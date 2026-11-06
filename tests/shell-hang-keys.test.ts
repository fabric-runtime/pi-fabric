import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FabricProgramTasks } from "../src/core/program-tasks.js";
import { FabricShellJobStore } from "../src/core/shell-jobs.js";
import { installFabricShellHangKeys } from "../src/ui/shell-hang-keys.js";

const encodings = [
  ["legacy", { ctrlB: "\x02", ctrlK: "\x0b" }],
  ["Kitty", { ctrlB: "\x1b[98;5u", ctrlK: "\x1b[107;5u" }],
] as const;
const cleanups: Array<() => Promise<void>> = [];

function harness(options: { shell?: boolean; program?: boolean } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const inputs = new Set<(data: string) => unknown>();
  const jobs = new FabricShellJobStore();
  const job = options.shell === false ? undefined : jobs.begin("bash", "sleep 30");
  const programs = new FabricProgramTasks();
  const parent = new AbortController();
  const program = options.program ? programs.begin({
    code: "return await work();", parentSignal: parent.signal, jobs: () => jobs,
  }) : undefined;
  const notify = vi.fn();
  const enabled = vi.fn(() => true);
  const ownsInput = vi.fn(() => false);
  const getEditorText = vi.fn(() => "");
  const getJobs = vi.fn((): FabricShellJobStore | undefined => jobs);
  const getPrograms = vi.fn(() => programs);
  const context = {
    mode: "tui",
    ui: {
      notify, getEditorText,
      onTerminalInput: (handler: (data: string) => unknown) => {
        inputs.add(handler);
        return () => { inputs.delete(handler); };
      },
    },
  } as unknown as ExtensionContext;
  const dispose = installFabricShellHangKeys(context, {
    enabled, ownsInput, jobs: getJobs, programs: getPrograms,
  });
  cleanups.push(async () => { dispose(); parent.abort(); await jobs.close(); });
  return {
    dispose, notify, jobs, job, programs, program, parent, inputs,
    enabled, ownsInput, getEditorText, getJobs, getPrograms,
    detached: () => job ? job.spilled : program?.job !== undefined,
    input: (data: string) => [...inputs].map(input => input(data)).find(result => result !== undefined),
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

describe.each(encodings)("shell hang keys (%s)", (_encoding, { ctrlB, ctrlK }) => {
  it("uses real Pi key decoding for Ctrl+B and Ctrl+K", () => {
    expect(matchesKey(ctrlB, "ctrl+b")).toBe(true);
    expect(matchesKey(ctrlK, "ctrl+k")).toBe(true);
  });

  it("requires Ctrl+B twice within one second to spill a waiting shell", () => {
    const h = harness();
    expect(h.input(ctrlB)).toEqual({ consume: true });
    expect(h.job!.spilled).toBe(false);
    expect(h.notify).toHaveBeenCalledWith("Fabric: press Ctrl+B again to background the waiting shell", "info");
    vi.advanceTimersByTime(1_000);
    expect(h.input(ctrlB)).toEqual({ consume: true });
    expect(h.job!.spilled).toBe(true);
    expect(h.job!.abort.signal.aborted).toBe(false);
    expect(h.notify).toHaveBeenCalledWith("Fabric: shell still running · output spilled to a live log", "info");
  });

  it("backgrounds a waiting program from an empty editor without cancelling it", () => {
    const h = harness({ shell: false, program: true });
    expect(h.input(ctrlB)).toEqual({ consume: true });
    expect(h.program!.job).toBeUndefined();
    expect(h.input(ctrlB)).toEqual({ consume: true });
    expect(h.program!.job).toMatchObject({ tool: "fabric_exec", spilled: true });
    expect(h.programs.waiting()).toBe(0);
    expect(h.notify).toHaveBeenCalledExactlyOnceWith("Fabric: program moved to the background · /fabric tasks", "info");
    h.parent.abort();
    expect(h.program!.signal.aborted).toBe(false);
  });

  it("gives waiting shells priority over programs even with a nonempty editor", () => {
    const h = harness({ program: true });
    h.getEditorText.mockReturnValue("keep this draft");
    expect(h.input(ctrlB)).toEqual({ consume: true });
    expect(h.input(ctrlB)).toEqual({ consume: true });
    expect(h.job!.spilled).toBe(true);
    expect(h.program!.job).toBeUndefined();
    expect(h.getPrograms).not.toHaveBeenCalled();
    expect(h.getEditorText).not.toHaveBeenCalled();
  });

  it("kills a waiting shell with Ctrl+K without cancelling detached work or programs", () => {
    const h = harness({ program: true });
    const detached = h.jobs.begin("bash", "already detached");
    detached.spill();
    expect(h.input(ctrlK)).toEqual({ consume: true });
    expect(h.job!.abort.signal.aborted).toBe(true);
    expect(detached.abort.signal.aborted).toBe(false);
    expect(h.program!.signal.aborted).toBe(false);
    expect(h.program!.job).toBeUndefined();
    expect(h.notify).toHaveBeenCalledWith("Fabric: killed waiting shell", "warning");
  });

  it.each(["shell", "program"] as const)("re-arms an expired confirmation chord for a %s", (kind) => {
    const h = harness({ shell: kind === "shell", program: kind === "program" });
    expect(h.input(ctrlB)).toEqual({ consume: true });
    vi.advanceTimersByTime(1_001);
    expect(h.input(ctrlB)).toEqual({ consume: true });
    expect(h.detached()).toBe(false);
    expect(h.input(ctrlB)).toEqual({ consume: true });
    expect(h.detached()).toBe(true);
  });

  it.each(["shell", "program"] as const)("resets the %s chord on unrelated input", (kind) => {
    const h = harness({ shell: kind === "shell", program: kind === "program" });
    h.input(ctrlB);
    expect(h.input("x")).toBeUndefined();
    expect(h.input(ctrlB)).toEqual({ consume: true });
    expect(h.detached()).toBe(false);
    expect(h.input(ctrlB)).toEqual({ consume: true });
    expect(h.detached()).toBe(true);
  });

  it("leaves Ctrl+B and Ctrl+K to the editor without eligible work", () => {
    const h = harness({ shell: false });
    for (const key of [ctrlB, ctrlB, ctrlK]) expect(h.input(key)).toBeUndefined();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("does not treat already detached work as eligible", () => {
    const h = harness();
    h.job!.spill();
    for (const key of [ctrlB, ctrlB, ctrlK]) expect(h.input(key)).toBeUndefined();
    expect(h.job!.abort.signal.aborted).toBe(false);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("keeps shortcuts in a nonempty editor and resets the program chord", () => {
    const h = harness({ shell: false, program: true });
    h.input(ctrlB);
    h.getEditorText.mockReturnValue("keep this draft");
    for (const key of [ctrlB, ctrlB, ctrlK]) expect(h.input(key)).toBeUndefined();
    expect(h.program!.job).toBeUndefined();
    expect(h.notify).not.toHaveBeenCalled();
    h.getEditorText.mockReturnValue("");
    h.input(ctrlB);
    expect(h.program!.job).toBeUndefined();
    h.input(ctrlB);
    expect(h.program!.job).toBeDefined();
  });

  it("does not use Ctrl+K to cancel a waiting program", () => {
    const h = harness({ shell: false, program: true });
    expect(h.input(ctrlK)).toBeUndefined();
    expect(h.program!.signal.aborted).toBe(false);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("falls through if the editor cannot be inspected or the job store is unavailable", () => {
    const h = harness({ shell: false, program: true });
    h.getEditorText.mockImplementation(() => { throw new Error("editor unavailable"); });
    expect(h.input(ctrlB)).toBeUndefined();
    h.getEditorText.mockReturnValue("");
    h.getJobs.mockReturnValue(undefined);
    for (const key of [ctrlB, ctrlB, ctrlK]) expect(h.input(key)).toBeUndefined();
    expect(h.program!.job).toBeUndefined();
    expect(h.notify).not.toHaveBeenCalled();
  });

  for (const guard of ["enabled", "ownsInput"] as const) {
    it.each(["shell", "program"] as const)(`respects ${guard} and clears an armed %s chord`, (kind) => {
      const h = harness({ shell: kind === "shell", program: kind === "program" });
      h.input(ctrlB);
      h.notify.mockClear();
      h[guard].mockReturnValue(guard === "ownsInput");
      for (const key of [ctrlB, ctrlK]) expect(h.input(key)).toBeUndefined();
      expect(h.job?.abort.signal.aborted ?? h.program!.signal.aborted).toBe(false);
      expect(h.notify).not.toHaveBeenCalled();
      h[guard].mockReturnValue(guard === "enabled");
      h.input(ctrlB);
      expect(h.detached()).toBe(false);
      h.input(ctrlB);
      expect(h.detached()).toBe(true);
    });
  }

  it("unsubscribes both handlers and cancels a pending Escape on disposal", () => {
    const h = harness();
    h.job!.spill();
    const watch = h.jobs.begin("bash", "watch", { monitor: { delivery: "ui", timeoutMs: 300000, intervalMs: 1000 } });
    watch.spill();
    h.input("\x1b");
    h.dispose();
    vi.advanceTimersByTime(100);
    expect(h.inputs.size).toBe(0);
    for (const key of [ctrlB, ctrlK]) expect(h.input(key)).toBeUndefined();
    expect(watch.abort.signal.aborted).toBe(false);
    expect(h.job!.abort.signal.aborted).toBe(false);
  });
});

describe("shell hang key lifecycle", () => {
  it("cancels monitors on lone Escape but not arrow sequences or ordinary detached shells", () => {
    const h = harness();
    h.job!.spill();
    const watch = h.jobs.begin("bash", "watch", { monitor: { delivery: "ui", timeoutMs: 300000, intervalMs: 1000 } });
    watch.spill();
    h.input("\x1b[A"); vi.advanceTimersByTime(100);
    expect(watch.abort.signal.aborted).toBe(false);
    expect(h.input("\x1b")).toBeUndefined(); vi.advanceTimersByTime(100);
    expect(watch.abort.signal.aborted).toBe(true);
    expect(h.job!.abort.signal.aborted).toBe(false);
  });

  it.each(["rpc", "missing hook"])("does not attach input handlers in %s mode", (mode) => {
    const onTerminalInput = vi.fn();
    const context = { mode: mode === "rpc" ? "rpc" : "tui", ui: mode === "rpc" ? { onTerminalInput } : {} } as unknown as ExtensionContext;
    installFabricShellHangKeys(context, { enabled: () => true, ownsInput: () => false, jobs: () => undefined })();
    expect(onTerminalInput).not.toHaveBeenCalled();
  });
});
