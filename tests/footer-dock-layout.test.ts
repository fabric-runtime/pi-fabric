import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Component, type TUI, type VStack } from "@earendil-works/pi-tui";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FabricState } from "../src/fabric-state.js";
import { FabricUiController } from "../src/ui/controller.js";
import { FabricWidget } from "../src/ui/widget.js";

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const STATUS = "Codex Usage: 5h 82% · weekly 74%";
const controllers: FabricUiController[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.stop(); vi.useRealTimers(); });
const lines = (content: string[]): Component => ({ render: () => content, invalidate: () => {} });

const mount = (statusFirst = true) => {
  vi.useFakeTimers();
  const terminal = { rows: 16 };
  const editorLines = ["─".repeat(80), ...Array.from({ length: 6 }, (_, i) => `draft ${i}`), "─".repeat(80)];
  const below = new Container();
  const footer = new Container(); footer.addChild(lines(["~/project (main)", "openai/gpt-6-astra"]));
  const viewport = createChatViewport({
    document: lines(Array.from({ length: 30 }, (_, i) => `transcript ${i}`)),
    pendingMessages: lines([]), status: lines(["Working"]), widgetsAbove: lines([""]),
    editor: lines(editorLines), widgetsBelow: below, footer, scrollbar: "hidden",
  });
  const tui = { terminal, getMountedRoots: () => [viewport.root], get children() { return [viewport.root]; }, requestRender: vi.fn(), setFocus: vi.fn() } as unknown as TUI;
  const widgets = new Map<string, Component>();
  // The same below-editor factory and key used by pi-better-openai's status mode.
  const setWidget = vi.fn((key: string, content: ((tui: TUI, theme: Theme) => Component) | undefined) => {
    (widgets.get(key) as (Component & { dispose?: () => void }) | undefined)?.dispose?.();
    widgets.delete(key);
    if (content) widgets.set(key, content(tui, theme));
    below.clear(); for (const widget of widgets.values()) below.addChild(widget);
  });
  const status = (content: string[] | undefined = [STATUS]) => setWidget("better-openai", content ? () => lines(content) : undefined);
  if (statusFirst) status();
  const state = {
    initialized: true,
    config: { ui: { enabled: true, widget: "always", maxRows: 6, refreshMs: 60000, eventHistory: 80 }, mesh: { enabled: false } },
    activity: { subscribe: () => () => {}, runs: () => [] },
    agents: {
      list: () => Array.from({ length: 10 }, (_, i) => ({ id: `agent-${i}`, name: `reviewer-${i}`, status: "running", transport: "process", cwd: "/tmp", model: "openai/gpt-6-astra", task: "Review", startedAt: Date.now(), turns: 0, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } })),
      subscribeUi: () => () => {},
    },
    actors: { list: () => [], subscribe: () => () => {} }, globalActors: { list: () => [] },
    mainAgentInfo: () => ({ id: "session:test", name: "Main", kind: "main", status: "idle", runner: "pi", transport: "host", cwd: "/tmp/project", sessionId: "test", startedAt: 1, updatedAt: 1, pendingMessages: false, local: true }),
    widgetDismissedAt: 0,
  } as unknown as FabricState;
  const context = { mode: "tui", hasUI: true, ui: { setWidget, notify: vi.fn(), onTerminalInput: () => () => {} } } as unknown as ExtensionContext;
  const controller = new FabricUiController(state); controllers.push(controller);
  const frame = (width = 80) => renderLayoutFrame(viewport.root, width, terminal.rows, () => {}).lines.map(stripVTControlCharacters);
  const list = () => ((viewport.root as VStack).children[1] as VStack).children.find(child => child instanceof FabricWidget) as FabricWidget;
  return { controller, context, frame, terminal, setWidget, footer, status, list, widgets, editorLines };
};

describe("Fabric dock with native Pi fullscreen layout", () => {
  it.each([true, false])("keeps Better OpenAI's status and native footer visible (status installed first: %s)", statusFirst => {
    const h = mount(statusFirst);
    if (statusFirst) expect(h.frame().join("\n")).toContain(STATUS);
    h.controller.start(h.context);
    if (!statusFirst) h.status();
    const text = h.frame().join("\n");
    expect(text).toContain(STATUS);
    expect(text).toContain("openai/gpt-6-astra");
    expect(text).toContain("draft 5");
    expect(text).toContain("Working");
    expect(h.list().render(80)).toHaveLength(2);
    expect(h.context.ui.notify).not.toHaveBeenCalled();
  });

  it("caps the configured height, shrinks through zero rows and restores the same list while focused", () => {
    const h = mount(); h.controller.start(h.context);
    const list = h.list(); list.focused = true;
    h.terminal.rows = 30;
    expect(h.frame().join("\n")).toContain(STATUS);
    expect(list.render(80)).toHaveLength(6);
    h.terminal.rows = 16;
    expect(h.frame().join("\n")).toContain(STATUS);
    expect(list.render(80)).toHaveLength(2);
    h.terminal.rows = 14;
    expect(h.frame().join("\n")).toContain(STATUS);
    expect(list.render(80)).toEqual([]);
    expect(list.hasRows()).toBe(false);
    h.terminal.rows = 30;
    expect(h.frame().join("\n")).toContain(STATUS);
    expect(list.render(80)).toHaveLength(6);
    expect(h.list()).toBe(list);
  });

  it("tracks live external status and footer replacement without replacing their components", () => {
    const h = mount(); h.controller.start(h.context);
    const list = h.list();
    h.status([STATUS, "reset in 2h", "weekly reset in 4d"]);
    let text = h.frame().join("\n");
    expect(text).toContain(STATUS); expect(text).toContain("weekly reset in 4d");
    expect(list.render(80)).toEqual([]);
    h.status();
    h.footer.clear(); h.footer.addChild(lines(["Better OpenAI footer", "model and tier", "quota and resets", "another extension status"]));
    text = h.frame().join("\n");
    expect(text).toContain(STATUS); expect(text).toContain("another extension status");
    expect(list.render(80)).toEqual([]);
    const status = h.widgets.get("better-openai");
    h.controller.stop();
    expect(h.widgets.get("better-openai")).toBe(status);
    expect(h.frame().join("\n")).toContain("Better OpenAI footer");
    expect(h.frame().join("\n")).toContain(STATUS);
  });

  it("measures other widgets at the current width when their status wraps", () => {
    const h = mount(); h.controller.start(h.context);
    h.setWidget("better-openai", () => ({
      render: width => width >= 60 ? [STATUS] : [STATUS, "reset in 2h", "weekly reset in 4d"], invalidate() {},
    }));
    expect(h.frame(80).join("\n")).toContain(STATUS);
    expect(h.list().render(80)).toHaveLength(2);
    expect(h.frame(40).join("\n")).toContain("weekly reset in 4d");
    expect(h.list().render(40)).toEqual([]);
    expect(h.frame(80).join("\n")).toContain(STATUS);
    expect(h.list().render(80)).toHaveLength(2);
  });

  it("reclaims only the rows an external widget or editor gives back", () => {
    const h = mount(); h.controller.start(h.context); h.frame();
    expect(h.list().render(80)).toHaveLength(2);
    h.setWidget("better-openai", undefined); h.frame();
    expect(h.list().render(80)).toHaveLength(3);
    h.editorLines.splice(1, 5); h.status();
    expect(h.frame().join("\n")).toContain(STATUS);
    expect(h.list().render(80)).toHaveLength(6);
  });
});
