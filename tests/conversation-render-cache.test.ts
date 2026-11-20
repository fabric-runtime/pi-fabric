import "./fixtures/conversation-host.js";
import {
  AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, initTheme, type Theme,
} from "@earendil-works/pi-coding-agent";
import { createInteractiveTuiReference } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/tui-renderer.js";
import { stripTerminalSequences, Text, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FabricConversationTranscriptRenderer, type FabricConversationTranscriptRenderOptions,
  type FabricConversationTranscriptRendererOptions,
} from "../src/ui/conversation-render.js";
import type { NativeAgentMessage, NativeToolExecution } from "../src/ui/conversation-native-reader.js";
import { defaultCodePreviewSettings } from "../src/ui/code-preview.js";
import type { JsonObject } from "@earendil-works/pi-ai";
import { assistantMessage, nativeTranscript, userMessage } from "./fixtures/native-conversation.js";

const highlighting = vi.hoisted(() => ({ ready: false, invalidate: undefined as (() => void) | undefined }));
vi.mock("../src/ui/highlight.js", () => ({
  highlightCode: (code: string, _language: string, invalidate: () => void) => {
    highlighting.invalidate = invalidate;
    return highlighting.ready ? [`highlighted:${code}`] : null;
  },
}));

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text, italic: (text: string) => text,
  underline: (text: string) => text, strikethrough: (text: string) => text,
} as unknown as Theme;
const options: FabricConversationTranscriptRenderOptions = {
  target: { id: "child", name: "Child", kind: "agent", status: "running", cwd: "/repo/child",
    canSteer: true, canFollowUp: true, canStop: true },
  toolsExpanded: false, outputPad: 1,
};
const renderers: FabricConversationTranscriptRenderer[] = [];
const setup = (settings: FabricConversationTranscriptRendererOptions = {}) => {
  const requestRender = vi.fn();
  const host = { requestRender } as unknown as TUI;
  // Pi supplies this live write-through reference, not the bare renderer.
  const tui = createInteractiveTuiReference(() => host);
  const renderer = new FabricConversationTranscriptRenderer(tui, theme, settings);
  renderers.push(renderer);
  return { renderer, requestRender };
};
const text = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
const call = (id: string, args: Record<string, unknown> = { command: "echo fixture" }) => ({
  type: "toolCall" as const, id, name: "fixture",
  // Serialization probe: a non-JSON `toJSON` value is supplied on purpose.
  arguments: args as JsonObject,
});
const result = (id: string, output: string): Extract<NativeAgentMessage, { role: "toolResult" }> => ({
  role: "toolResult", toolCallId: id, toolName: "fixture", timestamp: 1,
  content: [{ type: "text", text: output }], isError: false,
});
const tool = (id: string, output?: string): NativeToolExecution => ({
  toolCallId: id, toolName: "fixture", args: { command: "echo fixture" },
  status: output === undefined ? "running" : "completed",
  ...(output === undefined ? {} : { result: { content: [{ type: "text", text: output }] } }),
});

beforeEach(() => {
  vi.useFakeTimers();
  initTheme("dark", false);
  highlighting.ready = false;
  highlighting.invalidate = undefined;
});
afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("conversation renderer retained-row cache", () => {
  it("keeps tool callbacks local with Pi's write-through TUI reference and follows renderer swaps", () => {
    const firstRender = vi.fn();
    const secondRender = vi.fn();
    const first = { requestRender: firstRender, terminal: { columns: 80 }, mode: "regular" };
    const second = { requestRender: secondRender, terminal: { columns: 120 }, mode: "fullscreen" };
    let active = first;
    const tui = createInteractiveTuiReference(() => active as unknown as TUI);
    const renderer = new FabricConversationTranscriptRenderer(tui, theme);
    renderers.push(renderer);
    const handles: TUI[] = [];
    const update = ToolExecutionComponent.prototype.updateResult;
    vi.spyOn(ToolExecutionComponent.prototype, "updateResult").mockImplementation(function (this: ToolExecutionComponent, value, partial) {
      handles.push((this as unknown as { ui: TUI }).ui);
      return update.call(this, value, partial);
    });
    const transcript = nativeTranscript([], { streaming: { active: false, tools: [tool("one", "first result"), tool("two", "second result")] } });
    expect(text(renderer.render(transcript, 80, options))).toContain("second result");
    expect(first.requestRender).toBe(firstRender);
    const [one, two] = handles;
    expect(one).not.toBe(two);
    expect(Object.hasOwn(one!, "requestRender")).toBe(true);
    expect(Object.hasOwn(two!, "requestRender")).toBe(true);
    const renders = vi.spyOn(ToolExecutionComponent.prototype, "render");
    firstRender.mockClear();
    one!.requestRender();
    expect(firstRender).toHaveBeenCalledTimes(1);
    renderer.render(transcript, 80, options);
    expect(renders).toHaveBeenCalledTimes(1);
    two!.requestRender();
    expect(firstRender).toHaveBeenCalledTimes(2);
    expect(firstRender.mock.contexts.every((context) => context === first)).toBe(true);

    active = second;
    firstRender.mockClear();
    one!.requestRender();
    two!.requestRender();
    expect(firstRender).not.toHaveBeenCalled();
    expect(secondRender).toHaveBeenCalledTimes(2);
    expect(second.requestRender).toBe(secondRender);
    expect(secondRender.mock.contexts.every((context) => context === second)).toBe(true);
    expect(one!.terminal.columns).toBe(120);
    expect(one!.mode).toBe("fullscreen");

    renderer.dispose();
    secondRender.mockClear();
    one!.requestRender();
    two!.requestRender();
    expect(secondRender).not.toHaveBeenCalled();
    expect(second.requestRender).toBe(secondRender);
  });

  it("does no historical native work or content serialization on warm 1024-message frames beyond both former limits", () => {
    const { renderer } = setup();
    const serialize = vi.fn(() => "payload");
    const messages: NativeAgentMessage[] = [];
    for (let i = 0; i < 256; i++) {
      const assistant = assistantMessage(`**answer ${i}**`, i);
      assistant.content.push(call(`call-${i}`, { payload: { toJSON: serialize } }));
      messages.push(userMessage(`question ${i}`, i), assistant, result(`call-${i}`, `result-${i}`),
        assistantMessage(`followup ${i}`, i));
    }
    const transcript = nativeTranscript(messages);
    const cold = renderer.render(transcript, 100, options);
    const update = vi.spyOn(AssistantMessageComponent.prototype, "updateContent");
    const assistants = vi.spyOn(AssistantMessageComponent.prototype, "render");
    const users = vi.spyOn(UserMessageComponent.prototype, "render");
    const tools = vi.spyOn(ToolExecutionComponent.prototype, "render");
    const results = vi.spyOn(ToolExecutionComponent.prototype, "updateResult");
    const expanded = vi.spyOn(ToolExecutionComponent.prototype, "setExpanded");
    serialize.mockClear();
    expect(renderer.render(transcript, 100, options)).toEqual(cold);
    expect(renderer.render({ ...transcript, status: "idle" }, 100, options)).toEqual(cold);
    expect(update).not.toHaveBeenCalled();
    expect(assistants).not.toHaveBeenCalled();
    expect(users).not.toHaveBeenCalled();
    expect(tools).not.toHaveBeenCalled();
    expect(results).not.toHaveBeenCalled();
    expect(expanded).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
    const next = nativeTranscript([...messages, assistantMessage("appended", 999)]);
    expect(text(renderer.render(next, 100, options))).toContain("appended");
    expect(update).toHaveBeenCalledTimes(1);
    expect(assistants).toHaveBeenCalledTimes(1);
    expect(users).not.toHaveBeenCalled();
    expect(tools).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
  });

  it("updates changed objects with constant revision and colliding timestamps without poisoning returned arrays", () => {
    const { renderer } = setup();
    const first = assistantMessage("first", 1);
    const second = assistantMessage("second", 1);
    const transcript = nativeTranscript([first, second]);
    const cold = renderer.render(transcript, 80, options);
    cold.fill("caller mutated output");
    expect(text(renderer.render(transcript, 80, options))).toContain("first");
    transcript.messages[1] = assistantMessage("replacement", 1);
    const update = vi.spyOn(AssistantMessageComponent.prototype, "updateContent");
    const changed = text(renderer.render(transcript, 80, options));
    expect(changed).toContain("first");
    expect(changed).toContain("replacement");
    expect(changed).not.toContain("second");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("couples results before emitting their call, updates only the affected tool, and clears removed results", () => {
    const { renderer } = setup();
    const assistant = assistantMessage("calling");
    assistant.content.push(call("same"));
    const transcript = nativeTranscript([assistant, result("same", "initial result")]);
    expect(text(renderer.render(transcript, 80, options))).toContain("initial result");
    const update = vi.spyOn(AssistantMessageComponent.prototype, "updateContent");
    const updateResult = vi.spyOn(ToolExecutionComponent.prototype, "updateResult");
    const updated = nativeTranscript([assistant, result("same", "changed result")]);
    const lines = text(renderer.render(updated, 80, options));
    expect(lines).toContain("changed result");
    expect(lines).not.toContain("initial result");
    expect(update).not.toHaveBeenCalled();
    expect(updateResult).toHaveBeenCalledTimes(1);
    expect(text(renderer.render(nativeTranscript([assistant]), 80, options))).not.toContain("changed result");
    expect(text(renderer.render(transcript, 80, options))).toContain("initial result");
  });

  it("does not mistake opaque result details with identical JSON for unchanged tool content", () => {
    const seen: unknown[] = [];
    const { renderer } = setup({ getToolDefinition: () => ({
      renderResult: (value: any) => {
        seen.push(value.details);
        return new Text(value.details.get("label"), 0, 0);
      },
    }) });
    const initial = new Map([["label", "first opaque state"]]);
    const changed = new Map([["label", "second opaque state"]]);
    const execution = tool("opaque", "same text");
    const frame = (details: Map<string, string>) => nativeTranscript([], {
      streaming: { active: false, tools: [{ ...execution, result: { ...execution.result!, details } }] },
    });
    expect(text(renderer.render(frame(initial), 80, options))).toContain("first opaque state");
    expect(text(renderer.render(frame(changed), 80, options))).toContain("second opaque state");
    expect(seen.at(-1)).toBe(changed);
  });

  it("updates streaming executions even when a historical assistant already owns the call row", () => {
    const { renderer } = setup();
    const assistant = assistantMessage("working");
    assistant.content.push(call("shared"));
    const running = { ...tool("shared"), partial: { content: [{ type: "text", text: "partial output" }] } };
    const first = nativeTranscript([assistant], { streaming: { active: true, tools: [running] } });
    expect(text(renderer.render(first, 80, options))).toContain("partial output");
    const update = vi.spyOn(AssistantMessageComponent.prototype, "updateContent");
    const next = { ...first, streaming: { active: false, tools: [tool("shared", "finished output")] } };
    const lines = text(renderer.render(next, 80, options));
    expect(lines).toContain("finished output");
    expect(lines).not.toContain("partial output");
    expect(lines.split("\n").filter((line) => line.trim() === "fixture")).toHaveLength(1);
    expect(update).not.toHaveBeenCalled();
  });

  it("transitions pending partial calls through args completion and error-only changes", () => {
    const contexts: Array<{ executionStarted: boolean; argsComplete: boolean; isError: boolean }> = [];
    const { renderer } = setup({ getToolDefinition: () => ({
      renderCall: (_args: unknown, _theme: Theme, context: any) => {
        contexts.push(context);
        return new Text(`${context.args?.command}:${context.isError}`, 0, 0);
      },
    }) });
    const partial = assistantMessage("");
    partial.content.push(call("pending", { command: "first" }));
    renderer.render(nativeTranscript([], { streaming: { active: true, partialAssistant: partial, tools: [] } }), 80, options);
    expect(contexts.at(-1)?.executionStarted).toBe(false);
    const changed = { ...partial, content: [call("pending", { command: "second" })] };
    const started = { ...tool("pending", "done"), args: { command: "second" }, argsComplete: true };
    const transcript = nativeTranscript([], { streaming: { active: true, partialAssistant: changed, tools: [started] } });
    const lines = text(renderer.render(transcript, 80, options));
    expect(lines).toContain("second:false");
    expect(lines).not.toContain("first");
    expect(contexts.at(-1)?.argsComplete).toBe(true);
    expect(contexts.at(-1)?.executionStarted).toBe(true);
    const failed = { ...transcript, streaming: { active: false, tools: [{ ...started, isError: true }] } };
    expect(text(renderer.render(failed, 80, options))).toContain("second:true");
  });

  it("preserves full native rows across width, thinking, expansion, padding, and mutable preview options", () => {
    const { renderer } = setup();
    const assistant = assistantMessage("```ts\nconst x = 1;\n```\n" + "界".repeat(50));
    assistant.content.unshift({ type: "thinking", thinking: "private reasoning" });
    assistant.content.push(call("call"));
    const transcript = nativeTranscript([userMessage("**hello**"), assistant, result("call", "output")], { hasMore: true });
    renderer.render(transcript, 80, options);
    const preview = defaultCodePreviewSettings();
    for (const width of [31, 100]) {
      for (const hideThinking of [true, false]) {
        const changed = { ...options, hideThinking, toolsExpanded: true, outputPad: 0 as const,
          codeBlockIndent: "  ", codePreviewSettings: preview, showImages: false };
        const actual = renderer.render(transcript, width, changed);
        expect(actual).toEqual(setup().renderer.render(transcript, width, changed));
        expect(text(actual).includes("private reasoning")).toBe(!hideThinking);
        preview.readCollapsedLines += 1;
        expect(renderer.render(transcript, width, changed)).toEqual(setup().renderer.render(transcript, width, changed));
      }
    }
    const updates = vi.spyOn(AssistantMessageComponent.prototype, "updateContent");
    renderer.render(transcript, 91, { ...options, toolsExpanded: true });
    updates.mockClear();
    renderer.render(transcript, 92, { ...options, toolsExpanded: true });
    expect(updates).not.toHaveBeenCalled();
  });

  it("refreshes custom components on warm frames without touching static historical assistants", () => {
    let tick = 0;
    const { renderer } = setup({ getMessageRenderer: () => () => ({
      render: () => [`custom tick ${tick}`], invalidate: () => {},
    }), getToolDefinition: () => ({ renderCall: () => ({
      render: () => [`tool tick ${tick}`], invalidate: () => {},
    }) }) });
    const transcript = nativeTranscript([assistantMessage("historical"), {
      role: "custom", customType: "clock", timestamp: 1, content: "", display: true,
    }], { streaming: { active: false, tools: [tool("dynamic", "done")] } });
    renderer.render(transcript, 80, options);
    const updates = vi.spyOn(AssistantMessageComponent.prototype, "updateContent");
    tick++;
    const lines = text(renderer.render(transcript, 80, options));
    expect(lines).toContain("custom tick 1");
    expect(lines).toContain("tool tick 1");
    expect(updates).not.toHaveBeenCalled();
  });

  it("borrows stable immutable frames and preserves defensive copies across dynamic updates", () => {
    let output = Object.freeze(["dynamic first"]);
    const dynamicRender = vi.fn(() => output);
    const { renderer } = setup({ getMessageRenderer: () => () => ({ render: dynamicRender, invalidate() {} }) });
    const transcript = nativeTranscript([{ role: "custom", customType: "mutable", timestamp: 1, content: "", display: true }]);
    const first = renderer.render(transcript, 80, options, "borrow");
    for (let i = 0; i < 20; i++) expect(renderer.render(transcript, 80, options, "borrow")).toBe(first);
    expect(dynamicRender).toHaveBeenCalledTimes(21);
    const mutable = renderer.render(transcript, 80, options);
    mutable.fill("corrupted copy");
    expect(renderer.render(transcript, 80, options, "borrow")).toBe(first);
    expect(first.join("\n")).not.toContain("corrupted copy");
    // Pi 1.6 containers use the child array identity to detect row changes.
    output = Object.freeze(["dynamic second"]);
    const second = renderer.render(transcript, 80, options, "borrow");
    expect(second).not.toBe(first);
    expect(second.join("\n")).toContain("dynamic second");
    expect(first.join("\n")).toContain("dynamic first");
    renderer.invalidate();
    expect(renderer.render(transcript, 80, options, "borrow")).not.toBe(second);
  });

  it("invalidates live callback rows and guards callbacks/timers on options, target switches, eviction, and disposal", () => {
    let tick = 0;
    const invalidations: Array<() => void> = [];
    const { renderer, requestRender } = setup({ getToolDefinition: () => ({
      renderCall: (_args: unknown, _theme: Theme, context: any) => {
        invalidations.push(context.invalidate);
        context.state.codePreviewTimingInterval ??= setInterval(context.invalidate, 100);
        return new Text(`callback tick ${tick}`, 0, 0);
      },
    }) });
    const transcript = nativeTranscript([], { streaming: { active: true, tools: [tool("timer")] } });
    renderer.render(transcript, 80, options);
    const old = invalidations.at(-1)!;
    tick++;
    old();
    expect(text(renderer.render(transcript, 80, options))).toContain("callback tick 1");
    renderer.render(transcript, 80, { ...options, toolsExpanded: true });
    requestRender.mockClear();
    old();
    expect(requestRender).not.toHaveBeenCalled();
    const beforeTarget = invalidations.at(-1)!;
    renderer.render(transcript, 80, { ...options, target: { ...options.target, id: "other" } });
    requestRender.mockClear();
    beforeTarget();
    expect(requestRender).not.toHaveBeenCalled();
    const beforeEviction = invalidations.at(-1)!;
    renderer.render(nativeTranscript(), 80, options);
    requestRender.mockClear();
    beforeEviction();
    vi.advanceTimersByTime(300);
    expect(requestRender).not.toHaveBeenCalled();
    renderer.render(transcript, 80, options);
    const beforeDispose = invalidations.at(-1)!;
    renderer.dispose();
    requestRender.mockClear();
    beforeDispose();
    vi.advanceTimersByTime(300);
    expect(requestRender).not.toHaveBeenCalled();
    expect(renderer.render(transcript, 80, options)).toEqual([]);
  });

  it("does not reuse same-call components across same-source activation files or changed images", () => {
    const uiHandles: TUI[] = [];
    const update = ToolExecutionComponent.prototype.updateResult;
    vi.spyOn(ToolExecutionComponent.prototype, "updateResult").mockImplementation(function (this: ToolExecutionComponent, value, partial) {
      uiHandles.push((this as unknown as { ui: TUI }).ui);
      return update.call(this, value, partial);
    });
    const { renderer, requestRender } = setup();
    const image = (data: string): NativeToolExecution => ({ ...tool("image", ""), result: {
      content: [{ type: "image", mimeType: "image/png", data }, { type: "text", text: data }],
    } });
    const first = nativeTranscript([], { eventsFile: "/activation-1", streaming: { active: false, tools: [image("first")] } });
    renderer.render(first, 80, options);
    const old = uiHandles.at(-1)!;
    const second = { ...first, streaming: { active: false, tools: [image("second")] } };
    expect(text(renderer.render(second, 80, options))).toContain("second");
    expect(uiHandles.at(-1)).not.toBe(old);
    requestRender.mockClear();
    old.requestRender();
    expect(requestRender).not.toHaveBeenCalled();
    const current = uiHandles.at(-1)!;
    current.requestRender();
    expect(requestRender).toHaveBeenCalledTimes(1);
    renderer.render({ ...second, eventsFile: "/activation-2" }, 80, options);
    requestRender.mockClear();
    current.requestRender();
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("reuses more than 128 completed streaming tools and updates just one changed result", () => {
    const { renderer } = setup();
    const tools = Array.from({ length: 160 }, (_, i) => tool(`tool-${i}`, `result-${i}`));
    const transcript = nativeTranscript([], { streaming: { active: false, tools } });
    renderer.render(transcript, 80, options);
    const results = vi.spyOn(ToolExecutionComponent.prototype, "updateResult");
    const renders = vi.spyOn(ToolExecutionComponent.prototype, "render");
    const args = vi.spyOn(ToolExecutionComponent.prototype, "updateArgs");
    renderer.render(transcript, 80, options);
    expect(results).not.toHaveBeenCalled();
    expect(renders).not.toHaveBeenCalled();
    tools[80] = { ...tools[80]!, result: { content: [{ type: "text", text: "changed eighty" }] } };
    expect(text(renderer.render(transcript, 80, options))).toContain("changed eighty");
    expect(results).toHaveBeenCalledTimes(1);
    expect(renders).toHaveBeenCalledTimes(1);
    expect(args).not.toHaveBeenCalled();
  });

  it("honors content-version changes and finalizes the same partial object with native transformer context", () => {
    const settings: FabricConversationTranscriptRendererOptions = {
      markdownTransformers: [(markdown, context) => `${context.isStreaming ? "stream" : "final"}:${markdown}`],
    };
    const { renderer } = setup(settings);
    const assistant = assistantMessage("initial");
    const transcript = { ...nativeTranscript([assistant]), contentVersion: 1 };
    expect(text(renderer.render(transcript, 80, options))).toContain("final:initial");
    assistant.content = [{ type: "text", text: "changed" }];
    transcript.contentVersion++;
    expect(text(renderer.render(transcript, 80, options))).toContain("final:changed");
    const streaming = nativeTranscript([], { streaming: { active: true, partialAssistant: assistant, tools: [] } });
    expect(text(renderer.render(streaming, 80, options))).toContain("stream:changed");
    expect(text(renderer.render(nativeTranscript([assistant]), 80, options))).toContain("final:changed");
    settings.markdownTransformers = [(markdown) => `new-hook:${markdown}`];
    expect(text(renderer.render(transcript, 80, options))).toContain("new-hook:changed");
  });

  it("bounds strong caches to the retained window and releases all previous target message references", () => {
    const { renderer } = setup();
    const messages = Array.from({ length: 250 }, (_, index) => assistantMessage(`message-${index}`, index));
    renderer.render(nativeTranscript(messages), 80, options);
    const internals = renderer as unknown as {
      assistantComponents: Map<string, unknown>; messageRows: Map<NativeAgentMessage, unknown>;
      lastMessages: NativeAgentMessage[]; lastTools: NativeToolExecution[]; toolComponents: Map<string, unknown>;
    };
    expect(internals.assistantComponents.size).toBe(250);
    renderer.render(nativeTranscript([messages[249]!]), 80, options);
    expect(internals.assistantComponents.size).toBe(1);
    expect(internals.messageRows.size).toBe(1);
    renderer.render(nativeTranscript(), 80, { ...options, target: { ...options.target, id: "next" } });
    expect(internals.assistantComponents.size).toBe(0);
    expect(internals.messageRows.size).toBe(0);
    expect(internals.lastMessages).toEqual([]);
    expect(internals.lastTools).toEqual([]);
    expect(internals.toolComponents.size).toBe(0);
  });

  it("refreshes asynchronous highlighting and page hints without stale cached Markdown", () => {
    const { renderer, requestRender } = setup();
    const transcript = nativeTranscript([assistantMessage("```ts\nconst x = 1;\n```")]);
    expect(text(renderer.render(transcript, 80, options))).not.toContain("highlighted:");
    highlighting.ready = true;
    highlighting.invalidate!();
    expect(requestRender).toHaveBeenCalled();
    expect(text(renderer.render(transcript, 80, options))).toContain("highlighted:");
    const hinted = text(renderer.render({ ...transcript, hasMore: true, hasNewer: true }, 80, options));
    expect(hinted).toContain("older activity available");
    expect(hinted).toContain("newer activity available");
    const callback = highlighting.invalidate!;
    renderer.dispose();
    requestRender.mockClear();
    callback();
    expect(requestRender).not.toHaveBeenCalled();
  });
});
