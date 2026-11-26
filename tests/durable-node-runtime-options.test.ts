import { describe, expect, it } from "vitest";
import { durableTypeScriptNodeArgs } from "../src/durable/node-runtime-options.js";

describe("managed durable TypeScript worker Node flags", () => {
  it("shrinks only the young generation for typed workers", () => {
    expect(durableTypeScriptNodeArgs("typescript", "")).toEqual(["--max-semi-space-size=4"]);
    expect(durableTypeScriptNodeArgs("python", "")).toEqual([]);
    expect(durableTypeScriptNodeArgs(undefined, "")).toEqual([]);
  });

  it("leaves explicit operator NODE_OPTIONS unchanged", () => {
    expect(durableTypeScriptNodeArgs("typescript", "--max-semi-space-size=8")).toEqual([]);
    expect(durableTypeScriptNodeArgs("typescript", "--enable-source-maps")).toEqual([]);
  });
});
