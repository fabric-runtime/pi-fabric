import { describe, expect, it } from "vitest";
import { validateAgentResult } from "../src/agents/result.js";

type Rec = { status: string; text: string; value?: unknown; error?: string };
const rec = (text: string): Rec => ({ status: "completed", text });

const directive = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["silent", "message"] },
    message: { type: "string" },
  },
};

describe("validateAgentResult directive prose coercion", () => {
  it("coerces prose from a directive-mode actor into a message action", () => {
    const record = validateAgentResult(
      rec("Gate 2 wording: the merge is fine, but watch the PDC."),
      directive,
    );
    expect(record.status).toBe("completed");
    expect(record.value).toEqual({
      action: "message",
      message: "Gate 2 wording: the merge is fine, but watch the PDC.",
    });
    expect(record.error).toBeUndefined();
  });

  it("coerces empty output from a directive-mode actor into a silent action", () => {
    const record = validateAgentResult(rec("   "), directive);
    expect(record.status).toBe("completed");
    expect(record.value).toEqual({ action: "silent" });
  });

  it("caps coerced prose so a runaway monologue cannot flood the status record", () => {
    const record = validateAgentResult(rec("x".repeat(5000)), directive);
    expect(record.status).toBe("completed");
    const value = record.value as { message: string };
    expect(value.message).toHaveLength(2400);
  });

  it("still fails non-directive schemas loudly", () => {
    const record = validateAgentResult(
      rec("prose"),
      { type: "object", properties: { name: { type: "string" } } },
    );
    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/^Structured agent output was invalid:/);
  });

  it("does not coerce prose into an action the schema forbids", () => {
    // enum has "silent" but no "message": prose cannot become a valid action,
    // so the record must keep failing instead of emitting an invalid value.
    const silentOnly = {
      type: "object",
      properties: { action: { type: "string", enum: ["silent"] } },
    };
    const record = validateAgentResult(rec("prose"), silentOnly);
    expect(record.status).toBe("failed");
  });

  it.each([
    '{"action":"unsupported"}',
    '{"action":"message","message":42}',
    '42',
    '{"action":',
    '```json\n{"action":\n```',
  ])("does not turn invalid structured output into a message: %s", text => {
    const record = validateAgentResult(rec(text), directive);
    expect(record.status).toBe("failed");
    expect(record.error).toContain("Structured agent output was invalid");
  });

  it("does not replace an invalid pre-parsed value with prose", () => {
    const record = validateAgentResult({ ...rec("useful advice"), value: { action: "unsupported" } }, directive);
    expect(record.status).toBe("failed");
    expect(record.value).toEqual({ action: "unsupported" });
  });

  it("keeps required fields and message limits authoritative", () => {
    const strict = { ...directive, required: ["action", "message"], properties: {
      ...directive.properties, message: { type: "string", maxLength: 3 },
    } };
    expect(validateAgentResult(rec("too long"), strict).status).toBe("failed");
    expect(validateAgentResult(rec(""), strict).status).toBe("failed");
  });

  it("does not recover an already failed run", () => {
    expect(validateAgentResult({ ...rec("advice"), status: "failed", error: "provider failed" }, directive))
      .toEqual({ status: "failed", text: "advice", error: "provider failed" });
  });

  it("leaves valid structured output untouched", () => {
    const record = validateAgentResult(
      rec('{"action":"silent"}'),
      directive,
    );
    expect(record.status).toBe("completed");
    expect(record.value).toEqual({ action: "silent" });
  });

  it("leaves structured output that merely needs extraction untouched", () => {
    const record = validateAgentResult(
      rec('Sure!\n\n```json\n{"action":"message","message":"ok"}\n```'),
      directive,
    );
    expect(record.status).toBe("completed");
    expect(record.value).toEqual({ action: "message", message: "ok" });
  });

  it("checks an explicit null value instead of parsing the text", () => {
    const record = validateAgentResult(
      { ...rec('{"action":"silent"}'), value: null },
      directive,
    );
    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/^Structured agent output was invalid: /);
  });
});
