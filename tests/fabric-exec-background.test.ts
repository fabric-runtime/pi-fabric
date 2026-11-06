import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeFabricConfig } from "../src/config.js";
import { FabricProgramTasks } from "../src/core/program-tasks.js";
import { ShellEventInbox, SHELL_AWARENESS_MESSAGE_TYPE, SHELL_MESSAGE_TYPE } from "../src/core/shell-inbox.js";
import { FabricShellJobStore } from "../src/core/shell-jobs.js";
import { FabricShellTimingBridge } from "../src/core/shell-timing.js";
import { createFabricExecTool } from "../src/fabric-exec-tool.js";
import type { FabricState } from "../src/fabric-state.js";
import { registerFabricCommand } from "../src/commands/fabric.js";
import type { FabricUiController } from "../src/ui/controller.js";
import type { CapturedToolCatalog } from "../src/capture/catalog.js";
import { defaultCodePreviewSettings } from "../src/ui/code-preview.js";
import { installFabricShellHangKeys } from "../src/ui/shell-hang-keys.js";

const CTRL_B = "\x02";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const executionResult = (value: unknown, success = true) => ({
  success,
  kernel: "typescript",
  value,
  logs: [],
  audits: [],
  phases: [],
  trace: { outcome: success ? "succeeded" : "failed", operations: [] },
  elapsedMs: 1,
  ...(success ? {} : { error: "bead 3 failed" }),
});

const harness = () => {
  const jobs = new FabricShellJobStore();
  const programTasks = new FabricProgramTasks();
  const pending = deferred<ReturnType<typeof executionResult>>();
  const requests: Array<{ signal?: AbortSignal; onPartial(snapshot: unknown): void }> = [];
  const state = {
    bootstrapped: true,
    initialized: true,
    config: normalizeFabricConfig({}),
    ensure: vi.fn(async () => {}),
    claimHandoff: vi.fn(async () => undefined),
    prewalk: { planRequired: () => false, status: () => ({ state: "idle" }) },
    programTasks,
    get shellJobs() { return jobs; },
    execution: {
      execute: vi.fn((request: { signal?: AbortSignal; onPartial(snapshot: unknown): void }) => {
        requests.push(request);
        request.onPartial({ audits: [], phases: [], progress: "run implement hbox-1" });
        return pending.promise;
      }),
    },
  } as unknown as FabricState;
  const tool = createFabricExecTool(state, defaultCodePreviewSettings(), new Map(), (value) => value);
  const context = {
    mode: "tui",
    hasUI: true,
    cwd: process.cwd(),
    ui: { setTitle: () => {}, setStatus: () => {}, notify: () => {} },
    sessionManager: { getEntries: () => [], getSessionId: () => "session-1", getSessionName: () => "bg" },
  };
  const events: Array<{ type: string; output?: string }> = [];
  jobs.subscribe((event) => { events.push({ type: event.type, ...(event.output ? { output: event.output } : {}) }); });
  cleanups.push(() => jobs.close());
  const run = (params: Record<string, unknown>, signal?: AbortSignal, onUpdate = vi.fn()) =>
    tool.execute!("call-1", { code: "return await workflow();", display: { name: "seven beads" }, ...params } as never, signal, onUpdate, context as never);
  return { jobs, programTasks, pending, requests, state, tool, run, events };
};

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map((part) => part.text ?? "").join("\n");

describe("fabric_exec background programs", () => {
  it("backgrounds the entire awaited workflow on command without restarting or spilling its nested shell", async () => {
    const h = harness();
    const parent = new AbortController();
    const call = h.run({}, parent.signal);
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    const nested = h.jobs.begin("bash", "required remote validation");
    const notify = vi.fn();
    let command: any;
    const pi = { registerCommand: (_name: string, value: any) => { command = value; } } as unknown as ExtensionAPI;
    registerFabricCommand(pi, { state: h.state, fabricUi: {} as FabricUiController,
      capturedTools: {} as CapturedToolCatalog, applyFabricMode() {}, suspendToolCapture() {} });
    const initialized = vi.mocked(h.state.ensure).mock.calls.length;
    expect(h.jobs.list().filter(job => job.tool === "fabric_exec")).toHaveLength(0);
    expect(command.getArgumentCompletions("back")).toContainEqual({ value: "background", label: "background" });
    await command.handler("background", { mode: "tui", ui: { notify } });
    const receipt = await call;
    expect(textOf(receipt)).toContain("end this turn if you need the result");
    expect(textOf(receipt)).toContain("Do not start the same program again");
    expect(h.state.ensure).toHaveBeenCalledTimes(initialized);
    expect(h.requests).toHaveLength(1);
    expect(nested.spilled).toBe(false);
    expect(nested.abort.signal.aborted).toBe(false);
    parent.abort();
    expect(h.requests[0]!.signal!.aborted).toBe(false);
    const [job] = h.jobs.list().filter(job => job.tool === "fabric_exec");
    expect(job!.finishedAt).toBeUndefined();
    await command.handler("background", { mode: "tui", ui: { notify } });
    expect(h.jobs.list().filter(job => job.tool === "fabric_exec")).toHaveLength(1);
    h.pending.resolve(executionResult({ verified: true }));
    await vi.waitFor(() => expect(h.events.some(event => event.type === "finished" && event.output?.includes("verified"))).toBe(true));
    expect(h.state.claimHandoff).not.toHaveBeenCalled();
    const schema = JSON.stringify(h.tool.parameters);
    expect(schema).toContain("keep dependent awaits inside this program");
    expect(schema).toContain("Backgrounding is not task completion");
  });

  it("detaches a running program, frees the tool call, and finishes the task with the program's result", async () => {
    const h = harness();
    const parent = new AbortController();
    const onUpdate = vi.fn();
    const call = h.run({}, parent.signal, onUpdate);
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    expect(h.programTasks.waiting()).toBe(1);
    expect(h.programTasks.detachWaiting()).toBe(1);

    const result = await call;
    const [job] = h.jobs.list();
    expect(textOf(result)).toContain(`moved to the background by the user after 1s as task ${job!.id}`);
    expect(result).not.toMatchObject({ isError: true });
    expect(job).toMatchObject({ tool: "fabric_exec", status: "spilled", description: "seven beads" });
    expect(h.programTasks.waiting()).toBe(0);

    // Pi's tool signal no longer owns the program once it is detached.
    parent.abort();
    expect(h.requests[0]!.signal!.aborted).toBe(false);
    h.requests[0]!.onPartial({ audits: [], phases: [], progress: "run implement hbox-2" });
    expect(onUpdate).toHaveBeenCalledTimes(1);

    h.pending.resolve(executionResult({ closed: 7 }));
    // finished is set before asynchronous log cleanup and event delivery.
    await vi.waitFor(() => expect(h.events.some((event) => event.type === "finished")).toBe(true));
    const finished = h.events.find((event) => event.type === "finished");
    expect(finished?.output).toContain("run implement hbox-2");
    expect(finished?.output).toContain("closed");
    expect(h.jobs.get(job!.id)!.info()).toMatchObject({ status: "exited", exitCode: 0 });
    expect(h.state.claimHandoff).not.toHaveBeenCalled();
  });

  it("starts in the background when the model asks, and a failed program finishes as failed", async () => {
    const h = harness();
    const result = await h.run({ background: true });
    const [job] = h.jobs.list();
    expect(textOf(result)).toContain(`started in the background as task ${job!.id}`);
    h.pending.resolve(executionResult(undefined, false));
    // finished is set before asynchronous log cleanup and event delivery.
    await vi.waitFor(() => expect(h.events.some((event) => event.type === "finished")).toBe(true));
    expect(h.jobs.get(job!.id)!.info()).toMatchObject({ status: "failed", exitCode: 1 });
    expect(h.events.find((event) => event.type === "finished")?.output).toContain("bead 3 failed");
  });

  it("stops the program through its task, and keeps foreground programs on Pi's signal", async () => {
    const h = harness();
    const call = h.run({ background: true });
    await call;
    const [job] = h.jobs.list();
    expect(h.jobs.stop(job!.id)).toBe(true);
    expect(h.requests[0]!.signal!.aborted).toBe(true);
    h.pending.resolve(executionResult(undefined, false));
    await vi.waitFor(() => expect(h.jobs.get(job!.id)!.info().status).toBe("killed"));

    const foreground = harness();
    const parent = new AbortController();
    const running = foreground.run({}, parent.signal);
    await vi.waitFor(() => expect(foreground.requests).toHaveLength(1));
    parent.abort();
    expect(foreground.requests[0]!.signal!.aborted).toBe(true);
    foreground.pending.resolve(executionResult({ ok: true }));
    expect(textOf(await running)).toContain("ok");
    expect(foreground.jobs.list()).toEqual([]);
    expect(foreground.programTasks.waiting()).toBe(0);
  });
});

describe("Ctrl+B chord for programs", () => {
  const keys = (options: { editor?: string; shell?: boolean } = {}) => {
    vi.useFakeTimers();
    const inputs = new Set<(data: string) => unknown>();
    const jobs = new FabricShellJobStore();
    const programs = new FabricProgramTasks();
    const run = programs.begin({ code: "return 1;", jobs: () => jobs });
    const shell = options.shell ? jobs.begin("bash", "sleep 30") : undefined;
    const notify = vi.fn();
    const context = {
      mode: "tui",
      ui: {
        notify,
        getEditorText: () => options.editor ?? "",
        onTerminalInput: (handler: (data: string) => unknown) => {
          inputs.add(handler);
          return () => { inputs.delete(handler); };
        },
      },
    } as unknown as ExtensionContext;
    const dispose = installFabricShellHangKeys(context, {
      enabled: () => true, ownsInput: () => false, jobs: () => jobs, programs: () => programs,
    });
    cleanups.push(async () => { dispose(); shell?.abort.abort(); await jobs.close(); });
    return { run, shell, notify, input: (data: string) => [...inputs].map((input) => input(data)).find((value) => value !== undefined) };
  };

  it("moves the running program to the background from an empty editor", () => {
    const k = keys();
    expect(k.input(CTRL_B)).toEqual({ consume: true });
    expect(k.run.job).toBeUndefined();
    expect(k.input(CTRL_B)).toEqual({ consume: true });
    expect(k.run.job).toMatchObject({ tool: "fabric_exec", spilled: true });
    expect(k.notify).toHaveBeenCalledWith(expect.stringContaining("program moved to the background"), "info");
  });

  it("leaves Ctrl+B as cursor-left while the editor has text", () => {
    const k = keys({ editor: "steer: uplift" });
    expect(k.input(CTRL_B)).toBeUndefined();
    expect(k.input(CTRL_B)).toBeUndefined();
    expect(k.run.job).toBeUndefined();
  });

  it("spills a waiting nested shell before the program", () => {
    const k = keys({ shell: true });
    k.input(CTRL_B);
    k.input(CTRL_B);
    expect(k.shell!.spilled).toBe(true);
    expect(k.run.job).toBeUndefined();
  });
});

describe("background program delivery", () => {
  it("wakes the owner with the program result, and keeps programs out of shell timing", async () => {
    vi.useFakeTimers();
    const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
    const sendMessage = vi.fn();
    const timing = vi.fn();
    const ctx = { hasUI: true, ui: { notify: vi.fn() }, isIdle: () => true, hasPendingMessages: () => false } as unknown as ExtensionContext;
    const pi = { sendMessage, on: (name: string, fn: any) => { handlers.set(name, fn); return () => handlers.delete(name); } } as unknown as ExtensionAPI;
    const jobs = new FabricShellJobStore();
    const inbox = new ShellEventInbox(pi, ctx, jobs);
    const bridge = new FabricShellTimingBridge({ emit: timing } as unknown as ExtensionAPI["events"], "session-1", jobs);
    cleanups.push(async () => { bridge.close(); inbox.close(); await jobs.close(); });
    const run = new FabricProgramTasks().begin({ code: "return 1;", description: "seven beads", jobs: () => jobs });
    expect(run.detach()).toBe(true);

    expect(handlers.get("context")!({ type: "context", messages: [] }, ctx)).toBeUndefined();
    const awareness = handlers.get("tool_result")!({ type: "tool_result", toolCallId: "call", content: [], isError: false }, ctx);
    expect(awareness.content[0].text).toContain(`[${SHELL_AWARENESS_MESSAGE_TYPE}]`);
    expect(awareness.content[0].text).toContain("background fabric_exec program; completion wakes agent");

    await run.complete(`{"closed":7}\n${"x".repeat(3000)}`, true);
    await vi.advanceTimersByTimeAsync(100);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [message] = sendMessage.mock.calls[0]!;
    expect(message.customType).toBe(SHELL_MESSAGE_TYPE);
    expect(message.content).toContain("Automated background task events");
    expect(message.content).toContain(`Background fabric_exec program ${run.job!.id}: succeeded`);
    expect(message.content).toContain('{"closed":7}');
    expect(timing).not.toHaveBeenCalled();
  });
});
