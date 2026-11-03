import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { projectAgentTranscript } from "../src/ui/transcript.js";
import type { FabricDashboardSnapshot, FabricUiAgent } from "../src/ui/types.js";
import { FabricWidget, shouldShowFabricWidget, widgetViewport, type FabricWidgetInteraction, type FabricWidgetRow } from "../src/ui/widget.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;

const agent = (id: string, name: string, status = "running"): FabricUiAgent => ({
  id,
  name,
  status,
  transport: "process",
  cwd: "/tmp",
  startedAt: Date.now() - 5_000,
  toolCalls: 1,
});

type MutableSnapshot = FabricDashboardSnapshot & { agents: FabricUiAgent[]; actors: unknown[] };

const snapshot = (): MutableSnapshot => {
  const now = Date.now();
  return {
    now,
    main: { ...agent("main", "main"), status: "idle" },
    peers: [],
    runs: [],
    agents: [agent("agent-1", "security-reviewer")],
    actors: [
      {
        id: "actor-1",
        scope: "project",
        name: "advisor",
        status: "running",
        worker: agent("worker-1", "advisor-worker"),
        instructions: "",
        recentMessages: [],
      },
    ],
    componentGraph: { nodes: [], edges: [] },
    globalActors: [],
    state: [],
    events: [],
  } as unknown as MutableSnapshot;
};

const setup = (options: {
  current?: FabricDashboardSnapshot;
  terminalRows?: number;
  maxRows?: number;
  open?: boolean;
  interaction?: Partial<FabricWidgetInteraction>;
} = {}) => {
  const current = options.current ?? snapshot();
  const opened: FabricWidgetRow[] = [];
  const forwarded: string[] = [];
  let released = 0;
  const widget: FabricWidget = new FabricWidget(theme, () => current, options.maxRows ?? 6, () => options.terminalRows ?? 40, undefined, {
    release: (forward) => {
      released++;
      if (forward !== undefined) forwarded.push(forward);
      widget.focused = false;
    },
    requestRender: () => {},
    ...(options.open === false ? {} : { open: (row: FabricWidgetRow) => { opened.push(row); } }),
    ...options.interaction,
  });
  return { widget, opened, forwarded, released: () => released };
};

const manyAgents = (count: number): MutableSnapshot => {
  const current = snapshot();
  current.agents = Array.from({ length: count }, (_, index) => agent(`agent-${index}`, `agent-${index}`));
  current.actors = [];
  return current;
};

const mouse = (widget: FabricWidget, type: "move" | "click", y: number) =>
  widget.handleMouse({ type, button: type === "move" ? "none" : "left", x: 4, y, screenX: 4, screenY: y, width: 100, height: 8, shift: false, alt: false, ctrl: false });

describe("participant observations", () => {
  it("nests observer handles beneath the exact participant instead of counting them as shells", () => {
    const current = snapshot();
    current.shells = [{ id: "observe-123", tool: "monitor", command: "Observe reviewer", status: "spilled", startedAt: current.now - 1000, spilledAt: current.now - 1000, eventCount: 0, unread: false, stopping: false,
      observes: { kind: "participant", id: "agent-1" }, monitor: { delivery: "wake", timeoutMs: 300000, intervalMs: 5000 } }];
    const { widget } = setup({ current, maxRows: 8 });
    const lines = widget.render(140);
    const parent = lines.findIndex(line => line.includes("security-reviewer"));
    expect(lines[parent + 1]).toContain("╰─ ○ observe- watching · wake owner");
    expect(lines[1]).toContain("1 observation");
    expect(lines[1]).not.toContain("1 shell");
  });
});

describe("agent transcript projection", () => {
  it("keeps thinking text from streamed worker deltas", () => {
    const entries = projectAgentTranscript([
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Checking the " } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "new branch state" } },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "src/a.ts" } },
    ]).entries;
    expect(entries.find((entry) => entry.kind === "thinking")?.text).toBe("Checking the new branch state");
    expect(entries.some((entry) => entry.kind === "tool" && entry.toolName === "read")).toBe(true);
  });

  it("finishes the thinking of a reply that did not stream and keeps it for retained sessions", () => {
    const streamed = projectAgentTranscript([
      { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "done" }] } },
    ]).entries;
    expect(streamed.find((entry) => entry.kind === "thinking")).toMatchObject({ text: "plan", status: "completed" });
    const retained = projectAgentTranscript([
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "first" }, { type: "text", text: "a" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "second" }, { type: "text", text: "b" }] } },
    ]).entries.filter((entry) => entry.kind === "thinking");
    expect(retained.map((entry) => [entry.text, entry.status])).toEqual([["first", "completed"], ["second", "completed"]]);
  });
});

describe("Fabric agent list", () => {
  const wheel = (widget: FabricWidget, delta: number, y = 2, x = 4) => widget.handleMouse({
    type: "wheel", button: "none", x, y, screenX: x, screenY: y, width: 100, height: 6,
    shift: false, alt: false, ctrl: false, wheelDelta: delta,
  });

  it("reserves the overflow slot independently of scroll position", () => {
    expect(widgetViewport(0, 4, 10)).toEqual({ windowRows: 4, hasCue: false, maxOffset: 0, offset: 0 });
    expect(widgetViewport(2, 4, 10)).toEqual({ windowRows: 4, hasCue: false, maxOffset: 0, offset: 0 });
    for (const offset of [0, 1, 7, 99]) {
      expect(widgetViewport(10, 4, offset)).toEqual({ windowRows: 3, hasCue: true, maxOffset: 7, offset: Math.min(offset, 7) });
    }
  });

  it("scrolls only inside the overflowing widget and clamps at both ends without height jitter", () => {
    const current = manyAgents(8); current.sessionLabel = "OS-3";
    const { widget } = setup({ current, maxRows: 6 });
    const first = widget.render(100);
    expect(first).toHaveLength(6);
    expect(first[1]).toContain("OS-3");
    expect(first[1]).not.toContain("more");
    expect(first[2]).toContain("agent-0");
    expect(first.at(-1)).toBe("↓ 5 more");
    for (const [y, x] of [[0, 4], [-1, 4], [6, 4], [2, -1], [2, 100]]) {
      expect(wheel(widget, 1, y, x)).toBeUndefined();
    }
    expect(wheel(widget, 2)).toEqual({ handled: true, render: true });
    const middle = widget.render(100);
    expect(middle).toHaveLength(first.length);
    expect(middle[1]).toMatch(/↑ 2 more$/);
    expect(middle[1]).not.toMatch(/↓ \d+ more/);
    expect(middle[2]).toContain("agent-2");
    expect(middle.at(-1)).toBe("↓ 3 more");
    expect(wheel(widget, 100)).toEqual({ handled: true, render: true });
    const last = widget.render(100);
    expect(last).toHaveLength(first.length);
    expect(last[1]).toMatch(/↑ 5 more$/);
    expect(last[4]).toContain("agent-7");
    expect(last.at(-1)).toBe("");
    expect(wheel(widget, 100)).toEqual({ handled: true, render: false });
    wheel(widget, -100);
    expect(widget.render(100)).toEqual(first);
    expect(wheel(widget, -100)).toEqual({ handled: true, render: false });
  });

  it("reclamps on resize and child removal, grows to the cap, and does not pad idle content", () => {
    let rows = 12;
    const current = manyAgents(0); current.sessionLabel = "OS-3";
    const widget = new FabricWidget(theme, () => current, 6, () => rows, undefined, { release() {}, requestRender() {} });
    expect(widget.render(100)).toHaveLength(2);
    expect(wheel(widget, 1)).toBeUndefined();
    current.agents = manyAgents(2).agents; widget.invalidate();
    expect(widget.render(100)).toHaveLength(4);
    expect(wheel(widget, 1)).toBeUndefined();
    current.agents = manyAgents(20).agents; widget.invalidate();
    expect(widget.render(100)).toHaveLength(6);
    wheel(widget, 100); widget.render(100);
    for (const width of [1, 2, 8, 20, 100]) {
      const lines = widget.render(width);
      expect(lines).toHaveLength(6);
      expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
    }
    rows = 8;
    const small = widget.render(100);
    expect(small).toHaveLength(4);
    expect(small[2]).toContain("agent-17");
    expect(small.at(-1)).toMatch(/^↓ /);
    current.agents = manyAgents(1).agents; widget.invalidate();
    expect(widget.render(100)).toHaveLength(3);
    expect(widget.render(100)[2]).toContain("agent-0");
    current.agents = []; widget.invalidate();
    expect(widget.render(100)).toHaveLength(2);
  });
  it("opens the selected participant on Enter, as in Claude Code", () => {
    const current = snapshot();
    current.agents = [{ ...agent("agent-1", "security-reviewer"), model: "anthropic/claude-sonnet-5-5" }];
    const { widget, opened } = setup({ current });
    const unfocused = widget.render(120);
    expect(unfocused[0]).toBe("");
    expect(unfocused[1]).toMatch(/^● Fabric .*↓ to manage$/);
    expect(unfocused[2]).toMatch(/^○ security-reviewer .*claude-sonnet-5-5/);
    widget.focused = true;
    widget.selectFirst();
    const focused = widget.render(120);
    // Focus moves the filled circle from the header to the selected row.
    expect(focused[1]).toMatch(/^○ Fabric .*⏎ open · ↑↓ select · esc back$/);
    expect(focused[2]).toMatch(/^● security-reviewer /);
    widget.handleInput("\x1b[B");
    widget.handleInput("\r");
    expect(opened).toMatchObject([{ id: "actor-1", kind: "actor" }]);
  });

  it("has no inline preview: Space goes back to the editor like any other key", () => {
    const { widget, forwarded, released } = setup();
    widget.focused = true;
    widget.selectFirst();
    widget.handleInput(" ");
    expect(released()).toBe(1);
    expect(forwarded).toEqual([" "]);
  });

  it("heads the list with the session label and keeps it when idle", () => {
    const current = snapshot();
    current.agents = [];
    current.actors = [];
    expect(shouldShowFabricWidget(current, "auto")).toBe(false);
    current.sessionLabel = "PBO-21";
    expect(shouldShowFabricWidget(current, "auto")).toBe(true);
    expect(shouldShowFabricWidget(current, "hidden")).toBe(false);
    const { widget } = setup({ current });
    expect(widget.render(100)).toEqual(["", "● PBO-21"]);
  });

  it("lists nested agents as a tree under their parents", () => {
    const current = snapshot();
    const at = (offset: number) => Date.now() - 60_000 + offset;
    current.actors = [];
    current.agents = [
      { ...agent("planner", "planner"), startedAt: at(0) },
      { ...agent("reviewer", "reviewer"), startedAt: at(1_000) },
      // Started after reviewer, so creation order alone would draw it under reviewer.
      { ...agent("api", "api-audit"), parentId: "planner", nestingDepth: 1, startedAt: at(2_000) },
      { ...agent("api-child", "api-child"), parentId: "api", startedAt: at(2_500) },
      { ...agent("ui", "ui-audit", "completed"), parentId: "planner", nestingDepth: 1, startedAt: at(3_000), finishedAt: Date.now() },
      { ...agent("fixture", "fixture", "failed"), parentId: "ui", nestingDepth: 2, startedAt: at(4_000), finishedAt: Date.now(), error: "timed out" },
    ];
    const { widget } = setup({ current, maxRows: 10 });
    const rows = widget.render(160).slice(2).map((line) => line.replace(/^(.*?○ \S+).*$/, "$1"));
    expect(rows).toEqual(["○ planner", "├─ ○ api-audit", "│  └─ ○ api-child", "└─ ○ ui-audit", "   └─ ○ fixture", "○ reviewer"]);
    widget.focused = true;
    widget.selectFirst();
    widget.handleInput("\x1b[B");
    expect(widget.render(160)[3]).toMatch(/^├─ ● api-audit/);
  });

  it("keeps deep nested rows readable on narrow terminals and promotes missing parents", () => {
    const current = snapshot();
    current.actors = [];
    current.agents = Array.from({ length: 8 }, (_, index) => ({
      ...agent(`deep-${index}`, `node${index}`),
      parentId: index === 0 ? "missing" : `deep-${index - 1}`,
    }));
    const { widget } = setup({ current, maxRows: 12 });
    const rows = widget.render(24);
    expect(rows[2]).toMatch(/^○ node0/);
    expect(rows[9]).toContain("○ node7");
    expect(rows[9]).toMatch(/^…/);
    expect(rows.every((line) => visibleWidth(line) <= 24)).toBe(true);
  });

  it("shows a running agent's milestone in place of its tool name", () => {
    const current = snapshot();
    current.actors = [];
    current.agents = [{ ...agent("agent-1", "probe"), currentTool: "fabric_exec", milestone: "Trace token refresh" }];
    const { widget } = setup({ current });
    expect(widget.render(160)[2]).toMatch(/^○ probe  Trace token refresh · /);
    current.agents = [{ ...agent("agent-1", "probe"), currentTool: "read" }];
    widget.invalidate();
    expect(widget.render(160)[2]).toMatch(/^○ probe  read · /);
  });

  it("lists exact shell tasks after agents and opens their details directly", () => {
    const current = snapshot(); current.actors = [];
    current.shells = Array.from({ length: 5 }, (_, index) => ({
      id: `shell-${index}-0000`, tool: "bash", command: `sleep ${index}`, startedAt: current.now - 1_000,
      spilledAt: current.now, status: "spilled", eventCount: 0, unread: false, stopping: false,
    })) as NonNullable<FabricDashboardSnapshot["shells"]>;
    const { widget, opened } = setup({ current, maxRows: 10 });
    const lines = widget.render(120);
    expect(lines[1]).not.toContain("ctrl+alt+t");
    expect(lines[2]).toMatch(/^○ security-reviewer /);
    expect(lines.slice(3).every(line => /^○ shell-\d/.test(line))).toBe(true);
    expect(lines).toHaveLength(8);
    widget.focused = true; widget.selectFirst(); widget.handleInput("\x1b[B");
    expect(widget.render(120)[3]).toMatch(/^● shell-0/);
    widget.handleInput("\r");
    expect(opened.at(-1)).toMatchObject({ id: "shell-0-0000", kind: "shell" });
    current.agents = []; widget.focused = false; widget.invalidate(); widget.render(120);
    expect(mouse(widget, "click", 3)).toEqual({ handled: true, render: true });
    expect(opened.at(-1)).toMatchObject({ id: "shell-1-0000", kind: "shell", name: "sleep 1" });
  });

  it("emphasises a selected shell's id like an agent's name", () => {
    const current = snapshot();
    current.agents = [];
    current.actors = [];
    current.shells = [{ id: "3f4985ff-0000", tool: "bash", command: "sleep 90", description: "Probe sleep", startedAt: current.now - 1_000,
      spilledAt: current.now, status: "spilled", eventCount: 0, unread: false, stopping: false }] as NonNullable<FabricDashboardSnapshot["shells"]>;
    const marking = { ...theme, fg: (color: string, text: string) => `<${color}>${text}</>`, bold: (text: string) => `<b>${text}</b>` } as unknown as Theme;
    const widget = new FabricWidget(marking, () => current, 6, () => 40, undefined, { release: () => {}, requestRender: () => {}, open: () => {} });
    expect(widget.render(120)[2]).toContain("<muted>3f4985ff</>");
    widget.focused = true;
    widget.selectFirst();
    const selected = widget.render(120)[2]!;
    expect(selected).toContain("<b>3f4985ff</b>");
    expect(selected).toContain("<muted>spilled</>");
  });

  it("fills the circle under the pointer and opens a row on click", () => {
    const { widget, opened } = setup();
    const lines = widget.render(100);
    const advisor = lines.findIndex((line) => line.includes("advisor"));
    expect(lines[1]).toMatch(/^● /);
    expect(mouse(widget, "move", advisor)).toEqual({ handled: true, render: true });
    const hovered = widget.render(100);
    expect(hovered[1]).toMatch(/^○ /);
    expect(hovered[advisor]).toMatch(/^● advisor/);
    // A move within the same row does not redraw.
    expect(mouse(widget, "move", advisor)).toEqual({ handled: true });
    // Crossing the header on the way back to the editor clears the hover.
    mouse(widget, "move", 1);
    expect(widget.render(100)[advisor]).toMatch(/^○ advisor/);
    mouse(widget, "move", advisor);
    expect(mouse(widget, "click", advisor)).toEqual({ handled: true, render: true });
    expect(opened).toMatchObject([{ id: "actor-1", kind: "actor" }]);
    expect(widget.render(100)[advisor]).toMatch(/^○ advisor/);
  });

  it("hovers native Main without changing keyboard traversal or opening a conversation", () => {
    const { widget, opened, released } = setup();
    widget.focused = true;
    widget.selectFirst();
    expect(widget.render(100)[2]).toMatch(/^● security-reviewer/);

    expect(mouse(widget, "move", 1)).toEqual({ handled: true, render: true });
    expect(widget.render(100)[1]).toMatch(/^● Fabric/);
    expect(widget.render(100)[2]).toMatch(/^○ security-reviewer/);
    expect(mouse(widget, "move", 1)).toEqual({ handled: true });
    // Leaving Main restores the retained keyboard selection, without a keypress.
    mouse(widget, "move", 0);
    expect(widget.render(100)[2]).toMatch(/^● security-reviewer/);
    mouse(widget, "move", 1);
    expect(widget.render(100)[1]).toMatch(/^● Fabric/);

    // Main remains pointer-only: Up from the first agent returns to the editor.
    widget.handleInput("\x1b[A");
    expect(released()).toBe(1);
    expect(opened).toEqual([]);
  });

  it("a click on a row focuses the list when the host cannot open it", () => {
    const { widget, opened } = setup({ open: false });
    const lines = widget.render(100);
    const advisor = lines.findIndex((line) => line.includes("advisor"));
    expect(mouse(widget, "click", advisor)).toEqual({ focus: true, render: true });
    expect(opened).toEqual([]);
  });

  it("a click outside the participant rows does not take focus", () => {
    const { widget, opened } = setup();
    widget.render(100);
    expect(mouse(widget, "click", 1)).toBeUndefined();
    expect(opened).toEqual([]);
  });

  it("↑ on the top row and Esc return focus to the editor above the list", () => {
    const { widget, released } = setup();
    widget.focused = true;
    widget.selectFirst();
    widget.handleInput("\x1b[B");
    widget.handleInput("\x1b[A");
    expect(released()).toBe(0);
    widget.handleInput("\x1b[A");
    expect(released()).toBe(1);
    widget.focused = true;
    widget.handleInput("\x1b");
    expect(released()).toBe(2);
  });

  it("hands a key it does not use back to the editor with focus", () => {
    const { widget, forwarded, released } = setup();
    widget.focused = true;
    widget.selectDefault();
    widget.handleInput("x");
    expect(released()).toBe(1);
    expect(forwarded).toEqual(["x"]);
    // Ctrl+C lives in Pi's editor, so it must reach it too.
    widget.focused = true;
    widget.handleInput("\x03");
    expect(forwarded).toEqual(["x", "\x03"]);
  });

  it("keeps its configured cap while focused and every line inside the width", () => {
    const { widget } = setup({ current: manyAgents(30), terminalRows: 40 });
    const collapsed = widget.render(100);
    expect(collapsed).toHaveLength(6);
    expect(collapsed.at(-1)).toBe("↓ 27 more");
    widget.focused = true;
    widget.selectFirst();
    const focused = widget.render(100);
    expect(focused).toHaveLength(6);
    for (const width of [20, 40, 100]) {
      expect(widget.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it("renders directional overflow and keeps the footer non-interactive", () => {
    const { widget, opened } = setup({ current: manyAgents(6), terminalRows: 10, interaction: { mainId: "main", hints: false } });
    const initial = widget.render(40);
    expect(initial[1]).toMatch(/^● Fabric/);
    expect(initial[2]).toMatch(/^○ agent-0/);
    expect(initial[3]).toMatch(/^○ agent-1/);
    expect(initial[4]).toBe("↓ 4 more");
    expect(mouse(widget, "click", 4)).toBeUndefined();
    widget.focused = true; widget.selectFirst();
    for (let i = 0; i < 3; i++) widget.handleInput("\x1b[B");
    const middle = widget.render(40);
    expect(middle[1]).toMatch(/↑ 1 more$/);
    expect(middle[2]).toMatch(/^○ agent-1/);
    expect(middle[3]).toMatch(/^● agent-2/);
    expect(middle[4]).toBe("↓ 3 more");
    mouse(widget, "move", 2);
    expect(widget.render(40)[2]).toMatch(/^● agent-1/);
    expect(mouse(widget, "click", 2)).toEqual({ handled: true, render: true });
    expect(opened.at(-1)?.id).toBe("agent-1");
    for (let i = 0; i < 10; i++) widget.handleInput("\x1b[B");
    const end = widget.render(40);
    expect(end[1]).toMatch(/↑ 4 more$/);
    expect(end[3]).toMatch(/^● agent-5/);
    expect(end.at(-1)).toBe("");
    expect(end).toHaveLength(initial.length);
    expect(end.join("\n")).not.toContain("↓ ");
    for (const width of [1, 2, 8, 12, 40]) {
      expect(widget.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
    }
    const all = setup({ current: manyAgents(2), maxRows: 6, interaction: { hints: false } }).widget.render(40);
    expect(all.join("\n")).not.toMatch(/[↑↓] \d+ more/);
  });

  it("fits whole hints beside overflow labels and preserves the short viewport target", () => {
    const ansi = { ...theme, fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` } as unknown as Theme;
    const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
    for (const colors of [theme, ansi]) for (const rows of [3, 5]) {
      const current = manyAgents(6);
      const opened: FabricWidgetRow[] = [];
      const widget = new FabricWidget(colors, () => current, 6, () => 20, undefined, {
        mainId: "main", availableRows: () => rows, open: row => opened.push(row), release: () => {}, requestRender: () => {},
      });
      widget.focused = true; widget.selectFirst();
      for (let i = 0; i < 3; i++) widget.handleInput("\x1b[B");
      for (const width of [25, 35, 45]) {
        const screen = widget.render(width).map(strip);
        expect(screen.every(line => visibleWidth(line) <= width)).toBe(true);
        expect(screen[1]).toContain("↑ ");
        if (rows === 3) {
          expect(screen).toHaveLength(3);
          expect(screen[1]).not.toMatch(/↓ \d+ more/);
          expect(screen[2]).toMatch(/^● agent-2/);
        } else expect(screen.at(-1)).toMatch(/^↓ \d+ more$/);
        const beforeLabel = screen[1]!.split("↑ ")[0]!;
        const hints = beforeLabel.split(" · ").slice(1).map(s => s.trim()).filter(Boolean);
        const expected = width === 45 ? ["⏎ open", "↑↓ select"] : width === 35 ? ["⏎ open"] : [];
        expect(hints).toEqual(expected);
      }
      widget.render(45);
      mouse(widget, "move", 2);
      expect(strip(widget.render(45)[2]!)).toMatch(/^● agent-/);
      expect(mouse(widget, "click", 2)).toEqual({ handled: true, render: true });
      expect(opened.at(-1)?.id).toBe(rows === 3 ? "agent-2" : "agent-1");
      if (rows === 5) expect(mouse(widget, "click", 4)).toBeUndefined();
      for (const width of [1, 2, 8, 12]) expect(widget.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it("preserves Main identity across narrow two-row viewports with overflow in both directions", () => {
    const ansi = { ...theme, fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` } as unknown as Theme;
    const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
    for (const colors of [theme, ansi]) for (const sessionLabel of [undefined, "PBO-21", "Release-candidate"]) {
      const current = manyAgents(30);
      if (sessionLabel !== undefined) current.sessionLabel = sessionLabel;
      const opened: FabricWidgetRow[] = [];
      const widget = new FabricWidget(colors, () => current, 6, () => 20, undefined, {
        mainId: "main", availableRows: () => 3, open: row => opened.push(row), release: () => {}, requestRender: () => {},
      });
      widget.focused = true; widget.selectFirst();
      for (let i = 0; i < 12; i++) widget.handleInput("\x1b[B");
      for (let width = 20; width <= 30; width++) {
        const screen = widget.render(width).map(strip);
        expect(screen).toHaveLength(3);
        expect(screen.every(line => visibleWidth(line) <= width)).toBe(true);
        expect(screen[1]).toMatch(/^○ (Fabric|PBO-21|Relea)/);
        expect(screen[2]).toMatch(/^● agent-11/);
        if (sessionLabel !== "Release-candidate") {
          expect(screen[1]).toContain(`○ ${sessionLabel ?? "Fabric"}`);
          expect(screen[1]).toMatch(/↑ 11(?: more)?$/);
          expect(screen[1]).not.toContain("↓");
        } else if (width >= 24) {
          expect(screen[1]).toContain("○ Release-candidate");
          expect(screen[1]).toMatch(/↑ 11(?: more)?$/);
        }
        // Strip the count suffix; any hints that remain must be complete.
        const header = screen[1]!.replace(/\s+↑ 11(?: more)?(?: · ↓ 18(?: more)?)?$/, "");
        for (const hint of header.split(" · ").slice(1)) expect(["⏎ open", "↑↓ select", "esc back"]).toContain(hint);
      }
      widget.render(25);
      expect(mouse(widget, "click", 2)).toEqual({ handled: true, render: true });
      expect(opened.at(-1)?.id).toBe("agent-11");
      expect(mouse(widget, "click", 0)).toBeUndefined();
    }
  });

  it("snapshots ANSI-colored viewport states including singular overflow", () => {
    const current = manyAgents(4);
    const ansi = { ...theme, fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` } as unknown as Theme;
    const widget = new FabricWidget(ansi, () => current, 5, () => 10, undefined, { mainId: "main", hints: false, release: () => {}, requestRender: () => {} });
    const screen = (width: number) => widget.render(width).map(line => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/ · .*/, "").replace(/  thinking.*/, "").trimEnd());
    expect(screen(40)).toEqual(["", "● Fabric", "○ agent-0", "○ agent-1", "↓ 2 more"]);
    widget.focused = true; widget.selectFirst();
    for (let i = 0; i < 3; i++) widget.handleInput("\x1b[B");
    const middle = widget.render(40);
    expect(middle[1]).toMatch(/↑ 1 more\x1b\[39m$/);
    expect(screen(40).slice(2)).toEqual(["○ agent-1", "● agent-2", "↓ 1 more"]);
    widget.handleInput("\x1b[B");
    expect(widget.render(40)[1]).toMatch(/↑ 2 more\x1b\[39m$/);
    expect(screen(40).slice(2)).toEqual(["○ agent-2", "● agent-3", ""]);
    for (const width of [1, 4, 8, 12, 40]) expect(widget.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
  });

  it("scrolls to overflow tasks and maps clicks only to their visible rows", () => {
    const current = snapshot(); current.agents = []; current.actors = [];
    current.shells = Array.from({ length: 30 }, (_, index) => ({
      id: `shell-${index}-0000`, tool: "bash", command: `sleep ${index}`, startedAt: current.now - 1_000,
      spilledAt: current.now, status: "spilled", eventCount: 0, unread: false, stopping: false,
    })) as NonNullable<FabricDashboardSnapshot["shells"]>;
    const { widget, opened } = setup({ current, terminalRows: 12 });
    widget.focused = true; widget.selectFirst(); widget.render(100);
    for (let index = 0; index < 40; index++) widget.handleInput("\x1b[B");
    const shown = widget.render(100);
    expect(shown).toHaveLength(6); expect(shown[4]).toMatch(/^● shell-29/);
    expect(shown.at(-1)).toBe("");
    widget.handleInput("\r"); expect(opened.at(-1)?.id).toBe("shell-29-0000");
    const firstVisible = /shell-\d+/.exec(shown[2]!)![0];
    expect(mouse(widget, "click", 2)).toEqual({ handled: true, render: true });
    expect(opened.at(-1)?.id).toBe(`${firstVisible}-0000`);
    widget.handleInput("\x1b[A"); widget.render(100); widget.handleInput("\r");
    expect(opened.at(-1)?.id).toBe(`shell-${Number(firstVisible.slice(6)) - 1}-0000`);
  });

  it("marks the participant on screen and offers Main as a row in a participant window", () => {
    let viewing: string | undefined = "agent-1";
    const { widget, opened } = setup({ interaction: { viewing: () => viewing, mainId: "main", hints: false } });
    const lines = widget.render(120);
    // No key hints, and the agent on screen keeps the filled circle.
    expect(lines[1]).toBe("○ Fabric · 1 running · 1 actor");
    expect(lines[2]).toMatch(/^● security-reviewer /);
    widget.focused = true;
    widget.selectDefault();
    expect(widget.render(120)[2]).toMatch(/^● security-reviewer /);
    widget.handleInput("\x1b[A");
    widget.handleInput("\r");
    expect(opened).toMatchObject([{ id: "main", kind: "main" }]);
    viewing = undefined;
    widget.focused = false;
    expect(widget.render(120)[1]).toMatch(/^● Fabric/);
  });

  it("keeps a one-row budget to one row: the header, without the spacer", () => {
    const { widget, opened } = setup({ maxRows: 1 });
    const lines = widget.render(100);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^● Fabric /);
    expect(lines[0]).not.toMatch(/↓ \d+ more/);
    // Clicks map to rows without the spacer offset.
    expect(mouse(widget, "click", 0)).toBeUndefined();
    expect(opened).toEqual([]);
  });

  it("lists agents whose parents point at each other instead of hiding them", () => {
    const current = snapshot();
    current.actors = [];
    current.agents = [
      { ...agent("a", "alpha"), parentId: "b" },
      { ...agent("b", "beta"), parentId: "a" },
    ];
    const lines = setup({ current, maxRows: 10 }).widget.render(120).join("\n");
    expect(lines).toContain("alpha");
    expect(lines).toContain("beta");
  });

  it("stays passive without interaction wiring", () => {
    const current = snapshot();
    const widget = new FabricWidget(theme, () => current, 6);
    expect(widget.render(100).join("\n")).not.toContain("↓ to manage");
    expect(widget.handleMouse({ type: "click", button: "left", x: 0, y: 2, screenX: 0, screenY: 2, width: 100, height: 3, shift: false, alt: false, ctrl: false })).toBeUndefined();
  });
});
