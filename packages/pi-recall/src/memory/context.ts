import type { FabricExecutionOutcomeV1 } from "../audit/trace.js";
import type { EntryRange, MemoryCoverage } from "./index.js";
import type { MemoryBranches } from "./lineage.js";
import type {
  DigestHit,
  SearchResult,
  SearchSegment,
  SearchSegmentEntry,
} from "./search.js";
import {
  compareLexical,
  normalizeMemoryPhrase,
  tokenizeLexical,
  type MemoryQueryMatch,
  type MemoryQueryMode,
} from "./tokenize.js";

export const RECALL_DEFAULT_PAGE_SIZE = 10;
export const RECALL_MAX_PAGE_SIZE = 50;
export const RECALL_DEFAULT_SNIPPET_CHARS = 480;
export const RECALL_MAX_SNIPPET_CHARS = 2_000;
export const RECALL_MAX_RESPONSE_CHARS = 30_000;

export interface MemoryRecallCallArgs {
  query?: string;
  queryMode?: MemoryQueryMode;
  queryMatch?: MemoryQueryMatch;
  expectedSourceHash?: string;
  expectedLineageFingerprint?: string;
  branches?: MemoryBranches;
  scope?: string;
  offset?: number;
  pageSize?: number;
  snippetChars?: number;
  role?: string;
  tool?: string;
  ref?: string;
  provider?: string;
  action?: string;
  outcome?: FabricExecutionOutcomeV1;
  since?: number;
  until?: number;
  entryRange?: EntryRange;
  source?: string;
}

interface MemoryExpandCallArgs {
  session: string;
  source?: string;
  expectedSourceHash?: string;
  expectedLineageFingerprint?: string;
  branches?: MemoryBranches;
  indices?: number[];
  entryIds?: string[];
  operationAddresses?: string[];
  entryRange?: EntryRange;
  before?: number;
  after?: number;
  entryOffset?: number;
  textOffset?: number;
  maxChars?: number;
  maxEntries?: number;
}

interface MemorySourceBinding {
  sessionId: string;
  sessionFile: string;
  source?: string;
  sourceHash: string;
  branches: MemoryBranches;
  lineageFingerprint: string;
  tier: "hot" | "cold";
}

interface MemoryExpandFollow {
  ref: "memory.expand";
  args: MemoryExpandCallArgs;
}

interface MemoryRecallFollow {
  ref: "memory.recall";
  args: MemoryRecallCallArgs;
}

interface MemoryRecallEntryHit {
  kind: "entry";
  sessionId: string;
  tier: "hot" | "cold";
  index: number;
  entryId: string | null;
  parentId: string | null;
  operationAddress: string | null;
  type: string;
  role: string | null;
  tool: string | null;
  ref: string | null;
  provider: string | null;
  action: string | null;
  timestamp: number | null;
  isError: boolean;
  outcome?: FabricExecutionOutcomeV1;
  score: number;
  snippet: string;
  truncated: boolean;
  follow: MemoryExpandFollow;
}

interface MemoryRecallSessionHit {
  kind: "session";
  sessionId: string;
  tier: "cold";
  cwd: string;
  lastTimestamp: number | null;
  score: number;
  matchedTerms: number;
  matchedStructuralEntries: number;
  follow: MemoryRecallFollow;
}

type MemoryRecallHit = MemoryRecallEntryHit | MemoryRecallSessionHit;

interface MemoryRecallContinuation {
  ref: "memory.recall";
  args: MemoryRecallCallArgs;
}

export interface MemoryRecallResponse {
  total: number;
  hits: MemoryRecallHit[];
  next: MemoryRecallContinuation | null;
  coverage: MemoryCoverage;
}

interface RecallPresentationInput {
  result: SearchResult;
  query?: string;
  queryMode: MemoryQueryMode;
  coverage: MemoryCoverage;
  offset?: number;
  pageSize: number;
  snippetChars: number;
  requestArgs: MemoryRecallCallArgs;
}

interface Snippet {
  text: string;
  truncated: boolean;
}

const boundedMetadata = (value: string | null | undefined, max = 512): string | null => {
  if (value === undefined || value === null) return null;
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`;
};

const safeSlice = (text: string, start: number, end: number): string => {
  let safeStart = Math.max(0, start);
  let safeEnd = Math.min(text.length, end);
  const startCode = text.charCodeAt(safeStart);
  if (safeStart > 0 && startCode >= 0xdc00 && startCode <= 0xdfff) safeStart += 1;
  const endCode = text.charCodeAt(safeEnd - 1);
  if (safeEnd < text.length && endCode >= 0xd800 && endCode <= 0xdbff) safeEnd -= 1;
  return text.slice(safeStart, safeEnd);
};

const snippetAnchor = (
  text: string,
  query: string | undefined,
  queryMode: MemoryQueryMode,
): number => {
  if (!query) return 0;
  const normalized = normalizeMemoryPhrase(text);
  if (queryMode === "phrase") {
    const phrase = normalizeMemoryPhrase(query.trim());
    return Math.max(0, normalized.indexOf(phrase));
  }
  if (queryMode === "literal") {
    const terms = [...new Set(tokenizeLexical(query))].sort((left, right) =>
      right.length - left.length || left.localeCompare(right)
    );
    for (const term of terms) {
      const index = normalized.indexOf(term);
      if (index >= 0) return index;
    }
  }
  return 0;
};

const makeSnippet = (
  text: string,
  query: string | undefined,
  queryMode: MemoryQueryMode,
  maxChars: number,
): Snippet => {
  if (text.length <= maxChars) return { text, truncated: false };
  const anchor = snippetAnchor(text, query, queryMode);
  const leadingContext = Math.floor(maxChars / 3);
  let start = Math.max(0, anchor - leadingContext);
  let end = Math.min(text.length, start + maxChars);
  if (end - start < maxChars) start = Math.max(0, end - maxChars);
  const body = safeSlice(text, start, end);
  return {
    text: `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`,
    truncated: true,
  };
};

const sourceFromSegment = (segment: SearchSegment, sourceId?: string): MemorySourceBinding => ({
  sessionId: boundedMetadata(segment.sessionId) ?? "",
  sessionFile: segment.sessionFile,
  ...(sourceId ? { source: sourceId } : {}),
  sourceHash: segment.sourceHash,
  branches: segment.branches,
  lineageFingerprint: segment.lineageFingerprint,
  tier: segment.tier,
});

const sourceFromDigest = (digest: DigestHit, sourceId?: string): MemorySourceBinding => ({
  sessionId: boundedMetadata(digest.sessionId) ?? "",
  sessionFile: digest.sessionFile,
  ...(sourceId ? { source: sourceId } : {}),
  sourceHash: digest.sourceHash,
  branches: digest.branches,
  lineageFingerprint: digest.lineageFingerprint,
  tier: "cold",
});

const expandArgs = (
  source: MemorySourceBinding,
  entry: SearchSegmentEntry["entry"],
): MemoryExpandCallArgs => ({
  session: source.sessionFile,
  ...(source.source ? { source: source.source } : {}),
  expectedSourceHash: source.sourceHash,
  expectedLineageFingerprint: source.lineageFingerprint,
  branches: source.branches,
  indices: [entry.index],
});

const entryHit = (
  segment: SearchSegment,
  item: SearchSegmentEntry,
  query: string | undefined,
  queryMode: MemoryQueryMode,
  snippetChars: number,
  sourceId?: string,
): MemoryRecallEntryHit => {
  const entry = item.entry;
  const source = sourceFromSegment(segment, sourceId);
  const snippet = makeSnippet(entry.text, query, queryMode, snippetChars);
  return {
    kind: "entry",
    sessionId: source.sessionId,
    tier: source.tier,
    index: entry.index,
    entryId: boundedMetadata(entry.entryId),
    parentId: boundedMetadata(entry.parentId),
    operationAddress: boundedMetadata(entry.operationAddress),
    type: boundedMetadata(entry.type) ?? "entry",
    role: boundedMetadata(entry.role),
    tool: boundedMetadata(entry.toolName),
    ref: boundedMetadata(entry.ref),
    provider: boundedMetadata(entry.provider),
    action: boundedMetadata(entry.action),
    timestamp: entry.timestamp,
    isError: entry.isError,
    ...(entry.outcome ? { outcome: entry.outcome } : {}),
    score: item.score,
    snippet: snippet.text,
    truncated: snippet.truncated || entry.truncated,
    follow: { ref: "memory.expand", args: expandArgs(source, entry) },
  };
};

const hydrationArgs = (
  digest: DigestHit,
  request: MemoryRecallCallArgs,
): MemoryRecallCallArgs => {
  const { offset: _offset, entryRange: _entryRange, ...base } = request;
  return {
    ...base,
    scope: `session:${digest.sessionFile}`,
    branches: digest.branches,
    expectedSourceHash: digest.sourceHash,
    expectedLineageFingerprint: digest.lineageFingerprint,
  };
};

const sessionHit = (
  digest: DigestHit,
  request: MemoryRecallCallArgs,
  sourceId?: string,
): MemoryRecallSessionHit => {
  const source = sourceFromDigest(digest, sourceId);
  return {
    kind: "session",
    sessionId: source.sessionId,
    tier: "cold",
    cwd: boundedMetadata(digest.cwd, 2_048) ?? "",
    lastTimestamp: digest.lastTs,
    score: digest.score,
    matchedTerms: digest.matchedTerms,
    matchedStructuralEntries: digest.matchedStructuralEntries,
    follow: { ref: "memory.recall", args: hydrationArgs(digest, request) },
  };
};

type RecallCandidate =
  | { kind: "entry"; segment: SearchSegment; item: SearchSegmentEntry }
  | { kind: "session"; digest: DigestHit };

const recallCandidateCache = new WeakMap<SearchResult, RecallCandidate[]>();

const flattenCandidates = (result: SearchResult): RecallCandidate[] => {
  const cached = recallCandidateCache.get(result);
  if (cached) return cached;
  const candidates: RecallCandidate[] = [];
  for (const item of result.items) {
    if (item.kind === "digest") {
      candidates.push({ kind: "session", digest: item.digest });
      continue;
    }
    for (const entry of item.segment.entries) {
      if (entry.matched) candidates.push({ kind: "entry", segment: item.segment, item: entry });
    }
  }
  candidates.sort((left, right) => {
    const leftScore = left.kind === "entry" ? left.item.score : left.digest.score;
    const rightScore = right.kind === "entry" ? right.item.score : right.digest.score;
    if (rightScore !== leftScore) return rightScore - leftScore;
    const leftMtime = left.kind === "entry" ? left.segment.sessionMtime : left.digest.sessionMtime;
    const rightMtime = right.kind === "entry" ? right.segment.sessionMtime : right.digest.sessionMtime;
    if (rightMtime !== leftMtime) return rightMtime - leftMtime;
    if (left.kind !== right.kind) return left.kind === "entry" ? -1 : 1;
    if (left.kind === "entry" && right.kind === "entry") {
      if (left.item.entry.index !== right.item.entry.index) {
        return left.item.entry.index - right.item.entry.index;
      }
      return compareLexical(left.segment.sessionFile, right.segment.sessionFile);
    }
    if (left.kind === "session" && right.kind === "session") {
      return compareLexical(left.digest.sessionFile, right.digest.sessionFile);
    }
    return 0;
  });
  recallCandidateCache.set(result, candidates);
  return candidates;
};

const materializeCandidate = (
  candidate: RecallCandidate,
  query: string | undefined,
  queryMode: MemoryQueryMode,
  snippetChars: number,
  request: MemoryRecallCallArgs,
  sourceId?: string,
): MemoryRecallHit => candidate.kind === "session"
  ? sessionHit(candidate.digest, request, sourceId)
  : entryHit(candidate.segment, candidate.item, query, queryMode, snippetChars, sourceId);

const canonicalNextArgs = (
  request: MemoryRecallCallArgs,
  offset: number,
): MemoryRecallCallArgs => {
  const { offset: _offset, ...base } = request;
  return { ...base, offset };
};

export const presentRecall = (input: RecallPresentationInput): MemoryRecallResponse => {
  const candidates = flattenCandidates(input.result);
  const start = input.offset ?? 0;
  let selected = candidates.slice(start, start + input.pageSize);

  const build = (pageCandidates: RecallCandidate[]): MemoryRecallResponse => {
    const hits = pageCandidates.map((candidate) =>
      materializeCandidate(
        candidate,
        input.query,
        input.queryMode,
        input.snippetChars,
        input.requestArgs,
        input.requestArgs.source,
      )
    );
    return {
      total: candidates.length,
      hits,
      next: start + hits.length < candidates.length
        ? { ref: "memory.recall", args: canonicalNextArgs(input.requestArgs, start + hits.length) }
        : null,
      coverage: input.coverage,
    };
  };

  let response = build(selected);
  while (selected.length > 1 && JSON.stringify(response).length > RECALL_MAX_RESPONSE_CHARS) {
    selected = selected.slice(0, -1);
    response = build(selected);
  }
  return response;
};
