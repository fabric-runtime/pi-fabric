import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const scanControl = vi.hoisted(() => ({
  calls: 0,
  files: undefined as string[] | undefined,
  resolvers: [] as Array<(files: string[]) => void>,
}));

vi.mock("../src/entropy/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/entropy/sessions.js")>();
  return {
    ...actual,
    machineSessionFilesAsync: () => {
      scanControl.calls += 1;
      if (scanControl.files) return Promise.resolve(scanControl.files);
      return new Promise<string[]>((resolve) => scanControl.resolvers.push(resolve));
    },
  };
});

vi.mock("../src/fabric-runtime-state.js", () => ({
  FabricRuntimeState: class {
    initialized = true;
    widgetDismissedAt = 0;
    registry = { list: vi.fn(async () => []) };
    repairs = {
      repairs: [],
      status: () => ({
        enabled: true,
        catalogDigest: "test",
        repairCount: 0,
        applyHits: 0,
        invocationErrors: 0,
        effectDropped: 0,
        fingerprints: [],
        repairs: [],
      }),
    };
    async initialize(): Promise<void> {}
    async shutdown(): Promise<void> {}
    async publishHostLifecycle(): Promise<void> {}
    async settleComponents(): Promise<void> {}
    noteMainActivity(): void {}
    resetSpeculation(): void {}
    dispatchHostEvent(): number { return 0; }
    registerExternal(): void {}
    registerExternalComponent(): void {}
    mcpSlice(): never[] { return []; }
  },
}));

import piFabric from "../src/index.js";
import { BackgroundEntropyCompiler, compileEntropySurface } from "../src/entropy/compiler.js";
import { FileLockTimeoutError } from "../src/core/file-lock.js";
import * as compiledStore from "../src/entropy/compiled-store.js";
import * as activeSurface from "../src/entropy/active.js";
import * as sessions from "../src/entropy/sessions.js";
import * as poolStore from "../src/entropy/pool-store.js";

type ExtensionHandler = (event: unknown, context: ExtensionContext) => unknown;

const tempRoots: string[] = [];
afterEach(() => {
  scanControl.calls = 0;
  scanControl.files = undefined;
  activeSurface.clearActiveCompiledSurface();
  scanControl.resolvers.length = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const createHarness = () => {
  const handlers = new Map<string, ExtensionHandler[]>();
  let command: ((args: string, context: ExtensionContext) => Promise<void>) | undefined;
  const pi = {
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
    getActiveTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    on: vi.fn((event: string, handler: ExtensionHandler) => {
      const values = handlers.get(event) ?? [];
      values.push(handler);
      handlers.set(event, values);
    }),
    registerCommand: vi.fn((_name: string, definition: { handler: typeof command }) => {
      command = definition.handler;
    }),
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, handlers, command: () => command! };
};

const emit = async (
  handlers: Map<string, ExtensionHandler[]>,
  name: string,
  event: unknown,
  context: ExtensionContext,
): Promise<void> => {
  for (const handler of handlers.get(name) ?? []) await handler(event, context);
};

const retryHarness = async (hasUI = false) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-entropy-retry-"));
  tempRoots.push(root);
  const agentDir = path.join(root, "agent");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const file = path.join(root, "session.jsonl");
  fs.writeFileSync(file, "");
  scanControl.files = [file];
  const harness = createHarness();
  await piFabric(harness.pi);
  const context = {
    mode: "code", cwd: root, hasUI, isProjectTrusted: () => true,
    ui: { setStatus: vi.fn(), notify: vi.fn() },
    sessionManager: { getBranch: () => [], getSessionId: () => "retry", getSessionFile: () => file },
  } as unknown as ExtensionContext;
  await harness.command()("repairs", context);
  return {
    agentDir,
    context,
    trigger: async () => {
      await emit(harness.handlers, "tool_execution_end", { toolName: "fabric_exec", isError: false }, context);
      await emit(harness.handlers, "turn_end", {}, context);
    },
    shutdown: (reason = "quit") => emit(harness.handlers, "session_shutdown", { reason }, context),
    restart: () => emit(harness.handlers, "session_start", {}, context),
  };
};

const installLiveLock = (agentDir: string, name: string) => {
  const lock = path.join(agentDir, "fabric", "entropy", name);
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner"), `live\n${process.pid}\n${Date.now() - 60_000}\n`);
  return lock;
};

const mockRetryIO = () => {
  vi.spyOn(compiledStore, "loadCompiledSurfaceAsync").mockResolvedValue({});
  vi.spyOn(sessions, "sessionWindowEvidenceAsync").mockResolvedValue({
    traceWindows: [], traces: [], valueObservations: [], auditCalls: [], observationWindows: [],
  });
  const compile = vi.spyOn(BackgroundEntropyCompiler.prototype, "compile").mockResolvedValue(
    compileEntropySurface({ traces: [], surface: { version: 1, actions: [] } }),
  );
  const update = vi.spyOn(poolStore, "updateObservationPoolAsync").mockRejectedValue(new FileLockTimeoutError("busy"));
  return { compile, update };
};

describe("entropy background scheduler", () => {
  it("silently persists and activates improved entropy plans in UI sessions", async () => {
    const harness = await retryHarness(true);
    const outcome = compileEntropySurface({ traces: [], surface: { version: 1, actions: [{
      ref: "mcp.render", inputSchema: { type: "object", additionalProperties: false,
        properties: { format: { type: "string", enum: ["pdf", "html"] } }, required: ["format"] },
    }] } });
    expect(outcome.status).toBe("compiled");
    const artifact = outcome.artifact!;
    const previous = { ...artifact, gate: { ...artifact.gate, afterScore: outcome.report.score + 1 } };
    vi.spyOn(compiledStore, "loadCompiledSurfaceAsync").mockResolvedValue({ file: previous });
    vi.spyOn(BackgroundEntropyCompiler.prototype, "compile").mockResolvedValue(outcome);
    const save = vi.spyOn(compiledStore, "saveCompiledSurfaceAsync").mockResolvedValue({ file: artifact, written: true });
    const active = vi.spyOn(activeSurface, "setActiveCompiledSurface");
    vi.mocked(harness.context.ui.notify).mockClear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await harness.trigger();
    await vi.advanceTimersByTimeAsync(250);
    await harness.shutdown();
    expect(save).toHaveBeenCalledWith(harness.agentDir, artifact);
    expect(active).toHaveBeenCalledWith(artifact);
    expect(harness.context.ui.notify).not.toHaveBeenCalled();
  });

  it("compiles despite a live pool lock and retries without another user turn", async () => {
    const harness = await retryHarness();
    const lock = installLiveLock(harness.agentDir, "observation-pool.lock");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const compile = vi.spyOn(BackgroundEntropyCompiler.prototype, "compile");
    await harness.trigger();
    expect(compile).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(1));
    expect(fs.existsSync(lock)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    fs.rmSync(lock, { recursive: true });
    await vi.waitFor(async () => expect((await poolStore.loadObservationPoolAsync(harness.agentDir)).file).toBeDefined(), { timeout: 3_000 });
    await harness.shutdown();
    expect(compile).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("activates proven plans while their store is busy and persists them after release", async () => {
    const harness = await retryHarness();
    const lock = installLiveLock(harness.agentDir, "compiled.lock");
    const outcome = compileEntropySurface({ traces: [], surface: { version: 1, actions: [{
      ref: "mcp.render", inputSchema: { type: "object", additionalProperties: false,
        properties: { format: { type: "string", enum: ["pdf", "html"] } }, required: ["format"] },
    }] } });
    expect(outcome.artifact).toBeDefined();
    vi.spyOn(BackgroundEntropyCompiler.prototype, "compile").mockResolvedValue(outcome);
    const active = vi.spyOn(activeSurface, "setActiveCompiledSurface");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await harness.trigger();
    await vi.waitFor(() => expect(active).toHaveBeenCalledWith(outcome.artifact), { timeout: 2_000 });
    expect(fs.existsSync(lock)).toBe(true);
    expect((await compiledStore.loadCompiledSurfaceAsync(harness.agentDir)).file).toBeUndefined();
    fs.rmSync(lock, { recursive: true });
    await vi.waitFor(async () => expect((await compiledStore.loadCompiledSurfaceAsync(harness.agentDir)).file).toEqual(outcome.artifact), { timeout: 3_000 });
    await harness.shutdown();
    expect(warn).not.toHaveBeenCalled();
  });

  it("backs off through one unref'ed timer, caps retries, and cancels them on shutdown", async () => {
    const harness = await retryHarness();
    const { compile, update } = mockRetryIO();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const timers = vi.spyOn(globalThis, "setTimeout");
    await harness.trigger();
    await vi.advanceTimersByTimeAsync(250);
    expect(compile).toHaveBeenCalledTimes(1);
    for (const delay of [500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000]) {
      expect(vi.getTimerCount()).toBe(1);
      expect(timers.mock.lastCall?.[1]).toBe(delay);
      expect(timers.mock.results.at(-1)!.value.hasRef()).toBe(false);
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(update).toHaveBeenCalledTimes(8);
    await harness.shutdown();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(update).toHaveBeenCalledTimes(8);
  });

  it.each(["reload", "new", "resume", "fork"])("settles queued entropy work before %s makes the captured context stale", async (reason) => {
    const harness = await retryHarness();
    const { compile, update } = mockRetryIO();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sessionFile = harness.context.sessionManager.getSessionFile();
    const getSessionFile = vi.spyOn(harness.context.sessionManager, "getSessionFile");
    let stale = false;
    getSessionFile.mockImplementation(() => {
      if (stale) throw new Error("This extension ctx is stale after session replacement or reload");
      return sessionFile;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await harness.trigger();
    await harness.trigger();
    let stopped = false;
    const shutdown = harness.shutdown(reason).then(() => { stopped = true; });
    expect(stopped).toBe(false);
    // Pi invalidates the old context only after all shutdown handlers settle.
    await vi.advanceTimersByTimeAsync(500);
    await shutdown;
    expect(compile).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(2);
    stale = true;
    const reads = getSessionFile.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getSessionFile).toHaveBeenCalledTimes(reads);
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("cancels old-session retries on session start", async () => {
    const harness = await retryHarness();
    const { update } = mockRetryIO();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await harness.trigger();
    await vi.advanceTimersByTimeAsync(250);
    expect(update).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await harness.restart();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(update).toHaveBeenCalledTimes(1);
    await harness.shutdown();
  });

  it.each(["restart", "shutdown"] as const)("does not rearm a retry completing during %s", async (action) => {
    const harness = await retryHarness();
    const { update } = mockRetryIO();
    let reject!: (error: Error) => void;
    update.mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await harness.trigger();
    await vi.advanceTimersByTimeAsync(250);
    expect(update).toHaveBeenCalledTimes(1);
    const lifecycle = harness[action]();
    reject(new FileLockTimeoutError("busy"));
    await lifecycle;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(update).toHaveBeenCalledTimes(1);
    if (action === "restart") await harness.shutdown();
  });

  it("resets backoff after recovery and lets new turns supersede an idle retry", async () => {
    const harness = await retryHarness();
    const { update } = mockRetryIO();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const timers = vi.spyOn(globalThis, "setTimeout");
    await harness.trigger();
    await vi.advanceTimersByTimeAsync(750);
    expect(update).toHaveBeenCalledTimes(2);
    expect(timers.mock.lastCall?.[1]).toBe(1_000);
    update.mockResolvedValue({ file: { version: 1, entries: [], tracked: [], baked: [] }, written: true });
    await harness.trigger();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(update).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    update.mockRejectedValue(new FileLockTimeoutError("busy again"));
    await harness.trigger();
    await vi.advanceTimersByTimeAsync(250);
    expect(timers.mock.lastCall?.[1]).toBe(500);
    await harness.shutdown();
  });

  it("reports real pool errors, continues compilation, and does not retry them as contention", async () => {
    const harness = await retryHarness();
    const { compile, update } = mockRetryIO();
    update.mockRejectedValue(new Error("damaged pool"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await harness.trigger();
    await vi.advanceTimersByTimeAsync(250);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[pi-fabric] observation pool update failed: damaged pool");
    expect(vi.getTimerCount()).toBe(0);
    await harness.shutdown();
  });


  it("reuses discovery but still compiles each turn and skips unchanged pool writes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-entropy-background-"));
    tempRoots.push(root);
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));
    const file = path.join(root, "session.jsonl");
    fs.writeFileSync(file, "");
    const compile = vi.spyOn(BackgroundEntropyCompiler.prototype, "compile");
    const save = vi.spyOn(poolStore, "updateObservationPoolAsync");
    const harness = createHarness();
    await piFabric(harness.pi);
    const context = {
      mode: "code", cwd: root, hasUI: false, isProjectTrusted: () => true,
      ui: { setStatus: vi.fn(), notify: vi.fn() },
      sessionManager: { getBranch: () => [], getSessionId: () => "cached", getSessionFile: () => file },
    } as unknown as ExtensionContext;
    await harness.command()("repairs", context);
    const trigger = async () => {
      await emit(harness.handlers, "tool_execution_end", { toolName: "fabric_exec", isError: false }, context);
      await emit(harness.handlers, "turn_end", {}, context);
    };
    await trigger();
    await vi.waitFor(() => expect(scanControl.calls).toBe(1));
    scanControl.resolvers.shift()!([file]);
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(1));
    await trigger();
    await vi.waitFor(() => expect(compile).toHaveBeenCalledTimes(2));
    await emit(harness.handlers, "session_shutdown", {}, context);
    expect(scanControl.calls).toBe(1);
    expect(save).toHaveBeenCalledTimes(2);
    expect((await save.mock.results[0]!.value).written).toBe(true);
    expect((await save.mock.results[1]!.value).written).toBe(false);
    expect(compile.mock.calls[1]![0].windows).toEqual([{ file, traces: [] }]);
  });

  it("returns turn hooks immediately, coalesces pending turns, and flushes on shutdown", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-entropy-background-"));
    tempRoots.push(root);
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));
    const harness = createHarness();
    await piFabric(harness.pi);
    const context = {
      mode: "code",
      cwd: root,
      hasUI: false,
      isProjectTrusted: () => true,
      ui: { setStatus: vi.fn(), notify: vi.fn() },
      sessionManager: { getBranch: () => [], getSessionId: () => "background-session" },
    } as unknown as ExtensionContext;
    await harness.command()("repairs", context);

    const trigger = async (): Promise<void> => {
      await emit(
        harness.handlers,
        "tool_execution_end",
        { toolName: "fabric_exec", isError: false },
        context,
      );
      await emit(harness.handlers, "turn_end", {}, context);
    };

    await trigger();
    expect(scanControl.calls).toBe(0);
    await vi.waitFor(() => expect(scanControl.calls).toBe(1), { timeout: 1_000 });
    await trigger();
    await trigger();
    expect(scanControl.calls).toBe(1);

    scanControl.resolvers.shift()!([]);
    await vi.waitFor(() => expect(scanControl.calls).toBe(2), { timeout: 1_000 });
    expect(scanControl.resolvers).toHaveLength(1);
    scanControl.resolvers.shift()!([]);
    await emit(harness.handlers, "session_shutdown", {}, context);
    expect(scanControl.calls).toBe(2);
  });
});
