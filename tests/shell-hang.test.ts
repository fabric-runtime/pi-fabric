import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricShellJobStore } from "../src/core/shell-jobs.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import { normalizeFabricConfig } from "../src/config.js";

const stores: FabricShellJobStore[] = [];
const registries: ActionRegistry[] = [];

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  await Promise.all(stores.splice(0).map((jobs) => jobs.close()));
});

const invokeBash = async (
  command: string,
  hangMs: number,
  signal?: AbortSignal,
  extra: Record<string, unknown> = {},
) => {
  const jobs = new FabricShellJobStore();
  stores.push(jobs);
  const provider = new PiToolsProvider(process.cwd(), undefined, undefined, {
    powerShellToolDefinitionFactory: undefined,
    getShellHangMs: () => hangMs,
    shellJobs: jobs,
  });
  const registry = new ActionRegistry();
  registry.register(provider);
  registries.push(registry);
  const result = await registry.invoke(
    "pi.bash",
    { command, ...extra },
    {
      cwd: process.cwd(),
      signal: signal ?? new AbortController().signal,
      parentToolCallId: "parent",
      nestedToolCallId: "fabric_test-hang",
      extensionContext: {
        cwd: process.cwd(),
        sessionManager: {
          getSessionId: () => "hang-test",
          getSessionFile: () => undefined,
        },
      } as unknown as ExtensionContext,
      update: () => undefined,
      approve: async () => {},
      audits: [],
      maxResultChars: 100_000,
    },
  ) as {
    ok: boolean;
    output: string;
    details: {
      running?: boolean;
      taskId?: string;
      pid?: number;
      logPath?: string;
      elapsedMs?: number;
    } | null;
  };
  return { result, jobs };
};

// A detached Windows shell can be reaped before a signal probe observes it.
// The spill contract and tracked PID are asserted on every platform.
const windowsShell = process.platform === "win32";
const PID_PROBE_EXACT = !windowsShell;

describe("pi.bash auto-spill", () => {
  it("tracks a real detached nonzero exit, task ID, cwd, and terminal event", async () => {
    const { result, jobs } = await invokeBash("printf start; sleep 0.3; printf failed; exit 7", 0, undefined, { background: true, description: "Failing build" });
    expect(result.details?.taskId).toEqual(expect.any(String));
    const job = jobs.get(result.details!.taskId!)!;
    await vi.waitFor(() => expect(job.info().finishedAt).toBeDefined(), { timeout: 5000 });
    expect(job.info()).toMatchObject({ status: "failed", exitCode: 7, description: "Failing build", cwd: process.cwd() });
    expect(await job.outputText()).toContain("failed");
  });

  it("hands off a background command that exits before its pid is read", async () => {
    // A loaded host can finish a short command before the pid poll's next tick.
    const begin = FabricShellJobStore.prototype.begin;
    vi.spyOn(FabricShellJobStore.prototype, "begin").mockImplementation(function (this: FabricShellJobStore, ...args) {
      const job = begin.apply(this, args);
      const readPid = job.readPid.bind(job);
      job.readPid = async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return readPid();
      };
      return job;
    });
    const { result, jobs } = await invokeBash("printf start; exit 7", 0, undefined, { background: true, description: "Quick failure", timeout: 30 });
    expect(result.ok).toBe(true);
    expect(result.details).toMatchObject({ taskId: expect.any(String), running: false });
    const job = jobs.get(result.details!.taskId!)!;
    expect(job.info()).toMatchObject({ status: "failed", exitCode: 7, description: "Quick failure" });
    expect(await job.outputText()).toContain("start");
    expect(result.output).toContain("Exited with code 7");
    expect(result.output).not.toContain("Still running");
    expect(result.output).not.toContain("bounds the process");
  });

  it("starts an opt-in monitor on the protected shell path and stops it at its deadline", async () => {
    const { result, jobs } = await invokeBash("printf 'CI: waiting\\n'; sleep 8", 0, undefined, { monitor: { delivery: "ui", timeoutMs: 1000, intervalMs: 1000 } });
    const job = jobs.get(result.details!.taskId!)!;
    expect(job.info().monitor?.delivery).toBe("ui");
    await vi.waitFor(() => expect(job.info().finishedAt).toBeDefined(), { timeout: 5000 });
    expect(job.info().status).toBe("timed_out");
    expect(job.abort.signal.aborted).toBe(true);
  });

  it("requires explicit valid monitor delivery before creating a shell job", async () => {
    await expect(invokeBash("echo forbidden", 0, undefined, { monitor: {} })).rejects.toThrow();
    await expect(invokeBash("echo forbidden", 0, undefined, { background: false, monitor: { delivery: "wake" } })).rejects.toThrow("background:false");
  });
  it("spills a hung command as ok:true with a live log and tracked child", async () => {
    const { result, jobs } = await invokeBash("printf start; sleep 8; printf done", 120);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("[Still running after ");
    expect(result.output).toContain("Bounded live output (may be truncated):");
    expect(result.details?.running).toBe(true);
    expect(result.details?.logPath).toBeTruthy();
    const logPath = result.details!.logPath!;
    expect(fs.existsSync(logPath)).toBe(true);
    // Auto-spill can precede the asynchronous spawn notification on Windows.
    // Observe the tracked child becoming ready, not machine startup latency.
    const job = jobs.get(result.details!.taskId!)!;
    await vi.waitFor(() => expect(job.info().pid).toEqual(expect.any(Number)), { timeout: 5000 });
    const pid = job.info().pid;
    if (typeof pid === "number" && PID_PROBE_EXACT) {
      expect(() => process.kill(pid, 0)).not.toThrow();
      try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); }
    }
    expect(jobs.list().some((job) => job.status === "spilled")).toBe(true);
  });

  it("says an explicit timeout bounds the process, not the wait, when it hands off", async () => {
    const { result, jobs } = await invokeBash("printf start; sleep 8; printf done", 120, undefined, { timeout: 30 });
    expect(result.details?.running).toBe(true);
    const taskId = result.details!.taskId!;
    expect(result.output).toContain("Its timeout (30s) bounds the process, not this wait");
    expect(result.output).toContain(`call tasks.wait with {"id":"${taskId}","timeoutMs":300000} until it reports a terminal status`);
    expect(result.output).not.toContain("call tools.call");
    jobs.get(taskId)!.abort.abort();
  });

  it("does not add the timeout note without an explicit timeout", async () => {
    const { result, jobs } = await invokeBash("printf start; sleep 8; printf done", 120);
    expect(result.details?.running).toBe(true);
    expect(result.output).not.toContain("bounds the process");
    jobs.get(result.details!.taskId!)!.abort.abort();
  });

  it("does not auto-spill when hangMs is 0", async () => {
    const { result } = await invokeBash('printf "done\\n"', 0);
    expect(result.ok).toBe(true);
    // Shell startup diagnostics (for example MSYS's /tmp warning) precede
    // command output on some runners. Check the command boundary, not the image.
    expect(result.output.endsWith("done\n")).toBe(true);
    expect(result.output).not.toContain("Still running");
  });

  it("normalizes shellHangMs including off", () => {
    expect(normalizeFabricConfig({}).executor.shellHangMs).toBe(120_000);
    expect(normalizeFabricConfig({ executor: { shellHangMs: 0 } }).executor.shellHangMs).toBe(0);
    expect(normalizeFabricConfig({ executor: { shellHangMs: -5 } }).executor.shellHangMs).toBe(0);
    expect(normalizeFabricConfig({ executor: { shellHangMs: 20 * 60_000 } }).executor.shellHangMs).toBe(600_000);
  });

  it("spills immediately when background:true", async () => {
    const { result, jobs } = await invokeBash("printf start; sleep 8; printf done", 120_000, undefined, { background: true, timeout: 30 });
    expect(result.output).not.toContain("bounds the process");
    expect(result.ok).toBe(true);
    expect(result.details?.running).toBe(true);
    expect(result.details?.logPath).toBeTruthy();
    // Auto-spill can precede the asynchronous spawn notification on Windows.
    // Observe the tracked child becoming ready, not machine startup latency.
    const job = jobs.get(result.details!.taskId!)!;
    await vi.waitFor(() => expect(job.info().pid).toEqual(expect.any(Number)), { timeout: 5000 });
    const pid = job.info().pid;
    if (typeof pid === "number" && PID_PROBE_EXACT) {
      expect(() => process.kill(pid, 0)).not.toThrow();
      try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); }
    }
    expect(jobs.list().some((job) => job.status === "spilled")).toBe(true);
    expect(result.details?.elapsedMs).toEqual(expect.any(Number));
  });
});
