import type { KeybindingsManager, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  Key,
  getKeybindings,
  matchesKey,
  type KeyId,
} from "@earendil-works/pi-tui";
import { truncateStyledText as truncateToWidth } from "./truncate.js";

/**
 * Target-scoped conversation queue for the focused conversation view.
 *
 * When pi-queue-steer is installed and loaded, a versioned pi.events
 * request/capability handshake hands this adapter a bridge over the
 * extension's actual queue-state machinery (DeliveryQueue / QueueEditSession)
 * AND its actual shared execution-outline renderer (QueueTimelineWidget plus
 * the real inline-editor line extractor) — no imitation, no hard dependency:
 * the extension is discovered only through the shared bus. With no compatible
 * listener, the adapter falls back to Pi's native queue display labels and
 * colors ("Steering:" / "Follow-up:", dim) and never claims extension parity.
 *
 * Delivery ownership rules:
 * - every queue is bound to one targetId; rows and edits never leak to Main
 *   or to another target (dispatch goes only through the injected per-target
 *   `send` route);
 * - `submit` acknowledges route acceptance only: a resolved send marks the
 *   row `dispatched` — immutable, no longer editable (there is no remote
 *   retract API) — and still visible until native delivery is confirmed;
 * - rows retire through `syncSnapshot`, reconciled against the native
 *   reader agent's complete-message snapshot (read-only messages/streaming/
 *   tools source). Retirement keys on stable native message identities plus
 *   a pre-dispatch baseline and live-append frontier, with duplicate
 *   counting — trimmed text alone is NOT identity: identical text already in
 *   history, or historical pages loaded later, can never fake consumption;
 * - a failed send restores the exact remaining rows to the timeline head in
 *   order;
 * - Main-only control actions (/ commands, ! bash) are rejected at stage
 *   time — they are not queueable from a focused conversation;
 * - a run ending (settled, aborted, errored) is NOT a retirement event:
 *   follow-ups exist precisely to start the next run, and a route ack cannot
 *   prove consumption, so only `retireAll` (target removed/unreachable) or
 *   an identity match retires rows;
 * - `dispose({ retain })` gives Main explicit cleanup/retention semantics on
 *   target switches: retention parks the rows (the extension bridge retains
 *   them per targetId for re-adoption), the default clears them and releases
 *   the extension's retained state.
 */

export const QUEUE_STEER_CONVERSATION_QUEUE_REQUEST_EVENT = "queue-steer:conversation-queue:request:v1";

type ConversationQueueLane = "steer" | "followUp";
type ConversationQueueRowState = "queued" | "dispatched";

interface ConversationQueueRow {
  id: string;
  lane: ConversationQueueLane;
  text: string;
  state: ConversationQueueRowState;
  paused: boolean;
  /** Current row-editing selection (rendered live through the shared editor). */
  selected: boolean;
  /** Marked for removal inside the active editing session; save deletes it. */
  removed: boolean;
}

/** Structural shape of the extension's real `DeliveryQueue` rows. */
interface ConversationQueueBridgeRow {
  id: string;
  lane: ConversationQueueLane;
  text: string;
  images: unknown[];
  sequence: number;
  paused?: boolean;
}

/** Structural subset of the extension's real `DeliveryQueue`. */
interface ConversationQueueBridgeQueue {
  enqueue(lane: ConversationQueueLane, text: string, images?: readonly unknown[]): ConversationQueueBridgeRow;
  /** Insert interactive steering into the current run, before future follow-up roots. */
  enqueueSteer?(text: string, images?: readonly unknown[]): ConversationQueueBridgeRow;
  snapshot(): ConversationQueueBridgeRow[];
  peek(): ConversationQueueBridgeRow | undefined;
  get(id: string): ConversationQueueBridgeRow | undefined;
  remove(id: string): ConversationQueueBridgeRow | undefined;
  prepend(item: ConversationQueueBridgeRow): void;
  prependMany(items: readonly ConversationQueueBridgeRow[]): void;
  update(id: string, text: string): boolean;
  setLane(id: string, lane: ConversationQueueLane): boolean;
  setPaused(id: string, paused: boolean): boolean;
  clear(): void;
  readonly length: number;
}

/** Structural subset of the extension's real `QueueEditSession`. */
interface ConversationQueueBridgeEditSession {
  readonly selectedId: string;
  readonly composerDraft: string;
  capture(text: string): void;
  select(item: ConversationQueueBridgeRow, currentText: string): string;
  toggleRemoved(id: string): boolean | undefined;
  togglePaused(id: string): boolean | undefined;
  setLane(id: string, lane: ConversationQueueLane): ConversationQueueLane | undefined;
  commit(queue: ConversationQueueBridgeQueue, currentText: string): {
    updated: number;
    removed: number;
    moved: number;
    held: number;
    released: number;
  };
  rollbackPositions(queue: ConversationQueueBridgeQueue): void;
  /** Draft decoration readers; present on the extension's real session. */
  laneFor?(id: string): ConversationQueueLane | undefined;
  textFor?(id: string): string | undefined;
  pausedFor?(id: string): boolean | undefined;
  isRemoved?(id: string): boolean;
}

/**
 * Version 1 interop bridge served by a loaded pi-queue-steer over the
 * `QUEUE_STEER_CONVERSATION_QUEUE_REQUEST_EVENT` handshake. The renderer
 * members are optional so an older installed extension degrades gracefully
 * to the native fallback rendering instead of an imitation outline.
 */
export interface ConversationQueueBridgeV1 {
  version: 1;
  targetId: string;
  createQueue(): ConversationQueueBridgeQueue;
  createEditSession(item: ConversationQueueBridgeRow, composerDraft: string): ConversationQueueBridgeEditSession;
  isQueueableSubmission(text: string): boolean;
  laneLabel(lane: ConversationQueueLane): string;
  laneColor(lane: ConversationQueueLane): string;
  buildTimelineItems?(
    queue: ConversationQueueBridgeQueue,
    editSession: ConversationQueueBridgeEditSession | undefined,
    modes?: { steer: "all" | "one-at-a-time"; followUp: "all" | "one-at-a-time" },
  ): readonly unknown[];
  createTimelineWidget?(
    options: {
      items: readonly unknown[];
      editingId?: string;
      paused?: boolean;
      idle?: boolean;
      renderInlineEditor?: (width: number) => string[];
    },
    theme: Theme,
  ): { render(width: number): string[]; invalidate(): void };
  extractInlineEditorLines?(lines: readonly string[], paddingX?: number): string[];
}

/**
 * One entry of the native reader agent's complete-message snapshot. `id` is
 * a stable native identity (session entry id, reader event identity, or the
 * actor envelope/message id); `historical` marks baseline/history entries —
 * including older transcript pages loaded later — which establish identity
 * but can never retire a queued row.
 */
export interface ConversationSnapshotEntry {
  id: string;
  text: string;
  historical?: boolean;
}

export interface ConversationQueueOptions {
  /** Shared pi.events bus (emit only; the handshake is synchronous claim/respond). */
  piEvents: { emit(channel: string, data: unknown): void };
  targetId: string;
  targetName?: string;
  /**
   * Per-target dispatch route owned by Main; rejection restores the rows. A
   * resolved value may carry `messageId`/`id` (e.g. an actor envelope id) —
   * it becomes the row's expected native delivery identity.
   */
  send: (message: string, delivery: ConversationQueueLane) => Promise<unknown>;
  theme: Theme;
  /** Shared focused-view editor; row editing renders live through it. */
  editor?: {
    getText(): string;
    setText(text: string): void;
    handleInput?(data: string): void;
    /** Full renderer, used for real inline row editing via the bridge. */
    render?(width: number): string[];
    /** Editor interior padding, forwarded to the inline line extractor. */
    paddingX?: number;
  };
  keybindings?: Pick<KeybindingsManager, "matches" | "getKeys">;
  /** Target run state for the shared widget's stage label; default idle=false. */
  isIdle?: () => boolean;
  onNotify?: (text: string, kind: "info" | "error") => void;
  requestRender?: () => void;
}

interface StageResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export interface ConversationQueue {
  readonly targetId: string;
  /** "extension" when a real pi-queue-steer bridge was claimed, "native" otherwise. */
  readonly mode: "extension" | "native";
  readonly active: boolean;
  /** True while a row-editing session holds the shared editor. */
  readonly editingActive: boolean;
  /** Stage text as a queue row for this target. Control input is rejected. */
  stage(text: string, lane: ConversationQueueLane): StageResult;
  /**
   * Dispatch the contiguous same-lane unpauseed head batch through `send`.
   * Resolves true only when every row was accepted by the route; a failure
   * restores the unsent rows to the timeline head in order. Acceptance is
   * not consumption: accepted rows become immutable and stay visible until
   * `syncSnapshot` confirms native delivery identity.
   */
  submit(lane: ConversationQueueLane): Promise<boolean>;
  dispatch(text: string, lane: ConversationQueueLane): Promise<void>;
  park(text: string, lane: ConversationQueueLane): StageResult;
  cancelEditing(): void;
  syncPending(pending: { steering: string[]; followUp: string[] } | undefined): void;
  /** Decorated rows in timeline order (dispatched rows first, then queued). */
  rows(): ConversationQueueRow[];
  /** Queue list lines rendered above the editor; empty when nothing is held. */
  render(width: number): string[];
  /**
   * Row-editing input handling. Consumes keys only while an editing session
   * is active or when the dequeue binding starts one; everything else passes
   * back to Main (`false`).
   */
  handleInput(data: string): boolean;
  /**
   * Reconcile against the native reader snapshot (read-only). Main feeds the
   * initial pre-dispatch snapshot as `historical` entries before the first
   * submit, then subsequent live snapshots. Retirement matches, first, a
   * dispatched row's expected native message identity (actor envelope id) or,
   * failing that, one live-append entry beyond the historical baseline with
   * the row's text — duplicate rows each consume their own frontier entry.
   * Historical entries and older pages never retire anything.
   */
  syncSnapshot(entries: readonly ConversationSnapshotEntry[]): number;
  /**
   * The target is being removed/unreachable: retire every held row. This is
   * the only blanket retirement, and it must NOT be called merely because a
   * run ended or the target stopped — follow-ups are for the next run, and a
   * route ack cannot prove consumption.
   */
  retireAll(reason?: string): number;
  /** Number of rows still held (queued + dispatched-but-unconfirmed). */
  pendingCount(): number;
  dispose(options?: { retain?: boolean }): void;
}

interface RequestResult {
  ok: boolean;
  bridge?: ConversationQueueBridgeV1;
  error?: string;
}

interface HandshakeRequest {
  version: 1;
  action: "acquire" | "release";
  targetId: string;
  claim(): boolean;
  respond(result: RequestResult): void;
}

interface DispatchedRow {
  id: string;
  lane: ConversationQueueLane;
  text: string;
  /** Expected stable native identity, when the route reported one. */
  expectedId?: string;
}

const DEQUEUE_FALLBACK: KeyId = "alt+up";
const REMOVE_ROW_KEY = "alt+x";
const PAUSE_ROW_KEY = "alt+p";
const INDENT_ROW_KEY: KeyId = "alt+right";
const OUTDENT_ROW_KEY: KeyId = "alt+left";
const TOGGLE_LANE_KEY = "alt+t";

/** Native Pi pending-messages labels (interactive-mode ground truth). */
const NATIVE_LANE_LABEL: Record<ConversationQueueLane, string> = {
  steer: "Steering",
  followUp: "Follow-up",
};

/**
 * Native fallback timeline implementing the same structural contract as the
 * extension bridge, so the adapter logic is single-path for both modes.
 */
class NativeQueueState implements ConversationQueueBridgeQueue {
  private items: ConversationQueueBridgeRow[] = [];
  private nextIdNumber = 1;
  private nextSequence = 1;

  enqueue(lane: ConversationQueueLane, text: string, images: readonly unknown[] = []): ConversationQueueBridgeRow {
    const prefix = lane === "steer" ? "steer" : "follow-up";
    const item: ConversationQueueBridgeRow = {
      id: `${prefix}-${this.nextIdNumber++}`,
      lane,
      text,
      images: [...images],
      sequence: this.nextSequence++,
      paused: false,
    };
    this.items.push(item);
    return { ...item, images: [...item.images] };
  }

  enqueueSteer(text: string, images: readonly unknown[] = []): ConversationQueueBridgeRow {
    const item = this.enqueue("steer", text, images);
    const firstRoot = this.items.findIndex((candidate) => candidate.lane === "followUp");
    if (firstRoot !== -1) {
      const inserted = this.items.pop()!;
      this.items.splice(firstRoot, 0, inserted);
    }
    return item;
  }

  snapshot(): ConversationQueueBridgeRow[] {
    return this.items.map((item) => ({ ...item, images: [...item.images] }));
  }

  peek(): ConversationQueueBridgeRow | undefined {
    const item = this.items[0];
    return item ? { ...item, images: [...item.images] } : undefined;
  }

  get(id: string): ConversationQueueBridgeRow | undefined {
    const item = this.items.find((candidate) => candidate.id === id);
    return item ? { ...item, images: [...item.images] } : undefined;
  }

  remove(id: string): ConversationQueueBridgeRow | undefined {
    const index = this.items.findIndex((candidate) => candidate.id === id);
    if (index === -1) return undefined;
    const [item] = this.items.splice(index, 1);
    return item ? { ...item, images: [...item.images] } : undefined;
  }

  prepend(item: ConversationQueueBridgeRow): void {
    this.items.unshift({ ...item, images: [...item.images] });
  }

  prependMany(items: readonly ConversationQueueBridgeRow[]): void {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item) this.items.unshift({ ...item, images: [...item.images] });
    }
  }

  update(id: string, text: string): boolean {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) return false;
    item.text = text;
    return true;
  }

  setLane(id: string, lane: ConversationQueueLane): boolean {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item || item.lane === lane) return false;
    item.lane = lane;
    return true;
  }

  setPaused(id: string, paused: boolean): boolean {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item || (item.paused ?? false) === paused) return false;
    item.paused = paused;
    return true;
  }

  clear(): void {
    this.items = [];
  }

  get length(): number {
    return this.items.length;
  }
}

/** Rollback-safe snapshot editing for the native fallback queue. */
class NativeEditSession implements ConversationQueueBridgeEditSession {
  readonly composerDraft: string;
  private currentId: string;
  private readonly drafts = new Map<string, { text: string; lane: ConversationQueueLane; removed: boolean; paused: boolean }>();

  constructor(item: ConversationQueueBridgeRow, composerDraft: string) {
    this.currentId = item.id;
    this.composerDraft = composerDraft;
    this.drafts.set(item.id, {
      text: item.text,
      lane: item.lane,
      removed: false,
      paused: item.paused ?? false,
    });
  }

  get selectedId(): string {
    return this.currentId;
  }

  capture(text: string): void {
    const draft = this.drafts.get(this.currentId);
    if (draft) draft.text = text;
  }

  select(item: ConversationQueueBridgeRow, currentText: string): string {
    this.capture(currentText);
    if (!this.drafts.has(item.id)) {
      this.drafts.set(item.id, {
        text: item.text,
        lane: item.lane,
        removed: false,
        paused: item.paused ?? false,
      });
    }
    this.currentId = item.id;
    return this.drafts.get(item.id)?.text ?? item.text;
  }

  toggleRemoved(id: string): boolean | undefined {
    const draft = this.drafts.get(id);
    if (!draft) return undefined;
    draft.removed = !draft.removed;
    return draft.removed;
  }

  togglePaused(id: string): boolean | undefined {
    const draft = this.drafts.get(id);
    if (!draft) return undefined;
    draft.paused = !draft.paused;
    return draft.paused;
  }

  setLane(id: string, lane: ConversationQueueLane): ConversationQueueLane | undefined {
    const draft = this.drafts.get(id);
    if (!draft) return undefined;
    draft.lane = lane;
    return draft.lane;
  }

  commit(queue: ConversationQueueBridgeQueue, currentText: string): {
    updated: number;
    removed: number;
    moved: number;
    held: number;
    released: number;
  } {
    this.capture(currentText);
    let updated = 0;
    let removed = 0;
    let moved = 0;
    let held = 0;
    let released = 0;
    for (const [id, draft] of this.drafts.entries()) {
      if (draft.removed || !draft.text.trim()) {
        if (queue.remove(id)) removed += 1;
        continue;
      }
      if (queue.update(id, draft.text)) updated += 1;
      if (queue.setLane(id, draft.lane)) moved += 1;
      if (queue.setPaused(id, draft.paused)) {
        if (draft.paused) held += 1;
        else released += 1;
      }
    }
    return { updated, removed, moved, held, released };
  }

  rollbackPositions(): void {}

  laneFor(id: string): ConversationQueueLane | undefined {
    return this.drafts.get(id)?.lane;
  }

  textFor(id: string): string | undefined {
    return this.drafts.get(id)?.text;
  }

  pausedFor(id: string): boolean | undefined {
    return this.drafts.get(id)?.paused;
  }

  isRemoved(id: string): boolean {
    return this.drafts.get(id)?.removed ?? false;
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error ?? "");

const controlInputRe = /^[/!]/;

/**
 * Create one target-scoped conversation queue. Attempts the pi-queue-steer
 * interop handshake first (mode "extension"); with no claiming listener the
 * adapter serves Pi's native queue labels and colors (mode "native").
 */
export function createConversationQueue(options: ConversationQueueOptions): ConversationQueue {
  const { piEvents, targetId, theme } = options;
  const notify = (text: string, kind: "info" | "error" = "info") => {
    options.onNotify?.(text, kind);
  };
  const requestRender = () => options.requestRender?.();
  const targetLabel = options.targetName ?? targetId;

  let bridge: ConversationQueueBridgeV1 | undefined;
  let queue: ConversationQueueBridgeQueue;
  let mode: "extension" | "native" = "native";
  let disposed = false;
  /** Route-accepted rows awaiting native delivery identity confirmation. */
  const dispatched: DispatchedRow[] = [];
  let externalPending: DispatchedRow[] = [];
  let lastSendError: unknown;
  let editSession: ConversationQueueBridgeEditSession | undefined;

  // Snapshot reconciliation state: every fed identity is seen exactly once;
  // historical entries (initial baseline, older pages) can never retire;
  // live-append frontier counts per trimmed text drive text-based retirement
  // with duplicate counting; consumed ids make each entry retire at most one row.
  const seenIds = new Set<string>();
  const consumedIds = new Set<string>();
  const liveTextCounts = new Map<string, number>();

  const emitHandshake = (action: "acquire" | "release"): { claimed: boolean; result?: RequestResult | undefined } => {
    let claimed = false;
    let settled = false;
    let result: RequestResult | undefined;
    const request: HandshakeRequest = {
      version: 1,
      action,
      targetId,
      claim: () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      respond: (response) => {
        // The bridge contract is a synchronous respond during emit; late
        // responses are ignored so the adapter mode never flips mid-render.
        if (settled) return;
        settled = true;
        result = response;
      },
    };
    piEvents.emit(QUEUE_STEER_CONVERSATION_QUEUE_REQUEST_EVENT, request);
    return { claimed, result };
  };

  const acquisition = emitHandshake("acquire");
  if (
    acquisition.claimed
    && acquisition.result?.ok
    && acquisition.result.bridge?.version === 1
    && acquisition.result.bridge.targetId === targetId
  ) {
    bridge = acquisition.result.bridge;
    mode = "extension";
  } else if (acquisition.claimed && acquisition.result && !acquisition.result.ok) {
    notify(`pi-queue-steer refused the conversation queue for ${targetLabel}: ${acquisition.result.error ?? "unknown error"}`, "error");
  }
  queue = bridge ? bridge.createQueue() : new NativeQueueState();

  const laneLabel = (lane: ConversationQueueLane): string =>
    bridge ? bridge.laneLabel(lane) : lane === "steer" ? "steer" : "follow-up";

  const isQueueable = (text: string): boolean =>
    bridge ? bridge.isQueueableSubmission(text) : !controlInputRe.test(text.trim()) && text.trim() !== "";

  const decoratedRow = (item: ConversationQueueBridgeRow): ConversationQueueRow => ({
    id: item.id,
    lane: editSession?.laneFor?.(item.id) ?? item.lane,
    text: editSession?.textFor?.(item.id) ?? item.text,
    state: "queued",
    paused: editSession?.pausedFor?.(item.id) ?? (item.paused ?? false),
    selected: editSession?.selectedId === item.id,
    removed: editSession?.isRemoved?.(item.id) ?? false,
  });

  const orderedRows = (): ConversationQueueRow[] => {
    const held = queue.snapshot().map(decoratedRow);
    // Accepted rows are immutable: outside the editing queue, never selectable.
    const asDispatched = (row: DispatchedRow): ConversationQueueRow => ({
      id: row.id,
      lane: row.lane,
      text: row.text,
      state: "dispatched" as const,
      paused: false,
      selected: false,
      removed: false,
    });
    // User-owned rows stay ahead of unmatched native pending (Fabric
    // participant queues that show at the end of the transcript). A user
    // steer must not wait behind those at the next turn boundary.
    return [...dispatched.map(asDispatched), ...held, ...externalPending.map(asDispatched)];
  };

  /**
   * Contiguous same-lane head batch; a paused head row is a dispatch barrier
   * and rows behind it never jump ahead.
   */
  const headBatch = (lane: ConversationQueueLane): ConversationQueueBridgeRow[] => {
    const items = queue.snapshot();
    const head = items[0];
    if (!head || head.lane !== lane) return [];
    const batch: ConversationQueueBridgeRow[] = [];
    for (const item of items) {
      if (item.lane !== lane) break;
      if (item.paused) break;
      batch.push(item);
    }
    return batch;
  };

  const dequeueKeys = (): readonly string[] => {
    const manager = options.keybindings ?? getKeybindings();
    const keys = manager.getKeys("app.message.dequeue");
    return keys.filter((key: string) => /up$/i.test(key)).map((key: string) =>
      key.endsWith("Up") ? `${key.slice(0, -2)}Down` : `${key.slice(0, -2)}down`
    );
  };

  const actionMatches = (
    data: string,
    action: "app.message.dequeue" | "app.interrupt" | "tui.input.submit" | "app.message.followUp",
    fallback: (data: string) => boolean,
  ): boolean => {
    const manager = options.keybindings;
    if (manager) {
      const keys = manager.getKeys(action);
      if (keys.length === 0) return false;
      return manager.matches(data, action);
    }
    const global = getKeybindings();
    if (global.getKeys(action).length > 0) return global.matches(data, action);
    return fallback(data);
  };

  const startEditing = (): boolean => {
    if (!options.editor) {
      notify("Editing queued rows requires the shared editor", "error");
      return false;
    }
    const items = queue.snapshot();
    if (items.length === 0) {
      notify("No queued messages to edit", "info");
      return false;
    }
    // Enter at the most recently queued row, like the extension's dequeue.
    const mostRecent = items.reduce((newest, item) => (item.sequence > newest.sequence ? item : newest), items[0]!);
    editSession = bridge
      ? bridge.createEditSession(mostRecent, options.editor.getText())
      : new NativeEditSession(mostRecent, options.editor.getText());
    options.editor.setText(mostRecent.text);
    notify(`Editing queued ${laneLabel(mostRecent.lane)} row · enter saves, escape rolls back`, "info");
    requestRender();
    return true;
  };

  const finishEditing = (save: boolean): boolean => {
    const session = editSession;
    const editor = options.editor;
    if (!session || !editor) return false;
    const currentText = editor.getText();
    editSession = undefined;
    if (save) {
      const result = session.commit(queue, currentText);
      if (result.removed > 0) notify(`Removed ${result.removed} queued row${result.removed === 1 ? "" : "s"}`, "info");
      if (result.moved > 0) notify(`Changed delivery depth for ${result.moved} row${result.moved === 1 ? "" : "s"}`, "info");
      if (result.held > 0) notify(`Paused ${result.held} row${result.held === 1 ? "" : "s"} — dispatch stops there until resumed`, "info");
      if (result.released > 0) notify(`Resumed ${result.released} row${result.released === 1 ? "" : "s"}`, "info");
    } else {
      // Escape rolls the whole editing session back, including lane and
      // pause drafts; row edits live only in the discarded drafts.
      notify("Row edits rolled back", "info");
    }
    editor.setText(session.composerDraft);
    requestRender();
    return true;
  };

  const matchesOptionArrow = (data: string, direction: "left" | "right"): boolean => {
    const arrow = direction === "left" ? OUTDENT_ROW_KEY : INDENT_ROW_KEY;
    const wordAlias: KeyId = direction === "left" ? "alt+b" : "alt+f";
    // Preserve the word-navigation aliases some terminals send for Option+Arrow.
    return matchesKey(data, arrow) && !matchesKey(data, wordAlias);
  };

  const inlineEditorRenderer = (): ((width: number) => string[]) | undefined => {
    const editor = options.editor;
    if (!editor?.render) return undefined;
    return (width: number) => {
      const lines = editor.render!(width);
      if (bridge?.extractInlineEditorLines) {
        return bridge.extractInlineEditorLines(lines, editor.paddingX ?? 0);
      }
      return [...lines];
    };
  };

  return {
    targetId,
    get mode() {
      return mode;
    },
    get active() {
      return !disposed && (queue.length > 0 || dispatched.length > 0);
    },
    get editingActive() {
      return editSession !== undefined;
    },

    stage(text, lane) {
      if (disposed) return { ok: false, error: "Queue is disposed" };
      const trimmed = text.trim();
      if (!trimmed) return { ok: false, error: "Nothing to queue" };
      if (!isQueueable(trimmed) || controlInputRe.test(trimmed)) {
        return {
          ok: false,
          error: "Control input (/ commands, ! bash) is Main-only and is not queued from a focused conversation",
        };
      }
      const row = lane === "steer" && typeof queue.enqueueSteer === "function"
        ? queue.enqueueSteer(text)
        : queue.enqueue(lane, text);
      notify(`Queued ${laneLabel(lane)} → ${targetLabel}`, "info");
      requestRender();
      return { ok: true, id: row.id };
    },

    async submit(lane) {
      if (disposed) return false;
      if (editSession) {
        notify("Finish or cancel row editing before dispatching the queue", "info");
        return false;
      }
      const batch = headBatch(lane);
      if (batch.length === 0) {
        const head = queue.peek();
        if (head?.paused) notify(`The next ${laneLabel(lane)} row is paused — dispatch holds there`, "info");
        else notify(`No dispatchable queued ${laneLabel(lane)} rows at the timeline head`, "info");
        return false;
      }
      let sent = 0;
      lastSendError = undefined;
      for (const item of batch) {
        if (disposed) return false;
        queue.remove(item.id);
        const pending: DispatchedRow = { id: item.id, lane, text: item.text };
        dispatched.push(pending);
        requestRender();
        let expectedId: string | undefined;
        try {
          const result = await options.send(item.text, lane);
          // Actor routes can report the original envelope/message id; a
          // one-shot native route may resolve void — identity then falls
          // back to the live-append text frontier.
          const candidate = result as { messageId?: unknown; id?: unknown } | undefined;
          const reported = candidate?.messageId ?? candidate?.id;
          if (typeof reported === "string" && reported !== "") expectedId = reported;
        } catch (error) {
          lastSendError = error;
          const pendingIndex = dispatched.indexOf(pending);
          if (pendingIndex < 0 || disposed) return !disposed;
          dispatched.splice(pendingIndex, 1);
          // Exact failed-send restoration: only the failed row is prepended
          // — rows behind it were never removed from the queue, so they are
          // still in their original positions after it.
          queue.prepend({ ...item });
          notify(`Send failed for ${targetLabel} (${laneLabel(lane)}); row restored to the queue head: ${errorText(error)}`, "error");
          requestRender();
          return false;
        }
        if (expectedId) pending.expectedId = expectedId;
        sent += 1;
      }
      notify(`Accepted ${sent} queued ${laneLabel(lane)} row${sent === 1 ? "" : "s"} → ${targetLabel} · awaiting delivery`, "info");
      requestRender();
      return true;
    },

    async dispatch(text, lane) {
      const row = this.stage(text, lane);
      if (!row.ok || !row.id) throw new Error(row.error ?? "Unable to queue input");
      if (!await this.submit(lane)) {
        queue.remove(row.id);
        throw lastSendError ?? new Error("The queue head is paused or held; edit or resume it before sending");
      }
    },

    park(text, lane) {
      const result = this.stage(text, lane);
      if (result.id) queue.setPaused(result.id, true);
      return result;
    },

    cancelEditing() { if (editSession) finishEditing(false); },

    syncPending(pending) {
      externalPending = [];
      if (!pending) return;
      const own = [...queue.snapshot(), ...dispatched];
      for (const [lane, messages] of [["steer", pending.steering], ["followUp", pending.followUp]] as const) {
        const remaining = own.filter((row) => row.lane === lane).map((row) => row.text);
        messages.forEach((text, index) => {
          const match = remaining.indexOf(text);
          if (match >= 0) remaining.splice(match, 1);
          else externalPending.push({ id: `native:${lane}:${index}`, lane, text });
        });
      }
    },

    rows: orderedRows,

    render(width) {
      if (disposed || width <= 0) return [];
      const rows = orderedRows();
      if (rows.length === 0) return [];
      // Extension mode with a bridge that serves the real renderer: render
      // the actual shared execution-outline widget. The caption keeps the
      // execution model honest — Fabric dispatches on submit; retirement is
      // delivery-confirmed, not implied by the outline.
      if (bridge?.createTimelineWidget && bridge.buildTimelineItems) {
        const visibleRows: ConversationQueueBridgeRow[] = [
          ...dispatched.map((row, index) => ({ id: row.id, lane: row.lane, text: row.text, images: [], sequence: index - dispatched.length })),
          ...queue.snapshot(),
          ...externalPending.map((row, index) => ({ id: row.id, lane: row.lane, text: row.text, images: [], sequence: queue.snapshot().length + index + 1 })),
        ];
        const displayQueue = new Proxy(queue, { get(target, key) {
          if (key === "snapshot") return () => visibleRows;
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        } });
        const items = bridge.buildTimelineItems(displayQueue, editSession);
        const inline = editSession ? inlineEditorRenderer() : undefined;
        const editingId = editSession?.selectedId;
        const widget = bridge.createTimelineWidget(
          {
            items,
            ...(editingId !== undefined ? { editingId } : {}),
            paused: false,
            idle: options.isIdle?.() ?? false,
            ...(inline ? { renderInlineEditor: inline } : {}),
          },
          theme,
        );
        const lines = widget.render(width);
        if (dispatched.length > 0) lines.push(theme.fg("dim", truncateToWidth("Sent rows await child delivery; they cannot be edited locally.", width, "")));
        return lines;
      }
      // Native Pi pending-messages display (ground-truth labels/colors) or
      // an older bridge without the renderer members.
      const lines: string[] = [""];
      const innerWidth = Math.max(0, width - 2);
      const dequeueHint = (options.keybindings ?? getKeybindings()).getKeys("app.message.dequeue").join("/") || DEQUEUE_FALLBACK;
      for (const row of rows) {
        const label = bridge ? bridge.laneLabel(row.lane) : NATIVE_LANE_LABEL[row.lane];
        const marker = row.selected ? "› " : row.paused ? "⏸ " : "";
        const note = row.removed
            ? " · removed on save"
            : row.paused
              ? " · paused"
              : "";
        const color: ThemeColor = row.state === "dispatched"
          ? "dim"
          : bridge ? bridge.laneColor(row.lane) as ThemeColor : "dim";
        lines.push(
          ` ${theme.fg(color, truncateToWidth(`${marker}${label}: ${row.text.replace(/\n/g, " ")}${note}`, innerWidth, "…"))} `,
        );
      }
      const hint = queue.length > 0 ? `↳ ${dequeueHint} to edit queued messages` : "↳ Waiting for child delivery";
      lines.push(` ${theme.fg("dim", truncateToWidth(hint, innerWidth, "…"))} `);
      return lines;
    },

    handleInput(data) {
      if (disposed) return false;
      if (!editSession) {
        if (queue.length === 0) return false;
        if (!options.editor?.getText().trim() && matchesKey(data, Key.enter)) {
          const head = queue.peek();
          if (head) { queue.setPaused(head.id, false); void this.submit(head.lane); }
          return true;
        }
        if (actionMatches(data, "app.message.dequeue", (input) => matchesKey(input, DEQUEUE_FALLBACK))) {
          return startEditing();
        }
        return false;
      }
      const session = editSession;
      const editor = options.editor;
      // Navigation mirrors the extension: configured dequeue action moves to
      // the previous row, its mirrored twin moves to the next.
      if (actionMatches(data, "app.message.dequeue", (input) => matchesKey(input, DEQUEUE_FALLBACK)) && editor) {
        const ordered = queue.snapshot();
        const index = ordered.findIndex((item) => item.id === session.selectedId);
        const target = index <= 0 ? ordered.at(-1) : ordered[index - 1];
        if (target) editor.setText(session.select(target, editor.getText()));
        requestRender();
        return true;
      }
      const nextKeys = dequeueKeys();
      if (nextKeys.length > 0 && nextKeys.some((key) => matchesKey(data, key as KeyId)) && editor) {
        const ordered = queue.snapshot();
        const index = ordered.findIndex((item) => item.id === session.selectedId);
        const target = index === -1 || index === ordered.length - 1 ? ordered[0] : ordered[index + 1];
        if (target) editor.setText(session.select(target, editor.getText()));
        requestRender();
        return true;
      }
      if (matchesKey(data, REMOVE_ROW_KEY)) {
        session.toggleRemoved(session.selectedId);
        requestRender();
        return true;
      }
      if (matchesKey(data, PAUSE_ROW_KEY)) {
        session.togglePaused(session.selectedId);
        requestRender();
        return true;
      }
      if (matchesOptionArrow(data, "left")) {
        session.setLane(session.selectedId, "followUp");
        requestRender();
        return true;
      }
      if (matchesOptionArrow(data, "right")) {
        session.setLane(session.selectedId, "steer");
        requestRender();
        return true;
      }
      if (matchesKey(data, TOGGLE_LANE_KEY)) {
        const current = queue.get(session.selectedId)?.lane;
        if (current) session.setLane(session.selectedId, current === "steer" ? "followUp" : "steer");
        requestRender();
        return true;
      }
      if (
        actionMatches(data, "tui.input.submit", (input) => matchesKey(input, Key.enter))
        || actionMatches(data, "app.message.followUp", () => false)
      ) {
        return finishEditing(true);
      }
      if (actionMatches(data, "app.interrupt", (input) => matchesKey(input, Key.escape))) {
        return finishEditing(false);
      }
      editor?.handleInput?.(data);
      return true;
    },

    syncSnapshot(entries) {
      if (disposed || dispatched.length === 0) {
        // Still record identities so a pre-dispatch baseline exists even
        // before anything is queued.
        for (const entry of entries) {
          if (!seenIds.has(entry.id)) seenIds.add(entry.id);
        }
        return 0;
      }
      // Fold the snapshot in first: historical entries (initial baseline,
      // older transcript pages) register identity without creating frontier;
      // live unseen entries extend the per-text live-append frontier.
      for (const entry of entries) {
        if (seenIds.has(entry.id)) continue;
        seenIds.add(entry.id);
        if (entry.historical) continue;
        const key = entry.text.trim();
        liveTextCounts.set(key, (liveTextCounts.get(key) ?? 0) + 1);
      }
      let retired = 0;
      const consume = (entry: ConversationSnapshotEntry) => {
        consumedIds.add(entry.id);
        if (!entry.historical) {
          const key = entry.text.trim();
          const remaining = (liveTextCounts.get(key) ?? 0) - 1;
          if (remaining > 0) liveTextCounts.set(key, remaining);
          else liveTextCounts.delete(key);
        }
      };
      const frontierEntry = (row: DispatchedRow): ConversationSnapshotEntry | undefined => {
        // 1. Expected stable native identity (actor envelope/message id):
        //    any entry carrying it confirms delivery outright.
        if (row.expectedId) {
          const match = entries.find((entry) => entry.id === row.expectedId && !consumedIds.has(entry.id));
          if (match) return match;
        }
        // 2. Live-append frontier beyond the historical baseline: only
        //    entries that arrived live after dispatch, counted per text so
        //    duplicate rows retire one-for-one. History and older pages
        //    never qualify.
        for (const entry of entries) {
          if (entry.historical || consumedIds.has(entry.id)) continue;
          if (entry.text.trim() === row.text.trim() && (liveTextCounts.get(entry.text.trim()) ?? 0) > 0) {
            return { id: entry.id, text: entry.text.trim() };
          }
        }
        return undefined;
      };
      for (let index = dispatched.length - 1; index >= 0; index -= 1) {
        const row = dispatched[index];
        if (!row) continue;
        const confirmed = frontierEntry(row);
        if (!confirmed) continue;
        consume(confirmed);
        dispatched.splice(index, 1);
        retired += 1;
      }
      if (retired > 0) {
        notify(`${retired} queued row${retired === 1 ? "" : "s"} confirmed delivered → ${targetLabel}`, "info");
        requestRender();
      }
      return retired;
    },

    retireAll(reason) {
      if (disposed) return 0;
      const count = queue.length + dispatched.length;
      queue.clear();
      dispatched.length = 0;
      editSession = undefined;
      if (count > 0) {
        const suffix = reason ? ` (${reason})` : "";
        notify(`Retired ${count} queued row${count === 1 ? "" : "s"} for ${targetLabel}${suffix}`, "info");
        requestRender();
      }
      return count;
    },

    pendingCount() {
      if (disposed) return 0;
      return queue.length + dispatched.length;
    },

    dispose({ retain = false } = {}) {
      if (disposed) return;
      disposed = true;
      editSession = undefined;
      if (retain) {
        // Rows stay parked: in extension mode the bridge retains them per
        // targetId for re-adoption when the target is focused again.
        return;
      }
      queue.clear();
      dispatched.length = 0;
      if (bridge) emitHandshake("release");
    },
  };
}
