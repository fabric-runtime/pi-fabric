import "./fixtures/conversation-host.js";
import {
  AssistantMessageComponent,
  initTheme,
  ToolExecutionComponent,
  UserMessageComponent,
  type Theme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Text, stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFabricPersistedExecutionDetails } from "../src/audit/index.js";
import { FabricExecutionTraceRecorder } from "../src/audit/trace.js";
import { createFabricExecTool } from "../src/fabric-exec-tool.js";
import type { FabricState } from "../src/fabric-state.js";
import { MainAgentController } from "../src/main-agent.js";
import { deliverActorFeedback } from "../src/actors/feedback.js";
import type { FabricActorDeliveryRequest } from "../src/actors/types.js";
import { defaultCodePreviewSettings } from "../src/ui/code-preview.js";
import {
  FabricConversationTranscriptRenderer,
  type FabricConversationTranscriptRenderOptions,
  type FabricGetToolDefinition,
} from "../src/ui/conversation-render.js";
import type {
  NativeConversationTranscript,
  NativeToolExecution,
} from "../src/ui/conversation-native-reader.js";
import type { FabricConversationTarget } from "../src/ui/conversation.js";
import { initHighlighting } from "../src/ui/highlight.js";

// Spinner frames tick every 250ms; pin the clock so ANSI/wrap assertions are
// deterministic across GC pauses.
beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

const target: FabricConversationTarget = {
  id: "child", name: "Child", kind: "agent", status: "running", cwd: "/repo/child",
  canSteer: true, canFollowUp: true, canStop: true,
};
const tui = { requestRender: vi.fn() } as unknown as TUI;

const stateFor = (toolDisplay: "full" | "compact") =>
  ({
    bootstrapped: true,
    initialized: true,
    config: { ui: { showAgentToolPreview: true, toolDisplay } },
  }) as unknown as FabricState;

const fabricToolFor = (codePreviewSettings = defaultCodePreviewSettings()) =>
  createFabricExecTool(stateFor("full"), codePreviewSettings, new Map(), (tool) => tool);

const makeTranscript = (overrides: {
  messages?: NativeConversationTranscript["messages"];
  tools?: NativeToolExecution[];
  partialAssistant?: AssistantMessage;
  hasMore?: boolean;
} = {}): NativeConversationTranscript => ({
  messages: overrides.messages ?? [],
  entries: [],
  streaming: {
    active: (overrides.tools?.length ?? 0) > 0 || overrides.partialAssistant !== undefined,
    ...(overrides.partialAssistant ? { partialAssistant: overrides.partialAssistant } : {}),
    tools: overrides.tools ?? [],
  },
  revision: 0,
  leafId: null,
  sourceId: target.id,
  status: target.status,
  historyComplete: true,
  hasMore: overrides.hasMore ?? false,
  hasNewer: false,
  updatedAt: 0,
});

const assistantMessage = (text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-responses",
  provider: "openai",
  model: "fixture",
  timestamp: 1,
  stopReason: "stop",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  ...extra,
});

const renderOptions = (
  overrides: Partial<FabricConversationTranscriptRenderOptions> = {},
): FabricConversationTranscriptRenderOptions => ({
  target,
  toolsExpanded: false,
  outputPad: 1,
  ...overrides,
});

const render = (
  renderer: FabricConversationTranscriptRenderer,
  transcript: NativeConversationTranscript,
  width = 80,
  options: Partial<FabricConversationTranscriptRenderOptions> = {},
) => renderer.render(transcript, width, renderOptions(options));

const plain = (lines: string[]) => lines.map(stripTerminalSequences);

describe("focused conversation native component rendering", () => {
  it.each(["agent", "actor"] as const)("projects hidden %s feedback like Main's notification without exposing its payload", (kind) => {
    initTheme("dark", false);
    const sendMessage = vi.fn();
    const notify = vi.fn();
    const pi = { sendMessage } as unknown as ExtensionAPI;
    const context = { hasUI: true, ui: { notify } } as unknown as ExtensionContext;
    const text = "Review <result> & &lt;verify&gt;\n\x1b[31mcarefully\x1b[0m " + "x".repeat(500);
    if (kind === "agent") {
      new MainAgentController(pi, "main", true, "/repo", "session", context).deliverAgent({
        from: { id: "reviewer", name: "Reviewer", kind: "agent" }, message: text,
        data: { secret: "never display structured data" }, delivery: "steer",
      });
    } else {
      deliverActorFeedback(pi, context, {
        actor: { id: "reviewer", name: "Reviewer" },
        message: { id: "out-1", text, data: { secret: "never display structured data" } },
        delivery: "steer", triggerTurn: true,
      } as FabricActorDeliveryRequest);
    }
    const sent = sendMessage.mock.calls[0]![0];
    const message = { ...sent, role: "custom" as const, timestamp: 5 };
    const renderer = new FabricConversationTranscriptRenderer(tui, theme);
    const frame = render(renderer, makeTranscript({ messages: [message] }), 60);
    const expected = new Text(theme.fg("dim", notify.mock.calls[0]![0]), 1, 0).render(60);
    expect(frame).toEqual(expected);
    expect(frame.join("\n")).not.toMatch(/never display|fabric-agent-message|fabric-actor|<data>/);
    expect(sent.display).toBe(false);
    expect(sent.content).toContain("never display structured data");
    renderer.dispose();
  });

  it("keeps unrelated hidden messages out of the participant view", () => {
    const renderer = new FabricConversationTranscriptRenderer(tui, theme);
    const frame = render(renderer, makeTranscript({ messages: [{
      role: "custom", customType: "private-extension", display: false,
      content: "private text", details: { from: { name: "Impostor" } }, timestamp: 5,
    }] }));
    expect(frame).toEqual([]);
    renderer.dispose();
  });

  it("dispatches user and assistant messages through the exact native components with native spacing", () => {
    initTheme("dark", false);
    const renderer = new FabricConversationTranscriptRenderer(tui, theme);
    const lines = render(renderer, makeTranscript({
      messages: [
        { role: "user", content: "Please inspect **the result**.", timestamp: 1 },
        assistantMessage("A **normal Pi** response."),
      ],
    }), 80);
    const nativeUser = new UserMessageComponent("Please inspect **the result**.", undefined, 1).render(80);
    const nativeAssistant = new AssistantMessageComponent(assistantMessage("A **normal Pi** response."), false, undefined, undefined, 1).render(80);
    // Native rows in native order — no glyph/heading. The user card begins
    // with its own padded background rows; no extra spacer at transcript start.
    expect(plain(lines)).toEqual([...plain(nativeUser), ...plain(nativeAssistant)]);
    expect(lines.join("\n")).not.toContain("Agent");
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("honors the thinking toggle via hideThinking", () => {
    initTheme("dark", false);
    const renderer = new FabricConversationTranscriptRenderer(tui, theme);
    const message = assistantMessage("Answer");
    message.content = [
      { type: "thinking", thinking: "secret reasoning" } as never,
      { type: "text", text: "Answer" },
    ];
    const transcript = makeTranscript({ messages: [message] });
    const shown = plain(render(renderer, transcript, 80, { hideThinking: false })).join("\n");
    const hidden = plain(render(renderer, transcript, 80, { hideThinking: true })).join("\n");
    expect(shown).toContain("secret reasoning");
    expect(hidden).not.toContain("secret reasoning");
    expect(hidden).toContain("Answer");
  });

  it("renders fabric_exec through the actual registered callbacks with native tool card parity", async () => {
    initTheme("dark", false);
    await initHighlighting("dark-plus", true);
    const fabricTool = fabricToolFor();
    const getToolDefinition: FabricGetToolDefinition = (name) =>
      name === "fabric_exec" ? fabricTool : undefined;
    const renderer = new FabricConversationTranscriptRenderer(tui, theme, { getToolDefinition });
    const args = {
      code: "const result = await pi.read({ path: \"src/example.ts\" });\nreturn result;",
      display: { name: "Inspect example" },
    };
    const tool: NativeToolExecution = {
      toolCallId: "call-1", toolName: "fabric_exec", args, status: "completed",
      result: { content: [{ type: "text", text: "done" }], details: {} }, isError: false,
    };
    const lines = render(renderer, makeTranscript({ tools: [tool] }), 80);
    const text = lines.join("\n");
    expect(text).toContain("Inspect example");
    expect(text).toContain("const result = await pi.read");
    // Same rows as constructing the native component like interactive-mode does.
    // Do not assert a terminal color depth: the TUI adapts ANSI output to the
    // runner capability, while highlight.test.ts covers Shiki truecolor itself.
    const native = new ToolExecutionComponent(
      "fabric_exec", "call-1", args,
      { showImages: true, imageWidthCells: 60 },
      fabricTool, tui, target.cwd ?? process.cwd(),
    );
    native.markExecutionStarted();
    native.setArgsComplete();
    native.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
    expect(plain(lines)).toEqual(plain(native.render(80)));
  }, 15000);

  it("passes full persisted execution details through to renderResult for partial and final updates", async () => {
    initTheme("dark", false);
    await initHighlighting("dark-plus", true);
    const fabricTool = fabricToolFor();
    const renderResult = vi.fn(fabricTool.renderResult!);
    const wrapped = { ...fabricTool, renderResult };
    const renderer = new FabricConversationTranscriptRenderer(tui, theme, {
      getToolDefinition: (name) => (name === "fabric_exec" ? wrapped : undefined),
    });
    const args = { code: "return await pi.bash({ command: \"echo hi\" });" };
    const recorder = new FabricExecutionTraceRecorder();
    const partialDetails = createFabricPersistedExecutionDetails({
      success: true,
      trace: recorder.seal("succeeded", [], "partial"),
      audits: [{ ref: "pi.bash", provider: "pi", tool: "bash", args: { command: "echo hi" } }],
    });
    const finalRecorder = new FabricExecutionTraceRecorder();
    const finalDetails = createFabricPersistedExecutionDetails({
      success: true,
      trace: finalRecorder.seal("succeeded", [], "final"),
      audits: [{ ref: "pi.bash", provider: "pi", tool: "bash", args: { command: "echo hi" }, success: true, result: "hi" }],
    });
    const running: NativeToolExecution = {
      toolCallId: "call-2", toolName: "fabric_exec", args, status: "running", partial: { details: partialDetails },
    };
    render(renderer, makeTranscript({ tools: [running] }), 100);
    const finished: NativeToolExecution = {
      toolCallId: "call-2", toolName: "fabric_exec", args, status: "completed",
      result: { content: [{ type: "text", text: "hi" }], details: finalDetails }, isError: false,
    };
    render(renderer, makeTranscript({ tools: [finished] }), 100);
    const calls = renderResult.mock.calls;
    const partialCall = calls.find(([, options]) => options.isPartial === true);
    const finalCall = calls.find(([, options]) => options.isPartial === false);
    expect(partialCall?.[0].details).toEqual(partialDetails);
    expect(finalCall?.[0].details).toEqual(finalDetails);
    // No redaction or cloning en route: the persisted details pass through verbatim.
    expect(finalCall?.[0].details).toBe(finalDetails);
  }, 15000);

  it("does not cap expanded tool output at 40 lines", () => {
    initTheme("dark", false);
    const longOutput = Array.from({ length: 61 }, (_unused, index) => `line-${index + 1}`).join("\n");
    const definition = {
      renderCall: (args: any) => new Text(String((args as { marker: string }).marker), 0, 0) as never,
      renderResult: (result: any, options: any): never => {
        const text = (result.content as Array<{ text?: string }>).map((block) => block.text ?? "").join("\n");
        const lines = options.expanded ? text.split("\n") : text.split("\n").slice(0, 10);
        return new Text(lines.join("\n"), 0, 0) as never;
      },
    };
    const renderer = new FabricConversationTranscriptRenderer(tui, theme, {
      getToolDefinition: () => definition,
    });
    const tool: NativeToolExecution = {
      toolCallId: "call-3", toolName: "verbose_tool", args: { marker: "verbose" }, status: "completed",
      result: { content: [{ type: "text", text: longOutput }], details: {} }, isError: false,
    };
    const lines = render(renderer, makeTranscript({ tools: [tool] }), 120, { toolsExpanded: true });
    const text = plain(lines).join("\n");
    expect(text).toContain("line-1");
    expect(text).toContain("line-40");
    expect(text).toContain("line-61");
  });

  it("keeps tool backgrounds full width at the rightmost cell, including wrapped wide characters", () => {
    initTheme("dark", false);
    const wide = "界界界界界界界界界界界界界界界界界界界界";
    const tool: NativeToolExecution = {
      toolCallId: "call-4", toolName: "fabric_exec",
      args: { code: `${wide}\nconst padded = "${wide}${wide}";` }, status: "running",
    };
    const fabricTool = fabricToolFor({ ...defaultCodePreviewSettings(), toolCallBackground: "on" });
    const renderer = new FabricConversationTranscriptRenderer(tui, theme, {
      getToolDefinition: (name) => (name === "fabric_exec" ? fabricTool : undefined),
    });
    const width = 60;
    const lines = render(renderer, makeTranscript({ tools: [tool] }), width);
    expect(lines.length).toBeGreaterThan(0);
    // Leading/trailing empty rows are the native card Spacer(1)/padding; every
    // painted row must fill the full width with background to the last cell.
    const paintedRows = lines.filter((row) => row.length > 0);
    for (const row of paintedRows) {
      // Every card row fills the terminal width exactly…
      expect(visibleWidth(row)).toBe(width);
      // …its background spans the whole painted line…
      expect(row).toMatch(/\x1b\[48;5;\d+m|\x1b\[48;2;[\d;]+m/);
      // …and the rightmost cell is a bg-styled padding space inside the
      // background reset, never a blank unstyled cell (the far-right gap
      // regression from the screenshot).
      expect(row.endsWith(" \x1b[49m")).toBe(true);
      expect(row.endsWith("\x1b[49m ")).toBe(false);
    }
  });

  it("reuses one tool component per call across streaming frames without tool-call duplication", () => {
    initTheme("dark", false);
    const getToolDefinition = vi.fn(((name: string) =>
      name === "fabric_exec" ? {} : undefined) as FabricGetToolDefinition);
    const renderer = new FabricConversationTranscriptRenderer(tui, theme, { getToolDefinition });
    const partial: AssistantMessage = {
      ...assistantMessage("Working…"),
      content: [
        { type: "toolCall", id: "call-5", name: "fabric_exec", arguments: { code: "return 1;" } } as never,
      ],
    };
    const tool: NativeToolExecution = {
      toolCallId: "call-5", toolName: "fabric_exec", args: { code: "return 1;" }, status: "running",
    };
    const frame = (): string =>
      plain(render(renderer, makeTranscript({ partialAssistant: partial, tools: [tool] }), 80))
        .filter((line) => line.length > 0)
        .join("\n");
    const first = frame();
    const second = frame();
    expect(getToolDefinition).toHaveBeenCalledTimes(1); // component reused, not recreated
    expect(second).toBe(first);
    expect(first.split("fabric_exec").length).toBe(2); // exactly one card title
  });

  it("isolates the component cache between targets with identical tool call ids", () => {
    initTheme("dark", false);
    const renderer = new FabricConversationTranscriptRenderer(tui, theme, {
      getToolDefinition: () => undefined, // native generic card path
    });
    const toolA: NativeToolExecution = {
      toolCallId: "shared-call", toolName: "bash", args: { command: "echo target-A" }, status: "completed",
      result: { content: [{ type: "text", text: "target-A" }], details: {} }, isError: false,
    };
    const first = plain(render(renderer, makeTranscript({ tools: [toolA] }), 100)).join("\n");
    expect(first).toContain("target-A");
    const toolB: NativeToolExecution = {
      toolCallId: "shared-call", toolName: "bash", args: { command: "echo target-B" }, status: "completed",
      result: { content: [{ type: "text", text: "target-B" }], details: {} }, isError: false,
    };
    const otherTarget = { ...target, id: "other" };
    const second = plain(renderer.render(
      makeTranscript({ tools: [toolB] }), 100,
      { target: otherTarget, toolsExpanded: false, outputPad: 1 },
    )).join("\n");
    expect(second).toContain("target-B");
    expect(second).not.toContain("target-A");
    // Back to the first target: its own cached component still renders A.
    const again = plain(render(renderer, makeTranscript({ tools: [toolA] }), 100)).join("\n");
    expect(again).toContain("target-A");
    expect(again).not.toContain("target-B");
  });

  it("renders live RPC-streamed messages, not only persisted session entries", () => {
    initTheme("dark", false);
    const renderer = new FabricConversationTranscriptRenderer(tui, theme);
    const transcript = makeTranscript({
      messages: [
        { role: "user", content: "streamed prompt", timestamp: 1 },
        assistantMessage("streamed answer"),
      ],
      partialAssistant: { ...assistantMessage("partial tail"), stopReason: "pending" } as AssistantMessage,
    });
    const text = plain(render(renderer, transcript, 80)).join("\n");
    expect(text).toContain("streamed prompt");
    expect(text).toContain("streamed answer");
    expect(text).toContain("partial tail");
  });

  it("after dispose, renders nothing and stray renderer invalidations become no-ops", async () => {
    initTheme("dark", false);
    await initHighlighting("dark-plus", true);
    let capturedInvalidate: (() => void) | undefined;
    const fabricTool = fabricToolFor();
    const wrapped = {
      ...fabricTool,
      renderCall: (args: any, toolTheme: Theme, context: any) => {
        capturedInvalidate = context.invalidate;
        return fabricTool.renderCall!(args, toolTheme, context);
      },
    };
    const renderer = new FabricConversationTranscriptRenderer(tui, theme, {
      getToolDefinition: (name) => (name === "fabric_exec" ? wrapped : undefined),
    });
    const tool: NativeToolExecution = {
      toolCallId: "call-6", toolName: "fabric_exec", args: { code: "return 1;" }, status: "running",
    };
    expect(render(renderer, makeTranscript({ tools: [tool] }), 80).length).toBeGreaterThan(0);
    expect(capturedInvalidate).toBeTypeOf("function");
    renderer.dispose();
    const renderCalls = vi.mocked(tui.requestRender).mock.calls.length;
    capturedInvalidate!(); // live spinner timer firing after dispose
    expect(vi.mocked(tui.requestRender).mock.calls.length).toBe(renderCalls);
    expect(renderer.render(makeTranscript({ tools: [tool] }), 80, renderOptions())).toEqual([]);
  }, 15000);
});
