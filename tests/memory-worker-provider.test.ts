import { setImmediate as yieldToHost } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { WorkerMemoryProvider } from "../src/memory/worker-provider.js";
import type { MemoryProviderContext } from "../src/providers/memory-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";

const providers: WorkerMemoryProvider[] = [];
const fixtureUrl = new URL("./fixtures/memory-worker.mjs", import.meta.url);
const invocation = (signal?: AbortSignal, update = vi.fn()): FabricInvocationContext => ({
  cwd: process.cwd(), signal, parentToolCallId: "worker-test", nestedToolCallId: "recall",
  extensionContext: {} as FabricInvocationContext["extensionContext"], update,
});
const provider = (options: Partial<MemoryProviderContext> = {}, url = fixtureUrl) => {
  const value = new WorkerMemoryProvider({
    agentDir: "/unused", cwd: process.cwd(), config: DEFAULT_FABRIC_CONFIG.memory, ...options,
  }, url);
  providers.push(value);
  return value;
};
const started = () => {
  let resolve!: () => void;
  const ready = new Promise<void>(done => { resolve = done; });
  return { ready, update: vi.fn(() => resolve()) };
};
afterEach(async () => { await Promise.all(providers.splice(0).map(value => value.close())); });

describe("file memory worker ownership", () => {
  it("uses one worker for a FIFO burst and forwards progress", async () => {
    const memory = provider();
    const context = invocation();
    const completed: number[] = [];
    const results = await Promise.all(Array.from({ length: 13 }, (_, marker) =>
      memory.invoke("recall", { marker }, context).then(value => {
        completed.push(marker);
        return value as { threadId: number; marker: number };
      })));
    expect(new Set(results.map(value => value.threadId)).size).toBe(1);
    expect(results.map(value => value.marker)).toEqual(completed);
    expect(completed).toEqual(Array.from({ length: 13 }, (_, index) => index));
    expect(context.update).toHaveBeenCalledTimes(13);
  });

  it("routes outline through the worker like expand", async () => {
    const memory = provider();
    // The fixture worker echoes {threadId, marker}; an in-process fallback
    // would return a real outline response instead.
    expect(await memory.invoke("outline", { marker: "outline" }, invocation()))
      .toMatchObject({ marker: "outline" });
  });

  it("terminates an active synchronous job on abort, keeps the host responsive, and restarts for queued work", async () => {
    const memory = provider();
    const controller = new AbortController();
    const progress = started();
    const blocked = memory.invoke("recall", { gate: new SharedArrayBuffer(4) }, invocation(controller.signal, progress.update));
    const rejected = expect(blocked).rejects.toThrow("cancel active");
    await progress.ready;
    const next = memory.invoke("recall", { marker: "next" }, invocation());
    await yieldToHost();
    controller.abort(new Error("cancel active"));
    await rejected;
    expect(await next).toMatchObject({ marker: "next" });
  });

  it("cancels queued and pre-aborted calls without sending them or killing their neighbor", async () => {
    const memory = provider();
    const gate = new SharedArrayBuffer(4);
    const progress = started();
    const active = memory.invoke("recall", { gate }, invocation(undefined, progress.update));
    await progress.ready;
    const controller = new AbortController();
    const context = invocation(controller.signal);
    const queued = memory.invoke("recall", { marker: "cancelled" }, context);
    const rejected = expect(queued).rejects.toThrow("cancel queued");
    controller.abort(new Error("cancel queued"));
    await rejected;
    await expect(memory.invoke("recall", {}, context)).rejects.toThrow("cancel queued");
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    const first = await active as { threadId: number };
    const next = await memory.invoke("recall", {}, invocation()) as { threadId: number };
    expect(first.threadId).toBe(next.threadId);
    expect(context.update).not.toHaveBeenCalled();
  });

  it("bounds outstanding calls and rejects every active/queued request on close", async () => {
    const memory = provider();
    const results = Array.from({ length: 64 }, () =>
      memory.invoke("recall", { gate: new SharedArrayBuffer(4) }, invocation()).catch(error => error));
    await expect(memory.invoke("recall", {}, invocation())).rejects.toThrow("queue is full");
    await memory.close();
    for (const result of await Promise.all(results)) expect(result).toMatchObject({ message: "Memory provider is closed" });
    await expect(memory.invoke("recall", {}, invocation())).rejects.toThrow("closed");
  });

  it.each([{ exit: true }, { crash: true }])("settles unexpected worker loss and runs the next request: %j", async args => {
    const memory = provider();
    const failed = memory.invoke("recall", args, invocation());
    const rejected = expect(failed).rejects.toThrow(/exited|crashed/);
    const next = memory.invoke("recall", { marker: "survived" }, invocation());
    await rejected;
    expect(await next).toMatchObject({ marker: "survived" });
  });

  it("releases idle workers and lazily recreates them for later requests", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const memory = provider();
      const first = await memory.invoke("recall", {}, invocation()) as { threadId: number };
      await vi.advanceTimersByTimeAsync(30_000);
      const later = await memory.invoke("recall", {}, invocation()) as { threadId: number };
      expect(later.threadId).not.toBe(first.threadId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves per-request errors without poisoning the worker", async () => {
    const memory = provider();
    await expect(memory.invoke("recall", { error: true }, invocation())).rejects.toMatchObject({ name: "RangeError", message: "fixture request failed" });
    expect(await memory.invoke("sessions", { marker: "after-error" }, invocation())).toMatchObject({ marker: "after-error" });
  });

  it("surfaces worker startup failure instead of silently falling back to blocking execution", async () => {
    const memory = provider({}, new URL("./fixtures/missing-memory-worker.mjs", import.meta.url));
    await expect(memory.invoke("recall", {}, invocation())).rejects.toThrow();
  });

  it("takes live lineage at dispatch, sends IDs only, and rejects navigation during retrieval", async () => {
    const gate = new SharedArrayBuffer(4);
    let leafId = "old";
    const memory = provider({
      sessionId: "current", sessionFile: "/current.jsonl",
      getLiveBranch: () => ({ leafId, entries: [{ id: leafId, message: { content: "not copied" } }] }),
    });
    const progress = started();
    const blocked = memory.invoke("recall", { gate }, invocation(undefined, progress.update));
    const rejected = expect(blocked).rejects.toThrow("branch changed");
    await progress.ready;
    const next = memory.invoke("recall", {}, invocation());
    leafId = "new";
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    await rejected;
    expect(await next).toMatchObject({ branch: { leafId: "new", entries: [{ id: "new" }] } });
    expect((await memory.invoke("recall", { branches: "all" }, invocation()) as { branch: unknown }).branch).toBeUndefined();
    expect((await memory.invoke("recall", { scope: "session:another" }, invocation()) as { branch: unknown }).branch).toBeUndefined();
  });
});
