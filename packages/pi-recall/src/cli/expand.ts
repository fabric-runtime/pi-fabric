// `pi-recall expand` — ported from the fork's src/external/expand.ts so the
// standalone tier and the bridge tier print identical bytes: the sanctioned
// digest→full-entry read for surfaces whose only tools are shell + recall.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MemoryProviderContext } from "../memory/request-context.js";

const EXPAND_ARGV_HELP = [
  "expand arguments (key=value lines after the command):",
  "  session=<path|sid>   session file or session id (default: live session)",
  "  idx=<n[,n...]>       entry indices to expand (required unless id= given)",
  "  id=<8hex>            memory entry id from a recall hit (resolves session+index)",
  "  offset=<n>           entry offset (continuation)",
  "  textOffset=<n>       text offset inside entry (continuation)",
  "  maxChars=<n>         total text budget",
  "  branches=<b>         active | all",
].join("\n");

export interface ExpandCall {
  id?: string;
  session?: string;
  idx: number[];
  offset?: number;
  textOffset?: number;
  maxChars?: number;
  branches?: string;
}

const integerArg = (key: string, value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`expand ${key} must be a non-negative integer, got: ${value}`);
  }
  return parsed;
};

export const parseExpandArgv = (lines: string[]): ExpandCall => {
  const call: ExpandCall = { idx: [] };
  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error(`malformed expand argument (expected key=value): ${line}\n${EXPAND_ARGV_HELP}`);
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (value === "") throw new Error(`expand ${key}= is empty`);
    switch (key) {
      case "id":
        call.id = value;
        break;
      case "session":
        call.session = value;
        break;
      case "idx": {
        const indices = value.split(",").map((part) => integerArg("idx", part.trim()));
        if (indices.length === 0) throw new Error("expand idx= has no indices");
        call.idx = indices;
        break;
      }
      case "offset":
        call.offset = integerArg(key, value);
        break;
      case "textOffset":
        call.textOffset = integerArg(key, value);
        break;
      case "maxChars":
        call.maxChars = integerArg(key, value);
        break;
      case "branches":
        call.branches = value;
        break;
      default:
        throw new Error(`unknown expand argument: ${key}\n${EXPAND_ARGV_HELP}`);
    }
  }
  if (call.id === undefined && call.session === undefined && call.idx.length === 0) {
    throw new Error(`expand needs id=… or session=… idx=…\n${EXPAND_ARGV_HELP}`);
  }
  if (call.id !== undefined && call.session === undefined && call.idx.length > 0) {
    throw new Error("expand id= resolves its own index; drop idx= or use session=");
  }
  return call;
};

export interface MemoryIdMatch {
  sessionId: string;
  sessionFile: string;
  index: number;
  timestamp: number | null;
  /** Session source hash captured at index time; forwarding it as
   * expectedSourceHash lets expand refuse a session that changed since. */
  sourceHash?: string;
}

/** Resolve an 8-hex memory entry id to (session, index) via the memory
 * index store: full indexes (*.jsonl.json, entries[].entryId) and compact
 * digests (*.digest.json, addresses[] tuples). All index files are scanned
 * — stopping at the first hit would hide the same id in another session —
 * and representations of the same entry (shard + digest of one session)
 * are deduplicated. Newest first; ambiguity is surfaced, never guessed. */
export const resolveMemoryId = (
  id: string,
  context: MemoryProviderContext,
): MemoryIdMatch[] => {
  const indexDir = context.config.indexDir ?? join(context.agentDir, "fabric", "memory-index");
  let names: string[] = [];
  try {
    names = readdirSync(indexDir).filter(
      (name) => name.endsWith(".jsonl.json") || name.endsWith(".digest.json"),
    );
  } catch {
    return [];
  }
  const byRecency = names.sort((a, b) => {
    const time = (name: string): number => {
      try {
        return statSync(join(indexDir, name)).mtimeMs;
      } catch {
        return 0;
      }
    };
    return time(b) - time(a);
  });
  const matches: MemoryIdMatch[] = [];
  const seen = new Set<string>();
  const remember = (match: MemoryIdMatch): void => {
    const dedupe = `${match.sessionFile}\0${match.index}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    matches.push(match);
  };
  for (const name of byRecency) {
    let digest: {
      sessionId?: unknown;
      /** Shard files name their session `sessionFile`; digests use `file`. */
      file?: unknown;
      sessionFile?: unknown;
      sourceHash?: unknown;
      addresses?: unknown;
      entries?: unknown;
    };
    try {
      digest = JSON.parse(readFileSync(join(indexDir, name), "utf8")) as typeof digest;
    } catch {
      continue;
    }
    const sourceHash = typeof digest.sourceHash === "string" && digest.sourceHash.length === 64
      ? digest.sourceHash
      : undefined;
    const indexFile = typeof digest.file === "string" ? digest.file
      : typeof digest.sessionFile === "string" ? digest.sessionFile : undefined;
    if (Array.isArray(digest.entries)) {
      for (const entry of digest.entries) {
        if (typeof entry !== "object" || entry === null) continue;
        const record = entry as Record<string, unknown>;
        if (record.entryId !== id) continue;
        const file = typeof record.sessionFile === "string" ? record.sessionFile : indexFile;
        if (typeof file !== "string" || !existsSync(file)) continue;
        remember({
          sessionId: typeof record.sessionId === "string" ? record.sessionId
            : typeof digest.sessionId === "string" ? digest.sessionId : "",
          sessionFile: file,
          index: typeof record.index === "number" ? record.index : -1,
          timestamp: typeof record.timestamp === "number" ? record.timestamp : null,
          // The shard-level hash covers the shard's own session file only.
          ...(file === indexFile && sourceHash !== undefined ? { sourceHash } : {}),
        });
      }
    } else if (Array.isArray(digest.addresses)) {
      for (const address of digest.addresses) {
        if (!Array.isArray(address) || address.length < 2) continue;
        if (address[1] !== id) continue;
        if (indexFile === undefined || !existsSync(indexFile)) continue;
        remember({
          sessionId: typeof digest.sessionId === "string" ? digest.sessionId : "",
          sessionFile: indexFile,
          index: typeof address[0] === "number" ? address[0] : -1,
          timestamp: typeof address[5] === "number" ? address[5] : null,
          ...(sourceHash !== undefined ? { sourceHash } : {}),
        });
      }
    }
  }
  return matches;
};

const resolveSessionFile = (session: string, context: MemoryProviderContext): string => {
  if (existsSync(session)) return session;
  const sessionsRoot = join(context.agentDir, "sessions");
  let found: string | undefined;
  try {
    for (const dir of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const name of readdirSync(join(sessionsRoot, dir.name))) {
        if (name.endsWith(`_${session}.jsonl`)) {
          found = join(sessionsRoot, dir.name, name);
          break;
        }
      }
      if (found !== undefined) break;
    }
  } catch {
    /* fall through */
  }
  if (found === undefined) throw new Error(`expand: no session file matches ${session}`);
  return found;
};

const isoTimestamp = (milliseconds: number | null | undefined): string => {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) return "";
  const iso = new Date(milliseconds).toISOString();
  return iso.replace(/\.\d{3}Z$/, "Z");
};

interface ExpandEntry {
  index: number;
  entryId?: string | null;
  type?: string | null;
  role?: string | null;
  tool?: string | null;
  timestamp?: number | null;
  isError?: boolean;
  text: string;
  textRange?: { start: number; end: number; total: number; complete: boolean };
}

const renderEntry = (entry: ExpandEntry): string[] => {
  const meta = [
    `# entry #${entry.index}`,
    `${entry.type ?? "entry"}`,
    entry.role ?? "",
    entry.entryId ?? "" ? `id=${entry.entryId}` : "",
    entry.tool ?? "" ? `tool=${entry.tool}` : "",
    entry.isError ? "ERROR" : "",
    isoTimestamp(entry.timestamp),
  ]
    .filter((part) => part !== "");
  const lines = [meta.join("  "), entry.text];
  const range = entry.textRange;
  if (range !== undefined && !range.complete) {
    lines.push(
      `# (text ${range.end}/${range.total} — continue with textOffset=${range.end})`,
    );
  }
  return lines;
};

export const runExpandCall = async (
  call: ExpandCall,
  context: MemoryProviderContext,
): Promise<{ ok: boolean; lines: string[] }> => {
  let sessionFile: string | undefined;
  let indices = call.idx;
  let entryId: string | undefined;
  let expectedSourceHash: string | undefined;
  if (call.id !== undefined) {
    const matches = resolveMemoryId(call.id, context);
    if (matches.length === 0) {
      return {
        ok: false,
        lines: [
          `expand: id ${call.id} not found in the memory index (stale digest? run a recall first)`,
        ],
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        lines: [
          `expand: id ${call.id} matches ${matches.length} sessions; disambiguate:`,
          ...matches.map(
            (match) =>
              `  session=${match.sessionFile} idx=${match.index}  (${isoTimestamp(match.timestamp)})`,
          ),
        ],
      };
    }
    const match = matches[0]!;
    sessionFile = match.sessionFile;
    // The index only names the session; selecting by entry id (with the
    // index-time source hash as the staleness guard) verifies that the id
    // still identifies the same entry instead of trusting a cached index
    // into a session that may have changed.
    entryId = call.id;
    expectedSourceHash = match.sourceHash;
    indices = [];
  } else if (call.session !== undefined) {
    sessionFile = resolveSessionFile(call.session, context);
  } else if (context.sessionFile !== undefined) {
    sessionFile = context.sessionFile;
  } else {
    return { ok: false, lines: ["expand: no id=, no session=, and no live session"] };
  }
  if (indices.length === 0 && entryId === undefined) {
    return { ok: false, lines: ["expand: idx= required (or id=, which carries its own)"] };
  }
  const [{ processMemoryExpand }, { MemoryRequestCache }] = await Promise.all([
    import("../memory/expand-service.js"),
    import("../memory/request-cache.js"),
  ]);
  const response = (await processMemoryExpand(
    {
      session: sessionFile,
      ...(entryId !== undefined
        ? { entryIds: [entryId], ...(expectedSourceHash !== undefined ? { expectedSourceHash } : {}) }
        : { indices }),
      ...(call.offset !== undefined ? { entryOffset: call.offset } : {}),
      ...(call.textOffset !== undefined ? { textOffset: call.textOffset } : {}),
      ...(call.maxChars !== undefined ? { maxChars: call.maxChars } : {}),
      ...(call.branches !== undefined ? { branches: call.branches } : {}),
    },
    context,
    new MemoryRequestCache(),
  )) as { session?: string; entries?: ExpandEntry[]; error?: unknown; next?: { args?: Record<string, unknown> } | null };

  const header = [`# session ${sessionFile}`];
  if (response.error !== undefined) {
    return {
      ok: false,
      lines: [...header, `expand error: ${JSON.stringify(response.error)}`],
    };
  }
  const entries = response.entries ?? [];
  if (entries.length === 0) {
    return { ok: false, lines: [...header, "expand: no entries returned"] };
  }
  const lines = [header[0]!];
  for (const entry of entries) lines.push("", ...renderEntry(entry));
  const next = response.next;
  if (next !== null && next !== undefined) {
    const args = next.args ?? {};
    const entryOffset = typeof args.entryOffset === "number" ? args.entryOffset : 0;
    const textOffset = typeof args.textOffset === "number" && args.textOffset > 0
      ? args.textOffset
      : undefined;
    const selection = entryId !== undefined
      ? `id=${entryId}`
      : `session=${sessionFile} idx=${indices.join(",")}`;
    lines.push(
      `# (more entries — continue with: ${selection} offset=${entryOffset}` +
        `${textOffset !== undefined ? ` textOffset=${textOffset}` : ""})`,
    );
  }
  return { ok: true, lines };
};
