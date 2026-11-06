import fs from "node:fs";
import { NativeReaderEventReplay } from "./conversation-native-reader-replay.js";
import { NativeReaderCheckpoint } from "./conversation-native-reader-checkpoint.js";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { getConversationHost } from "./conversation-host.js";
import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";

// Native Pi conversation transcript reader.
//
// Unlike the dashboard's FabricTranscriptEntry pipeline (transcript-reader.ts +
// transcript-parser.ts), which flattens, clips (500/40k char caps), redacts and
// drops fields, this reader preserves the native Pi AgentMessage union intact:
//
//   - user messages with text AND image content blocks
//   - assistant thinking blocks, tool calls with full arguments
//   - tool results with full content, details and error flags
//   - native bashExecution / custom / branchSummary / compactionSummary messages
//   - session entry tree semantics (branch via leaf→root walk, compaction
//     checkpoints, branch summaries) using pi's own buildContextEntries +
//     sessionEntryToContextMessages — the same display projection interactive
//     mode's renderSessionItems consumes, with native summary roles preserved.
//   - live streaming from the worker RPC event log (events.jsonl): partial
//     assistant assembly from message_start/message_update deltas, full
//     tool_execution_{start,update,end} lifecycle with untruncated args,
//     partialResult and result details (including nested Fabric tool audits),
//     and entry_appended folding for extension session entries.
//
// Sources: either the native Pi session JSONL (preferred full history), the
// worker run events.jsonl (surfaced by the agents.log API), or both. Retained
// actor runs work in all shapes: a persistent session file, a retained
// events.jsonl (--no-session runs keep their whole history in events only), or
// a session file passed as `logFile` (the retained-actor fallback the UI uses).
//
// The controller keeps one reader per participant (stable source id). When only
// `logFile`/`eventsFile` rolls to the next activation run, all history loaded
// from the stable session file — including pinned loadOlder pages — is
// preserved; only events-derived streaming state resets.
//
// IO is byte-bounded but always loads whole records — a single record larger
// than the page budget grows the budget instead of being clipped, so no field
// is ever dropped. Repeated loadOlder() calls walk the user through all of
// history. Files that cannot be read are reported through the bounded
// `unavailable`/`error` snapshot fields instead of throwing.

export type NativeAgentMessage = SessionMessageEntry["message"];

export interface NativeConversationSource {
  /** Stable participant id (the controller keeps one reader per id). */
  id: string;
  status: string;
  /**
   * FabricTranscriptSource-compatible path: the active worker's or latest
   * retained run's events.jsonl (RPC event log) — or, retained-actor fallback,
   * a native Pi session file.
   */
  logFile?: string;
  /** Stable native Pi session file, preferred as the full history source. */
  sessionFile?: string;
  /** Explicit events.jsonl override; wins over logFile when both are given. */
  eventsFile?: string;
}

export interface NativeToolExecution {
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  status: "running" | "completed" | "failed";
  /** tool_execution_start observed for this call. */
  executionStarted?: boolean;
  /** Full arguments are known (start/end observed or toolcall_end delivered). */
  argsComplete?: boolean;
  /** Accumulated partial result while running (content + details preserved whole). */
  partial?: { content?: unknown[]; details?: unknown };
  /** Final result (content + details preserved whole). */
  result?: { content?: unknown[]; details?: unknown };
  isError?: boolean;
}

interface NativeTranscriptEntry {
  entryId: string;
  parentId: string | null;
  entryType: string;
  timestamp: string;
  /** Present for `message` entries; the native AgentMessage, unmodified. */
  message?: NativeAgentMessage;
  /** The whole native session entry — compaction, branch_summary, custom, … */
  entry: SessionEntry;
}

interface NativeConversationStreaming {
  /** True while a partial assistant message or a tool execution is live. */
  active: boolean;
  /** Assistant message assembled from message_start + message_update deltas. */
  partialAssistant?: AssistantMessage;
  /** Tool executions keyed by toolCallId, including completed ones. */
  tools: NativeToolExecution[];
}

export interface NativeConversationTranscript {
  /** Native AgentMessage union: active-branch display sequence + live tail. */
  messages: NativeAgentMessage[];
  /** Monotonic per reader, including source, availability and window changes. */
  revision: number;
  /** Active branch entries (root → leaf), compaction-applied, native and whole. */
  entries: NativeTranscriptEntry[];
  streaming: NativeConversationStreaming;
  pendingMessages?: { steering: string[]; followUp: string[] };
  leafId: string | null;
  sourceId: string;
  status: string;
  sessionFile?: string;
  eventsFile?: string;
  sessionId?: string;
  /** Both file windows reached the file starts and the branch path reaches root. */
  historyComplete: boolean;
  /** Older whole-record pages are available via loadOlder(). */
  hasMore: boolean;
  /** New complete records exist past the window (only when reads are pinned). */
  hasNewer: boolean;
  /** Which source files could not be read, when any were given but unreadable. */
  unavailable?: { sessionFile?: boolean; eventsFile?: boolean };
  /** Bounded (≤200 char) reason for the last unreadable-file condition. */
  error?: string;
  updatedAt: number;
}

const INITIAL_PAGE_BYTES = 256 * 1024;
const OLDER_PAGE_BYTES = 256 * 1024;
const GROWTH_PAGE_BYTES = 1024 * 1024;
const CLASSIFY_PROBE_BYTES = 4096;
const MAX_ERROR_CHARS = 200;

const emptyUsage = (): AssistantMessage["usage"] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

// JSON.parse output is a JsonValue; the object guard narrows it to JsonObject so
// callers can feed parsed tool-call arguments straight into Pi's JsonObject fields.
const parseRecord = (raw: string): JsonObject | undefined => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as JsonObject;
  } catch {
    return undefined;
  }
};

const isSessionEntry = (value: unknown): value is SessionEntry =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as SessionEntry).type === "string" &&
  typeof (value as SessionEntry).id === "string" &&
  ((value as SessionEntry).parentId === null || typeof (value as SessionEntry).parentId === "string");

const messageFingerprint = (message: NativeAgentMessage): string => {
  if ("content" in message) return JSON.stringify(message.content);
  if ("summary" in message) return JSON.stringify(message.summary);
  return "";
};

const messageKey = (message: NativeAgentMessage): string => {
  if (message.role === "toolResult") return `toolResult:${message.toolCallId}`;
  if (message.role === "assistant") {
    const calls = message.content
      .filter((block): block is Extract<typeof block, { type: "toolCall" }> => block.type === "toolCall")
      .map((block) => block.id);
    if (calls.length > 0) return `assistant:${message.timestamp}:calls:${calls.join(",")}`;
  }
  return `${message.role}:${message.timestamp}:${messageFingerprint(message)}`;
};

const clipError = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
};

interface RecordPage {
  /** Byte offset of the first record included (record-aligned). */
  start: number;
  /** Byte offset just past the last record included. */
  end: number;
  records: string[];
}

/**
 * Read whole JSONL records ending at `end`, backwards, byte-bounded. The start
 * is aligned forward to a record boundary; if one record exceeds the budget the
 * budget doubles so the record is always loaded whole (never clipped).
 *
 * An unterminated trailing line (mid-write at EOF) is only included when it
 * already parses as JSON; otherwise the page ends before it so the next read
 * picks up the completed record. Nothing partially written is ever surfaced.
 */
const readBackwardPage = (
  descriptor: number,
  end: number,
  budget: number,
  includeFinalPartialLine: boolean,
): RecordPage => {
  let windowBudget = Math.max(budget, 1);
  for (;;) {
    const candidate = Math.max(0, end - windowBudget);
    const buffer = Buffer.allocUnsafe(end - candidate);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, candidate);
    const data = buffer.subarray(0, Math.max(0, bytesRead));
    if (data.length === 0) return { start: candidate, end: candidate, records: [] };
    const firstNewline = data.indexOf(0x0a);
    if (firstNewline === -1) {
      if (candidate === 0) {
        // Leave an incomplete first record unconsumed so the next append
        // can complete it, just like a trailing partial line in a larger file.
        const raw = data.toString("utf8").replace(/\r$/, "");
        return includeFinalPartialLine && raw && parseRecord(raw)
          ? { start: 0, end, records: [raw] }
          : { start: 0, end: 0, records: [] };
      }
      // One record larger than the budget: grow and retry so it loads whole.
      windowBudget = Math.min(windowBudget * 2, end);
      continue;
    }
    // At the file start (candidate === 0) the first line is a complete record;
    // otherwise align forward past a possibly partial head line.
    const alignStart = candidate > 0 ? firstNewline + 1 : 0;
    const records: string[] = [];
    let lineStart = alignStart;
    let lastComplete = alignStart;
    for (let index = alignStart; index < data.length; index++) {
      if (data[index] !== 0x0a) continue;
      const raw = data.subarray(lineStart, index).toString("utf8").replace(/\r$/, "");
      if (raw) records.push(raw);
      lineStart = index + 1;
      lastComplete = lineStart;
    }
    if (records.length === 0 && candidate > 0) {
      // No complete record fit before the window end (one record larger than
      // the budget): grow and retry so it loads whole.
      windowBudget = Math.min(windowBudget * 2, end);
      continue;
    }
    let endOffset = end;
    if (lastComplete < data.length) {
      const tail = data.subarray(lastComplete).toString("utf8").replace(/\r$/, "");
      if (includeFinalPartialLine && tail && parseRecord(tail)) {
        records.push(tail);
      } else {
        endOffset = candidate + lastComplete;
      }
    }
    return { start: candidate + alignStart, end: endOffset, records };
  }
};

/**
 * Read whole JSONL records forward from `start` up to the file end, bounded by
 * `budget`. An unterminated trailing line is only included when it already
 * parses as JSON (complete record caught mid-append); otherwise it is left for
 * the next read so no partially written record is ever surfaced.
 */
const readForwardPage = (
  descriptor: number,
  start: number,
  size: number,
  budget: number,
): RecordPage => {
  let windowBudget = Math.max(budget, 1);
  for (;;) {
    const limit = Math.min(size, start + windowBudget);
    if (limit <= start) return { start, end: start, records: [] };
    const buffer = Buffer.allocUnsafe(limit - start);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, start);
    const data = buffer.subarray(0, Math.max(0, bytesRead));
    if (data.length === 0) return { start, end: start, records: [] };
    const records: string[] = [];
    let lineStart = 0;
    let lastComplete = 0;
    for (let index = 0; index < data.length; index++) {
      if (data[index] !== 0x0a) continue;
      const raw = data.subarray(lineStart, index).toString("utf8").replace(/\r$/, "");
      if (raw) records.push(raw);
      lineStart = index + 1;
      lastComplete = lineStart;
    }
    if (lastComplete < data.length) {
      const tail = data.subarray(lastComplete).toString("utf8").replace(/\r$/, "");
      if (limit >= size && tail && parseRecord(tail)) {
        records.push(tail);
        lastComplete = data.length;
      }
    }
    if (lastComplete === 0 && limit < size) {
      // One record larger than the budget: grow and retry so it loads whole.
      windowBudget = Math.min(windowBudget * 2, size - start);
      continue;
    }
    return { start, end: start + lastComplete, records };
  }
};

interface NativeReaderState {
  entries: SessionEntry[];
  sessionEntryIds: string[];
  eventEntryIds: string[];
  streamed: NativeAgentMessage[];
  partial: AssistantMessage | undefined;
  pendingMessages: NativeConversationTranscript["pendingMessages"];
  partialArgsRaw: Array<[number, string]>;
  tools: NativeToolExecution[];
  eventRecords: Record<string, unknown>[];
}

type NativeReaderMetadata = Omit<NativeConversationTranscript, "messages" | "entries" | "streaming" | "pendingMessages">;

interface FileWindow {
  /** Oldest byte loaded so far (record-aligned); 0 once history start is reached. */
  head: number;
  /** Newest byte consumed so far. */
  tail: number;
  /** Size observed at the last read; tail === size means followed to EOF. */
  size: number;
  hasOlder: boolean;
  /** Set when the file exists but could not be read. */
  unavailable: boolean;
}

type FileKind = "session" | "events";

const classifyFile = (filePath: string): FileKind | "unreadable" => {
  let descriptor: number | undefined;
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return "unreadable";
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(CLASSIFY_PROBE_BYTES, stat.size)));
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, Math.max(0, bytesRead)).toString("utf8");
    const firstLine = head.split("\n", 1)[0] ?? "";
    const parsed = parseRecord(firstLine);
    // Native session files start with a {"type":"session",...} header; worker
    // events.jsonl streams start with RPC events (agent_start, response, …).
    return parsed?.type === "session" ? "session" : "events";
  } catch {
    return "unreadable";
  } finally {
    if (descriptor !== undefined) closeQuietly(descriptor);
  }
};

const openDescriptor = (
  filePath: string,
): { descriptor: number; size: number } | { error: string } | undefined => {
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      closeQuietly(descriptor);
      return { error: "not a regular file" };
    }
    return { descriptor, size: stat.size };
  } catch (error) {
    return { error: clipError(error) };
  }
};

const closeQuietly = (descriptor: number): void => {
  try {
    fs.closeSync(descriptor);
  } catch {
    // best effort
  }
};

export class NativeConversationReader {
  #sourceId = "";
  #status = "";
  #sessionFile: string | undefined;
  #eventsFile: string | undefined;

  #entries: SessionEntry[] = [];
  readonly #entryIds = new Set<string>();
  readonly #byId = new Map<string, SessionEntry>();
  readonly #sessionEntryIds = new Set<string>();
  readonly #eventEntryIds = new Set<string>();
  #sessionLeafId: string | undefined;
  #eventLeafId: string | undefined;
  #sessionId: string | undefined;

  readonly #streamed = new Map<string, NativeAgentMessage>();
  #streamedOrder: string[] = [];
  #partial: AssistantMessage | undefined;
  #eventReplay = new NativeReaderEventReplay();
  #pendingMessages: NativeConversationTranscript["pendingMessages"];
  readonly #partialArgsRaw = new Map<number, string>();
  readonly #tools = new Map<string, NativeToolExecution>();

  readonly #windows = new Map<FileKind, FileWindow>();
  #followed = true;
  #revision = -1;
  #error: string | undefined;
  #snapshot: NativeConversationTranscript | undefined;
  #treeDirty = true;
  #messagesDirty = true;
  #streamingDirty = true;
  #branch: NativeTranscriptEntry[] = [];
  #branchMessages: NativeAgentMessage[] = [];
  #messages: NativeAgentMessage[] = [];
  #streaming: NativeConversationStreaming = { active: false, tools: [] };
  #pathComplete = false;
  #persisted = new Set<string>();
  #messageKeys = new WeakMap<NativeAgentMessage, string>();
  #entryProjections = new WeakMap<SessionEntry, { entry: NativeTranscriptEntry; messages: NativeAgentMessage[] }>();
  #logClassification: { path: string; kind: FileKind; dev: number; ino: number; size: number; mtimeMs: number } | undefined;
  #checkpoint: NativeReaderCheckpoint<NativeReaderState> | undefined;
  #suspendedMetadata: NativeReaderMetadata | undefined;
  readonly #loadedRanges = new Map<FileKind, Array<[number, number]>>();

  /** Last transcript produced; undefined before the first successful read. */
  get last(): NativeConversationTranscript | undefined {
    this.#resume();
    return this.#snapshot;
  }

  /** True when decoded history is offloaded to a private disk checkpoint. */
  get suspended(): boolean {
    return this.#checkpoint !== undefined;
  }

  /** Release decoded history without depending on the original source files. */
  suspend(): boolean {
    if (this.#checkpoint) return true;
    if (!this.#snapshot) return false;
    let checkpoint: NativeReaderCheckpoint<NativeReaderState>;
    try {
      checkpoint = new NativeReaderCheckpoint(this.#captureState());
    } catch {
      // Establish the complete checkpoint before dropping any usable state.
      return false;
    }
    const { messages: _messages, entries: _entries, streaming: _streaming, pendingMessages: _pending, ...metadata } = this.#snapshot;
    this.#suspendedMetadata = metadata;
    this.#checkpoint = checkpoint;
    this.#dropDecodedState();
    return true;
  }

  read(source: NativeConversationSource, followLatest = true): NativeConversationTranscript {
    const sourceId = typeof source?.id === "string" ? source.id : "";
    const status = typeof source?.status === "string" ? source.status : "";
    const explicitSession = typeof source?.sessionFile === "string" && source.sessionFile
      ? source.sessionFile
      : undefined;
    const explicitEvents = typeof source?.eventsFile === "string" && source.eventsFile
      ? source.eventsFile
      : undefined;
    const logFile = typeof source?.logFile === "string" ? source.logFile : undefined;

    let sessionFile = explicitSession;
    let eventsFile = explicitEvents;
    let logUnresolved = false;
    if (logFile && logFile !== explicitSession && logFile !== explicitEvents) {
      // Retained-actor fallback: logFile may BE a native session file.
      const kind = this.#classifyLog(logFile);
      if (kind === "session") sessionFile ??= logFile;
      else if (kind === "events") eventsFile ??= logFile;
      else logUnresolved = true;
    }

    if (sourceId === this.#sourceId && sessionFile === this.#sessionFile && !this.#resume()) {
      // Even an unrecoverable backing-file failure must not freeze participant
      // status. Keep the checkpoint and bookmarks available for later retries.
      this.#status = status;
      this.#followed = followLatest !== false;
      if (this.#suspendedMetadata) this.#suspendedMetadata = { ...this.#suspendedMetadata, status };
      if (this.#snapshot!.status !== status) {
        this.#snapshot = { ...this.#snapshot!, status, revision: ++this.#revision, updatedAt: Date.now() };
      }
      return this.#snapshot!;
    }
    if (sourceId !== this.#sourceId || sessionFile !== this.#sessionFile) {
      this.#resetPaths(sourceId, status, sessionFile, eventsFile);
    } else {
      this.#status = status;
      if (eventsFile !== this.#eventsFile) {
        // Rolling to the next activation run: preserve every bit of session
        // history loaded so far (including pinned older pages); reset only
        // events-derived streaming state.
        this.#eventsFile = eventsFile;
        this.#resetEventsState();
      }
    }
    if (logUnresolved) {
      // The log path was given but could not be read: surface it as an
      // unavailable events source instead of silently showing nothing.
      this.#windows.set("events", { head: 0, tail: 0, size: 0, hasOlder: false, unavailable: true });
      this.#setError(logFile ?? "source log unreadable");
    }
    this.#followed = followLatest !== false;
    this.#ingest(this.#followed);
    return this.#snapshot ?? this.#buildSnapshot();
  }

  /** Load older whole-record pages of history. Repeated calls load all of it. */
  loadOlder(pages = 1): NativeConversationTranscript | undefined {
    if (!this.#resume()) return this.#snapshot;
    if (!this.#snapshot) return undefined;
    for (let page = 0; page < Math.max(1, pages); page++) {
      let progressed = false;
      for (const [kind, filePath] of this.#windowFiles()) {
        if (this.#loadOlderFile(kind, filePath)) progressed = true;
      }
      if (!progressed) break;
    }
    this.#snapshot = this.#buildSnapshot();
    return this.#snapshot;
  }

  /** Consume any records newer than the current window (used when pinned). */
  loadNewer(): NativeConversationTranscript | undefined {
    if (!this.#resume()) return this.#snapshot;
    if (!this.#snapshot) return undefined;
    this.#followed = true;
    this.#ingest(true);
    return this.#snapshot ?? undefined;
  }

  /** Drop the current windows and re-read from the tail of both files. */
  loadLatest(): NativeConversationTranscript | undefined {
    if (!this.#resume()) return this.#snapshot;
    if (!this.#snapshot) return undefined;
    for (const [kind, filePath] of this.#windowFiles()) this.#initWindow(kind, filePath);
    this.#followed = true;
    this.#ingest(true);
    return this.#snapshot ?? undefined;
  }

  /** Drop all cached state for a clean re-read. */
  clear(): void {
    this.#resetPaths("", "", undefined, undefined);
  }

  #captureState(): NativeReaderState {
    return {
      entries: this.#entries,
      sessionEntryIds: [...this.#sessionEntryIds],
      eventEntryIds: [...this.#eventEntryIds],
      streamed: this.#streamedOrder.map((key) => this.#streamed.get(key)!),
      partial: this.#partial,
      pendingMessages: this.#pendingMessages,
      partialArgsRaw: [...this.#partialArgsRaw],
      tools: [...this.#tools.values()],
      eventRecords: [...this.#eventReplay.records()],
    };
  }

  #dropDecodedState(): void {
    this.#entries = [];
    this.#entryIds.clear();
    this.#byId.clear();
    this.#sessionEntryIds.clear();
    this.#eventEntryIds.clear();
    this.#eventReplay = new NativeReaderEventReplay();
    this.#resetStreamingState();
    this.#treeDirty = true;
    this.#pathComplete = false;
    this.#branch = [];
    this.#branchMessages = [];
    this.#messages = [];
    this.#persisted.clear();
    this.#messageKeys = new WeakMap();
    this.#entryProjections = new WeakMap();
    this.#snapshot = undefined;
  }

  #restoreState(state: NativeReaderState): void {
    this.#dropDecodedState();
    this.#entries = state.entries;
    for (const entry of state.entries) {
      this.#entryIds.add(entry.id);
      this.#byId.set(entry.id, entry);
    }
    for (const id of state.sessionEntryIds) this.#sessionEntryIds.add(id);
    for (const id of state.eventEntryIds) this.#eventEntryIds.add(id);
    for (const message of state.streamed) this.#foldMessage(message);
    this.#partial = state.partial;
    this.#pendingMessages = state.pendingMessages;
    for (const [index, raw] of state.partialArgsRaw) this.#partialArgsRaw.set(index, raw);
    for (const tool of state.tools) this.#tools.set(tool.toolCallId, tool);
    this.#eventReplay = new NativeReaderEventReplay(state.eventRecords);
  }

  #rememberRange(kind: FileKind, page: RecordPage): void {
    if (page.end <= page.start) return;
    const ranges = [...(this.#loadedRanges.get(kind) ?? []), [page.start, page.end] as [number, number]];
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const range of ranges) {
      const previous = merged.at(-1);
      if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
      else merged.push([...range]);
    }
    this.#loadedRanges.set(kind, merged);
  }

  #restoreLoadedRanges(): NativeReaderState {
    const restored = new NativeConversationReader();
    for (const [kind, filePath] of this.#windowFiles()) {
      const ranges = this.#loadedRanges.get(kind);
      if (!ranges?.length) continue;
      const opened = openDescriptor(filePath);
      if (!opened || "error" in opened) throw new Error(`${filePath}: ${opened?.error ?? "unavailable"}`);
      try {
        for (const [head, tail] of ranges) {
          if (opened.size < tail) throw new Error(`${filePath}: loaded range no longer available`);
          let offset = head;
          while (offset < tail) {
            const page = readForwardPage(opened.descriptor, offset, tail, GROWTH_PAGE_BYTES);
            if (page.end <= offset) throw new Error(`${filePath}: incomplete loaded range`);
            restored.#applyRecords(kind, page.records, true);
            offset = page.end;
          }
        }
      } finally {
        closeQuietly(opened.descriptor);
      }
    }
    return restored.#captureState();
  }

  #resume(): boolean {
    const checkpoint = this.#checkpoint;
    if (!checkpoint) return true;
    let state: NativeReaderState;
    try {
      try {
        state = checkpoint.restore();
      } catch {
        // A damaged checkpoint can only fall back to the exact loaded ranges,
        // never the current tail. Unreadable sources leave ownership intact.
        state = this.#restoreLoadedRanges();
      }
    } catch (error) {
      const reason = clipError(`Unable to restore reader history: ${clipError(error)}`);
      if (this.#snapshot?.error !== reason) {
        this.#snapshot = {
          ...this.#suspendedMetadata!,
          messages: [], entries: [], streaming: { active: false, tools: [] },
          revision: ++this.#revision,
          unavailable: {
            ...(this.#sessionFile ? { sessionFile: true } : {}),
            ...(this.#eventsFile ? { eventsFile: true } : {}),
          },
          error: reason,
          updatedAt: Date.now(),
        };
      }
      return false;
    }
    this.#restoreState(state);
    this.#checkpoint = undefined;
    this.#suspendedMetadata = undefined;
    checkpoint.dispose();
    this.#snapshot = this.#buildSnapshot();
    return true;
  }

  #windowFiles(): Array<[FileKind, string]> {
    const files: Array<[FileKind, string]> = [];
    if (this.#sessionFile) files.push(["session", this.#sessionFile]);
    if (this.#eventsFile) files.push(["events", this.#eventsFile]);
    return files;
  }

  #setError(detail: string): void {
    this.#error = clipError(detail);
  }

  #resetPaths(
    sourceId: string,
    status: string,
    sessionFile: string | undefined,
    eventsFile: string | undefined,
  ): void {
    this.#checkpoint?.dispose();
    this.#checkpoint = undefined;
    this.#suspendedMetadata = undefined;
    this.#loadedRanges.clear();
    this.#sourceId = sourceId;
    this.#status = status;
    this.#sessionFile = sessionFile;
    this.#eventsFile = eventsFile;
    this.#entries = [];
    this.#entryIds.clear();
    this.#byId.clear();
    this.#sessionEntryIds.clear();
    this.#eventEntryIds.clear();
    this.#sessionLeafId = undefined;
    this.#eventLeafId = undefined;
    this.#sessionId = undefined;
    this.#eventReplay = new NativeReaderEventReplay();
    this.#resetStreamingState();
    this.#windows.clear();
    this.#treeDirty = true;
    this.#messagesDirty = true;
    this.#branch = [];
    this.#branchMessages = [];
    this.#messages = [];
    this.#persisted.clear();
    this.#messageKeys = new WeakMap();
    this.#entryProjections = new WeakMap();
    this.#error = undefined;
    this.#snapshot = undefined;
    for (const [kind, filePath] of this.#windowFiles()) this.#initWindow(kind, filePath);
  }

  #resetStreamingState(): void {
    this.#messagesDirty = true;
    this.#streamingDirty = true;
    this.#streaming = { active: false, tools: [] };
    this.#pendingMessages = undefined;
    this.#streamed.clear();
    this.#streamedOrder = [];
    this.#partial = undefined;
    this.#partialArgsRaw.clear();
    this.#tools.clear();
  }

  #resetEventsState(): void {
    this.#treeDirty = true;
    this.#eventReplay = new NativeReaderEventReplay();
    this.#resetStreamingState();
    this.#eventLeafId = undefined;
    for (const id of this.#eventEntryIds) {
      if (this.#sessionEntryIds.has(id)) continue;
      this.#entryIds.delete(id);
      const entry = this.#byId.get(id);
      if (entry) {
        this.#byId.delete(id);
        const index = this.#entries.indexOf(entry);
        if (index >= 0) this.#entries.splice(index, 1);
      }
    }
    this.#eventEntryIds.clear();
    this.#windows.delete("events");
    this.#loadedRanges.delete("events");
    this.#error = undefined;
    if (this.#eventsFile) this.#initWindow("events", this.#eventsFile);
  }

  #initWindow(kind: FileKind, filePath: string): void {
    const opened = openDescriptor(filePath);
    if (!opened || "error" in opened) {
      this.#windows.set(kind, {
        head: 0,
        tail: 0,
        size: 0,
        hasOlder: false,
        unavailable: true,
      });
      if (opened && "error" in opened) this.#setError(`${filePath}: ${opened.error}`);
      return;
    }
    try {
      const page = readBackwardPage(opened.descriptor, opened.size, INITIAL_PAGE_BYTES, kind === "events");
      this.#applyRecords(kind, page.records, true);
      this.#rememberRange(kind, page);
      this.#windows.set(kind, {
        head: page.start,
        tail: page.end,
        size: opened.size,
        hasOlder: page.start > 0,
        unavailable: false,
      });
    } catch (error) {
      this.#windows.set(kind, {
        head: 0,
        tail: 0,
        size: 0,
        hasOlder: false,
        unavailable: true,
      });
      this.#setError(`${filePath}: ${clipError(error)}`);
    } finally {
      closeQuietly(opened.descriptor);
    }
  }

  #loadOlderFile(kind: FileKind, filePath: string): boolean {
    const window = this.#windows.get(kind);
    if (!window || !window.hasOlder || window.head <= 0) return false;
    const opened = openDescriptor(filePath);
    if (!opened) return false;
    if ("error" in opened) {
      window.unavailable = true;
      this.#setError(`${filePath}: ${opened.error}`);
      return false;
    }
    try {
      const page = readBackwardPage(opened.descriptor, window.head, OLDER_PAGE_BYTES, false);
      if (page.start >= window.head) return false;
      // Older records join the index without moving the authoritative leaf.
      this.#applyRecords(kind, page.records, false);
      this.#rememberRange(kind, page);
      window.head = page.start;
      window.hasOlder = page.start > 0;
      window.unavailable = false;
      return true;
    } finally {
      closeQuietly(opened.descriptor);
    }
  }

  #growFile(kind: FileKind, filePath: string, followLatest: boolean): boolean {
    const window = this.#windows.get(kind);
    if (!window) return false;
    const opened = openDescriptor(filePath);
    if (!opened) return false;
    if ("error" in opened) {
      window.unavailable = true;
      this.#setError(`${filePath}: ${opened.error}`);
      return false;
    }
    try {
      window.size = opened.size;
      window.unavailable = false;
      if (!followLatest || opened.size <= window.tail) return false;
      const page = readForwardPage(opened.descriptor, window.tail, opened.size, GROWTH_PAGE_BYTES);
      if (page.end <= window.tail) return false;
      this.#applyRecords(kind, page.records, true);
      this.#rememberRange(kind, page);
      window.tail = Math.max(window.tail, page.end);
      return true;
    } finally {
      closeQuietly(opened.descriptor);
    }
  }

  #ingest(followLatest: boolean): void {
    for (const [kind, filePath] of this.#windowFiles()) {
      this.#growFile(kind, filePath, followLatest);
    }
    this.#snapshot = this.#buildSnapshot();
  }

  #applyRecords(kind: FileKind, records: string[], updateLeaf: boolean): void {
    const parsed = records.map(parseRecord).filter((record): record is JsonObject => record !== undefined);
    if (kind === "session") {
      for (const record of parsed) this.#applySessionRecord(record, updateLeaf);
      return;
    }
    if (updateLeaf) {
      for (const record of parsed) {
        this.#eventReplay.append(record);
        this.#applyEventRecord(record);
      }
    } else {
      // Older event pages must prepend in arrival order, not append messages
      // after the live tail or overwrite live queue/partial/tool state.
      const replay = new NativeReaderEventReplay(parsed);
      for (const record of this.#eventReplay.records()) replay.append(record);
      this.#eventReplay = replay;
      this.#resetStreamingState();
      this.#eventLeafId = undefined;
      for (const record of replay.records()) this.#applyEventRecord(record);
    }
  }

  #applySessionRecord(record: Record<string, unknown>, updateLeaf: boolean): void {
    if (record.type === "session") {
      if (typeof record.id === "string") this.#sessionId = record.id;
      return;
    }
    if (!isSessionEntry(record)) return;
    this.#appendEntry(record, "session", updateLeaf);
  }

  // Entry list order is irrelevant: path construction walks byId from the leaf,
  // so older pages and live folds can append in any order.
  #appendEntry(entry: SessionEntry, origin: "session" | "events", updateLeaf = true): void {
    this.#treeDirty = true;
    this.#messagesDirty = true;
    if (this.#entryIds.has(entry.id)) {
      const existing = this.#byId.get(entry.id);
      if (existing && existing !== entry) {
        const replacement = { ...existing, ...entry } as SessionEntry;
        this.#entries[this.#entries.indexOf(existing)] = replacement;
        this.#byId.set(entry.id, replacement);
      }
      (origin === "session" ? this.#sessionEntryIds : this.#eventEntryIds).add(entry.id);
      if (updateLeaf) {
        if (origin === "session") this.#sessionLeafId = entry.id;
        else this.#eventLeafId = entry.id;
      }
      return;
    }
    this.#entryIds.add(entry.id);
    this.#byId.set(entry.id, entry);
    (origin === "session" ? this.#sessionEntryIds : this.#eventEntryIds).add(entry.id);
    this.#entries.push(entry);
    if (!updateLeaf) return;
    if (origin === "session") this.#sessionLeafId = entry.id;
    else this.#eventLeafId = entry.id;
  }

  #applyEventRecord(event: Record<string, unknown>): void {
    switch (event.type) {
      case "queue_update": {
        const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
        this.#pendingMessages = { steering: strings(event.steering), followUp: strings(event.followUp) };
        return;
      }
      case "message_start": {
        const message = event.message as NativeAgentMessage | undefined;
        if (!message || typeof message !== "object") return;
        if (message.role === "assistant") {
          this.#streamingDirty = true;
          this.#partial = {
            ...message,
            content: message.content.map((part) => ({ ...part })),
            usage: message.usage ?? emptyUsage(),
            stopReason: message.stopReason && message.stopReason !== "pending" ? message.stopReason : "pending",
          };
        } else {
          this.#foldMessage(message);
        }
        return;
      }
      case "message_update":
        this.#applyPartialDelta(event);
        return;
      case "message_end": {
        const message = event.message as NativeAgentMessage | undefined;
        if (!message || typeof message !== "object") return;
        if (message.role === "assistant") {
          this.#streamingDirty = true;
          this.#partial = undefined;
          this.#partialArgsRaw.clear();
        }
        this.#foldMessage(message);
        return;
      }
      case "tool_execution_start": {
        if (typeof event.toolCallId !== "string") return;
        this.#streamingDirty = true;
        const args = event.args as Record<string, unknown> | undefined;
        this.#tools.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          toolName: typeof event.toolName === "string" ? event.toolName : "",
          ...(args !== undefined ? { args } : {}),
          status: "running",
          executionStarted: true,
          argsComplete: true,
        });
        return;
      }
      case "tool_execution_update": {
        const tool = this.#toolFor(event);
        if (!tool) return;
        this.#streamingDirty = true;
        const partial = event.partialResult as { content?: unknown[]; details?: unknown } | undefined;
        if (partial && typeof partial === "object") {
          tool.partial = {
            ...(Array.isArray(partial.content) ? { content: partial.content } : {}),
            ...(partial.details !== undefined ? { details: partial.details } : {}),
          };
        }
        return;
      }
      case "tool_execution_end": {
        const tool = this.#toolFor(event);
        if (!tool) return;
        this.#streamingDirty = true;
        const result = event.result as { content?: unknown[]; details?: unknown } | undefined;
        if (result && typeof result === "object") {
          tool.result = {
            ...(Array.isArray(result.content) ? { content: result.content } : {}),
            ...(result.details !== undefined ? { details: result.details } : {}),
          };
        }
        tool.isError = event.isError === true;
        tool.status = event.isError === true ? "failed" : "completed";
        tool.executionStarted = true;
        tool.argsComplete = true;
        return;
      }
      case "turn_end": {
        const message = event.message as NativeAgentMessage | undefined;
        if (message && typeof message === "object") this.#foldMessage(message);
        if (Array.isArray(event.toolResults)) {
          for (const result of event.toolResults) {
            if (result && typeof result === "object") this.#foldMessage(result as NativeAgentMessage);
          }
        }
        return;
      }
      case "agent_end": {
        if (!Array.isArray(event.messages)) return;
        for (const message of event.messages) {
          if (message && typeof message === "object") this.#foldMessage(message as NativeAgentMessage);
        }
        return;
      }
      case "entry_appended": {
        if (isSessionEntry(event.entry)) this.#appendEntry(event.entry, "events");
        return;
      }
      default:
        return;
    }
  }

  #toolFor(event: Record<string, unknown>): NativeToolExecution | undefined {
    if (typeof event.toolCallId !== "string") return undefined;
    const previous = this.#tools.get(event.toolCallId);
    if (!previous) return undefined;
    const tool = { ...previous };
    this.#tools.set(event.toolCallId, tool);
    return tool;
  }

  #applyPartialDelta(event: Record<string, unknown>): void {
    const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
    if (!delta || typeof delta !== "object") return;
    this.#streamingDirty = true;
    if (!this.#partial) {
      this.#partial = {
        role: "assistant",
        content: [],
        api: "",
        provider: "",
        model: "",
        usage: emptyUsage(),
        stopReason: "pending",
        timestamp: Date.now(),
      };
    }
    const partial = this.#partial;
    if (event.usage && typeof event.usage === "object") {
      partial.usage = event.usage as AssistantMessage["usage"];
    }
    const contentIndex = typeof delta.contentIndex === "number" ? delta.contentIndex : 0;
    switch (delta.type) {
      case "text_start":
        partial.content[contentIndex] = { type: "text", text: "" };
        return;
      case "text_delta": {
        const block = partial.content[contentIndex];
        const text = typeof delta.delta === "string" ? delta.delta : "";
        partial.content[contentIndex] = {
          type: "text",
          text: (block?.type === "text" ? block.text : "") + text,
        };
        return;
      }
      case "text_end": {
        if (typeof delta.content === "string") {
          partial.content[contentIndex] = { type: "text", text: delta.content };
        }
        return;
      }
      case "thinking_start":
        partial.content[contentIndex] = { type: "thinking", thinking: "" };
        return;
      case "thinking_delta": {
        const block = partial.content[contentIndex];
        const text = typeof delta.delta === "string" ? delta.delta : "";
        partial.content[contentIndex] = {
          type: "thinking",
          thinking: (block?.type === "thinking" ? block.thinking : "") + text,
        };
        return;
      }
      case "thinking_end": {
        if (typeof delta.content === "string") {
          partial.content[contentIndex] = { type: "thinking", thinking: delta.content };
        }
        return;
      }
      case "toolcall_start": {
        this.#partialArgsRaw.delete(contentIndex);
        partial.content[contentIndex] = {
          type: "toolCall",
          id: typeof delta.id === "string" ? delta.id : "",
          name: typeof delta.toolName === "string" ? delta.toolName : "",
          arguments: {},
        };
        return;
      }
      case "toolcall_delta": {
        const raw = typeof delta.delta === "string" ? delta.delta : "";
        if (!raw) return;
        const accumulated = (this.#partialArgsRaw.get(contentIndex) ?? "") + raw;
        this.#partialArgsRaw.set(contentIndex, accumulated);
        const parsed = parseRecord(accumulated);
        const block = partial.content[contentIndex];
        if (block?.type === "toolCall" && parsed) partial.content[contentIndex] = { ...block, arguments: parsed };
        return;
      }
      case "toolcall_end": {
        const toolCall = delta.toolCall as AssistantMessage["content"][number] | undefined;
        if (toolCall && typeof toolCall === "object") partial.content[contentIndex] = toolCall;
        this.#partialArgsRaw.delete(contentIndex);
        return;
      }
      default:
        return;
    }
  }

  #foldMessage(message: NativeAgentMessage): void {
    if (!message || typeof message !== "object" || typeof message.role !== "string") return;
    const key = this.#messageKey(message);
    if (this.#streamed.has(key)) return;
    this.#messagesDirty = true;
    this.#streamed.set(key, message);
    this.#streamedOrder.push(key);
  }

  #messageKey(message: NativeAgentMessage): string {
    let key = this.#messageKeys.get(message);
    if (key === undefined) {
      key = messageKey(message);
      this.#messageKeys.set(message, key);
    }
    return key;
  }

  #classifyLog(filePath: string): FileKind | "unreadable" {
    const cached = this.#logClassification;
    try {
      const stat = fs.lstatSync(filePath);
      if (cached?.path === filePath && stat.isFile() && cached.dev === stat.dev && cached.ino === stat.ino &&
        cached.size > 0 && (stat.size > cached.size || (stat.size === cached.size && stat.mtimeMs === cached.mtimeMs))) {
        return cached.kind;
      }
      const kind = classifyFile(filePath);
      if (kind !== "unreadable") {
        this.#logClassification = { path: filePath, kind, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
        return kind;
      }
    } catch {
      // Keep a previously classified source attached while it is unavailable.
      // Dropping its path here would discard the user's cached loaded history.
    }
    return cached?.path === filePath ? cached.kind : "unreadable";
  }

  #buildSnapshot(): NativeConversationTranscript {
    const sessionWindow = this.#windows.get("session");
    const eventsWindow = this.#windows.get("events");
    const hasMore = (sessionWindow?.hasOlder ?? false) || (eventsWindow?.hasOlder ?? false);
    const hasNewer = !this.#followed &&
      ((sessionWindow !== undefined && sessionWindow.tail < sessionWindow.size) ||
        (eventsWindow !== undefined && eventsWindow.tail < eventsWindow.size));
    // Persisted entries are authoritative, including abandoned branches and
    // compacted messages that must not be resurrected by their RPC copies.
    const leafId = this.#sessionLeafId ?? this.#eventLeafId ?? null;
    if (this.#treeDirty) {
      this.#pathComplete = leafId !== null && this.#pathReachesRoot(leafId);
      const branch = leafId !== null ? getConversationHost().buildContextEntries(this.#entries, leafId, this.#byId) : [];
      const projections = branch.map((entry) => {
        let projected = this.#entryProjections.get(entry);
        if (!projected) {
          projected = {
            entry: {
              entryId: entry.id,
              parentId: entry.parentId,
              entryType: entry.type,
              timestamp: entry.timestamp,
              ...(entry.type === "message" ? { message: entry.message } : {}),
              entry,
            },
            messages: getConversationHost().sessionEntryToContextMessages(entry),
          };
          this.#entryProjections.set(entry, projected);
        }
        return projected;
      });
      this.#branch = projections.map((projection) => projection.entry);
      this.#branchMessages = projections.flatMap((projection) => projection.messages);
      this.#persisted = new Set(this.#entries.flatMap((entry) => entry.type === "message" ? [this.#messageKey(entry.message)] : []));
      this.#treeDirty = false;
      this.#messagesDirty = true;
    }
    if (this.#messagesDirty) {
      const streamed = this.#streamedOrder
        .filter((key) => !this.#persisted.has(key))
        .map((key) => this.#streamed.get(key)!);
      this.#messages = [...this.#branchMessages, ...streamed];
      this.#messagesDirty = false;
    }
    if (this.#streamingDirty) {
      const tools = [...this.#tools.values()];
      // Deltas address blocks by contentIndex, so a window that starts mid-message
      // leaves holes for blocks it has not loaded yet. Keep the indexed array for
      // later deltas and older-page replay; publish only the blocks that exist.
      const partialAssistant = this.#partial
        ? { ...this.#partial, content: this.#partial.content.filter((block) => block !== undefined) }
        : undefined;
      this.#streaming = {
        active: partialAssistant !== undefined || tools.some((tool) => tool.status === "running"),
        ...(partialAssistant ? { partialAssistant } : {}),
        tools,
      };
      this.#streamingDirty = false;
    }
    const historyComplete = !hasMore && this.#pathComplete &&
      (sessionWindow?.head ?? 0) === 0 && (eventsWindow?.head ?? 0) === 0;
    const unavailable: { sessionFile?: boolean; eventsFile?: boolean } = {};
    if (sessionWindow?.unavailable) unavailable.sessionFile = true;
    if (eventsWindow?.unavailable) unavailable.eventsFile = true;
    const hasUnavailable = unavailable.sessionFile || unavailable.eventsFile;
    const error = hasUnavailable ? this.#error : undefined;
    const previous = this.#snapshot;
    if (previous && previous.messages === this.#messages && previous.entries === this.#branch &&
      previous.streaming === this.#streaming && previous.pendingMessages === this.#pendingMessages &&
      previous.leafId === leafId && previous.sourceId === this.#sourceId && previous.status === this.#status &&
      previous.sessionFile === this.#sessionFile && previous.eventsFile === this.#eventsFile && previous.sessionId === this.#sessionId &&
      previous.historyComplete === historyComplete && previous.hasMore === hasMore && previous.hasNewer === hasNewer &&
      previous.unavailable?.sessionFile === unavailable.sessionFile && previous.unavailable?.eventsFile === unavailable.eventsFile &&
      previous.error === error) return previous;
    return {
      messages: this.#messages,
      revision: ++this.#revision,
      entries: this.#branch,
      streaming: this.#streaming,
      ...(this.#pendingMessages ? { pendingMessages: this.#pendingMessages } : {}),
      leafId,
      sourceId: this.#sourceId,
      status: this.#status,
      ...(this.#sessionFile ? { sessionFile: this.#sessionFile } : {}),
      ...(this.#eventsFile ? { eventsFile: this.#eventsFile } : {}),
      ...(this.#sessionId ? { sessionId: this.#sessionId } : {}),
      historyComplete,
      hasMore,
      hasNewer,
      ...(hasUnavailable ? { unavailable } : {}),
      ...(error ? { error } : {}),
      updatedAt: Date.now(),
    };
  }

  #pathReachesRoot(leafId: string): boolean {
    let current = this.#byId.get(leafId);
    if (!current) return false;
    const guard = new Set<string>();
    while (current.parentId !== null) {
      if (guard.has(current.id)) return true;
      guard.add(current.id);
      const parent = this.#byId.get(current.parentId);
      if (!parent) return false;
      current = parent;
    }
    return true;
  }
}
