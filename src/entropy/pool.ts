// Machine-wide value-observation pooling for the entropy compiler. The
// session window stays small by design (gate-local, always fresh), but
// sparse closed domains never reach the derivation thresholds inside one
// window. The pool accumulates per-(ref, key, value) counts across every
// window the compiler reads, with exact per-session deltas so a growing
// session file is never counted twice and a rewritten one retracts its old
// contribution before adding the new one. Bounded by construction: each
// entry tracks at most POOL_TRACKED_VALUES distinct values (above the
// derivation's ENUM_MAX_DISTINCT, so an overflowed domain stays provably
// ineligible instead of silently re-qualifying after eviction),
// POOL_TRACKED_SESSIONS files carry per-session counts for exact deltas,
// and evicted sessions bake into the totals with their digest remembered
// so the same evidence never merges twice.

import { createHash } from "node:crypto";
import { compareCodeUnits } from "./fingerprint.js";
import type { EntropyValueObservation } from "./types.js";

export const OBSERVATION_POOL_VERSION = 1 as const;
export const POOL_TRACKED_VALUES = 16;
export const POOL_TRACKED_SESSIONS = 16;
export const POOL_BAKED_DIGESTS = 512;

export interface EntropyPoolValueCount {
  value: string | number | boolean;
  count: number;
}

export interface EntropyObservationPoolEntry {
  ref: string;
  key: string;
  values: EntropyPoolValueCount[];
  total: number;
}

export interface EntropyPoolTrackedSession {
  file: string;
  digest: string;
  counts: Record<string, number>;
}

export interface EntropyObservationPoolFile {
  version: typeof OBSERVATION_POOL_VERSION;
  entries: EntropyObservationPoolEntry[];
  tracked: EntropyPoolTrackedSession[];
  baked: string[];
}

export interface EntropyObservationWindow {
  file: string;
  observations: readonly EntropyValueObservation[];
}

export interface MergedObservationPool {
  file: EntropyObservationPoolFile;
  mergedSessions: number;
  skippedSessions: number;
}

const SEPARATOR = "\u0000";

// Identity of one observation: ref, key, and the typed value, so `1`
// (number) and "1" (string) stay distinct evidence.
export const observationIdentity = (
  observation: EntropyValueObservation,
): string =>
  `${observation.ref}${SEPARATOR}${observation.key}${SEPARATOR}${typeof observation.value}:${String(observation.value)}`;

const entryValueKey = (value: string | number | boolean): string =>
  `${typeof value}:${String(value)}`;

const valueFromKey = (valueKey: string): string | number | boolean => {
  const separator = valueKey.indexOf(":");
  const type = valueKey.slice(0, separator);
  const raw = valueKey.slice(separator + 1);
  if (type === "number") return Number(raw);
  if (type === "boolean") return raw === "true";
  return raw;
};

const parseIdentity = (identity: string): { ref: string; key: string; valueKey: string } => {
  const first = identity.indexOf(SEPARATOR);
  const second = identity.indexOf(SEPARATOR, first + 1);
  return {
    ref: identity.slice(0, first),
    key: identity.slice(first + 1, second),
    valueKey: identity.slice(second + 1),
  };
};

export interface ObservationSummary {
  digest: string;
  counts: Record<string, number>;
}

const digestFromIdentityCounts = (counts: Readonly<Record<string, number>>): string => {
  const hash = createHash("sha256");
  hash.update("[");
  let first = true;
  for (const [identity, count] of Object.entries(counts).sort(([left], [right]) =>
    compareCodeUnits(left, right),
  )) {
    const encoded = JSON.stringify(identity);
    const repeated = Array.from({ length: count }, () => encoded).join(",");
    hash.update(first ? repeated : `,${repeated}`);
    first = false;
  }
  hash.update("]");
  return hash.digest("hex");
};

const summarizeObservations = (
  observations: readonly EntropyValueObservation[],
): ObservationSummary => {
  const counts: Record<string, number> = {};
  const digestCounts: Record<string, number> = {};
  for (const observation of observations) {
    const identity = observationIdentity(observation);
    counts[identity] = (counts[identity] ?? 0) + (observation.count ?? 1);
    digestCounts[identity] = (digestCounts[identity] ?? 0) + 1;
  }
  return { counts, digest: digestFromIdentityCounts(digestCounts) };
};

// Digest of one window's observation multiset. The hash input is byte-for-byte
// compatible with the former sorted identity array, but sorting distinct keys
// avoids an O(n log n) sweep over every repeated observation.
export const observationWindowDigest = (
  observations: readonly EntropyValueObservation[],
): string => summarizeObservations(observations).digest;

const COOPERATIVE_OBSERVATION_CHUNK = 256;
const COOPERATIVE_DIGEST_CHUNK = 512;

const yieldToLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

const digestFromIdentityCountsAsync = async (
  counts: Readonly<Record<string, number>>,
): Promise<string> => {
  const hash = createHash("sha256");
  hash.update("[");
  let first = true;
  let processed = 0;
  for (const [identity, count] of Object.entries(counts).sort(([left], [right]) =>
    compareCodeUnits(left, right),
  )) {
    const encoded = JSON.stringify(identity);
    // Hash repeated identities in native string batches, not one JS array
    // element per historical observation. Preserve the v1 digest bytes.
    const batchSize = Math.max(1, Math.floor(32_768 / (encoded.length + 1)));
    for (let remaining = count; remaining > 0;) {
      const size = Math.min(remaining, batchSize, COOPERATIVE_DIGEST_CHUNK - processed);
      hash.update(`${first ? "" : ","}${encoded}${(`,${encoded}`).repeat(size - 1)}`);
      first = false;
      remaining -= size;
      processed += size;
      if (processed >= COOPERATIVE_DIGEST_CHUNK) {
        processed = 0;
        await yieldToLoop();
      }
    }
  }
  hash.update("]");
  return hash.digest("hex");
};

const summarizeObservationsAsync = async (
  observations: readonly EntropyValueObservation[],
): Promise<ObservationSummary> => {
  const counts: Record<string, number> = {};
  const digestCounts: Record<string, number> = {};
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index]!;
    const identity = observationIdentity(observation);
    counts[identity] = (counts[identity] ?? 0) + (observation.count ?? 1);
    digestCounts[identity] = (digestCounts[identity] ?? 0) + 1;
    if ((index + 1) % COOPERATIVE_OBSERVATION_CHUNK === 0) await yieldToLoop();
  }
  return { counts, digest: await digestFromIdentityCountsAsync(digestCounts) };
};

interface WorkingEntry {
  ref: string;
  key: string;
  values: Map<string, { value: string | number | boolean; count: number }>;
}

const workingFromPool = (
  pool: EntropyObservationPoolFile | undefined,
): Map<string, WorkingEntry> => {
  const working = new Map<string, WorkingEntry>();
  if (!pool) return working;
  for (const entry of pool.entries) {
    const values = new Map<string, { value: string | number | boolean; count: number }>();
    for (const item of entry.values) {
      values.set(entryValueKey(item.value), { value: item.value, count: item.count });
    }
    working.set(`${entry.ref}${SEPARATOR}${entry.key}`, {
      ref: entry.ref,
      key: entry.key,
      values,
    });
  }
  return working;
};

const applyEntryDelta = (
  working: Map<string, WorkingEntry>,
  identity: string,
  weight: number,
): string => {
  const { ref, key, valueKey } = parseIdentity(identity);
  const entryId = `${ref}${SEPARATOR}${key}`;
  let entry = working.get(entryId);
  if (!entry) {
    entry = { ref, key, values: new Map() };
    working.set(entryId, entry);
  }
  const current = entry.values.get(valueKey);
  // A tracked session's snapshot can still hold values the cap already
  // evicted, so a retraction only removes what the entry still retains.
  const nextCount = (current?.count ?? 0) + weight;
  if (nextCount > 0) {
    entry.values.set(valueKey, {
      value: current?.value ?? valueFromKey(valueKey),
      count: nextCount,
    });
  } else {
    entry.values.delete(valueKey);
  }
  if (entry.values.size === 0) working.delete(entryId);
  return entryId;
};

// The tracked-value cap bounds the pool file. Eviction only ever touches
// entries already past the derivation's distinct guard (16 tracked values
// exceed the 8-value eligibility), so it can never flip an eligible
// parameter ineligible, and an overflowed domain stays provably open.
const enforceValueCap = (entry: WorkingEntry): void => {
  while (entry.values.size > POOL_TRACKED_VALUES) {
    let evictKey: string | undefined;
    let evictCount = Number.POSITIVE_INFINITY;
    for (const [valueKey, item] of entry.values) {
      if (
        evictKey === undefined ||
        item.count < evictCount ||
        (item.count === evictCount && compareCodeUnits(valueKey, evictKey) > 0)
      ) {
        evictKey = valueKey;
        evictCount = item.count;
      }
    }
    if (evictKey === undefined) return;
    entry.values.delete(evictKey);
  }
};

const serializePool = (
  working: Map<string, WorkingEntry>,
  tracked: EntropyPoolTrackedSession[],
  baked: string[],
): EntropyObservationPoolFile => ({
  version: OBSERVATION_POOL_VERSION,
  entries: [...working.values()]
    .map((entry) => ({
      ref: entry.ref,
      key: entry.key,
      // Derived, never accumulated: the total always equals the retained
      // counts, whatever deltas and evictions the merge applied.
      total: [...entry.values.values()].reduce((sum, item) => sum + item.count, 0),
      values: [...entry.values.values()]
        .map((item) => ({ value: item.value, count: item.count }))
        .sort(
          (left, right) =>
            right.count - left.count ||
            compareCodeUnits(entryValueKey(left.value), entryValueKey(right.value)),
        ),
    }))
    .sort((left, right) =>
      compareCodeUnits(
        `${left.ref}${SEPARATOR}${left.key}`,
        `${right.ref}${SEPARATOR}${right.key}`,
      ),
    ),
  tracked,
  baked,
});

export interface SummarizedObservationWindow {
  file: string;
  summary: ObservationSummary;
}

export const mergeObservationSummaries = (
  pool: EntropyObservationPoolFile | undefined,
  windows: readonly SummarizedObservationWindow[],
): MergedObservationPool => {
  const working = workingFromPool(pool);
  const tracked = [...(pool?.tracked ?? [])];
  const baked = [...(pool?.baked ?? [])];
  const bakedSet = new Set(baked);
  const trackedDigests = new Set(tracked.map((session) => session.digest));
  let mergedSessions = 0;
  let skippedSessions = 0;
  for (const window of windows) {
    const { digest, counts: fresh } = window.summary;
    if (bakedSet.has(digest) || trackedDigests.has(digest)) {
      skippedSessions += 1;
      continue;
    }
    const existingIndex = tracked.findIndex((session) => session.file === window.file);
    const existing = existingIndex >= 0 ? tracked[existingIndex] : undefined;
    const delta: Record<string, number> = { ...fresh };
    if (existing) {
      for (const [identity, count] of Object.entries(existing.counts)) {
        delta[identity] = (delta[identity] ?? 0) - count;
      }
    }
    const touched = new Set<string>();
    for (const [identity, weight] of Object.entries(delta)) {
      if (weight === 0) continue;
      touched.add(applyEntryDelta(working, identity, weight));
    }
    for (const entryId of touched) {
      const entry = working.get(entryId);
      if (entry) enforceValueCap(entry);
    }
    const trackedSession = { file: window.file, digest, counts: { ...fresh } };
    if (existing) {
      tracked[existingIndex] = trackedSession;
    } else {
      tracked.push(trackedSession);
      if (tracked.length > POOL_TRACKED_SESSIONS) {
        const oldest = tracked.shift()!;
        if (!bakedSet.has(oldest.digest)) {
          baked.push(oldest.digest);
          bakedSet.add(oldest.digest);
          while (baked.length > POOL_BAKED_DIGESTS) {
            bakedSet.delete(baked.shift()!);
          }
        }
      }
    }
    trackedDigests.add(digest);
    mergedSessions += 1;
  }
  return {
    file: serializePool(working, tracked, baked),
    mergedSessions,
    skippedSessions,
  };
};

// Merge one session-window scan into the pool. A session contributes exactly
// once per content. The async form performs the expensive observation summary
// in deterministic chunks for extension hooks; the pure form remains the
// certification API.
export const mergeObservationWindow = (
  pool: EntropyObservationPoolFile | undefined,
  windows: readonly EntropyObservationWindow[],
): MergedObservationPool => mergeObservationSummaries(
  pool,
  windows.map((window) => ({
    file: window.file,
    summary: summarizeObservations(window.observations),
  })),
);

// The cache keeps only the ends of the array it summarized, not the array.
// Session snapshots are immutable and an appended snapshot reuses the earlier
// observation objects, so the ends identify the summarized prefix. Holding the
// arrays here would pin every session's observations after the session reader
// has evicted them.
interface CachedObservationWindow {
  length: number;
  first: EntropyValueObservation | undefined;
  last: EntropyValueObservation | undefined;
  counts: Record<string, number>;
  digestCounts: Record<string, number>;
  summary: ObservationSummary;
}

const extendsSummarized = (
  cached: CachedObservationWindow,
  observations: readonly EntropyValueObservation[],
): boolean =>
  cached.length <= observations.length &&
  (cached.length === 0 ||
    (observations[0] === cached.first && observations[cached.length - 1] === cached.last));

/** For immutable session-reader snapshots only; ordinary public merges stay pure. */
export class SessionObservationCache {
  readonly #windows = new Map<string, CachedObservationWindow>();

  async merge(
    pool: EntropyObservationPoolFile | undefined,
    windows: readonly EntropyObservationWindow[],
  ): Promise<MergedObservationPool> {
    return mergeObservationSummaries(pool, await this.summarize(windows));
  }

  /** Per-window summaries, reusing unchanged and appended windows by identity. */
  async summarize(windows: readonly EntropyObservationWindow[]): Promise<SummarizedObservationWindow[]> {
    const summarized: SummarizedObservationWindow[] = [];
    for (const window of windows) {
      let cached = this.#windows.get(window.file);
      const append = cached !== undefined && extendsSummarized(cached, window.observations);
      if (!append || cached!.length !== window.observations.length) {
        const counts = append ? { ...cached!.counts } : {};
        const digestCounts = append ? { ...cached!.digestCounts } : {};
        const start = append ? cached!.length : 0;
        for (let index = start; index < window.observations.length; index++) {
          const observation = window.observations[index]!;
          const identity = observationIdentity(observation);
          counts[identity] = (counts[identity] ?? 0) + (observation.count ?? 1);
          digestCounts[identity] = (digestCounts[identity] ?? 0) + 1;
          if ((index + 1) % COOPERATIVE_OBSERVATION_CHUNK === 0) await yieldToLoop();
        }
        const digest = await digestFromIdentityCountsAsync(digestCounts);
        cached = {
          length: window.observations.length,
          first: window.observations[0],
          last: window.observations.at(-1),
          counts,
          digestCounts,
          summary: { counts, digest },
        };
      }
      this.#windows.delete(window.file);
      this.#windows.set(window.file, cached!);
      while (this.#windows.size > 16) this.#windows.delete(this.#windows.keys().next().value!);
      summarized.push({ file: window.file, summary: cached!.summary });
      await yieldToLoop();
    }
    return summarized;
  }
}

export const mergeObservationWindowAsync = async (
  pool: EntropyObservationPoolFile | undefined,
  windows: readonly EntropyObservationWindow[],
): Promise<MergedObservationPool> => {
  const summarized: SummarizedObservationWindow[] = [];
  for (const window of windows) {
    summarized.push({
      file: window.file,
      summary: await summarizeObservationsAsync(window.observations),
    });
  }
  await yieldToLoop();
  return mergeObservationSummaries(pool, summarized);
};

// Expand the pool into the flat value-observation corpus the derivation
// consumes. Counts travel as multiplicity, so pooled evidence costs one
// observation per distinct value instead of one per recorded call.
export const poolToValueObservations = (
  pool: EntropyObservationPoolFile | undefined,
): EntropyValueObservation[] => {
  if (!pool) return [];
  const observations: EntropyValueObservation[] = [];
  for (const entry of pool.entries) {
    for (const item of entry.values) {
      observations.push({ ref: entry.ref, key: entry.key, value: item.value, count: item.count });
    }
  }
  return observations;
};
