import { createHash } from "node:crypto";
import type { FabricMainAgentInfo } from "../main-agent.js";
import { MeshStore, type MeshIdentity, type MeshStateEntry } from "../mesh/store.js";
import type {
  FabricDepartedListOptions,
  FabricDepartedParticipant,
  FabricHostRecord,
  FabricParticipantInfo,
  FabricParticipantKind,
  FabricParticipantListOptions,
  FabricParticipantRecord,
  FabricParticipantSource,
  FabricPeerInfo,
} from "./types.js";

import { peerLabelPrefix } from "./peer-settle.js";
import { FABRIC_PEER_LABEL_SEQUENCE } from "../protocol.js";

const PARTICIPANT_PREFIX = "topology/participants/";
/** Project-scoped monotonic counter backing Linear-style peer labels. Never shrinks. */
const PEER_SEQ_KEY = `topology/peer-seq/${FABRIC_PEER_LABEL_SEQUENCE}`;
/** Fresh numbers tried before a pass gives up, when live sessions hold the first ones. */
const MAX_HELD_LABEL_SKIPS = 64;
const HOST_PREFIX = "topology/hosts/";
const LEGACY_SESSION_PREFIX = "sessions/";
const LEGACY_ACTOR_PREFIX = "actors/";
const PARTICIPANT_HEARTBEAT_MS = 5_000;
const PARTICIPANT_LEASE_MS = 15_000;
/**
 * Stopped-root tombstones live under their own prefix, so live discovery
 * (list, get, sessions, peers, label checks) never scans them.
 */
const TOMBSTONE_PREFIX = "topology/tombstones/";
const DEPARTED_LIMIT = 32;
const DEPARTED_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
/** How often a host sweeps records that dead hosts left behind. */
const REAP_INTERVAL_MS = 5 * 60 * 1_000;
/** Most records one sweep deletes; a backlog drains over successive heartbeats. */
const REAP_BATCH = 100;
const keyFor = (prefix: string, id: string): string =>
  prefix + createHash("sha256").update(id).digest("hex");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const participantKind = (value: unknown): FabricParticipantKind | undefined =>
  value === "root" || value === "agent" || value === "actor" || value === "provider"
    ? value
    : undefined;

// Inlined RUNNER_ID_PATTERN (src/agents/runner-registry.ts).
const RUNNER_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const isRunnerId = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 64 && RUNNER_ID_PATTERN.test(value);

const transports = new Set([
  "host",
  "hosted",
  "auto",
  "process",
  "tmux",
  "screen",
  "localterm",
  "herdr",
  "herdr-core",
]);
const capabilities = new Set([
  "steer",
  "followUp",
  "stop",
  "ask",
  "actor-bindings",
  "attach",
  "fabric",
]);

const participantFromEntry = (entry: MeshStateEntry): FabricParticipantRecord | undefined => {
  if (!isObject(entry.value) || entry.value.format !== 1) return undefined;
  const value = entry.value as Partial<FabricParticipantRecord>;
  const kind = participantKind(value.kind);
  if (
    !kind ||
    typeof value.id !== "string" ||
    entry.key !== keyFor(PARTICIPANT_PREFIX, value.id) ||
    typeof value.rootId !== "string" ||
    typeof value.ownerHostId !== "string" ||
    typeof value.ownerIdentityId !== "string" ||
    entry.updatedBy.id !== value.ownerIdentityId ||
    (value.ownerIncarnation !== undefined &&
      (typeof value.ownerIncarnation !== "string" ||
        value.ownerIncarnation.length === 0 ||
        value.ownerIncarnation.length > 128)) ||
    typeof value.name !== "string" ||
    typeof value.status !== "string" ||
    (kind === "provider"
      ? value.runner !== undefined || typeof value.provider !== "string"
      : !isRunnerId(value.runner)) ||
    typeof value.transport !== "string" ||
    !transports.has(value.transport) ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every(
      (capability) => typeof capability === "string" && capabilities.has(capability),
    ) ||
    typeof value.startedAt !== "number" ||
    typeof value.updatedAt !== "number" ||
    value.controlProtocol !== "v1" &&
    value.controlProtocol !== "legacy"
  ) {
    return undefined;
  }
  return value as FabricParticipantRecord;
};

const hostFromEntry = (entry: MeshStateEntry): FabricHostRecord | undefined => {
  if (!isObject(entry.value) || entry.value.format !== 1) return undefined;
  const value = entry.value as Partial<FabricHostRecord>;
  if (
    typeof value.id !== "string" ||
    entry.key !== keyFor(HOST_PREFIX, value.id) ||
    typeof value.rootId !== "string" ||
    !isObject(value.identity) ||
    typeof value.identity.id !== "string" ||
    typeof value.identity.name !== "string" ||
    entry.updatedBy.id !== value.identity.id ||
    (value.identity.kind !== "main" &&
      value.identity.kind !== "agent" &&
      value.identity.kind !== "actor") ||
    typeof value.startedAt !== "number" ||
    typeof value.updatedAt !== "number" ||
    typeof value.expiresAt !== "number"
  ) {
    return undefined;
  }
  return value as FabricHostRecord;
};

const optionalString = (value: unknown): boolean => value === undefined || typeof value === "string";

const tombstoneFromEntry = (entry: MeshStateEntry): FabricDepartedParticipant | undefined => {
  if (!isObject(entry.value) || entry.value.format !== 1) return undefined;
  const value = entry.value as Partial<FabricDepartedParticipant>;
  if (
    value.kind !== "root" ||
    value.status !== "stopped" ||
    typeof value.id !== "string" ||
    entry.key !== keyFor(TOMBSTONE_PREFIX, value.id) ||
    typeof value.rootId !== "string" ||
    typeof value.ownerHostId !== "string" ||
    typeof value.ownerIdentityId !== "string" ||
    entry.updatedBy.id !== value.ownerIdentityId ||
    typeof value.name !== "string" ||
    !optionalString(value.ownerIncarnation) ||
    !optionalString(value.label) ||
    !optionalString(value.cwd) ||
    !optionalString(value.sessionId) ||
    typeof value.startedAt !== "number" ||
    typeof value.lastSeenAt !== "number"
  ) {
    return undefined;
  }
  return value as FabricDepartedParticipant;
};

/** Copy only the identifying fields of a root record; operational state stays behind. */
const departedFromRoot = (
  participant: FabricParticipantRecord,
  status: FabricDepartedParticipant["status"],
  lastSeenAt: number,
): FabricDepartedParticipant => ({
  format: 1,
  id: participant.id,
  kind: "root",
  rootId: participant.rootId,
  ownerHostId: participant.ownerHostId,
  ownerIdentityId: participant.ownerIdentityId,
  ...(participant.ownerIncarnation ? { ownerIncarnation: participant.ownerIncarnation } : {}),
  name: participant.name,
  ...(participant.label ? { label: participant.label } : {}),
  ...(participant.cwd ? { cwd: participant.cwd } : {}),
  ...(participant.sessionId ? { sessionId: participant.sessionId } : {}),
  status,
  startedAt: participant.startedAt,
  lastSeenAt,
});

const peerFromParticipant = (participant: FabricParticipantInfo): FabricPeerInfo | undefined => {
  if (
    participant.kind !== "root" ||
    !participant.cwd ||
    !participant.sessionId ||
    (participant.status !== "idle" && participant.status !== "running")
  ) {
    return undefined;
  }
  return {
    id: participant.id,
    name: participant.label ?? "Peer " + participant.sessionId.slice(0, 8),
    ...(participant.label ? { label: participant.label } : {}),
    kind: "peer",
    status: participant.status,
    runner: "pi",
    transport: "host",
    cwd: participant.cwd,
    sessionId: participant.sessionId,
    ...(participant.model ? { model: participant.model } : {}),
    ...(participant.thinking ? { thinking: participant.thinking } : {}),
    startedAt: participant.startedAt,
    updatedAt: participant.updatedAt,
    pendingMessages: participant.pendingMessages === true,
    local: false,
  };
};

const legacyRootFromEntry = (
  entry: MeshStateEntry,
  localRootId: string,
  now: number,
): FabricParticipantInfo | undefined => {
  if (now - entry.updatedAt > PARTICIPANT_LEASE_MS || !isObject(entry.value)) return undefined;
  const value = entry.value;
  if (
    typeof value.id !== "string" ||
    value.id === localRootId ||
    typeof value.sessionId !== "string" ||
    entry.key !== `${LEGACY_SESSION_PREFIX}${value.sessionId}` ||
    entry.updatedBy.id !== value.id ||
    typeof value.cwd !== "string" ||
    typeof value.startedAt !== "number" ||
    (value.status !== "idle" && value.status !== "running")
  ) {
    return undefined;
  }
  return {
    format: 1,
    id: value.id,
    kind: "root",
    rootId: value.id,
    ownerHostId: value.id,
    ownerIdentityId: value.id,
    name: typeof value.name === "string" ? value.name : "main",
    status: value.status,
    runner: "pi",
    transport: "host",
    capabilities: ["steer", "followUp", "fabric"],
    cwd: value.cwd,
    sessionId: value.sessionId,
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.thinking === "string" ? { thinking: value.thinking } : {}),
    startedAt: value.startedAt,
    updatedAt: entry.updatedAt,
    pendingMessages: value.pendingMessages === true,
    controlProtocol: "legacy",
    local: false,
    stale: false,
  };
};

const legacyActorFromEntry = (
  entry: MeshStateEntry,
  roots: Map<string, FabricParticipantInfo>,
): FabricParticipantInfo | undefined => {
  if (!isObject(entry.value)) return undefined;
  const value = entry.value;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !isRunnerId(value.runner) ||
    typeof value.status !== "string"
  ) {
    return undefined;
  }
  const root = roots.get(entry.updatedBy.id);
  if (
    !root?.sessionId ||
    entry.key !== `${LEGACY_ACTOR_PREFIX}${root.sessionId}/${value.id}`
  ) {
    return undefined;
  }
  const active = value.status !== "stopped";
  return {
    format: 1,
    id: value.id,
    kind: "actor",
    rootId: root.id,
    ownerHostId: root.id,
    ownerIdentityId: entry.updatedBy.id,
    parentId: root.id,
    name: value.name,
    status: value.status,
    runner: value.runner,
    transport: "host",
    capabilities: [
      ...(active ? (["steer", "followUp"] as const) : []),
      ...(value.runner === "pi" || value.runner === "pi-durable" ? (["fabric"] as const) : []),
    ],
    startedAt: typeof value.createdAt === "number" ? value.createdAt : entry.updatedAt,
    updatedAt: entry.updatedAt,
    controlProtocol: "legacy",
    local: false,
    stale: false,
  };
};

export interface ParticipantDirectoryOptions {
  enabled: boolean;
  hostId: string;
  rootId: string;
  identity: MeshIdentity;
  selfOwnerHostId?: string;
  selfOwnerIdentityId?: string;
  /** This host's control-plane incarnation, stamped on every record it writes. */
  ownerIncarnation?: string;
  heartbeatMs?: number;
  leaseMs?: number;
  /**
   * The label this root recorded in its own session for its id, if any. A
   * resumed session keeps it, so reopening Pi does not take a new number.
   */
  recordedLabel?: () => string | undefined;
  /**
   * False until the session first uses Fabric: only then does it take a new
   * number, so idle sessions leave the counter alone. A recorded label is
   * reused at once, since that takes no number. Defaults to true.
   */
  labelWanted?: () => boolean;
  /**
   * Most stopped-root tombstones kept in the project, newest first. Close
   * prunes the rest; 0 writes none. Defaults to 32.
   */
  departedLimit?: number;
  /** Tombstones and lost roots older than this are not reported. Defaults to 7 days. */
  departedRetentionMs?: number;
}

export type ParticipantSnapshotSource = () => FabricParticipantRecord[];

/** A participant is live while its owner host holds an unexpired lease for the same identity and root. */
const liveOwner = (
  participant: FabricParticipantRecord,
  hosts: Map<string, FabricHostRecord>,
  now: number,
): boolean => {
  const owner = hosts.get(participant.ownerHostId);
  return !!owner && owner.expiresAt >= now && owner.identity.id === participant.ownerIdentityId &&
    owner.rootId === participant.rootId;
};

export class ParticipantDirectory implements FabricParticipantSource {
  readonly #sources = new Set<ParticipantSnapshotSource>();
  readonly #startedAt = Date.now();
  readonly #heartbeatMs: number;
  readonly #leaseMs: number;
  readonly #departedLimit: number;
  readonly #departedRetentionMs: number;
  readonly #localRecords = new Map<string, FabricParticipantRecord>();
  #timer: NodeJS.Timeout | undefined;
  #closed = false;
  #refreshing: Promise<void> | undefined;
  #refreshScheduled = false;
  #refreshAgain = false;
  #quiescing = false;
  #reapedAt = 0;
  #reaping: Promise<void> | undefined;

  constructor(
    readonly mesh: MeshStore,
    readonly options: ParticipantDirectoryOptions,
  ) {
    this.#heartbeatMs = Math.max(100, options.heartbeatMs ?? PARTICIPANT_HEARTBEAT_MS);
    this.#leaseMs = Math.max(this.#heartbeatMs * 2, options.leaseMs ?? PARTICIPANT_LEASE_MS);
    this.#departedLimit = Math.max(0, Math.floor(options.departedLimit ?? DEPARTED_LIMIT));
    this.#departedRetentionMs = Math.max(0, options.departedRetentionMs ?? DEPARTED_RETENTION_MS);
  }

  registerSource(source: ParticipantSnapshotSource): () => void {
    this.#sources.add(source);
    if (this.#timer) this.scheduleRefresh();
    return () => {
      this.#sources.delete(source);
      if (this.#timer) this.scheduleRefresh();
    };
  }

  async start(): Promise<void> {
    if (this.#timer) return;
    this.#closed = false;
    let initialError: unknown;
    try {
      await this.refresh();
    } catch (error) {
      initialError = error;
    }
    if (this.options.enabled) {
      // The heartbeat doubles as the recovery path: even when the initial
      // publish fails (for example a contended mesh lock at startup), keep
      // retrying so this host joins the mesh once the lock clears instead of
      // staying invisible until the next restart.
      this.#timer = setInterval(() => void this.refresh().catch(() => undefined), this.#heartbeatMs);
      this.#timer.unref();
    }
    if (initialError) throw initialError;
  }

  scheduleRefresh(): void {
    if (this.#closed) return;
    if (this.#refreshing) {
      this.#refreshAgain = true;
      return;
    }
    if (this.#refreshScheduled) return;
    this.#refreshScheduled = true;
    queueMicrotask(() => {
      this.#refreshScheduled = false;
      void this.refresh().catch(() => undefined);
    });
  }

  async refresh(): Promise<void> {
    if (this.#closed) return;
    if (this.#refreshing) return this.#refreshing;
    const operation = this.#refresh();
    this.#refreshing = operation;
    try {
      await operation;
    } finally {
      if (this.#refreshing === operation) this.#refreshing = undefined;
      if (this.#refreshAgain) {
        this.#refreshAgain = false;
        this.scheduleRefresh();
      }
    }
  }

  list(
    options: FabricParticipantListOptions = {},
    now = Date.now(),
  ): FabricParticipantInfo[] {
    if (!this.options.enabled) {
      const byId = new Map<string, FabricParticipantInfo>();
      for (const participant of this.#localRecords.values()) {
        if (options.scope === "lineage" && participant.rootId !== this.options.rootId) continue;
        if (options.kinds && !options.kinds.includes(participant.kind)) continue;
        byId.set(participant.id, { ...participant, local: true, stale: false });
      }
      const self = this.self(now);
      if (!options.kinds || options.kinds.includes(self.kind)) byId.set(self.id, self);
      return [...byId.values()];
    }
    const hosts = this.#hosts();
    const byId = new Map<string, FabricParticipantInfo>();
    for (const entry of this.mesh.listAll(PARTICIPANT_PREFIX)) {
      const participant = participantFromEntry(entry);
      if (!participant) continue;
      const stale = !liveOwner(participant, hosts, now);
      if (stale && !options.includeStale) continue;
      if (options.scope === "local" && participant.ownerHostId !== this.options.hostId) continue;
      if (options.scope === "lineage" && participant.rootId !== this.options.rootId) continue;
      if (options.kinds && !options.kinds.includes(participant.kind)) continue;
      byId.set(participant.id, {
        ...participant,
        local: participant.ownerHostId === this.options.hostId,
        stale,
      });
    }
    const legacyRoots = new Map(
      this.mesh
        .listAll(LEGACY_SESSION_PREFIX)
        .flatMap((entry) => {
          const root = legacyRootFromEntry(entry, this.options.rootId, now);
          return root ? [[root.id, root] as const] : [];
        }),
    );
    if (options.scope !== "local" && options.scope !== "lineage") {
      if (!options.kinds || options.kinds.includes("root")) {
        for (const root of legacyRoots.values()) {
          if (!byId.has(root.id)) byId.set(root.id, root);
        }
      }
      if (!options.kinds || options.kinds.includes("actor")) {
        for (const entry of this.mesh.listAll(LEGACY_ACTOR_PREFIX)) {
          const actor = legacyActorFromEntry(entry, legacyRoots);
          if (actor && !byId.has(actor.id)) byId.set(actor.id, actor);
        }
      }
    }
    const self = this.self(now);
    if (
      (!options.kinds || options.kinds.includes(self.kind)) &&
      options.scope !== "project" &&
      !byId.has(self.id)
    ) {
      byId.set(self.id, self);
    }
    return [...byId.values()].sort(
      (left, right) =>
        left.startedAt - right.startedAt || left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    );
  }

  get(id: string, now = Date.now()): FabricParticipantInfo | undefined {
    const target = id === "main" ? this.options.rootId : id;
    if (this.options.enabled) {
      const participant = this.#participant(target);
      if (participant) {
        const entry = this.mesh.get(keyFor(HOST_PREFIX, participant.ownerHostId));
        const owner = entry && hostFromEntry(entry);
        if (owner && liveOwner(participant, new Map([[owner.id, owner]]), now)) {
          return { ...participant, local: participant.ownerHostId === this.options.hostId, stale: false };
        }
      }
    }
    // Preserve local-only behavior and legacy fallback when no live canonical
    // record exists. Normal polling needs only the participant and its owner.
    return this.list({ scope: "project" }, now).find((participant) => participant.id === target);
  }

  #participant(id: string): FabricParticipantRecord | undefined {
    const entry = this.mesh.get(keyFor(PARTICIPANT_PREFIX, id));
    const participant = entry && participantFromEntry(entry);
    // Unpaired UTF-16 surrogates share their UTF-8 bytes with U+FFFD. A
    // matching storage key alone does not establish exact string identity.
    return participant?.id === id ? participant : undefined;
  }

  self(now = Date.now()): FabricParticipantInfo {
    const existing =
      this.#localRecords.get(this.options.identity.id) ??
      this.#participant(this.options.identity.id);
    if (existing) {
      return {
        ...existing,
        local: existing.ownerHostId === this.options.hostId,
        stale: false,
      };
    }
    const kind: FabricParticipantKind =
      this.options.identity.kind === "main" ? "root" : this.options.identity.kind;
    return {
      format: 1,
      id: this.options.identity.id,
      kind,
      rootId: this.options.rootId,
      ownerHostId: this.options.selfOwnerHostId ?? this.options.hostId,
      ownerIdentityId: this.options.selfOwnerIdentityId ?? this.options.identity.id,
      ...(!this.options.selfOwnerHostId && this.options.ownerIncarnation
        ? { ownerIncarnation: this.options.ownerIncarnation }
        : {}),
      ...(kind === "root" ? {} : { parentId: this.options.rootId }),
      name: this.options.identity.name,
      status: "running",
      runner: "pi",
      transport: "host",
      capabilities: ["steer", "followUp", "fabric"],
      ...(this.options.identity.sessionId ? { sessionId: this.options.identity.sessionId } : {}),
      startedAt: this.#startedAt,
      updatedAt: now,
      controlProtocol: "v1",
      local: (this.options.selfOwnerHostId ?? this.options.hostId) === this.options.hostId,
      stale: false,
    };
  }

  sessions(now = Date.now()): FabricParticipantInfo[] {
    return this.list({ scope: "project", kinds: ["root"] }, now);
  }

  peers(now = Date.now()): FabricPeerInfo[] {
    return this.sessions(now)
      .filter((participant) => participant.id !== this.options.rootId)
      .flatMap((participant) => {
        const peer = peerFromParticipant(participant);
        return peer ? [peer] : [];
      });
  }

  /**
   * Root sessions that are no longer live, newest first: `stopped` from the
   * tombstone a clean close wrote, `lost` from a root record whose owner
   * lease expired without one. Explicit opt-in only; live queries never read
   * tombstones. Pure read: never writes or prunes.
   */
  departed(options: FabricDepartedListOptions = {}, now = Date.now()): FabricDepartedParticipant[] {
    if (!this.options.enabled) return [];
    const hosts = this.#hosts();
    const live = new Set<string>([this.options.rootId]);
    const byId = new Map<string, FabricDepartedParticipant>();
    for (const entry of this.mesh.listAll(PARTICIPANT_PREFIX)) {
      const participant = participantFromEntry(entry);
      if (participant?.kind !== "root") continue;
      if (liveOwner(participant, hosts, now)) {
        live.add(participant.id);
        continue;
      }
      // The owner's last heartbeat is the best last-seen time; an unchanged
      // record keeps its older updatedAt while the lease keeps renewing.
      const owner = hosts.get(participant.ownerHostId);
      const heartbeat = owner?.identity.id === participant.ownerIdentityId ? owner.updatedAt : 0;
      byId.set(participant.id, departedFromRoot(participant, "lost", Math.max(participant.updatedAt, heartbeat)));
    }
    // A tombstone records a clean stop, so it wins over a leftover record that
    // is no newer. A newer record means the root ran again after that stop and
    // was then lost, so the stale tombstone must not hide the crash.
    for (const entry of this.mesh.listAll(TOMBSTONE_PREFIX)) {
      const tombstone = tombstoneFromEntry(entry);
      if (!tombstone) continue;
      const lost = byId.get(tombstone.id);
      if (!lost || tombstone.lastSeenAt >= lost.lastSeenAt) byId.set(tombstone.id, tombstone);
    }
    const cutoff = now - this.#departedRetentionMs;
    // A write limit of 0 only stops this session writing tombstones; reads
    // still default to the standard limit so other sessions' departures show.
    const limit = Math.max(0, Math.floor(options.limit ?? (this.#departedLimit || DEPARTED_LIMIT)));
    return [...byId.values()]
      .filter((participant) => !live.has(participant.id) && participant.lastSeenAt >= cutoff)
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  root(main: FabricMainAgentInfo): FabricParticipantRecord {
    return {
      format: 1,
      id: main.id,
      kind: "root",
      rootId: main.id,
      ownerHostId: this.options.hostId,
      ownerIdentityId: this.options.identity.id,
      ...(this.options.ownerIncarnation
        ? { ownerIncarnation: this.options.ownerIncarnation }
        : {}),
      name: "main",
      status: main.status === "running" ? "running" : "idle",
      runner: "pi",
      transport: "host",
      capabilities: ["steer", "followUp", "fabric"],
      ...(main.cwd ? { cwd: main.cwd } : {}),
      ...(main.sessionId ? { sessionId: main.sessionId } : {}),
      ...(main.model ? { model: main.model } : {}),
      ...(main.thinking ? { thinking: main.thinking } : {}),
      startedAt: main.startedAt ?? this.#startedAt,
      updatedAt: main.updatedAt,
      pendingMessages: main.pendingMessages,
      controlProtocol: "v1",
    };
  }

  async quiesce(): Promise<void> {
    if (this.#closed || this.#quiescing) return;
    this.#quiescing = true;
    await this.#refreshing?.catch(() => undefined);
    await this.refresh();
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#refreshing?.catch(() => undefined);
    await this.#reaping;
    if (!this.options.enabled) return;
    const owned = this.mesh.listAll(PARTICIPANT_PREFIX).flatMap((entry) => {
      const participant = participantFromEntry(entry);
      return participant?.ownerHostId === this.options.hostId ? [{ entry, participant }] : [];
    });
    // Tombstones go first, so a reader never finds neither a live record nor a tombstone.
    await this.#writeTombstones(owned.map((item) => item.participant)).catch(() => undefined);
    await Promise.allSettled(owned.map(({ entry }) => this.mesh.delete({ key: entry.key, ifVersion: entry.version })));
    const legacySessionKey = this.#legacySessionKey();
    if (legacySessionKey) {
      const legacy = this.mesh.get(legacySessionKey);
      if (legacy?.updatedBy.id === this.options.identity.id) {
        await this.mesh.delete({ key: legacy.key, ifVersion: legacy.version }).catch(() => undefined);
      }
    }
    const hostEntry = this.mesh.get(keyFor(HOST_PREFIX, this.options.hostId));
    if (hostEntry) await this.mesh.delete({ key: hostEntry.key, ifVersion: hostEntry.version }).catch(() => undefined);
  }

  /** Replace this host's root records with stopped tombstones, then prune by age and count. */
  async #writeTombstones(owned: FabricParticipantRecord[]): Promise<void> {
    // A limit of 0 turns tombstones off for this session only; it must not prune other sessions' tombstones.
    if (this.#departedLimit === 0) return;
    const now = Date.now();
    for (const participant of owned) {
      if (participant.kind !== "root") continue;
      await this.mesh.put({
        key: keyFor(TOMBSTONE_PREFIX, participant.id),
        value: departedFromRoot(participant, "stopped", now),
        identity: this.options.identity,
      }).catch(() => undefined);
    }
    const cutoff = now - this.#departedRetentionMs;
    const kept = this.mesh
      .listAll(TOMBSTONE_PREFIX)
      .map((entry) => ({ entry, tombstone: tombstoneFromEntry(entry) }))
      .sort((left, right) => (right.tombstone?.lastSeenAt ?? 0) - (left.tombstone?.lastSeenAt ?? 0));
    const prune = kept.filter(({ tombstone }, index) =>
      !tombstone || tombstone.lastSeenAt < cutoff || index >= this.#departedLimit);
    await Promise.allSettled(prune.map(({ entry }) => this.mesh.delete({ key: entry.key, ifVersion: entry.version })));
  }

  async #refresh(): Promise<void> {
    const now = Date.now();
    const desired = new Map<string, FabricParticipantRecord>();
    for (const source of this.#sources) {
      for (const candidate of source()) {
        const {
          task: _task,
          text: _text,
          error: _error,
          ownerIncarnation: _incarnation,
          ...operational
        } = candidate as
          FabricParticipantRecord & { task?: unknown; text?: unknown; error?: unknown };
        const record: FabricParticipantRecord = {
          ...operational,
          format: 1,
          ownerHostId: this.options.hostId,
          ownerIdentityId: this.options.identity.id,
          ...(this.options.ownerIncarnation
            ? { ownerIncarnation: this.options.ownerIncarnation }
            : {}),
          ...(this.#quiescing ? { capabilities: [] } : {}),
          controlProtocol: "v1",
        };
        desired.set(record.id, record);
      }
    }
    // Mint before the local cache swap so self() exposes the label too.
    await this.#ensurePeerLabels(desired);
    this.#localRecords.clear();
    for (const [id, record] of desired) this.#localRecords.set(id, record);
    if (!this.options.enabled) return;

    const root = [...desired.values()].find(
      (participant) => participant.kind === "root" && participant.id === this.options.rootId,
    );
    const legacySessionKey = this.#legacySessionKey();
    if (legacySessionKey && this.#quiescing) {
      const legacy = this.mesh.get(legacySessionKey);
      if (legacy?.updatedBy.id === this.options.identity.id) {
        await this.mesh
          .delete({ key: legacy.key, ifVersion: legacy.version })
          .catch(() => undefined);
      }
    } else if (root && legacySessionKey && root.cwd && root.sessionId) {
      await this.mesh.put({
        key: legacySessionKey,
        value: {
          id: root.id,
          name: root.label ?? `Peer ${root.sessionId.slice(0, 8)}`,
          ...(root.label ? { label: root.label } : {}),
          kind: "peer",
          status: root.status === "running" ? "running" : "idle",
          runner: "pi",
          transport: "host",
          cwd: root.cwd,
          sessionId: root.sessionId,
          ...(root.model ? { model: root.model } : {}),
          ...(root.thinking ? { thinking: root.thinking } : {}),
          startedAt: root.startedAt,
          updatedAt: now,
          pendingMessages: root.pendingMessages === true,
          local: false,
        },
        identity: this.options.identity,
      });
    }

    const existing = this.mesh
      .listAll(PARTICIPANT_PREFIX)
      .flatMap((entry) => {
        const participant = participantFromEntry(entry);
        return participant?.ownerHostId === this.options.hostId ? [{ entry, participant }] : [];
      });
    const existingById = new Map(existing.map((item) => [item.participant.id, item]));
    const legacyRoots = new Map(
      this.mesh
        .listAll(LEGACY_SESSION_PREFIX)
        .flatMap((entry) => {
          const root = legacyRootFromEntry(entry, this.options.rootId, now);
          return root ? [[root.id, root] as const] : [];
        }),
    );
    const legacyActorOwners = new Map(
      this.mesh
        .listAll(LEGACY_ACTOR_PREFIX)
        .flatMap((entry) => {
          const actor = legacyActorFromEntry(entry, legacyRoots);
          return actor ? [[actor.id, actor.ownerIdentityId] as const] : [];
        }),
    );
    for (const record of desired.values()) {
      const current = existingById.get(record.id);
      if (current && JSON.stringify(current.participant) === JSON.stringify(record)) continue;
      const key = keyFor(PARTICIPANT_PREFIX, record.id);
      const occupied = current?.entry ?? this.mesh.get(key);
      const occupiedParticipant = occupied && participantFromEntry(occupied);
      const legacyOwner = record.kind === "actor" ? legacyActorOwners.get(record.id) : undefined;
      if (!occupiedParticipant && legacyOwner && legacyOwner !== this.options.identity.id) {
        continue;
      }
      if (occupiedParticipant && occupiedParticipant.ownerHostId !== this.options.hostId) {
        const ownerEntry = this.mesh.get(keyFor(HOST_PREFIX, occupiedParticipant.ownerHostId));
        const owner = ownerEntry && hostFromEntry(ownerEntry);
        if (
          owner &&
          owner.expiresAt >= now &&
          owner.identity.id === occupiedParticipant.ownerIdentityId
        ) {
          continue;
        }
      }
      await this.mesh.put({
        key,
        value: record,
        identity: this.options.identity,
        ...(occupied ? { ifVersion: occupied.version } : {}),
      }).catch((error: unknown) => {
        const latest = this.mesh.get(key);
        const latestParticipant = latest && participantFromEntry(latest);
        if (latestParticipant && latestParticipant.ownerHostId !== this.options.hostId) return;
        throw error;
      });
    }
    for (const { entry, participant } of existing) {
      if (desired.has(participant.id)) continue;
      await this.mesh.delete({ key: entry.key, ifVersion: entry.version }).catch(() => undefined);
    }

    // Stamp this host's lease last, once every slower write above is done: a
    // refresh that outruns its own lease must not publish an already-expired
    // lease, which would make peers — and this host's own list() — read the
    // records it just wrote as stale.
    const leaseAt = Date.now();
    const host: FabricHostRecord = {
      format: 1,
      id: this.options.hostId,
      rootId: this.options.rootId,
      identity: this.options.identity,
      startedAt: this.#startedAt,
      updatedAt: leaseAt,
      expiresAt: leaseAt + this.#leaseMs,
    };
    await this.mesh.put({
      key: keyFor(HOST_PREFIX, this.options.hostId),
      value: host,
      identity: this.options.identity,
    });

    // The sweep runs beside the heartbeat instead of holding it up. A batch
    // that leaves work behind brings the next sweep forward to the next beat.
    if (!this.#reaping && leaseAt - this.#reapedAt >= REAP_INTERVAL_MS) {
      this.#reapedAt = leaseAt;
      this.#reaping = this.#reapDeparted(leaseAt)
        .then((more) => {
          if (more) this.#reapedAt = 0;
        })
        .catch(() => undefined)
        .finally(() => {
          this.#reaping = undefined;
        });
    }
  }

  /**
   * Delete records whose owner lease has been dead longer than the departed
   * window. Close removes a host's own records, but a killed or crashed host
   * never closes, and every heartbeat in the project re-reads what it left.
   * Lost roots inside the window stay, so departed() still reports them.
   * Returns true when records were left for a later batch.
   */
  async #reapDeparted(now: number): Promise<boolean> {
    const cutoff = now - this.#departedRetentionMs;
    const hosts = this.#hosts();
    const retainedOwners = new Set<string>();
    const reap: MeshStateEntry[] = [];
    for (const entry of this.mesh.listAll(PARTICIPANT_PREFIX)) {
      const participant = participantFromEntry(entry);
      if (!participant) continue;
      const owner = hosts.get(participant.ownerHostId);
      const heartbeat = owner?.identity.id === participant.ownerIdentityId ? owner.updatedAt : 0;
      if (!liveOwner(participant, hosts, now) && Math.max(participant.updatedAt, heartbeat) < cutoff) {
        reap.push(entry);
      } else {
        retainedOwners.add(participant.ownerHostId);
      }
    }
    for (const entry of this.mesh.listAll(HOST_PREFIX)) {
      const host = hostFromEntry(entry);
      if (host && host.expiresAt < cutoff && !retainedOwners.has(host.id)) reap.push(entry);
    }
    // One delete at a time, a bounded batch per sweep: every delete rewrites
    // the whole state under the mesh lock, and a burst of them would starve
    // the lease renewals of every host, this one included. An uncontended
    // delete settles without a macrotask, so yield between deletes to let the
    // heartbeat timer run. ifVersion keeps a record that its owner renewed
    // meanwhile; a lost CAS (another host reaped it, or its owner came back)
    // just moves on. Any other failure, such as a lock timeout, ends the batch
    // and leaves the rest for the next beat, so close() never waits on a
    // string of lock timeouts.
    for (const entry of reap.slice(0, REAP_BATCH)) {
      if (this.#closed) return false;
      try {
        await this.mesh.delete({ key: entry.key, ifVersion: entry.version });
      } catch {
        if (this.mesh.get(entry.key)?.version === entry.version) return true;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return reap.length > REAP_BATCH;
  }

  /**
   * Mint missing labels for this host's root participants. Labels persist in
   * the peer's own participant record, so every session computes the same
   * label and retired numbers are never reused even if a peer record dies.
   */
  async #ensurePeerLabels(desired: Map<string, FabricParticipantRecord>): Promise<void> {
    if (!this.options.enabled) return;
    for (const record of desired.values()) {
      if (record.kind !== "root" || record.id !== this.options.rootId || record.label) continue;
      const existingEntry = this.mesh.get(keyFor(PARTICIPANT_PREFIX, record.id));
      const existing = existingEntry ? participantFromEntry(existingEntry) : undefined;
      if (existing?.label) {
        record.label = existing.label;
        continue;
      }
      // Shutdown deletes the record, so a resumed session finds its label in its
      // own session file. Numbers are never minted twice, so only a live
      // participant of another id could hold it; then the session takes a new one.
      const recorded = this.options.recordedLabel?.();
      if (recorded && this.#reusableLabel(recorded, record)) {
        record.label = recorded;
        continue;
      }
      if (this.options.labelWanted?.() === false) continue;
      // A new counter generation restarts at 1 while sessions labelled by an
      // older one may still run: skip numbers a live participant holds.
      for (let attempt = 0; attempt < MAX_HELD_LABEL_SKIPS; attempt += 1) {
        const seq = await this.#claimPeerSeq();
        if (seq === undefined) break;
        const label = `${peerLabelPrefix(record.cwd)}-${seq}`;
        if (this.#heldByOther(label, record.id)) continue;
        record.label = label;
        break;
      }
    }
  }

  /** A recorded label fits this project and no other participant holds it. */
  #reusableLabel(label: string, record: FabricParticipantRecord): boolean {
    return new RegExp(`^${peerLabelPrefix(record.cwd)}-[1-9][0-9]*$`).test(label) && !this.#heldByOther(label, record.id);
  }

  /** A live participant of another id holds the label; a dead session's leftover record does not. */
  #heldByOther(label: string, id: string): boolean {
    const hosts = this.#hosts();
    const now = Date.now();
    return this.mesh.listAll(PARTICIPANT_PREFIX).some((entry) => {
      const participant = participantFromEntry(entry);
      return participant !== undefined && participant.id !== id && participant.label === label &&
        liveOwner(participant, hosts, now);
    });
  }

  #hosts(): Map<string, FabricHostRecord> {
    return new Map(this.mesh.listAll(HOST_PREFIX).flatMap((entry) => {
      const host = hostFromEntry(entry);
      return host ? [[host.id, host] as const] : [];
    }));
  }

  /** CAS-claim the next project-wide peer sequence number. ifVersion 0 creates. */
  async #claimPeerSeq(): Promise<number | undefined> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const entry = this.mesh.get(PEER_SEQ_KEY);
      const current =
        entry && isObject(entry.value) &&
        typeof entry.value.next === "number" &&
        Number.isInteger(entry.value.next) &&
        entry.value.next >= 1
          ? entry.value.next
          : 0;
      try {
        await this.mesh.put({
          key: PEER_SEQ_KEY,
          value: { format: 1, next: current + 1 },
          identity: this.options.identity,
          ifVersion: entry?.version ?? 0,
        });
        return current + 1;
      } catch (error) {
        // Only lost CAS races retry; offline/auth failures propagate.
        if (!/compare-and-swap/.test(error instanceof Error ? error.message : String(error))) {
          throw error;
        }
      }
    }
    return undefined;
  }

  #legacySessionKey(): string | undefined {
    if (this.options.identity.kind !== "main") return undefined;
    return `sessions/${this.options.identity.sessionId ?? this.options.identity.id}`;
  }
}
