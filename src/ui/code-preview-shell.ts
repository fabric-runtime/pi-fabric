// Adapted from pi-code-previews; see THIRD_PARTY_NOTICES.md.
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { continueArcGroup } from "./arc-group.js";
import { animationFitsViewport, type AnimationViewportState } from "./spinner.js";

type ToolCallBackgroundMode = "on" | "border" | "off";
type AnyTool = ToolDefinition<any, any, any>;

export type FabricToolShellDecorator = <TTool extends AnyTool>(
  tool: TTool,
  options?: {
    mode?: ToolCallBackgroundMode;
    preserveSelfShell?: boolean;
    toolCallTiming?: boolean;
    backgroundShortcut?: boolean;
  },
) => TTool;

type PreviewRenderContext = {
  args: unknown;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: Component | undefined;
  state: Record<string, unknown>;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
};

type TimingState = Record<string, unknown> & {
  codePreviewTimingStartedAt?: number;
  codePreviewTimingEndedAt?: number;
  codePreviewTimingInterval?: ReturnType<typeof setInterval>;
  codePreviewTimingOnlyRenderToken?: number;
  codePreviewTimingCallComponent?: Component;
  codePreviewTimingResultComponent?: Component;
  codePreviewTimingViewport?: AnimationViewportState;
  codePreviewTimingLabel?: string;
};

type BorderState = TimingState & {
  codePreviewBorderCallComponent?: Component;
  codePreviewBorderResultComponent?: Component;
  codePreviewBorderShell?: BorderedToolCall;
  codePreviewBorderTheme?: Theme;
  codePreviewBorderLastCallExecutionStarted?: boolean;
  codePreviewBorderLastCallPartial?: boolean;
};

const timingState = (context: { state?: unknown } | undefined): TimingState | undefined =>
  context?.state as TimingState | undefined;

const isTimingOnlyRender = (state: TimingState | undefined): boolean =>
  state?.codePreviewTimingOnlyRenderToken !== undefined;

const unwrapTimingComponent = (component: Component | undefined): Component | undefined =>
  component instanceof TimingPreservedComponent ? component.component : component;

const clearTimingInterval = (state: TimingState): void => {
  if (!state.codePreviewTimingInterval) return;
  clearInterval(state.codePreviewTimingInterval);
  delete state.codePreviewTimingInterval;
  delete state.codePreviewTimingOnlyRenderToken;
};

const ensureTimingInterval = (state: TimingState, invalidate: () => void): void => {
  state.codePreviewTimingInterval ??= setInterval(() => {
    if (!animationFitsViewport(state.codePreviewTimingViewport)) return;
    const token = (state.codePreviewTimingOnlyRenderToken ?? 0) + 1;
    state.codePreviewTimingOnlyRenderToken = token;
    try {
      invalidate();
    } finally {
      queueMicrotask(() => {
        if (state.codePreviewTimingOnlyRenderToken === token) {
          delete state.codePreviewTimingOnlyRenderToken;
        }
      });
    }
  }, 100);
};

const formatDuration = (milliseconds: number): string => {
  const ms = Math.max(0, Math.round(milliseconds));
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
};

const updateTiming = (
  context: PreviewRenderContext,
  enabled: boolean,
  options: { animate?: boolean; formatLabel?: boolean } = {},
): string | undefined => {
  const state = timingState(context);
  if (!state) return undefined;
  if (!enabled) {
    clearTimingInterval(state);
    return undefined;
  }
  if (
    context.executionStarted &&
    state.codePreviewTimingStartedAt === undefined &&
    context.isPartial !== false
  ) {
    state.codePreviewTimingStartedAt = Date.now();
    delete state.codePreviewTimingEndedAt;
  }
  const startedAt = state.codePreviewTimingStartedAt;
  if (startedAt === undefined) return undefined;
  if (context.isPartial && options.animate !== false) {
    ensureTimingInterval(state, context.invalidate);
  } else if (!context.isPartial) {
    state.codePreviewTimingEndedAt ??= Date.now();
    clearTimingInterval(state);
  }
  if (options.formatLabel === false) return undefined;
  const running = context.isPartial;
  if (running && !animationFitsViewport(state.codePreviewTimingViewport)) {
    return state.codePreviewTimingLabel;
  }
  const endedAt = running ? Date.now() : (state.codePreviewTimingEndedAt ?? Date.now());
  const durationMs = endedAt - startedAt;
  if (!Number.isFinite(durationMs) || Math.round(durationMs) <= 0) return undefined;
  const label = `${running ? "Elapsed" : "Took"} ${formatDuration(durationMs)}`;
  state.codePreviewTimingLabel = label;
  return label;
};

class TimingPreservedComponent implements Component {
  constructor(readonly component: Component, private readonly state: TimingState) {}
  render(width: number): string[] {
    return this.component.render(width);
  }
  invalidate(): void {
    if (!isTimingOnlyRender(this.state)) this.component.invalidate?.();
  }
}

class TimingFooter implements Component {
  constructor(
    private readonly component: Component,
    private readonly footer: string,
    private readonly state: TimingState,
  ) {}
  render(width: number): string[] {
    return [
      ...continueArcGroup(this.component.render(width)),
      truncateToWidth(this.footer, width, ""),
    ];
  }
  invalidate(): void {
    if (!isTimingOnlyRender(this.state)) this.component.invalidate?.();
  }
}

const BACKGROUND_SHORTCUT = "(ctrl+b to run in background)";

class BackgroundShortcutFooter implements Component {
  constructor(private readonly component: Component, private readonly theme: Theme) {}
  render(width: number): string[] {
    const lines = this.component.render(width);
    // A nested waiting shell may already have supplied the same connected hint.
    if (width < 12 || lines.some(line => line.includes("ctrl+b"))) return lines;
    return [...continueArcGroup(lines), truncateToWidth(this.theme.fg("muted", `╰─ ${BACKGROUND_SHORTCUT}`), width, "")];
  }
  invalidate(): void { this.component.invalidate?.(); }
}

const renderTimedResult = (
  context: PreviewRenderContext,
  theme: Theme,
  render: (context: PreviewRenderContext) => Component,
  label: string | undefined,
): Component => {
  const state = timingState(context);
  if (!state) return render(context);
  const reused = isTimingOnlyRender(state) ? state.codePreviewTimingResultComponent : undefined;
  const component = reused ?? render({
    ...context,
    lastComponent: unwrapTimingComponent(
      state.codePreviewTimingResultComponent ?? context.lastComponent,
    ),
  });
  state.codePreviewTimingResultComponent = component;
  return label
    ? new TimingFooter(component, theme.fg("muted", `╰─ ${label}`), state)
    : component;
};

const borderState = (context: PreviewRenderContext): BorderState =>
  context.state as BorderState;

const borderColor = (context: PreviewRenderContext): "warning" | "success" | "error" => {
  if (context.isError) return "error";
  return context.isPartial ? "warning" : "success";
};

class BorderedToolCall implements Component {
  private callComponent: Component | undefined;
  private resultComponent: Component | undefined;
  private color: "borderMuted" | "warning" | "success" | "error" = "borderMuted";
  private timingLabel: string | undefined;
  private cachedWidth: number | undefined;
  private cachedRows: string[] | undefined;

  constructor(private readonly theme: Theme, private readonly state: TimingState) {}

  setCall(component: Component | undefined): void {
    this.callComponent = component;
    this.invalidateCache();
  }
  setResult(component: Component | undefined): void {
    this.resultComponent = component;
    this.invalidateCache();
  }
  setColor(color: typeof this.color): void {
    if (color === this.color) return;
    this.color = color;
    this.invalidateCache();
  }
  setTimingLabel(label: string | undefined): void {
    if (label === this.timingLabel) return;
    this.timingLabel = label;
    this.invalidateCache();
  }
  render(width: number): string[] {
    if (width === this.cachedWidth && this.cachedRows) return this.cachedRows;
    const rows = this.renderUncached(width);
    this.cachedWidth = width;
    this.cachedRows = rows;
    return rows;
  }
  invalidate(): void {
    this.invalidateCache();
    if (isTimingOnlyRender(this.state)) return;
    this.callComponent?.invalidate?.();
    this.resultComponent?.invalidate?.();
  }
  private invalidateCache(): void {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
  }
  private renderUncached(width: number): string[] {
    const body = [
      ...(this.callComponent?.render(Math.max(1, width - 4)) ?? []),
      ...(this.resultComponent?.render(Math.max(1, width - 4)) ?? []),
    ];
    (this.state.codePreviewTimingViewport ??= {}).renderedRows = body.length + (width < 4 ? 0 : 2);
    if (width < 4) return body;
    const innerWidth = width - 4;
    const border = (value: string) => this.theme.fg(this.color, value);
    const label = this.timingLabel ? ` ${this.theme.fg("muted", this.timingLabel)} ` : "";
    const labelWidth = visibleWidth(label);
    const top = labelWidth > 0 && labelWidth <= width - 2
      ? `${border("╭")}${border("─".repeat(width - 2 - labelWidth))}${label}${border("╮")}`
      : border(`╭${"─".repeat(width - 2)}╮`);
    return [
      top,
      ...body.map((line) => this.frameLine(line, innerWidth, border)),
      border(`╰${"─".repeat(width - 2)}╯`),
    ];
  }
  private frameLine(
    line: string,
    innerWidth: number,
    border: (value: string) => string,
  ): string {
    const text = truncateToWidth(line, innerWidth, "");
    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(text)));
    const hasDiffBackground = /^\x1b\[48;2;\d+;\d+;\d+m/.test(text);
    return hasDiffBackground
      ? `${border("│")} ${text}${padding} \x1b[49m${border("│")}\x1b[0m`
      : `${border("│")} ${text}\x1b[0m${padding} ${border("│")}`;
  }
}

const shouldRenderResultSeparately = (state: BorderState, isPartial: boolean): boolean =>
  state.codePreviewBorderLastCallPartial === undefined ||
  (state.codePreviewBorderLastCallPartial !== isPartial &&
    state.codePreviewBorderLastCallExecutionStarted === true);

export const withCodePreviewShell: FabricToolShellDecorator = (tool, options = {}) => {
  const mode = options.mode ?? "on";
  const timingEnabled = options.toolCallTiming ?? true;
  if ((options.preserveSelfShell ?? true) && tool.renderShell === "self") return tool;
  const originalRenderCall = tool.renderCall;
  const originalRenderResult = tool.renderResult;
  const renderCall = (args: unknown, theme: Theme, context: PreviewRenderContext): Component =>
    originalRenderCall
      ? originalRenderCall.call(tool, args as never, theme, context as never)
      : new Text(theme.fg("toolTitle", theme.bold(tool.label || tool.name)), 0, 0);
  const renderResult = (
    result: unknown,
    resultOptions: unknown,
    theme: Theme,
    context: PreviewRenderContext,
  ): Component => {
    const component = originalRenderResult
      ? originalRenderResult.call(tool, result as never, resultOptions as never, theme, context as never)
      : new Container();
    const background = typeof context.args === "object" && context.args !== null &&
      (context.args as Record<string, unknown>).background === true;
    return options.backgroundShortcut && context.executionStarted && context.isPartial && !background
      ? new BackgroundShortcutFooter(component, theme) : component;
  };

  return {
    ...tool,
    renderShell: mode === "on" ? "default" : "self",
    renderCall(args, theme, rawContext) {
      if (!rawContext) {
        return originalRenderCall
          ? originalRenderCall.call(tool, args, theme, rawContext)
          : new Text(theme.fg("toolTitle", theme.bold(tool.label || tool.name)), 0, 0);
      }
      const context = rawContext as unknown as PreviewRenderContext;
      if (mode !== "border") {
        const state = timingState(context);
        if (
          context.isPartial &&
          isTimingOnlyRender(state) &&
          state?.codePreviewTimingCallComponent
        ) {
          updateTiming(context, timingEnabled, { animate: false, formatLabel: false });
          return state.codePreviewTimingCallComponent;
        }
        const component = renderCall(args, theme, {
          ...context,
          lastComponent: unwrapTimingComponent(context.lastComponent),
        });
        const wrapped = state
          ? new TimingPreservedComponent(component, state)
          : component;
        if (state) state.codePreviewTimingCallComponent = wrapped;
        updateTiming(context, timingEnabled, { animate: false, formatLabel: false });
        return wrapped;
      }

      const state = borderState(context);
      const timingOnly = context.isPartial && isTimingOnlyRender(state);
      const component = timingOnly && state.codePreviewBorderCallComponent
        ? state.codePreviewBorderCallComponent
        : renderCall(args, theme, {
            ...context,
            lastComponent: state.codePreviewBorderCallComponent,
          });
      const label = updateTiming(context, timingEnabled);
      state.codePreviewBorderCallComponent = component;
      state.codePreviewBorderLastCallExecutionStarted = context.executionStarted;
      state.codePreviewBorderLastCallPartial = context.isPartial;
      const shell = state.codePreviewBorderShell instanceof BorderedToolCall &&
          state.codePreviewBorderTheme === theme
        ? state.codePreviewBorderShell
        : new BorderedToolCall(theme, state);
      shell.setCall(component);
      shell.setResult(state.codePreviewBorderResultComponent);
      shell.setColor(borderColor(context));
      shell.setTimingLabel(label);
      state.codePreviewBorderShell = shell;
      state.codePreviewBorderTheme = theme;
      return shell;
    },
    renderResult(result, resultOptions, theme, rawContext) {
      const context = rawContext as unknown as PreviewRenderContext;
      const optionsRecord = resultOptions as { isPartial: boolean };
      const label = updateTiming(context, timingEnabled);
      if (mode !== "border") {
        return renderTimedResult(
          context,
          theme,
          (next) => renderResult(result, resultOptions, theme, next),
          label,
        );
      }

      const state = borderState(context);
      const timingOnly = context.isPartial && isTimingOnlyRender(state);
      const component = timingOnly && state.codePreviewBorderResultComponent
        ? state.codePreviewBorderResultComponent
        : renderResult(result, resultOptions, theme, {
            ...context,
            lastComponent: state.codePreviewBorderResultComponent,
          });
      state.codePreviewBorderResultComponent = component;
      const shell = state.codePreviewBorderShell instanceof BorderedToolCall &&
          state.codePreviewBorderTheme === theme
        ? state.codePreviewBorderShell
        : new BorderedToolCall(theme, state);
      shell.setCall(state.codePreviewBorderCallComponent);
      shell.setResult(component);
      shell.setColor(borderColor(context));
      shell.setTimingLabel(label);
      state.codePreviewBorderShell = shell;
      state.codePreviewBorderTheme = theme;
      return shouldRenderResultSeparately(state, optionsRecord.isPartial)
        ? component
        : new Container();
    },
  } as typeof tool;
};
