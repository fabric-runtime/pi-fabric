import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { FabricActivityRun } from "../src/activity/types.js";
import { FabricActivityStore } from "../src/activity/store.js";
import { ActorStoreReadError } from "../src/actors/store-read.js";
import type { FabricState } from "../src/fabric-state.js";
import { FabricUiController } from "../src/ui/controller.js";
import type { FabricDashboard } from "../src/ui/dashboard.js";
import { FabricWidget } from "../src/ui/widget.js";
import "../src/ui/dashboard.js";
import "../src/ui/model-picker.js";

const theme = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
} as unknown as Theme;

const stubActor = {
  id: "actor-1",
  name: "advisor",
  status: "idle",
  events: ["turn_end"],
  topics: [],
  delivery: "mailbox",
  responseMode: "text",
  triggerTurn: false,
  coalesce: true,
  queued: 0,
  messages: 0,
  createdAt: 0,
  updatedAt: 0,
};

const stubState = () =>
  ({
    initialized: true,
    config: {
      ui: { enabled: true, refreshMs: 60_000, eventHistory: 80, widget: "hidden" },
      mesh: { enabled: false },
    },
    activity: { subscribe: vi.fn(() => () => {}), runs: vi.fn(() => []), reset: vi.fn() },
    mainAgentInfo: vi.fn(() => ({
      id: "session:test",
      name: "Main",
      kind: "main",
      status: "idle",
      runner: "pi",
      transport: "host",
      cwd: "/tmp/project",
      sessionId: "test",
      startedAt: 1,
      updatedAt: 1,
      pendingMessages: false,
      local: true,
    })),
    queueUserMessage: vi.fn().mockResolvedValue({
      queued: true,
      messageId: "message-1",
      routed: "main",
    }),
    agents: { list: vi.fn(() => []), subscribeUi: vi.fn(() => () => {}) },
    actors: {
      list: vi.fn(() => [stubActor]),
      messages: vi.fn(() => []),
      instructions: vi.fn(() => "Advise only when useful."),
      setModel: vi.fn().mockResolvedValue(undefined),
      setThinking: vi.fn().mockResolvedValue(undefined),
      setEvents: vi.fn().mockResolvedValue(undefined),
      setInstructions: vi.fn().mockResolvedValue(undefined),
      clearMessages: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(() => () => {}),
    },
    globalActors: {
      list: vi.fn(() => []),
      resolve: vi.fn(() => undefined),
      create: vi.fn(() => ({ id: "g1", name: "x", createdAt: 0, updatedAt: 0 })),
      update: vi.fn(() => ({ id: "g1", name: "x", createdAt: 0, updatedAt: 0 })),
      remove: vi.fn(() => ({ removed: true })),
      toRequest: vi.fn(() => ({ name: "x", instructions: "y" })),
    },
    mesh: { read: vi.fn(() => []), latestOffset: vi.fn(() => 0), list: vi.fn(() => []) },
    widgetDismissedAt: 0,
  }) as unknown as FabricState;

describe("FabricUiController dashboard wiring", () => {
  it("uses incremental views, skips duplicate progress refreshes, and releases readers on stop", async () => {
    vi.useFakeTimers();
    const state = stubState();
    const activity = new FabricActivityStore();
    Object.assign(state, { activity });
    activity.start("history");
    activity.finish("history", true);
    activity.start("live");
    activity.beginCall("live", { callId: "call", ref: "pi.read", args: { path: "file.ts" } });
    const createView = vi.spyOn(activity, "createRunView");
    const fullReads = vi.spyOn(activity, "runs");
    const legacySummaries = vi.spyOn(activity, "runSummaries");
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const controller = new FabricUiController(state);
    const context = {
      mode: "tui", modelRegistry: { getAvailable: () => [] }, ui: {
        custom: vi.fn(async (factory: (t: TUI, theme: Theme, keys: unknown, done: () => void) => FabricDashboard) => {
          factory(tui, theme, {}, () => {});
          expect(controller.snapshot().runs[0]!.calls[0]!.args).toEqual({ path: "file.ts" });
        }),
        notify: vi.fn(), setWidget: vi.fn(),
      },
    } as unknown as ExtensionContext;
    try {
      controller.start(context);
      const history = controller.snapshot().runs[1];
      expect(controller.snapshot().runs[0]!.calls[0]).not.toHaveProperty("args");
      activity.updateCall("live", "call", { type: "progress", message: "working" });
      await vi.advanceTimersByTimeAsync(110);
      // The public snapshot() API deliberately returns isolated copies.
      expect(controller.snapshot().runs[1]).toEqual(history);
      expect(controller.snapshot().runs[0]!.calls[0]!.progress).toBe("working");
      vi.mocked(state.mainAgentInfo).mockClear();
      for (let i = 0; i < 100; i++) activity.updateCall("live", "call", { type: "progress", message: "working" });
      await vi.advanceTimersByTimeAsync(110);
      expect(state.mainAgentInfo).not.toHaveBeenCalled();
      await controller.openDashboard(context);
      expect(controller.snapshot().runs[0]!.calls[0]).not.toHaveProperty("args");
      expect(fullReads).not.toHaveBeenCalled();
      expect(legacySummaries).not.toHaveBeenCalled();
      expect(createView).toHaveBeenCalledTimes(1);
      controller.stop();
      controller.start(context);
      expect(createView).toHaveBeenCalledTimes(2);
      expect(context.ui.notify).not.toHaveBeenCalled();
    } finally {
      controller.stop();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
  it("passes every actor callback to the dashboard so all pickers are available", async () => {
    const state = stubState();
    const controller = new FabricUiController(state);
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    let dashboard: FabricDashboard | undefined;
    const context = {
      mode: "tui",
      modelRegistry: { getAvailable: () => [] },
      ui: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        custom: vi.fn(async (factory: any) => {
          dashboard = factory(tui, theme, {}, () => {}) as FabricDashboard;
        }),
        notify: vi.fn(),
        setWidget: vi.fn(),
      },
    } as unknown as ExtensionContext;

    try {
      await controller.openDashboard(context);
      expect(dashboard).toBeDefined();
      // Enter the entities pane and open the actor detail.
      dashboard!.handleInput("l");
      dashboard!.handleInput("\r");
      const detail = dashboard!.render(120).join("\n");
      expect(detail).toContain("advisor");
      // Each hint is gated on its callback being wired by the controller;
      // this guards against regressions like the thinking picker being omitted.
      expect(detail).toContain("m session model");
      expect(detail).toContain("M pin model");
      expect(detail).toContain("e session thinking");
      expect(detail).toContain("E pin thinking");
      expect(detail).toContain("v events");
      expect(detail).toContain("c clear");
    } finally {
      dashboard?.dispose();
      controller.stop();
    }
  });

  it("wires global template events end to end from the dashboard to the registry", async () => {
    const state = stubState();
    vi.mocked(state.globalActors.list).mockReturnValue([
      {
        id: "g-actor-1",
        name: "global-reviewer",
        instructions: "Review when asked.",
        runner: "pi",
        events: ["turn_end"],
        topics: [],
        delivery: "mailbox",
        responseMode: "directive",
        triggerTurn: false,
        coalesce: true,
        createdAt: 0,
        updatedAt: 0,
      },
    ] as never);
    const controller = new FabricUiController(state);
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    let dashboard: FabricDashboard | undefined;
    const context = {
      mode: "tui",
      modelRegistry: { getAvailable: () => [] },
      ui: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        custom: vi.fn(async (factory: any) => {
          dashboard = factory(tui, theme, {}, () => {}) as FabricDashboard;
        }),
        notify: vi.fn(),
        setWidget: vi.fn(),
      },
    } as unknown as ExtensionContext;

    try {
      await controller.openDashboard(context);
      expect(dashboard).toBeDefined();
      // Move from the first actor to the global template, then open its
      // detail; the hint is gated on onGlobalEvents being wired.
      dashboard!.handleInput("l");
      dashboard!.handleInput("j");
      dashboard!.handleInput("\r");
      expect(dashboard!.render(120).join("\n")).toContain("v events");
      dashboard!.handleInput("v");
      dashboard!.handleInput(" ");
      dashboard!.handleInput("\r");
      expect(state.globalActors.update).toHaveBeenCalledWith("g-actor-1", {
        events: ["input", "turn_end"],
      });
      expect(context.ui.notify).toHaveBeenCalledWith(
        "Global actor event subscriptions updated",
        "info",
      );
    } finally {
      dashboard?.dispose();
      controller.stop();
    }
  });

  it("reports an unreadable template library on import instead of throwing from the key handler", async () => {
    const state = stubState();
    vi.mocked(state.globalActors.list).mockReturnValue([
      {
        id: "g-actor-1",
        name: "global-reviewer",
        instructions: "Review when asked.",
        runner: "pi",
        events: ["turn_end"],
        topics: [],
        delivery: "mailbox",
        responseMode: "directive",
        triggerTurn: false,
        coalesce: true,
        createdAt: 0,
        updatedAt: 0,
      },
    ] as never);
    // The library became unreadable after the dashboard listed it.
    const readError = new ActorStoreReadError("/project/global-actors.json", "invalid JSON");
    vi.mocked(state.globalActors.resolve).mockImplementation(() => {
      throw readError;
    });
    const create = vi.fn();
    Object.assign(state.actors, { create });
    const controller = new FabricUiController(state);
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    let dashboard: FabricDashboard | undefined;
    const context = {
      mode: "tui",
      modelRegistry: { getAvailable: () => [] },
      ui: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        custom: vi.fn(async (factory: any) => {
          dashboard = factory(tui, theme, {}, () => {}) as FabricDashboard;
        }),
        notify: vi.fn(),
        setWidget: vi.fn(),
      },
    } as unknown as ExtensionContext;

    try {
      await controller.openDashboard(context);
      // Select the global template and press p to import it.
      dashboard!.handleInput("l");
      dashboard!.handleInput("j");
      expect(() => dashboard!.handleInput("p")).not.toThrow();
      expect(create).not.toHaveBeenCalled();
      expect(context.ui.notify).toHaveBeenCalledWith(readError.message, "error");
    } finally {
      dashboard?.dispose();
      controller.stop();
    }
  });

  it("routes Main dashboard messages through FabricState", async () => {
    const state = stubState();
    const controller = new FabricUiController(state);
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    let dashboard: FabricDashboard | undefined;
    const context = {
      mode: "tui",
      modelRegistry: { getAvailable: () => [] },
      ui: {
        custom: vi.fn(async (factory: (
          tui: TUI,
          theme: Theme,
          keybindings: unknown,
          done: () => void,
        ) => FabricDashboard) => {
          dashboard = factory(tui, theme, {}, () => {});
        }),
        notify: vi.fn(),
        setWidget: vi.fn(),
      },
    } as unknown as ExtensionContext;

    try {
      await controller.openDashboard(context);
      dashboard!.handleInput("l");
      dashboard!.handleInput("g");
      dashboard!.handleInput("s");
      dashboard!.handleInput("focus on the failing test");
      dashboard!.handleInput("\r");
      expect(state.queueUserMessage).toHaveBeenCalledWith(
        "session:test",
        "focus on the failing test",
        "steer",
      );
    } finally {
      dashboard?.dispose();
      controller.stop();
    }
  });

  it("does not refresh settled sessions on an idle timer", async () => {
    vi.useFakeTimers();
    const state = stubState();
    state.config.ui.refreshMs = 100;
    vi.mocked(state.actors.list).mockReturnValue([]);
    const settledRun: FabricActivityRun = {
      id: "settled-run",
      name: "Large settled run",
      status: "completed",
      phases: [],
      calls: Array.from({ length: 1_000 }, (_, index) => ({
        id: `call-${index}`,
        ref: "pi.read",
        label: "pi.read",
        kind: "tool",
        status: "completed",
        startedAt: index,
        updatedAt: index,
        finishedAt: index,
      })),
      items: [],
      events: [],
      startedAt: 0,
      updatedAt: 1_000,
      finishedAt: 1_000,
    };
    vi.mocked(state.activity.runs).mockReturnValue([settledRun]);
    const context = {
      mode: "tui",
      ui: { setWidget: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    const controller = new FabricUiController(state);
    try {
      controller.start(context);
      expect(state.activity.runs).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(state.activity.runs).toHaveBeenCalledTimes(1);
    } finally {
      controller.stop();
      vi.useRealTimers();
    }
  });

  it("wakes settled UI state when actors or detached agents change", async () => {
    vi.useFakeTimers();
    const state = stubState();
    state.config.ui.refreshMs = 500;
    let onActor = (): void => {};
    let onAgent = (): void => {};
    vi.mocked(state.actors.subscribe).mockImplementation((listener) => {
      onActor = listener;
      return () => {};
    });
    vi.mocked(state.agents.subscribeUi).mockImplementation((listener) => {
      onAgent = listener;
      return () => {};
    });
    const context = {
      mode: "tui",
      ui: { setWidget: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    const controller = new FabricUiController(state);
    try {
      controller.start(context);
      expect(state.activity.runs).toHaveBeenCalledTimes(1);
      onActor();
      await vi.advanceTimersByTimeAsync(100);
      expect(state.activity.runs).toHaveBeenCalledTimes(2);
      onAgent();
      await vi.advanceTimersByTimeAsync(100);
      expect(state.activity.runs).toHaveBeenCalledTimes(3);
    } finally {
      controller.stop();
      vi.useRealTimers();
    }
  });

  it("coalesces bursty activity updates into a 10 Hz refresh", async () => {
    vi.useFakeTimers();
    const state = stubState();
    state.config.ui.refreshMs = 500;
    let onActivity = (): void => {};
    vi.mocked(state.activity.subscribe).mockImplementation((listener) => {
      onActivity = listener;
      return () => {};
    });
    const context = {
      mode: "tui",
      ui: { setWidget: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    const controller = new FabricUiController(state);
    try {
      controller.start(context);
      expect(state.activity.runs).toHaveBeenCalledTimes(1);
      for (let index = 0; index < 25; index++) onActivity();
      await vi.advanceTimersByTimeAsync(99);
      expect(state.activity.runs).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(state.activity.runs).toHaveBeenCalledTimes(2);
    } finally {
      controller.stop();
      vi.useRealTimers();
    }
  });

  it("surfaces dashboard refresh failures while retaining the last snapshot", async () => {
    const state = stubState();
    vi.mocked(state.activity.runs).mockImplementation(() => {
      throw new Error("corrupt activity state");
    });
    const notify = vi.fn();
    const context = {
      mode: "tui",
      modelRegistry: { getAvailable: () => [] },
      ui: {
        custom: vi.fn(async () => undefined),
        notify,
        setWidget: vi.fn(),
      },
    } as unknown as ExtensionContext;
    const controller = new FabricUiController(state);
    try {
      await controller.openDashboard(context);
      expect(notify).toHaveBeenCalledWith(
        "Fabric dashboard refresh failed: corrupt activity state",
        "warning",
      );
    } finally {
      controller.stop();
    }
  });

  it("refreshes streaming activity from payload-free summaries unless the dashboard is open", async () => {
    vi.useFakeTimers();
    const state = stubState();
    state.config.ui.refreshMs = 500;
    const baseRun = {
      id: "run-1",
      status: "running",
      phases: [],
      calls: [],
      items: [],
      events: [],
      startedAt: 0,
      updatedAt: 1,
    } as Omit<FabricActivityRun, "name">;
    const activityStubs = state.activity as unknown as Record<string, unknown>;
    activityStubs.runSummaries = vi.fn(() => [
      { ...baseRun, name: "summary view" } as FabricActivityRun,
    ]);
    let revision = 1;
    activityStubs.revision = vi.fn(() => revision);
    const runSummaries = vi.mocked(
      activityStubs.runSummaries as () => FabricActivityRun[],
    );
    let onActivity = (): void => {};
    vi.mocked(state.activity.subscribe).mockImplementation((listener) => {
      onActivity = listener;
      return () => {};
    });
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const context = {
      mode: "tui",
      modelRegistry: { getAvailable: () => [] },
      ui: {
        custom: vi.fn(async (factory: (
          t: TUI,
          theme: Theme,
          keybindings: unknown,
          done: () => void,
        ) => FabricDashboard) => {
          factory(tui, theme, {}, () => {});
        }),
        notify: vi.fn(),
        setWidget: vi.fn(),
      },
    } as unknown as ExtensionContext;
    const controller = new FabricUiController(state);
    try {
      controller.start(context);
      expect(runSummaries).toHaveBeenCalledTimes(1);
      expect(state.activity.runs).not.toHaveBeenCalled();
      expect(controller.snapshot().runs[0]?.name).toBe("summary view");

      // Streaming updates stay on the cheap path at the 10 Hz cadence.
      revision = 2;
      onActivity();
      await vi.advanceTimersByTimeAsync(110);
      expect(runSummaries).toHaveBeenCalledTimes(2);
      expect(state.activity.runs).not.toHaveBeenCalled();

      // Opening the dashboard switches to full detail even at the same
      // revision; closing returns to summaries and downgrades promptly.
      await controller.openDashboard(context);
      expect(state.activity.runs).toHaveBeenCalledTimes(1);
      expect(runSummaries).toHaveBeenCalledTimes(3);

      // Idle polling does not churn copies at an unchanged revision.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(state.activity.runs).toHaveBeenCalledTimes(1);
      expect(runSummaries).toHaveBeenCalledTimes(3);
    } finally {
      controller.stop();
      vi.useRealTimers();
    }
  });

  it("ticks the activity widget elapsed clock while nested calls are idle", async () => {
    vi.useFakeTimers();
    const state = stubState();
    state.config.ui.widget = "auto";
    state.config.ui.refreshMs = 500;
    state.config.ui.maxRows = 6;
    vi.mocked(state.actors.list).mockReturnValue([]);
    // A running agent gives the list a row; a header-only list collapses.
    vi.mocked(state.agents.list).mockReturnValue([{
      id: "agent-1", name: "reviewer", status: "running", transport: "process", cwd: "/tmp", startedAt: Date.now(),
    }] as never);
    const activity = new FabricActivityStore();
    Object.assign(state, { activity });
    let widget: FabricWidget | undefined;
    const requestRender = vi.fn();
    const tui = { requestRender } as unknown as TUI;
    const context = {
      mode: "tui",
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn((_key: string, content: unknown) => {
          if (typeof content === "function") {
            widget = (content as (t: TUI, theme: Theme) => FabricWidget)(tui, theme);
          }
        }),
      },
    } as unknown as ExtensionContext;
    const controller = new FabricUiController(state);
    try {
      controller.start(context);
      activity.start("live", { name: "T06 slice A" });
      for (let index = 0; index < 6; index++) {
        const callId = `c${index}`;
        activity.beginCall("live", { callId, ref: "pi.read", args: { path: `${index}.ts` } });
        activity.finishCall("live", callId, { success: true, result: "ok" });
      }
      await vi.advanceTimersByTimeAsync(1_100);
      expect(widget).toBeDefined();
      const first = widget!.render(80).join("\n");
      expect(first).toContain("T06 slice A");
      expect(first).toContain("6/6 calls");
      // Sub-second elapsed stays hidden, so the clock shows its first real tick.
      expect(first).toMatch(/1s/);
      expect(controller.snapshot().runs[0]?.status).toBe("running");
      requestRender.mockClear();
      await vi.advanceTimersByTimeAsync(5_000);
      const elapsedMs =
        controller.snapshot().now - controller.snapshot().runs[0]!.startedAt;
      const second = widget!.render(80).join("\n");
      expect(elapsedMs).toBeGreaterThanOrEqual(5_000);
      expect(second).toMatch(/6s/);
      expect(requestRender).toHaveBeenCalled();
    } finally {
      controller.stop();
      vi.useRealTimers();
    }
  });
});

describe("FabricUiController widget arrow entry", () => {
  /** Pi's interactive layout: below-editor widgets in the order last set, then the footer, last. */
  type Layout = "regular" | "fullscreen" | "unknown";
  const container = () => {
    const node = {
      children: [] as unknown[],
      addChild: vi.fn((child: unknown) => { node.children.push(child); }),
      removeChild: vi.fn((child: unknown) => { node.children = node.children.filter((entry) => entry !== child); }),
    };
    return node;
  };
  const mount = (layout: Layout = "regular", options: { shells?: boolean; agents?: boolean; label?: string; idleActors?: boolean } = {}) => {
    const state = stubState();
    if (options.label) Object.assign(state, { sessionLabel: () => options.label });
    if (options.shells) {
      const job = { id: "job-1", tool: "bash", command: "sleep 30", startedAt: Date.now(), spilledAt: Date.now(),
        status: "spilled", eventCount: 0, unread: false, stopping: false };
      Object.assign(state, { shellJobs: { list: () => [job], subscribe: () => () => {} } });
    }
    state.config.ui.widget = "always";
    state.config.ui.maxRows = 6;
    vi.mocked(state.actors.list).mockReturnValue(options.idleActors ? [stubActor, { ...stubActor, id: "actor-2", name: "reviewer" }] as never : []);
    vi.mocked(state.agents.list).mockReturnValue(options.agents === false ? [] : [{
      id: "agent-1", name: "reviewer", status: "running", transport: "process", cwd: "/tmp",
      model: "anthropic/claude-opus-5-5", task: "Review the diff", startedAt: Date.now(),
    }] as never);
    let focused: unknown;
    const editor = { text: "", getText() { return this.text; }, handleInput: vi.fn(), render: () => [], invalidate: () => {} };
    focused = editor;
    let overlay = false;
    const below = container();
    const footer = { render: () => ["~/project (main)"] };
    // Regular mode mounts Pi's containers as TUI roots; fullscreen keeps them in an input dock.
    const host = container();
    // Pi's editor container renders its bordered editor; it sits right before the widgets.
    const editorBox = { render: (width: number) => ["─".repeat(width), "> ", "─".repeat(width)] };
    host.children = [{ render: () => [] }, editorBox, below, ...(layout === "unknown" ? [] : [footer])];
    const viewport = { children: [{ render: () => [] }, host] };
    const roots = (): unknown[] => layout === "fullscreen" ? [viewport] : host.children;
    const tui = {
      get children() { return roots(); },
      getMountedRoots: roots,
      addChild: (child: unknown) => host.addChild(child),
      removeChild: (child: unknown) => host.removeChild(child),
      requestRender: vi.fn(),
      hasOverlay: () => overlay,
      getFocusedComponent: () => focused,
      setFocus: (component: unknown) => {
        if (focused instanceof FabricWidget) focused.focused = false;
        if (component instanceof FabricWidget) component.focused = true;
        focused = component;
      },
    } as unknown as TUI;
    const listeners: Array<(data: string) => { consume?: boolean } | undefined> = [];
    // Pi keeps one widget per key and moves a re-set key to the end.
    const byKey = new Map<string, unknown>();
    const setWidget = vi.fn((key: string, content: unknown) => {
      const previous = byKey.get(key);
      (previous as { dispose?: () => void } | undefined)?.dispose?.();
      byKey.delete(key);
      if (typeof content === "function") {
        byKey.set(key, (content as (t: TUI, theme: Theme) => unknown)(tui, theme));
      }
      below.children = [...below.children.filter((child) => child !== previous && ![...byKey.values()].includes(child)), ...byKey.values()];
    });
    const context = {
      mode: "tui",
      ui: {
        notify: vi.fn(),
        setWidget,
        onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
          listeners.push(handler);
          return () => listeners.splice(listeners.indexOf(handler), 1);
        },
      },
    } as unknown as ExtensionContext;
    const controller = new FabricUiController(state);
    controller.start(context);
    const press = (data: string) => listeners.map((listener) => listener(data)).find(Boolean);
    const list = () => [...host.children, ...below.children].find((child) => child instanceof FabricWidget) as FabricWidget;
    return { controller, editor, press, setWidget, below, host, footer, editorBox, list, listeners: () => listeners.length, focused: () => focused, setOverlay: (value: boolean) => { overlay = value; } };
  };

  it.each(["regular", "fullscreen"] as const)("docks the list after Pi's footer in the %s renderer", (layout) => {
    const { controller, setWidget, below, host, footer, list } = mount(layout);
    try {
      expect(setWidget).toHaveBeenCalledTimes(1);
      expect(setWidget).toHaveBeenCalledWith("pi-fabric", expect.any(Function), { placement: "belowEditor" });
      // The registered widget is a zero-height anchor; the list sits last, after the footer.
      expect(host.children.at(-2)).toBe(footer);
      expect(host.children.at(-1)).toBe(list());
      expect((below.children[0] as { render(width: number): string[] }).render(120)).toEqual([]);
      const lines = list().render(120).join("\n");
      expect(lines).toContain("claude-opus-5-5");
      expect(lines).not.toContain("anthropic/");
      expect(lines).toContain("↓ to manage");
      controller.stop();
      expect(host.children).not.toContain(list());
    } finally {
      controller.stop();
    }
  });

  it.each(["regular", "fullscreen"] as const)("lets Main hover win after returning from a conversation in %s mode", async (layout) => {
    const { controller, editor, list, focused } = mount(layout);
    let returnToMain!: () => void;
    const closed = new Promise<void>((resolve) => { returnToMain = resolve; });
    const open = vi.spyOn(controller, "openConversation").mockImplementation(() => closed);
    try {
      const widget = list();
      const pointer = (type: "move" | "click", y: number) => widget.handleMouse({
        type, button: type === "click" ? "left" : "none", x: 4, y, screenX: 4, screenY: y,
        width: 120, height: 40, shift: false, alt: false, ctrl: false,
      });
      widget.render(120);
      pointer("click", 2);
      expect(open).toHaveBeenCalledWith(expect.anything(), "agent-1");
      returnToMain();
      await vi.waitFor(() => expect(focused()).toBe(widget));
      expect(widget.render(120)[2]).toMatch(/^● reviewer/);

      // The native list retains keyboard selection after the preview closes.
      // Main must still win on hover without typing to release that focus.
      for (let index = 0; index < 2; index++) {
        pointer("move", 1);
        const main = widget.render(120);
        expect(main[1]).toMatch(/^● Fabric/);
        expect(main[2]).toMatch(/^○ reviewer/);
        pointer("move", 2);
        expect(widget.render(120)[2]).toMatch(/^● reviewer/);
      }
      expect(editor.handleInput).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      returnToMain();
      open.mockRestore();
      controller.stop();
    }
  });

  it("moves the label to the editor border and collapses the list while only Main is left", () => {
    const { controller, editorBox, list } = mount("regular", { agents: false, label: "PBO-21" });
    try {
      // Pi's editor render now carries the label at the right of its top border.
      expect(stripVTControlCharacters(editorBox.render(40)[0]!)).toBe(`${"─".repeat(30)} PBO-21 ──`);
      expect(editorBox.render(40)[2]).toBe("─".repeat(40));
      expect(list().render(40)).toEqual([]);
      controller.stop();
      // Stopping restores Pi's own render.
      expect(editorBox.render(40)[0]).toBe("─".repeat(40));
    } finally {
      controller.stop();
    }
  });

  it("keeps the header when the editor border is too narrow to show the label", () => {
    const { controller, editorBox, list } = mount("regular", { agents: false, label: "PBO-21" });
    try {
      // A 10-column border has no room for the badge; Pi draws it before the list each frame.
      expect(editorBox.render(10)[0]).toBe("─".repeat(10));
      expect(list().render(40)[1]).toMatch(/^● PBO-21/);
      // Wide enough again: the badge shows, and the header-only list collapses.
      expect(stripVTControlCharacters(editorBox.render(40)[0]!)).toContain(" PBO-21 ");
      expect(list().render(40)).toEqual([]);
    } finally {
      controller.stop();
    }
  });

  it("collapses a header-only list without a label, such as for idle actors", () => {
    const { controller, editorBox, list } = mount("regular", { agents: false, idleActors: true });
    try {
      // Two idle actors keep the widget mounted, but give it nothing to select.
      expect(controller.snapshot().actors).toHaveLength(2);
      expect(list().render(120)).toEqual([]);
      expect(editorBox.render(40)[0]).toBe("─".repeat(40));
    } finally {
      controller.stop();
    }
  });

  it("leaves another extension's later render wrapper in place when it stops", () => {
    const { controller, editorBox } = mount("regular", { agents: false, label: "PBO-21" });
    // Another extension wraps Pi's editor container after Fabric did.
    const fabricRender = editorBox.render;
    editorBox.render = (width: number) => fabricRender(width).map((line, index) => index === 1 ? "> other" : line);
    const otherRender = editorBox.render;
    controller.stop();
    expect(editorBox.render).toBe(otherRender);
    // Fabric's layer passes through: no badge, the other wrapper still applies.
    expect(editorBox.render(40)).toEqual(["─".repeat(40), "> other", "─".repeat(40)]);
  });

  it("keeps the list and the border label while agents run", () => {
    const { controller, editorBox, list } = mount("regular", { label: "PBO-21" });
    try {
      // The label always sits on the editor border, list or not.
      expect(stripVTControlCharacters(editorBox.render(40)[0]!)).toBe(`${"─".repeat(30)} PBO-21 ──`);
      expect(list().render(120)[1]).toMatch(/^● PBO-21 /);
    } finally {
      controller.stop();
    }
  });

  it("redocks after Pi remounts its containers in another renderer", async () => {
    const { controller, below, host, footer, editorBox, list } = mount("regular");
    try {
      const widget = list();
      // A renderer switch rebuilds the root with Pi's containers and nothing else.
      host.children = [host.children[0], editorBox, below, footer];
      (below.children[0] as { render(width: number): string[] }).render(120);
      await Promise.resolve();
      expect(host.children.at(-1)).toBe(widget);
    } finally {
      controller.stop();
    }
  });

  it("moves focus from an empty editor into the list on ↓ and back out on ↑", () => {
    const { controller, editor, press, list, focused } = mount();
    try {
      editor.text = "draft";
      expect(press("\x1b[B")).toBeUndefined();
      expect(focused()).toBe(editor);
      editor.text = "";
      expect(press("\x1b[B")).toEqual({ consume: true });
      expect(focused()).toBe(list());
      // A focused widget owns input: the listener lets its own ↓ through.
      expect(press("\x1b[B")).toBeUndefined();
      list().handleInput("\x1b[A");
      expect(focused()).toBe(editor);
    } finally {
      controller.stop();
    }
  });

  it("falls back to the below-editor slot in an unknown layout and stays last there", async () => {
    vi.useFakeTimers();
    const { controller, setWidget, below, list } = mount("unknown");
    try {
      const widget = list();
      expect(setWidget).toHaveBeenCalledTimes(2);
      expect(below.children).toEqual([widget]);
      widget.render(120);
      below.children.push({ render: () => ["status line"] });
      widget.render(120);
      widget.render(120);
      await vi.advanceTimersByTimeAsync(0);
      expect(setWidget).toHaveBeenCalledTimes(3);
      expect(below.children.at(-1)).toBe(widget);
      expect(list()).toBe(widget);
      // Already last: no further moves.
      widget.render(120);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(setWidget).toHaveBeenCalledTimes(3);
    } finally {
      controller.stop();
      vi.useRealTimers();
    }
  });

  it("opens the tasks view for a shell row and the conversation for an agent row", async () => {
    const { controller, editor, press, list } = mount("regular", { shells: true });
    const openTasks = vi.spyOn(controller, "openTasks").mockResolvedValue();
    const openConversation = vi.spyOn(controller, "openConversation").mockResolvedValue();
    try {
      const lines = list().render(120);
      expect(lines[2]).toMatch(/^○ reviewer /);
      expect(lines[3]).toMatch(/^○ job-1 spilled · /);
      editor.text = "";
      press("\x1b[B");
      list().handleInput("\x1b[B");
      list().handleInput("\r");
      await Promise.resolve();
      expect(openTasks).toHaveBeenCalledWith(expect.anything(), "job-1");
      expect(openConversation).not.toHaveBeenCalled();
      // Closing the tasks view returns to the list, still on the shell.
      await Promise.resolve();
      expect(list().focused).toBe(true);
      list().handleInput("\x1b[A");
      list().handleInput("\r");
      await Promise.resolve();
      expect(openConversation).toHaveBeenCalledWith(expect.anything(), "agent-1");
    } finally {
      controller.stop();
    }
  });

  it("keeps the opened row filled while its view opens, so the header never flickers", async () => {
    const { controller, editor, press, list } = mount();
    let finish!: () => void;
    vi.spyOn(controller, "openConversation").mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    try {
      editor.text = "";
      press("\x1b[B");
      list().handleInput("\r");
      // Focus is back on the editor while the conversation loads.
      expect(list().focused).toBe(false);
      const opening = list().render(120);
      expect(opening[1]).toMatch(/^○ /);
      expect(opening[2]).toMatch(/^● reviewer /);
      finish();
      await Promise.resolve();
      await Promise.resolve();
      expect(list().focused).toBe(true);
      expect(list().render(120)[2]).toMatch(/^● reviewer /);
    } finally {
      controller.stop();
    }
  });

  it("removes the input listener and mounted mouse target on stop", () => {
    const { controller, host, list, listeners, press } = mount();
    const widget = list();
    expect(listeners()).toBe(1);
    widget.render(120);
    controller.stop();
    expect(listeners()).toBe(0);
    expect(press("\x1b[B")).toBeUndefined();
    expect(host.children).not.toContain(widget);
    controller.stop();
    expect(listeners()).toBe(0);
  });

  it("leaves ↓ to an open overlay", () => {
    const { controller, press, setOverlay, editor, focused } = mount();
    try {
      setOverlay(true);
      expect(press("\x1b[B")).toBeUndefined();
      expect(focused()).toBe(editor);
    } finally {
      controller.stop();
    }
  });
});
