import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
  Markdown,
  wrapTextWithAnsi,
  type MarkdownTheme,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { truncateStyledText as truncateToWidth } from "./truncate.js";
import type { FabricActivityCall } from "../activity/types.js";
import { formatFabricEffectConflict } from "../core/effect-conflict.js";
import type { CodePreviewSettings } from "./code-preview.js";
import { coreToolTitle, renderCoreToolBody } from "./core-tool-render.js";
import type { Entity } from "./dashboard-model.js";
import { colorStatus, statusGlyph } from "./dashboard-presentation.js";
import { nestedEditDiff, renderBoundedLines } from "./fabric-render.js";
import {
  formatActorDataPreview,
  formatClock,
  formatDuration,
  formatTokens,
  padToWidth,
  safeText,
  wrapPlainText,
} from "./format.js";
import { highlightCode } from "./highlight.js";
import { formatJsonAsYaml } from "./structured.js";
import { loadStateFilePreview, renderStateFilePreview } from "./state-file-preview.js";
import type { FabricAgentTranscript, FabricTranscriptEntry } from "./transcript.js";
import type { FabricDashboardSnapshot, FabricUiActor, FabricUiAgent } from "./types.js";
import { isActiveStatus } from "./types.js";

const transcriptMarkdownTheme = (theme: Theme, invalidate: () => void): MarkdownTheme => ({
  heading: (text) => theme.fg("mdHeading", text),
  link: (text) => theme.fg("mdLink", text),
  linkUrl: (text) => theme.fg("mdLinkUrl", text),
  code: (text) => theme.fg("mdCode", text),
  codeBlock: (text) => theme.fg("mdCodeBlock", text),
  codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
  quote: (text) => theme.fg("mdQuote", text),
  quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
  hr: (text) => theme.fg("mdHr", text),
  listBullet: (text) => theme.fg("mdListBullet", text),
  bold: (text) => theme.bold(text),
  italic: (text) => theme.italic(text),
  underline: (text) => theme.underline(text),
  strikethrough: (text) => theme.strikethrough(text),
  highlightCode: (code, lang) =>
    highlightCode(code, lang ?? "", invalidate) ??
    code.split("\n").map((line) => theme.fg("mdCodeBlock", line)),
});

const TRANSCRIPT_EXPANDED_TOOL_LINES = 40;
const TRANSCRIPT_STRUCTURED_LINES = 40;

const safeMarkdownText = (value: string): string =>
  value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f-\u009f]/g, " ");

export type FabricTranscriptTarget = FabricUiAgent | FabricUiActor;

export interface DashboardDetailRenderState {
  view: "summary" | "transcript";
  scroll: number;
  pageAnchor: "start" | "end" | undefined;
  transcriptFollowing: boolean;
  transcriptToolsExpanded: boolean;
}

export interface DashboardDetailRenderResult {
  lines: string[];
  scroll: number;
  maxScroll: number;
  pageAnchor: "start" | "end" | undefined;
}

interface DashboardDetailRendererOptions {
  agentTranscript:
    | ((agent: FabricUiAgent, followLatest: boolean) => FabricAgentTranscript)
    | undefined;
  actorTranscript:
    | ((actor: FabricUiActor, followLatest: boolean) => FabricAgentTranscript)
    | undefined;
  codePreviewSettings: CodePreviewSettings | undefined;
  actorDefaultTools: string[];
}

export class DashboardDetailRenderer {
  private detailView: "summary" | "transcript" = "summary";
  private detailScroll = 0;
  private detailMaxScroll = 0;
  private transcriptPageAnchor: "start" | "end" | undefined;
  private transcriptFollowing = true;
  private transcriptToolsExpanded = false;
  private actionHint = "";
  private toolToggleHint = "";
  private readonly transcriptMarkdown = new Map<string, { text: string; component: Markdown }>();
  private readonly highlightInvalidate = (): void => this.tui.requestRender();
  private readonly agentTranscript:
    | ((agent: FabricUiAgent, followLatest: boolean) => FabricAgentTranscript)
    | undefined;
  private readonly actorTranscript:
    | ((actor: FabricUiActor, followLatest: boolean) => FabricAgentTranscript)
    | undefined;
  private readonly codePreviewSettings: CodePreviewSettings | undefined;
  private readonly actorDefaultTools: string[];

  constructor(
    readonly tui: TUI,
    readonly theme: Theme,
    readonly snapshot: () => FabricDashboardSnapshot,
    options: DashboardDetailRendererOptions,
  ) {
    this.agentTranscript = options.agentTranscript;
    this.actorTranscript = options.actorTranscript;
    this.codePreviewSettings = options.codePreviewSettings;
    this.actorDefaultTools = options.actorDefaultTools;
  }

  render(
    width: number,
    snapshot: FabricDashboardSnapshot,
    entity: Entity,
    state: DashboardDetailRenderState,
    actionHint: string,
    toolToggleHint: string,
  ): DashboardDetailRenderResult {
    this.detailView = state.view;
    this.detailScroll = state.scroll;
    this.transcriptPageAnchor = state.pageAnchor;
    this.transcriptFollowing = state.transcriptFollowing;
    this.transcriptToolsExpanded = state.transcriptToolsExpanded;
    this.actionHint = actionHint;
    this.toolToggleHint = toolToggleHint;
    const lines = this.renderDetail(width, snapshot, entity);
    return {
      lines,
      scroll: this.detailScroll,
      maxScroll: this.detailMaxScroll,
      pageAnchor: this.transcriptPageAnchor,
    };
  }

  invalidate(): void {
    this.transcriptMarkdown.clear();
  }

  private detailActionHint(_entity: Entity): string {
    return this.actionHint;
  }

  private transcriptToolToggleHint(): string {
    return this.toolToggleHint;
  }

  private transcriptTarget(entity: Entity): FabricTranscriptTarget | undefined {
    if (entity.kind === "agent" || entity.kind === "actor") return entity.value;
    return undefined;
  }

  private hasTranscript(entity: Entity): boolean {
    return (
      (entity.kind === "agent" && this.agentTranscript !== undefined) ||
      (entity.kind === "actor" && this.actorTranscript !== undefined)
    );
  }

  private transcriptFor(entity: Entity): FabricAgentTranscript | undefined {
    if (entity.kind === "agent") {
      return this.agentTranscript?.(entity.value, this.transcriptFollowing);
    }
    if (entity.kind === "actor") {
      return this.actorTranscript?.(entity.value, this.transcriptFollowing);
    }
    return undefined;
  }

  private renderDetail(
    width: number,
    snapshot: FabricDashboardSnapshot,
    entity: Entity,
  ): string[] {
    if (width < 24) return this.renderNarrowDetail(width, snapshot, entity);
    const innerWidth = width - 2;
    const transcriptView =
      (entity.kind === "agent" || entity.kind === "actor") && this.detailView === "transcript";
    const actionLines = wrapPlainText(this.detailActionHint(entity), Math.max(1, innerWidth - 2), 3);
    const viewLabel = transcriptView
      ? ` · transcript · ${isActiveStatus(entity.status) ? "live" : entity.status}`
      : "";
    const kindLabel =
      entity.kind === "main"
        ? "main agent"
        : entity.kind === "peer"
          ? "peer session"
          : entity.kind === "meshParticipant"
            ? "project participant"
            : entity.kind === "meshTopic"
              ? "topic"
              : entity.kind === "meshRoute"
                ? "route"
                : entity.kind;
    const lines = [this.topBorder(width, `${kindLabel} · ${entity.label}${viewLabel}`)];
    const content = transcriptView
      ? this.transcriptLines(entity, innerWidth)
      : this.detailLines(entity, innerWidth, snapshot.now, snapshot.main.cwd ?? process.cwd());
    const terminalRows = this.tui.terminal?.rows ?? process.stdout.rows ?? 28;
    const maxBody = Math.max(1, Math.min(24, terminalRows - 8 - actionLines.length));
    const maxScroll = Math.max(0, content.length - maxBody);
    this.detailMaxScroll = maxScroll;
    if (transcriptView && this.transcriptFollowing) {
      this.detailScroll = maxScroll;
    } else if (transcriptView && this.transcriptPageAnchor) {
      this.detailScroll = this.transcriptPageAnchor === "end" ? maxScroll : 0;
      this.transcriptPageAnchor = undefined;
    } else {
      this.detailScroll = Math.max(0, Math.min(this.detailScroll, maxScroll));
    }
    const visible = content.slice(this.detailScroll, this.detailScroll + maxBody);
    for (const line of visible) lines.push(this.row(width, line));
    while (lines.length < maxBody + 1) lines.push(this.row(width, ""));
    lines.push(this.middleBorder(width));
    const range =
      content.length > maxBody
        ? ` · ${this.detailScroll + 1}-${Math.min(content.length, this.detailScroll + maxBody)}/${content.length}`
        : "";
    const navigation = transcriptView
      ? `↑↓/jk lazy scroll · ${this.transcriptToolToggleHint()} · g page top · G follow:${this.transcriptFollowing ? "on" : "off"}/live tail · t summary · esc back${range}`
      : `↑↓/jk scroll · ${this.hasTranscript(entity) ? "t transcript · " : ""}esc back${range}`;
    lines.push(this.row(width, this.theme.fg("dim", navigation)));
    for (const actionLine of actionLines) {
      lines.push(this.row(width, this.theme.fg("muted", `  ${actionLine}`)));
    }
    lines.push(this.bottomBorder(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private transcriptLines(entity: Entity, width: number): string[] {
    const transcript = this.transcriptFor(entity);
    const transcriptCwd =
      entity.kind === "agent"
        ? entity.value.cwd
        : entity.kind === "actor"
          ? entity.value.worker?.cwd
          : undefined;
    // Reasoning is a widget-pane view; the dashboard transcript keeps replies, tools, and errors.
    const entries = transcript?.entries.filter((entry) => entry.kind !== "thinking") ?? [];
    if (!transcript || entries.length === 0) {
      return [
        this.theme.fg(
          "dim",
          isActiveStatus(entity.status)
            ? "Waiting for streamed agent activity…"
            : "No retained transcript is available for this agent or actor.",
        ),
      ];
    }
    const lines: string[] = [];
    if (transcript.hasMore ?? transcript.truncated) {
      lines.push(this.theme.fg("dim", "↑ older activity available · scroll past the top to load"));
    }
    let firstTool = true;
    for (const entry of entries) {
      if (entry.kind === "tool") {
        if (this.transcriptToolsExpanded && !firstTool) lines.push("");
        firstTool = false;
        lines.push(...this.transcriptToolLines(entry, width, transcriptCwd));
        continue;
      }
      const glyph =
        entry.kind === "assistant"
          ? this.theme.fg("accent", "◆")
          : entry.kind === "user"
            ? this.theme.fg("muted", "›")
            : entry.kind === "error"
              ? this.theme.fg("error", "✗")
              : colorStatus(
                  this.theme,
                  entry.status ?? "completed",
                  statusGlyph(entry.status ?? "completed"),
                );
      lines.push(
        truncateToWidth(
          `${glyph} ${this.theme.fg(
            entry.kind === "assistant" ? "accent" : "muted",
            safeText(entry.label),
          )}`,
          width,
          "",
        ),
      );
      if (!entry.text) continue;
      if (entry.kind === "assistant" || entry.kind === "user") {
        lines.push(
          ...this.markdownTranscriptLines(
            this.transcriptTarget(entity)?.id ?? entity.id,
            entry.id,
            entry.text,
            width,
          ),
        );
        continue;
      }
      for (const paragraph of entry.text.split("\n")) {
        const wrapped = wrapPlainText(paragraph, Math.max(1, width - 2), 10_000);
        for (const line of wrapped) lines.push(truncateToWidth(`  ${line}`, width, ""));
      }
    }
    if (transcript.hasNewer) {
      lines.push(this.theme.fg("dim", "↓ newer activity available · scroll past the bottom to load"));
    }
    return lines;
  }

  private transcriptToolLines(
    entry: FabricTranscriptEntry,
    width: number,
    transcriptCwd?: string,
  ): string[] {
    const depth = Math.max(0, entry.depth ?? 0);
    const padding = "  ".repeat(depth);
    const bodyPadding = `${padding}  `;
    const glyph = colorStatus(
      this.theme,
      entry.status ?? "completed",
      statusGlyph(entry.status ?? "completed"),
    );
    const status =
      entry.status === "running" ? " · running" : entry.status === "failed" ? " · failed" : "";
    const audit = this.transcriptToolAudit(entry);
    const context = this.codePreviewSettings
      ? {
          cwd: transcriptCwd ?? this.snapshot().main.cwd ?? process.cwd(),
          settings: this.codePreviewSettings,
          invalidate: this.highlightInvalidate,
        }
      : undefined;
    const title = context ? coreToolTitle(audit, this.theme, context) : null;
    const headline = title ?? this.theme.fg("toolTitle", this.theme.bold(entry.toolName ?? entry.label));
    const collapsedSummary =
      !this.transcriptToolsExpanded && entry.text
        ? ` · ${safeText(entry.text).replace(/\s+/g, " ").trim()}`
        : "";
    const lines = [
      truncateToWidth(
        `${padding}${glyph} ${headline}${this.theme.fg("dim", `${status}${collapsedSummary}`)}`,
        width,
        "",
      ),
    ];
    if (!this.transcriptToolsExpanded) return lines;

    const rendered = context
      ? renderCoreToolBody(audit, this.theme, {
          ...context,
          expanded: true,
          maxLines: TRANSCRIPT_EXPANDED_TOOL_LINES,
        })
      : null;
    if (rendered) {
      for (const row of renderBoundedLines(
        rendered.lines,
        this.theme,
        this.codePreviewSettings?.diffIntensity ?? "off",
      ).render(Math.max(1, width - visibleWidth(bodyPadding)))) {
        lines.push(truncateToWidth(`${bodyPadding}${row}`, width, ""));
      }
      if (rendered.hidden > 0) {
        lines.push(this.theme.fg("dim", `${bodyPadding}… ${rendered.hidden} more lines`));
      }
      return lines;
    }
    if (entry.args && Object.keys(entry.args).length > 0) {
      lines.push(...this.transcriptStructuredLines("input", entry.args, width, bodyPadding));
    } else if (entry.text) {
      for (const row of wrapPlainText(
        entry.text,
        Math.max(1, width - visibleWidth(bodyPadding)),
        10_000,
      )) {
        lines.push(truncateToWidth(`${bodyPadding}${row}`, width, ""));
      }
    }
    if (entry.result !== undefined) {
      lines.push(...this.transcriptStructuredLines("result", entry.result, width, bodyPadding));
    }
    return lines;
  }

  private transcriptToolAudit(entry: FabricTranscriptEntry): {
    ref: string;
    provider: string;
    tool: string;
    args?: Record<string, unknown>;
    result?: unknown;
    success?: boolean;
  } {
    const rawName = entry.toolName ?? entry.label;
    const normalizedName = rawName.toLowerCase();
    const tool =
      normalizedName === "glob"
        ? "find"
        : ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"].includes(normalizedName)
          ? normalizedName
          : rawName;
    const rawArgs = entry.args ?? {};
    const args: Record<string, unknown> = { ...rawArgs };
    if (typeof rawArgs.file_path === "string" && typeof args.path !== "string") {
      args.path = rawArgs.file_path;
    }
    if (tool === "edit" && !Array.isArray(args.edits)) {
      const oldText = typeof rawArgs.old_string === "string" ? rawArgs.old_string : undefined;
      const newText = typeof rawArgs.new_string === "string" ? rawArgs.new_string : undefined;
      if (oldText !== undefined && newText !== undefined) args.edits = [{ oldText, newText }];
    }
    return {
      ref: typeof tool === "string" ? `pi.${tool}` : `tool.${rawName}`,
      provider: "pi",
      tool,
      ...(Object.keys(args).length > 0 ? { args } : {}),
      ...(entry.result !== undefined ? { result: entry.result } : {}),
      ...(entry.status !== "running" ? { success: entry.status !== "failed" } : {}),
    };
  }

  private transcriptStructuredLines(
    label: string,
    value: unknown,
    width: number,
    padding: string,
  ): string[] {
    const yaml = formatJsonAsYaml(value) ?? safeText(value);
    if (!yaml) return [];
    const yamlLines = yaml.split("\n");
    const shownYamlLines = yamlLines.slice(0, TRANSCRIPT_STRUCTURED_LINES);
    const highlighted =
      highlightCode(shownYamlLines.join("\n"), "yaml", this.highlightInvalidate) ??
      shownYamlLines.map((line) => this.theme.fg("mdCodeBlock", line || " "));
    const lines = [truncateToWidth(`${padding}${this.theme.fg("dim", `${label}:`)}`, width, "")];
    const nestedPadding = `${padding}  `;
    for (const row of highlighted) {
      for (const wrapped of wrapTextWithAnsi(row, Math.max(1, width - visibleWidth(nestedPadding)))) {
        lines.push(truncateToWidth(`${nestedPadding}${wrapped}`, width, ""));
        if (lines.length > TRANSCRIPT_STRUCTURED_LINES) break;
      }
      if (lines.length > TRANSCRIPT_STRUCTURED_LINES) break;
    }
    const hiddenLines = Math.max(0, yamlLines.length - shownYamlLines.length);
    if (hiddenLines > 0) {
      lines.push(this.theme.fg("dim", `${nestedPadding}… ${hiddenLines} more lines`));
    }
    return lines;
  }

  private markdownTranscriptLines(
    agentId: string,
    entryId: string,
    text: string,
    width: number,
  ): string[] {
    return this.markdownLines(`transcript:${agentId}:${entryId}`, text, width);
  }

  private markdownLines(key: string, text: string, width: number, indent = 2): string[] {
    const markdown = safeMarkdownText(text);
    if (!markdown.trim()) return [];
    let cached = this.transcriptMarkdown.get(key);
    if (!cached || cached.text !== markdown) {
      cached = {
        text: markdown,
        component: new Markdown(
          markdown,
          0,
          0,
          transcriptMarkdownTheme(this.theme, () => {
            this.transcriptMarkdown.delete(key);
            this.tui.requestRender();
          }),
        ),
      };
      this.transcriptMarkdown.delete(key);
      this.transcriptMarkdown.set(key, cached);
      while (this.transcriptMarkdown.size > 128) {
        const oldest = this.transcriptMarkdown.keys().next().value as string | undefined;
        if (!oldest) break;
        this.transcriptMarkdown.delete(oldest);
      }
    }
    const padding = " ".repeat(Math.max(0, indent));
    return cached.component
      .render(Math.max(1, width - visibleWidth(padding)))
      .map((line) => truncateToWidth(`${padding}${line}`, width, ""));
  }

  private detailLines(entity: Entity, width: number, now: number, cwd: string): string[] {
    const lines: string[] = [];
    const field = (label: string, value: unknown): void => {
      const text = safeText(value);
      if (!text) return;
      const prefix = `${this.theme.fg("dim", `${label}:`)} `;
      const wrapped = wrapPlainText(text, Math.max(1, width - visibleWidth(prefix)), 12);
      if (wrapped[0]) lines.push(truncateToWidth(prefix + wrapped[0], width));
      for (const continuation of wrapped.slice(1)) {
        lines.push(truncateToWidth(" ".repeat(visibleWidth(prefix)) + continuation, width));
      }
    };
    const markdownField = (label: string, value: string | undefined, key: string): void => {
      if (!value?.trim()) return;
      lines.push(this.theme.fg("dim", `${label}:`));
      lines.push(...this.markdownLines(`detail:${entity.id}:${key}`, value, width));
    };
    const structuredField = (label: string, value: unknown): void => {
      if (value === undefined) return;
      const yaml = formatJsonAsYaml(value);
      if (yaml === undefined) {
        field(label, value);
        return;
      }
      lines.push(this.theme.fg("dim", `${label}:`));
      const highlighted =
        highlightCode(yaml, "yaml", this.highlightInvalidate) ??
        yaml.split("\n").map((line) => this.theme.fg("mdCodeBlock", line || " "));
      for (const highlightedLine of highlighted) {
        for (const wrapped of wrapTextWithAnsi(highlightedLine, Math.max(1, width - 2))) {
          lines.push(truncateToWidth(`  ${wrapped}`, width, ""));
        }
      }
    };
    const stringOutputField = (label: string, value: unknown): void => {
      if (typeof value !== "string") return;
      markdownField(label, value, label.toLowerCase());
    };
    const objectOutputField = (label: string, value: Record<string, unknown>): void => {
      if (typeof value.output === "string" || typeof value.text === "string" || typeof value.content === "string") {
        stringOutputField(label, value.output ?? value.text ?? value.content);
        return;
      }
      structuredField(label, value);
    };
    const outputField = (label: string, value: unknown): void => {
      if (value === undefined) return;
      if (typeof value === "string") {
        stringOutputField(label, value);
        return;
      }
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        objectOutputField(label, value as Record<string, unknown>);
        return;
      }
      structuredField(label, value);
    };
    const coreCallPreview = (call: FabricActivityCall): boolean => {
      const settings = this.codePreviewSettings;
      const tool = call.ref.startsWith("pi.") ? call.ref.slice(3) : "";
      if (!settings || !["bash", "powershell", "read", "write", "edit", "grep", "find", "ls"].includes(tool)) {
        return false;
      }
      const success = call.status === "completed"
        ? true
        : call.status === "failed"
          ? false
          : undefined;
      const audit = {
        ref: call.ref,
        provider: "pi",
        tool,
        ...(call.args !== undefined ? { args: call.args } : {}),
        ...(call.result !== undefined ? { result: call.result } : {}),
        ...(call.preview !== undefined ? { preview: call.preview } : {}),
        ...(success !== undefined ? { success } : {}),
        startedAt: call.startedAt,
        ...(call.finishedAt !== undefined ? { endedAt: call.finishedAt } : {}),
      };
      const context = {
        cwd: this.snapshot().main.cwd ?? process.cwd(),
        settings,
        invalidate: this.highlightInvalidate,
      };
      const title = coreToolTitle(audit, this.theme, context);
      const rendered = renderCoreToolBody(audit, this.theme, {
        ...context,
        expanded: true,
        maxLines: 200,
      });
      if (!rendered) return false;
      lines.push(this.theme.fg("dim", "Preview:"));
      const body = renderBoundedLines(
        [...(title ? [title] : []), ...rendered.lines],
        this.theme,
        settings.diffIntensity,
      ).render(Math.max(1, width - 2));
      for (const row of body) lines.push(truncateToWidth(`  ${row}`, width, ""));
      if (rendered.hidden > 0) {
        lines.push(this.theme.fg("muted", `  … ${rendered.hidden} more lines`));
      }
      return true;
    };
    const argumentField = (call: FabricActivityCall): void => {
      const args = call.args;
      if (!args || Object.keys(args).length === 0) return;
      const stringValue = (key: string): string | undefined =>
        typeof args[key] === "string" ? args[key] : undefined;
      if (call.ref === "pi.bash" || call.ref === "pi.powershell") {
        const command = stringValue("command");
        const language = call.ref === "pi.powershell" ? "powershell" : "bash";
        if (command) {
          markdownField("Command", `\`\`\`${language}\n${command}\n\`\`\``, "command");
        }
      }
      const edits = Array.isArray(args.edits) ? args.edits : [];
      if (call.ref === "pi.edit" && edits.length > 0) {
        lines.push(this.theme.fg("dim", "Edits:"));
        const diff = nestedEditDiff(
          {
            ref: call.ref,
            tool: call.ref.split(".")[1] ?? call.ref,
            args,
          },
          this.theme,
          this.highlightInvalidate,
        );
        if (diff) {
          for (const line of diff) lines.push(truncateToWidth(`  ${line}`, width, ""));
        } else {
          structuredField("Edits", edits);
        }
      }
      const content = stringValue("content");
      if (call.ref === "pi.write" && content !== undefined) {
        const path = stringValue("path") ?? "";
        const extension = path.includes(".") ? path.split(".").at(-1) : "";
        markdownField("Content", "```" + (extension || "text") + "\n" + content + "\n```", "content");
      }
      const renderedKeys = new Set(["command", "edits", "content"]);
      const remaining = Object.fromEntries(
        Object.entries(args).filter(([key]) => !renderedKeys.has(key)),
      );
      if (Object.keys(remaining).length > 0) structuredField("Input", remaining);
    };
    field("Status", entity.status);

    if (entity.kind === "main") {
      const main = entity.value;
      field("ID", main.id);
      field("Scope", "user-facing Pi session");
      field("Runner", main.runner);
      field("Model", main.model);
      field("Thinking", main.thinking);
      field("Transport", main.transport);
      field("Session", main.sessionId);
      field("Working directory", main.cwd);
      field("Pending messages", main.pendingMessages ? "yes" : "no");
      field("Local owner", main.local ? "yes" : "no");
      field(
        "Elapsed",
        main.startedAt ? formatDuration(Math.max(0, now - main.startedAt)) : undefined,
      );
    } else if (entity.kind === "peer") {
      const peer = entity.value;
      field("ID", peer.id);
      field("Scope", "concurrent root Pi session");
      field("Runner", peer.runner);
      field("Model", peer.model);
      field("Thinking", peer.thinking);
      field("Transport", peer.transport);
      field("Session", peer.sessionId);
      field("Working directory", peer.cwd);
      field("Pending messages", peer.pendingMessages ? "yes" : "no");
      field("Last heartbeat", new Date(peer.updatedAt).toLocaleString());
      field("Elapsed", formatDuration(Math.max(0, now - peer.startedAt)));
    } else if (entity.kind === "agent") {
      const agent = entity.value;
      field("ID", agent.id);
      field("Runner", agent.runner);
      field("Residency", agent.residency ?? "session");
      field("Model", agent.model);
      field("Thinking", agent.thinking);
      field("Transport", agent.transport);
      field("Activity", agent.currentTool);
      field("Elapsed", agent.startedAt ? formatDuration((agent.finishedAt ?? now) - agent.startedAt) : undefined);
      field("Usage", agent.usage ? `${formatTokens(agent.usage.input + agent.usage.output)} tokens · ${agent.toolCalls ?? 0} tools · ${agent.turns ?? 0} turns · $${agent.usage.cost.toFixed(4)}` : undefined);
      markdownField("Task", agent.task, "task");
      field("Branch", agent.branch);
      field("Worktree", agent.worktree);
      field("Attach", agent.attachCommand);
      field("Error", agent.error);
      markdownField("Result", agent.text, "result");
      structuredField("Value", agent.value);
    } else if (entity.kind === "actor") {
      const actor = entity.value;
      field("ID", actor.id);
      field("Runner", actor.runner);
      field("Residency", actor.residency ?? "session");
      field("Execution owner", actor.ownerHostId);
      field("Runtime", actor.local === false ? "remote shared owner" : "local owner");
      field("Session model", actor.binding?.model ?? "inherit project");
      field("Project model", actor.projectDefaults?.model ?? "inherit Fabric");
      field("Effective model", actor.model ?? "Fabric default");
      field("Active worker model", actor.worker?.model);
      field("Session thinking", actor.binding?.thinking ?? "inherit project");
      field("Project thinking", actor.projectDefaults?.thinking ?? "inherit Fabric");
      field("Effective reasoning", actor.thinking ?? "Fabric default");
      field("Active worker thinking", actor.worker?.thinking);
      field("Delivery", `${actor.delivery} · ${actor.responseMode}`);
      field("Trigger turn", actor.triggerTurn ? "yes" : "no");
      field("Activity", actor.worker?.currentTool);
      field("Transport", actor.worker?.transport);
      field(
        "Usage",
        actor.worker?.usage
          ? `${formatTokens(actor.worker.usage.input + actor.worker.usage.output)} tokens · ${actor.worker.toolCalls ?? 0} tools`
          : undefined,
      );
      field("Host events", actor.events.join(", "));
      field("Tools", actor.tools?.join(", ") ?? `inherited (${this.actorDefaultTools.join(", ")})`);
      field("Topics", actor.topics.join(", "));
      field("Queue", actor.queued);
      field("Last error", actor.lastError);
      field("Instructions", actor.instructions);
      if (actor.recentMessages.length > 0) {
        lines.push("");
        lines.push(this.theme.fg("accent", "Recent mailbox"));
        for (const message of actor.recentMessages) {
          const text =
            message.text ??
            message.error ??
            message.action ??
            formatActorDataPreview(message.data) ??
            "data";
          field(
            `${message.direction === "in" ? "→" : "←"} ${formatClock(message.createdAt)} ${message.source}`,
            text,
          );
        }
      }
    } else if (entity.kind === "call") {
      const call = entity.value;
      field("Reference", call.ref);
      field("ID", call.id);
      field("Kind", call.entityKind ?? call.kind);
      field("Progress", call.progress);
      field("Elapsed", formatDuration((call.finishedAt ?? now) - call.startedAt));
      field("Tokens", call.metrics?.tokens);
      field("Tool calls", call.metrics?.toolCalls);
      field("Cost", call.metrics?.cost);
      field("Entity", call.entityId);
      const renderedCorePreview = coreCallPreview(call);
      if (!renderedCorePreview) argumentField(call);
      field("Error", call.error);
      if (!renderedCorePreview) outputField("Output", call.result);
    } else if (entity.kind === "item") {
      const item = entity.value;
      field("ID", item.id);
      field("Kind", item.kind);
      field("Progress", item.total !== undefined ? `${item.completed ?? 0}/${item.total}` : undefined);
      field("Current", item.current);
      field("Detail", item.detail);
      structuredField("Data", item.data);
    } else if (entity.kind === "globalActor") {
      const def = entity.value;
      field("Scope", "global template");
      field("ID", def.id);
      field("Runner", def.runner);
      field("Residency", def.residency ?? "session");
      field("Delivery", `${def.delivery} · ${def.responseMode}`);
      field("Model", def.model ?? "inherit");
      field("Thinking", def.thinking ?? "inherit");
      field("Host events", def.events.join(", "));
      field("Topics", def.topics.join(", "));
      field("Trigger turn", def.triggerTurn ? "yes" : "no");
      field("Coalesce", def.coalesce ? "yes" : "no");
      field("Created", new Date(def.createdAt).toLocaleString());
      field("Updated", new Date(def.updatedAt).toLocaleString());
      field("Instructions", def.instructions);
    } else if (entity.kind === "meshParticipant") {
      const participant = entity.value;
      const canonical = participant.participant;
      field("Scope", canonical ? `project ${canonical.kind}` : "observed mesh agent");
      field("Identity", participant.id);
      field("Root", canonical?.rootId);
      field("Parent", canonical?.parentId);
      field("Owner host", canonical?.ownerHostId);
      field("Owner identity", canonical?.ownerIdentityId);
      field("Residency", canonical?.residency ?? "session");
      field("Runner", canonical?.runner);
      field("Transport", canonical?.transport);
      field("Capabilities", canonical?.capabilities.join(", "));
      field("Local", canonical ? (canonical.local ? "yes" : "no") : undefined);
      field("Observed routes", participant.routes);
      field("Last activity", new Date(participant.lastSeenAt).toLocaleString());
      field("Current work", canonical?.currentTool);
    } else if (entity.kind === "meshTopic") {
      const topic = entity.value;
      field("Scope", "project mesh topic");
      field("ID", topic.id);
      field("System topic", topic.system ? "yes" : "no");
      field("Subscribers", topic.subscribers.map((subscriber) => subscriber.name).join(", "));
      field("Recent events", topic.recentEvents);
      field(
        "Last activity",
        topic.lastEventAt ? new Date(topic.lastEventAt).toLocaleString() : undefined,
      );
    } else if (entity.kind === "meshRoute") {
      const route = entity.value;
      field("Scope", "recent project mesh route");
      field("From", `${route.fromName} (${route.fromKind}:${route.fromId})`);
      field("To", `${route.targetName} (${route.targetKind}:${route.targetId})`);
      field("Topic", route.topic);
      field("Event kind", route.kind);
      field("Deliveries", route.count);
      field("Last activity", new Date(route.lastAt).toLocaleString());
      markdownField("Payload text", route.text, "route-text");
    } else if (entity.kind === "component") {
      const component = entity.value;
      field("Definition", component.component);
      field("Parent", component.parentId);
      field("Guarantee", component.guarantee);
      const componentEffects = component.effects ?? [];
      const visibleEffects = componentEffects.slice(0, 8).map((effect) =>
        `${effect.label}: ${effect.kind}/${effect.ordering} [${effect.resources.join(", ")}]`,
      );
      if (componentEffects.length > visibleEffects.length) {
        visibleEffects.push(`+${componentEffects.length - visibleEffects.length} more`);
      }
      field("Effects", visibleEffects.join("; "));
      field("Effect conflicts", component.effectConflicts?.map((conflict) =>
        formatFabricEffectConflict(
          conflict.withComponent,
          conflict.resources,
          conflict.reason,
        )
      ).join("; "));
      field("Requirements", component.requirements.join(", "));
      field("Provisions", component.provisions.join(", "));
      field("Missing", component.missing.join(", "));
      field("Optional missing", component.optionalMissing.join(", "));
      field("Target digest", component.targetDigest);
      field("Error", component.error);
      field("Updated", new Date(component.updatedAt).toLocaleString());
    } else {
      const entry = entity.value;
      field("Key", entry.key);
      field("Owner", entry.owner);
      field("Version", entry.version);
      field("Updated", new Date(entry.updatedAt).toLocaleString());
      field("Detail", entry.detail);
      const filePreview = loadStateFilePreview(entry, cwd);
      if (filePreview) {
        field("File", filePreview.path);
        lines.push(this.theme.fg("dim", "Preview:"));
        lines.push(...renderStateFilePreview(
          filePreview,
          this.theme,
          width,
          120,
          this.highlightInvalidate,
        ));
      }
      structuredField("Value", entry.value);
    }
    return lines.length > 0 ? lines : [this.theme.fg("dim", "No details")];
  }

  private renderNarrowDetail(
    width: number,
    snapshot: FabricDashboardSnapshot,
    entity: Entity,
  ): string[] {
    const transcriptView =
      (entity.kind === "agent" || entity.kind === "actor") && this.detailView === "transcript";
    const content = transcriptView
      ? this.transcriptLines(entity, width)
      : this.detailLines(entity, width, snapshot.now, snapshot.main.cwd ?? process.cwd());
    const terminalRows = this.tui.terminal?.rows ?? process.stdout.rows ?? 28;
    const maxBody = Math.max(1, terminalRows - 2);
    this.detailMaxScroll = Math.max(0, content.length - maxBody);
    if (transcriptView && this.transcriptFollowing) {
      this.detailScroll = this.detailMaxScroll;
    } else if (transcriptView && this.transcriptPageAnchor) {
      this.detailScroll = this.transcriptPageAnchor === "end" ? this.detailMaxScroll : 0;
      this.transcriptPageAnchor = undefined;
    } else {
      this.detailScroll = Math.max(0, Math.min(this.detailScroll, this.detailMaxScroll));
    }
    const title = `${entity.label}${transcriptView ? " · transcript" : ""}`;
    const hint = transcriptView
      ? `${this.transcriptToolToggleHint()} · g page top · G follow:${this.transcriptFollowing ? "on" : "off"}/tail · t summary · esc`
      : `${this.hasTranscript(entity) ? "t transcript · " : ""}esc`;
    return [title, ...content.slice(this.detailScroll, this.detailScroll + maxBody), hint]
      .map((line) => truncateToWidth(line, width, ""))
      .filter((line) => visibleWidth(line) > 0);
  }

  private topBorder(width: number, title: string): string {
    const border = (value: string) => this.theme.fg("borderMuted", value);
    const safeTitle = truncateToWidth(safeText(title), Math.max(0, width - 6));
    const styledTitle = ` ${this.theme.fg("accent", safeTitle)} `;
    const remaining = Math.max(0, width - 2 - visibleWidth(styledTitle));
    const left = Math.floor(remaining / 2);
    const right = remaining - left;
    return `${border(`╭${"─".repeat(left)}`)}${styledTitle}${border(`${"─".repeat(right)}╮`)}`;
  }

  private middleBorder(width: number): string {
    return this.theme.fg("borderMuted", `├${"─".repeat(Math.max(0, width - 2))}┤`);
  }

  private bottomBorder(width: number): string {
    return this.theme.fg("borderMuted", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
  }

  private row(width: number, content: string): string {
    const innerWidth = Math.max(0, width - 2);
    return `${this.theme.fg("borderMuted", "│")}${padToWidth(content, innerWidth)}${this.theme.fg(
      "borderMuted",
      "│",
    )}`;
  }
}
