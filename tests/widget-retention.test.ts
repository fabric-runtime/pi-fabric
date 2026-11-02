import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FabricState } from "../src/fabric-state.js";
import type { FabricParticipantInfo } from "../src/topology/types.js";
import { FabricUiController } from "../src/ui/controller.js";
import { FabricWidgetRetention } from "../src/ui/retention.js";
import { FabricWidget, shouldShowFabricWidget } from "../src/ui/widget.js";
import type { FabricDashboardSnapshot, FabricUiAgent } from "../src/ui/types.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
const agent = (id: string, finishedAt?: number): FabricUiAgent => ({
  id, name: id, status: "completed", transport: "local", cwd: "/tmp",
  startedAt: 1, ...(finishedAt === undefined ? {} : { updatedAt: finishedAt, finishedAt }),
  text: "retained result", logFile: "/tmp/events.jsonl",
});
const snapshot = (): FabricDashboardSnapshot => ({
  now: Date.now(), runs: [], agents: [], actors: [], peers: [], globalActors: [],
  state: [], events: [], componentGraph: { components: [], edges: [], cycles: [] },
  main: { id: "main", name: "Main", kind: "main", status: "idle", runner: "pi", transport: "host",
    cwd: "/tmp", startedAt: 1, updatedAt: 1, pendingMessages: false, local: true },
});
afterEach(() => vi.useRealTimers());

/** The widget's rows below the blank spacer that separates it from the editor. */
const body = (lines: string[]): string[] => {
  expect(lines[0]).toBe("");
  return lines.slice(1);
};

describe("widget display-only completion retention", () => {
  it.each(["completed", "failed", "stopped", "timed_out", "cancelled"])("expires %s at exactly 30 seconds and auto-hides without mutating stored data", status => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    let current = snapshot();
    current.agents = [{ ...agent("finished", 10_000), status }];
    const stored = structuredClone(current);
    const retention = new FabricWidgetRetention();
    const widget = new FabricWidget(theme, () => current, 10, undefined, retention);
    expect(body(widget.render(160))).toHaveLength(2);
    vi.setSystemTime(39_999); current = { ...current, now: Date.now() };
    expect(body(widget.render(160)).join("\n")).toContain("finished");
    expect(shouldShowFabricWidget(current, "auto", retention)).toBe(true);
    vi.setSystemTime(40_000); current = { ...current, now: Date.now() };
    expect(widget.hasChanged()).toBe(true);
    expect(body(widget.render(160))).toHaveLength(1);
    expect(shouldShowFabricWidget(current, "auto", retention)).toBe(false);
    expect(shouldShowFabricWidget(current, "always", retention)).toBe(true);
    expect(shouldShowFabricWidget(current, "hidden", retention)).toBe(false);
    expect(current.agents).toEqual(stored.agents);
    expect(current.agents[0]!.text).toBe("retained result");
    expect(current.agents[0]!.logFile).toBe("/tmp/events.jsonl");
  });

  it("retires rows gradually, updates overflow and running counts, and shrinks height without padding", () => {
    vi.useFakeTimers(); vi.setSystemTime(39_999);
    let current = snapshot();
    current.agents = [agent("older", 10_000), agent("newer", 15_000), { ...agent("live"), status: "running" }];
    const compact = new FabricWidget(theme, () => current, 4);
    const full = new FabricWidget(theme, () => current, 8);
    expect(body(compact.render(160)).at(-1)).toContain("↓ 2 more");
    expect(body(full.render(160))).toHaveLength(4);
    expect(body(full.render(160))[0]).toContain("1 running");
    vi.setSystemTime(40_000); current = { ...current, now: Date.now() };
    expect(body(compact.render(160)).join("\n")).not.toContain("more");
    expect(body(compact.render(160))).toHaveLength(3);
    expect(body(full.render(160))).toHaveLength(3);
    expect(body(full.render(160)).join("\n")).not.toContain("older");
    vi.setSystemTime(44_999); current = { ...current, now: Date.now() };
    expect(body(full.render(160)).join("\n")).toContain("newer");
    vi.setSystemTime(45_000); current = { ...current, now: Date.now() };
    expect(body(compact.render(160))[0]).not.toContain("more");
    expect(body(full.render(160))).toHaveLength(2);
    expect(body(full.render(160)).every(line => line.trim().length > 0)).toBe(true);
    expect(body(full.render(160))[0]).toContain("1 running");
    expect(shouldShowFabricWidget(current, "auto")).toBe(true);
    expect(current.agents).toHaveLength(3);
  });

  it("freezes missing finishedAt fallbacks across heartbeat snapshots, and renews only after a new execution", () => {
    const retention = new FabricWidgetRetention();
    const current = snapshot(); current.now = 10_000;
    const unknown = agent("unknown");
    delete unknown.startedAt;
    current.agents = [{ ...agent("updated"), updatedAt: 10_000 }, { ...agent("started"), startedAt: 10_000 }, unknown];
    retention.sync(current);
    expect(current.agents.map(row => retention.finishedAt(row, current.now))).toEqual([10_000, 10_000, 10_000]);
    current.now = 39_999;
    current.agents = current.agents.map(row => ({ ...row, updatedAt: current.now }));
    retention.sync(current);
    expect(current.agents.every(row => retention.visible(row, current))).toBe(true);
    current.now = 40_000;
    retention.sync(current);
    expect(current.agents.some(row => retention.visible(row, current))).toBe(false);
    current.agents[0]!.status = "running"; retention.sync(current);
    current.agents[0]!.status = "completed"; current.agents[0]!.updatedAt = 40_000;
    retention.sync(current);
    expect(retention.visible(current.agents[0]!, current)).toBe(true);
    expect(current.agents[0]).not.toHaveProperty("finishedAt", expect.any(Number));
  });

  it("keeps idle resident agents and actors, honors dismissal, and tolerates negative/backward clocks", () => {
    const retention = new FabricWidgetRetention(); const current = snapshot();
    current.now = -1;
    current.agents = [agent("negative", -10_000)];
    expect(retention.visible(current.agents[0]!, current)).toBe(true);
    current.now = -20_000;
    expect(retention.visible(current.agents[0]!, current)).toBe(true);
    current.now = 20_000;
    expect(retention.visible(current.agents[0]!, current)).toBe(false);
    current.now = 10_000; current.widgetDismissedAt = 10_000;
    current.agents = [agent("dismissed", 10_000)];
    expect(shouldShowFabricWidget(current, "auto", retention)).toBe(false);
    current.agents.push({ ...agent("resident", 1), status: "idle", residency: "durable" });
    current.now = 100_000;
    expect(shouldShowFabricWidget(current, "auto", retention)).toBe(true);
    expect(body(new FabricWidget(theme, () => current, 8, undefined, retention).render(160)).join("\n")).toContain("resident");
    current.agents = [];
    current.actors = [{ id: "actor", name: "actor", status: "idle", worker: agent("worker", 1) } as FabricDashboardSnapshot["actors"][number]];
    const lines = body(new FabricWidget(theme, () => current, 8).render(160));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("1 actor");
    expect(lines.join("\n")).toContain("actor");
    expect(shouldShowFabricWidget(current, "auto")).toBe(true);
  });
});

const controllerFixture = (refreshMs: number, participants: FabricParticipantInfo[]) => {
  const main = snapshot().main;
  let onAgent = () => {};
  const state = {
    initialized: true, widgetDismissedAt: 0,
    config: { ui: { enabled: true, refreshMs, widget: "auto", maxRows: 8, eventHistory: 80 }, mesh: { enabled: false } },
    activity: { subscribe: () => () => {}, runs: () => [] },
    agents: { subscribeUi: (listener: () => void) => { onAgent = listener; return () => {}; }, list: () => [] },
    actors: { subscribe: () => () => {}, list: () => [] }, globalActors: { list: () => [] },
    mainAgentInfo: () => main, participantInfos: () => participants, peerInfos: () => [],
  } as unknown as FabricState;
  let widget: FabricWidget | undefined;
  const requestRender = vi.fn(); const tui = { requestRender } as unknown as TUI;
  const setWidget = vi.fn((_key: string, content: unknown) => {
    if (typeof content === "function") widget = (content as (tui: TUI, theme: Theme) => FabricWidget)(tui, theme);
  });
  const context = { mode: "tui", ui: { setWidget, notify: vi.fn() } } as unknown as ExtensionContext;
  const controller = new FabricUiController(state);
  return { controller, context, setWidget, requestRender, widget: () => widget!, refresh: () => onAgent() };
};
const participant = (id: string, finishedAt?: number): FabricParticipantInfo => ({
  ...agent(id, finishedAt), format: 1, kind: "agent", rootId: "main", ownerHostId: "remote", ownerIdentityId: "remote",
  transport: "host", capabilities: ["attach"], startedAt: 1, updatedAt: finishedAt ?? 10_000,
  controlProtocol: "v1", local: false, stale: false,
});

describe("controller idle expiry repaint", () => {
  it.each([1000, 60_000])("repaints at individual deadlines even with refreshMs=%s, preserving participant and dashboard data", async refreshMs => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const records = [participant("older", 10_000), participant("newer", 15_000),
      { ...participant("root", 1), kind: "root" as const }];
    const stored = structuredClone(records); const h = controllerFixture(refreshMs, records);
    try {
      h.controller.start(h.context);
      expect(body(h.widget().render(160))).toHaveLength(3);
      expect(h.controller.snapshot().agents.map(row => row.id).sort()).toEqual(["newer", "older"]);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(body(h.widget().render(160)).join("\n")).toContain("older");
      h.requestRender.mockClear();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.requestRender).toHaveBeenCalled();
      expect(body(h.widget().render(160))).toHaveLength(2);
      expect(body(h.widget().render(160)).join("\n")).not.toContain("older");
      expect(h.controller.snapshot().agents).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(4999);
      expect(body(h.widget().render(160)).join("\n")).toContain("newer");
      await vi.advanceTimersByTimeAsync(1);
      expect(h.setWidget).toHaveBeenLastCalledWith("pi-fabric", undefined);
      expect(h.controller.snapshot().agents).toHaveLength(2);
      expect(h.controller.snapshot().participants).toEqual(stored);
      expect(records).toEqual(stored);
      expect(vi.getTimerCount()).toBe(0);
    } finally { h.controller.stop(); }
  });

  it("does not expire or turn root peers into widget rows while their child completion expires", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const records = [participant("child", 10_000), { ...participant("root"), kind: "root" as const, status: "idle" }];
    const h = controllerFixture(60_000, records);
    const peer = { ...snapshot().main, id: "root", kind: "peer" as const, status: "idle" as const, cwd: "/tmp", startedAt: 1, local: false as const, sessionId: "peer" };
    h.controller.state.peerInfos = () => [peer];
    try {
      h.controller.start(h.context);
      expect(body(h.widget().render(160))).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.setWidget).toHaveBeenLastCalledWith("pi-fabric", undefined);
      expect(h.controller.snapshot().peers).toEqual([peer]);
      expect(h.controller.snapshot().participants).toEqual(records);
      expect(h.controller.snapshot().agents.map(row => row.id)).toEqual(["child"]);
    } finally { h.controller.stop(); }
  });

  it("does not extend fallback retention on control refresh or cache misses", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const records = [participant("legacy")]; const h = controllerFixture(60_000, records);
    try {
      h.controller.start(h.context); body(h.widget().render(160));
      await vi.advanceTimersByTimeAsync(20_000);
      records[0]!.updatedAt = 30_000; h.refresh();
      await vi.advanceTimersByTimeAsync(100);
      expect(body(h.widget().render(160)).join("\n")).toContain("legacy");
      await vi.advanceTimersByTimeAsync(9899);
      expect(h.setWidget).not.toHaveBeenLastCalledWith("pi-fabric", undefined);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.setWidget).toHaveBeenLastCalledWith("pi-fabric", undefined);
      expect(h.controller.snapshot().agents[0]!.updatedAt).toBe(30_000);
      expect(records[0]!.status).toBe("completed");
    } finally { h.controller.stop(); }
  });
});
