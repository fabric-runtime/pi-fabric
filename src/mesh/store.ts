import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  writeFileAtomic,
  encodeOwnerIdentityLine,
  lockOwnerLiveness,
  lockOwnerProvablyDead,
  reapLockByRenameClaim,
  SHORT_LOCK_MAX_HOLD_MS,
} from "../core/atomic-write.js";
import { readJsonlPage } from "../log-tail.js";
import { captureStoragePut, captureStorageDelete, storageRevision } from "../verified/storage.js";
import type { FabricMessageSender } from "../protocol.js";
import { processSender } from "../scope.js";

export interface MeshIdentity {
  id: string;
  name: string;
  kind: "main" | "actor" | "agent";
  sessionId?: string;
}

export interface MeshEvent {
  id: string;
  sequence: number;
  topic: string;
  kind: string;
  from: MeshIdentity;
  to?: string;
  text?: string;
  data?: unknown;
  createdAt: number;
  /** Set on events appended through a scoped external grant (`pi-fabric mesh post`). */
  origin?: "external";
  untrusted?: true;
  grantId?: string;
  /** Set on events released from a pending schedule; the event id is the schedule id. */
  scheduled?: { dueAt: number; key?: string };
  /** Host-stamped authority of the publishing process; absent from older builds and grant posts. */
  sender?: FabricMessageSender;
}

/** Host-internal append request used inside {@link MeshStore.transact}. */
export interface MeshAppendInput {
  id?: string;
  topic: string;
  kind?: string;
  from: MeshIdentity;
  to?: string;
  text?: string;
  data?: unknown;
  origin?: "external";
  untrusted?: true;
  grantId?: string;
  scheduled?: { dueAt: number; key?: string };
  sender?: FabricMessageSender;
  /** A tighter per-event byte ceiling than the store's own. */
  maxEventBytes?: number;
}

/** A pending scheduled event; released into its topic log once due. */
export interface MeshSchedule {
  id: string;
  key?: string;
  topic: string;
  kind: string;
  from: MeshIdentity;
  to?: string;
  text?: string;
  data?: unknown;
  dueAt: number;
  createdAt: number;
  /** Stamped when scheduled; carried onto the released event. */
  sender?: FabricMessageSender;
}

interface MeshScheduleFile {
  format: 1;
  schedules: MeshSchedule[];
}

export interface MeshTailResult {
  events: MeshEvent[];
  nextOffset: number;
}

export interface MeshStateEntry {
  key: string;
  value: unknown;
  version: number;
  updatedAt: number;
  updatedBy: MeshIdentity;
}

interface MeshStateFile {
  format: 1 | 2;
  revisionFormat?: 2;
  entries: Record<string, MeshStateEntry>;
  versions?: Record<string, number>;
  tombstoneOrder?: string[];
  /** Persisted allocation clock; never evicted with per-key tombstones. */
  highWater?: number;
}

export interface MeshStoreOptions {
  maxEventLogBytes?: number;
  retainedEventLogBytes?: number;
  maxStateBytes?: number;
  maxStateTombstones?: number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

const TOPIC_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/;

export const validateMeshTopic = (topic: string): void => {
  if (!TOPIC_PATTERN.test(topic)) throw new Error(`Invalid Fabric mesh topic: ${topic}`);
};
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;
const DEFAULT_MAX_EVENT_LOG_BYTES = 64 * 1024 * 1024;
const DEFAULT_RETAINED_EVENT_LOG_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STATE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_STATE_TOMBSTONES = 10_000;
const EVENT_READ_PAGE_BYTES = 4 * 1024 * 1024;
const EVENT_READ_CHUNK_BYTES = 64 * 1024;
const CURSOR_OFFSET_BASE = 2 ** 32;
export const MESH_MAX_PENDING_SCHEDULES = 1_000;
export const MESH_MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60 * 1_000;
const MAX_SCHEDULE_FILE_BYTES = 16 * 1024 * 1024;
const SCHEDULE_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const processAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const jsonClone = <T>(value: T): T => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Mesh values must be JSON-serializable");
  return JSON.parse(serialized) as T;
};

const isMeshStateFile = (value: unknown): value is MeshStateFile => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![1, 2].includes((value as { format?: unknown }).format as number)
  ) {
    return false;
  }
  const entries = (value as { entries?: unknown }).entries;
  return typeof entries === "object" && entries !== null && !Array.isArray(entries);
};

const recoverConcatenatedState = (serialized: string): MeshStateFile | undefined => {
  const snapshots: MeshStateFile[] = [];
  let documents = 0;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < serialized.length; index += 1) {
    const character = serialized[index]!;
    if (start < 0) {
      if (/\s/.test(character)) continue;
      if (character !== "{") return undefined;
      start = index;
      depth = 1;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth !== 0) continue;
      try {
        const parsed: unknown = JSON.parse(serialized.slice(start, index + 1));
        documents += 1;
        if (isMeshStateFile(parsed)) snapshots.push(parsed);
      } catch {
        return undefined;
      }
      start = -1;
    }
  }

  return start < 0 && documents > 1 ? snapshots.at(-1) : undefined;
};

const compareSchedules = (left: MeshSchedule, right: MeshSchedule): number =>
  left.dueAt - right.dueAt || left.createdAt - right.createdAt || left.id.localeCompare(right.id);

const isMeshSchedule = (value: unknown): value is MeshSchedule => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Partial<MeshSchedule>;
  return typeof entry.id === "string" && typeof entry.topic === "string" &&
    typeof entry.kind === "string" && typeof entry.from === "object" && entry.from !== null &&
    Number.isSafeInteger(entry.dueAt) && Number.isSafeInteger(entry.createdAt) &&
    (entry.key === undefined || typeof entry.key === "string");
};

const emptyState = (): MeshStateFile => ({ format: 1, revisionFormat: 2, entries: {}, highWater: 0 });

const readState = (filePath: string, maxBytes: number, recoverDamage = true): MeshStateFile => {
  let serialized: string;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) throw new Error(`state exceeds ${maxBytes} bytes`);
    if (stat.size === 0 && recoverDamage) return emptyState();
    serialized = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return emptyState();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read Fabric mesh state: ${message}`);
  }
  if (!serialized.trim() && recoverDamage) return emptyState();
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (isMeshStateFile(parsed)) return parsed;
    throw new Error("invalid state format");
  } catch (error) {
    // Failed parsing must not silently erase the allocation clock. Read-only
    // startup can tolerate damage, but mutations require a repaired snapshot.
    const recovered = recoverConcatenatedState(serialized);
    if (recovered) return recovered;
    if (!recoverDamage) throw new Error("Failed to read Fabric mesh state: invalid state format");
    // Preserve the original bytes at this path as a barrier to clock reset.
    return emptyState();
  }
};

const atomicWrite = (filePath: string, value: unknown, maxBytes = Number.POSITIVE_INFINITY): void => {
  const serialized = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error(`Fabric mesh state exceeds ${maxBytes} bytes`);
  }
  writeFileAtomic(filePath, serialized);
};

// Host invariant for the proved reducer: the persisted clock covers every
// issued token. Legacy files can seed only from retained entries/tombstones;
// tokens already evicted before this migration cannot be reconstructed.
const stateSlot = (state: MeshStateFile, key: string): {
  present: boolean; version: number; highWater: number;
} => {
  if (state.versions !== undefined &&
      (typeof state.versions !== "object" || state.versions === null || Array.isArray(state.versions))) {
    throw new Error("Invalid Fabric mesh revision table");
  }
  let retainedMaximum = 0;
  for (const revision of Object.values(state.versions ?? {})) {
    retainedMaximum = Math.max(retainedMaximum, storageRevision(revision));
  }
  for (const [entryKey, entry] of Object.entries(state.entries)) {
    if (typeof entry !== "object" || entry === null || entry.key !== entryKey) {
      throw new Error("Invalid Fabric mesh state entry");
    }
    const version = storageRevision(entry.version);
    const retained = state.versions !== undefined && Object.hasOwn(state.versions, entryKey)
      ? state.versions[entryKey] : undefined;
    if (version === 0 || (retained !== undefined && retained !== version)) {
      throw new Error("Inconsistent Fabric mesh revision");
    }
    retainedMaximum = Math.max(retainedMaximum, version);
  }
  // New snapshots require their clock: losing it must not look like legacy
  // migration and silently reissue revisions from an evicted history.
  if (Object.hasOwn(state, "revisionFormat") && state.revisionFormat !== 2) {
    throw new Error("Unsupported Fabric mesh revision protocol");
  }
  if ((state.format === 2 || state.revisionFormat === 2) && !Object.hasOwn(state, "highWater")) {
    throw new Error("Missing Fabric mesh high-water revision");
  }
  const highWater = Object.hasOwn(state, "highWater")
    ? storageRevision(state.highWater) : retainedMaximum;
  if (highWater < retainedMaximum) throw new Error("Inconsistent Fabric mesh high-water revision");
  const present = Object.hasOwn(state.entries, key);
  const version = present ? state.entries[key]!.version
    : state.versions !== undefined && Object.hasOwn(state.versions, key) ? state.versions[key]! : 0;
  return { present, version, highWater };
};

const compactStateTombstones = (state: MeshStateFile, maxTombstones: number): void => {
  state.versions ??= {};
  const orderedKeys: string[] = [];
  const seen = new Set<string>();
  for (const key of state.tombstoneOrder ?? []) {
    if (Object.hasOwn(state.entries, key) || !Object.hasOwn(state.versions, key) || seen.has(key)) continue;
    seen.add(key);
    orderedKeys.push(key);
  }
  for (const key of Object.keys(state.versions)) {
    if (Object.hasOwn(state.entries, key) || seen.has(key)) continue;
    seen.add(key);
    orderedKeys.push(key);
  }
  const retainedKeys = orderedKeys.slice(-maxTombstones);
  const retained = new Set(retainedKeys);
  for (const key of Object.keys(state.versions)) {
    if (!Object.hasOwn(state.entries, key) && !retained.has(key)) delete state.versions[key];
  }
  state.tombstoneOrder = retainedKeys;
};

export class MeshStore {
  readonly #eventsPath: string;
  readonly #statePath: string;
  readonly #counterPath: string;
  readonly #generationPath: string;
  readonly #lockPath: string;
  readonly #maxEventLogBytes: number;
  readonly #retainedEventLogBytes: number;
  readonly #maxStateBytes: number;
  readonly #maxStateTombstones: number;
  readonly #lockTimeoutMs: number;
  readonly #staleLockMs: number;
  #stateCache:
    | { device: number; inode: number; size: number; modifiedAt: number; state: MeshStateFile }
    | undefined;
  readonly #schedulesPath: string;
  #scheduleCache:
    | { inode: number; size: number; modifiedAt: number; file: MeshScheduleFile; error?: string }
    | undefined;

  constructor(
    readonly root: string,
    readonly maxEventBytes: number,
    readonly maxReadEvents: number,
    options: MeshStoreOptions = {},
  ) {
    this.#eventsPath = path.join(root, "events.jsonl");
    this.#statePath = path.join(root, "state.json");
    this.#counterPath = path.join(root, "sequence");
    this.#generationPath = path.join(root, "generation");
    this.#lockPath = path.join(root, ".lock");
    // Pending schedules live beside state.json, outside the verified storage
    // revision table: they are serialized by this lock, not by key CAS.
    this.#schedulesPath = path.join(root, "schedules.json");
    this.#maxEventLogBytes = Math.min(
      CURSOR_OFFSET_BASE - 1,
      Math.max(maxEventBytes + 2, Math.floor(options.maxEventLogBytes ?? DEFAULT_MAX_EVENT_LOG_BYTES)),
    );
    this.#retainedEventLogBytes = Math.min(
      this.#maxEventLogBytes - 1,
      Math.max(
        maxEventBytes + 1,
        Math.floor(options.retainedEventLogBytes ?? DEFAULT_RETAINED_EVENT_LOG_BYTES),
      ),
    );
    this.#maxStateBytes = Math.max(
      maxEventBytes * 2,
      Math.floor(options.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES),
    );
    this.#maxStateTombstones = Math.max(
      1,
      Math.floor(options.maxStateTombstones ?? DEFAULT_MAX_STATE_TOMBSTONES),
    );
    this.#lockTimeoutMs = Math.max(100, Math.floor(options.lockTimeoutMs ?? LOCK_TIMEOUT_MS));
    this.#staleLockMs = Math.max(100, Math.floor(options.staleLockMs ?? STALE_LOCK_MS));
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  async publish(input: {
    topic: string;
    kind?: string;
    from: MeshIdentity;
    to?: string;
    text?: string;
    data?: unknown;
    /** Host-only: publish on behalf of another authority (an actor's scope). */
    sender?: FabricMessageSender;
  }): Promise<MeshEvent> {
    this.#validateTopic(input.topic);
    if (input.to !== undefined && !input.to.trim()) throw new Error("Mesh recipient is empty");
    const eventData = input.data === undefined ? undefined : jsonClone(input.data);
    const sender = input.sender ?? processSender();
    return this.#withLock(() => {
      // Any write that already holds the lock also releases due schedules first,
      // so the log keeps due-time order relative to this event. Damaged
      // schedule state must not block ordinary publishing.
      try { this.#releaseDueLocked(Date.now()); } catch { /* schedule mutations report it */ }
      return this.#appendLocked({ ...input, ...(eventData !== undefined ? { data: eventData } : {}), sender });
    });
  }

  /**
   * Host-internal: runs `operation` under the mesh lock with an append
   * capability, for side stores (grants) that must commit with an event.
   */
  async transact<T>(operation: (append: (input: MeshAppendInput) => MeshEvent) => T): Promise<T> {
    return this.#withLock(() => {
      try { this.#releaseDueLocked(Date.now()); } catch { /* schedule mutations report it */ }
      return operation((input) => {
        this.#validateTopic(input.topic);
        return this.#appendLocked(input);
      });
    });
  }

  #appendLocked(input: MeshAppendInput): MeshEvent {
    this.#repairEventLog();
    const sequence = Math.max(this.#readSequence(), this.#readLastEventSequence()) + 1;
    const event: MeshEvent = {
      id: input.id ?? randomUUID(),
      sequence,
      topic: input.topic,
      kind: input.kind?.trim() || "message",
      from: jsonClone(input.from),
      ...(input.to ? { to: input.to } : {}),
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.data !== undefined ? { data: jsonClone(input.data) } : {}),
      createdAt: Date.now(),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.untrusted ? { untrusted: true as const } : {}),
      ...(input.grantId ? { grantId: input.grantId } : {}),
      ...(input.scheduled ? { scheduled: { ...input.scheduled } } : {}),
      ...(input.sender ? { sender: jsonClone(input.sender) } : {}),
    };
    const line = JSON.stringify(event);
    const limit = Math.min(this.maxEventBytes, input.maxEventBytes ?? this.maxEventBytes);
    if (Buffer.byteLength(line, "utf8") > limit) {
      throw new Error(`Mesh event exceeds ${limit} bytes`);
    }
    fs.appendFileSync(this.#eventsPath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    atomicWrite(this.#counterPath, sequence);
    this.#compactEventLog();
    return event;
  }

  /**
   * Stores a pending event released into `topic` once `dueAt` passes. A `key`
   * replaces any pending schedule with that key in the same locked write, so
   * concurrent publishers never leave two schedules for one key.
   */
  async schedule(input: {
    topic: string;
    kind?: string;
    from: MeshIdentity;
    to?: string;
    text?: string;
    data?: unknown;
    dueAt: number;
    key?: string;
  }, now = Date.now()): Promise<MeshSchedule> {
    this.#validateTopic(input.topic);
    if (input.to !== undefined && !input.to.trim()) throw new Error("Mesh recipient is empty");
    if (input.key !== undefined && !SCHEDULE_KEY_PATTERN.test(input.key)) {
      throw new Error(`Invalid Fabric mesh schedule key: ${input.key}`);
    }
    if (!Number.isSafeInteger(input.dueAt) || input.dueAt < 0) {
      throw new Error("Mesh schedule due time must be a nonnegative epoch millisecond integer");
    }
    if (input.dueAt > now + MESH_MAX_SCHEDULE_AHEAD_MS) {
      throw new Error("Mesh schedules may be at most 366 days ahead");
    }
    const schedule: MeshSchedule = {
      id: randomUUID(),
      ...(input.key !== undefined ? { key: input.key } : {}),
      topic: input.topic,
      kind: input.kind?.trim() || "message",
      from: jsonClone(input.from),
      ...(input.to ? { to: input.to } : {}),
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.data !== undefined ? { data: jsonClone(input.data) } : {}),
      dueAt: input.dueAt,
      createdAt: now,
      sender: processSender(),
    };
    // Reject at schedule time what release could never append.
    const released: MeshEvent = {
      id: schedule.id, sequence: Number.MAX_SAFE_INTEGER, topic: schedule.topic, kind: schedule.kind,
      from: schedule.from, ...(schedule.to ? { to: schedule.to } : {}),
      ...(schedule.text !== undefined ? { text: schedule.text } : {}),
      ...(schedule.data !== undefined ? { data: schedule.data } : {}),
      createdAt: Number.MAX_SAFE_INTEGER,
      scheduled: { dueAt: schedule.dueAt, ...(schedule.key !== undefined ? { key: schedule.key } : {}) },
      ...(schedule.sender ? { sender: schedule.sender } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(released), "utf8") > this.maxEventBytes) {
      throw new Error(`Mesh event exceeds ${this.maxEventBytes} bytes`);
    }
    return this.#withLock(() => {
      const file = this.#readSchedules(false);
      const pending = file.schedules.filter((entry) => input.key === undefined || entry.key !== input.key);
      if (pending.length >= MESH_MAX_PENDING_SCHEDULES) {
        throw new Error(`At most ${MESH_MAX_PENDING_SCHEDULES} mesh schedules may be pending`);
      }
      pending.push(schedule);
      this.#writeSchedules(pending);
      this.#releaseDueLocked(now);
      return jsonClone(schedule);
    });
  }

  /** Removes the pending schedule with `key`, if any. */
  async unschedule(key: string): Promise<{ removed: boolean }> {
    if (!SCHEDULE_KEY_PATTERN.test(key)) throw new Error(`Invalid Fabric mesh schedule key: ${key}`);
    return this.#withLock(() => {
      const file = this.#readSchedules(false);
      const pending = file.schedules.filter((entry) => entry.key !== key);
      if (pending.length === file.schedules.length) return { removed: false };
      this.#writeSchedules(pending);
      return { removed: true };
    });
  }

  /** Pending schedules by due time; a due one stays listed until a releaser appends it. */
  scheduled(input: { topic?: string; limit?: number } = {}): MeshSchedule[] {
    if (input.topic !== undefined) this.#validateTopic(input.topic);
    const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 100), MESH_MAX_PENDING_SCHEDULES));
    return this.#readSchedules(true).schedules
      .filter((entry) => input.topic === undefined || entry.topic === input.topic)
      .sort(compareSchedules)
      .slice(0, limit)
      .map((entry) => jsonClone(entry));
  }

  /** Earliest pending due time, read without the lock (one stat when unchanged). */
  nextScheduleDueAt(): number | undefined {
    let next: number | undefined;
    for (const entry of this.#readSchedules(true).schedules) {
      if (next === undefined || entry.dueAt < next) next = entry.dueAt;
    }
    return next;
  }

  /**
   * Appends every due schedule to its topic and removes it, under the mesh
   * lock, so concurrent releasers (monitors, resident hosts, CLI posts) append
   * each schedule once. The lock is taken only when something is due.
   */
  async releaseDueSchedules(now = Date.now()): Promise<MeshEvent[]> {
    const next = this.nextScheduleDueAt();
    if (next === undefined || next > now) return [];
    return this.#withLock(() => this.#releaseDueLocked(now));
  }

  #releaseDueLocked(now: number): MeshEvent[] {
    if (!fs.existsSync(this.#schedulesPath)) return [];
    const file = this.#readSchedules(false);
    const due = file.schedules.filter((entry) => entry.dueAt <= now).sort(compareSchedules);
    if (due.length === 0) return [];
    const released: MeshEvent[] = [];
    const releasedIds = new Set<string>();
    try {
      // Events first, then the shrunken schedule file: a crash in between
      // re-releases with the same event id (at-least-once, dedupe by id).
      for (const entry of due) {
        released.push(this.#appendLocked({
          id: entry.id,
          topic: entry.topic,
          kind: entry.kind,
          from: entry.from,
          ...(entry.to ? { to: entry.to } : {}),
          ...(entry.text !== undefined ? { text: entry.text } : {}),
          ...(entry.data !== undefined ? { data: entry.data } : {}),
          scheduled: { dueAt: entry.dueAt, ...(entry.key !== undefined ? { key: entry.key } : {}) },
          // Older schedules stay unstamped: the releasing host never lends its own authority.
          ...(entry.sender ? { sender: entry.sender } : {}),
        }));
        releasedIds.add(entry.id);
      }
    } finally {
      if (releasedIds.size > 0) {
        this.#writeSchedules(file.schedules.filter((entry) => !releasedIds.has(entry.id)));
      }
    }
    return released;
  }

  #readSchedules(lenient: boolean): MeshScheduleFile {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.#schedulesPath);
    } catch (error) {
      this.#scheduleCache = undefined;
      if (errorCode(error) === "ENOENT") return { format: 1, schedules: [] };
      throw error;
    }
    // Locked mutations always re-read; the stat-keyed cache serves only lockless reads.
    const cached = lenient ? this.#scheduleCache : undefined;
    if (cached && cached.inode === stat.ino && cached.size === stat.size && cached.modifiedAt === stat.mtimeMs) {
      return cached.error === undefined ? cached.file : { format: 1, schedules: [] };
    }
    let file: MeshScheduleFile = { format: 1, schedules: [] };
    let damage: string | undefined;
    try {
      if (stat.size > MAX_SCHEDULE_FILE_BYTES) throw new Error(`exceeds ${MAX_SCHEDULE_FILE_BYTES} bytes`);
      const parsed = JSON.parse(fs.readFileSync(this.#schedulesPath, "utf8")) as Partial<MeshScheduleFile>;
      if (parsed?.format !== 1 || !Array.isArray(parsed.schedules) || !parsed.schedules.every(isMeshSchedule)) {
        throw new Error("invalid format");
      }
      file = { format: 1, schedules: parsed.schedules };
    } catch (error) {
      damage = error instanceof Error ? error.message : String(error);
    }
    this.#scheduleCache = {
      inode: stat.ino, size: stat.size, modifiedAt: stat.mtimeMs, file, ...(damage !== undefined ? { error: damage } : {}),
    };
    if (damage === undefined) return file;
    // Reads tolerate damage; mutations refuse to overwrite it silently.
    if (lenient) return { format: 1, schedules: [] };
    throw new Error(`Failed to read Fabric mesh schedules: ${damage}`);
  }

  #writeSchedules(schedules: MeshSchedule[]): void {
    if (schedules.length === 0) {
      fs.rmSync(this.#schedulesPath, { force: true });
      this.#scheduleCache = undefined;
      return;
    }
    atomicWrite(this.#schedulesPath, { format: 1, schedules }, MAX_SCHEDULE_FILE_BYTES);
    this.#scheduleCache = undefined;
  }

  read(
    input: {
      after?: number;
      topic?: string;
      to?: string;
      limit?: number;
    } = {},
  ): MeshEvent[] {
    if (input.topic !== undefined) this.#validateTopic(input.topic);
    const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 100), this.maxReadEvents));
    const events =
      input.after === undefined
        ? this.#readRecentEvents(input, limit)
        : this.#readEventsAfter(Math.max(0, Math.floor(input.after)), input, limit);
    return events.map((event) => jsonClone(event));
  }

  latestSequence(): number {
    return Math.max(this.#readSequence(), this.#readLastEventSequence());
  }

  latestOffset(): number {
    const generation = this.#readGeneration();
    let descriptor: number | undefined;
    let completeOffset = 0;
    try {
      descriptor = fs.openSync(this.#eventsPath, "r");
      const size = fs.fstatSync(descriptor).size;
      if (size > 0) {
        const lastByte = Buffer.allocUnsafe(1);
        fs.readSync(descriptor, lastByte, 0, 1, size - 1);
        if (lastByte[0] === 0x0a) {
          completeOffset = size;
        } else {
          const readBytes = Math.min(size, this.maxEventBytes + 1);
          const tail = Buffer.allocUnsafe(readBytes);
          fs.readSync(descriptor, tail, 0, readBytes, size - readBytes);
          const newline = tail.lastIndexOf(0x0a);
          completeOffset = newline >= 0 ? size - readBytes + newline + 1 : 0;
        }
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    return this.#encodeCursor(generation, completeOffset);
  }

  tail(cursor: number, limit = 100): MeshTailResult {
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), this.maxReadEvents));
    const generation = this.#readGeneration();
    const decoded = this.#decodeCursor(cursor);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(this.#eventsPath, "r");
      const size = fs.fstatSync(descriptor).size;
      let position = decoded.generation === generation ? Math.min(decoded.offset, size) : 0;
      if (position > 0) {
        const previousByte = Buffer.allocUnsafe(1);
        fs.readSync(descriptor, previousByte, 0, 1, position - 1);
        if (previousByte[0] !== 0x0a) position = 0;
      }
      if (position >= size) {
        return { events: [], nextOffset: this.#encodeCursor(generation, position) };
      }
      const chunkBytes = Math.min(
        size - position,
        Math.max(this.maxEventBytes + 1, EVENT_READ_PAGE_BYTES),
      );
      const buffer = Buffer.allocUnsafe(chunkBytes);
      const bytesRead = fs.readSync(descriptor, buffer, 0, chunkBytes, position);
      const events: MeshEvent[] = [];
      let lineStart = 0;
      let consumed = 0;
      for (let index = 0; index < bytesRead; index++) {
        if (buffer[index] !== 0x0a) continue;
        const line = buffer.subarray(lineStart, index).toString("utf8").trim();
        lineStart = index + 1;
        consumed = lineStart;
        if (line) {
          try {
            const event = JSON.parse(line) as MeshEvent;
            if (typeof event.sequence === "number") events.push(event);
          } catch { /* skip malformed mesh log line */ }
        }
        if (events.length >= boundedLimit) break;
      }
      return {
        events: events.map((event) => jsonClone(event)),
        nextOffset: this.#encodeCursor(generation, position + consumed),
      };
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return { events: [], nextOffset: this.#encodeCursor(generation, 0) };
      }
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  #readRecentEvents(
    input: { topic?: string; to?: string },
    limit: number,
  ): MeshEvent[] {
    let events: MeshEvent[] = [];
    let before: number | undefined;
    while (events.length < limit) {
      const page = readJsonlPage(
        this.#eventsPath,
        this.maxReadEvents,
        before,
        Math.max(this.maxEventBytes + 1, EVENT_READ_PAGE_BYTES),
      );
      const pageEvents: MeshEvent[] = [];
      for (const line of page.lines) {
        const parsed = line.parsed;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
        const event = parsed as MeshEvent;
        if (typeof event.sequence !== "number" || !this.#eventMatches(event, input)) continue;
        pageEvents.push(event);
      }
      events = [...pageEvents, ...events].slice(-limit);
      if (!page.hasMore || page.before === undefined || page.before === before) break;
      before = page.before;
    }
    return events;
  }

  #readEventsAfter(
    after: number,
    input: { topic?: string; to?: string },
    limit: number,
  ): MeshEvent[] {
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(this.#eventsPath, "r");
      const size = fs.fstatSync(descriptor).size;
      const events: MeshEvent[] = [];
      let position = 0;
      let lineChunks: Buffer[] = [];
      let lineBytes = 0;
      let skippingOversizedLine = false;
      let reachedLimit = false;

      const emitLine = (): void => {
        if (!skippingOversizedLine && lineBytes > 0) {
          const decoded = Buffer.concat(lineChunks, lineBytes).toString("utf8");
          const line = decoded.endsWith(String.fromCharCode(13)) ? decoded.slice(0, -1) : decoded;
          try {
            const event = JSON.parse(line) as MeshEvent;
            if (
              typeof event.sequence === "number" &&
              event.sequence > after &&
              this.#eventMatches(event, input)
            ) {
              events.push(event);
              reachedLimit = events.length >= limit;
            }
          } catch { /* skip malformed mesh log line */ }
        }
        lineChunks = [];
        lineBytes = 0;
        skippingOversizedLine = false;
      };

      while (position < size && !reachedLimit) {
        const readLength = Math.min(EVENT_READ_CHUNK_BYTES, size - position);
        const chunk = Buffer.allocUnsafe(readLength);
        const bytesRead = fs.readSync(descriptor, chunk, 0, readLength, position);
        if (bytesRead <= 0) break;
        position += bytesRead;
        const captured = chunk.subarray(0, bytesRead);
        let segmentStart = 0;
        while (segmentStart < captured.length && !reachedLimit) {
          const newline = captured.indexOf(0x0a, segmentStart);
          const segmentEnd = newline < 0 ? captured.length : newline;
          const segment = captured.subarray(segmentStart, segmentEnd);
          if (!skippingOversizedLine) {
            if (lineBytes + segment.length <= this.maxEventBytes) {
              if (segment.length > 0) lineChunks.push(segment);
              lineBytes += segment.length;
            } else {
              lineChunks = [];
              lineBytes = 0;
              skippingOversizedLine = true;
            }
          }
          if (newline < 0) break;
          emitLine();
          segmentStart = newline + 1;
        }
      }
      if (!reachedLimit && (lineBytes > 0 || skippingOversizedLine)) emitLine();
      return events;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  #eventMatches(event: MeshEvent, input: { topic?: string; to?: string }): boolean {
    if (input.topic !== undefined && event.topic !== input.topic) return false;
    if (input.to !== undefined && event.to !== input.to) return false;
    return true;
  }

  get(key: string): MeshStateEntry | undefined {
    this.#validateKey(key);
    const entries = this.#readCachedState().entries;
    return Object.hasOwn(entries, key) ? jsonClone(entries[key]) : undefined;
  }

  list(prefix = "", limit = 100): MeshStateEntry[] {
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), this.maxReadEvents));
    return this.listAll(prefix).slice(0, boundedLimit);
  }

  /** Internal project-state scan for host-managed indexes that must reconcile every key. */
  listAll(prefix = ""): MeshStateEntry[] {
    if (prefix) this.#validateKey(prefix);
    return Object.values(this.#readCachedState().entries)
      .filter((entry) => !prefix || entry.key.startsWith(prefix))
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((entry) => jsonClone(entry));
  }

  async put(input: {
    key: string;
    value: unknown;
    identity: MeshIdentity;
    ifVersion?: number;
  }): Promise<MeshStateEntry> {
    const { key, value, identity, ifVersion } = input;
    this.#validateKey(key);
    const request = captureStoragePut({ key, value, identity, ifVersion }, this.maxEventBytes);
    return this.#withLock(() => {
      const state = readState(this.#statePath, this.#maxStateBytes, false);
      const slot = stateSlot(state, request.key);
      const plan = request.transition(slot.present, slot.version, slot.highWater);
      if (plan.kind !== "put") throw new Error("Invalid verified storage put plan");
      const entry: MeshStateEntry = {
        key: plan.key,
        value: plan.value,
        version: plan.version,
        updatedAt: Date.now(),
        updatedBy: plan.identity,
      };
      state.entries[plan.key] = entry;
      state.versions ??= {};
      state.versions[plan.key] = plan.version;
      // Keep the envelope readable by existing hosts; revisionFormat marks the
      // mandatory persistent clock without making old readers quarantine it.
      state.format = 1;
      state.revisionFormat = 2;
      state.highWater = plan.highWater;
      state.tombstoneOrder = (state.tombstoneOrder ?? []).filter((key) => key !== plan.key);
      compactStateTombstones(state, this.#maxStateTombstones);
      atomicWrite(this.#statePath, state, this.#maxStateBytes);
      this.#cacheState(state);
      return jsonClone(entry);
    });
  }

  async delete(input: {
    key: string;
    ifVersion?: number;
  }): Promise<{ deleted: boolean; version?: number }> {
    const { key, ifVersion } = input;
    this.#validateKey(key);
    const request = captureStorageDelete({ key, ifVersion });
    return this.#withLock(() => {
      const state = readState(this.#statePath, this.#maxStateBytes, false);
      const slot = stateSlot(state, request.key);
      const plan = request.transition(slot.present, slot.version, slot.highWater);
      if (plan.kind === "unchanged") {
        this.#cacheState(state);
        return { deleted: false };
      }
      if (plan.kind !== "delete") throw new Error("Invalid verified storage delete plan");
      delete state.entries[plan.key];
      state.versions ??= {};
      // Delete consumes a key successor and advances the persistent clock.
      // Eviction can forget a CAS tombstone, but not allocation history.
      state.versions[plan.key] = plan.version;
      // Keep the envelope readable by existing hosts; revisionFormat marks the
      // mandatory persistent clock without making old readers quarantine it.
      state.format = 1;
      state.revisionFormat = 2;
      state.highWater = plan.highWater;
      state.tombstoneOrder = [
        ...(state.tombstoneOrder ?? []).filter((key) => key !== plan.key),
        plan.key,
      ];
      compactStateTombstones(state, this.#maxStateTombstones);
      atomicWrite(this.#statePath, state, this.#maxStateBytes);
      this.#cacheState(state);
      return { deleted: true, version: plan.version };
    });
  }

  #readCachedState(): MeshStateFile {
    try {
      const stat = fs.statSync(this.#statePath);
      const cached = this.#stateCache;
      if (
        cached &&
        cached.device === stat.dev &&
        cached.inode === stat.ino &&
        cached.size === stat.size &&
        cached.modifiedAt === stat.mtimeMs
      ) {
        return cached.state;
      }
    } catch (error) {
      this.#stateCache = undefined;
      if (errorCode(error) === "ENOENT") return emptyState();
      throw error;
    }
    const state = readState(this.#statePath, this.#maxStateBytes);
    this.#cacheState(state);
    return state;
  }

  #cacheState(state: MeshStateFile): void {
    try {
      const stat = fs.statSync(this.#statePath);
      this.#stateCache = {
        device: stat.dev,
        inode: stat.ino,
        size: stat.size,
        modifiedAt: stat.mtimeMs,
        state,
      };
    } catch {
      this.#stateCache = undefined;
    }
  }

  async #withLock<T>(operation: () => T): Promise<T> {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.#lockTimeoutMs;
    const token = randomUUID();
    const ownerPath = path.join(this.#lockPath, "owner");
    while (true) {
      try {
        fs.mkdirSync(this.#lockPath, { mode: 0o700 });
        fs.writeFileSync(ownerPath, `${token}\n${process.pid}\n${Date.now()}\n${encodeOwnerIdentityLine()}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        break;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        if (this.#clearStaleLock(ownerPath)) continue;
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the Fabric mesh lock");
        await delay(10);
      }
    }
    try {
      return operation();
    } finally {
      try {
        const owner = fs.readFileSync(ownerPath, "utf8");
        if (owner.startsWith(`${token}\n`)) {
          fs.rmSync(this.#lockPath, { recursive: true, force: true });
        }
      } catch {
        // Another process already recovered or removed this lock.
      }
    }
  }

  // Returns true when a stale lock was removed and acquisition should retry.
  // A lock is stale when it outlived the stale window without a live owner:
  // either the owner file names a dead process, or the owner file is missing
  // or corrupt — the owner crashed between creating the lock directory and
  // writing the owner file — and the untouched lock directory itself is
  // stale. A younger lock is also removed when its owner is provably dead:
  // same host, PID namespace and boot, and the pid is gone or reused. Removal
  // re-reads the state it judged stale so a freshly rotated owner is never
  // deleted mid-check, and an owner lock is removed through a rename claim so
  // a lock a new owner took after that re-read survives.
  #clearStaleLock(ownerPath: string): boolean {
    let lockModifiedAt: number | undefined;
    let owner: string | undefined;
    try {
      owner = fs.readFileSync(ownerPath, "utf8");
    } catch {
      try {
        lockModifiedAt = fs.statSync(this.#lockPath).mtimeMs;
      } catch {
        return false;
      }
    }
    if (owner !== undefined) {
      const [, pidText, createdText, identityLine] = owner.trim().split("\n");
      const createdAt = Number(createdText);
      const fresh = Number.isFinite(createdAt) && Date.now() - createdAt <= this.#staleLockMs;
      // A fresh lock is cleared only when its local owner is provably dead.
      // Unknown (another PID namespace within the hold ceiling) is not death.
      const dead = fresh
        ? lockOwnerProvablyDead(Number(pidText), identityLine)
        : lockOwnerLiveness(Number(pidText), createdAt, identityLine, {
          legacyAlive: processAlive,
          maxHoldMs: Math.max(SHORT_LOCK_MAX_HOLD_MS, this.#staleLockMs),
        }) === "dead";
      if (!dead) return false;
      try {
        if (fs.readFileSync(ownerPath, "utf8") !== owner) return false;
        return reapLockByRenameClaim(this.#lockPath, (claimed) => {
          try {
            return fs.readFileSync(path.join(claimed, "owner"), "utf8") === owner;
          } catch {
            return false;
          }
        });
      } catch {
        return false;
      }
    }
    if (lockModifiedAt === undefined || Date.now() - lockModifiedAt <= this.#staleLockMs) {
      return false;
    }
    try {
      if (fs.statSync(this.#lockPath).mtimeMs !== lockModifiedAt) return false;
      fs.rmSync(this.#lockPath, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  #readGeneration(): number {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.#generationPath, "utf8"));
      return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    } catch {
      return 0;
    }
  }

  #encodeCursor(generation: number, offset: number): number {
    const cursor = generation * CURSOR_OFFSET_BASE + offset;
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error("Fabric mesh cursor exhausted its safe integer range");
    }
    return cursor;
  }

  #decodeCursor(cursor: number): { generation: number; offset: number } {
    if (!Number.isSafeInteger(cursor) || cursor < 0) return { generation: -1, offset: 0 };
    return {
      generation: Math.floor(cursor / CURSOR_OFFSET_BASE),
      offset: cursor % CURSOR_OFFSET_BASE,
    };
  }

  #compactEventLog(): void {
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(this.#eventsPath, "r");
      const size = fs.fstatSync(descriptor).size;
      if (size <= this.#maxEventLogBytes) return;
      const readBytes = Math.min(
        size,
        this.#retainedEventLogBytes + this.maxEventBytes + 1,
      );
      const buffer = Buffer.allocUnsafe(readBytes);
      const bytesRead = fs.readSync(descriptor, buffer, 0, readBytes, size - readBytes);
      const captured = buffer.subarray(0, bytesRead);
      const retentionBoundary = Math.max(0, captured.length - this.#retainedEventLogBytes);
      const newline = retentionBoundary === 0 ? -1 : captured.indexOf(0x0a, retentionBoundary);
      const retainedStart = retentionBoundary === 0 ? 0 : newline >= 0 ? newline + 1 : captured.length;
      const retained = captured.subarray(retainedStart);
      fs.closeSync(descriptor);
      descriptor = undefined;
      const temporaryPath =
        this.#eventsPath + "." + process.pid + "." + randomUUID() + ".tmp";
      try {
        fs.writeFileSync(temporaryPath, retained, { mode: 0o600 });
        fs.renameSync(temporaryPath, this.#eventsPath);
      } finally {
        try { fs.rmSync(temporaryPath, { force: true }); } catch {}
      }
      atomicWrite(this.#generationPath, this.#readGeneration() + 1);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  #repairEventLog(): void {
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(this.#eventsPath, "r+");
      const size = fs.fstatSync(descriptor).size;
      if (size === 0) return;
      const lastByte = Buffer.allocUnsafe(1);
      fs.readSync(descriptor, lastByte, 0, 1, size - 1);
      if (lastByte[0] === 0x0a) return;
      const readBytes = Math.min(size, this.maxEventBytes + 1);
      const tail = Buffer.allocUnsafe(readBytes);
      fs.readSync(descriptor, tail, 0, readBytes, size - readBytes);
      const newline = tail.lastIndexOf(0x0a);
      fs.ftruncateSync(descriptor, newline >= 0 ? size - readBytes + newline + 1 : 0);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  #readLastEventSequence(): number {
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(this.#eventsPath, "r");
      const size = fs.fstatSync(descriptor).size;
      if (size === 0) return 0;
      const readBytes = Math.min(size, this.maxEventBytes + 1);
      const tail = Buffer.allocUnsafe(readBytes);
      fs.readSync(descriptor, tail, 0, readBytes, size - readBytes);
      const lines = tail.toString("utf8").trim().split("\n");
      for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index];
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { sequence?: unknown };
          if (typeof parsed.sequence === "number" && Number.isSafeInteger(parsed.sequence)) {
            return parsed.sequence;
          }
        } catch { /* skip malformed sequence line */ }
      }
      return 0;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return 0;
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  #readSequence(): number {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.#counterPath, "utf8"));
      return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return 0;
      return 0;
    }
  }

  #validateTopic(topic: string): void {
    validateMeshTopic(topic);
  }

  #validateKey(key: string): void {
    const unsafeSegment = key
      .split(/[/:]/)
      .some(
        (segment) =>
          segment === "__proto__" || segment === "prototype" || segment === "constructor",
      );
    if (!KEY_PATTERN.test(key) || unsafeSegment) {
      throw new Error(`Invalid Fabric mesh key: ${key}`);
    }
  }
}
