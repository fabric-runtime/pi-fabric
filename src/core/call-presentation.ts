/** Presentation only: never use these predicates to skip execution or recording. */
export const isRoutineInternalCall = (call: {
  ref: string;
  success?: boolean;
  status?: string;
  error?: string;
  result?: unknown;
}): boolean => {
  if (call.ref !== "native.load" || call.error) return false;
  if (call.result && typeof call.result === "object" &&
    (call.result as { isError?: unknown }).isError === true) return false;
  return call.success === true || (call.success === undefined && call.status === "completed");
};

const providers = new Set([
  "agents", "mesh", "mcp", "native", "tasks", "sessions", "programs", "jev",
  "memory", "state", "schema", "compact", "cache", "components", "thinking",
  "prewalk", "decisions", "fabric",
]);

const text = (value: unknown): string => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 96)
  : "";
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

/** Explicit field allowlists for built-ins. Never stringify arguments or infer from arbitrary strings. */
export const providerCallMetadata = (
  ref: string,
  args: Record<string, unknown> = {},
): { title: string; detail: string } | undefined => {
  const separator = ref.indexOf(".");
  const provider = ref.slice(0, separator);
  const action = ref.slice(separator + 1);
  if (!providers.has(provider) || separator < 1) return undefined;
  // MCP server tools are external, not the built-in MCP management API.
  if (provider === "mcp" && !action.startsWith("$")) return undefined;
  const first = (...keys: string[]): string => keys.map(key => text(args[key])).find(Boolean) ?? "";
  let detail = "";
  switch (provider) {
    case "tasks": detail = first("id", "jobId"); break;
    case "sessions": detail = first("id", "label", "cwd"); break;
    case "programs": detail = first("ref", "name"); break;
    case "jev": detail = first("id") || text(record(args.program).name); break;
    case "agents": detail = first("name", "id"); break;
    case "mesh": detail = first("key", "topic", "grantId", "prefix"); break;
    case "mcp": detail = first("server", "name"); break;
    case "memory": detail = first("query", "id", "sessionId"); break;
    case "state": detail = first("label"); break;
    case "schema": detail = first("hypothesisId", "label"); break;
    case "compact": detail = first("reason"); break;
    case "cache": detail = first("id", "target"); break;
    case "components": detail = first("id", "component", "scope"); break;
    case "thinking": detail = first("level", "target"); break;
    case "prewalk": detail = first("label"); break;
    case "decisions": detail = first("id", "title", "holder"); break;
    case "native": {
      const model = record(args.model);
      detail = [text(model.provider), text(model.id)].filter(Boolean).join("/") || first("type");
      break;
    }
    case "fabric": detail = first("ref", "provider", "namespace", "query"); break;
  }
  return { title: `${provider}.${action}`, detail };
};
