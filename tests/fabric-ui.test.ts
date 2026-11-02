import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { CodePreviewSettings } from "../src/ui/code-preview.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { FabricDashboard } from "../src/ui/dashboard.js";
import { entitiesForOverview, phasePanels } from "../src/ui/dashboard-model.js";
import {
  topologyParticipantGroup,
  topologyStateGroupPath,
  topologyTopicGroupPath,
  topologyTreeRouteNodeIds,
} from "../src/ui/dashboard-fabric-graph.js";
import { configureHighlighting } from "../src/ui/highlight.js";
import { formatActorDataPreview, formatDuration, wrapPlainText } from "../src/ui/format.js";
import { entityTail } from "../src/ui/dashboard-presentation.js";
import { formatToolCallDuration } from "../src/ui/tool-call-timing.js";
import type { ModelSource } from "../src/ui/model-picker.js";
import type { FabricThinking } from "../src/thinking.js";
import type { FabricDashboardSnapshot } from "../src/ui/types.js";
import { FabricWidget, shouldShowFabricWidget, widgetRowLimit } from "../src/ui/widget.js";

const actorModelSource: ModelSource = {
  models: [
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
  ],
  lastUsed: {},
};

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const codePreviewSettings: CodePreviewSettings = {
  shikiTheme: "dark-plus",
  diffIntensity: "subtle",
  wordEmphasis: "all",
  toolCallBackground: "on",
  toolCallTiming: true,
  readCollapsedLines: 10,
  readContentPreview: true,
  writeContentPreview: true,
  writeCollapsedLines: 10,
  editDiffPreview: true,
  editCollapsedLines: 160,
  grepCollapsedLines: 15,
  grepResultPreview: true,
  findResultPreview: true,
  lsResultPreview: true,
  pathListCollapsedLines: 20,
  readLineNumbers: true,
  bashResultPreview: true,
  bashWarnings: true,
  syntaxHighlighting: true,
  secretWarnings: true,
  pathIcons: "unicode",
  tools: ["bash", "read", "write", "edit", "grep", "find", "ls"],
};

const ansiTheme = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
  bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[49m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as unknown as Theme;

const mainAgent = (now: number, status: "idle" | "running" = "running") => ({
  id: "session:main",
  name: "Main" as const,
  kind: "main" as const,
  status,
  runner: "pi" as const,
  transport: "host" as const,
  cwd: "/tmp/project",
  sessionId: "main",
  model: "anthropic/claude-opus-4-8",
  thinking: "high",
  startedAt: now - 120_000,
  updatedAt: now,
  pendingMessages: false,
  local: true,
});

const snapshot = (): FabricDashboardSnapshot => {
  const now = Date.now();
  return {
    now,
    main: mainAgent(now),
    peers: [],
    runs: [
      {
        id: "run-1",
        name: "Repository migration",
        description: "Port packages in two phases",
        status: "running",
        currentPhaseId: "audit",
        startedAt: now - 70_000,
        updatedAt: now,
        phases: [
          {
            id: "discover",
            name: "Discover",
            status: "completed",
            total: 1,
            startedAt: now - 70_000,
            updatedAt: now - 60_000,
            finishedAt: now - 60_000,
          },
          {
            id: "audit",
            name: "Audit",
            status: "running",
            total: 3,
            startedAt: now - 60_000,
            updatedAt: now,
          },
        ],
        calls: [
          {
            id: "call-agent",
            ref: "agents.run",
            label: "security-reviewer",
            kind: "agent",
            status: "running",
            phaseId: "audit",
            entityId: "agent-1",
            entityKind: "agent",
            startedAt: now - 40_000,
            updatedAt: now,
          },
          {
            id: "call-tool",
            ref: "extensions.project_status",
            label: "project status",
            kind: "extension",
            status: "completed",
            phaseId: "audit",
            startedAt: now - 30_000,
            updatedAt: now - 29_000,
            finishedAt: now - 29_000,
          },
        ],
        items: [
          {
            id: "packages",
            label: "Migrate packages",
            kind: "task",
            status: "running",
            phaseId: "audit",
            completed: 1,
            total: 3,
            createdAt: now - 50_000,
            updatedAt: now,
          },
        ],
        events: [],
      },
    ],
    agents: [
      {
        id: "agent-1",
        name: "security-reviewer",
        status: "running",
        transport: "process",
        cwd: "/tmp/project",
        task: "Review the migration for security defects",
        model: "anthropic/claude-opus-4-8",
        currentTool: "grep",
        startedAt: now - 40_000,
        updatedAt: now,
        turns: 2,
        toolCalls: 6,
        usage: { input: 4000, output: 1200, cacheRead: 0, cacheWrite: 0, cost: 0.04 },
        runId: "run-1",
        phaseId: "audit",
      },
    ],
    actors: [
      {
        id: "actor-1",
        scope: "project",
        name: "advisor",
        status: "idle",
        runner: "pi",
        events: ["turn_end"],
        topics: ["team.review"],
        delivery: "mailbox",
        responseMode: "directive",
        triggerTurn: false,
        coalesce: true,
        model: "anthropic/claude-sonnet-4-6",
        binding: {
          scope: "session",
          sessionId: "session-test",
          model: "anthropic/claude-sonnet-4-6",
        },
        projectDefaults: { scope: "project" },
        queued: 0,
        messages: 2,
        createdAt: now - 120_000,
        updatedAt: now,
        instructions: "Advise only when useful.",
        recentMessages: [],
      },
    ],
    componentGraph: { components: [], edges: [], cycles: [] },
    globalActors: [],
    state: [
      {
        key: "tasks/package-a",
        label: "Package A",
        status: "claimed",
        owner: "security-reviewer",
        value: { status: "claimed", owner: "security-reviewer" },
        version: 2,
        updatedAt: now,
      },
    ],
    events: [
      {
        id: "event-1",
        sequence: 1,
        topic: "team.review",
        kind: "finding",
        from: { id: "actor-1", name: "advisor", kind: "actor" },
        text: "Review started",
        createdAt: now,
      },
    ],
  };
};

/** The widget's rows below the blank spacer that separates it from the editor. */
const body = (lines: string[]): string[] => {
  expect(lines[0]).toBe("");
  return lines.slice(1);
};

describe("Fabric dynamic UI", () => {
  it("excludes successful internal loads from dashboard rows and phase counts, not raw history", () => {
    const current = snapshot();
    const run = current.runs[0]!;
    const before = phasePanels(current, run);
    const call = { id: "internal", ref: "native.load", label: "native.load", kind: "tool" as const, status: "completed" as const, phaseId: "audit", startedAt: current.now, updatedAt: current.now };
    run.calls.push(call);
    expect(phasePanels(current, run)).toEqual(before);
    expect(entitiesForOverview(current, run, before.find(panel => panel.id === "audit"), "activity").some(entity => entity.label === "native.load")).toBe(false);
    run.calls.push({ ...call, id: "failed-load", status: "failed", error: "load failed" });
    expect(phasePanels(current, run).find(panel => panel.id === "audit")?.total).toBe((before.find(panel => panel.id === "audit")?.total ?? 0) + 1);
    expect(run.calls.filter(call => call.ref === "native.load")).toHaveLength(2);
  });
  it("projects component lifecycle and dependency nodes into both overview modes", () => {
    const current = snapshot();
    const now = Date.now();
    current.componentGraph = {
      components: [
        {
          id: "consumer",
          component: "consumer-definition",
          state: "active",
          guarantee: "managed",
          requirements: ["search.query"],
          provisions: [],
          missing: [],
          optionalMissing: [],
          effects: [],
          targetDigest: "target",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "provider",
          component: "provider-definition",
          state: "active",
          guarantee: "revertible",
          requirements: [],
          provisions: ["search"],
          missing: [],
          optionalMissing: [],
          effects: [],
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
      edges: [{ from: "consumer", to: "provider", ref: "search.query" }],
      cycles: [],
    };

    const activity = entitiesForOverview(current, undefined, undefined, "activity");
    const topology = entitiesForOverview(current, undefined, undefined, "topology");
    expect(activity.filter((entity) => entity.kind === "component").map((entity) => entity.id))
      .toEqual(["component:consumer", "component:provider"]);
    expect(topology.filter((entity) => entity.kind === "component").map((entity) => entity.id))
      .toEqual(["component:consumer", "component:provider"]);
  });

  it.each([-1, 0, 1, 999, NaN, Infinity])("hides zero/subsecond elapsed text (%s ms)", milliseconds => {
    expect(formatDuration(milliseconds)).toBe("");
  });

  it("keeps nonzero duration formatting and hides zero tool-call timings", () => {
    expect(formatDuration(1_000)).toBe("1s");
    expect(formatDuration(61_000)).toBe("1m01s");
    expect(formatToolCallDuration(100, 100)).toBeUndefined();
    expect(formatToolCallDuration(100, 99)).toBeUndefined();
    expect(formatToolCallDuration(100, 142)).toBe("42ms");
    expect(formatToolCallDuration(100, 1_100)).toBe("1.0s");
  });

  it.each([0, 999, 1_000])("omits zero/subsecond widget and entity timers without stray separators (%s ms)", elapsed => {
    const current = snapshot();
    const run = current.runs[0]!;
    run.startedAt = current.now - elapsed;
    run.finishedAt = current.now;
    run.status = "completed";
    run.phases = [];
    delete run.currentPhaseId;
    current.agents = current.agents.slice(0, 1).map(agent => ({ ...agent, startedAt: run.startedAt, finishedAt: current.now, status: "completed" }));
    const worker = current.agents[0]!;
    current.actors = current.actors.slice(0, 1).map(actor => ({ ...actor, worker, status: "idle" }));
    for (const call of run.calls) { call.startedAt = run.startedAt; call.finishedAt = current.now; }
    const lines = body(new FabricWidget(theme, () => current, 8).render(400));
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line).not.toMatch(/(?:^| )0s(?: |$)/);
      expect(line).not.toMatch(/ · $| ·  · /);
    }
    expect(lines[0]!.includes(" · 1s")).toBe(elapsed === 1_000);
    const tails = [
      entityTail({ kind: "agent", id: worker.id, label: worker.name, status: worker.status, value: worker }, current.now),
      ...run.calls.map(call => entityTail({ kind: "call", id: call.id, label: call.ref, status: call.status, value: call }, current.now)),
    ];
    expect(tails.length).toBeGreaterThan(0);
    for (const tail of tails) {
      expect(tail).not.toMatch(/(?:^| )0s(?: |$)/);
      expect(tail.includes("1s")).toBe(elapsed === 1_000);
    }
  });

  it.each([0, 999, 1_000])("hides zero dashboard elapsed fields, but keeps positive elapsed fields (%s ms)", elapsed => {
    const current = snapshot();
    const run = current.runs[0]!;
    run.startedAt = current.now - elapsed;
    for (const agent of current.agents) agent.startedAt = run.startedAt;
    for (const call of run.calls) { call.startedAt = run.startedAt; call.finishedAt = current.now; }
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI,
      theme, () => current, vi.fn(),
    );
    try {
      expect(dashboard.render(240).join("\n")).not.toMatch(/(?:^| )0s(?: |$)/);
      dashboard.handleInput("l");
      for (const name of ["agent · security-reviewer", "call · project status"]) {
        dashboard.handleInput("\r");
        const detail = dashboard.render(240).join("\n");
        expect(detail).toContain(name);
        expect(detail.includes("Elapsed:")).toBe(elapsed === 1_000);
        if (elapsed === 1_000) expect(detail).toContain("Elapsed: 1s");
        dashboard.handleInput("\x1b");
        dashboard.handleInput("j");
      }
    } finally { dashboard.dispose(); }
  });

  it.each([0, 999, 1_000])("omits zero relative ages with their suffix (%s ms)", elapsed => {
    const now = 10_000;
    const common = { id: "fixture", label: "Fixture", status: "idle" };
    const entities = [
      { ...common, kind: "peer", value: { sessionId: "session", model: "model", updatedAt: now - elapsed } },
      { ...common, kind: "meshParticipant", value: { routes: 1, lastSeenAt: now - elapsed } },
      { ...common, kind: "meshTopic", value: { subscribers: [], recentEvents: 0, lastEventAt: now - elapsed } },
      { ...common, kind: "meshRoute", value: { kind: "publish", topic: "topic", count: 1, lastAt: now - elapsed } },
    ] as Parameters<typeof entityTail>[0][];
    for (const entity of entities) {
      const text = entityTail(entity, now);
      expect(text.includes("ago")).toBe(elapsed === 1_000);
      expect(text).not.toMatch(/0s| · $| ·  · /);
      if (elapsed === 1_000) expect(text).toContain("1s ago");
    }
  });

  it("renders a bounded compact activity widget", () => {
    const current = snapshot();
    const widget = new FabricWidget(theme, () => current, 5);
    const lines = widget.render(72);

    expect(lines.join("\n")).toContain("Repository migration");
    expect(lines.join("\n")).toContain("security-reviewer");
    expect(lines.join("\n")).toContain("Audit");
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines.every((line) => visibleWidth(line) <= 72)).toBe(true);
    const ansiLines = new FabricWidget(ansiTheme, () => current, 5).render(48);
    expect(ansiLines.every((line) => visibleWidth(line) <= 48)).toBe(true);
    expect(shouldShowFabricWidget(current, "auto")).toBe(true);
  });

  it("caps the animated box to a share of the pane so it cannot overflow", () => {
    const current = snapshot();
    const base = current.agents[0]!;
    current.agents = Array.from({ length: 14 }, (_, index) => ({
      ...base,
      id: `agent-${index + 2}`,
      name: `worker-${index + 2}`,
      status: index % 2 === 0 ? "running" : "queued",
    }));
    const natural = new FabricWidget(theme, () => current, 40).render(72);
    expect(natural.length).toBeGreaterThan(12);

    expect(widgetRowLimit(40, 60)).toBe(30);
    expect(widgetRowLimit(6, 12)).toBe(6);
    expect(widgetRowLimit(40, 8)).toBe(4);
    expect(widgetRowLimit(40, 1)).toBe(1);
    expect(widgetRowLimit(40, undefined)).toBe(40);
    expect(widgetRowLimit(0, 60)).toBe(1);

    // No pane reading keeps the configured budget; a short pane clamps it.
    expect(new FabricWidget(theme, () => current, 40, () => undefined).render(72).length).toBe(natural.length);
    expect(new FabricWidget(theme, () => current, 40, () => 8).render(72).length).toBeLessThanOrEqual(4);

    // The accessor is read per render, so a live resize tightens the same widget.
    let rows = 60;
    const widget = new FabricWidget(theme, () => current, 40, () => rows);
    expect(widget.render(72).length).toBe(Math.min(natural.length, 30));
    rows = 10;
    expect(widget.render(72).length).toBeLessThanOrEqual(5);
  });

  it("drops statistics, then shortens the title, before it drops key hints", () => {
    const current = snapshot();
    current.actors = [];
    const run = current.runs[0]!;
    run.name = "Repository migration across every package in the monorepo";
    const interaction = { release: () => {}, requestRender: () => {}, open: () => {} };
    const widget = new FabricWidget(theme, () => current, 8, () => 40, undefined, interaction);
    const header = (width: number) => {
      widget.invalidate();
      return body(widget.render(width))[0]!;
    };
    const wide = header(240);
    expect(wide).toContain("Repository migration across every package in the monorepo");
    expect(wide).toContain(" tok");
    expect(wide).toContain("↓ to manage");
    // Too narrow for every statistic: they go first, the title and the key stay.
    const medium = header(100);
    expect(visibleWidth(medium)).toBeLessThanOrEqual(100);
    expect(medium).not.toContain(" tok");
    expect(medium).toContain("Repository migration");
    expect(medium).toMatch(/↓ to manage$/);
    // Narrower still: the title shortens and the key hint survives.
    const narrow = header(48);
    expect(visibleWidth(narrow)).toBeLessThanOrEqual(48);
    expect(narrow).toContain("…");
    expect(narrow).toMatch(/↓ to manage$/);
    // Focused hints keep the most important key, ⏎ open, longest.
    widget.focused = true;
    const focused = header(34);
    expect(visibleWidth(focused)).toBeLessThanOrEqual(34);
    expect(focused).toContain("⏎ open");
  });

  it("fits agent rows by dropping statistics before shortening the activity", () => {
    const current = snapshot();
    current.actors = [];
    current.runs = [];
    current.agents = [{ ...current.agents[0]!, name: "reviewer", status: "running", model: "anthropic/claude-opus-5-5",
      milestone: "Trace the token refresh path through every service", toolCalls: 12, usage: { input: 9000, output: 1000, cacheRead: 0, cacheWrite: 0, cost: 0 } }];
    const row = (width: number) => body(new FabricWidget(theme, () => current, 8).render(width))[1]!;
    expect(row(200)).toContain("claude-opus-5-5 · 12 calls · 10k tok");
    const narrow = row(60);
    expect(visibleWidth(narrow)).toBeLessThanOrEqual(60);
    expect(narrow).toMatch(/^○ reviewer  Trace the token refresh/);
    expect(narrow).not.toContain("10k tok");
    expect(narrow).not.toContain("12 calls");
  });

  it("renders the widget header title and agent names in muted grey, matching pi core status lines", () => {
    const recordingTheme = {
      fg: (color: string, text: string) => `<${color}>${text}</>`,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => `<bold>${text}</>`,
    } as unknown as Theme;
    const current = snapshot();
    const lines = new FabricWidget(recordingTheme, () => current, 8).render(120);
    const header = lines.find((line) => line.includes("Repository migration")) ?? "";
    const agentRow = lines.find((line) => line.includes("security-reviewer")) ?? "";
    expect(header).toContain("<muted>Repository migration</>");
    expect(header).not.toContain("<text>");
    expect(agentRow).toContain("<muted>security-reviewer</>");
  });

  it("indents agents by tree depth instead of topology parentage", () => {
    const current = snapshot();
    current.actors = [];
    current.runs[0]!.calls = [];
    const base = current.agents[0]!;
    current.agents = [
      { ...base, id: "top", name: "top-level", parentId: "session:main" },
      { ...base, id: "child", name: "recursive-child", parentId: "top", nestingDepth: 1 },
      { ...base, id: "grandchild", name: "recursive-grandchild", parentId: "child", nestingDepth: 2 },
    ];

    const lines = new FabricWidget(theme, () => current, 8).render(120);
    const top = lines.find((line) => line.includes("top-level"));
    const child = lines.find((line) => line.includes("recursive-child"));
    const grandchild = lines.find((line) => line.includes("recursive-grandchild"));

    expect(top).toMatch(/^○ /);
    expect(child).toMatch(/^└─ ○ /);
    expect(grandchild).toMatch(/^ {3}└─ ○ /);
  });

  it("leases actor rows through settle and resets them for the next activation", () => {
    const current = snapshot();
    current.runs = [];
    current.agents = [];
    const actor = current.actors[0]!;
    actor.status = "running";
    actor.lastRunId = "actor-run-1";
    actor.worker = {
      id: "actor-run-1",
      name: "worker",
      status: "running",
      runner: "pi",
      transport: "process",
      cwd: "/tmp/project",
    };
    const widget = new FabricWidget(theme, () => current, 8);
    const active = body(widget.render(100));
    expect(active[0]).toMatch(/^● Fabric/);
    expect(active.join("\n")).toContain("advisor");

    actor.status = "idle";
    actor.worker.status = "completed";
    widget.invalidate();
    const settled = body(widget.render(100));
    expect(settled).toHaveLength(active.length);

    actor.status = "running";
    actor.worker = {
      id: "actor-run-2",
      name: "worker",
      status: "running",
      runner: "pi",
      transport: "process",
      cwd: "/tmp/project",
    };
    widget.invalidate();
    const next = body(widget.render(100));
    expect(next).toHaveLength(2);
  });

  it("shows only agent-provider rows in the widget", () => {
    const current = snapshot();
    const customCall = current.runs[0]!.calls.find((call) => call.kind === "extension")!;
    current.runs[0]!.calls = [
      {
        ...customCall,
        id: "custom-index",
        label: "Custom index",
        status: "running",
        entityKind: "custom",
        progress: "Indexing packages",
      },
    ];

    const withAgent = new FabricWidget(theme, () => current, 8).render(120).join("\n");
    expect(withAgent).toContain("security-reviewer");
    expect(withAgent).not.toContain("Custom index");
    expect(withAgent).not.toContain("advisor");
    expect(withAgent).not.toContain("Package A");

    current.agents = [];
    const withoutAgents = body(new FabricWidget(theme, () => current, 8).render(120));
    expect(withoutAgents).toHaveLength(1);
    expect(withoutAgents.join("\n")).not.toContain("Custom index");
    expect(withoutAgents.join("\n")).not.toContain("advisor");
    expect(withoutAgents.join("\n")).not.toContain("Package A");
  });

  it("does not mount the auto widget for standalone non-agent state", () => {
    const current = snapshot();
    current.runs = [];
    current.agents = [];
    current.actors = [];
    expect(current.state[0]?.status).toBe("claimed");
    expect(shouldShowFabricWidget(current, "auto")).toBe(false);
  });

  it("does not redraw an unchanged dashboard on its own", async () => {
    vi.useFakeTimers();
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn());
    try {
      await vi.advanceTimersByTimeAsync(2_000);
      expect(tui.requestRender).not.toHaveBeenCalled();
    } finally {
      dashboard.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps dashboard and widget agents in creation order", () => {
    const current = snapshot();
    current.actors = [];
    current.state = [];
    current.runs[0]!.calls = [];
    current.runs[0]!.items = [];
    const base = current.agents[0]!;
    current.agents = [
      { ...base, id: "third", name: "third-created", startedAt: 300, updatedAt: 700 },
      { ...base, id: "first", name: "first-created", startedAt: 100, updatedAt: 900 },
      { ...base, id: "second", name: "second-created", startedAt: 200, updatedAt: 800 },
    ];

    const widgetText = new FabricWidget(theme, () => current, 8).render(120).join("\n");
    expect(widgetText.indexOf("first-created")).toBeLessThan(widgetText.indexOf("second-created"));
    expect(widgetText.indexOf("second-created")).toBeLessThan(widgetText.indexOf("third-created"));

    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      const dashboardText = dashboard.render(120).join("\n");
      expect(dashboardText.indexOf("first-created")).toBeLessThan(
        dashboardText.indexOf("second-created"),
      );
      expect(dashboardText.indexOf("second-created")).toBeLessThan(
        dashboardText.indexOf("third-created"),
      );

      current.agents[2]!.updatedAt = 1_000;
      current.agents[0]!.updatedAt = 0;
      const refreshed = dashboard.render(120).join("\n");
      expect(refreshed.indexOf("first-created")).toBeLessThan(
        refreshed.indexOf("second-created"),
      );
      expect(refreshed.indexOf("second-created")).toBeLessThan(
        refreshed.indexOf("third-created"),
      );
    } finally {
      dashboard.dispose();
    }
  });

  it("keeps completed runs visible and summarizes actors without listing them", () => {
    const current = snapshot();
    const run = current.runs[0];
    if (!run) throw new Error("missing fixture run");
    run.status = "completed";
    run.finishedAt = current.now - 20_000;
    current.agents[0]!.status = "completed";
    current.state = [];
    current.actors = [];
    // A completed run remains visible through agent_settled so its rows do not collapse.
    expect(shouldShowFabricWidget(current, "auto")).toBe(true);
    // An explicit dismissal watermark can still hide retained history.
    current.widgetDismissedAt = current.now;
    expect(shouldShowFabricWidget(current, "auto")).toBe(false);
    // ambient actors keep the widget visible regardless
    current.actors = snapshot().actors;
    expect(shouldShowFabricWidget(current, "auto")).toBe(true);
    const lines = body(new FabricWidget(theme, () => current, 5).render(72));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^● Fabric · /);
    expect(lines[0]).toContain("1 actor");
    expect(lines.join("\n")).not.toContain("advisor");
  });

  it("keeps a bounded terminal agent result cue through settle", () => {
    const current = snapshot();
    const run = current.runs[0]!;
    run.status = "completed";
    run.finishedAt = current.now;
    current.actors = [];
    current.state = [];
    current.agents[0]!.status = "completed";
    current.agents[0]!.finishedAt = current.now;
    delete current.agents[0]!.currentTool;
    current.agents[0]!.text = "Found a concrete regression";

    const lines = new FabricWidget(theme, () => current, 5).render(72).join("\n");
    expect(lines).toContain("security-reviewer");
    expect(lines).toContain("result: Found a concrete regression");

    current.widgetDismissedAt = current.now;
    expect(shouldShowFabricWidget(current, "auto")).toBe(false);
  });

  it("keeps completed agents visible after a later run starts", () => {
    const current = snapshot();
    current.actors = [];
    current.state = [];
    const completed = {
      ...current.agents[0]!,
      id: "agent-completed",
      name: "finished-reviewer",
      status: "completed" as const,
      finishedAt: current.now - 5_000,
    };
    current.agents = [completed];
    const widget = new FabricWidget(theme, () => current, 6);
    expect(widget.render(72).join("\n")).toContain("finished-reviewer");

    current.runs = [
      {
        ...current.runs[0]!,
        id: "run-2",
        name: "Follow-up run",
        calls: [],
        items: [],
        startedAt: current.now,
        updatedAt: current.now,
      },
      current.runs[0]!,
    ];
    widget.invalidate();
    const lines = widget.render(72).join("\n");
    expect(lines).toContain("Follow-up run");
    expect(lines).toContain("finished-reviewer");
  });

  it("hides explicitly dismissed runs and resurfaces later ones", () => {
    const current = snapshot();
    const run = current.runs[0];
    if (!run) throw new Error("missing fixture run");
    run.calls = [
      { id: "c1", ref: "pi.bash", label: "pi.bash", kind: "tool", status: "completed", phaseId: "audit", startedAt: run.startedAt, updatedAt: current.now, finishedAt: current.now, detail: "done" },
    ];
    run.items = [];
    current.agents = [];
    current.actors = [];
    current.state = [];
    run.status = "completed";
    run.finishedAt = current.now;
    current.widgetDismissedAt = 0;
    // A freshly finished non-agent run remains summarized by its header only.
    expect(shouldShowFabricWidget(current, "auto")).toBe(true);
    const lines = body(new FabricWidget(theme, () => current, 8).render(72));
    expect(lines).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("pi.bash");
    // An explicit dismissal hides retained history.
    current.widgetDismissedAt = current.now;
    expect(shouldShowFabricWidget(current, "auto")).toBe(false);
    current.widgetDismissedAt = current.now + 1;
    expect(shouldShowFabricWidget(current, "auto")).toBe(false);
    // a later run that finishes after the dismiss shows again
    run.finishedAt = current.now + 2000;
    run.updatedAt = run.finishedAt;
    current.now = run.finishedAt;
    expect(shouldShowFabricWidget(current, "auto")).toBe(true);
  });

  it("keeps widget rows stable as agents complete", () => {
    const current = snapshot();
    current.actors = [];
    current.state = [];
    current.runs[0]!.items = [];
    current.runs[0]!.calls = [];
    current.agents = [
      { ...snapshot().agents[0]!, id: "agent-1", name: "alpha", status: "running" },
      { ...snapshot().agents[0]!, id: "agent-2", name: "beta", status: "running" },
    ];
    const widget = new FabricWidget(theme, () => current, 8);
    const first = body(widget.render(72));
    expect(first.length).toBe(3); // header + alpha + beta

    current.agents[1]!.status = "completed";
    widget.invalidate();
    const second = body(widget.render(72));
    expect(second).toHaveLength(first.length);
    expect(second.join("\n")).toContain("alpha");
    expect(second.join("\n")).toContain("beta");
    expect(second.every((line) => visibleWidth(line) > 0)).toBe(true);

    current.agents[0]!.status = "completed";
    widget.invalidate();
    const third = body(widget.render(72));
    expect(third).toHaveLength(first.length);
    expect(third.join("\n")).toContain("alpha");
    expect(third.join("\n")).toContain("beta");
  });

  it("releases rows when agents leave the activity snapshot", () => {
    const current = snapshot();
    current.actors = [];
    current.state = [];
    current.runs[0]!.items = [];
    current.runs[0]!.calls = [];
    const base = current.agents[0]!;
    current.agents = [
      { ...base, id: "agent-1", name: "alpha" },
      { ...base, id: "agent-2", name: "beta" },
    ];
    const widget = new FabricWidget(theme, () => current, 8);
    expect(body(widget.render(72))).toHaveLength(3);

    current.agents = [current.agents[0]!];
    widget.invalidate();
    const withOneAgent = body(widget.render(72));
    expect(withOneAgent).toHaveLength(2);
    expect(withOneAgent.every((line) => visibleWidth(line) > 0)).toBe(true);

    current.agents = [];
    widget.invalidate();
    const withoutAgents = body(widget.render(72));
    expect(withoutAgents).toHaveLength(1);
    expect(withoutAgents[0]).toContain("Fabric");
  });

  it("keeps the hidden-row marker visible at the width boundary", () => {
    const current = snapshot();
    current.actors = [];
    current.state = [];
    current.runs[0]!.items = [];
    current.runs[0]!.calls = [];
    current.agents = [
      { ...current.agents[0]!, id: "agent-one", name: "a very long active agent name", status: "running" },
      { ...current.agents[0]!, id: "agent-two", name: "second", status: "running" },
      { ...current.agents[0]!, id: "agent-three", name: "third", status: "running" },
    ];
    // Four rows: spacer, header, one agent, and the reserved bottom overflow cue.
    const lines = new FabricWidget(theme, () => current, 4).render(24);
    expect(lines).toHaveLength(4);
    expect(lines[1]).not.toMatch(/↓ \d+ more/);
    expect(lines[3]).toContain("↓ 2 more");
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
  });

  it("reuses cached rows for unrelated TUI redraws", () => {
    let current = snapshot();
    const fg = vi.fn((_color: string, text: string) => text);
    const cachedTheme = { ...theme, fg } as unknown as Theme;
    const widget = new FabricWidget(cachedTheme, () => current, 8);

    const first = widget.render(72);
    fg.mockClear();
    expect(widget.render(72)).toBe(first);
    expect(fg).not.toHaveBeenCalled();

    current = { ...current, now: current.now + 500 };
    widget.render(72);
    expect(fg).toHaveBeenCalled();

    fg.mockClear();
    widget.invalidate();
    widget.render(72);
    expect(fg).toHaveBeenCalled();
  });

  it("reports whether the rendered output changed", () => {
    const current = snapshot();
    current.actors = [];
    current.state = [];
    current.runs[0]!.items = [];
    current.runs[0]!.calls = [];
    current.runs[0]!.status = "completed";
    current.runs[0]!.finishedAt = current.now;
    current.agents = [];
    const widget = new FabricWidget(theme, () => current, 8);
    expect(widget.hasChanged()).toBe(true); // never rendered
    widget.render(72);
    expect(widget.hasChanged()).toBe(false); // identical
    current.runs[0]!.name = "Changed title";
    expect(widget.hasChanged()).toBe(true); // content changed
    widget.render(72);
    expect(widget.hasChanged()).toBe(false); // re-rendered, now identical
  });

  it("groups dashboard entities by type within the selected sidebar phase", () => {
    const current = snapshot();
    const task = current.runs[0]!.items[0]!;
    current.runs[0]!.items.push({
      ...task,
      id: "custom-review",
      label: "Custom review",
      kind: "custom",
    });
    const extensionCall = current.runs[0]!.calls.find((call) => call.kind === "extension")!;
    current.runs[0]!.calls.push({
      ...extensionCall,
      id: "custom-call",
      label: "Custom provider activity",
      entityKind: "custom",
    });
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      const renderedLines = dashboard.render(120);
      const rendered = renderedLines.join("\n");
      expect(rendered).toContain("Activity");
      expect(rendered).toContain("Discover");
      expect(rendered).toContain("Audit");
      expect(rendered).toContain("Agents (2)");
      expect(rendered).toContain("Extensions (1)");
      expect(rendered).toContain("Tasks (1)");
      expect(rendered).toContain("Custom items (2)");
      expect(rendered).not.toContain("Actors (1)");
      expect(rendered).not.toContain("Shared state (1)");
      expect(rendered.indexOf("Agents (2)")).toBeLessThan(rendered.indexOf("Extensions (1)"));
      expect(rendered.indexOf("Extensions (1)")).toBeLessThan(rendered.indexOf("Tasks (1)"));
      expect(rendered.indexOf("Tasks (1)")).toBeLessThan(rendered.indexOf("Custom items (2)"));
      for (const heading of ["Extensions (1)", "Tasks (1)", "Custom items (2)"]) {
        const headingIndex = renderedLines.findIndex((line) => line.includes(heading));
        expect(headingIndex).toBeGreaterThan(0);
        expect(renderedLines[headingIndex - 1]?.split("│")[2]?.trim()).toBe("");
      }
      expect(renderedLines.some((line) => /^│[^│]*│[^│]*Audit/.test(line))).toBe(false);

      dashboard.handleInput("G");
      const session = dashboard.render(120).join("\n");
      expect(session).toContain("Actors (1)");
      expect(session).toContain("Shared state (1)");
      expect(session.indexOf("Actors (1)")).toBeLessThan(session.indexOf("Shared state (1)"));
    } finally {
      dashboard.dispose();
    }
  });
  it("moves the cursor through type groups in each sidebar phase", () => {
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI,
      theme,
      snapshot,
      vi.fn(),
    );
    const inspectSelection = (): string => {
      dashboard.handleInput("\r");
      const detail = dashboard.render(120).join("\n");
      dashboard.handleInput("\x1b");
      return detail;
    };
    try {
      dashboard.render(120);
      dashboard.handleInput("l");
      expect(inspectSelection()).toContain("agent · security-reviewer");

      dashboard.handleInput("j");
      expect(inspectSelection()).toContain("call · project status");

      dashboard.handleInput("j");
      expect(inspectSelection()).toContain("item · Migrate packages");

      dashboard.handleInput("k");
      expect(inspectSelection()).toContain("call · project status");

      dashboard.handleInput("h");
      dashboard.handleInput("G");
      dashboard.handleInput("l");
      expect(inspectSelection()).toContain("actor · advisor");

      dashboard.handleInput("j");
      expect(inspectSelection()).toContain("state · Package A");
    } finally {
      dashboard.dispose();
    }
  });
  it("keeps the overview height stable when the entity action hint appears", () => {
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI,
      theme,
      snapshot,
      vi.fn(),
    );
    try {
      const withoutHint = dashboard.render(120);
      expect(withoutHint.join("\n")).not.toContain("enter details");

      dashboard.handleInput("l");
      const withHint = dashboard.render(120);
      expect(withHint.join("\n")).toContain("enter details");
      expect(withHint).toHaveLength(withoutHint.length);

      dashboard.handleInput("h");
      expect(dashboard.render(120)).toHaveLength(withoutHint.length);
    } finally {
      dashboard.dispose();
    }
  });

  it("renders a responsive sidebar with a heading-free grouped activity pane", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn());
    try {
      const overview = dashboard.render(120);
      const overviewText = overview.join("\n");
      expect(overviewText).toContain("Activity");
      expect(overviewText).toContain("Audit");
      expect(overviewText).toContain("Agents (2)");
      expect(overviewText).not.toContain("Actors (1)");
      expect(overviewText).toContain("security-reviewer");
      expect(overviewText).toContain("claude-opus-4-8");
      expect(overview.some((line) => /^│[^│]*│[^│]*Audit/.test(line))).toBe(false);
      expect(overview.every((line) => visibleWidth(line) <= 120)).toBe(true);
      expect(dashboard.render(60).every((line) => visibleWidth(line) <= 60)).toBe(true);
      const tooNarrow = dashboard.render(20);
      expect(tooNarrow.join("\n")).toContain("too narrow");
      expect(tooNarrow.every((line) => visibleWidth(line) <= 20)).toBe(true);
      const ansiDashboard = new FabricDashboard(tui, ansiTheme, snapshot, vi.fn());
      try {
        expect(ansiDashboard.render(96).every((line) => visibleWidth(line) <= 96)).toBe(true);
      } finally {
        ansiDashboard.dispose();
      }

      dashboard.handleInput("l");
      dashboard.handleInput("\r");
      const detail = dashboard.render(80);
      const detailText = detail.join("\n");
      expect(detailText).toContain("Review the migration for security defects");
      expect(detailText).toContain("anthropic/claude-opus-4-8");
      expect(detail.every((line) => visibleWidth(line) <= 80)).toBe(true);
    } finally {
      dashboard.dispose();
    }
  });
  it("renders call inputs and outputs with preview highlighting", () => {
    const current = snapshot();
    current.agents = [];
    current.actors = [];
    current.globalActors = [];
    current.state = [];
    current.runs[0]!.items = [];
    const now = current.now;
    current.runs[0]!.calls = [
      {
        id: "bash-detail",
        ref: "pi.bash",
        label: "pi.bash",
        kind: "tool",
        status: "completed",
        args: { command: "pnpm vitest run tests/fabric-ui.test.ts" },
        result: { ok: true, output: "Tests **passed**" },
        startedAt: now - 1_000,
        updatedAt: now,
        finishedAt: now,
      },
      {
        id: "edit-detail",
        ref: "pi.edit",
        label: "pi.edit",
        kind: "tool",
        status: "completed",
        args: {
          path: "src/example.ts",
          edits: [{ oldText: "const oldValue = 1;", newText: "const newValue = 2;" }],
        },
        result: {
          ok: true,
          output: "edited",
          details: { diff: "-1 const oldValue = 1;\n+1 const newValue = 2;" },
        },
        startedAt: now - 900,
        updatedAt: now,
        finishedAt: now,
      },
      {
        id: "write-detail",
        ref: "pi.write",
        label: "pi.write",
        kind: "tool",
        status: "completed",
        args: { path: "src/example.ts", content: "export const value = 2;" },
        result: { ok: true, created: true },
        preview: {
          writeBeforeCaptured: true,
          codePreviewBeforeWrite: {
            kind: "content",
            content: "export const value = 1;",
          },
        },
        startedAt: now - 800,
        updatedAt: now,
        finishedAt: now,
      },
      {
        id: "structured-detail",
        ref: "extensions.analyze",
        label: "analyze",
        kind: "extension",
        status: "completed",
        args: { query: "ui regressions", limit: 2 },
        result: { findings: [{ name: "cursor jump", fixed: true }] },
        startedAt: now - 700,
        updatedAt: now,
        finishedAt: now,
      },
    ];
    for (const call of current.runs[0]!.calls) call.phaseId = "audit";

    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 60 } } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
      { codePreviewSettings },
    );
    const openDetail = (index: number): string => {
      for (let step = 0; step < index; step++) dashboard.handleInput("j");
      dashboard.handleInput("\r");
      const pages: string[] = [];
      for (let scroll = 0; scroll < 20; scroll++) {
        pages.push(dashboard.render(100).join("\n"));
        dashboard.handleInput("j");
      }
      dashboard.handleInput("\x1b");
      return pages.join("\n");
    };
    try {
      dashboard.render(120);
      dashboard.handleInput("l");
      const bash = openDetail(0);
      expect(bash).toContain("Preview:");
      expect(bash).toContain("pnpm vitest run tests/fabric-ui.test.ts");
      expect(bash).toContain("Tests **passed**");
      expect(bash).toContain("1.0s");

      const edit = openDetail(1).replace(/\x1b\[[0-9;]*m/g, "");
      expect(edit).toContain("Preview:");
      expect(edit).toContain("const oldValue = 1;");
      expect(edit).toContain("const newValue = 2;");

      const write = openDetail(1).replace(/\x1b\[[0-9;]*m/g, "");
      expect(write).toContain("Preview:");
      expect(write).toContain("Write applied");
      expect(write).toContain("export const value = 1;");
      expect(write).toContain("export const value = 2;");

      const structured = openDetail(1);
      expect(structured).toContain("Input:");
      expect(structured).toContain("query: ui regressions");
      expect(structured).toContain("limit: 2");
      expect(structured).toContain("Output:");
      expect(structured).toContain("findings:");
      expect(structured).toContain("fixed: true");
    } finally {
      dashboard.dispose();
    }
  });

  it("rerenders dashboard core-tool details with lazy Shiki highlighting", async () => {
    configureHighlighting("dark-plus", false);
    configureHighlighting("dark-plus", true);
    const current = snapshot();
    current.agents = [];
    current.actors = [];
    current.globalActors = [];
    current.state = [];
    current.runs[0]!.items = [];
    const now = current.now;
    const call = (
      id: string,
      ref: string,
      args: Record<string, unknown>,
      result: unknown,
      preview?: unknown,
    ) => ({
      id,
      ref,
      label: ref,
      kind: "tool" as const,
      status: "completed" as const,
      phaseId: "audit",
      args,
      result,
      ...(preview !== undefined ? { preview } : {}),
      startedAt: now - 1_000,
      updatedAt: now,
      finishedAt: now,
    });
    current.runs[0]!.calls = [
      call("lazy-read", "pi.read", { path: "src/lazy-read.ts" }, "export const lazyRead = true;"),
      call(
        "lazy-write",
        "pi.write",
        { path: "src/lazy-write.ts", content: "export const lazyWrite = true;" },
        { ok: true },
        { writeBeforeCaptured: true },
      ),
      call(
        "lazy-edit",
        "pi.edit",
        { path: "src/lazy-edit.ts", edits: [{ oldText: "const value = false;", newText: "const value = true;" }] },
        { ok: true, details: { diff: "-1 const value = false;\n+1 const value = true;" } },
      ),
      call(
        "lazy-grep",
        "pi.grep",
        { path: "src", pattern: "lazyGrep", literal: true },
        "src/lazy-grep.ts:1: export const lazyGrep = true;",
      ),
      call(
        "lazy-bash",
        "pi.bash",
        { command: "printf '%s\n' lazy-bash" },
        { ok: true, output: "lazy-bash" },
      ),
    ];
    const requestRender = vi.fn();
    const dashboard = new FabricDashboard(
      { requestRender, terminal: { rows: 60 } } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
      { codePreviewSettings },
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("l");
      dashboard.handleInput("\r");
      requestRender.mockClear();
      expect(dashboard.render(100).join("\n")).not.toContain("\x1b[38;2;");
      await vi.waitFor(() => expect(requestRender).toHaveBeenCalled(), { timeout: 15_000 });
      expect(dashboard.render(100).join("\n")).toContain("\x1b[38;2;");

      dashboard.handleInput("\x1b");
      for (let index = 1; index < current.runs[0]!.calls.length; index++) {
        dashboard.handleInput("j");
        dashboard.handleInput("\r");
        expect(dashboard.render(100).join("\n")).toContain("\x1b[38;2;");
        dashboard.handleInput("\x1b");
      }
    } finally {
      dashboard.dispose();
    }
  }, 20_000);

  it("lazily highlights dashboard Markdown code and structured YAML", async () => {
    configureHighlighting("dark-plus", false);
    configureHighlighting("dark-plus", true);
    const current = snapshot();
    current.agents[0]!.task = "## Planned checks\n\n- Inspect **authentication**\n\n```ts\nexport const dashboardTask = true;\n```";
    current.agents[0]!.text = "### Findings\n\n1. Found a **rotation gap**";
    current.agents[0]!.value = {
      findings: [{ severity: "high", path: "src/auth.ts" }],
      approved: false,
    };
    const requestRender = vi.fn();
    const dashboard = new FabricDashboard(
      { requestRender, terminal: { rows: 60 } } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("l");
      dashboard.handleInput("\r");
      requestRender.mockClear();
      const plainPage = dashboard.render(100).join("\n");
      expect(plainPage).not.toContain("\x1b[38;2;");
      await vi.waitFor(() => expect(requestRender).toHaveBeenCalled(), { timeout: 15_000 });
      const firstPage = dashboard.render(100).join("\n");
      expect(firstPage).toContain("\x1b[38;2;");
      for (let index = 0; index < 30; index++) dashboard.handleInput("j");
      const lastPage = dashboard.render(100).join("\n");
      const detail = `${firstPage}\n${lastPage}`;
      const visibleDetail = detail.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

      expect(visibleDetail).toContain("Task:");
      expect(visibleDetail).toContain("Planned checks");
      expect(visibleDetail).toContain("Inspect authentication");
      expect(visibleDetail).toContain("export const dashboardTask = true;");
      expect(visibleDetail).not.toContain("## Planned checks");
      expect(visibleDetail).not.toContain("**authentication**");
      expect(visibleDetail).toContain("Result:");
      expect(visibleDetail).toContain("Findings");
      expect(visibleDetail).toContain("Found a rotation gap");
      expect(visibleDetail).toContain("Value:");
      expect(visibleDetail).toContain("findings:");
      expect(visibleDetail).toContain("- severity: high");
      expect(visibleDetail).toContain("path: src/auth.ts");
      expect(visibleDetail).toContain("approved: false");
      expect(visibleDetail).not.toContain('{"findings"');
      expect(detail.split("\n").every((line) => visibleWidth(line) <= 100)).toBe(true);
    } finally {
      dashboard.dispose();
    }
  }, 20_000);

  const openActorDetail = (dashboard: FabricDashboard): void => {
    dashboard.handleInput("G");
    dashboard.handleInput("l");
    dashboard.handleInput("\r");
  };

  it("previews recent mailbox data payloads instead of the data placeholder", () => {
    const current = snapshot();
    const actor = current.actors[0]!;
    const stamp = Date.now();
    actor.recentMessages = [
      {
        id: "msg-data",
        actorId: actor.id,
        actorName: actor.name,
        direction: "in",
        source: "mesh:team.review",
        createdAt: stamp,
        data: { kind: "finding", path: "src/actors/manager.ts" },
      },
      {
        id: "msg-truncated",
        actorId: actor.id,
        actorName: actor.name,
        direction: "in",
        source: "mesh:team.review",
        createdAt: stamp,
        data: { fabricTruncated: true, originalBytes: 4096, preview: '{"blob":"abcdef' },
      },
      {
        id: "msg-empty",
        actorId: actor.id,
        actorName: actor.name,
        direction: "out",
        source: "direct",
        createdAt: stamp,
      },
    ];
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      openActorDetail(dashboard);
      const detail = dashboard.render(200).join("\n");
      expect(detail).toContain("Recent mailbox");
      expect(detail).toContain('{"kind":"finding","path":"src/actors/manager.ts"}');
      expect(detail).toContain('[truncated from 4096 bytes]');
      expect(detail).not.toContain("mesh:team.review: data");
      expect(detail).toContain("direct: data");
    } finally {
      dashboard.dispose();
    }
  });


  it("offers a per-actor model picker from the actor detail view", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const onActorModel = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      modelSource: actorModelSource,
      onActorModel,
    });
    try {
      openActorDetail(dashboard);
      const detail = dashboard.render(120);
      expect(detail.join("\n")).toContain("advisor");
      expect(detail.join("\n")).toContain("m session model");

      // Open the picker.
      dashboard.handleInput("m");
      const picker = dashboard.render(120);
      const pickerText = picker.join("\n");
      expect(pickerText).toContain('Model for actor "advisor"');
      expect(pickerText).toContain("Inherit");
      expect(pickerText).toContain("claude-sonnet-4-5");
      expect(picker.every((line) => visibleWidth(line) <= 120)).toBe(true);

      // Select the first real model (Inherit is index 0; one down lands on it).
      dashboard.handleInput("\x1b[B");
      dashboard.handleInput("\r");
      expect(onActorModel).toHaveBeenCalledWith(
        "actor-1",
        "anthropic/claude-sonnet-4-5",
        "session",
      );

      // Selecting closes the picker and returns to the actor detail.
      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
      expect(after.join("\n")).not.toContain('Model for actor "advisor"');
    } finally {
      dashboard.dispose();
    }
  });

  it("uses the Claude runtime catalog for a Claude actor", () => {
    const current = snapshot();
    current.actors[0]!.runner = "claude";
    current.actors[0]!.model = "claude/haiku";
    current.actors[0]!.binding = {
      scope: "session",
      sessionId: "session-test",
      model: "claude/haiku",
    };
    const onActorModel = vi.fn();
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
      {
        modelSource: actorModelSource,
        claudeModelSource: {
          models: [{ provider: "claude", id: "haiku", name: "Haiku (runtime)" }],
          lastUsed: {},
        },
        onActorModel,
      },
    );
    try {
      openActorDetail(dashboard);
      dashboard.handleInput("m");
      const picker = dashboard.render(120).join("\n");
      expect(picker).toContain('Model for Claude actor "advisor"');
      expect(picker).toContain("Haiku (runtime)");
      dashboard.handleInput("\r");
      expect(onActorModel).toHaveBeenCalledWith("actor-1", "claude/haiku", "session");
    } finally {
      dashboard.dispose();
    }
  });

  it("picking Inherit clears the actor model override", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const onActorModel = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      modelSource: actorModelSource,
      onActorModel,
    });
    try {
      openActorDetail(dashboard);
      dashboard.handleInput("m");
      // Inherit is the default selection (index 0).
      dashboard.handleInput("\r");
      expect(onActorModel).toHaveBeenCalledWith("actor-1", undefined, "session");
      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
    } finally {
      dashboard.dispose();
    }
  });

  it("uses uppercase model and thinking controls for explicit project pins", () => {
    const onActorModel = vi.fn();
    const onActorThinking = vi.fn();
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      snapshot,
      vi.fn(),
      { modelSource: actorModelSource, onActorModel, onActorThinking },
    );
    try {
      openActorDetail(dashboard);
      dashboard.handleInput("M");
      expect(dashboard.render(120).join("\n")).toContain(
        'Project model default for actor "advisor"',
      );
      dashboard.handleInput("\x1b[B");
      dashboard.handleInput("\r");
      expect(onActorModel).toHaveBeenCalledWith(
        "actor-1",
        "anthropic/claude-sonnet-4-5",
        "project",
      );

      dashboard.handleInput("E");
      expect(dashboard.render(120).join("\n")).toContain(
        'Project thinking default for actor "advisor"',
      );
      dashboard.handleInput("\x1b[B");
      dashboard.handleInput("\r");
      expect(onActorThinking).toHaveBeenCalledWith("actor-1", "off", "project");
    } finally {
      dashboard.dispose();
    }
  });
  it("keeps session bindings available while hiding owner-only passive actor controls", () => {
    const current = snapshot();
    current.actors[0]!.local = false;
    const onActorModel = vi.fn();
    const onActorThinking = vi.fn();
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
      {
        modelSource: actorModelSource,
        onActorModel,
        onActorThinking,
        onActorDeliveryPolicy: vi.fn(),
        onActorEvents: vi.fn(),
        onActorTools: vi.fn(),
        onActorInstructions: vi.fn(),
        onClearMessages: vi.fn(),
      },
    );
    try {
      openActorDetail(dashboard);
      const detail = dashboard.render(120).join("\n");
      expect(detail).toContain("m session model");
      expect(detail).toContain("e session thinking");
      expect(detail).not.toContain("pin model");
      expect(detail).not.toContain("pin thinking");
      expect(detail).not.toContain("delivery policy");
      expect(detail).not.toContain("clear mailbox");

      dashboard.handleInput("M");
      expect(dashboard.render(120).join("\n")).not.toContain("Project model default");
      dashboard.handleInput("y");
      expect(dashboard.render(120).join("\n")).not.toContain("Mailbox only");

      dashboard.handleInput("m");
      expect(dashboard.render(120).join("\n")).toContain('Model for actor "advisor"');
      dashboard.handleInput("\x1b");
      dashboard.handleInput("e");
      expect(dashboard.render(120).join("\n")).toContain('Thinking level for actor "advisor"');
      expect(onActorModel).not.toHaveBeenCalled();
      expect(onActorThinking).not.toHaveBeenCalled();
    } finally {
      dashboard.dispose();
    }
  });

  it("canceling the picker returns to the detail without changing the model", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const onActorModel = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      modelSource: actorModelSource,
      onActorModel,
    });
    try {
      openActorDetail(dashboard);
      dashboard.handleInput("m");
      dashboard.handleInput("\x1b");
      expect(onActorModel).not.toHaveBeenCalled();
      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
      expect(after.join("\n")).not.toContain('Model for actor "advisor"');
    } finally {
      dashboard.dispose();
    }
  });

  it("offers a per-actor thinking picker from the actor detail view", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const onActorThinking = vi.fn<(
      id: string,
      thinking: FabricThinking | undefined,
      scope: "session" | "project",
    ) => void>();
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      modelSource: actorModelSource,
      onActorThinking,
    });
    try {
      openActorDetail(dashboard);
      const detail = dashboard.render(120);
      expect(detail.join("\n")).toContain("advisor");
      expect(detail.join("\n")).toContain("e session thinking");

      // Open the thinking picker.
      dashboard.handleInput("e");
      const picker = dashboard.render(120);
      const pickerText = picker.join("\n");
      expect(pickerText).toContain('Thinking level for actor "advisor"');
      expect(pickerText).toContain("Inherit");
      expect(pickerText).toContain("Medium");
      expect(picker.every((line) => visibleWidth(line) <= 120)).toBe(true);

      // Inherit is index 0; "medium" is index 4 (off=1, minimal=2, low=3, medium=4).
      dashboard.handleInput("\x1b[B");
      dashboard.handleInput("\x1b[B");
      dashboard.handleInput("\x1b[B");
      dashboard.handleInput("\x1b[B");
      dashboard.handleInput("\r");
      expect(onActorThinking).toHaveBeenCalledWith("actor-1", "medium", "session");

      // Selecting closes the picker and returns to the actor detail.
      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
      expect(after.join("\n")).not.toContain('Thinking level for actor "advisor"');
    } finally {
      dashboard.dispose();
    }
  });

  it("picking Inherit clears the actor thinking override", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const onActorThinking = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      modelSource: actorModelSource,
      onActorThinking,
    });
    try {
      openActorDetail(dashboard);
      dashboard.handleInput("e");
      // Inherit is the default selection (index 0) for an actor with no thinking set.
      dashboard.handleInput("\r");
      expect(onActorThinking).toHaveBeenCalledWith("actor-1", undefined, "session");
      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
    } finally {
      dashboard.dispose();
    }
  });

  it("canceling the thinking picker returns to the detail without changing thinking", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const onActorThinking = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      modelSource: actorModelSource,
      onActorThinking,
    });
    try {
      openActorDetail(dashboard);
      dashboard.handleInput("e");
      dashboard.handleInput("\x1b");
      expect(onActorThinking).not.toHaveBeenCalled();
      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
      expect(after.join("\n")).not.toContain('Thinking level for actor "advisor"');
    } finally {
      dashboard.dispose();
    }
  });

  it("does not offer the thinking picker when no onActorThinking is wired", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn());
    try {
      openActorDetail(dashboard);
      const detail = dashboard.render(120);
      expect(detail.join("\n")).not.toContain("e session thinking");
      // Pressing e is a no-op: still in the actor detail.
      dashboard.handleInput("e");
      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
    } finally {
      dashboard.dispose();
    }
  });

  it("does not offer the picker when no model source is wired", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn());
    try {
      openActorDetail(dashboard);
      const detail = dashboard.render(120);
      expect(detail.join("\n")).not.toContain("m model");
      // Pressing m is a no-op: still in the actor detail.
      dashboard.handleInput("m");
      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
    } finally {
      dashboard.dispose();
    }
  });

  it("edits a live actor delivery policy with an explicit resume choice", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const onActorDeliveryPolicy = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      onActorDeliveryPolicy,
    });
    try {
      openActorDetail(dashboard);
      const detail = dashboard.render(120).join("\n");
      expect(detail).toContain("Trigger turn: no");
      expect(detail).toContain("y delivery policy");

      dashboard.handleInput("y");
      const picker = dashboard.render(120).join("\n");
      expect(picker).toContain("Mailbox only ✓");
      expect(picker).toContain("Steer · resume Main");
      dashboard.handleInput("\x1b[B");
      dashboard.handleInput("\x1b[B");
      dashboard.handleInput("\r");
      expect(onActorDeliveryPolicy).toHaveBeenCalledWith("actor-1", "steer", true);
    } finally {
      dashboard.dispose();
    }
  });

  it("offers a per-actor host-event picker from the actor detail view", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const onActorEvents = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      modelSource: actorModelSource,
      onActorEvents,
    });
    try {
      openActorDetail(dashboard);
      const detail = dashboard.render(120);
      expect(detail.join("\n")).toContain("v events");
      // clear is offered by its own callback, not wired in this test.
      expect(detail.join("\n")).not.toContain("c clear");

      // Open the events picker. The fixture actor subscribes to turn_end only.
      dashboard.handleInput("v");
      const picker = dashboard.render(120);
      const pickerText = picker.join("\n");
      expect(pickerText).toContain('Host events for actor "advisor"');
      expect(pickerText).toContain("[x] turn_end");
      expect(pickerText).toContain("[ ] input");
      expect(picker.every((line) => visibleWidth(line) <= 120)).toBe(true);

      // Toggle input on (index 0), move down to turn_end, toggle it off, apply.
      dashboard.handleInput(" ");
      dashboard.handleInput("\x1b[B");
      dashboard.handleInput(" ");
      dashboard.handleInput("\r");
      expect(onActorEvents).toHaveBeenCalledWith("actor-1", ["input"]);

      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
      expect(after.join("\n")).not.toContain('Host events for actor "advisor"');
    } finally {
      dashboard.dispose();
    }
  });

  it("scrolls the expanded host-event catalog around the current selection", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      modelSource: actorModelSource,
      onActorEvents: vi.fn(),
    });
    try {
      openActorDetail(dashboard);
      dashboard.handleInput("v");
      for (let index = 0; index < 28; index++) dashboard.handleInput("\x1b[B");
      const picker = dashboard.render(120);
      const pickerText = picker.join("\n");
      expect(pickerText).toContain("tool_result");
      expect(pickerText).toContain("earlier events");
      expect(pickerText).not.toContain("raw user or extension input");
      expect(picker.every((line) => visibleWidth(line) <= 120)).toBe(true);
    } finally {
      dashboard.dispose();
    }
  });

  it("canceling the events picker returns to the detail without changing events", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const onActorEvents = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      modelSource: actorModelSource,
      onActorEvents,
    });
    try {
      openActorDetail(dashboard);
      dashboard.handleInput("v");
      dashboard.handleInput("\x1b");
      expect(onActorEvents).not.toHaveBeenCalled();
      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
      expect(after.join("\n")).not.toContain('Host events for actor "advisor"');
    } finally {
      dashboard.dispose();
    }
  });

  it("clearing the mailbox invokes onClearMessages without leaving the detail", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const onClearMessages = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      modelSource: actorModelSource,
      onClearMessages,
    });
    try {
      openActorDetail(dashboard);
      const detail = dashboard.render(120);
      expect(detail.join("\n")).toContain("c clear");

      dashboard.handleInput("c");
      expect(onClearMessages).toHaveBeenCalledWith("actor-1");

      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
    } finally {
      dashboard.dispose();
    }
  });

  it("does not offer the events or clear actions when not wired", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const dashboard = new FabricDashboard(tui, theme, snapshot, vi.fn(), {
      modelSource: actorModelSource,
    });
    try {
      openActorDetail(dashboard);
      const detail = dashboard.render(120);
      expect(detail.join("\n")).not.toContain("v events");
      expect(detail.join("\n")).not.toContain("c clear");
      // Pressing v/c is a no-op: still in the actor detail.
      dashboard.handleInput("v");
      dashboard.handleInput("c");
      const after = dashboard.render(120);
      expect(after.join("\n")).toContain("advisor");
    } finally {
      dashboard.dispose();
    }
  });
  it("shows active and completed run-owned work in the Agents group", () => {
    const current = snapshot();
    const run = current.runs[0]!;
    current.actors = [];
    current.globalActors = [];
    current.state = [];
    current.events = [];
    run.status = "completed";
    run.finishedAt = current.now - 1_000;
    for (const phase of run.phases) phase.status = "completed";
    run.items = [];
    run.calls = [
      {
        id: "spawn-active",
        ref: "agents.spawn",
        label: "background-active",
        kind: "agent",
        status: "completed",
        entityId: "agent-active",
        startedAt: current.now - 2_000,
        updatedAt: current.now - 1_900,
        finishedAt: current.now - 1_900,
      },
      {
        id: "spawn-done",
        ref: "agents.spawn",
        label: "background-done",
        kind: "agent",
        status: "completed",
        entityId: "agent-done",
        startedAt: current.now - 3_000,
        updatedAt: current.now - 2_900,
        finishedAt: current.now - 2_900,
      },
    ];
    const { phaseId: _phaseId, ...unphasedAgent } = snapshot().agents[0]!;
    current.agents = [
      {
        ...unphasedAgent,
        id: "agent-active",
        name: "background-active",
        status: "running",
        runId: run.id,
      },
      {
        ...unphasedAgent,
        id: "agent-done",
        name: "background-done",
        status: "completed",
        runId: run.id,
      },
    ];

    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      const all = dashboard.render(120).join("\n");
      expect(all).toContain("Agents (3)");
      expect(all).toContain("background-active");
      expect(all).toContain("background-done");
      expect(all).toContain("Run activity");

      dashboard.handleInput("f");
      const active = dashboard.render(120).join("\n");
      expect(active).toContain("background-active");
      expect(active).not.toContain("background-done");

      dashboard.handleInput("f");
      const completed = dashboard.render(120).join("\n");
      expect(completed).not.toContain("background-active");
      expect(completed).toContain("background-done");
    } finally {
      dashboard.dispose();
    }
  });

  it("keeps lifecycle calls and linked agents in their sidebar phases", () => {
    const current = snapshot();
    const run = current.runs[0]!;
    current.actors = [];
    current.globalActors = [];
    current.state = [];
    run.currentPhaseId = "implement";
    run.phases = [
      {
        id: "spawn",
        name: "Spawn agents",
        status: "completed",
        total: 1,
        startedAt: current.now - 10_000,
        updatedAt: current.now - 9_000,
        finishedAt: current.now - 9_000,
      },
      {
        id: "implement",
        name: "Implement",
        status: "running",
        total: 1,
        startedAt: current.now - 9_000,
        updatedAt: current.now,
      },
    ];
    run.calls = [
      {
        id: "spawn-agent",
        ref: "agents.spawn",
        label: "worker",
        kind: "agent",
        status: "completed",
        phaseId: "spawn",
        entityId: "agent-1",
        startedAt: current.now - 10_000,
        updatedAt: current.now - 9_000,
        finishedAt: current.now - 9_000,
      },
      {
        id: "wait-agent",
        ref: "agents.wait",
        label: "wait for worker",
        kind: "agent",
        status: "running",
        phaseId: "implement",
        entityId: "agent-1",
        startedAt: current.now - 8_000,
        updatedAt: current.now,
      },
    ];
    run.items = [];
    current.agents[0] = {
      ...current.agents[0]!,
      name: "worker",
      phaseId: "spawn",
    };

    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      const implementLines = dashboard.render(120);
      const implement = implementLines.join("\n");
      expect(implement).toContain("Agents (2)");
      expect(implement).toContain("wait for worker");
      expect(implement).toContain("Spawn agents");
      expect(implement).toContain("Implement");
      expect(implementLines.some((line) => /^│[^│]*│[^│]*Implement/.test(line))).toBe(false);

      dashboard.handleInput("k");
      const spawn = dashboard.render(120).join("\n");
      expect(spawn).toContain("Agents (2)");
      expect(spawn).toContain("worker");
      expect(spawn).not.toContain("wait for worker");
    } finally {
      dashboard.dispose();
    }
  });

  it("keeps the selected run stable when newer activity reorders the run list", () => {
    const current = snapshot();
    const newest = current.runs[0]!;
    const older = structuredClone(newest);
    older.id = "run-older";
    older.name = "Older retained run";
    older.updatedAt -= 10_000;
    current.runs = [newest, older];
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("[");
      expect(dashboard.render(120).join("\n")).toContain("Older retained run");

      const later = structuredClone(newest);
      later.id = "run-later";
      later.name = "Later activity";
      current.runs = [later, newest, older];
      const afterRefresh = dashboard.render(120).join("\n");
      expect(afterRefresh).toContain("Older retained run");
      expect(afterRefresh).not.toContain("Fabric · Later activity");
    } finally {
      dashboard.dispose();
    }
  });

  it("keeps an open detail visible when its status leaves the current filter", () => {
    const current = snapshot();
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("l");
      dashboard.handleInput("f");
      dashboard.handleInput("\r");
      expect(dashboard.render(120).join("\n")).toContain("Review the migration");

      current.agents[0]!.status = "completed";
      const completedDetail = dashboard.render(120).join("\n");
      expect(completedDetail).toContain("Review the migration");
      expect(completedDetail).toContain("One-shot agent");
    } finally {
      dashboard.dispose();
    }
  });

  it("queues user messages for Main, actors, and remote mesh agents", () => {
    const current = snapshot();
    current.participants = [
      {
        format: 1,
        id: "remote-agent",
        kind: "agent",
        rootId: "session:peer",
        ownerHostId: "session:peer",
        ownerIdentityId: "session:peer",
        parentId: "session:peer",
        name: "remote implementor",
        status: "running",
        runner: "pi",
        transport: "process",
        capabilities: ["steer", "followUp", "stop"],
        startedAt: current.now - 1_000,
        updatedAt: current.now,
        controlProtocol: "v1",
        local: false,
        stale: false,
      },
    ];
    current.events.push({
      id: "external-agent",
      sequence: 2,
      topic: "team.review",
      kind: "handoff",
      from: { id: "remote-agent", name: "remote implementor", kind: "agent" },
      text: "available",
      createdAt: current.now,
    });
    const onTargetMessage = vi.fn();
    const onAgentStop = vi.fn();
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
      { onTargetMessage, onAgentStop },
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("l");
      dashboard.handleInput("g");
      expect(dashboard.render(120).join("\n")).toContain("Main actions: s message/steer");
      dashboard.handleInput("s");
      dashboard.handleInput("prioritize the regression");
      dashboard.handleInput("\r");
      expect(onTargetMessage).toHaveBeenCalledWith(
        { id: "session:main", name: "Main", kind: "main" },
        "prioritize the regression",
        "steer",
      );

      dashboard.handleInput("u");
      dashboard.handleInput("then summarize");
      dashboard.handleInput("\r");
      expect(onTargetMessage).toHaveBeenCalledWith(
        { id: "session:main", name: "Main", kind: "main" },
        "then summarize",
        "followUp",
      );

      dashboard.handleInput("\x1b");
      dashboard.handleInput("j");
      dashboard.handleInput("s");
      dashboard.handleInput("stay within auth scope");
      dashboard.handleInput("\r");
      expect(onTargetMessage).toHaveBeenCalledWith(
        { id: "agent-1", name: "security-reviewer", kind: "agent" },
        "stay within auth scope",
        "steer",
      );

      dashboard.handleInput("\x1b");
      dashboard.handleInput("h");
      dashboard.handleInput("G");
      dashboard.handleInput("l");
      dashboard.handleInput("s");
      dashboard.handleInput("review this queue item");
      dashboard.handleInput("\r");
      expect(onTargetMessage).toHaveBeenCalledWith(
        { id: "actor-1", name: "advisor", kind: "actor" },
        "review this queue item",
        "steer",
      );

      dashboard.handleInput("\x1b");
      dashboard.handleInput("2");
      dashboard.handleInput("g");
      dashboard.handleInput("j");
      dashboard.handleInput("j");
      dashboard.handleInput("j");
      dashboard.handleInput("s");
      dashboard.handleInput("continue remotely");
      dashboard.handleInput("\r");
      expect(onTargetMessage).toHaveBeenCalledWith(
        { id: "remote-agent", name: "remote implementor", kind: "meshParticipant" },
        "continue remotely",
        "steer",
      );
      expect(dashboard.render(120).join("\n")).toContain(
        "Remote participant actions: s steer over mesh · u queue follow-up over mesh · x stop",
      );
      dashboard.handleInput("x");
      expect(onAgentStop).not.toHaveBeenCalled();
      expect(dashboard.render(120).join("\n")).toContain("x again to confirm stop");
      dashboard.handleInput("x");
      expect(onAgentStop).toHaveBeenCalledWith("remote-agent");
    } finally {
      dashboard.dispose();
    }
  });

  it("steers, follows up, and safely stops an agent from the overview", () => {
    const current = snapshot();
    const onAgentSteer = vi.fn();
    const onAgentFollowUp = vi.fn();
    const onAgentStop = vi.fn();
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
      { onAgentSteer, onAgentFollowUp, onAgentStop },
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("l");
      expect(dashboard.render(120).join("\n")).toContain("agent actions: s steer · u follow-up · x stop");

      dashboard.handleInput("s");
      expect(dashboard.render(120).join("\n")).toContain("steer now · security-reviewer");
      dashboard.handleInput("focus on auth checks");
      dashboard.handleInput("\r");
      expect(onAgentSteer).toHaveBeenCalledWith("agent-1", "focus on auth checks");

      dashboard.handleInput("\x1b");
      dashboard.handleInput("u");
      expect(dashboard.render(120).join("\n")).toContain("queue follow-up");
      dashboard.handleInput("summarize remaining risks");
      dashboard.handleInput("\r");
      expect(onAgentFollowUp).toHaveBeenCalledWith("agent-1", "summarize remaining risks");

      dashboard.handleInput("\x1b");
      dashboard.handleInput("x");
      expect(onAgentStop).not.toHaveBeenCalled();
      expect(dashboard.render(120).join("\n")).toContain("x again to stop");
      dashboard.handleInput("x");
      expect(onAgentStop).toHaveBeenCalledWith("agent-1");
    } finally {
      dashboard.dispose();
    }
  });

  it("opens contextual keyboard help", () => {
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      snapshot,
      vi.fn(),
    );
    try {
      dashboard.handleInput("?");
      const help = dashboard.render(100).join("\n");
      expect(help).toContain("Fabric dashboard help");
      expect(dashboard.render(200).join("\n")).toContain(
        "M reduced motion (pins the model on an editable actor row)",
      );
      expect(help).not.toContain("s steer now");
      expect(help).not.toContain("m model");
      dashboard.handleInput("\x1b");
      expect(dashboard.render(100).join("\n")).toContain("Repository migration");
    } finally {
      dashboard.dispose();
    }
  });

  it("shows completed-agent result summaries and activity-group metrics", () => {
    const current = snapshot();
    current.agents[0]!.status = "completed";
    current.agents[0]!.finishedAt = current.now;
    current.agents[0]!.text = "Found two concrete authentication gaps.";
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      dashboard.render(120);
      const overview = dashboard.render(120).join("\n");
      expect(overview).toContain("result: Found two concrete authentication gaps.");
      expect(overview).toContain("Agents (2)");
      expect(overview).toContain("5.2k tok");
    } finally {
      dashboard.dispose();
    }
  });

  it("advertises and opens actor controls directly from the overview", () => {
    const current = snapshot();
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
      { modelSource: actorModelSource, onActorModel: vi.fn(), onActorThinking: vi.fn() },
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("j");
      dashboard.handleInput("l");
      const overview = dashboard.render(120).join("\n");
      expect(overview).toContain(
        "actor actions: m session model · M pin model · e session thinking · E pin thinking",
      );

      dashboard.handleInput("m");
      expect(dashboard.render(120).join("\n")).toContain('Model for actor "advisor"');
    } finally {
      dashboard.dispose();
    }
  });

  it("selects persistent actor tools from the actor overview", () => {
    const current = snapshot();
    current.actors[0]!.tools = ["read", "grep"];
    const onActorTools = vi.fn();
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
      { onActorTools, actorDefaultTools: ["read", "grep", "find", "ls"] },
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("j");
      dashboard.handleInput("l");
      expect(dashboard.render(120).join("\n")).toContain("actor actions: o tools");

      dashboard.handleInput("o");
      expect(dashboard.render(120).join("\n")).toContain('Tools for actor "advisor"');
      dashboard.handleInput(" ");
      dashboard.handleInput("\r");
      expect(onActorTools).toHaveBeenCalledWith("actor-1", ["grep"]);
    } finally {
      dashboard.dispose();
    }
  });

  it("lazy-loads actor transcript pages and toggles tool details with the native binding", () => {
    const nestedSuccessBackground = "\x1b[48;2;10;10;10m";
    const nestedErrorBackground = "\x1b[48;2;20;10;10m";
    const dashboardTheme = {
      ...theme,
      getFgAnsi: (color: string) => color === "toolDiffAdded"
        ? "\x1b[38;2;80;200;120m"
        : "\x1b[38;2;220;90;100m",
      getBgAnsi: (color: string) => color === "toolErrorBg"
        ? nestedErrorBackground
        : nestedSuccessBackground,
    } as unknown as Theme;
    const actorTranscript = vi.fn(() => ({
      truncated: true,
      hasMore: true,
      hasNewer: true,
      entries: [
        {
          id: "actor-edit",
          kind: "tool" as const,
          label: "edit",
          toolName: "edit",
          status: "running" as const,
          args: {
            path: "src/actor.ts",
            edits: [{ oldText: "const before = 1;", newText: "const after = 2;" }],
          },
          text: "editing actor source",
        },
        {
          id: "actor-grep",
          kind: "tool" as const,
          label: "grep",
          toolName: "grep",
          status: "completed" as const,
          args: { pattern: "actorValue", path: "src", literal: true },
          result: {
            content: [{ type: "text", text: "src/actor.ts:1: const actorValue = true;" }],
          },
        },
      ],
    }));
    const loadOlderTranscript = vi.fn(() => true);
    const loadNewerTranscript = vi.fn(() => true);
    const loadLatestTranscript = vi.fn(() => true);
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 24 } } as unknown as TUI,
      dashboardTheme,
      snapshot,
      vi.fn(),
      {
        actorTranscript,
        loadOlderTranscript,
        loadNewerTranscript,
        loadLatestTranscript,
        codePreviewSettings,
      },
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("j");
      dashboard.handleInput("l");
      dashboard.handleInput(" ");
      const collapsed = dashboard.render(100).join("\n");
      const collapsedVisible = collapsed.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      expect(actorTranscript).toHaveBeenCalledWith(
        expect.objectContaining({ id: "actor-1", name: "advisor" }),
        true,
      );
      expect(collapsedVisible).toContain("actor · advisor · transcript");
      expect(collapsedVisible).toContain("src/actor.ts");
      expect(collapsedVisible).not.toContain("const before = 1;");
      expect(collapsedVisible).not.toContain("const after = 2;");
      expect(collapsedVisible).toContain("ctrl+o expand tools");
      const collapsedRows = collapsedVisible.split("\n");
      const collapsedGrepRow = collapsedRows.findIndex((line) => line.includes("actorValue"));
      expect(collapsedGrepRow).toBeGreaterThan(0);
      expect(collapsedRows[collapsedGrepRow - 1]!.slice(1, -1).trim()).not.toBe("");

      dashboard.handleInput("\x0f");
      const expanded = dashboard.render(100).join("\n");
      const expandedVisible = expanded.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      expect(expanded).toContain("\x1b[48;2;");
      expect(expanded).not.toContain(nestedSuccessBackground);
      expect(expanded).not.toContain(nestedErrorBackground);
      expect(expandedVisible).toContain("const before = 1;");
      expect(expandedVisible).toContain("const after = 2;");
      expect(expandedVisible).toContain("const actorValue = true;");
      expect(expandedVisible).toContain("ctrl+o collapse tools");
      const expandedRows = expandedVisible.split("\n");
      const expandedGrepRow = expandedRows.findIndex((line) => line.includes("actorValue"));
      expect(expandedGrepRow).toBeGreaterThan(0);
      expect(expandedRows[expandedGrepRow - 1]!.slice(1, -1).trim()).toBe("");

      dashboard.handleInput("g");
      dashboard.handleInput("k");
      expect(loadOlderTranscript).toHaveBeenCalledWith(
        expect.objectContaining({ id: "actor-1", name: "advisor" }),
      );
      dashboard.render(100);
      dashboard.handleInput("j");
      expect(loadNewerTranscript).toHaveBeenCalledWith(
        expect.objectContaining({ id: "actor-1", name: "advisor" }),
      );
      dashboard.handleInput("G");
      expect(loadLatestTranscript).toHaveBeenCalledWith(
        expect.objectContaining({ id: "actor-1", name: "advisor" }),
      );
      expect(dashboard.render(100).join("\n")).toContain("G follow:on");
    } finally {
      dashboard.dispose();
    }
  });

  it("lazily highlights expanded agent transcript tools", async () => {
    configureHighlighting("dark-plus", false);
    configureHighlighting("dark-plus", true);
    const requestRender = vi.fn();
    const dashboard = new FabricDashboard(
      { requestRender, terminal: { rows: 28 } } as unknown as TUI,
      theme,
      snapshot,
      vi.fn(),
      {
        codePreviewSettings,
        agentTranscript: () => ({
          truncated: false,
          entries: [{
            id: "lazy-transcript-read",
            kind: "tool",
            label: "read",
            toolName: "read",
            status: "completed",
            args: { path: "src/lazy-transcript.ts" },
            result: { content: [{ type: "text", text: "export const lazyTranscript = true;" }] },
          }],
        }),
      },
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("l");
      dashboard.handleInput(" ");
      dashboard.handleInput("\x0f");
      requestRender.mockClear();
      const plain = dashboard.render(100).join("\n");
      expect(plain).toContain("lazyTranscript");
      expect(plain).not.toContain("\x1b[38;2;");
      await vi.waitFor(() => expect(requestRender).toHaveBeenCalled(), { timeout: 15_000 });
      expect(dashboard.render(100).join("\n")).toContain("\x1b[38;2;");
    } finally {
      dashboard.dispose();
    }
  }, 20_000);

  it("opens a live transcript preview and toggles back to summary", () => {
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 28 } } as unknown as TUI,
      theme,
      snapshot,
      vi.fn(),
      {
        agentTranscript: () => ({
          truncated: true,
          entries: [
            { id: "message-1", kind: "assistant", label: "Agent", text: "## Live review\n\nReviewing the **event stream**.\n\n| Area | Status |\n| --- | --- |\n| Tail | Active |", status: "running" },
            { id: "tool-1", kind: "tool", label: "pi.read", text: "src/ui/dashboard.ts", status: "running" },
          ],
        }),
      },
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("l");
      expect(dashboard.render(120).join("\n")).toContain("space live transcript peek");
      dashboard.handleInput(" ");
      const transcript = dashboard.render(80).join("\n");
      expect(transcript).toContain("transcript · live");
      expect(transcript).toContain("older activity available");
      expect(transcript).toContain("Live review");
      expect(transcript).toContain("Reviewing the event stream");
      expect(transcript).toContain("Tail");
      expect(transcript).toContain("Active");
      expect(transcript).not.toContain("| --- | --- |");
      expect(transcript).toContain("pi.read · running · src/ui/dashboard.ts");
      expect(transcript.split("\n").filter((line) => line.includes("pi.read"))).toHaveLength(1);
      expect(transcript).toContain("G follow:on");

      dashboard.handleInput("k");
      expect(dashboard.render(80).join("\n")).toContain("G follow:on");
      dashboard.handleInput("G");
      expect(dashboard.render(80).join("\n")).toContain("G follow:on");
      dashboard.handleInput("t");
      expect(dashboard.render(80).join("\n")).toContain("Review the migration for security defects");
    } finally {
      dashboard.dispose();
    }
  });

  it("pauses only after real transcript scrolling and resumes at the growing tail", () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({
      id: `message-${index}`,
      kind: "assistant" as const,
      label: "Agent",
      text: `streamed update ${index}`,
      status: "completed" as const,
    }));
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 12 } } as unknown as TUI,
      theme,
      snapshot,
      vi.fn(),
      { agentTranscript: () => ({ entries, truncated: false }) },
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("l");
      dashboard.handleInput(" ");
      expect(dashboard.render(80).join("\n")).toContain("streamed update 29");

      dashboard.handleInput("k");
      const paused = dashboard.render(80).join("\n");
      expect(paused).toContain("G follow:off");
      entries.push({ id: "message-30", kind: "assistant", label: "Agent", text: "new tail update", status: "completed" });
      expect(dashboard.render(80).join("\n")).not.toContain("new tail update");

      dashboard.handleInput("G");
      const followed = dashboard.render(80).join("\n");
      expect(followed).toContain("G follow:on");
      expect(followed).toContain("new tail update");
    } finally {
      dashboard.dispose();
    }
  });

  it("includes error status in the failed filter", () => {
    const current = snapshot();
    current.agents[0]!.status = "error";
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("f");
      dashboard.handleInput("f");
      dashboard.handleInput("f");
      expect(dashboard.render(120).join("\n")).toContain("security-reviewer");
    } finally {
      dashboard.dispose();
    }
  });

  it("pins an inspected entity to its run and phase during live reordering", () => {
    const current = snapshot();
    const inspectedRun = current.runs[0]!;
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("l");
      dashboard.handleInput("\r");
      expect(dashboard.render(120).join("\n")).toContain("Review the migration for security defects");

      const { phaseId: _phaseId, ...unphasedAgent } = current.agents[0]!;
      current.agents.push({
        ...unphasedAgent,
        id: "agent-unphased",
        name: "new background agent",
      });
      const later = structuredClone(inspectedRun);
      later.id = "run-later-live";
      later.name = "Later live run";
      current.runs = [later, inspectedRun];

      const refreshed = dashboard.render(120).join("\n");
      expect(refreshed).toContain("Review the migration for security defects");
      expect(refreshed).not.toContain("Later live run");

      dashboard.handleInput("\x1b");
      const resumed = dashboard.render(120).join("\n");
      expect(resumed).toContain("Later live run");
    } finally {
      dashboard.dispose();
    }
  });

  it("keeps narrow detail and editor modes operable", () => {
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      snapshot,
      vi.fn(),
      {
        onAgentSteer: vi.fn(),
        agentTranscript: () => ({
          entries: [{ id: "narrow", kind: "assistant", label: "Agent", text: "narrow live transcript", status: "running" }],
          truncated: false,
        }),
      },
    );
    try {
      dashboard.render(120);
      dashboard.handleInput("l");
      dashboard.handleInput("\r");
      const narrow = dashboard.render(20).join("\n");
      expect(narrow).toContain("migration for");
      expect(narrow).toContain("esc");
      dashboard.handleInput("t");
      expect(dashboard.render(20).join("\n")).toContain("narrow live");
      dashboard.handleInput("s");
      const editor = dashboard.render(20).join("\n");
      expect(editor).toContain("steer");
      expect(editor).toContain("esc cancel");
    } finally {
      dashboard.dispose();
    }
  });

  it("bounds dashboard height to the effective overlay and keeps its footer", () => {
    for (const rows of [5, 7, 8, 9, 10, 12, 43]) {
      const dashboard = new FabricDashboard(
        { requestRender: vi.fn(), terminal: { rows } } as unknown as TUI,
        theme,
        snapshot,
        vi.fn(),
      );
      const overlayRows = Math.max(1, Math.min(Math.floor(rows * 0.9), rows - 2));
      try {
        expect(dashboard.render(100).length).toBeLessThanOrEqual(overlayRows);
        dashboard.handleInput("2");
        const topology = dashboard.render(100);
        expect(topology.length).toBeLessThanOrEqual(overlayRows);
        if (rows === 10) expect(topology.join("\n")).toContain("security-revi");
        if (rows === 43) {
          expect(topology.at(-1)).toContain("╰");
          expect(topology.join("\n")).toContain("arrows/h/l move");
        }
      } finally {
        dashboard.dispose();
      }
    }
  });

  it("preserves CJK and emoji while wrapping by display width", () => {
    const value = "界界界界 🚀 mission";
    const lines = wrapPlainText(value, 4);
    expect(lines.every((line) => visibleWidth(line) <= 4)).toBe(true);
    expect(lines.join("").replaceAll(" ", "")).toBe(value.replaceAll(" ", ""));
    expect(wrapPlainText("界", 1)).toEqual(["…"]);
    expect(wrapPlainText("👩‍💻x", 2)).toEqual(["👩‍💻", "x"]);
  });

  it("formats actor mailbox data payloads for preview", () => {
    expect(formatActorDataPreview(undefined)).toBeUndefined();
    expect(formatActorDataPreview("plain text")).toBe("plain text");
    expect(formatActorDataPreview({ topic: "team.review" })).toBe('{"topic":"team.review"}');
    expect(formatActorDataPreview([1, 2, 3])).toBe("[1,2,3]");
    expect(formatActorDataPreview(42)).toBe("42");
    expect(
      formatActorDataPreview({ fabricTruncated: true, originalBytes: 4096, preview: '{"blob":"abc' }),
    ).toBe('{"blob":"abc [truncated from 4096 bytes]');
    expect(formatActorDataPreview({ fabricTruncated: true, preview: '{"blob":"abc' })).toBe(
      '{"blob":"abc [truncated]',
    );
    expect(formatActorDataPreview({ fabricTruncated: true, originalBytes: 10 })).toBe(
      "[truncated from 10 bytes]",
    );
    const clipped = formatActorDataPreview("x".repeat(500), 100);
    expect(clipped).toHaveLength(100);
    expect(clipped?.endsWith("…")).toBe(true);
  });


  it("keeps Main available in Activity and the unified topology without children", () => {
    const current = snapshot();
    current.runs = [];
    current.agents = [];
    current.actors = [];
    current.globalActors = [];
    current.state = [];
    current.events = [];
    current.main.status = "idle";
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 24 } } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
      { onTargetMessage: vi.fn() },
    );
    try {
      dashboard.render(100);
      dashboard.handleInput("l");
      const activity = dashboard.render(100).join("\n");
      expect(activity).toContain("Agents (1)");
      expect(activity).toContain("Main");

      dashboard.handleInput("3");
      dashboard.handleInput("r");
      expect(dashboard.render(100).join("\n")).toContain("· Activity");

      dashboard.handleInput("2");
      const topology = dashboard.render(100).join("\n");
      expect(topology).toContain("Fabric · Topology");
      expect(topology).toContain("◆ Main");
      expect(topology).toContain("selected");
      expect(topology).not.toContain("Run topology");
      expect(topology).not.toContain("Project mesh");

      dashboard.handleInput("3");
      dashboard.handleInput("r");
      expect(dashboard.render(100).join("\n")).toContain("Fabric · Topology");
    } finally {
      dashboard.dispose();
    }
  });

  it("renders recursive agents and mesh resources in one graph", () => {
    const current = snapshot();
    const parent = {
      ...current.agents[0]!,
      id: "flow-parent",
      name: "flow-parent",
      status: "completed",
      startedAt: current.now - 50_000,
      finishedAt: current.now - 20_000,
    };
    const child = {
      ...current.agents[0]!,
      id: "flow-child",
      name: "flow-child",
      parentId: parent.id,
      status: "running",
      startedAt: current.now - 19_000,
    };
    current.agents = [parent, child];
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      dashboard.handleInput("2");
      const lines = dashboard.render(140);
      const graph = lines.join("\n");
      expect(graph).toContain("Fabric · Topology");
      expect(graph).toContain("╭ selected");
      expect(graph).not.toContain("│╭ selected");
      expect(graph).toContain("flow-parent");
      expect(graph).toContain("flow-child");
      expect(graph).toContain("advisor");
      expect(graph).toContain("team.review");
      expect(graph).toContain("Package A");
      expect(graph).toContain("phase Audit");
      expect(graph.indexOf("flow-parent")).toBeLessThan(graph.lastIndexOf("flow-child"));
      expect(lines.every((line) => visibleWidth(line) <= 140)).toBe(true);

      dashboard.handleInput("\r");
      expect(dashboard.render(140).join("\n")).toContain("agent · flow-child");
    } finally {
      dashboard.dispose();
    }
  });

  it("animates collapsed traffic edges and supports replay controls", () => {
    const current = snapshot();
    current.events = [
      {
        id: "transition",
        sequence: 1,
        topic: "fabric.state",
        kind: "transition",
        from: { id: current.main.id, name: "main", kind: "main" },
        text: "state moving",
        createdAt: current.now - 500,
      },
      {
        id: "certified",
        sequence: 2,
        topic: "fabric.state",
        kind: "state.certified",
        from: { id: current.main.id, name: "main", kind: "main" },
        text: "state certified",
        createdAt: current.now,
      },
    ];
    current.state.push(
      {
        key: "state/current",
        label: "Current state",
        status: "committed",
        value: { status: "committed" },
        version: 3,
        updatedAt: current.now,
      },
      {
        key: "state/complexity/src/index.ts",
        label: "index.ts complexity",
        status: "state",
        value: { count: 12 },
        version: 1,
        updatedAt: current.now,
      },
      {
        key: "schema/contracts/transition",
        label: "Transition contract",
        status: "state",
        value: { version: 1 },
        version: 1,
        updatedAt: current.now,
      },
    );
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      dashboard.handleInput("2");
      const live = dashboard.render(140).join("\n");
      let toured = live;
      for (let index = 0; index < 12; index++) {
        dashboard.handleInput("\t");
        toured += `\n${dashboard.render(140).join("\n")}`;
      }
      expect(live).toContain("Participants");
      expect(live).toContain("Mesh");
      expect(toured).toContain("Fabric");
      expect(topologyParticipantGroup("root")).toEqual({ id: "sessions", label: "Sessions", order: 0 });
      expect(topologyParticipantGroup("peer")).toEqual({ id: "sessions", label: "Sessions", order: 0 });
      expect(topologyParticipantGroup("agent")).toEqual({ id: "agents", label: "Agents", order: 1 });
      expect(topologyParticipantGroup("actor")).toEqual({ id: "actors", label: "Actors", order: 2 });
      expect(topologyTopicGroupPath("fabric.state")).toEqual([
        { id: "fabric", label: "Fabric" },
      ]);
      expect(topologyTopicGroupPath("fabric.actor.input")).toEqual([
        { id: "fabric", label: "Fabric" },
        { id: "fabric:actor", label: "Actor" },
      ]);
      expect(topologyTopicGroupPath("team.review")).toEqual([
        { id: "project", label: "Project topics" },
        { id: "project:team", label: "team" },
      ]);
      expect(topologyTopicGroupPath("alerts")).toEqual([
        { id: "project", label: "Project topics" },
      ]);
      expect(topologyStateGroupPath("state/current")).toEqual([
        { id: "world", label: "World state" },
      ]);
      expect(topologyStateGroupPath("state/complexity/src/index.ts")).toEqual([
        { id: "world", label: "World state" },
        { id: "world:complexity", label: "Complexity" },
        { id: "world:complexity:src", label: "src" },
      ]);
      expect(topologyStateGroupPath("schema/workspace")).toEqual([
        { id: "schema", label: "Schema" },
      ]);
      expect(topologyStateGroupPath("schema/hypothesis/abc")).toEqual([
        { id: "schema", label: "Schema" },
        { id: "schema:hypotheses", label: "Hypotheses" },
      ]);
      expect(topologyStateGroupPath("schema/certificate/abc")).toEqual([
        { id: "schema", label: "Schema" },
        { id: "schema:certificates", label: "Certificates" },
      ]);
      expect(topologyStateGroupPath("tasks/package-a")).toEqual([
        { id: "project", label: "Project state" },
        { id: "project:tasks", label: "tasks" },
      ]);
      const tree = new Map<string, { parentId?: string }>([
        ["main", {}],
        ["participants", { parentId: "main" }],
        ["agents", { parentId: "participants" }],
        ["agent", { parentId: "agents" }],
        ["mesh", { parentId: "main" }],
        ["topics", { parentId: "mesh" }],
        ["fabric", { parentId: "topics" }],
        ["fabric.state", { parentId: "fabric" }],
      ]);
      expect(topologyTreeRouteNodeIds(tree, "agent", "fabric.state")).toEqual([
        "agent",
        "agents",
        "participants",
        "main",
        "mesh",
        "topics",
        "fabric",
        "fabric.state",
      ]);
      expect(live).toContain("fabric.state");
      expect(live).not.toContain("main → fabric.state");
      expect(live).toContain("live decay");

      dashboard.handleInput("r");
      const replay = dashboard.render(140).join("\n");
      expect(replay).toContain("replay 1/2");
      expect(replay).toContain("transition");
      expect(replay).toContain("space pause");

      dashboard.handleInput("\u001b[C");
      expect(dashboard.render(140).join("\n")).toContain("replay 2/2");
      dashboard.handleInput("H");
      expect(dashboard.render(140).join("\n")).toContain("history");
      dashboard.handleInput("M");
      expect(dashboard.render(140).join("\n")).toContain("motion:reduced");
    } finally {
      dashboard.dispose();
    }
  });

  it("renders state-owned project files with highlighted readable previews", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-state-preview-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src", "answer.ts"),
      "export const answer: number = 42;\nif (answer > 0) console.log(answer);\n",
    );
    const current = snapshot();
    current.main.cwd = root;
    current.runs = [];
    current.agents = [];
    current.actors = [];
    current.events = [];
    current.state = [{
      key: "state/complexity/src/answer.ts",
      label: "state/complexity/src/answer.ts",
      status: "state",
      value: {
        file: "src/answer.ts",
        language: "typescript/javascript",
        count: 1,
      },
      version: 1,
      updatedAt: current.now,
    }];
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      dashboard.handleInput("2");
      dashboard.handleInput("G");
      const topology = dashboard.render(140).join("\n");
      const topologyText = topology.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      expect(topologyText).toContain("file src/answer.ts");
      expect(topologyText).toContain("export const answer");
      expect(topologyText).toContain("1 │");

      dashboard.handleInput("\r");
      const detail = dashboard.render(140).join("\n");
      const detailText = detail.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      expect(detailText).toContain("File: src/answer.ts");
      expect(detailText).toContain("Preview:");
      expect(detailText).toContain("if (answer > 0)");
      expect(detailText).toContain("2 │");
    } finally {
      dashboard.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps current workflow phase context in the merged topology", () => {
    const current = snapshot();
    current.agents[0] = {
      ...current.agents[0]!,
      status: "completed",
      phaseId: "discover",
      finishedAt: current.now - 1_000,
    };
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 14 } } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      dashboard.handleInput("2");
      expect(dashboard.render(100).join("\n")).toContain("current Audit");
    } finally {
      dashboard.dispose();
    }
  });

  it("centers large graphs on attention and summarizes off-canvas nodes", () => {
    const current = snapshot();
    const run = current.runs[0]!;
    current.actors = [];
    current.state = [];
    current.events = [];
    run.phases = [{
      id: "fanout",
      name: "Fan out",
      status: "running",
      total: 80,
      startedAt: current.now - 80_000,
      updatedAt: current.now,
    }];
    run.currentPhaseId = "fanout";
    const base = current.agents[0]!;
    current.agents = Array.from({ length: 80 }, (_, index) => ({
      ...base,
      id: `flow-worker-${index}`,
      name: `flow-worker-${index}`,
      status: index === 56 ? "running" as const : "completed" as const,
      phaseId: "fanout",
      startedAt: current.now - 80_000 + index,
      ...(index === 56 ? {} : { finishedAt: current.now - 1_000 }),
    }));
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 24 } } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      dashboard.handleInput("2");
      const lines = dashboard.render(120);
      const graph = lines.join("\n");
      expect(graph).toContain("flow-worker-56");
      expect(graph).toMatch(/\d+ off-canvas/);
      expect(lines.length).toBeLessThanOrEqual(24);
      expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
    } finally {
      dashboard.dispose();
    }
  });

  it("keeps deeply nested selected agents readable in narrow topologies", () => {
    const current = snapshot();
    const run = current.runs[0]!;
    current.actors = [];
    current.state = [];
    current.events = [];
    run.phases = [{
      id: "deep",
      name: "Deep recursion",
      status: "running",
      startedAt: current.now - 30_000,
      updatedAt: current.now,
    }];
    run.currentPhaseId = "deep";
    const base = current.agents[0]!;
    current.agents = Array.from({ length: 20 }, (_, index) => ({
      ...base,
      id: `deep-node-${index}`,
      name: `deep-node-${index}`,
      status: index === 19 ? "running" as const : "completed" as const,
      phaseId: "deep",
      startedAt: current.now - 30_000 + index,
      ...(index > 0 ? { parentId: `deep-node-${index - 1}` } : {}),
    }));
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 24 } } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      dashboard.handleInput("2");
      const lines = dashboard.render(40);
      expect(lines.join("\n")).toContain("deep-node-19");
      expect(lines.join("\n")).toMatch(/\d+ off-canvas/);
      expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    } finally {
      dashboard.dispose();
    }
  });

  it("moves the topology camera with a damped spring", () => {
    vi.useFakeTimers();
    const current = snapshot();
    current.actors = [];
    current.state = [];
    current.events = [];
    const root = {
      ...current.agents[0]!,
      id: "thread-a",
      name: "thread-a",
      status: "completed",
    };
    const leaf = {
      ...current.agents[0]!,
      id: "thread-d",
      name: "thread-d",
      parentId: root.id,
      status: "running",
    };
    current.agents = [root, leaf];
    const requestRender = vi.fn();
    const dashboard = new FabricDashboard(
      { requestRender, terminal: { rows: 24 } } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      dashboard.handleInput("2");
      const initial = dashboard.render(80).join("\n");
      dashboard.handleInput("h");
      const springStart = dashboard.render(80).join("\n");
      expect(springStart).toContain("▣ thread-a");
      vi.advanceTimersByTime(160);
      const springMoved = dashboard.render(80).join("\n");
      expect(springMoved).not.toBe(springStart);
      expect(springMoved).not.toBe(initial);
      expect(requestRender).toHaveBeenCalled();

      dashboard.handleInput("1");
      const rendersAfterLeaving = requestRender.mock.calls.length;
      vi.advanceTimersByTime(500);
      expect(requestRender).toHaveBeenCalledTimes(rendersAfterLeaving);
    } finally {
      dashboard.dispose();
      vi.useRealTimers();
    }
  });

  it("inspects topics and routes without switching topology modes", () => {
    const current = snapshot();
    current.events.push(
      {
        id: "event-agent-route",
        sequence: 2,
        topic: "team.review",
        kind: "handoff",
        from: { id: "agent-1", name: "security-reviewer", kind: "agent" },
        text: "Review handoff",
        createdAt: current.now - 1_000,
      },
      {
        id: "event-actor-output",
        sequence: 3,
        topic: "fabric.actor.output",
        kind: "message",
        from: { id: "actor-coordinator", name: "topology-coordinator", kind: "actor" },
        text: "Recent mesh feed stays visible",
        createdAt: current.now,
      },
    );
    const dashboard = new FabricDashboard(
      { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI,
      theme,
      () => current,
      vi.fn(),
    );
    try {
      dashboard.handleInput("2");
      const lines = dashboard.render(140);
      const graph = lines.join("\n");
      expect(graph).toContain("Fabric · Topology");
      expect(graph).toContain("security-revi");
      expect(graph).toContain("advisor");
      expect(graph).toContain("team.review");
      expect(graph).toContain("Package A");
      expect(graph).toContain("Recent mesh feed stays visible");
      expect(lines.every((line) => visibleWidth(line) <= 140)).toBe(true);

      dashboard.handleInput("g");
      dashboard.handleInput("j");
      dashboard.handleInput("j");
      dashboard.handleInput("j");
      dashboard.handleInput("\r");
      const topicDetail = dashboard.render(140).join("\n");
      expect(topicDetail).toContain("topic · team.review");
      expect(topicDetail).toContain("Subscribers: advisor");

      dashboard.handleInput("\x1b");
      dashboard.handleInput("G");
      dashboard.handleInput("\r");
      const routeDetail = dashboard.render(140).join("\n");
      expect(routeDetail).toContain("recent project mesh route");
      expect(routeDetail).toContain("From: security-reviewer (agent:agent-1)");

      dashboard.handleInput("\x1b");
      dashboard.handleInput("1");
      expect(dashboard.render(140).join("\n")).toContain("· Activity");
      dashboard.handleInput("2");
      expect(dashboard.render(140).join("\n")).toContain("Fabric · Topology");
    } finally {
      dashboard.dispose();
    }
  });

});

describe("Fabric dashboard global actors and instructions editor", () => {
  const baseSnapshot = (): FabricDashboardSnapshot => {
    const now = Date.now();
    return {
      now,
      main: mainAgent(now, "idle"),
      peers: [],
      runs: [],
      agents: [],
      actors: [
        {
          id: "actor-1",
          scope: "project",
          name: "advisor",
          status: "idle",
          runner: "pi",
          events: [],
          topics: [],
          delivery: "mailbox",
          responseMode: "text",
          triggerTurn: false,
          coalesce: true,
          queued: 0,
          messages: 0,
          createdAt: now,
          updatedAt: now,
          instructions: "Advise only when useful.",
          recentMessages: [],
        },
      ],
      componentGraph: { components: [], edges: [], cycles: [] },
      globalActors: [
        {
          id: "g-actor-1",
          name: "global-reviewer",
          instructions: "You are a global reviewer template.",
          runner: "pi",
          events: ["turn_end"],
          topics: [],
          delivery: "mailbox",
          responseMode: "directive",
          triggerTurn: false,
          coalesce: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
      state: [],
      events: [],
    };
  };

  it("edits a global template delivery policy", () => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
    const onGlobalDeliveryPolicy = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, baseSnapshot, vi.fn(), {
      onGlobalDeliveryPolicy,
    });
    try {
      dashboard.handleInput("l");
      dashboard.handleInput("j");
      dashboard.handleInput("y");
      expect(dashboard.render(120).join("\n")).toContain("Mailbox only ✓");
      dashboard.handleInput("\x1b[B");
      dashboard.handleInput("\r");
      expect(onGlobalDeliveryPolicy).toHaveBeenCalledWith("g-actor-1", "steer", false);
    } finally {
      dashboard.dispose();
    }
  });

  it("edits global template host events with v", () => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
    const onGlobalEvents = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, baseSnapshot, vi.fn(), {
      onGlobalEvents,
    });
    try {
      dashboard.handleInput("l");
      dashboard.handleInput("j");
      expect(dashboard.render(120).join("\n")).toContain("v events");
      dashboard.handleInput("\r");
      expect(dashboard.render(120).join("\n")).toContain("v events");
      dashboard.handleInput("v");
      expect(dashboard.render(120).join("\n")).toContain("Host events for template");
      dashboard.handleInput(" ");
      dashboard.handleInput("\r");
      expect(onGlobalEvents).toHaveBeenCalledWith("g-actor-1", ["input", "turn_end"]);
    } finally {
      dashboard.dispose();
    }
  });

  it("lists global templates and offers import/instructions/delete in their detail", () => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
    const onImportActor = vi.fn();
    const onGlobalInstructions = vi.fn();
    const onRemoveGlobalActor = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, baseSnapshot, vi.fn(), {
      onGlobalInstructions,
      onImportActor,
      onRemoveGlobalActor,
    });
    try {
      const overview = dashboard.render(120).join("\n");
      expect(overview).toContain("global-reviewer");
      expect(overview).toContain("global template");

      // Move from the project actor to the global template and open its detail.
      dashboard.handleInput("l");
      dashboard.handleInput("j");
      dashboard.handleInput("p");
      dashboard.handleInput("d");
      expect(onImportActor).toHaveBeenCalledWith("g-actor-1");
      expect(onRemoveGlobalActor).toHaveBeenCalledWith("g-actor-1");
      onImportActor.mockClear();
      onRemoveGlobalActor.mockClear();
      dashboard.handleInput("\r");
      const detail = dashboard.render(120).join("\n");
      expect(detail).toContain("Instructions");
      expect(detail).toContain("i instructions");
      expect(detail).toContain("p import");
      expect(detail).toContain("d delete");

      dashboard.handleInput("p");
      expect(onImportActor).toHaveBeenCalledWith("g-actor-1");
      dashboard.handleInput("d");
      expect(onRemoveGlobalActor).toHaveBeenCalledWith("g-actor-1");
    } finally {
      dashboard.dispose();
    }
  });

  it("exports a project actor and edits its instructions in the embedded editor", () => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
    const onActorInstructions = vi.fn();
    const onExportActor = vi.fn();
    const dashboard = new FabricDashboard(tui, theme, baseSnapshot, vi.fn(), {
      onActorInstructions,
      onExportActor,
    });
    try {
      // Open the first entity, the project actor.
      dashboard.handleInput("l");
      dashboard.handleInput("x");
      expect(onExportActor).toHaveBeenCalledWith("actor-1");
      onExportActor.mockClear();
      dashboard.handleInput("\r");
      const detail = dashboard.render(120).join("\n");
      expect(detail).toContain("x export→global");
      expect(detail).toContain("i instructions");

      dashboard.handleInput("x");
      expect(onExportActor).toHaveBeenCalledWith("actor-1");

      // open the embedded instructions editor
      dashboard.handleInput("i");
      const editor = dashboard.render(120).join("\n");
      expect(editor).toContain("instructions · advisor");
      expect(editor).toContain("enter submit");

      // Enter submits the (unchanged) text to the actor callback and returns to detail
      dashboard.handleInput("\r");
      expect(onActorInstructions).toHaveBeenCalledWith("actor-1", "Advise only when useful.");
      const after = dashboard.render(120).join("\n");
      expect(after).toContain("advisor");
    } finally {
      dashboard.dispose();
    }
  });
});
