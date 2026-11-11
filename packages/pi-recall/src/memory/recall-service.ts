import type { FabricInvocationContext } from "../protocol.js";
import {
  presentRecall,
  RECALL_DEFAULT_PAGE_SIZE,
  RECALL_DEFAULT_SNIPPET_CHARS,
  RECALL_MAX_PAGE_SIZE,
  RECALL_MAX_SNIPPET_CHARS,
  type MemoryRecallCallArgs,
} from "./context.js";
import { reconstructSessionLineage } from "./lineage.js";
import {
  fingerprintSource,
  loadTieredIndex,
  type EntryRange,
  type SearchFilters,
} from "./index.js";
import {
  DEFAULT_REGEX_MAX_HAYSTACK_BYTES,
  DEFAULT_REGEX_MAX_HAYSTACK_TERMS,
  DEFAULT_REGEX_MAX_PATTERN_BYTES,
  DEFAULT_REGEX_TIMEOUT_MS,
  searchMemoryIndex,
  type SearchResult,
} from "./search.js";
import type { MemoryQueryMatch, MemoryQueryMode } from "./tokenize.js";
import {
  parseBranches,
  resolveRefs,
  liveBranchResolver,
  resolveIndexOptions,
  addressError,
  recallFailure,
  stalePointerError,
  type MemoryProviderContext,
} from "./request-context.js";
import {
  checkAbort,
  fileRecallPlan,
  hostRecallPlan,
  memorySourceFailure,
  resolveRegisteredSource,
  type RecallSourcePlan,
} from "./host-source.js";
import { sameSourceObservations, type SourceObservation } from "./source-observation.js";
import { recallContinuationKey, type RecallRequestCache } from "./request-cache.js";

export async function processMemoryRecall(
  args: Record<string, unknown>,
  invocationContext: Pick<FabricInvocationContext, "update" | "signal">,
  context: MemoryProviderContext,
  cache: RecallRequestCache,
): Promise<unknown> {
  const query = typeof args.query === "string" ? args.query : undefined;
  const rawQueryMode = args.queryMode;
  if (
    rawQueryMode !== undefined &&
    rawQueryMode !== "literal" &&
    rawQueryMode !== "phrase" &&
    rawQueryMode !== "regex"
  ) {
    throw new Error('memory.recall queryMode must be "literal", "phrase", or "regex"');
  }
  const queryMode: MemoryQueryMode = rawQueryMode === "phrase"
    ? "phrase"
    : rawQueryMode === "regex"
      ? "regex"
      : "literal";
  const rawQueryMatch = args.queryMatch;
  if (rawQueryMatch !== undefined && rawQueryMatch !== "all" && rawQueryMatch !== "any") {
    throw new Error('memory.recall queryMatch must be "all" or "any"');
  }
  if (queryMode !== "literal" && rawQueryMatch !== undefined) {
    throw new Error("memory.recall queryMatch is only valid with literal queryMode");
  }
  const queryMatch: MemoryQueryMatch = rawQueryMatch === "all" ? "all" : "any";
  const expectedSourceHash = typeof args.expectedSourceHash === "string"
    ? args.expectedSourceHash
    : undefined;
  const expectedLineageFingerprint = typeof args.expectedLineageFingerprint === "string"
    ? args.expectedLineageFingerprint
    : undefined;
  const branches = parseBranches(args.branches, "memory.recall");
  const scope = typeof args.scope === "string" ? args.scope : undefined;
  const role = typeof args.role === "string" ? args.role : undefined;
  const tool = typeof args.tool === "string" ? args.tool : undefined;
  const ref = typeof args.ref === "string" ? args.ref : undefined;
  const provider = typeof args.provider === "string" ? args.provider : undefined;
  const action = typeof args.action === "string" ? args.action : undefined;
  const rawOutcome = args.outcome;
  if (
    rawOutcome !== undefined &&
    rawOutcome !== "succeeded" &&
    rawOutcome !== "failed" &&
    rawOutcome !== "aborted" &&
    rawOutcome !== "timed_out"
  ) {
    throw new Error("memory.recall outcome must be succeeded, failed, aborted, or timed_out");
  }
  const outcome = rawOutcome as SearchFilters["outcome"];
  const since = typeof args.since === "number" ? args.since : undefined;
  const until = typeof args.until === "number" ? args.until : undefined;
  const offset = typeof args.offset === "number" && args.offset >= 0
    ? Math.floor(args.offset)
    : undefined;
  const pageSize =
    typeof args.pageSize === "number" && args.pageSize >= 1
      ? Math.min(Math.floor(args.pageSize), RECALL_MAX_PAGE_SIZE)
      : RECALL_DEFAULT_PAGE_SIZE;
  const snippetChars =
    typeof args.snippetChars === "number" && args.snippetChars >= 80
      ? Math.min(Math.floor(args.snippetChars), RECALL_MAX_SNIPPET_CHARS)
      : RECALL_DEFAULT_SNIPPET_CHARS;

  const sourceId = typeof args.source === "string" && args.source.length > 0
    ? args.source
    : undefined;
  let plan: RecallSourcePlan;
  if (sourceId !== undefined) {
    if (scope !== undefined && scope !== `source:${sourceId}` && !scope.startsWith("session:")) {
      throw new Error(
        'memory.recall scope must name the selected source, one of its sessions, or be omitted',
      );
    }
    try {
      plan = await hostRecallPlan(
        resolveRegisteredSource(context.sources, sourceId),
        sourceId,
        scope?.startsWith("session:") ? scope.slice("session:".length).trim() : null,
        context,
        invocationContext.signal,
      );
    } catch (error) {
      const failure = memorySourceFailure(error);
      if (!failure) throw error;
      return recallFailure(failure);
    }
  } else {
    plan = fileRecallPlan(resolveRefs(scope, context, false), context);
  }
  const refs = plan.refs;
  const options = resolveIndexOptions(
    context.config,
    context.agentDir,
    branches,
    sourceId === undefined ? liveBranchResolver(context) : undefined,
  );
  const hydrate = sourceId !== undefined
    ? plan.sessionKey !== null
    : scope?.trim().startsWith("session:") ?? false;
  if ((expectedSourceHash !== undefined || expectedLineageFingerprint !== undefined) && !hydrate) {
    throw new Error("memory.recall integrity expectations require scope session:<id-or-path>");
  }

  const rawRange = args.entryRange;
  const entryRange = rawRange && typeof rawRange === "object" && !Array.isArray(rawRange)
    ? rawRange as Record<string, unknown>
    : undefined;
  const first = entryRange?.first;
  const last = entryRange?.last;
  if ((first === undefined) !== (last === undefined)) {
    throw new Error("memory.recall entryRange requires both first and last");
  }
  if ((first !== undefined || last !== undefined) && !hydrate) {
    throw new Error("memory.recall entryRange requires scope session:<id-or-path>");
  }
  if (first !== undefined && (
    typeof first !== "number" ||
    typeof last !== "number" ||
    !Number.isSafeInteger(first) ||
    !Number.isSafeInteger(last) ||
    first < 0 ||
    last < first
  )) {
    return recallFailure(addressError("Entry range requires safe integers with 0 <= first <= last."));
  }
  const selectedRange: EntryRange | undefined =
    typeof first === "number" && typeof last === "number" ? { first, last } : undefined;
  const filters: SearchFilters = {};
  if (role) filters.role = role;
  if (tool) filters.tool = tool;
  if (ref) filters.ref = ref;
  if (provider) filters.provider = provider;
  if (action) filters.action = action;
  if (outcome) filters.outcome = outcome;
  if (since !== undefined) filters.since = since;
  if (until !== undefined) filters.until = until;
  const baseRequestArgs: MemoryRecallCallArgs = {
    ...(sourceId ? { source: sourceId } : {}),
    ...(query === undefined ? {} : { query }),
    queryMode,
    ...(queryMode === "literal" ? { queryMatch } : {}),
    ...(expectedSourceHash ? { expectedSourceHash } : {}),
    ...(expectedLineageFingerprint ? { expectedLineageFingerprint } : {}),
    branches,
    scope: sourceId
      ? plan.sessionKey !== null
        ? `session:${plan.refs[0]?.file ?? plan.sessionKey}`
        : `source:${sourceId}`
      : scope ?? "session",
    ...(offset === undefined ? {} : { offset }),
    pageSize,
    snippetChars,
    ...(role ? { role } : {}),
    ...(tool ? { tool } : {}),
    ...(ref ? { ref } : {}),
    ...(provider ? { provider } : {}),
    ...(action ? { action } : {}),
    ...(outcome ? { outcome } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(selectedRange ? { entryRange: selectedRange } : {}),
  };
  const updateProgress = (searchResult: SearchResult): void => {
    invocationContext.update(
      searchResult.matchMode === "structural"
        ? `memory.recall: ${searchResult.matchedCount} structural matches`
        : searchResult.matchMode === "combined"
          ? `memory.recall: ${searchResult.matchedCount} filtered matches`
          : query
            ? `memory.recall: ${searchResult.matchedCount} matches`
            : `memory.recall: ${searchResult.matchedCount} recent entries`,
    );
  };
  const observationsBefore: readonly SourceObservation[] | null = await plan.observeAll(branches);
  const cached = offset === undefined
    ? undefined
    : cache.cachedRecallContinuation(
        recallContinuationKey(baseRequestArgs, context.fabricScope?.digest),
        observationsBefore,
      );
  if (cached) {
    const response = presentRecall({
      result: cached.result,
      ...(query === undefined ? {} : { query }),
      queryMode,
      coverage: cached.coverage,
      ...(offset === undefined ? {} : { offset }),
      pageSize,
      snippetChars,
      requestArgs: cached.requestArgs,
    });
    const observationsAfterCachedPage = await plan.observeAll(branches);
    if (
      observationsBefore &&
      observationsAfterCachedPage &&
      sameSourceObservations(observationsBefore, observationsAfterCachedPage)
    ) {
      if (response.next === null) cache.forgetRecallContinuation(cached);
      updateProgress(cached.result);
      return response;
    }
    cache.forgetRecallContinuation(cached);
  }

  if (hydrate && refs[0]) {
    const state = plan.stateFor(refs[0]);
    const lineage = plan.lineageFor(refs[0], branches);
    const sourceChanged = expectedSourceHash !== undefined &&
      state?.sourceHash !== expectedSourceHash;
    const lineageChanged = expectedLineageFingerprint !== undefined &&
      lineage.fingerprint !== expectedLineageFingerprint;
    if (state && (sourceChanged || lineageChanged)) {
      return recallFailure(stalePointerError(
        refs[0].file,
        expectedSourceHash,
        state.sourceHash,
        expectedLineageFingerprint,
        lineage.fingerprint,
      ));
    }
  }

  const index = plan.loadIndex(options, hydrate, selectedRange);
  const hydratedShard = index.shards[0];
  const hydratedSourceChanged = expectedSourceHash !== undefined &&
    hydratedShard?.sourceHash !== expectedSourceHash;
  const hydratedLineageChanged = expectedLineageFingerprint !== undefined &&
    hydratedShard?.lineageFingerprint !== expectedLineageFingerprint;
  if (hydrate && hydratedShard && (hydratedSourceChanged || hydratedLineageChanged)) {
    return recallFailure(stalePointerError(
      hydratedShard.sessionFile,
      expectedSourceHash,
      hydratedShard.sourceHash,
      expectedLineageFingerprint,
      hydratedShard.lineageFingerprint,
    ));
  }
  if (
    hydrate &&
    selectedRange &&
    index.shards[0] &&
    selectedRange.last >= index.shards[0].totalEntryCount
  ) {
    return recallFailure(addressError(
      `Entry range ends at ${selectedRange.last}, but the session has ${index.shards[0].totalEntryCount} entries.`,
      index.shards[0].totalEntryCount,
    ));
  }

  const searchQuery = {
    ...(query === undefined ? {} : { query }),
    queryMode,
    queryMatch,
    filters,
    regexLimits: {
      maxPatternBytes: context.config.regexMaxPatternBytes
        ?? DEFAULT_REGEX_MAX_PATTERN_BYTES,
      maxHaystackTerms: context.config.regexMaxHaystackTerms
        ?? DEFAULT_REGEX_MAX_HAYSTACK_TERMS,
      maxHaystackBytes: context.config.regexMaxHaystackBytes
        ?? DEFAULT_REGEX_MAX_HAYSTACK_BYTES,
      timeoutMs: context.config.regexTimeoutMs ?? DEFAULT_REGEX_TIMEOUT_MS,
    },
  };
  const result = await searchMemoryIndex(index.shards, index.digests, searchQuery);
  const coverage = {
    ...index.coverage,
    complete: index.coverage.complete && result.queryCoverage.complete,
    reasons: [...new Set([...index.coverage.reasons, ...result.queryCoverage.reasons])].sort(),
    ...(result.queryCoverage.error ? { error: result.queryCoverage.error } : {}),
  };
  const soleRef = refs.length === 1 ? refs[0] : undefined;
  const soleShard = soleRef
    ? index.shards.find((candidate) => candidate.sessionFile === soleRef.file)
    : undefined;
  const soleDigest = soleRef
    ? index.digests.find((candidate) => candidate.file === soleRef.file)
    : undefined;
  const continuationBinding = soleRef && (soleShard?.sourceHash || soleDigest?.sourceHash)
    ? {
        file: soleRef.file,
        sourceHash: soleShard?.sourceHash ?? soleDigest!.sourceHash,
        lineageFingerprint: soleShard?.lineageFingerprint ?? soleDigest!.lineageFingerprint,
      }
    : undefined;
  const requestArgs: MemoryRecallCallArgs = {
    ...baseRequestArgs,
    ...((expectedSourceHash ?? continuationBinding?.sourceHash)
      ? { expectedSourceHash: expectedSourceHash ?? continuationBinding!.sourceHash }
      : {}),
    ...((expectedLineageFingerprint ?? continuationBinding?.lineageFingerprint)
      ? {
          expectedLineageFingerprint:
            expectedLineageFingerprint ?? continuationBinding!.lineageFingerprint,
        }
      : {}),
    scope: continuationBinding
      ? `session:${continuationBinding.file}`
      : baseRequestArgs.scope ?? "session",
  };
  const response = presentRecall({
    result,
    ...(query === undefined ? {} : { query }),
    queryMode,
    coverage,
    ...(offset === undefined ? {} : { offset }),
    pageSize,
    snippetChars,
    requestArgs,
  });
  const observationsAfter = await plan.observeAll(branches);
  if (
    response.next !== null &&
    observationsBefore &&
    observationsAfter &&
    sameSourceObservations(observationsBefore, observationsAfter)
  ) {
    cache.rememberRecallContinuation({
      key: recallContinuationKey(requestArgs, context.fabricScope?.digest),
      result,
      coverage,
      requestArgs,
      observations: observationsAfter,
      touchedAt: Date.now(),
    });
  }
  updateProgress(result);
  return response;
}
