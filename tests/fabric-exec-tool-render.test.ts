import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FabricState } from "../src/fabric-state.js";
import { createFabricPersistedExecutionDetails, FabricExecutionTraceRecorder } from "../src/audit/index.js";
import { createFabricExecTool } from "../src/fabric-exec-tool.js";
import { defaultCodePreviewSettings } from "../src/ui/code-preview.js";
import { FabricToolDisplayController } from "../src/ui/tool-display.js";

// Partial cards stamp running activity rows with spinnerFrame(Date.now()).
// Serial renders that straddle a 250ms spinner tick (GC pauses under
// full-suite load) observed different glyphs and broke cross-render
// comparisons, so the whole file renders at one pinned instant.
beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const semanticTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
} as unknown as Theme;

const stateFor = (
  toolDisplay: "full" | "compact",
  overrides: Partial<{ bootstrapped: boolean; initialized: boolean }> = {},
) => ({
  bootstrapped: true,
  initialized: true,
  config: {
    ui: { showAgentToolPreview: true, toolDisplay },
  },
  ...overrides,
}) as unknown as FabricState;

const toolFor = (
  state: FabricState,
  display?: FabricToolDisplayController,
  codePreviewSettings = defaultCodePreviewSettings(),
) => createFabricExecTool(
  state,
  codePreviewSettings,
  new Map(),
  (tool) => tool,
  display,
);

const renderContext = (
  args: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) => ({
  args,
  toolCallId: "fabric-call-1",
  invalidate: vi.fn(),
  lastComponent: undefined,
  state: {},
  cwd: process.cwd(),
  executionStarted: true,
  argsComplete: true,
  isPartial: false,
  expanded: false,
  showImages: true,
  isError: false,
  ...overrides,
});

const renderCall = (
  tool: ReturnType<typeof toolFor>,
  args: Record<string, unknown>,
  expanded = false,
  theme: Theme = plainTheme,
) => tool.renderCall!(args as never, theme, renderContext(args, { expanded }) as never).render(120).join("\n");

const renderResult = (
  tool: ReturnType<typeof toolFor>,
  args: Record<string, unknown>,
  details: Record<string, unknown>,
  output: string,
  options: { expanded?: boolean; partial?: boolean; theme?: Theme; context?: Record<string, unknown>; width?: number } = {},
) => tool.renderResult!(
  { content: output ? [{ type: "text", text: output }] : [], details } as never,
  { expanded: options.expanded ?? false, isPartial: options.partial ?? false },
  options.theme ?? plainTheme,
  renderContext(args, { expanded: options.expanded ?? false, isPartial: options.partial ?? false, ...options.context }) as never,
).render(options.width ?? 120).join("\n");

const nestedRows = (rendered: string): string[] => rendered.split("\n").slice(1);

describe("registered fabric_exec compact transcript rendering", () => {
  it.each(["full", "compact"] as const)("filters successful internal loads in %s partial, final and restored cards", mode => {
    const tool = toolFor(stateFor(mode));
    const audits = [
      { ref: "native.load", success: true, result: { stored: 42 } },
      { ref: "tasks.wait", args: { id: "task-123" }, success: true },
    ];
    for (const partial of [true, false]) for (const expanded of [true, false]) {
      const details = JSON.parse(JSON.stringify({ success: true, audits, phases: [] }));
      const card = renderResult(tool, { code: 'return await tools.call({ref: "tasks.wait", args: {id: "task-123"}})' }, details, "done", { partial, expanded });
      expect(card).not.toContain("native.load");
      expect(card).not.toContain("2 calls");
      expect(card).toContain("tasks.wait task-123");
      expect(details.audits).toHaveLength(2);
    }
    const failed = renderResult(tool, {}, { success: false, audits: [{ ref: "native.load", success: false, error: "load failed" }] }, "load failed");
    expect(failed).toContain("native.load");
    expect(failed).toContain("load failed");
  });
  it("subtracts trimmed internal loads without erasing raw omitted counters", () => {
    const details = { success: true, audits: [{ ref: "tasks.wait", args: { id: "task-123" }, success: true }], omittedCalls: { count: 4, done: 4, internal: 3, failed: 1 } };
    for (const partial of [false, true]) {
      const card = renderResult(toolFor(stateFor("full")), {}, details, "done", { partial });
      expect(card).not.toContain("5");
      expect(card).toContain("2");
      expect(details.omittedCalls).toEqual({ count: 4, done: 4, internal: 3, failed: 1 });
    }
  });
  it("retains trimmed failure counts on a resumed compact card", () => {
    const recorder = new FabricExecutionTraceRecorder();
    const details = createFabricPersistedExecutionDetails({
      success: true, trace: recorder.seal("succeeded", []),
      audits: [
        { ref: "ok", success: true },
        { ref: "failed", success: false, result: "x".repeat(600_000) },
      ],
    });
    expect(details.omittedCalls).toEqual({ count: 1, done: 1, failed: 1 });
    expect(Buffer.byteLength(JSON.stringify(details))).toBeLessThanOrEqual(512 * 1024);
    const resumed = JSON.parse(JSON.stringify(details));
    const card = renderResult(toolFor(stateFor("compact")), { code: "return 1" }, resumed, "1", { theme: semanticTheme });
    expect(card).toContain("<error>✗ Tools</error>");
    expect(card).toContain("2 calls · 1 failed");
  });
  it("keeps the shell background hint visible during streamed output, only while waiting", () => {
    const tool = toolFor(stateFor("full"));
    const args = { code: "await pi.bash({cmd:'build'})" };
    const shell = { ref: "pi.bash", provider: "pi", tool: "bash", args: { command: "build" }, preview: { result: "streamed output", shellBackgroundShortcut: true } };
    const details = { audits: [shell], phases: [], progress: "bash: streamed output" };
    for (const expanded of [false, true]) {
      expect(renderResult(tool, args, details, "", { partial: true, expanded })).toContain("Ctrl+B twice");
      expect(renderResult(tool, args, { ...details, audits: [shell, { ref: "pi.read", tool: "read", success: true }] }, "", { partial: true, expanded })).toContain("Ctrl+B twice");
    }
    expect(renderResult(tool, args, { ...details, audits: [{ ...shell, success: true }] }, "", { partial: true })).not.toContain("Ctrl+B twice");
    expect(renderResult(tool, args, details, "", { partial: false })).not.toContain("Ctrl+B twice");
    expect(renderResult(tool, args, { ...details, audits: [{ ...shell, preview: { result: "streamed output" } }] }, "", { partial: true })).not.toContain("Ctrl+B twice");
  });
  it("infers Python compact titles while preserving explicit intent and neutral fallbacks", () => {
    const state = stateFor("compact");
    state.config.executor = { kernel: "python" } as FabricState["config"]["executor"];
    const tool = toolFor(state);
    const code = '# pi.bash("fake")\nreturn await pi.read(path="src/config.ts")';
    expect(renderCall(tool, { code })).toContain("Read config.ts");
    expect(renderCall(tool, { code, display: { name: " ", description: "Verify configuration" } }))
      .toContain("Verify configuration");
    expect(renderCall(tool, { code, display: { name: "Declared intent" } })).toContain("Declared intent");
    expect(renderCall(tool, { code: '# pi.bash("fake")\nreturn 1' })).toContain("Python program");
  });

  it("keeps full source while compact elevates intent and falls back to Fabric for absent or blank names", () => {
    const args = {
      code: "const implementationSecret = await discover();\nreturn implementationSecret;",
      display: { name: "Apply migration", description: "Persist the verified setting" },
    };

    const full = renderCall(toolFor(stateFor("full")), args, true);
    const compact = renderCall(toolFor(stateFor("compact")), args);
    const composing = renderCall(toolFor(stateFor("compact")), { code: "" });
    const fallback = renderCall(toolFor(stateFor("compact")), { code: args.code });
    const blank = renderCall(toolFor(stateFor("compact")), { code: args.code, display: { name: "   " } });

    expect(full).toContain("fabric");
    expect(full).toContain("TypeScript · 2 lines");
    expect(full).toContain("implementationSecret");
    // Full mode shows the declared objective between the title and the code.
    expect(full).toContain("Persist the verified setting");
    expect(full.indexOf("Persist the verified setting"))
      .toBeGreaterThan(full.indexOf("TypeScript · 2 lines"));
    expect(full.indexOf("implementationSecret"))
      .toBeGreaterThan(full.indexOf("Persist the verified setting"));
    expect(compact).toContain("Apply migration");
    expect(compact).toContain("Persist the verified setting");
    expect(compact).not.toContain("fabric");
    expect(compact).not.toContain("TypeScript");
    expect(compact).not.toContain("implementationSecret");
    expect(composing).toContain("Fabric");
    expect(fallback).toContain("Fabric");
    expect(blank).toContain("Fabric");
  });

  it("promotes a compact card to the full transcript while the expand toggle is on", () => {
    const args = {
      code: "const implementationSecret = await discover();\nreturn implementationSecret;",
      display: { name: "Apply migration", description: "Persist the verified setting" },
    };
    const details = {
      success: true,
      audits: [
        { ref: "pi.read", provider: "pi", tool: "read", args: { path: "src/config.ts" }, success: true, result: "export const value = true;" },
        { ref: "pi.bash", provider: "pi", tool: "bash", args: { command: "pnpm test" }, success: true },
      ],
      phases: [],
    };

    // ctrl+o (app.tools.expand) flips expanded; the expanded compact card must
    // be byte-identical to the full card in both the call and the result.
    expect(renderCall(toolFor(stateFor("compact")), args, true))
      .toBe(renderCall(toolFor(stateFor("full")), args, true));

    const compactCollapsed = renderResult(toolFor(stateFor("compact")), args, details, "outer return");
    const compactExpanded = renderResult(toolFor(stateFor("compact")), args, details, "outer return", { expanded: true });
    const fullExpanded = renderResult(toolFor(stateFor("full")), args, details, "outer return", { expanded: true });

    expect(compactCollapsed).toContain("Tools");
    expect(compactCollapsed).not.toContain("Fabric complete");
    expect(compactExpanded).toBe(fullExpanded);
    expect(compactExpanded).toContain("Fabric complete");
  });

  it("adds configured duration metadata to completed provider calls", () => {
    const args = { code: "return await extensions.fovea_focus({ query: 'src/fabric-exec-tool.ts' });" };
    const details = {
      success: true,
      audits: [
        {
          ref: "extensions.fovea_focus",
          provider: "extensions",
          tool: "fovea_focus",
          args: { query: "src/fabric-exec-tool.ts" },
          success: true,
          startedAt: 1_000,
          endedAt: 1_129,
        },
        {
          ref: "memory.recall",
          provider: "memory",
          tool: "recall",
          args: { query: "renderer" },
          success: true,
          startedAt: 2_000,
          endedAt: 3_250,
        },
        {
          ref: "mcp.github.search_code",
          provider: "mcp",
          tool: "github.search_code",
          args: { query: "timing metadata" },
          success: true,
          startedAt: 4_000,
          endedAt: 4_042,
        },
      ],
      phases: [],
    };
    const timingSettings = { ...defaultCodePreviewSettings(), toolCallTiming: true };
    const rendered = renderResult(
      toolFor(stateFor("compact"), undefined, timingSettings),
      args,
      details,
      "",
    );
    const timingDisabled = renderResult(
      toolFor(stateFor("compact"), undefined, { ...timingSettings, toolCallTiming: false }),
      args,
      details,
      "",
    );

    expect(rendered).toContain("fovea_focus src/fabric-exec-tool.ts · 129ms");
    expect(rendered).toContain("recall renderer · 1.3s");
    expect(rendered).toContain("github.search_code timing metadata · 42ms");
    expect(timingDisabled).not.toContain("129ms");
    expect(timingDisabled).not.toContain("1.3s");
    expect(timingDisabled).not.toContain("42ms");
  });

  it("uses Tools or Evaluated summaries while preserving completed nested detail and bounded returns", () => {
    const args = { code: "await Promise.all([]);" };
    const details = {
      success: false,
      error: "Fabric execution failed",
      audits: [
        { ref: "pi.read", provider: "pi", tool: "read", args: { path: "src/config.ts" }, success: true, result: "export const value = true;" },
        { ref: "pi.bash", provider: "pi", tool: "bash", args: { command: "pnpm test" }, success: false, error: "tests failed" },
      ],
      phases: [],
    };
    const full = renderResult(toolFor(stateFor("full")), args, details, "outer failure details");
    const compact = renderResult(toolFor(stateFor("compact")), args, details, "outer failure details");
    const evaluated = renderResult(
      toolFor(stateFor("compact")),
      args,
      { success: true, audits: [], phases: [] },
      "quiet outer return",
    );
    const longReturn = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join("\n");
    const boundedEvaluation = renderResult(
      toolFor(stateFor("compact")),
      args,
      { success: true, audits: [], phases: [] },
      longReturn,
    );
    const expandedEvaluation = renderResult(
      toolFor(stateFor("compact")),
      args,
      { success: true, audits: [], phases: [] },
      longReturn,
      { expanded: true },
    );

    expect(full).toContain("Fabric failed");
    expect(compact).toContain("Tools");
    expect(compact).toContain("2 calls");
    expect(compact).toContain("1 failed");
    expect(compact).toContain("read src/config.ts");
    expect(compact).toContain("tests failed");
    expect(compact).toContain("outer failure details");
    expect(evaluated).toContain("Evaluated");
    expect(evaluated).toContain("quiet outer return");
    expect(boundedEvaluation).toContain("line 12");
    expect(boundedEvaluation).not.toContain("line 13");
    expect(boundedEvaluation).toContain("… 2 lines");
    expect(boundedEvaluation).toContain("to expand");
    expect(expandedEvaluation).not.toContain("Evaluated");
    expect(expandedEvaluation).toContain("line 14");
  });

  it("summarizes one nested call while keeping its successful outer return quiet in compact mode", () => {
    const args = { code: "await extensions.remote({ strings: 'single-headline' });" };
    const details = {
      success: true,
      audits: [
        {
          ref: "extensions.remote",
          provider: "extensions",
          tool: "remote",
          args: { strings: "single-headline" },
          success: true,
        },
      ],
      phases: [],
    };
    const failedDetails = {
      success: false,
      audits: [
        {
          ref: "extensions.remote",
          provider: "extensions",
          tool: "remote",
          args: { strings: "failed-headline" },
          success: false,
          error: "nested failure",
        },
      ],
      phases: [],
    };

    const full = renderResult(toolFor(stateFor("full")), args, details, "successful outer return");
    const compact = renderResult(toolFor(stateFor("compact")), args, details, "successful outer return");
    const expandedCompact = renderResult(
      toolFor(stateFor("compact")),
      args,
      details,
      "successful outer return",
      { expanded: true },
    );
    const failedCompact = renderResult(
      toolFor(stateFor("compact")),
      args,
      failedDetails,
      "outer failure return",
    );

    expect(full).toContain("successful outer return");
    expect(compact).toContain("Tools");
    expect(compact).toContain("1 call");
    expect(compact).toContain("single-headline");
    expect(compact).not.toContain("successful outer return");
    expect(expandedCompact).toContain("successful outer return");
    expect(failedCompact).toContain("Tools");
    expect(failedCompact).toContain("1 call");
    expect(failedCompact).toContain("1 failed");
    expect(failedCompact).toContain("nested failure");
  });

  it("leaves completed nested bash and dynamic calls unchanged apart from the grouped header", () => {
    const args = { code: "await Promise.all([]);" };
    const details = {
      success: true,
      audits: [
        {
          ref: "pi.bash",
          provider: "pi",
          tool: "bash",
          args: { command: "echo alpha\necho beta" },
          result: { output: "bash result" },
          success: true,
        },
        {
          ref: "extensions.remote",
          provider: "extensions",
          tool: "remote",
          args: { strings: "existing-string-headline" },
          success: true,
        },
      ],
      phases: [],
    };
    const full = renderResult(toolFor(stateFor("full")), args, details, "", { expanded: true, theme: semanticTheme });
    const compact = renderResult(toolFor(stateFor("compact")), args, details, "", { theme: semanticTheme });
    const fullCollapsed = renderResult(toolFor(stateFor("full")), args, details, "", { theme: semanticTheme });
    const compactExpanded = renderResult(toolFor(stateFor("compact")), args, details, "", { expanded: true, theme: semanticTheme });

    expect(full).toContain("<accent>echo alpha</accent>");
    expect(full).toContain("<accent>echo beta</accent>");
    expect(full).toContain("existing-string-headline");
    expect(full).toContain("Fabric complete");
    expect(compact).toContain("existing-string-headline");
    expect(compact).toContain("Tools");
    expect(compact).not.toContain("Fabric complete");
    // Collapsed compact keeps the collapsed full card's nested rows under its
    // grouped header; ctrl+o expansion promotes it to the full card verbatim.
    expect(compact.split("\n").slice(1)).toEqual(fullCollapsed.split("\n").slice(1));
    expect(compactExpanded).toBe(full);
  });

  it("re-renders a resumed card identically to the live one from persisted audits", () => {
    const args = { code: "await pi.bash({ command: 'echo alpha' });\nawait pi.edit({ path: 'f.ts', edits: [{ oldText: 'a', newText: 'b' }] });" };
    const audits = [
      { ref: "pi.bash", provider: "pi", tool: "bash", args: { command: "echo alpha" }, success: true, result: { output: "alpha" } },
      { ref: "pi.edit", provider: "pi", tool: "edit", args: { path: "f.ts", edits: [{ oldText: "a", newText: "b" }] }, success: true, result: { details: { diff: "-a\n+b" } } },
    ];
    const trace = {
      kind: "pi-fabric.execution",
      version: 1,
      outcome: "succeeded",
      phases: [],
      operations: audits.map((audit, sequence) => ({
        type: "call",
        sequence,
        ref: audit.ref,
        provider: audit.provider,
        action: audit.tool,
        args: audit.tool === "bash" ? { command: audit.args.command } : { path: audit.args.path },
        outcome: "succeeded",
      })),
      counts: { droppedValues: 0, truncatedValues: 0, redactedValues: 0, droppedOperations: 0 },
    };
    // Simulate a session reload: only the persisted, JSON-round-tripped details survive.
    const persisted = JSON.parse(
      JSON.stringify(createFabricPersistedExecutionDetails({ success: true, trace: trace as never, audits })),
    );
    const liveDetails = { success: true, phases: [], audits };

    for (const expanded of [false, true]) {
      const live = renderResult(toolFor(stateFor("full")), args, liveDetails, "", { expanded });
      const resumed = renderResult(toolFor(stateFor("full")), args, persisted, "", { expanded });
      expect(resumed).toBe(live);
    }
    const expanded = renderResult(toolFor(stateFor("full")), args, persisted, "", { expanded: true });
    expect(expanded).toContain("alpha");
    expect(expanded).toContain("hunk");
  });

  it("counts resumed audits the size bound dropped from the session record", () => {
    const args = { code: "return 1" };
    const audits = Array.from({ length: 40 }, (_, index) => ({
      ref: "pi.read",
      provider: "pi",
      tool: "read",
      args: { path: `file-${index}.ts` },
      success: true,
      result: "y".repeat(30_000),
    }));
    const trace = {
      kind: "pi-fabric.execution",
      version: 1,
      outcome: "succeeded",
      phases: [],
      operations: audits.map((audit, sequence) => ({
        type: "call",
        sequence,
        ref: audit.ref,
        provider: audit.provider,
        action: audit.tool,
        args: { path: audit.args.path },
        outcome: "succeeded",
      })),
      counts: { droppedValues: 0, truncatedValues: 0, redactedValues: 0, droppedOperations: 0 },
    };
    const persisted = JSON.parse(
      JSON.stringify(createFabricPersistedExecutionDetails({ success: true, trace: trace as never, audits })),
    ) as { audits: unknown[] };
    // The 512 KiB bound keeps fewer than 40 audits.
    expect(persisted.audits.length).toBeLessThan(40);

    const resumed = renderResult(toolFor(stateFor("full")), args, persisted, "", { expanded: true });
    expect(resumed).toContain("40 nested calls");
    expect(resumed).toContain(`${40 - persisted.audits.length} nested calls hidden`);
    const compact = renderResult(toolFor(stateFor("compact")), args, persisted, "");
    expect(compact).toContain("40 calls");
  });

  it("marks trace-only resumed audits instead of fabricating empty content", () => {
    // Session records written before rich audit persistence: args are
    // privacy-projected and results were never retained.
    const details = {
      success: true,
      trace: {
        kind: "pi-fabric.execution",
        version: 1,
        outcome: "succeeded",
        phases: [],
        operations: [
          { type: "call", sequence: 0, ref: "pi.bash", provider: "pi", action: "bash", args: { command: "echo alpha" }, outcome: "succeeded" },
          { type: "call", sequence: 1, ref: "pi.edit", provider: "pi", action: "edit", args: { path: "f.ts" }, outcome: "succeeded" },
        ],
        counts: { droppedValues: 0, truncatedValues: 0, redactedValues: 0, droppedOperations: 0 },
      },
    };
    const args = { code: "await pi.bash({ command: 'echo alpha' });" };
    const expanded = renderResult(toolFor(stateFor("full")), args, details, "", { expanded: true });

    expect(expanded).toContain("output not retained across reload");
    expect(expanded).toContain("diff not retained across reload");
    expect(expanded).not.toContain("No output");
  });

  it("uses a compact pre-tool live status and Tools for grouped activity without changing its nested calls", () => {
    const args = { code: "await Promise.all([]);" };
    const details = {
      audits: [
        { ref: "pi.read", provider: "pi", tool: "read", args: { path: "src/example.ts" }, success: true },
        { ref: "extensions.remote", provider: "extensions", tool: "remote", args: { strings: "live-string-headline" } },
      ],
      phases: [],
    };
    const full = renderResult(toolFor(stateFor("full")), args, details, "", { partial: true });
    const compact = renderResult(toolFor(stateFor("compact")), args, details, "", { partial: true });
    const compactBeforeFirstTool = renderResult(
      toolFor(stateFor("compact")),
      args,
      { progress: "Running Fabric program…", audits: [], phases: [] },
      "",
      { partial: true },
    );

    expect(full).toContain("Fabric running");
    expect(compact).toContain("Tools running");
    expect(full).toContain("live-string-headline");
    expect(compact).toContain("live-string-headline");
    expect(compact.split("\n").slice(1)).toEqual(full.split("\n").slice(1));
    expect(compactBeforeFirstTool).toContain("Running…");
    expect(compactBeforeFirstTool).not.toContain("Fabric program");
  });

  it("retains specialized write previews while compact hides outer source", () => {
    const args = {
      code: 'await pi.write({ path: "README.md", content: π.content });',
      strings: { content: "# Visible write preview", secret: "never-show-this" },
      display: { name: "Update README" },
    };
    const tool = toolFor(stateFor("compact"));
    const preview = tool.renderCall!(
      args as never,
      plainTheme,
      renderContext(args, { executionStarted: false, isPartial: true }) as never,
    ).render(120).join("\n");

    expect(preview).toContain("Update README");
    expect(preview).toContain("README.md");
    expect(preview).toContain("Visible write preview");
    expect(preview).not.toContain("await pi.write");
  });

  it("omits the call-side write preview on resumed cards so collapsed renders show it once", () => {
    const args = {
      code: 'await pi.write({ path: "README.md", content: π.content });',
      strings: { content: "# Visible write preview" },
      display: { name: "Update README" },
    };
    // Pi only marks live calls as executionStarted; resumed cards stay at its
    // false default but are always complete (isPartial false).
    const resumedCompact = toolFor(stateFor("compact")).renderCall!(
      args as never,
      plainTheme,
      renderContext(args, { executionStarted: false, isPartial: false }) as never,
    ).render(120).join("\n");
    const resumedFull = toolFor(stateFor("full")).renderCall!(
      args as never,
      plainTheme,
      renderContext(args, { executionStarted: false, isPartial: false }) as never,
    ).render(120).join("\n");
    const streaming = toolFor(stateFor("compact")).renderCall!(
      args as never,
      plainTheme,
      renderContext(args, { executionStarted: false, isPartial: true }) as never,
    ).render(120).join("\n");

    expect(resumedCompact).toContain("Update README");
    expect(resumedCompact).not.toContain("Visible write preview");
    expect(resumedFull).toContain("await pi.write");
    expect(resumedFull).not.toContain("Visible write preview");
    expect(streaming).toContain("Visible write preview");
  });

  it("streams and retains edit diffs in collapsed multicall results", () => {
    const args = { code: "await pi.read({ path: 'before.ts' });\nawait pi.edit({ path: 'target.ts', old: 'before', new: 'after' });" };
    const partialDetails = {
      audits: [
        {
          ref: "pi.read",
          provider: "pi",
          tool: "read",
          args: { path: "before.ts" },
          success: true,
        },
        {
          ref: "pi.edit",
          provider: "pi",
          tool: "edit",
          args: {
            path: "target.ts",
            edits: [{ oldText: "const value = 'before';", newText: "const value = 'after';" }],
          },
        },
      ],
      phases: [],
    };
    const completedDetails = {
      ...partialDetails,
      success: true,
      audits: partialDetails.audits.map((audit, index) =>
        index === 1
          ? { ...audit, success: true, result: { details: { diff: "-const value = 'before';\n+const value = 'after';" } } }
          : audit,
      ),
    };
    const tool = toolFor(stateFor("compact"));
    const partial = renderResult(tool, args, partialDetails, "", { partial: true });
    const completed = renderResult(tool, args, completedDetails, "");

    expect(partial).toContain("proposed edit");
    expect(partial).toContain("before");
    expect(partial).toContain("after");
    expect(completed).toContain("1 hunk");
    expect(completed).toContain("before");
    expect(completed).toContain("after");
  });

  it("keeps specialized collapsed and expanded core detail plus hidden-call bounds unchanged", () => {
    const args = { code: "await Promise.all([]);" };
    const details = {
      success: true,
      audits: [
        {
          ref: "pi.read",
          provider: "pi",
          tool: "read",
          args: { path: "src/example.ts" },
          result: "export const preview = true;",
          success: true,
        },
        {
          ref: "pi.grep",
          provider: "pi",
          tool: "grep",
          args: { pattern: "needle", path: "src", literal: true },
          result: "src/example.ts:3: needle\nsrc/example.ts-4- context",
          success: true,
        },
        {
          ref: "pi.find",
          provider: "pi",
          tool: "find",
          args: { pattern: "*.ts", path: "src" },
          result: "src/example.ts",
          success: true,
        },
        {
          ref: "pi.ls",
          provider: "pi",
          tool: "ls",
          args: { path: "src" },
          result: "example.ts",
          success: true,
        },
        {
          ref: "pi.edit",
          provider: "pi",
          tool: "edit",
          args: { path: "src/example.ts", edits: [{ oldText: "before", newText: "after" }] },
          result: { details: { diff: "-before\n+after" } },
          success: true,
        },
        {
          ref: "pi.write",
          provider: "pi",
          tool: "write",
          args: { path: "src/new.ts", content: "export const preview = true;" },
          preview: { details: { codePreviewBeforeWrite: { kind: "content", content: "" } }, writeBeforeCaptured: true },
          success: true,
        },
        ...Array.from({ length: 7 }, (_, index) => ({
          ref: "extensions.remote",
          provider: "extensions",
          tool: "remote",
          args: { strings: `hidden-call-${index}` },
          success: true,
        })),
      ],
      phases: [],
    };

    for (const expanded of [false, true]) {
      const full = renderResult(toolFor(stateFor("full")), args, details, "", { expanded, theme: semanticTheme });
      const compact = renderResult(toolFor(stateFor("compact")), args, details, "", { expanded, theme: semanticTheme });
      expect(nestedRows(compact)).toEqual(nestedRows(full));
    }
  });

  it("keeps agent and actor preview trees plus failed nested calls unchanged", () => {
    const args = { code: "await agents.wait({ id: 'worker' });" };
    const details = {
      success: false,
      audits: [
        {
          ref: "agents.wait",
          provider: "agents",
          tool: "wait",
          args: { id: "worker" },
          success: true,
          preview: {
            kind: "fabric-agent-tools",
            id: "worker",
            name: "researcher",
            status: "completed",
            owner: "agent",
            tools: [
              {
                id: "worker-edit",
                kind: "tool",
                label: "edit",
                toolName: "edit",
                status: "completed",
                args: { path: "src/worker.ts", edits: [{ oldText: "old", newText: "new" }] },
                result: { details: { diff: "-old\n+new" } },
              },
            ],
            agents: [
              {
                id: "actor",
                name: "reviewer",
                status: "failed",
                owner: "actor",
                currentTool: "bash",
                tools: [
                  {
                    id: "actor-bash",
                    kind: "tool",
                    label: "bash",
                    toolName: "bash",
                    status: "failed",
                    args: { command: "echo actor" },
                    result: { output: "actor failure" },
                  },
                ],
              },
            ],
          },
        },
        {
          ref: "extensions.remote",
          provider: "extensions",
          tool: "remote",
          args: { strings: "failed-child" },
          success: false,
          error: "remote child failed",
        },
      ],
      phases: [],
    };
    for (const expanded of [false, true]) {
      const full = renderResult(toolFor(stateFor("full")), args, details, "outer failure", {
        expanded,
        theme: semanticTheme,
      });
      const compact = renderResult(toolFor(stateFor("compact")), args, details, "outer failure", {
        expanded,
        theme: semanticTheme,
      });

      expect(nestedRows(compact)).toEqual(nestedRows(full));
    }
  });

  it("honors the bootstrapped compact preference while the heavyweight runtime is inactive", () => {
    const args = {
      code: "const lazyResume = await readHistory();\nreturn lazyResume;",
      display: { name: "Resume history", description: "Render the resumed card" },
    };
    const bootstrappedOnly = stateFor("compact", { initialized: false });

    const compact = renderCall(toolFor(bootstrappedOnly), args);

    expect(compact).toContain("Resume history");
    expect(compact).toContain("Render the resumed card");
    expect(compact).not.toContain("lazyResume");
    expect(compact).not.toContain("TypeScript");
  });

  it("falls back to full before bootstrap and for an explicit full preference", () => {
    const args = {
      code: "const untouchedSource = true;",
      display: { name: "Keep full" },
    };
    const preBootstrap = stateFor("full", { bootstrapped: false });
    const bootstrappedFull = stateFor("full", { initialized: false });
    // Failed-bootstrap window: bootstrap() sets cwd before config loads, so a
    // config read failure leaves cwd set with no bootstrapped config. Rendering
    // must still fall back to full instead of throwing.
    const failedBootstrap = { cwd: "/workspace" } as unknown as FabricState;

    const fallback = renderCall(toolFor(preBootstrap), args, true);
    const full = renderCall(toolFor(bootstrappedFull), args, true);
    const failedFallback = renderCall(toolFor(failedBootstrap), args, true);

    expect(fallback).toContain("untouchedSource");
    expect(fallback).toContain("TypeScript");
    expect(full).toContain("untouchedSource");
    expect(full).toContain("TypeScript");
    expect(full).toContain("fabric");
    expect(failedFallback).toContain("untouchedSource");
    expect(failedFallback).toContain("TypeScript");
  });

  it("invalidates completed cards so their current display preference redraws immediately", async () => {
    // This test awaits real event-loop turns for the refresh drain, so it
    // opts out of the file-wide fake timers (its assertions never compare
    // spinner frames across renders).
    vi.useRealTimers();
    const flushDrainTurns = async (turns: number): Promise<void> => {
      for (let index = 0; index < turns; index++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    const state = stateFor("full");
    const display = new FabricToolDisplayController();
    const tool = toolFor(state, display);
    const args = { code: "const currentPresentation = true;" };
    const context = renderContext(args);
    const resultContext = renderContext(args);
    const result = {
      content: [] as Array<{ type: "text"; text: string }>,
      details: { success: true, audits: [], phases: [] },
    };

    const full = tool.renderCall!(args as never, plainTheme, context as never).render(120).join("\n");
    const fullResult = tool.renderResult!(
      result as never,
      { expanded: false, isPartial: false },
      plainTheme,
      resultContext as never,
    ).render(120).join("\n");
    (state.config.ui as { toolDisplay: "full" | "compact" }).toolDisplay = "compact";
    display.refresh();
    const compact = tool.renderCall!(args as never, plainTheme, context as never).render(120).join("\n");
    const compactResult = tool.renderResult!(
      result as never,
      { expanded: false, isPartial: false },
      plainTheme,
      resultContext as never,
    ).render(120).join("\n");

    // refresh() drains asynchronously and invalidates once per card: both
    // kinds resolve to the same host component, whose invalidate() re-renders
    // call and result together, so firing both would double the render work.
    await flushDrainTurns(2);
    expect(full).toContain("currentPresentation");
    expect(fullResult).toContain("Fabric");
    expect(resultContext.invalidate).toHaveBeenCalledOnce();
    expect(context.invalidate).not.toHaveBeenCalled();
    expect(compact).not.toContain("currentPresentation");
    expect(compactResult).toContain("Evaluated");

    // Switching back to full re-renders the same historical cards and restores
    // the TypeScript presentation for both the call and the result component.
    (state.config.ui as { toolDisplay: "full" | "compact" }).toolDisplay = "full";
    display.refresh();
    await flushDrainTurns(2);
    const fullAgain = tool.renderCall!(args as never, plainTheme, context as never).render(120).join("\n");
    const fullResultAgain = tool.renderResult!(
      result as never,
      { expanded: false, isPartial: false },
      plainTheme,
      resultContext as never,
    ).render(120).join("\n");

    expect(resultContext.invalidate).toHaveBeenCalledTimes(2);
    expect(context.invalidate).not.toHaveBeenCalled();
    expect(fullAgain).toContain("currentPresentation");
    expect(fullResultAgain).toContain("Fabric");
    expect(fullResultAgain).not.toContain("Evaluated");
  });
});
