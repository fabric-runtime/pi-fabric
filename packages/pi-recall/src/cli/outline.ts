// `pi-recall outline` — ordered entry skeleton over the shared memory engine:
// per entry one bounded row (index / type / role / tool / preview / size), the
// map before `expand` reads the territory. Same session resolution as expand.
import type { MemoryProviderContext } from "../memory/request-context.js";

const OUTLINE_ARGV_HELP = [
  "outline arguments (key=value lines after the command):",
  "  session=<path|sid>   session file or session id (required)",
  "  role=<r>             exact normalized entry role filter",
  "  branches=<b>         active | all",
].join("\n");

export interface OutlineCall {
  session?: string;
  role?: string;
  branches?: string;
}

export const parseOutlineArgv = (lines: string[]): OutlineCall => {
  const call: OutlineCall = {};
  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error(`malformed outline argument (expected key=value): ${line}\n${OUTLINE_ARGV_HELP}`);
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (value === "") throw new Error(`outline ${key}= is empty`);
    switch (key) {
      case "session":
        call.session = value;
        break;
      case "role":
        call.role = value;
        break;
      case "branches":
        call.branches = value;
        break;
      default:
        throw new Error(`unknown outline argument: ${key}\n${OUTLINE_ARGV_HELP}`);
    }
  }
  if (call.session === undefined) {
    throw new Error(`outline needs session=<path|sid>\n${OUTLINE_ARGV_HELP}`);
  }
  return call;
};

interface OutlineResponse {
  session?: string;
  total?: number;
  truncated?: boolean;
  error?: unknown;
  entries?: Array<{
    index: number;
    type?: string | null;
    role?: string | null;
    tool?: string | null;
    preview?: string;
    size?: number;
  }>;
}

const pad = (value: string, width: number): string =>
  value.length >= width ? value : value + " ".repeat(width - value.length);

export const renderOutline = (response: OutlineResponse): string[] => {
  const entries = response.entries ?? [];
  const head = response.truncated
    ? `${response.total} entries, showing ${entries.length}`
    : `${response.total ?? entries.length} entries`;
  const lines = [`# session ${response.session} (${head})`];
  for (const row of entries) {
    lines.push(
      [
        pad(String(row.index), 4),
        pad(row.type ?? "-", 10),
        pad(row.role ?? "-", 18),
        pad(row.tool ?? "-", 12),
        row.preview ?? "",
      ]
        .join("  ")
        .trimEnd(),
    );
  }
  if (response.truncated) {
    // maxEntries is a hard engine cap (parseOutlineArgv rejects it; the service
    // clamps at 200), so recovery is narrowing or per-entry reads, not a raise.
    lines.push(
      `# (truncated at ${entries.length} of ${response.total} rows — narrow with role=<r>, or read entries with: pi-recall expand session=<file> idx=<n>)`,
    );
  }
  return lines;
};

export const runOutlineCall = async (
  call: OutlineCall,
  context: MemoryProviderContext,
  json = false,
): Promise<{ ok: boolean; lines: string[] }> => {
  const [{ resolveSessionFile }, { processMemoryOutline }, { MemoryRequestCache }] = await Promise.all([
    import("./expand.js"),
    import("../memory/outline-service.js"),
    import("../memory/request-cache.js"),
  ]);
  const sessionFile = resolveSessionFile(call.session!, context);
  const response = (await processMemoryOutline(
    {
      session: sessionFile,
      ...(call.role !== undefined ? { role: call.role } : {}),
      ...(call.branches !== undefined ? { branches: call.branches } : {}),
    },
    context,
    new MemoryRequestCache(),
  )) as OutlineResponse;
  if (json) {
    return { ok: response.error === undefined, lines: [JSON.stringify(response, null, 2)] };
  }
  if (response.error !== undefined) {
    return {
      ok: false,
      lines: [`# session ${sessionFile}`, `outline error: ${JSON.stringify(response.error)}`],
    };
  }
  return { ok: true, lines: renderOutline(response) };
};
