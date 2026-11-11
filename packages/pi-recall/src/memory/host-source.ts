import crypto from "node:crypto";
import { foldSessionDigest } from "./digest.js";
import { resolveSessionTarget, type SessionRef } from "./discovery.js";
import {
  classifySessionTiers,
  digestPolicy,
  fitDigestCache,
  fingerprintSource,
  loadTieredIndex,
  MEMORY_CACHE_VERSION,
  missingDigest,
  missingShard,
  shardPolicy,
  type DigestShard,
  type EntryRange,
  type MemoryCoverage,
  type MemoryIndexOptions,
  type Shard,
  type SourceState,
  type TieredIndexBundle,
} from "./index.js";
import {
  reconstructRecordsLineage,
  reconstructSessionLineage,
  type MemoryBranches,
  type SessionLineage,
} from "./lineage.js";
import {
  normalizeRecords,
  normalizeSession,
  type NormalizationCoverage,
  type NormalizedEntry,
} from "./normalize.js";
import type {
  MemorySourceAction,
  MemorySourceCoverage,
  MemorySourceListPage,
  MemorySourceRecord,
  MemorySourceSessionDescriptor,
  MemorySourceSessionMetadata,
  MemorySourceSnapshot,
  PortableMemorySource,
} from "./portable.js";
import { MemorySourceError } from "./portable.js";
import type { FabricScope } from "../protocol.js";
import { observeHostSource, observeSource, observeSources, type SourceObservation } from "./source-observation.js";
import {
  liveBranchResolver,
  resolveTierRefs,
  type MemoryProviderContext,
} from "./request-context.js";

const HOST_KEY_PREFIX = "memory-source:";
const REASON_PATTERN = /^[a-z0-9_.:-]{1,64}$/;

export interface HostSnapshot {
  sourceId: string;
  sessionKey: string;
  displayKey: string;
  sessionId: string;
  revision: string;
  metadata: MemorySourceSessionMetadata;
  records: readonly MemorySourceRecord[];
  coverageReasons: string[];
  selectedLeafId?: string | null;
}

/** Opaque, stable, non-filesystem session key shown in public outputs. */
const hostDisplayKey = (sourceId: string, sessionKey: string): string =>
  `${HOST_KEY_PREFIX}${sourceId}/${sessionKey}`;

/** Accept both the engine's display key and the adapter's raw session key. */
const hostSessionKey = (sourceId: string, session: string): string => {
  const prefix = `${HOST_KEY_PREFIX}${sourceId}/`;
  return session.startsWith(prefix) ? session.slice(prefix.length) : session;
};

export const resolveRegisteredSource = (
  registry: { get(id: string): PortableMemorySource | undefined } | undefined,
  sourceId: string,
): PortableMemorySource => {
  const source = registry?.get(sourceId);
  if (!source) throw new MemorySourceError("source_not_found", `Memory source not registered: ${sourceId}`);
  return source;
};

export const memorySourceFailure = (error: unknown): { code: string; message: string } | null =>
  error instanceof MemorySourceError ? { code: error.code, message: error.message } : null;

export const checkAbort = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw new MemorySourceError("aborted", "Memory source call was aborted.");
};

const assertAuthorized = async (
  source: PortableMemorySource,
  action: MemorySourceAction,
  sessionKey: string | null,
  scope: Readonly<FabricScope> | undefined,
): Promise<void> => {
  if (!source.authorize) return;
  let allowed: boolean;
  try {
    allowed = await (scope ? source.authorize(action, sessionKey, scope) : source.authorize(action, sessionKey));
  } catch {
    // Adapter failures stay sanitized: no backend error text, paths, or
    // credentials may reach public memory results.
    throw new MemorySourceError("source_unauthorized", "Memory source authorization failed.");
  }
  if (allowed !== true) {
    throw new MemorySourceError("source_unauthorized", "Memory source denied access.");
  }
};

const coverageReasons = (coverage: MemorySourceCoverage | undefined): string[] => {
  if (!coverage || coverage.complete !== false) return [];
  const reason = typeof coverage.reason === "string" && REASON_PATTERN.test(coverage.reason)
    ? `source_coverage:${coverage.reason}`
    : "source_coverage_incomplete";
  return [reason];
};

const asSessionKey = (value: unknown): string =>
  typeof value === "string" && value.length > 0 ? value : "";

const normalizeListResponse = (
  response: readonly MemorySourceSessionDescriptor[] | MemorySourceListPage,
): { sessions: readonly MemorySourceSessionDescriptor[]; coverageReasons: string[] } =>
  Array.isArray(response)
    ? { sessions: response as readonly MemorySourceSessionDescriptor[], coverageReasons: [] }
    : { sessions: (response as MemorySourceListPage).sessions, coverageReasons: coverageReasons((response as MemorySourceListPage).coverage) };

/**
 * Validate one adapter snapshot. Authorization is re-checked after the async
 * load so a revocation during the load fails closed before any content
 * reaches the engine. The returned snapshot deep-clones records and metadata,
 * so later adapter mutation (including nested objects) cannot change what the
 * engine already indexed; non-JSON-serializable records fail closed as
 * invalid_source_response because the engine's own hashing is JSON-canonical.
 */
const loadHostSnapshot = async (
  source: PortableMemorySource,
  sessionKey: string,
  action: MemorySourceAction,
  signal?: AbortSignal,
  scope?: Readonly<FabricScope>,
): Promise<HostSnapshot | null> => {
  checkAbort(signal);
  await assertAuthorized(source, action, sessionKey, scope);
  const response = await source.loadSession(sessionKey, signal === undefined ? {} : { signal });
  checkAbort(signal);
  await assertAuthorized(source, action, sessionKey, scope);
  if (response === null || response === undefined) return null;
  const key = asSessionKey(response.sessionKey);
  const revision = asSessionKey(response.revision);
  if (!revision || !Array.isArray(response.records) || key !== sessionKey) {
    throw new MemorySourceError("invalid_source_response", "Memory source returned an invalid snapshot.");
  }
  if (!response.records.every((record) =>
    record !== null && typeof record === "object" && !Array.isArray(record))) {
    throw new MemorySourceError("invalid_source_response", "Memory source snapshot has non-object records.");
  }
  let records: readonly MemorySourceRecord[];
  try {
    records = JSON.parse(JSON.stringify(response.records)) as MemorySourceRecord[];
  } catch {
    throw new MemorySourceError(
      "invalid_source_response",
      "Memory source snapshot records are not JSON-serializable.",
    );
  }
  if (response.selectedLeafId !== undefined && response.selectedLeafId !== null &&
      (typeof response.selectedLeafId !== "string" || !records.some(record =>
        record.type !== "session" && record.id === response.selectedLeafId))) {
    throw new MemorySourceError("invalid_source_response", "Memory source selected leaf is invalid.");
  }
  return {
    sourceId: source.id,
    sessionKey,
    displayKey: hostDisplayKey(source.id, sessionKey),
    sessionId: response.sessionId ?? sessionKey,
    revision,
    metadata: { ...(response.metadata ?? {}) },
    records,
    ...(response.selectedLeafId !== undefined ? { selectedLeafId: response.selectedLeafId } : {}),
    coverageReasons: coverageReasons(response.coverage),
  };
};

export const listHostSnapshots = async (
  source: PortableMemorySource,
  limit: number,
  action: MemorySourceAction,
  signal?: AbortSignal,
  scope?: Readonly<FabricScope>,
): Promise<{ snapshots: HostSnapshot[]; coverageReasons: string[] }> => {
  checkAbort(signal);
  await assertAuthorized(source, action, null, scope);
  const boundedLimit = Math.max(0, Math.floor(limit));
  const listed = normalizeListResponse(
    await source.listSessions(signal === undefined ? { limit: boundedLimit } : { limit: boundedLimit, signal }),
  );
  checkAbort(signal);
  const snapshots: HostSnapshot[] = [];
  const coverageReasons = new Set(listed.coverageReasons);
  if (listed.sessions.length > boundedLimit) {
    coverageReasons.add("source_limit_exceeded");
  }
  for (const descriptor of listed.sessions.slice(0, boundedLimit)) {
    checkAbort(signal);
    const key = asSessionKey(descriptor.sessionKey);
    if (!key) {
      coverageReasons.add("invalid_source_response");
      continue;
    }
    const snapshot = await loadHostSnapshot(source, key, action, signal, scope);
    if (!snapshot) {
      coverageReasons.add("source_unavailable");
      continue;
    }
    for (const reason of snapshot.coverageReasons) coverageReasons.add(reason);
    snapshots.push(snapshot);
  }
  if (snapshots.length === 0) {
    await assertAuthorized(source, action, null, scope);
  }
  return { snapshots, coverageReasons: [...coverageReasons] };
};

const hostSourceState = (snapshot: HostSnapshot): SourceState => {
  const canonical = JSON.stringify(snapshot.records);
  const sourceHash = crypto
    .createHash("sha256")
    .update(`${snapshot.revision}\u0000${canonical}`)
    .digest("hex");
  return {
    mtime: snapshot.metadata.updatedAt ?? 0,
    size: Buffer.byteLength(canonical, "utf8"),
    sourceHash,
  };
};

const hostRef = (snapshot: HostSnapshot): SessionRef => ({
  id: snapshot.sessionId,
  file: snapshot.displayKey,
  cwd: snapshot.metadata.cwd ?? "",
  mtime: snapshot.metadata.updatedAt ?? 0,
});

const hostLineage = (snapshot: HostSnapshot, branches: MemoryBranches): SessionLineage =>
  reconstructRecordsLineage(snapshot.records, branches, undefined, snapshot.selectedLeafId);

const hostIdentity = (sessionFile: string, sessionId: string | undefined, cwd: string | undefined) => ({
  sessionFile,
  ...(sessionId !== undefined ? { sessionId } : {}),
  ...(cwd !== undefined ? { cwd } : {}),
});

const mergedCoverage = (
  base: NormalizationCoverage,
  extra: readonly string[],
): NormalizationCoverage => {
  if (extra.length === 0) return base;
  const reasons = [...new Set([...base.reasons, ...extra])].sort();
  return { complete: false, reasons };
};

const buildHostShard = (
  snapshot: HostSnapshot,
  options: MemoryIndexOptions,
  tier: "hot" | "cold",
  entryRange?: EntryRange,
): Shard => {
  const state = hostSourceState(snapshot);
  const lineage = hostLineage(snapshot, options.branches ?? "active");
  const { entries, header, indexCoverage } = normalizeRecords(
    snapshot.records,
    hostIdentity(snapshot.displayKey, snapshot.sessionId, snapshot.metadata.cwd),
    options.maxEntryChars,
    {
      lineage,
      indexThinking: options.indexThinking ?? false,
      indexToolOutput: options.indexToolOutput ?? true,
    },
  );
  const selected = entryRange
    ? entries.filter((entry) => entry.index >= entryRange.first && entry.index <= entryRange.last)
    : entries;
  return {
    cacheVersion: MEMORY_CACHE_VERSION,
    kind: "shard",
    sessionFile: snapshot.displayKey,
    sessionId: header?.sessionId ?? snapshot.sessionId,
    mtime: state.mtime,
    size: state.size,
    sourceHash: state.sourceHash,
    branches: lineage.branches,
    lineageFingerprint: lineage.fingerprint,
    policy: shardPolicy(options, lineage),
    cacheBytes: 0,
    cacheSourceRatio: 0,
    entries: selected,
    totalEntryCount: entries.length,
    indexCoverage: mergedCoverage(indexCoverage, snapshot.coverageReasons),
    tier,
  };
};

const buildHostDigest = (snapshot: HostSnapshot, options: MemoryIndexOptions): DigestShard => {
  const state = hostSourceState(snapshot);
  const lineage = hostLineage(snapshot, options.branches ?? "active");
  const { entries, header, indexCoverage } = normalizeRecords(
    snapshot.records,
    hostIdentity(snapshot.displayKey, snapshot.sessionId, snapshot.metadata.cwd),
    Number.MAX_SAFE_INTEGER,
    {
      lineage,
      indexThinking: options.indexThinking ?? false,
      indexToolOutput: options.indexToolOutput ?? true,
    },
  );
  const digest = foldSessionDigest({
    sessionId: header?.sessionId ?? snapshot.sessionId,
    file: snapshot.displayKey,
    cwd: header?.cwd ?? snapshot.metadata.cwd ?? "",
    entries,
    maxVocabularyBytes: options.maxColdVocabularyBytes ?? 512 * 1024,
    normalizationCoverage: mergedCoverage(indexCoverage, snapshot.coverageReasons),
  });
  return fitDigestCache({
    cacheVersion: MEMORY_CACHE_VERSION,
    kind: "digest",
    ...digest,
    mtime: state.mtime,
    size: state.size,
    sourceHash: state.sourceHash,
    branches: lineage.branches,
    lineageFingerprint: lineage.fingerprint,
    policy: digestPolicy(options, lineage),
    cacheBytes: 0,
    cacheSourceRatio: 0,
  }, options.maxColdCacheBytes ?? 1024 * 1024);
};

/** In-memory tiered index for host sources: identical tiers, budgets, and
 *  coverage semantics as the filesystem index, with no disk cache writes. */
export const loadHostTieredIndex = (
  snapshots: readonly HostSnapshot[],
  options: MemoryIndexOptions,
  hydrate = false,
  entryRange?: EntryRange,
  extraReasons: readonly string[] = [],
): TieredIndexBundle => {
  const refs = snapshots.map(hostRef);
  const tiers = classifySessionTiers(refs, options.hotSessions ?? 50);
  const maxSessions = options.maxSyncSessions ?? 10_000;
  const maxSourceBytes = options.maxSyncSourceBytes ?? 512 * 1024 * 1024;
  const shards: Shard[] = [];
  const digests: DigestShard[] = [];
  const reasons = new Set(extraReasons);
  let indexedSessions = 0;
  let incompleteSessions = 0;
  let processedSessions = 0;
  let processedSourceBytes = 0;
  const byKey = new Map(snapshots.map((snapshot) => [snapshot.displayKey, snapshot]));
  for (const ref of refs) {
    const snapshot = byKey.get(ref.file);
    if (!snapshot) {
      reasons.add("source_unavailable");
      continue;
    }
    const size = hostSourceState(snapshot).size;
    if (processedSessions >= maxSessions) {
      reasons.add("max_sync_sessions");
      continue;
    }
    const tier = tiers.get(ref.file) ?? "cold";
    const sourceWorkBytes = size * (hydrate && tier === "cold" ? 6 : 3);
    if (processedSourceBytes + sourceWorkBytes > maxSourceBytes) {
      reasons.add("max_sync_source_bytes");
      continue;
    }
    processedSessions += 1;
    processedSourceBytes += sourceWorkBytes;
    if (hydrate) {
      if (tier === "cold") digests.push(buildHostDigest(snapshot, options));
      const shard = buildHostShard(snapshot, options, "cold", entryRange);
      shards.push(shard);
      if (shard.sourceHash) indexedSessions += 1;
      if (shard.sourceHash && !shard.indexCoverage.complete) {
        incompleteSessions += 1;
        for (const reason of shard.indexCoverage.reasons) reasons.add(reason);
      }
    } else if (tier === "hot") {
      const shard = buildHostShard(snapshot, options, "hot");
      shards.push(shard);
      if (shard.sourceHash) indexedSessions += 1;
      if (shard.sourceHash && !shard.indexCoverage.complete) {
        incompleteSessions += 1;
        for (const reason of shard.indexCoverage.reasons) reasons.add(reason);
      }
    } else {
      const digest = buildHostDigest(snapshot, options);
      digests.push(digest);
      if (digest.sourceHash) indexedSessions += 1;
      if (!digest.indexCoverage.complete) {
        incompleteSessions += 1;
        for (const reason of digest.indexCoverage.reasons) reasons.add(reason);
      }
    }
  }
  const eligibleSessions = refs.length;
  const staleSessions = eligibleSessions - indexedSessions;
  // Extra reasons (adapter coverage caps, list truncation) also demote the
  // result to incomplete: a truncated source is never presented as complete.
  const coverage: MemoryCoverage = {
    complete: reasons.size === 0 && staleSessions === 0 && incompleteSessions === 0,
    indexedSessions,
    eligibleSessions,
    staleSessions,
    incompleteSessions,
    reasons: [...reasons].sort(),
  };
  return { shards, digests, refs, tiers, coverage };
};

/** Source-resolution strategy shared by filesystem and host-backed calls. */
export interface RecallSourcePlan {
  refs: SessionRef[];
  sessionKey: string | null;
  observeAll(branches: MemoryBranches): readonly SourceObservation[] | null;
  stateFor(ref: SessionRef): SourceState | null;
  lineageFor(ref: SessionRef, branches: MemoryBranches): SessionLineage;
  loadIndex(
    options: MemoryIndexOptions,
    hydrate: boolean,
    entryRange?: EntryRange,
  ): TieredIndexBundle;
}

export const fileRecallPlan = (refs: SessionRef[], context: MemoryProviderContext): RecallSourcePlan => {
  const liveResolver = liveBranchResolver(context);
  return {
    refs,
    sessionKey: null,
    observeAll: (branches) => observeSources(refs, branches, liveResolver),
    stateFor: (ref) => fingerprintSource(ref.file),
    lineageFor: (ref, branches) =>
      reconstructSessionLineage(ref.file, branches, liveResolver?.(ref.file)),
    loadIndex: (options, hydrate, entryRange) =>
      loadTieredIndex(refs, resolveTierRefs(refs, context), options, hydrate, entryRange),
  };
};

export const hostRecallPlan = async (
  source: PortableMemorySource,
  sourceId: string,
  sessionKey: string | null,
  context: MemoryProviderContext,
  signal?: AbortSignal,
): Promise<RecallSourcePlan> => {
  const loaded = sessionKey !== null
    ? await (async () => {
        const snapshot = await loadHostSnapshot(source, sessionKey, "recall", signal, context.fabricScope);
        return snapshot
          ? { snapshots: [snapshot], coverageReasons: [] as string[] }
          : null;
      })()
    : await listHostSnapshots(source, context.config.maxSessions, "recall", signal, context.fabricScope);
  if (!loaded) throw new MemorySourceError("session_not_found", `Session not found in source ${sourceId}: ${sessionKey}`);
  const snapshots = loaded.snapshots;
  const refs = snapshots.map(hostRef);
  const byKey = new Map(snapshots.map((snapshot) => [snapshot.displayKey, snapshot]));
  const stateByKey = new Map<string, SourceState>();
  const stateOf = (snapshot: HostSnapshot): SourceState => {
    let state = stateByKey.get(snapshot.displayKey);
    if (!state) {
      state = hostSourceState(snapshot);
      stateByKey.set(snapshot.displayKey, state);
    }
    return state;
  };
  return {
    refs,
    sessionKey,
    observeAll: (branches) =>
      snapshots.map((snapshot) =>
        ({ ...observeHostSource(snapshot.displayKey, snapshot.revision, stateOf(snapshot).sourceHash), liveBranchSignature: hostLineage(snapshot, branches).fingerprint })),
    stateFor: (ref) => {
      const snapshot = byKey.get(ref.file);
      return snapshot ? stateOf(snapshot) : null;
    },
    lineageFor: (ref, branches) => {
      const snapshot = byKey.get(ref.file);
      return snapshot
        ? hostLineage(snapshot, branches)
        : reconstructSessionLineage(ref.file, branches);
    },
    loadIndex: (options, hydrate, entryRange) =>
      loadHostTieredIndex(snapshots, options, hydrate, entryRange, loaded.coverageReasons),
  };
};

export interface ExpansionAccess {
  ref: SessionRef;
  state(): SourceState | null;
  lineage(branches: MemoryBranches): SessionLineage;
  observe(branches: MemoryBranches): SourceObservation | null;
  normalizeFull(
    branches: MemoryBranches,
    policy: { indexThinking: boolean; indexToolOutput: boolean },
    lineage?: SessionLineage,
  ): { entries: NormalizedEntry[]; indexCoverage: NormalizationCoverage } | null;
}

export const fileExpansionAccess = (
  session: string,
  context: MemoryProviderContext,
): ExpansionAccess | null => {
  const ref = resolveSessionTarget(context.agentDir, session);
  if (!ref) return null;
  const liveResolver = liveBranchResolver(context);
  return {
    ref,
    state: () => fingerprintSource(ref.file),
    lineage: (branches) => reconstructSessionLineage(ref.file, branches, liveResolver?.(ref.file)),
    observe: (branches) =>
      observeSource(ref.file, branches, branches === "active" ? liveResolver?.(ref.file) : undefined),
    normalizeFull: (branches, policy, lineage) => {
      const resolvedLineage = lineage ??
        reconstructSessionLineage(ref.file, branches, liveResolver?.(ref.file));
      const normalized = normalizeSession(ref.file, Number.MAX_SAFE_INTEGER, {
        lineage: resolvedLineage,
        ...policy,
      });
      return normalized.header === null && normalized.entries.length === 0 &&
        normalized.indexCoverage.reasons.includes("source_unavailable")
        ? null
        : { entries: normalized.entries, indexCoverage: normalized.indexCoverage };
    },
  };
};

export const hostExpansionAccess = async (
  sourceId: string,
  session: string,
  context: MemoryProviderContext,
  signal?: AbortSignal,
): Promise<ExpansionAccess> => {
  const source = resolveRegisteredSource(context.sources, sourceId);
  const sessionKey = hostSessionKey(sourceId, session);
  const snapshot = await loadHostSnapshot(source, sessionKey, "expand", signal, context.fabricScope);
  if (!snapshot) {
    throw new MemorySourceError("session_not_found", `Session not found in source ${sourceId}: ${sessionKey}`);
  }
  const state = hostSourceState(snapshot);
  const ref = hostRef(snapshot);
  return {
    ref,
    state: () => state,
    lineage: (branches) => hostLineage(snapshot, branches),
    observe: (branches) => ({ ...observeHostSource(snapshot.displayKey, snapshot.revision, state.sourceHash), liveBranchSignature: hostLineage(snapshot, branches).fingerprint }),
    normalizeFull: (branches, policy) => {
      const normalized = normalizeRecords(
        snapshot.records,
        hostIdentity(snapshot.displayKey, snapshot.sessionId, snapshot.metadata.cwd),
        Number.MAX_SAFE_INTEGER,
        { lineage: hostLineage(snapshot, branches), ...policy },
      );
      return {
        entries: normalized.entries,
        indexCoverage: mergedCoverage(normalized.indexCoverage, snapshot.coverageReasons),
      };
    },
  };
};
