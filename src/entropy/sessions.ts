// On-demand session measurement. Session JSONL is the source of truth, so
// entropy is never recorded: the newest machine sessions are read live
// across every project under the agent dir, measured against the current
// surface, and the trend is the per-session slope. Evidence breadth matches
// enforcement breadth: the compiled surface governs the whole machine, so
// it learns from the whole machine. The repair table, compiled surface, and
// bounded observation pool are the only durable derived artifacts; only the
// first two change runtime behavior.

import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { sessionDirForCwd, sessionsDirRoot } from "../memory/discovery.js";
import {
  entropySessionEvidenceFromJsonl,
  entropyTracesFromSessionJsonl,
  scanEntropySessionJsonlAsync,
  type EntropySessionEvidence,
} from "./corpus.js";
import { measureEntropy, measureEntropyAsync, type EntropyTraceWindow } from "./meter.js";
import { compareCodeUnits, trendFromScores } from "./fingerprint.js";
import type {
  EntropyAuditCall,
  EntropyModelReport,
  EntropyReport,
  EntropySurfaceSnapshot,
  EntropyTraceInput,
  EntropyTrend,
  EntropyValueObservation,
} from "./types.js";

const DEFAULT_SESSION_WINDOW = 8;

const SESSION_STAT_CONCURRENCY = 32;
const SESSION_READ_CONCURRENCY = 4;
const SESSION_EVIDENCE_CACHE_LIMIT = 16;
// Estimated bytes the evidence cache may hold beyond the active window. The
// DEFAULT_SESSION_WINDOW most recently read files are always kept, so the
// background compile never rescans a session it read on the previous turn;
// older entries (files that left the window, or a `/fabric` sweep across the
// machine) stay only while the total fits.
const SESSION_EVIDENCE_CACHE_BYTES = 16 * 1024 * 1024;

interface StampedSessionFile {
  file: string;
  mtime: number;
}

interface CachedSessionEvidence {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  currentModel?: string;
  evidence: EntropySessionEvidence;
  /** Estimated retained bytes of `evidence`. */
  bytes: number;
}

const asyncEvidenceCache = new Map<string, CachedSessionEvidence>();
let asyncEvidenceCacheBytes = 0;

// Rough V8 retained size: headers, slots and string payloads. Observation
// values are the audit argument strings themselves, so an observation counts
// only its own object. The walk yields between chunks so a first scan of a
// large session never blocks Pi's event loop on the estimate.
const OBJECT_BYTES = 32;
const SLOT_BYTES = 8;
const STRING_BYTES = 16;
const OBSERVATION_BYTES = 48;
const ESTIMATE_CHUNK = 4_096;

const estimateEvidenceBytesAsync = async (evidence: EntropySessionEvidence): Promise<number> => {
  let bytes = OBJECT_BYTES * 3 + evidence.valueObservations.length * (OBSERVATION_BYTES + SLOT_BYTES);
  const stack: unknown[] = [evidence.traces, evidence.auditCalls];
  let visited = 0;
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") bytes += STRING_BYTES + value.length;
    else if (Array.isArray(value)) {
      bytes += OBJECT_BYTES + value.length * SLOT_BYTES;
      for (const item of value) stack.push(item);
    } else if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      bytes += OBJECT_BYTES + entries.length * SLOT_BYTES * 2;
      for (const [, item] of entries) stack.push(item);
    } else bytes += SLOT_BYTES;
    if (++visited % ESTIMATE_CHUNK === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return bytes;
};

const mapConcurrent = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
};

const byNewestSession = (left: StampedSessionFile, right: StampedSessionFile): number =>
  right.mtime - left.mtime ||
  (left.file < right.file ? -1 : left.file > right.file ? 1 : 0);

const stampSessionFiles = async (files: readonly string[]): Promise<StampedSessionFile[]> =>
  mapConcurrent(files, SESSION_STAT_CONCURRENCY, async (file) => {
    let mtime = 0;
    try {
      mtime = (await fs.promises.stat(file)).mtimeMs;
    } catch {
      // Preserve the synchronous selector's race behavior: an unreadable file
      // sorts last and the later stream open decides whether it contributes.
    }
    return { file, mtime };
  });

export interface SessionCorpusEntry {
  file: string;
  operations: number;
  report: EntropyReport;
}

// Per-model trend across the session window: the attribution that names
// which model's behavior moved, with the surface share staying global.
export interface SessionModelTrend {
  model: string;
  sessions: number;
  latestBehavioralScore: number;
  slopePerSession: number;
  latestRejectionsPer1k: number;
}

export interface SessionCorpusResult {
  files: readonly string[];
  sessions: SessionCorpusEntry[];
  latest?: EntropyReport;
  trend: EntropyTrend;
  models: SessionModelTrend[];
}

// Newest-first session JSONL files for one project cwd, bounded by `limit`.
// Mtime ties break by path so the ordering is stable.
export const projectSessionFiles = (
  agentDir: string,
  cwd: string,
  limit = DEFAULT_SESSION_WINDOW,
): string[] => {
  const dir = sessionDirForCwd(cwd, agentDir);
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const stamped = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => {
      const file = path.join(dir, entry.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { file, mtime };
    });
  stamped.sort(
    (left, right) =>
      right.mtime - left.mtime || (left.file < right.file ? -1 : left.file > right.file ? 1 : 0),
  );
  return stamped.slice(0, Math.max(1, limit)).map((entry) => entry.file);
};

// Machine-wide session window: newest sessions across every project under
// the agent dir, bounded by `limit` in total. The current project's newest
// session is always included even when quieter projects would crowd it
// out, because the live session produced this turn's evidence. Ordering
// matches projectSessionFiles: mtime descending, path tiebreak, stable.
export const machineSessionFiles = (
  agentDir: string,
  cwd: string | undefined,
  limit = DEFAULT_SESSION_WINDOW,
): string[] => {
  const root = sessionsDirRoot(agentDir);
  let projectDirs: fs.Dirent[] = [];
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const byNewest = (
    left: { file: string; mtime: number },
    right: { file: string; mtime: number },
  ) =>
    right.mtime - left.mtime ||
    (left.file < right.file ? -1 : left.file > right.file ? 1 : 0);
  const stamped: { file: string; mtime: number }[] = [];
  const directories = projectDirs
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const directory of directories) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(path.join(root, directory.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.filter(
      (candidate) => candidate.isFile() && candidate.name.endsWith(".jsonl"),
    )) {
      const file = path.join(root, directory.name, entry.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        mtime = 0;
      }
      stamped.push({ file, mtime });
    }
  }
  stamped.sort(byNewest);
  const window = Math.max(1, limit);
  let selected = stamped.slice(0, window);
  if (cwd) {
    const current = projectSessionFiles(agentDir, cwd, 1)[0];
    if (current !== undefined && !selected.some((entry) => entry.file === current)) {
      const kept = [...selected];
      if (kept.length >= window) kept.length = window - 1;
      let mtime = 0;
      try {
        mtime = fs.statSync(current).mtimeMs;
      } catch {
        mtime = 0;
      }
      kept.push({ file: current, mtime });
      kept.sort(byNewest);
      selected = kept;
    }
  }
  return selected.map((entry) => entry.file);
};

export const projectSessionFilesAsync = async (
  agentDir: string,
  cwd: string,
  limit = DEFAULT_SESSION_WINDOW,
): Promise<string[]> => {
  const dir = sessionDirForCwd(cwd, agentDir);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(dir, entry.name));
  const stamped = await stampSessionFiles(files);
  stamped.sort(byNewestSession);
  return stamped.slice(0, Math.max(1, limit)).map((entry) => entry.file);
};

export const machineSessionFilesAsync = async (
  agentDir: string,
  cwd: string | undefined,
  limit = DEFAULT_SESSION_WINDOW,
): Promise<string[]> => {
  const root = sessionsDirRoot(agentDir);
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const directories = projectDirs
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const filesByDirectory = await mapConcurrent(
    directories,
    SESSION_STAT_CONCURRENCY,
    async (directory): Promise<string[]> => {
      const dir = path.join(root, directory.name);
      try {
        return (await fs.promises.readdir(dir, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => path.join(dir, entry.name));
      } catch {
        return [];
      }
    },
  );
  const stamped = await stampSessionFiles(filesByDirectory.flat());
  stamped.sort(byNewestSession);
  const window = Math.max(1, limit);
  let selected = stamped.slice(0, window);
  if (cwd) {
    const current = (await projectSessionFilesAsync(agentDir, cwd, 1))[0];
    if (current !== undefined && !selected.some((entry) => entry.file === current)) {
      const kept = [...selected];
      if (kept.length >= window) kept.length = window - 1;
      const [stampedCurrent] = await stampSessionFiles([current]);
      if (stampedCurrent) kept.push(stampedCurrent);
      kept.sort(byNewestSession);
      selected = kept;
    }
  }
  return selected.map((entry) => entry.file);
};

const finalizeSessionCorpus = (
  files: readonly string[],
  sessions: SessionCorpusEntry[],
): SessionCorpusResult => {
  const chronological = [...sessions].reverse();
  const modelScores = new Map<string, { behavioral: number[]; latest: EntropyModelReport }>();
  for (const session of chronological) {
    for (const model of session.report.byModel) {
      const entry = modelScores.get(model.model) ?? { behavioral: [], latest: model };
      entry.behavioral.push(model.behavioralScore);
      entry.latest = model;
      modelScores.set(model.model, entry);
    }
  }
  const models: SessionModelTrend[] = [...modelScores.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([model, entry]) => ({
      model,
      sessions: entry.behavioral.length,
      latestBehavioralScore: entry.latest.behavioralScore,
      slopePerSession: trendFromScores(entry.behavioral).slopePerStep,
      latestRejectionsPer1k: entry.latest.invocationRejectionsPer1k,
    }));
  return {
    files,
    sessions,
    ...(sessions.length > 0 ? { latest: sessions[0]!.report } : {}),
    trend: trendFromScores(chronological.map((session) => session.report.score)),
    models,
  };
};

// Measure each session file independently against the same surface; sessions
// without fabric_exec traces contribute nothing. `files` must be newest
// first; the trend runs oldest to newest.
export const measureSessionCorpus = (input: {
  files: readonly string[];
  surface?: EntropySurfaceSnapshot;
  catalogDigest?: string;
}): SessionCorpusResult => {
  const sessions: SessionCorpusEntry[] = [];
  for (const file of input.files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const traces = entropyTracesFromSessionJsonl(text.split("\n"));
    if (traces.length === 0) continue;
    const report = measureEntropy({
      traces,
      ...(input.surface ? { surface: input.surface } : {}),
      ...(input.catalogDigest !== undefined ? { catalogDigest: input.catalogDigest } : {}),
    });
    if (report.totals.operations === 0) continue;
    sessions.push({ file, operations: report.totals.operations, report });
  }
  return finalizeSessionCorpus(input.files, sessions);
};

// One read per file yields the meter traces, the verbatim audit value
// corpus, the verbatim audit calls, and the per-file observation windows
// the machine-wide pool consumes with exact deltas, so the autonomous
// compile and the command share a single window scan.
/** Background-only discovery cadence; explicit inspection continues to scan immediately. */
export class BackgroundSessionSelector {
  #cached: { agentDir: string; cwd: string | undefined; files: string[]; until: number } | undefined;

  constructor(readonly scan = machineSessionFilesAsync) {}

  async select(agentDir: string, cwd: string | undefined, currentFile?: string): Promise<string[]> {
    const cached = this.#cached;
    let files: string[];
    if (cached && cached.agentDir === agentDir && cached.cwd === cwd && Date.now() < cached.until) {
      files = cached.files;
    } else {
      files = await this.scan(agentDir, cwd);
      // Do not cache an absent session root: it may be created by this turn.
      this.#cached = files.length > 0 ? { agentDir, cwd, files, until: Date.now() + 30_000 } : undefined;
    }
    // The active file is fresh on every compile, including forks and switches
    // which occurred inside the machine-wide discovery window.
    return currentFile
      ? [currentFile, ...files.filter((file) => file !== currentFile)].slice(0, DEFAULT_SESSION_WINDOW)
      : [...files];
  }
}

export interface SessionObservationWindow {
  file: string;
  observations: EntropyValueObservation[];
}

export interface SessionWindowEvidence {
  traceWindows: EntropyTraceWindow[];
  traces: EntropyTraceInput[];
  valueObservations: EntropyValueObservation[];
  auditCalls: EntropyAuditCall[];
  observationWindows: SessionObservationWindow[];
}

interface SessionFileMetadata {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

const sessionMetadata = async (file: string): Promise<SessionFileMetadata | undefined> => {
  try {
    const entry = await fs.promises.stat(file);
    return {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      dev: entry.dev,
      ino: entry.ino,
    };
  } catch {
    return undefined;
  }
};

const endsAtLineBoundary = async (
  file: string,
  metadata: SessionFileMetadata,
): Promise<boolean> => {
  if (metadata.size === 0) return true;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, "r");
    const byte = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(byte, 0, 1, metadata.size - 1);
    return bytesRead === 1 && byte[0] === 0x0a;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const scanSessionRange = async (
  file: string,
  start: number,
  end: number,
  initialModel?: string,
): ReturnType<typeof scanEntropySessionJsonlAsync> => {
  const input = fs.createReadStream(file, { encoding: "utf8", start, end });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    return await scanEntropySessionJsonlAsync(lines, initialModel);
  } finally {
    lines.close();
    input.destroy();
  }
};

const evidenceWindow = (
  file: string,
  evidence: EntropySessionEvidence,
): SessionWindowEvidence => ({
  traceWindows: [{ file, traces: evidence.traces }],
  traces: evidence.traces,
  valueObservations: evidence.valueObservations,
  auditCalls: evidence.auditCalls,
  observationWindows: [{ file, observations: evidence.valueObservations }],
});

const forgetSessionEvidence = (file: string): void => {
  const cached = asyncEvidenceCache.get(file);
  if (!cached) return;
  asyncEvidenceCache.delete(file);
  asyncEvidenceCacheBytes -= cached.bytes;
};

const cacheSessionEvidence = (file: string, cached: CachedSessionEvidence): void => {
  forgetSessionEvidence(file);
  asyncEvidenceCache.set(file, cached);
  asyncEvidenceCacheBytes += cached.bytes;
  while (asyncEvidenceCache.size > SESSION_EVIDENCE_CACHE_LIMIT) {
    forgetSessionEvidence(asyncEvidenceCache.keys().next().value!);
  }
};

// Runs after a batch of reads, when every file of the batch is among the most
// recently read: trimming mid-batch could evict a window file the same batch
// has yet to read and force a full rescan of it.
const trimSessionEvidenceCache = (): void => {
  while (
    asyncEvidenceCache.size > DEFAULT_SESSION_WINDOW &&
    asyncEvidenceCacheBytes > SESSION_EVIDENCE_CACHE_BYTES
  ) {
    forgetSessionEvidence(asyncEvidenceCache.keys().next().value!);
  }
};

/** Cached session evidence: entry count and estimated bytes. For diagnostics and tests. */
export const sessionEvidenceCacheUsage = (): { files: number; bytes: number } => ({
  files: asyncEvidenceCache.size,
  bytes: asyncEvidenceCacheBytes,
});

const sameSessionFile = (
  cached: CachedSessionEvidence,
  metadata: SessionFileMetadata,
): boolean => cached.dev === metadata.dev && cached.ino === metadata.ino;

const readSessionEvidenceAsync = async (
  file: string,
): Promise<SessionWindowEvidence | undefined> => {
  const metadata = await sessionMetadata(file);
  if (!metadata) return undefined;
  const cached = asyncEvidenceCache.get(file);
  if (
    cached &&
    sameSessionFile(cached, metadata) &&
    cached.size === metadata.size &&
    Math.abs(cached.mtimeMs - metadata.mtimeMs) <= 1e-6
  ) {
    cacheSessionEvidence(file, cached);
    return evidenceWindow(file, cached.evidence);
  }

  const append =
    cached && sameSessionFile(cached, metadata) && metadata.size > cached.size
      ? cached
      : undefined;
  const start = append ? append.size : 0;
  let scan: Awaited<ReturnType<typeof scanEntropySessionJsonlAsync>>;
  try {
    scan = metadata.size === start
      ? {
          evidence: { traces: [], valueObservations: [], auditCalls: [] },
          ...(append?.currentModel ? { currentModel: append.currentModel } : {}),
        }
      : await scanSessionRange(
          file,
          start,
          metadata.size - 1,
          append?.currentModel,
        );
  } catch {
    return undefined;
  }
  const evidence: EntropySessionEvidence = append
    ? {
        traces: [...append.evidence.traces, ...scan.evidence.traces],
        valueObservations: [
          ...append.evidence.valueObservations,
          ...scan.evidence.valueObservations,
        ],
        auditCalls: [...append.evidence.auditCalls, ...scan.evidence.auditCalls],
      }
    : scan.evidence;
  if (await endsAtLineBoundary(file, metadata)) {
    const bytes = (append?.bytes ?? 0) + await estimateEvidenceBytesAsync(scan.evidence);
    cacheSessionEvidence(file, {
      ...metadata,
      ...(scan.currentModel ? { currentModel: scan.currentModel } : {}),
      evidence,
      bytes,
    });
  } else {
    forgetSessionEvidence(file);
  }
  return evidenceWindow(file, evidence);
};

export const sessionWindowEvidenceAsync = async (
  files: readonly string[],
  options: { windowsOnly?: boolean } = {},
): Promise<SessionWindowEvidence> => {
  const windows = await mapConcurrent(files, SESSION_READ_CONCURRENCY, readSessionEvidenceAsync);
  trimSessionEvidenceCache();
  const traces: EntropyTraceInput[] = [];
  const valueObservations: EntropyValueObservation[] = [];
  const auditCalls: EntropyAuditCall[] = [];
  const observationWindows: SessionObservationWindow[] = [];
  const traceWindows: EntropyTraceWindow[] = [];
  for (const window of windows) {
    if (!window) continue;
    // Background consumers only need immutable per-file snapshots. Avoid
    // copying the full historical corpus into unused flattened arrays.
    if (!options.windowsOnly) {
      for (const trace of window.traces) traces.push(trace);
      for (const observation of window.valueObservations) valueObservations.push(observation);
      for (const call of window.auditCalls) auditCalls.push(call);
    }
    observationWindows.push(...window.observationWindows);
    traceWindows.push(...window.traceWindows);
  }
  return { traces, valueObservations, auditCalls, observationWindows, traceWindows };
};

export const measureSessionCorpusAsync = async (input: {
  files: readonly string[];
  surface?: EntropySurfaceSnapshot;
  catalogDigest?: string;
}): Promise<SessionCorpusResult> => {
  const windows = await mapConcurrent(
    input.files,
    SESSION_READ_CONCURRENCY,
    readSessionEvidenceAsync,
  );
  trimSessionEvidenceCache();
  const sessions: SessionCorpusEntry[] = [];
  for (let index = 0; index < input.files.length; index++) {
    const window = windows[index];
    const file = input.files[index];
    if (!window || !file || window.traces.length === 0) continue;
    const report = await measureEntropyAsync({
      traces: window.traces,
      ...(input.surface ? { surface: input.surface } : {}),
      ...(input.catalogDigest !== undefined ? { catalogDigest: input.catalogDigest } : {}),
    });
    if (report.totals.operations === 0) continue;
    sessions.push({ file, operations: report.totals.operations, report });
  }
  return finalizeSessionCorpus(input.files, sessions);
};

export const sessionWindowEvidence = (
  files: readonly string[],
): SessionWindowEvidence => {
  const traces: EntropyTraceInput[] = [];
  const valueObservations: EntropyValueObservation[] = [];
  const auditCalls: EntropyAuditCall[] = [];
  const observationWindows: SessionObservationWindow[] = [];
  const traceWindows: EntropyTraceWindow[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const evidence = entropySessionEvidenceFromJsonl(text.split("\n"));
    traces.push(...evidence.traces);
    valueObservations.push(...evidence.valueObservations);
    auditCalls.push(...evidence.auditCalls);
    observationWindows.push({ file, observations: evidence.valueObservations });
    traceWindows.push({ file, traces: evidence.traces });
  }
  return { traces, valueObservations, auditCalls, observationWindows, traceWindows };
};
