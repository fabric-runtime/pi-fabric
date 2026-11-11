import path from "node:path";
import {
  RECALL_DEFAULT_PAGE_SIZE,
  RECALL_DEFAULT_SNIPPET_CHARS,
  type MemoryRecallCallArgs,
} from "./context.js";
import type { MemoryBranches } from "./lineage.js";
import type { ExpandSessionSelection, ExpandedSessionEntry, NormalizedEntry } from "./normalize.js";
import type { MemoryCoverage } from "./index.js";
import type { SearchResult } from "./search.js";
import {
  sameSourceObservation,
  sameSourceObservations,
  type SourceObservation,
} from "./source-observation.js";

const CONTINUATION_CACHE_TTL_MS = 5 * 60_000;
const EXPANSION_SNAPSHOT_LIMIT = 2;
const EXPANSION_SELECTION_LIMIT = 16;

export type CanonicalExpansionSelection = ExpandSessionSelection & {
  before?: number;
  after?: number;
};

export interface ResolvedExpansionSelection {
  entries: ExpandedSessionEntry[];
  canonical: CanonicalExpansionSelection;
  anchorIndex: number | null;
}

export interface ExpansionSnapshot {
  file: string;
  branches: MemoryBranches;
  /** Host scope digest; a snapshot is never served under another scope. */
  scopeDigest?: string;
  sourceHash: string;
  lineageFingerprint: string;
  observation: SourceObservation;
  entries: readonly NormalizedEntry[];
  selections: Map<string, ResolvedExpansionSelection>;
  touchedAt: number;
}

export interface RecallContinuationCache {
  key: string;
  result: SearchResult;
  coverage: MemoryCoverage;
  requestArgs: MemoryRecallCallArgs;
  observations: readonly SourceObservation[];
  touchedAt: number;
}

export const recallContinuationKey = (args: MemoryRecallCallArgs, scopeDigest?: string): string => JSON.stringify([
  scopeDigest ?? null,
  args.query ?? null,
  args.queryMode ?? "literal",
  args.queryMatch ?? null,
  args.expectedSourceHash ?? null,
  args.expectedLineageFingerprint ?? null,
  args.branches ?? "active",
  args.scope ?? "session",
  args.pageSize ?? RECALL_DEFAULT_PAGE_SIZE,
  args.snippetChars ?? RECALL_DEFAULT_SNIPPET_CHARS,
  args.role ?? null,
  args.tool ?? null,
  args.ref ?? null,
  args.provider ?? null,
  args.action ?? null,
  args.outcome ?? null,
  args.since ?? null,
  args.until ?? null,
  args.entryRange ? [args.entryRange.first, args.entryRange.last] : null,
]);

const expansionSnapshotKey = (file: string, branches: MemoryBranches, scopeDigest?: string): string =>
  `${path.resolve(file)}\0${branches}\0${scopeDigest ?? ""}`;

export const expansionSelectionKey = (selection: CanonicalExpansionSelection): string => JSON.stringify([
  selection.indices ?? null,
  selection.entryIds ?? null,
  selection.operationAddresses ?? null,
  selection.entryRange ? [selection.entryRange.first, selection.entryRange.last] : null,
  selection.before ?? 0,
  selection.after ?? 0,
]);

export class MemoryRequestCache {
  private recallContinuation: RecallContinuationCache | undefined;
  private readonly expansionSnapshots = new Map<string, ExpansionSnapshot>();

  cachedRecallContinuation(
    key: string,
    observations: readonly SourceObservation[] | null,
  ): RecallContinuationCache | undefined {
    const cached = this.recallContinuation;
    if (!cached || cached.key !== key) return undefined;
    if (
      !observations ||
      Date.now() - cached.touchedAt > CONTINUATION_CACHE_TTL_MS ||
      !sameSourceObservations(cached.observations, observations)
    ) {
      this.recallContinuation = undefined;
      return undefined;
    }
    cached.touchedAt = Date.now();
    return cached;
  }

  rememberRecallContinuation(cached: RecallContinuationCache): void {
    this.recallContinuation = cached;
  }

  forgetRecallContinuation(cached: RecallContinuationCache): void {
    if (this.recallContinuation === cached) this.recallContinuation = undefined;
  }

  cachedExpansionSnapshot(
    file: string,
    branches: MemoryBranches,
    observation: SourceObservation | null,
    scopeDigest?: string,
  ): ExpansionSnapshot | undefined {
    const key = expansionSnapshotKey(file, branches, scopeDigest);
    const cached = this.expansionSnapshots.get(key);
    if (!cached) return undefined;
    if (
      !observation ||
      Date.now() - cached.touchedAt > CONTINUATION_CACHE_TTL_MS ||
      !sameSourceObservation(cached.observation, observation)
    ) {
      this.expansionSnapshots.delete(key);
      return undefined;
    }
    cached.touchedAt = Date.now();
    this.expansionSnapshots.delete(key);
    this.expansionSnapshots.set(key, cached);
    return cached;
  }

  rememberExpansionSnapshot(snapshot: ExpansionSnapshot): void {
    const key = expansionSnapshotKey(snapshot.file, snapshot.branches, snapshot.scopeDigest);
    this.expansionSnapshots.delete(key);
    this.expansionSnapshots.set(key, snapshot);
    while (this.expansionSnapshots.size > EXPANSION_SNAPSHOT_LIMIT) {
      const oldest = this.expansionSnapshots.keys().next().value;
      if (oldest === undefined) break;
      this.expansionSnapshots.delete(oldest);
    }
  }

  rememberExpansionSelection(
    snapshot: ExpansionSnapshot,
    keys: readonly string[],
    selection: ResolvedExpansionSelection,
  ): void {
    for (const key of new Set(keys)) {
      snapshot.selections.delete(key);
      snapshot.selections.set(key, selection);
    }
    while (snapshot.selections.size > EXPANSION_SELECTION_LIMIT) {
      const oldest = snapshot.selections.keys().next().value;
      if (oldest === undefined) break;
      snapshot.selections.delete(oldest);
    }
  }

  forgetExpansionSnapshot(snapshot: ExpansionSnapshot): void {
    const key = expansionSnapshotKey(snapshot.file, snapshot.branches, snapshot.scopeDigest);
    if (this.expansionSnapshots.get(key) === snapshot) this.expansionSnapshots.delete(key);
  }
}

// Services can only access their own cache lifecycle operations.
export type RecallRequestCache = Pick<MemoryRequestCache,
  "cachedRecallContinuation" | "rememberRecallContinuation" | "forgetRecallContinuation"
>;

export type ExpansionRequestCache = Pick<MemoryRequestCache,
  "cachedExpansionSnapshot" | "rememberExpansionSnapshot" | "rememberExpansionSelection" | "forgetExpansionSnapshot"
>;
