import "./fixtures/conversation-host.js";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NativeConversationReader, type NativeConversationSource } from "../src/ui/conversation-native-reader.js";
import { WorkingStatusIndicator } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/status-indicator.js";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FabricConversationState,
  FabricConversationView,
  type FabricConversationDelivery,
  type FabricConversationOptions,
  type FabricConversationTarget,
} from "../src/ui/conversation.js";
import { FabricConversationTranscriptRenderer } from "../src/ui/conversation-render.js";
import type { FabricDashboardSnapshot, FabricUiAgent } from "../src/ui/types.js";
import { FabricWidget, type FabricWidgetInteraction } from "../src/ui/widget.js";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { nativeTranscript, userMessage, assistantMessage } from "./fixtures/native-conversation.js";
initTheme("dark", false);

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

/** Row of the editor's top border while the streaming indicator is embedded. */
const editorStatusRow = (lines: string[]): number =>
  lines.findIndex((line) => /^── [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working ─+ [^─\s][^─]* ──$/.test(line));

const historyText = (line: string): string => stripTerminalSequences(line).replace(/[│┃█]$/, "").trimEnd();

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const deferred = (): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const makeTargets = (): FabricConversationTarget[] => [
  {
    id: "main",
    name: "Main",
    kind: "main",
    status: "running",
    canSteer: true,
    canFollowUp: true,
    canStop: false,
  },
  {
    id: "a",
    name: "Agent A",
    kind: "agent",
    parentId: "main",
    status: "running",
    canSteer: true,
    canFollowUp: true,
    canStop: true,
    cwd: "/tmp/a",
  },
  {
    id: "b",
    name: "Agent B",
    kind: "agent",
    parentId: "main",
    status: "completed",
    canSteer: false,
    canFollowUp: false,
    canStop: false,
    readOnlyReason: "one-shot completed",
  },
  {
    id: "child",
    name: "Nested",
    kind: "agent",
    parentId: "a",
    status: "running",
    canSteer: true,
    canFollowUp: true,
    canStop: true,
  },
];

const transcriptFor = (id: string) => nativeTranscript([
  userMessage(`hello from ${id}`),
  { ...assistantMessage(""), content: [{ type: "toolCall", id: `${id}:t1`, name: "bash", arguments: { command: "ls" } }] },
  { role: "toolResult", toolCallId: `${id}:t1`, toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 },
  assistantMessage(`reply for ${id}`, 4),
]);

interface Harness {
  view: FabricConversationView;
  state: FabricConversationState;
  send: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  loadOlder: ReturnType<typeof vi.fn>;
  loadNewer: ReturnType<typeof vi.fn>;
  loadLatest: ReturnType<typeof vi.fn>;
  tui: TUI;
  keybindings: Pick<KeybindingsManager, "matches" | "getKeys">;
}

const views: FabricConversationView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

interface HarnessOverrides {
  mode?: "regular" | "fullscreen";
  targets?: () => FabricConversationTarget[];
  initialTargetId?: string;
  send?: (id: string, message: string, delivery: FabricConversationDelivery) => Promise<unknown>;
  keybindings?: Harness["keybindings"];
  rows?: number;
  transcript?: FabricConversationOptions["transcript"];
  participants?: FabricConversationOptions["participants"];
  openTasks?: (id?: string) => void;
}

const makeHarness = (overrides: HarnessOverrides = {}): Harness => {
  const state = new FabricConversationState();
  const tui = {
    mode: overrides.mode,
    requestRender: vi.fn(),
    terminal: { rows: overrides.rows ?? 40, columns: 100, write: vi.fn() },
  } as unknown as TUI;
  const keybindings: Harness["keybindings"] = overrides.keybindings ?? {
    matches: () => false,
    getKeys: () => [],
  };
  const send = vi.fn(overrides.send ?? (async () => undefined));
  const options: FabricConversationOptions = {
    targets: overrides.targets ?? makeTargets,
    initialTargetId: overrides.initialTargetId ?? "a",
    state,
    transcript: overrides.transcript ?? ((id) => transcriptFor(id)),
    loadOlder: vi.fn(() => true),
    loadNewer: vi.fn(() => true),
    loadLatest: vi.fn(() => true),
    send,
    stop: vi.fn(async () => undefined),
    close: vi.fn(),
    keybindings,
    ...(overrides.participants ? { participants: overrides.participants } : {}),
    ...(overrides.openTasks ? { openTasks: overrides.openTasks } : {}),
  };
  const view = new FabricConversationView(tui, theme, options);
  views.push(view);
  return {
    view,
    state,
    send: options.send as Harness["send"],
    stop: options.stop as Harness["stop"],
    close: options.close as Harness["close"],
    loadOlder: options.loadOlder as Harness["loadOlder"],
    loadNewer: options.loadNewer as Harness["loadNewer"],
    loadLatest: options.loadLatest as Harness["loadLatest"],
    tui,
    keybindings,
  };
};

describe.each(["regular", "fullscreen"] as const)("native conversation dock in %s mode", (mode) => {
  it.each(["\x1b[<65;4;4M", "\x1b[1;5B", "\x1b[6~"])("keeps live follow while scrolling down at the bottom (%j)", (gesture) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "fabric-bottom-follow-"));
    try {
      const eventsFile = path.join(directory, "events.jsonl");
      writeFileSync(eventsFile, "");
      const reader = new NativeConversationReader();
      const source = { id: "a", status: "running", eventsFile };
      const h = makeHarness({ mode, transcript: (_id, follow) => reader.read(source, follow) });
      h.loadNewer.mockImplementation(() => {
        const before = reader.read(source, false);
        return reader.loadNewer()!.revision !== before.revision;
      });
      expect(renderText(h.view)).toContain("Working");
      for (let tick = 0; tick < 4; tick++) {
        const append = (text: string) => appendFileSync(eventsFile, JSON.stringify({
          type: "message_end", message: assistantMessage(text, tick + 1),
        }) + "\n");
        append(`before scroll ${tick}`);
        h.view.handleInput(gesture);
        // New activity can arrive between the scroll callback and the next frame.
        append(`after scroll ${tick}`);
        h.view.refresh();
        const text = renderText(h.view);
        expect(h.state.view("a").following).toBe(true);
        expect(text).toContain(`after scroll ${tick}`);
        expect(text).toContain("Working");
        expect(text).not.toContain("newer activity available");
      }
      expect(h.loadNewer).not.toHaveBeenCalled();
      h.view.handleInput("\x1b[<64;4;4M");
      expect(h.state.view("a").following).toBe(false);
      appendFileSync(eventsFile, JSON.stringify({ type: "message_end", message: assistantMessage("while pinned", 99) }) + "\n");
      expect(renderText(h.view)).toContain("newer activity available");
      h.view.handleInput("\x1b[1;5F");
      const latest = renderText(h.view);
      expect(latest).toContain("while pinned");
      expect(latest).toContain("Working");
      expect(latest).not.toContain("newer activity available");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps a fixed dock gap while scrolling without changing history rows", () => {
    const history = Array.from({ length: 100 }, (_, i) => `history ${i}`);
    vi.spyOn(FabricConversationTranscriptRenderer.prototype, "render").mockReturnValue(history);
    const targets = makeTargets();
    delete targets[2]!.readOnlyReason;
    const h = makeHarness({ mode, initialTargetId: "b", targets: () => targets });
    h.view.render(100);
    h.view.handleInput("\x1b[<64;4;4M");
    const lines = h.view.render(100);
    const border = lines.findIndex((line) => /^─+ [^─\s][^─]* ──$/.test(line));
    const scroll = h.state.view("b").scroll;
    expect(h.state.view("b").following).toBe(false);
    expect(lines.slice(0, border - 2).map(historyText)).toEqual(history.slice(scroll, scroll + border - 2));
    expect(lines[border - 2]).toContain("Jump to latest message");
    expect(lines[border - 1]).toBe("");
    h.view.handleInput("\x1b[1;5F");
    const latest = h.view.render(100);
    expect(latest.slice(border - 2, border).map(historyText)).toEqual(["history 99", ""]);
    expect(history).toHaveLength(100);
  });

  it("pins Working in the editor border while the transcript scrolls away", () => {
    vi.useFakeTimers();
    vi.spyOn(FabricConversationTranscriptRenderer.prototype, "render").mockReturnValue(
      Array.from({ length: 100 }, (_, i) => `history ${i}`),
    );
    const h = makeHarness({ mode });
    let lines = h.view.render(100);
    let editorTop = editorStatusRow(lines);
    expect(editorTop).toBeGreaterThan(0);
    expect(lines.slice(0, editorTop).join("\n")).not.toContain("Working");
    h.view.handleInput("\x1b[<64;4;4M");
    lines = h.view.render(100);
    editorTop = editorStatusRow(lines);
    expect(editorTop).toBeGreaterThan(0);
    // Scrolled back: the transcript end left the window; the dock kept its gap and status.
    expect(historyText(lines[editorTop - 3]!)).toMatch(/^history \d+$/);
    expect(lines[editorTop - 2]).toContain("Jump to latest message");
    expect(lines[editorTop - 2]).not.toContain("history 99");
    expect(lines[editorTop - 1]).toBe("");
    h.view.handleInput("\x1b[1;5F");
    lines = h.view.render(100);
    editorTop = editorStatusRow(lines);
    expect(historyText(lines[editorTop - 2]!)).toBe("history 99");
    expect(historyText(lines[editorTop - 1]!)).toBe("");
  });

  it("keeps the dock indicator out of an older page's transcript end", () => {
    vi.useFakeTimers();
    vi.spyOn(FabricConversationTranscriptRenderer.prototype, "render").mockReturnValue(
      Array.from({ length: 100 }, (_, i) => `history ${i}`),
    );
    const transcript = nativeTranscript([], { hasNewer: true });
    const h = makeHarness({ mode, transcript: () => transcript });
    const lines = h.view.render(100);
    const editorTop = editorStatusRow(lines);
    expect(editorTop).toBeGreaterThan(0);
    expect(lines.slice(0, editorTop).join("\n")).not.toContain("Working");
    expect(lines[editorTop - 2]).toContain("history 99");
    expect(lines[editorTop - 2]).toContain("Jump to latest message");
    expect(lines[editorTop - 1]).toBe("");
  });

  it("fills at most one older page per refresh and does no paging inside render", () => {
    let transcript = nativeTranscript([assistantMessage("short tail")], { hasMore: true });
    const h = makeHarness({ initialTargetId: "b", transcript: () => transcript });
    h.loadOlder.mockImplementation(() => {
      transcript = nativeTranscript([assistantMessage(`page ${h.loadOlder.mock.calls.length}`)], { hasMore: true });
      return true;
    });
    h.view.render(100);
    expect(h.loadOlder).not.toHaveBeenCalled();
    expect(h.view.refresh()).toBe(true);
    expect(h.loadOlder).toHaveBeenCalledTimes(1);
    expect(h.view.render(100).join("\n")).toContain("page 1");
    expect(h.loadOlder).toHaveBeenCalledTimes(1);
    h.view.refresh();
    expect(h.loadOlder).toHaveBeenCalledTimes(2);
    h.loadOlder.mockReturnValue(false);
    h.view.render(100);
    expect(h.view.refresh()).toBe(false);
  });

  it.each(["pinned", "has newer", "full", "complete"])("does not auto-fill a %s viewport", (kind) => {
    const transcript = nativeTranscript([
      assistantMessage(kind === "full" ? Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") : "short tail"),
    ], { hasMore: kind !== "complete", hasNewer: kind === "has newer" });
    const h = makeHarness({ initialTargetId: "b", transcript: () => transcript });
    h.view.render(100);
    if (kind === "pinned") h.state.view("b").following = false;
    h.view.refresh();
    expect(h.loadOlder).not.toHaveBeenCalled();
  });

  it("preserves the prepend anchor when Working ends during a page load", () => {
    vi.useFakeTimers();
    let history = Array.from({ length: 100 }, (_, i) => `history ${i}`);
    vi.spyOn(FabricConversationTranscriptRenderer.prototype, "render").mockImplementation(() => history);
    const targets = makeTargets();
    const h = makeHarness({ mode, targets: () => targets });
    Object.assign(h.state.view("a"), { following: false, scroll: 0 });
    h.view.render(100);
    h.loadOlder.mockImplementation(() => {
      history = [...Array.from({ length: 10 }, (_, i) => `older ${i}`), ...history];
      targets[1]!.status = "idle";
      return true;
    });
    h.view.handleInput("\x1b[<64;4;4M");
    expect(historyText(h.view.render(100)[0]!)).toBe("older 7");
    expect(h.state.view("a").scroll).toBe(7);
  });

  it("slices only visible history rows when animating a virtual tail", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const rows = Array.from({ length: 100_000 }, (_, i) => `history ${i}`);
    const history = new Proxy(rows, { get(target, key, receiver) {
      if (key === Symbol.iterator) throw new Error("Do not copy the full transcript to append decorations");
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    } });
    vi.spyOn(FabricConversationTranscriptRenderer.prototype, "render").mockReturnValue(history);
    const h = makeHarness({ mode });
    h.view.render(100);
    reads = 0;
    await vi.advanceTimersByTimeAsync(80);
    expect(h.view.render(100).join("\n")).toContain("⠙ Working");
    expect(reads).toBeLessThanOrEqual(40);
    expect(rows).toHaveLength(100_000);
  });

  it("reserves exactly one gap above the editor without trimming native trailing rows", () => {
    const tail = "\x1b[44m  \x1b[0m";
    vi.spyOn(FabricConversationTranscriptRenderer.prototype, "render").mockReturnValue([
      ...Array.from({ length: 100 }, (_, i) => `history ${i}`), "history-last", tail,
    ]);
    const h = makeHarness({ mode, initialTargetId: "b" });
    const lines = h.view.render(100);
    const border = lines.findIndex((line) => /^─+ [^─\s][^─]* ──$/.test(line));
    expect(border).toBeGreaterThan(3);
    expect(lines.slice(border - 3, border)).toEqual(["history-last", tail, ""]);
  });

  it("animates the border indicator and stops on idle, switch and disposal", async () => {
    vi.useFakeTimers();
    const colors = vi.spyOn(theme, "fg");
    const targets = makeTargets();
    const transcript = nativeTranscript([userMessage("settled history"), assistantMessage("unchanged history")]);
    const h = makeHarness({ mode, targets: () => targets, transcript: () => transcript });
    const invalidations = vi.spyOn(FabricConversationTranscriptRenderer.prototype, "invalidate");
    let lines = h.view.render(100);
    let statusRow = editorStatusRow(lines);
    expect(statusRow).toBeGreaterThan(0);
    // Embedded placement must equal Pi's own at the same width (status width 95).
    const native = new WorkingStatusIndicator(h.tui, "Working");
    const nativeStatus = stripTerminalSequences(native.renderInBorder(95));
    native.dispose();
    const badge = " Agent A ──";
    expect(lines[statusRow]).toBe(`── ${nativeStatus} ${"─".repeat(100 - visibleWidth(nativeStatus) - 4 - visibleWidth(badge))}${badge}`);
    expect(lines.slice(0, statusRow).join("\n")).not.toContain("Working");
    // Pi paints the embedded spinner and label with the thinking-level border color.
    expect(colors).toHaveBeenCalledWith("borderMuted", "⠋");
    expect(colors).toHaveBeenCalledWith("borderMuted", "Working");
    invalidations.mockClear();
    vi.mocked(h.tui.requestRender).mockClear();
    await vi.advanceTimersByTimeAsync(80);
    expect(h.tui.requestRender).toHaveBeenCalledTimes(1);
    lines = h.view.render(100);
    statusRow = editorStatusRow(lines);
    expect(lines[statusRow]).toContain("⠙ Working");
    expect(invalidations).not.toHaveBeenCalled();
    targets[1]!.status = "idle";
    expect(h.view.refresh()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.view.render(100).join("\n")).not.toContain("Working");
    targets[1]!.status = "running";
    h.view.render(100);
    expect(vi.getTimerCount()).toBe(1);
    h.view.selectTarget("b");
    expect(vi.getTimerCount()).toBe(0);
    h.view.selectTarget("a");
    h.view.render(100);
    expect(vi.getTimerCount()).toBe(1);
    h.view.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.mocked(h.tui.requestRender).mockClear();
    await vi.advanceTimersByTimeAsync(160);
    expect(h.tui.requestRender).not.toHaveBeenCalled();
  });

  it.each(["idle", "stopped", "completed", "failed", "unavailable", "stale"])("does not animate an unfinished retained stream after the target becomes %s", (status) => {
    vi.useFakeTimers();
    const targets = makeTargets();
    const transcript = nativeTranscript([], { streaming: { active: true, partialAssistant: assistantMessage("unfinished output"), tools: [] } });
    const h = makeHarness({ mode, targets: () => targets, transcript: () => transcript });
    expect(h.view.render(100).join("\n")).toContain("Working");
    if (status === "stale") targets[1]!.stale = true;
    else targets[1]!.status = status;
    if (status === "idle") targets[1]!.kind = "actor";
    h.view.refresh();
    expect(h.view.render(100).join("\n")).not.toContain("Working");
    expect(vi.getTimerCount()).toBe(0);
    expect(h.view.refresh()).toBe(false);
  });

  it("clips native Working rows at tiny widths without stealing editor keys", () => {
    vi.useFakeTimers();
    const h = makeHarness({ mode });
    for (const width of [1, 2, 3, 4, 5, 8, 12]) {
      const lines = h.view.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      if (width >= 3) expect(lines.some((line) => line.includes("⠋"))).toBe(true);
    }
    h.view.handleInput("unchanged keyboard routing");
    expect(h.state.peek("a")?.draft).toBe("unchanged keyboard routing");
    h.view.handleInput("\x03");
    expect(h.state.peek("a")?.draft).toBe("");
  });
});

describe("conversation view change observation", () => {
  it("observes the target provider once per frame/input and refreshes mutable hierarchy and permissions", () => {
    const roster = makeTargets();
    const targets = vi.fn(() => roster);
    const h = makeHarness({ targets });
    targets.mockClear();
    h.view.render(100);
    expect(targets).toHaveBeenCalledTimes(1);
    targets.mockClear();
    h.view.handleInput("x");
    expect(targets).toHaveBeenCalledTimes(1);
    roster[1] = { ...roster[1]!, name: "Changed", parentId: "b", canSteer: false, readOnlyReason: "owner stale" };
    // The badge shows the refreshed name and permissions (its lineage now lives in the agent list).
    expect(h.view.render(100).map((line) => stripTerminalSequences(line))).toContainEqual(expect.stringMatching(/ Changed · read-only ──$/));
    h.view.handleInput("\r");
    expect(h.send).not.toHaveBeenCalled();
    h.view.dispose();
  });

  it("does not render during unchanged refresh but observes metadata, same-revision replacement and native growth", () => {
    const targets = makeTargets().map((target) => ({ ...target, status: "idle" }));
    let transcript = nativeTranscript([userMessage("first")]);
    const source = vi.fn(() => transcript);
    const h = makeHarness({ targets: () => targets, transcript: source });
    h.view.render(100);
    source.mockClear();
    expect(h.view.refresh()).toBe(false);
    expect(source).toHaveBeenCalledTimes(1);
    transcript = { ...transcript, hasNewer: true };
    expect(h.view.refresh()).toBe(true);
    expect(h.view.refresh()).toBe(false);
    transcript = { ...transcript, unavailable: { eventsFile: true }, error: "unavailable" };
    expect(h.view.refresh()).toBe(true);
    expect(h.view.refresh()).toBe(false);
    transcript = nativeTranscript([userMessage("same revision, different reader")]);
    expect(h.view.refresh()).toBe(true);
    transcript = { ...transcript, messages: [...transcript.messages, assistantMessage("appended")], revision: transcript.revision + 1 };
    expect(h.view.refresh()).toBe(true);
    expect(h.view.render(100).join("\n")).toContain("appended");
    h.view.dispose();
    source.mockClear();
    expect(h.view.refresh()).toBe(false);
    expect(source).not.toHaveBeenCalled();
  });

  it("reads only the selected transcript and marks only the selected target seen", () => {
    const targets = makeTargets();
    targets[1]!.updatedAt = 50;
    targets[2]!.updatedAt = 100;
    const transcript = vi.fn((id: string) => transcriptFor(id));
    const h = makeHarness({ targets: () => targets, transcript });
    h.view.render(100);
    h.view.refresh();
    expect(new Set(transcript.mock.calls.map(([id]) => id))).toEqual(new Set(["a"]));
    expect(h.state.peek("a")?.lastSeenUpdatedAt).toBe(50);
    // Rendering never creates or advances another target's seen state.
    expect(h.state.peek("b")?.lastSeenUpdatedAt ?? 0).toBeLessThan(100);
    h.view.selectTarget("b");
    expect(h.state.peek("b")?.lastSeenUpdatedAt).toBe(100);
    targets[2]!.updatedAt = 101;
    h.view.refresh();
    h.view.render(100);
    expect(h.state.peek("b")?.lastSeenUpdatedAt).toBe(101);
  });

  it("keeps pinned navigation, drafts and pending sends beyond the lightweight state limit", () => {
    const state = new FabricConversationState();
    const pinned = state.view("pinned");
    pinned.following = false;
    pinned.scroll = 777;
    pinned.pageAnchor = "prepend";
    pinned.anchorLength = 999;
    state.view("draft").draft = "keep draft";
    const pending = state.view("pending");
    state.addPendingSend({ id: "pending", message: "accepted later", delivery: "steer" });
    for (let index = 0; index < 300; index++) state.view(`other-${index}`);
    expect(state.peek("pinned")).toBe(pinned);
    expect(pinned).toMatchObject({ following: false, scroll: 777, pageAnchor: "prepend", anchorLength: 999 });
    expect(state.peek("draft")?.draft).toBe("keep draft");
    expect(state.peek("pending")).toBe(pending);
    state.resolvePendingSend("pending", "accepted later");
    expect(state.hasPendingSend("pending", "accepted later")).toBe(false);
  });
});

const renderText = (view: FabricConversationView, width = 80): string =>
  view.render(width).join("\n");

const type = (view: FabricConversationView, text: string): void => {
  for (const char of text) view.handleInput(char);
};

describe("FabricConversationView", () => {
  it("keeps native queue rows until an actual new user message is observed", async () => {
    let messages = [userMessage("repeat", 1)];
    const h = makeHarness({ transcript: () => nativeTranscript(messages) });
    type(h.view, "repeat");
    h.view.handleInput("\r");
    await flush();
    expect(h.state.peek("a")?.draft).toBe("");
    expect(renderText(h.view)).toContain("Steering: repeat");
    h.view.selectTarget("child");
    expect(renderText(h.view)).not.toContain("Steering: repeat");
    h.view.selectTarget("a");
    expect(renderText(h.view)).toContain("Steering: repeat");
    messages = [...messages, userMessage("repeat", 2)];
    expect(renderText(h.view)).not.toContain("Steering: repeat");
    expect(h.state.queues.get("a")?.rows()).toEqual([]);
    h.view.dispose();
  });

  it("routes sends to the selected target only and renders only its transcript", async () => {
    const h = makeHarness({ initialTargetId: "a" });
    type(h.view, "do the thing");
    h.view.handleInput("\r");
    await flush();
    expect(h.send).toHaveBeenCalledWith("a", "do the thing", "steer");
    const text = renderText(h.view);
    expect(text).toContain("reply for a");
    expect(text).not.toContain("reply for b");
    expect(h.state.selectedId).toBe("a");
  });

  it("explicit initialTargetId overrides state.selectedId", () => {
    const h = makeHarness({ initialTargetId: "a" });
    h.state.selectedId = "a";
    const view = new FabricConversationView(
      h.tui,
      theme,
      {
        targets: makeTargets,
        initialTargetId: "b",
        state: h.state,
        transcript: (id) => transcriptFor(id),
        loadOlder: () => true,
        loadNewer: () => true,
        loadLatest: () => true,
        send: async () => undefined,
        stop: async () => undefined,
        close: () => {},
      },
    );
    expect(h.state.selectedId).toBe("b");
    expect(view.selectTarget.length).toBe(1);
  });

  it("keeps a pending send pinned across navigation and clears only the accepted draft", async () => {
    const gate = deferred();
    const h = makeHarness({ initialTargetId: "a", send: () => gate.promise });
    type(h.view, "hello a");
    h.view.handleInput("\r");
    await flush();
    expect(h.send).toHaveBeenCalledWith("a", "hello a", "steer");
    // Draft retained (raw) until the owner acknowledges.
    expect(h.state.peek("a")?.draft).toBe("hello a");
    h.view.selectTarget("b");
    gate.resolve();
    await flush();
    expect(h.state.peek("a")?.draft).toBe("");
    expect(h.state.peek("b")?.draft).toBe("");
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("does not clear a newer edited draft when the original send resolves", async () => {
    const gate = deferred();
    const h = makeHarness({ initialTargetId: "a", send: () => gate.promise });
    type(h.view, "hello");
    h.view.handleInput("\r");
    type(h.view, "!");
    gate.resolve();
    await flush();
    expect(h.state.peek("a")?.draft).toBe("hello!");
    expect(h.view.render(80).join("\n")).toContain("hello!");
  });

  it("retains the raw draft on failed send and shows error feedback without closing", async () => {
    const gate = deferred();
    const h = makeHarness({ initialTargetId: "a", send: () => gate.promise });
    type(h.view, " spaced draft ");
    h.view.handleInput("\r");
    gate.reject(new Error("boom"));
    await flush();
    expect(h.state.peek("a")?.draft).toBe(" spaced draft ");
    const text = renderText(h.view);
    expect(text).toContain(" spaced draft ");
    expect(text).toContain("Send failed for Agent A (steer): boom");
    expect(h.close).not.toHaveBeenCalled();
  });

  it("restores per-target drafts when switching and reopening", () => {
    const h = makeHarness({ initialTargetId: "a" });
    type(h.view, "draft a");
    h.view.selectTarget("b");
    type(h.view, "draft b");
    h.view.selectTarget("a");
    expect(h.view.render(80).join("\n")).toContain("draft a");
    h.view.selectTarget("b");
    expect(h.view.render(80).join("\n")).toContain("draft b");
  });

  it("terminal completion disables sending without closing the viewer", async () => {
    const h = makeHarness({ initialTargetId: "b" });
    type(h.view, "late message");
    h.view.handleInput("\r");
    await flush();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    const text = renderText(h.view);
    expect(text).toContain("read-only: one-shot completed");
    expect(text).toContain("late message");
  });

  it("pages older and newer via callbacks and follows latest on End", () => {
    const h = makeHarness({ initialTargetId: "a", keybindings: {
      matches: (data, action) => (action === "tui.altScreen.previousPrompt" && data === "\x1b[1;5A") || (action === "tui.altScreen.nextPrompt" && data === "\x1b[1;5B"),
      getKeys: () => [],
    } });
    h.view.handleInput("\x1b[1;5A");
    expect(h.loadOlder).toHaveBeenCalledWith("a");
    renderText(h.view);
    h.view.handleInput("\x1b[1;5B");
    expect(h.loadNewer).toHaveBeenCalledWith("a");
    h.view.handleInput("\x1b[1;5F");
    expect(h.loadLatest).toHaveBeenCalledWith("a");
    h.view.handleInput("\x1b[5~");
    renderText(h.view);
    h.view.handleInput("\x1b[6~");
    expect(h.loadNewer).toHaveBeenCalledTimes(2);
  });

  it("selecting Main returns to the native session without stopping anything", () => {
    const h = makeHarness({ initialTargetId: "a" });
    h.view.selectTarget("main");
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.stop).not.toHaveBeenCalled();
  });

  it("shows the agent list below the footer and drives it from the editor with ↓, enter and esc", () => {
    const now = Date.now();
    const agent = (id: string, name: string, startedAt: number): FabricUiAgent => ({
      id, name, status: "running", transport: "process", cwd: "/tmp", startedAt, toolCalls: 0,
    });
    const snapshot = {
      now, sessionLabel: "Fabric session", peers: [], runs: [], actors: [], globalActors: [], state: [], events: [],
      componentGraph: { nodes: [], edges: [] },
      agents: [agent("a", "Agent A", now - 2_000), agent("b", "Agent B", now - 1_000)],
    } as unknown as FabricDashboardSnapshot;
    let received: FabricWidgetInteraction | undefined;
    let widget: FabricWidget | undefined;
    const h = makeHarness({
      initialTargetId: "a",
      participants: (interaction) => {
        received = interaction;
        return widget = new FabricWidget(theme, () => snapshot, 6, undefined, undefined, interaction);
      },
    });
    expect(widget?.interaction).toBe(received);
    const marker = "\x1b_pi:c\x07";
    // The editor's top border carries the target badge (after Working while A runs).
    const badge = (lines: string[]) => lines.find((line) => /^──.* [^─\s][^─]* ──$/.test(line));
    let lines = h.view.render(100);
    expect(lines).toHaveLength(40);
    // Spacer, header (the Main row), then one row per agent: the frame's last lines.
    const list = widget!.render(100);
    expect(list).toHaveLength(4);
    expect(lines.slice(-4)).toEqual(list);
    expect(list[0]).toBe("");
    expect(list[1]).toContain("Fabric session");
    // Hints tell editor focus from list focus, as on the main screen.
    expect(list[1]).toMatch(/↓ to manage$/);
    expect(list[2]).toContain("Agent A");
    expect(list[3]).toContain("Agent B");
    expect(badge(lines)).toMatch(/─ Agent A( · read-only)? ──$/);
    expect(lines.join("\n")).toContain(marker);

    // ↓ in the empty editor moves focus into the list.
    h.view.handleInput("\x1b[B");
    expect(widget!.focused).toBe(true);
    expect(widget!.render(100)[1]).toMatch(/⏎ open · ↑↓ select · esc back$/);
    expect(renderText(h.view, 100)).not.toContain(marker);
    // ↓ selects the next agent; enter opens it and gives focus back to the editor.
    h.view.handleInput("\x1b[B");
    h.view.handleInput("\r");
    expect(h.state.selectedId).toBe("b");
    expect(widget!.focused).toBe(false);
    lines = h.view.render(100);
    expect(badge(lines)).toMatch(/─ Agent B( · read-only)? ──$/);
    expect(lines.join("\n")).toContain(marker);
    expect(h.send).not.toHaveBeenCalled();

    // esc in the list returns to the editor without closing the view.
    h.view.handleInput("\x1b[B");
    expect(widget!.focused).toBe(true);
    h.view.handleInput("\x1b");
    expect(widget!.focused).toBe(false);
    expect(renderText(h.view, 100)).toContain(marker);
    expect(h.close).not.toHaveBeenCalled();

    // The header is the Main row: enter on it closes the view.
    h.view.handleInput("\x1b[B");
    h.view.handleInput("\x1b[A");
    h.view.handleInput("\x1b[A");
    expect(h.close).not.toHaveBeenCalled();
    h.view.handleInput("\r");
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.stop).not.toHaveBeenCalled();
  });

  it("opens the shell tasks view from a shell row in the agent list", () => {
    const now = Date.now();
    const snapshot = {
      now, peers: [], runs: [], actors: [], globalActors: [], state: [], events: [],
      componentGraph: { nodes: [], edges: [] },
      agents: [{ id: "a", name: "Agent A", status: "running", transport: "process", cwd: "/tmp", startedAt: now - 2_000 }],
      shells: [{ id: "job-1", tool: "bash", command: "sleep 30", startedAt: now - 1_000, spilledAt: now,
        status: "spilled", eventCount: 0, unread: false, stopping: false }],
    } as unknown as FabricDashboardSnapshot;
    const openTasks = vi.fn();
    let widget: FabricWidget | undefined;
    const h = makeHarness({
      initialTargetId: "a",
      openTasks,
      participants: (interaction) => widget = new FabricWidget(theme, () => snapshot, 6, undefined, undefined, interaction),
    });
    expect(h.view.render(100).at(-1)).toMatch(/^○ job-1 spilled · /);
    // ↓ lands on the agent on screen; ↓ again reaches the shell row.
    h.view.handleInput("\x1b[B");
    h.view.handleInput("\x1b[B");
    h.view.handleInput("\r");
    expect(openTasks).toHaveBeenCalledWith("job-1");
    expect(widget!.focused).toBe(false);
    expect(h.state.selectedId).toBe("a");
    expect(h.close).not.toHaveBeenCalled();
  });

  it("bottom-aligns a short transcript on the editor, as Pi does", () => {
    const h = makeHarness({ initialTargetId: "a" });
    const lines = h.view.render(100).map((line) => stripTerminalSequences(line));
    expect(lines).toHaveLength(40);
    const first = lines.findIndex((line) => line.trim() !== "");
    const border = lines.findIndex((line) => /^──.* [^─\s][^─]* ──$/.test(line));
    // Blank rows fill the top; the transcript ends just above the editor.
    expect(first).toBeGreaterThan(10);
    expect(border).toBeGreaterThan(first);
    expect(lines.slice(first, border).filter((line) => line.trim() !== "").length).toBeGreaterThan(0);
    expect(border - first).toBeLessThan(15);
  });

  it("escape closes the view without stopping any agent", () => {
    const h = makeHarness({ initialTargetId: "a" });
    h.view.handleInput("\x1b");
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.stop).not.toHaveBeenCalled();
  });

  it("/stop confirms then stops only the selected non-main target", async () => {
    const h = makeHarness({ initialTargetId: "a" });
    type(h.view, "/stop");
    h.view.handleInput("\r");
    expect(h.stop).not.toHaveBeenCalled();
    expect(renderText(h.view)).toContain("enter again to stop Agent A");
    h.view.handleInput("\r");
    await flush();
    expect(h.stop).toHaveBeenCalledWith("a");
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.close).not.toHaveBeenCalled();
  });

  it("escape cancels a pending /stop confirmation", () => {
    const h = makeHarness({ initialTargetId: "a" });
    type(h.view, "/stop");
    h.view.handleInput("\r");
    h.view.handleInput("\x1b");
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
  });

  it("never sends unsupported slash or shell commands to the target", async () => {
    const h = makeHarness({ initialTargetId: "a" });
    for (const command of ["/model", "!rm -rf /"]) {
      type(h.view, command);
      h.view.handleInput("\r");
      await flush();
      expect(h.send).not.toHaveBeenCalled();
      expect(h.close).not.toHaveBeenCalled();
      expect(renderText(h.view)).toContain("Unsupported command");
      expect(h.state.peek("a")?.draft).toBe(command);
      // Reset draft for the next iteration.
      h.view.handleInput("\x03");
    }
  });

  it("sends follow-up delivery through the injected app.message.followUp binding", async () => {
    const h = makeHarness({
      initialTargetId: "a",
      keybindings: {
        matches: (data, binding) => binding === "app.message.followUp" && data === "\x1b\x12",
        getKeys: (binding) => (binding === "app.message.followUp" ? ["alt+enter"] : []),
      },
    });
    type(h.view, "queued later");
    h.view.handleInput("\x1b\x12");
    await flush();
    expect(h.send).toHaveBeenCalledWith("a", "queued later", "followUp");
  });

  it("does not fall back to default keys for an unbound configured binding", async () => {
    const h = makeHarness({ initialTargetId: "a" });
    type(h.view, "hi");
    // ctrl+q is a follow-up fallback key, but the injected manager binds nothing.
    h.view.handleInput("\x11");
    await flush();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.state.peek("a")?.draft).toBe("hi");
  });

  it("expands tool previews with the native configured tools expand key", () => {
    const h = makeHarness({
      initialTargetId: "a",
      keybindings: {
        matches: (data, binding) => binding === "app.tools.expand" && data === "\x0f",
        getKeys: (binding) => (binding === "app.tools.expand" ? ["ctrl+o"] : []),
      },
    });
    const before = renderText(h.view);
    expect(before).not.toContain("input:");
    h.view.handleInput("\x0f");
    const after = renderText(h.view);
    expect(after).toContain("bash");
    expect(after).not.toContain("input:");
    expect(h.state.peek("a")?.toolsExpanded).toBe(true);
  });

  it("ctrl+c clears the composer draft instead of stopping anything", () => {
    const h = makeHarness({ initialTargetId: "a" });
    type(h.view, "scratch");
    h.view.handleInput("\x03");
    expect(h.state.peek("a")?.draft).toBe("");
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
  });

  it("propagates focus to the editor (IME cursor marker) immediately", () => {
    const h = makeHarness({ initialTargetId: "a" });
    const marker = "\x1b_pi:c\x07";
    expect(renderText(h.view)).toContain(marker);
    h.view.focused = false;
    expect(renderText(h.view)).not.toContain(marker);
    h.view.focused = true;
    expect(renderText(h.view)).toContain(marker);
  });

  it("close+reopen before ack blocks duplicate send and success clears the old draft", async () => {
    const gate = deferred();
    const h = makeHarness({ initialTargetId: "a", send: () => gate.promise });
    type(h.view, "hello a");
    h.view.handleInput("\r");
    await flush();
    expect(h.send).toHaveBeenCalledTimes(1);
    h.view.dispose();
    const reopened = new FabricConversationView(h.tui, theme, {
      targets: makeTargets,
      initialTargetId: "a",
      state: h.state,
      transcript: (id) => transcriptFor(id),
      loadOlder: () => true,
      loadNewer: () => true,
      loadLatest: () => true,
      send: h.send as unknown as FabricConversationOptions["send"],
      stop: async () => undefined,
      close: h.close as unknown as () => void,
    });
    // The new view reconciles editor text from the shared session draft.
    views.push(reopened);
    expect(renderText(reopened)).toContain("hello a");
    reopened.handleInput("\r");
    await flush();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.state.hasPendingSend("a", "hello a")).toBe(true);
    gate.resolve();
    await flush();
    expect(h.state.peek("a")?.draft).toBe("");
    expect(h.state.hasPendingSend("a", "hello a")).toBe(false);
    expect(renderText(reopened)).toContain("Steering: hello a");
    expect(h.state.queues.get("a")?.rows()).toEqual([expect.objectContaining({ text: "hello a", state: "dispatched" })]);
  });

  it("session clear before ack invalidates the in-flight send", async () => {
    const gate = deferred();
    const h = makeHarness({ initialTargetId: "a", send: () => gate.promise });
    type(h.view, "gone");
    h.view.handleInput("\r");
    h.state.clear();
    gate.resolve();
    await flush();
    expect(h.state.peek("a")).toBeUndefined();
    expect(h.state.hasPendingSend("a", "gone")).toBe(false);
  });

  it("constrains every line to terminal width and total to terminal rows", () => {
    const h = makeHarness({ initialTargetId: "a", rows: 40 });
    type(h.view, "wide draft that must wrap inside the editor budget");
    for (const width of [80, 30, 12]) {
      const lines = h.view.render(width);
      expect(lines.length).toBeLessThanOrEqual(40);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("prioritizes editor content at tiny heights", () => {
    const h = makeHarness({ initialTargetId: "a", rows: 4 });
    type(h.view, "tiny");
    const lines = h.view.render(80);
    expect(lines.length).toBeLessThanOrEqual(4);
    const text = lines.join("\n");
    expect(text).toContain("tiny");
    expect(text).toContain("Agent A");
  });
});

describe("partial message whose first blocks are outside the loaded window", () => {
  const delta = (type: string, contentIndex: number, text?: string) => ({
    type: "message_update",
    assistantMessageEvent: { type, contentIndex, ...(text === undefined ? {} : { delta: text }) },
  });
  const prefix = [
    { type: "message_start", message: { role: "assistant", content: [], api: "openai-responses", provider: "openai", model: "m", timestamp: 1 } },
    delta("thinking_start", 0),
    delta("thinking_delta", 0, "Synthetic reasoning."),
    delta("text_start", 1),
  ];
  const withEvents = (records: unknown[], run: (reader: NativeConversationReader, h: Harness, source: NativeConversationSource) => void): void => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "fabric-sparse-partial-"));
    try {
      const eventsFile = path.join(directory, "events.jsonl");
      writeFileSync(eventsFile, records.map((record) => JSON.stringify(record) + "\n").join(""));
      const reader = new NativeConversationReader();
      const source = { id: "a", status: "running", eventsFile };
      const h = makeHarness({ transcript: (_id, follow) => reader.read(source, follow) });
      run(reader, h, source);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  it("renders a tail that starts at a text delta for content index 1", () => {
    withEvents([delta("text_delta", 1, "VISIBLE_REPRO")], (_reader, h) => {
      expect(renderText(h.view, 100)).toContain("VISIBLE_REPRO");
    });
  });

  it("keeps the original block index when a delta arrives after publishing a sparse snapshot", () => {
    withEvents([delta("text_delta", 1, "BEFORE")], (reader, h, source) => {
      const first = reader.read(source);
      expect(first.streaming.partialAssistant?.content).toEqual([{ type: "text", text: "BEFORE" }]);
      appendFileSync(source.eventsFile!, JSON.stringify(delta("text_delta", 1, "AFTER")) + "\n");
      expect(reader.read(source).streaming.partialAssistant?.content).toEqual([
        { type: "text", text: "BEFOREAFTER" },
      ]);
      // An already published snapshot must not change when the internal block does.
      expect(first.streaming.partialAssistant?.content).toEqual([{ type: "text", text: "BEFORE" }]);
      h.view.refresh();
      expect(renderText(h.view, 100)).toContain("BEFOREAFTER");
    });
  });

  it("renders the initial page of a large stream and recovers the earlier blocks after loadOlder", () => {
    const records = [
      ...prefix,
      ...Array.from({ length: 320 }, () => delta("text_delta", 1, "x".repeat(1024) + "\n")),
      delta("text_delta", 1, "VISIBLE_REPRO"),
    ];
    withEvents(records, (reader, h, source) => {
      expect(renderText(h.view, 100)).toContain("VISIBLE_REPRO");
      expect(reader.read(source).hasMore).toBe(true);
      const older = reader.loadOlder();
      expect(older?.hasMore).toBe(false);
      expect(older?.streaming.partialAssistant?.content.map((block) => block.type)).toEqual(["thinking", "text"]);
      expect(older?.streaming.partialAssistant?.content[0]).toMatchObject({ thinking: "Synthetic reasoning." });
      h.view.refresh();
      expect(renderText(h.view, 100)).toContain("VISIBLE_REPRO");
    });
  });
});
