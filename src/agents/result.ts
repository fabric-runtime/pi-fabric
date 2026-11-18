import { Value } from "typebox/value";

const MAX_SALVAGE_CHARS = 1024 * 1024;
const MAX_PARSED_CANDIDATES = 16;

// Find spans in one pass even when a model emits a long run of unclosed
// brackets. Keep inner completions so malformed surrounding prose cannot
// hide a later value; a successfully parsed outer value will own its span.
const balancedSpans = (text: string): Int32Array => {
  const ends = new Int32Array(text.length);
  const stack: number[] = [];
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"' && stack.length) quoted = true;
    else if (char === "{" || char === "[") stack.push(i);
    else if (char === "}" || char === "]") {
      const start = stack.pop();
      if (start === undefined) continue;
      if ((text[start] === "{") === (char === "}")) ends[start] = i + 1;
      else stack.length = 0;
    }
  }
  return ends;
};

export const parseStructuredValue = (text: string, schema?: Record<string, unknown>): unknown => {
  const trimmed = text.trim();
  let originalError: unknown;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    originalError = error;
  }
  const source = trimmed.slice(0, MAX_SALVAGE_CHARS);
  // Bound bytes sent to JSON.parse independently of the number of positions
  // that look balanced, so nested, unparsable spans cannot make this quadratic.
  let remaining = source.length * 4;
  let parsed = 0;
  let first: unknown;
  const unmatched = Symbol("unmatched JSON candidate");
  const tryCandidate = (candidate: string): { result: unknown; parsed: boolean } => {
    remaining -= candidate.length;
    let value: unknown;
    try { value = JSON.parse(candidate); }
    catch { return { result: unmatched, parsed: false }; }
    if (parsed++ === 0) first = value;
    return { result: !schema || Value.Check(schema, value) ? value : unmatched, parsed: true };
  };
  const fenced = source.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (fenced?.[1]) {
    const { result } = tryCandidate(fenced[1]);
    if (result !== unmatched) return result;
  }
  const spans = balancedSpans(source);
  for (let i = 0; i < spans.length && parsed < MAX_PARSED_CANDIDATES && remaining > 0; i++) {
    const end = spans[i]!;
    if (!end || end - i > remaining) continue;
    const attempted = tryCandidate(source.slice(i, end));
    if (attempted.result !== unmatched) return attempted.result;
    // An object nested inside an unrelated but valid payload is not a
    // separate answer. Keep looking after the valid candidate instead.
    if (attempted.parsed) i = end - 1;
  }
  if (parsed === 0) throw originalError;
  return first;
};

export function validateAgentResult<T extends { status: string; text: string; value?: unknown; error?: string }>(record: T, schema?: Record<string, unknown>): T {
  if (record.status !== "completed" || !schema) return record;
  let parsed = false;
  try {
    // An explicit null is a value; only a missing one falls back to the text.
    const value = record.value !== undefined ? record.value : parseStructuredValue(record.text, schema);
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
