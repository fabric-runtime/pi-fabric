import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_RECOVERY_TIMEOUT_MS, PiRecoveryWatchdog } from "../src/worker/recovery-watchdog.js";

afterEach(() => vi.useRealTimers());

const setup = () => {
  vi.useFakeTimers();
  const fail = vi.fn();
  return { fail, watchdog: new PiRecoveryWatchdog(fail) };
};

describe("PiRecoveryWatchdog", () => {
  it("bounds a terminated response and reports the original cause exactly once", () => {
    const { fail, watchdog } = setup();
    expect(PI_RECOVERY_TIMEOUT_MS).toBe(60_000);
    watchdog.arm("Error: Terminated");
    vi.advanceTimersByTime(59_999);
    expect(fail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fail).toHaveBeenCalledExactlyOnceWith(
      "Error: Terminated; Pi made no recovery progress for 60000ms; terminating child. Recovery: Pi announced no retry.",
    );
    watchdog.arm("another retry");
    watchdog.progress();
    vi.advanceTimersByTime(120_000);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not extend the deadline for repeated errors or retry announcements", () => {
    const { fail, watchdog } = setup();
    watchdog.arm("Error: Terminated");
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(10_000);
      watchdog.arm("Error: Terminated");
    }
    vi.advanceTimersByTime(10_000);
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it("refreshes on real streaming progress but still bounds a retry that stalls again", () => {
    const { fail, watchdog } = setup();
    watchdog.arm("Error: Terminated");
    vi.advanceTimersByTime(50_000);
    watchdog.progress();
    vi.advanceTimersByTime(50_000);
    expect(fail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it("does not time out healthy work and permits a later independent failure", () => {
    const { fail, watchdog } = setup();
    watchdog.progress();
    vi.advanceTimersByTime(120_000);
    watchdog.arm("first error");
    vi.advanceTimersByTime(30_000);
    watchdog.clear();
    vi.advanceTimersByTime(120_000);
    expect(fail).not.toHaveBeenCalled();
    watchdog.arm("later error");
    vi.advanceTimersByTime(60_000);
    expect(fail.mock.calls[0]?.[0]).toContain("later error");
  });

  it("says the retry turn never started when Pi announced a retry and went quiet", () => {
    const { fail, watchdog } = setup();
    watchdog.arm("anthropic/claude-sonnet-5-5: terminated");
    vi.advanceTimersByTime(2_000);
    watchdog.retryAnnounced(1, 3);
    vi.advanceTimersByTime(58_000);
    expect(fail).toHaveBeenCalledExactlyOnceWith(
      "anthropic/claude-sonnet-5-5: terminated; Pi made no recovery progress for 60000ms; terminating child. " +
      "Recovery: Pi announced retry 1 of 3 2s after the error; the retry turn never started.",
    );
  });

  it("says when the retry turn and its response started but produced no output", () => {
    const { fail, watchdog } = setup();
    watchdog.arm("Error: Terminated");
    vi.advanceTimersByTime(2_000);
    watchdog.retryAnnounced(1, 3);
    vi.advanceTimersByTime(2_000);
    watchdog.turnStarted();
    vi.advanceTimersByTime(1_000);
    watchdog.responseStarted();
    vi.advanceTimersByTime(30_000);
    watchdog.responseStarted();
    vi.advanceTimersByTime(25_000);
    expect(fail.mock.calls[0]?.[0]).toBe(
      "Error: Terminated; Pi made no recovery progress for 60000ms; terminating child. " +
      "Recovery: Pi announced retry 1 of 3 2s after the error; the retry turn started 4s after the error; " +
      "an assistant response started 5s after the error but produced no output.",
    );
  });

  it("keeps what recovery did after streamed output and reports when the output stopped", () => {
    const { fail, watchdog } = setup();
    watchdog.arm("Error: Terminated");
    vi.advanceTimersByTime(2_000);
    watchdog.retryAnnounced(2, 3);
    watchdog.turnStarted();
    vi.advanceTimersByTime(1_000);
    watchdog.responseStarted();
    vi.advanceTimersByTime(7_000);
    watchdog.progress();
    vi.advanceTimersByTime(59_999);
    expect(fail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fail).toHaveBeenCalledExactlyOnceWith(
      "Error: Terminated; Pi made no recovery progress for 60000ms; terminating child. " +
      "Recovery: Pi announced retry 2 of 3 2s after the error; the retry turn started 2s after the error; " +
      "an assistant response started 3s after the error; its last output came 10s after the error.",
    );
  });

  it("reports the latest retry attempt and forgets the previous attempt's turn", () => {
    const { fail, watchdog } = setup();
    watchdog.arm("Error: Terminated");
    watchdog.retryAnnounced(1, 3);
    watchdog.turnStarted();
    watchdog.responseStarted();
    vi.advanceTimersByTime(10_000);
    watchdog.retryAnnounced(2, 3);
    vi.advanceTimersByTime(50_000);
    expect(fail.mock.calls[0]?.[0]).toMatch(/Recovery: Pi announced retry 2 of 3 10s after the error; the retry turn never started\.$/);
  });

  it("ignores lifecycle events while no recovery is pending", () => {
    const { fail, watchdog } = setup();
    watchdog.retryAnnounced(1, 3);
    watchdog.turnStarted();
    watchdog.responseStarted();
    watchdog.arm("Error: Terminated");
    vi.advanceTimersByTime(60_000);
    expect(fail.mock.calls[0]?.[0]).toMatch(/Recovery: Pi announced no retry\.$/);
  });

  it("measures from the first error and drops recovery state once cleared", () => {
    const { fail, watchdog } = setup();
    watchdog.arm("first error");
    watchdog.retryAnnounced(1, 3);
    watchdog.clear();
    vi.advanceTimersByTime(5_000);
    watchdog.arm("second error");
    vi.advanceTimersByTime(3_000);
    watchdog.arm("second error again");
    watchdog.turnStarted();
    vi.advanceTimersByTime(57_000);
    expect(fail.mock.calls[0]?.[0]).toBe(
      "second error again; Pi made no recovery progress for 60000ms; terminating child. " +
      "Recovery: Pi announced no retry; a turn started 3s after the error.",
    );
  });

  it("cancels pending recovery on stop, timeout or process exit", () => {
    const { fail, watchdog } = setup();
    watchdog.arm("Error: Terminated");
    watchdog.dispose();
    watchdog.progress();
    watchdog.arm("late event");
    vi.advanceTimersByTime(120_000);
    expect(fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
