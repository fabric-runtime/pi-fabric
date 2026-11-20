import "./fixtures/conversation-host.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, UserMessageComponent, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { conversationFooter, readConversationAppearance } from "../src/ui/conversation-chrome.js";
import { FabricConversationState, FabricConversationView, type FabricConversationTarget } from "../src/ui/conversation.js";
import { FabricConversationTranscriptRenderer } from "../src/ui/conversation-render.js";
import { initHighlighting } from "../src/ui/highlight.js";
import { nativeTranscript, userMessage, assistantMessage } from "./fixtures/native-conversation.js";

const theme = {
  fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text,
  bold: (text: string) => text, italic: (text: string) => text,
  underline: (text: string) => text, strikethrough: (text: string) => text,
} as unknown as Theme;
const target: FabricConversationTarget = {
  id: "child", name: "chat-test", kind: "actor", status: "idle", cwd: "/repo/child", branch: "feature/chat",
  model: "openai/child-model", thinking: "low", canSteer: true, canFollowUp: true, canStop: true,
  usage: { input: 1200, output: 400, cacheRead: 600, cacheWrite: 0, cost: 0.012 }, contextWindow: 128000,
};
const tui = { terminal: { rows: 22, columns: 120 }, requestRender: vi.fn() } as unknown as TUI;
const plain = (lines: readonly string[]) => lines.map(stripTerminalSequences);

describe("native conversation chrome", () => {
  it.each([0, 1] as const)("matches native user background width and padding (%s)", (outputPad) => {
    initTheme("dark", false);
    const renderer = new FabricConversationTranscriptRenderer(tui, theme);
    const lines = renderer.render(nativeTranscript([userMessage("Hello!")]), 80, { target, toolsExpanded: false, outputPad });
    const native = new UserMessageComponent("Hello!", undefined, outputPad).render(80);
    expect(plain(lines)).toEqual(plain(native));
    expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true);
  });

  it.each([0, 1] as const)("matches native assistant spacing without an Agent heading (%s)", (outputPad) => {
    initTheme("dark", false);
    const text = "A **normal Pi** response.";
    const message: AssistantMessage = {
      role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "fixture", timestamp: 0, stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const native = new AssistantMessageComponent(message, false, undefined, undefined, outputPad).render(80);
    const lines = new FabricConversationTranscriptRenderer(tui, theme).render(nativeTranscript([message]), 80, { target, toolsExpanded: false, outputPad });
    expect(plain(lines)).toEqual(plain(native));
    expect(plain(lines).join("\n")).not.toContain("Agent");
  });

  it("renders Shiki truecolor fences and native tool backgrounds", async () => {
    await initHighlighting("dark-plus", true);
    const bg = vi.fn((_color: string, text: string) => text);
    const renderer = new FabricConversationTranscriptRenderer(tui, { ...theme, bg } as unknown as Theme);
    const lines = renderer.render(nativeTranscript([
      assistantMessage("```typescript\nconst result = 42;\n```"),
      { ...assistantMessage("", 3), content: [{ type: "toolCall", id: "tool", name: "read", arguments: { path: "src/example.ts" } }] },
      { role: "toolResult", toolCallId: "tool", toolName: "read", content: [{ type: "text", text: "const result = 42;" }], isError: false, timestamp: 4 },
    ]), 80, { target, toolsExpanded: true, codeBlockIndent: "    " });
    expect(lines.join("\n")).toContain("\x1b[38;2;");
    expect(lines.some((line) => line.includes("\x1b[48;"))).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
    expect(plain(lines).find((line) => line.includes("const result"))).toMatch(/^ {5}/);
  }, 15000);

  it("keeps editor rules full width and the child footer below the editor", () => {
    const state = new FabricConversationState();
    state.view(target.id).draft = "draft";
    const view = new FabricConversationView(tui, theme, {
      state, targets: () => [target], initialTargetId: target.id,
      appearance: { editorPaddingX: 2, outputPad: 1 },
      transcript: () => nativeTranscript(),
      loadOlder: () => false, loadNewer: () => false, loadLatest: () => false,
      send: vi.fn(), stop: vi.fn(), close: vi.fn(),
    });
    const lines = plain(view.render(120));
    const rules = lines.map((line, index) => ({ line, index })).filter(({ line }) => /^─/.test(line));
    expect(rules).toHaveLength(2);
    expect(rules.every(({ line }) => line.length === 120)).toBe(true);
    expect(lines.find((line) => line.includes("draft"))).toMatch(/^  draft/);
    const footerIndex = lines.findIndex((line) => line.includes("/repo/child (feature/chat)"));
    expect(footerIndex).toBeGreaterThan(rules[1]!.index);
    expect(lines[footerIndex + 1]).toContain("idle · ↑1.2k ↓400 R600 $0.012 · ?/128k ctx");
    expect(lines[footerIndex + 1]).toContain("?/128k ctx");
    expect(lines[footerIndex + 1]).toMatch(/\(openai\) child-model • low$/);
    view.dispose();
  });

  it("formats provider-qualified and bare models like Main without losing model subpaths", () => {
    expect(plain(conversationFooter({ ...target, model: "openai/gpt-6.1-sol", thinking: "high" }, theme, 140))[1])
      .toMatch(/\(openai\) gpt-6\.1-sol • high$/);
    expect(plain(conversationFooter({ ...target, model: "gateway/vendor/model", thinking: "off" }, theme, 140))[1])
      .toMatch(/\(gateway\) vendor\/model • thinking off$/);
    expect(plain(conversationFooter({ ...target, model: "local-model" }, theme, 140))[1])
      .toMatch(/local-model • low$/);
  });

  it("honors copy-on-select being disabled for footer selections", async () => {
    const copy = vi.fn(async (_text: string) => {});
    const view = new FabricConversationView(tui, theme, {
      state: new FabricConversationState(), targets: () => [target], initialTargetId: target.id,
      appearance: { editorPaddingX: 0, outputPad: 0, copyOnSelect: false },
      transcript: () => nativeTranscript(), loadOlder: () => false, loadNewer: () => false, loadLatest: () => false,
      copyToClipboard: copy, send: vi.fn(), stop: vi.fn(), close: vi.fn(),
    });
    try {
      const frame = plain(view.render(120));
      const y = frame.findIndex(line => line.includes("(openai) child-model"));
      const x = frame[y]!.indexOf("(openai)");
      const event = { button: "left" as const, x, y, screenX: x, screenY: y, width: 120, height: 22,
        shift: false, alt: false, ctrl: false };
      view.handleMouse({ ...event, type: "press" });
      view.handleMouse({ ...event, type: "release", x: x + 8 });
      expect(copy).not.toHaveBeenCalled();
      view.handleInput("\x03");
      await vi.waitFor(() => expect(copy).toHaveBeenCalledWith("(openai)"));
    } finally { view.dispose(); }
  });

  it("keeps the draft cursor visible in a one-row terminal", () => {
    const state = new FabricConversationState();
    state.view(target.id).draft = "visible draft";
    const view = new FabricConversationView({ ...tui, terminal: { rows: 1, columns: 40 } } as TUI, theme, {
      state, targets: () => [target], transcript: () => nativeTranscript(),
      loadOlder: () => false, loadNewer: () => false, loadLatest: () => false,
      send: vi.fn(), stop: vi.fn(), close: vi.fn(),
    });
    const lines = plain(view.render(40));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("visible draft");
    view.dispose();
  });

  it("shows a run's tokens, calls and time, and its status only once it settles", () => {
    const now = Date.now();
    const running = { ...target, kind: "agent" as const, status: "running", toolCalls: 12, startedAt: now - 184_000,
      usage: { input: 43_000, output: 2_200, cacheRead: 147_000, cacheWrite: 0, cost: 0.122 }, contextWindow: 272_000 };
    // While it runs, the border says Working; the line carries only what that does not.
    expect(stripTerminalSequences(conversationFooter(running, theme, 160)[1]!))
      .toMatch(/^↑43k ↓2\.2k R147k \$0\.122 · 12 calls · 3m0[45]s · \?\/272k ctx /);
    const settled = { ...running, status: "failed", toolCalls: 1, finishedAt: now - 120_000 };
    expect(stripTerminalSequences(conversationFooter(settled, theme, 160)[1]!))
      .toMatch(/^failed · ↑43k ↓2\.2k R147k \$0\.122 · 1 call · 1m04s · \?\/272k ctx /);
  });

  it("does not invent usage or current context occupancy", () => {
    const { usage: _usage, contextWindow: _context, ...unknown } = target;
    const lines = conversationFooter(unknown, theme, 120);
    expect(lines[1]).toContain("usage unavailable");
    expect(lines[1]).toContain("ctx ?");
    expect(lines[1]).not.toContain("$0");
    expect(lines[1]).not.toContain("0%");
    for (const width of [1, 2, 8, 30, 80, 120]) {
      expect(conversationFooter(target, theme, width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it("keeps read-only context in the existing path row, even when the path is long", () => {
    const readonly = { ...target, kind: "agent" as const, status: "completed",
      cwd: `/repo/${"long-directory/".repeat(12)}`, readOnlyReason: "Target finished (completed); one-shot runs are read-only" };
    for (const width of [1, 2, 8, 9, 12, 20, 80, 120]) {
      const lines = conversationFooter(readonly, theme, width);
      expect(lines).toHaveLength(2);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      if (width >= 9) expect(lines[0]).toContain("read-only");
      expect(lines[0]).not.toContain("Target finished");
    }
    expect(conversationFooter(target, theme, 120)[0]).not.toContain("read-only");
  });

  it("removes the redundant metadata header while retaining a border badge and footer stats", () => {
    const readonly = { ...target, kind: "agent" as const, status: "completed",
      readOnlyReason: "Target finished (completed); one-shot runs are read-only" };
    const render = vi.spyOn(FabricConversationTranscriptRenderer.prototype, "render").mockReturnValue(["history starts here"]);
    const view = new FabricConversationView(tui, theme, {
      state: new FabricConversationState(), targets: () => [readonly], initialTargetId: readonly.id,
      transcript: () => nativeTranscript(), loadOlder: () => false, loadNewer: () => false, loadLatest: () => false,
      send: vi.fn(), stop: vi.fn(), close: vi.fn(),
    });
    try {
      const lines = plain(view.render(120));
      // No header above the transcript: only the blank rows that bottom-align it.
      const history = lines.indexOf("history starts here");
      expect(history).toBeGreaterThan(0);
      expect(lines.slice(0, history).every((line) => line.trim() === "")).toBe(true);
      const border = lines.findIndex((line) => line.startsWith("─"));
      expect(border).toBeGreaterThan(history);
      expect(lines.slice(history + 1, border).every((line) => line.trim() === "")).toBe(true);
      expect(lines.some((line) => /^─.* chat-test · read-only ──$/.test(line))).toBe(true);
      expect(lines).not.toContain("chat-test");
      const footer = lines.findIndex((line) => line.includes("/repo/child (feature/chat)"));
      expect(lines[footer]).toBe("/repo/child (feature/chat) • chat-test • read-only");
      expect(lines[footer + 1]).toContain("completed · ↑1.2k ↓400 R600 $0.012 · ?/128k ctx");
      expect(lines.filter((line) => line.includes("(openai) child-model"))).toHaveLength(1);
      expect(lines.join("\n")).not.toContain("Target finished");
    } finally { view.dispose(); render.mockRestore(); }
  });

  it.each(["regular", "fullscreen"])("places a nested target's own name on the input border in %s mode, including resize", (mode) => {
    const main = { ...target, id: "main", name: "Main", kind: "main" as const };
    const parent = { ...target, id: "parent", name: "ancestor", parentId: main.id };
    const child = { ...target, name: "研究👩‍💻é-active-target", parentId: parent.id };
    // Pi paints the editor border in the thinking-level colour; the badge takes that colour.
    let border = "250;220;120";
    const fg = vi.fn((color: string, text: string) =>
      color === "borderMuted" || color.startsWith("thinking") ? `\x1b[38;2;${border}m${text}\x1b[39m` : text);
    const view = new FabricConversationView({ ...tui, mode, terminal: { ...tui.terminal, write: vi.fn() } } as TUI, { ...theme, fg } as unknown as Theme, {
      state: new FabricConversationState(), targets: () => [main, parent, child], initialTargetId: child.id,
      transcript: () => nativeTranscript(), loadOlder: () => false, loadNewer: () => false, loadLatest: () => false,
      send: vi.fn(), stop: vi.fn(), close: vi.fn(),
    });
    try {
      const wide = view.render(120);
      const badge = wide.find((line) => line.includes(child.name))!;
      expect(stripTerminalSequences(badge)).toMatch(/^─+ 研究👩‍💻é-active-target ──$/);
      // Only the target's own name: no Main and no ancestors.
      expect(visibleWidth(badge)).toBe(120);
      // A light border gets black text.
      expect(badge).toContain(`\x1b[48;2;250;220;120;38;2;0;0;0m ${child.name} `);
      expect(plain(wide).filter((line) => line.startsWith("─") && line.includes(child.name))).toHaveLength(1);
      for (const width of [1, 2, 5, 8, 16, 24, 40, 120]) {
        const lines = view.render(width);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        if (width === 24) {
          const border = plain(lines).find((line) => /^─.*研究/.test(line))!;
          expect(border).toContain("研究");
          expect(border).not.toContain("ancestor");
        }
      }
      // A new thinking level recolours the border, and the badge with it; a dark one gets white text.
      border = "40;60;160";
      view.invalidate();
      expect(view.render(120).find((line) => line.includes(child.name))).toContain("\x1b[48;2;40;60;160;38;2;255;255;255m");
      Object.assign(child, { name: "active-" + "界".repeat(200), readOnlyReason: "Target finished" });
      const readonly = view.render(40);
      const readonlyBadge = plain(readonly).find((line) => /^─.*active-/.test(line))!;
      expect(readonlyBadge).toContain(" · read-only ──");
      expect(readonlyBadge).not.toContain("ancestor");
      expect(readonlyBadge).toContain("…");
      expect(visibleWidth(readonlyBadge)).toBe(40);
    } finally { view.dispose(); }
  });

  it("reads native padding and code settings only from trusted layers", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-chrome-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ editorPaddingX: 1, outputPad: 1, markdown: { codeBlockIndent: "  " }, fullscreenScrollbar: "hidden" }));
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ editorPaddingX: 3, outputPad: 0, markdown: { codeBlockIndent: "    " }, fullscreenScrollbar: "always" }));
    try {
      expect(readConversationAppearance(cwd, agentDir, true)).toMatchObject({ editorPaddingX: 3, outputPad: 0, codeBlockIndent: "    ", scrollbar: "always" });
      expect(readConversationAppearance(cwd, agentDir, false)).toMatchObject({ editorPaddingX: 1, outputPad: 1, codeBlockIndent: "  ", scrollbar: "hidden" });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
