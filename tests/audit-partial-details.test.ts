import { describe, expect, it } from "vitest";
import { createFabricPartialExecutionDetails, FABRIC_PARTIAL_UPDATE_MAX_BYTES } from "../src/audit/details.js";

const updateBytes = (details: ReturnType<typeof createFabricPartialExecutionDetails>) =>
  Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: details.progress ?? "" }], details }), "utf8");

describe("partial execution envelope budget", () => {
  it.each(["p", "\0", "🚀", "\ud800"])("bounds large phase names with character %j", (character) => {
    const details = createFabricPartialExecutionDetails({
      audits: [],
      phases: Array.from({ length: 64 }, (_, index) => `${index}: ${character.repeat(80_000)}`),
      progress: character.repeat(20_000),
      deadlineAt: 1_800_000_000_000,
    });
    expect(updateBytes(details)).toBeLessThanOrEqual(FABRIC_PARTIAL_UPDATE_MAX_BYTES);
    expect(details.phases.length).toBeGreaterThan(0);
    expect(details.phases.every((phase) => phase.length <= 241)).toBe(true);
    expect(details.phases.at(-1)).toMatch(/^63:/);
    expect(details.deadlineAt).toBe(1_800_000_000_000);
  });

  it("retains raw omitted internal loads separately from failures", () => {
    const details = createFabricPartialExecutionDetails({
      audits: Array.from({ length: 100 }, (_, index) => ({ ref: "native.load", success: index !== 50 })), phases: [],
    });
    expect(details.audits).toHaveLength(60);
    expect(details.omittedCalls).toEqual({ count: 40, done: 40, failed: 1, internal: 39 });
  });

  it("counts failures among omitted partial audits", () => {
    const details = createFabricPartialExecutionDetails({
      audits: Array.from({ length: 100 }, (_, index) => ({ ref: `call-${index}`, success: index !== 50 })), phases: [],
    });
    expect(details.omittedCalls).toEqual({ count: 40, done: 40, failed: 1 });
  });

  it("budgets escaped phases after audits and both copies of progress", () => {
    const details = createFabricPartialExecutionDetails({
      audits: Array.from({ length: 100 }, (_, index) => ({
        ref: `demo.call-${index}`, args: { text: "x".repeat(30_000) }, success: true,
      })),
      phases: Array.from({ length: 64 }, (_, index) => `${index}: ${"\0".repeat(80_000)}`),
      progress: "\0".repeat(20_000),
    });
    expect(updateBytes(details)).toBeLessThanOrEqual(FABRIC_PARTIAL_UPDATE_MAX_BYTES);
    expect(details.phases.length).toBeLessThan(64);
    expect(details.phases.at(-1)).toMatch(/^63:/);
    expect(details.audits.length + (details.omittedCalls?.count ?? 0)).toBe(100);
    expect(details.audits.filter((audit) => audit.success !== undefined).length + (details.omittedCalls?.done ?? 0)).toBe(100);
  });
});
