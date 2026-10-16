import type { BashOperations, BashToolOptions, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Host-local opt-in on a bash ToolDefinition; never serialized into guest schemas. */
export const FABRIC_BASH_MIDDLEWARE = Symbol.for("pi-fabric:bash-middleware:v1");

/** The extension keeps standalone execution; Fabric owns local process/job lifetime. */
export interface FabricBashMiddlewareV1 {
  version: 1;
  options?: Omit<BashToolOptions, "operations">;
  /** Filter output before Fabric retains it in previews, results, or background logs. */
  wrapOperations: (operations: BashOperations) => BashOperations;
}

export type {
  FabricCacheHoldOptions, FabricCacheHoldResult, FabricCacheLease,
  FabricCacheSample, FabricCacheObservation, FabricCacheStatus,
} from "./cache/types.js";

/** Host-local background shell accounting, independent of model-facing notifications. */
export const FABRIC_SHELL_TIMING_EVENT = "pi-fabric:shell:timing:v1";

export interface FabricShellTimingV1 {
  version: 1;
  sessionId: string;
  taskId: string;
  tool: "bash" | "powershell";
  /** started = handoff to background; finished includes runtime teardown. */
  phase: "started" | "finished";
  /** Synchronous observation time, not a backdated process timestamp. */
  timestamp: number;
}

/** Host-emitted on each `workflow.item` status transition; observation only. */
export const FABRIC_WORKFLOW_ITEM_EVENT = "pi-fabric:workflow-item:v1";

export type FabricWorkflowItemStatusV1 =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "stopped";

export interface FabricWorkflowItemEventV1 {
  version: 1;
  /** The outer `fabric_exec` tool call id that owns the item. */
  invocationId: string;
  sessionId?: string;
  /** Caller-supplied stable id, or the deterministic per-invocation `item-<n>`. */
  itemId: string;
  label?: string;
  /** Absent on the item's first status. */
  from?: FabricWorkflowItemStatusV1;
  to: FabricWorkflowItemStatusV1;
  /** Synchronous observation time (epoch ms). */
  at: number;
  /** Caller-supplied plain JSON object carried by the transitioning call. */
  meta?: Record<string, unknown>;
}

/** Host-local request: run a saved program without the model, like `/fabric run`. */
export const FABRIC_PROGRAM_RUN_EVENT = "pi-fabric:program:run:v1";

export type FabricProgramRunReplyV1 =
  | { ok: true; program: string; value: unknown; logs: string[] }
  | { ok: false; error: string; program?: string };

export interface FabricProgramRunRequestV1 {
  /** name, name@<digest prefix >= 12>, or a full digest. */
  ref: string;
  input?: unknown;
  requirePromoted?: boolean;
  signal?: AbortSignal;
  /** Called exactly once. */
  reply: (result: FabricProgramRunReplyV1) => void;
}

export const FABRIC_PROVIDER_REGISTER_EVENT = "pi-fabric:provider:register:v1";
export const FABRIC_PROVIDER_DISCOVER_EVENT = "pi-fabric:provider:discover:v1";
export const FABRIC_PROVIDER_WITHDRAW_EVENT = "pi-fabric:provider:withdraw:v1";

/**
 * Withdraws a directly registered provider. `generation` pins the withdrawal
 * to one binding: a number matches the binding generation, a string matches
 * the provider binding id. A mismatch or unknown name is ignored.
 */
export interface FabricProviderWithdrawalV1 {
  name: string;
  generation?: number | string;
}

export const readFabricProviderWithdrawalV1 = (
  value: unknown,
): FabricProviderWithdrawalV1 | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const generation = record.generation;
  if (
    typeof record.name !== "string" ||
    record.name.length === 0 ||
    record.name.length > 128 ||
    (generation !== undefined &&
      !(typeof generation === "number" && Number.isSafeInteger(generation) && generation > 0) &&
      !(typeof generation === "string" && generation.length > 0 && generation.length <= 128))
  ) {
    return undefined;
  }
  return {
    name: record.name,
    ...(generation !== undefined ? { generation: generation as number | string } : {}),
  };
};

export const FABRIC_TOOL_PLACEMENT_EVENT = "pi-fabric:tool-placement:v1";
export const MAX_FABRIC_TOOL_PLACEMENT_QUERY = 1_024;

/**
 * model = declared to the model this turn; program = callable from
 * fabric_exec (pi.* / extensions.*); unavailable otherwise. model wins when
 * both apply.
 */
export type FabricToolPlacement = "model" | "program" | "unavailable";
export type FabricToolPlacementMode = "full-code" | "enforce" | "orchestration";

export interface FabricToolPlacementResultV1 {
  version: 1;
  mode: FabricToolPlacementMode;
  tools: Record<string, FabricToolPlacement>;
  /** `model` tools a program can also call (foreground tools); omitted when empty. */
  programCallable?: string[];
}

/** Host-local synchronous query; omitted `tools` reports every registered tool. */
export interface FabricToolPlacementRequestV1 {
  tools?: string[];
  reply: (result: FabricToolPlacementResultV1) => void;
}

export const readFabricToolPlacementRequestV1 = (
  value: unknown,
): FabricToolPlacementRequestV1 | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const tools = record.tools;
  if (
    typeof record.reply !== "function" ||
    (tools !== undefined && (
      !Array.isArray(tools) ||
      tools.length > MAX_FABRIC_TOOL_PLACEMENT_QUERY ||
      tools.some((name) => typeof name !== "string" || name.length === 0 || name.length > 256)
    ))
  ) {
    return undefined;
  }
  return value as FabricToolPlacementRequestV1;
};
/** Asks trace-context listeners for the W3C trace context of a child about to launch. */
export const FABRIC_CHILD_TRACE_CONTEXT_EVENT = "pi-fabric:child-trace-context:v1";
export type {
  FabricChildTraceContextRequestV1,
  FabricTraceContextV1,
} from "./agents/trace-context.js";
export const FABRIC_COMPONENT_REGISTER_EVENT = "pi-fabric:component:register:v1";
export const FABRIC_COMPONENT_DISCOVER_EVENT = "pi-fabric:component:discover:v1";
export const FABRIC_PREWALK_REQUEST_EVENT = "pi-fabric:prewalk:request:v1";

export type FabricPrewalkRequestResultV1 =
  | { ok: true }
  | { ok: false; error: string };

/** Host-local request used by queue extensions that need an acknowledged prewalk arm. */
export interface FabricPrewalkRequestV1 {
  version: 1;
  context: ExtensionContext;
  claim: () => boolean;
  respond: (result: FabricPrewalkRequestResultV1) => void;
}

export const readFabricPrewalkRequestV1 = (
  value: unknown,
): FabricPrewalkRequestV1 | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.context !== "object" ||
    record.context === null ||
    typeof record.claim !== "function" ||
    typeof record.respond !== "function"
  ) {
    return undefined;
  }
  return value as FabricPrewalkRequestV1;
};

export const FABRIC_PEER_CARDS_EVENT = "pi-fabric:peers:cards:v1";
export const FABRIC_PEER_AWAIT_SETTLE_EVENT = "pi-fabric:peer:await-settle:v1";

/** One root peer session on the project mesh, for pickers and status lines. */
export interface FabricPeerCardV1 {
  id: string;
  /** Linear-style project label (e.g. "PQS-2") minted by the owning host. */
  label: string;
  status: "idle" | "running";
  model?: string;
  cwd?: string;
  startedAt: number;
  updatedAt: number;
  pendingMessages: boolean;
}

export type FabricPeerCardsResultV1 =
  | { ok: true; cards: FabricPeerCardV1[] }
  | { ok: false; error: string };

/** Host-local request used by queue extensions to enumerate live peer sessions. */
export interface FabricPeerCardsRequestV1 {
  version: 1;
  context: ExtensionContext;
  claim: () => boolean;
  respond: (result: FabricPeerCardsResultV1) => void;
}

export const readFabricPeerCardsRequestV1 = (
  value: unknown,
): FabricPeerCardsRequestV1 | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.context !== "object" ||
    record.context === null ||
    typeof record.claim !== "function" ||
    typeof record.respond !== "function"
  ) {
    return undefined;
  }
  return value as FabricPeerCardsRequestV1;
};

export interface FabricPeerSettleProgressV1 {
  waiting: Array<{ label: string; status: "idle" | "running" }>;
}

export type FabricPeerAwaitSettleResultV1 =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Host-local request used by queue extensions to hold dispatch until peer
 * sessions settle. A peer counts as settled once it has been quiet
 * (status-wide) for settledForMs; peers that vanish from the mesh count as
 * settled since they can no longer conflict. Selector matches a peer label
 * (case-insensitive) or exact participant id; omitted waits on all peers.
 */
export interface FabricPeerAwaitSettleRequestV1 {
  version: 1;
  context: ExtensionContext;
  selector?: string;
  settledForMs?: number;
  signal?: AbortSignal;
  update?: (progress: FabricPeerSettleProgressV1) => void;
  claim: () => boolean;
  respond: (result: FabricPeerAwaitSettleResultV1) => void;
}

export const readFabricPeerAwaitSettleRequestV1 = (
  value: unknown,
): FabricPeerAwaitSettleRequestV1 | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const signal = record.signal as AbortSignal | undefined;
  if (
    record.version !== 1 ||
    typeof record.context !== "object" ||
    record.context === null ||
    typeof record.claim !== "function" ||
    typeof record.respond !== "function" ||
    (record.selector !== undefined && typeof record.selector !== "string") ||
    (record.settledForMs !== undefined && typeof record.settledForMs !== "number") ||
    (signal !== undefined && typeof signal.aborted !== "boolean") ||
    (record.update !== undefined && typeof record.update !== "function")
  ) {
    return undefined;
  }
  return value as FabricPeerAwaitSettleRequestV1;
};

export const FABRIC_DECISIONS_CAPABILITY_EVENT = "pi-fabric:decisions:capability:v1";
export const FABRIC_DECISION_REQUEST_EVENT = "pi-fabric:decisions:request:v1";

export type FabricDecisionInputV1 = "text" | "confirm" | "select" | "editor";

export type FabricDecisionsCapabilityResultV1 =
  | {
      ok: true;
      available: true;
      inputs: FabricDecisionInputV1[];
      maxOptions: number;
      maxTitleChars: number;
      maxBodyChars: number;
      maxTextChars: number;
      minTimeoutMs: number;
      maxTimeoutMs: number;
    }
  | { ok: true; available: false; reason: string }
  | { ok: false; error: string };

/**
 * Host-local request: does this session offer user-held durable decisions?
 * An unclaimed request means no compatible Fabric runtime is installed.
 */
export interface FabricDecisionsCapabilityRequestV1 {
  version: 1;
  context: ExtensionContext;
  claim: () => boolean;
  respond: (result: FabricDecisionsCapabilityResultV1) => void;
}

/** One question for a person. Fabric always holds it for `"user"` and never applies a default. */
export interface FabricDecisionQuestionV1 {
  title: string;
  body?: string;
  /** Defaults to `"select"` with options, else `"text"`. `"confirm"` supplies yes/no. */
  input?: FabricDecisionInputV1;
  options?: Array<{ id: string; label: string }>;
  /** Omit to wait until a person answers or cancels, or the request signal aborts. */
  timeoutMs?: number;
}

export interface FabricDecisionAnswerV1 {
  optionId?: string;
  text?: string;
  answeredBy: string;
  via: string;
  at: number;
}

/** Only `answered` carries an answer; `cancelled` and `expired` never do. */
export type FabricDecisionResultV1 =
  | { ok: true; id: string; status: "answered"; answer: FabricDecisionAnswerV1 }
  | { ok: true; id: string; status: "cancelled" | "expired" }
  | { ok: false; error: string; id?: string };

/**
 * Host-local request: raise a user-held question decision and respond once it
 * settles. Aborting `signal` cancels the decision and responds `ok: false`.
 */
export interface FabricDecisionRequestV1 {
  version: 1;
  context: ExtensionContext;
  question: FabricDecisionQuestionV1;
  signal?: AbortSignal;
  /**
   * Names the asking extension, for example its package name. Recorded as
   * `raisedBy.participantId: "extension:<source>"`. Must match
   * `[A-Za-z0-9@][A-Za-z0-9@._/-]{0,63}`; omit it to record the session.
   */
  source?: string;
  /** Called once the decision is stored, before waiting starts. */
  onRaised?: (id: string) => void;
  claim: () => boolean;
  respond: (result: FabricDecisionResultV1) => void;
}

export const readFabricDecisionsCapabilityRequestV1 = (
  value: unknown,
): FabricDecisionsCapabilityRequestV1 | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.context !== "object" ||
    record.context === null ||
    typeof record.claim !== "function" ||
    typeof record.respond !== "function"
  ) {
    return undefined;
  }
  return value as FabricDecisionsCapabilityRequestV1;
};

export const readFabricDecisionRequestV1 = (
  value: unknown,
): FabricDecisionRequestV1 | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const signal = record.signal as AbortSignal | undefined;
  if (
    record.version !== 1 ||
    typeof record.context !== "object" ||
    record.context === null ||
    typeof record.question !== "object" ||
    record.question === null ||
    Array.isArray(record.question) ||
    typeof record.claim !== "function" ||
    typeof record.respond !== "function" ||
    (signal !== undefined && (typeof signal !== "object" || signal === null || typeof signal.aborted !== "boolean")) ||
    (record.source !== undefined && typeof record.source !== "string") ||
    (record.onRaised !== undefined && typeof record.onRaised !== "function")
  ) {
    return undefined;
  }
  return value as FabricDecisionRequestV1;
};

/** Identifies host-side tool lifecycle events replayed for a nested Fabric call. */
export const FABRIC_NESTED_TOOL_CALL_ID_PREFIX = "fabric_";

/** Discriminant for the transient details envelope on a proxied provider result. */
export const FABRIC_TOOL_RESULT_PROXY_KIND = "pi-fabric.tool-result-proxy.v1";

/**
 * Host-only middleware details for non-Pi Fabric providers. `result` is the
 * exact value before maxNestedResultChars is enforced and is not persisted as
 * a separate Pi tool-result message.
 */
export interface FabricToolResultProxyDetailsV1 {
  kind: typeof FABRIC_TOOL_RESULT_PROXY_KIND;
  ref: string;
  result: unknown;
}

export const readFabricToolResultProxyDetailsV1 = (
  value: unknown,
): FabricToolResultProxyDetailsV1 | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.kind !== FABRIC_TOOL_RESULT_PROXY_KIND ||
    typeof record.ref !== "string" ||
    !Object.prototype.hasOwnProperty.call(record, "result")
  ) {
    return undefined;
  }
  return record as unknown as FabricToolResultProxyDetailsV1;
};

export type FabricRisk = "read" | "write" | "execute" | "network" | "agent";
export type FabricEffectKind = "none" | "scoped" | "transactional" | "emission";
export type FabricEffectOrdering = "commutative" | "ordered" | "unknown";

export interface FabricActionEffect {
  kind: FabricEffectKind;
  resources?: string[];
  ordering?: FabricEffectOrdering;
}

/** MCP tool annotations (Model Context Protocol ToolAnnotations), cached when a runtime surfaces them. */
export interface FabricToolAnnotations {
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}
export type FabricActivityEntityKind =
  | "agent"
  | "actor"
  | "tool"
  | "extension"
  | "mcp"
  | "mesh"
  | "task"
  | "custom";

export type FabricInvocationActivityUpdate =
  | { type: "progress"; message: string }
  | { type: "entity"; id: string; kind: FabricActivityEntityKind; name?: string }
  | { type: "metrics"; tokens?: number; toolCalls?: number; cost?: number };

export interface FabricMediaBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export interface FabricActionDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  risk: FabricRisk;
  namespace?: string;
  effect?: FabricActionEffect;
  annotations?: FabricToolAnnotations;
}

export interface FabricCapabilityActionHead {
  key: string;
  parentKey: string;
  ref: string;
  name: string;
  description: string;
  descriptorHash: string;
  risk: FabricRisk;
  namespace?: string;
  effect?: FabricActionEffect;
}

export interface FabricCapabilityProviderHead {
  key: string;
  parentKey: string;
  name: string;
  description: string;
  descriptorHash: string;
  actions: FabricCapabilityActionHead[];
}

export interface FabricCapabilityBindingView {
  ref: string;
  provider: string;
  providerBindingId: string;
  generation: number;
  descriptorHash: string;
}

/** Immutable issuer-owned authority, not a serializable bearer grant.
 * Another registry must resolve a fresh view; copies and released views are invalid. */
export interface FabricCommittedCapabilityView {
  id: string;
  /** Runtime-local digest including provider binding generations. */
  digest: string;
  /** Portable digest of exact refs and descriptor semantics across runtimes. */
  semanticDigest: string;
  bindings: Record<string, FabricCapabilityBindingView>;
}

export interface FabricCapabilityResolution {
  satisfied: boolean;
  missing: string[];
  optionalMissing: string[];
  view?: FabricCommittedCapabilityView;
}

export interface FabricCapabilityCatalog {
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

export interface FabricProviderListRequest {
  namespace?: string;
  query?: string;
  limit?: number;
}

/** One named action whose arguments should be typed in guest declarations. */
export interface FabricNamedActionTypeSource {
  name: string;
  inputSchema: Record<string, unknown>;
}

/** One MCP server plus the tools to type for `mcp.<server>.*` guest calls. */
export interface FabricMcpServerTypeSource {
  server: string;
  tools: FabricNamedActionTypeSource[];
}

export type {
  FabricKernel,
  FabricKernelRuntime,
  FabricHostCall,
  FabricSandboxOptions,
  FabricSandboxResult,
  FabricSandboxTerminationReason,
} from "./runtime/kernel.js";
export type { FabricPythonRuntime } from "./config.js";

/**
 * Live descriptor snapshot the registry hands to the guest declaration
 * builder so dynamic surfaces (mcp, extensions) get argument checking before
 * the sandbox runs. Empty/absent sections keep the loose static declarations.
 */
export interface FabricGuestTypeSources {
  mcpServers?: FabricMcpServerTypeSource[];
  extensionTools?: FabricNamedActionTypeSource[];
}

/**
 * Pre-rendered `declare const` blocks replacing the loose mcp/extensions
 * declaration lines. Values are full replacement text (helpers + declare).
 */
export interface FabricDynamicGuestDeclarations {
  mcp?: string;
  extensions?: string;
}

/**
 * Provider-owned work (for example a delegated run) registered with Fabric's
 * participant directory under `provider:<provider>:<id>`. Non-detached
 * participants are stopped when their fabric_exec program is cancelled or
 * times out; detached ones survive until stopped, withdrawn, or shut down.
 */
export interface FabricParticipantSpec {
  /** Unique per provider while unsettled; `[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`. */
  id: string;
  label: string;
  kind?: string;
  detached?: boolean;
  stop(reason: string): Promise<{ confirmed: boolean }>;
  steer?(message: string): Promise<void>;
  followUp?(message: string): Promise<void>;
}

export interface FabricParticipantProgress {
  phase?: string;
  message?: string;
  /** Cumulative totals; each update replaces the previous usage. */
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number };
}

export interface FabricParticipantSettlement {
  status: "completed" | "failed" | "stopped";
  summary?: string;
}

export interface FabricParticipantHandle {
  readonly ref: string;
  update(progress: FabricParticipantProgress): void;
  settle(result: FabricParticipantSettlement): void;
  dispose(): void;
}

export interface FabricInvocationParticipants {
  register(spec: FabricParticipantSpec): FabricParticipantHandle;
}

/** Host-issued principal and grants (`pi-fabric/scope`); trusted host code, not a verified kernel. */
export type FabricScopeAction = "read" | "write" | "execute";
export interface FabricScopeGrant {
  /** `<ns>:<path>`, `<ns>:<path>/*` (one level), `<ns>:<path>/**` (any depth) or `<ns>:*`. */
  resource: string;
  actions: FabricScopeAction[];
}
export interface FabricScope {
  version: 1;
  principal: { id: string; issuer: "host" };
  /** At most 64, merged per resource and sorted. */
  grants: FabricScopeGrant[];
  /** sha256 hex of canonical JSON { grants, parentDigest?, principal }. */
  digest: string;
  parentDigest?: string;
}
/**
 * Host-stamped authority of a message's sender (actor mailbox items, mesh
 * events). "host" is an unscoped session; "scope" carries the sender's scope,
 * with grants when they fit. Absent on records written by older builds.
 */
export type FabricMessageSender =
  | { authority: "host" }
  | {
      authority: "scope";
      principalId: string;
      digest: string;
      grants?: FabricScopeGrant[];
      parentDigest?: string;
    };

export interface FabricInvocationContext {
  /** Host-selected result projection; never an action argument or an authority grant. */
  nativeToolResult?: boolean;
  cwd: string;
  signal: AbortSignal | undefined;
  parentToolCallId: string;
  nestedToolCallId: string;
  extensionContext: ExtensionContext;
  update(message: string): void;
  activity?(update: FabricInvocationActivityUpdate): void;
  /** Host-supplied inside fabric_exec: register provider-owned work as a participant. */
  participants?: FabricInvocationParticipants;
  /** Host-supplied inside fabric_exec so agents.handoff schedules the outer-call boundary. */
  deferHandoff?(args: Record<string, unknown>): Record<string, unknown>;
  // Out-of-band image content blocks a provider (currently only pi.read of an
  // image file) wants attached to the call audit, so the single-call render can
  // re-attach them to the fabric_exec result content for pi core's kitty image
  // preview. Bypasses the result char bound that would truncate the base64.
  // `note` is the read tool's own text output (e.g. "Read image file [image/png]"),
  // captured after any tool_result patch so a handoff that strips pi's
  // non-vision note has run; used as the single-call body + content text so the
  // preview shows the clean note instead of the swapped description.
  attachMedia?(blocks: FabricMediaBlock[], note?: string): void;
  // Providers call this after mutable tool_call middleware has run so live and
  // durable audit surfaces reflect the arguments actually passed to the tool.
  updateArguments?(args: Record<string, unknown>): void;
  // Ephemeral renderer-only metadata. It is exposed to live Fabric previews but
  // never projected into the durable execution trace.
  attachPreview?(preview: unknown): void;
  capabilityView?: FabricCommittedCapabilityView;
  /** Frozen host-issued scope; set by the registry only, absent when unscoped. */
  scope?: Readonly<FabricScope>;
  /** Advisory for ordinary calls; strict components reject concurrent conflicting effects. */
  effectPolicy?: "advisory" | "strict";
}

export interface FabricScopedProviderResult {
  value: unknown;
  dispose(): void | Promise<void>;
}

export interface FabricProvider {
  name: string;
  description: string;
  list(
    request: FabricProviderListRequest,
    context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]>;
  describe(
    actionName: string,
    context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined>;
  prepareArguments?(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown>;
  acquire?(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<FabricScopedProviderResult>;
  invocationEnded?(parentToolCallId: string): Promise<void>;
  subscribeCatalog?(listener: () => void): () => void;
  close?(): Promise<void>;
}

export interface FabricProviderRegistration {
  version: 1;
  provider: FabricProvider;
  overwrite?: boolean;
}

export interface FabricProviderDiscovery {
  version: 1;
  register(provider: FabricProvider, options?: { overwrite?: boolean }): void;
}

export type {
  ComponentChangeRequest as FabricComponentChangeRequest,
  ComponentChangePlan as FabricComponentChangePlan,
} from "./components/control.js";

export type {
  FabricCapabilityRequirement,
  FabricComponentChildOptions,
  FabricComponentContext,
  FabricComponentDefinition,
  FabricComponentDiscovery,
  FabricComponentDisposer,
  FabricComponentEffect,
  FabricComponentEffectConflict,
  FabricComponentEffectInfo,
  FabricComponentEffectOptions,
  FabricComponentEffectRegistration,
  FabricComponentEntry,
  FabricComponentGraph,
  FabricComponentGuarantee,
  FabricComponentHandle,
  FabricComponentInfo,
  FabricComponentProviderLease,
  FabricModelGuidance,
  FabricModelGuidanceInfo,
  FabricModelGuidancePlacement,
  FabricModelGuidanceTarget,
  FabricComponentProvision,
  FabricComponentRegistration,
  FabricComponentState,
  FabricComponentStopOptions,
} from "./components/types.js";

export {
  FABRIC_EXECUTION_GUIDANCE_SLOT,
  MAX_FABRIC_MODEL_GUIDANCE_CONTENT_CHARS,
  MAX_FABRIC_MODEL_GUIDANCE_PER_COMPONENT,
  MAX_FABRIC_MODEL_GUIDANCE_REGISTRATIONS,
  MAX_FABRIC_MODEL_GUIDANCE_SNAPSHOT_CHARS,
  MAX_FABRIC_MODEL_GUIDANCE_TOTAL_CHARS,
} from "./components/model-guidance.js";
