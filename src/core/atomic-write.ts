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
  // Flush the temporary file before rename, its directory after rename, and
  // the directory's ancestor links. Subject to filesystem/platform support.
  fsync?: boolean;
  // Inclusive directory boundary for ancestor flushing (default: filesystem
  // root). Its parent chain must already be durable and must not be renamed
  // or replaced during the operation. Must contain the target directory.
  // Ignored without fsync. Useful for stores that establish their root once.
  durabilityRoot?: string;
}

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EEXIST", "EBUSY"]);

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;

// Portable synchronous sleep for the retry window (Atomics.wait is legal on
// the Node main thread). Undefined when SharedArrayBuffer or Atomics is
// unavailable; callers whose bound is a wait, not an attempt count, must then
// bound by the clock instead (releaseShortLock).
const blockingSleep: ((ms: number) => void) | undefined = (() => {
  try {
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    return (ms: number): void => {
      Atomics.wait(buffer, 0, 0, ms);
    };
  } catch {
    return undefined;
  }
})();

// Rename retries proceed immediately without a blocking sleep: still correct,
// just less cooperative under contention.
const syncSleep = (ms: number): void => blockingSleep?.(ms);

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

// Windows refuses to open or flush a directory with EPERM/EACCES/EISDIR. On
// POSIX the same EPERM/EACCES means the caller lacks access to a directory it
// asked to make durable, so it must surface rather than pass as unsupported.
export const unsupportedDirectoryFsyncCodes = (platform: NodeJS.Platform): ReadonlySet<string> =>
  new Set(["EINVAL", "ENOTSUP", "EISDIR", ...(platform === "win32" ? ["EPERM", "EACCES"] : [])]);

const UNSUPPORTED_DIRECTORY_FSYNC_CODES = unsupportedDirectoryFsyncCodes(process.platform);

/**
 * Flushes a directory entry table so a create or rename in it is durable.
 * Platforms that cannot open or flush a directory (Windows, some network
 * filesystems) report an error code that is ignored here; on POSIX a
 * permission error is rethrown.
 */
export const fsyncDirectory = (directory: string): void => {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = errorCode(error);
    if (code === undefined || !UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};

// Never infer durability from existence: another creator (or a failed prior
// attempt) may have made any of these directories without flushing its parent.
// No cache is populated before or after a barrier, so retries repeat the work.
const directoryBarriers = (directory: string, durabilityRoot?: string): string[] => {
  const resolved = path.resolve(directory);
  const boundary = durabilityRoot === undefined ? path.parse(resolved).root : path.resolve(durabilityRoot);
  const relative = path.relative(boundary, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("durabilityRoot must contain the target directory");
  }
  const parents: string[] = [];
  for (let current = resolved; ; current = path.dirname(current)) {
    const parent = path.dirname(current);
    if (parents.at(-1) !== parent) parents.push(parent);
    // path.relative also handles case-insensitive drive/root spellings on Windows.
    if (path.relative(boundary, current) === "") return parents;
  }
};

/**
 * mkdir -p plus barriers for every ancestor link, including pre-existing ones.
 * By default the crash boundary is the filesystem root. With an explicit
 * inclusive durabilityRoot, its parent chain must already be durable; require
 * that parent to exist so mkdir cannot silently create above the boundary.
 * Ancestors must not be concurrently renamed/replaced. Concurrent creators
 * and retries after failed mkdir/fsync are safe: all barriers run again.
 */
export const mkdirDurable = (
  directory: string,
  mode: number,
  fsync: boolean,
  durabilityRoot?: string,
): void => {
  if (!fsync) {
    fs.mkdirSync(directory, { recursive: true, mode });
    return;
  }
  const parents = directoryBarriers(directory, durabilityRoot);
  if (durabilityRoot !== undefined && !fs.statSync(parents.at(-1)!).isDirectory()) {
    throw new Error("durabilityRoot parent must be an existing durable directory");
  }
  fs.mkdirSync(directory, { recursive: true, mode });
  for (const parent of parents) fsyncDirectory(parent);
};

const fsyncDirectoryAsync = async (directory: string): Promise<void> => {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = errorCode(error);
    if (code === undefined || !UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(code)) throw error;
  } finally {
    await handle?.close();
  }
};

const mkdirDurableAsync = async (
  directory: string,
  mode: number,
  fsync: boolean,
  durabilityRoot?: string,
): Promise<void> => {
  if (!fsync) {
    await fs.promises.mkdir(directory, { recursive: true, mode });
    return;
  }
  const parents = directoryBarriers(directory, durabilityRoot);
  if (durabilityRoot !== undefined && !(await fs.promises.stat(parents.at(-1)!)).isDirectory()) {
    throw new Error("durabilityRoot parent must be an existing durable directory");
  }
  await fs.promises.mkdir(directory, { recursive: true, mode });
  for (const parent of parents) await fsyncDirectoryAsync(parent);
};

export const writeFileAtomic = (
  filePath: string,
  contents: string,
  options?: AtomicWriteOptions,
): void => {
  mkdirDurable(path.dirname(filePath), options?.dirMode ?? 0o700, options?.fsync === true, options?.durabilityRoot);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    if (options?.fsync) {
      const descriptor = fs.openSync(temporary, "wx", options.mode ?? 0o600);
      try {
        fs.writeFileSync(descriptor, contents, "utf8");
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    } else {
      fs.writeFileSync(temporary, contents, {
        encoding: "utf8",
        mode: options?.mode ?? 0o600,
      });
    }
    renameAtomic(temporary, filePath, options);
    if (options?.fsync) fsyncDirectory(path.dirname(filePath));
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

export const writeFileAtomicAsync = async (
  filePath: string,
  contents: string,
  options?: AtomicWriteOptions,
): Promise<void> => {
  await mkdirDurableAsync(path.dirname(filePath), options?.dirMode ?? 0o700, options?.fsync === true, options?.durabilityRoot);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    if (options?.fsync) {
      const handle = await fs.promises.open(temporary, "wx", options.mode ?? 0o600);
      try {
        await handle.writeFile(contents, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      await fs.promises.writeFile(temporary, contents, {
        encoding: "utf8",
        mode: options?.mode ?? 0o600,
      });
    }
    await renameAtomicAsync(temporary, filePath, options);
    if (options?.fsync) await fsyncDirectoryAsync(path.dirname(filePath));
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
 *
 * The ceiling has an inherent cost: a holder suspended past it (SIGSTOP, a
 * laptop sleep, a debugger) is reaped while it still believes it holds the
 * lock, and on resuming it can finish one write after another process took
 * the lock. Its release stays safe: releaseShortLock only removes a lock
 * whose owner file carries its own token, so it never frees the new holder.
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

// ---------------------------------------------------------------------------
// Short-lived directory locks (`mkdir` claim + `owner` file). Four stores share
// this protocol: the mesh store, the actor registry and binding stores, and
// the generic file lock. Their critical sections are synchronous or short
// file I/O, so a lock that outlives SHORT_LOCK_MAX_HOLD_MS has leaked.
//
// Owner file: `token\npid\ncreatedAt\n{identity}\n`. Older readers only
// consume the first three lines.

const CLAIM_INFIX = ".reap-";
/** How long a release keeps looking for a lock a reaper is holding. */
export const SHORT_LOCK_RELEASE_RETRY_MS = 25;
const CLAIM_SWEEP_INTERVAL_MS = 1_000;
// Upper bound on release attempts when no blocking sleep exists.
const RELEASE_SPIN_ATTEMPT_CAP = 10_000;
const DIGITS = /^\d+$/;

/** Owner file text for a short lock acquired with `token`. */
export const formatShortLockOwner = (token: string): string =>
  `${token}\n${process.pid}\n${Date.now()}\n${encodeOwnerIdentityLine()}\n`;

export interface ShortLockOwner {
  token: string;
  /** Absent when the pid line is missing or not a positive decimal pid. */
  pid?: number;
  /** Absent when the creation line is missing or not a decimal number. */
  createdAt?: number;
  identityLine?: string;
}

/**
 * Parses a short-lock owner file field by field. A missing, empty or partial
 * file yields no pid: such a lock says nothing about its owner and is judged
 * by its age alone, never as a dead owner.
 */
export const parseShortLockOwner = (text: string): ShortLockOwner => {
  const [token = "", pidText = "", createdText = "", identityLine] = text.split("\n").map((line) => line.trim());
  const pid = DIGITS.test(pidText) ? Number(pidText) : Number.NaN;
  const createdAt = DIGITS.test(createdText) ? Number(createdText) : Number.NaN;
  return {
    token,
    ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
    ...(Number.isSafeInteger(createdAt) ? { createdAt } : {}),
    ...(identityLine ? { identityLine } : {}),
  };
};

export interface ShortLockJudgeOptions {
  staleMs: number;
  /** The store's pre-identity probe for owners without an identity line. */
  legacyAlive?: (pid: number) => boolean;
  probes?: LivenessProbes;
}

/**
 * True when a short lock may be reaped.
 * - No usable pid (missing, empty or partial owner file): only when the lock
 *   is older than the stale window. Its owner may be mid-acquire.
 * - Within the stale window: only when the owner is provably dead.
 * - Older than max(SHORT_LOCK_MAX_HOLD_MS, staleMs): always. A live owner
 *   this old has leaked the lock; no critical section runs that long.
 * - Otherwise: when the owner is dead (namespace-safe liveness).
 * A creation time that is missing or in the future falls back to the
 * directory's mtime.
 * The hold ceiling lets a suspended holder finish one write after a reaper
 * took its lock; see SHORT_LOCK_MAX_HOLD_MS.
 */
export const shortLockReapable = (
  ownerText: string | undefined,
  lockModifiedAt: number | undefined,
  options: ShortLockJudgeOptions,
): boolean => {
  const now = (options.probes?.now ?? Date.now)();
  const owner = parseShortLockOwner(ownerText ?? "");
  const since = owner.createdAt !== undefined && owner.createdAt <= now
    ? owner.createdAt
    : lockModifiedAt;
  if (since === undefined) return false;
  const age = now - since;
  if (owner.pid === undefined) return age > options.staleMs;
  if (age <= options.staleMs) {
    return lockOwnerProvablyDead(
      owner.pid,
      owner.identityLine,
      options.probes === undefined ? {} : { probes: options.probes },
    );
  }
  const ceiling = Math.max(SHORT_LOCK_MAX_HOLD_MS, options.staleMs);
  if (age > ceiling) return true;
  return lockOwnerLiveness(owner.pid, since, owner.identityLine, {
    ...(options.legacyAlive === undefined ? {} : { legacyAlive: options.legacyAlive }),
    ...(options.probes === undefined ? {} : { probes: options.probes }),
    maxHoldMs: ceiling,
  }) === "dead";
};

const readOwnerText = (directory: string): string | undefined => {
  try {
    return fs.readFileSync(path.join(directory, "owner"), "utf8");
  } catch {
    return undefined;
  }
};

const modifiedAt = (directory: string): number | undefined => {
  try {
    return fs.statSync(directory).mtimeMs;
  } catch {
    return undefined;
  }
};

const ownerToken = (directory: string): string | undefined => readOwnerText(directory)?.split("\n", 1)[0];

/** Device and inode of a lock directory; bigint so Windows file ids stay exact. */
export interface LockInode {
  dev: bigint;
  ino: bigint;
}

const lockInode = (directory: string): LockInode | undefined => {
  try {
    const { dev, ino } = fs.lstatSync(directory, { bigint: true });
    return { dev, ino };
  } catch {
    return undefined;
  }
};

const sameInode = (left: LockInode, right: LockInode): boolean =>
  left.dev === right.dev && left.ino === right.ino;

// link() is unsupported on some filesystems (FAT/exFAT, some network and
// FUSE mounts, sandboxes that forbid hard links).
const LINK_UNSUPPORTED_CODES = new Set(["EPERM", "ENOTSUP", "EXDEV", "ENOSYS"]);

/**
 * Publishes `temporary` as `ownerPath` without replacing an existing owner:
 * link() fails EEXIST where rename() would overwrite. Returns false on EEXIST.
 * Where link() is unsupported, rename() is safe only after checking for an
 * existing owner *with the unique temporary already inside the directory*.
 * That nonempty directory cannot be replaced by a rename-back. If it moves,
 * rename's unique source disappears too, so publication fails with ENOENT.
 * This assumes cooperating clients move whole lock directories, not temps.
 */
const publishShortLockOwner = (temporary: string, ownerPath: string): boolean => {
  try {
    fs.linkSync(temporary, ownerPath);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") return false;
    if (code === undefined || !LINK_UNSUPPORTED_CODES.has(code)) throw error;
    try {
      fs.lstatSync(ownerPath);
      return false;
    } catch (ownerError) {
      if (errorCode(ownerError) !== "ENOENT") throw ownerError;
    }
    renameAtomic(temporary, ownerPath);
    return true;
  }
  try {
    fs.unlinkSync(temporary);
  } catch {
    // The lock is held; a leftover temp leaves with the directory.
  }
  return true;
};

/** A fresh claim path beside `lock`; the `t<ms>` part dates it for sweeps. */
const claimPath = (lock: string): string =>
  `${lock}${CLAIM_INFIX}${process.pid}-t${Date.now()}-${randomUUID()}`;

/** Claim directories beside `lock`, as absolute paths. */
const listClaims = (lock: string, strict = false): string[] => {
  const prefix = `${path.basename(lock)}${CLAIM_INFIX}`;
  try {
    return fs.readdirSync(path.dirname(lock))
      .filter((name: string) => name.startsWith(prefix))
      .map((name: string) => path.join(path.dirname(lock), name));
  } catch (error) {
    if (strict) throw error;
    return [];
  }
};

/**
 * Creates the lock directory exclusively and publishes its owner file
 * atomically. `mkdir` stays the canonical claim, as in older versions.
 * Upgraded acquirers additionally refuse in-flight rename claims (see below).
 * The owner is written to a
 * temporary file inside the lock and hard-linked into place: a reader sees no
 * owner (judged by the directory's age) or a complete one, never an empty or
 * partial owner. Returns false on contention.
 *
 * The link refuses to publish over an existing owner. A reaper whose claim
 * held a live lock renames it back, and POSIX rename() silently replaces the
 * empty directory this call just created. Publishing then targets the other
 * owner's directory; link() fails EEXIST, so this returns false and removes
 * only its own temporary file, never the directory (it is the other owner's
 * lock). See publishShortLockOwner for the rename fallback.
 *
 * After publication, a strict claim scan is followed by canonical inode and
 * owner verification. A displaced successful holder remains in a claim, so
 * no successor may enter until it is restored or released. If displacement
 * occurs after this scan/check, the next acquirer sees that claim instead.
 * Fail closed on scan errors. Older binaries do not honor this barrier and
 * retain their rename-window race; ordinary mixed-version mkdir contention
 * still works. See docs/short-lock-protocol.md.
 */
export const tryAcquireShortLock = (lock: string, ownerText: string): boolean => {
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
  const created = lockInode(lock);
  const temporary = path.join(lock, `owner.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, ownerText, { encoding: "utf8", mode: 0o600 });
    if (publishShortLockOwner(temporary, path.join(lock, "owner"))) {
      try {
        const claims = listClaims(lock, true);
        const canonical = lockInode(lock);
        if (claims.length === 0 && created !== undefined && canonical !== undefined
          && sameInode(created, canonical) && readOwnerText(lock) === ownerText) return true;
      } catch {
        // Cannot establish exclusion: withdraw, never enter the critical section.
      }
      releaseShortLock(lock, parseShortLockOwner(ownerText).token, 0);
      return false;
    }
  } catch (error) {
    // ENOENT: a reaper claimed the directory mid-publish. Whatever it puts
    // back has no owner and ages out; retry as contention.
    if (errorCode(error) === "ENOENT") return false;
    try {
      fs.rmSync(temporary, { force: true });
      // Only an empty directory is removed: never another owner's lock.
      fs.rmdirSync(lock);
    } catch {
      // The lock ages out.
    }
    throw error;
  }
  // EEXIST: another owner's live lock sits at `lock`. Contention.
  try {
    fs.rmSync(temporary, { force: true });
  } catch {
    // A stray temp leaves with that owner's directory.
  }
  return false;
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
 * deleted, even if the rename-back races a fresh writer. A live owner that
 * releases while its lock sits at the claim path takes it from there
 * (releaseShortLock), so the rename-back then finds nothing to restore.
 *
 * `expected` is the lock directory's inode when the caller judged it (stat it
 * before reading the owner); without it the lock is stat'd just before the
 * rename. When the claimed directory is a different inode, the lock was
 * reaped and re-acquired in between: the claim holds someone else's live
 * lock, so it is renamed back at once, without reading its owner or calling
 * `verify`, and never deleted. If that rename-back fails it is left for its
 * owner's release or the claim sweep.
 *
 * The claim itself is an acquisition barrier even on an inode mismatch.
 * A successor can populate the canonical directory but must withdraw before
 * entering its critical section while this claim exists. Restoration may
 * still fail; the barrier then persists until owner release or safe stale
 * cleanup. No compare-and-rename primitive or recursively reaped guard is
 * needed. Inode reuse is not detected here; `verify` also compares the owner.
 */
export const reapLockByRenameClaim = (
  lock: string,
  verify: (claimed: string) => boolean,
  expected: LockInode | undefined = lockInode(lock),
): boolean => {
  if (expected === undefined) return false;
  const claim = claimPath(lock);
  try {
    fs.renameSync(lock, claim);
  } catch {
    return false;
  }
  const claimed = lockInode(claim);
  if (claimed === undefined || !sameInode(claimed, expected)) {
    try {
      fs.renameSync(claim, lock);
    } catch {
      // Left as a claim: its owner's release takes it, or the sweep does.
    }
    return false;
  }
  if (!verify(claim)) {
    try {
      fs.renameSync(claim, lock);
    } catch {
      // `lock` was recreated after the claim, or the owner released from the
      // claim path. Re-verify before any destructive step so a claimed live
      // lock is only ever left for its owner's release or the stale sweep,
      // never deleted.
      if (verify(claim)) fs.rmSync(claim, { recursive: true, force: true });
    }
    return false;
  }
  fs.rmSync(claim, { recursive: true, force: true });
  return true;
};

const lastClaimSweep = new Map<string, number>();

/**
 * Removes claim directories beside `lock` older than `staleMs`: reapers or
 * releasers that died mid-claim, or rename-backs that lost a race. Claims
 * are acquisition barriers: age alone must not discard a displaced live
 * holder. Require the ordinary owner-staleness verdict too. Returns the count.
 *
 * A claim's age comes from the `t<ms>` stamp in its name, which is the
 * claimant's clock, not this process's: a claimant whose clock runs ahead
 * makes its claim look younger, one that runs behind makes it look older.
 * Claims without a stamp (older versions) fall back to the directory's mtime,
 * which is when its contents last changed, not when it was claimed.
 */
export const sweepStaleLockClaims = (lock: string, staleMs: number, now = Date.now()): number => {
  let removed = 0;
  for (const claim of listClaims(lock)) {
    const stamp = /-t(\d{1,15})-[^-]/.exec(path.basename(claim).slice(path.basename(lock).length + CLAIM_INFIX.length));
    let since = stamp ? Number(stamp[1]) : Number.NaN;
    if (!Number.isSafeInteger(since)) {
      try {
        since = fs.lstatSync(claim).mtimeMs;
      } catch {
        continue;
      }
    }
    if (now - since <= staleMs) continue;
    let owner: string | undefined;
    try {
      owner = fs.readFileSync(path.join(claim, "owner"), "utf8");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") continue;
    }
    if (!shortLockReapable(owner, modifiedAt(claim), { staleMs, probes: { now: () => now } })) continue;
    try {
      fs.rmSync(claim, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Another sweeper or the owner's release got there first.
    }
  }
  return removed;
};

/**
 * One stale-lock recovery step for a contended short lock: sweeps old claim
 * directories (at most once a second per lock and process), judges the lock
 * with shortLockReapable, and removes it through a rename claim that
 * re-verifies the same owner text and verdict. True when it removed the lock
 * and acquisition should retry at once. Never throws.
 */
export const reapStaleShortLock = (lock: string, options: ShortLockJudgeOptions): boolean => {
  try {
    const now = Date.now();
    if (now - (lastClaimSweep.get(lock) ?? 0) >= CLAIM_SWEEP_INTERVAL_MS) {
      lastClaimSweep.set(lock, now);
      if (lastClaimSweep.size > 256) lastClaimSweep.delete(lastClaimSweep.keys().next().value!);
      sweepStaleLockClaims(lock, options.staleMs, now);
    }
    // Stat before reading: the rename claim must take this same directory.
    const judged = lockInode(lock);
    if (judged === undefined) return false;
    const owner = readOwnerText(lock);
    const lockModifiedAt = modifiedAt(lock);
    if (lockModifiedAt === undefined) return false;
    if (!shortLockReapable(owner, lockModifiedAt, options)) return false;
    // Re-read: a rotated owner is judged afresh on the next attempt.
    if (readOwnerText(lock) !== owner) return false;
    return reapLockByRenameClaim(lock, (claimed) =>
      readOwnerText(claimed) === owner && shortLockReapable(owner, modifiedAt(claimed), options), judged);
  } catch {
    return false;
  }
};

/** Moves `source` to a private claim and deletes it when it holds `token`. */
const takeOwnLock = (lock: string, source: string, token: string): boolean => {
  if (ownerToken(source) !== token) return false;
  const trash = claimPath(lock);
  try {
    fs.renameSync(source, trash);
  } catch {
    return false;
  }
  if (ownerToken(trash) === token) {
    fs.rmSync(trash, { recursive: true, force: true });
    return true;
  }
  // Another owner's directory replaced ours between the read and the rename.
  try {
    fs.renameSync(trash, source);
  } catch {
    // Left as a claim: its owner's release takes it, or the sweep does.
  }
  return false;
};

/**
 * Releases a short lock acquired with `token`. The lock may be sitting at a
 * reaper's claim path (`<lock>.reap-*`) while the reaper verifies it; the
 * release then takes it from there, so the reaper's rename-back finds nothing
 * and cannot restore a released lock. A rename-back may also land between
 * two checks, so the release retries for a bounded few milliseconds.
 * Returns false when the lock was not found (reaped, or replaced by an
 * owner with another token, which is never touched).
 */
export const releaseShortLock = (
  lock: string,
  token: string,
  retryMs = SHORT_LOCK_RELEASE_RETRY_MS,
): boolean => {
  // With a blocking sleep the bound is counted in 1 ms sleeps, not wall-clock
  // reads, so a frozen or faked clock cannot turn it into a spin. Without one,
  // counting attempts would collapse the window to microseconds, so the clock
  // bounds it and a hard attempt cap still stops a frozen or rewound clock.
  const deadline = Date.now() + retryMs;
  for (let attempt = 0; ; attempt++) {
    try {
      if (takeOwnLock(lock, lock, token)) return true;
      for (const claim of listClaims(lock)) {
        if (takeOwnLock(lock, claim, token)) return true;
      }
    } catch {
      // Raced with a reaper or sweeper; look again.
    }
    if (blockingSleep !== undefined) {
      if (attempt >= retryMs) return false;
      blockingSleep(1);
    } else if (attempt >= RELEASE_SPIN_ATTEMPT_CAP || Date.now() >= deadline) {
      return false;
    }
  }
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
