import { createHash } from "node:crypto";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CodePreviewSettings } from "../src/ui/code-preview.js";
import { Box, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { configureHighlighting, initHighlighting } from "../src/ui/highlight.js";
import {
  HiddenRowBorrowingComponent,
  observeResultRows,
  resultRowDeficit,
  type ResultRowBalance,
} from "../src/ui/row-balance.js";
import {
  captureFabricAgentPreviews,
  captureFabricCallHeadlinePreviews,
  captureFabricCoreToolPreviews,
  captureFabricWritePreviews,
  compactProgressPreview,
  expandHint,
  fabricWriteBindings,
  inheritComponentBackground,
  inheritEnclosingBackground,
  modelReadHint,
  nestedCallBody,
  nestedCallCode,
  nestedCallTitle,
  nestedEditDiff,
  renderBoundedLines,
  renderFabricMulticallPartial,
  renderFabricWriteArgumentPreview,
  restoreFabricAgentPreviews,
  restoreFabricCallHeadlinePreviews,
  restoreFabricCoreToolPreviews,
  restoreFabricWritePreviews,
  restoreLegacyBashCommands,
  singleCallProgressLine,
} from "../src/ui/fabric-render.js";

const theme = {
  fg: (color: string, text: string) => `\x1b[${color}]${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as unknown as Theme;

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

describe("TUI width bounds (#84)", () => {
  const adversarialLines = [
    "x".repeat(300),
    "\t\t\tdeeply\ttabbed\toutput\t" + "y".repeat(200),
    "\x1b[31mred\x1b[0m".repeat(30),
    "🎉".repeat(120),
    "中文".repeat(120),
    "🏳️‍🌈".repeat(60),
    "①②③ﬁ".repeat(80),
    "a̐éö̲".repeat(150),
  ];

  const expectBounded = (rows: string[], width: number) => {
    for (const row of rows) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    }
  };

  it("bounds wrapped and truncated bounded-line rows at narrow widths", () => {
    for (const width of [50, 51, 20, 11, 3, 1]) {
      const wrapIndexes = new Set(adversarialLines.map((_line, index) => index));
      const wrapped = renderBoundedLines(adversarialLines, plainTheme, "off", wrapIndexes);
      expectBounded(wrapped.render(width), width);
      const unwrapped = renderBoundedLines(adversarialLines, plainTheme, "off");
      expectBounded(unwrapped.render(width), width);
    }
  });

  it("bounds row-borrowing previews even when the inner renderer overflows", () => {
    const overproducing = (limit: number, width: number): string[] => [
      `${"overflow".repeat(Math.max(4, limit))} ${width}`,
    ];
    const balance: ResultRowBalance = {};
    const component = new HiddenRowBorrowingComponent(1, 3, overproducing, balance);
    for (const width of [50, 11, 3, 1]) {
      expectBounded(component.render(width), width);
    }
  });
});

describe("fabric nested rendering", () => {
  it("filters internal successes before multicall counts without shifting preview attachment", () => {
    const audits = [
      { ref: "native.load", success: true },
      { ref: "tasks.wait", args: { id: "task-123" }, success: true },
      { ref: "sessions.status", args: { id: "session-123" } },
    ];
    for (const expanded of [false, true]) {
      const text = renderFabricMulticallPartial({ audits, expanded, phases: [],
        omittedCalls: { count: 2, done: 2, internal: 2 }, preview: { auditIndex: 1, body: "receipt body", hidden: 0 },
      }, plainTheme).render(120).join("\n");
      expect(text).toContain("1/2 calls");
      expect(text).not.toContain("native.load");
      expect(text).toContain("tasks.wait task-123");
      expect(text).toContain("receipt body");
      expect(text).toContain("sessions.status session-123");
      expect(audits).toHaveLength(3);
    }
  });
  it("renders the whole expand hint dim", () => {
    expect(expandHint(theme)).toMatch(/^\x1b\[dim\].+ to expand\x1b\[0m$/);
    expect(expandHint(theme)).not.toContain("\x1b[muted]");
  });

  it("removes nested backgrounds while preserving foreground styling", () => {
    const styled = [
      "\x1b[38;2;9;8;7;48;2;1;2;3mtruecolor",
      "\x1b[44mstandard",
      "\x1b[48;5;22mindexed",
      "\x1b[48:2::4:5:6mcolon",
      "\x1b[7mreverse",
      "\x1b[0mreset",
    ].join(" ");

    const inherited = inheritEnclosingBackground(styled);

    expect(inherited).toContain("\x1b[38;2;9;8;7mtruecolor");
    expect(inherited).not.toMatch(/\x1b\[(?:4[0-9]|10[0-7]|48[:;]|7m|0m)/);
    expect(inherited).toContain("\x1b[22;23;24;25;27;28;29;39;54;55mreset");
  });

  it("normalizes backgrounds introduced during component rendering", () => {
    const component = renderBoundedLines(["\x1b[48;2;1;2;3moutput\x1b[49m"]);

    expect(inheritComponentBackground(component).render(20)).toEqual(["output"]);
  });

  it("renders a bash title with a $ prompt and a highlighted command", async () => {
    await initHighlighting("dark-plus", true);
    const title = nestedCallTitle(
      { ref: "pi.bash", tool: "bash", args: { command: "ls -la src/" } },
      theme,
    );
    expect(title).toContain("$");
    expect(title).toContain("src/");
    // shiki truecolor escapes wrap the command tokens
    expect(title).toContain("\x1b[38;2;");
  }, 15_000);

  it("restores legacy digest-only bash previews from visible Fabric arguments", () => {
    const literalCommand = "pnpm vitest run tests/fabric-render.test.ts";
    const namedCommand = "git status --short";
    const digest = (command: string): string =>
      `sha256:${createHash("sha256").update(command).digest("hex")}`;
    const restored = restoreLegacyBashCommands(
      [literalCommand, namedCommand].map((command) => ({
        ref: "pi.bash",
        provider: "pi",
        tool: "bash",
        args: { commandDigest: digest(command) },
      })),
      {
        code: `await pi.bash({ cmd: "${literalCommand}" });\nawait pi.bash({ cmd: π.script });`,
        strings: { script: namedCommand },
      },
    );

    expect(restored.map((audit) => audit.args)).toEqual([
      { command: literalCommand },
      { command: namedCommand },
    ]);
  });

  it("never renders an unrecoverable legacy command digest", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const [restored] = restoreLegacyBashCommands(
      [{ ref: "pi.bash", provider: "pi", tool: "bash", args: { commandDigest: digest } }],
      { code: "return true;" },
    );

    expect(restored?.args).toEqual({});
    const title = nestedCallTitle(restored!, plainTheme);
    expect(title).toBe("bash");
    expect(title).not.toContain("sha256:");
  });

  it("extracts π write bindings in source order", () => {
    const bindings = fabricWriteBindings(`
return Promise.all([
  pi.write({ path: "README.md", text: π.readme }),
  pi.write({ file: "docs/configuration.md", contents: π.configuration }),
  pi.write({ file_path: "docs/interface.md", content: π["interface"] }),
]);
`);

    expect(bindings).toEqual([
      { path: "README.md", stringKey: "readme" },
      { path: "docs/configuration.md", stringKey: "configuration" },
      { path: "docs/interface.md", stringKey: "interface" },
    ]);
  });

  it("extracts escaped and quoted write bindings without matching comments", () => {
    const bindings = fabricWriteBindings(`
// pi.write({ path: "ignored.md", text: π.ignored })
pi.write({ "path": "docs/quoted\\nname.md", "content": π["quoted"] });
pi.write({ path: "nested.md", metadata: { content: π.wrong }, text: π.right });
`);

    expect(bindings).toEqual([
      { path: "docs/quoted\nname.md", stringKey: "quoted" },
      { path: "nested.md", stringKey: "right" },
    ]);
  });

  it("renders a growing single π value during argument composition", () => {
    const streaming = renderFabricWriteArgumentPreview(
      {
        bindings: [{ path: "preview.unknown", stringKey: "preview" }],
        strings: { preview: "first line\nsecond line" },
        expanded: false,
      },
      plainTheme,
    )!.render(100);

    expect(streaming).toContain("first line");
    expect(streaming).toContain("second line");
  });

  it("streams only the latest π value in a multicall", () => {
    const composing = renderFabricWriteArgumentPreview(
      {
        bindings: [
          { path: "one.unknown", stringKey: "one" },
          { path: "two.unknown", stringKey: "two" },
          { path: "three.unknown", stringKey: "three" },
        ],
        strings: { one: "one complete", two: "two growing" },
        expanded: false,
        spinner: "◓",
      },
      plainTheme,
    )!.render(100);

    expect(composing[0]).toContain("Fabric composing · 1/3 writes");
    expect(composing.some((line) => line.startsWith("◓ write two.unknown"))).toBe(true);
    expect(composing).toContain("  two growing");
    expect(composing).not.toContain("one complete");
  });

  it("exposes in-flight write content for single-call previews", () => {
    const audit = {
      ref: "pi.write",
      provider: "pi",
      tool: "write",
      args: { path: "README.md", content: "# Fabric\n\nLive preview" },
    };

    expect(nestedCallBody(audit)).toBe("# Fabric\n\nLive preview");
    expect(nestedCallCode(audit)).toEqual({
      code: "# Fabric\n\nLive preview",
      lang: "markdown",
    });
  });

  it("upgrades a streaming write from plain text after lazy Shiki initialization", async () => {
    configureHighlighting("dark-plus", false);
    configureHighlighting("dark-plus", true);
    const invalidate = vi.fn();
    const input = {
      bindings: [{ path: "src/lazy-stream.ts", stringKey: "preview" }],
      strings: { preview: "export const lazyStream = true;" },
      expanded: false,
      cwd: process.cwd(),
      settings: {
        shikiTheme: "dark-plus",
        syntaxHighlighting: true,
        writeContentPreview: true,
        writeCollapsedLines: 10,
        tools: ["write"],
      } as CodePreviewSettings,
    };
    const render = (): string =>
      renderFabricWriteArgumentPreview(input, plainTheme, invalidate)!.render(100).join("\n");

    expect(render()).not.toContain("\x1b[38;2;");
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled(), { timeout: 15_000 });
    expect(render()).toContain("\x1b[38;2;");
  }, 20_000);

  it("falls back to plain in-flight write content for unknown file types", () => {
    const audit = {
      ref: "pi.write",
      provider: "pi",
      tool: "write",
      args: { path: "fixture.unknown", content: "first\nsecond" },
    };

    expect(nestedCallCode(audit)).toBeNull();
    expect(nestedCallBody(audit)).toBe("first\nsecond");
  });

  it("restores rich core arguments, results, and renderer metadata after final projection", () => {
    const live = [
      {
        ref: "pi.grep",
        provider: "pi",
        tool: "grep",
        args: { path: "src", pattern: "needle", literal: true },
        result: "src/a.ts:1: needle",
        preview: { details: { truncation: { truncated: false } } },
        success: true,
      },
      {
        ref: "pi.edit",
        provider: "pi",
        tool: "edit",
        args: { path: "src/a.ts", edits: [{ oldText: "old", newText: "new" }] },
        result: { ok: true, output: "edited", details: { diff: "-1 old\n+1 new" } },
        success: true,
      },
    ];
    const previews = captureFabricCoreToolPreviews(live);
    const restored = restoreFabricCoreToolPreviews(
      [
        { ref: "pi.grep", provider: "pi", tool: "grep", args: { path: "src" }, success: true },
        { ref: "pi.edit", provider: "pi", tool: "edit", args: { path: "src/a.ts" }, success: true },
      ],
      previews,
    );

    expect(restored[0]?.args).toMatchObject({ pattern: "needle", literal: true });
    expect(restored[0]?.result).toBe("src/a.ts:1: needle");
    expect(restored[0]?.preview).toEqual({ details: { truncation: { truncated: false } } });
    expect(restored[1]?.args?.edits).toEqual([{ oldText: "old", newText: "new" }]);
    expect(restored[1]?.result).toMatchObject({ details: { diff: "-1 old\n+1 new" } });
  });

  it("restores ephemeral write content after final trace projection", () => {
    const live = [
      {
        ref: "pi.write",
        provider: "pi",
        tool: "write",
        args: { path: "README.md", content: "# Cached preview" },
        success: true,
      },
    ];
    const previews = captureFabricWritePreviews(live);
    const restored = restoreFabricWritePreviews(
      [
        {
          ref: "pi.write",
          provider: "pi",
          tool: "write",
          args: { path: "README.md" },
          success: true,
        },
      ],
      previews,
    );

    expect(nestedCallBody(restored[0]!)).toBe("# Cached preview");
  });

  it("keeps a waiting agent's running tool inline ahead of stale narrative", () => {
    const lines = renderFabricMulticallPartial(
      {
        audits: [
          {
            ref: "agents.wait",
            provider: "agents",
            tool: "wait",
            args: { id: "agent-child-12345678" },
            preview: {
              kind: "fabric-agent-tools",
              id: "agent-child-12345678",
              name: "researcher",
              status: "running",
              runner: "pi",
              owner: "agent",
              text: "I previously inspected the repository.",
              tools: [
                {
                  id: "child-read",
                  kind: "tool",
                  label: "read",
                  toolName: "read",
                  status: "running",
                  args: { path: "src/current.ts" },
                },
              ],
            },
          },
        ],
        phases: [],
        expanded: false,
        showAgentToolPreview: true,
        spinner: "◑",
      },
      plainTheme,
    ).render(120);

    expect(lines).toContain("◆ Fabric running · 0/1 calls");
    expect(lines).toContain("◑ wait researcher › read src/current.ts");
    expect(lines.join("\n")).not.toContain("previously inspected");
  });

  it("restores friendly agent previews after ephemeral live details disappear", () => {
    const live = [
      {
        ref: "agents.wait",
        provider: "agents",
        tool: "wait",
        args: { id: "agent-child-12345678" },
        preview: {
          kind: "fabric-agent-tools",
          id: "agent-child-12345678",
          name: "researcher",
          status: "completed",
          owner: "agent",
          text: "Review complete.",
          tools: [],
        },
      },
    ];
    const previews = captureFabricAgentPreviews(live);
    const restored = restoreFabricAgentPreviews(
      [{ ref: "agents.wait", provider: "agents", tool: "wait", args: { id: "agent-child-12345678" }, success: true }],
      previews,
    );

    expect(nestedCallTitle(restored[0]!, plainTheme)).toBe("wait researcher");
    expect(restored[0]?.preview).toEqual(live[0]?.preview);
  });

  it("keeps later active calls visible when a collapsed multicall exceeds its limit", () => {
    const audits = Array.from({ length: 10 }, (_, index) => ({
      ref: "agents.wait",
      provider: "agents",
      tool: "wait",
      args: { id: `agent-${index}` },
      ...(index === 9 ? {} : { success: true }),
      ...(index === 9
        ? {
            preview: {
              kind: "fabric-agent-tools" as const,
              id: "agent-9",
              name: "active-agent",
              status: "running",
              owner: "agent" as const,
              tools: [],
            },
          }
        : {}),
    }));
    const lines = renderFabricMulticallPartial(
      { audits, phases: [], expanded: false },
      plainTheme,
    ).render(120).join("\n");

    expect(lines).toContain("wait active-agent");
    expect(lines).toContain("… 2 nested calls hidden");
  });

  it("clips collapsed multicall narrative inline and reveals it when expanded", () => {
    const narrative = "A long agent update that must remain visible across narrow terminal rows without losing its ending.";
    const audits = [{
      ref: "agents.wait",
      provider: "agents",
      tool: "wait",
      args: { id: "agent-child" },
      preview: {
        kind: "fabric-agent-tools" as const,
        id: "agent-child",
        name: "researcher",
        status: "running",
        owner: "agent" as const,
        text: narrative,
        tools: [],
      },
    }];
    const collapsed = renderFabricMulticallPartial(
      { audits, phases: [], expanded: false },
      plainTheme,
    ).render(40);
    const expanded = renderFabricMulticallPartial(
      { audits, phases: [], expanded: true },
      plainTheme,
    ).render(40);

    expect(collapsed).toHaveLength(2);
    expect(collapsed.every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(collapsed.join(" ")).not.toContain("without losing its ending.");
    expect(expanded.length).toBeGreaterThan(2);
    expect(expanded.join(" ").replace(/\s+/g, " ")).toContain("without losing its ending.");
  });

  it("renders child-agent tool activity as one line beneath its parent call", () => {
    const settings = {
      tools: ["edit"],
      editDiffPreview: true,
      editCollapsedLines: 160,
      syntaxHighlighting: false,
      secretWarnings: true,
      diffIntensity: "subtle",
      wordEmphasis: "all",
      toolCallBackground: "off",
    } as CodePreviewSettings;
    const lines = renderFabricMulticallPartial(
      {
        audits: [
          {
            ref: "agents.run",
            provider: "agents",
            tool: "run",
            args: { task: "implement" },
            preview: {
              kind: "fabric-agent-tools",
              id: "agent-child-123",
              name: "implementor",
              status: "running",
              runner: "pi",
              owner: "agent",
              tools: [
                {
                  id: "child-edit",
                  kind: "tool",
                  label: "edit",
                  toolName: "edit",
                  status: "running",
                  args: {
                    path: "src/child.ts",
                    edits: [{ oldText: "const before = 1;", newText: "const after = 2;" }],
                  },
                },
              ],
            },
          },
        ],
        phases: [],
        expanded: false,
        showAgentToolPreview: true,
        core: { cwd: process.cwd(), settings },
      },
      plainTheme,
    ).render(120).join("\n");

    const visible = lines.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    expect(visible).toContain("run implement › edit src/child.ts");
    expect(visible).not.toContain("[agent");
    expect(visible).not.toContain("const before = 1;");
    expect(visible).not.toContain("const after = 2;");
  });

  it("renders recursive descendant agent trees when expanded", () => {
    const tool = (
      id: string,
      toolName: string,
      status: string,
      args: Record<string, unknown>,
    ) => ({ id, kind: "tool" as const, label: toolName, toolName, status: status as "running" | "completed" | "failed", args });
    const lines = renderFabricMulticallPartial(
      {
        audits: [
          {
            ref: "agents.run",
            provider: "agents",
            tool: "run",
            args: { name: "orchestrator" },
            preview: {
              kind: "fabric-agent-tools" as const,
              id: "agent-parent",
              name: "orchestrator",
              status: "running",
              runner: "pi" as const,
              owner: "agent" as const,
              tools: [tool("parent-read", "read", "running", { path: "src/parent.ts" })],
              agents: [
                {
                  id: "agent-child",
                  name: "planner",
                  status: "running",
                  owner: "agent" as const,
                  currentTool: "fabric_exec",
                  tools: [tool("child-grep", "grep", "completed", { pattern: "nested", path: "src" })],
                  agents: [
                    {
                      id: "agent-grandchild",
                      name: "researcher",
                      status: "running",
                      owner: "agent" as const,
                      tools: [
                        tool("grandchild-edit", "edit", "running", {
                          path: "src/deep.ts",
                          edits: [{ oldText: "a", newText: "b" }],
                        }),
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
        phases: [],
        expanded: true,
        showAgentToolPreview: true,
      },
      plainTheme,
    ).render(120).join("\n");

    expect(lines).toContain("read src/parent.ts");
    expect(lines).toContain("◐ planner · running · fabric_exec");
    expect(lines).toContain("grep src");
    expect(lines).toContain("◐ researcher · running");
    expect(lines).toContain("edit src/deep.ts");
    const rows = lines.split("\n");
    const plannerRow = rows.find((line) => line.includes("planner"))!;
    const researcherRow = rows.find((line) => line.includes("researcher"))!;
    expect(researcherRow.indexOf("◐")).toBeGreaterThan(plannerRow.indexOf("◐"));
  });

  it("shows a collapsed descendant breadcrumb that prefers the running branch", () => {
    const lines = renderFabricMulticallPartial(
      {
        audits: [
          {
            ref: "agents.run",
            provider: "agents",
            tool: "run",
            args: { name: "orchestrator" },
            preview: {
              kind: "fabric-agent-tools" as const,
              id: "agent-parent",
              name: "orchestrator",
              status: "running",
              owner: "agent" as const,
              tools: [],
              agents: [
                { id: "agent-done", name: "planner", status: "completed", tools: [] },
                {
                  id: "agent-live",
                  name: "researcher",
                  status: "running",
                  tools: [],
                  agents: [
                    {
                      id: "agent-deep",
                      name: "digger",
                      status: "running",
                      tools: [
                        {
                          id: "deep-read",
                          kind: "tool" as const,
                          label: "read",
                          toolName: "read",
                          status: "running" as const,
                          args: { path: "src/deep.ts" },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
        phases: [],
        expanded: false,
        showAgentToolPreview: true,
        spinner: "◑",
      },
      plainTheme,
    ).render(120);

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("run orchestrator");
    expect(lines[1]).toContain("researcher › digger › read src/deep.ts");
    expect(lines.join("\n")).not.toContain("planner");
  });

  it("falls back to the latest known tool in the crumb between executions", () => {
    const lines = renderFabricMulticallPartial(
      {
        audits: [
          {
            ref: "agents.run",
            provider: "agents",
            tool: "run",
            args: { name: "orchestrator" },
            preview: {
              kind: "fabric-agent-tools" as const,
              id: "agent-parent",
              name: "orchestrator",
              status: "running",
              owner: "agent" as const,
              tools: [],
              agents: [
                {
                  id: "agent-live",
                  name: "researcher",
                  status: "running",
                  tools: [
                    {
                      id: "leaf-grep",
                      kind: "tool" as const,
                      label: "grep",
                      toolName: "grep",
                      status: "completed" as const,
                      args: { pattern: "maxDepth", path: "src" },
                    },
                  ],
                },
              ],
            },
          },
        ],
        phases: [],
        expanded: false,
        showAgentToolPreview: true,
        spinner: "◑",
      },
      plainTheme,
    ).render(120);

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("researcher › grep src");
  });

  it("prefers the live descendant breadcrumb over the parent's own tool when collapsed", () => {
    const lines = renderFabricMulticallPartial(
      {
        audits: [
          {
            ref: "agents.run",
            provider: "agents",
            tool: "run",
            args: { name: "orchestrator" },
            preview: {
              kind: "fabric-agent-tools" as const,
              id: "agent-parent",
              name: "orchestrator",
              status: "running",
              owner: "agent" as const,
              text: "Waiting on the helper chain.",
              tools: [
                {
                  id: "parent-read",
                  kind: "tool" as const,
                  label: "read",
                  toolName: "read",
                  status: "running" as const,
                  args: { path: "src/parent.ts" },
                },
              ],
              agents: [
                {
                  id: "agent-live",
                  name: "researcher",
                  status: "running",
                  tools: [],
                  agents: [
                    {
                      id: "agent-deep",
                      name: "digger",
                      status: "running",
                      tools: [
                        {
                          id: "deep-read",
                          kind: "tool" as const,
                          label: "read",
                          toolName: "read",
                          status: "running" as const,
                          args: { path: "src/deep.ts" },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
        phases: [],
        expanded: false,
        showAgentToolPreview: true,
        spinner: "◑",
      },
      plainTheme,
    ).render(120);

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("researcher › digger › read src/deep.ts");
    expect(lines[1]).not.toContain("src/parent.ts");
    expect(lines[1]).not.toContain("Waiting on the helper chain.");
  });

  it("keeps the completed descendant breadcrumb as the final collapsed summary", () => {
    const lines = renderFabricMulticallPartial(
      {
        audits: [
          {
            ref: "agents.run",
            provider: "agents",
            tool: "run",
            args: { name: "orchestrator" },
            preview: {
              kind: "fabric-agent-tools" as const,
              id: "agent-parent",
              name: "orchestrator",
              status: "completed",
              owner: "agent" as const,
              tools: [],
              agents: [{ id: "agent-child", name: "planner", status: "completed", tools: [] }],
            },
          },
        ],
        phases: [],
        expanded: false,
        showAgentToolPreview: true,
        spinner: "◑",
      },
      plainTheme,
    ).render(120);

    expect(lines[1]).toContain("run orchestrator › planner");
    expect(lines[1]).not.toContain("› ›");
  });

  it("marks descendant previews cut by the tree budget", () => {
    const lines = renderFabricMulticallPartial(
      {
        audits: [
          {
            ref: "agents.run",
            provider: "agents",
            tool: "run",
            args: { name: "orchestrator" },
            preview: {
              kind: "fabric-agent-tools" as const,
              id: "agent-parent",
              name: "orchestrator",
              status: "running",
              owner: "agent" as const,
              tools: [],
              agents: [{ id: "agent-child", name: "planner", status: "running", tools: [] }],
              agentsTruncated: true,
            },
          },
        ],
        phases: [],
        expanded: true,
        showAgentToolPreview: true,
      },
      plainTheme,
    ).render(120).join("\n");

    expect(lines).toContain("planner");
    expect(lines).toContain("… deeper agent previews hidden");
  });

  it("stops expanding descendants at the render depth cap", () => {
    const deep = (level: number): Record<string, unknown> => ({
      id: `agent-lvl${level}`,
      name: `lvl${level}`,
      status: "running",
      tools: [],
      ...(level < 8 ? { agents: [deep(level + 1)] } : {}),
    });
    const lines = renderFabricMulticallPartial(
      {
        audits: [
          {
            ref: "agents.run",
            provider: "agents",
            tool: "run",
            args: { name: "root" },
            preview: {
              kind: "fabric-agent-tools" as const,
              id: "agent-root",
              name: "root",
              status: "running",
              owner: "agent" as const,
              tools: [],
              agents: [deep(1)],
            },
          },
        ],
        phases: [],
        expanded: true,
        showAgentToolPreview: true,
      },
      plainTheme,
    ).render(120).join("\n");

    expect(lines).toContain("lvl5");
    expect(lines).not.toContain("lvl7");
    expect(lines).toContain("… deeper agent previews hidden");
  });

  it("rejects preview trees deeper than the guard allows", () => {
    const deep = (level: number): Record<string, unknown> => ({
      id: `agent-lvl${level}`,
      name: `lvl${level}`,
      status: "running",
      tools: [],
      ...(level < 12 ? { agents: [deep(level + 1)] } : {}),
    });
    const lines = renderFabricMulticallPartial(
      {
        audits: [
          {
            ref: "agents.run",
            provider: "agents",
            tool: "run",
            args: { name: "root" },
            preview: {
              kind: "fabric-agent-tools" as const,
              id: "agent-root",
              name: "root",
              status: "running",
              owner: "agent" as const,
              tools: [],
              agents: [deep(1)],
            },
          },
        ],
        phases: [],
        expanded: true,
        showAgentToolPreview: true,
      },
      plainTheme,
    ).render(120).join("\n");

    expect(lines).not.toContain("lvl");
  });

  it("hides descendant trees when the agent tool preview is disabled", () => {
    const lines = renderFabricMulticallPartial(
      {
        audits: [
          {
            ref: "agents.run",
            provider: "agents",
            tool: "run",
            args: { name: "orchestrator" },
            preview: {
              kind: "fabric-agent-tools" as const,
              id: "agent-parent",
              name: "orchestrator",
              status: "running",
              owner: "agent" as const,
              tools: [],
              agents: [{ id: "agent-child", name: "planner", status: "running", tools: [] }],
            },
          },
        ],
        phases: [],
        expanded: true,
        showAgentToolPreview: false,
      },
      plainTheme,
    ).render(120).join("\n");

    expect(lines).not.toContain("planner");
  });

  it("keeps collapsed multicall narrative on one inline row when tools are hidden", () => {
    const lines = renderFabricMulticallPartial(
      {
        audits: [
          {
            ref: "agents.run",
            provider: "agents",
            tool: "run",
            args: { task: "implement" },
            preview: {
              kind: "fabric-agent-tools",
              id: "agent-child-123",
              name: "implementor",
              status: "running",
              runner: "pi",
              owner: "agent",
              text: "Inspecting the routing configuration now.\nThe response stays expanded.",
              tools: [
                {
                  id: "child-read",
                  kind: "tool",
                  label: "read",
                  toolName: "read",
                  status: "running",
                  args: { path: "src/private.ts" },
                },
              ],
            },
          },
        ],
        phases: [],
        expanded: false,
        showAgentToolPreview: false,
      },
      plainTheme,
    ).render(120).join("\n");

    const visible = lines.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    expect(visible).toContain(
      "run implement › Inspecting the routing configuration now. The response stays expanded.",
    );
    expect(visible.split("\n")).toHaveLength(2);
    expect(visible).not.toContain("[agent");
    expect(visible).not.toContain("src/private.ts");
  });

  it("renders parallel agent updates on their parent rows", () => {
    const lines = renderFabricMulticallPartial(
      {
        audits: [
          {
            ref: "agents.run",
            provider: "agents",
            tool: "run",
            args: { name: "reader" },
            preview: {
              kind: "fabric-agent-tools",
              id: "agent-reader",
              name: "reader",
              status: "running",
              runner: "pi",
              owner: "agent",
              text: "Reviewing the routing configuration.",
              tools: [],
            },
          },
          {
            ref: "agents.run",
            provider: "agents",
            tool: "run",
            args: { name: "searcher" },
            preview: {
              kind: "fabric-agent-tools",
              id: "agent-searcher",
              name: "searcher",
              status: "running",
              runner: "pi",
              owner: "agent",
              text: "I will inspect the tests.",
              tools: [
                {
                  id: "child-grep",
                  kind: "tool",
                  label: "grep",
                  toolName: "grep",
                  status: "running",
                  args: { pattern: "rolling", path: "tests" },
                },
              ],
            },
          },
        ],
        phases: [],
        expanded: false,
        showAgentToolPreview: true,
      },
      plainTheme,
    ).render(160).map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));

    expect(lines).toContain("◐ run reader › Reviewing the routing configuration.");
    const searcherLine = lines.find((line) => line.includes("run searcher"));
    expect(searcherLine).toContain("grep tests");
    expect(lines.join("\n")).not.toContain("I will inspect the tests.");
    expect(lines.join("\n")).not.toContain("[agent");
  });

  it("keeps assistant responses expanded and agent tools one-line", () => {
    const lines = renderFabricMulticallPartial(
      {
        audits: [
          {
            ref: "agents.run",
            provider: "agents",
            tool: "run",
            args: { task: "implement" },
            preview: {
              kind: "fabric-agent-tools",
              id: "agent-child-123",
              name: "implementor",
              status: "running",
              runner: "pi",
              owner: "agent",
              text: Array.from({ length: 10 }, (_, index) => `narrative ${index + 1}`).join("\n"),
              tools: Array.from({ length: 8 }, (_, index) => ({
                id: `child-read-${index}`,
                kind: "tool" as const,
                label: "read",
                toolName: "read",
                status: "completed" as const,
                args: { path: `src/file-${index}.ts` },
              })),
            },
          },
        ],
        phases: [],
        expanded: true,
        showAgentToolPreview: true,
      },
      plainTheme,
    ).render(160).map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
    const visible = lines.join("\n");

    expect(lines[1]).toContain("run implement › narrative 1");
    expect(visible).toContain("narrative 10");
    expect(visible).toContain("read src/file-0.ts");
    expect(visible).toContain("read src/file-7.ts");
    expect(visible).not.toContain("earlier narrative lines");
    expect(visible).not.toContain("earlier tool calls");
  });

  it("expands recent agent tool bodies only with the transcript keybinding", () => {
    const settings = {
      tools: ["edit"],
      editDiffPreview: true,
      editCollapsedLines: 160,
      syntaxHighlighting: false,
      secretWarnings: true,
      diffIntensity: "subtle",
      wordEmphasis: "all",
      toolCallBackground: "off",
    } as CodePreviewSettings;
    const lines = renderFabricMulticallPartial(
      {
        audits: [
          {
            ref: "agents.run",
            provider: "agents",
            tool: "run",
            args: { name: "implementor" },
            preview: {
              kind: "fabric-agent-tools",
              id: "agent-child-123",
              name: "implementor",
              status: "running",
              runner: "pi",
              owner: "agent",
              tools: [
                {
                  id: "child-edit",
                  kind: "tool",
                  label: "edit",
                  toolName: "edit",
                  status: "completed",
                  args: {
                    path: "src/child.ts",
                    edits: [{ oldText: "const before = 1;", newText: "const after = 2;" }],
                  },
                },
              ],
            },
          },
        ],
        phases: [],
        expanded: true,
        showAgentToolPreview: true,
        core: { cwd: process.cwd(), settings },
      },
      plainTheme,
    ).render(120).join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

    expect(lines).toContain("run implementor › edit src/child.ts");
    expect(lines).toContain("const before = 1;");
    expect(lines).toContain("const after = 2;");
  });

  it("renders transcript content blocks for the two most recent expanded agent tools", async () => {
    await initHighlighting("dark-plus", true);
    const settings = {
      tools: ["read", "grep"],
      readContentPreview: true,
      readLineNumbers: true,
      grepResultPreview: true,
      syntaxHighlighting: true,
      secretWarnings: true,
      diffIntensity: "subtle",
      wordEmphasis: "all",
      toolCallBackground: "off",
    } as CodePreviewSettings;
    const nestedSuccessBackground = "\x1b[48;2;1;2;3m";
    const nestedTheme = {
      ...plainTheme,
      getBgAnsi: () => nestedSuccessBackground,
    } as unknown as Theme;
    const raw = renderFabricMulticallPartial(
      {
        audits: [{
          ref: "agents.run",
          provider: "agents",
          tool: "run",
          args: { name: "reader" },
          preview: {
            kind: "fabric-agent-tools",
            id: "agent-reader",
            name: "reader",
            status: "completed",
            owner: "agent",
            text: "Inspection complete.",
            tools: [
              {
                id: "child-read",
                kind: "tool",
                label: "read",
                toolName: "read",
                status: "completed",
                args: { path: "src/expanded.ts" },
                result: {
                  content: [{ type: "text", text: "export const expandedBody = true;" }],
                  details: {},
                },
              },
              {
                id: "child-grep",
                kind: "tool",
                label: "grep",
                toolName: "grep",
                status: "completed",
                args: { pattern: "expandedBody", path: "src", literal: true },
                result: {
                  content: [{
                    type: "text",
                    text: "src/expanded.ts:1: export const expandedBody = true;",
                  }],
                  details: {},
                },
              },
            ],
          },
        }],
        phases: [],
        expanded: true,
        showAgentToolPreview: true,
        core: { cwd: process.cwd(), settings },
      },
      nestedTheme,
    ).render(140).join("\n");
    const lines = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

    expect(raw).toContain("\x1b[38;2;");
    expect(raw).not.toContain(nestedSuccessBackground);
    expect(lines).toContain("read src/expanded.ts");
    expect(lines).toContain("grep /expandedBody/ in src");
    expect(lines).toContain("export const expandedBody = true;");
    expect(lines).not.toContain("No matches found");
  });

  it("preserves diff-specific backgrounds when nested tool backgrounds are disabled", () => {
    const successBackground = "\x1b[48;2;10;10;10m";
    const errorBackground = "\x1b[48;2;20;10;10m";
    const diffTheme = {
      ...plainTheme,
      getFgAnsi: (color: string) => color === "toolDiffAdded"
        ? "\x1b[38;2;80;200;120m"
        : "\x1b[38;2;220;90;100m",
      getBgAnsi: (color: string) => color === "toolErrorBg"
        ? errorBackground
        : successBackground,
    } as unknown as Theme;
    const settings = {
      tools: ["edit"],
      editDiffPreview: true,
      editCollapsedLines: 160,
      syntaxHighlighting: false,
      secretWarnings: true,
      diffIntensity: "subtle",
      wordEmphasis: "all",
      toolCallBackground: "on",
    } as CodePreviewSettings;
    const raw = renderFabricMulticallPartial(
      {
        audits: [{
          ref: "agents.run",
          provider: "agents",
          tool: "run",
          args: { name: "editor" },
          preview: {
            kind: "fabric-agent-tools",
            id: "agent-editor",
            name: "editor",
            status: "completed",
            owner: "agent",
            tools: [{
              id: "child-edit",
              kind: "tool",
              label: "edit",
              toolName: "edit",
              status: "completed",
              args: {
                path: "src/example.ts",
                edits: [{
                  oldText: "const before = 1;",
                  newText: "const after = 2;",
                }],
              },
            }],
          },
        }],
        phases: [],
        expanded: true,
        core: { cwd: process.cwd(), settings },
      },
      diffTheme,
    ).render(120).join("\n");

    expect(raw).toContain("\x1b[48;2;");
    expect(raw).not.toContain(successBackground);
    expect(raw).not.toContain(errorBackground);
  });

  it("preserves assistant responses and one-line tools for large agent groups", () => {
    const audits = Array.from({ length: 10 }, (_, agentIndex) => ({
      ref: "agents.run",
      provider: "agents",
      tool: "run",
      args: { name: `agent-${agentIndex}` },
      preview: {
        kind: "fabric-agent-tools" as const,
        id: `agent-child-${agentIndex}`,
        name: `agent-${agentIndex}`,
        status: "running",
        runner: "pi" as const,
        owner: "agent" as const,
        text: "first narrative\nlatest narrative",
        tools: Array.from({ length: 3 }, (_, toolIndex) => ({
          id: `tool-${agentIndex}-${toolIndex}`,
          kind: "tool" as const,
          label: "read",
          toolName: "read",
          status: "completed" as const,
          args: { path: `src/agent-${agentIndex}-file-${toolIndex}.ts` },
        })),
      },
    }));
    const lines = renderFabricMulticallPartial(
      { audits, phases: [], expanded: true, showAgentToolPreview: true },
      plainTheme,
    ).render(160).map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
    const visible = lines.join("\n");

    expect(visible).toContain("run agent-0 › first narrative");
    expect(visible).toContain("latest narrative");
    expect(visible).toContain("src/agent-0-file-0.ts");
    expect(visible).toContain("src/agent-0-file-2.ts");
    expect(lines.length).toBeLessThanOrEqual(60);
  });

  it("renders a write body while a multicall remains partial", () => {
    const lines = renderFabricMulticallPartial(
      {
        audits: [
          {
            ref: "pi.write",
            provider: "pi",
            tool: "write",
            args: { path: "one.md" },
            success: true,
          },
          {
            ref: "pi.write",
            provider: "pi",
            tool: "write",
            args: { path: "two.md" },
            success: true,
          },
          { ref: "pi.bash", provider: "pi", tool: "bash", args: { command: "sleep 1" } },
        ],
        phases: [],
        progress: "bash: waiting",
        expanded: false,
        preview: { auditIndex: 1, body: "# Two\nPreview body", hidden: 4 },
      },
      plainTheme,
    ).render(100);

    expect(lines).toContain("  # Two");
    expect(lines).toContain("  Preview body");
    expect(lines).toContain("  … 4 more lines");
  });

  it("renders in-flight agent names from invocation arguments", () => {
    const title = nestedCallTitle(
      {
        ref: "agents.run",
        provider: "agents",
        tool: "run",
        args: { name: "dashboard reviewer", task: "Review the dashboard" },
      },
      theme,
    );
    expect(title).toContain("dashboard reviewer");
  });

  it("returns null for non-edit calls and edits without operations", () => {
    expect(nestedEditDiff({ ref: "pi.read", tool: "read" }, theme)).toBeNull();
    expect(nestedEditDiff({ ref: "pi.edit", tool: "edit", args: { path: "a.ts" } }, theme)).toBeNull();
  });

  it("renders a plain +/- diff with context for unknown languages", () => {
    const lines = nestedEditDiff(
      {
        ref: "pi.edit",
        tool: "edit",
        args: {
          path: "notes.txt",
          edits: [
            { oldText: "const a = 1;\nconst b = 2;", newText: "const a = 1;\nconst b = 3;" },
          ],
        },
      },
      theme,
    );
    expect(lines).not.toBeNull();
    const joined = lines!.join("\n");
    expect(joined).toContain("const a = 1;");
    expect(joined).toContain("const b = 2;");
    expect(joined).toContain("const b = 3;");
    expect(joined).toContain("toolDiffContext");
    expect(joined).toContain("toolDiffRemoved");
    expect(joined).toContain("toolDiffAdded");
  });

  it("syntax-highlights edit diff content for known languages", async () => {
    await initHighlighting("dark-plus", true);
    const lines = nestedEditDiff(
      {
        ref: "pi.edit",
        tool: "edit",
        args: {
          path: "src/index.ts",
          edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }],
        },
      },
      theme,
    );
    expect(lines).not.toBeNull();
    const joined = lines!.join("\n");
    expect(joined).toContain("toolDiffRemoved");
    expect(joined).toContain("toolDiffAdded");
    // shiki truecolor escapes on the highlighted code content
    expect(joined).toContain("\x1b[38;2;");
  }, 15_000);

  it("modelReadHint reports model lines vs read lines for a sliced read", () => {
    expect(
      modelReadHint(
        [{ ref: "pi.read", tool: "read", result: `a
b
c
d
e
f
g
h` }],
        `b
c
d`,
        theme,
      ),
    ).toContain("→ 3 of 8 lines to model");
  });

  it("modelReadHint is empty when the full read went to the model", () => {
    expect(modelReadHint([{ ref: "pi.read", tool: "read", result: `a
b
c` }], `x
y
z`, theme)).toBe("");
  });

  it("modelReadHint ignores non-read audits", () => {
    expect(modelReadHint([{ ref: "pi.bash", tool: "bash", result: `a
b
c
d
e
f` }], `a
b`, theme)).toBe("");
  });

  it("keeps generic MCP headlines after final trace projection", () => {
    const live = [
      {
        ref: "mcp.fal-ai.submit_job",
        provider: "mcp",
        tool: "fal-ai.submit_job",
        args: { endpoint: "fal-ai/hunyuan3d-v3/image-to-3d", arguments: { image_url: "one" } },
      },
      {
        ref: "mcp.fal-ai.submit_job",
        provider: "mcp",
        tool: "fal-ai.submit_job",
        args: { endpoint: "fal-ai/hunyuan3d-v3/image-to-3d/two", arguments: { image_url: "two" } },
      },
    ];
    const previews = captureFabricCallHeadlinePreviews(live);
    const restored = restoreFabricCallHeadlinePreviews(
      [
        { ref: "fabric.workflow.parallel", provider: "fabric", tool: "workflow.parallel", args: { itemCount: 2 } },
        ...live.map(({ args: _args, ...audit }) => ({ ...audit, args: {}, success: true })),
      ],
      previews,
    );

    expect(previews).toEqual([
      { ref: "mcp.fal-ai.submit_job", headline: "fal-ai/hunyuan3d-v3/image-to-3d" },
      { ref: "mcp.fal-ai.submit_job", headline: "fal-ai/hunyuan3d-v3/image-to-3d/two" },
    ]);
    expect(nestedCallTitle(restored[1]!, plainTheme)).toBe(
      "fal-ai.submit_job fal-ai/hunyuan3d-v3/image-to-3d",
    );
    expect(nestedCallTitle(restored[2]!, plainTheme)).toBe(
      "fal-ai.submit_job fal-ai/hunyuan3d-v3/image-to-3d/two",
    );
  });

  it("keeps safe provider details when final traces omit results and payloads", () => {
    const live = [
      { ref: "agents.list", provider: "agents", tool: "list", args: {}, result: Array(13).fill({}) },
      { ref: "agents.log", provider: "agents", tool: "log", args: { id: "agent-reviewer-1234", lines: 2000 } },
      { ref: "agents.ask", provider: "agents", tool: "ask", args: { id: "agent-reviewer-1234", message: "Audit web search" } },
      { ref: "mcp.$call", provider: "mcp", tool: "$call", args: { server: "github", tool: "search_code", args: { q: "private" } } },
      { ref: "fabric.discovery.list", provider: "fabric", tool: "discovery.list", args: {}, result: Array(83).fill({}) },
    ];
    const previews = captureFabricCallHeadlinePreviews(live);
    const restored = restoreFabricCallHeadlinePreviews(
      [
        { ref: "agents.list", provider: "agents", tool: "list", args: {}, success: true },
        { ref: "agents.log", provider: "agents", tool: "log", args: { id: "agent-reviewer-1234" }, success: true },
        { ref: "agents.ask", provider: "agents", tool: "ask", args: { id: "agent-reviewer-1234" }, success: true },
        { ref: "mcp.$call", provider: "mcp", tool: "$call", args: {}, success: true },
        { ref: "fabric.discovery.list", provider: "fabric", tool: "discovery.list", args: {}, success: true },
      ],
      previews,
    );

    expect(restored.map((audit) => nestedCallTitle(audit, plainTheme))).toEqual([
      "list 13",
      "log agent-re",
      "ask agent-re Audit web search",
      "$call github.search_code",
      "discovery.list 83",
    ]);
    expect(JSON.stringify(previews)).not.toContain("private");
  });

  it("renders structural details from durable workflow and discovery projections", () => {
    expect(nestedCallTitle(
      { ref: "fabric.discovery.describe", provider: "fabric", tool: "discovery.describe", args: { ref: "agents.log" } },
      plainTheme,
    )).toBe("discovery.describe agents.log");
    expect(nestedCallTitle(
      { ref: "fabric.workflow.pipeline", provider: "fabric", tool: "workflow.pipeline", args: { itemCount: 4, stageCount: 2 } },
      plainTheme,
    )).toBe("workflow.pipeline 4 items · 2 stages");
  });

  it("keeps restored headline occurrences aligned when final args already have a preview", () => {
    const restored = restoreFabricCallHeadlinePreviews(
      [
        { ref: "mcp.server.lookup", provider: "mcp", tool: "server.lookup", args: { query: "durable first" } },
        { ref: "mcp.server.lookup", provider: "mcp", tool: "server.lookup", args: {} },
      ],
      [
        { ref: "mcp.server.lookup", headline: "live first" },
        { ref: "mcp.server.lookup", headline: "live second" },
      ],
    );

    expect(nestedCallTitle(restored[0]!, plainTheme)).toBe("server.lookup durable first");
    expect(nestedCallTitle(restored[1]!, plainTheme)).toBe("server.lookup live second");
  });

  it("renders a generic extension tool's query argument", () => {
    const title = nestedCallTitle(
      { ref: "extensions.vcc_recall", provider: "extensions", tool: "vcc_recall", args: { query: "how do I recall X" } },
      theme,
    );
    expect(title).toContain("vcc_recall");
    expect(title).toContain("how do I recall X");
  });

  it("falls back to the first string arg for tools with unfamiliar keys", () => {
    const title = nestedCallTitle(
      { ref: "extensions.custom_search", provider: "extensions", tool: "custom_search", args: { haystack: "needle" } },
      theme,
    );
    expect(title).toContain("custom_search");
    expect(title).toContain("needle");
  });

  it("renders just the tool name when there is no string arg", () => {
    const title = nestedCallTitle(
      { ref: "extensions.no_args", provider: "extensions", tool: "no_args", args: { count: 3 } },
      theme,
    );
    expect(title).toContain("no_args");
    expect(title).not.toContain("3");
  });

  it("preserves the enclosing Box background when bounded rows are truncated", () => {
    const box = new Box(1, 0, (text) => "\x1b[42m" + text + "\x1b[49m");
    box.addChild(renderBoundedLines(["x".repeat(40)]));

    const line = box.render(20)[0]!;
    expect(line).toBe(
      "\x1b[42m " + "x".repeat(18) + "\x1b[22;23;24;27;29;39m \x1b[49m",
    );
    expect(visibleWidth(line)).toBe(20);
  });

  it("reuses bounded row layout until its width or content is invalidated", () => {
    const component = renderBoundedLines(["x".repeat(40)]);
    const first = component.render(20);

    expect(component.render(20)).toBe(first);
    expect(component.render(24)).not.toBe(first);

    const resized = component.render(20);
    expect(resized).not.toBe(first);
    component.invalidate?.();
    expect(component.render(20)).not.toBe(resized);
  });

  it("reuses stable source-row balancing between animation frames", () => {
    const balance: ResultRowBalance = {};
    let renders = 0;
    const code = new HiddenRowBorrowingComponent(
      2,
      4,
      (limit) => {
        renders++;
        return Array.from({ length: limit }, (_, index) => "code-" + (index + 1));
      },
      balance,
    );

    const first = code.render(80);
    expect(code.render(80)).toBe(first);
    expect(renders).toBe(1);

    code.invalidate();
    expect(code.render(80)).not.toBe(first);
    expect(renders).toBe(2);
  });

  it("replaces lost result rows with hidden source lines", () => {
    const balance: ResultRowBalance = {};
    const partial = observeResultRows(
      renderBoundedLines(["running", "call one", "call two", "detail", "progress"]),
      balance,
      { expanded: false, isPartial: true },
    );
    expect(partial.render(80)).toHaveLength(5);

    const final = observeResultRows(
      renderBoundedLines(["complete", "calls"]),
      balance,
      { expanded: false, isPartial: false },
    );
    expect(final.render(80)).toEqual(["complete", "calls"]);
    expect(resultRowDeficit(balance, 80)).toBe(3);

    const code = new HiddenRowBorrowingComponent(
      8,
      20,
      (limit) => [
        "title",
        ...Array.from({ length: limit }, (_, index) => `code-${index + 1}`),
        ...(limit < 20 ? [`${20 - limit} hidden`] : []),
      ],
      balance,
    );
    const rendered = code.render(80);
    expect(rendered).toHaveLength(13);
    expect(rendered).toContain("code-11");
    expect(rendered).not.toContain("code-12");
    expect(rendered.length + final.render(80).length).toBe(15);
  });

  it("does not reveal a source line that would overshoot the result deficit", () => {
    const balance: ResultRowBalance = {};
    observeResultRows(
      renderBoundedLines(["one", "two", "three"]),
      balance,
      { expanded: false, isPartial: true },
    ).render(20);
    observeResultRows(
      renderBoundedLines(["done"]),
      balance,
      { expanded: false, isPartial: false },
    );

    const code = new HiddenRowBorrowingComponent(
      1,
      2,
      (limit) =>
        limit === 1 ? ["base"] : ["base", "wrapped", "source", "line"],
      balance,
    );
    expect(code.render(20)).toEqual(["base"]);
  });

  it("keeps multicall progress inline without adding completion-only rows", () => {
    const audits = [
      {
        ref: "pi.read",
        provider: "pi",
        tool: "read",
        args: { path: "src/index.ts" },
        success: true,
      },
      {
        ref: "pi.ls",
        provider: "pi",
        tool: "ls",
        args: { path: "src" },
      },
    ];
    const component = renderFabricMulticallPartial(
      {
        audits,
        phases: ["Inspect"],
        progress: "bash: one\ntwo\nthree\nfour",
        expanded: false,
      },
      plainTheme,
    );

    const wide = component.render(120);
    expect(wide).toHaveLength(4); // header + phase + two calls
    expect(wide[0]).toContain("… 3 lines · four");
    expect(wide.slice(1)).not.toContain("four");

    const narrow = component.render(24);
    expect(narrow).toHaveLength(wide.length);
    expect(narrow.every((line) => visibleWidth(line) <= 24)).toBe(true);
  });

  it("uses the completed-render call cap while a multicall is partial", () => {
    const audits = Array.from({ length: 12 }, (_, index) => ({
      ref: "pi.read",
      provider: "pi",
      tool: "read",
      args: { path: `file-${index}.ts` },
    }));
    const lines = renderFabricMulticallPartial(
      { audits, phases: [], progress: "Calling pi.read", expanded: false },
      plainTheme,
    ).render(100);

    expect(lines).toHaveLength(10); // header + eight calls + hidden marker
    expect(lines.at(-1)).toContain("4 nested calls hidden");
  });

  it("omits redundant single-call progress when an agent preview is visible", () => {
    expect(singleCallProgressLine("Agent reviewer: running", ["› read src/index.ts"])).toBe("");
    expect(singleCallProgressLine("Agent reviewer: running", [])).toBe("Agent reviewer: running");
  });

  it("compacts multiline progress to its latest line", () => {
    expect(compactProgressPreview("one\ntwo\nthree")).toBe("… 2 lines · three");
  });
});

describe("nestedCallTitle truncation marker", () => {
  const bashAudit = (result: unknown) => ({
    ref: "pi.bash",
    provider: "pi",
    tool: "bash",
    args: { cmd: "curl -sf https://example.com" },
    result,
  });

  it("marks results truncated by the core bash tool", () => {
    const title = nestedCallTitle(
      bashAudit({
        ok: true,
        output: "    },",
        details: { truncation: { truncated: true, maxBytes: 51200 } },
      }),
      plainTheme,
    );

    expect(title).toContain("truncated");
  });

  it("marks results truncated at the fabric result boundary", () => {
    const title = nestedCallTitle(
      { ...bashAudit({ ok: true, output: "line" }), resultTruncated: true },
      plainTheme,
    );

    expect(title).toContain("truncated");
  });

  it("omits the marker for complete results", () => {
    const title = nestedCallTitle(
      bashAudit({
        ok: true,
        output: "line",
        details: { truncation: { truncated: false } },
      }),
      plainTheme,
    );

    expect(title).not.toContain("truncated");
  });
});
