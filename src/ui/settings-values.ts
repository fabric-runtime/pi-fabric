import {
  MIN_COMPACTION_RATIO_THRESHOLD,
  MAX_COMPACTION_RATIO_THRESHOLD,
  clampCompactionRatioThreshold,
  QUICKJS_MAX_MEMORY_LIMIT_BYTES,
  type FabricConfig,
  clampCompactionTokenThreshold,
} from "../config.js";
import { INHERIT_VALUE } from "./model-picker.js";
import { DECISION_PROFILE_SETTING_ID, decisionProfileSelection, decisionProfileSummary } from "./settings-decision-profiles.js";
import {
  THINKING_LEVELS,
  thinkingLabel,
} from "../thinking.js";

export const BOOLEANS = ["true", "false"] as const;
export const APPROVAL_MODES = ["allow", "ask", "auto", "deny"] as const;
export const RUNNERS = ["pi-durable", "pi", "claude", "veda"] as const;
export const TRANSPORTS = ["auto", "process", "tmux", "screen", "localterm", "herdr"] as const;
export const WIDGET_MODES = ["auto", "always", "hidden"] as const;
export const TOOL_DISPLAY_MODES = ["full", "compact"] as const;
export const RESULT_FORMATS = ["auto", "yaml", "json", "text"] as const;
export const EXECUTOR_KERNELS = ["typescript", "python"] as const;
export const PYTHON_RUNTIMES = ["monty", "cpython"] as const;
export const EXECUTOR_RUNTIMES = ["quickjs", "node-process", "bun-process"] as const;
export const SCHEMA_MODES = ["off", "audit", "enforce"] as const;
export const COMPACTION_ENGINES = ["fabric", "pi"] as const;
export const COMPACTION_THRESHOLD_SETTING_ID = "compaction.threshold";
export const COMPACTION_DEFAULT_THRESHOLD_LABEL = "Pi default";
export const COMPACTION_PERCENT_OPTION_LABEL = "Custom percent…";
export const COMPACTION_TOKENS_OPTION_LABEL = "Custom tokens…";
export const COMPACTION_PERCENT_MIN = Math.round(MIN_COMPACTION_RATIO_THRESHOLD * 100);
export const COMPACTION_PERCENT_MAX = Math.round(MAX_COMPACTION_RATIO_THRESHOLD * 100);
export const clampCompactionPercentThreshold = (value: number): number =>
  Math.round(clampCompactionRatioThreshold(value / 100) * 100);

export const COMPACTION_TARGET_RATIOS = Array.from(
  { length: 13 },
  (_, index) => String((25 + index * 5) / 100),
);

export const ACTOR_SCOPES = ["project", "session"] as const;
export const DIFF_INTENSITIES = ["off", "subtle", "medium"] as const;
export const WORD_EMPHASES = ["all", "smart", "off"] as const;
export const TOOL_CALL_BACKGROUNDS = ["on", "border", "off"] as const;
export const PATH_ICON_MODES = ["unicode", "nerd", "off"] as const;
export const CODE_PREVIEW_EDIT_LINES_ID = "codePreview.editCollapsedLines";
export const CODE_PREVIEW_ALL_LINES = "All lines";
export const SHIKI_THEME_PRESETS = [
  "auto",
  "github-light/github-dark",
  "light-plus/dark-plus",
  "solarized-light/solarized-dark",
  "catppuccin-latte/catppuccin-mocha",
  "github-light",
  "light-plus",
  "solarized-light",
  "dark-plus",
  "github-dark",
  "solarized-dark",
  "nord",
  "one-dark-pro",
] as const;

export const RISKS = ["read", "write", "execute", "network", "agent"] as const;
export const CORE_RISK_TOOLS = ["read", "grep", "find", "edit", "write", "bash", "powershell"] as const;
export const CORE_DEFAULT_TOOL_CANDIDATES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
export const BUDGET_VALUES = [0, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
export const TOKEN_VALUES = [0, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000];
export const PREWALK_MODEL_UNSET_LABEL = "Ask each time";
export const PREWALK_THINKING_INHERIT_LABEL = "Agents default";
export const PREWALK_MODES = ["in-place", "trajectory"] as const;
export const unique = (values: readonly string[]): string[] => [...new Set(values)];
export const formatDebounce = (ms: number): string =>
  ms === 0 ? "Off" : ms < 1_000 ? `${ms}ms` : `${ms / 1_000}s`;

export const formatMs = (ms: number): string =>
  ms < 1_000
    ? `${ms}ms`
    : ms < 60_000
      ? `${ms / 1_000}s`
      : ms < 3_600_000
        ? `${ms / 60_000}m`
        : `${ms / 3_600_000}h`;

export const formatRetention = (ms: number): string =>
  ms >= 24 * 60 * 60 * 1_000 && ms % (24 * 60 * 60 * 1_000) === 0
    ? `${ms / (24 * 60 * 60 * 1_000)}d`
    : formatMs(ms);

export const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 * 1024
    ? `${Number((bytes / (1024 * 1024 * 1024)).toFixed(2))} GB`
    : bytes >= 1024 * 1024
      ? `${Number((bytes / (1024 * 1024)).toFixed(2))} MB`
      : `${Number((bytes / 1024).toFixed(2))} KB`;

export const executorMemoryLimitOptions = (
  maximumBytes = QUICKJS_MAX_MEMORY_LIMIT_BYTES,
): number[] => {
  const minimumBytes = 16 * 1024 * 1024;
  const values: number[] = [];
  for (let value = minimumBytes; value <= maximumBytes; value *= 2) values.push(value);
  if (maximumBytes >= minimumBytes && values.at(-1) !== maximumBytes) values.push(maximumBytes);
  return values;
};

export const formatUsd = (value: number): string =>
  value <= 0 ? "Off" : `$${value.toFixed(2)}`;

export const formatTokens = (value: number): string =>
  value <= 0
    ? "Off"
    : value >= 1_000_000
      ? `${value / 1_000_000}M`
      : value >= 1_000
        ? `${value / 1_000}k`
        : String(value);

export const formatToolCount = (count: number): string =>
  `${count} ${count === 1 ? "tool" : "tools"}`;

export const formatBlockedCount = (count: number): string =>
  `${count} blocked`;

// The threshold row is a mode selection: Pi default, a window-occupancy
// percent, or an exact token count. mode: "default" clears both maps so Pi's
// built-in threshold applies.
export type CompactionThresholdSelection =
  | { mode: "default" }
  | { mode: "percent"; value: number }
  | { mode: "tokens"; value: number };

export const formatCompactionThreshold = (
  config: FabricConfig,
  modelKey: string,
): string => {
  const tokens = config.compaction.tokenThresholds[modelKey];
  if (tokens !== undefined) return `${formatTokens(tokens)} tokens`;
  const ratio = config.compaction.thresholds[modelKey];
  return ratio === undefined
    ? COMPACTION_DEFAULT_THRESHOLD_LABEL
    : `${Math.round(ratio * 100)}%`;
};

export const compactionThresholdPartial = (
  modelKey: string,
  selection: CompactionThresholdSelection,
): Record<string, unknown> => ({
  compaction: {
    thresholds: { [modelKey]: selection.mode === "percent" ? selection.value : null },
    tokenThresholds: { [modelKey]: selection.mode === "tokens" ? selection.value : null },
  },
});

const getPath = (config: FabricConfig, id: string): unknown => {
  const segments = id.split(".");
  let current: unknown = config;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

export const parseBudgetValue = (value: string): number => {
  if (value === "Off") return 0;
  const digits = Number.parseFloat(value.replace(/[^0-9.]/g, ""));
  return Number.isFinite(digits) ? digits : 0;
};

export const parseFormattedNumericValue = (value: string): number => {
  const normalized = value.trim();
  if (normalized === "Off") return 0;
  if (normalized.startsWith("$")) return parseBudgetValue(normalized);

  const bytes = normalized.match(/^([0-9]+(?:\.[0-9]+)?) (KB|MB|GB)$/);
  if (bytes) {
    const amount = Number(bytes[1]);
    const units = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 } as const;
    return Math.round(amount * units[bytes[2] as keyof typeof units]);
  }

  const duration = normalized.match(/^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h|d)$/);
  if (duration) {
    const amount = Number(duration[1]);
    const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
    return Math.round(amount * units[duration[2] as keyof typeof units]);
  }

  const tokens = normalized.match(/^([0-9]+(?:\.[0-9]+)?)(k|M)$/);
  if (tokens) return Math.round(Number(tokens[1]) * (tokens[2] === "M" ? 1_000_000 : 1_000));
  return Number(normalized.replaceAll(",", ""));
};

export const EXTRACTIVE_OFF = "Off";
export const EXTRACTIVE_LOCAL = "Deterministic only (no classifier)";
export const EXTRACTIVE_CONSENT = "Enable classifier: send bounded user/assistant text; API charges";

export const coerceValue = (id: string, value: string, config: FabricConfig): unknown => {
  if (id === DECISION_PROFILE_SETTING_ID) return decisionProfileSelection(config.jev, value);
  if (id === "mcp.nativeServers") return value.split(",").map(name => name.trim()).filter(Boolean);
  if (id === COMPACTION_THRESHOLD_SETTING_ID) {
    if (value === COMPACTION_DEFAULT_THRESHOLD_LABEL) return { mode: "default" };
    const tokens = /^(.+?) tokens$/.exec(value);
    if (tokens?.[1] !== undefined) {
      return {
        mode: "tokens",
        value: clampCompactionTokenThreshold(parseFormattedNumericValue(tokens[1])),
      };
    }
    return { mode: "percent", value: Number(value.replace("%", "")) / 100 };
  }
  if (id === CODE_PREVIEW_EDIT_LINES_ID) {
    if (value === CODE_PREVIEW_ALL_LINES || value === "all") return "all";
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    const current = getPath(config, id);
    return typeof current === "number" ? current : 160;
  }
  const current = getPath(config, id);
  // prewalk.enabled is enabled by default and omitted from normalized
  // configs unless false, so its control still needs an explicit boolean type.
  if (typeof current === "boolean" || id === "prewalk.enabled") return value === "true";
  if (typeof current === "number") return parseFormattedNumericValue(value);
  // The model picker stores the canonical "provider/id" string, or "Inherit"
  // for no override; persist an empty string so normalizeFabricConfig drops it.
  // Agents inherit; prewalk asks interactively when it is armed.
  if (
    id === "approvals.model" ||
    id === "tuner.proposerModel" ||
    id === "prewalk.model" ||
    id === "agents.model" ||
    id === "agents.claude.model" ||
    id === "agents.veda.model"
  ) {
    return value === INHERIT_VALUE || value === PREWALK_MODEL_UNSET_LABEL ? "" : value;
  }
  if (id === "prewalk.thinking" && value === PREWALK_THINKING_INHERIT_LABEL) return "";
  if (id === "agents.thinking" || id === "prewalk.thinking") {
    return THINKING_LEVELS.find((level) => thinkingLabel(level) === value) ?? value;
  }
  return value;
};

export const buildPartial = (id: string, value: unknown): Record<string, unknown> => {
  if (id === "memory.extractive.mode") return { memory: { extractive: {
    enabled: value === EXTRACTIVE_LOCAL || value === EXTRACTIVE_CONSENT,
    maxEvaluationsPerTurn: value === EXTRACTIVE_CONSENT ? 1 : 0,
  } } };
  if (id === "memory.extractive.classifier" && typeof value === "string") {
    const slash = value.indexOf("/");
    if (slash < 1 || slash === value.length - 1) return {};
    return { memory: { extractive: { provider: value.slice(0, slash), model: value.slice(slash + 1) } } };
  }
  const segments = id.split(".");
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index];
    if (segment === undefined) break;
    const next: Record<string, unknown> = {};
    current[segment] = next;
    current = next;
  }
  const last = segments[segments.length - 1];
  if (last !== undefined) current[last] = value;
  return root;
};

export const summaryFor = (id: string, config: FabricConfig): string => {
  switch (id) {
    case "fullCodeMode":
      return config.fullCodeMode ? "true" : "false";
    case "executor": {
      const refFloors = Object.keys(config.executor.hostCallTimeouts).length;
      const kernel = config.executor.kernel === "python"
        ? `python · ${config.executor.pythonRuntime === "monty" ? "monty" : config.executor.cpython.binary}`
        : `typescript · ${config.executor.runtime}`;
      const hang = config.executor.shellHangMs === 0 ? "hang off" : `hang ${formatMs(config.executor.shellHangMs)}`;
      return `${kernel} · ${formatMs(config.executor.timeoutMs)} · max ${formatMs(config.executor.maxTimeoutMs)} · ${hang}${refFloors > 0 ? ` · ${refFloors} ref floor${refFloors === 1 ? "" : "s"}` : ""}`;
    }
    case "schema":
      return config.schema.mode;
    case "approvals":
      return config.approvals.execute;
    case "decisions":
      return decisionProfileSummary(config.jev);
    case "mcp":
      return config.mcp.enabled
        ? config.mcp.jev.semanticSearch ? "enabled · semantic" : "enabled"
        : "disabled";
    case "prewalk":
      return `${config.prewalk.enabled === false ? "off · " : ""}${config.prewalk.mode} · ${config.prewalk.model || PREWALK_MODEL_UNSET_LABEL}${config.prewalk.thinking ? ` · ${thinkingLabel(config.prewalk.thinking)}` : ""}${config.prewalk.requirePlan ? " · plan" : ""}${config.prewalk.alwaysRearm ? " · repeat" : ""}`;
    case "agents":
      return `${config.agents.runner}/${config.agents.transport}`;
    case "tuner":
      return [config.tuner.enabled ? "rules on" : "rules off", ...(config.tuner.capture ? [config.tuner.autoAccept ? "suggest · auto accept" : "suggest"] : [])].join(" · ");
    case "capture":
      return config.capture.enabled ? "enabled" : "disabled";
    case "ui":
      return config.ui.widget;
    case "memory":
      return config.memory.extractive?.enabled ? (config.memory.extractive.maxEvaluationsPerTurn ? "classifier-assisted" : "deterministic only") : "off";
    case "compaction":
      return config.compaction.engine;
    case "retention":
      return `${formatRetention(config.retention.orphanedTempRunMs)} · ${formatRetention(config.retention.oneShotRunMs)} · ${formatRetention(config.retention.actorRunArchiveMs)}`;
    case "mesh":
      return config.mesh.enabled ? "enabled" : "disabled";
    case "codePreview":
      return config.codePreview.shikiTheme;
    default:
      return "";
  }
};
