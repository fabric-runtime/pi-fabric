import { afterEach, describe, expect, it, vi } from "vitest";
import { settleWithin } from "../src/async-settlement.js";

describe("settleWithin", () => {
  afterEach(() => vi.useRealTimers());

  it("still waits for every operation, including rejected operations", async () => {
    let finish!: () => void;
    const operation = new Promise<void>((resolve) => { finish = resolve; });
    const wait = settleWithin([operation, Promise.reject(new Error("failed"))], 10_000);
    finish();
    await expect(wait).resolves.toBe(true);
  });

  it("bounds a non-cooperative operation and clears the timer", async () => {
    vi.useFakeTimers();
    const wait = settleWithin([new Promise(() => {})], 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(wait).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("cancels only the wait (already aborted: %s)", async (alreadyAborted) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let reject!: (error: Error) => void;
    const operation = new Promise<void>((_resolve, fail) => { reject = fail; });
    if (alreadyAborted) controller.abort();
    const wait = settleWithin([operation], 10_000, controller.signal);
    if (!alreadyAborted) controller.abort();
    await expect(wait).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    if (!alreadyAborted) expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    // A late cleanup failure remains observed after the caller has returned.
    reject(new Error("late failure"));
    await Promise.resolve();
  });
});
