import fs from "node:fs";
import { DEFAULT_JEV_CONFIG, normalizeJevConfig, type FabricJevConfig } from "./jev/config.js";
import { normalizeJevApprovalModel } from "./jev/model-key.js";
export type { FabricJevConfig } from "./jev/config.js";
import os from "node:os";
import path from "node:path";
import { renameAtomic } from "./core/atomic-write.js";
import { approvalActionOverridesValue, type FabricActionApprovalMode } from "./core/approval-overrides.js";
import { foregroundConfigValue, type FabricForegroundConfig } from "./core/foreground-tools.js";
import { quarantineDamagedFile } from "./core/damaged-file.js";
import { normalizeModelAliases, type FabricModelAliases } from "./core/model-resolution.js";
import { PI_CORE_TOOL_NAME_SET } from "./core/pi-tools.js";
import { DEFAULT_SHELL_HANG_MS, SHELL_HANG_MAX_MS } from "./core/shell-limits.js";
import {
  CURRENT_FABRIC_CONFIG_VERSION,
  migrateFabricConfigDocument,
} from "./config-migrations.js";
import type { FabricComponentEntry } from "./components/types.js";
import type { FabricRisk } from "./protocol.js";
import type { FabricKernel } from "./runtime/kernel.js";
import {
  DEFAULT_FABRIC_THINKING,
  FABRIC_THINKING_BOUNDS_ENV,
  inheritedThinkingBounds,
  intersectThinkingBounds,
  isFabricThinking,
  normalizeThinkingBounds,
  type FabricThinking,
  type FabricThinkingBounds,
} from "./thinking.js";
import {
  defaultCodePreviewSettings,
  normalizeCodePreviewSettings,
  type CodePreviewSettings,
} from "./ui/code-preview.js";

type FabricApprovalMode = "allow" | "ask" | "auto" | "deny";
export type FabricAgentTransport =
  | "auto"
  | "process"
  | "tmux"
  | "screen"
  | "localterm"
  | "herdr";
/** Built-in runner ids, or a runner registered through pi-fabric/runners. */
export type FabricAgentRunner = "pi-durable" | "pi" | "claude" | "veda" | (string & {});

/** How a child run's reported model is checked against the requested key.
 * Strict fails the run on a mismatch. Permissive records the reported
 * attribution instead, so virtual provider keys can resolve to a concrete
 * backend at stream time. */
export type FabricModelAdmission = "strict" | "permissive";
export type FabricUiWidgetMode = "auto" | "always" | "hidden";
type FabricToolDisplayMode = "full" | "compact";
export type FabricResultFormat = "auto" | "yaml" | "json" | "text";
export type FabricPrewalkMode = "in-place" | "trajectory";
export type FabricExecutorRuntime = "quickjs" | "node-process" | "bun-process";
export type FabricConfigScope = "global" | "project";
type FabricCompactionEngine = "pi" | "fabric";
type FabricActorScope = "project" | "session";

export type FabricPythonRuntime = "cpython" | "monty";

interface FabricExecutorConfig {
  kernel: FabricKernel;
  pythonRuntime: FabricPythonRuntime;
  cpython: { binary: string };
  /** Optional jev-fabric backend for durable tasks and sessions (macOS/Linux).
   * `binary` empty or "auto" picks the user's compatible install outside the
   * workspace, then the bundled package; an explicit path never falls back.
   * `home` empty means JEV_FABRIC_HOME, else `<cwd>/.jev-fabric-native`, the
   * same store other harnesses share. `timeoutMs` is the default job lifetime. */
  jevFabric: { binary: string; home: string; timeoutMs: number };
  /** TypeScript backend only; ignored by the Python kernel. */
  runtime: FabricExecutorRuntime;
  /** Add native tool aliases, or opt into Pi's script-level naming/result ergonomics. */
  codemodeProfile: "additive" | "native";
  timeoutMs: number;
  /** Policy maximum for any executor deadline, including per-invocation
   * requests and per-ref floors. Values above this are visibly normalized. */
  maxTimeoutMs: number;
  /** Exact-ref deadline floors (ms) for known long-running host calls, e.g.
   * "extensions.subagent". Keys are exact refs; no wildcard matching. */
  hostCallTimeouts: Record<string, number>;
  /** Exact host-call refs that wait for a person, e.g. "extensions.ask" or
   * "decisions.wait".
   * While such a call is in flight the program deadline is paused, so a
   * foreground question can wait indefinitely. Cancellation still applies. */
  humanWaitRefs: string[];
  /** Wait budget for nested pi.bash / pi.powershell (default 2m, max 10m).
   * 0 disables auto-spill. After this, the await settles successfully with a
   * live output path while the process keeps running. `background: true`
   * detaches immediately. Explicit shell timeout remains a hard cap. */
  shellHangMs: number;
  memoryLimitBytes: number;
  maxOutputChars: number;
  maxNestedResultChars: number;
  resultFormat: FabricResultFormat;
}

export interface FabricApprovalConfig {
  read: FabricApprovalMode;
  write: FabricApprovalMode;
  execute: FabricApprovalMode;
  network: FabricApprovalMode;
  agent: FabricApprovalMode;
  model?: string;
  /** Exact `provider.action` or `provider.*` → allow | ask | deny; exact beats wildcard beats risk mode. */
  actions?: Record<string, FabricActionApprovalMode>;
  /** No-UI approvals: "deny" (absent, fail closed) or "decision" (await a durable user decision). */
  headless?: "deny" | "decision";
  /** Headless approval decision deadline; absent means 5 minutes. */
  headlessTimeoutMs?: number;
}

/** Session-start background revalidation scope for the MCP descriptor cache:
 * "changed" lists only added/reconfigured servers, "all" re-lists every known
 * server, "off" never spawns servers in the background. */
type FabricMcpRevalidatePolicy = "changed" | "all" | "off";

interface FabricMcpCacheConfig {
  /** Serve MCP tool metadata from the on-disk descriptor cache instead of
   * connecting to every configured server on first discovery each session. */
  enabled: boolean;
  revalidate: FabricMcpRevalidatePolicy;
  /** Wall-clock budget for one session-start background revalidation pass. */
  revalidateBudgetMs: number;
}

export interface FabricMcpJevConfig {
  /** Opt-in Jev ranking for tools.search({ searchMode: "semantic" }). */
  semanticSearch: boolean;
  /** MCP servers whose tool metadata must not be sent to Jev. Empty allows every server, including ones not yet cached. */
  blockedServers: string[];
  semanticCandidateLimit: number;
  semanticMinProbability: number;
}

const nativeMcpServersValue = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256 || value.some(name =>
    typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name.trim()))) {
    throw new Error("mcp.nativeServers must be an array of at most 256 exact Pi MCP server names (letters, digits, _ and -)");
  }
  return [...new Set(value.map((name: string) => name.trim()))];
};

export interface FabricMcpConfig {
  enabled: boolean;
  /** Opt-in exact server names owned by Pi, never mcporter fallback targets. */
  nativeServers?: string[];
  configPath?: string;
  disableOAuth: boolean;
  allowDynamicServers: boolean;
  callTimeoutMs: number;
  cache: FabricMcpCacheConfig;
  jev: FabricMcpJevConfig;
}

interface FabricClaudeRunnerConfig {
  binary: string;
  model?: string;
}

/** Veda CLI options for the `veda` agent runner. The Veda CLI wraps external
 * backends (agy, codex, claude-code, droid, pi, and any backend registered by
 * the installed Veda build); the backend is selected here and the persona
 * controls read-only vs write-capable behavior. */
interface FabricVedaRunnerConfig {
  binary: string;
  /** Veda backend to drive. Defaults to the Antigravity CLI (agy). */
  backend: string;
  /** Optional backend-specific model or Veda model alias. */
  model?: string;
  /** Veda persona: navigator-plan, navigator-chat, reviewer, or worker. */
  persona: string;
}

interface FabricPrewalkConfig {
  // Master switch, persisted by /fabric prewalk --disable|--enable or the
  // settings UI (absent means enabled). Manual arming, session auto-arm, and
  // boundary claims all gate on it.
  enabled?: boolean;
  mode: FabricPrewalkMode;
  model?: string;
  alwaysRearm: boolean;
  // Compact with the configured engine just before restoring Main's boundary
  // model after an in-place continuation settles.
  compactOnReturn: boolean;
  // Frontier-first planning: the mutation boundary that would hand off instead
  // asks Main to record its plan, and the handoff fires at the next mutation with
  // that plan in the transcript. Upstream prewalk nudges the plan on turn one,
  // before any discovery; this lands on the boundary, after it.
  requirePlan: boolean;
  // Filesystem fallback trigger: when an armed boundary ran a successful
  // pi.bash or pi.powershell without an audited mutation, claim on stat-manifest drift so
  // shell heredocs / sed -i / formatter writes also hand off.
  detectShellWrites: boolean;
  // Reasoning effort for the trajectory executor; unset inherits agents.thinking.
  thinking?: FabricThinking;
}

export interface FabricAgentConfig {
  enabled: boolean;
  runner: FabricAgentRunner;
  transport: FabricAgentTransport;
  model?: string;
  claude: FabricClaudeRunnerConfig;
  veda: FabricVedaRunnerConfig;
  thinking: FabricThinking;
  maxConcurrent: number;
  maxPerExecution: number;
  maxDepth: number;
  timeoutMs: number;
  extensions: boolean;
  defaultTools: string[];
  retainRuns: boolean;
  notifyOnComplete: boolean;
  budgetUsd: number;
  maxTokensPerChild: number;
  /** Write usage-only pi-format session files per agent run for external trackers. */
  sessionExport: boolean;
  /** Export store root override; PI_FABRIC_AGENT_DIR wins. Empty = ~/.pi-fabric/agent. */
  sessionExportDir: string;
  /** Admission policy for the model a child process actually reports. */
  modelAdmission: FabricModelAdmission;
  /** Shell command run in each new agent worktree before the child starts. */
  worktree?: { setup?: string };
  /** Child UI dialogs: "cancel" (absent) or "route" to the parent UI or a decision. */
  childQuestions?: "cancel" | "route";
  /** Routed child question deadline; absent means 10 minutes. */
  childQuestionTimeoutMs?: number;
}

export interface FabricToolCaptureConfig {
  enabled: boolean;
  hideFromModel: boolean;
  keepVisible: string[];
  defaultRisk: FabricRisk;
  risks: Record<string, FabricRisk>;
}

export type FabricSchemaMode = "off" | "audit" | "enforce";

export interface FabricSchemaTrustedCommand {
  command: string;
  args: string[];
  shell: boolean;
  timeoutMs: number;
}

export interface FabricSchemaConfig {
  mode: FabricSchemaMode;
  certificateTtlMs: number;
  maxFiles: number;
  maxBytes: number;
  trustedCommands: Record<string, FabricSchemaTrustedCommand>;
}

interface FabricUiConfig {
  enabled: boolean;
  widget: FabricUiWidgetMode;
  maxRows: number;
  refreshMs: number;
  eventHistory: number;
  haltOnEscape: boolean;
  showAgentToolPreview: boolean;
  toolDisplay: FabricToolDisplayMode;
  updateDebounceMs: number;
}

export interface FabricCompactionPressureBands {
  warn: number;
  urgent: number;
}

interface FabricCompactionConfig {
  engine: FabricCompactionEngine;
  targetContextRatio: number;
  thresholds: Record<string, number>;
  tokenThresholds: Record<string, number>;
  /** Occupancy fractions reported by `compact.pressure()`; 0 < warn < urgent < 1. */
  pressureBands: FabricCompactionPressureBands;
  /** Compact at a settled boundary when window headroom drops below this; 0 disables. */
  outputReserveTokens: number;
  /** Drop orphaned tool results and fill missing ones in outgoing context. */
  repairOrphans: boolean;
}

export const MIN_COMPACTION_TOKEN_THRESHOLD = 1_000;
export const MAX_COMPACTION_TOKEN_THRESHOLD = 100_000_000;
export const MIN_COMPACTION_RATIO_THRESHOLD = 0.25;
export const MAX_COMPACTION_RATIO_THRESHOLD = 0.95;

export const clampCompactionTokenThreshold = (value: number): number =>
  Math.min(
    MAX_COMPACTION_TOKEN_THRESHOLD,
    Math.max(MIN_COMPACTION_TOKEN_THRESHOLD, Math.round(value)),
  );

export const clampCompactionRatioThreshold = (value: number): number =>
  Math.min(
    MAX_COMPACTION_RATIO_THRESHOLD,
    Math.max(MIN_COMPACTION_RATIO_THRESHOLD, value),
  );

export interface FabricRetentionConfig {
  orphanedTempRunMs: number;
  oneShotRunMs: number;
  actorRunArchiveMs: number;
}

export interface FabricMeshConfig {
  enabled: boolean;
  root?: string;
  actorScope: FabricActorScope;
  maxEventBytes: number;
  maxReadEvents: number;
  actorPollMs: number;
  actorQueueLimit: number;
  eventContextChars: number;
  actorContextEntries: number;
  /** Tell a root session's model when other root sessions join or leave the project. */
  peerNotices: boolean;
}

interface FabricRepairsConfig {
  enabled: boolean;
}

interface FabricEntropyConfig {
  compile: boolean;
}

interface FabricTraceConfig {
  /** Persist the opt-in FabricAssessmentTraceV1 (timings, usage) beside the execution trace. */
  assessment: boolean;
}

/** One configured portable memory source (see docs/memory-recall.md). */
export interface FabricMemorySourceConfig {
  /** Registry id used as `args.source` in source-qualified memory calls. */
  id: string;
  /** Adapter kind; `"fs"` walks a local directory of session JSONL files. */
  kind: "fs";
  /** Absolute directory the `fs` adapter enumerates recursively. */
  root: string;
}

export interface FabricExtractiveConfig {
  enabled: boolean;
  provider: string;
  model: string;
  maxViewBytes: number;
  maxCandidates: number;
  maxSourceChars: number;
  /** Zero selects deterministic-only operation. V1 issues at most one batch. */
  maxEvaluationsPerTurn: number;
  timeoutMs: number;
}

export const DEFAULT_EXTRACTIVE_CONFIG: FabricExtractiveConfig = {
  enabled: false, provider: "typesafe", model: "jev-latest",
  maxViewBytes: 8192, maxCandidates: 128, maxSourceChars: 24000,
  maxEvaluationsPerTurn: 1, timeoutMs: 3000,
};

export interface FabricMemoryConfig {
  extractive?: FabricExtractiveConfig;
  enabled: boolean;
  indexDir?: string;
  maxSessions: number;
  maxEntryChars: number;
  indexThinking: boolean;
  indexToolOutput: boolean;
  hotSessions?: number;
  digestTerms?: number;
  maxColdVocabularyBytes?: number;
  maxColdCacheBytes?: number;
  maxSyncSessions?: number;
  maxSyncSourceBytes?: number;
  maxCacheCleanupFiles?: number;
  regexMaxPatternBytes?: number;
  regexMaxHaystackTerms?: number;
  regexMaxHaystackBytes?: number;
  regexTimeoutMs?: number;
  /** Configured portable sources; present enables source-qualified calls. */
  sources?: FabricMemorySourceConfig[];
}

export interface FabricSpeculationConfig {
  /** Master switch for speculative programmatic tool calling during streaming. */
  enabled: boolean;
  /** Maximum simultaneously in-flight speculative calls; excess candidates are dropped. */
  maxConcurrent: number;
  /** Maximum retained unserved speculation entries per turn. */
  maxEntries: number;
  /** Per-stream cap on buffered partial tool-call arguments while extracting the `code` field. */
  maxBufferBytes: number;
  /** Unserved speculation entries older than this are aborted and discarded. */
  entryTtlMs: number;
  /**
   * Tier B: MCP tools that may be speculated despite risk "network". Entries
   * are `server.tool` or `server.*` and match the ref after the `mcp.` prefix.
   * Only enable for tools the operator knows are read-only; cached MCP
   * annotations with destructiveHint=true always refuse.
   */
  mcpAllowlist: string[];
}


export interface FabricModelsConfig {
  /** Alias name → ordered provider/model fallback chain plus an optional default thinking level. */
  aliases: FabricModelAliases;
}

export interface FabricThinkingConfig {
  /** Inclusive host/child thinking bounds; empty means the model's levels. */
  bounds: FabricThinkingBounds;
}

export interface FabricConfig {
  fullCodeMode: boolean;
  executor: FabricExecutorConfig;
  approvals: FabricApprovalConfig;
  mcp: FabricMcpConfig;
  prewalk: FabricPrewalkConfig;
  agents: FabricAgentConfig;
  models: FabricModelsConfig;
  components: FabricComponentEntry[];
  capture: FabricToolCaptureConfig;
  /** Registered tools full code mode keeps declared beside fabric_exec. */
  foreground: FabricForegroundConfig;
  ui: FabricUiConfig;
  compaction: FabricCompactionConfig;
  retention: FabricRetentionConfig;
  mesh: FabricMeshConfig;
  memory: FabricMemoryConfig;
  jev: FabricJevConfig;
  entropy: FabricEntropyConfig;
  repairs: FabricRepairsConfig;
  trace: FabricTraceConfig;
  schema: FabricSchemaConfig;
  speculation: FabricSpeculationConfig;
  thinking: FabricThinkingConfig;
  codePreview: CodePreviewSettings;
}

/** Hard implementation maximum for any executor deadline. Policy ceilings
 * (executor.maxTimeoutMs) may be raised up to this value by administrators. */
export const MAX_EXECUTOR_TIMEOUT_MS = 24 * 3_600_000;

export const MIN_AGENT_TIMEOUT_MS = 1_000;
export const MAX_AGENT_TIMEOUT_MS = 24 * 3_600_000;
/** Default per-run wall-clock budget. It equals the policy ceiling on purpose:
 *  an orchestration program inherits agents.timeoutMs as its own whole-program
 *  deadline floor, so any lower default truncates long participants at a
 *  fraction of the maximum the policy already allows. Narrow one run by setting
 *  agents.timeoutMs explicitly; per-call values can only raise it. */
const DEFAULT_AGENT_TIMEOUT_MS = MAX_AGENT_TIMEOUT_MS;
export const QUICKJS_MAX_MEMORY_LIMIT_BYTES = 0xffff_ffff;
export const MAX_EXECUTOR_MEMORY_LIMIT_BYTES = Math.max(
  8 * 1024 * 1024,
  Math.min(Number.MAX_SAFE_INTEGER, Math.floor(os.totalmem())),
);

export const maxExecutorMemoryLimitBytes = (
  runtime: FabricExecutorRuntime,
  kernel: FabricKernel = "typescript",
): number =>
  kernel === "typescript" && runtime === "quickjs"
    ? Math.min(QUICKJS_MAX_MEMORY_LIMIT_BYTES, MAX_EXECUTOR_MEMORY_LIMIT_BYTES)
    : MAX_EXECUTOR_MEMORY_LIMIT_BYTES;

export const DEFAULT_FABRIC_CONFIG: FabricConfig = {
  fullCodeMode: true,
  executor: {
    kernel: "typescript",
    pythonRuntime: "monty",
    cpython: { binary: "python3" },
    jevFabric: { binary: "", home: "", timeoutMs: 3_600_000 },
    runtime: "quickjs",
    codemodeProfile: "additive",
    timeoutMs: 120_000,
    maxTimeoutMs: 900_000,
    hostCallTimeouts: {},
    humanWaitRefs: ["extensions.ask", "decisions.wait"],
    shellHangMs: DEFAULT_SHELL_HANG_MS,
    memoryLimitBytes: 64 * 1024 * 1024,
    maxOutputChars: 50_000,
    maxNestedResultChars: 2_000_000,
    resultFormat: "auto",
  },
  approvals: {
    read: "allow",
    write: "allow",
    execute: "allow",
    network: "allow",
    agent: "allow",
  },
  mcp: {
    enabled: true,
    nativeServers: [],
    disableOAuth: true,
    allowDynamicServers: true,
    callTimeoutMs: 120_000,
    cache: {
      enabled: true,
      revalidate: "changed",
      revalidateBudgetMs: 60_000,
    },
    jev: {
      semanticSearch: false,
      blockedServers: [],
      semanticCandidateLimit: 127,
      semanticMinProbability: 0.2,
    },
  },
  prewalk: {
    mode: "in-place",
    alwaysRearm: false,
    compactOnReturn: true,
    detectShellWrites: true,
    requirePlan: true,
  },
  agents: {
    enabled: true,
    runner: "pi-durable",
    transport: "process",
    claude: { binary: "claude" },
    veda: { binary: "veda", backend: "agy", persona: "navigator-chat" },
    thinking: DEFAULT_FABRIC_THINKING,
    maxConcurrent: 4,
    maxPerExecution: 100,
    maxDepth: 2,
    timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
    extensions: true,
    defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    retainRuns: false,
    notifyOnComplete: true,
    budgetUsd: 0,
    maxTokensPerChild: 0,
    sessionExport: true,
    sessionExportDir: "",
    modelAdmission: "strict",
  },
  jev: { ...DEFAULT_JEV_CONFIG, credentialCommand: [] },
  components: [],
  capture: {
    enabled: true,
    hideFromModel: true,
    keepVisible: ["fabric_exec"],
    defaultRisk: "execute",
    risks: {
      read: "read",
      grep: "read",
      find: "read",
      ls: "read",
      edit: "write",
      write: "write",
      bash: "execute",
      fovea_sketch: "read",
      fovea_focus: "read",
      fovea_dwell: "read",
      fovea_impact: "read",
    },
  },
  ui: {
    enabled: true,
    widget: "auto",
    maxRows: 6,
    refreshMs: 500,
    eventHistory: 80,
    haltOnEscape: true,
    showAgentToolPreview: true,
    toolDisplay: "compact",
    updateDebounceMs: 100,
  },
  compaction: {
    engine: "fabric",
    targetContextRatio: 0.65,
    thresholds: {},
    tokenThresholds: {},
    pressureBands: { warn: 0.6, urgent: 0.8 },
    outputReserveTokens: 0,
    repairOrphans: true,
  },
  retention: {
    orphanedTempRunMs: 6 * 60 * 60 * 1_000,
    oneShotRunMs: 24 * 60 * 60 * 1_000,
    actorRunArchiveMs: 7 * 24 * 60 * 60 * 1_000,
  },
  mesh: {
    enabled: true,
    actorScope: "project",
    maxEventBytes: 256 * 1024,
    maxReadEvents: 500,
    actorPollMs: 250,
    actorQueueLimit: 32,
    eventContextChars: 40_000,
    actorContextEntries: 14,
    peerNotices: true,
  },
  models: {
    aliases: {},
  },
  memory: {
    extractive: { ...DEFAULT_EXTRACTIVE_CONFIG },
    enabled: true,
    maxSessions: 500,
    maxEntryChars: 2_000,
    indexThinking: false,
    indexToolOutput: true,
    hotSessions: 50,
    digestTerms: 200,
    maxColdVocabularyBytes: 512 * 1024,
    maxColdCacheBytes: 1024 * 1024,
    maxSyncSessions: 10_000,
    maxSyncSourceBytes: 512 * 1024 * 1024,
    maxCacheCleanupFiles: 100_000,
    regexMaxPatternBytes: 1_024,
    regexMaxHaystackTerms: 20_000,
    regexMaxHaystackBytes: 2 * 1024 * 1024,
    regexTimeoutMs: 250,
  },
  entropy: {
    compile: true,
  },
  repairs: {
    enabled: true,
  },
  trace: {
    assessment: false,
  },
  schema: {
    mode: "off",
    certificateTtlMs: 30_000,
    maxFiles: 100,
    maxBytes: 10 * 1024 * 1024,
    trustedCommands: {},
  },
  speculation: {
    enabled: true,
    maxConcurrent: 4,
    maxEntries: 64,
    maxBufferBytes: 2 * 1024 * 1024,
    entryTtlMs: 180_000,
    mcpAllowlist: [],
  },
  thinking: { bounds: {} },
  foreground: { tools: [], maxTools: 4 },
  codePreview: defaultCodePreviewSettings(),
};

interface JsonObjectFile {
  document: Record<string, unknown>;
  source: string;
}

const readJsonObjectFile = (filePath: string): JsonObjectFile | undefined => {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    // Unreadable settings must not take down extension load.
    return undefined;
  }
  if (!source.trim()) return { document: {}, source };
  try {
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      quarantineDamagedFile(filePath);
      return undefined;
    }
    return { document: parsed as Record<string, unknown>, source };
  } catch {
    quarantineDamagedFile(filePath);
    return undefined;
  }
};

const readJsonObject = (filePath: string): Record<string, unknown> | undefined =>
  readJsonObjectFile(filePath)?.document;

const mergeObjects = (
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> => {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = merged[key];
    // Routing documents replace atomically: never splice one provider's route/options
    // into another provider across trusted global/project layers or UI updates.
    if (key === "decisionProfiles") {
      merged[key] = structuredClone(value);
    } else if (
      typeof baseValue === "object" &&
      baseValue !== null &&
      !Array.isArray(baseValue) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      merged[key] = mergeObjects(
        baseValue as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      merged[key] = value;
    }
  }
  return merged;
};

const approvalMode = (value: unknown, fallback: FabricApprovalMode): FabricApprovalMode =>
  value === "allow" || value === "ask" || value === "auto" || value === "deny"
    ? value
    : fallback;

const booleanValue = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const boundedInteger = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : fallback;

const boundedFloat = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

// Inlined copy of RUNNER_ID_PATTERN (src/agents/runner-registry.ts) so config
// never loads the runner registry; tests/runner-registry-graph.test.ts keeps it in sync.
const RUNNER_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

// A registered runner may load after config; launch fails closed if it never does.
const runnerValue = (value: unknown, fallback: FabricAgentRunner): FabricAgentRunner =>
  typeof value === "string" && value.length <= 64 && RUNNER_ID_PATTERN.test(value) ? value : fallback;

const modelAdmissionValue = (
  value: unknown,
  fallback: FabricModelAdmission,
): FabricModelAdmission =>
  value === "strict" || value === "permissive" ? value : fallback;

const prewalkModeValue = (
  value: unknown,
  fallback: FabricPrewalkMode,
): FabricPrewalkMode =>
  value === "in-place" || value === "trajectory" ? value : fallback;

const transportValue = (
  value: unknown,
  fallback: FabricAgentTransport,
): FabricAgentTransport =>
  value === "auto" ||
  value === "process" ||
  value === "tmux" ||
  value === "screen" ||
  value === "localterm" ||
  value === "herdr"
    ? value
    : fallback;

const thinkingValue = (value: unknown, fallback: FabricThinking): FabricThinking =>
  isFabricThinking(value) ? value : fallback;

const humanWaitRefsValue = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value
        .filter((ref): ref is string => typeof ref === "string")
        .map((ref) => ref.trim())
        .filter((ref) => ref.length > 0 && ref.length <= 512))].slice(0, 256)
    : [...DEFAULT_FABRIC_CONFIG.executor.humanWaitRefs];

const objectValue = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const widgetModeValue = (value: unknown, fallback: FabricUiWidgetMode): FabricUiWidgetMode =>
  value === "auto" || value === "always" || value === "hidden" ? value : fallback;

const toolDisplayModeValue = (
  value: unknown,
  fallback: FabricToolDisplayMode,
): FabricToolDisplayMode => value === "full" || value === "compact" ? value : fallback;

const executorKernelValue = (value: unknown, fallback: FabricKernel): FabricKernel =>
  value === "typescript" || value === "python" ? value : fallback;

const executorRuntimeValue = (
  value: unknown,
  fallback: FabricExecutorRuntime,
): FabricExecutorRuntime =>
  value === "quickjs" || value === "node-process" || value === "bun-process" ? value : fallback;

const resultFormatValue = (
  value: unknown,
  fallback: FabricResultFormat,
): FabricResultFormat =>
  value === "auto" || value === "yaml" || value === "json" || value === "text"
    ? value
    : fallback;

const compactionEngineValue = (
  value: unknown,
  fallback: FabricCompactionEngine,
): FabricCompactionEngine =>
  value === "pi" || value === "fabric" ? value : fallback;

// Bands are validated as a pair: any non-finite value or an ordering other
// than 0 < warn < urgent < 1 falls back to the defaults as a whole.
const compactionPressureBandsValue = (
  value: unknown,
  fallback: FabricCompactionPressureBands,
): FabricCompactionPressureBands => {
  const bands = objectValue(value);
  const warn = bands.warn === undefined ? fallback.warn : bands.warn;
  const urgent = bands.urgent === undefined ? fallback.urgent : bands.urgent;
  return typeof warn === "number"
    && typeof urgent === "number"
    && Number.isFinite(warn)
    && Number.isFinite(urgent)
    && warn > 0
    && warn < urgent
    && urgent < 1
    ? { warn, urgent }
    : { ...fallback };
};

const actorScopeValue = (value: unknown, fallback: FabricActorScope): FabricActorScope =>
  value === "project" || value === "session" ? value : fallback;

const schemaModeValue = (value: unknown, fallback: FabricSchemaMode): FabricSchemaMode =>
  value === "off" || value === "audit" || value === "enforce" ? value : fallback;

const mcpRevalidatePolicyValue = (
  value: unknown,
  fallback: FabricMcpRevalidatePolicy,
): FabricMcpRevalidatePolicy =>
  value === "changed" || value === "all" || value === "off" ? value : fallback;

const riskValue = (value: unknown, fallback: FabricRisk): FabricRisk =>
  value === "read" ||
  value === "write" ||
  value === "execute" ||
  value === "network" ||
  value === "agent"
    ? value
    : fallback;

const MEMORY_SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,127}$/;

/**
 * Parse `memory.sources`. A wrong-typed value stays absent like every other
 * memory key, but a present array with malformed entries is a hard config
 * error: a silently dropped source would surface only as a confusing
 * `source_not_found` at call time. The id charset is the portable registry's
 * SOURCE_ID_PATTERN restricted to lowercase.
 */
const memorySourcesValue = (value: unknown): FabricMemorySourceConfig[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const sources: FabricMemorySourceConfig[] = [];
  const seen = new Set<string>();
  value.forEach((raw, index) => {
    const entry = objectValue(raw);
    const where = `memory.sources[${index}]`;
    const id = stringValue(entry.id);
    if (!id || !MEMORY_SOURCE_ID_PATTERN.test(id)) {
      throw new Error(
        `Invalid ${where}: id must be 1-128 chars of lowercase letters, digits, dot, underscore, or dash, starting with a letter or digit`,
      );
    }
    if (entry.kind !== "fs") {
      throw new Error(
        `Invalid ${where}: unknown kind ${JSON.stringify(entry.kind ?? null)}; expected "fs"`,
      );
    }
    const root = stringValue(entry.root);
    if (!root || !path.isAbsolute(root)) {
      throw new Error(`Invalid ${where}: root must be an absolute directory path`);
    }
    if (seen.has(id)) {
      throw new Error(`Invalid ${where}: duplicate source id ${JSON.stringify(id)}`);
    }
    seen.add(id);
    sources.push({ id, kind: "fs", root });
  });
  return sources.length > 0 ? sources : undefined;
};

export const normalizeFabricConfig = (input: Record<string, unknown>): FabricConfig => {
  const executor = objectValue(input.executor);
  const cpython = objectValue(executor.cpython);
  const jevFabric = objectValue(executor.jevFabric);
  const executorKernel = executorKernelValue(executor.kernel, DEFAULT_FABRIC_CONFIG.executor.kernel);
  const executorMaxTimeoutMs = boundedInteger(
    executor.maxTimeoutMs,
    DEFAULT_FABRIC_CONFIG.executor.maxTimeoutMs,
    1_000,
    MAX_EXECUTOR_TIMEOUT_MS,
  );
  const approvals = objectValue(input.approvals);
  const mcp = objectValue(input.mcp);
  const mcpCache = objectValue(mcp.cache);
  const mcpJev = objectValue(mcp.jev);
  const prewalk = objectValue(input.prewalk);
  const agents = objectValue(input.agents);
  const claude = objectValue(agents.claude);
  const veda = objectValue(agents.veda);
  const capture = objectValue(input.capture);
  const ui = objectValue(input.ui);
  const compaction = objectValue(input.compaction);
  const retention = objectValue(input.retention);
  const mesh = objectValue(input.mesh);
  const memory = objectValue(input.memory);
  const extractive = objectValue(memory.extractive);
  const memorySources = memorySourcesValue(memory.sources);
  const entropy = objectValue(input.entropy);
  const repairs = objectValue(input.repairs);
  const trace = objectValue(input.trace);
  const modelsSection = objectValue(input.models);
  const schema = objectValue(input.schema);
  const schemaMode = schemaModeValue(schema.mode, DEFAULT_FABRIC_CONFIG.schema.mode);
  const speculation = objectValue(input.speculation);
  const configuredExecutorRuntime = executorRuntimeValue(
    executor.runtime,
    DEFAULT_FABRIC_CONFIG.executor.runtime,
  );
  const executorRuntime = schemaMode === "enforce" && executorKernel === "typescript"
    ? "quickjs"
    : configuredExecutorRuntime;
  const configuredTools = Array.isArray(agents.defaultTools)
    ? agents.defaultTools.filter(
        (tool): tool is string => typeof tool === "string" && Boolean(tool),
      )
    : DEFAULT_FABRIC_CONFIG.agents.defaultTools;
  const approvalModel = normalizeJevApprovalModel(stringValue(approvals.model));
  const approvalActions = approvalActionOverridesValue(approvals.actions);
  const configPath = stringValue(mcp.configPath);
  const meshRoot = stringValue(mesh.root);
  const memoryIndexDir = stringValue(memory.indexDir);
  const compactionThresholds = Object.fromEntries(
    Object.entries(objectValue(compaction.thresholds))
      .filter(([model, threshold]) =>
        model.includes("/")
        && typeof threshold === "number"
        && Number.isFinite(threshold),
      )
      .map(([model, threshold]) => [
        model,
        clampCompactionRatioThreshold(threshold as number),
      ]),
  );
  const compactionTokenThresholds = Object.fromEntries(
    Object.entries(objectValue(compaction.tokenThresholds))
      .filter(([model, tokens]) =>
        model.includes("/")
        && typeof tokens === "number"
        && Number.isFinite(tokens),
      )
      .map(([model, tokens]) => [
        model,
        clampCompactionTokenThreshold(tokens as number),
      ]),
  );
  const prewalkModel = stringValue(prewalk.model);
  const prewalkThinking = isFabricThinking(prewalk.thinking) ? prewalk.thinking : undefined;
  const agentModel = stringValue(agents.model);
  const claudeBinary = stringValue(claude.binary);
  const claudeModel = stringValue(claude.model);
  const vedaBinary = stringValue(veda.binary);
  const vedaBackend = stringValue(veda.backend);
  const vedaModel = stringValue(veda.model);
  const vedaPersona = stringValue(veda.persona);
  const agentThinking = thinkingValue(agents.thinking, DEFAULT_FABRIC_CONFIG.agents.thinking);
  const configuredComponents: FabricComponentEntry[] = Array.isArray(input.components)
    ? input.components.flatMap((raw) => {
        const componentEntry = objectValue(raw);
        const id = stringValue(componentEntry.id);
        const component = stringValue(componentEntry.component);
        if (!id || !component) return [];
        return [{
          id,
          component,
          ...(Object.prototype.hasOwnProperty.call(componentEntry, "config")
            ? { config: componentEntry.config }
            : {}),
          ...(typeof componentEntry.disabled === "boolean"
            ? { disabled: componentEntry.disabled }
            : {}),
        }];
      }).slice(0, 256)
    : DEFAULT_FABRIC_CONFIG.components;
  const configuredVisible = Array.isArray(capture.keepVisible)
    ? capture.keepVisible.filter(
        (name): name is string => typeof name === "string" && Boolean(name.trim()),
      )
    : DEFAULT_FABRIC_CONFIG.capture.keepVisible;
  const configuredRisks = {
    ...DEFAULT_FABRIC_CONFIG.capture.risks,
    ...objectValue(capture.risks),
  };
  const trustedCommands = Object.fromEntries(
    Object.entries(objectValue(schema.trustedCommands)).flatMap(([name, raw]) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) return [];
      const command = objectValue(raw);
      const executable = stringValue(command.command);
      if (!executable) return [];
      const shell = booleanValue(command.shell, false);
      const args = !shell && Array.isArray(command.args)
        ? command.args.filter((arg): arg is string => typeof arg === "string").slice(0, 64)
        : [];
      return [[name, {
        command: executable,
        args,
        shell,
        timeoutMs: boundedInteger(command.timeoutMs, 30_000, 1, 300_000),
      } satisfies FabricSchemaTrustedCommand]];
    }),
  );
  const risks = Object.fromEntries(
    Object.entries(configuredRisks)
      .filter(([name]) => Boolean(name.trim()))
      .map(([name, risk]) => [name, riskValue(risk, DEFAULT_FABRIC_CONFIG.capture.defaultRisk)]),
  );

  return {
    fullCodeMode: booleanValue(input.fullCodeMode, DEFAULT_FABRIC_CONFIG.fullCodeMode),
    executor: {
      kernel: executorKernel,
      pythonRuntime: executor.pythonRuntime === "cpython" ? "cpython" : "monty",
      cpython: {
        binary: stringValue(cpython.binary)?.trim() ?? DEFAULT_FABRIC_CONFIG.executor.cpython.binary,
      },
      jevFabric: {
        binary: stringValue(jevFabric.binary)?.trim() ?? DEFAULT_FABRIC_CONFIG.executor.jevFabric.binary,
        home: stringValue(jevFabric.home)?.trim() ?? "",
        timeoutMs: boundedInteger(jevFabric.timeoutMs, DEFAULT_FABRIC_CONFIG.executor.jevFabric.timeoutMs, 1_000, MAX_EXECUTOR_TIMEOUT_MS),
      },
      runtime: executorRuntime,
      codemodeProfile: executor.codemodeProfile === "native" ? "native" : "additive",
      maxTimeoutMs: boundedInteger(
        executor.maxTimeoutMs,
        DEFAULT_FABRIC_CONFIG.executor.maxTimeoutMs,
        1_000,
        MAX_EXECUTOR_TIMEOUT_MS,
      ),
      hostCallTimeouts: Object.fromEntries(
        Object.entries(objectValue(executor.hostCallTimeouts))
          .filter(([ref, value]) =>
            typeof ref === "string" &&
            Boolean(ref.trim()) &&
            typeof value === "number" &&
            Number.isFinite(value) &&
            value >= 1,
          )
          .map(([ref, value]) => [ref, boundedInteger(value, 1_000, 1_000, executorMaxTimeoutMs)]),
      ),
      humanWaitRefs: humanWaitRefsValue(executor.humanWaitRefs),
      timeoutMs: boundedInteger(
        executor.timeoutMs,
        DEFAULT_FABRIC_CONFIG.executor.timeoutMs,
        1_000,
        executorMaxTimeoutMs,
      ),
      shellHangMs: boundedInteger(
        executor.shellHangMs,
        DEFAULT_FABRIC_CONFIG.executor.shellHangMs,
        0,
        Math.min(executorMaxTimeoutMs, SHELL_HANG_MAX_MS),
      ),
      memoryLimitBytes: boundedInteger(
        executor.memoryLimitBytes,
        DEFAULT_FABRIC_CONFIG.executor.memoryLimitBytes,
        8 * 1024 * 1024,
        maxExecutorMemoryLimitBytes(executorRuntime, executorKernel),
      ),
      maxOutputChars: boundedInteger(
        executor.maxOutputChars,
        DEFAULT_FABRIC_CONFIG.executor.maxOutputChars,
        1_000,
        1_000_000,
      ),
      maxNestedResultChars: boundedInteger(
        executor.maxNestedResultChars,
        DEFAULT_FABRIC_CONFIG.executor.maxNestedResultChars,
        10_000,
        20_000_000,
      ),
      resultFormat: resultFormatValue(
        executor.resultFormat,
        DEFAULT_FABRIC_CONFIG.executor.resultFormat,
      ),
    },
    approvals: {
      read: approvalMode(approvals.read, DEFAULT_FABRIC_CONFIG.approvals.read),
      write: approvalMode(approvals.write, DEFAULT_FABRIC_CONFIG.approvals.write),
      execute: approvalMode(approvals.execute, DEFAULT_FABRIC_CONFIG.approvals.execute),
      network: approvalMode(approvals.network, DEFAULT_FABRIC_CONFIG.approvals.network),
      agent: approvalMode(approvals.agent, DEFAULT_FABRIC_CONFIG.approvals.agent),
      ...(approvalModel ? { model: approvalModel } : {}),
      ...(approvalActions ? { actions: approvalActions } : {}),
      ...(approvals.headless === "decision" ? { headless: "decision" as const } : {}),
      ...(approvals.headlessTimeoutMs === undefined ? {} : {
        headlessTimeoutMs: boundedInteger(approvals.headlessTimeoutMs, 300_000, 1_000, 86_400_000),
      }),
    },
    mcp: {
      enabled: booleanValue(mcp.enabled, DEFAULT_FABRIC_CONFIG.mcp.enabled),
      nativeServers: nativeMcpServersValue(mcp.nativeServers),
      ...(configPath ? { configPath } : {}),
      disableOAuth: booleanValue(mcp.disableOAuth, DEFAULT_FABRIC_CONFIG.mcp.disableOAuth),
      allowDynamicServers: booleanValue(
        mcp.allowDynamicServers,
        DEFAULT_FABRIC_CONFIG.mcp.allowDynamicServers,
      ),
      callTimeoutMs: boundedInteger(
        mcp.callTimeoutMs,
        DEFAULT_FABRIC_CONFIG.mcp.callTimeoutMs,
        1_000,
        900_000,
      ),
      cache: {
        enabled: booleanValue(mcpCache.enabled, DEFAULT_FABRIC_CONFIG.mcp.cache.enabled),
        revalidate: mcpRevalidatePolicyValue(
          mcpCache.revalidate,
          DEFAULT_FABRIC_CONFIG.mcp.cache.revalidate,
        ),
        revalidateBudgetMs: boundedInteger(
          mcpCache.revalidateBudgetMs,
          DEFAULT_FABRIC_CONFIG.mcp.cache.revalidateBudgetMs,
          1_000,
          600_000,
        ),
      },
      jev: {
        semanticSearch: booleanValue(
          mcpJev.semanticSearch,
          DEFAULT_FABRIC_CONFIG.mcp.jev.semanticSearch,
        ),
        blockedServers: Array.isArray(mcpJev.blockedServers)
          ? [...new Set(
              mcpJev.blockedServers.flatMap((name) => {
                if (typeof name !== "string") return [];
                const trimmed = name.trim();
                return trimmed.length > 0 && trimmed.length <= 128 ? [trimmed] : [];
              }),
            )].slice(0, 256)
          : [...DEFAULT_FABRIC_CONFIG.mcp.jev.blockedServers],
        semanticCandidateLimit: boundedInteger(
          mcpJev.semanticCandidateLimit,
          DEFAULT_FABRIC_CONFIG.mcp.jev.semanticCandidateLimit,
          2,
          127,
        ),
        semanticMinProbability:
          typeof mcpJev.semanticMinProbability === "number" &&
          Number.isFinite(mcpJev.semanticMinProbability) &&
          mcpJev.semanticMinProbability >= 0 &&
          mcpJev.semanticMinProbability <= 1
            ? mcpJev.semanticMinProbability
            : DEFAULT_FABRIC_CONFIG.mcp.jev.semanticMinProbability,
      },
    },
    prewalk: {
      ...(prewalk.enabled === false ? { enabled: false } : {}),
      mode: prewalkModeValue(prewalk.mode, DEFAULT_FABRIC_CONFIG.prewalk.mode),
      ...(prewalkModel ? { model: prewalkModel } : {}),
      ...(prewalkThinking ? { thinking: prewalkThinking } : {}),
      alwaysRearm: booleanValue(
        prewalk.alwaysRearm,
        DEFAULT_FABRIC_CONFIG.prewalk.alwaysRearm,
      ),
      compactOnReturn: booleanValue(
        prewalk.compactOnReturn,
        DEFAULT_FABRIC_CONFIG.prewalk.compactOnReturn,
      ),
      detectShellWrites: booleanValue(
        prewalk.detectShellWrites,
        DEFAULT_FABRIC_CONFIG.prewalk.detectShellWrites,
      ),
      requirePlan: booleanValue(
        prewalk.requirePlan,
        DEFAULT_FABRIC_CONFIG.prewalk.requirePlan,
      ),
    },
    agents: {
      enabled: booleanValue(agents.enabled, DEFAULT_FABRIC_CONFIG.agents.enabled),
      runner: runnerValue(agents.runner, DEFAULT_FABRIC_CONFIG.agents.runner),
      transport: transportValue(agents.transport, DEFAULT_FABRIC_CONFIG.agents.transport),
      ...(agentModel ? { model: agentModel } : {}),
      claude: {
        binary: claudeBinary ?? DEFAULT_FABRIC_CONFIG.agents.claude.binary,
        ...(claudeModel ? { model: claudeModel } : {}),
      },
      veda: {
        binary: vedaBinary ?? DEFAULT_FABRIC_CONFIG.agents.veda.binary,
        backend: vedaBackend ?? DEFAULT_FABRIC_CONFIG.agents.veda.backend,
        ...(vedaModel ? { model: vedaModel } : {}),
        persona: vedaPersona ?? DEFAULT_FABRIC_CONFIG.agents.veda.persona,
      },
      thinking: agentThinking,
      maxConcurrent: boundedInteger(
        agents.maxConcurrent,
        DEFAULT_FABRIC_CONFIG.agents.maxConcurrent,
        1,
        32,
      ),
      maxPerExecution: boundedInteger(
        agents.maxPerExecution,
        DEFAULT_FABRIC_CONFIG.agents.maxPerExecution,
        1,
        1_000,
      ),
      maxDepth: boundedInteger(
        agents.maxDepth,
        DEFAULT_FABRIC_CONFIG.agents.maxDepth,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      timeoutMs: boundedInteger(
        agents.timeoutMs,
        DEFAULT_FABRIC_CONFIG.agents.timeoutMs,
        MIN_AGENT_TIMEOUT_MS,
        MAX_AGENT_TIMEOUT_MS,
      ),
      extensions: booleanValue(agents.extensions, DEFAULT_FABRIC_CONFIG.agents.extensions),
      defaultTools: configuredTools,
      retainRuns: booleanValue(agents.retainRuns, DEFAULT_FABRIC_CONFIG.agents.retainRuns),
      notifyOnComplete: booleanValue(
        agents.notifyOnComplete,
        DEFAULT_FABRIC_CONFIG.agents.notifyOnComplete,
      ),
      budgetUsd: boundedFloat(
        agents.budgetUsd,
        DEFAULT_FABRIC_CONFIG.agents.budgetUsd,
        0,
        1_000_000,
      ),
      maxTokensPerChild: boundedInteger(
        agents.maxTokensPerChild,
        DEFAULT_FABRIC_CONFIG.agents.maxTokensPerChild,
        0,
        100_000_000,
      ),
      sessionExport: booleanValue(
        agents.sessionExport,
        DEFAULT_FABRIC_CONFIG.agents.sessionExport,
      ),
      sessionExportDir:
        typeof agents.sessionExportDir === "string"
          ? agents.sessionExportDir
          : DEFAULT_FABRIC_CONFIG.agents.sessionExportDir,
      modelAdmission: modelAdmissionValue(
        agents.modelAdmission,
        DEFAULT_FABRIC_CONFIG.agents.modelAdmission,
      ),
      ...(stringValue(objectValue(agents.worktree).setup)
        ? { worktree: { setup: String(objectValue(agents.worktree).setup).trim() } }
        : {}),
      ...(agents.childQuestions === "route" ? { childQuestions: "route" as const } : {}),
      ...(agents.childQuestionTimeoutMs === undefined ? {} : {
        childQuestionTimeoutMs: boundedInteger(agents.childQuestionTimeoutMs, 600_000, 1_000, 86_400_000),
      }),
    },
    jev: normalizeJevConfig(input.jev),
    components: configuredComponents.map((entry) => structuredClone(entry)),
    capture: {
      enabled: booleanValue(capture.enabled, DEFAULT_FABRIC_CONFIG.capture.enabled),
      hideFromModel: booleanValue(
        capture.hideFromModel,
        DEFAULT_FABRIC_CONFIG.capture.hideFromModel,
      ),
      keepVisible: [...new Set(configuredVisible)],
      defaultRisk: riskValue(capture.defaultRisk, DEFAULT_FABRIC_CONFIG.capture.defaultRisk),
      risks,
    },
    ui: {
      enabled: booleanValue(ui.enabled, DEFAULT_FABRIC_CONFIG.ui.enabled),
      widget: widgetModeValue(ui.widget, DEFAULT_FABRIC_CONFIG.ui.widget),
      maxRows: boundedInteger(ui.maxRows, DEFAULT_FABRIC_CONFIG.ui.maxRows, 1, 20),
      refreshMs: boundedInteger(ui.refreshMs, DEFAULT_FABRIC_CONFIG.ui.refreshMs, 100, 10_000),
      eventHistory: boundedInteger(
        ui.eventHistory,
        DEFAULT_FABRIC_CONFIG.ui.eventHistory,
        1,
        500,
      ),
      haltOnEscape: booleanValue(ui.haltOnEscape, DEFAULT_FABRIC_CONFIG.ui.haltOnEscape),
      // Renamed from ui.showNestedToolCalls; the v2 migration rewrites persisted
      // files, and this fallback covers configs normalized without migration.
      showAgentToolPreview: booleanValue(
        ui.showAgentToolPreview ?? ui.showNestedToolCalls,
        DEFAULT_FABRIC_CONFIG.ui.showAgentToolPreview,
      ),
      toolDisplay: toolDisplayModeValue(
        ui.toolDisplay,
        DEFAULT_FABRIC_CONFIG.ui.toolDisplay,
      ),
      // Renamed from ui.nestedToolDebounceMs (v3): the window coalesces every
      // live fabric_exec card update — nested calls, progress, agent previews.
      updateDebounceMs: boundedInteger(
        ui.updateDebounceMs ?? ui.nestedToolDebounceMs,
        DEFAULT_FABRIC_CONFIG.ui.updateDebounceMs,
        0,
        2_000,
      ),
    },
    compaction: {
      engine: compactionEngineValue(compaction.engine, DEFAULT_FABRIC_CONFIG.compaction.engine),
      targetContextRatio: boundedFloat(
        compaction.targetContextRatio,
        DEFAULT_FABRIC_CONFIG.compaction.targetContextRatio,
        0.25,
        0.85,
      ),
      thresholds: compactionThresholds,
      tokenThresholds: compactionTokenThresholds,
      pressureBands: compactionPressureBandsValue(
        compaction.pressureBands,
        DEFAULT_FABRIC_CONFIG.compaction.pressureBands,
      ),
      outputReserveTokens: boundedInteger(
        compaction.outputReserveTokens,
        DEFAULT_FABRIC_CONFIG.compaction.outputReserveTokens,
        0,
        MAX_COMPACTION_TOKEN_THRESHOLD,
      ),
      repairOrphans: booleanValue(
        compaction.repairOrphans,
        DEFAULT_FABRIC_CONFIG.compaction.repairOrphans,
      ),
    },
    retention: {
      orphanedTempRunMs: boundedInteger(
        retention.orphanedTempRunMs,
        DEFAULT_FABRIC_CONFIG.retention.orphanedTempRunMs,
        60 * 60 * 1_000,
        365 * 24 * 60 * 60 * 1_000,
      ),
      oneShotRunMs: boundedInteger(
        retention.oneShotRunMs,
        DEFAULT_FABRIC_CONFIG.retention.oneShotRunMs,
        60 * 60 * 1_000,
        365 * 24 * 60 * 60 * 1_000,
      ),
      actorRunArchiveMs: boundedInteger(
        retention.actorRunArchiveMs,
        DEFAULT_FABRIC_CONFIG.retention.actorRunArchiveMs,
        60 * 60 * 1_000,
        365 * 24 * 60 * 60 * 1_000,
      ),
    },
    mesh: {
      enabled: booleanValue(mesh.enabled, DEFAULT_FABRIC_CONFIG.mesh.enabled),
      ...(meshRoot ? { root: meshRoot } : {}),
      actorScope: actorScopeValue(mesh.actorScope, DEFAULT_FABRIC_CONFIG.mesh.actorScope),
      maxEventBytes: boundedInteger(
        mesh.maxEventBytes,
        DEFAULT_FABRIC_CONFIG.mesh.maxEventBytes,
        1_024,
        4 * 1024 * 1024,
      ),
      maxReadEvents: boundedInteger(
        mesh.maxReadEvents,
        DEFAULT_FABRIC_CONFIG.mesh.maxReadEvents,
        1,
        10_000,
      ),
      actorPollMs: boundedInteger(
        mesh.actorPollMs,
        DEFAULT_FABRIC_CONFIG.mesh.actorPollMs,
        50,
        10_000,
      ),
      actorQueueLimit: boundedInteger(
        mesh.actorQueueLimit,
        DEFAULT_FABRIC_CONFIG.mesh.actorQueueLimit,
        1,
        1_000,
      ),
      eventContextChars: boundedInteger(
        mesh.eventContextChars,
        DEFAULT_FABRIC_CONFIG.mesh.eventContextChars,
        1_000,
        1_000_000,
      ),
      actorContextEntries: boundedInteger(
        mesh.actorContextEntries,
        DEFAULT_FABRIC_CONFIG.mesh.actorContextEntries,
        1,
        100,
      ),
      peerNotices: booleanValue(mesh.peerNotices, DEFAULT_FABRIC_CONFIG.mesh.peerNotices),
    },
    models: {
      aliases: normalizeModelAliases(modelsSection.aliases),
    },
    memory: {
      extractive: {
        enabled: booleanValue(extractive.enabled, false),
        provider: stringValue(extractive.provider) || DEFAULT_EXTRACTIVE_CONFIG.provider,
        model: stringValue(extractive.model) || DEFAULT_EXTRACTIVE_CONFIG.model,
        maxViewBytes: boundedInteger(extractive.maxViewBytes, 8192, 1024, 32768),
        maxCandidates: boundedInteger(extractive.maxCandidates, 128, 1, 256),
        maxSourceChars: boundedInteger(extractive.maxSourceChars, 24000, 256, 100000),
        maxEvaluationsPerTurn: boundedInteger(extractive.maxEvaluationsPerTurn, 1, 0, 1),
        timeoutMs: boundedInteger(extractive.timeoutMs, 3000, 100, 10000),
      },
      enabled: booleanValue(memory.enabled, DEFAULT_FABRIC_CONFIG.memory.enabled),
      ...(memoryIndexDir ? { indexDir: memoryIndexDir } : {}),
      ...(memorySources ? { sources: memorySources } : {}),
      maxSessions: boundedInteger(
        memory.maxSessions,
        DEFAULT_FABRIC_CONFIG.memory.maxSessions,
        1,
        100_000,
      ),
      maxEntryChars: boundedInteger(
        memory.maxEntryChars,
        DEFAULT_FABRIC_CONFIG.memory.maxEntryChars,
        100,
        1_000_000,
      ),
      indexThinking: booleanValue(
        memory.indexThinking,
        DEFAULT_FABRIC_CONFIG.memory.indexThinking ?? false,
      ),
      indexToolOutput: booleanValue(
        memory.indexToolOutput,
        DEFAULT_FABRIC_CONFIG.memory.indexToolOutput ?? true,
      ),
      hotSessions: boundedInteger(
        memory.hotSessions,
        DEFAULT_FABRIC_CONFIG.memory.hotSessions ?? 50,
        0,
        100_000,
      ),
      digestTerms: boundedInteger(
        memory.digestTerms,
        DEFAULT_FABRIC_CONFIG.memory.digestTerms ?? 200,
        1,
        10_000,
      ),
      maxColdVocabularyBytes: boundedInteger(
        memory.maxColdVocabularyBytes,
        DEFAULT_FABRIC_CONFIG.memory.maxColdVocabularyBytes ?? 512 * 1024,
        2,
        64 * 1024 * 1024,
      ),
      maxColdCacheBytes: boundedInteger(
        memory.maxColdCacheBytes,
        DEFAULT_FABRIC_CONFIG.memory.maxColdCacheBytes ?? 1024 * 1024,
        512,
        128 * 1024 * 1024,
      ),
      maxSyncSessions: boundedInteger(
        memory.maxSyncSessions,
        DEFAULT_FABRIC_CONFIG.memory.maxSyncSessions ?? 10_000,
        1,
        1_000_000,
      ),
      maxSyncSourceBytes: boundedInteger(
        memory.maxSyncSourceBytes,
        DEFAULT_FABRIC_CONFIG.memory.maxSyncSourceBytes ?? 512 * 1024 * 1024,
        1_024,
        8 * 1024 * 1024 * 1024,
      ),
      maxCacheCleanupFiles: boundedInteger(
        memory.maxCacheCleanupFiles,
        DEFAULT_FABRIC_CONFIG.memory.maxCacheCleanupFiles ?? 100_000,
        1,
        1_000_000,
      ),
      regexMaxPatternBytes: boundedInteger(
        memory.regexMaxPatternBytes,
        DEFAULT_FABRIC_CONFIG.memory.regexMaxPatternBytes ?? 1_024,
        1,
        64 * 1024,
      ),
      regexMaxHaystackTerms: boundedInteger(
        memory.regexMaxHaystackTerms,
        DEFAULT_FABRIC_CONFIG.memory.regexMaxHaystackTerms ?? 20_000,
        1,
        1_000_000,
      ),
      regexMaxHaystackBytes: boundedInteger(
        memory.regexMaxHaystackBytes,
        DEFAULT_FABRIC_CONFIG.memory.regexMaxHaystackBytes ?? 2 * 1024 * 1024,
        1_024,
        128 * 1024 * 1024,
      ),
      regexTimeoutMs: boundedInteger(
        memory.regexTimeoutMs,
        DEFAULT_FABRIC_CONFIG.memory.regexTimeoutMs ?? 250,
        10,
        10_000,
      ),
    },
    entropy: {
      compile: booleanValue(entropy.compile, DEFAULT_FABRIC_CONFIG.entropy.compile),
    },
    repairs: {
      enabled: booleanValue(repairs.enabled, DEFAULT_FABRIC_CONFIG.repairs.enabled),
    },
    trace: {
      assessment: booleanValue(trace.assessment, DEFAULT_FABRIC_CONFIG.trace.assessment),
    },
    schema: {
      mode: schemaMode,
      certificateTtlMs: boundedInteger(
        schema.certificateTtlMs,
        DEFAULT_FABRIC_CONFIG.schema.certificateTtlMs,
        1_000,
        10 * 60_000,
      ),
      maxFiles: boundedInteger(
        schema.maxFiles,
        DEFAULT_FABRIC_CONFIG.schema.maxFiles,
        1,
        1_000,
      ),
      maxBytes: boundedInteger(
        schema.maxBytes,
        DEFAULT_FABRIC_CONFIG.schema.maxBytes,
        1_024,
        100 * 1024 * 1024,
      ),
      trustedCommands,
    },
    speculation: {
      enabled: booleanValue(
        speculation.enabled,
        DEFAULT_FABRIC_CONFIG.speculation.enabled,
      ),
      maxConcurrent: boundedInteger(
        speculation.maxConcurrent,
        DEFAULT_FABRIC_CONFIG.speculation.maxConcurrent,
        1,
        32,
      ),
      maxEntries: boundedInteger(
        speculation.maxEntries,
        DEFAULT_FABRIC_CONFIG.speculation.maxEntries,
        1,
        1_024,
      ),
      maxBufferBytes: boundedInteger(
        speculation.maxBufferBytes,
        DEFAULT_FABRIC_CONFIG.speculation.maxBufferBytes,
        64 * 1024,
        64 * 1024 * 1024,
      ),
      entryTtlMs: boundedInteger(
        speculation.entryTtlMs,
        DEFAULT_FABRIC_CONFIG.speculation.entryTtlMs,
        5_000,
        30 * 60_000,
      ),
      mcpAllowlist: [
        ...new Set(
          (Array.isArray(speculation.mcpAllowlist) ? speculation.mcpAllowlist : [])
            .filter(
            (entry): entry is string =>
              typeof entry === "string" && entry.trim().length > 0,
          )
            .map((entry) => entry.trim().slice(0, 256)),
        ),
      ].slice(0, 256),
    },
    thinking: {
      // Bounds are a ceiling policy: malformed values fail closed.
      bounds: normalizeThinkingBounds(objectValue(input.thinking).bounds, "thinking.bounds"),
    },
    // Malformed entries fail config loading; semantic refusals report at runtime.
    foreground: foregroundConfigValue(input.foreground),
    codePreview: normalizeCodePreviewSettings(input.codePreview),
  };
};

export const effectiveToolCaptureConfig = (
  config: Pick<FabricConfig, "fullCodeMode" | "capture"> & Partial<Pick<FabricConfig, "schema">>,
): FabricToolCaptureConfig =>
  config.schema?.mode === "enforce"
    ? {
        ...config.capture,
        enabled: true,
        hideFromModel: true,
        keepVisible: ["fabric_exec"],
        risks: { ...config.capture.risks },
      }
    : config.fullCodeMode
      ? {
          ...config.capture,
          keepVisible: config.capture.keepVisible.filter(
            (name) => !PI_CORE_TOOL_NAME_SET.has(name),
          ),
          risks: { ...config.capture.risks },
        }
      : {
          ...config.capture,
          enabled: false,
          hideFromModel: false,
          keepVisible: [...config.capture.keepVisible],
          risks: { ...config.capture.risks },
        };

interface FabricConfigFilePlan {
  path: string;
  document: Record<string, unknown>;
  source: string;
  changed: boolean;
}

const planConfigFile = (filePath: string): FabricConfigFilePlan | undefined => {
  const input = readJsonObjectFile(filePath);
  if (!input) return undefined;
  const migration = migrateFabricConfigDocument(input.document);
  return {
    path: filePath,
    document: migration.document,
    source: input.source,
    changed: migration.changed,
  };
};

export const writeJsonAtomic = (
  filePath: string,
  document: Record<string, unknown>,
  expectedSource: string | null,
): void => {
  const resolvedPath = fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;
  const directory = path.dirname(resolvedPath);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  const mode = fs.existsSync(resolvedPath) ? fs.statSync(resolvedPath).mode & 0o777 : 0o600;
  const temporaryPath = path.join(
    directory,
    `.${path.basename(resolvedPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", mode);
    fs.writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (expectedSource === null) {
      if (fs.existsSync(resolvedPath)) {
        throw new Error(`Fabric configuration changed while updating ${filePath}`);
      }
    } else {
      let currentSource: string;
      try {
        currentSource = fs.readFileSync(resolvedPath, "utf8");
      } catch (error) {
        throw new Error(`Fabric configuration changed while updating ${filePath}`, { cause: error });
      }
      if (currentSource !== expectedSource) {
        throw new Error(`Fabric configuration changed while updating ${filePath}`);
      }
    }
    renameAtomic(temporaryPath, resolvedPath);
    try {
      const directoryDescriptor = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM") throw error;
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
};

const resolveFabricConfig = (
  options: {
    cwd: string;
    agentDir: string;
  },
  includeProject: boolean,
  applyEnvironmentOverrides: boolean,
): FabricConfig => {
  let merged = structuredClone(DEFAULT_FABRIC_CONFIG) as unknown as Record<string, unknown>;
  const plans = [
    planConfigFile(path.join(options.agentDir, "fabric.json")),
    ...(includeProject
      ? [planConfigFile(path.join(options.cwd, ".pi", "fabric.json"))]
      : []),
  ].filter((plan): plan is FabricConfigFilePlan => plan !== undefined);
  for (const plan of plans) {
    if (plan.changed) writeJsonAtomic(plan.path, plan.document, plan.source);
    merged = mergeObjects(merged, plan.document);
  }
  const inheritedKernel = process.env.PI_FABRIC_KERNEL;
  if (applyEnvironmentOverrides && inheritedKernel !== undefined) {
    // This can select trusted native execution: never repair an unsafe selector.
    if (inheritedKernel !== "typescript" && inheritedKernel !== "python") {
      throw new Error(`Invalid PI_FABRIC_KERNEL: ${inheritedKernel}; expected typescript or python`);
    }
    merged.executor = { ...objectValue(merged.executor), kernel: inheritedKernel };
  }
  const inheritedPythonRuntime = process.env.PI_FABRIC_PYTHON_RUNTIME;
  if (applyEnvironmentOverrides && inheritedPythonRuntime !== undefined) {
    if (inheritedPythonRuntime !== "cpython" && inheritedPythonRuntime !== "monty") {
      throw new Error(`Invalid PI_FABRIC_PYTHON_RUNTIME: ${inheritedPythonRuntime}; expected cpython or monty`);
    }
    merged.executor = { ...objectValue(merged.executor), pythonRuntime: inheritedPythonRuntime };
  }
  const inheritedFullCodeMode = process.env.PI_FABRIC_FULL_CODE_MODE;
  if (
    applyEnvironmentOverrides &&
    (inheritedFullCodeMode === "true" || inheritedFullCodeMode === "false")
  ) {
    merged.fullCodeMode = inheritedFullCodeMode === "true";
  }
  const normalized = normalizeFabricConfig(merged);
  if (applyEnvironmentOverrides && process.env[FABRIC_THINKING_BOUNDS_ENV] !== undefined) {
    // A child only narrows its own bounds by the parent's; never widens them.
    const inherited = inheritedThinkingBounds();
    if (inherited) {
      normalized.thinking.bounds = intersectThinkingBounds(inherited, normalized.thinking.bounds);
    }
  }
  return normalized;
};

export const loadFabricConfigForScope = (
  options: {
    cwd: string;
    agentDir: string;
    projectTrusted: boolean;
  },
  scope: FabricConfigScope,
): FabricConfig => {
  if (scope === "project" && !options.projectTrusted) {
    throw new Error("Cannot load project Fabric configuration for an untrusted project");
  }
  return resolveFabricConfig(options, scope === "project", false);
};

export const loadFabricConfig = (options: {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
}): FabricConfig => {
  const config = resolveFabricConfig(options, options.projectTrusted, true);
  if (config.compaction.engine === "fabric") {
    process.env.PI_FABRIC_COMPACTION_ENGINE = "fabric";
  } else {
    delete process.env.PI_FABRIC_COMPACTION_ENGINE;
  }
  return config;
};

export const saveFabricConfig = (
  options: {
    cwd: string;
    agentDir: string;
    projectTrusted: boolean;
    scope?: FabricConfigScope;
  },
  partial: Record<string, unknown>,
): { scope: FabricConfigScope; path: string } => {
  const scope = options.scope ?? (options.projectTrusted ? "project" : "global");
  if (scope === "project" && !options.projectTrusted) {
    throw new Error("Cannot save project Fabric configuration for an untrusted project");
  }
  const targetPath = scope === "project"
    ? path.join(options.cwd, ".pi", "fabric.json")
    : path.join(options.agentDir, "fabric.json");
  if (Object.hasOwn(partial, "configVersion") || Object.hasOwn(partial, "subagents")) {
    throw new Error("Fabric configuration updates must use the current schema");
  }
  const input = readJsonObjectFile(targetPath);
  const existing = migrateFabricConfigDocument(input?.document ?? {}).document;
  const merged = mergeObjects(existing, partial) as Record<string, unknown>;
  // Reject invalid ownership before the settings UI replaces a working file.
  // Do not normalize the whole document: saved layers must remain sparse.
  nativeMcpServersValue(objectValue(merged.mcp).nativeServers);
  approvalActionOverridesValue(objectValue(merged.approvals).actions);
  foregroundConfigValue(merged.foreground);
  // Never stamp down: preserve version markers written by newer builds.
  merged.configVersion = Math.max(
    typeof merged.configVersion === "number" ? merged.configVersion : 0,
    CURRENT_FABRIC_CONFIG_VERSION,
  );
  writeJsonAtomic(targetPath, merged, input?.source ?? null);
  return { scope, path: targetPath };
};
