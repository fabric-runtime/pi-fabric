import { describe, expect, it } from "vitest";
import { hostOutputCeiling, providerHumanWait } from "../src/verified/execution.js";

// Wire/codec checks supplement the universal decisions and mutation refusals.
describe("verified execution policy adapters", () => {
  it("preserves nullish defaults and exact positive safe overrides without clamping", () => {
    expect(hostOutputCeiling(undefined, 50_000, "limit")).toBe(50_000);
    expect(hostOutputCeiling(null, 50_000, "limit")).toBe(50_000);
    expect(hostOutputCeiling(262_144, 50_000, "limit")).toBe(262_144);
    expect(hostOutputCeiling(1, 2_000_000, "limit")).toBe(1);
    expect(hostOutputCeiling(2 ** 32, 50_000, "limit")).toBe(2 ** 32);
    expect(hostOutputCeiling(Number.MAX_SAFE_INTEGER, 50_000, "limit")).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("rejects malformed present overrides and malformed defaults without coercion", () => {
    const invalid: unknown[] = [false, true, "262144", {}, [], -1, -0, 0, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1];
    for (const value of invalid) {
      expect(() => hostOutputCeiling(value as number, 50_000, "limit")).toThrow("limit must be a positive safe integer");
    }
    for (const value of [undefined, null, ...invalid]) {
      expect(() => hostOutputCeiling(undefined, value as number, "limit")).toThrow("Invalid default for limit");
    }
  });
  it("forwards the exact callback only without an explicit hard deadline", () => {
    const callback = async <T>(wait: () => Promise<T>): Promise<T> => wait();
    expect(providerHumanWait(callback, undefined)).toBe(callback);
    expect(providerHumanWait(undefined, undefined)).toBeUndefined();
    expect(providerHumanWait(callback, 1000)).toBeUndefined();
    expect(providerHumanWait(callback, 0)).toBeUndefined();
  });
});
