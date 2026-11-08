import type {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  MarkdownTransformer,
  MessageRenderer,
  Theme,
  TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { getConversationHost } from "./conversation-host.js";
import type { MarkdownTheme, TUI } from "@earendil-works/pi-tui";
import { Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { conversationFeedback } from "./conversation-feedback.js";
import type { CodePreviewSettings } from "./code-preview.js";
import { highlightCode } from "./highlight.js";
import { terminalSafe } from "./transcript-sanitization.js";
import type { FabricConversationTarget } from "./conversation.js";
import { unwrapActorEnvelopeText } from "./conversation-transcript.js";
import type {
  NativeAgentMessage,
  NativeConversationTranscript,
  NativeToolExecution,
} from "./conversation-native-reader.js";

export type {
  NativeAgentMessage,
  NativeConversationTranscript,
  NativeToolExecution,
} from "./conversation-native-reader.js";

type UserAgentMessage = Extract<NativeAgentMessage, { role: "user" }>;
type ToolResultAgentMessage = Extract<NativeAgentMessage, { role: "toolResult" }>;
type BashExecutionAgentMessage = Extract<NativeAgentMessage, { role: "bashExecution" }>;
type CustomAgentMessage = Extract<NativeAgentMessage, { role: "custom" }>;
type CompactionSummaryAgentMessage = Extract<NativeAgentMessage, { role: "compactionSummary" }>;
type BranchSummaryAgentMessage = Extract<NativeAgentMessage, { role: "branchSummary" }>;

/** Exactly what ToolExecutionComponent accepts as its tool definition. */
export type FabricToolDefinitionLike = ConstructorParameters<typeof ToolExecutionComponent>[4];
export type FabricGetToolDefinition = (toolName: string) => FabricToolDefinitionLike;

export interface FabricConversationTranscriptRendererOptions {
  /**
   * Registered tool definitions (Main wires the actual fabricTool and
   * capturedTools.get(name).definition). Undefined falls back to the native
   * generic tool card, exactly like interactive-mode getRegisteredToolDefinition.
   */
  getToolDefinition?: FabricGetToolDefinition | undefined;
  /** Extension message renderers (capturedTools.runner.getMessageRenderer). */
  getMessageRenderer?: ((customType: string) => MessageRenderer | undefined) | undefined;
  /** Native markdown transformers (capturedTools.runner.getMarkdownTransformers). */
  markdownTransformers?: readonly MarkdownTransformer[] | undefined;
  hiddenThinkingLabel?: string | undefined;
  imageWidthCells?: number | undefined;
}

export interface FabricConversationTranscriptRenderOptions {
  target: FabricConversationTarget;
  toolsExpanded: boolean;
  outputPad?: 0 | 1;
  codeBlockIndent?: string;
  codePreviewSettings?: CodePreviewSettings | undefined;
  hideThinking?: boolean;
  showImages?: boolean;
}

type NativeToolResultContent = { type: string; text?: string; data?: string; mimeType?: string };

const DEFAULT_IMAGE_WIDTH_CELLS = 60;

const stableKey = (value: unknown): string => {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return `unserializable:${String(value)}`;
  }
};

interface RenderedRow {
  render: (width: number) => string[];
  lines?: string[] | undefined;
  spacer: boolean;
  dynamic: boolean;
  partial?: boolean;
  input?: readonly unknown[];
}

interface ToolCacheRecord {
  component: ToolExecutionComponent;
  name: string;
  dynamicRenderer: boolean;
  started: boolean;
  argsComplete: boolean;
  args: unknown;
  argsKey: string;
  result: unknown;
  resultKey: string | undefined;
  partialKey: string | undefined;
  imageKey: string;
  isPartial: boolean;
  isError: boolean;
  error: string | undefined;
}

interface MessageCacheRecord {
  component: BashExecutionComponent | CustomMessageComponent | CompactionSummaryMessageComponent
    | BranchSummaryMessageComponent | SkillInvocationMessageComponent;
}

interface AssistantCacheRecord {
  hideThinking: boolean;
  message?: NativeAgentMessage;
  streaming?: boolean;
  component: AssistantMessageComponent;
}

/**
 * Renders a conversation-native transcript with the exact registered Pi
 * components (UserMessageComponent, AssistantMessageComponent,
 * ToolExecutionComponent, BashExecutionComponent, compaction/branch/custom
 * summaries), dispatched the way interactive-mode addMessageToChat and
 * renderSessionItems do. Native component rows are preserved verbatim — no
 * dashboard normalization, no per-line re-truncation, no extra background or
 * glyph decoration — so full-width backgrounds and native spacing survive.
 */
export class FabricConversationTranscriptRenderer {
  private readonly toolComponents = new Map<string, ToolCacheRecord>();
  private readonly messageComponents = new Map<string, MessageCacheRecord>();
  private readonly assistantComponents = new Map<string, AssistantCacheRecord>();
  private readonly markdownThemeCache = new Map<string, MarkdownTheme>();
  private readonly highlightInvalidate: () => void;
  private disposed = false;
  private currentTargetId = "";
  private readonly rendererStates = new Map<string, Set<Record<string, unknown>>>();
  private readonly liveStates = new WeakSet<object>();
  private readonly messageRows = new Map<NativeAgentMessage, RenderedRow>();
  private readonly toolRows = new Map<string, RenderedRow>();
  private readonly toolTokens = new Map<string, object>();
  private readonly messageIds = new WeakMap<NativeAgentMessage, number>();
  private nextMessageId = 0;
  private rows: RenderedRow[] = [];
  private lastMessages: NativeAgentMessage[] = [];
  private lastTools: NativeToolExecution[] = [];
  private lastPartial: NativeConversationTranscript["streaming"]["partialAssistant"];
  private lastVersion: number | undefined;
  private sourceKey = "";
  private optionsKey = "";
  private lastRendererHooks: unknown[] = [];
  private lastWidth = 0;
  private frameLines: string[] | undefined;
  private frameFlags = "";
  private planDirty = true;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly rendererOptions: FabricConversationTranscriptRendererOptions = {},
  ) {
    this.highlightInvalidate = (): void => {
      if (this.disposed) return;
      this.invalidate();
      this.tui.requestRender();
    };
  }

  /** Drop cached components; stray renderer timers/invalidations become no-ops. */
  invalidate(): void {
    this.toolTokens.clear();
    for (const key of this.rendererStates.keys()) this.releaseRendererStates(key);
    this.toolComponents.clear();
    this.messageComponents.clear();
    this.assistantComponents.clear();
    this.markdownThemeCache.clear();
    this.messageRows.clear();
    this.toolRows.clear();
    this.rows = [];
    this.lastMessages = [];
    this.lastTools = [];
    this.lastPartial = undefined;
    this.frameLines = undefined;
    this.planDirty = true;
  }

  /** Finalize: live spinner/timing intervals may still fire once; guarded. */
  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  render(transcript: NativeConversationTranscript, width: number, options: FabricConversationTranscriptRenderOptions, ownership?: "copy"): string[];
  render(transcript: NativeConversationTranscript, width: number, options: FabricConversationTranscriptRenderOptions, ownership: "borrow"): readonly string[];
  render(
    transcript: NativeConversationTranscript,
    width: number,
    options: FabricConversationTranscriptRenderOptions,
    ownership: "copy" | "borrow" = "copy",
  ): readonly string[] {
    if (this.disposed || width <= 0) return [];
    width = Math.max(1, width);
    // Revisions are reader-local, and a participant can roll to a new activation.
    const sourceKey = stableKey([options.target.id, options.target.cwd ?? process.cwd(), transcript.sourceId,
      transcript.sessionId, transcript.sessionFile, transcript.eventsFile]);
    const optionsKey = stableKey([options.toolsExpanded, options.outputPad, options.codeBlockIndent,
      options.hideThinking, options.showImages, options.codePreviewSettings,
      this.rendererOptions.hiddenThinkingLabel, this.rendererOptions.imageWidthCells]);
    const hooks = [this.rendererOptions.getToolDefinition, this.rendererOptions.getMessageRenderer,
      ...(this.rendererOptions.markdownTransformers ?? [])];
    if (sourceKey !== this.sourceKey || optionsKey !== this.optionsKey || !sameItems(hooks, this.lastRendererHooks)) {
      this.invalidate();
      this.sourceKey = sourceKey;
      this.optionsKey = optionsKey;
      this.lastRendererHooks = hooks;
    }
    this.currentTargetId = options.target.id;
    const version = (transcript as NativeConversationTranscript & { contentVersion?: number }).contentVersion
      ?? transcript.revision;
    const streaming = transcript.streaming;
    // Compare identities, not content keys: fixtures may replace a message without
    // bumping revision, while reader metadata can change without replacing content.
    if (this.planDirty || version !== this.lastVersion ||
      !sameItems(transcript.messages, this.lastMessages) ||
      !sameItems(streaming.tools, this.lastTools) || streaming.partialAssistant !== this.lastPartial) {
      this.reconcileRows(transcript, options);
      this.lastVersion = version;
    }
    if (width !== this.lastWidth) {
      this.lastWidth = width;
      for (const row of this.rows) row.lines = undefined;
      this.frameLines = undefined;
    }
    for (const row of this.rows) {
      if (row.lines && !row.dynamic) continue;
      const lines = row.render(width);
      if (!row.lines || !sameItems(row.lines, lines)) {
        // Dynamic renderers still run every frame, but unchanged image/spinner
        // output must not rebuild the entire retained transcript. Snapshot their
        // rows in case a custom component reuses and mutates its output array.
        row.lines = row.dynamic ? lines.slice() : lines;
        this.frameLines = undefined;
      }
    }
    const flags = `${transcript.hasMore}:${transcript.hasNewer}`;
    if (!this.frameLines || flags !== this.frameFlags) {
      const lines: string[] = [];
      if (!transcript.messages.length && !streaming.partialAssistant && !streaming.tools.length) {
        lines.push(this.theme.fg("dim", "No retained transcript yet; new agent activity will appear here."));
      } else {
        if (transcript.hasMore) {
          lines.push(this.theme.fg("dim", "↑ older activity available · ctrl+↑ past the top to load"));
        }
        for (const row of this.rows) {
          if (!row.lines?.length) continue;
          if (row.spacer && lines.length) lines.push("");
          for (const line of row.lines) lines.push(line);
        }
        if (transcript.hasNewer) {
          lines.push(this.theme.fg("dim", "↓ newer activity available · ctrl+↓ past the bottom to load"));
        }
      }
      this.frameLines = lines;
      this.frameFlags = flags;
    }
    // The view borrows an immutable snapshot for indexed scrolling/selection.
    // Ordinary callers keep their mutable defensive copy. Never mutate a borrowed
    // frame: all invalidation paths replace it, preserving pinned selections.
    return ownership === "borrow" ? this.frameLines : this.frameLines.slice();
  }

  private reconcileRows(
    transcript: NativeConversationTranscript,
    options: FabricConversationTranscriptRenderOptions,
  ): void {
    const rows: RenderedRow[] = [];
    const messages = new Set<NativeAgentMessage>();
    const keys = new Set<string>();
    const tools = new Set<string>();
    const results = new Map<string, ToolResultAgentMessage>();
    const streaming = new Map(transcript.streaming.tools.map((tool) => [tool.toolCallId, tool]));
    for (const message of transcript.messages) {
      if (message.role === "toolResult") results.set(message.toolCallId, message);
    }
    const addTool = (id: string, name: string, args: Record<string, unknown> | undefined, error?: string): void => {
      if (tools.has(id)) return;
      tools.add(id);
      rows.push(this.reconcileTool(id, name, args, results.get(id), streaming.get(id), error, options));
    };
    const addMessage = (message: NativeAgentMessage, partial = false): void => {
      if (message.role === "toolResult") return;
      messages.add(message);
      const key = partial ? ":streaming" : this.messageKey(message);
      keys.add(key);
      let row = this.messageRows.get(message);
      const input = shallowInput(message);
      if (!row || row.partial !== partial || !sameItems(row.input ?? [], input)) {
        if (row) {
          this.assistantComponents.delete(key);
          this.messageComponents.delete(key);
        }
        row = {
          input,
          partial,
          spacer: message.role !== "assistant",
          // A custom component can read time or external state in render(width).
          dynamic: message.role === "custom" && message.display,
          render: (width) => {
            const lines: string[] = [];
            if (partial && message.role === "assistant") {
              this.renderAssistantContent(message, key, true, width, options, lines);
            } else {
              this.renderMessage(message, width, options, lines);
            }
            return lines;
          },
        };
        this.messageRows.set(message, row);
      }
      rows.push(row);
      if (message.role === "assistant") {
        const error = message.stopReason === "error" || message.stopReason === "aborted"
          ? message.errorMessage || "Error" : undefined;
        for (const call of message.content) {
          if (call.type === "toolCall") addTool(call.id, call.name, call.arguments, error);
        }
      }
    };
    for (const message of transcript.messages) addMessage(message);
    if (transcript.streaming.partialAssistant) addMessage(transcript.streaming.partialAssistant, true);
    for (const tool of transcript.streaming.tools) addTool(tool.toolCallId, tool.toolName, tool.args);
    // Retain the loaded window, not an undersized FIFO that thrashes on each scan.
    for (const message of this.messageRows.keys()) if (!messages.has(message)) this.messageRows.delete(message);
    for (const cache of [this.messageComponents, this.assistantComponents]) {
      for (const key of cache.keys()) if (!keys.has(key)) cache.delete(key);
    }
    for (const key of this.toolComponents.keys()) {
      const id = key.slice(this.currentTargetId.length + 1);
      if (!tools.has(id)) this.releaseTool(key);
    }
    this.rows = rows;
    this.lastMessages = transcript.messages.slice();
    this.lastTools = transcript.streaming.tools.slice();
    this.lastPartial = transcript.streaming.partialAssistant;
    this.planDirty = false;
    this.frameLines = undefined;
  }

  private messageKey(message: NativeAgentMessage): string {
    let id = this.messageIds.get(message);
    if (id === undefined) { id = ++this.nextMessageId; this.messageIds.set(message, id); }
    return `${this.currentTargetId}\u0000${id}`;
  }

  private markdownTheme(options: FabricConversationTranscriptRenderOptions): MarkdownTheme {
    const key = options.codeBlockIndent ?? "";
    let markdownTheme = this.markdownThemeCache.get(key);
    if (!markdownTheme) {
      markdownTheme = {
        ...(options.codeBlockIndent !== undefined ? { codeBlockIndent: options.codeBlockIndent } : {}),
        heading: (text) => this.theme.fg("mdHeading", text),
        link: (text) => this.theme.fg("mdLink", text),
        linkUrl: (text) => this.theme.fg("mdLinkUrl", text),
        code: (text) => this.theme.fg("mdCode", text),
        codeBlock: (text) => this.theme.fg("mdCodeBlock", text),
        codeBlockBorder: (text) => this.theme.fg("mdCodeBlockBorder", text),
        quote: (text) => this.theme.fg("mdQuote", text),
        quoteBorder: (text) => this.theme.fg("mdQuoteBorder", text),
        hr: (text) => this.theme.fg("mdHr", text),
        listBullet: (text) => this.theme.fg("mdListBullet", text),
        bold: (text) => this.theme.bold(text),
        italic: (text) => this.theme.italic(text),
        underline: (text) => this.theme.underline(text),
        strikethrough: (text) => this.theme.strikethrough(text),
        highlightCode: (code, lang) =>
          highlightCode(code, lang ?? "", this.highlightInvalidate) ??
          code.split("\n").map((line) => this.theme.fg("mdCodeBlock", line)),
      };
      this.markdownThemeCache.set(key, markdownTheme);
    }
    return markdownTheme;
  }

  private renderMessage(
    message: NativeAgentMessage,
    width: number,
    options: FabricConversationTranscriptRenderOptions,
    lines: string[],
  ): void {
    switch (message.role) {
      case "user":
        this.renderUserMessage(message, width, options, lines);
        return;
      case "assistant":
        this.renderAssistantContent(message, this.messageKey(message), false, width, options, lines);
        return;
      case "toolResult":
        return;
      case "bashExecution":
        this.pushSpacer(lines);
        this.renderBashExecution(message, width, options, lines);
        return;
      case "custom":
        if (!message.display) {
          if (message.customType !== "pi-fabric-agent-message" && message.customType !== "pi-fabric-actor") return;
          const feedback = conversationFeedback({ ...message, content: customText(message) });
          if (feedback !== undefined) lines.push(...new Text(this.theme.fg("dim", feedback), 1, 0).render(width));
          return;
        }
        this.pushSpacer(lines);
        this.renderCustomMessage(message, width, options, lines);
        return;
      case "compactionSummary":
        this.pushSpacer(lines);
        this.renderBoxedMessage(this.messageKey(message), message, getConversationHost().CompactionSummaryMessageComponent, width, options, lines);
        return;
      case "branchSummary":
        this.pushSpacer(lines);
        this.renderBoxedMessage(this.messageKey(message), message, getConversationHost().BranchSummaryMessageComponent, width, options, lines);
        return;
      default:
        return;
    }
  }

  private renderUserMessage(
    message: UserAgentMessage,
    width: number,
    options: FabricConversationTranscriptRenderOptions,
    lines: string[],
  ): void {
    const text = userMessageText(message);
    if (!text) return;
    this.pushSpacer(lines);
    const skillBlock = getConversationHost().parseSkillBlock(text);
    if (skillBlock) {
      const record = this.messageRecord(this.messageKey(message), () =>
        new (getConversationHost().SkillInvocationMessageComponent)(skillBlock, this.markdownTheme(options)));
      record.component.setExpanded(options.toolsExpanded);
      lines.push(...safeRender(record.component, width, () => this.plainTextFallback(text, width)));
      if (skillBlock.userMessage) {
        this.pushSpacer(lines);
        lines.push(...this.userComponentLines(skillBlock.userMessage, width, options));
      }
      return;
    }
    lines.push(...this.userComponentLines(text, width, options));
  }

  private userComponentLines(
    text: string,
    width: number,
    options: FabricConversationTranscriptRenderOptions,
  ): string[] {
    const component = new (getConversationHost().UserMessageComponent)(
      terminalSafe(text, false),
      this.markdownTheme(options),
      options.outputPad ?? 1,
      this.rendererOptions.markdownTransformers,
    );
    return safeRender(component, width, () => this.plainTextFallback(text, width));
  }

  private renderAssistantContent(
    message: Extract<NativeAgentMessage, { role: "assistant" }>,
    key: string,
    streaming: boolean,
    width: number,
    options: FabricConversationTranscriptRenderOptions,
    lines: string[],
  ): void {
    const record = this.assistantRecord(key, options);
    if (record.message !== message || record.streaming !== streaming) {
      record.component.updateContent(message, streaming);
      record.message = message;
      record.streaming = streaming;
    }
    lines.push(...safeRender(record.component, width, () => this.plainTextFallback(assistantText(message), width)));
  }

  private reconcileTool(
    id: string,
    name: string,
    callArgs: Record<string, unknown> | undefined,
    result: ToolResultAgentMessage | undefined,
    tool: NativeToolExecution | undefined,
    error: string | undefined,
    options: FabricConversationTranscriptRenderOptions,
  ): RenderedRow {
    const key = `${this.currentTargetId}\u0000${id}`;
    const args = tool?.args ?? callArgs;
    const value = result ?? tool?.result ?? tool?.partial;
    const isPartial = !result && !tool?.result && !error;
    const isError = result?.isError ?? tool?.isError ?? !!error;
    const started = tool ? tool.executionStarted ?? true : false;
    const argsComplete = !!result || !!tool?.result || !!tool?.argsComplete;
    let record = this.toolComponents.get(key);
    // Native converted-image caches are indexed by position, not image identity.
    const images = record?.result === value ? undefined : value?.content?.filter(
      (block): block is NativeToolResultContent => !!block && typeof block === "object" &&
        (block as NativeToolResultContent).type === "image",
    );
    const imageKey = record && record.result === value ? record.imageKey : stableKey(images?.length ? images : undefined);
    if (record && (record.name !== name || record.imageKey !== imageKey ||
      (!record.isPartial && isPartial) || (record.argsComplete && !argsComplete) ||
      (record.started && !started && !result))) {
      this.releaseTool(key);
      record = undefined;
    }
    let row = this.toolRows.get(key);
    if (!record) {
      const token = {};
      this.toolTokens.set(key, token);
      const definition = this.definitionFor(name, key, token);
      // Pi's live TUI proxy forwards inherited assignments to the real host.
      // Define an own callback so delegation cannot overwrite requestRender.
      const ui = Object.create(this.tui, {
        requestRender: {
          configurable: true, enumerable: true, writable: true,
          value: (): void => {
            if (this.disposed || this.toolTokens.get(key) !== token) return;
            const current = this.toolRows.get(key);
            if (current) current.lines = undefined;
            this.frameLines = undefined;
            this.tui.requestRender();
          },
        },
      }) as TUI;
      const component = new (getConversationHost().ToolExecutionComponent)(name, id, args,
        { showImages: options.showImages ?? true, imageWidthCells: this.imageWidthCells() },
        definition, ui, options.target.cwd ?? process.cwd());
      if (options.toolsExpanded) component.setExpanded(true);
      record = { component, name, dynamicRenderer: !!definition?.renderCall || !!definition?.renderResult, started: false, argsComplete: false, args, argsKey: "0",
        result: undefined, resultKey: undefined, partialKey: undefined, imageKey,
        isPartial: true, isError: false, error: undefined };
      this.toolComponents.set(key, record);
      row = {
        spacer: false,
        dynamic: !!definition?.renderCall || !!definition?.renderResult || isPartial || imageKey !== "undefined",
        render: (width) => safeRender(component, width, () => this.plainTextFallback(name, width)),
      };
      this.toolRows.set(key, row);
    }
    const { component } = record;
    let changed = false;
    if (record.args !== args) {
      component.updateArgs(args);
      changed = true;
      record.args = args;
      record.argsKey = String(Number(record.argsKey) + 1);
    }
    if (started && !record.started) {
      record.started = true;
      component.markExecutionStarted();
      changed = true;
    }
    if (argsComplete && !record.argsComplete) {
      record.argsComplete = true;
      component.setArgsComplete();
      changed = true;
    }
    if (record.result !== value || record.isPartial !== isPartial || record.isError !== isError || record.error !== error) {
      // Details can contain opaque extension state; serialization is not an equality test.
      const resultKey = String(Number(record.resultKey ?? 0) + 1);
      if (value !== undefined || error !== undefined) {
        component.updateResult({
          content: error && !value ? [{ type: "text", text: error }] : (value?.content ?? []) as NativeToolResultContent[],
          ...(value?.details !== undefined ? { details: value.details } : {}),
          isError,
        }, isPartial);
        changed = true;
      }
      record.result = value;
      record.resultKey = resultKey;
      record.partialKey = isPartial ? resultKey : undefined;
      record.isPartial = isPartial;
      record.isError = isError;
      record.error = error;
    }
    row!.dynamic = record.dynamicRenderer || isPartial || imageKey !== "undefined";
    if (changed) row!.lines = undefined;
    return row!;
  }

  private releaseTool(key: string): void {
    this.toolTokens.delete(key);
    this.releaseRendererStates(key);
    this.toolComponents.delete(key);
    this.toolRows.delete(key);
  }

  private renderBashExecution(
    message: BashExecutionAgentMessage,
    width: number,
    options: FabricConversationTranscriptRenderOptions,
    lines: string[],
  ): void {
    const key = this.messageKey(message);
    const record = this.messageRecord(key, () => {
      const component = new (getConversationHost().BashExecutionComponent)(message.command, this.tui, message.excludeFromContext);
      component.appendOutput(terminalSafe(message.output ?? "", false));
      // Mirrors interactive-mode: only the truncated flag is known at this point.
      const truncation = message.truncated ? ({ truncated: true } as TruncationResult) : undefined;
      component.setComplete(message.exitCode, message.cancelled, truncation, message.fullOutputPath);
      return component;
    });
    record.component.setExpanded(options.toolsExpanded);
    lines.push(...safeRender(record.component, width, () => this.plainTextFallback(message.command, width)));
  }

  private renderCustomMessage(
    message: CustomAgentMessage,
    width: number,
    options: FabricConversationTranscriptRenderOptions,
    lines: string[],
  ): void {
    const record = this.messageRecord(this.messageKey(message), () =>
      new (getConversationHost().CustomMessageComponent)(
        message,
        this.rendererOptions.getMessageRenderer?.(message.customType),
        this.markdownTheme(options),
        options.outputPad ?? 1,
      ));
    record.component.setExpanded(options.toolsExpanded);
    lines.push(...safeRender(record.component, width, () => this.plainTextFallback(customText(message), width)));
  }

  private renderBoxedMessage<M extends CompactionSummaryAgentMessage | BranchSummaryAgentMessage>(
    key: string,
    message: M,
    create: new (message: M, markdownTheme?: MarkdownTheme) => MessageCacheRecord["component"],
    width: number,
    options: FabricConversationTranscriptRenderOptions,
    lines: string[],
  ): void {
    const record = this.messageRecord(key, () => new create(message, this.markdownTheme(options)));
    record.component.setExpanded(options.toolsExpanded);
    lines.push(...safeRender(record.component, width, () => this.plainTextFallback(message.summary, width)));
  }

  /**
   * Registered definition with wrapped renderer callbacks: the render context
   * invalidate becomes a no-op once disposed, so a live spinner/timing timer
   * firing after dispose cannot touch the TUI. ToolExecutionComponent has no
   * dispose; this finalizes its renderer subscriptions instead.
   */
  private definitionFor(toolName: string, key: string, token: object): FabricToolDefinitionLike {
    const definition = this.rendererOptions.getToolDefinition?.(toolName);
    if (!definition) return definition;
    const live = (): boolean => !this.disposed && this.toolTokens.get(key) === token;
    const guard = <T extends { invalidate: () => void; state: Record<string, unknown> }>(context: T): T => {
      const states = this.rendererStates.get(key) ?? new Set<Record<string, unknown>>();
      states.add(context.state);
      this.rendererStates.set(key, states);
      this.liveStates.add(context.state);
      return {
        ...context,
        invalidate: (): void => {
          if (!live() || !this.liveStates.has(context.state)) return;
          context.invalidate();
        },
      };
    };
    // An old native image conversion can call updateDisplay after eviction.
    const empty = { render: () => [], invalidate: () => {} };
    return {
      ...definition,
      ...(definition.renderCall
        ? { renderCall: (args: any, theme: Theme, context: any) =>
          live() ? definition.renderCall!(args, theme, guard(context)) : empty }
        : {}),
      ...(definition.renderResult
        ? { renderResult: (result: any, options: any, theme: Theme, context: any) =>
          live() ? definition.renderResult!(result, options, theme, guard(context)) : empty }
        : {}),
    };
  }

  private assistantRecord(
    key: string,
    options: FabricConversationTranscriptRenderOptions,
  ): AssistantCacheRecord {
    const cacheKey = key;
    const hideThinking = options.hideThinking ?? false;
    let record = this.assistantComponents.get(cacheKey);
    if (!record || record.hideThinking !== hideThinking) {
      record = {
        hideThinking,
        component: new (getConversationHost().AssistantMessageComponent)(
          undefined,
          hideThinking,
          this.markdownTheme(options),
          this.rendererOptions.hiddenThinkingLabel,
          options.outputPad ?? 1,
          this.rendererOptions.markdownTransformers,
        ),
      };
      this.assistantComponents.set(cacheKey, record);
    }
    return record;
  }

  private messageRecord(
    key: string,
    create: () => MessageCacheRecord["component"],
  ): MessageCacheRecord {
    const cacheKey = key;
    let record = this.messageComponents.get(cacheKey);
    if (!record) {
      record = { component: create() };
      this.messageComponents.set(cacheKey, record);
    }
    return record;
  }

  private releaseRendererStates(key: string): void {
    for (const state of this.rendererStates.get(key) ?? []) {
      this.liveStates.delete(state);
      if (state.codePreviewTimingInterval) {
        clearInterval(state.codePreviewTimingInterval as ReturnType<typeof setInterval>);
        delete state.codePreviewTimingInterval;
      }
      const spinner = state.fabricSpinner as { timer?: ReturnType<typeof setTimeout> } | undefined;
      if (spinner?.timer) { clearTimeout(spinner.timer); delete spinner.timer; }
    }
    this.rendererStates.delete(key);
  }

  private imageWidthCells(): number {
    return Math.max(1, Math.floor(this.rendererOptions.imageWidthCells ?? DEFAULT_IMAGE_WIDTH_CELLS));
  }

  private plainTextFallback(text: string, width: number): string[] {
    const safe = terminalSafe(text, false);
    return safe.split("\n").flatMap((paragraph) =>
      wrapTextWithAnsi(paragraph, Math.max(1, width)).map((line) => this.theme.fg("text", line)),
    );
  }

  private pushSpacer(lines: string[]): void {
    if (lines.length > 0) lines.push("");
  }
}

// Snapshot shallow fields on projection changes, including optional producer-side
// content versions. Immutable nested payloads never need hashing on warm frames.
const shallowInput = (value: object): unknown[] => [...Object.keys(value), ...Object.values(value)];

const sameItems = <T>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index]);

const userMessageText = (message: UserAgentMessage): string => {
  const blocks = typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content.filter((block): block is { type: "text"; text: string } => block.type === "text");
  const text = blocks.map((block) => block.text).join("");
  return unwrapActorEnvelopeText(text) ?? text;
};

const assistantText = (message: { content: unknown }): string =>
  Array.isArray(message.content)
    ? message.content
      .filter((block): block is { type: "text"; text: string } =>
        typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text")
      .map((block) => block.text)
      .join("\n")
    : "";

const customText = (message: CustomAgentMessage): string =>
  typeof message.content === "string"
    ? message.content
    : message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");

const safeRender = (
  component: { render(width: number): string[] },
  width: number,
  fallback: () => string[],
): string[] => {
  try {
    // Native rows are preserved verbatim: components already wrap and pad to
    // width, so re-truncating would clip the trailing background cell.
    return component.render(width);
  } catch {
    return fallback();
  }
};
