import "./fixtures/conversation-host.js";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { createInteractiveTuiReference } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/tui-renderer.js";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Editor, Text, TuiAltScreen, TuiMainScreen, stripTerminalSequences, visibleWidth, type OverlayHandle, type Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { FabricConversationState, FabricConversationView } from "../src/ui/conversation.js";
import { nativeTranscript, userMessage, assistantMessage } from "./fixtures/native-conversation.js";
import { installFabricEscapeHalt } from "../src/ui/escape-halt.js";

class ProbeTerminal implements Terminal {
  columns = 90;
  rows = 24;
  kittyProtocolActive = false;
  output = "";
  input: (data: string) => void = () => {};
  start(onInput: (data: string) => void): void { this.input = onInput; }
  stop(): void { this.input = () => {}; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
}

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

describe("conversation through the real Pi TUI", () => {
  it.each([["main screen", TuiMainScreen], ["alternate screen", TuiAltScreen]] as const)(
    "selects footer text and double/triple-clicks chat without touching Main (%s)", async (_name, Renderer) => {
      initTheme("dark", false);
      const terminal = new ProbeTerminal();
      terminal.columns = 140;
      const tui = new Renderer(terminal);
      const main = new Text("PRIVATE MAIN RESPONSE");
      tui.addChild(main);
      const copy = vi.fn(async (_text: string) => {});
      const target = { id: "child", name: "Child", kind: "agent" as const, status: "completed",
        model: "openai/gpt-6.1-sol", thinking: "high", cwd: "/repo/child",
        canSteer: false, canFollowUp: false, canStop: false };
      const state = new FabricConversationState();
      const view = new FabricConversationView(createInteractiveTuiReference(() => tui), theme, {
        state, initialTargetId: "child", targets: () => [target],
        transcript: () => nativeTranscript([assistantMessage("child response")]),
        loadOlder: () => false, loadNewer: () => false, loadLatest: () => false,
        copyToClipboard: copy, send: vi.fn(), stop: vi.fn(), close: vi.fn(),
      });
      tui.start();
      const handle = tui.showOverlay(view, { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 });
      const pointer = (type: "press" | "release" | "drag", x: number, y: number) =>
        terminal.input(`\x1b[<${type === "drag" ? 32 : 0};${x + 1};${y + 1}${type === "release" ? "m" : "M"}`);
      try {
        await vi.waitFor(() => expect(terminal.output).toContain("child response"));
        const frame = view.render(terminal.columns).map(stripTerminalSequences);
        const footerY = frame.findIndex(line => line.includes("(openai) gpt-6.1-sol"));
        const footerX = frame[footerY]!.indexOf("(openai)");
        pointer("press", footerX, footerY);
        pointer("drag", footerX + 8, footerY);
        pointer("release", footerX + 8, footerY);
        await vi.waitFor(() => expect(copy).toHaveBeenCalledWith("(openai)"));
        // A live footer update cannot change the pinned text being copied.
        target.model = "another/model";
        expect(view.render(terminal.columns).map(stripTerminalSequences)[footerY]).toContain("(openai)");
        terminal.input("\x03");
        await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(2));
        terminal.input("\x1b");
        const chatFrame = view.render(terminal.columns).map(stripTerminalSequences);
        const chatY = chatFrame.findIndex(line => line.includes("child response"));
        const chatX = chatFrame[chatY]!.indexOf("child response") + 1;
        for (let i = 0; i < 2; i++) { pointer("press", chatX, chatY); pointer("release", chatX, chatY); }
        await vi.waitFor(() => expect(copy).toHaveBeenCalledWith("child"));
        pointer("press", chatX, chatY); pointer("release", chatX, chatY);
        await vi.waitFor(() => expect(copy.mock.calls.some(([text]) => text.trim() === "child response")).toBe(true));
        expect(copy.mock.calls.every(([text]) => !text.includes("PRIVATE MAIN"))).toBe(true);
        expect(tui.children).toEqual([main]);
      } finally { view.dispose(); handle.hide(); state.clear(); tui.stop(); }
    },
  );
  it.each([["main screen", TuiMainScreen], ["alternate screen", TuiAltScreen]] as const)(
    "selects and copies child text and completes /copy without touching Main (%s)", async (_name, Renderer) => {
      initTheme("dark", false);
      const terminal = new ProbeTerminal();
      const tui = new Renderer(terminal);
      const originalRequestRender = tui.requestRender;
      const main = new Editor(tui, { borderColor: (text) => text,
        selectList: { selectedPrefix: (text) => text, selectedText: (text) => text,
          description: (text) => text, scrollInfo: (text) => text, noMatch: (text) => text } });
      main.setText("untouched Main draft");
      main.addToHistory("PRIVATE MAIN HISTORY");
      const mainSubmit = vi.fn();
      main.onSubmit = mainSubmit;
      tui.addChild(new Text("PRIVATE MAIN RESPONSE"));
      tui.addChild(main);
      tui.setFocus(main);
      const copy = vi.fn(async (_text: string) => {});
      const send = vi.fn();
      const stop = vi.fn();
      const state = new FabricConversationState();
      const view = new FabricConversationView(createInteractiveTuiReference(() => tui), theme, {
        state, initialTargetId: "child",
        targets: () => [{ id: "child", name: "Child", kind: "agent", status: "completed", readOnlyReason: "finished",
          canSteer: false, canFollowUp: false, canStop: false }],
        transcript: () => nativeTranscript([userMessage("Select the response"), assistantMessage("child response")]),
        loadOlder: () => false, loadNewer: () => false, loadLatest: () => false,
        copyToClipboard: copy, send, stop, close: vi.fn(),
      });
      tui.start();
      const handle = tui.showOverlay(view, { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 });
      try {
        await vi.waitFor(() => expect(terminal.output).toContain("child response"));
        const frame = view.render(terminal.columns).map(stripTerminalSequences);
        const y = frame.findIndex((line) => line.includes("child response"));
        const x = frame[y]!.indexOf("child response");
        terminal.input(`\x1b[<0;${x + 1};${y + 1}M`);
        terminal.input(`\x1b[<32;${x + 6};${y + 1}M`);
        terminal.input(`\x1b[<0;${x + 6};${y + 1}m`);
        await vi.waitFor(() => expect(copy).toHaveBeenCalledWith("child"));
        terminal.input("/co");
        await vi.waitFor(() => expect(view.render(terminal.columns).join("\n")).toContain("/copy selection"));
        terminal.input("\r");
        await vi.waitFor(() => expect(copy).toHaveBeenCalledWith("child response"));
        expect(copy).toHaveBeenCalledTimes(2);
        expect(copy.mock.calls.every(([text]) => !text.includes("PRIVATE MAIN"))).toBe(true);
        expect(state.view("child").draft).toBe("");
        await vi.waitFor(() => expect(terminal.output).toContain("Copied last assistant response"));
        const notification = new Text(theme.fg("dim", "Copied last assistant response"), 1, 0).render(terminal.columns);
        const notifiedFrame = view.render(terminal.columns);
        const noticeRow = notifiedFrame.indexOf(notification[0]!);
        expect(noticeRow).toBeGreaterThan(1);
        expect(notifiedFrame.slice(noticeRow - 1, noticeRow + notification.length)).toEqual(["", ...notification]);
        terminal.input("draft after /copy");
        expect(view.render(terminal.columns).join("\n")).toContain("Copied last assistant response");
        terminal.input("\x1b[A");
        terminal.input("\x1b[A");
        expect(state.view("child").draft).toBe("/copy");
        terminal.input("\x1b[A");
        expect(state.view("child").draft).toBe("Select the response");
        terminal.input("\x1b[B");
        expect(state.view("child").draft).toBe("/copy");
        terminal.input("\x1b[B");
        expect(state.view("child").draft).toBe("draft after /copy");
        expect(tui.children).toHaveLength(2);
        expect(main.getText()).toBe("untouched Main draft");
        expect(mainSubmit).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(stop).not.toHaveBeenCalled();
        expect(tui.requestRender).toBe(originalRequestRender);
      } finally {
        view.dispose();
        handle.hide();
        state.clear();
        tui.stop();
      }
    },
  );

  it.each([["main screen", TuiMainScreen], ["alternate screen", TuiAltScreen]] as const)(
    "paints a stable pending copy result through native completion (%s)", async (_name, Renderer) => {
      initTheme("dark", false);
      const terminal = new ProbeTerminal();
      const tui = new Renderer(terminal);
      tui.addChild(new Text("PRIVATE MAIN"));
      const state = new FabricConversationState();
      let resolve!: () => void;
      const copy = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
      const send = vi.fn();
      const view = new FabricConversationView(createInteractiveTuiReference(() => tui), theme, {
        state, initialTargetId: "child",
        targets: () => [{ id: "child", name: "Child", kind: "agent", status: "completed", readOnlyReason: "finished",
          canSteer: false, canFollowUp: false, canStop: false }],
        transcript: () => nativeTranscript([
          userMessage(Array.from({ length: 100 }, (_, i) => `history ${i}`).join("\n")), assistantMessage("child response"),
        ]),
        loadOlder: () => false, loadNewer: () => false, loadLatest: () => false,
        copyToClipboard: copy, send, stop: vi.fn(), close: vi.fn(),
      });
      tui.start();
      const handle = tui.showOverlay(view, { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 });
      try {
        await vi.waitFor(() => expect(terminal.output).toContain("child response"));
        terminal.input("/co");
        await vi.waitFor(() => expect(view.render(terminal.columns).join("\n")).toContain("/copy selection"));
        terminal.output = "";
        terminal.input("\r");
        const pending = view.render(terminal.columns).map(stripTerminalSequences);
        const scroll = state.view("child").scroll;
        expect(pending.join("\n")).toContain("Copying…");
        await vi.waitFor(() => expect(terminal.output).toContain("Copying…"));
        expect(copy).toHaveBeenCalledWith("child response");
        resolve();
        await vi.waitFor(() => expect(terminal.output).toContain("Copied last assistant response"));
        const done = view.render(terminal.columns).map(stripTerminalSequences);
        const notice = pending.findIndex((line) => line.includes("Copying…"));
        expect(done.slice(0, notice)).toEqual(pending.slice(0, notice));
        expect(state.view("child").scroll).toBe(scroll);
        terminal.input("\x1b[A");
        expect(state.view("child").draft).toBe("/copy");
        expect(send).not.toHaveBeenCalled();
        expect(tui.children).toHaveLength(1);
      } finally {
        resolve?.();
        view.dispose();
        handle.hide();
        state.clear();
        tui.stop();
      }
    },
  );

  it.each([["main screen", TuiMainScreen], ["alternate screen", TuiAltScreen]] as const)(
    "keeps the upstream-style dock gap while scrolling history (%s)", async (_name, Renderer) => {
      initTheme("dark", false);
      const terminal = new ProbeTerminal();
      const tui = new Renderer(terminal);
      const reference = createInteractiveTuiReference(() => tui);
      const state = new FabricConversationState();
      const view = new FabricConversationView(reference, theme, {
        state, initialTargetId: "child",
        targets: () => [{ id: "child", name: "Child", kind: "agent", status: "running",
          canSteer: true, canFollowUp: true, canStop: true }],
        transcript: () => nativeTranscript([
          userMessage(Array.from({ length: 100 }, (_, index) => `history ${index}`).join("\n")),
          assistantMessage("final history marker"),
        ]),
        loadOlder: () => false, loadNewer: () => false, loadLatest: () => false,
        send: vi.fn(), stop: vi.fn(), close: vi.fn(),
      });
      tui.start();
      const handle = tui.showOverlay(view, { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 });
      try {
        await vi.waitFor(() => expect(terminal.output).toContain("Working"));
        const before = view.render(terminal.columns).map(stripTerminalSequences);
        // The dock's top border carries the streaming status; the transcript ends above it.
        const editorTop = before.findIndex((line) => /^── [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working ─+ .+ ──$/.test(line));
        expect(editorTop).toBeGreaterThan(1);
        expect(before[editorTop - 1]).toBe("");
        expect(before[editorTop - 2]).toContain("final history marker");
        const start = state.view("child").scroll;
        terminal.input("\x1b[<64;4;4M");
        const after = view.render(terminal.columns).map(stripTerminalSequences);
        const delta = start - state.view("child").scroll;
        expect(delta).toBeGreaterThan(0);
        expect(state.view("child").following).toBe(false);
        const history = (line: string) => line.slice(0, terminal.columns - 1).trimEnd();
        expect(after.slice(delta, editorTop - 2).map(history)).toEqual(before.slice(0, editorTop - delta - 2).map(history));
        expect(after[editorTop - 1]).toBe("");
        expect(after[editorTop - 2]).toContain("Jump to latest message");
        expect(after.slice(0, editorTop - 1).some((line) => line.endsWith("┃"))).toBe(true);
        // The fixed gap is neither selectable history nor the jump-to-latest hitbox.
        terminal.input(`\x1b[<0;45;${editorTop}M`);
        terminal.input(`\x1b[<0;45;${editorTop}m`);
        expect(state.view("child").following).toBe(false);
        terminal.input(`\x1b[<0;45;${editorTop - 1}M`);
        terminal.input(`\x1b[<0;45;${editorTop - 1}m`);
        const latest = view.render(terminal.columns).map(stripTerminalSequences);
        expect(state.view("child").following).toBe(true);
        expect(latest[editorTop - 1]).toBe("");
        expect(latest[editorTop - 2]).toContain("final history marker");
        expect(latest.join("\n")).not.toContain("Jump to latest message");
      } finally {
        view.dispose();
        handle.hide();
        state.clear();
        tui.stop();
      }
    },
  );

  it.each([["main screen", TuiMainScreen], ["alternate screen", TuiAltScreen]] as const)(
    "routes child input and restores Main without interruption (%s)", async (_name, Renderer) => {
    initTheme("dark", false);
    const terminal = new ProbeTerminal();
    const tui = new Renderer(terminal);
    const main = new Editor(tui, {
      borderColor: (text) => text,
      selectList: {
        selectedPrefix: (text) => text, selectedText: (text) => text,
        description: (text) => text, scrollInfo: (text) => text, noMatch: (text) => text,
      },
    });
    main.setText("untouched Main draft");
    const mainSubmit = vi.fn();
    main.onSubmit = mainSubmit;
    tui.addChild(new Text("Main conversation keeps its history"));
    tui.addChild(main);
    tui.setFocus(main);
    tui.start();
    let ownsInput = true;
    let handle: OverlayHandle | undefined;
    const halt = vi.fn(() => 1);
    const context = {
      mode: "tui",
      ui: {
        notify: vi.fn(),
        onTerminalInput: (listener: (data: string) => undefined) => tui.addInputListener(listener),
      },
    } as unknown as ExtensionContext;
    const unsubscribe = installFabricEscapeHalt(context, {
      enabled: () => true, ownsInput: () => ownsInput, halted: () => false, halt,
    });
    const send = vi.fn().mockResolvedValue({ queued: true });
    const stop = vi.fn().mockResolvedValue(undefined);
    const state = new FabricConversationState();
    const hostRequestRender = tui.requestRender;
    const reference = createInteractiveTuiReference(() => tui);
    const view = new FabricConversationView(reference, theme, {
      state, initialTargetId: "child-1",
      targets: () => [
        { id: "main", name: "Main", kind: "main", status: "running", canSteer: false, canFollowUp: false, canStop: false },
        { id: "child-1", parentId: "main", name: "Implementer", kind: "agent", status: "running", canSteer: true, canFollowUp: true, canStop: true },
      ],
      transcript: () => nativeTranscript([
        userMessage("Implement the change"),
        { ...assistantMessage(""), content: [
          { type: "text", text: "Working on **the requested change**." },
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } },
        ] },
        { role: "toolResult", toolCallId: "read-1", toolName: "read", timestamp: 3,
          content: [{ type: "text", text: "Preview tool output" }], isError: false },
      ]),
      loadOlder: () => false, loadNewer: () => false, loadLatest: () => false,
      send, stop,
      close: () => { ownsInput = false; handle?.hide(); view.dispose(); },
    });
    handle = tui.showOverlay(view, { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 });
    try {
      const lines = view.render(terminal.columns);
      expect(lines.join("\n")).toContain("Implementer");
      expect(lines.join("\n")).toContain("Preview tool output");
      expect(tui.requestRender).toBe(hostRequestRender);
      expect(lines.every((line) => visibleWidth(line) <= terminal.columns)).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(terminal.rows);
      terminal.input("Please check the error path");
      terminal.input("\r");
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith("child-1", "Please check the error path", "steer"));
      expect(main.getText()).toBe("untouched Main draft");
      expect(mainSubmit).not.toHaveBeenCalled();
      terminal.input("\x1b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(halt).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(main.getText()).toBe("untouched Main draft");
      terminal.input(" still here");
      expect(main.getText()).toContain("still here");
      expect(mainSubmit).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      handle.hide();
      view.dispose();
      tui.stop();
    }
  });
});
