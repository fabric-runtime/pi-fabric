import type { FabricDynamicGuestDeclarations } from "../protocol.js";
import { NATIVE_CODEMODE_TYPES } from "./native-codemode-types.js";
import { JEV_GUEST_DECLARATIONS } from "../jev/guest-types.js";

// These names and compatibility fields are the single source of truth for
// generated core-override overloads. Keep them beside PiToolsApi below so an
// override extends the same guest contract rather than copying its signatures.
// Numeric fields widen to `number | string` in generated overloads too,
// mirroring built-in runtime normalization; a strict override schema still
// rejects the string form at validation time, and the registry error wins.
export const PI_CORE_COMPATIBILITY_ARGUMENT_TYPE_NAMES = {
  read: "PiReadCompatibilityArgument",
  bash: "PiBashCompatibilityArgument",
  powershell: "PiPowerShellCompatibilityArgument",
  edit: "PiEditCompatibilityArgument",
  write: "PiWriteCompatibilityArgument",
  grep: "PiGrepCompatibilityArgument",
  find: "PiFindCompatibilityArgument",
  ls: "PiLsCompatibilityArgument",
} as const;

export const PI_CORE_NUMERIC_FIELDS = {
  read: ["offset", "limit"],
  bash: ["timeout"],
  powershell: ["timeout"],
  edit: [],
  write: [],
  grep: ["context", "limit"],
  find: ["limit"],
  ls: ["limit"],
} as const;

export const GUEST_TYPE_DECLARATIONS = `
${NATIVE_CODEMODE_TYPES}
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type FabricTransport = "auto" | "process" | "tmux" | "screen" | "localterm" | "herdr";
type FabricAgentRunner = "pi-durable" | "pi" | "claude" | "veda" | (string & {});
type FabricKernel = "typescript" | "python";
type FabricThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
interface FabricActionEffect {
  kind: "none" | "scoped" | "transactional" | "emission";
  resources?: string[];
  ordering?: "commutative" | "ordered" | "unknown";
}
interface FabricAction {
  ref: string;
  provider: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  risk: "read" | "write" | "execute" | "network" | "agent";
  namespace?: string;
  effect?: FabricActionEffect;
}
interface FabricAgentRequest {
  /** Omitted/inherit uses caller executor.kernel; concrete choices require Pi with extensions. */
  kernel?: FabricKernel | "inherit";
  task: string;
  name?: string;
  runner?: FabricAgentRunner;
  transport?: FabricTransport;
  model?: string;
  persona?: string;
  thinking?: FabricThinking;
  /** Child thinking bounds; must lie inside this session's bounds. Levels outside are clamped. */
  thinkingBounds?: FabricThinkingBounds;
  tools?: string[];
  timeoutMs?: number;
  extensions?: boolean;
  recursive?: boolean;
  /** Filesystem execution directory; relative paths resolve from the parent agent cwd. */
  cwd?: string;
  worktree?: boolean;
  /** Shell command run in the new worktree before launch. */
  worktreeSetup?: string;
  /** Pi only. branch: fork this conversation (last completed turn); snippet: prefix recent messages. */
  seed?: "task" | "branch" | "snippet";
  seedMessages?: number;
  /** Pi only write confinement; bash needs shell: "unconfined". */
  readOnly?: boolean;
  writableRoots?: string[];
  shell?: "deny" | "unconfined";
  /** Narrow the host-issued scope; omitted inherits it. Refused when this session is unscoped. */
  scope?: { grants: { resource: string; actions: ("read" | "write" | "execute")[] }[] };
  schema?: Record<string, unknown>;
  /** Appended to the child's system prompt (Veda receives it as a <system_instructions> block); blank is ignored and durable spawn refuses it. */
  systemPrompt?: string;
  prompt?: string;
  instructions?: string;
  timeout_ms?: number;
  residency?: FabricParticipantResidency;
  /** Opt in to session persistence for hook-based observability and external trace ingestion. */
  persistSession?: boolean;
}
interface FabricHandoffCall {
  readonly ref: string;
}
interface FabricHandoffFacts {
  readonly calls: readonly FabricHandoffCall[];
  count(ref?: string | readonly string[]): number;
}
type FabricHandoffPredicate = (facts: Readonly<FabricHandoffFacts>) => boolean;
interface FabricHandoffRequest {
  kernel?: FabricKernel | "inherit";
  model: string;
  task?: string;
  when?: FabricHandoffPredicate;
  name?: string;
  transport?: FabricTransport;
  thinking?: FabricThinking;
  tools?: string[];
  timeoutMs?: number;
  extensions?: boolean;
  recursive?: boolean;
  schema?: Record<string, unknown>;
  prompt?: string;
  instructions?: string;
  timeout_ms?: number;
}
interface FabricHandoffResult {
  scheduled: true;
  status: "deferred";
  boundary: "fabric_exec_end";
}
interface FabricMainAgentInfo {
  id: string;
  name: "Main";
  kind: "main";
  status: "idle" | "running" | "remote";
  runner: "pi";
  transport: "host";
  cwd?: string;
  sessionId?: string;
  model?: string;
  thinking?: string;
  startedAt?: number;
  updatedAt: number;
  pendingMessages: boolean;
  local: boolean;
}
interface FabricPeerInfo {
  id: string;
  name: string;
  kind: "peer";
  status: "idle" | "running";
  runner: "pi";
  transport: "host";
  cwd: string;
  sessionId: string;
  model?: string;
  thinking?: string;
  startedAt: number;
  updatedAt: number;
  pendingMessages: boolean;
  local: false;
}
type FabricParticipantKind = "root" | "agent" | "actor";
type FabricParticipantResidency = "session" | "durable";
type FabricParticipantScope = "local" | "lineage" | "project";
type FabricParticipantCapability = "steer" | "followUp" | "stop" | "ask" | "actor-bindings" | "attach" | "fabric";
interface FabricParticipantInfo {
  format: 1;
  id: string;
  kind: FabricParticipantKind | "provider";
  rootId: string;
  ownerHostId: string;
  ownerIdentityId: string;
  ownerIncarnation?: string;
  parentId?: string;
  name: string;
  status: string;
  runner?: FabricAgentRunner;
  provider?: string;
  transport: FabricTransport | "host";
  capabilities: FabricParticipantCapability[];
  cwd?: string;
  sessionId?: string;
  model?: string;
  thinking?: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  pendingMessages?: boolean;
  currentTool?: string;
  turns?: number;
  toolCalls?: number;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  actorQueued?: number;
  actorMessages?: number;
  controlProtocol: "v1" | "legacy";
  residency: FabricParticipantResidency;
  local: boolean;
  stale: boolean;
}
type FabricLifecycleEventType =
  | "pi.input"
  | "pi.agent_start"
  | "pi.agent_end"
  | "pi.turn_end"
  | "pi.agent_settled"
  | "pi.tool_error"
  | "pi.session_compact"
  | "run.completed"
  | "run.failed"
  | "run.stopped"
  | "run.timed_out"
  | "run.resumed"
  | "run.detached"
  | "tokens.usage"
  | "component.state";
type FabricLifecycleDelivery = "steer" | "followUp";
interface FabricLifecycleSource {
  id: string;
  name: string;
  kind: FabricParticipantKind;
  rootId: string;
  runner: FabricAgentRunner;
  ownerHostId?: string;
  ownerIdentityId?: string;
}
interface FabricLifecycleEvent {
  version: 1;
  id: string;
  sequence: number;
  event: FabricLifecycleEventType;
  source: FabricLifecycleSource;
  occurredAt: number;
  publishedAt: number;
  runId?: string;
  status?: string;
  data?: unknown;
}
interface FabricLifecycleSubscription {
  format: 1;
  id: string;
  from: string;
  events: FabricLifecycleEventType[];
  to: string;
  delivery: FabricLifecycleDelivery;
  triggerTurn: boolean;
  once: boolean;
  afterSequence: number;
  createdAt: number;
  updatedAt: number;
  createdBy: { id: string; name: string; kind: "main" | "agent" | "actor"; sessionId?: string };
  lastDeliveredAt?: number;
  lastEventId?: string;
  lastError?: string;
}
interface FabricAgentHandle {
  /** Resolved Fabric kernel, absent for non-Fabric runners. */
  kernel?: FabricKernel;
  id: string;
  name: string;
  status: string;
  runner: FabricAgentRunner;
  /** Local execution metadata is absent for hosted participants. */
  transport?: FabricTransport;
  cwd?: string;
  rootId?: string;
  parentId?: string;
  depth?: number;
  generation?: number;
  model?: string;
  thinking?: FabricThinking;
  /** Present only when the requested level was clamped into thinking bounds. */
  requestedThinking?: FabricThinking;
  actorId?: string;
  actorName?: string;
  sessionId?: string;
  runnerSessionId?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
  text?: string;
  value?: unknown;
  error?: string;
  logFile?: string;
  residency?: FabricParticipantResidency;
}
interface FabricRemoteControlResult {
  queued: true;
  messageId: string;
  routed: "mesh";
  acknowledged: true;
}
interface FabricAgentResult extends FabricAgentHandle {
  task: string;
  startedAt: number;
  finishedAt?: number;
  turns: number;
  toolCalls: number;
  text: string;
  value?: unknown;
  error?: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  pendingMessages?: { steering: string[]; followUp: string[] };
  /** worktree: true runs; worktree stays the path. */
  worktreeResult?: {
    path: string; branch?: string; baseRef?: string; changedFiles: string[];
    diffstat: { files: number; insertions: number; deletions: number }; kept: boolean; diffError?: string;
  };
}
interface FabricModelInfo {
  runner?: FabricAgentRunner;
  provider: string;
  id: string;
  name: string;
  key: string;
  value?: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}
interface FabricLogLine {
  index?: number;
  offset: number;
  raw: string;
  parsed?: unknown;
}
interface FabricAgentLog {
  id: string;
  runDirectory: string;
  logFile: string;
  status?: FabricAgentResult;
  events: FabricLogLine[];
  hasMore: boolean;
  before?: number;
}
interface FabricActorLog {
  actorId: string;
  actorName: string;
  sessionFile: string;
  logDir: string;
  session: FabricLogLine[];
  sessionHasMore: boolean;
  sessionBefore?: number;
  run?: {
    runId: string;
    eventsFile: string;
    status?: FabricAgentResult;
    events: FabricLogLine[];
    hasMore: boolean;
    before?: number;
  };
  retainedRuns: string[];
}
interface FabricCapabilityActionHead {
  key: string;
  parentKey: string;
  ref: string;
  name: string;
  description: string;
  descriptorHash: string;
  risk: "read" | "write" | "execute" | "network" | "agent";
  namespace?: string;
  effect?: FabricActionEffect;
}
interface FabricCapabilityProviderHead {
  key: string;
  parentKey: string;
  name: string;
  description: string;
  descriptorHash: string;
  actions: FabricCapabilityActionHead[];
}
interface FabricCapabilityCatalog {
  kind: "pi-fabric.capability-catalog";
  version: 1;
  root: {
    key: "capability:fabric";
    name: "Fabric capabilities";
    description: string;
    descriptorHash: string;
  };
  providers: FabricCapabilityProviderHead[];
  totalActions: number;
  indexedActions: number;
  complete: boolean;
  reasons: string[];
}
interface FabricActionListEnvelope {
  kind: "pi-fabric.action-list";
  version: 1;
  actions: FabricAction[];
  /** Full visible-action count before paging. */
  total: number;
  /** True when total exceeds the returned page: more actions exist. */
  truncated: boolean;
  limit: number;
}
interface FabricActionSearchBackend {
  requested: "semantic";
  used: "semantic" | "lexical";
  degraded: boolean;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
  abstained?: boolean;
  reason?: "timeout" | "rate_limited" | "service_unavailable";
}
interface FabricActionSearchEnvelope {
  kind: "pi-fabric.action-search";
  version: 1;
  actions: FabricAction[];
  backend: FabricActionSearchBackend;
}
interface FabricToolsApi {
  [name: string]: any;
  providers(): Promise<Array<{ name: string; description: string }>>;
  catalog(args?: { provider?: string; limit?: number }): Promise<FabricCapabilityCatalog>;
  /**
   * Capped discovery page: default 100 entries, silently truncated (hard cap
   * 1000). A short result never proves an action is absent — confirm with
   * search() or pass envelope: true to get totals and a truncated flag.
   */
  list(args?: { provider?: string; namespace?: string; query?: string; limit?: number; envelope?: boolean }): Promise<FabricAction[] | FabricActionListEnvelope>;
  search(args: { query: string; limit?: number; searchMode?: "lexical" | "semantic" }): Promise<FabricAction[] | FabricActionSearchEnvelope>;
  describe(args: { ref: string }): Promise<FabricAction>;
  call(args: { ref: string; args?: Record<string, unknown> }): Promise<unknown>;
  progress(args: { message: string }): Promise<void>;
  models: FabricNativeModels;
}
interface FabricCapturedToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  text: string;
  details?: unknown;
  isError: boolean;
  terminate?: boolean;
  source: { path: string; source: string; scope: string; origin: string; baseDir?: string };
}
interface FabricCapturedTool {
  (args?: Record<string, unknown>): Promise<FabricCapturedToolResult>;
}
type FabricExtensionsApi = Record<string, FabricCapturedTool>;
// String-primary tools (read/bash/powershell/grep/find/ls) accept a bare string; the
// runtime proxy coerces it to { <primaryField>: string }. Lets the model write
// the natural form (pi.bash("ls")) instead of pi.bash({ command: "ls" }).
// Return shapes differ by tool: read/grep/find/ls return their text as a bare
// string (e.g. const src: string = await pi.read({ path })); shell/edit/write
// return { ok, output, details } (e.g. const { output } = await pi.bash(...)).
// Common alias keys (cmd→command, query→pattern, file→path, dir→path) and a
// flat edit shape ({ path, oldText, newText }) are also accepted; the runtime
// proxy normalizes them to the canonical form before the host validates args.
// Bash timeout is measured in seconds; timeoutMs is converted from milliseconds.
// After executor.shellHangMs the await still resolves ok: true with a still-running
// notice, pid, and live output path in details; background: true (alias
// run_in_background) detaches immediately. The process keeps writing that file.
// Extended near-miss repairs: find's name/filename/glob → pattern, write's
// data → content, ls's folder → path, bash's script → command; numeric option
// fields (limit/offset/context/timeout) also accept numeric strings, coerced
// at runtime (2322 diagnostics are suppressed by the type-checker by design).
// String-primary tools also take a two-arg (primary, options) form —
// pi.read("index.ts", { limit: 120 }) merges to { path, ...options } at
// runtime, the positional string winning the primary field on conflict.
// shell/edit/write envelopes are proxy-guarded so string-method access
// (.trim(), .split(), iteration) fails with an actionable TypeError pointing
// at .output instead of QuickJS's context-free "not a function" — property-
// miss (2339) checks are suppressed by design, so the runtime gives the hint.
type PiPathArgument = {
  path?: string;
  file?: string;
  absolutePath?: string;
  file_path?: string;
  filePath?: string;
  filepath?: string;
  pathname?: string;
  target_file?: string;
  targetFile?: string;
  absolute_path?: string;
  fileAbsolutePath?: string;
};
type PiOptionalPathArgument = {
  path?: string;
  file?: string;
  absolutePath?: string;
  file_path?: string;
  filePath?: string;
  filepath?: string;
  pathname?: string;
  target_file?: string;
  targetFile?: string;
  absolute_path?: string;
  fileAbsolutePath?: string;
  dir?: string;
  folder?: string;
  directory?: string;
  directoryPath?: string;
};
type PiOldTextArgument = {
  oldText?: string;
  old?: string;
  old_string?: string;
  oldString?: string;
  old_str?: string;
  oldStr?: string;
  from?: string;
  old_value?: string;
  old_text?: string;
  oldContent?: string;
  old_content?: string;
};
type PiNewTextArgument = {
  newText?: string;
  new?: string;
  replacement?: string;
  new_string?: string;
  newString?: string;
  new_str?: string;
  newStr?: string;
  to?: string;
  new_value?: string;
  new_text?: string;
  newContent?: string;
  new_content?: string;
};
type PiEditOperation = PiOldTextArgument & PiNewTextArgument & { all?: boolean };
type PiCommandArgument = { command?: string; cmd?: string; shell?: string; cmdline?: string; script?: string; commandLine?: string };
type PiContentArgument = { content?: string; contents?: string; body?: string; text?: string; data?: string; fileContent?: string };
type PiGrepPatternArgument = { pattern?: string; query?: string; regex?: string; search?: string; q?: string; expression?: string; text?: string };
type PiFindPatternArgument = { pattern?: string; query?: string; regex?: string; search?: string; name?: string; filename?: string; glob?: string; expression?: string; include?: string };
// Two-arg (primary, options) bags for the string-primary tools. Only option
// aliases belong here (max/start/ctx/ic/...), never primary-field aliases —
// the primary field comes from the positional string.
type PiReadOptions = { offset?: number; limit?: number; start?: number; max?: number };
// cwd is honored per call by the pi provider, which binds the command to a
// shell definition rooted there; relative paths resolve from the session cwd.
// The alias spellings mirror the shell entries in __piArgAliases: the
// runtime repairs them, so the checker has to accept the same spellings or a
// repairable call is rejected before it ever reaches the sandbox.
type PiShellOptions = {
  timeout?: number; timeoutMs?: number; settle?: boolean;
  background?: boolean; run_in_background?: boolean;
  description?: string;
  /** Opt-in line events; implies background. ui never wakes the model; wake may start an owning-agent turn. */
  monitor?: { delivery: "ui" | "wake"; timeoutMs?: number; intervalMs?: number; match?: string };
  cwd?: string; workdir?: string; directory?: string; workingDirectory?: string;
};
type PiBashOptions = PiShellOptions & {
  /** Owned by an external jev-fabric store (macOS/Linux): keeps running if Pi exits and reattaches on resume. Implies background. */
  durable?: boolean;
  /** Durable only: on exit publish {kind ?? "task.completed", data:{taskId, exitCode, description?}}. */
  notify?: { topic: string; kind?: string };
};
type PiPowerShellOptions = PiShellOptions;
type PiGrepOptions = { path?: string; glob?: string; globPattern?: string; ignoreCase?: boolean; ic?: boolean; caseInsensitive?: boolean; literal?: boolean; context?: number; ctx?: number; limit?: number; max?: number };
type PiFindOptions = { path?: string; limit?: number; max?: number };
type PiLsOptions = { limit?: number; max?: number };
type PiReadArgument = string | (PiPathArgument & PiReadOptions);
type PiBashArgument = string | (PiCommandArgument & PiBashOptions);
type PiPowerShellArgument = string | (PiCommandArgument & PiPowerShellOptions);
type PiEditFlatArgument = PiPathArgument & PiOldTextArgument & PiNewTextArgument & { all?: boolean };
type PiEditArgument = PiPathArgument & ({ edits: PiEditOperation[]; all?: boolean } | PiEditFlatArgument);
type PiWriteArgument = string | (PiPathArgument & PiContentArgument);
type PiGrepArgument = string | (PiGrepPatternArgument & PiGrepOptions);
type PiFindArgument = string | (PiFindPatternArgument & PiFindOptions);
type PiLsArgument = string | (PiOptionalPathArgument & PiLsOptions);
type PiNumericString<T> = T extends number ? T | string : T;
type PiNumericStringOptions<T> = { [K in keyof T]: PiNumericString<T[K]> };
type PiReadCompatibilityArgument = string | (PiPathArgument & PiNumericStringOptions<PiReadOptions>);
type PiBashCompatibilityArgument = string | (PiCommandArgument & PiNumericStringOptions<PiBashOptions>);
type PiPowerShellCompatibilityArgument = string | (PiCommandArgument & PiNumericStringOptions<PiPowerShellOptions>);
type PiEditCompatibilityArgument = PiEditFlatArgument;
type PiWriteCompatibilityArgument = PiWriteArgument;
type PiGrepCompatibilityArgument = string | (PiGrepPatternArgument & PiNumericStringOptions<PiGrepOptions>);
type PiFindCompatibilityArgument = string | (PiFindPatternArgument & PiNumericStringOptions<PiFindOptions>);
type PiLsCompatibilityArgument = string | (PiOptionalPathArgument & PiNumericStringOptions<PiLsOptions>);
interface PiToolsApi {
  read(args: PiReadArgument, options?: PiReadOptions): Promise<string>;
  bash(args: PiBashArgument, options?: PiBashOptions): Promise<{ ok: true; output: string; details: unknown } | { ok: false; output: string; details: null; exitCode: number; error: string }>;
  powershell(args: PiPowerShellArgument, options?: PiPowerShellOptions): Promise<{ ok: true; output: string; details: unknown } | { ok: false; output: string; details: null; exitCode: number; error: string }>;
  edit(args: PiEditArgument): Promise<{ ok: true; output: string; details: unknown }>;
  edit(path: string, oldText: string, newText: string): Promise<{ ok: true; output: string; details: unknown }>;
  write(args: PiWriteArgument): Promise<{ ok: true; output: string; details: unknown }>;
  write(path: string, content: string): Promise<{ ok: true; output: string; details: unknown }>;
  grep(args: PiGrepArgument): Promise<string>;
  grep(pattern: string, path?: string | PiGrepOptions, limit?: number): Promise<string>;
  find(args: PiFindArgument): Promise<string>;
  find(pattern: string, path?: string | PiFindOptions, limit?: number): Promise<string>;
  ls(args?: PiLsArgument, options?: PiLsOptions): Promise<string>;
}
type FabricActorHostEvent =
  | "resources_discover"
  | "session_start"
  | "session_info_changed"
  | "session_before_switch"
  | "session_before_fork"
  | "session_before_compact"
  | "session_compact"
  | "session_shutdown"
  | "session_before_tree"
  | "session_tree"
  | "input"
  | "before_agent_start"
  | "agent_start"
  | "agent_end"
  | "agent_settled"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "context"
  | "before_provider_headers"
  | "before_provider_request"
  | "after_provider_response"
  | "tool_execution_start"
  | "tool_call"
  | "tool_execution_update"
  | "tool_result"
  | "tool_execution_end"
  | "model_select"
  | "thinking_level_select"
  | "user_bash"
  | "tool_error";
type FabricActorDelivery = "mailbox" | "steer" | "followUp" | "nextTurn";
interface FabricActorHostMediaDescriptor {
  readonly type: "image";
  readonly mediaIndex: number;
  readonly mimeType: string;
}
interface FabricActorHostSignal {
  readonly payload: unknown;
  readonly media?: readonly FabricActorHostMediaDescriptor[];
  readonly idle: boolean;
  readonly observedAt: number;
}
type FabricActorActivation =
  | { readonly kind: "hostEvent"; readonly id: string; readonly source: string; readonly sequence: number; readonly createdAt: number; readonly event: FabricActorHostEvent; readonly mainRevision: number; readonly taskRevision: number; readonly signal?: FabricActorHostSignal }
  | { readonly kind: "direct"; readonly id: string; readonly source: string; readonly sequence: number; readonly createdAt: number }
  | { readonly kind: "mesh"; readonly id: string; readonly source: string; readonly sequence: number; readonly createdAt: number; readonly topic: string };
interface FabricActorValidityFacts {
  readonly activation: Readonly<FabricActorActivation>;
  readonly current: Readonly<{ latestActivationSequence: number; mainRevision: number; taskRevision: number; idle: boolean; now: number }>;
}
type FabricActorValidityDecision = boolean | { valid: boolean; reason?: string };
type FabricActorBindingScope = "session" | "project";
interface FabricActorRunBinding { model?: string; thinking?: FabricThinking }
type FabricActorValidWhile = (facts: Readonly<FabricActorValidityFacts>) => FabricActorValidityDecision;
interface FabricActorRequestBase {
  /** Fixed at creation; ask/tell cannot change language. Global templates resolve inheritance on import. */
  kernel?: FabricKernel | "inherit";
  scope?: "session" | "project" | "global";
  name: string;
  instructions: string;
  events?: FabricActorHostEvent[];
  topics?: string[];
  responseMode?: "text" | "directive";
  coalesce?: boolean;
  runner?: FabricAgentRunner;
  model?: string;
  thinking?: FabricThinking;
  tools?: string[];
  transport?: FabricTransport;
  timeoutMs?: number;
  timeout_ms?: number;
  extensions?: boolean;
  requires?: Array<string | { ref: string; optional?: boolean }>;
  validWhile?: FabricActorValidWhile;
  residency?: FabricParticipantResidency;
}
type FabricActorRequest = FabricActorRequestBase & (
  | { delivery?: "mailbox"; triggerTurn?: false }
  | { delivery: "nextTurn"; triggerTurn?: false }
  | { delivery: "steer" | "followUp"; triggerTurn: boolean }
);
interface FabricActorInfo {
  kernel?: FabricKernel;
  pythonRuntime?: "cpython" | "monty";
  id: string;
  scope: "session" | "project";
  name: string;
  status: "idle" | "queued" | "running" | "stopped";
  runner: FabricAgentRunner;
  events: FabricActorHostEvent[];
  topics: string[];
  delivery: FabricActorDelivery;
  responseMode: "text" | "directive";
  triggerTurn: boolean;
  coalesce: boolean;
  model?: string;
  thinking?: FabricThinking;
  binding?: FabricActorRunBinding & { scope: "session"; sessionId: string; updatedAt?: number };
  projectDefaults?: FabricActorRunBinding & { scope: "project" };
  tools?: string[];
  timeoutMs?: number;
  extensions?: boolean;
  requirements?: Array<{ ref: string; optional?: boolean }>;
  capabilityDigest?: string;
  missingCapabilities?: string[];
  validWhile?: { version: 1; source: string };
  residency: FabricParticipantResidency;
  queued: number;
  messages: number;
  createdAt: number;
  updatedAt: number;
  lastRunId?: string;
  lastError?: string;
  sessionFile?: string;
  logDir?: string;
}
interface FabricModelSwitchRequest {
  /** provider/id, a models.aliases name, or a search term; resolution tries aliases first, then exact matches, then the closest fuzzy match (recency from pi-model-sort breaks ties) against authenticated models. */
  model: string;
  /** Optional provider filter applied before matching (e.g. "anthropic"). */
  provider?: string;
}
interface FabricModelSwitchResult {
  switched: boolean;
  /** Active model as provider/id after the call (unchanged when reason is "already-active"). */
  model: string;
  name?: string;
  /** Previously active provider/id when known. Absent for already-active results. */
  previous?: string;
  /** Set when the selector resolved through a configured models.aliases name. */
  alias?: string;
  /** How the selector resolved: the alias name, or one of closest/recent/latest for inexact picks. Absent for exact provider/id or bare-id matches. */
  via?: string;
  reason?: "already-active";
}
interface FabricActorMessage {
  id: string;
  actorId: string;
  actorName: string;
  direction: "in" | "out";
  source: string;
  createdAt: number;
  text?: string;
  data?: unknown;
  action?: "silent" | "message" | "stop";
  runId?: string;
  error?: string;
  stale?: boolean;
  reason?: string;
}
// agentId/agent_id spellings repair to id during agent arg normalization.
type FabricAgentTargetArgs = { id: string; agentId?: string; agent_id?: string };
interface FabricAgentsApi {
  run(args: FabricAgentRequest): Promise<FabricAgentResult>;
  /** Hosted capability only; resumes a paused direct child without exposing its checkpoint. */
  resume(args: FabricAgentTargetArgs & { task?: string }): Promise<FabricAgentResult>;
  handoff(args: FabricHandoffRequest): Promise<FabricHandoffResult>;
  spawn(args: FabricAgentRequest): Promise<FabricAgentHandle>;
  wait(args: FabricAgentTargetArgs): Promise<FabricAgentResult>;
  /** Alias for wait. */
  join(args: FabricAgentTargetArgs): Promise<FabricAgentResult>;
  status(args: FabricAgentTargetArgs): Promise<FabricAgentResult | FabricAgentHandle | FabricMainAgentInfo | FabricActorInfo | FabricParticipantInfo>;
  list(args?: { scope?: FabricParticipantScope }): Promise<Array<FabricAgentResult | FabricAgentHandle | FabricParticipantInfo>>;
  members(args?: { scope?: FabricParticipantScope; kinds?: FabricParticipantKind[]; includeStale?: boolean }): Promise<FabricParticipantInfo[]>;
  /** lineage mirrors PI_FABRIC_LINEAGE in child workers. */
  self(): Promise<FabricParticipantInfo & { lineage?: {
    version: 1; rootSessionId: string; parentSessionId?: string; parentRunId?: string;
    runId: string; depth: number; childIndex: number; worker: true;
  } }>;
  main(): Promise<FabricMainAgentInfo>;
  sessions(): Promise<FabricParticipantInfo[]>;
  peers(): Promise<FabricPeerInfo[]>;
  subscribe(args: {
    from: string;
    events: FabricLifecycleEventType[];
    to?: string;
    delivery: FabricLifecycleDelivery;
    triggerTurn: boolean;
    once?: boolean;
  }): Promise<FabricLifecycleSubscription>;
  subscriptions(args?: { from?: string; to?: string }): Promise<FabricLifecycleSubscription[]>;
  unsubscribe(args: FabricAgentTargetArgs): Promise<{ removed: boolean }>;
  models(args?: { runner?: FabricAgentRunner; refresh?: boolean }): Promise<FabricModelInfo[]>;
  stop(args: FabricAgentTargetArgs): Promise<FabricAgentResult | FabricActorInfo | FabricRemoteControlResult>;
  cleanup(args: FabricAgentTargetArgs & { deleteBranch?: boolean; delete_branch?: boolean }): Promise<{ cleaned: boolean }>;
  create(args: FabricActorRequest): Promise<FabricActorInfo>;
  setModel(args: { id: string; model?: string; scope?: FabricActorBindingScope }): Promise<FabricActorInfo>;
  switchModel(args: FabricModelSwitchRequest): Promise<FabricModelSwitchResult>;
  setThinking(args: { id: string; thinking?: FabricThinking; scope?: FabricActorBindingScope }): Promise<FabricActorInfo>;
  setTools(args: { id: string; tools: string[]; scope?: "project" | "global" }): Promise<FabricActorInfo>;
  setEvents(args: { id: string; events: FabricActorHostEvent[] }): Promise<FabricActorInfo>;
  setDeliveryPolicy(args: {
    id: string;
    delivery: FabricActorDelivery;
    triggerTurn: boolean;
    scope?: "project" | "global";
  }): Promise<FabricActorInfo>;
  setInstructions(args: {
    id: string;
    instructions: string;
    scope?: "project" | "global";
  }): Promise<FabricActorInfo>;
  ask(args: { id: string; message: string; data?: unknown; model?: string; thinking?: FabricThinking }): Promise<FabricActorMessage>;
  tell(args: { id: string; message: string; data?: unknown; model?: string; thinking?: FabricThinking }): Promise<{ queued: true; messageId: string }>;
  steer(args: { id: string; message: string; data?: unknown }): Promise<{ queued: true; messageId: string; routed?: "local" | "main" | "mesh"; acknowledged?: boolean }>;
  followUp(args: { id: string; message: string; data?: unknown }): Promise<{ queued: true; messageId: string; routed?: "local" | "main" | "mesh"; acknowledged?: boolean }>;
  setSteeringMode(args: { id: string; mode: "all" | "one-at-a-time" }): Promise<{ queued: true; messageId: string }>;
  setFollowUpMode(args: { id: string; mode: "all" | "one-at-a-time" }): Promise<{ queued: true; messageId: string }>;
  /** Advisory compaction of a running Pi-runner child at its next safe turn boundary. */
  compact(args: { id: string; instructions?: string }): Promise<{ queued: true; messageId: string }>;
  actorStatus(args: FabricAgentTargetArgs): Promise<FabricActorInfo>;
  actors(): Promise<FabricActorInfo[]>;
  messages(args: { id: string; limit?: number }): Promise<FabricActorMessage[]>;
  remove(args: { id: string }): Promise<{ removed: boolean }>;
  /** Drop an actor's mailbox history without stopping the actor. */
  clearMessages(args: { id: string }): Promise<FabricActorInfo>;
  /** Stamp a global template into the current project as a fresh live actor with no inherited history. */
  "import"(args: { id?: string; name?: string; as?: string }): Promise<FabricActorInfo>;
  /** Export a live project actor's definition to the global registry as a project-independent template. */
  "export"(args: { id: string; overwrite?: boolean }): Promise<FabricActorRequest & { id: string; createdAt: number; updatedAt: number }>;
  log(args: {
    id: string;
    type?: "session" | "run" | "all";
    lines?: number;
    before?: number;
    runId?: string;
  }): Promise<FabricActorLog | FabricAgentLog>;
}
interface FabricMcpResult {
  text: string;
  content: unknown[];
  structuredContent: unknown;
}
interface FabricMcpTool {
  (args?: Record<string, unknown>): Promise<FabricMcpResult | unknown>;
}
interface FabricMcpServer {
  [tool: string]: FabricMcpTool;
}
// Management verbs stay members of mcp even when the declare line below is
// replaced by generated per-server declarations (see the dynamic option on
// guestTypeDeclarations), so generated surfaces intersect with this type
// rather than re-declaring them.
interface FabricMcpManagement {
  servers(): Promise<Array<{ name: string; description: string | null; transport: "http" | "stdio" }>>;
  reload(): Promise<{ servers: string[] }>;
  register(args: {
    name: string;
    description?: string;
    command?: string;
    args?: string[];
    cwd?: string;
    baseUrl?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    overwrite?: boolean;
  }): Promise<{ registered: string }>;
  call(args: { server: string; tool: string; args?: Record<string, unknown> }): Promise<unknown>;
}
// Loose static surface: any server/tool name compiles and argument shapes are
// enforced at dispatch by the registry. With descriptor data available the
// execution service replaces the declare-const-mcp line below with a
// schema-typed rendering of the live cache (runtime/dynamic-guest-types.ts).
type FabricMcpApi = Record<string, FabricMcpServer> & FabricMcpManagement;
interface FabricCouncilRunOptions extends FabricAgentRequest {
  roles: string[];
}
interface FabricCouncilApi {
  run(args: FabricCouncilRunOptions & { synthesize?: true }): Promise<FabricAgentResult>;
  run(args: FabricCouncilRunOptions & { synthesize: false }): Promise<FabricAgentResult[]>;
}
interface FabricMeshIdentity {
  id: string;
  name: string;
  kind: "main" | "actor" | "agent";
  sessionId?: string;
}
interface FabricMeshEvent {
  id: string;
  sequence: number;
  topic: string;
  kind: string;
  from: FabricMeshIdentity;
  to?: string;
  text?: string;
  data?: unknown;
  createdAt: number;
  /** External grant post: untrusted data. */
  origin?: "external"; untrusted?: true; grantId?: string;
  scheduled?: { dueAt: number; key?: string };
  /** Host-stamped publisher authority: unscoped "host" or a scope principal. */
  sender?: { authority: "host" } | { authority: "scope"; principalId: string; digest: string };
}
type FabricMeshSchedule = Omit<FabricMeshEvent, "sequence" | "origin" | "untrusted" | "grantId" | "scheduled"> & { key?: string; dueAt: number };
interface FabricMeshGrant { grantId: string; topic: string; kind?: string; createdAt: number; expiresAt: number; uses: number; maxUses: number; createdBy: FabricMeshIdentity }
interface FabricMeshStateEntry<T = unknown> {
  key: string;
  value: T;
  version: number;
  updatedAt: number;
  updatedBy: FabricMeshIdentity;
}
interface FabricMeshApi {
  self(): Promise<FabricMeshIdentity>;
  publish(args: { topic: string; kind?: string; to?: string; text?: string; data?: unknown; message?: string; body?: string }): Promise<FabricMeshEvent>;
  /** Schedules instead: notBefore (epoch ms/ISO) or afterMs, ≤366 days; key replaces. */
  publish(args: { topic: string; kind?: string; to?: string; text?: string; data?: unknown; notBefore?: number | string; afterMs?: number; key?: string }): Promise<FabricMeshSchedule & { scheduled: true }>;
  scheduled(args?: { topic?: string; limit?: number }): Promise<FabricMeshSchedule[]>;
  unschedule(args: { key: string }): Promise<{ removed: boolean }>;
  /** External post token, shown once. ttlMs 1 min..30 days; uses 1..10000, default 1. */
  grant(args: { topic: string; ttlMs: number; uses?: number; kind?: string }): Promise<FabricMeshGrant & { token: string; command: string }>;
  revoke(args: { grantId: string }): Promise<{ revoked: boolean }>;
  grants(): Promise<FabricMeshGrant[]>;
  read(args?: { after?: number; topic?: string; to?: string; limit?: number; max?: number }): Promise<FabricMeshEvent[]>;
  members(args?: { scope?: FabricParticipantScope; kinds?: FabricParticipantKind[]; includeStale?: boolean; limit?: number; max?: number; include_stale?: boolean }): Promise<FabricParticipantInfo[]>;
  get<T = unknown>(args: { key: string }): Promise<FabricMeshStateEntry<T> | null>;
  list<T = unknown>(args?: { prefix?: string; limit?: number; max?: number }): Promise<Array<FabricMeshStateEntry<T>>>;
  put<T = unknown>(args: { key: string; value: T; ifVersion?: number; if_version?: number; version?: number }): Promise<FabricMeshStateEntry<T>>;
  delete(args: { key: string; ifVersion?: number; if_version?: number; version?: number }): Promise<{ deleted: boolean; version?: number }>;
}
// Stable-provider argument bags declare the canonical keys plus the
// near-miss spellings repaired during argument normalization
// (providers/arg-normalization.ts and each provider's per-action table). The
// registry's prepare stage repairs aliases before schema validation, so a
// call spelled with an alias typechecks instead of tripping the
// excess-property check; the canonical key wins on conflict, and anything
// else fails additionalProperties:false validation with the offending
// property path named. Keep these spillover fields in sync with the provider
// normalization tables.
type FabricMemoryBranches = "active" | "all";
type FabricMemoryQueryMode = "literal" | "phrase" | "regex";
type FabricMemoryQueryMatch = "all" | "any";
interface FabricMemoryEntryRange {
  first: number;
  last: number;
}
interface FabricMemoryRecallArgs {
  source?: string;
  query?: string;
  queryMode?: FabricMemoryQueryMode;
  queryMatch?: FabricMemoryQueryMatch;
  expectedSourceHash?: string;
  expectedLineageFingerprint?: string;
  branches?: FabricMemoryBranches;
  scope?: string;
  offset?: number;
  pageSize?: number;
  snippetChars?: number;
  role?: string;
  tool?: string;
  ref?: string;
  provider?: string;
  action?: string;
  outcome?: "succeeded" | "failed" | "aborted" | "timed_out";
  since?: number;
  until?: number;
  entryRange?: FabricMemoryEntryRange;
  q?: string;
  limit?: number;
  max?: number;
  page_size?: number;
  snippet_chars?: number;
  query_mode?: FabricMemoryQueryMode;
  query_match?: FabricMemoryQueryMatch;
  entry_range?: FabricMemoryEntryRange;
}
interface FabricMemoryExpandArgs {
  source?: string;
  session: string;
  expectedSourceHash?: string;
  expectedLineageFingerprint?: string;
  branches?: FabricMemoryBranches;
  indices?: number[];
  entryIds?: string[];
  operationAddresses?: string[];
  entryRange?: FabricMemoryEntryRange;
  before?: number;
  after?: number;
  entryOffset?: number;
  textOffset?: number;
  maxChars?: number;
  maxEntries?: number;
  id?: string;
  file?: string;
  path?: string;
  session_id?: string;
  index?: number;
  entry_ids?: string[];
  operation_addresses?: string[];
  entry_range?: FabricMemoryEntryRange;
  entry_offset?: number;
  text_offset?: number;
  max_chars?: number;
  max_entries?: number;
}
interface FabricMemoryCall<Ref extends string, Args> {
  ref: Ref;
  args: Args;
}
interface FabricMemoryRecallEntryHit {
  kind: "entry";
  sessionId: string;
  tier: "hot" | "cold";
  index: number;
  entryId: string | null;
  parentId: string | null;
  operationAddress: string | null;
  type: string;
  role: string | null;
  tool: string | null;
  ref: string | null;
  provider: string | null;
  action: string | null;
  timestamp: number | null;
  isError: boolean;
  outcome?: "succeeded" | "failed" | "aborted" | "timed_out";
  score: number;
  snippet: string;
  truncated: boolean;
  follow: FabricMemoryCall<"memory.expand", FabricMemoryExpandArgs>;
}
interface FabricMemoryRecallSessionHit {
  kind: "session";
  sessionId: string;
  tier: "cold";
  cwd: string;
  lastTimestamp: number | null;
  score: number;
  matchedTerms: number;
  matchedStructuralEntries: number;
  follow: FabricMemoryCall<"memory.recall", FabricMemoryRecallArgs>;
}
type FabricMemoryRecallHit = FabricMemoryRecallEntryHit | FabricMemoryRecallSessionHit;
interface FabricMemoryError {
  code: string;
  message: string;
  [key: string]: unknown;
}
interface FabricMemoryCoverage {
  complete: boolean;
  indexedSessions: number;
  eligibleSessions: number;
  staleSessions: number;
  incompleteSessions: number;
  reasons: string[];
  error?: FabricMemoryError;
}
interface FabricMemoryRecallResult {
  total: number;
  hits: FabricMemoryRecallHit[];
  next: FabricMemoryCall<"memory.recall", FabricMemoryRecallArgs> | null;
  coverage: FabricMemoryCoverage;
  error?: FabricMemoryError;
}
interface FabricMemoryExpandedEntry {
  index: number;
  entryId: string | null;
  parentId: string | null;
  type: string | null;
  role: string | null;
  timestamp: number | null;
  isError: boolean;
  anchor?: boolean;
  text: string;
  textRange: { start: number; end: number; total: number; complete: boolean };
  parentEntryId?: string | null;
  operationAddress?: string | null;
  tool?: string | null;
  ref?: string | null;
  provider?: string | null;
  action?: string | null;
  outcome?: "succeeded" | "failed" | "aborted" | "timed_out";
  filesTouched?: Array<string | null>;
  operation?: unknown;
  branchFact?: unknown;
  structuredTruncated?: boolean;
  factAddress?: string | null;
  carrierEntryId?: string | null;
  carrierParentId?: string | null;
  carrierFromId?: string | null;
}
interface FabricMemoryExpandResult {
  session?: string;
  sourceHash?: string;
  branches?: FabricMemoryBranches;
  lineageFingerprint?: string;
  entryCount?: number;
  entries: FabricMemoryExpandedEntry[];
  next?: FabricMemoryCall<"memory.expand", FabricMemoryExpandArgs> | null;
  error?: FabricMemoryError;
}
interface FabricMemoryWalkResult {
  visited: number;
  stopped: boolean;
  error?: FabricMemoryError;
}
interface FabricMemorySessionInfo {
  id: string;
  file: string;
  cwd: string;
  mtime: number;
  entryCount: number;
  tier: "hot" | "cold";
  branches: FabricMemoryBranches;
  lineageFingerprint: string | null;
}
interface FabricMemoryApi {
  recall(args?: FabricMemoryRecallArgs): Promise<FabricMemoryRecallResult>;
  expand(args: FabricMemoryExpandArgs): Promise<FabricMemoryExpandResult>;
  walk(
    args: FabricMemoryExpandArgs,
    visitor: (
      entry: FabricMemoryExpandedEntry,
      index: number,
    ) => boolean | void | Promise<boolean | void>,
  ): Promise<FabricMemoryWalkResult>;
  sessions(args?: {
    source?: string;
    scope?: string;
    branches?: FabricMemoryBranches;
    limit?: number;
    max?: number;
  }): Promise<{
    scope?: string;
    branches?: FabricMemoryBranches;
    sessions?: FabricMemorySessionInfo[];
    error?: FabricMemoryError;
  }>;
}
interface FabricStateTransitionArgs {
  label: string;
  from?: string;
  to: string;
  summary: string;
  evidence?: string[];
  tags?: string[];
  kind?: "state" | "representation";
  complexity?: { files: string[] };
  force?: boolean;
  name?: string;
  description?: string;
}
interface FabricStateComplexityFile {
  file: string;
  supported: boolean;
  language?: string;
  current?: number;
  recorded?: number;
  delta?: number;
  recordedDelta?: number;
}
interface FabricStateVerificationResult {
  certified: boolean;
  violated: boolean;
  certificationStatus: "certified" | "failed";
  results: unknown[];
  failures: unknown[];
  certificate?: unknown;
  reportingError?: string;
  evidenceDigest: string;
  resultDigest: string;
  binding?: Record<string, string>;
  observed?: { commit?: string; dirty?: boolean };
  requestedBy?: "program" | "host";
}
interface FabricStateApi {
  transition(args: FabricStateTransitionArgs): Promise<{ event: FabricMeshEvent; head: unknown }>;
  get(): Promise<{
    head: unknown | null;
    goal: { check: string; description?: string } | null;
    complexity: { files: number; decisionPoints: number; lastNetDelta: number };
    certification: { current: unknown | null; recent: unknown[] };
    recentLabels: string[];
  }>;
  history(args?: { label?: string; limit?: number; includeArchived?: boolean; name?: string; max?: number }): Promise<{
    transitions: unknown[];
    labels: string[];
    certifications: unknown[];
  }>;
  complexity(args?: { files?: string[]; paths?: string[] }): Promise<{ files: FabricStateComplexityFile[]; netDelta: number }>;
  verify(args?: { labels?: string[]; includeArchived?: boolean; timeoutMs?: number; label?: string; binding?: Record<string, string> }): Promise<FabricStateVerificationResult>;
  goal(args: { check: string; description?: string; command?: string; cmd?: string; predicate?: string }): Promise<FabricMeshStateEntry<{ check: string; description?: string }>>;
  checkGoal(args?: { timeoutMs?: number }): Promise<{
    passed: boolean;
    output: string;
    exitCode: number | null;
    error?: string;
  }>;
}
type FabricSchemaEvidence =
  | { kind: "file_exists"; path: string }
  | { kind: "file_absent"; path: string }
  | { kind: "file_contains"; path: string; literal: string }
  | { kind: "file_sha256"; path: string; sha256: string }
  | { kind: "trusted_command"; name: string };
type FabricSchemaFileOperation =
  | { kind: "write"; path: string; content: string; expected: { absent: true } | { sha256: string } }
  | { kind: "edit"; path: string; oldText: string; newText: string; expectedSha256: string }
  | { kind: "delete"; path: string; expectedSha256: string };
interface FabricSchemaEvidenceResult {
  evidence: FabricSchemaEvidence;
  status: "confirmed" | "nonconfirmed" | "error";
  detail: string;
  exitCode?: number | null;
  output?: string;
  observedSha256?: string;
}
interface FabricSchemaStatus {
  mode: "off" | "audit" | "enforce";
  certificateTtlMs: number;
  maxFiles: number;
  maxBytes: number;
  trustedCommands: string[];
  generation: number;
  lastOutcome: "committed" | "rolled_back" | "quarantined" | null;
  hypotheses: Array<{
    id: string;
    label: string;
    status: string;
    generation: number;
    updatedAt: number;
  }>;
}
interface FabricSchemaVerificationResult {
  verified: boolean;
  hypothesisId: string;
  certificate?: string;
  issuedAt?: number;
  expiresAt?: number;
  reason?: string;
  results: FabricSchemaEvidenceResult[];
}
interface FabricSchemaCommitResult {
  outcome: "committed" | "rolled_back" | "quarantined";
  transactionId: string;
  generation?: number;
  paths?: string[];
  postconditions?: FabricSchemaEvidenceResult[];
  complexityReductionCertified?: boolean;
  stateTransition?: unknown;
  error?: string;
  rollbackError?: string;
}
interface FabricSchemaApi {
  status(): Promise<FabricSchemaStatus>;
  hypothesize(args: {
    label: string;
    summary: string;
    evidence: FabricSchemaEvidence[];
    complexityReduction?: boolean;
    name?: string;
    description?: string;
    complexity_reduction?: boolean;
  }): Promise<{
    hypothesisId: string;
    status: string;
    state: unknown;
    fingerprint: string;
    generation: number;
  }>;
  verify(args: { hypothesisId: string; id?: string; hypothesis_id?: string }): Promise<FabricSchemaVerificationResult>;
  commit(args: {
    hypothesisId: string;
    certificate: string;
    operations: FabricSchemaFileOperation[];
    postconditions: FabricSchemaEvidence[];
    id?: string;
    hypothesis_id?: string;
  }): Promise<FabricSchemaCommitResult>;
  abort(args: { hypothesisId: string; certificate?: string; id?: string; hypothesis_id?: string }): Promise<{
    aborted: true;
    hypothesisId: string;
  }>;
}
interface FabricCompactPendingIntent {
  reason?: string;
  instructions?: string;
  preserve?: string[];
  requestedBy: string;
  requestedAt: number;
}
type FabricCompactionOwner = "fabric" | "pi" | "external" | "none";
interface FabricCompactLastCommit {
  at: number;
  requestedBy: string;
  status: "committed" | "cancelled" | "failed";
  summary?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  error?: string;
}
type FabricComponentState = "waiting" | "loading" | "active" | "unloading" | "failed" | "quarantined" | "disposed";
interface FabricComponentEffectInfo {
  label: string;
  kind: "none" | "scoped" | "transactional" | "emission";
  resources: string[];
  ordering: "commutative" | "ordered" | "unknown";
}
interface FabricComponentEffectConflict {
  withComponent: string;
  resources: string[];
  reason: "shared_resource" | "unknown_resource";
}
interface FabricComponentInfo {
  id: string;
  component: string;
  parentId?: string;
  state: FabricComponentState;
  guarantee: "managed" | "revertible";
  requirements: string[];
  provisions: string[];
  missing: string[];
  optionalMissing: string[];
  effects?: FabricComponentEffectInfo[];
  effectConflicts?: FabricComponentEffectConflict[];
  targetDigest?: string;
  error?: string;
  cleanupErrors?: string[];
  revision: number;
  createdAt: number;
  updatedAt: number;
}
interface FabricComponentEntry {
  id: string;
  component: string;
  config?: unknown;
  disabled?: boolean;
}
interface FabricComponentDefinitionInfo {
  name: string;
  description?: string;
  revision: number;
  configSchema?: Record<string, unknown>;
  requirements: string[];
  provisions: string[];
}
interface FabricComponentConfigSource {
  scope: "global" | "project";
  path: string;
  trusted: boolean;
  present: boolean;
  selected: boolean;
}
interface FabricComponentConfigurationInfo {
  sources: FabricComponentConfigSource[];
  warnings: string[];
  sessionOverrides: string[];
  removalPolicy: "drain";
  error?: string;
}
interface FabricComponentChangeRequest {
  scope?: "session" | "global" | "project";
  entries?: FabricComponentEntry[];
  remove?: string[];
  reset?: string[];
}
interface FabricComponentChangePlan {
  revision: string;
  request: Required<FabricComponentChangeRequest>;
  changes: Array<{ id: string; operation: "add" | "replace" | "remove"; component: string; requirements: string[]; provisions: string[] }>;
  warnings: string[];
  sources: FabricComponentConfigSource[];
}
interface FabricComponentsApi {
  list(): Promise<{
    definitions: FabricComponentDefinitionInfo[];
    components: FabricComponentInfo[];
    configuration: FabricComponentConfigurationInfo;
  }>;
  describe(args: { component: string }): Promise<FabricComponentDefinitionInfo & { instances: FabricComponentInfo[] }>;
  plan(args: FabricComponentChangeRequest): Promise<FabricComponentChangePlan>;
  apply(args: FabricComponentChangeRequest & { expectedRevision: string }): Promise<{ components: FabricComponentInfo[]; configuration: FabricComponentConfigurationInfo; scope: "session" | "global" | "project" }>;
  reconcile(): Promise<{ components: FabricComponentInfo[]; configuration: FabricComponentConfigurationInfo }>;
  status(args: { id: string }): Promise<FabricComponentInfo>;
  graph(): Promise<{
    components: FabricComponentInfo[];
    edges: Array<{ from: string; to: string; ref: string; kind?: "dependency" | "ownership" }>;
    cycles: string[][];
  }>;
  reload(args?: { id?: string }): Promise<{ components: FabricComponentInfo[] }>;
}

interface FabricCacheHoldOptions {
  target?: "self" | "main";
  durationMs: number;
  /** Currently unsupported: requesting this bound rejects acquisition. */
  maxRefreshes?: number;
  /** Currently unsupported: requesting this bound rejects acquisition. */
  maxCostUsd?: number;
}
interface FabricCacheLease {
  id: string; scope: "session" | "component"; sessionId: string; model: string; expiresAt: number;
}
type FabricCacheHoldResult = ({ status: "held" } & FabricCacheLease)
  | { status: "unsupported" | "unavailable"; reason: string };
interface FabricCacheSample {
  entryId: string; observedAt: number; input: number; cacheRead: number; cacheWrite: number;
  output: number; totalInput: number; cacheReadShare: number; reportedCostUsd: number | null;
}
interface FabricCacheObservation {
  lastRequest: FabricCacheSample | null; lastRefresh: FabricCacheSample | null;
  maintenance: { requests: number; tokens: number; reportedCostUsd: number; unknownCostRequests: number; unknownTokenRequests: number };
  window: { entries: number; limit: number; truncated: boolean; stoppedAt: string | null };
}
interface FabricCacheStatus {
  target: "self"; sessionId: string; model: string | null; supported: boolean; reason: string | null;
  limits: { durationMs: true; maxRefreshes: false; maxCostUsd: false };
  leases: FabricCacheLease[]; scheduled: null; cleanupError: string | null; observation: FabricCacheObservation;
}
interface FabricCacheApi {
  status(args?: { target?: "self" | "main" }): Promise<FabricCacheStatus>;
  hold(args: FabricCacheHoldOptions): Promise<FabricCacheHoldResult>;
  release(args: { id: string }): Promise<{ released: boolean; cleanupError: string | null }>;
}

interface FabricThinkingBounds { min?: FabricThinking; max?: FabricThinking }
interface FabricThinkingOverride {
  level: FabricThinking;
  scope: "turn" | "turns" | "session";
  remainingTurns?: number;
  reason?: string;
  setAt: number;
}
interface FabricThinkingStatus {
  level: FabricThinking;
  available: FabricThinking[];
  bounds: { min: FabricThinking; max: FabricThinking };
  baseline: FabricThinking;
  override?: FabricThinkingOverride;
}
interface FabricThinkingApi {
  status(): Promise<FabricThinkingStatus>;
  set(args: { level: FabricThinking; scope?: "turn" | "turns" | "session"; turns?: number; reason?: string }): Promise<FabricThinkingStatus & { clamped?: true; requested?: FabricThinking }>;
  reset(): Promise<FabricThinkingStatus>;
}

interface FabricDecision {
  id: string; kind: "approval" | "question" | "escalation"; title: string; body?: string;
  options?: Array<{ id: string; label: string }>; input: "text" | "confirm" | "select" | "editor";
  raisedBy: { participantId: string; runId?: string; sessionId?: string };
  holder: string; createdAt: number; deadline?: number; onExpire: "cancel" | "default" | "escalate"; defaultOptionId?: string;
  escalation?: { chain: string[]; hop: number; hopTimeoutMs: number; onFinal: "cancel" | "default" };
  history?: Array<{ holder: string; until: number; reason: "expired" | "escalated"; text?: string; by?: string }>;
  status: "open" | "answered" | "expired" | "cancelled";
  answer?: { optionId?: string; text?: string; answeredBy: string; via: string; at: number };
}
interface FabricDecisionsApi {
  raise(args: { title: string; kind?: FabricDecision["kind"]; body?: string; options?: Array<{ id: string; label: string }>; input?: FabricDecision["input"]; holder?: string; deadline?: number; timeoutMs?: number; onExpire?: "cancel" | "default" | "escalate"; defaultOptionId?: string; escalation?: { chain?: string[]; hopTimeoutMs?: number; onFinal?: "cancel" | "default" } }): Promise<{ id: string }>;
  wait(args: { id: string; timeoutMs?: number }): Promise<FabricDecision>;
  list(args?: { status?: FabricDecision["status"]; holder?: string; limit?: number }): Promise<FabricDecision[]>;
  answer(args: { id: string; optionId?: string; text?: string }): Promise<FabricDecision>;
  escalate(args: { id: string; reason?: string }): Promise<FabricDecision>;
  cancel(args: { id: string }): Promise<FabricDecision>;
}

type FabricProgramStatus = "candidate" | "promoted" | "retired";
interface FabricProgramSummary {
  /** name@digest12 */
  ref: string; name: string; digest: string; kind: "fabric" | "jev"; kernel?: "typescript" | "python";
  description?: string; createdAt: number; status: FabricProgramStatus;
}
interface FabricProgramRecord extends FabricProgramSummary {
  version: 1; code?: string; jevProgram?: Record<string, unknown>; inputSchema?: Record<string, unknown>; trial?: unknown;
}
interface FabricProgramsApi {
  /** Always saved as a candidate; identical content returns the same ref. */
  save(args: { name: string; kind?: "fabric" | "jev"; kernel?: "typescript" | "python"; code?: string; jevProgram?: Record<string, unknown>; description?: string; inputSchema?: Record<string, unknown> }): Promise<{ ref: string; digest: string }>;
  list(args?: { name?: string; status?: FabricProgramStatus }): Promise<FabricProgramSummary[]>;
  /** ref: name (latest promoted, else latest candidate), name@<digest prefix >= 12>, or a full digest. */
  get(args: { ref: string }): Promise<FabricProgramRecord>;
  /** Runs nested with this program's capabilities; args.input becomes the saved program's input global. */
  run<T = unknown>(args: { ref: string; input?: unknown; requirePromoted?: boolean }): Promise<T>;
}

interface FabricCompactApi {
  request(args?: {
    reason?: string;
    instructions?: string;
    preserve?: string[];
    requestedBy?: string;
    instruction?: string;
    requested_by?: string;
  }): Promise<{ requested: true; intent: FabricCompactPendingIntent }>;
  status(): Promise<{
    pending?: FabricCompactPendingIntent;
    last?: FabricCompactLastCommit;
    lastAuto?: { at: number; trigger: "headroom" | "tokens" | "ratio"; committed: boolean };
    owner: FabricCompactionOwner;
    outputReserveTokens: number;
  }>;
  /** Read-only context pressure; never compacts. */
  pressure(): Promise<{
    tokens: number | null;
    contextWindow: number | null;
    fraction: number | null;
    headroomTokens: number | null;
    band: "ok" | "warn" | "urgent" | "unknown";
    outputReserveTokens: number;
    thresholdFraction?: number;
    thresholdTokens?: number;
    owner: FabricCompactionOwner;
  }>;
  /** Persistent carry-forward focus rendered in every Fabric summary until cleared; no args reads. */
  carry(args?: { items?: string[]; add?: string[]; remove?: string[]; clear?: boolean }): Promise<{ items: string[] }>;
  cancel(): Promise<{ cancelled: true }>;
}

interface FabricPrewalkFileIdentityStatus {
  path: string;
  loadedSha256: string;
  diskSha256: string;
  stale: boolean;
}
interface FabricPrewalkApi {
  /** Only when Fabric's armed advisory or checkpoint requests an executor handoff plan.
   * Not a task planner, checklist, or acceptance-ledger store; unavailable otherwise. */
  plan(args: {
    outcome: string;
    steps: string[];
    verification: string[];
    risks: string;
  }): Promise<{ recorded: true; readiness: "ready"; plan: string }>;
  status(): Promise<{
    state: "idle" | "armed" | "handing_off" | "continuation_pending";
    planRequired: boolean;
    planReady: boolean;
    planPrompts: number;
    claimedReadiness: "planned" | "disabled" | "unplanned" | null;
    runtime?: {
      entry: FabricPrewalkFileIdentityStatus | null;
      lazyRuntime: FabricPrewalkFileIdentityStatus | null;
    };
  }>;
}

interface FabricWorkflowAgentOptions extends Omit<FabricAgentRequest, "task"> {
  label?: string;
}
type FabricActivityStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "stopped";
type FabricActivityKind = "agent" | "actor" | "tool" | "extension" | "mcp" | "mesh" | "task" | "custom";
interface FabricWorkflowDisplay {
  name?: string;
  description?: string;
}
interface FabricWorkflowPhaseOptions {
  id?: string;
  description?: string;
  total?: number;
}
interface FabricWorkflowPhaseInput extends FabricWorkflowPhaseOptions {
  name: string;
}
interface FabricWorkflowItem {
  /** Stable id, 1-128 chars of [A-Za-z0-9._:/-]; omitted ids become item-<n> per invocation. */
  id?: string;
  label: string;
  status?: FabricActivityStatus;
  phase?: string;
  detail?: string;
  kind?: FabricActivityKind;
  current?: string;
  total?: number;
  completed?: number;
  data?: unknown;
  /** Plain JSON object (<= 2 KiB) carried only on the host pi-fabric:workflow-item:v1 event. */
  meta?: Record<string, unknown>;
}
interface FabricWorkflowApi {
  agent<T = string>(prompt: string, options?: FabricWorkflowAgentOptions): Promise<T>;
  parallel<T, R>(items: T[], mapper: (item: T, index: number) => Promise<R> | R, concurrency?: number | { concurrency?: number }): Promise<R[]>;
  parallel<T>(thunks: Array<() => Promise<T> | T>, concurrency?: number | { concurrency?: number }): Promise<T[]>;
  pipeline<T>(items: T[], ...stages: Array<(value: unknown, original: T, index: number) => Promise<unknown> | unknown>): Promise<unknown[]>;
  configure(display: FabricWorkflowDisplay): Promise<FabricWorkflowDisplay>;
  phase(name: string, options?: FabricWorkflowPhaseOptions): Promise<{ name: string; index: number; id?: string }>;
  phase(input: FabricWorkflowPhaseInput): Promise<{ name: string; index: number; id?: string }>;
  item(item: FabricWorkflowItem): Promise<FabricWorkflowItem>;
  event(event: { message: string; level?: "info" | "success" | "warning" | "error"; data?: unknown }): Promise<void>;
  log(...values: unknown[]): void;
  budget: { total: number; spent(): number; remaining(): number };
}
declare const tools: FabricToolsApi;
declare const nativeTools: Record<string, (args?: Record<string, unknown>) => Promise<any>>;
declare const fabric: { readonly tools: FabricToolsApi };
declare const pi: PiToolsApi;
declare const extensions: FabricExtensionsApi;
declare const agents: FabricAgentsApi;
declare const mesh: FabricMeshApi;
declare const mcp: FabricMcpApi;
declare const memory: FabricMemoryApi;
declare const state: FabricStateApi;
declare const schema: FabricSchemaApi;
declare const components: FabricComponentsApi;
declare const compact: FabricCompactApi;
declare const cache: FabricCacheApi;
declare const thinking: FabricThinkingApi;
declare const decisions: FabricDecisionsApi;
declare const programs: FabricProgramsApi;
declare const prewalk: FabricPrewalkApi;
${JEV_GUEST_DECLARATIONS}
declare const council: FabricCouncilApi;
declare const workflow: FabricWorkflowApi;
declare function agent<T = string>(prompt: string, options?: FabricWorkflowAgentOptions): Promise<T>;
declare function parallel<T, R>(items: T[], mapper: (item: T, index: number) => Promise<R> | R, concurrency?: number | { concurrency?: number }): Promise<R[]>;
declare function parallel<T>(thunks: Array<() => Promise<T> | T>, concurrency?: number | { concurrency?: number }): Promise<T[]>;
declare function pipeline<T>(items: T[], ...stages: Array<(value: unknown, original: T, index: number) => Promise<unknown> | unknown>): Promise<unknown[]>;
declare function phase(name: string, options?: FabricWorkflowPhaseOptions): Promise<{ name: string; index: number; id?: string }>;
declare function phase(input: FabricWorkflowPhaseInput): Promise<{ name: string; index: number; id?: string }>;
declare function log(...values: unknown[]): void;
declare const budget: FabricWorkflowApi["budget"];
type FabricRlmRequest = Omit<FabricAgentRequest, "runner" | "recursive"> & { runner?: "pi" | "pi-durable" };
declare const rlm: { query(args: FabricRlmRequest): Promise<FabricAgentResult> };
interface FabricConsole {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
declare const console: FabricConsole;
declare const π: Readonly<Record<string, string>>;
// Process runtimes only: node/bun children bridge native-module imports;
// quickjs has no module loader and rejects __fabricImport at runtime.
declare function __fabricImport(specifier: string): Promise<any>;
declare function print(...args: unknown[]): void;
declare function setTimeout(handler: (...args: any[]) => void, timeout?: number): number;
declare function clearTimeout(handle: number): void;
declare function setInterval(handler: (...args: any[]) => void, timeout?: number): number;
declare function clearInterval(handle: number): void;
// Process runtimes only: the bun-process child binds the host's real Bun
// module namespace as __bun; undefined under node-process and quickjs.
declare const __bun: any;
`;

const FULL_CODE_GLOBAL_DECLARATIONS = [
  "declare const pi: PiToolsApi;\n",
  "declare const extensions: FabricExtensionsApi;\n",
];

const PI_LOOSE_DECLARATION = "declare const pi: PiToolsApi;\n";
const MCP_LOOSE_DECLARATION = "declare const mcp: FabricMcpApi;\n";
const EXTENSIONS_LOOSE_DECLARATION = "declare const extensions: FabricExtensionsApi;\n";

export interface FabricGuestDeclarationOptions {
  /** Global names to omit (for example providers disabled by configuration). */
  excludeGlobals?: readonly string[];
  /**
   * Pre-rendered replacement blocks from buildDynamicGuestDeclarations().
   * Applied only when the loose anchor line is still present — excluded
   * globals (or orchestration-only mode, for extensions) keep nothing to
   * replace, and missing/undefined sections keep the loose surface.
   */
  dynamic?: FabricDynamicGuestDeclarations;
  /**
   * Additive overloads for the current captured exact-name core overrides.
   * The block is applied only to the full-code `pi` declaration.
   */
  coreOverrides?: string;
}

const globalDeclarationLine = (name: string): RegExp =>
  new RegExp(`^declare const ${name}: [^\\n]*;\\n`, "m");

const terminatedDeclaration = (block: string): string =>
  block.endsWith("\n") ? block : `${block}\n`;

export const guestTypeDeclarations = (
  fullCodeMode: boolean,
  options: FabricGuestDeclarationOptions = {},
): string => {
  const base = fullCodeMode
    ? GUEST_TYPE_DECLARATIONS
    : FULL_CODE_GLOBAL_DECLARATIONS.reduce(
        (declarations, declaration) => declarations.replace(declaration, ""),
        GUEST_TYPE_DECLARATIONS,
      );
  let result = (options.excludeGlobals ?? []).reduce(
    (declarations, name) => declarations.replace(globalDeclarationLine(name), ""),
    base,
  );
  if (fullCodeMode && options.coreOverrides && result.includes(PI_LOOSE_DECLARATION)) {
    result = result.replace(
      PI_LOOSE_DECLARATION,
      terminatedDeclaration(options.coreOverrides),
    );
  }
  if (options.dynamic?.mcp && result.includes(MCP_LOOSE_DECLARATION)) {
    result = result.replace(
      MCP_LOOSE_DECLARATION,
      terminatedDeclaration(options.dynamic.mcp),
    );
  }
  if (options.dynamic?.extensions && result.includes(EXTENSIONS_LOOSE_DECLARATION)) {
    result = result.replace(
      EXTENSIONS_LOOSE_DECLARATION,
      terminatedDeclaration(options.dynamic.extensions),
    );
  }
  return result;
};
