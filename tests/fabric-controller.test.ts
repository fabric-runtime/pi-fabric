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
