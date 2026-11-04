import { describe, expect, it } from "vitest";
import { parseStructuredValue, validateAgentResult } from "../src/agents/result.js";

const reportSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: { verdict: { type: "string" }, lines: { type: "number" } },
  required: ["verdict", "lines"],
};

const directiveSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: { action: { enum: ["message", "silent"] }, message: { type: "string" } },
  required: ["action", "message"],
};

type Rec = { status: string; text: string; value?: unknown; error?: string };
const rec = (text: string): Rec => ({ status: "completed", text });

describe("parseStructuredValue prose salvage", () => {
  it("salvages JSON after prose that quotes bracketed code", () => {
    const text =
      'Analysis complete. `src/main.rs` contains zero `#[test]` or `cfg(test)` matches. {"verdict":"no unit tests","lines":650}';
    expect(parseStructuredValue(text)).toEqual({ verdict: "no unit tests", lines: 650 });
  });

  it("prefers the schema-matching candidate over an earlier valid array", () => {
    const text = 'See refs [1] for context. {"verdict":"ok","lines":2}';
    expect(parseStructuredValue(text, reportSchema)).toEqual({ verdict: "ok", lines: 2 });
  });

  it("returns the first parsed candidate when no schema is given", () => {
    expect(parseStructuredValue("refs [1] and [2]")).toEqual([1]);
  });

  it("keeps the fenced block ahead of bracket runs in prose", () => {
    const text = 'Notes [x] before.\n\`\`\`json\n{"verdict":"fenced","lines":1}\n\`\`\`';
    expect(parseStructuredValue(text, reportSchema)).toEqual({ verdict: "fenced", lines: 1 });
  });

  it("throws the whole-text parse error when no candidate parses", () => {
    expect(() => parseStructuredValue("no json here, just `#[test]` and [see]")).toThrow();
  });
});

describe("validateAgentResult salvage integration", () => {
  it("completes an agent whose prose preamble quotes bracketed code", () => {
    const record = validateAgentResult(rec('Done. `#[test]` count: 0. {"verdict":"missing","lines":0}'), reportSchema);
    expect(record.status).toBe("completed");
    expect(record.value).toEqual({ verdict: "missing", lines: 0 });
  });

  it("still fails prose with no JSON payload", () => {
    const record = validateAgentResult(rec("just prose, nothing else"), reportSchema);
    expect(record.status).toBe("failed");
    expect(record.error).toContain("Structured agent output was invalid");
  });

  it("does not regress directive prose coercion", () => {
    const record = validateAgentResult(rec("useful advice with a `#[test]` mention"), directiveSchema);
    expect(record.status).toBe("completed");
    expect(record.value).toEqual({ action: "message", message: "useful advice with a `#[test]` mention" });
  });

  it("reports a schema mismatch when every candidate parses but none matches", () => {
    const record = validateAgentResult(rec("refs [1] and [2]"), reportSchema);
    expect(record.status).toBe("failed");
    expect(record.error).toContain("Structured agent output was invalid");
  });
});
