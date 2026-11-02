import { describe, expect, it } from "vitest";
import { isRoutineInternalCall, providerCallMetadata } from "../src/core/call-presentation.js";
import { FabricActivityStore } from "../src/activity/store.js";

describe("safe built-in call presentation", () => {
  it.each([
    ["tasks.wait", { id: "task-123" }, "task-123"],
    ["tasks.watch", { id: "task-123", match: "secret" }, "task-123"],
    ["tasks.adopt", { jobId: "job-123" }, "job-123"],
    ["sessions.write", { id: "session-123", text: "secret" }, "session-123"],
    ["sessions.open", { label: "compiler", cmd: "secret" }, "compiler"],
    ["agents.stop", { id: "agent-123" }, "agent-123"],
    ["jev.spawn", { program: { name: "observer", code: "secret" }, input: "secret" }, "observer"],
    ["jev.wait", { id: "jev-123" }, "jev-123"],
    ["programs.get", { ref: "compiler@abc123" }, "compiler@abc123"],
    ["schema.commit", { hypothesisId: "hyp-123", certificate: "secret" }, "hyp-123"],
    ["mesh.revoke", { grantId: "grant-123" }, "grant-123"],
    ["cache.release", { id: "lease-123" }, "lease-123"],
    ["components.describe", { component: "compiler" }, "compiler"],
    ["native.classify", { model: { provider: "test", id: "judge", apiKey: "secret" }, context: "secret" }, "test/judge"],
  ])("scopes %s and selects only declared display fields", (ref, args, detail) => {
    expect(providerCallMetadata(ref as string, args as Record<string, unknown>)).toEqual({ title: ref, detail });
  });
  it("bounds and sanitizes selected fields without inspecting arbitrary payloads", () => {
    const poison = { toJSON() { throw new Error("must not stringify"); } };
    const result = providerCallMetadata("tasks.wait", { id: "\x1b[31m" + "x".repeat(500), payload: poison });
    expect(result?.detail.length).toBeLessThanOrEqual(96);
    expect(result?.detail).not.toContain("\x1b");
    expect(providerCallMetadata("sessions.write", { text: "secret", payload: poison })?.detail).toBe("");
    expect(providerCallMetadata("extensions.custom", { query: "existing preview" })).toBeUndefined();
  });
  it("hides only confirmed successful internal loads", () => {
    expect(isRoutineInternalCall({ ref: "native.load", success: true })).toBe(true);
    expect(isRoutineInternalCall({ ref: "native.load", status: "completed" })).toBe(true);
    for (const call of [
      { ref: "native.load" }, { ref: "native.load", success: false },
      { ref: "native.load", success: true, error: "failure" },
      { ref: "native.load", success: true, result: { isError: true } },
      { ref: "native.store", success: true }, { ref: "extensions.load", success: true },
    ]) expect(isRoutineInternalCall(call)).toBe(false);
  });
  it("retains synchronous activity history and scoped labels", () => {
    const store = new FabricActivityStore();
    store.start("run");
    store.beginCall("run", { callId: "load", ref: "native.load", args: {} });
    store.finishCall("run", "load", { success: true, result: { stored: 42 } });
    store.beginCall("run", { callId: "wait", ref: "tasks.wait", args: { id: "task-123" } });
    const raw = store.get("run")!;
    expect(raw.calls).toHaveLength(2);
    expect(raw.calls[0]?.result).toEqual({ stored: 42 });
    expect(raw.calls[1]?.label).toBe("tasks.wait · task-123");
    expect(raw.calls.filter(call => !isRoutineInternalCall(call))).toHaveLength(1);
  });
});
