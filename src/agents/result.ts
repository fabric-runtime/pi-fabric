import { Value } from "typebox/value";

const extractBalancedJson = (text: string, start: number): string | null => {
  const open = text[start];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
};

export const parseStructuredValue = (text: string): unknown => {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Whole text is not JSON; try extraction below.
  }
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Fenced block is not JSON; try balanced extraction below.
    }
  }
  const start = trimmed.search(/[{\[]/);
  if (start >= 0) {
    const balanced = extractBalancedJson(trimmed, start);
    if (balanced) return JSON.parse(balanced);
  }
  return JSON.parse(trimmed);
};

export function validateAgentResult<T extends { status: string; text: string; value?: unknown; error?: string }>(record: T, schema?: Record<string, unknown>): T {
  if (record.status !== "completed" || !schema) return record;
  let parsed = false;
  try {
    // An explicit null is a value; only a missing one falls back to the text.
    const value = record.value !== undefined ? record.value : parseStructuredValue(record.text);
    parsed = true;
    if (!Value.Check(schema, value)) {
      const errors = [...Value.Errors(schema, value)].slice(0, 5).map((error) => error.message).join("; ");
      throw new Error(errors || "value does not match schema");
    }
    record.value = value;
  } catch (error) {
    // Directive-mode actors (schema's action enum contains "silent") prefer
    // silence over chatter, so a model that ignored the JSON contract and
    // answered in prose produced advice, not a protocol failure. Coerce the
    // prose into the nearest valid action instead of failing the whole run.
    // The coerced value must itself validate against the schema, so schemas
    // that do not actually accept a message action still fail loudly.
    const actionSchema = (schema as { properties?: { action?: { enum?: unknown[] } } }).properties?.action;
    const prose = record.text.trim();
    // Invalid JSON/schema values are protocol failures, not advice. Only plain
    // unstructured prose (or silence) is eligible for the directive fallback.
    const plainProse = !/^[{[\"]|```/.test(prose);
    if (!parsed && error instanceof SyntaxError && plainProse &&
        Array.isArray(actionSchema?.enum) && actionSchema.enum.includes("silent")) {
      const coerced = prose ? { action: "message", message: prose.slice(0, 2400) } : { action: "silent" };
      if (Value.Check(schema, coerced)) {
        record.value = coerced;
        return record;
      }
    }
    record.status = "failed";
    const reason = error instanceof Error ? error.message : String(error);
    const output = record.text.trim();
    const snippet = output.slice(0, 200);
    record.error = `Structured agent output was invalid: ${reason}${snippet ? ` (output: ${snippet}${output.length > 200 ? "…" : ""})` : ""}`;
  }
  return record;
}
