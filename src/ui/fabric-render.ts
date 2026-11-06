import { createHash } from "node:crypto";
import { arcItem, pushArcItem } from "./arc-group.js";
import type { AppKeybinding, Theme } from "@earendil-works/pi-coding-agent";
import type { CodePreviewSettings } from "./code-preview.js";
import { formatToolCallDuration } from "./tool-call-timing.js";
import {
  getKeybindings,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { highlightCode, languageFromPath } from "./highlight.js";
import { headlineArg } from "../core/call-preview.js";
import { isRoutineInternalCall, providerCallMetadata } from "../core/call-presentation.js";
import { coreToolTitle, renderCoreToolBody } from "./core-tool-render.js";
import { isFabricAgentToolPreview, type FabricAgentToolPreviewNode, type FabricTranscriptEntry } from "./transcript.js";
import { fabricStringLiterals, fabricWriteBindings, type FabricWriteBinding } from "./fabric-code-parser.js";
export { fabricWriteBindings, type FabricWriteBinding } from "./fabric-code-parser.js";
import {
  applyDiffBackground,
  createDiffBackgroundResolver,
  parseMarkedDiffLine,
  wrapDiffAnsiToWidth,
  type DiffBackgroundIntensity,
} from "./diff-background.js";

export interface FabricRenderAudit {
  ref: string;
  tool?: string;
  provider?: string;
  success?: boolean;
  error?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  resultTruncated?: boolean;
  preview?: unknown;
  /** True for audits reconstructed from the durable trace: args are privacy-projected and results/previews were never persisted. */
  fromTrace?: boolean;
  startedAt?: number;
  endedAt?: number;
  previewHeadline?: string;
}

const configuredDiffWrapRows = Number.parseInt(
  process.env.CODE_PREVIEW_DIFF_WRAP_ROWS ?? "",
  10,
);
const DIFF_WRAP_ROWS =
  Number.isFinite(configuredDiffWrapRows) && configuredDiffWrapRows > 0
    ? configuredDiffWrapRows
    : 3;

const EXPAND_KEYBINDING = "app.tools.expand" as AppKeybinding;
const COLLAPSED_MULTICALL_LIMIT = 8;
const EXPANDED_MULTICALL_LIMIT = 30;
const AGENT_RESPONSE_LINE_CODE_POINTS = 240;
const EXPANDED_AGENT_TOOL_BODY_COUNT = 2;
const EXPANDED_AGENT_TOOL_BODY_LINES = 12;
const FULL_SGR_RESET = "\x1b[0m";
const TEXT_SGR_RESET = "\x1b[22;23;24;27;29;39m";
const INHERITED_TEXT_RESET_PARAMETERS = [
  "22", "23", "24", "25", "27", "28", "29", "39", "54", "55",
];
const SGR_SEQUENCE = /\x1b\[([0-9:;]*)m/g;

export const inheritEnclosingBackground = (text: string): string =>
  text.replace(SGR_SEQUENCE, (_sequence, rawParameters: string) => {
    const parameters = rawParameters === "" ? ["0"] : rawParameters.split(";");
    const kept: string[] = [];
    for (let index = 0; index < parameters.length; index++) {
      const parameter = parameters[index]!;
      const code = Number.parseInt(parameter, 10);
      if (parameter === "0") {
        kept.push(...INHERITED_TEXT_RESET_PARAMETERS);
      } else if (parameter.startsWith("48:")) {
        continue;
      } else if (code === 38 || code === 58) {
        const mode = parameters[index + 1];
        const end = index + (mode === "2" ? 4 : mode === "5" ? 2 : 0);
        kept.push(...parameters.slice(index, end + 1));
        index = end;
      } else if (code === 48) {
        const mode = parameters[index + 1];
        index += mode === "2" ? 4 : mode === "5" ? 2 : 0;
      } else if (
        code === 49
        || code === 7
        || (code >= 40 && code <= 47)
        || (code >= 100 && code <= 107)
      ) {
        continue;
      } else {
        kept.push(parameter);
      }
    }
    return kept.length > 0 ? `\x1b[${kept.join(";")}m` : "";
  });

export const safeTerminalText = (value: string): string =>
  value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (character) => {
    const code = character.codePointAt(0)?.toString(16).padStart(2, "0") ?? "00";
    return `\\x${code}`;
  });

const truncateBoundedLine = (line: string, width: number): string => {
  const truncated = truncateToWidth(line, width, "");
  if (!truncated.endsWith(FULL_SGR_RESET)) return truncated;

  // truncateToWidth adds a full reset when clipping. Inside Pi's default tool Box,
  // that reset clears the enclosing background before the right padding cell.
  return truncated.slice(0, -FULL_SGR_RESET.length) + TEXT_SGR_RESET;
};

class BoundedLineList implements Component {
  #cachedWidth: number | undefined;
  #cachedRows: string[] | undefined;

  constructor(
    readonly lines: string[],
    private readonly theme?: Theme,
    private readonly diffIntensity: DiffBackgroundIntensity = "off",
    private readonly wrapLineIndexes?: ReadonlySet<number>,
    private readonly inheritBackground = false,
  ) {}

  render(width: number): string[] {
    if (this.#cachedWidth === width && this.#cachedRows) return this.#cachedRows;
    if (width <= 0) return this.#cache(width, []);
    const diffBackground = createDiffBackgroundResolver(this.theme, this.diffIntensity);
    const rows: string[] = [];
    for (let lineIndex = 0; lineIndex < this.lines.length; lineIndex++) {
      const rawLine = this.lines[lineIndex]!;
      const { kind, line } = parseMarkedDiffLine(rawLine);
      if (!kind) {
        let renderedRows: string[];
        if (this.wrapLineIndexes?.has(lineIndex)) {
          const continuationIndent = width > 2 ? "  " : "";
          const wrapped = wrapTextWithAnsi(
            line,
            Math.max(1, width - visibleWidth(continuationIndent)),
          );
          renderedRows = wrapped.map(
            (row, index) => truncateBoundedLine(
              index === 0 ? row : continuationIndent + row,
              width,
            ),
          );
        } else renderedRows = [truncateBoundedLine(line, width)];
        rows.push(...(
          this.inheritBackground
            ? renderedRows.map(inheritEnclosingBackground)
            : renderedRows
        ));
        continue;
      }
      const pipe = line.indexOf("│ ");
      const continuationPrefix = pipe < 0
        ? ""
        : " ".repeat(visibleWidth(line.slice(0, pipe + 2)));
      const wrappedRows = wrapDiffAnsiToWidth(
        line,
        width,
        DIFF_WRAP_ROWS,
        visibleWidth(continuationPrefix) < width ? continuationPrefix : "",
      );
      for (const row of wrappedRows) {
        const padding = " ".repeat(Math.max(0, width - visibleWidth(row)));
        rows.push(applyDiffBackground(row + padding, diffBackground(kind)));
      }
    }
    return this.#cache(width, rows);
  }

  invalidate(): void {
    this.#cachedWidth = undefined;
    this.#cachedRows = undefined;
  }

  withInheritedBackground(): BoundedLineList {
    if (this.inheritBackground) return this;
    return new BoundedLineList(
      this.lines,
      this.theme,
      this.diffIntensity,
      this.wrapLineIndexes,
      true,
    );
  }

  #cache(width: number, rows: string[]): string[] {
    this.#cachedWidth = width;
    this.#cachedRows = rows;
    return rows;
  }
}

class InheritedBackgroundComponent implements Component {
  constructor(private readonly child: Component) {}

  render(width: number): string[] {
    return this.child.render(width).map(inheritEnclosingBackground);
  }

  invalidate(): void {
    this.child.invalidate?.();
  }
}

export const inheritComponentBackground = (component: Component): Component =>
  component instanceof BoundedLineList
    ? component.withInheritedBackground()
    : new InheritedBackgroundComponent(component);

export const renderBoundedLines = (
  lines: string[],
  theme?: Theme,
  diffIntensity: DiffBackgroundIntensity = "off",
  wrapLineIndexes?: ReadonlySet<number>,
): Component => new BoundedLineList(lines, theme, diffIntensity, wrapLineIndexes);

export const fabricMulticallCallLimit = (expanded: boolean): number =>
  expanded ? EXPANDED_MULTICALL_LIMIT : COLLAPSED_MULTICALL_LIMIT;

const visibleMulticallAudits = (
  audits: FabricRenderAudit[],
  expanded: boolean,
): Array<{ audit: FabricRenderAudit; auditIndex: number }> => {
  const limit = fabricMulticallCallLimit(expanded);
  if (expanded || audits.length <= limit) {
    return audits.slice(0, limit).map((audit, auditIndex) => ({ audit, auditIndex }));
  }
  const active = audits
    .map((audit, auditIndex) => ({ audit, auditIndex }))
    .filter(({ audit }) => audit.success === undefined);
  const selected = new Set(
    active.slice(-limit).map(({ auditIndex }) => auditIndex),
  );
  for (let auditIndex = 0; auditIndex < audits.length && selected.size < limit; auditIndex++) {
    if (!selected.has(auditIndex)) selected.add(auditIndex);
  }
  return [...selected]
    .sort((left, right) => left - right)
    .map((auditIndex) => ({ audit: audits[auditIndex]!, auditIndex }));
};

/** Render the "keybinding to expand" hint, mirroring pi core's native tool previews. */
export function expandHint(theme: Theme): string {
  let keys: string[] = [];
  try {
    keys = getKeybindings().getKeys(EXPAND_KEYBINDING);
  } catch {
    keys = [];
  }
  const keyText = keys.length > 0 ? keys.join("/") : "ctrl-o";
  return theme.fg("dim", `${keyText} to expand`);
}

const truncateOneLine = (value: string, max: number): string => {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
};

const argString = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === "string" ? (args[key] as string) : undefined;

const LEGACY_COMMAND_DIGEST = /^sha256:[a-f0-9]{64}$/;
const legacyCommandCache = new WeakMap<object, ReadonlyMap<string, string>>();

const digestCommand = (command: string): string =>
  `sha256:${createHash("sha256").update(command).digest("hex")}`;

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const legacyCommandsFrom = (fabricArgs: unknown): ReadonlyMap<string, string> => {
  const args = recordOf(fabricArgs);
  if (!args) return new Map();
  const cached = legacyCommandCache.get(args);
  if (cached) return cached;

  const commands = new Map<string, string>();
  const remember = (candidate: unknown): void => {
    if (typeof candidate === "string") commands.set(digestCommand(candidate), candidate);
  };
  const namedStrings = recordOf(args.strings);
  if (namedStrings) {
    for (const value of Object.values(namedStrings)) remember(value);
  }
  const rawCode = args.code;
  const code =
    typeof rawCode === "string"
      ? rawCode
      : Array.isArray(rawCode) && rawCode.every((value) => typeof value === "string")
        ? rawCode.join("\n")
        : undefined;
  if (code) {
    for (const literal of fabricStringLiterals(code)) remember(literal);
  }
  legacyCommandCache.set(args, commands);
  return commands;
};

export const restoreLegacyBashCommands = (
  audits: FabricRenderAudit[],
  fabricArgs: unknown,
): FabricRenderAudit[] => {
  const hasLegacyCommand = audits.some((audit) => {
    const digest = audit.ref === "pi.bash" ? argString(audit.args ?? {}, "commandDigest") : undefined;
    return Boolean(digest && LEGACY_COMMAND_DIGEST.test(digest));
  });
  if (!hasLegacyCommand) return audits;

  const commands = legacyCommandsFrom(fabricArgs);
  return audits.map((audit) => {
    if (audit.ref !== "pi.bash" || !audit.args) return audit;
    const digest = argString(audit.args, "commandDigest");
    if (!digest || !LEGACY_COMMAND_DIGEST.test(digest)) return audit;
    const { commandDigest: _commandDigest, ...argsWithoutDigest } = audit.args;
    const command = commands.get(digest);
    return {
      ...audit,
      args: command ? { ...argsWithoutDigest, command } : argsWithoutDigest,
    };
  });
};

export interface FabricWriteArgumentPreviewInput {
  bindings: FabricWriteBinding[];
  strings?: Record<string, string> | undefined;
  expanded: boolean;
  cwd?: string | undefined;
  settings?: CodePreviewSettings | undefined;
  spinner?: string | undefined;
}

const renderWriteArgumentBody = (
  path: string,
  content: string,
  expanded: boolean,
  theme: Theme,
  invalidate?: () => void,
  parity?: { cwd: string; settings: CodePreviewSettings },
): { lines: string[]; hidden: number } => {
  if (parity) {
    const rendered = renderCoreToolBody(
      { ref: "pi.write", provider: "pi", tool: "write", args: { path, content } },
      theme,
      {
        cwd: parity.cwd,
        settings: parity.settings,
        expanded,
        maxLines: 200,
        ...(invalidate ? { invalidate } : {}),
      },
    );
    if (rendered) return rendered;
  }
  const allLines = safeTerminalText(content).split("\n");
  while (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
  const limit = expanded ? Math.min(allLines.length, 200) : 10;
  const shown = allLines.slice(0, limit);
  const lang = languageFromPath(path);
  const highlighted = lang && shown.length > 0
    ? highlightCode(shown.join("\n"), lang, invalidate)
    : null;
  return {
    lines: shown.map((line, index) =>
      highlighted?.[index] ?? theme.fg("toolOutput", line || " "),
    ),
    hidden: allLines.length - shown.length,
  };
};

export const renderFabricWriteArgumentPreview = (
  input: FabricWriteArgumentPreviewInput,
  theme: Theme,
  invalidate?: () => void,
): Component | null => {
  const available = input.bindings.map(
    (binding) => input.strings?.[binding.stringKey],
  );
  let activeIndex = -1;
  for (let index = 0; index < available.length; index++) {
    if (typeof available[index] === "string") activeIndex = index;
  }
  if (activeIndex < 0) return null;

  if (input.bindings.length === 1) {
    const binding = input.bindings[0]!;
    const rows = [
      nestedCallTitle(
        {
          ref: "pi.write",
          provider: "pi",
          tool: "write",
          args: { path: binding.path, content: available[0] ?? "" },
        },
        theme,
        invalidate,
        input.cwd && input.settings ? { cwd: input.cwd, settings: input.settings } : undefined,
      ),
    ];
    const body = renderWriteArgumentBody(
      binding.path,
      available[0] ?? "",
      input.expanded,
      theme,
      invalidate,
      input.cwd && input.settings ? { cwd: input.cwd, settings: input.settings } : undefined,
    );
    rows.push(...body.lines);
    if (body.hidden > 0) {
      rows.push(
        theme.fg("dim", `… ${body.hidden} more ${body.hidden === 1 ? "line" : "lines"}`) +
          (input.expanded ? "" : theme.fg("dim", " · ") + expandHint(theme)),
      );
    }
    return renderBoundedLines(rows);
  }

  const completed = Math.max(
    0,
    available.filter((value) => typeof value === "string").length - 1,
  );
  const rows = [
    theme.fg(
      "warning",
      `◆ Fabric composing · ${completed}/${input.bindings.length} writes`,
    ),
  ];
  const callLimit = fabricMulticallCallLimit(input.expanded);
  const shownBindings = input.bindings.slice(0, callLimit);
  for (let index = 0; index < shownBindings.length; index++) {
    const binding = shownBindings[index]!;
    const glyph =
      index !== activeIndex && typeof available[index] === "string"
        ? theme.fg("dim", "›")
        : index === activeIndex
          ? theme.fg("warning", input.spinner ?? "◐")
          : theme.fg("dim", "○");
    rows.push(
      `${glyph} ${nestedCallTitle(
        {
          ref: "pi.write",
          provider: "pi",
          tool: "write",
          args: {
            path: binding.path,
            ...(typeof available[index] === "string" ? { content: available[index] } : {}),
          },
        },
        theme,
        invalidate,
        input.cwd && input.settings ? { cwd: input.cwd, settings: input.settings } : undefined,
      )}`,
    );
    if (index === activeIndex) {
      const body = renderWriteArgumentBody(
        binding.path,
        available[index] ?? "",
        input.expanded,
        theme,
        invalidate,
        input.cwd && input.settings ? { cwd: input.cwd, settings: input.settings } : undefined,
      );
      for (const line of body.lines) rows.push(`  ${line}`);
      if (body.hidden > 0) {
        rows.push(
          theme.fg("dim", `  … ${body.hidden} more ${body.hidden === 1 ? "line" : "lines"}`),
        );
      }
    }
  }
  const hidden = input.bindings.length - shownBindings.length;
  if (hidden > 0) {
    rows.push(
      theme.fg("dim", `… ${hidden} more ${hidden === 1 ? "write" : "writes"}`) +
        (input.expanded ? "" : theme.fg("dim", " · ") + expandHint(theme)),
    );
  }
  return renderBoundedLines(rows);
};

const shortIdOf = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value.startsWith("session:") ? `session:${value.slice(8, 16)}` : value.slice(0, 8)
    : undefined;

const countOf = (result: unknown): string =>
  Array.isArray(result) ? String(result.length) : "";

const providerCallDetail = (
  provider: string,
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
  preview: unknown,
  previewHeadline?: string,
): string => {
  if (provider === "agents") {
    if (previewHeadline) return previewHeadline;
    if (preview && typeof preview === "object" && !Array.isArray(preview)) {
      const target = preview as Record<string, unknown>;
      if (target.kind === "fabric-agent-target" && target.id === args.id && typeof target.name === "string" && target.name.trim()) {
        return truncateOneLine(target.name, 80);
      }
    }
    const name = argString(args, "name");
    const previewName = isFabricAgentToolPreview(preview) ? preview.name : undefined;
    const id = shortIdOf(args.id);
    const message = argString(args, "message");
    const task = argString(args, "task");
    switch (tool) {
      case "create":
        return name ?? "";
      case "remove":
      case "stop":
      case "cleanup":
      case "wait":
      case "join":
      case "status":
      case "actorStatus":
      case "messages":
        return previewName ?? name ?? id ?? "";
      case "ask":
      case "tell":
        return [previewName ?? name ?? id, message ? truncateOneLine(message, 48) : ""]
          .filter(Boolean)
          .join(" ");
      case "run":
      case "spawn":
        return name ?? (task ? truncateOneLine(task, 64) : previewName ?? "");
      case "actors":
      case "list":
      case "models":
      case "peers":
      case "departed":
      case "definitions":
        return countOf(result);
      default:
        return previewName ?? id ?? "";
    }
  }
  if (provider === "mesh") {
    if (previewHeadline) return previewHeadline;
    switch (tool) {
      case "publish":
        return argString(args, "topic") ?? "";
      case "read":
        return [argString(args, "topic"), countOf(result)].filter(Boolean).join(" · ");
      case "get":
      case "put":
      case "delete":
        return argString(args, "key") ?? "";
      case "list":
        return [argString(args, "prefix"), countOf(result)].filter(Boolean).join(" · ");
      case "members":
        return countOf(result);
      default:
        return "";
    }
  }
  if (provider === "mcp") {
    if (previewHeadline) return previewHeadline;
    switch (tool) {
      case "$call":
        return [argString(args, "server"), argString(args, "tool")].filter(Boolean).join(".");
      case "$register":
        return argString(args, "name") ?? "";
      case "$servers":
        return countOf(result);
      default:
        return "";
    }
  }
  return "";
};

const structuralCallDetail = (
  provider: string,
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
): string => {
  if (provider !== "fabric") return "";
  const count = countOf(result);
  switch (tool) {
    case "discovery.providers":
    case "discovery.models":
    case "discovery.search":
      return count;
    case "discovery.list":
      return [argString(args, "provider"), argString(args, "namespace"), count]
        .filter(Boolean)
        .join(" · ");
    case "discovery.describe":
      return argString(args, "ref") ?? "";
    case "workflow.parallel":
    case "workflow.pipeline": {
      const itemCount = typeof args.itemCount === "number" ? args.itemCount : undefined;
      const stageCount = typeof args.stageCount === "number" ? args.stageCount : undefined;
      return [
        itemCount !== undefined ? `${itemCount} ${itemCount === 1 ? "item" : "items"}` : "",
        stageCount !== undefined ? `${stageCount} ${stageCount === 1 ? "stage" : "stages"}` : "",
      ].filter(Boolean).join(" · ");
    }
    default:
      return "";
  }
};

const callHeadlinePreview = (audit: FabricRenderAudit): string | undefined => {
  const ref = audit.ref;
  const provider = audit.provider ?? ref.split(".")[0] ?? ref;
  const tool = audit.tool ?? ref.split(".")[1] ?? ref;
  const args = audit.args ?? {};
  return providerCallDetail(provider, tool, args, audit.result, audit.preview)
    || (providerCallMetadata(ref, args)?.detail ?? headlineArg(args))
    || structuralCallDetail(provider, tool, args, audit.result);
};

const nestedResultTruncated = (audit: FabricRenderAudit): boolean => {
  if (audit.resultTruncated === true) return true;
  const result = audit.result;
  if (typeof result !== "object" || result === null) return false;
  const details = (result as Record<string, unknown>).details;
  if (typeof details !== "object" || details === null) return false;
  const truncation = (details as Record<string, unknown>).truncation;
  if (typeof truncation !== "object" || truncation === null) return false;
  return (truncation as Record<string, unknown>).truncated === true;
};

/** Compact one-line title for a nested Fabric call, e.g. `read src/index.ts` or `$ ls -la`. */
export function nestedCallTitle(
  audit: FabricRenderAudit,
  theme: Theme,
  invalidate?: () => void,
  core?: { cwd: string; settings: CodePreviewSettings },
): string {
  const title = nestedCallTitleText(audit, theme, invalidate, core);
  return nestedResultTruncated(audit)
    ? `${title} ${theme.fg("warning", "· truncated")}`
    : title;
}

const nestedCallTitleText = (
  audit: FabricRenderAudit,
  theme: Theme,
  invalidate?: () => void,
  core?: { cwd: string; settings: CodePreviewSettings },
): string => {
  const coreTitle = core
    ? coreToolTitle(audit, theme, { ...core, ...(invalidate ? { invalidate } : {}) })
    : null;
  if (coreTitle) return coreTitle;
  const timing = core?.settings.toolCallTiming
    ? formatToolCallDuration(audit.startedAt, audit.endedAt)
    : undefined;
  const withTiming = (value: string): string =>
    timing ? `${value}${theme.fg("dim", ` · ${timing}`)}` : value;
  const ref = audit.ref;
  const provider = audit.provider ?? ref.split(".")[0] ?? ref;
  const tool = audit.tool ?? ref.split(".")[1] ?? ref;
  const metadata = providerCallMetadata(ref, audit.args);
  // Existing agent/mesh/MCP and structural previews already identify their scope.
  const scopedTitle = metadata && !["agents", "mesh", "mcp", "fabric"].includes(provider) ? metadata.title : tool;
  const title = theme.fg("toolTitle", theme.bold(scopedTitle));
  const args = audit.args ?? {};
  const providerDetail = providerCallDetail(
    provider,
    tool,
    args,
    audit.result,
    audit.preview,
    audit.previewHeadline,
  );
  if (providerDetail) return withTiming(`${title} ${theme.fg("accent", providerDetail)}`);
  if (metadata) {
    const detail = metadata.detail || structuralCallDetail(provider, tool, args, audit.result) || audit.previewHeadline;
    return withTiming(detail ? `${title} ${theme.fg("accent", detail)}` : title);
  }
  const command = argString(args, "command");
  if (command) {
    const firstLine = command.split("\n")[0] ?? "";
    const highlighted =
      firstLine.length > 0 ? highlightCode(firstLine, "bash", invalidate) : null;
    const cmd =
      highlighted && highlighted[0] ? highlighted[0] : theme.fg("accent", firstLine);
    return withTiming(`${title} ${theme.fg("dim", "$")} ${cmd}`);
  }
  const path = argString(args, "path");
  const pattern = argString(args, "pattern");
  const task = argString(args, "task");
  let detail = "";
  if (path) detail = path;
  else if (pattern) detail = `/${pattern}/${path ? ` ${path}` : ""}`;
  else if (task) detail = truncateOneLine(task, 64);
  else {
    detail = headlineArg(args)
      || structuralCallDetail(provider, tool, args, audit.result)
      || audit.previewHeadline
      || "";
  }
  return withTiming(detail ? `${title} ${theme.fg("accent", detail)}` : title);
};

const transcriptToolAudit = (entry: FabricTranscriptEntry): FabricRenderAudit => {
  const rawName = entry.toolName ?? entry.label;
  const normalized = rawName.toLowerCase();
  const tool = normalized === "glob"
    ? "find"
    : ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"].includes(normalized)
      ? normalized
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
    ref: `pi.${tool}`,
    provider: "pi",
    tool,
    ...(Object.keys(args).length > 0 ? { args } : {}),
    ...(entry.result !== undefined ? { result: entry.result } : {}),
    ...(entry.status !== "running" ? { success: entry.status !== "failed" } : {}),
  };
};

const AGENT_PREVIEW_RENDER_MAX_DEPTH = 6;

type AgentToolPreviewRenderOptions = {
  expanded: boolean;
  compact?: boolean | undefined;
  showTools?: boolean | undefined;
  core?: { cwd: string; settings: CodePreviewSettings } | undefined;
  invalidate?: (() => void) | undefined;
};

const previewStatusGlyph = (status: string | undefined, theme: Theme): string =>
  status === "running"
    ? theme.fg("warning", "◐")
    : status === "failed"
      ? theme.fg("error", "✗")
      : theme.fg("dim", "›");

// Collapsed mode allows a single descendant row: prefer the running branch,
// then follow it depth-first so the breadcrumb always ends at live work.
const descendantBreadcrumb = (
  node: FabricAgentToolPreviewNode,
  theme: Theme,
): string | undefined => {
  let tail: FabricAgentToolPreviewNode | undefined =
    node.agents?.find((child) => child.status === "running") ?? node.agents?.[0];
  if (!tail) return undefined;
  const names = [tail.name];
  for (let depth = 0; depth < AGENT_PREVIEW_RENDER_MAX_DEPTH; depth += 1) {
    const next: FabricAgentToolPreviewNode | undefined =
      tail.agents?.find((child) => child.status === "running") ?? tail.agents?.[0];
    if (!next) break;
    tail = next;
    names.push(tail.name);
  }
  // Tool executions in transcript tails are short windows; a 1s preview tick
  // usually samples between them. Falling back to the latest known tool keeps
  // the crumb informative instead of going blank between executions.
  const runningTool = tail.tools.slice().reverse().find((entry) => entry.status === "running");
  const shownTool = runningTool ?? tail.tools.at(-1);
  const trail = names
    .map((name) => theme.fg("accent", safeTerminalText(name)))
    .join(theme.fg("dim", " › "));
  const tool = shownTool
    ? theme.fg("dim", " › ") + nestedCallTitle(transcriptToolAudit(shownTool), theme)
    : "";
  // Only abnormal states earn a glyph; a terminal "›" would duplicate the
  // preview-line chevron this crumb is appended after.
  const glyph =
    tail.status === "running" || tail.status === "failed"
      ? `${previewStatusGlyph(tail.status, theme)} `
      : "";
  return `${glyph}${trail}${tool}`;
};

export const renderAgentToolPreviewLines = (
  audit: FabricRenderAudit,
  theme: Theme,
  options: AgentToolPreviewRenderOptions,
): string[] => {
  if (!isFabricAgentToolPreview(audit.preview)) return [];
  return renderAgentToolPreviewNodeLines(audit.preview, theme, options, 0);
};

const renderAgentToolPreviewNodeLines = (
  preview: FabricAgentToolPreviewNode,
  theme: Theme,
  options: AgentToolPreviewRenderOptions,
  depth: number,
): string[] => {
  const rawPreviewText = safeTerminalText(preview.text ?? "").trim();
  const responseLines = rawPreviewText
    ? options.compact
      ? [rawPreviewText.replace(/\s+/g, " ").trim()]
      : rawPreviewText.split("\n").flatMap((line) => {
          const normalized = line.replace(/\s+/g, " ").trim();
          if (!normalized) return [""];
          const codePoints = Array.from(normalized);
          const chunks: string[] = [];
          for (
            let offset = 0;
            offset < codePoints.length;
            offset += AGENT_RESPONSE_LINE_CODE_POINTS
          ) {
            chunks.push(codePoints.slice(offset, offset + AGENT_RESPONSE_LINE_CODE_POINTS).join(""));
          }
          return chunks;
        })
    : [];
  const tools = options.showTools === false ? [] : preview.tools;
  // Collapsed cards get one inline row; a live descendant branch is more
  // informative than the parent's own spinning tool or narrative, so the
  // breadcrumb wins the slot — matching how a running tool already displaces
  // response text here.
  const descendantCrumb =
    !options.expanded &&
    options.showTools !== false &&
    preview.agents !== undefined &&
    preview.agents.length > 0
      ? descendantBreadcrumb(preview, theme)
      : undefined;
  const runningTool = tools.slice().reverse().find((entry) => entry.status === "running");
  const latestTool = tools.at(-1);
  const collapsedRunningTool =
    !options.expanded && descendantCrumb === undefined ? runningTool : undefined;
  const visibleResponseLines =
    collapsedRunningTool !== undefined || descendantCrumb !== undefined ? [] : responseLines;
  const visibleTools =
    options.expanded || descendantCrumb !== undefined
      ? options.expanded
        ? tools
        : []
      : collapsedRunningTool
        ? [collapsedRunningTool]
        : responseLines.length === 0 && latestTool
          ? [latestTool]
          : [];
  const chevron = theme.fg("dim", "›");
  const lines: string[] = [];

  for (const responseLine of visibleResponseLines) {
    const text = theme.fg("toolOutput", responseLine || " ");
    lines.push(lines.length === 0 ? `${chevron} ${text}` : `  ${text}`);
  }

  for (let toolIndex = 0; toolIndex < visibleTools.length; toolIndex++) {
    const entry = visibleTools[toolIndex]!;
    const nestedAudit = transcriptToolAudit(entry);
    const title = nestedCallTitle(
      nestedAudit,
      theme,
      options.invalidate,
      options.core,
    );
    if (lines.length === 0) {
      lines.push(`${chevron} ${title}`);
    } else {
      const glyph = entry.status === "running"
        ? theme.fg("warning", "◐")
        : entry.status === "failed"
          ? theme.fg("error", "✗")
          : theme.fg("dim", "›");
      lines.push(`  ${glyph} ${title}`);
    }
    if (
      !options.expanded ||
      !options.core ||
      toolIndex < visibleTools.length - EXPANDED_AGENT_TOOL_BODY_COUNT
    ) continue;
    const body = renderCoreToolBody(nestedAudit, theme, {
      cwd: options.core.cwd,
      settings: options.core.settings,
      expanded: true,
      maxLines: EXPANDED_AGENT_TOOL_BODY_LINES,
      ...(options.invalidate ? { invalidate: options.invalidate } : {}),
    });
    if (!body) continue;
    for (const row of body.lines) lines.push(`    ${row}`);
    if (body.hidden > 0) {
      lines.push(theme.fg("dim", `    … ${body.hidden} more lines`));
    }
  }

  if (descendantCrumb !== undefined && lines.length === 0) {
    lines.push(`${chevron} ${descendantCrumb}`);
  }

  if (options.expanded && options.showTools !== false && preview.agents && preview.agents.length > 0) {
    if (depth < AGENT_PREVIEW_RENDER_MAX_DEPTH) {
      for (const child of preview.agents) {
        const status =
          child.status && child.status !== "completed"
            ? theme.fg("dim", ` · ${safeTerminalText(child.status)}`)
            : "";
        const currentTool =
          child.currentTool && child.status === "running"
            ? theme.fg("dim", ` · ${safeTerminalText(child.currentTool)}`)
            : "";
        lines.push(
          `  ${previewStatusGlyph(child.status, theme)} ${theme.fg("accent", safeTerminalText(child.name))}${status}${currentTool}`,
        );
        const childLines = renderAgentToolPreviewNodeLines(
          child,
          theme,
          { ...options, core: undefined },
          depth + 1,
        );
        for (const row of childLines) lines.push(`  ${row}`);
      }
      if (preview.agentsTruncated) {
        lines.push(theme.fg("dim", "  … deeper agent previews hidden"));
      }
    } else {
      lines.push(theme.fg("dim", "  … deeper agent previews hidden"));
    }
  }

  return lines;
};

interface FabricMulticallPreview {
  auditIndex: number;
  body: string;
  hidden: number;
}

export interface FabricMulticallPartialInput {
  audits: FabricRenderAudit[];
  phases: string[];
  progress?: string | undefined;
  expanded: boolean;
  preview?: FabricMulticallPreview | undefined;
  core?: { cwd: string; settings: CodePreviewSettings } | undefined;
  showAgentToolPreview?: boolean | undefined;
  spinner?: string | undefined;
  activityLabel?: string | undefined;
  /** Calls the progress update left out to stay bounded. */
  omittedCalls?: { count: number; done: number; internal?: number } | undefined;
}

export const shellBackgroundShortcut = (audit: FabricRenderAudit): boolean => {
  const preview = audit.preview;
  return audit.success === undefined && (audit.tool === "bash" || audit.tool === "powershell") &&
    typeof preview === "object" && preview !== null &&
    (preview as Record<string, unknown>).shellBackgroundShortcut === true;
};

export const singleCallProgressLine = (
  progress: string | undefined,
  previewLines: string[],
): string => progress && previewLines.length === 0 ? safeTerminalText(progress) : "";

export const compactProgressPreview = (progress: string): string => {
  const lines = safeTerminalText(progress)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const latest = lines[lines.length - 1] ?? "";
  if (lines.length <= 1) return latest;
  return `… ${lines.length - 1} ${lines.length === 2 ? "line" : "lines"} · ${latest}`;
};

export const renderFabricMulticallPartial = (
  input: FabricMulticallPartialInput,
  theme: Theme,
  invalidate?: () => void,
): Component => {
  // Preserve original audit indexes when attaching streamed bodies after filtering.
  const visible = input.audits.map((audit, index) => ({ audit, index }))
    .filter(({ audit }) => !isRoutineInternalCall(audit));
  const previewIndex = input.preview ? visible.findIndex(({ index }) => index === input.preview!.auditIndex) : -1;
  input = { ...input, audits: visible.map(({ audit }) => audit),
    preview: input.preview && previewIndex >= 0 ? { ...input.preview, auditIndex: previewIndex } : undefined };
  const internal = input.omittedCalls?.internal ?? 0;
  const omitted = Math.max(0, (input.omittedCalls?.count ?? 0) - internal);
  const done = input.audits.filter((audit) => audit.success !== undefined).length +
    Math.max(0, (input.omittedCalls?.done ?? 0) - internal);
  let header = theme.fg(
    "warning",
    `◆ ${input.activityLabel ?? "Fabric"} running · ${done}/${input.audits.length + omitted} calls`,
  );
  const progress = input.progress ? compactProgressPreview(input.progress) : "";
  if (progress) header += theme.fg("dim", ` · ${progress}`);

  const rows = [header];
  const wrapLineIndexes = input.expanded ? new Set<number>() : undefined;
  if (input.phases.length > 0) {
    rows.push(theme.fg("dim", input.phases.map((phase) => `◆ ${phase}`).join("  ")));
  }

  const callsShown = visibleMulticallAudits(input.audits, input.expanded);
  for (let visibleIndex = 0; visibleIndex < callsShown.length; visibleIndex++) {
    const { audit, auditIndex } = callsShown[visibleIndex]!;
    if (input.expanded && visibleIndex > 0) rows.push("");
    const glyph =
      audit.success === undefined
        ? theme.fg("warning", input.spinner ?? "◐")
        : audit.success === false
          ? theme.fg("error", "✗")
          : theme.fg("dim", "›");
    const previewLines = renderAgentToolPreviewLines(audit, theme, {
      expanded: input.expanded,
      compact: !input.expanded,
      showTools: input.showAgentToolPreview,
      core: input.core,
      ...(invalidate ? { invalidate } : {}),
    });
    let callRow = `${glyph} ${nestedCallTitle(audit, theme, invalidate, input.core)}`;
    if (audit.success === false && audit.error) {
      callRow += ` ${theme.fg("dim", "›")} ${theme.fg("error", truncateOneLine(safeTerminalText(audit.error), 240))}`;
    } else if (previewLines[0]) {
      callRow += ` ${previewLines[0]}`;
    }
    if (previewLines.length > 0) wrapLineIndexes?.add(rows.length);
    rows.push(callRow);
    if (audit.success !== false && input.preview?.auditIndex === auditIndex) {
      for (const line of input.preview.body.split("\n")) rows.push(`  ${line}`);
      if (input.preview.hidden > 0) {
        rows.push(
          theme.fg(
            "dim",
            `  … ${input.preview.hidden} more ${input.preview.hidden === 1 ? "line" : "lines"}`,
          ),
        );
      }
    }
    if (audit.success !== false && previewLines.length > 1) {
      for (const line of previewLines.slice(1)) {
        wrapLineIndexes?.add(rows.length);
        rows.push(line);
      }
    }
  }

  const callsHidden = input.audits.length + omitted - callsShown.length;
  if (callsHidden > 0) {
    const label = `… ${callsHidden} nested ${callsHidden === 1 ? "call" : "calls"} hidden`;
    rows.push(
      theme.fg("dim", label) +
        (input.expanded ? "" : theme.fg("dim", " · ") + expandHint(theme)),
    );
  }
  if (input.audits.some(shellBackgroundShortcut)) {
    pushArcItem(rows, arcItem(theme, "(ctrl+b to run in background)"));
  }
  return renderBoundedLines(
    rows,
    theme,
    input.core?.settings.diffIntensity ?? "off",
    wrapLineIndexes,
  );
};

export interface FabricCoreToolPreview extends FabricRenderAudit {
  ref: string;
}

const CORE_TOOL_NAMES = new Set(["bash", "powershell", "read", "write", "edit", "grep", "find", "ls"]);

export const captureFabricCoreToolPreviews = (
  audits: FabricRenderAudit[],
  previous: FabricCoreToolPreview[] = [],
): FabricCoreToolPreview[] => {
  const prior = previous.slice();
  return audits.flatMap((audit) => {
    if (
      !audit.tool ||
      !CORE_TOOL_NAMES.has(audit.tool) ||
      (audit.provider !== "pi" && audit.ref !== `pi.${audit.tool}`)
    ) return [];
    const path = argString(audit.args ?? {}, "path");
    const index = prior.findIndex(
      (candidate) =>
        candidate.ref === audit.ref &&
        argString(candidate.args ?? {}, "path") === path,
    );
    const old = index >= 0 ? prior.splice(index, 1)[0] : undefined;
    return [{
      ...(old ?? {}),
      ...audit,
      args: { ...(old?.args ?? {}), ...(audit.args ?? {}) },
      ...(audit.result !== undefined
        ? { result: audit.result }
        : old?.result !== undefined
          ? { result: old.result }
          : {}),
      ...(audit.preview !== undefined
        ? { preview: audit.preview }
        : old?.preview !== undefined
          ? { preview: old.preview }
          : {}),
    }];
  });
};

export const restoreFabricCoreToolPreviews = (
  audits: FabricRenderAudit[],
  previews: FabricCoreToolPreview[],
): FabricRenderAudit[] => {
  const remaining = previews.slice();
  return audits.map((audit) => {
    if (
      !audit.tool ||
      !CORE_TOOL_NAMES.has(audit.tool) ||
      (audit.provider !== "pi" && audit.ref !== `pi.${audit.tool}`)
    ) return audit;
    const path = argString(audit.args ?? {}, "path");
    let index = remaining.findIndex(
      (preview) =>
        preview.ref === audit.ref &&
        argString(preview.args ?? {}, "path") === path,
    );
    if (index < 0) index = remaining.findIndex((preview) => preview.ref === audit.ref);
    if (index < 0) return audit;
    const preview = remaining.splice(index, 1)[0];
    if (!preview) return audit;
    return {
      ...preview,
      ...audit,
      args: { ...(preview.args ?? {}), ...(audit.args ?? {}) },
      ...(audit.result !== undefined
        ? { result: audit.result }
        : preview.result !== undefined
          ? { result: preview.result }
          : {}),
      ...(audit.preview !== undefined
        ? { preview: audit.preview }
        : preview.preview !== undefined
          ? { preview: preview.preview }
          : {}),
      ...(audit.resultTruncated !== undefined
        ? { resultTruncated: audit.resultTruncated }
        : preview.resultTruncated !== undefined
          ? { resultTruncated: preview.resultTruncated }
          : {}),
    };
  });
};

export interface FabricAgentPreview {
  ref: string;
  id: string;
  preview: unknown;
}

export const captureFabricAgentPreviews = (
  audits: FabricRenderAudit[],
  previous: FabricAgentPreview[] = [],
): FabricAgentPreview[] => {
  const captured = previous.slice();
  const indexes = new Map(
    captured.map((preview, index) => [`${preview.ref}\0${preview.id}`, index]),
  );
  for (const audit of audits) {
    if (!isFabricAgentToolPreview(audit.preview)) continue;
    const entry = { ref: audit.ref, id: audit.preview.id, preview: audit.preview };
    const key = `${entry.ref}\0${entry.id}`;
    const index = indexes.get(key);
    if (index === undefined) {
      indexes.set(key, captured.length);
      captured.push(entry);
    } else captured[index] = entry;
  }
  return captured;
};

export const restoreFabricAgentPreviews = (
  audits: FabricRenderAudit[],
  previews: FabricAgentPreview[],
): FabricRenderAudit[] => {
  const remaining = previews.slice();
  return audits.map((audit) => {
    if (isFabricAgentToolPreview(audit.preview)) return audit;
    const requestedId = argString(audit.args ?? {}, "id");
    let index = requestedId
      ? remaining.findIndex((preview) => preview.ref === audit.ref && preview.id === requestedId)
      : -1;
    if (index < 0) index = remaining.findIndex((preview) => preview.ref === audit.ref);
    if (index < 0) return audit;
    const preview = remaining.splice(index, 1)[0];
    return preview ? { ...audit, preview: preview.preview } : audit;
  });
};

export interface FabricWritePreview {
  ref: string;
  path?: string | undefined;
  content: string;
}

export const captureFabricWritePreviews = (audits: FabricRenderAudit[]): FabricWritePreview[] =>
  audits.flatMap((audit) => {
    const rendererPreview =
      typeof audit.preview === "object" && audit.preview !== null && !Array.isArray(audit.preview)
        ? (audit.preview as Record<string, unknown>)
        : undefined;
    const content = audit.tool === "write"
      ? (typeof rendererPreview?.writeContent === "string"
          ? rendererPreview.writeContent
          : argString(audit.args ?? {}, "content"))
      : undefined;
    if (content === undefined) return [];
    return [{ ref: audit.ref, path: argString(audit.args ?? {}, "path"), content }];
  });

// Arbitrary provider arguments are deliberately absent from persisted traces.
// Keep only their selected one-line headlines in renderer state so completion
// does not erase a preview that was already visible while the call was live.
export interface FabricCallHeadlinePreview {
  ref: string;
  headline: string;
}

export const captureFabricCallHeadlinePreviews = (
  audits: FabricRenderAudit[],
): FabricCallHeadlinePreview[] =>
  audits.flatMap((audit) => {
    const headline = callHeadlinePreview(audit);
    return headline ? [{ ref: audit.ref, headline }] : [];
  });

export const restoreFabricCallHeadlinePreviews = (
  audits: FabricRenderAudit[],
  previews: FabricCallHeadlinePreview[],
): FabricRenderAudit[] => {
  const remaining = previews.slice();
  return audits.map((audit) => {
    const index = remaining.findIndex((preview) => preview.ref === audit.ref);
    if (index < 0) return audit;
    const [preview] = remaining.splice(index, 1);
    // Peer steering headlines carry the resolved label, not just the raw id.
    const peerControl = audit.ref === "agents.steer" || audit.ref === "agents.followUp";
    if ((!peerControl && headlineArg(audit.args)) || !preview) return audit;
    return { ...audit, previewHeadline: preview.headline };
  });
};

// Write content is also absent from persisted traces. Keep bounded live content
// so a fast write can still render when its final result replaces the partial.
export const restoreFabricWritePreviews = (
  audits: FabricRenderAudit[],
  previews: FabricWritePreview[],
): FabricRenderAudit[] => {
  const remaining = previews.slice();
  return audits.map((audit) => {
    if (audit.tool !== "write" || typeof audit.args?.content === "string") return audit;
    const path = argString(audit.args ?? {}, "path");
    const index = remaining.findIndex(
      (preview) => preview.ref === audit.ref && preview.path === path,
    );
    if (index < 0) return audit;
    const [preview] = remaining.splice(index, 1);
    return preview
      ? { ...audit, args: { ...(audit.args ?? {}), content: preview.content } }
      : audit;
  });
};

/** Extract the human-readable body text from a nested call result or write arguments, if any. */
export function nestedCallBody(audit: FabricRenderAudit): string | undefined {
  if (audit.tool === "write" && typeof audit.args?.content === "string") {
    return audit.args.content;
  }
  const result = audit.result;
  if (typeof result === "string") return result;
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    if (typeof obj.output === "string") return obj.output;
    if (typeof obj.text === "string") return obj.text;
  }
  return undefined;
}

/** Source code + language for syntax highlighting, for reads (file content) and writes (content being written). */
export function nestedCallCode(
  audit: FabricRenderAudit,
): { code: string; lang: string } | null {
  const args = audit.args ?? {};
  const path = typeof args.path === "string" ? args.path : undefined;
  const lang = languageFromPath(path);
  if (!lang) return null;
  if (audit.tool === "read") {
    return typeof audit.result === "string" ? { code: audit.result, lang } : null;
  }
  if (audit.tool === "write") {
    return typeof args.content === "string" ? { code: args.content, lang } : null;
  }
  return null;
}

const escapeControlChars = (text: string): string =>
  text
    .replace(/\x1b/g, "␛")
    .replace(/\r/g, "␍")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "�");

type DiffLine = { kind: "+" | "-" | " "; content: string };

const lineDiff = (oldLines: string[], newLines: string[]): DiffLine[] => {
  const m = oldLines.length;
  const n = newLines.length;
  if (m * n > 1_000_000) {
    return [
      ...oldLines.map((line) => ({ kind: "-" as const, content: line })),
      ...newLines.map((line) => ({ kind: "+" as const, content: line })),
    ];
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    const oldLine = oldLines[i] ?? "";
    const cur = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = n - 1; j >= 0; j--) {
      const newLine = newLines[j] ?? "";
      cur[j] =
        oldLine === newLine
          ? (next[j + 1] ?? 0) + 1
          : Math.max(next[j] ?? 0, cur[j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    const oldLine = oldLines[i] ?? "";
    const newLine = newLines[j] ?? "";
    if (oldLine === newLine) {
      out.push({ kind: " ", content: oldLine });
      i++;
      j++;
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      out.push({ kind: "-", content: oldLine });
      i++;
    } else {
      out.push({ kind: "+", content: newLine });
      j++;
    }
  }
  while (i < m) {
    out.push({ kind: "-", content: oldLines[i] ?? "" });
    i++;
  }
  while (j < n) {
    out.push({ kind: "+", content: newLines[j] ?? "" });
    j++;
  }
  return out;
};

/** Render a syntax-highlighted line diff for a nested `pi.edit` call, or null. */
export function nestedEditDiff(
  audit: FabricRenderAudit,
  theme: Theme,
  invalidate?: () => void,
): string[] | null {
  if (audit.tool !== "edit") return null;
  const args = audit.args ?? {};
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (edits.length === 0) return null;
  const lang = languageFromPath(typeof args.path === "string" ? args.path : undefined);
  const lines: string[] = [];
  for (const edit of edits.slice(0, 5)) {
    if (!edit || typeof edit !== "object") continue;
    const record = edit as Record<string, unknown>;
    const oldText = typeof record.oldText === "string" ? record.oldText : "";
    const newText = typeof record.newText === "string" ? record.newText : "";
    const diff = lineDiff(oldText.split("\n"), newText.split("\n"));
    if (diff.length === 0) continue;
    // Tokenize the old and new side as separate streams so removal-side
    // comment/string state cannot bleed into added lines.
    const oldHighlighted = lang
      ? highlightCode(
          diff.filter((entry) => entry.kind !== "+").map((entry) => entry.content).join("\n"),
          lang,
          invalidate,
        )
      : null;
    const newHighlighted = lang
      ? highlightCode(
          diff.filter((entry) => entry.kind !== "-").map((entry) => entry.content).join("\n"),
          lang,
          invalidate,
        )
      : null;
    let oldCursor = 0;
    let newCursor = 0;
    for (let index = 0; index < diff.length; index++) {
      const entry = diff[index]!;
      let text: string | undefined;
      if (entry.kind === "-") {
        text = oldHighlighted?.[oldCursor++];
      } else if (entry.kind === "+") {
        text = newHighlighted?.[newCursor++];
      } else {
        oldCursor++;
        text = newHighlighted?.[newCursor++];
      }
      const content =
        text != null ? text || " " : theme.fg("toolOutput", escapeControlChars(entry.content) || " ");
      if (entry.kind === "+") {
        lines.push(`${theme.fg("toolDiffAdded", "+")} ${content}`);
      } else if (entry.kind === "-") {
        lines.push(`${theme.fg("toolDiffRemoved", "-")} ${content}`);
      } else {
        lines.push(`${theme.fg("toolDiffContext", " ")} ${content}`);
      }
    }
  }
  return lines.length > 0 ? lines : null;
}

const lineCountTrimmed = (value: string): number => {
  const lines = value.split("\n");
  let end = lines.length;
  while (end > 0) {
    const last = lines[end - 1];
    if (last === undefined || last.trim() === "") end--;
    else break;
  }
  return end;
};

// Mirrors pi core's read range notice: surface how many lines a fabric_exec
// program sent to the model vs. how many its nested read(s) returned, so
// sliced reads don't look like full-file reads. The audited body is unchanged.
export function modelReadHint(
  audits: FabricRenderAudit[],
  output: string,
  theme: Theme,
): string {
  if (!output) return "";
  const modelLines = lineCountTrimmed(output);
  let readLines = 0;
  let sawRead = false;
  for (const audit of audits) {
    if (audit.tool !== "read") continue;
    const body = nestedCallBody(audit);
    if (typeof body !== "string") continue;
    sawRead = true;
    readLines += lineCountTrimmed(body);
  }
  if (!sawRead || modelLines >= readLines) return "";
  return theme.fg("warning", "→ " + modelLines + " of " + readLines + " lines to model");
}
