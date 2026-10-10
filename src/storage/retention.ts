import fs from "node:fs";
import path from "node:path";
import {
  type OwnerIdentity,
  ownerHeartbeatFields,
  ownerIdentityFields,
  ownerLiveness,
  recordOwnerLiveness,
  writeJsonAtomic,
} from "../core/atomic-write.js";
import { ownedStat, processAlive } from "./scratch.js";

export const FABRIC_RUN_ROOT_PREFIX = "pi-fabric-runs-";
const RUN_ROOT_OWNER_FILE = ".fabric-owner.json";
const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped", "timed_out"]);
/**
 * A run root is heartbeated by each retention sweep of its owner, every 15
 * minutes (`RETENTION_SWEEP_INTERVAL_MS` in agents/manager.ts). Across PID
 * namespaces a signal probe means nothing, so three missed sweeps prove the
 * owner dead.
 */
export const RUN_ROOT_HEARTBEAT_TTL_MS = 45 * 60 * 1_000;
interface RunRootOwner {
  pid: number;
  startedAt: number;
  heartbeatAt: number;
  // Optional owner identity (namespace-safe liveness); absent on old markers.
  identity?: Omit<OwnerIdentity, "pid">;
  orphanedAt?: number;
  closedAt?: number;
  childrenStopped?: boolean;
}
interface RunRecordSummary {
  status?: string;
  actorId?: string;
  finishedAt?: number;
  updatedAt?: number;
  transport?: string;
  sessionId?: string;
}
export interface RetentionSweepResult {
  removedRoots: string[];
  removedRuns: string[];
}
const ownerPath = (root: string): string => path.join(root, RUN_ROOT_OWNER_FILE);
const readJson = <T>(file: string): T | undefined => {
  try {
    const stat = ownedStat(file);
    if (!stat?.isFile() || stat.size > 1024 * 1024) return;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch { return; }
};
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const validOwner = (owner: RunRootOwner | undefined): owner is RunRootOwner => !!owner &&
  Number.isSafeInteger(owner.pid) && owner.pid > 0 && time(owner.startedAt) && time(owner.heartbeatAt) &&
  (owner.closedAt === undefined || time(owner.closedAt)) &&
  (owner.orphanedAt === undefined || time(owner.orphanedAt)) &&
  (owner.childrenStopped === undefined || typeof owner.childrenStopped === "boolean");
const writeOwner = (root: string, owner: RunRootOwner): void => {
  if (fs.existsSync(root) && !ownedStat(root)?.isDirectory()) throw new Error("Unsafe Fabric run root");
  const file = ownerPath(root);
  if (fs.existsSync(file)) {
    const existing = readJson<RunRootOwner>(file);
    if (!validOwner(existing) || existing.pid !== owner.pid) throw new Error("Unsafe Fabric run owner marker");
  }
  writeJsonAtomic(file, owner);
};
export const markRunRootActive = (root: string, now = Date.now()): void => {
  const existing = readJson<RunRootOwner>(ownerPath(root));
  writeOwner(root, { pid: process.pid, startedAt: validOwner(existing) ? existing.startedAt : now, ...ownerHeartbeatFields(now) });
};
export const heartbeatRunRoot = markRunRootActive;
export const markRunRootClosed = (root: string, now = Date.now(), childrenStopped = false): void => {
  const existing = readJson<RunRootOwner>(ownerPath(root));
  writeOwner(root, { pid: process.pid, startedAt: validOwner(existing) ? existing.startedAt : now, ...ownerHeartbeatFields(now), closedAt: now, childrenStopped });
};
// Identity-less (old) markers keep the plain signal probe. Uncertainty is not death.
const ownerAlive = (owner: RunRootOwner, now: number): boolean =>
  recordOwnerLiveness(owner, {
    heartbeatTtlMs: RUN_ROOT_HEARTBEAT_TTL_MS,
    legacyAlive: processAlive,
    probes: { now: () => now },
  }) !== "dead";
// A process-transport child lives in its owner's namespace; its start time is
// unrecorded. Without an owner identity, keep the plain signal probe.
const childAlive = (owner: RunRootOwner | undefined, pid: number): boolean => {
  const identity = ownerIdentityFields(owner?.identity);
  if (!identity) return processAlive(pid);
  const { startedAt: _startedAt, ...place } = identity;
  return ownerLiveness({ ...place, pid }, { legacyAlive: processAlive }) !== "dead";
};
const recordAgeReference = (record: RunRecordSummary, fallback: number): number =>
  time(record.finishedAt) ? record.finishedAt : time(record.updatedAt) ? record.updatedAt : fallback;
const runFiles = new Set(["task.txt", "status.json", "events.jsonl", "lifecycle.jsonl", "steer.jsonl", "schema.json", "images.json"]);
const DURABLE_KEY = /^(?:initial|[0-9a-f]{64})$/;
const DURABLE_LEASE_FILES = new Set(["lease.sqlite", "lease.sqlite-journal"]);
const DURABLE_STORE_FILE = /^(?:main|(?:doc|task)-(?:0|[1-9]\d*))\.jsonl(?:\.reclaim)?$/;
const onlyOwnedFiles = (directory: string, allowed: (name: string) => boolean): boolean =>
  fs.readdirSync(directory).every((name) => allowed(name) && ownedStat(path.join(directory, name))?.isFile() === true);
/**
 * The pi-durable runner's journal: `durable/<initial|sha256>/{lease.sqlite,store/*.jsonl}`,
 * exactly as src/durable/storage.ts creates it. The run's status and child liveness
 * still decide removal; this only stops Fabric's own journal from vetoing it.
 */
const safeDurableTree = (directory: string): boolean => fs.readdirSync(directory).every((key) => {
  const conversation = path.join(directory, key);
  if (!DURABLE_KEY.test(key) || !ownedStat(conversation)?.isDirectory()) return false;
  return fs.readdirSync(conversation).every((name) => {
    const file = path.join(conversation, name);
    if (name === "store") return ownedStat(file)?.isDirectory() === true && onlyOwnedFiles(file, (child) => DURABLE_STORE_FILE.test(child));
    return DURABLE_LEASE_FILES.has(name) && ownedStat(file)?.isFile() === true;
  });
});
/** Unknown transports/contents and live descendants veto removal, even under a dead host. */
const safeRunTree = (root: string, childrenStopped: boolean, owner?: RunRootOwner, depth = 0): boolean => {
  if (depth > 32 || !ownedStat(root)?.isDirectory()) return false;
  const record = readJson<RunRecordSummary>(path.join(root, "status.json"));
  const pid = record?.transport === "process" && typeof record.sessionId === "string" && /^\d+$/.test(record.sessionId)
    ? Number(record.sessionId) : undefined;
  if (pid !== undefined && childAlive(owner, pid)) return false;
  if (!record?.status || !TERMINAL_STATUSES.has(record.status)) {
    if (!childrenStopped && pid === undefined) return false;
    if (!ownedStat(path.join(root, "task.txt"))?.isFile()) return false;
  }
  try {
    for (const name of fs.readdirSync(root)) {
      const file = path.join(root, name);
      const stat = ownedStat(file);
      if (!stat) return false;
      if (stat.isFile() && runFiles.has(name)) continue;
      if (stat.isDirectory() && name === "handoff-session") {
        // This directory is exclusively populated by Fabric's session fork writer.
        if (fs.readdirSync(file).some((child) => !child.endsWith(".jsonl") || !ownedStat(path.join(file, child))?.isFile())) return false;
        continue;
      }
      if (stat.isDirectory() && name === "durable") {
        if (!safeDurableTree(file)) return false;
        continue;
      }
      if (stat.isDirectory() && name === "nested") {
        for (const child of fs.readdirSync(file)) if (!safeRunTree(path.join(file, child), false, owner, depth + 1)) return false;
        continue;
      }
      return false;
    }
    return true;
  } catch { return false; }
};
const safeRootContents = (root: string, childrenStopped: boolean, owner?: RunRootOwner): boolean => {
  try { return fs.readdirSync(root).every((name) => name === RUN_ROOT_OWNER_FILE || safeRunTree(path.join(root, name), childrenStopped, owner)); }
  catch { return false; }
};
export const canRemoveManagedRunRoot = (root: string): boolean => {
  if (!ownedStat(root)?.isDirectory()) return false;
  const owner = readJson<RunRootOwner>(ownerPath(root));
  return validOwner(owner) && owner.pid === process.pid && safeRootContents(root, true, owner);
};
export const removeEmptyRunRoot = (root: string): boolean => {
  try {
    if (!ownedStat(root)?.isDirectory() || !validOwner(readJson<RunRootOwner>(ownerPath(root)))) return false;
    if (fs.readdirSync(root).some((name) => name !== RUN_ROOT_OWNER_FILE)) return false;
    fs.rmSync(root, { recursive: true, force: true });
    return true;
  } catch { return false; }
};
const pruneClosedRunRoot = (root: string, owner: RunRootOwner, orphanMs: number, oneShotMs: number, now: number): string[] => {
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return removed; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    if (!safeRunTree(directory, owner.childrenStopped === true, owner)) continue;
    const record = readJson<RunRecordSummary>(path.join(directory, "status.json"));
    const terminal = !!record?.status && TERMINAL_STATUSES.has(record.status);
    const reference = terminal ? recordAgeReference(record!, ownedStat(directory)?.mtimeMs ?? now) : owner.closedAt!;
    const retention = terminal && !record?.actorId ? oneShotMs : orphanMs;
    if (now - reference < retention) continue;
    try { fs.rmSync(directory, { recursive: true, force: true }); removed.push(directory); } catch {}
  }
  return removed;
};
export const sweepTempRunRoots = (options: {
  tempRoot: string;
  currentRoot?: string;
  orphanedTempRunRetentionMs: number;
  oneShotRunRetentionMs: number;
  now?: number;
}): RetentionSweepResult => {
  const now = options.now ?? Date.now();
  const result: RetentionSweepResult = { removedRoots: [], removedRuns: [] };
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(options.tempRoot, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^pi-fabric-runs-[A-Za-z0-9_-]+$/.test(entry.name)) continue;
    const root = path.join(options.tempRoot, entry.name);
    if (options.currentRoot && path.resolve(root) === path.resolve(options.currentRoot)) continue;
    if (!ownedStat(root)?.isDirectory()) continue;
    const owner = readJson<RunRootOwner>(ownerPath(root));
    if (!validOwner(owner)) continue;
    if (owner.closedAt !== undefined) {
      result.removedRuns.push(...pruneClosedRunRoot(root, owner, options.orphanedTempRunRetentionMs, options.oneShotRunRetentionMs, now));
      if (removeEmptyRunRoot(root)) result.removedRoots.push(root);
      continue;
    }
    if (ownerAlive(owner, now)) continue;
    if (owner.orphanedAt === undefined) {
      try { writeOwner(root, { ...owner, orphanedAt: now }); } catch {}
      continue;
    }
    if (now - owner.orphanedAt < options.orphanedTempRunRetentionMs || !safeRootContents(root, false, owner)) continue;
    try { fs.rmSync(root, { recursive: true, force: true }); result.removedRoots.push(root); } catch {}
  }
  return result;
};

export const pruneActorRunArchives = (options: {
  runsDirectory: string;
  latestRunId?: string;
  retentionMs: number;
  now?: number;
}): string[] => {
  const now = options.now ?? Date.now();
  const removed: string[] = [];
  if (!ownedStat(options.runsDirectory)?.isDirectory()) return removed;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(options.runsDirectory, { withFileTypes: true }); } catch { return removed; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === options.latestRunId) continue;
    const directory = path.join(options.runsDirectory, entry.name);
    const record = readJson<RunRecordSummary>(path.join(directory, "status.json"));
    if (!record?.status || !TERMINAL_STATUSES.has(record.status) || !safeRunTree(directory, false)) continue;
    if (now - recordAgeReference(record, ownedStat(directory)?.mtimeMs ?? now) < options.retentionMs) continue;
    try { fs.rmSync(directory, { recursive: true, force: true }); removed.push(directory); } catch {}
  }
  return removed;
};
