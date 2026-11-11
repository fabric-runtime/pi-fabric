import { pointerCurrent } from "../verified/policy.js";
import { acceptsExpansionPage } from "../verified/memory.js";
import { RECALL_MAX_RESPONSE_CHARS } from "./context.js";
import {
  expandSessionEntriesChecked,
  type ExpandSessionSelection,
} from "./normalize.js";
import {
  fileExpansionAccess,
  hostExpansionAccess,
  memorySourceFailure,
  type ExpansionAccess,
} from "./host-source.js";
import {
  EXPAND_DEFAULT_MAX_CHARS,
  EXPAND_MAX_CHARS,
  EXPAND_DEFAULT_MAX_ENTRIES,
  EXPAND_MAX_ENTRIES,
  EXPAND_MAX_CONTEXT,
  EXPAND_MAX_EXACT_SELECTORS,
} from "./request-limits.js";
import {
  parseBranches,
  addressError,
  stalePointerError,
  type MemoryProviderContext,
} from "./request-context.js";
import { sameSourceObservation } from "./source-observation.js";
import {
  expansionSelectionKey,
  type CanonicalExpansionSelection,
  type ExpansionRequestCache,
} from "./request-cache.js";

export async function processMemoryExpand(
  args: Record<string, unknown>,
  context: MemoryProviderContext,
  cache: ExpansionRequestCache,
  signal?: AbortSignal,
): Promise<unknown> {
  const session = typeof args.session === "string" ? args.session : "";
  const sourceId = typeof args.source === "string" && args.source.length > 0
    ? args.source
    : undefined;
  const expectedSourceHash = typeof args.expectedSourceHash === "string"
    ? args.expectedSourceHash
    : undefined;
  const expectedLineageFingerprint = typeof args.expectedLineageFingerprint === "string"
    ? args.expectedLineageFingerprint
    : undefined;
  const branches = parseBranches(args.branches, "memory.expand");
  const rawIndices = args.indices;
  if (rawIndices !== undefined && !Array.isArray(rawIndices)) {
    throw new Error("memory.expand indices must be an array");
  }
  if (Array.isArray(rawIndices) && !rawIndices.every((index) =>
    typeof index === "number" && Number.isSafeInteger(index) && index >= 0)) {
    return { session, error: addressError("Every entry index must be a non-negative safe integer."), entries: [] };
  }
  const indices = (rawIndices as number[] | undefined) ?? [];
  const entryIds = Array.isArray(args.entryIds)
    ? args.entryIds.filter(
        (entryId): entryId is string => typeof entryId === "string" && entryId.length > 0,
      )
    : [];
  const operationAddresses = Array.isArray(args.operationAddresses)
    ? args.operationAddresses.filter(
        (address): address is string => typeof address === "string" && address.length > 0,
      )
    : [];
  if (indices.length + entryIds.length + operationAddresses.length > EXPAND_MAX_EXACT_SELECTORS) {
    throw new Error(`memory.expand accepts at most ${EXPAND_MAX_EXACT_SELECTORS} exact selectors per call`);
  }
  const rawRange = args.entryRange;
  const rangeRecord = rawRange && typeof rawRange === "object" && !Array.isArray(rawRange)
    ? rawRange as Record<string, unknown>
    : undefined;
  const first = rangeRecord?.first;
  const last = rangeRecord?.last;
  if (!session) throw new Error("memory.expand requires a session");
  if ((first === undefined) !== (last === undefined)) {
    throw new Error("memory.expand entryRange requires both first and last");
  }
  if (first !== undefined && (
    typeof first !== "number" ||
    typeof last !== "number" ||
    !Number.isSafeInteger(first) ||
    !Number.isSafeInteger(last) ||
    first < 0 ||
    last < first
  )) {
    return { session, error: addressError("Entry range requires safe integers with 0 <= first <= last."), entries: [] };
  }
  const numeric = (value: unknown, fallback: number, maximum: number): number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? Math.min(value, maximum)
      : fallback;
  const before = numeric(args.before, 0, EXPAND_MAX_CONTEXT);
  const after = numeric(args.after, 0, EXPAND_MAX_CONTEXT);
  const entryOffset = numeric(args.entryOffset, 0, Number.MAX_SAFE_INTEGER);
  const textOffset = numeric(args.textOffset, 0, Number.MAX_SAFE_INTEGER);
  const maxChars = Math.max(256, numeric(args.maxChars, EXPAND_DEFAULT_MAX_CHARS, EXPAND_MAX_CHARS));
  const maxEntries = Math.max(1, numeric(args.maxEntries, EXPAND_DEFAULT_MAX_ENTRIES, EXPAND_MAX_ENTRIES));

  let access: ExpansionAccess | null;
  if (sourceId !== undefined) {
    try {
      access = await hostExpansionAccess(sourceId, session, context, signal);
    } catch (error) {
      const failure = memorySourceFailure(error);
      if (!failure) throw error;
      return { session, error: failure, entries: [] };
    }
  } else {
    access = fileExpansionAccess(session, context);
  }
  if (!access) {
    return {
      session,
      error: { code: "session_not_found", message: `Session not found: ${session}` },
      entries: [],
    };
  }
  const ref = access.ref;
  const observedSource = access.observe(branches);
  let snapshot = cache.cachedExpansionSnapshot(ref.file, branches, observedSource, context.fabricScope?.digest);
  if (snapshot) {
    const sourceChanged = expectedSourceHash !== undefined &&
      snapshot.sourceHash !== expectedSourceHash;
    const lineageChanged = expectedLineageFingerprint !== undefined &&
      snapshot.lineageFingerprint !== expectedLineageFingerprint;
    if (!pointerCurrent(!sourceChanged, !lineageChanged)) {
      return {
        session: ref.file,
        branches,
        error: stalePointerError(
          ref.file,
          expectedSourceHash,
          snapshot.sourceHash,
          expectedLineageFingerprint,
          snapshot.lineageFingerprint,
        ),
        entries: [],
      };
    }
  }

  if (!snapshot) {
    const initialState = access.state();
    if (!initialState) {
      return {
        session: ref.file,
        error: { code: "source_unavailable", message: `Session source is unavailable: ${ref.file}` },
        entries: [],
      };
    }
    const initialLineage = access.lineage(branches);
    const sourceChanged = expectedSourceHash !== undefined &&
      initialState.sourceHash !== expectedSourceHash;
    const lineageChanged = expectedLineageFingerprint !== undefined &&
      initialLineage.fingerprint !== expectedLineageFingerprint;
    if (!pointerCurrent(!sourceChanged, !lineageChanged)) {
      return {
        session: ref.file,
        branches,
        error: stalePointerError(
          ref.file,
          expectedSourceHash,
          initialState.sourceHash,
          expectedLineageFingerprint,
          initialLineage.fingerprint,
        ),
        entries: [],
      };
    }

    const normalizedFull = access.normalizeFull(
      branches,
      { indexThinking: true, indexToolOutput: true },
      initialLineage,
    );
    if (!normalizedFull) {
      return {
        session: ref.file,
        error: stalePointerError(
          ref.file,
          expectedSourceHash ?? initialState.sourceHash,
          initialState.sourceHash,
          expectedLineageFingerprint ?? initialLineage.fingerprint,
          initialLineage.fingerprint,
        ),
        entries: [],
      };
    }
    const normalized = normalizedFull.entries;
    const finalState = access.state();
    const finalLineage = access.lineage(branches);
    const finalObservation = access.observe(branches);
    if (
      !finalState ||
      !finalObservation ||
      !pointerCurrent(finalState.sourceHash === initialState.sourceHash, finalLineage.fingerprint === initialLineage.fingerprint)
    ) {
      return {
        session: ref.file,
        error: stalePointerError(
          ref.file,
          expectedSourceHash ?? initialState.sourceHash,
          finalState?.sourceHash ?? "",
          expectedLineageFingerprint ?? initialLineage.fingerprint,
          finalLineage.fingerprint,
        ),
        entries: [],
      };
    }
    snapshot = {
      file: ref.file,
      branches,
      ...(context.fabricScope ? { scopeDigest: context.fabricScope.digest } : {}),
      sourceHash: finalState.sourceHash,
      lineageFingerprint: finalLineage.fingerprint,
      observation: finalObservation,
      entries: normalized,
      selections: new Map(),
      touchedAt: Date.now(),
    };
  }

  const entryCount = snapshot.entries.length;
  const outOfBounds = indices.find((index) => index >= entryCount);
  if (outOfBounds !== undefined) {
    return {
      session: ref.file,
      error: addressError(`Entry index ${outOfBounds} is outside 0..${Math.max(0, entryCount - 1)}.`, entryCount),
      entries: [],
    };
  }
  if (typeof last === "number" && last >= entryCount) {
    return {
      session: ref.file,
      error: addressError(`Entry range ends at ${last}, but the session has ${entryCount} entries.`, entryCount),
      entries: [],
    };
  }
  if (
    indices.length === 0 &&
    entryIds.length === 0 &&
    operationAddresses.length === 0 &&
    (first === undefined || last === undefined)
  ) {
    if (before > 0 || after > 0) {
      throw new Error("memory.expand before/after requires one selected anchor");
    }
    cache.forgetExpansionSnapshot(snapshot);
    return {
      session: ref.file,
      sourceHash: snapshot.sourceHash,
      branches,
      lineageFingerprint: snapshot.lineageFingerprint,
      entryCount,
      entries: [],
      next: null,
    };
  }

  const requestedSelection: ExpandSessionSelection = {};
  if (indices.length > 0) requestedSelection.indices = indices;
  if (entryIds.length > 0) requestedSelection.entryIds = entryIds;
  if (operationAddresses.length > 0) requestedSelection.operationAddresses = operationAddresses;
  if (typeof first === "number" && typeof last === "number") {
    requestedSelection.entryRange = { first, last };
  }
  const requestedWithContext: CanonicalExpansionSelection = {
    ...requestedSelection,
    ...(before > 0 ? { before } : {}),
    ...(after > 0 ? { after } : {}),
  };
  const requestedKey = expansionSelectionKey(requestedWithContext);
  let resolved = snapshot.selections.get(requestedKey);
  if (!resolved) {
    let expansion = expandSessionEntriesChecked(snapshot.entries, requestedSelection);
    if ("error" in expansion) {
      return {
        session: ref.file,
        sourceHash: snapshot.sourceHash,
        branches,
        lineageFingerprint: snapshot.lineageFingerprint,
        error: expansion.error,
        entries: [],
      };
    }

    let anchorIndex: number | null = null;
    let canonical: CanonicalExpansionSelection;
    if (before > 0 || after > 0) {
      if (expansion.expanded.length !== 1) {
        throw new Error("memory.expand before/after requires exactly one resolved anchor");
      }
      anchorIndex = expansion.expanded[0]!.index;
      const contextRange = {
        first: Math.max(0, anchorIndex - before),
        last: Math.min(Math.max(0, entryCount - 1), anchorIndex + after),
      };
      canonical = requestedWithContext;
      expansion = expandSessionEntriesChecked(snapshot.entries, { entryRange: contextRange });
      if ("error" in expansion) {
        return {
          session: ref.file,
          sourceHash: snapshot.sourceHash,
          branches,
          lineageFingerprint: snapshot.lineageFingerprint,
          error: expansion.error,
          entries: [],
        };
      }
    } else if (requestedSelection.entryRange) {
      canonical = { entryRange: requestedSelection.entryRange };
    } else {
      canonical = { indices: expansion.expanded.map((entry) => entry.index) };
    }
    resolved = { entries: expansion.expanded, canonical, anchorIndex };
    cache.rememberExpansionSelection(
      snapshot,
      [requestedKey, expansionSelectionKey(canonical)],
      resolved,
    );
  }

  const selected = resolved.entries;
  const canonicalSelection = resolved.canonical;
  const anchorIndex = resolved.anchorIndex;
  const finalState = snapshot;
  const finalLineage = { fingerprint: snapshot.lineageFingerprint };
  if (entryOffset > selected.length) {
    return {
      session: ref.file,
      error: addressError(`Entry offset ${entryOffset} is outside 0..${selected.length}.`, selected.length),
      entries: [],
    };
  }
  if (entryOffset < selected.length && textOffset > selected[entryOffset]!.text.length) {
    return {
      session: ref.file,
      error: {
        code: "text_offset_out_of_bounds",
        message: `Text offset ${textOffset} exceeds entry #${selected[entryOffset]!.index} length ${selected[entryOffset]!.text.length}.`,
        textLength: selected[entryOffset]!.text.length,
      },
      entries: [],
    };
  }

  const bounded = (value: string | null, maximum = 512): string | null =>
    value === null || value.length <= maximum
      ? value
      : `${value.slice(0, Math.max(1, maximum - 1))}…`;
  const compactStructure = (value: unknown): unknown => {
    if (value === undefined) return undefined;
    const serialized = JSON.stringify(value);
    return serialized.length <= 2_000 ? value : undefined;
  };
  const output: Array<Record<string, unknown>> = [];
  const cursors: Array<{ position: number; textOffset: number }> = [];
  let position = entryOffset;
  let currentTextOffset = textOffset;
  let remainingChars = maxChars;
  while (position < selected.length && output.length < maxEntries && remainingChars > 0) {
    const entry = selected[position]!;
    let end = Math.min(entry.text.length, currentTextOffset + remainingChars);
    if (
      end < entry.text.length &&
      end > currentTextOffset &&
      entry.text.charCodeAt(end) >= 0xdc00 &&
      entry.text.charCodeAt(end) <= 0xdfff
    ) {
      end -= 1;
    }
    if (end === currentTextOffset && currentTextOffset < entry.text.length) {
      end = Math.min(entry.text.length, currentTextOffset + 2);
    }
    const chunk = entry.text.slice(currentTextOffset, end);
    const textComplete = end >= entry.text.length;
    const operation = compactStructure(entry.operation);
    const branchFact = compactStructure(entry.branchFact);
    output.push({
      index: entry.index,
      entryId: bounded(entry.entryId),
      parentId: bounded(entry.parentId),
      type: bounded(entry.type),
      role: bounded(entry.role),
      timestamp: entry.timestamp,
      isError: entry.isError,
      ...(anchorIndex !== null ? { anchor: entry.index === anchorIndex } : {}),
      text: chunk,
      textRange: {
        start: currentTextOffset,
        end,
        total: entry.text.length,
        complete: textComplete,
      },
      ...(entry.parentEntryId !== undefined ? { parentEntryId: bounded(entry.parentEntryId) } : {}),
      ...(entry.operationAddress ? { operationAddress: bounded(entry.operationAddress) } : {}),
      ...(entry.toolName ? { tool: bounded(entry.toolName) } : {}),
      ...(entry.ref ? { ref: bounded(entry.ref) } : {}),
      ...(entry.provider ? { provider: bounded(entry.provider) } : {}),
      ...(entry.action ? { action: bounded(entry.action) } : {}),
      ...(entry.outcome ? { outcome: entry.outcome } : {}),
      ...(entry.filesTouched
        ? { filesTouched: entry.filesTouched.slice(0, 20).map((file) => bounded(file, 1_024)) }
        : {}),
      ...(operation !== undefined ? { operation } : {}),
      ...(branchFact !== undefined ? { branchFact } : {}),
      ...((entry.operation !== undefined && operation === undefined) ||
          (entry.branchFact !== undefined && branchFact === undefined)
        ? { structuredTruncated: true }
        : {}),
      ...(entry.factAddress ? { factAddress: bounded(entry.factAddress) } : {}),
      ...(entry.carrierEntryId ? { carrierEntryId: bounded(entry.carrierEntryId) } : {}),
      ...(entry.carrierParentId !== undefined ? { carrierParentId: bounded(entry.carrierParentId) } : {}),
      ...(entry.carrierFromId !== undefined ? { carrierFromId: bounded(entry.carrierFromId) } : {}),
    });
    remainingChars -= chunk.length;
    if (!textComplete) {
      currentTextOffset = end;
      cursors.push({ position, textOffset: currentTextOffset });
      break;
    }
    position += 1;
    currentTextOffset = 0;
    cursors.push({ position, textOffset: 0 });
  }

  const responseAt = (
    records: Array<Record<string, unknown>>,
    cursor: { position: number; textOffset: number },
  ): Record<string, unknown> => {
    const hasNext = cursor.position < selected.length;
    const nextArgs = hasNext
      ? {
          ...(sourceId ? { source: sourceId } : {}),
          session: ref.file,
          expectedSourceHash: finalState.sourceHash,
          expectedLineageFingerprint: finalLineage.fingerprint,
          branches,
          ...canonicalSelection,
          entryOffset: cursor.position,
          ...(cursor.textOffset > 0 ? { textOffset: cursor.textOffset } : {}),
          maxChars,
          maxEntries,
        }
      : null;
    return {
      session: ref.file,
      sourceHash: finalState.sourceHash,
      branches,
      lineageFingerprint: finalLineage.fingerprint,
      entryCount,
      entries: records,
      next: nextArgs ? { ref: "memory.expand", args: nextArgs } : null,
    };
  };

  let cursor = { position, textOffset: currentTextOffset };
  let response = responseAt(output, cursor);
  while (output.length > 1 && JSON.stringify(response).length > RECALL_MAX_RESPONSE_CHARS) {
    output.pop();
    cursors.pop();
    cursor = cursors.at(-1) ?? { position: entryOffset, textOffset };
    response = responseAt(output, cursor);
  }
  if (output.length === 1 && JSON.stringify(response).length > RECALL_MAX_RESPONSE_CHARS) {
    const record = output[0]!;
    const range = record.textRange as { start: number; end: number; total: number; complete: boolean };
    const chunk = record.text as string;
    const excess = JSON.stringify(response).length - RECALL_MAX_RESPONSE_CHARS;
    let keep = Math.max(1, chunk.length - excess - 256);
    if (
      keep < chunk.length &&
      keep > 0 &&
      chunk.charCodeAt(keep) >= 0xdc00 &&
      chunk.charCodeAt(keep) <= 0xdfff
    ) {
      keep -= 1;
    }
    if (keep > 0 && keep < chunk.length) {
      record.text = chunk.slice(0, keep);
      range.end = range.start + keep;
      range.complete = false;
      cursor = { position: entryOffset, textOffset: range.end };
      response = responseAt(output, cursor);
    }
    if (JSON.stringify(response).length > RECALL_MAX_RESPONSE_CHARS) {
      delete record.operation;
      delete record.branchFact;
      if (Array.isArray(record.filesTouched)) {
        record.filesTouched = record.filesTouched.slice(0, 4).map((file) => bounded(String(file), 256));
      }
      record.structuredTruncated = true;
      response = responseAt(output, cursor);
    }
    if (JSON.stringify(response).length > RECALL_MAX_RESPONSE_CHARS) {
      const current = String(record.text);
      const firstCodePointChars = (current.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
      const minimalText = current.slice(0, Math.min(current.length, firstCodePointChars));
      const minimalRange = record.textRange as { start: number; end: number; total: number; complete: boolean };
      minimalRange.end = minimalRange.start + minimalText.length;
      minimalRange.complete = minimalRange.end >= minimalRange.total;
      output[0] = {
        index: record.index,
        entryId: record.entryId,
        parentId: record.parentId,
        type: record.type,
        role: record.role,
        timestamp: record.timestamp,
        isError: record.isError,
        ...(record.anchor !== undefined ? { anchor: record.anchor } : {}),
        text: minimalText,
        textRange: minimalRange,
        structuredTruncated: true,
      };
      cursor = minimalRange.complete
        ? { position: entryOffset + 1, textOffset: 0 }
        : { position: entryOffset, textOffset: minimalRange.end };
      response = responseAt(output, cursor);
    }
  }

  if (!acceptsExpansionPage(output, selected, entryOffset, textOffset, cursor)) {
    cache.forgetExpansionSnapshot(snapshot);
    return { session: ref.file, entries: [], error: { code: "invalid_expansion", message: "Expansion failed source-bound chunk verification" } };
  }

  const endingObservation = access.observe(branches);
  if (!endingObservation || !sameSourceObservation(snapshot.observation, endingObservation)) {
    cache.forgetExpansionSnapshot(snapshot);
    const actualState = access.state();
    const actualLineage = access.lineage(branches);
    if (
      !actualState ||
      !endingObservation ||
      !pointerCurrent(actualState.sourceHash === snapshot.sourceHash, actualLineage.fingerprint === snapshot.lineageFingerprint)
    ) {
      return {
        session: ref.file,
        error: stalePointerError(
          ref.file,
          expectedSourceHash ?? snapshot.sourceHash,
          actualState?.sourceHash ?? "",
          expectedLineageFingerprint ?? snapshot.lineageFingerprint,
          actualLineage.fingerprint,
        ),
        entries: [],
      };
    }
    snapshot.observation = endingObservation;
  }
  if (response.next === null) {
    cache.forgetExpansionSnapshot(snapshot);
  } else {
    snapshot.touchedAt = Date.now();
    cache.rememberExpansionSnapshot(snapshot);
  }
  return response;
}
