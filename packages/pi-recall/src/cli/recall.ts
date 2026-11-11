// `pi-recall recall` — ported from the fork's src/external/recall.ts so the
// standalone tier and the bridge tier print identical bytes. Parsing and
// invocation live here; the flag layer (positional query, --scope …) lives in
// bin/pi-recall.
import type { MemoryProviderContext } from "../memory/request-context.js";
import type { MemoryRequestCache } from "../memory/request-cache.js";
import { normalizeMemoryArgs } from "../providers/memory-provider.js";

export const RECALL_ARGV_HELP = [
  "recall arguments (key=value lines after the command):",
  "  query=<terms>               required; literal terms by default",
  "  scope=<scope>               session | project | global | session:<id-or-path>",
  "  queryMode=<mode>            literal (default) | phrase | regex",
  "  queryMatch=<match>          any (default) | all",
  "  branches=<branches>         active (default) | all",
  "  pageSize=<n> / offset=<n>   paging",
  "  role=<role>                 filter by entry role",
].join("\n");

const STRING_ARGUMENTS = new Set([
  "query",
  "scope",
  "queryMode",
  "queryMatch",
  "branches",
  "role",
  "source",
  "expectedSourceHash",
  "expectedLineageFingerprint",
]);
const NUMBER_ARGUMENTS = new Set(["pageSize", "offset"]);

export const parseRecallArgv = (lines: readonly string[]): Record<string, unknown> => {
  const args: Record<string, unknown> = {};
  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error(`malformed recall argument (expected key=value): ${line}\n${RECALL_ARGV_HELP}`);
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (STRING_ARGUMENTS.has(key)) {
      if (value === "") throw new Error(`recall ${key}= is empty`);
      args[key] = value;
    } else if (NUMBER_ARGUMENTS.has(key)) {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`recall ${key} must be a non-negative integer, got: ${value}`);
      }
      args[key] = parsed;
    } else {
      throw new Error(`unknown recall argument: ${key}\n${RECALL_ARGV_HELP}`);
    }
  }
  if (typeof args.query !== "string") {
    throw new Error(`recall needs a query=<terms> line\n${RECALL_ARGV_HELP}`);
  }
  return args;
};

export const RECALL_TIMEOUT_MS = 30_000;

// One cache per CLI process; the engine keeps per-provider caches.
let defaultCache: MemoryRequestCache | undefined;
const recallCache = async (): Promise<MemoryRequestCache> => {
  if (defaultCache === undefined) {
    const module = await import("../memory/request-cache.js");
    defaultCache = new module.MemoryRequestCache();
  }
  return defaultCache;
};

export const runRecall = async (
  rawArgs: Record<string, unknown>,
  context: MemoryProviderContext,
  cache?: MemoryRequestCache,
): Promise<unknown> => {
  const { processMemoryRecall } = await import("../memory/recall-service.js");
  const args = normalizeMemoryArgs("recall", rawArgs);
  return await processMemoryRecall(
    args,
    {
      update: () => undefined,
      signal: AbortSignal.timeout(RECALL_TIMEOUT_MS),
    },
    context,
    cache ?? (await recallCache()),
  );
};

const isoTimestamp = (value: unknown): string =>
  typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : "-";

const scoreText = (value: unknown): string =>
  typeof value === "number" && Number.isFinite(value)
    ? String(Math.round(value * 100) / 100)
    : "-";

const snippetLine = (text: unknown, truncated: unknown): string => {
  const flat = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  return `  ${flat}${truncated === true ? " …" : ""}`;
};

const renderEntryHit = (hit: Record<string, unknown>): string[] => {
  const parts = ["entry", `ts=${isoTimestamp(hit.timestamp)}`, `sid=${hit.sessionId ?? "-"}`];
  if (hit.tier) parts.push(`tier=${hit.tier}`);
  if (typeof hit.index === "number") parts.push(`idx=${hit.index}`);
  if (hit.type) parts.push(`type=${hit.type}`);
  if (hit.role) parts.push(`role=${hit.role}`);
  if (hit.tool) parts.push(`tool=${hit.tool}`);
  if (hit.isError === true) parts.push("err");
  parts.push(`score=${scoreText(hit.score)}`);
  if (typeof hit.entryId === "string") parts.push(`id=${hit.entryId}`);
  return [parts.join(" "), snippetLine(hit.snippet, hit.truncated)];
};

const renderSessionHit = (hit: Record<string, unknown>): string[] => {
  const parts = ["session", `sid=${hit.sessionId ?? "-"}`, `ts=${isoTimestamp(hit.lastTimestamp)}`];
  if (typeof hit.cwd === "string") parts.push(`cwd=${hit.cwd}`);
  parts.push(`score=${scoreText(hit.score)}`);
  if (typeof hit.matchedTerms === "number") parts.push(`terms=${hit.matchedTerms}`);
  if (typeof hit.matchedStructuralEntries === "number") {
    parts.push(`structural=${hit.matchedStructuralEntries}`);
  }
  return [parts.join(" ")];
};

export const renderRecall = (response: unknown): { ok: boolean; lines: string[] } => {
  if (typeof response !== "object" || response === null) {
    return { ok: false, lines: ["recall returned a malformed payload"] };
  }
  const view = response as {
    total?: unknown;
    hits?: unknown;
    next?: { args?: { offset?: unknown } } | null;
    coverage?: Record<string, unknown> & { reasons?: unknown };
    error?: { code?: unknown; message?: unknown };
  };
  if (view.error) {
    const code = typeof view.error.code === "string" ? view.error.code : "error";
    const message = typeof view.error.message === "string" ? view.error.message : "";
    return { ok: false, lines: [`recall failed (${code}): ${message}`] };
  }
  const coverage =
    typeof view.coverage === "object" && view.coverage !== null ? view.coverage : {};
  const coverageParts = [
    `total=${typeof view.total === "number" ? view.total : 0}`,
    `indexed=${coverage.indexedSessions ?? "-"}`,
    `eligible=${coverage.eligibleSessions ?? "-"}`,
  ];
  if (coverage.staleSessions) coverageParts.push(`stale=${coverage.staleSessions}`);
  if (coverage.incompleteSessions) coverageParts.push(`incomplete=${coverage.incompleteSessions}`);
  if (
    coverage.complete === false &&
    Array.isArray(coverage.reasons) &&
    coverage.reasons.length > 0
  ) {
    coverageParts.push(`reasons=${coverage.reasons.join(",")}`);
  }
  const lines: string[] = [coverageParts.join(" ")];
  const hits = Array.isArray(view.hits) ? view.hits : [];
  hits.forEach((hit, position) => {
    const record = typeof hit === "object" && hit !== null ? (hit as Record<string, unknown>) : {};
    const rendered =
      record.kind === "session" ? renderSessionHit(record) : renderEntryHit(record);
    rendered.forEach((line, index) => lines.push(index === 0 ? `[${position + 1}] ${line}` : line));
  });
  if (view.next && typeof view.next === "object") {
    const offset = view.next.args?.offset;
    if (typeof offset === "number") lines.push(`next offset=${offset}`);
  }
  return { ok: true, lines };
};
