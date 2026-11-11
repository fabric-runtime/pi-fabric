// Pinned truth tables for the severed verified-policy predicates. The tables
// were enumerated by executing the fork's model-checked machines
// (src/verified/generated/policy.js) before extraction; if any assertion here
// fails, the plain-predicate transcription in src/verified/policy.ts diverged
// from the verified kernels and must be fixed before shipping.
import { describe, expect, test } from "bun:test";
import {
  acceptMemoryChunk,
  coverageComplete,
  lineageSelected,
  pointerCurrent,
} from "../src/verified/policy.js";

describe("lineageSelected (machine: lineage selected)", () => {
  test("selected iff member or allBranches", () => {
    expect(lineageSelected(false, false)).toBe(false);
    expect(lineageSelected(false, true)).toBe(true);
    expect(lineageSelected(true, false)).toBe(true);
    expect(lineageSelected(true, true)).toBe(true);
  });
});

describe("pointerCurrent (machine: pointer current)", () => {
  test("current iff source and lineage", () => {
    expect(pointerCurrent(false, false)).toBe(false);
    expect(pointerCurrent(false, true)).toBe(false);
    expect(pointerCurrent(true, false)).toBe(false);
    expect(pointerCurrent(true, true)).toBe(true);
  });
});

describe("coverageComplete (machine: coverage complete)", () => {
  test("complete iff sourceComplete and not truncated", () => {
    expect(coverageComplete(false, false)).toBe(false);
    expect(coverageComplete(false, true)).toBe(false);
    expect(coverageComplete(true, false)).toBe(true);
    expect(coverageComplete(true, true)).toBe(false);
  });
});

describe("acceptMemoryChunk (machine: chunk accepted)", () => {
  const range = (start: number, end: number, total: number, complete: boolean) =>
    ({ start, end, total, complete });

  test("complete chunk aligned at zero", () => {
    expect(acceptMemoryChunk(range(0, 10, 10, true), 10, 0, 10)).toBe(true);
  });

  test("partial chunk mid-entry", () => {
    expect(acceptMemoryChunk(range(4, 9, 40, false), 5, 4, 40)).toBe(true);
  });

  test("rejects wrong expected start", () => {
    expect(acceptMemoryChunk(range(0, 10, 10, true), 10, 4, 10)).toBe(false);
  });

  test("rejects wrong expected total", () => {
    expect(acceptMemoryChunk(range(0, 10, 10, true), 10, 0, 11)).toBe(false);
  });

  test("rejects length that does not close the range", () => {
    expect(acceptMemoryChunk(range(0, 10, 10, true), 9, 0, 10)).toBe(false);
  });

  test("complete flag must match end === total (both ways)", () => {
    expect(acceptMemoryChunk(range(0, 10, 10, false), 10, 0, 10)).toBe(false);
    expect(acceptMemoryChunk(range(0, 4, 10, true), 4, 0, 10)).toBe(false);
  });

  test("empty non-complete chunk is rejected (start < end unless complete)", () => {
    expect(acceptMemoryChunk(range(3, 3, 10, false), 0, 3, 10)).toBe(false);
  });

  test("zero-length complete chunk at the end is accepted", () => {
    expect(acceptMemoryChunk(range(10, 10, 10, true), 0, 10, 10)).toBe(true);
  });

  test("rejects non-naturals and out-of-range addition", () => {
    expect(acceptMemoryChunk(range(-1, 4, 10, false), 5, 0, 10)).toBe(false);
    expect(acceptMemoryChunk(range(0, 4, 10, false), 1.5, 0, 10)).toBe(false);
    expect(acceptMemoryChunk({ ...range(0, 4, 10, false), complete: "yes" as unknown as boolean }, 4, 0, 10)).toBe(false);
  });
});
