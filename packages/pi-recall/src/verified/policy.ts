// Severed seam of the pi-fabric extraction (pi-transcript-recall).
//
// In the fork these decisions are one-line wrappers over model-checked state
// machines (src/verified/generated/policy.js, gdp-wired kernels). The engines
// were a startup-graph concern, not a memory-module dependency: each wrapper is
// a total function over boolean/natural inputs. Here the same total functions
// are plain predicates whose truth tables were extracted by enumerating the
// fork's machines on 2026-11-11 (see tests/policy.test.ts for the pinned
// tables):
//
//   lineageSelected(allBranches, member) = allBranches || member
//   pointerCurrent(source, lineage)      = source && lineage
//   coverageComplete(sourceComplete, truncated) = sourceComplete && !truncated
//   acceptMemoryChunk(...) — chunk machine out.accepted, see below

/** Verified-kernel natural bound (src/verified/nat.ts in the fork). */
export const VERIFIED_NAT_MAX = Number.MAX_SAFE_INTEGER;

const isNatural = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const lineageSelected = (allBranches: boolean, member: boolean): boolean =>
  allBranches || member;

export const pointerCurrent = (source: boolean, lineage: boolean): boolean =>
  source && lineage;

export const coverageComplete = (sourceComplete: boolean, truncated: boolean): boolean =>
  sourceComplete && !truncated;

export interface TextRange { start: number; end: number; total: number; complete: boolean }

/** Chunk-acceptance kernel of acceptsExpansionPage (fork src/verified/memory.ts).
 * Machine step transcribed from generated/policy.js `chunk accepted`:
 * accepted ⇔ start === expectedStart ∧ total === expectedTotal ∧ start ≤ end
 * ∧ end ≤ total ∧ start + length === end ∧ complete ⇔ end === total
 * ∧ (complete ∨ start < end). */
export const acceptMemoryChunk = (
  range: TextRange, length: number, expectedStart: number, expectedTotal: number,
): boolean => {
  if (![range.start, range.end, range.total, length, expectedStart, expectedTotal].every(isNatural) ||
      range.start + length > VERIFIED_NAT_MAX || typeof range.complete !== "boolean") return false;
  return range.start === expectedStart && range.total === expectedTotal &&
    range.start <= range.end && range.end <= range.total &&
    range.start + length === range.end &&
    range.complete === (range.end === range.total) &&
    (range.complete || range.start < range.end);
};
