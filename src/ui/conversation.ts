import { getConversationHost } from "./conversation-host.js";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, KeyId, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
  CURSOR_MARKER,
  getKeybindings,
  Key,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
} from "@earendil-works/pi-tui";
import { BorderStatusEditor, BorderWorkingIndicator } from "./border-status-editor.js";
import { FabricConversationTranscriptRenderer, type FabricConversationTranscriptRendererOptions } from "./conversation-render.js";
import { conversationFooter, type FabricConversationAppearance } from "./conversation-chrome.js";
import type { AgentUsage } from "../agents/types.js";
import { safeText } from "./format.js";
import type { CodePreviewSettings } from "./code-preview.js";
import type { NativeConversationTranscript } from "./conversation-native-reader.js";
import { defaultConversationTarget } from "./conversation-targets.js";
import { ConversationTextSelection } from "./conversation-selection.js";
import { ConversationScrollbar } from "./conversation-scrollbar.js";
import { ConversationLatest } from "./conversation-latest.js";
import { isKittyImageLine, KittyViewport, type KittyViewportFrame } from "./kitty-viewport.js";
import { appendConversationPrompt, conversationPromptHistory } from "./conversation-history.js";
import { conversationAssistantText, conversationCommandCompletion, CONVERSATION_COMMAND_HELP } from "./conversation-commands.js";
import { ConversationQueueStore } from "./conversation-queue-store.js";
import type { ConversationQueue } from "./conversation-queue.js";
import { isActiveStatus } from "./types.js";
import type { FabricWidget, FabricWidgetInteraction } from "./widget.js";
import { borderBadge } from "./format.js";

export type FabricConversationDelivery = "steer" | "followUp";

export interface FabricConversationTarget {
  id: string;
  name: string;
  kind: "main" | "peer" | "agent" | "actor";
  parentId?: string;
  status: string;
  runner?: string;
  model?: string;
  thinking?: string;
  cwd?: string;
  branch?: string;
  usage?: AgentUsage;
  /** Tool calls of the current or last run. */
  toolCalls?: number;
  /** Start and end of the current or last run, for its elapsed time. */
  startedAt?: number;
  finishedAt?: number;
  contextWindow?: number;
  canSteer: boolean;
  canFollowUp: boolean;
  canStop: boolean;
  readOnlyReason?: string;
  stale?: boolean;
  /** Latest activity timestamp. */
  updatedAt?: number;
}

export interface FabricConversationStateEntry {
  draft: string;
  following: boolean;
  scroll: number;
  pageAnchor: "start" | "end" | "prepend" | undefined;
  anchorLength?: number | undefined;
  toolsExpanded: boolean;
  hideThinking?: boolean;
  lastSeenUpdatedAt: number;
  /** Session-local composer history, oldest first; lazily seeded, like Pi. */
  promptHistory?: string[];
}

const STATE_ENTRY_LIMIT = 128;

/** Session-owned in-flight send; survives view close/reopen, cleared on clear(). */
export interface FabricConversationPendingSend {
  id: string;
  message: string;
  delivery: FabricConversationDelivery;
}

/**
 * Per-target view state owned by the parent controller. Created once and
 * reused across overlay opens so drafts, scroll/following, and the selected
 * target survive close/reopen; clear() on session shutdown (and bumps epoch
 * so in-flight sends from a previous session never mutate new state).
 */
export class FabricConversationState {
  readonly queues = new ConversationQueueStore();
  selectedId: string | undefined;
  private epochCounter = 0;
  private readonly entries = new Map<string, FabricConversationStateEntry>();
  private readonly pendingSends = new Set<FabricConversationPendingSend>();

  get epoch(): number {
    return this.epochCounter;
  }

  hasPendingSend(id: string, message: string): boolean {
    for (const pending of this.pendingSends) {
      if (pending.id === id && pending.message === message) return true;
    }
    return false;
  }

  addPendingSend(pending: FabricConversationPendingSend): void {
    this.pendingSends.add(pending);
  }

  /** Acknowledged: drop the pending marker and clear only the exact accepted draft. */
  resolvePendingSend(id: string, message: string): void {
    for (const pending of this.pendingSends) {
      if (pending.id !== id || pending.message !== message) continue;
      this.pendingSends.delete(pending);
      const entry = this.entries.get(id);
      if (entry && entry.draft === message) entry.draft = "";
      return;
    }
  }

  /** Rejected: drop the pending marker; the raw draft stays untouched. */
  failPendingSend(id: string, message: string): void {
    for (const pending of this.pendingSends) {
      if (pending.id !== id || pending.message !== message) continue;
      this.pendingSends.delete(pending);
      return;
    }
  }

  /** Live view state for a target; creates (and may evict empty) entries. */
  view(id: string): FabricConversationStateEntry {
    const existing = this.entries.get(id);
    if (existing) {
      this.entries.delete(id);
      this.entries.set(id, existing);
      return existing;
    }
    const created: FabricConversationStateEntry = {
      draft: "",
      following: true,
      scroll: 0,
      pageAnchor: undefined,
      toolsExpanded: false,
      lastSeenUpdatedAt: 0,
    };
    this.entries.set(id, created);
    this.enforceLimit();
    return created;
  }

  /** Non-mutating lookup; unread checks must never create or evict drafts. */
  peek(id: string): FabricConversationStateEntry | undefined {
    return this.entries.get(id);
  }

  clear(): void {
    this.queues.clear();
    this.entries.clear();
    this.pendingSends.clear();
    this.selectedId = undefined;
    this.epochCounter++;
  }

  private enforceLimit(): void {
    while (this.entries.size > STATE_ENTRY_LIMIT) {
      let evicted = false;
      for (const key of this.entries.keys()) {
        if (key === this.selectedId) continue;
        const entry = this.entries.get(key);
        // Only discard untouched lightweight navigation state. Pinned scroll,
        // loaded-page anchors, queues and in-flight sends outlive reader suspension.
        if (entry && entry.draft === "" && entry.following && !entry.pageAnchor &&
          !entry.toolsExpanded && entry.hideThinking === undefined &&
          !this.queues.get(key) && ![...this.pendingSends].some((pending) => pending.id === key)) {
          this.entries.delete(key);
          evicted = true;
          break;
        }
      }
      if (!evicted) break;
    }
  }
}

export interface FabricConversationOptions {
  targets: () => FabricConversationTarget[];
  initialTargetId?: string;
  state: FabricConversationState;
  transcript: (id: string, followLatest: boolean) => NativeConversationTranscript;
  loadOlder: (id: string) => boolean;
  loadNewer: (id: string) => boolean;
  loadLatest: (id: string) => boolean;
  send: (id: string, message: string, delivery: FabricConversationDelivery) => Promise<unknown>;
  stop: (id: string) => Promise<unknown>;
  close: () => void;
  copyToClipboard?: (text: string) => Promise<void>;
  onTargetChange?: (id: string) => void;
  keybindings?: Pick<KeybindingsManager, "matches" | "getKeys">;
  codePreviewSettings?: CodePreviewSettings;
  appearance?: FabricConversationAppearance;
  rendererOptions?: FabricConversationTranscriptRendererOptions | undefined;
  queueEvents?: { emit(channel: string, data: unknown): void } | undefined;
  /** The agent list shown at the bottom of the window, as on the main screen. */
  participants?: (interaction: FabricWidgetInteraction) => FabricWidget;
  /** Open the background shell tasks view over this window, on one task when `id` is given. */
  openTasks?: (id: string) => void;
}

interface Feedback {
  text: string;
  kind: "info" | "error";
  at: number;
}

const FEEDBACK_TTL_MS = 8_000;
const FOLLOW_UP_FALLBACK: KeyId[] = ["alt+enter", "ctrl+q"];
const TOOLS_EXPAND_FALLBACK: KeyId[] = ["ctrl+o"];

const conversationEditorTheme = (theme: Theme, thinking: () => string | undefined): EditorTheme => ({
  borderColor: (value: string) => {
    const level = thinking();
    const color = level === "minimal" ? "thinkingMinimal" : level === "low" ? "thinkingLow"
      : level === "medium" ? "thinkingMedium" : level === "high" ? "thinkingHigh"
      : level === "xhigh" ? "thinkingXhigh" : level === "max" ? "thinkingMax" : "borderMuted";
    return theme.fg(color, value);
  },
  selectList: {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("muted", text),
    noMatch: (text: string) => theme.fg("muted", text),
  },
});

const errorText = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error ?? "");
};

const isMainTarget = (target: FabricConversationTarget | undefined): boolean =>
  target?.kind === "main";

export class FabricConversationView implements Component, Focusable {
  private focusState = true;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly options: FabricConversationOptions;
  private readonly state: FabricConversationState;
  private readonly renderer: FabricConversationTranscriptRenderer;
  private readonly scrollbar: ConversationScrollbar;
  private readonly latest = new ConversationLatest();
  private readonly imageViewport = new KittyViewport();
  private editor: BorderStatusEditor | undefined;
  private suspendedEditor: BorderStatusEditor | undefined;
  private editorEpoch = -1;
  /** The agent list below the footer; ↓ in an empty editor moves into it. */
  private readonly list: FabricWidget | undefined;
  private listFocused = false;
  private listTop = 0;
  private rawMousePress: { x: number; y: number; button: TuiMouseEvent["button"] } | undefined;
  private currentId: string | undefined;
  private feedback: Feedback | undefined;
  private commandNotification: { component: Text; epoch: number; pendingResult?: Text } | undefined;
  private notificationScope = 0;
  private stopConfirmId: string | undefined;
  private disposed = false;
  private lastBodyLength = 0;
  private lastBody: readonly string[] = [];
  private lastBodyBudget = 1;
  private editorTop = 0;
  private editorHeight = 0;
  private ownsMouseMode = false;
  private targets: FabricConversationTarget[] = [];
  private targetsKey = "";
  private readonly targetsById = new Map<string, FabricConversationTarget>();
  private nonMain: FabricConversationTarget[] = [];
  private main: FabricConversationTarget | undefined;
  private observationKey = "";
  private observedTranscript: NativeConversationTranscript | undefined;
  private working: BorderWorkingIndicator | undefined;
  private workingTargetId: string | undefined;
  private readonly textSelection = new ConversationTextSelection();
  private selectionWidth = 0;
  private selectionWasFollowing = false;
  private selectionLatestRow = 0;
  private lastLatestRow = 0;
  private selectionRegion: "body" | "footer" = "body";
  private lastFooter: readonly string[] = [];
  private lastSelectionPress: { target: string; region: "body" | "footer"; row: number; col: number; at: number; count: number } | undefined;
  private bodyTop = 0;
  private bodyHeight = 0;
  private copyVersion = 0;
  private copyTask: Promise<void> = Promise.resolve();

  constructor(
    tui: TUI,
    theme: Theme,
    options: FabricConversationOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.options = options;
    this.state = options.state;
    this.scrollbar = new ConversationScrollbar(theme, options.appearance?.scrollbar);
    this.updateTargets();
    this.renderer = new FabricConversationTranscriptRenderer(tui, theme, {
      ...options.rendererOptions,
      imageWidthCells: options.appearance?.imageWidthCells,
    });
    this.editor = this.createEditor();
    this.editorEpoch = this.state.epoch;
    this.list = options.participants?.({
      open: (row) => {
        this.releaseList();
        if (row.kind === "shell") this.options.openTasks?.(row.id);
        else this.selectTarget(row.id);
      },
      release: (forward) => this.releaseList(forward),
      requestRender: () => this.tui.requestRender(),
      viewing: () => this.currentId,
      ...(this.main ? { mainId: this.main.id } : {}),
    });
    // An explicit initialTargetId must win over state.selectedId so reissuing
    // "/fabric chat B" focuses B instead of reopening the previously selected A.
    const nonMain = this.nonMainTargets();
    const requested = options.initialTargetId ?? defaultConversationTarget(nonMain, options.state.selectedId)?.id;
    const requestedTarget = requested
      ? this.targetById(requested)
      : undefined;
    const resolved =
      requested && requestedTarget && !isMainTarget(requestedTarget)
        ? requested
        : nonMain[0]?.id;
    if (resolved) this.applySelection(resolved, false);
    if (!this.currentId) this.currentId = nonMain[0]?.id;
    // Regular Pi leaves mouse input to terminal scrollback. This preview owns
    // a separate viewport; capture wheel and drag input and restore on close.
    if (tui.mode === "regular") {
      tui.terminal.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
      this.ownsMouseMode = true;
    }
  }

  private createEditor(withHistory = true): BorderStatusEditor {
    // Own method only: assignment through Pi's live proxy would mutate Main.
    const editorTui = Object.create(this.tui, { requestRender: { value: () => {
      if (!this.disposed && this.editor === editor) this.tui.requestRender();
    } } }) as TUI;
    const editor = new BorderStatusEditor(editorTui, conversationEditorTheme(this.theme, () => this.currentTarget()?.thinking), {
      paddingX: this.options.appearance?.editorPaddingX ?? 0,
    });
    // The border carries the streaming indicator, so every editor instance —
    // including one rebuilt for a new epoch or a queue-row swap — inherits the
    // indicator that is live right now.
    editor.setWorkingStatusIndicator(this.working);
    editor.topBorderBadge = (width) => this.targetBadge(width);
    editor.focused = this.focusState && !this.listFocused;
    if (!withHistory) return editor;
    editor.setAutocompleteProvider(conversationCommandCompletion(() =>
      !this.disposed && this.editor === editor && !this.state.queues.get(this.currentId ?? "")?.editingActive));
    editor.onSubmit = (text) => {
      if (this.disposed || this.editor !== editor) return;
      // Native completion submits after clearing the editor; restore for routing.
      editor.setText(text);
      this.submit("steer");
    };
    editor.onChange = (text) => {
      if (this.editor === editor && this.currentId && !this.state.queues.get(this.currentId)?.editingActive) this.state.view(this.currentId).draft = text;
    };
    for (const text of this.currentId ? this.state.peek(this.currentId)?.promptHistory ?? [] : []) editor.addToHistory(text);
    return editor;
  }

  private releaseEditor(editor: BorderStatusEditor | undefined): void {
    if (!editor) return;
    editor.setAutocompleteProvider(conversationCommandCompletion(() => false));
    editor.focused = false;
    delete editor.onSubmit;
    delete editor.onChange;
  }

  private resetEditor(): void {
    this.releaseEditor(this.editor);
    this.releaseEditor(this.suspendedEditor);
    this.suspendedEditor = undefined;
    this.editor = this.createEditor();
    this.editorEpoch = this.state.epoch;
  }

  private ensureEditorEpoch(): void {
    if (this.editorEpoch === this.state.epoch) return;
    this.observedTranscript = undefined;
    this.observationKey = "";
    this.resetEditor();
    if (this.currentId) this.editor?.setText(this.state.view(this.currentId).draft);
  }

  private initializePromptHistory(): void {
    if (!this.currentId || !this.editor || this.suspendedEditor) return;
    const entry = this.state.view(this.currentId);
    if (entry.promptHistory !== undefined) return;
    const transcript = this.observedTranscript ?? this.options.transcript(this.currentId, entry.following);
    // A worker may not have written its initial transcript yet; retry later.
    if (transcript.unavailable) return;
    entry.promptHistory = conversationPromptHistory(transcript);
    for (const text of entry.promptHistory) this.editor.addToHistory(text);
  }

  private rememberPrompt(text: string): void {
    if (!this.currentId) return;
    this.initializePromptHistory();
    const entry = this.state.view(this.currentId);
    appendConversationPrompt(entry.promptHistory ??= [], text);
    this.editor?.addToHistory(text);
  }

  private setQueueEditorText(text: string): void {
    let restoredText = text;
    const editing = this.currentId && this.state.queues.get(this.currentId)?.editingActive;
    if (editing && !this.suspendedEditor) {
      // Preserve the composer's native history/draft; queued rows never browse it.
      this.suspendedEditor = this.editor;
      if (this.suspendedEditor) this.suspendedEditor.focused = false;
      this.editor = this.createEditor(false);
    } else if (!editing && this.suspendedEditor) {
      this.releaseEditor(this.editor);
      this.editor = this.suspendedEditor;
      this.suspendedEditor = undefined;
      this.editor.focused = this.focusState && !this.listFocused;
      this.attachWorkingIndicator();
      // An acknowledgement may have cleared the composer while a row was open.
      restoredText = this.currentId ? this.state.view(this.currentId).draft : text;
    }
    this.editor?.setText(restoredText);
  }

  get focused(): boolean {
    return this.focusState;
  }

  set focused(value: boolean) {
    this.focusState = value;
    if (this.list) this.list.focused = value && this.listFocused;
    if (this.editor) this.editor.focused = value && !this.listFocused;
  }

  /** Re-focus a target while the view is open; selecting Main closes to the native session. */
  selectTarget(id: string): void {
    this.updateTargets();
    this.applySelection(id, true);
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    this.ensureEditorEpoch();
    this.updateTargets();
    // Fullscreen Pi dispatches normalized events; regular mode forwards SGR.
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
    if (mouse) {
      const button = Number(mouse[1]);
      const wheel = (button & 64) !== 0;
      const release = mouse[4] === "m" || (!wheel && (button & 3) === 3 && !(button & 32));
      const event: TuiMouseEvent = {
        type: wheel ? "wheel" : release ? "release" : (button & 32) ? (button & 3) === 3 ? "move" : "drag" : "press",
        button: wheel ? "none" : (button & 3) === 0 ? "left" : (button & 3) === 1 ? "middle" : (button & 3) === 2 ? "right" : "none",
        ...(wheel ? { wheelDelta: (button & 1) === 0 ? -3 : 3 } : {}),
        x: Number(mouse[2]) - 1, y: Number(mouse[3]) - 1, screenX: Number(mouse[2]) - 1, screenY: Number(mouse[3]) - 1,
        width: this.tui.terminal.columns, height: this.terminalRows(), shift: !!(button & 4), alt: !!(button & 8), ctrl: !!(button & 16),
      };
      // Regular Pi forwards raw SGR input, unlike fullscreen's normalized
      // pointer dispatch. Synthesize its click only after an unmoved release;
      // the list deliberately does not activate on a press or text drag.
      const pressed = this.rawMousePress;
      if (event.type === "press") this.rawMousePress = { x: event.x, y: event.y, button: event.button };
      else if (event.type !== "move") this.rawMousePress = undefined;
      this.handleMouse(event);
      if (event.type === "release" && pressed?.button === "left" &&
        (event.button === "left" || event.button === "none") && pressed.x === event.x && pressed.y === event.y) {
        this.handleMouse({ ...event, type: "click", button: "left" });
      }
      return;
    }
    this.rawMousePress = undefined;
    if (this.listFocused && this.list) {
      this.list.handleInput(data);
      this.tui.requestRender();
      return;
    }
    this.handleConversationInput(data);
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined;
    this.ensureEditorEpoch();
    this.updateTargets();
    // The agent list sees every pointer move, so its hover clears when the pointer leaves it.
    if (this.list && !this.textSelection.dragging && (event.type === "move" || event.y >= this.listTop)) {
      const result = this.list.handleMouse({ ...event, y: event.y - this.listTop });
      if (event.y >= this.listTop) {
        if (result?.focus) this.focusList(false);
        this.tui.requestRender();
        return { handled: true };
      }
      if (result?.render) this.tui.requestRender();
      if (event.type === "move") return { handled: true };
    }
    if (!this.textSelection.dragging && this.latest.hit(event)) {
      this.followLatest();
      this.tui.requestRender();
      return { handled: true };
    }
    if (this.currentId && !this.textSelection.dragging &&
      this.scrollbar.handleMouse(event, (position) => {
        const entry = this.state.view(this.currentId!);
        this.textSelection.clear();
        entry.pageAnchor = undefined;
        entry.anchorLength = undefined;
        entry.scroll = position;
        entry.following = position === Math.max(0, this.lastBodyLength - this.lastBodyBudget);
      })) {
      this.textSelection.clear();
      this.tui.requestRender();
      return { handled: true, capture: true };
    }
    if (event.type === "wheel") {
      this.scrollBy(event.wheelDelta ?? 0);
      this.tui.requestRender();
      return { handled: true };
    }
    if (!this.currentId) return { handled: true };
    const entry = this.state.view(this.currentId);
    const inBody = event.y >= this.bodyTop && event.y < this.bodyTop + this.bodyHeight;
    const footerTop = this.editorTop + this.editorHeight;
    const inFooter = event.y >= footerTop && event.y < footerTop + this.lastFooter.length;
    const region = this.textSelection.dragging ? this.selectionRegion : inFooter ? "footer" : "body";
    const row = region === "footer"
      ? Math.max(0, Math.min(this.lastFooter.length - 1, event.y - footerTop))
      : entry.scroll + Math.max(0, Math.min(this.bodyHeight - 1, event.y - this.bodyTop));
    if (event.type === "press" && event.button === "left" && (inBody || inFooter)) {
      this.selectionRegion = region;
      this.selectionWasFollowing = entry.following;
      this.selectionLatestRow = this.lastLatestRow;
      if (region === "body") entry.following = false;
      const previous = this.lastSelectionPress;
      const now = Date.now();
      const count = previous?.target === this.currentId && previous.region === region && previous.row === row &&
        Math.abs(previous.col - event.x) <= 1 && now - previous.at < 500 ? previous.count % 3 + 1 : 1;
      this.lastSelectionPress = { target: this.currentId, region, row, col: event.x, at: now, count };
      this.textSelection.start(region === "footer" ? this.lastFooter : this.lastBody, row, event.x, count);
      this.tui.requestRender();
      return { handled: true, capture: true };
    }
    if (this.textSelection.dragging && (event.type === "drag" || event.type === "release")) {
      if (event.type === "drag") {
        this.lastSelectionPress = undefined;
        this.textSelection.move(row, event.x);
      }
      else {
        this.textSelection.finish(row, event.x);
        if (this.selectionRegion === "body" && !this.textSelection.active && this.selectionWasFollowing) entry.following = true;
        if (this.textSelection.active && (this.options.appearance?.copyOnSelect ?? true)) this.copySelection();
      }
      this.tui.requestRender();
      return { handled: true, render: true };
    }
    if (event.type === "press") this.textSelection.clear();
    if (event.y >= this.editorTop && event.y < this.editorTop + this.editorHeight) {
      return this.editor?.handleMouse({ ...event, y: event.y - this.editorTop, height: this.editorHeight }) ?? { handled: true };
    }
    // Never fall back to the host's selection or paste handlers behind an overlay.
    return { handled: true };
  }

  render(width: number): string[] {
    this.latest.clear();
    if (this.disposed || width <= 0) return [];
    this.updateTargets();
    if (width !== this.selectionWidth) {
      this.textSelection.clear();
      this.selectionWidth = width;
    }
    const rows = Math.max(1, this.terminalRows());
    this.markCurrentTargetSeen();
    this.reconcileEditor();
    const target = this.currentTarget();
    const queue = this.currentQueue();
    this.observe();
    const contentWidth = this.scrollbar.contentWidth(width);
    const liveTranscriptLines = this.transcriptLines(contentWidth);
    const transcriptLines = (this.selectionRegion === "body" ? this.textSelection.source : undefined) ?? liveTranscriptLines;
    let queueLines = queue?.render(width) ?? [];
    // Native components own their interior padding. Giving them the full width
    // keeps user backgrounds and editor rules flush with both terminal edges.
    let editorLines = !(queue?.editingActive && queue.mode === "extension") ? this.renderEditorLines(width) : [];
    const editorBudget = Math.min(editorLines.length, Math.max(1, rows - (rows >= 6 ? 3 : 0)));
    // The editor border carries the streaming indicator, so the transcript tail
    // only needs its history-row fallback while the top border is unmounted.
    let editorShowsTopBorder = editorLines.length > 0;
    if (editorLines.length > editorBudget) {
      const cursor = Math.max(0, editorLines.findIndex((line) => line.includes(CURSOR_MARKER)));
      const start = Math.max(0, Math.min(cursor - Math.floor(editorBudget / 2), editorLines.length - editorBudget));
      editorShowsTopBorder = start === 0;
      editorLines = editorLines.slice(start, start + editorBudget);
    }
    let remaining = rows - editorLines.length;
    const liveFooter = conversationFooter(target, this.theme, width).slice(0, Math.max(0, remaining - 1));
    this.lastFooter = this.selectionRegion === "footer" && this.textSelection.source
      ? this.textSelection.source.slice(0, liveFooter.length) : liveFooter;
    const footer = this.selectionRegion === "footer" && this.textSelection.active
      ? this.lastFooter.map((line, row) => this.textSelection.highlight(line, row, this.theme))
      : this.lastFooter;
    remaining -= footer.length;
    // The list keeps at least three transcript rows above the editor.
    const list = (this.list?.render(width) ?? []).slice(0, Math.max(0, remaining - 3));
    remaining -= list.length;
    const head: string[] = [];
    const feedback = this.currentFeedbackLine(width);
    if (feedback !== undefined && remaining > 1) {
      head.push(feedback);
      remaining--;
    }
    // Match Pi's fixed above-editor spacer: it stays below the scrolling
    // viewport (and any queued messages), including while reading old history.
    // On tiny screens, keep one transcript row instead of reserving the gap.
    const editorGap = editorShowsTopBorder && remaining > 1 ? [""] : [];
    remaining -= editorGap.length;
    const queueBudget = Math.max(0, remaining - 1);
    if (queueLines.length > queueBudget) {
      const cursor = queueLines.findIndex((line) => line.includes(CURSOR_MARKER));
      const start = Math.max(0, Math.min(cursor < 0 ? 0 : cursor - Math.floor(queueBudget / 2), queueLines.length - queueBudget));
      queueLines = queueLines.slice(start, start + queueBudget);
    }
    remaining -= queueLines.length;
    this.editorTop = rows - editorLines.length - footer.length - list.length;
    this.listTop = rows - list.length;
    this.editorHeight = editorLines.length;
    const window = remaining > 0
      ? this.windowBody(transcriptLines, remaining, this.transcriptTail(contentWidth, remaining, editorShowsTopBorder))
      : undefined;
    let body = window?.lines ?? [];
    const scroll = this.currentId ? this.state.view(this.currentId).scroll : 0;
    this.bodyHeight = Math.max(0, Math.min(remaining, this.lastBody.length - scroll));
    let imageRows = window?.imageRows;
    if (this.selectionRegion === "body" && this.textSelection.active) {
      for (let row = 0; row < this.bodyHeight; row++) {
        if (!imageRows?.has(row)) body[row] = this.textSelection.highlight(body[row]!, scroll + row, this.theme);
      }
    }
    // A short transcript sits on the editor, as Pi's own does: blank rows go
    // above it. While the jump-to-latest label shows, its row stays below.
    const following = this.currentId ? this.state.view(this.currentId).following : true;
    // A selection must not introduce a jump-to-latest row under the pointer.
    const latestRow = this.selectionRegion === "body" && this.textSelection.source
      ? this.selectionLatestRow : !following || !!this.observedTranscript?.hasNewer ? 1 : 0;
    this.lastLatestRow = latestRow;
    const pad = Math.max(0, remaining - body.length - latestRow);
    if (pad > 0) {
      body = [...Array.from({ length: pad }, () => ""), ...body];
      if (imageRows) imageRows = new Set([...imageRows].map((row) => row + pad));
    }
    while (body.length < remaining) body.push("");
    this.bodyTop = head.length + pad;
    if (remaining > 0) {
      const entry = this.currentId ? this.state.view(this.currentId) : undefined;
      this.scrollbar.sync(width, head.length, remaining, this.lastBodyLength, scroll, entry?.following ?? true,
        () => { if (!this.disposed) this.tui.requestRender(); });
      this.scrollbar.paint(body, imageRows);
      this.latest.paint(body, width, head.length, !imageRows?.has(body.length - 1) && !!entry && latestRow > 0,
        this.scrollbar.visible, this.theme);
    } else this.scrollbar.reset();
    return [...head, ...body.slice(0, remaining), ...queueLines, ...editorGap, ...editorLines, ...footer, ...list]
      .slice(0, rows)
      .map((line) => isKittyImageLine(line) || visibleWidth(line) <= width ? line : truncateToWidth(line, width, ""));
  }

  /** Observe files without rendering native history; true means a visible change
   * or a live animation still needs the normal TUI render path. */
  refresh(): boolean {
    if (this.disposed) return false;
    this.updateTargets();
    const changed = this.observe();
    // Byte-bounded tail pages can contain only a hidden message or a collapsed
    // tool, leaving older visible history offscreen until the first scroll.
    // Fill at most one page per existing refresh tick, outside render(), and
    // never move a user's pinned history window or fetch newer records.
    if (this.currentId && this.state.view(this.currentId).following &&
      this.observedTranscript?.hasMore && !this.observedTranscript.hasNewer &&
      this.lastBody.length > 0 && this.lastBody.length < this.lastBodyBudget &&
      this.options.loadOlder(this.currentId)) {
      this.observe();
      return true;
    }
    return changed || this.selectedTargetIsWorking();
  }

  private observe(): boolean {
    const entry = this.currentId ? this.state.view(this.currentId) : undefined;
    const transcript = this.currentTarget() && this.currentId && entry
      ? this.options.transcript(this.currentId, entry.following) : undefined;
    if (transcript && this.currentId) this.state.queues.sync(this.currentId, transcript);
    const key = JSON.stringify([this.targetsKey, this.currentId, entry?.draft,
      this.feedback && Date.now() - this.feedback.at <= FEEDBACK_TTL_MS ? this.feedback : undefined,
      transcript && [transcript.sourceId, transcript.sessionId, transcript.sessionFile, transcript.eventsFile,
        transcript.revision, transcript.status, transcript.leafId, transcript.historyComplete, transcript.hasMore,
        transcript.hasNewer, transcript.unavailable, transcript.error, transcript.pendingMessages]]);
    const previous = this.observedTranscript;
    const changed = key !== this.observationKey || previous?.messages !== transcript?.messages ||
      previous?.entries !== transcript?.entries || previous?.streaming !== transcript?.streaming;
    this.observationKey = key;
    this.observedTranscript = transcript;
    this.syncWorkingIndicator();
    return changed;
  }

  private selectedTargetIsWorking(): boolean {
    const target = this.currentTarget();
    if (!target || target.stale) return false;
    // A killed worker can leave a partial message/tool in its log forever.
    // That retained tail must not override terminal or unavailable ownership.
    return isActiveStatus(target.status);
  }

  private syncWorkingIndicator(): void {
    const active = !this.disposed && this.currentId && this.selectedTargetIsWorking();
    if (!active) {
      this.stopWorkingIndicator();
      return;
    }
    if (this.working && this.workingTargetId === this.currentId) return;
    this.stopWorkingIndicator();
    const id = this.currentId;
    this.workingTargetId = id;
    // Pi paints the embedded indicator in the thinking-level border color, so
    // the border owns both the spinner and the label rather than accent/muted.
    const color = (text: string): string => this.editor?.borderColor(text) ?? this.theme.fg("borderMuted", text);
    this.working = new BorderWorkingIndicator({ requestRender: () => {
      if (!this.disposed && this.currentId === id) this.tui.requestRender();
    } } as TUI, color, "Working");
    this.attachWorkingIndicator();
  }

  /** Every editor instance that can be mounted (composer, suspended queue-row
   *  composer) carries the live indicator, and nothing keeps a stale one. */
  private attachWorkingIndicator(): void {
    this.editor?.setWorkingStatusIndicator(this.working);
    this.suspendedEditor?.setWorkingStatusIndicator(this.working);
  }

  private stopWorkingIndicator(): void {
    this.working?.stop();
    this.working = undefined;
    this.workingTargetId = undefined;
    this.attachWorkingIndicator();
  }

  invalidate(): void {
    this.working?.invalidate();
    this.commandNotification?.component.invalidate();
    this.commandNotification?.pendingResult?.invalidate();
    this.renderer.invalidate();
    this.editor?.invalidate();
    this.list?.invalidate();
  }

  dispose(): void {
    if (this.currentId) this.state.queues.detach(this.currentId);
    this.disposed = true;
    this.latest.clear();
    this.scrollbar.reset();
    this.clearCommandNotification();
    this.copyVersion++;
    this.textSelection.clear();
    this.stopWorkingIndicator();
    this.releaseEditor(this.editor);
    this.releaseEditor(this.suspendedEditor);
    this.suspendedEditor = undefined;
    this.editor = undefined;
    this.observedTranscript = undefined;
    this.lastBody = [];
    this.renderer.dispose();
    this.imageViewport.clear();
    if (this.ownsMouseMode) {
      this.ownsMouseMode = false;
      this.tui.terminal.write("\x1b[?1002l\x1b[?1000l\x1b[?1006l");
    }
  }

  /** Keep the editor in sync with the shared session draft (e.g. after an ack
   * that landed while a previous view instance was disposed). */
  private reconcileEditor(): void {
    this.ensureEditorEpoch();
    if (!this.editor || !this.currentId) return;
    if (this.state.queues.get(this.currentId)?.editingActive) return;
    if (this.state.hasPendingSend(this.currentId, this.editor.getText())) return;
    const draft = this.state.view(this.currentId).draft;
    if (this.editor.getText() !== draft) this.editor.setText(draft);
  }

  private applySelection(id: string, requestRender: boolean): void {
    if (this.currentId && this.currentId !== id) this.state.queues.detach(this.currentId);
    const target = this.targetById(id);
    if (!target) {
      this.feedback = {
        text: `Unknown target ${safeText(id)}`,
        kind: "error",
        at: Date.now(),
      };
      if (requestRender) this.tui.requestRender();
      return;
    }
    if (isMainTarget(target)) {
      this.options.close();
      return;
    }
    const changed = this.currentId !== id;
    if (changed) {
      this.latest.clear();
      this.scrollbar.reset();
      this.clearCommandNotification();
      this.copyVersion++;
      this.textSelection.clear();
      this.stopWorkingIndicator();
      this.observedTranscript = undefined;
      this.observationKey = "";
      this.lastBody = [];
      this.lastBodyLength = 0;
      this.renderer.invalidate();
      this.options.onTargetChange?.(id);
    }
    this.currentId = id;
    this.state.selectedId = id;
    if (changed) this.resetEditor();
    const entry = this.state.view(id);
    entry.lastSeenUpdatedAt = target.updatedAt ?? Date.now();
    this.stopConfirmId = undefined;
    this.feedback = undefined;
    this.editor?.setText(entry.draft);
    if (requestRender) this.tui.requestRender();
  }

  private markCurrentTargetSeen(): void {
    if (!this.currentId) return;
    const target = this.targetById(this.currentId);
    if (!target?.updatedAt) return;
    const entry = this.state.view(this.currentId);
    if (entry.lastSeenUpdatedAt < target.updatedAt) entry.lastSeenUpdatedAt = target.updatedAt;
  }

  private updateTargets(): void {
    // One provider observation per frame/input, including providers that mutate
    // their roster in place. The fingerprint contains metadata, never history.
    const targets = this.options.targets();
    const key = JSON.stringify(targets);
    if (key === this.targetsKey) return;
    this.targetsKey = key;
    this.targets = targets;
    this.targetsById.clear();
    for (const target of targets) {
      if (!this.targetsById.has(target.id)) this.targetsById.set(target.id, target);
    }
    this.nonMain = targets.filter((target) => !isMainTarget(target));
    this.main = targets.find(isMainTarget);
  }

  private nonMainTargets(): FabricConversationTarget[] {
    return this.nonMain;
  }

  private currentTarget(): FabricConversationTarget | undefined {
    return this.currentId ? this.targetById(this.currentId) : undefined;
  }

  private targetById(id: string): FabricConversationTarget | undefined {
    return this.targetsById.get(id);
  }

  private terminalRows(): number {
    return this.tui.terminal?.rows ?? process.stdout.rows ?? 28;
  }

  /**
   * Respects a configured binding; when an injected manager reports no keys
   * the binding is unbound (never falls back), and only the default global
   * manager (no injection) falls back to hard-coded keys.
   */
  private bindingMatches(
    data: string,
    binding: "app.message.followUp" | "app.message.copy" | "app.tools.expand" | "app.thinking.toggle",
    fallbackKeys: KeyId[],
  ): boolean {
    if (this.options.keybindings) {
      const keys = this.options.keybindings.getKeys(binding);
      return keys.length > 0 && this.options.keybindings.matches(data, binding);
    }
    const global = getKeybindings();
    const keys = global.getKeys(binding);
    if (keys.length > 0) return global.matches(data, binding);
    return fallbackKeys.some((key) => matchesKey(data, key));
  }

  private handleConversationInput(data: string): void {
    const editor = this.editor;
    if (!editor) return;
    this.feedback = undefined;
    if (this.stopConfirmId === undefined && this.bindingMatches(data, "app.message.copy", ["ctrl+shift+c"])) {
      this.copyResponse(undefined, true);
      return;
    }
    if (this.stopConfirmId === undefined && this.textSelection.active && matchesKey(data, Key.ctrl("c"))) {
      this.copySelection();
      return;
    }
    if (this.stopConfirmId === undefined && this.textSelection.source && matchesKey(data, Key.escape)) {
      this.textSelection.clear();
      return;
    }
    const queue = this.currentQueue();
    if (this.stopConfirmId === undefined && !queue?.editingActive && editor.isShowingAutocomplete() &&
        [Key.enter, Key.tab, Key.up, Key.down, Key.escape].some((key) => matchesKey(data, key))) {
      editor.handleInput(data);
      return;
    }
    if (this.stopConfirmId === undefined && queue?.handleInput(data)) return;

    if (this.stopConfirmId !== undefined) {
      if (matchesKey(data, Key.enter)) {
        const target = this.targetById(this.stopConfirmId);
        this.stopConfirmId = undefined;
        if (target) this.dispatchStop(target);
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.stopConfirmId = undefined;
        this.notifyCommand("Stop cancelled");
        return;
      }
      this.stopConfirmId = undefined;
      this.notifyCommand("Stop cancelled");
    }

    if (this.bindingMatches(data, "app.message.followUp", FOLLOW_UP_FALLBACK)) {
      this.submit("followUp");
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.submit("steer");
      return;
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      if (editor.getText().length > 0) editor.setText("");
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.options.close();
      return;
    }
    // ↓ in an empty editor moves into the agent list, as on the main screen.
    if (matchesKey(data, Key.down) && editor.getText().length === 0 && this.list?.hasRows()) {
      this.focusList(true);
      return;
    }
    const viewportKeys = getKeybindings();
    if (viewportKeys.matches(data, "tui.altScreen.previousPrompt")) { this.scrollPrompt(-1); return; }
    if (viewportKeys.matches(data, "tui.altScreen.nextPrompt")) { this.scrollPrompt(1); return; }
    if (viewportKeys.matches(data, "tui.altScreen.lineUp")) { this.scrollBy(-1); return; }
    if (viewportKeys.matches(data, "tui.altScreen.lineDown")) { this.scrollBy(1); return; }
    if (viewportKeys.matches(data, "tui.altScreen.pageUp")) { this.scrollBy(-Math.max(1, this.lastBodyBudget - 2)); return; }
    if (viewportKeys.matches(data, "tui.altScreen.pageDown")) { this.scrollBy(Math.max(1, this.lastBodyBudget - 2)); return; }
    if (viewportKeys.matches(data, "tui.altScreen.halfPageUp")) { this.scrollBy(-Math.max(1, Math.floor(this.lastBodyBudget / 2))); return; }
    if (viewportKeys.matches(data, "tui.altScreen.halfPageDown")) { this.scrollBy(Math.max(1, Math.floor(this.lastBodyBudget / 2))); return; }
    if (viewportKeys.matches(data, "tui.altScreen.top")) { this.scrollToTop(); return; }
    if (viewportKeys.matches(data, "tui.altScreen.bottom")) { this.followLatest(); return; }
    if (this.bindingMatches(data, "app.thinking.toggle", ["ctrl+t"])) {
      this.textSelection.clear();
      if (this.currentId) {
        const entry = this.state.view(this.currentId);
        entry.hideThinking = !(entry.hideThinking ?? this.options.appearance?.hideThinkingBlock ?? false);
      }
      return;
    }
    if (this.bindingMatches(data, "app.tools.expand", TOOLS_EXPAND_FALLBACK)) {
      this.textSelection.clear();
      if (this.currentId) {
        const entry = this.state.view(this.currentId);
        entry.toolsExpanded = !entry.toolsExpanded;
      }
      return;
    }
    if (viewportKeys.matches(data, "tui.editor.cursorUp") || viewportKeys.matches(data, "tui.editor.cursorDown") ||
        viewportKeys.matches(data, "tui.editor.historyPrevious") || viewportKeys.matches(data, "tui.editor.historyNext")) this.initializePromptHistory();
    editor.handleInput(data);
  }

  private clearCommandNotification(): void {
    this.commandNotification = undefined;
    this.notificationScope++;
  }

  private notifyCommand(message: string, kind: Feedback["kind"] = "info",
    options: { reserve?: string; reveal?: boolean } = {}): void {
    if (this.disposed || !this.currentId || !this.currentTarget()) return;
    this.feedback = undefined;
    // Pi showStatus/showError use Spacer(1) + Text, not the input/status dock.
    // Retain one local result, rather than implement a full notification history.
    const text = safeText(message).slice(0, 4096);
    this.commandNotification = {
      component: new Text(this.theme.fg(kind === "error" ? "error" : "dim", kind === "error" ? `Error: ${text}` : text),
        kind === "error" ? this.options.appearance?.outputPad ?? 1 : 1, 0),
      epoch: this.state.epoch,
      ...(options.reserve !== undefined ? { pendingResult: new Text(this.theme.fg("dim", safeText(options.reserve).slice(0, 4096)), 1, 0) } : {}),
    };
    // Reveal the result in the loaded window; do not fetch newer history or
    // change following/selection when the user is inspecting an older page.
    if (options.reveal !== false) {
      const entry = this.state.view(this.currentId);
      entry.pageAnchor = entry.following ? undefined : "end";
      entry.anchorLength = undefined;
    }
    this.tui.requestRender();
  }

  private copyFeedback(text: string, kind: Feedback["kind"], command?: string, reveal = true): void {
    if (command !== undefined) this.notifyCommand(text, kind, { reveal });
    else {
      // A shortcut superseding a slash copy must not leave a pending result.
      if (this.commandNotification?.pendingResult) this.clearCommandNotification();
      this.feedback = { text: safeText(text), kind, at: Date.now() };
    }
  }

  private copySelection(command?: string): void {
    const text = this.textSelection.text();
    if (!text) {
      this.copyFeedback("No transcript text selected. Drag to select first.", "error", command);
      return;
    }
    this.copyText(text, "Copied selected transcript text", command);
  }

  private copyResponse(command?: string, preferSelection = false): void {
    if (preferSelection && this.textSelection.active) { this.copySelection(command); return; }
    if (!this.currentId) return;
    const transcript = this.options.transcript(this.currentId, false);
    if (transcript.hasNewer) {
      this.copyFeedback("Use /latest before /copy to load the latest response.", "error", command);
      return;
    }
    const text = conversationAssistantText(transcript);
    if (!text) {
      this.copyFeedback("No assistant response to copy yet.", "error", command);
      return;
    }
    this.copyText(text, "Copied last assistant response", command);
  }

  private copyText(text: string, message: string, command?: string): void {
    const id = this.currentId;
    const epoch = this.state.epoch;
    const version = ++this.copyVersion;
    const editor = this.editor;
    // Completion removes the suggestion rows synchronously. Reserve the final
    // result now, so clipboard latency cannot produce a blank, shifting frame.
    if (command !== undefined) this.notifyCommand("Copying…", "info", { reserve: message });
    const notification = this.commandNotification;
    const current = (): boolean => !this.disposed && this.currentId === id && this.state.epoch === epoch && this.copyVersion === version;
    // A newer command owns the notification, but does not cancel the copy itself.
    const currentResult = (): boolean => current() && (command === undefined || this.commandNotification === notification);
    // Serialize writes so a slower older copy cannot overwrite a newer one.
    this.copyTask = this.copyTask.then(() => {
      if (current()) return (this.options.copyToClipboard ?? getConversationHost().copyToClipboard)(text);
    }).then(() => {
      if (!currentResult()) return;
      if (command !== undefined && id) {
        if (this.state.peek(id)?.draft === command) this.state.view(id).draft = "";
        if (editor?.getText() === command) editor.setText("");
      }
      this.copyFeedback(message, "info", command, false);
      this.tui.requestRender();
    }, (error: unknown) => {
      if (!currentResult()) return;
      this.copyFeedback(`Copy failed: ${errorText(error)}`, "error", command, false);
      this.tui.requestRender();
    });
  }

  private submit(delivery: FabricConversationDelivery): void {
    const editor = this.editor;
    const target = this.currentTarget();
    if (!editor || !target || isMainTarget(target)) return;
    const raw = editor.getText();
    const message = editor.getExpandedText();
    if (!message.trim()) return;
    const command = message.trim().replace(/[\t ]+/g, " ");
    // Commands belong only to this target's in-memory editor history, including
    // failed attempts. Remember before navigation/validation, never via send.
    if (command.startsWith("/")) this.rememberPrompt(message);
    if (command === "/copy") { this.copyResponse(raw); return; }
    if (command === "/copy selection") { this.copySelection(raw); return; }
    if (command === "/help") {
      editor.setText("");
      this.notifyCommand(CONVERSATION_COMMAND_HELP);
      return;
    }
    if (command === "/latest") {
      editor.setText("");
      this.followLatest();
      this.notifyCommand("Following latest output");
      return;
    }

    if (command === "/back") {
      this.options.close();
      return;
    }
    if (command === "/stop") {
      if (!target.canStop) {
        this.notifyCommand(`Stop unavailable for ${target.name}: the selected target cannot be stopped from here.`, "error");
        return;
      }
      this.stopConfirmId = target.id;
      this.notifyCommand(`Press enter again to stop ${target.name} · esc cancels`);
      return;
    }
    if (message.trim().startsWith("/") || message.trim().startsWith("!")) {
      this.notifyCommand(`Unsupported command "${message.trim()}" is not forwarded from this view. Use /help for preview commands.`, "error");
      return;
    }
    if (target.readOnlyReason) {
      this.feedback = {
        text: safeText(`${target.name} is read-only: ${target.readOnlyReason}`),
        kind: "error",
        at: Date.now(),
      };
      return;
    }
    if (delivery === "steer" && !target.canSteer) {
      this.feedback = {
        text: safeText(`${target.name} does not accept steering messages right now.`),
        kind: "error",
        at: Date.now(),
      };
      return;
    }
    if (delivery === "followUp" && !target.canFollowUp) {
      this.feedback = {
        text: safeText(`${target.name} does not accept follow-up messages right now.`),
        kind: "error",
        at: Date.now(),
      };
      return;
    }
    const queue = this.currentQueue();
    if (!queue) return;
    this.textSelection.clear();
    this.state.queues.sync(target.id, this.options.transcript(target.id, true));
    if (queue.mode === "extension" && delivery === "followUp" && !isActiveStatus(target.status)) {
      const parked = queue.park(message, delivery);
      if (parked.ok) { this.rememberPrompt(message); this.state.view(target.id).draft = ""; editor.setText(""); }
      return;
    }
    // Session-owned pending marker: blocks duplicate submission of the same
    // raw draft for the same target across view close/reopen.
    if (this.state.hasPendingSend(target.id, raw)) return;
    this.rememberPrompt(message);
    const pending: FabricConversationPendingSend = { id: target.id, message: raw, delivery };
    this.state.addPendingSend(pending);
    const epoch = this.state.epoch;
    this.feedback = {
      text: safeText(`Sending ${delivery} → ${target.name}…`),
      kind: "info",
      at: Date.now(),
    };
    void Promise.resolve()
      .then(() => queue.dispatch(message, delivery))
      .then(() => {
        // Same-session acks mutate shared state even if this view was closed;
        // only a session clear (epoch change) invalidates the result.
        if (this.state.epoch !== epoch) return;
        this.state.resolvePendingSend(target.id, raw);
        if (this.disposed) return;
        if (this.currentId === target.id && this.editor === editor && editor.getText() === raw) {
          editor.setText("");
        }
        this.feedback = {
          text: safeText(`Queued ${delivery} → ${target.name}`),
          kind: "info",
          at: Date.now(),
        };
        this.tui.requestRender();
      })
      .catch((error: unknown) => {
        if (this.state.epoch !== epoch) return;
        this.state.failPendingSend(target.id, raw);
        if (this.disposed) return;
        // Keep the raw draft including whitespace and any newer editing; never merge.
        this.feedback = {
          text: safeText(
            `Send failed for ${target.name} (${delivery}): ${errorText(error)}`,
          ),
          kind: "error",
          at: Date.now(),
        };
        this.tui.requestRender();
      });
  }

  private dispatchStop(target: FabricConversationTarget): void {
    const epoch = this.state.epoch;
    const scope = this.notificationScope;
    const current = (): boolean => !this.disposed && epoch === this.state.epoch &&
      scope === this.notificationScope && this.currentId === target.id;
    this.notifyCommand(`Stopping ${target.name}…`);
    void Promise.resolve()
      .then(() => this.options.stop(target.id))
      .then(() => {
        if (current()) this.notifyCommand(`Stop requested for ${target.name}`);
      })
      .catch((error: unknown) => {
        if (current()) this.notifyCommand(`Stop failed for ${target.name}: ${errorText(error)}`, "error");
      });
  }

  /** Move keyboard focus into the agent list; `keyboard` selects the agent on screen. */
  private focusList(keyboard: boolean): void {
    if (!this.list) return;
    this.listFocused = true;
    if (keyboard) this.list.selectDefault();
    this.list.focused = this.focusState;
    if (this.editor) this.editor.focused = false;
  }

  /** Give focus back to the editor; `forward` is a key the list did not use. */
  private releaseList(forward?: string): void {
    if (!this.listFocused) return;
    this.listFocused = false;
    if (this.list) this.list.focused = false;
    if (this.editor) this.editor.focused = this.focusState;
    if (forward !== undefined) this.handleConversationInput(forward);
    this.tui.requestRender();
  }

  private scrollBy(delta: number): void {
    if (!this.currentId || !Number.isFinite(delta) || delta === 0) return;
    if (!this.textSelection.dragging) this.textSelection.clear();
    const entry = this.state.view(this.currentId);
    const maxScroll = Math.max(0, this.lastBodyLength - this.lastBodyBudget);
    const position = entry.following ? maxScroll : entry.scroll;
    // A wheel/key gesture wins over an unpainted command-result reveal.
    if (entry.pageAnchor === "end") entry.pageAnchor = undefined;
    // Downward overscroll at the live tail is still follow mode. Paging here
    // can succeed on fresh activity and leave the view pinned between frames,
    // alternating the Working row with the newer-activity notice.
    if (entry.following && delta > 0) return;
    const next = position + Math.trunc(delta);
    entry.following = false;
    if (next < 0 && !this.textSelection.dragging && this.options.loadOlder(this.currentId)) {
      // Native history pages prepend records instead of replacing the tail.
      // Preserve the old viewport anchor, then apply the requested movement.
      entry.pageAnchor = "prepend";
      entry.anchorLength = this.lastBody.length;
      entry.scroll = next;
      return;
    }
    if (next > maxScroll && !this.textSelection.dragging && this.options.loadNewer(this.currentId)) {
      entry.scroll = next;
      return;
    }
    entry.scroll = Math.max(0, Math.min(next, maxScroll));
    if (delta > 0 && entry.scroll === maxScroll) entry.following = true;
  }

  private scrollPrompt(direction: -1 | 1): void {
    if (!this.currentId) return;
    const entry = this.state.view(this.currentId);
    const position = entry.following ? Math.max(0, this.lastBodyLength - this.lastBodyBudget) : entry.scroll;
    const prompts = this.lastBody.flatMap((line, index) => line.includes("\x1b]133;A") ? [index] : []);
    const target = direction < 0 ? prompts.filter((row) => row < position).at(-1) : prompts.find((row) => row > position);
    this.scrollBy(target === undefined ? direction * Math.max(1, this.lastBodyBudget) : target - position);
  }

  private scrollToTop(): void {
    if (!this.currentId) return;
    this.textSelection.clear();
    const entry = this.state.view(this.currentId);
    entry.following = false;
    entry.scroll = 0;
    if (this.options.loadOlder(this.currentId)) entry.pageAnchor = "start";
  }

  private followLatest(): void {
    this.latest.clear();
    this.textSelection.clear();
    if (!this.currentId) return;
    this.options.loadLatest(this.currentId);
    const entry = this.state.view(this.currentId);
    entry.following = true;
    entry.pageAnchor = undefined;
    entry.anchorLength = undefined;
  }

  /** The participant's own name on the editor border; lineage stays in the agent list below. */
  private targetBadge(width: number): string {
    const target = this.currentTarget();
    const labelWidth = Math.max(0, width - 2);
    const access = target?.readOnlyReason ? " · read-only" : "";
    const name = target ? (isMainTarget(target) ? "Main" : safeText(target.name) || safeText(target.id)) : "Fabric";
    // Keep the access label when it fits alongside at least one cell of the name.
    const suffix = visibleWidth(access) + 1 <= labelWidth ? access : "";
    const label = truncateToWidth(name, Math.max(0, labelWidth - visibleWidth(suffix)), "…") + suffix;
    // A block in the editor's thinking-level border colour, with black or white text.
    return borderBadge(this.editor?.borderColor("─") ?? "", label);
  }
  private currentFeedbackLine(width: number): string | undefined {
    if (!this.feedback) return undefined;
    if (Date.now() - this.feedback.at > FEEDBACK_TTL_MS) return undefined;
    const color = this.feedback.kind === "error" ? "error" : "accent";
    return truncateToWidth(this.theme.fg(color, this.feedback.text), width, "");
  }

  private renderEditorLines(innerWidth: number): string[] {
    const editor = this.editor;
    if (!editor) return [];
    return editor.render(innerWidth);
  }

  private currentQueue(): ConversationQueue | undefined {
    const target = this.currentTarget();
    if (!target || target.kind === "main" || !this.editor || this.disposed) return undefined;
    return this.state.queues.attach({
      targetId: target.id, targetName: target.name,
      piEvents: this.options.queueEvents ?? { emit() {} }, theme: this.theme,
      send: (message, delivery) => {
        if (message.trimStart().startsWith("/") || message.trimStart().startsWith("!")) {
          return Promise.reject(new Error("Commands cannot be sent from queued edits; use the preview composer."));
        }
        return this.options.send(target.id, message, delivery);
      },
      editor: {
        getText: () => this.editor?.getText() ?? "",
        setText: (text) => this.setQueueEditorText(text),
        handleInput: (data) => this.editor?.handleInput(data),
        render: (width) => this.editor?.render(width) ?? [],
        paddingX: this.options.appearance?.editorPaddingX ?? 0,
      },
      ...(this.options.keybindings ? { keybindings: this.options.keybindings } : {}),
      isIdle: () => !isActiveStatus(this.targetById(target.id)?.status ?? "stopped"),
      onNotify: (text, kind) => {
        if (kind === "error" && !this.disposed && this.currentId === target.id) this.feedback = { text: safeText(text), kind, at: Date.now() };
      },
      requestRender: () => { if (!this.disposed && this.currentId === target.id) this.tui.requestRender(); },
    });
  }

  private transcriptLines(innerWidth: number): readonly string[] {
    const target = this.currentTarget();
    if (!target || !this.currentId) return [this.theme.fg("dim", "No target selected.")];
    const entry = this.state.view(this.currentId);
    const transcript = this.observedTranscript ?? this.options.transcript(this.currentId, entry.following);
    return this.renderer.render(transcript, innerWidth, {
      target,
      toolsExpanded: entry.toolsExpanded,
      hideThinking: entry.hideThinking ?? this.options.appearance?.hideThinkingBlock ?? false,
      showImages: this.options.appearance?.showImages ?? true,
      outputPad: this.options.appearance?.outputPad ?? 1,
      ...(this.options.appearance?.codeBlockIndent !== undefined ? { codeBlockIndent: this.options.appearance.codeBlockIndent } : {}),
      codePreviewSettings: this.options.codePreviewSettings,
    }, "borrow");
  }

  private transcriptTail(width: number, budget: number, editorVisible: boolean): string[] {
    if (this.commandNotification && this.commandNotification.epoch !== this.state.epoch) this.clearCommandNotification();
    const notification = this.commandNotification;
    if (this.observedTranscript?.hasNewer && !notification) return [];
    // These rows belong to the end of history, never to the fixed input dock.
    // The streaming indicator is not one of them while the composer is mounted:
    // its border carries the status, exactly as Pi's embedded indicator does.
    const tail = notification ? ["", ...notification.component.render(width)] : [];
    // Reserve wrapped success geometry too, including after a resize.
    if (notification?.pendingResult) {
      const reserved = 1 + notification.pendingResult.render(width).length;
      while (tail.length < reserved) tail.push("");
    }
    if (!editorVisible && !this.observedTranscript?.hasNewer) tail.push(...this.working?.render(width) ?? []);
    // The mounted editor owns its fixed separator. Keep a history row only for
    // the fallback or the latest overlay, so it cannot cover a command result
    // on an older page and the live bottom does not get two gaps.
    if (budget > 1 && (!editorVisible || this.observedTranscript?.hasNewer)) tail.push("");
    return tail;
  }

  private windowBody(body: readonly string[], budget: number, tail: string[]): KittyViewportFrame {
    this.lastBodyLength = body.length + tail.length;
    this.lastBody = body;
    this.lastBodyBudget = budget;
    const entry = this.currentId ? this.state.view(this.currentId) : undefined;
    const maxScroll = Math.max(0, this.lastBodyLength - budget);
    if (entry) {
      if (entry.following) {
        entry.scroll = maxScroll;
      } else if (entry.pageAnchor) {
        entry.scroll = entry.pageAnchor === "prepend"
          ? entry.scroll + Math.max(0, body.length - (entry.anchorLength ?? body.length))
          : entry.pageAnchor === "end" ? maxScroll : 0;
        entry.pageAnchor = undefined;
        entry.anchorLength = undefined;
      }
      entry.scroll = Math.max(0, Math.min(entry.scroll, maxScroll));
    }
    // Slice the virtual body + tail without copying retained history per frame.
    const start = entry?.scroll ?? 0;
    const end = start + budget;
    const frame = this.imageViewport.slice(body, start, end);
    if (end > body.length) frame.lines.push(...tail.slice(Math.max(0, start - body.length), end - body.length));
    return frame;
  }
}
