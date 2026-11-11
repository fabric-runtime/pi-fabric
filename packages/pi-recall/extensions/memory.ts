/**
 * pi-transcript-recall extension — memory_recall / memory_expand /
 * memory_sessions over the extracted pi-fabric memory module.
 *
 * Semantics mirror the fork's MemoryProvider (src/providers/memory-provider.ts):
 * normalizeMemoryArgs before dispatch, one shared request cache, and the same
 * AmbiguousSessionError response mapping. Differences from the engine wiring
 * are deliberate and standalone-shaped: the agent tree comes from
 * resolveAgentDir (PI_CODING_AGENT_DIR), index writes isolate through
 * PI_RECALL_INDEX_DIR, and there is no live-branch hook (the engine injects
 * unflushed live-session entries; here the session file on disk is the truth).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveAgentDir } from "../src/core/agent-dir.js";
import { resolveMemoryConfig } from "../src/config.js";
import {
  RECALL_DEFAULT_PAGE_SIZE,
  RECALL_MAX_PAGE_SIZE,
  RECALL_MAX_SNIPPET_CHARS,
} from "../src/memory/context.js";
import {
  EXPAND_MAX_CHARS,
  EXPAND_MAX_CONTEXT,
  EXPAND_MAX_ENTRIES,
  EXPAND_MAX_EXACT_SELECTORS,
} from "../src/memory/request-limits.js";
import { MemoryRequestCache } from "../src/memory/request-cache.js";
import { recallFailure, type MemoryProviderContext } from "../src/memory/request-context.js";
import { AmbiguousSessionError } from "../src/memory/discovery.js";
import { processMemoryRecall } from "../src/memory/recall-service.js";
import { processMemoryExpand } from "../src/memory/expand-service.js";
import { processMemorySessions } from "../src/memory/sessions-service.js";
import { normalizeMemoryArgs } from "../src/providers/memory-provider.js";

const SOURCE_PARAM = Type.Optional(
  Type.String({
    minLength: 1,
    description:
      "Registered portable memory source id. When set, the call resolves against that source only — filesystem scopes are never consulted and there is no filesystem fallback.",
  }),
);

const HASH_PARAMS = {
  expectedSourceHash: Type.Optional(
    Type.String({ description: "SHA-256 from a prior pointer; stale sources are refused." }),
  ),
  expectedLineageFingerprint: Type.Optional(
    Type.String({
      description: "Active-lineage fingerprint from a prior pointer; changed leaves are refused.",
    }),
  ),
};

const BRANCHES_PARAM = Type.Optional(
  Type.String({
    enum: ["active", "all"],
    description: "The active parent-linked path (default) or every branch.",
  }),
);

const ENTRY_RANGE_PARAM = Type.Optional(
  Type.Object(
    {
      first: Type.Number({ minimum: 0 }),
      last: Type.Number({ minimum: 0 }),
    },
    {
      description: "Inclusive normalized-entry range for an explicit session:<id> resolution.",
      additionalProperties: false,
    },
  ),
);

// One cache per session, mirroring the engine's per-provider MemoryRequestCache.
const cache = new MemoryRequestCache();

interface SessionManagerLike {
  getSessionId?: () => string | undefined;
  getSessionFile?: () => string | undefined;
}

const buildContext = (sessionManager: SessionManagerLike | undefined): MemoryProviderContext => {
  const context: MemoryProviderContext = {
    agentDir: resolveAgentDir(),
    cwd: process.cwd(),
    config: resolveMemoryConfig(),
  };
  const sessionId = sessionManager?.getSessionId?.();
  const sessionFile = sessionManager?.getSessionFile?.();
  if (sessionId !== undefined) context.sessionId = sessionId;
  if (sessionFile !== undefined) context.sessionFile = sessionFile;
  return context;
};

type ToolUpdate = ((update: { content: unknown[]; details: Record<string, unknown> }) => void) | undefined;

const invocationUpdate = (onUpdate: ToolUpdate) => (message: string): void => {
  onUpdate?.({ content: [{ type: "text", text: message }], details: {} });
};

/** AmbiguousSessionError → structured failure, identical to the provider. */
const dispatchFailure = (action: "recall" | "expand" | "sessions", error: unknown): unknown => {
  if (error instanceof AmbiguousSessionError) {
    const detail = {
      code: error.code,
      message: error.message,
      session: error.session,
      candidates: error.candidates,
    };
    if (action === "recall") return recallFailure(detail);
    if (action === "expand") return { entries: [], next: null, error: detail };
    return { error: detail };
  }
  throw error;
};

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "memory_recall",
    exposure: "deferred",
    label: "Memory recall",
    description:
      "Search session memory as bounded ranked snippets. Literal queries rank any matching term by default; queryMatch all narrows to co-located terms. Use memory_expand with a hit's session+index for full text.",
    parameters: Type.Object({
      source: SOURCE_PARAM,
      query: Type.Optional(Type.String({ maxLength: 4096, description: "Search terms (default literal mode)." })),
      queryMode: Type.Optional(
        Type.String({
          enum: ["literal", "phrase", "regex"],
          description: "Canonical tokens (default), one case-insensitive exact phrase, or explicitly bounded regex.",
        }),
      ),
      queryMatch: Type.Optional(
        Type.String({
          enum: ["all", "any"],
          description: "For literal mode, accept any term (default) or require all terms in one hot entry.",
        }),
      ),
      ...HASH_PARAMS,
      branches: BRANCHES_PARAM,
      scope: Type.Optional(
        Type.String({
          description: "session | project | global | session:<id-or-path>. Defaults to session.",
        }),
      ),
      offset: Type.Optional(Type.Number({ minimum: 0, description: "Exact ranked-hit offset, normally copied from next.args." })),
      pageSize: Type.Optional(Type.Number({ minimum: 1, maximum: RECALL_MAX_PAGE_SIZE, default: RECALL_DEFAULT_PAGE_SIZE })),
      snippetChars: Type.Optional(
        Type.Number({
          minimum: 80,
          maximum: RECALL_MAX_SNIPPET_CHARS,
          description: "Maximum indexed-text characters shown per hit; full text remains in memory_expand.",
        }),
      ),
      role: Type.Optional(
        Type.String({
          description:
            "Exact normalized entry role to filter by: the closed set the session normalizer can produce.",
        }),
      ),
      tool: Type.Optional(Type.String()),
      ref: Type.Optional(
        Type.String({ minLength: 1, description: "Exact persisted action ref; structural selection, not lexical expansion." }),
      ),
      provider: Type.Optional(Type.String({ minLength: 1, description: "Exact persisted provider identity." })),
      action: Type.Optional(Type.String({ minLength: 1, description: "Exact persisted action name." })),
      outcome: Type.Optional(
        Type.String({ enum: ["succeeded", "failed", "aborted", "timed_out"], description: "Exact persisted execution outcome." }),
      ),
      since: Type.Optional(Type.Number()),
      until: Type.Optional(Type.Number()),
      entryRange: ENTRY_RANGE_PARAM,
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const context = buildContext(ctx?.sessionManager as SessionManagerLike | undefined);
      try {
        const response = await processMemoryRecall(
          normalizeMemoryArgs("recall", params as Record<string, unknown>),
          { update: invocationUpdate(onUpdate as ToolUpdate), signal },
          context,
          cache,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
          details: { action: "recall" },
        };
      } catch (error) {
        const response = dispatchFailure("recall", error);
        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
          details: { action: "recall", failed: true },
        };
      }
    },
  });

  pi.registerTool({
    name: "memory_expand",
    exposure: "deferred",
    label: "Memory expand",
    description:
      "Read exact normalized session entries and nearby context as bounded lossless chunks. Copy session+index from a memory_recall hit; continuation offsets come from the returned next args.",
    parameters: Type.Object({
      source: SOURCE_PARAM,
      session: Type.Optional(
        Type.String({ description: "Exact session file path, unambiguous id, or source session key. Defaults to the live session." }),
      ),
      ...HASH_PARAMS,
      branches: BRANCHES_PARAM,
      indices: Type.Optional(Type.Array(Type.Number({ minimum: 0 }), { maxItems: EXPAND_MAX_EXACT_SELECTORS })),
      entryIds: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: EXPAND_MAX_EXACT_SELECTORS })),
      operationAddresses: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: EXPAND_MAX_EXACT_SELECTORS })),
      entryRange: ENTRY_RANGE_PARAM,
      before: Type.Optional(Type.Number({ minimum: 0, maximum: EXPAND_MAX_CONTEXT, description: "Entries before one exact selected anchor." })),
      after: Type.Optional(Type.Number({ minimum: 0, maximum: EXPAND_MAX_CONTEXT, description: "Entries after one exact selected anchor." })),
      entryOffset: Type.Optional(Type.Number({ minimum: 0, description: "Continuation offset within the resolved selection; copy from next.args." })),
      textOffset: Type.Optional(Type.Number({ minimum: 0, description: "Continuation offset within the first returned entry; copy from next.args." })),
      maxChars: Type.Optional(Type.Number({ minimum: 256, maximum: EXPAND_MAX_CHARS, description: "Total entry-text characters returned in this chunk." })),
      maxEntries: Type.Optional(Type.Number({ minimum: 1, maximum: EXPAND_MAX_ENTRIES, description: "Maximum complete or partial entries returned in this chunk." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const sessionManager = ctx?.sessionManager as SessionManagerLike | undefined;
      const context = buildContext(sessionManager);
      let args = normalizeMemoryArgs("expand", params as Record<string, unknown>);
      if (args.session === undefined) {
        // Engine parity: prepareArguments injected the live session for expand.
        const live = sessionManager?.getSessionFile?.();
        if (live !== undefined) args = { ...args, session: live };
      }
      try {
        const response = await processMemoryExpand(args, context, cache, signal);
        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
          details: { action: "expand" },
        };
      } catch (error) {
        const response = dispatchFailure("expand", error);
        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
          details: { action: "expand", failed: true },
        };
      }
    },
  });

  pi.registerTool({
    name: "memory_sessions",
    exposure: "deferred",
    label: "Memory sessions",
    description: "List known sessions in scope with id, file, cwd, mtime, entry count, and hot/cold tier.",
    parameters: Type.Object({
      source: SOURCE_PARAM,
      scope: Type.Optional(Type.String({ description: "session | project | global. Defaults to session." })),
      branches: BRANCHES_PARAM,
      limit: Type.Optional(Type.Number({ minimum: 1, description: "Maximum sessions returned; capped at the internal session ceiling." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const context = buildContext(ctx?.sessionManager as SessionManagerLike | undefined);
      try {
        const response = await processMemorySessions(
          normalizeMemoryArgs("sessions", params as Record<string, unknown>),
          context,
          signal,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
          details: { action: "sessions" },
        };
      } catch (error) {
        const response = dispatchFailure("sessions", error);
        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
          details: { action: "sessions", failed: true },
        };
      }
    },
  });
}
