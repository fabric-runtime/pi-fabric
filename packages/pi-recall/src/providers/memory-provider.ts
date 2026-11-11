import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";
import { AmbiguousSessionError } from "../memory/discovery.js";
import {
  RECALL_DEFAULT_PAGE_SIZE,
  RECALL_DEFAULT_SNIPPET_CHARS,
  RECALL_MAX_PAGE_SIZE,
  RECALL_MAX_SNIPPET_CHARS,
} from "../memory/context.js";
import {
  EXPAND_DEFAULT_MAX_CHARS,
  EXPAND_MAX_CHARS,
  EXPAND_DEFAULT_MAX_ENTRIES,
  EXPAND_MAX_ENTRIES,
  EXPAND_MAX_CONTEXT,
  EXPAND_MAX_EXACT_SELECTORS,
} from "../memory/request-limits.js";
import { recallFailure, type MemoryProviderContext } from "../memory/request-context.js";
import { MemoryRequestCache } from "../memory/request-cache.js";
import { processMemoryRecall } from "../memory/recall-service.js";
import { processMemoryExpand } from "../memory/expand-service.js";
import { processMemorySessions } from "../memory/sessions-service.js";
import { actionArgNormalizer, type ArgNormalizationSpec } from "./arg-normalization.js";

const errorOutputSchema = {
  type: "object",
  properties: {
    code: { type: "string" },
    message: { type: "string" },
  },
  required: ["code", "message"],
};

const coverageOutputSchema = {
  type: "object",
  properties: {
    complete: { type: "boolean" },
    indexedSessions: { type: "number" },
    eligibleSessions: { type: "number" },
    staleSessions: { type: "number" },
    incompleteSessions: { type: "number" },
    reasons: {
      type: "array",
      items: { type: "string" },
      description: "Stable machine-readable incompleteness codes; empty when complete is true.",
    },
    error: errorOutputSchema,
  },
  required: [
    "complete",
    "indexedSessions",
    "eligibleSessions",
    "staleSessions",
    "incompleteSessions",
    "reasons",
  ],
};

const callOutputSchema = (ref: "memory.recall" | "memory.expand") => ({
  type: "object",
  properties: {
    ref: { const: ref },
    args: { type: "object" },
  },
  required: ["ref", "args"],
});

const recallEntryOutputSchema = {
  type: "object",
  properties: {
    kind: { const: "entry" },
    sessionId: { type: "string" },
    tier: { type: "string", enum: ["hot", "cold"] },
    index: { type: "number" },
    entryId: { type: ["string", "null"] },
    parentId: { type: ["string", "null"] },
    operationAddress: { type: ["string", "null"] },
    type: { type: "string" },
    role: { type: ["string", "null"] },
    tool: { type: ["string", "null"] },
    ref: { type: ["string", "null"] },
    provider: { type: ["string", "null"] },
    action: { type: ["string", "null"] },
    timestamp: { type: ["number", "null"] },
    isError: { type: "boolean" },
    outcome: { type: "string", enum: ["succeeded", "failed", "aborted", "timed_out"] },
    score: { type: "number" },
    snippet: { type: "string" },
    truncated: { type: "boolean" },
    follow: callOutputSchema("memory.expand"),
  },
  required: [
    "kind",
    "sessionId",
    "tier",
    "index",
    "entryId",
    "parentId",
    "operationAddress",
    "type",
    "role",
    "tool",
    "ref",
    "provider",
    "action",
    "timestamp",
    "isError",
    "score",
    "snippet",
    "truncated",
    "follow",
  ],
};

const recallSessionOutputSchema = {
  type: "object",
  properties: {
    kind: { const: "session" },
    sessionId: { type: "string" },
    tier: { const: "cold" },
    cwd: { type: "string" },
    lastTimestamp: { type: ["number", "null"] },
    score: { type: "number" },
    matchedTerms: { type: "number" },
    matchedStructuralEntries: { type: "number" },
    follow: callOutputSchema("memory.recall"),
  },
  required: [
    "kind",
    "sessionId",
    "tier",
    "cwd",
    "lastTimestamp",
    "score",
    "matchedTerms",
    "matchedStructuralEntries",
    "follow",
  ],
};

const recallOutputSchema: Record<string, unknown> = {
  type: "object",
  description: "Bounded ranked memory hits with uniform follow and pagination calls.",
  properties: {
    total: { type: "number" },
    hits: {
      type: "array",
      description: "Call tools.call(hit.follow) to expand an entry or resolve a cold session.",
      items: { oneOf: [recallEntryOutputSchema, recallSessionOutputSchema] },
    },
    next: {
      oneOf: [callOutputSchema("memory.recall"), { type: "null" }],
      description: "When non-null, call tools.call(next).",
    },
    coverage: coverageOutputSchema,
    error: errorOutputSchema,
  },
  required: ["total", "hits", "next", "coverage"],
};

const expandOutputSchema: Record<string, unknown> = {
  type: "object",
  description: "Integrity-bound session entries returned as lossless bounded text chunks.",
  properties: {
    session: { type: "string" },
    sourceHash: { type: "string" },
    branches: { type: "string", enum: ["active", "all"] },
    lineageFingerprint: { type: "string" },
    entryCount: { type: "number" },
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "number" },
          entryId: { type: ["string", "null"] },
          parentId: { type: ["string", "null"] },
          type: { type: ["string", "null"] },
          role: { type: ["string", "null"] },
          timestamp: { type: ["number", "null"] },
          isError: { type: "boolean" },
          text: { type: "string" },
          textRange: {
            type: "object",
            properties: {
              start: { type: "number" },
              end: { type: "number" },
              total: { type: "number" },
              complete: { type: "boolean" },
            },
            required: ["start", "end", "total", "complete"],
          },
          anchor: { type: "boolean" },
          parentEntryId: { type: ["string", "null"] },
          operationAddress: { type: ["string", "null"] },
          tool: { type: ["string", "null"] },
          ref: { type: ["string", "null"] },
          provider: { type: ["string", "null"] },
          action: { type: ["string", "null"] },
          outcome: { type: "string", enum: ["succeeded", "failed", "aborted", "timed_out"] },
          filesTouched: { type: "array", items: { type: ["string", "null"] } },
          operation: { type: "object" },
          branchFact: { type: "object" },
          structuredTruncated: { type: "boolean" },
          factAddress: { type: ["string", "null"] },
          carrierEntryId: { type: ["string", "null"] },
          carrierParentId: { type: ["string", "null"] },
          carrierFromId: { type: ["string", "null"] },
        },
        required: ["index", "entryId", "parentId", "type", "role", "timestamp", "isError", "text", "textRange"],
      },
    },
    next: {
      oneOf: [callOutputSchema("memory.expand"), { type: "null" }],
      description: "When non-null, call tools.call(next).",
    },
    error: errorOutputSchema,
  },
  required: ["entries"],
};

const sessionsOutputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    scope: { type: "string" },
    branches: { type: "string", enum: ["active", "all"] },
    sessions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          file: { type: "string" },
          cwd: { type: "string" },
          mtime: { type: "number" },
          entryCount: { type: "number" },
          tier: { type: "string", enum: ["hot", "cold"] },
          branches: { type: "string", enum: ["active", "all"] },
          lineageFingerprint: { type: ["string", "null"] },
        },
        required: [
          "id",
          "file",
          "cwd",
          "mtime",
          "entryCount",
          "tier",
          "branches",
          "lineageFingerprint",
        ],
      },
    },
    error: errorOutputSchema,
  },
};

const SOURCE_ARG_SCHEMA = {
  type: "string",
  minLength: 1,
  description:
    "Registered portable memory source id. When set, the call resolves against that source only — filesystem scopes are never consulted and there is no filesystem fallback.",
} as const;

export const memoryActionDescriptors: FabricActionDescriptor[] = [
  {
    name: "recall",
    description:
      "Search session memory as bounded ranked snippets. Literal queries rank any matching term by default; queryMatch all narrows to co-located terms. Call tools.call(hit.follow) for either an exact entry or a cold-session candidate, and tools.call(next) to continue.",
    inputSchema: {
      type: "object",
      properties: {
        source: SOURCE_ARG_SCHEMA,
        query: { type: "string", maxLength: 4096 },
        queryMode: {
          type: "string",
          enum: ["literal", "phrase", "regex"],
          default: "literal",
          description: "Canonical tokens (default), one case-insensitive exact phrase, or explicitly bounded regex.",
        },
        queryMatch: {
          type: "string",
          enum: ["all", "any"],
          default: "any",
          description: "For literal mode, accept any term (default) or require all terms in one hot entry.",
        },
        expectedSourceHash: {
          type: "string",
          description: "SHA-256 from a prior pointer; stale sources are refused.",
        },
        expectedLineageFingerprint: {
          type: "string",
          description: "Active-lineage fingerprint from a prior pointer; changed leaves are refused.",
        },
        branches: {
          type: "string",
          enum: ["active", "all"],
          description: "Search the active parent-linked path (default) or every branch.",
        },
        scope: {
          type: "string",
          description:
            "session | project | global | session:<id-or-path>. Defaults to session.",
        },
        offset: {
          type: "number",
          minimum: 0,
          description: "Exact ranked-hit offset, normally copied from next.args.",
        },
        pageSize: { type: "number", minimum: 1, maximum: RECALL_MAX_PAGE_SIZE, default: RECALL_DEFAULT_PAGE_SIZE },
        snippetChars: {
          type: "number",
          minimum: 80,
          maximum: RECALL_MAX_SNIPPET_CHARS,
          default: RECALL_DEFAULT_SNIPPET_CHARS,
          description: "Maximum indexed-text characters shown per hit; full text remains in memory.expand.",
        },
        role: {
          type: "string",
          enum: [
            "assistant",
            "bashExecution",
            "branchCustomMessage",
            "branchSummary",
            "branchUser",
            "compaction",
            "compactionSummary",
            "custom",
            "fabricOperation",
            "fabricPhase",
            "fabricRun",
            "toolResult",
            "user",
          ],
          description:
            "Exact normalized entry role to filter by: the closed set the session normalizer can produce.",
        },
        tool: { type: "string" },
        ref: {
          type: "string",
          minLength: 1,
          description: "Exact persisted Fabric action ref, such as pi.grep. This is structural selection, not lexical expansion.",
        },
        provider: {
          type: "string",
          minLength: 1,
          description: "Exact persisted Fabric provider identity.",
        },
        action: {
          type: "string",
          minLength: 1,
          description: "Exact persisted Fabric action name.",
        },
        outcome: {
          type: "string",
          enum: ["succeeded", "failed", "aborted", "timed_out"],
          description: "Exact persisted Fabric execution outcome.",
        },
        since: { type: "number" },
        until: { type: "number" },
        entryRange: {
          type: "object",
          description:
            "Inclusive normalized-entry range for an explicit session:<id> resolution.",
          properties: {
            first: { type: "number", minimum: 0 },
            last: { type: "number", minimum: 0 },
          },
          required: ["first", "last"],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    outputSchema: recallOutputSchema,
    risk: "read",
    namespace: "memory",
  },
  {
    name: "expand",
    description:
      "Read exact normalized session entries and nearby context as bounded lossless chunks. Call tools.call(next) to continue, or use guest-side memory.walk(args, visitor) to traverse complete reassembled entries.",
    inputSchema: {
      type: "object",
      properties: {
        source: SOURCE_ARG_SCHEMA,
        session: { type: "string", description: "Exact session file path, unambiguous id, or source session key." },
        expectedSourceHash: {
          type: "string",
          description: "SHA-256 from a prior pointer; stale sources are refused.",
        },
        expectedLineageFingerprint: {
          type: "string",
          description: "Active-lineage fingerprint from a prior pointer; changed leaves are refused.",
        },
        branches: {
          type: "string",
          enum: ["active", "all"],
          description: "Expand on the active parent-linked path (default) or across every branch.",
        },
        indices: { type: "array", maxItems: EXPAND_MAX_EXACT_SELECTORS, items: { type: "number", minimum: 0 } },
        entryIds: { type: "array", maxItems: EXPAND_MAX_EXACT_SELECTORS, items: { type: "string", maxLength: 512 } },
        operationAddresses: { type: "array", maxItems: EXPAND_MAX_EXACT_SELECTORS, items: { type: "string", maxLength: 512 } },
        entryRange: {
          type: "object",
          properties: {
            first: { type: "number", minimum: 0 },
            last: { type: "number", minimum: 0 },
          },
          required: ["first", "last"],
          additionalProperties: false,
        },
        before: {
          type: "number",
          minimum: 0,
          maximum: EXPAND_MAX_CONTEXT,
          default: 0,
          description: "Entries before one exact selected anchor.",
        },
        after: {
          type: "number",
          minimum: 0,
          maximum: EXPAND_MAX_CONTEXT,
          default: 0,
          description: "Entries after one exact selected anchor.",
        },
        entryOffset: {
          type: "number",
          minimum: 0,
          description: "Continuation offset within the resolved selection; copy from next.args.",
        },
        textOffset: {
          type: "number",
          minimum: 0,
          description: "Continuation offset within the first returned entry; copy from next.args.",
        },
        maxChars: {
          type: "number",
          minimum: 256,
          maximum: EXPAND_MAX_CHARS,
          default: EXPAND_DEFAULT_MAX_CHARS,
          description: "Total entry-text characters returned in this chunk.",
        },
        maxEntries: {
          type: "number",
          minimum: 1,
          maximum: EXPAND_MAX_ENTRIES,
          default: EXPAND_DEFAULT_MAX_ENTRIES,
          description: "Maximum complete or partial entries returned in this chunk.",
        },
      },
      required: ["session"],
      additionalProperties: false,
    },
    outputSchema: expandOutputSchema,
    risk: "read",
    namespace: "memory",
  },
  {
    name: "sessions",
    description: "List known sessions in scope with id, file, cwd, mtime, entry count, and hot/cold tier.",
    inputSchema: {
      type: "object",
      properties: {
        source: SOURCE_ARG_SCHEMA,
        scope: { type: "string" },
        branches: {
          type: "string",
          enum: ["active", "all"],
          description: "Count the active parent-linked path (default) or every branch.",
        },
        limit: {
          type: "number",
          minimum: 1,
          description: "Maximum sessions returned; capped at the internal session ceiling.",
        },
      },
      additionalProperties: false,
    },
    outputSchema: sessionsOutputSchema,
    risk: "read",
    namespace: "memory",
  },
];

const descriptors = memoryActionDescriptors;

// Value spellings models reliably substitute for the documented memory scopes,
// e.g. scope "cwd" for "project". Same discipline as the key aliases below:
// identical intent only. Unknown scopes still fall through to resolveScope's
// default "session" handling.
const MEMORY_SCOPE_VALUE_ALIASES: Record<string, string> = {
  cwd: "project",
  repo: "project",
  directory: "project",
  folder: "project",
  all: "global",
  current: "session",
};

const MEMORY_ARG_NORMALIZATION: Record<string, ArgNormalizationSpec> = {
  recall: { values: { scope: MEMORY_SCOPE_VALUE_ALIASES } },
  sessions: { values: { scope: MEMORY_SCOPE_VALUE_ALIASES } },
};

// Argument repair derives from the action schemas plus the shared synonym
// lexicon; only scope value spellings stay table-bound because the schema
// spells scope as a free string rather than an enum.
export const normalizeMemoryArgs = actionArgNormalizer(
  () => descriptors,
  MEMORY_ARG_NORMALIZATION,
);

export type { MemoryProviderContext } from "../memory/request-context.js";

/** Lightweight recall/expand/sessions action schemas for managed proxies. */
export const memoryActionSchemas: {
  recall: { inputSchema: object; outputSchema: object };
  expand: { inputSchema: object; outputSchema: object };
  sessions: { inputSchema: object; outputSchema: object };
} = Object.fromEntries(
  descriptors.map((descriptor) => [
    descriptor.name,
    { inputSchema: descriptor.inputSchema, outputSchema: descriptor.outputSchema },
  ]),
) as {
  recall: { inputSchema: object; outputSchema: object };
  expand: { inputSchema: object; outputSchema: object };
  sessions: { inputSchema: object; outputSchema: object };
};

export class MemoryProvider implements FabricProvider {
  readonly name = "memory";
  readonly description =
    "Cross-session memory: a search engine over every Pi session timeline on this machine";

  private readonly cache = new MemoryRequestCache();

  constructor(private readonly context: MemoryProviderContext) {}

  async list(
    request: FabricProviderListRequest,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    return query
      ? descriptors.filter((descriptor) =>
          `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query),
        )
      : descriptors;
  }

  async describe(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    return descriptors.find((descriptor) => descriptor.name === actionName);
  }

  prepareArguments(
    actionName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    return normalizeMemoryArgs(actionName, args);
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    invocationContext: FabricInvocationContext,
  ): Promise<unknown> {
    const context = invocationContext.scope
      ? { ...this.context, fabricScope: invocationContext.scope }
      : this.context;
    try {
      switch (actionName) {
        case "recall":
          return await processMemoryRecall(args, invocationContext, context, this.cache);
        case "expand":
          return await processMemoryExpand(args, context, this.cache, invocationContext.signal);
        case "sessions":
          return await processMemorySessions(args, context, invocationContext.signal);
        default:
          throw new Error(`Unknown memory action: ${actionName}`);
      }
    } catch (error) {
      if (error instanceof AmbiguousSessionError) {
        const detail = {
          code: error.code,
          message: error.message,
          session: error.session,
          candidates: error.candidates,
        };
        if (actionName === "recall") return recallFailure(detail);
        if (actionName === "expand") return { entries: [], next: null, error: detail };
        return { error: detail };
      }
      throw error;
    }
  }

}
