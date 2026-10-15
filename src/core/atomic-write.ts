import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AtomicWriteOptions {
  // File mode for the committed file (default 0o600) and for mkdir -p of its
  // parent directory (default 0o700).
  mode?: number;
  dirMode?: number;
  // Windows transiently rejects rename() with EPERM/EACCES/EEXIST/EBUSY while
  // an antivirus scan, indexer, or sibling reader probes the destination —
  // milliseconds of contention, not a policy failure. Retry a bounded number
  // of times with linear backoff before surfacing the error.
  renameRetries?: number;
  renameRetryDelayMs?: number;
}

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EEXIST", "EBUSY"]);

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;

// Portable synchronous sleep for the retry window (Atomics.wait is legal on
// the Node main thread). If unavailable, retries proceed immediately — still
// correct, just less cooperative under contention.
const syncSleep = (() => {
  try {
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    return (ms: number): void => {
      Atomics.wait(buffer, 0, 0, ms);
    };
  } catch {
    return (): void => undefined;
  }
})();

export const renameAtomic = (
  source: string,
  target: string,
  options?: AtomicWriteOptions,
): void => {
  const attempts = Math.max(1, options?.renameRetries ?? 8);
  const delay = options?.renameRetryDelayMs ?? 25;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      fs.renameSync(source, target);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (attempt === attempts || code === undefined || !RETRYABLE_RENAME_CODES.has(code)) {
        throw error;
      }
      syncSleep(delay * attempt);
    }
  }
};

export const writeFileAtomic = (
  filePath: string,
  contents: string,
  options?: AtomicWriteOptions,
): void => {
  fs.mkdirSync(path.dirname(filePath), {
    recursive: true,
    mode: options?.dirMode ?? 0o700,
  });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, {
      encoding: "utf8",
      mode: options?.mode ?? 0o600,
    });
    renameAtomic(temporary, filePath, options);
  } finally {
    // No-op right after a successful rename; removes the temp on failure.
    fs.rmSync(temporary, { force: true });
  }
};

export interface AtomicJsonOptions extends AtomicWriteOptions {
  // Pretty-print indent for JSON.stringify (default: compact).
  space?: number;
  // Some on-disk formats expect a trailing newline (schema state files).
  newline?: boolean;
}

export const writeJsonAtomic = (
  filePath: string,
  value: unknown,
  options?: AtomicJsonOptions,
): void => {
  const space = options?.space;
  const serialized =
    JSON.stringify(value, null, space) + (options?.newline === true ? "\n" : "");
  writeFileAtomic(filePath, serialized, options);
};

const asyncSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const renameAtomicAsync = async (
  source: string,
  target: string,
  options?: AtomicWriteOptions,
): Promise<void> => {
  const attempts = Math.max(1, options?.renameRetries ?? 8);
  const delay = options?.renameRetryDelayMs ?? 25;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await fs.promises.rename(source, target);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (attempt === attempts || code === undefined || !RETRYABLE_RENAME_CODES.has(code)) {
        throw error;
      }
      await asyncSleep(delay * attempt);
    }
  }
};

const writeFileAtomicAsync = async (
  filePath: string,
  contents: string,
  options?: AtomicWriteOptions,
): Promise<void> => {
  await fs.promises.mkdir(path.dirname(filePath), {
    recursive: true,
    mode: options?.dirMode ?? 0o700,
  });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, contents, {
      encoding: "utf8",
      mode: options?.mode ?? 0o600,
    });
    await renameAtomicAsync(temporary, filePath, options);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
};

export const writeJsonAtomicAsync = async (
  filePath: string,
  value: unknown,
  options?: AtomicJsonOptions,
): Promise<void> => {
  const space = options?.space;
  const serialized =
    JSON.stringify(value, null, space) + (options?.newline === true ? "\n" : "");
  await writeFileAtomicAsync(filePath, serialized, options);
};

// ---------------------------------------------------------------------------
// Namespace-safe owner liveness. It shares this module with the atomic
// writers whose files it guards: a separate module would become its own
// shared chunk in the eager startup graph, which is at its file budget.
//
// `process.kill(pid, 0)` only answers for the
// caller's own PID namespace and boot: inside containers the same number can
// name an unrelated process (or nothing), and after PID reuse it names a
// stranger. Owners therefore record who they are (host, PID namespace, boot,
// process start time) and long-lived owners refresh a heartbeat. A probe only
// trusts the signal answer when the record shares the caller's namespace and
// boot; otherwise the heartbeat decides. Records without identity fields keep
// the caller's pre-identity behaviour exactly.

/** Long-lived owners refresh `heartbeatAt` this often. */
export const OWNER_HEARTBEAT_INTERVAL_MS = 10_000;
/** A heartbeat older than this proves the owner dead. */
export const OWNER_HEARTBEAT_TTL_MS = 45_000;
/**
 * Short-lived locks carry no heartbeat. Across namespaces their creation time
 * stands in for one, so a crashed foreign holder cannot strand a lock forever.
 */
export const SHORT_LOCK_MAX_HOLD_MS = 10 * 60_000;
// Linux reports process start in clock ticks since boot; the wall-clock
// conversion of each side may disagree by up to a btime rounding second.
const PID_START_TOLERANCE_MS = 2_000;
// Linux USER_HZ is 100 on every mainstream architecture. Both sides of a
// comparison use the same conversion, so only consistency matters.
const CLOCK_TICKS_PER_SECOND = 100;
const MAX_IDENTITY_JSON_CHARS = 1_024;

export type OwnerLiveness = "alive" | "dead" | "unknown";

export interface OwnerIdentity {
  pid: number;
  hostname: string;
  pidNamespace?: string;
  bootId?: string;
  startedAt: number;
}

/** A persisted owner. Identity fields are optional so old records still parse. */
export interface OwnerRecord {
  pid: number;
  hostname?: string;
  pidNamespace?: string;
  bootId?: string;
  startedAt?: number;
}

export interface LivenessProbes {
  self?: () => OwnerIdentity;
  /** `kill(pid, 0)`: ESRCH dead, EPERM alive, anything else unknown. */
  signal?: (pid: number) => OwnerLiveness;
  /** Wall-clock start of `pid` when the platform reports it (Linux procfs). */
  processStartedAt?: (pid: number) => number | undefined;
  now?: () => number;
}

export interface OwnerLivenessOptions {
  heartbeatAt?: number;
  heartbeatTtlMs?: number;
  /** The caller's exact pre-identity probe, used only for legacy records. */
  legacyAlive?: (pid: number) => boolean;
  probes?: LivenessProbes;
}

const readTrimmed = (file: string): string | undefined => {
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
};

let bootTimeSeconds: number | undefined | null = null;
const readBootTimeSeconds = (): number | undefined => {
  if (bootTimeSeconds !== null) return bootTimeSeconds;
  const line = readTrimmed("/proc/stat")?.split("\n").find((entry) => entry.startsWith("btime "));
  const value = Number(line?.slice("btime ".length).trim());
  bootTimeSeconds = Number.isSafeInteger(value) && value > 0 ? value : undefined;
  return bootTimeSeconds;
};

/** Parses `/proc/<pid>/stat` (field 22, starttime) into wall-clock ms. */
export const parseProcStartedAt = (stat: string, bootSeconds: number): number | undefined => {
  // The command name is parenthesised and may contain spaces or parentheses.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ticks = Number(fields[19]);
  if (!Number.isSafeInteger(ticks) || ticks < 0) return undefined;
  return bootSeconds * 1_000 + Math.round((ticks * 1_000) / CLOCK_TICKS_PER_SECOND);
};

const procStartedAt = (pid: number | "self"): number | undefined => {
  if (process.platform !== "linux") return undefined;
  const boot = readBootTimeSeconds();
  const stat = readTrimmed(`/proc/${pid}/stat`);
  return boot === undefined || stat === undefined ? undefined : parseProcStartedAt(stat, boot);
};

const signalProbe = (pid: number): OwnerLiveness => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "dead";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return "dead";
    return code === "EPERM" ? "alive" : "unknown";
  }
};

let cachedIdentity: OwnerIdentity | undefined;
/** This process's identity, computed once on first use (never at import). */
export const currentOwnerIdentity = (): OwnerIdentity => {
  if (cachedIdentity) return { ...cachedIdentity };
  let pidNamespace: string | undefined;
  let bootId: string | undefined;
  let startedAt: number | undefined;
  if (process.platform === "linux") {
    try {
      pidNamespace = fs.readlinkSync("/proc/self/ns/pid");
    } catch {
      pidNamespace = undefined;
    }
    bootId = readTrimmed("/proc/sys/kernel/random/boot_id");
    // PID-reuse detection compares procfs start times, so record ours the
    // same way. Without a boot id, readers skip that comparison.
    if (bootId !== undefined) startedAt = procStartedAt("self");
    if (startedAt === undefined) bootId = undefined;
  }
  cachedIdentity = {
    pid: process.pid,
    hostname: os.hostname(),
    ...(pidNamespace === undefined ? {} : { pidNamespace }),
    ...(bootId === undefined ? {} : { bootId }),
    startedAt: startedAt ?? Math.round(performance.timeOrigin),
  };
  return { ...cachedIdentity };
};

const boundedString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

/** Identity fields of a persisted record, or undefined for legacy/malformed ones. */
export const ownerIdentityFields = (
  value: unknown,
): Omit<OwnerIdentity, "pid"> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!boundedString(record.hostname, 255)) return undefined;
  if (record.pidNamespace !== undefined && !boundedString(record.pidNamespace, 128)) return undefined;
  if (record.bootId !== undefined && !boundedString(record.bootId, 128)) return undefined;
  if (typeof record.startedAt !== "number" || !Number.isFinite(record.startedAt)) return undefined;
  return {
    hostname: record.hostname,
    ...(record.pidNamespace === undefined ? {} : { pidNamespace: record.pidNamespace as string }),
    ...(record.bootId === undefined ? {} : { bootId: record.bootId as string }),
    startedAt: record.startedAt,
  };
};

/** One JSON line appended to line-oriented lock owner files. */
export const encodeOwnerIdentityLine = (): string => {
  const { pid: _pid, ...identity } = currentOwnerIdentity();
  return JSON.stringify(identity);
};

/** The identity line of a lock owner file; absent or malformed is legacy. */
export const decodeOwnerIdentityLine = (
  line: string | undefined,
): Omit<OwnerIdentity, "pid"> | undefined => {
  if (!line || line.length > MAX_IDENTITY_JSON_CHARS || !line.startsWith("{")) return undefined;
  try {
    return ownerIdentityFields(JSON.parse(line));
  } catch {
    return undefined;
  }
};

/** Optional heartbeat field of a persisted record. */
const heartbeatField = (value: unknown): number | undefined =>
  typeof value === "object" && value !== null &&
  typeof (value as { heartbeatAt?: unknown }).heartbeatAt === "number" &&
  Number.isFinite((value as { heartbeatAt: number }).heartbeatAt)
    ? (value as { heartbeatAt: number }).heartbeatAt
    : undefined;

/** Additive fields a long-lived JSON owner record carries. */
export interface OwnerHeartbeatFields {
  identity?: Omit<OwnerIdentity, "pid">;
  heartbeatAt?: number;
}

/** Identity and first heartbeat for a JSON owner record being acquired. */
export const ownerHeartbeatFields = (now = Date.now()): Required<OwnerHeartbeatFields> => {
  const { pid: _pid, ...identity } = currentOwnerIdentity();
  return { identity, heartbeatAt: now };
};

/**
 * Liveness of a persisted JSON owner record `{ pid, identity?, heartbeatAt? }`.
 * Malformed identity is treated as legacy; a non-numeric pid is dead.
 */
export const recordOwnerLiveness = (
  record: unknown,
  options: Omit<OwnerLivenessOptions, "heartbeatAt"> = {},
): OwnerLiveness => {
  if (typeof record !== "object" || record === null) return "dead";
  const { pid, identity: rawIdentity } = record as { pid?: unknown; identity?: unknown };
  if (typeof pid !== "number") return "dead";
  const identity = ownerIdentityFields(rawIdentity);
  const heartbeatAt = heartbeatField(record);
  return ownerLiveness(identity ? { ...identity, pid } : { pid }, {
    ...options,
    ...(heartbeatAt === undefined ? {} : { heartbeatAt }),
  });
};

export const ownerLiveness = (
  record: OwnerRecord,
  options: OwnerLivenessOptions = {},
): OwnerLiveness => {
  const probes = options.probes ?? {};
  const signal = probes.signal ?? signalProbe;
  if (typeof record.hostname !== "string") {
    return options.legacyAlive
      ? (options.legacyAlive(record.pid) ? "alive" : "dead")
      : signal(record.pid);
  }
  const self = (probes.self ?? currentOwnerIdentity)();
  const sameHost = record.hostname === self.hostname;
  if (
    sameHost &&
    record.pidNamespace === self.pidNamespace &&
    record.bootId === self.bootId
  ) {
    const answer = signal(record.pid);
    if (answer !== "alive") return answer;
    // Same boot: a different start time under the same PID is reuse.
    if (record.bootId !== undefined && record.startedAt !== undefined) {
      const actual = (probes.processStartedAt ?? procStartedAt)(record.pid);
      if (actual !== undefined && Math.abs(actual - record.startedAt) > PID_START_TOLERANCE_MS) {
        return "dead";
      }
    }
    return "alive";
  }
  // Another namespace, host, or boot: the signal answer means nothing here.
  if (options.heartbeatAt !== undefined) {
    const now = (probes.now ?? Date.now)();
    return now - options.heartbeatAt <= (options.heartbeatTtlMs ?? OWNER_HEARTBEAT_TTL_MS)
      ? "alive"
      : "dead";
  }
  // No process outlives its kernel boot (containers share the host's boot id).
  if (
    sameHost &&
    record.bootId !== undefined &&
    self.bootId !== undefined &&
    record.bootId !== self.bootId
  ) return "dead";
  return "unknown";
};

/**
 * Liveness of a line-oriented lock owner (`[token\n]pid\ncreated\n{identity}`).
 * Short locks never heartbeat, so their creation time is the heartbeat with a
 * generous hold ceiling.
 */
export const lockOwnerLiveness = (
  pid: number,
  createdAt: number,
  identityLine: string | undefined,
  options: Pick<OwnerLivenessOptions, "legacyAlive" | "probes"> & { maxHoldMs?: number } = {},
): OwnerLiveness => {
  const identity = decodeOwnerIdentityLine(identityLine);
  return ownerLiveness(identity ? { ...identity, pid } : { pid }, {
    ...options,
    ...(Number.isFinite(createdAt) ? { heartbeatAt: createdAt } : {}),
    heartbeatTtlMs: options.maxHoldMs ?? SHORT_LOCK_MAX_HOLD_MS,
  });
};

/**
 * True only when a line-oriented lock owner is provably gone, whatever the
 * lock's age: its identity line names this host, PID namespace and boot, and
 * its pid is absent or now belongs to a process started at another time.
 * Legacy owners, other hosts, namespaces or boots, unusable pids, and alive or
 * unknown probes prove nothing, so callers keep their stale-age rule for them.
 */
export const lockOwnerProvablyDead = (
  pid: number,
  identityLine: string | undefined,
  options: Pick<OwnerLivenessOptions, "probes"> = {},
): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const identity = decodeOwnerIdentityLine(identityLine);
  if (!identity) return false;
  const self = (options.probes?.self ?? currentOwnerIdentity)();
  if (
    identity.hostname !== self.hostname ||
    identity.pidNamespace !== self.pidNamespace ||
    identity.bootId !== self.bootId
  ) return false;
  return ownerLiveness(
    { ...identity, pid },
    options.probes === undefined ? {} : { probes: options.probes },
  ) === "dead";
};

/**
 * Removes the lock directory `lock` only when `verify(claimed)` accepts the
 * directory this process claimed by renaming it. Returns true when it removed
 * the lock, false when the claim failed or held another owner's lock.
 *
 * Stale-lock recovery must be an exclusive claim. Stat-then-delete is
 * TOCTOU: two reapers (or a reaper and a fresh writer that recreated the
 * lock in between) can both pass their checks, and the slower rm then
 * deletes a lock the faster one already replaced. rename() is the claim —
 * only one process can move the directory, and removal targets the claimed
 * path, never the live lock path. A claim that turns out to hold a live
 * lock is renamed back before any destructive step; a live lock is never
 * deleted, even if the rename-back races a fresh writer.
 */
export const reapLockByRenameClaim = (lock: string, verify: (claimed: string) => boolean): boolean => {
  const claim = `${lock}.reap-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(lock, claim);
  } catch {
    return false;
  }
  if (!verify(claim)) {
    try {
      fs.renameSync(claim, lock);
    } catch {
      // `lock` was recreated after the claim. Re-verify before any
      // destructive step so a claimed live lock is only ever abandoned as
      // garbage, never deleted.
      if (verify(claim)) fs.rmSync(claim, { recursive: true, force: true });
    }
    return false;
  }
  fs.rmSync(claim, { recursive: true, force: true });
  return true;
};

/**
 * Runs `refresh(now)` on an unref'd interval until the returned stop function
 * is called. Refresh failures are swallowed: a missed beat only ages the
 * record toward the TTL.
 */
export const startOwnerHeartbeat = (
  refresh: (heartbeatAt: number) => void,
  intervalMs = OWNER_HEARTBEAT_INTERVAL_MS,
): (() => void) => {
  const timer = setInterval(() => {
    try {
      refresh(Date.now());
    } catch {
      // The next beat retries; a stale heartbeat is the failure signal.
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
};
