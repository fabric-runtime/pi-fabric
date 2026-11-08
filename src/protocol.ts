import type { FabricActionPolicyHookV1 } from "./core/action-policy-hooks.js";
import type {
  BashOperations,
  BashToolOptions,
  CompactionResult,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

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

/** Host-local request: run a saved program or caller-supplied code without the model, like `/fabric run`. */
export const FABRIC_PROGRAM_RUN_EVENT = "pi-fabric:program:run:v1";

export type FabricProgramRunReplyV1 =
  | { ok: true; program: string; value: unknown; logs: string[] }
  | { ok: false; error: string; program?: string };

interface FabricProgramRunRequestBaseV1 {
  /** JSON, at most 64 KiB; reaches the program as `input`. */
  input?: unknown;
  signal?: AbortSignal;
  /** Called exactly once. */
  reply: (result: FabricProgramRunReplyV1) => void;
}

/** Runs a saved program. Exactly one of `ref` or `code` is allowed. */
export interface FabricProgramRunByRefRequestV1 extends FabricProgramRunRequestBaseV1 {
  /** name, name@<digest prefix >= 12>, or a full digest. */
  ref: string;
  requirePromoted?: boolean;
  code?: never;
}

/**
 * Runs TypeScript program text the caller built, without saving it anywhere.
 * Fabric computes the SHA-256 of the code and records it in the trace.
 */
export interface FabricProgramRunByCodeRequestV1 extends FabricProgramRunRequestBaseV1 {
  /** Non-empty TypeScript, at most 65 536 characters. */
  code: string;
  ref?: never;
  requirePromoted?: never;
}

export type FabricProgramRunRequestV1 = FabricProgramRunByRefRequestV1 | FabricProgramRunByCodeRequestV1;

/** The request fields Fabric reads, once, when a program run event arrives. */
export type FabricProgramRunFieldV1 = "ref" | "code" | "input" | "requirePromoted" | "signal";

/**
 * Everything a program run listener keeps of a request. Read once, at the event
 * boundary and before the listener's first await, so a caller that deletes or
 * replaces a field afterwards cannot change what runs or lose its reply.
 */
export interface FabricProgramRunSnapshotV1 {
  readonly ref: unknown;
  readonly code: unknown;
  /** A JSON copy of the caller's `input`, never the caller's object. */
  readonly input: unknown;
  readonly requirePromoted: unknown;
  readonly signal: unknown;
  /**
   * The first field whose getter threw when read; the handler refuses the
   * request by name instead of letting the throw escape.
   */
  readonly unreadable: FabricProgramRunFieldV1 | undefined;
  /** Calls the caller's `reply` at most once, directly, and never throws. */
  readonly respond: (result: FabricProgramRunReplyV1) => void;
}

// Stands in for input that is not JSON. It is not JSON either, so the run
// refuses it with the error it always gave.
const NOT_JSON_INPUT = Symbol("not JSON");

/**
 * A JSON copy of `input`, so a caller that changes the input's contents after
 * emitting cannot change what runs.
 */
const copyProgramRunInput = (input: unknown): unknown => {
  if (input === undefined) return undefined;
  try {
    const text = JSON.stringify(input);
    if (text !== undefined) return JSON.parse(text) as unknown;
  } catch {
    // Not JSON-compatible.
  }
  return NOT_JSON_INPUT;
};

/**
 * Reads `reply` and each named field once, and never lets a getter's throw out.
 * Returns undefined when `reply` cannot be read, because nobody can be told.
 * Throws when `reply` reads as something other than a function, as the event
 * has always done for a payload without a `reply` function.
 */
export const snapshotFabricProgramRunRequestV1 = (value: unknown): FabricProgramRunSnapshotV1 | undefined => {
  const request = value as Record<string, unknown> | null | undefined;
  let reply: unknown;
  try {
    reply = request?.reply;
  } catch {
    return undefined;
  }
  if (typeof reply !== "function") throw new Error("Invalid Pi Fabric program run request");
  let unreadable: FabricProgramRunFieldV1 | undefined;
  const read = (field: FabricProgramRunFieldV1): unknown => {
    try {
      return request![field];
    } catch {
      unreadable ??= field;
      return undefined;
    }
  };
  let replied = false;
  const respond = (result: FabricProgramRunReplyV1): void => {
    if (replied) return;
    replied = true;
    try {
      reply(result);
    } catch {
      // A throwing listener must not turn into an unhandled rejection.
    }
  };
  // Read the plain fields before `input`: copying `input` runs its `toJSON`
  // and getters, which must not be able to change what else the request says.
  const ref = read("ref");
  // A request with `ref` is a saved-program run, as it was before `code`
  // existed: it never reads `code`, so a getter on it cannot refuse the run.
  const code = ref === undefined && unreadable === undefined ? read("code") : undefined;
  const requirePromoted = read("requirePromoted");
  const signal = read("signal");
  const input = copyProgramRunInput(read("input"));
  return Object.freeze({
    ref,
    code,
    input,
    requirePromoted,
    signal,
    unreadable,
    respond,
  });
};

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

/**
 * Host-local compaction ownership. One extension at a time may claim
 * compaction from Fabric: Fabric's compactor, threshold trigger and threshold
 * deferral stand down, and `compact.*` program calls route to the owner.
 * `/tree` branch summaries stay with Fabric unless the claim sets
 * `branchSummary`. Fabric drops the claim on withdrawal, when `signal`
 * aborts, and at its own `session_shutdown` (reload, session switch, quit).
 * Fabric loads its claim code on the first message, so the reply may come
 * after `emit` returns.
 */
export const FABRIC_COMPACTION_OWNER_EVENT = "pi-fabric:compaction-owner:v1";

export type FabricCompactionOwnerRequestFieldV1 = "reason" | "instructions" | "preserve" | "requestedBy" | "seed";
export type FabricCompactionOwnerCarryFieldV1 = "items" | "add" | "remove" | "clear";
export type FabricCompactionOwnerActionNameV1 = "request" | "status" | "pressure" | "carry" | "cancel";

export interface FabricCompactionOwnerIdentityV1 {
  /** 1-128 characters, no control characters or surrounding whitespace. */
  name: string;
  /** 1-64 characters, same rules. */
  version: string;
}

/** Validated `compact.request` arguments; only declared fields ever appear. */
export interface FabricCompactionOwnerRequestV1 {
  reason?: string;
  instructions?: string;
  preserve?: string[];
  requestedBy?: string;
  /**
   * Text to send after the owner's compaction commits. Send it as Fabric
   * does: a labelled custom message that starts a turn, not a user message.
   */
  seed?: string;
}

/** Validated `compact.carry` arguments; an empty object reads the list. */
export interface FabricCompactionOwnerCarryUpdateV1 {
  items?: string[];
  add?: string[];
  remove?: string[];
  clear?: boolean;
}

export interface FabricCompactionOwnerCarryResultV1 {
  items: string[];
}

/** The owner's own ladder, reported beside Fabric's pressure band. */
export interface FabricCompactionOwnerPressureV1 {
  /** 1-64 characters. */
  stage: string;
  /** At most 16 named finite numbers (names 1-64 characters). */
  thresholds?: Record<string, number>;
}

type FabricCompactionOwnerResult<T> = T | Promise<T>;

/** Passed to every owner handler. */
export interface FabricCompactionOwnerCallV1 {
  /** The invoking session's extension context, when Fabric has one. */
  context: ExtensionContext | undefined;
  /**
   * Aborts when the calling program is cancelled or the handler runs longer
   * than 30 seconds. Fabric has already failed the program call by then,
   * naming the owner and the action; stop the work.
   */
  signal: AbortSignal;
}

/**
 * Supported `compact.*` actions. An absent action, or a request/carry field
 * absent from `fields`, fails the program call with an error naming the owner.
 * Every handler receives `{ context, signal }` (`FabricCompactionOwnerCallV1`).
 */
export interface FabricCompactionOwnerActionsV1 {
  request?: {
    fields: readonly FabricCompactionOwnerRequestFieldV1[];
    handler: (request: FabricCompactionOwnerRequestV1, call: FabricCompactionOwnerCallV1) => unknown;
  };
  /** Result: JSON, at most 16 KiB; reported as `ownerStatus`. */
  status?: { handler: (call: FabricCompactionOwnerCallV1) => unknown };
  pressure?: {
    handler: (call: FabricCompactionOwnerCallV1) => FabricCompactionOwnerResult<FabricCompactionOwnerPressureV1>;
  };
  carry?: {
    fields: readonly FabricCompactionOwnerCarryFieldV1[];
    handler: (
      update: FabricCompactionOwnerCarryUpdateV1,
      call: FabricCompactionOwnerCallV1,
    ) => FabricCompactionOwnerResult<FabricCompactionOwnerCarryResultV1>;
  };
  cancel?: { handler: (call: FabricCompactionOwnerCallV1) => unknown };
}

export type FabricCompactionFallbackResultV1 =
  | { ok: true; compaction: CompactionResult }
  | { ok: false; reason: string };

export interface FabricCompactionFallbackOptionsV1 {
  /** Carry-forward items to render; omitted renders Fabric's stored list. */
  carry?: readonly string[];
}

/** Returned to the claimant only; the token is the withdrawal credential. */
export interface FabricCompactionOwnerHandleV1 {
  readonly token: string;
  /** False once the claim is withdrawn or cleared. */
  readonly active: boolean;
  /** Releases the claim and restores Fabric's engine; false when no longer held. */
  withdraw(): boolean;
  /**
   * Fabric's deterministic summary (summary compiler plus its enrichers) for
   * the given `session_before_compact` event. Return `{ compaction }` from
   * the owner's own handler when its model summary fails.
   */
  fallback(
    event: SessionBeforeCompactEvent,
    context?: ExtensionContext,
    options?: FabricCompactionFallbackOptionsV1,
  ): FabricCompactionFallbackResultV1;
}

export type FabricCompactionOwnerClaimResultV1 =
  | {
    ok: true;
    handle: FabricCompactionOwnerHandleV1;
    /**
     * Fabric's carry-forward items when the claim was made, as a frozen copy.
     * Under the claim `compact.carry` goes to the owner, so this is the list
     * the owner takes over. Absent when Fabric has not started the session
     * yet (the owner's `session_start` ran before Fabric's).
     */
    carry?: readonly string[];
  }
  | { ok: false; error: string; holder?: FabricCompactionOwnerIdentityV1 };

export interface FabricCompactionOwnerClaimV1 {
  version: 1;
  type: "claim";
  owner: FabricCompactionOwnerIdentityV1;
  actions: FabricCompactionOwnerActionsV1;
  /** Also take `/tree` branch summaries. Omitted or false: Fabric keeps them. */
  branchSummary?: boolean;
  /** Aborting releases the claim; bind it to the owner's own lifetime. */
  signal?: AbortSignal;
  /**
   * Called once, possibly after `emit` returns. Wait with a timeout, abort
   * `signal` when giving up, and withdraw a grant that arrives late.
   */
  reply: (result: FabricCompactionOwnerClaimResultV1) => void;
}

export type FabricCompactionOwnerWithdrawResultV1 =
  | { ok: true }
  | { ok: false; error: string };

export interface FabricCompactionOwnerWithdrawV1 {
  version: 1;
  type: "withdraw";
  /** The token from the claim handle; any other token is refused. */
  token: string;
  reply?: (result: FabricCompactionOwnerWithdrawResultV1) => void;
}

export type FabricCompactionOwnerMessageV1 =
  | FabricCompactionOwnerClaimV1
  | FabricCompactionOwnerWithdrawV1;
export const FABRIC_HOST_POLICY_EVENT = "pi-fabric:host-policy:v1";
export const MAX_FABRIC_HOST_POLICY_NAMES = 256;

/** Every policy field this build enforces. A request naming any other field is refused. */
export const FABRIC_HOST_POLICY_FIELDS = ["owner", "reason", "deniedTools", "deniedProviders", "allowedRefs"] as const;
export type FabricHostPolicyField = (typeof FABRIC_HOST_POLICY_FIELDS)[number];

/**
 * The one restriction an embedding host (for example a delegate worker runner)
 * places on this Fabric instance. The host sends it before the instance runs
 * anything; Fabric seals it on the first program or provider call, so it
 * cannot be replaced, widened or added to afterwards.
 *
 * - `deniedTools`: Pi core and captured extension tool names refused through
 *   `pi.*` and `extensions.*`.
 * - `deniedProviders`: Fabric providers refused entirely.
 * - `allowedRefs`: exact `provider.action` refs, or `provider.*`, that the
 *   host allows outside `pi.*` and `extensions.*`. Those providers do not
 *   replay Pi `tool_call` hooks. Without an entry, only Fabric's fixed set of
 *   built-in read-only actions is allowed; a provider's own `risk` label never
 *   grants anything.
 *
 * Any policy also refuses native executors, which bypass tool hooks.
 */
export interface FabricHostPolicyV1 {
  owner: string;
  reason: string;
  deniedTools?: string[];
  deniedProviders?: string[];
  allowedRefs?: string[];
}

/** `accepted: true` means the policy is in force and will be sealed unchanged. */
export type FabricHostPolicyReplyV1 =
  | { version: 1; accepted: true; digest: string; enforced: FabricHostPolicyField[] }
  | { version: 1; accepted: false; reason: string };

/** Host-local synchronous request; Fabric replies before `emit` returns. */
export interface FabricHostPolicyRequestV1 {
  policy: FabricHostPolicyV1;
  reply: (reply: FabricHostPolicyReplyV1) => void;
}

const HOST_POLICY_FIELD_SET: ReadonlySet<string> = new Set(FABRIC_HOST_POLICY_FIELDS);
const HOST_POLICY_REF = /^[a-z][a-z0-9_-]*\.(?:\*|[^\s*]+(?:\.\*)?)$/;
// Same rule as the registry's provider names, so an entry that can never name
// a provider ("MCP", "mcp ") is refused instead of acknowledged and ignored.
const HOST_POLICY_PROVIDER = /^[a-z][a-z0-9_-]*$/;
// Tool names as model APIs accept them: letters, digits, `_` and `-`.
const HOST_POLICY_TOOL = /^[A-Za-z0-9_-]+$/;

const boundedNames = (value: unknown, pattern?: RegExp): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_FABRIC_HOST_POLICY_NAMES &&
  value.every((name) => typeof name === "string" && name.length > 0 && name.length <= 256 && (!pattern || pattern.test(name)));

const boundedLabel = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1_024;

/**
 * Copies named fields only. A request without a reply function is ignored.
 * A malformed policy, or one with a field this build does not enforce, is
 * refused whole with a reason and never partially applied.
 */
export const readFabricHostPolicyRequestV1 = (
  value: unknown,
):
  | { ok: true; request: FabricHostPolicyRequestV1 }
  | { ok: false; reason: string; reply: FabricHostPolicyRequestV1["reply"] }
  | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.reply !== "function") return undefined;
  const reply = record.reply as FabricHostPolicyRequestV1["reply"];
  const refuse = (reason: string) => ({ ok: false as const, reason, reply });
  const raw = record.policy;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return refuse("policy must be an object");
  const policy = raw as Record<string, unknown>;
  const unknown = Object.keys(policy).filter((key) => !HOST_POLICY_FIELD_SET.has(key));
  if (unknown.length > 0) return refuse(`unsupported policy fields: ${unknown.slice(0, 8).join(", ")}`);
  if (!boundedLabel(policy.owner) || !boundedLabel(policy.reason)) return refuse("owner and reason must be non-empty strings of at most 1024 characters");
  if (policy.deniedTools !== undefined && !boundedNames(policy.deniedTools, HOST_POLICY_TOOL)) return refuse("deniedTools must be a list of tool names (letters, digits, _ and -)");
  if (policy.deniedProviders !== undefined && !boundedNames(policy.deniedProviders, HOST_POLICY_PROVIDER)) return refuse("deniedProviders must be a list of provider names (lowercase letters, digits, _ and -, starting with a letter)");
  if (policy.allowedRefs !== undefined && !boundedNames(policy.allowedRefs, HOST_POLICY_REF)) return refuse("allowedRefs must be a list of provider.action or provider.* refs");
  return {
    ok: true,
    request: {
      policy: {
        owner: policy.owner,
        reason: policy.reason,
        ...(policy.deniedTools ? { deniedTools: [...policy.deniedTools] } : {}),
        ...(policy.deniedProviders ? { deniedProviders: [...policy.deniedProviders] } : {}),
        ...(policy.allowedRefs ? { allowedRefs: [...policy.allowedRefs] } : {}),
      },
      reply,
    },
  };
};

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

/**
 * Custom session entry a root Fabric session appends once the project mesh
 * mints its peer label, and again only if the label changes. Headless hosts
 * read it with Pi's RPC `get_entries`: unlike the `fabric-label` footer status,
 * it is structured, outlives the event stream, and does not depend on
 * `ui.sessionLabel.footer`.
 */
export const FABRIC_PEER_ENTRY_TYPE = "pi-fabric-peer";

/**
 * Generation of the project-wide label counter. Raising it restarts numbering
 * at 1 and retires every label an older generation recorded. Generation 3 is
 * the first that takes a number only at a session's first Fabric use.
 */
export const FABRIC_PEER_LABEL_SEQUENCE = 3;

export interface FabricPeerEntryV1 {
  version: 1;
  /** Counter generation that minted the label; a resumed session reuses only the current one. */
  sequence: number;
  /** Participant id other sessions and the mesh use for this session. */
  participantId: string;
  /** Linear-style project label (e.g. "PQS-2"). */
  label: string;
}

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

/**
 * Host-local registration of an extension action policy hook (issue #312).
 * Fabric consults registered hooks at the fabric_exec approve stage only when
 * `approvals.policyHooks` is true. Registering under an existing `name`
 * replaces that hook. `respond`, when given, receives an `unregister`
 * function that removes only this registration.
 */
export const FABRIC_ACTION_POLICY_REGISTER_EVENT = "pi-fabric:action-policy:register:v1";

export interface FabricActionPolicyRegistrationV1 {
  version: 1;
  /** Must match `[A-Za-z0-9@][A-Za-z0-9@._/-]{0,63}`; shown in denial messages. */
  name: string;
  hook: FabricActionPolicyHookV1;
  respond?: (result: { ok: true; unregister: () => void } | { ok: false; error: string }) => void;
}

export const readFabricActionPolicyRegistrationV1 = (
  value: unknown,
): FabricActionPolicyRegistrationV1 | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.name !== "string" ||
    typeof record.hook !== "function" ||
    (record.respond !== undefined && typeof record.respond !== "function")
  ) {
    return undefined;
  }
  // Copy named fields: a later change to the caller's object changes nothing here.
  return {
    version: 1,
    name: record.name,
    hook: record.hook as FabricActionPolicyRegistrationV1["hook"],
    ...(record.respond ? { respond: record.respond as NonNullable<FabricActionPolicyRegistrationV1["respond"]> } : {}),
  };
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

/**
 * Host-local registration of a question renderer: an extension that shows
 * Fabric's decisions to the person at this terminal in its own interface.
 * Fabric offers a routed child question, and the decision picked in
 * `/fabric decisions`, to registered renderers only when
 * `ui.questionRenderers` is true. Registering under an existing `name`
 * replaces that renderer in its original position. `respond`, when given,
 * receives an `unregister` function that removes only this registration.
 */
export const FABRIC_QUESTION_RENDERER_REGISTER_EVENT = "pi-fabric:question-renderer:register:v1";

/** Where Fabric is about to show a decision to the person at this terminal. */
export type FabricQuestionRenderSurfaceV1 = "child-question" | "decisions-command";

/** A copy of the stored decision. Changing it changes nothing in the store. */
export interface FabricQuestionDecisionV1 {
  id: string;
  kind: "approval" | "question" | "escalation";
  title: string;
  body?: string;
  input: FabricDecisionInputV1;
  /** Present for `select` and `confirm`; an answer must use one of these ids. */
  options?: Array<{ id: string; label: string }>;
  holder: string;
  raisedBy: { participantId: string; runId?: string; sessionId?: string };
  createdAt: number;
  /** Epoch ms after which the decision expires and `signal` aborts. */
  deadline?: number;
}

export interface FabricQuestionRenderInputV1 {
  version: 1;
  surface: FabricQuestionRenderSurfaceV1;
  ui: ExtensionContext["ui"];
  decision: FabricQuestionDecisionV1;
  /**
   * Aborts when the decision is answered, cancelled, or expires elsewhere, or
   * when the asking child run settles. Fabric then uses the stored record.
   */
  signal: AbortSignal;
}

/**
 * What a renderer reports. `decisionId` must name the decision it was handed.
 * `dismissed` means the person closed the renderer without deciding.
 */
export type FabricQuestionRenderResultV1 =
  | { status: "answered"; decisionId: string; answer: { optionId?: string; text?: string } }
  | { status: "cancelled"; decisionId: string }
  | { status: "dismissed"; decisionId: string };

/**
 * Returns `undefined` to decline, so the next renderer or Fabric's own dialog
 * shows the decision. A throw, a rejection, a malformed result, a result for
 * another decision, or an answer the store refuses falls back to Fabric's own
 * dialog. Fabric writes an accepted result to the store itself.
 */
export type FabricQuestionRendererV1 = (
  input: FabricQuestionRenderInputV1,
) => FabricQuestionRenderResultV1 | undefined | Promise<FabricQuestionRenderResultV1 | undefined>;

export interface FabricQuestionRendererRegistrationV1 {
  version: 1;
  /** Must match `[A-Za-z0-9@][A-Za-z0-9@._/-]{0,63}`. */
  name: string;
  render: FabricQuestionRendererV1;
  respond?: (result: { ok: true; unregister: () => void } | { ok: false; error: string }) => void;
}

export const readFabricQuestionRendererRegistrationV1 = (
  value: unknown,
): FabricQuestionRendererRegistrationV1 | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.name !== "string" ||
    typeof record.render !== "function" ||
    (record.respond !== undefined && typeof record.respond !== "function")
  ) {
    return undefined;
  }
  // Copy named fields: a later change to the caller's object changes nothing here.
  return {
    version: 1,
    name: record.name,
    render: record.render as FabricQuestionRendererV1,
    ...(record.respond ? { respond: record.respond as NonNullable<FabricQuestionRendererRegistrationV1["respond"]> } : {}),
  };
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
  /** Optional presentation cap. Omitted means enumerate all matching descriptors. */
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

/**
 * One registered provider that gets a program global named after it. Its
 * actions' input schemas are its TypeScript declarations; an empty list
 * declares the global loosely (any action, one argument object).
 */
export interface FabricProviderTypeSource {
  provider: string;
  actions: FabricNamedActionTypeSource[];
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
 * builder so dynamic surfaces (mcp, extensions, provider globals) get argument
 * checking before the sandbox runs. Empty/absent sections keep the loose
 * static declarations.
 */
export interface FabricGuestTypeSources {
  mcpServers?: FabricMcpServerTypeSource[];
  extensionTools?: FabricNamedActionTypeSource[];
  /**
   * Providers registered outside Fabric whose names can be program globals
   * (see `src/provider-globals.ts`). Each entry is exactly one global the
   * program gets, typed or loose.
   */
  providers?: FabricProviderTypeSource[];
}

/**
 * Pre-rendered `declare const` blocks replacing the loose mcp/extensions
 * declaration lines. Values are full replacement text (helpers + declare).
 * `providers` replaces nothing: it declares one new global per provider.
 */
export interface FabricDynamicGuestDeclarations {
  mcp?: string;
  extensions?: string;
  providers?: string;
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
  /** Host-only native deadline pause. Wrap only an authenticated human decision,
   * never tool dispatch or guest work. During fabric_exec the property is present,
   * with undefined under a hard deadline or without native pause support.
   * The provider must honor signal; this callback does not grant authorization. */
  humanWait?: (<T>(wait: () => Promise<T>) => Promise<T>) | undefined;
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
  // Host-supplied inside fabric_exec. A provider calls this when a successful
  // nested tool result sets Pi's `terminate: true`; the outer fabric_exec
  // result then carries `terminate: true` once the program succeeds.
  requestTerminate?(): void;
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
