import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FabricState } from "../src/fabric-state.js";
import { AttachedMonitors } from "../src/core/attached-monitors.js";
import { FabricShellJobStore, type FabricShellJobInfo } from "../src/core/shell-jobs.js";
import { ShellTasksView } from "../src/ui/shell-tasks.js";
import { FabricUiController } from "../src/ui/controller.js";
import { FabricWidget, shouldShowFabricWidget } from "../src/ui/widget.js";
import { registerFabricCommand } from "../src/commands/fabric.js";
import type { CapturedToolCatalog } from "../src/capture/catalog.js";
const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });

const fixture = () => {
  const jobs = new FabricShellJobStore(); cleanup.push(() => jobs.close());
  const state = {
    shellJobs: jobs, initialized: true, ensure: vi.fn(async () => {}), widgetDismissedAt: 0,
    config: { ui: { enabled: true, refreshMs: 1000, widget: "auto", maxRows: 5, eventHistory: 80 }, mesh: { enabled: false } },
    activity: { subscribe: () => () => {}, runs: () => [] },
    agents: { subscribeUi: () => () => {}, list: () => [] }, actors: { subscribe: () => () => {}, list: () => [] }, globalActors: { list: () => [] },
    mainAgentInfo: () => ({ id: "main", name: "Main", kind: "main", status: "idle", runner: "pi", transport: "host", cwd: process.cwd(), startedAt: 1, updatedAt: 1, pendingMessages: false, local: true }),
  } as unknown as FabricState;
  const controller = new FabricUiController(state); cleanup.push(() => controller.stop());
  const setWidget = vi.fn(), notify = vi.fn(), requestRender = vi.fn();
  const context = { mode: "tui", hasUI: true, ui: { setWidget, notify } } as unknown as ExtensionContext;
  return { jobs, state, controller, context, setWidget, notify, requestRender };
};

describe("background shell UI", () => {
  it("groups an observation beneath its task and stops watching without stopping work", async () => {
    const h = fixture();
    const target = h.jobs.begin("bash", "build", { description: "Remote checks" }); target.spill();
    const other = h.jobs.begin("bash", "other"); other.spill();
    const observations = new AttachedMonitors(h.jobs); cleanup.push(() => observations.close());
    const observer = await observations.start({ target: { kind: "task", id: target.id }, delivery: "ui", events: ["output", "terminal"], timeoutMs: 300000, intervalMs: 1000 });
    const widget = new FabricWidget(theme, () => ({ ...h.controller.snapshot(), shells: h.jobs.list() }), 8);
    const lines = widget.render(160);
    const targetRow = lines.findIndex(line => line.includes(target.id.slice(0, 8)));
    expect(lines[targetRow + 1]).toContain(`╰─ ○ ${observer.id.slice(0, 8)} watching · UI only`);
    expect(lines.join("\n")).toContain("2 shells · 1 observation");
    expect(lines.filter(line => line.includes(observer.id.slice(0, 8)))).toHaveLength(1);
    for (const width of [1, 12, 40, 80]) expect(widget.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
    const view = new ShellTasksView({ jobs: h.jobs, theme, done: vi.fn(), rows: () => 40, requestRender: vi.fn(), id: observer.id });
    cleanup.push(() => view.dispose());
    const detail = view.render(120).join("\n");
    expect(detail).toContain("Fabric · observation");
    expect(detail).toContain("Target: task Remote checks · spilled");
    expect(detail).toContain("Stopping observation leaves the target running.");
    expect(detail).toContain("stop watching");
    view.handleInput("x"); expect(view.render(120).join("\n")).toContain("target continues");
    view.handleInput("x");
    expect(h.jobs.get(observer.id)!.abort.signal.aborted).toBe(true);
    expect(target.abort.signal.aborted).toBe(false);
    expect(other.abort.signal.aborted).toBe(false);
  });

  it.each<[string, Partial<FabricShellJobInfo>, Parameters<Theme["fg"]>[0], string]>([
    ["running", { status: "running" }, "accent", "○"],
    ["spilled", {}, "accent", "○"],
    ["stopping", { stopping: true }, "warning", "○"],
    ["monitor:ui", { monitor: { delivery: "ui", timeoutMs: 300000, intervalMs: 5000 } }, "accent", "○"],
    ["monitor:wake", { monitor: { delivery: "wake", timeoutMs: 300000, intervalMs: 5000 } }, "accent", "○"],
    ["exited", { status: "exited", finishedAt: 13000 }, "success", "○"],
    ["failed", { status: "failed", finishedAt: 13000 }, "error", "○"],
    ["killed", { status: "killed", finishedAt: 13000 }, "dim", "○"],
    ["timed_out", { status: "timed_out", finishedAt: 13000 }, "error", "○"],
    ["exited", { status: "exited", finishedAt: 13000, monitor: { delivery: "ui", timeoutMs: 300000, intervalMs: 5000 } }, "success", "○"],
    ["stopping", { stopping: true, monitor: { delivery: "wake", timeoutMs: 300000, intervalMs: 5000 } }, "warning", "○"],
  ])("renders %s shells with status-coloured circles, muted labels and dim metrics", (status, overrides, color, glyph) => {
    vi.useFakeTimers(); vi.setSystemTime(13000);
    const h = fixture();
    const colors: Record<string, number> = { dim: 90, muted: 37, accent: 36, success: 32, error: 31, warning: 33 };
    const ansiTheme = {
      ...theme,
      fg: (color: string, text: string) => `\u001b[${colors[color]}m${text}\u001b[39m`,
    } as Theme;
    const job: FabricShellJobInfo = {
      id: "7b6eb606-1234", tool: "bash", command: "sleep 30", startedAt: 10000,
      spilledAt: 10000, status: "spilled", eventCount: 0, unread: false, stopping: false,
      ...overrides,
    };
    for (const description of [undefined, "Watch CI 界\u001b[2J"]) {
      const snapshot = { ...h.controller.snapshot(), now: 13000, shells: [description === undefined ? job : { ...job, description }] };
      const widget = new FabricWidget(ansiTheme, () => snapshot, 5);
      const lines = widget.render(120);
      expect(lines[0]).toBe("");
      expect(lines[1]).not.toContain("ctrl+alt+t");
      expect(lines[2]).toBe(
        `${ansiTheme.fg(color, glyph)} ${ansiTheme.fg("muted", "7b6eb606")} ${ansiTheme.fg("muted", status)}` +
        `${ansiTheme.fg("dim", " · 3s · ")}${ansiTheme.fg("muted", description ? "Watch CI 界" : "sleep 30")}`,
      );
      for (const width of [1, 12, 40, 80]) {
        expect(widget.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
      }
    }
  });

  it("keeps a steady shell circle and redraws it when the task completes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const h = fixture();
    const job = h.jobs.begin("bash", "sleep 30"); job.spill();
    const widget = new FabricWidget(theme, () => ({ ...h.controller.snapshot(), now: Date.now(), shells: h.jobs.list() }), 5);
    expect(widget.render(120)[2]).toMatch(/^○ .* spilled /);
    vi.setSystemTime(10250);
    expect(widget.hasChanged()).toBe(false);
    await job.finish(0);
    expect(widget.hasChanged()).toBe(true);
    expect(widget.render(120)[2]).toMatch(/^○ .* exited /);
    vi.setSystemTime(10500);
    expect(widget.hasChanged()).toBe(false);
  });
  it("keeps the widget live after the executor is idle and refreshes elapsed time without output", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const h = fixture(); h.controller.start(h.context);
    expect(vi.getTimerCount()).toBe(0);
    const job = h.jobs.begin("bash", "sleep 30", { description: "Watch CI" }); job.spill();
    await vi.advanceTimersByTimeAsync(100);
    const snapshot = h.controller.snapshot();
    expect(snapshot.shells).toHaveLength(1);
    expect(shouldShowFabricWidget(snapshot, "auto")).toBe(true);
    expect(shouldShowFabricWidget(snapshot, "hidden")).toBe(false);
    const widget = new FabricWidget(theme, () => h.controller.snapshot(), 5);
    expect(widget.render(80).join("\n")).not.toContain("ctrl+alt+t");
    expect(widget.render(80).join("\n")).toContain("Watch CI");
    await vi.advanceTimersByTimeAsync(3000);
    expect(widget.render(80).join("\n")).toContain("3s");
    await job.finish(0);
    await vi.advanceTimersByTimeAsync(31000);
    expect(shouldShowFabricWidget(h.controller.snapshot(), "auto")).toBe(false);
    h.controller.stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it("opens the only task directly, bounds width, keeps finished detail open and confirms stop", async () => {
    const h = fixture();
    const job = h.jobs.begin("bash", "printf secret; sleep 5", { cwd: "/work", description: "Build 界\u001b[2J" }); job.spill(); job.append(Buffer.from("line 1\nline 2\n"));
    const done = vi.fn();
    let rows = 32;
    const view = new ShellTasksView({ jobs: h.jobs, theme, done, rows: () => rows, requestRender: h.requestRender, id: job.id }); cleanup.push(() => view.dispose());
    await Promise.resolve();
    const text = view.render(100).join("\n");
    expect(text).toContain("Elapsed"); expect(text).toContain("last output"); expect(text).toContain("cwd: /work"); expect(text).toContain("printf secret");
    for (const width of [1, 12, 40, 80]) expect(view.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
    expect(text).not.toContain("\u001b");
    rows = 2; expect(view.render(40).length).toBeLessThanOrEqual(2); rows = 32;
    view.handleInput("x"); expect(job.abort.signal.aborted).toBe(false);
    view.handleInput("x"); expect(job.abort.signal.aborted).toBe(true);
    await job.finish(null);
    expect(view.render(100).join("\n")).toContain("killed"); expect(done).not.toHaveBeenCalled();
    view.handleInput("\u001b"); view.handleInput("\u001b"); expect(done).toHaveBeenCalledOnce();
  });

  it("does not kill work when the inspector closes", () => {
    const h = fixture(); const job = h.jobs.begin("bash", "watch"); job.spill();
    const view = new ShellTasksView({ jobs: h.jobs, theme, done: vi.fn(), rows: () => 24, requestRender: vi.fn(), id: job.id });
    view.dispose(); expect(job.abort.signal.aborted).toBe(false);
  });

  it("keeps the task command and exact-ID completion without the retired shortcut", async () => {
    const h = fixture(); const job = h.jobs.begin("bash", "watch"); job.spill();
    let command: any; const shortcuts = new Map<string, any>();
    const pi = { registerCommand: (_name: string, value: any) => { command = value; }, registerShortcut: (key: string, value: any) => shortcuts.set(key, value) } as unknown as ExtensionAPI;
    const openTasks = vi.spyOn(h.controller, "openTasks").mockResolvedValue();
    registerFabricCommand(pi, { state: h.state, fabricUi: h.controller, capturedTools: {} as CapturedToolCatalog, applyFabricMode: vi.fn(), suspendToolCapture: vi.fn() });
    expect(command.getArgumentCompletions("ta")).toContainEqual({ value: "tasks", label: "tasks" });
    expect(command.getArgumentCompletions("tasks ")[0].value).toBe(`tasks ${job.id}`);
    await command.handler(`tasks ${job.id}`, h.context);
    expect(openTasks).toHaveBeenCalledWith(h.context, job.id);
    expect(shortcuts.has("ctrl+alt+t")).toBe(false);
  });
});
