import { describe, expect, it, vi } from "vitest";
import { settleLifecyclePublication } from "../src/core/lifecycle-settlement.js";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe("abort lifecycle publication", () => {
  it("does not wait for a contended mesh write on abort, but still publishes it", async () => {
    let release!: () => void;
    const publisher = { publishHostLifecycle: vi.fn(() => new Promise<void>(resolve => { release = resolve; })) };
    await settleLifecyclePublication(publisher, "pi.agent_settled", { aborted: true }, true);
    expect(publisher.publishHostLifecycle).toHaveBeenCalledOnce();
    release();
    await flush();
  });

  it("keeps normal completion ordered behind the publication", async () => {
    let release!: () => void;
    let completed = false;
    const publisher = { publishHostLifecycle: () => new Promise<void>(resolve => { release = resolve; }) };
    const pending = settleLifecyclePublication(publisher, "pi.agent_end", {}, false).then(() => { completed = true; });
    await flush();
    expect(completed).toBe(false);
    release();
    await pending;
    expect(completed).toBe(true);
  });

  it("handles a delayed publication failure without an unhandled rejection", async () => {
    let reject!: (error: Error) => void;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const publisher = { publishHostLifecycle: () => new Promise<void>((_, fail) => { reject = fail; }) };
      await settleLifecyclePublication(publisher, "pi.turn_end", {}, true);
      reject(new Error("mesh is locked"));
      await flush();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("mesh is locked"));
    } finally { warn.mockRestore(); }
  });
});
