import type { Component, Focusable, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { FabricUiWidgetMode } from "../config.js";
import { isRoutineInternalCall } from "../core/call-presentation.js";
import { FabricWidgetRetention, isRecentWidgetCompletion } from "./retention.js";
import { FABRIC_WIDGET_FOCUS_HINT, FABRIC_WIDGET_FOCUS_SHORTCUT } from "./widget-keys.js";
import type { FabricShellJobInfo } from "../core/shell-jobs.js";
import type {
  FabricActivityRun,
  FabricActivityStatus,
} from "../activity/types.js";
import { formatCost, formatDuration, formatTokens, safeText } from "./format.js";
import {
  isActiveStatus,
  orderAgentsByCreation,
  type FabricDashboardSnapshot,
  type FabricUiAgent,
} from "./types.js";

/**
 * Claude Code's list marker: a hollow circle per row, filled for the row in
 * view. Status is the circle's colour, so the shape never jumps.
 */
const circle = (selected: boolean): string => (selected ? "●" : "○");

const colorStatus = (theme: Theme, status: string, value: string): string => {
  if (status === "completed" || status === "done" || status === "exited") return theme.fg("success", value);
  if (status === "failed" || status === "timed_out") return theme.fg("error", value);
  if (status === "blocked" || status === "stopping") return theme.fg("warning", value);
  if (status === "running" || status === "in_progress" || status === "spilled") return theme.fg("accent", value);
  return theme.fg("dim", value);
};

const phaseProgress = (
  run: FabricActivityRun,
  phaseId: string,
): { completed: number; total: number } => {
  const phase = run.phases.find((candidate) => candidate.id === phaseId);
  const statuses: FabricActivityStatus[] = [
    ...run.calls.filter((call) => !isRoutineInternalCall(call) && call.phaseId === phaseId).map((call) => call.status),
    ...run.items.filter((item) => item.phaseId === phaseId).map((item) => item.status),
  ];
  const completed = statuses.filter((status) => status === "completed").length;
  return { completed, total: Math.max(phase?.total ?? 0, statuses.length) };
};

const totalTokens = (
  snapshot: FabricDashboardSnapshot,
  run: FabricActivityRun | undefined,
): number =>
  snapshot.agents
    .filter((agent) => (run ? agent.runId === run.id : isActiveStatus(agent.status)))
    .reduce(
      (sum, agent) => sum + (agent.usage ? agent.usage.input + agent.usage.output : 0),
      0,
    );

const totalCost = (
  snapshot: FabricDashboardSnapshot,
  run: FabricActivityRun | undefined,
): number =>
  snapshot.agents
    .filter((agent) => (run ? agent.runId === run.id : isActiveStatus(agent.status)))
    .reduce((sum, agent) => sum + (agent.usage?.cost ?? 0), 0);

/** A widget row that can be selected and opened. */
export interface FabricWidgetRow {
  /**
   * Agent id, actor id for an actor's worker row, the main session's id, a
   * or the exact shell task id.
   */
  id: string;
  kind: "main" | "agent" | "actor" | "shell";
  name: string;
  model?: string;
}

/** Optional interaction wiring; without it the widget stays a passive status box. */
export interface FabricWidgetInteraction {
  /** Open the participant's full conversation, where it can be read and steered. */
  open?: (row: FabricWidgetRow) => void;
  /**
   * Return focus to the editor. `forward` is a key the widget does not use; the
   * editor receives it, because Pi handles Ctrl+C and extension shortcuts there.
   */
  release: (forward?: string) => void;
  /** Ask the host to redraw (selection changes without a snapshot change). */
  requestRender: () => void;
  /** Called after each render, so the host can check where the widget sits. */
  rendered?: () => void;
  /** Space left after native UI and other extensions; zero temporarily hides the list. */
  availableRows?: (width: number) => number | undefined;
  /** The participant on screen; its row keeps the filled circle. Undefined means the main session. */
  viewing?: () => string | undefined;
  /** The main session's id, which makes the header a row to select, for windows Main is a place to return to. */
  mainId?: string;
  /** False drops the key hints, where the list is the window's only navigation. */
  hints?: boolean;
  /**
   * With no row to select (no agent, actor worker, or shell task), the widget
   * draws no lines while this is true: the host shows any session label
   * elsewhere, on the editor border.
   */
  collapseIdle?: () => boolean;
}

/** Model id without its provider prefix: `anthropic/claude-opus-5-5` → `claude-opus-5-5`. */
const modelName = (model: string | undefined): string | undefined =>
  model ? safeText(model.slice(model.lastIndexOf("/") + 1)).trim() || undefined : undefined;

/**
 * Progressive disclosure for one line: `lead` (circle and name) always shows.
 * When the line is too wide, `detail` statistics drop from their end first,
 * then `flexible` (a title or the current activity) is shortened, and key
 * `hints` drop last, so a narrow terminal keeps the keys before the numbers.
 */
const fitLine = (
  theme: Theme,
  width: number,
  lead: string,
  flexible: { text: string; gap: string; color: "muted" | "dim" } | undefined,
  detail: string[],
  hints: string[],
): string => {
  const separator = theme.fg("dim", " · ");
  const compose = (flex: string | undefined, details: number, hintCount: number): string => {
    const tail = [...detail.slice(0, details), ...hints.slice(0, hintCount)];
    return `${lead}${flex ? `${flexible!.gap}${theme.fg(flexible!.color, flex)}` : ""}${
      tail.length > 0 ? `${separator}${tail.map((part) => theme.fg("dim", part)).join(separator)}` : ""
    }`;
  };
  let details = detail.length;
  let hintCount = hints.length;
  let flex = flexible?.text;
  while (details > 0 && visibleWidth(compose(flex, details, hintCount)) > width) details--;
  if (flex && visibleWidth(compose(flex, details, hintCount)) > width) {
    const room = width - visibleWidth(compose(undefined, details, hintCount)) - visibleWidth(flexible!.gap);
    flex = room >= 6 ? truncateToWidth(flex, room, "…") : undefined;
  }
  while (hintCount > 0 && visibleWidth(compose(flex, details, hintCount)) > width) hintCount--;
  return truncateToWidth(compose(flex, details, hintCount), width, "…");
};

/** Parents before their children, so nesting reads as a tree; `depth` is the indent within the listed set. */
const treeOrder = (agents: FabricUiAgent[]): Array<{ agent: FabricUiAgent; depth: number; prefix: string }> => {
  const ids = new Set(agents.map((agent) => agent.id));
  const children = new Map<string, FabricUiAgent[]>();
  const roots: FabricUiAgent[] = [];
  for (const agent of agents) {
    const parentId = agent.parentId;
    if (parentId && parentId !== agent.id && ids.has(parentId)) {
      children.set(parentId, [...(children.get(parentId) ?? []), agent]);
    } else roots.push(agent);
  }
  const ordered: Array<{ agent: FabricUiAgent; depth: number; prefix: string }> = [];
  const seen = new Set<string>();
  const visit = (agent: FabricUiAgent, ancestors: boolean[], last: boolean): void => {
    if (seen.has(agent.id)) return;
    seen.add(agent.id);
    const depth = ancestors.length;
    const prefix = depth === 0 ? "" : `${ancestors.slice(1).map((more) => more ? "│  " : "   ").join("")}${last ? "└─ " : "├─ "}`;
    ordered.push({ agent, depth, prefix });
    const descendants = (children.get(agent.id) ?? []).filter((child) => !seen.has(child.id));
    descendants.forEach((child, index) => visit(child, [...ancestors, !last], index === descendants.length - 1));
  };
  for (const root of roots) visit(root, [], true);
  // Parents that point at each other leave a cycle with no root: list each such
  // agent as a root instead of hiding it.
  for (const agent of agents) visit(agent, [], true);
  return ordered;
};

const agentLine = (
  theme: Theme,
  agent: FabricUiAgent,
  now: number,
  prefix: string,
  selected: boolean,
  width: number,
): string => {
  const status = colorStatus(theme, agent.status, circle(selected));
  const live = isActiveStatus(agent.status);
  const activity = live
    ? agent.milestone ?? agent.currentTool ?? (agent.status === "running" ? "thinking" : agent.status)
    : agent.error
      ? `error: ${safeText(agent.error)}`
      : agent.text
        ? `result: ${safeText(agent.text)}`
        : agent.status;
  const metrics = [
    modelName(agent.model),
    agent.toolCalls !== undefined ? `${agent.toolCalls} call${agent.toolCalls === 1 ? "" : "s"}` : undefined,
    agent.usage ? `${formatTokens(agent.usage.input + agent.usage.output)} tok` : undefined,
    agent.startedAt
      ? formatDuration((agent.finishedAt ?? now) - agent.startedAt)
      : undefined,
  ].filter((value): value is string => Boolean(value));
  const name = safeText(agent.name);
  // Deep trees should not consume the whole row on narrow terminals.
  const prefixBudget = Math.max(0, Math.floor(width / 3));
  const compactPrefix = prefix.length <= prefixBudget ? prefix : prefixBudget >= 4 ? `…${prefix.slice(-(prefixBudget - 1))}` : "";
  const lead = `${theme.fg("dim", compactPrefix)}${status} ${selected ? theme.bold(name) : theme.fg("muted", name)}`;
  return fitLine(theme, width, lead, { text: safeText(activity).replace(/\s+/g, " ").trim(), gap: "  ", color: "muted" }, metrics, []);
};

export const shouldShowFabricWidget = (
  snapshot: FabricDashboardSnapshot,
  mode: FabricUiWidgetMode,
  retention = new FabricWidgetRetention(),
): boolean => {
  if (mode === "hidden") return false;
  if (mode === "always") return true;
  retention.sync(snapshot);
  // A labelled root keeps its header row, so the label always has a home.
  if (snapshot.sessionLabel) return true;
  if (snapshot.shells?.some(job => job.finishedAt === undefined || isRecentWidgetCompletion(job.finishedAt, snapshot.now))) return true;
  if (snapshot.agents.some((agent) => retention.visible(agent, snapshot))) return true;
  if (snapshot.actors.some((actor) => actor.status !== "stopped")) return true;
  const run = snapshot.runs[0];
  if (!run) return false;
  if (run.status === "running") return true;
  const finishedAt = run.finishedAt ?? run.updatedAt;
  return finishedAt > (snapshot.widgetDismissedAt ?? 0);
};

/**
 * Share of the terminal height the animated box may claim. pi's main-screen
 * renderer scrolls the pane once the rendered content is taller than the
 * terminal, so a box that fills the viewport keeps that scroll region moving on
 * every animation frame — which reads as flicker inside tmux. Half the pane
 * keeps the transcript and editor visible and bounds the box on short panes.
 */
export const WIDGET_TERMINAL_ROW_SHARE = 0.5;

/** Effective row budget: the configured maximum, bounded by the live pane. */
export const widgetRowLimit = (maxRows: number, terminalRows?: number): number => {
  const configured = Math.max(1, maxRows);
  if (terminalRows === undefined || !Number.isFinite(terminalRows) || terminalRows <= 0) {
    return configured;
  }
  const paneShare = Math.floor(terminalRows * WIDGET_TERMINAL_ROW_SHARE);
  return Math.max(1, Math.min(configured, paneShare));
};

/** Keyboard focus must not resize the footer or move the transcript. */
export const widgetFocusedRowLimit = (maxRows: number, terminalRows?: number): number =>
  widgetRowLimit(maxRows, terminalRows);

/** Keep the viewport height fixed, replacing the overflow cue with content at the bottom. */
export const widgetViewport = (contentRows: number, budget: number, offset: number) => {
  const available = Math.max(0, Math.floor(budget));
  // Clamp against a full viewport so the last page has no empty cue slot.
  const maxOffset = available > 0 ? Math.max(0, contentRows - available) : 0;
  const clampedOffset = Math.max(0, Math.min(maxOffset, Math.floor(offset)));
  // At a one-child budget keep that child reachable; there is no room for a cue.
  const hasCue = clampedOffset < maxOffset && available > 1;
  const windowRows = Math.max(0, available - Number(hasCue));
  return { windowRows, hasCue, maxOffset, offset: clampedOffset };
};

/** Pointer-only Main row id; distinct from no hover in the render-cache key. */
const HEADER_ROW = "\0main";

export class FabricWidget implements Component, Focusable {
  constructor(
    readonly theme: Theme,
    readonly snapshot: () => FabricDashboardSnapshot,
    readonly maxRows: number,
    // Live terminal height. pi re-renders the widget on resize, so reading the
    // pane per render bounds the box without a resize subscription.
    readonly terminalRows?: () => number | undefined,
    readonly retention = new FabricWidgetRetention(),
    readonly interaction?: FabricWidgetInteraction,
  ) {}

  /** Set by the TUI when the widget gains or loses keyboard focus. */
  focused = false;
  #selectedId: string | undefined;
  /** Row under the pointer; it draws like the selection, as Claude Code's hover does. */
  #hoveredId: string | undefined;
  /** Selectable rows of the last render, with their line index below the spacer. */
  #rows: Array<FabricWidgetRow & { line: number }> = [];
  /** Rows above the header in the last render: the spacer, or none on a one-row budget. */
  #spacerRows = 1;
  #renderedInteraction: string | undefined;
  #scrollOffset = 0;
  #maxScrollOffset = 0;
  #followSelection = false;

  /** Select the row on screen, or the first row; used when focus arrives from the keyboard. */
  selectDefault(): void {
    const rows = this.#selectableRows();
    if (rows.some((row) => row.id === this.#selectedId)) return;
    const viewing = this.interaction?.viewing?.();
    this.#selectedId = rows.find((row) => row.id === viewing)?.id ?? rows[0]?.id;
    this.#followSelection = true;
  }

  /** Select the top row; ↓ from the editor lands on the row next to it. */
  selectFirst(): void {
    this.#selectedId = this.#selectableRows()[0]?.id;
    this.#followSelection = true;
  }

  /** True while at least one row can take focus. */
  hasRows(): boolean {
    return this.#selectableRows().length > 0;
  }

  #interactionKey(): string {
    return `${this.focused}|${this.#selectedId ?? ""}|${this.#hoveredId ?? ""}|${this.#scrollOffset}|${this.#followSelection}|${this.interaction?.viewing?.() ?? ""}|${this.interaction?.collapseIdle?.() ?? ""}`;
  }

  handleInput(data: string): void {
    // The keyboard takes over from the pointer.
    this.#hoveredId = undefined;
    const rows = this.#selectableRows();
    const index = Math.max(0, rows.findIndex((row) => row.id === this.#selectedId));
    const select = (next: number): void => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, next))];
      if (row) { this.#selectedId = row.id; this.#followSelection = true; }
    };
    if (matchesKey(data, "escape") || matchesKey(data, FABRIC_WIDGET_FOCUS_SHORTCUT)) {
      this.interaction?.release();
    } else if (matchesKey(data, "up") || data === "k") {
      // The editor sits above the list, so ↑ past the top row returns to it.
      if (index === 0 && matchesKey(data, "up")) this.interaction?.release();
      else select(index - 1);
    } else if (matchesKey(data, "down") || data === "j") {
      select(index + 1);
    } else if (matchesKey(data, "enter")) {
      const row = rows[index];
      if (row) this.interaction?.open?.(row);
    } else {
      // Not a widget key: give focus and the key back to the editor, so typing,
      // Ctrl+C, and extension shortcuts still work after a stray click.
      this.interaction?.release(data);
      return;
    }
    this.interaction?.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.interaction) return undefined;
    if (event.type === "wheel") {
      // Only this mounted component's bounds, never the editor/transcript or spacer.
      if (event.x < 0 || event.x >= (this.#lastWidth ?? 0) ||
        event.y < this.#spacerRows || event.y >= (this.#lastLines?.length ?? 0) ||
        this.#maxScrollOffset === 0 || !Number.isFinite(event.wheelDelta) || !event.wheelDelta) return undefined;
      const offset = Math.max(0, Math.min(this.#maxScrollOffset, this.#scrollOffset + Math.trunc(event.wheelDelta)));
      const changed = offset !== this.#scrollOffset;
      this.#scrollOffset = offset;
      this.#followSelection = false;
      this.#hoveredId = undefined;
      return { handled: true, render: changed };
    }
    // The spacer row, when drawn, sits above the header.
    const row = this.#rows.find((candidate) => candidate.line === event.y - this.#spacerRows);
    if (event.type === "move") {
      // Native Main is not a keyboard row, but hovering its header must still
      // override the retained agent selection after a conversation closes.
      // The spacer and outside rows clear hover; pi-tui has no leave event.
      const header = event.y === this.#spacerRows && (this.#lastLines?.length ?? 0) > this.#spacerRows;
      const hoveredId = row?.id ?? (header ? HEADER_ROW : undefined);
      if (hoveredId === this.#hoveredId) return { handled: true };
      this.#hoveredId = hoveredId;
      return { handled: true, render: true };
    }
    if (event.type === "press") return { handled: true };
    if (event.type !== "click" || event.button !== "left") return undefined;
    this.#hoveredId = undefined;
    // Only a row takes focus; a click elsewhere leaves the editor focused.
    if (!row) return undefined;
    this.#selectedId = row.id;
    // A click opens the row like Enter.
    if (this.interaction.open) {
      this.interaction.open(row);
      return { handled: true, render: true };
    }
    return { focus: true, render: true };
  }

  /** Focused keyboard traversal can scroll; pointer targets remain viewport-only. */
  #selectableRows(): FabricWidgetRow[] {
    const budget = this.#rowLimit();
    if (budget === 0) return [];
    const { lines, rows } = this.#content(this.snapshot(), Number.MAX_SAFE_INTEGER);
    const body = Math.max(1, budget - (budget >= 2 ? 1 : 0));
    const viewport = widgetViewport(lines.length - 1, body - 1, this.#scrollOffset);
    return this.focused && body > 1 ? rows : rows.filter((row) => row.line === 0 ||
      (row.line > viewport.offset && row.line <= viewport.offset + viewport.windowRows));
  }

  #rowLimit(width = this.#lastWidth): number {
    const limit = this.focused
      ? widgetFocusedRowLimit(this.maxRows, this.terminalRows?.())
      : widgetRowLimit(this.maxRows, this.terminalRows?.());
    const available = width === undefined ? undefined : this.interaction?.availableRows?.(width);
    return available === undefined || !Number.isFinite(available)
      ? limit : Math.min(limit, Math.max(0, Math.floor(available)));
  }

  #lastWidth: number | undefined;
  #lastLimit: number | undefined;
  #lastSnapshot: FabricDashboardSnapshot | undefined;
  #lastLines: string[] | undefined;
  #pending:
    | { width: number; limit: number; snapshot: FabricDashboardSnapshot; lines: string[] }
    | undefined;

  render(width: number): string[] {
    if (width <= 0) return [];
    const snapshot = this.snapshot();
    // The pane can shrink between renders, so the row budget is part of the
    // cache key: a box measured against a taller terminal must not be reused.
    const limit = this.#rowLimit(width);
    const interactionChanged = this.#renderedInteraction !== this.#interactionKey();
    if (interactionChanged) this.#pending = undefined;
    const lines =
      !interactionChanged &&
      this.#pending?.width === width &&
      this.#pending.limit === limit &&
      this.#pending.snapshot === snapshot
        ? this.#pending.lines
        : !interactionChanged &&
            this.#lastWidth === width &&
            this.#lastLimit === limit &&
            this.#lastSnapshot === snapshot &&
            this.#lastLines
          ? this.#lastLines
          : this.#renderLines(snapshot, width, limit);
    this.#pending = undefined;
    this.#renderedInteraction = this.#interactionKey();
    this.#lastWidth = width;
    this.#lastLimit = limit;
    this.#lastSnapshot = snapshot;
    this.#lastLines = lines;
    this.interaction?.rendered?.();
    return lines;
  }

  hasChanged(): boolean {
    if (this.#lastWidth === undefined || this.#lastLines === undefined) return true;
    const snapshot = this.snapshot();
    const limit = this.#rowLimit();
    const lines = this.#renderLines(snapshot, this.#lastWidth, limit);
    this.#pending = { width: this.#lastWidth, limit, snapshot, lines };
    return (
      lines.length !== this.#lastLines.length ||
      lines.some((line, index) => line !== this.#lastLines?.[index])
    );
  }

  invalidate(): void {
    this.#pending = undefined;
    this.#lastWidth = undefined;
    this.#lastLimit = undefined;
    this.#lastSnapshot = undefined;
    this.#lastLines = undefined;
  }

  /**
   * A blank row separates the list from the footer above it, as in Claude
   * Code. It counts toward the row budget like any other row, so a one-row
   * budget drops it and keeps the header.
   */
  #renderLines(snapshot: FabricDashboardSnapshot, width: number, limit: number): string[] {
    if (limit === 0) { this.#rows = []; this.#spacerRows = 0; return []; }
    const spacer = limit >= 2 ? 1 : 0;
    const body = Math.max(1, limit - spacer);
    let { lines, rows } = this.#content(snapshot, width);
    if (this.#selectedId !== undefined && !rows.some((row) => row.id === this.#selectedId)) {
      this.#selectedId = rows[0]?.id;
      // The selected row draws a filled circle, so redraw with the new selection.
      if (this.focused) ({ lines, rows } = this.#content(snapshot, width));
    }
    if (this.#hoveredId !== undefined && this.#hoveredId !== HEADER_ROW && !rows.some((row) => row.id === this.#hoveredId)) {
      this.#hoveredId = undefined;
    }
    // Pin Main. At the bottom a child replaces the overflow cue, keeping the
    // viewport height fixed without leaving a blank row or moving the footer.
    let viewport = widgetViewport(lines.length - 1, body - 1, this.#scrollOffset);
    if (this.focused && this.#followSelection && viewport.windowRows > 0) {
      const selected = (rows.find(row => row.id === this.#selectedId)?.line ?? 0) - 1;
      let offset = viewport.offset;
      if (selected < offset) offset = Math.max(0, selected);
      else if (selected >= offset + viewport.windowRows) offset = selected - viewport.windowRows + 1;
      viewport = widgetViewport(lines.length - 1, body - 1, offset);
    }
    this.#followSelection = false;
    this.#scrollOffset = viewport.offset;
    this.#maxScrollOffset = viewport.maxOffset;
    const capacity = viewport.windowRows;
    const start = viewport.offset + 1;
    const below = Math.max(0, lines.length - start - capacity);
    const above = viewport.offset;
    const identityWidth = 2 + visibleWidth(safeText(snapshot.sessionLabel ?? "Fabric"));
    const labels = above > 0 ? [`↑ ${above} more`, `↑ ${above}`] : [];
    const fits = (label: string, identity: number) => visibleWidth(label) + 1 + identity <= width;
    const label = labels.find(label => fits(label, identityWidth))
      ?? labels.find(label => fits(label, Math.min(identityWidth, 8)));
    // Fit the header against the reserved space, so hints are dropped whole
    // in priority order rather than cut off when the label is appended.
    const headerWidth = label && width >= visibleWidth(label) + 2 ? width - visibleWidth(label) - 1 : width;
    const header = headerWidth === width ? lines[0] ?? "" : this.#content(snapshot, width, headerWidth).lines[0] ?? "";
    const boundedHeader = label ? this.#withRightLabel(header, label, width) : truncateToWidth(header, width);
    const visibleLines = [boundedHeader, ...lines.slice(start, start + capacity).map(line => truncateToWidth(line, width))];
    if (viewport.hasCue) visibleLines.push(truncateToWidth(this.theme.fg("dim", `↓ ${below} more`), width));
    // Only participant rows, never the overflow footer, are pointer targets.
    this.#rows = rows.filter(row => row.line === 0 || (row.line >= start && row.line < start + capacity))
      .map(row => ({ ...row, line: row.line === 0 ? 0 : row.line - start + 1 }));
    if (rows.length === 0 && this.interaction?.collapseIdle?.()) return [];
    this.#spacerRows = spacer;
    return [...(spacer ? [""] : []), ...visibleLines];
  }

  /** Key hints for the header, most important first; the line fitter drops them from the end. */
  #hints(hasRows: boolean): string[] {
    if (!this.interaction || this.interaction.hints === false) return [];
    if (this.focused) return [...(this.interaction.open ? ["⏎ open"] : []), "↑↓ select", "esc back"];
    return hasRows ? [FABRIC_WIDGET_FOCUS_HINT] : [];
  }

  #content(snapshot: FabricDashboardSnapshot, width: number, headerWidth = width): { lines: string[]; rows: Array<FabricWidgetRow & { line: number }> } {
    const rows: Array<FabricWidgetRow & { line: number }> = [];
    const lines = this.#buildContent(snapshot, rows, width, headerWidth);
    return { lines, rows };
  }

  #buildContent(snapshot: FabricDashboardSnapshot, rows: Array<FabricWidgetRow & { line: number }>, width: number, headerWidth: number): string[] {
    const candidateRun = snapshot.runs[0];
    const candidateFinishedAt = candidateRun?.finishedAt ?? candidateRun?.updatedAt ?? 0;
    const run =
      candidateRun &&
      (candidateRun.status === "running" ||
        candidateFinishedAt > (snapshot.widgetDismissedAt ?? 0))
        ? candidateRun
        : undefined;
    this.retention.sync(snapshot);
    const orderedAgents = orderAgentsByCreation(snapshot.agents);
    const activeAgents = orderedAgents.filter((agent) => isActiveStatus(agent.status));
    const activeAgentIds = new Set(activeAgents.map((agent) => agent.id));
    // Keep settle-time rows stable, then retire each completion independently.
    // Bound only current content: expiry must not leave a high-water blank row.
    const terminalAgents = orderedAgents
      .filter((agent) =>
        !activeAgentIds.has(agent.id) &&
        !isActiveStatus(agent.status) &&
        this.retention.visible(agent, snapshot))
      .sort((left, right) =>
        this.retention.finishedAt(right, snapshot.now) - this.retention.finishedAt(left, snapshot.now));
    const visibleActors = snapshot.actors.filter((actor) => actor.status !== "stopped");
    const activeActorWorkers = visibleActors
      .filter((actor) => actor.worker && isActiveStatus(actor.worker.status))
      .map((actor) => ({ ...actor.worker!, name: actor.name, actorId: actor.id }));
    const terminalActorWorkers = visibleActors
      .filter((actor) => actor.worker && !isActiveStatus(actor.worker.status))
      .map((actor) => ({ ...actor.worker!, name: actor.name, actorId: actor.id }));
    const nestedCalls =
      run?.calls.filter((call) => !isRoutineInternalCall(call) && call.kind !== "agent" && call.kind !== "actor") ?? [];
    const shells = snapshot.shells ?? [];
    const liveShells = shells.filter(job => job.finishedAt === undefined);
    const recentShells = shells.filter(job => job.finishedAt !== undefined && isRecentWidgetCompletion(job.finishedAt, snapshot.now));
    const listedShells = [...liveShells, ...recentShells];
    const headerStatus =
      run?.status ??
      (activeAgents.length > 0 || activeActorWorkers.length > 0 || liveShells.length > 0 ? "running" : "idle");
    const parts: string[] = [];

    const callTotal = nestedCalls.length;
    if (callTotal > 1) {
      const callDone = nestedCalls.filter(
        (call) => call.status === "completed" || call.status === "failed",
      ).length;
      parts.push(`${callDone}/${callTotal} calls`);
    }
    if (run?.currentPhaseId) {
      const phaseIndex = run.phases.findIndex((phase) => phase.id === run.currentPhaseId);
      const phase = run.phases[phaseIndex];
      if (phase) {
        const progress = phaseProgress(run, phase.id);
        parts.push(
          `${phaseIndex + 1}/${run.phases.length} ${safeText(phase.name)}${
            progress.total > 0 ? ` ${progress.completed}/${progress.total}` : ""
          }`,
        );
      }
    }
    if (activeAgents.length > 0) parts.push(`${activeAgents.length} running`);
    if (visibleActors.length > 0) parts.push(`${visibleActors.length} actor${visibleActors.length === 1 ? "" : "s"}`);
    const backgroundWork = liveShells.filter(job => !job.observes);
    const shellCount = backgroundWork.filter(job => job.tool !== "fabric_exec").length;
    const workflowCount = backgroundWork.length - shellCount;
    const observationCount = liveShells.length - backgroundWork.length;
    if (shellCount) parts.push(`${shellCount} shell${shellCount === 1 ? "" : "s"}`);
    if (workflowCount) parts.push(`${workflowCount} workflow${workflowCount === 1 ? "" : "s"}`);
    if (observationCount) parts.push(`${observationCount} observation${observationCount === 1 ? "" : "s"}`);
    const tokens = totalTokens(snapshot, run);
    if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
    const cost = totalCost(snapshot, run);
    if (cost > 0) parts.push(formatCost(cost));
    const elapsed = run && formatDuration((run.finishedAt ?? snapshot.now) - run.startedAt);
    if (elapsed) parts.push(elapsed);

    // One row carries the filled circle: the hovered row, else the selection
    // while focused, else the participant on screen (the main session here).
    const headerId = this.interaction?.mainId ?? HEADER_ROW;
    const marked = this.#hoveredId ??
      (this.focused && this.#selectedId !== undefined ? this.#selectedId : this.interaction?.viewing?.() ?? headerId);

    const participants = [...activeAgents, ...terminalAgents, ...activeActorWorkers, ...terminalActorWorkers];
    const lines: string[] = [];
    // The header is the main session's row.
    const label = safeText(snapshot.sessionLabel ?? "Fabric");
    if (this.interaction?.mainId !== undefined) rows.push({ id: headerId, kind: "main", name: label, line: 0 });
    const hasRows = participants.length > 0 || listedShells.length > 0 || this.interaction?.mainId !== undefined;
    lines.push(fitLine(
      this.theme,
      headerWidth,
      `${colorStatus(this.theme, headerStatus, circle(marked === headerId))} ${this.theme.fg("accent", this.theme.bold(label))}`,
      run?.name ? { text: safeText(run.name), gap: " ", color: "muted" } : undefined,
      parts,
      this.#hints(hasRows),
    ));

    const shownObservations = new Set<string>();
    const pushObservation = (job: FabricShellJobInfo, prefix: string): void => {
      shownObservations.add(job.id);
      rows.push({ id: job.id, kind: "shell", name: safeText(job.description ?? job.command), line: lines.length });
      const active = job.finishedAt === undefined;
      const status = job.stopping ? "stopping" : active ? "watching" : job.status === "timed_out" ? "expired" : job.status === "killed" ? "stopped" : "ended";
      const delivery = job.monitor?.delivery === "wake" ? "wake owner" : "UI only";
      const remaining = active && job.monitor ? ` · expires in ${formatDuration(Math.max(0, job.startedAt + job.monitor.timeoutMs - snapshot.now)) || "0s"}` : "";
      lines.push(fitLine(this.theme, width,
        `${prefix}${colorStatus(this.theme, job.stopping ? "stopping" : job.status, circle(job.id === marked))} ${this.theme.fg("muted", job.id.slice(0, 8))} ${this.theme.fg("muted", `${status} · ${delivery}${remaining}`)}`,
        { text: safeText(job.description ?? `Observe ${job.observes!.kind} ${job.observes!.id.slice(0, 8)}`), gap: " · ", color: "dim" }, [], []));
    };
    const pushObservations = (kind: "task" | "participant", id: string): void => {
      const children = listedShells.filter(job => job.observes?.kind === kind && job.observes.id === id);
      children.forEach((job, index) => pushObservation(job, index === children.length - 1 ? "  ╰─ " : "  ├─ "));
    };
    const pushParticipant = (agent: FabricUiAgent, kind: "agent" | "actor", prefix = ""): void => {
      const id = kind === "actor" ? agent.actorId ?? agent.id : agent.id;
      rows.push({
        id,
        kind,
        name: agent.name,
        ...(agent.model ? { model: agent.model } : {}),
        line: lines.length,
      });
      lines.push(agentLine(this.theme, agent, snapshot.now, prefix, id === marked, width));
      pushObservations("participant", agent.id);
    };
    // Trees with a running root come first, then retained ones; a child always
    // sits under its parent, whatever its own status.
    const liveTrees: Array<{ agent: FabricUiAgent; depth: number; prefix: string }> = [];
    const settledTrees: Array<{ agent: FabricUiAgent; depth: number; prefix: string }> = [];
    let liveRoot = false;
    for (const entry of treeOrder([...activeAgents, ...terminalAgents])) {
      if (entry.depth === 0) liveRoot = isActiveStatus(entry.agent.status);
      (liveRoot ? liveTrees : settledTrees).push(entry);
    }
    for (const { agent, prefix } of liveTrees) pushParticipant(agent, "agent", prefix);
    for (const agent of activeActorWorkers) pushParticipant(agent, "actor");
    for (const agent of terminalActorWorkers) pushParticipant(agent, "actor");
    for (const { agent, prefix } of settledTrees) pushParticipant(agent, "agent", prefix);

    // Shells follow participants. Every selectable row names an exact task;
    // Enter opens its detail, with no separate task-list overlay.
    // The id is the row's name, emphasised like an agent's name.
    const shellLine = (job: FabricShellJobInfo, name: string, detail: string | undefined, id: string): string => {
      const status = job.stopping ? "stopping" : job.status;
      const elapsed = formatDuration((job.finishedAt ?? snapshot.now) - job.startedAt) || "0s";
      const selected = id === marked;
      return fitLine(
        this.theme,
        width,
        `${colorStatus(this.theme, status, circle(selected))} ${selected ? this.theme.bold(name) : this.theme.fg("muted", name)}${
          detail ? ` ${this.theme.fg("muted", detail)}` : ""
        }`,
        { text: safeText(job.description ?? job.command), gap: this.theme.fg("dim", ` · ${elapsed} · `), color: "muted" },
        [],
        [],
      );
    };
    for (const job of listedShells.filter(job => !job.observes)) {
      const status = job.stopping ? "stopping" : job.status;
      const label = job.monitor && job.finishedAt === undefined && !job.stopping ? `monitor:${job.monitor.delivery}` : status;
      rows.push({ id: job.id, kind: "shell", name: safeText(job.description ?? job.command), line: lines.length });
      lines.push(shellLine(job, job.id.slice(0, 8), label, job.id));
      pushObservations("task", job.id);
    }
    // Retain inspectability if a target is no longer in this local view.
    for (const job of listedShells) if (job.observes && !shownObservations.has(job.id)) pushObservation(job, "");
    return lines;
  }

  #withRightLabel(line: string, label: string, width: number): string {
    const labelWidth = visibleWidth(label);
    // Preserve the row marker when the terminal is too narrow for both.
    if (width < labelWidth + 2) return truncateToWidth(line, width);
    const left = truncateToWidth(line, width - labelWidth - 1, "");
    return `${left}${" ".repeat(width - visibleWidth(left) - labelWidth)}${this.theme.fg("dim", label)}`;
  }
}
