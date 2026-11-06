import { homedir } from "node:os";
import path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ScrollViewScrollbar } from "@earendil-works/pi-tui";
import { getConversationHost } from "./conversation-host.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { truncateStyledText as truncateToWidth } from "./truncate.js";
import { formatDuration, formatTokens, safeText } from "./format.js";
import { isActiveStatus } from "./types.js";
import type { FabricConversationTarget } from "./conversation.js";

export interface FabricConversationAppearance {
  editorPaddingX: number;
  outputPad: 0 | 1;
  codeBlockIndent?: string;
  hideThinkingBlock?: boolean;
  showImages?: boolean;
  imageWidthCells?: number;
  copyOnSelect?: boolean;
  scrollbar?: ScrollViewScrollbar;
}

/** Read the host's public Pi settings without changing its editor or footer. */
export function readConversationAppearance(cwd: string, agentDir: string, projectTrusted: boolean): FabricConversationAppearance {
  const settings = getConversationHost().SettingsManager.create(cwd, agentDir, { projectTrusted });
  return {
    editorPaddingX: settings.getEditorPaddingX(), outputPad: settings.getOutputPad(),
    codeBlockIndent: settings.getCodeBlockIndent(), hideThinkingBlock: settings.getHideThinkingBlock(),
    showImages: settings.getShowImages(), imageWidthCells: settings.getImageWidthCells(),
    copyOnSelect: settings.getFullscreenCopyOnSelect(),
    scrollbar: settings.getFullscreenScrollbar(),
  };
}

const footerPath = (cwd: string): string => {
  const home = homedir();
  if (cwd === home) return "~";
  return cwd.startsWith(`${home}${path.sep}`) ? `~${cwd.slice(home.length)}` : cwd;
};

/** Native-shaped footer backed by this participant, never by Main's session stats. */
export function conversationFooter(target: FabricConversationTarget | undefined, theme: Theme, width: number): string[] {
  if (!target || width <= 0) return [];
  const location = target.cwd ? footerPath(target.cwd) : "cwd unavailable";
  const branch = target.branch ? ` (${target.branch})` : "";
  const pwd = safeText(`${location}${branch} • ${target.name}`);
  const access = target.readOnlyReason ? theme.fg("warning", "read-only") : "";
  const separator = theme.fg("dim", " • ");
  const locationWidth = width - (access ? visibleWidth(separator) + visibleWidth(access) : 0);
  const pathLine = locationWidth > 0
    ? theme.fg("dim", truncateToWidth(pwd, locationWidth, "…")) + (access ? separator + access : "")
    : truncateToWidth(access, width, "…");
  // Groups like Pi's own footer: tokens and cost, then the run's work and time,
  // then context. A running target says so on its border (Working), so only a
  // settled status (completed, failed, stopped) leads the line.
  const groups: string[] = [];
  if (!isActiveStatus(target.status)) groups.push(safeText(target.status));
  if (target.usage) {
    const usage = target.usage;
    // Agent usage is run-scoped; actor values describe the current/last activation.
    const tokens = [`↑${formatTokens(usage.input)}`, `↓${formatTokens(usage.output)}`];
    if (usage.cacheRead > 0) tokens.push(`R${formatTokens(usage.cacheRead)}`);
    if (usage.cacheWrite > 0) tokens.push(`W${formatTokens(usage.cacheWrite)}`);
    if (Number.isFinite(usage.cost)) tokens.push(`$${usage.cost.toFixed(3)}`);
    groups.push(tokens.join(" "));
  } else {
    groups.push("usage unavailable");
  }
  if (target.toolCalls !== undefined) groups.push(`${target.toolCalls} call${target.toolCalls === 1 ? "" : "s"}`);
  const elapsed = target.startedAt !== undefined
    ? formatDuration((target.finishedAt ?? Date.now()) - target.startedAt)
    : "";
  if (elapsed) groups.push(elapsed);
  // Cumulative run tokens are not current context occupancy. Do not invent a percentage.
  groups.push(target.contextWindow ? `?/${formatTokens(target.contextWindow)} ctx` : "ctx ?");
  const stats = [groups.join(" · ")];
  const modelKey = safeText(target.model ?? `${target.runner ?? ""} model unavailable`).trim();
  const separatorIndex = modelKey.indexOf("/");
  const model = separatorIndex > 0 && separatorIndex < modelKey.length - 1
    ? `(${modelKey.slice(0, separatorIndex)}) ${modelKey.slice(separatorIndex + 1)}`
    : modelKey;
  const thinking = target.thinking ? ` • ${safeText(target.thinking === "off" ? "thinking off" : target.thinking)}` : "";
  const left = truncateToWidth(stats.join(" "), width, "…");
  const right = truncateToWidth(`${model}${thinking}`, Math.max(0, width - visibleWidth(left) - 2), "");
  const gap = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));
  return [
    pathLine,
    theme.fg("dim", `${left}${gap}${right}`),
  ];
}
