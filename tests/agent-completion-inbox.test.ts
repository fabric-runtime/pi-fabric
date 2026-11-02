import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentCompletionInbox, AGENT_COMPLETION_MESSAGE_TYPE } from "../src/agents/completion-inbox.js";
import type { AgentRunResult } from "../src/agents/types.js";

type Handler = (event: any, context: ExtensionContext) => unknown;
const inboxes: AgentCompletionInbox[] = [];
const result = (id: string, extra: Partial<AgentRunResult> = {}): AgentRunResult => ({
  id, name: `worker ${id}`, status: "completed", text: `result ${id}`, startedAt: 1, finishedAt: 2,
  task: "work", runner: "pi", transport: "process", cwd: ".", updatedAt: 2, turns: 1, toolCalls: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, ...extra,
});
const harness = () => {
  let idle = false;
  let pending = false;
  const handlers = new Map<string, Handler>();
  const sendMessage = vi.fn();
  const notify = vi.fn();
  const context = { hasUI: true, ui: { notify }, isIdle: () => idle, hasPendingMessages: () => pending } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    }, sendMessage,
  } as unknown as ExtensionAPI;
  const inbox = new AgentCompletionInbox(pi, context);
  inboxes.push(inbox);
  return {
    inbox, context, handlers, sendMessage, notify,
    idle: (value = true) => { idle = value; },
    pending: (value = true) => { pending = value; },
    emit: (name: string, event: unknown = {}) => handlers.get(name)?.(event, context),
    boundary: (stopReason = "toolUse") => handlers.get("turn_end")?.({ message: { role: "assistant", stopReason } }, context),
  };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const inbox of inboxes.splice(0)) inbox.close();
  vi.useRealTimers();
});

describe("AgentCompletionInbox", () => {
  it("stays inert when ExtensionAPI.on is missing or does not return unsubscribe", () => {
    const context = { hasUI: false, isIdle: () => true, hasPendingMessages: () => false } as unknown as ExtensionContext;
    const missing = new AgentCompletionInbox({ sendMessage: vi.fn() } as unknown as ExtensionAPI, context);
    inboxes.push(missing);
    expect(() => missing.close()).not.toThrow();
    const noUnsub = new AgentCompletionInbox({
      on: () => undefined, sendMessage: vi.fn(),
    } as unknown as ExtensionAPI, context);
    inboxes.push(noUnsub);
    expect(() => noUnsub.close()).not.toThrow();
  });

  it("shows concise status immediately but batches unread results only after the entire tool turn", async () => {
    const h = harness();
    h.inbox.enqueue(result("a"));
    h.inbox.enqueue(result("b", { status: "failed", error: "OAuth expired", text: "partial output" }));
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("OAuth expired"), "warning");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sendMessage).not.toHaveBeenCalled();
    h.boundary();
    expect(h.sendMessage).toHaveBeenCalledOnce();
    const [message, options] = h.sendMessage.mock.calls[0]!;
    expect(message).toMatchObject({ customType: AGENT_COMPLETION_MESSAGE_TYPE, display: false, details: { ids: ["a", "b"] } });
    expect(message.content).toContain("result a");
    expect(message.content).toContain("OAuth expired");
    expect(message.content).toContain("partial output");
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
    h.idle();
    h.emit("agent_settled");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sendMessage).toHaveBeenCalledOnce();
  });

  it.each(["headless", "broken UI"])("delivers hidden steering once with %s", mode => {
    const h = harness();
    if (mode === "headless") Object.assign(h.context, { hasUI: false });
    else h.notify.mockImplementation(() => { throw new Error("closed UI"); });
    const delivered = vi.fn();
    expect(() => h.inbox.enqueue(result("a"), delivered)).not.toThrow();
    h.boundary(); h.boundary();
    expect(h.sendMessage).toHaveBeenCalledOnce();
    expect(h.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ display: false }), { deliverAs: "steer", triggerTurn: true });
    expect(delivered).toHaveBeenCalledOnce();
    if (mode === "headless") expect(h.notify).not.toHaveBeenCalled();
  });

  it("retracts a completion consumed by a later wait in the same tool batch", async () => {
    const h = harness();
    h.inbox.enqueue(result("a"));
    h.inbox.acknowledge("a");
    h.boundary("stop");
    h.idle();
    h.emit("agent_settled");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledOnce();
  });

  it("preserves other unread Promise.allSettled spawn results when one is consumed", () => {
    const h = harness();
    for (const id of ["a", "b", "c"]) h.inbox.enqueue(result(id));
    h.inbox.acknowledge("b");
    h.boundary();
    expect(h.sendMessage.mock.calls[0]![0].details.ids).toEqual(["a", "c"]);
  });

  it("wakes idle Main once for asynchronous spawned completions", async () => {
    const h = harness();
    h.idle();
    h.inbox.enqueue(result("a"));
    h.inbox.enqueue(result("b"));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sendMessage).toHaveBeenCalledOnce();
    h.inbox.enqueue(result("a"));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sendMessage).toHaveBeenCalledOnce();
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("rechecks idleness rather than racing a new user tool batch", async () => {
    const h = harness();
    h.idle();
    h.inbox.enqueue(result("a"));
    h.idle(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sendMessage).not.toHaveBeenCalled();
    h.inbox.acknowledge("a");
    h.boundary();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("does not compete with already queued user input", async () => {
    const h = harness();
    h.idle();
    h.pending();
    h.inbox.enqueue(result("a"));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sendMessage).not.toHaveBeenCalled();
    h.pending(false);
    h.boundary();
    expect(h.sendMessage).toHaveBeenCalledOnce();
  });

  it.each(["aborted", "error"])("does not restart Main after %s; results remain for the next input", async (reason) => {
    const h = harness();
    h.inbox.enqueue(result("a"));
    h.boundary(reason);
    h.idle();
    h.emit("agent_settled");
    h.inbox.enqueue(result("b"));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sendMessage).not.toHaveBeenCalled();
    h.emit("input");
    h.idle(false);
    const resumed = h.emit("before_agent_start") as { message: { details: { ids: string[] } } };
    expect(resumed.message.details.ids).toEqual(["a", "b"]);
    h.boundary();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("resumes after an automatically recovered error without requiring input", async () => {
    const h = harness();
    h.boundary("error");
    h.inbox.enqueue(result("during-retry"));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sendMessage).not.toHaveBeenCalled();
    h.boundary("stop");
    expect(h.sendMessage).toHaveBeenCalledOnce();
    h.idle(); h.emit("agent_settled", { aborted: false });
    h.inbox.enqueue(result("after-recovery"));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
  });

  it.each(["busy", "queued input"])("rechecks delivery when %s clears without a lifecycle event", async blocked => {
    const h = harness();
    if (blocked === "queued input") { h.idle(); h.pending(); }
    h.inbox.enqueue(result("a"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.sendMessage).not.toHaveBeenCalled();
    h.idle(); h.pending(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sendMessage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.sendMessage).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors signal-free settled aborts even across subsequent healthy boundaries", async () => {
    const h = harness();
    h.emit("agent_settled", { aborted: true });
    h.boundary("error"); h.boundary("stop");
    h.inbox.enqueue(result("a")); h.idle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sendMessage).not.toHaveBeenCalled();
    h.emit("input");
    expect(h.emit("before_agent_start")).toMatchObject({ message: { details: { ids: ["a"] } } });
  });

  it("cancels a deferred retry on close without acknowledging its result", async () => {
    const h = harness(); const delivered = vi.fn();
    h.inbox.enqueue(result("a"), delivered);
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(1);
    h.inbox.close(); h.idle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks the abort signal even before the aborted turn event arrives", async () => {
    const h = harness();
    Object.defineProperty(h.context, "signal", { value: AbortSignal.abort() });
    h.idle();
    h.inbox.enqueue(result("a"));
    await vi.advanceTimersByTimeAsync(100);
    h.boundary();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("acknowledges durable delivery only at the actual boundary", () => {
    const h = harness();
    const delivered = vi.fn();
    h.inbox.enqueue(result("a"), delivered);
    h.inbox.enqueue(result("a"), delivered);
    expect(delivered).not.toHaveBeenCalled();
    h.boundary();
    expect(delivered).toHaveBeenCalledOnce();
    expect(h.sendMessage).toHaveBeenCalledOnce();
  });

  it("keeps a receipt failure from replaying the batch or dropping sibling acknowledgments", () => {
    const h = harness();
    const failedReceipt = vi.fn(() => { throw new Error("disk busy"); });
    const delivered = vi.fn();
    h.inbox.enqueue(result("a"), failedReceipt);
    h.inbox.enqueue(result("b"), delivered);
    expect(() => h.boundary()).not.toThrow();
    expect(delivered).toHaveBeenCalledOnce();
    expect(() => h.inbox.enqueue(result("a"), failedReceipt)).not.toThrow();
    h.boundary();
    expect(failedReceipt).toHaveBeenCalledTimes(2);
    expect(h.sendMessage).toHaveBeenCalledOnce();
  });

  it("remembers abort when settled arrives with a fresh signal-free context", async () => {
    const h = harness();
    Object.defineProperty(h.context, "signal", { value: AbortSignal.abort() });
    h.inbox.enqueue(result("a"));
    const idleContext = { ...h.context, isIdle: () => true, signal: undefined } as unknown as ExtensionContext;
    h.handlers.get("agent_settled")?.({}, idleContext);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("confirms already consumed durable results without displaying or waking again", () => {
    const h = harness();
    const delivered = vi.fn();
    h.inbox.acknowledge("a");
    h.inbox.enqueue(result("a"), delivered);
    h.boundary();
    expect(delivered).toHaveBeenCalledOnce();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("bounds batch content and leaves full results in the agent store", () => {
    const h = harness();
    for (let i = 0; i < 40; i++) h.inbox.enqueue(result(String(i), { text: "x".repeat(50_000), error: "y".repeat(50_000) }));
    h.boundary();
    const first = h.sendMessage.mock.calls[0]![0];
    expect(first.content.length).toBeLessThan(17_000);
    expect(first.content).toContain("agents.wait");
    expect(first.details.ids).toHaveLength(32);
    h.boundary();
    expect(h.sendMessage.mock.calls[1]![0].details.ids).toHaveLength(8);
  });

  it("archives pending old-frontier deliveries on tree navigation", () => {
    const h = harness();
    const delivered = vi.fn();
    h.inbox.enqueue(result("a"), delivered);
    h.emit("session_tree");
    h.boundary();
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(delivered).toHaveBeenCalledOnce();
  });

  it("unsubscribes and leaves undelivered durable results unacknowledged on shutdown", async () => {
    const h = harness();
    const delivered = vi.fn();
    h.idle();
    h.inbox.enqueue(result("a"), delivered);
    h.inbox.close();
    h.inbox.enqueue(result("b"));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.handlers.size).toBe(0);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
  });
});
