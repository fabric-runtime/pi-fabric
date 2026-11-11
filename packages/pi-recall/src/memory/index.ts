import crypto from "node:crypto";
import { coverageComplete } from "../verified/policy.js";
import fs from "node:fs";
import path from "node:path";
import { foldSessionDigest, type SessionDigest } from "./digest.js";
import type { SessionRef } from "./discovery.js";
import type { LiveSessionBranch, MemoryBranches, SessionLineage } from "./lineage.js";
import { reconstructSessionLineage } from "./lineage.js";
import type { NormalizedEntry } from "./normalize.js";
import { DEFAULT_MEMORY_INDEX_PRIVACY, normalizeSession } from "./normalize.js";
import { compareLexical, lexicalTermCounts, tokenizeLexical } from "./tokenize.js";

export const MEMORY_CACHE_VERSION = 6;
export const DEFAULT_HOT_SESSIONS = 50;
const DEFAULT_MAX_COLD_VOCABULARY_BYTES = 512 * 1024;
const DEFAULT_MAX_COLD_CACHE_BYTES = 1024 * 1024;
const DEFAULT_MAX_SYNC_SESSIONS = 10_000;
const DEFAULT_MAX_SYNC_SOURCE_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_CACHE_CLEANUP_FILES = 100_000;

type MemoryTier = "hot" | "cold";

interface CacheRecord {
  cacheVersion: typeof MEMORY_CACHE_VERSION;
  kind: "shard" | "digest";
  mtime: number;
  size: number;
  sourceHash: string;
  branches: MemoryBranches;
  lineageFingerprint: string;
  policy: string;
  cacheBytes: number;
  cacheSourceRatio: number;
}

export interface Shard extends CacheRecord {
  kind: "shard";
  sessionFile: string;
  sessionId: string;
  entries: NormalizedEntry[];
  totalEntryCount: number;
  indexCoverage: { complete: boolean; reasons: string[] };
  tier?: MemoryTier;
  indexReason?: string;
}

export interface DigestShard extends SessionDigest, CacheRecord {
  kind: "digest";
}

export interface MemoryIndexOptions {
  indexDir: string;
  maxEntryChars: number;
  hotSessions?: number;
  digestTerms?: number;
  maxColdVocabularyBytes?: number;
  maxColdCacheBytes?: number;
  maxSyncSessions?: number;
  maxSyncSourceBytes?: number;
  maxCacheCleanupFiles?: number;
  branches?: MemoryBranches;
  indexThinking?: boolean;
  indexToolOutput?: boolean;
  liveBranchForFile?: (sessionFile: string) => LiveSessionBranch | undefined;
}

export interface EntryRange {
  first: number;
  last: number;
}

const cacheBaseName = (sessionFile: string): string => {
  const hash = crypto.createHash("sha1").update(sessionFile).digest("hex").slice(0, 16);
  const safeBase = path.basename(sessionFile).replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${hash}-${safeBase}`;
};

const cacheModeSuffix = (branches: MemoryBranches): string => branches === "all" ? ".all" : "";

export const shardPathForSession = (
  sessionFile: string,
  indexDir: string,
  branches: MemoryBranches = "active",
): string => path.join(indexDir, `${cacheBaseName(sessionFile)}${cacheModeSuffix(branches)}.json`);

export const digestPathForSession = (
  sessionFile: string,
  indexDir: string,
  branches: MemoryBranches = "active",
): string => path.join(indexDir, `${cacheBaseName(sessionFile)}${cacheModeSuffix(branches)}.digest.json`);

const policyPrivacy = (options: MemoryIndexOptions): string =>
  `thinking:${options.indexThinking ?? DEFAULT_MEMORY_INDEX_PRIVACY.indexThinking};tool-output:${options.indexToolOutput ?? DEFAULT_MEMORY_INDEX_PRIVACY.indexToolOutput}`;
export const shardPolicy = (options: MemoryIndexOptions, lineage: SessionLineage): string =>
  `entry:${options.maxEntryChars};branches:${lineage.branches};lineage:${lineage.fingerprint};${policyPrivacy(options)}`;
export const digestPolicy = (options: MemoryIndexOptions, lineage: SessionLineage): string =>
  `vocab:${options.maxColdVocabularyBytes ?? DEFAULT_MAX_COLD_VOCABULARY_BYTES};cache:${options.maxColdCacheBytes ?? DEFAULT_MAX_COLD_CACHE_BYTES};branches:${lineage.branches};lineage:${lineage.fingerprint};${policyPrivacy(options)}`;

const resolveLineage = (sessionFile: string, options: MemoryIndexOptions): SessionLineage =>
  reconstructSessionLineage(
    sessionFile,
    options.branches ?? "active",
    options.liveBranchForFile?.(sessionFile),
  );

const normalizationOptions = (options: MemoryIndexOptions, lineage: SessionLineage) => ({
  lineage,
  indexThinking: options.indexThinking ?? DEFAULT_MEMORY_INDEX_PRIVACY.indexThinking,
  indexToolOutput: options.indexToolOutput ?? DEFAULT_MEMORY_INDEX_PRIVACY.indexToolOutput,
});

const readShardFile = (
  filePath: string,
  maxBytes = DEFAULT_MAX_SYNC_SOURCE_BYTES,
): Shard | null => {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Shard;
    if (
      parsed.cacheVersion !== MEMORY_CACHE_VERSION ||
      parsed.kind !== "shard" ||
      typeof parsed.sessionFile !== "string" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.sourceHash !== "string" ||
      parsed.sourceHash.length !== 64 ||
      (parsed.branches !== "active" && parsed.branches !== "all") ||
      typeof parsed.lineageFingerprint !== "string" ||
      parsed.lineageFingerprint.length !== 64 ||
      typeof parsed.policy !== "string" ||
      typeof parsed.cacheBytes !== "number" ||
      parsed.cacheBytes !== stat.size ||
      typeof parsed.cacheSourceRatio !== "number" ||
      typeof parsed.totalEntryCount !== "number" ||
      typeof parsed.indexCoverage !== "object" ||
      parsed.indexCoverage === null ||
      typeof parsed.indexCoverage.complete !== "boolean" ||
      !Array.isArray(parsed.indexCoverage.reasons) ||
      !parsed.indexCoverage.reasons.every((reason) => typeof reason === "string") ||
      !Array.isArray(parsed.entries) ||
      !parsed.entries.every((entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof entry.index === "number" &&
        typeof entry.sessionFile === "string" &&
        typeof entry.text === "string")
    ) return null;
    return parsed;
  } catch {
    return null;
  }
};

const readDigestFile = (
  filePath: string,
  maxBytes = DEFAULT_MAX_COLD_CACHE_BYTES,
): DigestShard | null => {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as DigestShard;
    if (
      parsed.cacheVersion !== MEMORY_CACHE_VERSION ||
      parsed.kind !== "digest" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.file !== "string" ||
      typeof parsed.sourceHash !== "string" ||
      parsed.sourceHash.length !== 64 ||
      (parsed.branches !== "active" && parsed.branches !== "all") ||
      typeof parsed.lineageFingerprint !== "string" ||
      parsed.lineageFingerprint.length !== 64 ||
      typeof parsed.policy !== "string" ||
      typeof parsed.cacheBytes !== "number" ||
      parsed.cacheBytes !== stat.size ||
      typeof parsed.cacheSourceRatio !== "number" ||
      !Array.isArray(parsed.filesTouched) ||
      !Array.isArray(parsed.vocabulary) ||
      !parsed.vocabulary.every((term, index) =>
        typeof term === "string" && (index === 0 || parsed.vocabulary[index - 1]! < term)) ||
      !Array.isArray(parsed.addresses) ||
      !parsed.addresses.every((address) =>
        Array.isArray(address) &&
        address.length === 10 &&
        typeof address[0] === "number" &&
        (address[1] === null || typeof address[1] === "string") &&
        (address[2] === null || typeof address[2] === "string") &&
        (address[3] === null || typeof address[3] === "string") &&
        (address[4] === null || typeof address[4] === "string") &&
        (address[5] === null || typeof address[5] === "number") &&
        (address[6] === null || typeof address[6] === "string") &&
        (address[7] === null || typeof address[7] === "string") &&
        (address[8] === null || typeof address[8] === "string") &&
        (address[9] === null ||
          address[9] === "succeeded" ||
          address[9] === "failed" ||
          address[9] === "aborted" ||
          address[9] === "timed_out")) ||
      typeof parsed.indexCoverage !== "object" ||
      parsed.indexCoverage === null ||
      typeof parsed.indexCoverage.complete !== "boolean" ||
      typeof parsed.indexCoverage.vocabularyBytes !== "number" ||
      !Array.isArray(parsed.indexCoverage.reasons) ||
      !parsed.indexCoverage.reasons.every((reason) => typeof reason === "string") ||
      typeof parsed.mtime !== "number" ||
      typeof parsed.size !== "number"
    ) return null;
    return parsed;
  } catch {
    return null;
  }
};

const serializedBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const applyCacheMetrics = <T extends CacheRecord>(value: T): T => {
  let previous = -1;
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const bytes = serializedBytes(value);
    value.cacheBytes = bytes;
    value.cacheSourceRatio = value.size === 0 ? 0 : Number((bytes / value.size).toFixed(6));
    if (bytes === previous) break;
    previous = bytes;
  }
  value.cacheBytes = serializedBytes(value);
  value.cacheSourceRatio = value.size === 0
    ? 0
    : Number((value.cacheBytes / value.size).toFixed(6));
  return value;
};

const writeCacheFile = (filePath: string, value: Shard | DigestShard): boolean => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(filePath), 0o700); } catch {}
    fs.writeFileSync(filePath, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch {}
    return true;
  } catch {
    return false;
  }
};

const removeCacheFile = (filePath: string): void => {
  try {
    fs.rmSync(filePath, { force: true, recursive: true });
  } catch {
    // Cache cleanup is best effort.
  }
};

export interface SourceState {
  mtime: number;
  size: number;
  sourceHash: string;
}

export const fingerprintSource = (file: string): SourceState | null => {
  try {
    const content = fs.readFileSync(file);
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    return {
      mtime: stat.mtimeMs,
      size: stat.size,
      sourceHash: crypto.createHash("sha256").update(content).digest("hex"),
    };
  } catch {
    return null;
  }
};

const isCacheFresh = (
  cache: CacheRecord | null,
  state: SourceState,
  policy: string,
): boolean =>
  cache !== null &&
  cache.mtime === state.mtime &&
  cache.size === state.size &&
  cache.sourceHash === state.sourceHash &&
  cache.policy === policy;

export const missingShard = (
  ref: SessionRef,
  lineage: SessionLineage,
  reason = "source_unavailable",
): Shard => ({
  cacheVersion: MEMORY_CACHE_VERSION,
  kind: "shard",
  sessionFile: ref.file,
  sessionId: ref.id,
  mtime: 0,
  size: 0,
  sourceHash: "",
  branches: lineage.branches,
  lineageFingerprint: lineage.fingerprint,
  policy: reason,
  cacheBytes: 0,
  cacheSourceRatio: 0,
  entries: [],
  totalEntryCount: 0,
  indexCoverage: { complete: false, reasons: [reason] },
  tier: "hot",
  indexReason: reason,
});

export const loadShard = (ref: SessionRef, options: MemoryIndexOptions): Shard => {
  const lineage = resolveLineage(ref.file, options);
  const filePath = shardPathForSession(ref.file, options.indexDir, lineage.branches);
  const state = fingerprintSource(ref.file);
  if (!state) {
    removeCacheFile(filePath);
    return missingShard(ref, lineage);
  }
  const policy = shardPolicy(options, lineage);
  const cached = readShardFile(
    filePath,
    options.maxSyncSourceBytes ?? DEFAULT_MAX_SYNC_SOURCE_BYTES,
  );
  if (isCacheFresh(cached, state, policy) && cached?.sessionFile === ref.file) return cached;
  if (fs.existsSync(filePath)) removeCacheFile(filePath);
  const { entries, header, indexCoverage } = normalizeSession(
    ref.file,
    options.maxEntryChars,
    normalizationOptions(options, lineage),
  );
  const finalState = fingerprintSource(ref.file);
  const finalLineage = resolveLineage(ref.file, options);
  if (
    !finalState ||
    finalState.sourceHash !== state.sourceHash ||
    finalLineage.fingerprint !== lineage.fingerprint
  ) {
    removeCacheFile(filePath);
    return missingShard(
      ref,
      finalLineage,
      finalState?.sourceHash === state.sourceHash
        ? "lineage_changed_during_index"
        : "source_changed_during_index",
    );
  }
  const shard = applyCacheMetrics<Shard>({
    cacheVersion: MEMORY_CACHE_VERSION,
    kind: "shard",
    sessionFile: ref.file,
    sessionId: header?.sessionId ?? ref.id,
    ...state,
    branches: lineage.branches,
    lineageFingerprint: lineage.fingerprint,
    policy,
    cacheBytes: 0,
    cacheSourceRatio: 0,
    entries,
    totalEntryCount: entries.length,
    indexCoverage,
    tier: "hot",
  });
  writeCacheFile(filePath, shard);
  return shard;
};

const hydrateShard = (
  ref: SessionRef,
  options: MemoryIndexOptions,
  entryRange?: EntryRange,
): Shard => {
  const lineage = resolveLineage(ref.file, options);
  const state = fingerprintSource(ref.file);
  if (!state) return { ...missingShard(ref, lineage), tier: "cold" };
  const { entries, header, indexCoverage } = normalizeSession(
    ref.file,
    options.maxEntryChars,
    normalizationOptions(options, lineage),
  );
  const finalState = fingerprintSource(ref.file);
  const finalLineage = resolveLineage(ref.file, options);
  if (
    !finalState ||
    finalState.sourceHash !== state.sourceHash ||
    finalLineage.fingerprint !== lineage.fingerprint
  ) {
    return {
      ...missingShard(
        ref,
        finalLineage,
        finalState?.sourceHash === state.sourceHash
          ? "lineage_changed_during_index"
          : "source_changed_during_index",
      ),
      tier: "cold",
    };
  }
  const selected = entryRange
    ? entries.filter((entry) => entry.index >= entryRange.first && entry.index <= entryRange.last)
    : entries;
  return {
    cacheVersion: MEMORY_CACHE_VERSION,
    kind: "shard",
    sessionFile: ref.file,
    sessionId: header?.sessionId ?? ref.id,
    ...state,
    branches: lineage.branches,
    lineageFingerprint: lineage.fingerprint,
    policy: shardPolicy(options, lineage),
    cacheBytes: 0,
    cacheSourceRatio: 0,
    entries: selected,
    totalEntryCount: entries.length,
    indexCoverage,
    tier: "cold",
  };
};

export const missingDigest = (
  ref: SessionRef,
  lineage: SessionLineage,
  reason = "source_unavailable",
): DigestShard => ({
  cacheVersion: MEMORY_CACHE_VERSION,
  kind: "digest",
  sessionId: ref.id,
  file: ref.file,
  cwd: ref.cwd,
  firstTs: null,
  lastTs: null,
  entryCount: 0,
  filesTouched: [],
  toolHistogram: {},
  errorCount: 0,
  vocabulary: [],
  addresses: [],
  indexCoverage: { complete: false, vocabularyBytes: 2, reasons: [reason] },
  mtime: 0,
  size: 0,
  sourceHash: "",
  branches: lineage.branches,
  lineageFingerprint: lineage.fingerprint,
  policy: reason,
  cacheBytes: 0,
  cacheSourceRatio: 0,
});

const maxFittingPrefix = <T>(
  values: T[],
  fits: (candidate: T[]) => boolean,
): T[] => {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(values.slice(0, middle))) low = middle;
    else high = middle - 1;
  }
  return values.slice(0, low);
};

export const fitDigestCache = (digest: DigestShard, maxBytes: number): DigestShard => {
  applyCacheMetrics(digest);
  if (digest.cacheBytes <= maxBytes) return digest;

  digest.indexCoverage.complete = coverageComplete(digest.indexCoverage.complete, true);
  if (!digest.indexCoverage.reasons.includes("max_cold_cache_bytes")) {
    digest.indexCoverage.reasons.push("max_cold_cache_bytes");
  }
  digest.addresses = maxFittingPrefix(digest.addresses, (addresses) => {
    digest.addresses = addresses;
    applyCacheMetrics(digest);
    return digest.cacheBytes <= maxBytes;
  });
  applyCacheMetrics(digest);
  if (digest.cacheBytes <= maxBytes) return digest;

  digest.vocabulary = maxFittingPrefix(digest.vocabulary, (vocabulary) => {
    digest.vocabulary = vocabulary;
    digest.indexCoverage.vocabularyBytes = serializedBytes(vocabulary);
    applyCacheMetrics(digest);
    return digest.cacheBytes <= maxBytes;
  });
  digest.indexCoverage.vocabularyBytes = serializedBytes(digest.vocabulary);
  return applyCacheMetrics(digest);
};

export const loadDigest = (ref: SessionRef, options: MemoryIndexOptions): DigestShard => {
  const lineage = resolveLineage(ref.file, options);
  const filePath = digestPathForSession(ref.file, options.indexDir, lineage.branches);
  const state = fingerprintSource(ref.file);
  if (!state) {
    removeCacheFile(filePath);
    return missingDigest(ref, lineage);
  }
  const policy = digestPolicy(options, lineage);
  const maxCacheBytes = options.maxColdCacheBytes ?? DEFAULT_MAX_COLD_CACHE_BYTES;
  const cached = readDigestFile(filePath, maxCacheBytes);
  if (
    isCacheFresh(cached, state, policy) &&
    cached?.file === ref.file &&
    serializedBytes(cached) <= maxCacheBytes
  ) return cached;
  if (fs.existsSync(filePath)) removeCacheFile(filePath);

  const { entries, header, indexCoverage } = normalizeSession(
    ref.file,
    Number.MAX_SAFE_INTEGER,
    normalizationOptions(options, lineage),
  );
  const finalState = fingerprintSource(ref.file);
  const finalLineage = resolveLineage(ref.file, options);
  if (
    !finalState ||
    finalState.sourceHash !== state.sourceHash ||
    finalLineage.fingerprint !== lineage.fingerprint
  ) {
    removeCacheFile(filePath);
    return missingDigest(
      ref,
      finalLineage,
      finalState?.sourceHash === state.sourceHash
        ? "lineage_changed_during_index"
        : "source_changed_during_index",
    );
  }
  const digest = foldSessionDigest({
    sessionId: header?.sessionId ?? ref.id,
    file: ref.file,
    cwd: header?.cwd ?? ref.cwd,
    entries,
    maxVocabularyBytes:
      options.maxColdVocabularyBytes ?? DEFAULT_MAX_COLD_VOCABULARY_BYTES,
    normalizationCoverage: indexCoverage,
  });
  const persisted = fitDigestCache({
    cacheVersion: MEMORY_CACHE_VERSION,
    kind: "digest",
    ...digest,
    ...state,
    branches: lineage.branches,
    lineageFingerprint: lineage.fingerprint,
    policy,
    cacheBytes: 0,
    cacheSourceRatio: 0,
  }, maxCacheBytes);
  if (persisted.cacheBytes <= maxCacheBytes) writeCacheFile(filePath, persisted);
  return persisted;
};

const compareRefsByRecency = (left: SessionRef, right: SessionRef): number => {
  if (right.mtime !== left.mtime) return right.mtime - left.mtime;
  return compareLexical(left.file, right.file);
};

export const classifySessionTiers = (
  refs: SessionRef[],
  hotSessions = DEFAULT_HOT_SESSIONS,
): Map<string, MemoryTier> => {
  const sorted = [...refs].sort(compareRefsByRecency);
  const hot = new Set(sorted.slice(0, Math.max(0, Math.floor(hotSessions))).map((ref) => ref.file));
  return new Map(sorted.map((ref) => [ref.file, hot.has(ref.file) ? "hot" : "cold"]));
};

export interface MemoryCoverage {
  complete: boolean;
  indexedSessions: number;
  eligibleSessions: number;
  staleSessions: number;
  incompleteSessions: number;
  reasons: string[];
}

export interface TieredIndexBundle {
  shards: Shard[];
  digests: DigestShard[];
  refs: SessionRef[];
  tiers: Map<string, MemoryTier>;
  coverage: MemoryCoverage;
}

const cleanupCacheDirectory = (
  indexDir: string,
  branchesToClean: MemoryBranches,
  maxFiles: number,
  maxBytes: number,
): { complete: boolean; reasons: string[] } => {
  let directory: fs.Dir;
  try {
    directory = fs.opendirSync(indexDir);
  } catch {
    return { complete: true, reasons: [] };
  }
  let inspected = 0;
  let inspectedBytes = 0;
  try {
    while (true) {
      const entry = directory.readSync();
      if (!entry) return { complete: true, reasons: [] };
      if (!entry.name.endsWith(".json")) continue;
      if (inspected >= maxFiles) {
        return { complete: false, reasons: ["cache_cleanup_budget"] };
      }
      inspected += 1;
      const cacheFile = path.join(indexDir, entry.name);
      if (!entry.isFile()) {
        removeCacheFile(cacheFile);
        continue;
      }
      let cacheBytes: number;
      try {
        cacheBytes = fs.statSync(cacheFile).size;
      } catch {
        removeCacheFile(cacheFile);
        continue;
      }
      if (inspectedBytes + cacheBytes > maxBytes) {
        return { complete: false, reasons: ["cache_cleanup_budget"] };
      }
      inspectedBytes += cacheBytes;
      try {
        const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Record<string, unknown>;
        const kind = parsed.kind;
        const source = kind === "shard" && typeof parsed.sessionFile === "string"
          ? parsed.sessionFile
          : kind === "digest" && typeof parsed.file === "string" ? parsed.file : null;
        const branches = parsed.branches === "active" || parsed.branches === "all"
          ? parsed.branches
          : null;
        if (branches !== null && branches !== branchesToClean) continue;
        const expected = source && branches && kind === "shard"
          ? shardPathForSession(source, indexDir, branches)
          : source && branches && kind === "digest"
            ? digestPathForSession(source, indexDir, branches)
            : null;
        const structurallyValid = kind === "shard"
          ? readShardFile(cacheFile, cacheBytes) !== null
          : kind === "digest" ? readDigestFile(cacheFile, cacheBytes) !== null : false;
        if (
          parsed.cacheVersion !== MEMORY_CACHE_VERSION ||
          source === null ||
          expected !== cacheFile ||
          !fs.existsSync(source) ||
          !structurallyValid
        ) removeCacheFile(cacheFile);
      } catch {
        removeCacheFile(cacheFile);
      }
    }
  } finally {
    directory.closeSync();
  }
};

const sourceSize = (file: string): number | null => {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
};

export const loadTieredIndex = (
  refs: SessionRef[],
  allRefs: SessionRef[],
  options: MemoryIndexOptions,
  hydrate = false,
  entryRange?: EntryRange,
): TieredIndexBundle => {
  const cleanup = cleanupCacheDirectory(
    options.indexDir,
    options.branches ?? "active",
    options.maxCacheCleanupFiles ?? DEFAULT_MAX_CACHE_CLEANUP_FILES,
    options.maxSyncSourceBytes ?? DEFAULT_MAX_SYNC_SOURCE_BYTES,
  );
  const tierRefs = allRefs.length > 0 ? allRefs : refs;
  const tiers = classifySessionTiers(tierRefs, options.hotSessions ?? DEFAULT_HOT_SESSIONS);
  const maxSessions = options.maxSyncSessions ?? DEFAULT_MAX_SYNC_SESSIONS;
  const maxSourceBytes = options.maxSyncSourceBytes ?? DEFAULT_MAX_SYNC_SOURCE_BYTES;
  const shards: Shard[] = [];
  const digests: DigestShard[] = [];
  const reasons = new Set(cleanup.reasons);
  let indexedSessions = 0;
  let incompleteSessions = 0;
  let processedSessions = 0;
  let processedSourceBytes = 0;

  for (const ref of refs) {
    const size = sourceSize(ref.file);
    if (size === null) {
      reasons.add("source_unavailable");
      continue;
    }
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
    try {
      if (hydrate) {
        if (tier === "cold") loadDigest(ref, options);
        const shard = hydrateShard(ref, options, entryRange);
        shards.push(shard);
        if (shard.sourceHash) indexedSessions += 1;
        else reasons.add(shard.indexReason ?? "source_unavailable");
        if (shard.sourceHash && !shard.indexCoverage.complete) {
          incompleteSessions += 1;
          for (const reason of shard.indexCoverage.reasons) reasons.add(reason);
        }
      } else if (tier === "hot") {
        const shard = loadShard(ref, options);
        removeCacheFile(digestPathForSession(
          ref.file,
          options.indexDir,
          options.branches ?? "active",
        ));
        shards.push(shard);
        if (shard.sourceHash) indexedSessions += 1;
        else reasons.add(shard.indexReason ?? "source_unavailable");
        if (shard.sourceHash && !shard.indexCoverage.complete) {
          incompleteSessions += 1;
          for (const reason of shard.indexCoverage.reasons) reasons.add(reason);
        }
      } else {
        const digest = loadDigest(ref, options);
        removeCacheFile(shardPathForSession(
          ref.file,
          options.indexDir,
          options.branches ?? "active",
        ));
        digests.push(digest);
        if (digest.sourceHash) indexedSessions += 1;
        if (!digest.indexCoverage.complete) {
          incompleteSessions += 1;
          for (const reason of digest.indexCoverage.reasons) reasons.add(reason);
        }
      }
    } catch {
      reasons.add("index_error");
    }
  }

  const eligibleSessions = refs.length;
  const staleSessions = eligibleSessions - indexedSessions;
  return {
    shards,
    digests,
    refs,
    tiers,
    coverage: {
      complete: cleanup.complete && staleSessions === 0 && incompleteSessions === 0,
      indexedSessions,
      eligibleSessions,
      staleSessions,
      incompleteSessions,
      reasons: [...reasons].sort(compareLexical),
    },
  };
};

export interface SearchFilters {
  role?: string;
  tool?: string;
  ref?: string;
  provider?: string;
  action?: string;
  outcome?: NonNullable<NormalizedEntry["outcome"]>;
  since?: number;
  until?: number;
}

const matchesFilters = (entry: NormalizedEntry, filters: SearchFilters): boolean => {
  if (filters.role !== undefined && entry.role !== filters.role) return false;
  if (filters.tool !== undefined && entry.toolName !== filters.tool) return false;
  if (filters.ref !== undefined && entry.ref !== filters.ref) return false;
  if (filters.provider !== undefined && entry.provider !== filters.provider) return false;
  if (filters.action !== undefined && entry.action !== filters.action) return false;
  if (filters.outcome !== undefined && entry.outcome !== filters.outcome) return false;
  if (filters.since !== undefined && entry.timestamp !== null && entry.timestamp < filters.since) return false;
  if (filters.until !== undefined && entry.timestamp !== null && entry.timestamp > filters.until) return false;
  return true;
};

export interface IndexedEntry {
  entry: NormalizedEntry;
  sessionMtime: number;
}

export interface ScoredEntry extends IndexedEntry {
  score: number;
  matchedTerms: number;
}

export interface ShardBundle {
  shards: Shard[];
  refs: SessionRef[];
}

export const loadShards = (refs: SessionRef[], options: MemoryIndexOptions): ShardBundle => ({
  shards: refs.map((ref) => loadShard(ref, options)),
  refs,
});

export const bm25Score = (
  shards: Shard[],
  terms: string[],
  filters: SearchFilters,
  candidateLimit = Number.MAX_SAFE_INTEGER,
): ScoredEntry[] => {
  const queryTerms = [...new Set(terms.flatMap((term) => tokenizeLexical(term)))];
  const matching: { entry: NormalizedEntry; mtime: number; counts: Map<string, number> }[] = [];
  for (const shard of shards) {
    for (const entry of shard.entries) {
      if (matchesFilters(entry, filters) && matching.length < candidateLimit) {
        matching.push({ entry, mtime: shard.mtime, counts: lexicalTermCounts(entry.text) });
      }
    }
  }
  if (matching.length === 0 || queryTerms.length === 0) return [];

  const lengths = matching.map((item) => Math.max(1, [...item.counts.values()].reduce((a, b) => a + b, 0)));
  const averageLength = lengths.reduce((sum, length) => sum + length, 0) / matching.length;
  const documentFrequency = new Map<string, number>();
  for (const item of matching) {
    for (const term of queryTerms) {
      if ((item.counts.get(term) ?? 0) > 0) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
  }

  const K = 1.2;
  const B = 0.75;
  const results: ScoredEntry[] = [];
  for (let index = 0; index < matching.length; index += 1) {
    const item = matching[index]!;
    let score = 0;
    let matchedTerms = 0;
    for (const term of queryTerms) {
      const tf = item.counts.get(term) ?? 0;
      if (tf === 0) continue;
      matchedTerms += 1;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log((matching.length - df + 0.5) / (df + 0.5) + 1);
      const normalized = (tf * (K + 1)) /
        (tf + K * (1 - B + B * (lengths[index]! / averageLength)));
      score += idf * normalized;
    }
    if (score > 0) {
      results.push({ entry: item.entry, sessionMtime: item.mtime, score, matchedTerms });
    }
  }

  results.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.sessionMtime !== left.sessionMtime) return right.sessionMtime - left.sessionMtime;
    if (left.entry.index !== right.entry.index) return left.entry.index - right.entry.index;
    return compareLexical(left.entry.sessionFile, right.entry.sessionFile);
  });
  return results;
};

export const recentEntries = (
  shards: Shard[],
  filters: SearchFilters,
  limit: number,
): IndexedEntry[] => {
  const all: IndexedEntry[] = [];
  for (const shard of shards) {
    for (const entry of shard.entries) {
      if (matchesFilters(entry, filters)) all.push({ entry, sessionMtime: shard.mtime });
    }
  }
  all.sort((left, right) => {
    if (right.sessionMtime !== left.sessionMtime) return right.sessionMtime - left.sessionMtime;
    if (left.entry.index !== right.entry.index) return left.entry.index - right.entry.index;
    return compareLexical(left.entry.sessionFile, right.entry.sessionFile);
  });
  return all.slice(0, Math.max(0, limit));
};
