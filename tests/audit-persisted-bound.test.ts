import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFabricPersistedExecutionDetails,
  FABRIC_EXECUTION_DETAILS_MAX_BYTES,
} from "../src/audit/details.js";
import { isRoutineInternalCall } from "../src/core/call-presentation.js";
import type { FabricExecutionTraceV1 } from "../src/audit/trace-schema.js";

type Input = Parameters<typeof createFabricPersistedExecutionDetails>[0];
type Details = ReturnType<typeof createFabricPersistedExecutionDetails>;

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

// The bound as it was specified: measure the whole record after every pop.
const reference = (input: Input): Details => {
  const details = structuredClone(createFabricPersistedExecutionDetails({
    ...input,
    audits: [],
    trace: { ...input.trace, operations: [], phases: [] },
    ...(input.assessment ? { assessment: { ...input.assessment, operations: [] } } : {}),
    phases: [],
  }));
  details.audits = structuredClone([...(input.audits ?? [])]) as Details["audits"];
  details.trace = structuredClone(input.trace);
  if (input.assessment) details.assessment = structuredClone(input.assessment);
  details.phases = [...(input.phases ?? [])];
  const max = FABRIC_EXECUTION_DETAILS_MAX_BYTES;
  while (bytes(details) > max && details.audits.length > 0) {
    const dropped = details.audits.pop()!;
    const omitted = details.omittedCalls ?? { count: 0, done: 0 };
    details.omittedCalls = {
      count: omitted.count + 1,
      done: omitted.done + (dropped.success !== undefined ? 1 : 0),
      ...((omitted.internal ?? 0) + Number(isRoutineInternalCall(dropped)) > 0
        ? { internal: (omitted.internal ?? 0) + Number(isRoutineInternalCall(dropped)) } : {}),
      ...((omitted.failed ?? 0) + (dropped.success === false ? 1 : 0) > 0
        ? { failed: (omitted.failed ?? 0) + (dropped.success === false ? 1 : 0) } : {}),
    };
  }
  while (bytes(details) > max && details.assessment && details.assessment.operations.length > 0) {
    details.assessment.operations.pop();
    details.assessment.counts.droppedOperations++;
  }
  while (bytes(details) > max && details.trace.operations.length > 0) {
    details.trace.operations.pop();
    details.trace.counts.droppedOperations++;
  }
  while (bytes(details) > max && details.phases.length > 0) details.phases.pop();
  while (bytes(details) > max && details.trace.phases.length > 0) {
    details.trace.phases.pop();
    details.trace.counts.droppedValues++;
  }
  if (bytes(details) > max) {
    delete details.trace.error;
    details.trace.counts.droppedValues++;
  }
  return details;
};

const trace = (operations: number, operationBytes: number, phases = 0, phaseBytes = 0): FabricExecutionTraceV1 => ({
  version: 1,
  outcome: "succeeded",
  error: "trace error ".repeat(20),
  counts: { droppedOperations: 0, droppedValues: 0 },
  phases: Array.from({ length: phases }, (_, index) => `phase ${index} ${"φ".repeat(phaseBytes)}`),
  operations: Array.from({ length: operations }, (_, index) => ({
    ref: "pi.read",
    args: { path: `src/${index}.ts` },
    outcome: "succeeded",
    result: `${index}:${"r".repeat(operationBytes)}`,
  })),
}) as unknown as FabricExecutionTraceV1;

const audits = (count: number, resultBytes: number) => Array.from({ length: count }, (_, index) => ({
  ref: index % 5 === 0 ? "fabric.$spanStart" : "pi.read",
  nestedToolCallId: `call-${index}`,
  ...(index % 7 === 3 ? {} : { success: index % 11 !== 4 }),
  ...(index % 11 === 4 ? { error: "failed ✗" } : {}),
  args: { path: `src/module-${index}.ts` },
  result: `${index} ${"😀x".repeat(resultBytes / 3)}`,
  startedAt: index,
  endedAt: index + 1,
}));

const cases: Array<[string, Input]> = [
  ["fits without dropping", { success: true, trace: trace(4, 100), audits: audits(6, 1_000), phases: ["a"] }],
  ["drops many large audits", { success: true, trace: trace(80, 200), audits: audits(120, 25_000), phases: ["read", "sum"] }],
  ["drops one audit at the boundary", { success: false, trace: trace(2, 10), audits: audits(21, 25_000), error: "boom" }],
  ["drops into the trace", { success: true, trace: trace(400, 3_000), audits: audits(30, 30_000), phases: ["p"] }],
  ["drops assessment rows before the trace", {
    success: true,
    trace: trace(300, 2_000),
    audits: audits(10, 60_000),
    assessment: {
      version: 1,
      counts: { droppedOperations: 0 },
      operations: Array.from({ length: 200 }, (_, index) => ({ ref: "pi.read", index, note: "a".repeat(1_500) })),
    } as unknown as NonNullable<Input["assessment"]>,
  }],
  ["drops phases and trace phases", {
    success: true,
    trace: trace(0, 0, 400, 1_200),
    audits: [],
    phases: Array.from({ length: 400 }, (_, index) => `${index} ${"p".repeat(1_000)}`),
  }],
];

describe("persisted fabric_exec details bound", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(cases)("matches measuring after every pop: %s", (_name, input) => {
    const expected = reference(input);
    const actual = createFabricPersistedExecutionDetails(input);
    expect(actual).toEqual(expected);
    expect(bytes(actual)).toBeLessThanOrEqual(FABRIC_EXECUTION_DETAILS_MAX_BYTES);
  });

  it("does not re-serialize the whole record for every dropped audit", () => {
    const input: Input = { success: true, trace: trace(40, 100), audits: audits(400, 25_000) };
    const stringify = vi.spyOn(JSON, "stringify");
    const details = createFabricPersistedExecutionDetails(input);
    const whole = stringify.mock.calls.filter(([value]) => value === details).length;
    expect(details.omittedCalls?.count).toBeGreaterThan(350);
    // One measurement per bound plus a few confirmations, not one per pop.
    expect(whole).toBeLessThanOrEqual(10);
  });
});
