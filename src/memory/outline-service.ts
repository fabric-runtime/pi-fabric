import { pointerCurrent } from "../verified/policy.js";
import {
  fileExpansionAccess,
  hostExpansionAccess,
  memorySourceFailure,
  type ExpansionAccess,
} from "./host-source.js";
import { OUTLINE_MAX_ENTRIES, OUTLINE_PREVIEW_CHARS } from "./request-limits.js";
import {
  parseBranches,
  parseRoleFilter,
  stalePointerError,
  type MemoryProviderContext,
} from "./request-context.js";
import { sameSourceObservation } from "./source-observation.js";
import type { ExpansionRequestCache } from "./request-cache.js";
import type { NormalizedEntry } from "./normalize.js";

/** One skeleton row of the session outline: the addressable position, the
 *  entry shape, a bounded one-line preview, and the rendered size that
 *  memory.expand will return for that entry. */
export interface MemoryOutlineRow {
  index: number;
  type: string;
  role?: string;
  tool?: string;
  preview: string;
  size: number;
}

const outlinePreview = (text: string): string => {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed.length <= OUTLINE_PREVIEW_CHARS) return collapsed;
  // Reserve one cell for the ellipsis and never split a surrogate pair.
  let end = OUTLINE_PREVIEW_CHARS - 1;
  const boundary = collapsed.charCodeAt(end - 1);
  if (boundary >= 0xd800 && boundary <= 0xdbff) end -= 1;
  return `${collapsed.slice(0, end)}…`;
};

const outlineRow = (entry: NormalizedEntry): MemoryOutlineRow => ({
  index: entry.index,
  type: entry.type,
  ...(entry.role !== null ? { role: entry.role } : {}),
  ...(entry.toolName !== null ? { tool: entry.toolName } : {}),
  preview: outlinePreview(entry.text),
  size: entry.text.length,
});

/** Resolve one session exactly like memory.expand and return its ordered
 *  entry skeleton: one bounded row per normalized entry, optionally filtered
 *  by exact role. Deterministic — no scores, no ranking, no continuation. */
export async function processMemoryOutline(
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
  const branches = parseBranches(args.branches, "memory.outline");
  const role = parseRoleFilter(args.role, "memory.outline");
  const maxEntries = typeof args.maxEntries === "number" &&
      Number.isSafeInteger(args.maxEntries) && args.maxEntries >= 1
    ? Math.min(args.maxEntries, OUTLINE_MAX_ENTRIES)
    : OUTLINE_MAX_ENTRIES;
  if (!session) throw new Error("memory.outline requires a session");

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

  const all = snapshot.entries;
  const filtered = role === undefined ? all : all.filter((entry) => entry.role === role);
  const rows = filtered.slice(0, maxEntries).map(outlineRow);
  const response = {
    session: ref.file,
    sourceHash: snapshot.sourceHash,
    branches,
    lineageFingerprint: snapshot.lineageFingerprint,
    entryCount: all.length,
    total: filtered.length,
    truncated: filtered.length > rows.length,
    entries: rows,
  };

  const endingObservation = access.observe(branches);
  cache.forgetExpansionSnapshot(snapshot);
  if (!endingObservation || !sameSourceObservation(snapshot.observation, endingObservation)) {
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
  }
  return response;
}
