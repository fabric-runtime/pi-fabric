import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { availablePythonBackends } from "./fixtures/python-backends.js";
import { DEFAULT_FABRIC_CONFIG, normalizeFabricConfig, type FabricConfig } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { HumanWaitDeadlinePause } from "../src/runtime/deadline-pause.js";

const registries: ActionRegistry[] = [];
const controllers: AbortController[] = [];
beforeEach(() => {
  // Only the parent's deadline clock is virtual. Child startup/IPC remain real;
  // tests advance time after a host-call handshake, never after a guessed delay.
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
});
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  vi.useRealTimers();
  await Promise.all(registries.splice(0).map(registry => registry.close()));
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
type PendingCall = { name: string; answer(): void; fail(): void };
const fixture = (configure: (config: FabricConfig) => void, provider = "extensions") => {
  const registry = new ActionRegistry();
  registries.push(registry);
  const aborted: string[] = [];
  const calls: Array<ReturnType<typeof deferred<PendingCall>>> = [];
  const slot = (index: number) => calls[index] ??= deferred<PendingCall>();
  let invoked = 0;
  let observed = 0;
  const descriptor = {
    name: "ask",
    description: "human question stub",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    risk: "read" as const,
  };
  registry.register({
    name: provider,
    description: `fake ${provider}`,
    async list() { return ["ask", "slow", "wait"].map(name => ({ ...descriptor, name })); },
    async describe(name) { return ["ask", "slow", "wait"].includes(name) ? { ...descriptor, name } : undefined; },
    async invoke(name, _args, context) {
      const response = deferred<unknown>();
      const abort = () => { aborted.push(name); response.reject(new Error("aborted")); };
      context.signal?.addEventListener("abort", abort, { once: true });
      if (context.signal?.aborted) abort();
      slot(invoked++).resolve({
        name,
        answer: () => response.resolve({ answer: name }),
        fail: () => response.reject(new Error("question failed")),
      });
      try { return await response.promise; }
      finally { context.signal?.removeEventListener("abort", abort); }
    },
  });
  const config = structuredClone(DEFAULT_FABRIC_CONFIG);
  config.fullCodeMode = true;
  config.approvals.read = "allow";
  configure(config);
  const service = new FabricExecutionService(registry, config);
  const controller = new AbortController();
  controllers.push(controller);
  const run = (code: string) => service.execute({
    code, signal: controller.signal, parentToolCallId: "human-wait",
    context: { cwd: process.cwd(), hasUI: false, sessionManager: {
      getSessionId: () => "human-wait-test", getSessionFile: () => undefined,
    } } as unknown as ExtensionContext,
    onPartial() {},
  });
  return { run, aborted, controller, nextCall: () => slot(observed++).promise };
};

describe("HumanWaitDeadlinePause", () => {
  it("suspends once, resumes once with the saved budget, and applies raised floors", () => {
    const calls: string[] = [];
    let remaining = 300;
    const pause = new HumanWaitDeadlinePause({
      remainingMs: () => remaining,
      suspend: () => calls.push("suspend"),
      resume: (ms) => calls.push(`resume:${ms}`),
    });
    pause.leave();
    expect(calls).toEqual([]);
    pause.enter();
    remaining = 5;
    pause.enter();
    expect(pause.paused).toBe(true);
    pause.leave();
    expect(calls).toEqual(["suspend"]);
    pause.raise(100);
    pause.leave();
    expect(pause.paused).toBe(false);
    expect(calls).toEqual(["suspend", "resume:300"]);
    pause.enter();
    pause.raise(1_000.7);
    pause.leave();
    expect(calls.at(-1)).toBe("resume:1000");
  });
});

describe("executor.humanWaitRefs config", () => {
  it("defaults to extensions.ask and decisions.wait and normalizes exact refs", () => {
    expect(normalizeFabricConfig({}).executor.humanWaitRefs).toEqual(["extensions.ask", "decisions.wait"]);
    expect(normalizeFabricConfig({ executor: { humanWaitRefs: [] } }).executor.humanWaitRefs).toEqual([]);
    expect(normalizeFabricConfig({
      executor: { humanWaitRefs: [" extensions.ask ", "extensions.ask", "", 7, "mcp.q.ask"] },
    }).executor.humanWaitRefs).toEqual(["extensions.ask", "mcp.q.ask"]);
    expect(normalizeFabricConfig({ executor: { humanWaitRefs: "extensions.ask" } }).executor.humanWaitRefs)
      .toEqual(["extensions.ask", "decisions.wait"]);
  });
});

const runtimes = ["quickjs", "node-process", "monty", "cpython"] as const;
describe.each(runtimes)("%s human-wait deadline pause", (runtime) => {
  const python = runtime === "monty" || runtime === "cpython";
  const runTest = it.skipIf(python && !availablePythonBackends[runtime]);
  const configure = (config: FabricConfig): void => {
    config.executor = { ...normalizeFabricConfig({ executor: {
      ...(python ? { kernel: "python", pythonRuntime: runtime } : { runtime }),
      memoryLimitBytes: 256 * 1024 * 1024,
    } }).executor, timeoutMs: 1_000 };
  };
  const call = (name: string, generic = false) => python
    ? `await tools.call(ref="extensions.${name}", args={})`
    : generic ? `await tools.call({ ref: "extensions.${name}", args: {} })` : `await extensions.${name}({})`;

  runTest.each([false, true])("waits past the deadline (generic=%s)", async (generic) => {
    const { run, nextCall, aborted } = fixture(configure);
    const pending = run(`return ${call("ask", generic)}`);
    const question = await nextCall();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(aborted).toEqual([]);
    question.answer();
    expect(await pending).toMatchObject({ success: true, value: { answer: "ask" } });
  });

  runTest.each([false, true])("pauses for a decisions.wait by default (generic=%s)", async (generic) => {
    const { run, nextCall, aborted } = fixture(configure, "decisions");
    const code = python
      ? 'return await tools.call(ref="decisions.wait", args={"id": "dec_1"})'
      : generic
        ? 'return await tools.call({ ref: "decisions.wait", args: { id: "dec_1" } })'
        : 'return await decisions.wait({ id: "dec_1" })';
    const pending = run(code);
    const decision = await nextCall();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(aborted).toEqual([]);
    decision.answer();
    expect(await pending).toMatchObject({ success: true, value: { answer: "wait" } });
  });

  runTest.each(["unlisted", "disabled"])("keeps the normal deadline when %s", async (mode) => {
    const { run, nextCall, aborted } = fixture(config => {
      configure(config);
      if (mode === "disabled") config.executor.humanWaitRefs = [];
    });
    const name = mode === "disabled" ? "ask" : "slow";
    const pending = run(`return ${call(name)}`);
    await nextCall();
    await vi.advanceTimersByTimeAsync(1_001);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    expect(aborted).toContain(name);
  });

  runTest.each(["answer", "fail"] as const)("resumes the saved budget after %s", async (settle) => {
    const { run, nextCall } = fixture(configure);
    const code = python
      ? `try:\n    ${call("ask")}\nexcept Exception:\n    pass\nreturn ${call("slow")}`
      : `try { ${call("ask")}; } catch {} return ${call("slow")};`;
    const pending = run(code);
    const question = await nextCall();
    await vi.advanceTimersByTimeAsync(60_000);
    question[settle]();
    expect((await nextCall()).name).toBe("slow");
    await vi.advanceTimersByTimeAsync(1_001);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  });

  runTest("cancels an entered human wait without waiting for a timer", async () => {
    const { run, nextCall, controller, aborted } = fixture(configure);
    const pending = run(`return ${call("ask")}`);
    await nextCall();
    controller.abort(new Error("user cancelled"));
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cancelled|abort/i);
    expect(aborted).toContain("ask");
  });

  runTest("remains paused until all overlapping questions settle", async () => {
    const { run, nextCall, aborted } = fixture(configure);
    const code = python
      ? 'return await asyncio.gather(tools.call(ref="extensions.ask", args={}), tools.call(ref="extensions.ask", args={}))'
      : 'return await Promise.all([extensions.ask({}), extensions.ask({})]);';
    const pending = run(code);
    const first = await nextCall();
    const second = await nextCall();
    first.answer();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(aborted).toEqual([]);
    second.answer();
    expect(await pending).toMatchObject({ success: true, value: [{ answer: "ask" }, { answer: "ask" }] });
  });
});

const approvalFixture = (configure: (config: FabricConfig) => void, headless: boolean) => {
  const registry = new ActionRegistry();
  registries.push(registry);
  const aborted: string[] = [];
  const prompts: Array<ReturnType<typeof deferred<(approve: boolean) => void>>> = [];
  const slot = (index: number) => prompts[index] ??= deferred<(approve: boolean) => void>();
  let asked = 0;
  let observed = 0;
  let ran = 0;
  const descriptor = {
    name: "act",
    description: "write action stub",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    risk: "write" as const,
  };
  registry.register({
    name: "extensions",
    description: "fake extensions",
    async list() { return [descriptor]; },
    async describe(name) { return name === "act" ? descriptor : undefined; },
    async invoke() { ran++; return { done: true }; },
  });
  const config = structuredClone(DEFAULT_FABRIC_CONFIG);
  config.fullCodeMode = true;
  config.approvals.read = "allow";
  config.approvals.write = "ask";
  if (headless) config.approvals.headless = "decision";
  configure(config);
  const ask = (signal: AbortSignal | undefined) => {
    const answer = deferred<boolean>();
    const onAbort = () => { aborted.push("approval"); answer.resolve(false); };
    signal?.addEventListener("abort", onAbort, { once: true });
    slot(asked++).resolve((approve) => answer.resolve(approve));
    return answer.promise.finally(() => signal?.removeEventListener("abort", onAbort));
  };
  const service = new FabricExecutionService(registry, config);
  if (headless) service.setHeadlessApproval((_action, _reason, signal) => ask(signal));
  const controller = new AbortController();
  controllers.push(controller);
  const ui = {
    notify() {},
    select: async () => (await ask(controller.signal)) ? "Allow once" : "Deny",
  };
  const run = (code: string, hardTimeoutMs?: number) => service.execute({
    code, signal: controller.signal, parentToolCallId: "approval-wait",
    ...(hardTimeoutMs === undefined ? {} : { hardTimeoutMs }),
    context: { cwd: process.cwd(), hasUI: !headless, ...(headless ? {} : { ui }), sessionManager: {
      getSessionId: () => "approval-wait-test", getSessionFile: () => undefined,
    } } as unknown as ExtensionContext,
    onPartial() {},
  });
  return { run, aborted, controller, ran: () => ran, nextPrompt: () => slot(observed++).promise };
};

describe.each(runtimes)("%s approval prompt deadline pause", (runtime) => {
  const python = runtime === "monty" || runtime === "cpython";
  const runTest = it.skipIf(python && !availablePythonBackends[runtime]);
  const deadlineMs = 1_000;
  // One virtual millisecond more than a full budget, so any unpaused deadline has fired.
  const pastDeadlineMs = deadlineMs + 1;
  const configure = (config: FabricConfig): void => {
    config.executor = { ...normalizeFabricConfig({ executor: {
      ...(python ? { kernel: "python", pythonRuntime: runtime } : { runtime }),
      memoryLimitBytes: 256 * 1024 * 1024,
    } }).executor, timeoutMs: deadlineMs };
  };
  const act = python ? 'await tools.call(ref="extensions.act", args={})' : "await extensions.act({})";

  runTest.each(["screen", "headless"] as const)("waits past the deadline for a %s approval", async (surface) => {
    const { run, nextPrompt, aborted, ran } = approvalFixture(configure, surface === "headless");
    const pending = run(`return ${act}`);
    const approve = await nextPrompt();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(aborted).toEqual([]);
    approve(true);
    expect(await pending).toMatchObject({ success: true, value: { done: true } });
    expect(ran()).toBe(1);
  });

  runTest("resumes the saved budget after the approval", async () => {
    const { run, nextPrompt } = approvalFixture(configure, false);
    const code = python
      ? `${act}\nwhile True:\n    await asyncio.sleep(0.05)`
      : `${act}; while (true) await new Promise(resolve => setTimeout(resolve, 50));`;
    const pending = run(code);
    const approve = await nextPrompt();
    await vi.advanceTimersByTimeAsync(60_000);
    approve(true);
    await vi.advanceTimersByTimeAsync(pastDeadlineMs);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  });

  runTest("keeps an explicit hard timeout during an approval", async () => {
    const { run, nextPrompt, ran } = approvalFixture(configure, false);
    const pending = run(`return ${act}`, deadlineMs);
    const approve = await nextPrompt();
    await vi.advanceTimersByTimeAsync(pastDeadlineMs);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    approve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(ran()).toBe(0);
  });

  runTest("cancels an open approval without waiting for a timer", async () => {
    const { run, nextPrompt, controller, aborted, ran } = approvalFixture(configure, false);
    const pending = run(`return ${act}`);
    await nextPrompt();
    controller.abort(new Error("user cancelled"));
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cancelled|abort/i);
    expect(aborted).toContain("approval");
    expect(ran()).toBe(0);
  });
});
