// Adapted from pi-code-previews for audited nested calls; see THIRD_PARTY_NOTICES.md.
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CodePreviewSettings } from "./code-preview.js";
import { formatToolCallDuration } from "./tool-call-timing.js";
import { shikiLanguages } from "./shiki-catalog.js";
import type { FabricRenderAudit } from "./fabric-render.js";
import {
  effectiveShikiThemeIsLight,
  highlightCode,
  highlightFileLines,
  highlightSourceLines,
  languageFromPath,
  observePiTheme,
} from "./highlight.js";
import { arcItem, pushArcItem } from "./arc-group.js";
import { markDiffLine } from "./diff-background.js";
import { countContentLines, selectPreviewTextLines } from "./preview-lines.js";
import {
  shouldSkipWriteDiffBytes,
  shouldSkipWriteDiffComplexity,
} from "../providers/write-diff-limits.js";
import {
  diffLineNumberWidth,
  formatDiffLineNumber,
  parseDiffLine,
  type ParsedDiffLine,
} from "./word-diff/parse.js";

export interface CoreToolRenderOptions {
  cwd: string;
  settings: CodePreviewSettings;
  expanded: boolean;
  maxLines: number;
  invalidate?: () => void;
}

export interface RenderedCoreToolBody {
  lines: string[];
  hidden: number;
}

type PreviewEntry<T> =
  | { kind: "line"; line: T; index: number }
  | { kind: "hidden"; hidden: number };

type DiffSummary = {
  additions: number;
  removals: number;
  replacements: number;
  insertions: number;
  deletions: number;
  totalLines: number;
  hunks: number;
};

const CORE_TOOLS = new Set(["bash", "powershell", "read", "write", "edit", "grep", "find", "ls"]);

export const isCoreToolAudit = (audit: FabricRenderAudit): boolean =>
  audit.tool !== undefined &&
  CORE_TOOLS.has(audit.tool) &&
  (audit.provider === "pi" || audit.ref === `pi.${audit.tool}`);

const positiveEnvInteger = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const SECRET_SCAN_CHARS = positiveEnvInteger("CODE_PREVIEW_SECRET_SCAN_CHARS", 200_000);
const MAX_HIGHLIGHT_CHARS = positiveEnvInteger("CODE_PREVIEW_MAX_HIGHLIGHT_CHARS", 80_000);
const CONTENT_LANGUAGE_DETECTION_CHARS = positiveEnvInteger(
  "CODE_PREVIEW_CONTENT_LANGUAGE_DETECTION_CHARS",
  50_000,
);

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const numberOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const argString = (audit: FabricRenderAudit, key: string): string | undefined =>
  stringOf(audit.args?.[key]);

const escapeControlChars = (text: string): string =>
  text
    .replace(/\x1b/g, "␛")
    .replace(/\r/g, "␍")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "�");

const expandTabs = (text: string): string => text.replace(/\t/g, "    ");

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const countLabel = (count: number, singular: string): string =>
  `${count} ${count === 1 ? singular : `${singular}s`}`;

const metadata = (theme: Theme, values: Array<string | undefined>): string => {
  const present = values.filter((value): value is string => Boolean(value));
  return present.length > 0 ? theme.fg("dim", ` · ${present.join(" · ")}`) : "";
};

const formatDisplayPath = (filePath: string, cwd: string): string => {
  if (!filePath) return "";
  if (isAbsolute(filePath)) {
    const fromCwd = relative(cwd, filePath);
    if (fromCwd && fromCwd !== ".." && !fromCwd.startsWith("../") && !isAbsolute(fromCwd)) {
      return fromCwd;
    }
    if (!fromCwd) return ".";
    const fromHome = relative(homedir(), filePath);
    if (fromHome && fromHome !== ".." && !fromHome.startsWith("../") && !isAbsolute(fromHome)) {
      return `~/${fromHome}`;
    }
    if (!fromHome) return "~";
  }
  return filePath;
};

const renderPath = (filePath: string, cwd: string, theme: Theme, fallback = "..."): string =>
  theme.fg("accent", escapeControlChars(formatDisplayPath(filePath, cwd) || fallback));

const normalizedResult = (audit: FabricRenderAudit): unknown => {
  const preview = recordOf(audit.preview);
  return preview && "result" in preview ? preview.result : audit.result;
};

const contentOutput = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .flatMap((part) => {
      const record = recordOf(part);
      return record?.type === "text" && typeof record.text === "string"
        ? [record.text]
        : [];
    })
    .join("\n");
  return text || undefined;
};

const resultOutput = (audit: FabricRenderAudit): string | undefined => {
  const result = normalizedResult(audit);
  if (typeof result === "string") return result;
  const record = recordOf(result);
  return stringOf(record?.output)
    ?? stringOf(record?.text)
    ?? contentOutput(record?.content);
};

const resultDetails = (audit: FabricRenderAudit): Record<string, unknown> | undefined => {
  const preview = recordOf(audit.preview);
  const previewDetails = recordOf(preview?.details);
  if (previewDetails) return previewDetails;
  return recordOf(recordOf(normalizedResult(audit))?.details);
};

const nativeTruncated = (audit: FabricRenderAudit): boolean => {
  const truncation = recordOf(resultDetails(audit)?.truncation);
  return truncation?.truncated === true || audit.resultTruncated === true;
};

// Pi returns this instead of file content when one source line exceeds its
// byte limit. It is metadata, not JSON/code from the requested file.
const READ_OVERSIZED_LINE_NOTICE =
  /^\[Line \d+ is [^\r\n]+, exceeds [^\r\n]+ limit\. Use bash: [^\r\n]+\]$/;

const READ_CONTINUATION_NOTICE =
  /^\[(?:Showing lines \d+-\d+ of \d+(?: \([^)]+\))?|\d+ more lines in file)\. Use offset=\d+ to continue\.\]$/;

const splitReadContinuationNotice = (text: string): { content: string; notice?: string } => {
  const match = /^(.*?)(?:\r?\n){2}(\[[^\r\n]+\])$/s.exec(text);
  const notice = match?.[2];
  if (!match || !notice || !READ_CONTINUATION_NOTICE.test(notice)) return { content: text };
  return { content: match[1] ?? "", notice: notice.slice(1, -1) };
};

const toolLimit = (audit: FabricRenderAudit, options: CoreToolRenderOptions): number => {
  if (options.expanded) return options.maxLines;
  const configured = (() => {
    switch (audit.tool) {
      case "read":
        return options.settings.readCollapsedLines;
      case "write":
        return options.settings.writeCollapsedLines;
      case "edit":
        return options.settings.editCollapsedLines === "all"
          ? options.maxLines
          : options.settings.editCollapsedLines;
      case "grep":
        return options.settings.grepCollapsedLines;
      case "find":
      case "ls":
        return options.settings.pathListCollapsedLines;
      case "bash":
      case "powershell":
        return 8;
      default:
        return options.maxLines;
    }
  })();
  return Math.max(1, Math.min(configured, options.maxLines));
};

const previewEntries = <T>(lines: T[], limit: number): { entries: PreviewEntry<T>[]; hidden: number } => {
  if (limit <= 0 || lines.length <= limit) {
    return { entries: lines.map((line, index) => ({ kind: "line", line, index })), hidden: 0 };
  }
  if (limit < 8) {
    return {
      entries: lines.slice(0, limit).map((line, index) => ({ kind: "line", line, index })),
      hidden: lines.length - limit,
    };
  }
  const head = Math.ceil(limit * 0.65);
  const tail = Math.max(1, limit - head - 1);
  const hidden = lines.length - head - tail;
  return {
    entries: [
      ...lines.slice(0, head).map((line, index) => ({ kind: "line" as const, line, index })),
      { kind: "hidden" as const, hidden },
      ...lines.slice(-tail).map((line, offset) => ({
        kind: "line" as const,
        line,
        index: lines.length - tail + offset,
      })),
    ],
    hidden,
  };
};

const secretWarnings = (source: string): string[] => {
  if (!source) return [];
  const sample = source.length <= SECRET_SCAN_CHARS
    ? source
    : `${source.slice(0, SECRET_SCAN_CHARS / 2)}\n${source.slice(-SECRET_SCAN_CHARS / 2)}`;
  const warnings: Array<[string, RegExp]> = [
    ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["AWS secret key", /\bAWS_SECRET_ACCESS_KEY\s*=\s*["']?[^\s'"]{12,}/i],
    [
      "API key",
      /\b(?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|MISTRAL|GROQ|TOGETHER|PERPLEXITY|XAI)_API_KEY\s*=\s*["']?[^\s'"]{12,}/i,
    ],
    ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/],
    ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ];
  return warnings.filter(([, pattern]) => pattern.test(sample)).map(([label]) => label);
};

const warningLine = (source: string, options: CoreToolRenderOptions, theme: Theme): string | undefined => {
  if (!options.settings.secretWarnings) return undefined;
  const warnings = secretWarnings(source);
  return warnings.length > 0
    ? theme.fg("warning", `⚠ Preview ${countLabel(warnings.length, "warning")}: possible ${warnings.join(", ")}`)
    : undefined;
};

const resolveLanguage = (filePath: string, content?: string): string | undefined => {
  const fromPath = languageFromPath(filePath);
  if (fromPath) return fromPath;
  const firstLine = content?.split("\n", 1)[0]?.trim();
  if (firstLine?.startsWith("#!")) {
    const parts = firstLine
      .replace(/^#!\s*/, "")
      .split(/\s+/)
      .filter(Boolean);
    const envIndex = parts.findIndex((part) => part.split("/").at(-1) === "env");
    const command = envIndex >= 0
      ? parts.slice(envIndex + 1).find((part) => !part.startsWith("-"))
      : parts[0];
    const executable = command?.split("/").at(-1)?.toLowerCase().replace(/\d+(?:\.\d+)?$/, "");
    const shebang: Record<string, string> = {
      bash: "bash",
      sh: "bash",
      zsh: "bash",
      python: "python",
      node: "javascript",
      deno: "typescript",
      ruby: "ruby",
      php: "php",
    };
    const language = executable ? shebang[executable] : undefined;
    if (language && language in shikiLanguages()) return language;
  }
  if (!content || content.length > CONTENT_LANGUAGE_DETECTION_CHARS) return undefined;
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Continue with the remaining lightweight content checks.
    }
  }
  if (/^<(!doctype\s+html|html)(\s|>)/i.test(trimmed)) return "html";
  if (/^<\?xml\s/i.test(trimmed)) return "xml";
  return undefined;
};

const BASH_TRUNCATION_NOTICE =
  /^\[Showing (?:last [^\r\n]+ of line \d+ \(line is [^)]+\)|lines \d+-\d+ of \d+(?: \([^)]+ limit\))?)\. Full output: [^\r\n]+\]$/;

const isBashTruncationNotice = (line: string): boolean => BASH_TRUNCATION_NOTICE.test(line);

const renderContent = (
  content: string,
  filePath: string,
  theme: Theme,
  options: CoreToolRenderOptions,
  config: { lineNumbers?: boolean; firstLine?: number; emptyLabel: string; skipLabel: string },
): RenderedCoreToolBody => {
  const limit = toolLimit({ ref: "", tool: config.lineNumbers ? "read" : "write" }, options);
  const selected = selectPreviewTextLines(content, limit);
  if (selected.total === 0) {
    return { lines: [theme.fg("muted", config.emptyLabel)], hidden: 0 };
  }
  const skipHighlight =
    options.settings.syntaxHighlighting && content.length > MAX_HIGHLIGHT_CHARS;
  const language =
    options.settings.syntaxHighlighting && !skipHighlight
      ? resolveLanguage(filePath, content)
      : undefined;
  const rendered: string[] = [];
  const warning = warningLine(content, options, theme);
  if (warning) rendered.push(warning);
  const absoluteFilePath = language && filePath ? resolve(options.cwd, filePath) : undefined;
  let chunk: Array<{ line: string; index: number }> = [];
  // A chunk is a contiguous run of visible file lines; when the on-disk file
  // matches, slice its fully-tokenized coverage (state-correct across excerpt
  // boundaries). Any mismatch falls back to per-chunk tokenization.
  const flush = (): void => {
    if (chunk.length === 0) return;
    const normalized = chunk.map((entry) => expandTabs(escapeControlChars(entry.line)));
    const first = chunk[0]!;
    const from = (config.firstLine ?? 1) - 1 + first.index;
    const fileLines =
      absoluteFilePath && language && first.index + chunk.length <= selected.total
        ? highlightFileLines(
            absoluteFilePath,
            language,
            from,
            from + chunk.length,
            options.invalidate,
          )
        : null;
    const fileVerified =
      fileLines !== null && fileLines.every((line, index) => line.raw === normalized[index]);
    const highlighted = fileVerified
      ? fileLines!.map((line) => line.ansi)
      : language
        ? highlightCode(normalized.join("\n"), language, options.invalidate)
        : null;
    const width = String((config.firstLine ?? 1) + selected.total - 1).length;
    for (let index = 0; index < chunk.length; index++) {
      const entry = chunk[index]!;
      const text = highlighted?.[index] ?? theme.fg("toolOutput", normalized[index] || " ");
      if (config.lineNumbers) {
        const lineNumber = String((config.firstLine ?? 1) + entry.index).padStart(width, " ");
        rendered.push(`${theme.fg("dim", `${lineNumber} │ `)}${text}`);
      } else {
        rendered.push(text);
      }
    }
    chunk = [];
  };
  for (const entry of selected.entries) {
    if (entry.kind === "hidden") {
      flush();
      rendered.push(theme.fg("muted", `      --- ${entry.hidden} lines hidden ---`));
    } else if (isBashTruncationNotice(entry.line)) {
      flush();
      const notice = theme.fg("muted", escapeControlChars(entry.line));
      if (config.lineNumbers) {
        const width = String((config.firstLine ?? 1) + selected.total - 1).length;
        const lineNumber = String((config.firstLine ?? 1) + entry.index).padStart(width, " ");
        rendered.push(`${theme.fg("dim", `${lineNumber} │ `)}${notice}`);
      } else {
        rendered.push(notice);
      }
    } else {
      chunk.push({ line: entry.line, index: entry.index });
    }
  }
  flush();
  if (skipHighlight) pushArcItem(rendered, arcItem(theme, config.skipLabel));
  return { lines: rendered, hidden: selected.hidden };
};

const firstShellCommandName = (command: string): string | undefined => {
  const words: string[] = [];
  let index = 0;
  while (index < command.length && words.length < 8) {
    while (index < command.length && /\s/.test(command[index] ?? "")) index++;
    if (index >= command.length || "|&;()<>{}".includes(command[index] ?? "")) break;
    let word = "";
    while (index < command.length) {
      const character = command[index] ?? "";
      if (/\s/.test(character) || "|&;()<>{}".includes(character)) break;
      if (character === "'" || character === '"') {
        const quote = character;
        index++;
        while (index < command.length && command[index] !== quote) {
          if (quote === '"' && command[index] === "\\") index++;
          word += command[index] ?? "";
          index++;
        }
        if (index < command.length) index++;
        continue;
      }
      if (character === "\\") {
        index++;
        word += command[index] ?? "";
        index++;
        continue;
      }
      word += character;
      index++;
    }
    if (word) words.push(word);
  }
  const commandWord = words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word));
  return commandWord?.split("/").at(-1);
};

const bashWarnings = (command: string): string[] => {
  const compact = command.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();
  const warnings: Array<[string, RegExp]> = [
    [
      "recursive delete",
      /\brm\b(?=[^;&|]*(?:-[\w-]*r[\w-]*|--recursive)\b)(?=[^;&|]*(?:-[\w-]*f[\w-]*|--force)\b)/i,
    ],
    ["elevated privileges", /(^|[;&|]\s*)sudo\b/],
    ["recursive permission change", /\bchmod\s+(?:-[\w-]*R|--recursive)\b/],
    ["recursive ownership change", /\bchown\s+(?:-[\w-]*R|--recursive)\b/],
    ["searches entire filesystem", /\bfind\b(?:\s+-[\w-]+)*\s+\/+(?=\s|$)/],
    ["searches entire home directory", /\bfind\b(?:\s+-[\w-]+)*\s+~\/?(?=\s|$)/],
    ["discards git changes", /\bgit\s+reset\s+--hard\b/],
    ["removes untracked files", /\bgit\s+clean\s+-[\w-]*[fd][\w-]*\b/],
    ["removes Docker data", /\bdocker\s+system\s+prune\b/],
    ["writes to a system path", />{1,2}\s*\/?(?:etc|bin|sbin|usr|var|System|Library)\b/],
  ];
  return warnings.filter(([, pattern]) => pattern.test(compact)).map(([label]) => label);
};

const injectVisibleRanges = (
  ansi: string,
  ranges: Array<[number, number]>,
  open: string,
  close: string,
): string => {
  const sorted = ranges.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  let out = "";
  let visible = 0;
  let active = false;
  let rangeIndex = 0;
  for (let index = 0; index < ansi.length; index++) {
    if (ansi[index] === "\x1b" && ansi[index + 1] === "[") {
      const end = ansi.indexOf("m", index + 2);
      if (end >= 0) {
        const sequence = ansi.slice(index, end + 1);
        out += sequence;
        if (active && (sequence === "\x1b[39m" || sequence === "\x1b[22m")) out += open;
        index = end;
        continue;
      }
    }
    while (rangeIndex < sorted.length && visible >= sorted[rangeIndex]![1]) {
      if (active) out += close;
      active = false;
      rangeIndex++;
    }
    const range = sorted[rangeIndex];
    if (!active && range && visible >= range[0] && visible < range[1]) {
      out += open;
      active = true;
    }
    out += ansi[index];
    visible++;
  }
  if (active) out += close;
  return out;
};

// Word emphasis refines a diff that already renders. Load the matcher at the
// first diff, not while loading the extension, and repaint once it is ready.
let lineEmphasis: typeof import("./word-diff/line-emphasis.js") | undefined;
let lineEmphasisLoad: Promise<void> | undefined;
const lineEmphasisReadyCallbacks = new Set<() => void>();

export const loadWordEmphasis = (invalidate?: () => void): Promise<void> => {
  if (invalidate && !lineEmphasis) lineEmphasisReadyCallbacks.add(invalidate);
  return lineEmphasisLoad ??= import("./word-diff/line-emphasis.js").then((module) => {
    lineEmphasis = module;
    const callbacks = [...lineEmphasisReadyCallbacks];
    lineEmphasisReadyCallbacks.clear();
    for (const callback of callbacks) {
      try {
        callback();
      } catch {
        // A stale invalidate callback is harmless.
      }
    }
  }, () => {
    // Without the matcher, diffs keep their line-level colors.
    lineEmphasisReadyCallbacks.clear();
  });
};

const wordEmphasisFor = (
  parsed: Array<ParsedDiffLine | null>,
  mode: CodePreviewSettings["wordEmphasis"],
  invalidate?: () => void,
): Map<number, { ranges: Array<[number, number]>; kind: "add" | "remove" }> => {
  const emphasis = new Map<
    number,
    { ranges: Array<[number, number]>; kind: "add" | "remove" }
  >();
  if (mode === "off") return emphasis;
  if (!lineEmphasis) {
    void loadWordEmphasis(invalidate);
    return emphasis;
  }
  const { changedLineEmphasis } = lineEmphasis;
  let start = 0;
  while (start < parsed.length) {
    if (!parsed[start] || parsed[start]!.kind === " ") {
      start++;
      continue;
    }
    let end = start;
    while (end < parsed.length && parsed[end] && parsed[end]!.kind !== " ") end++;
    const block = parsed.slice(start, end) as ParsedDiffLine[];
    for (const [index, value] of changedLineEmphasis(block, mode)) {
      emphasis.set(start + index, value);
    }
    start = end;
  }
  return emphasis;
};

const summarizeDiff = (diff: string): DiffSummary => {
  let additions = 0;
  let removals = 0;
  let replacements = 0;
  let insertions = 0;
  let deletions = 0;
  let hunks = 0;
  let groupAdditions = 0;
  let groupRemovals = 0;
  const flush = (): void => {
    if (groupAdditions === 0 && groupRemovals === 0) return;
    hunks++;
    if (groupAdditions > 0 && groupRemovals > 0) {
      replacements++;
      insertions += Math.max(0, groupAdditions - groupRemovals);
      deletions += Math.max(0, groupRemovals - groupAdditions);
    } else if (groupAdditions > 0) insertions += groupAdditions;
    else deletions += groupRemovals;
    groupAdditions = 0;
    groupRemovals = 0;
  };
  const lines = diff.split("\n");
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
      groupAdditions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removals++;
      groupRemovals++;
    } else {
      flush();
    }
  }
  flush();
  return { additions, removals, replacements, insertions, deletions, totalLines: lines.length, hunks };
};

const describeDiffShape = (summary: DiffSummary): string => {
  const parts: string[] = [];
  if (summary.replacements > 0) parts.push(countLabel(summary.replacements, "replacement"));
  if (summary.insertions > 0) parts.push(countLabel(summary.insertions, "insertion"));
  if (summary.deletions > 0) parts.push(countLabel(summary.deletions, "deletion"));
  return parts.length > 0 ? parts.join(", ") : "changes";
};

// Render callbacks are synchronous. Resolve jsdiff at the first write diff,
// not while loading the extension.
const require = createRequire(import.meta.url);
let jsdiff: typeof import("diff") | undefined;

const createSimpleDiff = (before: string, after: string): string => {
  const changes = (jsdiff ??= require("diff") as typeof import("diff")).diffLines(before, after);
  const hasChangeAfter = changes.map(() => false);
  let futureChange = false;
  for (let index = changes.length - 1; index >= 0; index--) {
    hasChangeAfter[index] = futureChange;
    const change = changes[index]!;
    if (change.added || change.removed) futureChange = true;
  }
  const out: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  let changed = false;
  let firstChangedLine = 1;
  const context = 3;
  const contextLines = (lines: string[], oldStart: number): string[] =>
    lines.map((line, offset) => ` ${oldStart + offset} ${line}`);
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index]!;
    const lines = change.value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (!change.added && !change.removed) {
      const later = hasChangeAfter[index] ?? false;
      if (!changed && later) {
        const start = Math.max(0, lines.length - context);
        out.push(...contextLines(lines.slice(start), oldLine + start));
      } else if (changed) {
        if (later && lines.length > context * 2) {
          out.push(...contextLines(lines.slice(0, context), oldLine));
          out.push("...");
          out.push(...contextLines(lines.slice(-context), oldLine + lines.length - context));
        } else {
          out.push(...contextLines(lines.slice(0, later ? lines.length : context), oldLine));
        }
      }
      oldLine += lines.length;
      newLine += lines.length;
      continue;
    }
    if (!changed) firstChangedLine = newLine;
    changed = true;
    for (const line of lines) {
      if (change.removed) out.push(`-${oldLine++} ${line}`);
      else out.push(`+${newLine++} ${line}`);
    }
  }
  return out.length > 0 ? [`@@ ${firstChangedLine} @@`, ...out].join("\n") : "";
};

// FNV-style content hash for virtual-document cache keys; stable within the
// process, not persisted, so no collision risk across sessions.
const hashSourceText = (value: string): number => {
  let hash = 5381;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return hash;
};

// Ceiling on the pre-edit context we weave back in front of removed lines.
// Bounds the virtual document so a deep edit never triggers a huge background
// tokenization just to recover grammar state for a handful of removed lines.
const DIFF_REMOVED_CONTEXT_LINES = 512;

/**
 * Resolve surviving compact-diff rows to their post-edit file positions.
 * pi numbers additions on the new side, but context and removals on the old
 * side. Tracking the line delta is O(visible rows) and lets one existing
 * highlightFileLines request serve every matching row without extra I/O or
 * tokenization.
 */
const postEditFileRows = (
  parsed: Array<ParsedDiffLine | null>,
): Array<{ index: number; lineNumber: number }> => {
  const rows: Array<{ index: number; lineNumber: number }> = [];
  let lineDelta = 0;
  for (let index = 0; index < parsed.length; index++) {
    const line = parsed[index];
    if (!line) continue;
    const lineNumber = Number.parseInt(line.lineNumber.trim(), 10);
    if (line.kind === "+") {
      if (Number.isFinite(lineNumber) && lineNumber > 0) rows.push({ index, lineNumber });
      lineDelta++;
    } else if (line.kind === "-") {
      lineDelta--;
    } else if (Number.isFinite(lineNumber)) {
      const translated = lineNumber + lineDelta;
      if (translated > 0) rows.push({ index, lineNumber: translated });
    }
  }
  return rows;
};

/**
 * Highlight removed (`-`) diff lines against a virtual pre-edit document.
 * Removed lines no longer exist on disk, so the file-verified path can never
 * serve them; tokenizing the removed fragment alone leaves embedded-language
 * scopes (e.g. JS inside an HTML <script>) colorless. Weaving the removed
 * lines back into the file's pre-edit line context restores full grammar
 * state. Returns a map from diff-row index to ANSI, or null when the virtual
 * document cannot be reconstructed (file unreadable/oversized/mismatched).
 * Coverage is produced by the shared background pump; pass `invalidate` to
 * repaint once ready.
 */
const highlightRemovedDiffLines = (
  parsed: Array<ParsedDiffLine | null>,
  filePath: string,
  language: string,
  cwd: string,
  invalidate?: () => void,
): Map<number, string> | null => {
  // The first contiguous hunk's removed lines plus their surrounding context.
  let start = 0;
  while (start < parsed.length && !parsed[start]) start++;
  let end = start;
  while (end < parsed.length && parsed[end]) end++;
  const block = parsed.slice(start, end) as ParsedDiffLine[];
  const removed: Array<{ row: number; n: number; content: string }> = [];
  // Context rows preceding the first removed line: they belong to the pre-edit
  // document and must be woven in too — a scope opener (comment/string/tag) is
  // often one of them.
  const contextBefore: Array<{ n: number; content: string }> = [];
  for (let offset = 0; offset < block.length; offset++) {
    const line = block[offset]!;
    // Separator ("...") and other unnumbered rows carry no file position;
    // skip them instead of aborting the whole weave.
    const n = Number.parseInt(line.lineNumber.trim(), 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (line.kind === "-") removed.push({ row: start + offset, n, content: expandTabs(line.content) });
    else if (line.kind === " " && removed.length === 0) contextBefore.push({ n, content: expandTabs(line.content) });
  }
  if (removed.length === 0) return null;
  // The virtual document weaves the removed lines back in as a single run, so
  // it is only faithful when they were contiguous in the pre-edit file. A
  // hunk that interleaves removed and context lines mid-hunk falls through to
  // the fragment fallback rather than reconstruct a wrong document.
  for (let index = 1; index < removed.length; index++) {
    if (removed[index]!.n !== removed[index - 1]!.n + 1) return null;
  }
  const firstRemoved = removed[0]!.n;
  // The woven context must run contiguously right up to the first removed
  // line; a folded gap in between (or interleaved removals) would silently
  // reconstruct the wrong pre-edit document.
  for (let index = 1; index < contextBefore.length; index++) {
    if (contextBefore[index]!.n !== contextBefore[index - 1]!.n + 1) return null;
  }
  if (contextBefore.length > 0 && contextBefore[contextBefore.length - 1]!.n !== firstRemoved - 1) {
    return null;
  }
  const anchor = contextBefore.length > 0 ? contextBefore[0]!.n : firstRemoved;

  const absolute = resolve(cwd, filePath);
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_HIGHLIGHT_CHARS) return null;
  let text: string;
  try {
    text = readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
  if (text.includes("\0")) return null;
  const fileLines = text.replace(/\r\n?/g, "\n").split("\n").map(expandTabs);
  // Context (post-edit, 1-based) must still match the file, or the pre-edit
  // reconstruction would be anchored to the wrong place.
  for (const line of block) {
    if (line.kind !== " ") continue;
    const n = Number.parseInt(line.lineNumber.trim(), 10);
    if (!Number.isFinite(n)) continue;
    if (fileLines[n - 1] !== expandTabs(line.content)) return null;
  }
  const prefixCount = Math.max(0, Math.min(anchor - 1, DIFF_REMOVED_CONTEXT_LINES));
  const prefix = fileLines.slice(anchor - 1 - prefixCount, anchor - 1);
  const removedContents = removed.map((row) => row.content);
  const contextContents = contextBefore.map((context) => context.content);
  const virtual = [...prefix, ...contextContents, ...removedContents];
  const cacheKey = `removed\0${language}\0${absolute}\0${hashSourceText(virtual.join("\n"))}`;
  const covered = highlightSourceLines(
    cacheKey,
    virtual,
    language,
    prefixCount,
    virtual.length,
    invalidate,
  );
  if (!covered) return null;
  const out = new Map<number, string>();
  for (let index = 0; index < removed.length; index++) {
    const entry = covered[contextContents.length + index];
    if (entry && entry.raw === removed[index]!.content) out.set(removed[index]!.row, entry.ansi);
  }
  return out;
};

const renderDiff = (
  diff: string,
  filePath: string,
  theme: Theme,
  options: CoreToolRenderOptions,
  limitOverride?: number,
): RenderedCoreToolBody => {
  if (!diff) return { lines: [], hidden: 0 };
  const sourceLines = diff.split("\n");
  const limit = Math.max(1, Math.min(limitOverride ?? toolLimit({ ref: "", tool: "edit" }, options), options.maxLines));
  const shown = sourceLines.slice(0, limit);
  const hidden = sourceLines.length - shown.length;
  const parsed = shown.map(parseDiffLine);
  const width = diffLineNumberWidth(parsed);
  const skipHighlight =
    options.settings.syntaxHighlighting && diff.length > MAX_HIGHLIGHT_CHARS;
  const language =
    options.settings.syntaxHighlighting && !skipHighlight
      ? resolveLanguage(filePath)
      : undefined;
  const highlighted: Array<string | undefined> = Array.from({ length: shown.length }, () => undefined);
  if (language) {
    // Prefer the on-disk document: numbered diff lines whose content still
    // matches the file take fully state-correct tokens straight from its
    // coverage. Removed/rewritten lines of a successful edit (and proposed
    // edits whose file doesn't match) fail verification and fall through.
    if (filePath) {
      const numbered = postEditFileRows(parsed);
      if (numbered.length > 0) {
        let from = numbered[0]!.lineNumber;
        let to = from;
        for (let index = 1; index < numbered.length; index++) {
          const lineNumber = numbered[index]!.lineNumber;
          from = Math.min(from, lineNumber);
          to = Math.max(to, lineNumber);
        }
        from--;
        to++;
        const slice = highlightFileLines(
          resolve(options.cwd, filePath),
          language,
          from,
          to,
          options.invalidate,
        );
        if (slice) {
          for (const row of numbered) {
            const entry = slice[row.lineNumber - 1 - from];
            if (entry && entry.raw === expandTabs(parsed[row.index]!.content)) {
              highlighted[row.index] = entry.ansi;
            }
          }
        }
      }
      // Removed lines never verify against the post-edit file; recover their
      // grammar state from a virtual pre-edit document before falling back to
      // colorless fragment tokenization.
      const removedHighlighted = highlightRemovedDiffLines(
        parsed,
        filePath,
        language,
        options.cwd,
        options.invalidate,
      );
      if (removedHighlighted) {
        for (const [row, ansi] of removedHighlighted) {
          if (highlighted[row] === undefined) highlighted[row] = ansi;
        }
      }
    }
    // Remaining lines: tokenize the old and new side of each contiguous
    // segment as separate streams so removal-side comment/string state can
    // never bleed into added lines (and vice versa).
    let start = 0;
    while (start < parsed.length) {
      if (!parsed[start] || highlighted[start] !== undefined) {
        start++;
        continue;
      }
      let end = start;
      while (end < parsed.length && parsed[end] && highlighted[end] === undefined) end++;
      const oldOffsets: number[] = [];
      const newOffsets: number[] = [];
      const oldContent: string[] = [];
      const newContent: string[] = [];
      for (let offset = start; offset < end; offset++) {
        const line = parsed[offset]!;
        const content = expandTabs(line.content);
        if (line.kind !== "+") {
          oldOffsets.push(offset);
          oldContent.push(content);
        }
        if (line.kind !== "-") {
          newOffsets.push(offset);
          newContent.push(content);
        }
      }
      const oldRendered = oldContent.length
        ? highlightCode(oldContent.join("\n"), language, options.invalidate)
        : null;
      if (oldRendered) {
        for (let index = 0; index < oldOffsets.length; index++) {
          highlighted[oldOffsets[index]!] = oldRendered[index];
        }
      }
      const newRendered = newContent.length
        ? highlightCode(newContent.join("\n"), language, options.invalidate)
        : null;
      if (newRendered) {
        for (let index = 0; index < newOffsets.length; index++) {
          highlighted[newOffsets[index]!] = newRendered[index];
        }
      }
      start = end;
    }
  }
  const emphasis = wordEmphasisFor(parsed, options.settings.wordEmphasis, options.invalidate);
  const emphasisColors = effectiveShikiThemeIsLight()
    ? { add: "\x1b[48;2;194;209;194m", remove: "\x1b[48;2;216;182;182m" }
    : { add: "\x1b[48;2;64;132;82m", remove: "\x1b[48;2;148;62;70m" };
  const lines = shown.map((raw, index) => {
    const line = parsed[index];
    if (!line) {
      const safe = escapeControlChars(raw);
      const trimmed = safe.trim();
      if (trimmed === "...") return theme.fg("muted", "      --- unchanged lines hidden ---");
      if (trimmed.startsWith("@@")) return theme.fg("accent", theme.bold(safe));
      if (
        trimmed.startsWith("---") ||
        trimmed.startsWith("+++") ||
        trimmed.startsWith("diff ") ||
        trimmed.startsWith("index ")
      ) {
        return theme.fg("muted", safe);
      }
      return theme.fg("toolDiffContext", safe);
    }
    const truncationNotice = isBashTruncationNotice(line.content);
    let content = truncationNotice
      ? theme.fg("muted", escapeControlChars(line.content))
      : highlighted[index] ?? theme.fg("toolOutput", escapeControlChars(expandTabs(line.content)) || " ");
    const match = truncationNotice ? undefined : emphasis.get(index);
    if (match && match.ranges.length > 0) {
      content = injectVisibleRanges(
        content,
        match.ranges,
        match.kind === "add" ? emphasisColors.add : emphasisColors.remove,
        "\x1b[49m",
      );
    }
    const lineNumber = formatDiffLineNumber(line.lineNumber, width);
    if (line.kind === "+") {
      return markDiffLine("add", `${theme.fg("toolDiffAdded", `+${lineNumber} │ `)}${content}`);
    }
    if (line.kind === "-") {
      return markDiffLine("remove", `${theme.fg("toolDiffRemoved", `-${lineNumber} │ `)}${content}`);
    }
    return `\x1b[2m${theme.fg("toolDiffContext", ` ${lineNumber} │ `)}${content}\x1b[22m`;
  });
  if (skipHighlight) {
    pushArcItem(lines, arcItem(theme, "Syntax highlighting skipped for large diff"));
  }
  return { lines, hidden };
};

const renderRead = (
  audit: FabricRenderAudit,
  theme: Theme,
  options: CoreToolRenderOptions,
): RenderedCoreToolBody | null => {
  if (!options.expanded && !options.settings.readContentPreview) return null;
  const output = resultOutput(audit);
  if (output === undefined) return null;
  const filePath = argString(audit, "path") ?? "";
  if (/^Read image file/i.test(output)) {
    return { lines: [theme.fg("dim", escapeControlChars(output))], hidden: 0 };
  }
  const truncated = nativeTruncated(audit);
  if (truncated && READ_OVERSIZED_LINE_NOTICE.test(output)) {
    return { lines: [arcItem(theme, escapeControlChars(output.slice(1, -1)))], hidden: 0 };
  }
  const { content, notice } =
    truncated || typeof audit.args?.limit === "number"
      ? splitReadContinuationNotice(output)
      : { content: output };
  const rendered = renderContent(content, filePath, theme, options, {
    lineNumbers: options.settings.readLineNumbers,
    firstLine: Math.max(1, Math.floor(numberOf(audit.args?.offset) ?? 1)),
    emptyLabel: "Empty file",
    skipLabel: "Syntax highlighting skipped for large file",
  });
  if (notice) pushArcItem(rendered.lines, arcItem(theme, notice));
  else if (truncated) pushArcItem(rendered.lines, arcItem(theme, "Output truncated by read"));
  return rendered;
};

const getWriteBefore = (audit: FabricRenderAudit): unknown => {
  const details = resultDetails(audit);
  return details?.codePreviewBeforeWrite ?? recordOf(audit.preview)?.codePreviewBeforeWrite;
};

const bashCommand = (audit: FabricRenderAudit): string =>
  stringOf(recordOf(audit.preview)?.bashCommand) ?? argString(audit, "command") ?? "";

const writeContent = (audit: FabricRenderAudit): string | undefined =>
  stringOf(recordOf(audit.preview)?.writeContent) ?? argString(audit, "content");

const renderWrite = (
  audit: FabricRenderAudit,
  theme: Theme,
  options: CoreToolRenderOptions,
): RenderedCoreToolBody | null => {
  if (!options.expanded && !options.settings.writeContentPreview) return null;
  const content = writeContent(audit);
  if (content === undefined) return null;
  const filePath = argString(audit, "path") ?? "";
  const before = getWriteBefore(audit);
  const beforeRecord = recordOf(before);
  if (audit.success === true && beforeRecord?.kind === "content") {
    const beforeContent = stringOf(beforeRecord.content);
    if (beforeContent === undefined) {
      return {
        lines: [
          theme.fg("success", "✓ Write applied") +
            theme.fg("muted", " · previous content unavailable"),
        ],
        hidden: 0,
      };
    }
    if (beforeContent === content) {
      return { lines: [theme.fg("muted", "✓ Write applied · no changes")], hidden: 0 };
    }
    if (shouldSkipWriteDiffBytes(beforeContent, content)) {
      return {
        lines: [
          theme.fg("success", "✓ Write applied") +
            theme.fg("muted", " · diff skipped for large content"),
        ],
        hidden: 0,
      };
    }
    if (shouldSkipWriteDiffComplexity(beforeContent, content)) {
      return {
        lines: [
          theme.fg("success", "✓ Write applied") +
            theme.fg("muted", " · diff skipped for complex rewrite"),
        ],
        hidden: 0,
      };
    }
    const diff = createSimpleDiff(beforeContent, content);
    const summary = summarizeDiff(diff);
    const header =
      `${theme.fg("success", "✓ Write applied")} ${theme.fg("muted", describeDiffShape(summary))}` +
      theme.fg("muted", " · ") +
      theme.fg("success", `+${summary.additions}`) +
      " " +
      theme.fg("error", `-${summary.removals}`);
    const rendered = renderDiff(diff, filePath, theme, options);
    return { lines: [header, ...rendered.lines], hidden: rendered.hidden };
  }
  if (audit.success === true && beforeRecord?.kind === "skipped") {
    let reason = stringOf(beforeRecord.reason) ?? "preview unavailable";
    const byteLength = numberOf(beforeRecord.byteLength);
    const maxBytes = numberOf(beforeRecord.maxBytes);
    if (byteLength !== undefined) {
      reason += beforeRecord.sizeExceeded === true && maxBytes !== undefined
        ? ` (${formatBytes(byteLength)} > ${formatBytes(maxBytes)})`
        : ` (${formatBytes(byteLength)})`;
    }
    return {
      lines: [
        theme.fg("success", "✓ Write applied") +
          theme.fg("muted", ` · diff skipped: ${reason}`),
      ],
      hidden: 0,
    };
  }
  if (audit.success === true && recordOf(audit.preview)?.writeBeforeCaptured === true && before === undefined) {
    const rendered = renderContent(content, filePath, theme, options, {
      emptyLabel: "Empty content",
      skipLabel: "Syntax highlighting skipped for large content",
    });
    return {
      lines: [
        theme.fg("success", `✓ New file (${countLabel(countContentLines(content), "line")})`),
        ...rendered.lines,
      ],
      hidden: rendered.hidden,
    };
  }
  return renderContent(content, filePath, theme, options, {
    emptyLabel: "Empty content",
    skipLabel: "Syntax highlighting skipped for large content",
  });
};

const editOperations = (audit: FabricRenderAudit): Array<{ oldText: string; newText: string }> => {
  const edits = Array.isArray(audit.args?.edits) ? audit.args.edits : [];
  return edits.flatMap((edit) => {
    const record = recordOf(edit);
    const oldText = stringOf(record?.oldText) ?? stringOf(record?.old_text);
    const newText = stringOf(record?.newText) ?? stringOf(record?.new_text);
    return oldText !== undefined && newText !== undefined && oldText !== newText
      ? [{ oldText, newText }]
      : [];
  });
};

const renderEdit = (
  audit: FabricRenderAudit,
  theme: Theme,
  options: CoreToolRenderOptions,
): RenderedCoreToolBody | null => {
  if (!options.expanded && !options.settings.editDiffPreview) return null;
  const filePath = argString(audit, "path") ?? "";
  const actual = stringOf(resultDetails(audit)?.diff);
  if (actual) {
    const summary = summarizeDiff(actual);
    const header =
      theme.fg("muted", countLabel(summary.hunks, "hunk")) +
      theme.fg("muted", " · ") +
      theme.fg("success", `+${summary.additions}`) +
      " " +
      theme.fg("error", `-${summary.removals}`);
    const rendered = renderDiff(actual, filePath, theme, options);
    return { lines: [header, ...rendered.lines], hidden: rendered.hidden };
  }
  const operations = editOperations(audit);
  if (operations.length === 0) {
    if (audit.fromTrace) {
      // The durable trace keeps only the edited path (edits/diff are not
      // persisted), so resumed edits have no diff to expand into.
      return { lines: [theme.fg("dim", "diff not retained across reload")], hidden: 0 };
    }
    return null;
  }
  const maxOperations = Math.min(operations.length, 3);
  const sections: string[] = [];
  let additions = 0;
  let removals = 0;
  let hidden = 0;
  const perOperation = Math.max(8, Math.floor(toolLimit(audit, options) / maxOperations));
  for (let index = 0; index < maxOperations; index++) {
    const operation = operations[index]!;
    const diff = createSimpleDiff(operation.oldText, operation.newText);
    const summary = summarizeDiff(diff);
    additions += summary.additions;
    removals += summary.removals;
    if (operations.length > 1) sections.push(theme.fg("muted", `Proposed edit ${index + 1}/${operations.length}`));
    const rendered = renderDiff(diff, filePath, theme, options, perOperation);
    sections.push(...rendered.lines);
    hidden += rendered.hidden;
  }
  const header = `${theme.fg("muted", "proposed edit")} ${theme.fg("success", `+${additions}`)} ${theme.fg("error", `-${removals}`)}${
    operations.length > 1 ? theme.fg("muted", ` · ${operations.length} edit blocks`) : ""
  }`;
  if (operations.length > maxOperations) {
    pushArcItem(sections, arcItem(theme, `Showing ${maxOperations} of ${operations.length} edit blocks`));
  }
  return { lines: [header, ...sections], hidden };
};

const grepMatchRanges = (
  code: string,
  pattern: string,
  literal: boolean,
  ignoreCase: boolean,
): Array<[number, number]> => {
  if (!literal || !pattern) return [];
  const haystack = ignoreCase ? code.toLowerCase() : code;
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;
  const ranges: Array<[number, number]> = [];
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    ranges.push([index, index + needle.length]);
    index = haystack.indexOf(needle, index + needle.length);
  }
  return ranges;
};

type GrepParsedRow = {
  filePath: string;
  lineNumber: number;
  lineNumberLabel: string;
  code: string;
  isMatch: boolean;
};

const parseGrepRow = (raw: string): GrepParsedRow | null => {
  const match = raw.match(/^(.+):(\d+):\s(.*)$/);
  const context = raw.match(/^(.+)-(\d+)-\s(.*)$/);
  const parsed = match ?? context;
  if (!parsed) return null;
  const lineNumberLabel = parsed[2] ?? "";
  const lineNumber = Number.parseInt(lineNumberLabel, 10);
  return {
    filePath: parsed[1] ?? "",
    lineNumber: Number.isFinite(lineNumber) ? lineNumber : 0,
    lineNumberLabel,
    code: expandTabs(parsed[3] ?? ""),
    isMatch: Boolean(match),
  };
};

// Tokenize one run of consecutive same-file grep rows. Preferred source is
// the on-disk file's coverage (correct grammar state across excerpt edges,
// e.g. a doc comment whose opener sits above the match); otherwise the whole
// run is tokenized as a single unit so adjacent lines still share state.
const highlightGrepRun = (
  run: GrepParsedRow[],
  language: string | undefined,
  options: CoreToolRenderOptions,
): Array<string | undefined> => {
  if (!language) return run.map(() => undefined);
  const first = run[0]!;
  const last = run[run.length - 1]!;
  const slice = highlightFileLines(
    resolve(options.cwd, first.filePath),
    language,
    first.lineNumber - 1,
    last.lineNumber,
    options.invalidate,
  );
  if (slice && slice.every((line, index) => line.raw === run[index]!.code)) {
    return slice.map((line) => line.ansi);
  }
  const rendered = highlightCode(
    run.map((row) => row.code).join("\n"),
    language,
    options.invalidate,
  );
  return run.map((_, index) => rendered?.[index]);
};

const renderGrepRowLine = (
  row: GrepParsedRow,
  highlighted: string,
  audit: FabricRenderAudit,
  theme: Theme,
): string => {
  let content = highlighted;
  if (row.isMatch) {
    const ranges = grepMatchRanges(
      row.code,
      argString(audit, "pattern") ?? "",
      audit.args?.literal === true,
      audit.args?.ignoreCase === true,
    );
    if (ranges.length > 0) {
      content = injectVisibleRanges(
        content,
        ranges,
        effectiveShikiThemeIsLight() ? "\x1b[48;2;234;225;171m" : "\x1b[48;2;90;74;28m",
        "\x1b[49m",
      );
    }
  }
  const number = row.isMatch
    ? theme.fg("accent", row.lineNumberLabel.padStart(4, " "))
    : theme.fg("dim", row.lineNumberLabel.padStart(4, " "));
  const marker = row.isMatch ? theme.fg("warning", "│") : theme.fg("dim", "┆");
  return `${theme.fg("dim", "  ")}${number} ${marker} ${content}`;
};

const renderGrep = (
  audit: FabricRenderAudit,
  theme: Theme,
  options: CoreToolRenderOptions,
): RenderedCoreToolBody | null => {
  if (!options.expanded && !options.settings.grepResultPreview) return null;
  const output = resultOutput(audit)?.replace(/\r?\n$/, "");
  if (!output || output === "No matches found") {
    return { lines: [theme.fg("muted", output || "No matches found")], hidden: 0 };
  }
  const raw = output.split("\n");
  const skipHighlight =
    options.settings.syntaxHighlighting && output.length > MAX_HIGHLIGHT_CHARS;
  const syntaxOn = options.settings.syntaxHighlighting && !skipHighlight;
  const selected = previewEntries(raw, toolLimit(audit, options));
  const lines: string[] = [];
  let currentPath = "";
  let currentLanguage: string | undefined;
  let run: GrepParsedRow[] = [];

  const flushRun = (): void => {
    if (run.length === 0) return;
    const highlighted = syntaxOn ? highlightGrepRun(run, currentLanguage, options) : [];
    for (let index = 0; index < run.length; index++) {
      const row = run[index]!;
      const content = highlighted[index] ?? theme.fg("toolOutput", escapeControlChars(row.code));
      lines.push(renderGrepRowLine(row, content, audit, theme));
    }
    run = [];
  };

  for (const entry of selected.entries) {
    if (entry.kind === "hidden") {
      flushRun();
      lines.push(theme.fg("muted", `      --- ${entry.hidden} lines hidden ---`));
      currentPath = "";
      currentLanguage = undefined;
      continue;
    }
    const row = parseGrepRow(entry.line);
    if (!row) {
      flushRun();
      lines.push(
        entry.line.startsWith("[") && entry.line.endsWith("]")
          ? theme.fg("warning", escapeControlChars(entry.line))
          : theme.fg("toolOutput", escapeControlChars(entry.line) || " "),
      );
      continue;
    }
    if (row.filePath !== currentPath) {
      flushRun();
      currentPath = row.filePath;
      currentLanguage = syntaxOn ? languageFromPath(row.filePath) : undefined;
      lines.push(theme.fg("accent", escapeControlChars(row.filePath)));
      run.push(row);
      continue;
    }
    const previous = run[run.length - 1];
    if (!previous || row.lineNumber !== previous.lineNumber + 1) {
      flushRun();
    }
    run.push(row);
  }
  flushRun();
  if (skipHighlight) {
    pushArcItem(lines, arcItem(theme, "Syntax highlighting skipped for large grep output"));
  }
  return { lines, hidden: selected.hidden };
};

const NERD_BY_NAME: Record<string, string> = {
  "package.json": "",
  "package-lock.json": "",
  "tsconfig.json": "",
  "readme.md": "",
  license: "",
  dockerfile: "",
  makefile: "",
  ".gitignore": "",
  ".env": "",
  ".envrc": "",
};

const NERD_BY_EXTENSION: Record<string, string> = {
  ts: "", tsx: "", js: "", jsx: "", json: "", md: "", py: "", rs: "",
  go: "", java: "", rb: "", php: "", html: "", css: "", scss: "",
  yaml: "", yml: "", toml: "", sh: "", bash: "", zsh: "", sql: "",
  xml: "", png: "", jpg: "", jpeg: "", gif: "", svg: "",
};

const pathIcon = (
  filePath: string,
  directory: boolean,
  mode: CodePreviewSettings["pathIcons"],
): string => {
  if (mode === "off") return "";
  if (mode === "unicode") return directory ? "▸" : "•";
  if (directory) return "";
  const name = basename(filePath).toLowerCase();
  return NERD_BY_NAME[name] ?? NERD_BY_EXTENSION[extname(name).slice(1)] ?? "";
};

const renderPathList = (
  audit: FabricRenderAudit,
  theme: Theme,
  options: CoreToolRenderOptions,
): RenderedCoreToolBody | null => {
  const enabled = audit.tool === "find" ? options.settings.findResultPreview : options.settings.lsResultPreview;
  if (!options.expanded && !enabled) return null;
  const output = resultOutput(audit)?.replace(/\r?\n$/, "") ?? "";
  const emptyMarker = audit.tool === "find" ? "No files found matching pattern" : "(empty directory)";
  if (!output || output === emptyMarker) {
    return {
      lines: [theme.fg("muted", audit.tool === "find" ? output || "No files found" : "Empty directory")],
      hidden: 0,
    };
  }
  const raw = output.split("\n");
  if (options.expanded && !enabled) {
    return {
      lines: raw.map((line) => theme.fg("toolOutput", escapeControlChars(line) || " ")),
      hidden: 0,
    };
  }
  const selected = previewEntries(raw, toolLimit(audit, options));
  const lines: string[] = [];
  let chunk: string[] = [];
  const flush = (): void => {
    if (chunk.length === 0) return;
    const shouldTree = chunk
      .filter((line) => line && !(line.startsWith("[") && line.endsWith("]")))
      .some((line) => line.includes("/"));
    const seenDirectories = new Set<string>();
    for (const rawPath of chunk) {
      if (rawPath.startsWith("[") && rawPath.endsWith("]")) {
        lines.push(theme.fg("warning", escapeControlChars(rawPath)));
        continue;
      }
      if (!rawPath) {
        lines.push("");
        continue;
      }
      if (!shouldTree) {
        const leading = rawPath.match(/^\s*/)?.[0] ?? "";
        const body = rawPath.slice(leading.length);
        const directory = body.endsWith("/");
        const icon = pathIcon(body, directory, options.settings.pathIcons);
        const iconText = icon ? leading + icon : leading;
        lines.push(
          `${theme.fg("dim", iconText)}${icon ? " " : ""}${renderPath(body, options.cwd, theme, body)}`,
        );
        continue;
      }
      const clean = rawPath.replace(/^\.\//, "");
      const directory = clean.endsWith("/");
      const parts = clean.replace(/\/$/, "").split("/").filter(Boolean);
      let prefix = "";
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index]!;
        const leaf = index === parts.length - 1;
        const key = prefix ? `${prefix}/${part}` : part;
        const isDirectory = !leaf || directory;
        if (!isDirectory || !seenDirectories.has(key)) {
          if (isDirectory) seenDirectories.add(key);
          const icon = pathIcon(part, isDirectory, options.settings.pathIcons);
          const indent = "  ".repeat(index);
          const label = isDirectory
            ? theme.fg("accent", `${escapeControlChars(part)}/`)
            : theme.fg("toolOutput", escapeControlChars(part));
          lines.push(`${theme.fg("dim", indent + icon)}${icon ? " " : ""}${label}`);
        }
        prefix = key;
      }
    }
    chunk = [];
  };
  for (const entry of selected.entries) {
    if (entry.kind === "hidden") {
      flush();
      lines.push(theme.fg("muted", `      --- ${entry.hidden} lines hidden ---`));
    } else {
      chunk.push(entry.line);
    }
  }
  flush();
  return { lines, hidden: selected.hidden };
};

const renderBash = (
  audit: FabricRenderAudit,
  theme: Theme,
  options: CoreToolRenderOptions,
): RenderedCoreToolBody | null => {
  const commandName = audit.tool === "bash"
    ? firstShellCommandName(bashCommand(audit))
    : "";
  const resultEnabled =
    options.settings.bashResultPreview &&
    (commandName === "grep" || commandName === "egrep" || commandName === "fgrep"
      ? options.settings.grepResultPreview
      : commandName === "find"
        ? options.settings.findResultPreview
        : commandName === "ls"
          ? options.settings.lsResultPreview
          : true);
  if (!options.expanded && !resultEnabled) return null;
  const command = bashCommand(audit);
  // Shiki's tokenizer only splits on "\n"; escape remaining control characters
  // (\r -> visible glyph) rather than folding them into line breaks, so the
  // highlighted array stays row-aligned with commandLines and trailing rows
  // can't drift into the plain fallback as duplicated lines.
  const displayCommand = escapeControlChars(command.replace(/\r\n/g, "\n"));
  const commandLines = displayCommand.split("\n");
  const highlightedCommand = command
    ? highlightCode(
        displayCommand,
        audit.tool === "powershell" ? "powershell" : "bash",
        options.invalidate,
      )
    : null;
  const lines = commandLines.slice(1).map((line, index) =>
    `${theme.fg("dim", "  ")}${highlightedCommand?.[index + 1] ?? theme.fg("accent", line)}`,
  );
  const output = resultOutput(audit)?.replace(/\r?\n$/, "") ?? "";
  if (!output || output === "(no output)") {
    if (!output && audit.fromTrace) {
      // Trace-derived audits never retain results, so an empty output slot
      // after a session reload means "not persisted", not "no output".
      return { lines: [...lines, theme.fg("dim", "output not retained across reload")], hidden: 0 };
    }
    return {
      lines: [...lines, theme.fg("muted", output || "No output")],
      hidden: 0,
    };
  }
  const raw = output.split("\n");
  const selected = previewEntries(raw, toolLimit(audit, options));
  const warning = warningLine(output, options, theme);
  if (warning) lines.push(warning);
  for (const entry of selected.entries) {
    if (entry.kind === "hidden") {
      lines.push(theme.fg("muted", `      --- ${entry.hidden} lines hidden ---`));
      continue;
    }
    const text = theme.fg(audit.success === false ? "error" : "muted", escapeControlChars(entry.line) || " ");
    lines.push(text);
  }
  if (nativeTruncated(audit)) {
    pushArcItem(lines, arcItem(theme, `Output truncated by ${audit.tool ?? "shell"}`));
  }
  const fullOutputPath = stringOf(resultDetails(audit)?.fullOutputPath);
  if (fullOutputPath) pushArcItem(lines, arcItem(theme, `Full output: ${escapeControlChars(fullOutputPath)}`));
  return { lines, hidden: selected.hidden };
};

export const coreToolRendererEnabled = (
  audit: FabricRenderAudit,
  settings: CodePreviewSettings,
): boolean =>
  isCoreToolAudit(audit) &&
  audit.tool !== undefined &&
  settings.tools.includes(audit.tool as CodePreviewSettings["tools"][number]);

export const coreToolPreviewEnabled = (
  audit: FabricRenderAudit,
  settings: CodePreviewSettings,
): boolean => {
  if (!coreToolRendererEnabled(audit, settings)) return true;
  switch (audit.tool) {
    case "read":
      return settings.readContentPreview;
    case "write":
      return settings.writeContentPreview;
    case "edit":
      return settings.editDiffPreview;
    case "grep":
      return settings.grepResultPreview;
    case "find":
      return settings.findResultPreview;
    case "ls":
      return settings.lsResultPreview;
    case "bash":
    case "powershell": {
      if (!settings.bashResultPreview) return false;
      const command = audit.tool === "bash"
        ? firstShellCommandName(bashCommand(audit))
        : "";
      if (command === "grep" || command === "egrep" || command === "fgrep") {
        return settings.grepResultPreview;
      }
      if (command === "find") return settings.findResultPreview;
      if (command === "ls") return settings.lsResultPreview;
      return true;
    }
    default:
      return true;
  }
};

export const renderCoreToolBody = (
  audit: FabricRenderAudit,
  theme: Theme,
  options: CoreToolRenderOptions,
): RenderedCoreToolBody | null => {
  observePiTheme(theme);
  if (!coreToolRendererEnabled(audit, options.settings) || !audit.tool) return null;
  switch (audit.tool) {
    case "read":
      return renderRead(audit, theme, options);
    case "write":
      return renderWrite(audit, theme, options);
    case "edit":
      return renderEdit(audit, theme, options);
    case "grep":
      return renderGrep(audit, theme, options);
    case "find":
    case "ls":
      return renderPathList(audit, theme, options);
    case "bash":
    case "powershell":
      return renderBash(audit, theme, options);
    default:
      return null;
  }
};

export const coreToolTitle = (
  audit: FabricRenderAudit,
  theme: Theme,
  options: Pick<CoreToolRenderOptions, "cwd" | "settings" | "invalidate">,
): string | null => {
  observePiTheme(theme);
  if (!coreToolRendererEnabled(audit, options.settings) || !audit.tool) return null;
  const title = theme.fg("toolTitle", theme.bold(audit.tool));
  const timing = options.settings.toolCallTiming
    ? formatToolCallDuration(audit.startedAt, audit.endedAt)
    : undefined;
  const filePath = argString(audit, "path") ?? "";
  if (audit.tool === "bash" || audit.tool === "powershell") {
    const command = bashCommand(audit);
    const firstLine = command.split("\n")[0] ?? "";
    const language = audit.tool === "powershell" ? "powershell" : "bash";
    const highlighted = firstLine ? highlightCode(firstLine, language, options.invalidate)?.[0] : undefined;
    const timeout = numberOf(audit.args?.timeout);
    const warnings = audit.tool === "bash" && options.settings.bashWarnings
      ? bashWarnings(command)
      : [];
    const prompt = audit.tool === "powershell" ? "PS>" : "$";
    return `${title} ${theme.fg("dim", prompt)} ${highlighted ?? theme.fg("accent", escapeControlChars(firstLine))}${metadata(theme, [
      timeout !== undefined ? `timeout ${timeout}s` : undefined,
      warnings.length > 0 ? `⚠ ${warnings.join(", ")}` : undefined,
      timing,
    ])}`;
  }
  if (audit.tool === "grep") {
    const pattern = argString(audit, "pattern") ?? "";
    const glob = argString(audit, "glob");
    const limit = numberOf(audit.args?.limit);
    return `${title} ${theme.fg("accent", `/${escapeControlChars(pattern)}/`)} ${theme.fg("muted", "in")} ${renderPath(filePath || ".", options.cwd, theme)}${metadata(theme, [
      glob ? escapeControlChars(glob) : undefined,
      limit !== undefined ? `limit ${limit}` : undefined,
      timing,
    ])}`;
  }
  if (audit.tool === "find") {
    const pattern = argString(audit, "pattern") || "*";
    return `${title} ${theme.fg("accent", escapeControlChars(pattern))} ${theme.fg("muted", "in")} ${renderPath(filePath || ".", options.cwd, theme)}${metadata(theme, [timing])}`;
  }
  if (audit.tool === "ls") {
    return `${title} ${renderPath(filePath || ".", options.cwd, theme)}${metadata(theme, [timing])}`;
  }
  if (audit.tool === "read") {
    const offset = numberOf(audit.args?.offset);
    const limit = numberOf(audit.args?.limit);
    const range = offset !== undefined || limit !== undefined
      ? theme.fg("warning", `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}`)
      : "";
    return `${title} ${renderPath(filePath, options.cwd, theme)}${range}${metadata(theme, [
      languageFromPath(filePath),
      timing,
    ])}`;
  }
  if (audit.tool === "write") {
    const content = writeContent(audit);
    const rendererPreview = recordOf(audit.preview);
    const byteLength = numberOf(rendererPreview?.writeByteLength) ??
      (content !== undefined ? Buffer.byteLength(content, "utf8") : undefined);
    const lineCount = numberOf(rendererPreview?.writeLineCount) ??
      (content !== undefined ? countContentLines(content) : undefined);
    return `${title} ${renderPath(filePath, options.cwd, theme)}${metadata(theme, [
      byteLength !== undefined ? formatBytes(byteLength) : undefined,
      lineCount !== undefined ? countLabel(lineCount, "line") : undefined,
      languageFromPath(filePath),
      timing,
    ])}`;
  }
  return `${title} ${renderPath(filePath, options.cwd, theme)}${metadata(theme, [timing])}`;
};
