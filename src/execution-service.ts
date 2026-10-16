import { NativeCodemodeProvider } from "./native-codemode.js";
import { nativeMcpIdentity } from "./core/native-mcp-identity.js";
import { nativeToolRef, nativeToolIdentifier } from "./core/native-tool-names.js";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  FabricExecutionTraceRecorder,
  FabricTraceSafeError,
  executionOutcomeFromError,
  type FabricExecutionFailureStageV1,
  type FabricExecutionTraceOperationHandle,
  type FabricExecutionTraceV1,
} from "./audit/trace.js";
import { FabricActivityStore } from "./activity/store.js";
import {
  FabricWorkflowItemTransitions,
  validateWorkflowItemInput,
} from "./activity/workflow-items.js";
import {
  FabricAssessmentRecorder,
  readFabricAssessmentUsage,
  type FabricAssessmentTraceV1,
} from "./audit/assessment.js";
import type { CapturedToolCatalog } from "./capture/catalog.js";
import { isPiShellRef, PI_CORE_TOOL_NAME_SET } from "./core/pi-tools.js";
import { piBashExitMetadata } from "./core/pi-bash-error.js";
import { normalizePiArguments } from "./core/pi-arguments.js";
import { pythonErrorRecoveryHint } from "./runtime/python-error-guidance.js";
import type {
  FabricActivityEventInput,
  FabricActivityItemInput,
  FabricPhaseInput,
  FabricRunDisplay,
} from "./activity/types.js";
import {
  MAX_AGENT_TIMEOUT_MS,
  MIN_AGENT_TIMEOUT_MS,
  type FabricConfig,
} from "./config.js";
import {
  type ActionRegistry,
  fabricActionListLimit,
  type FabricCallAudit,
  type FabricRegistryActivityEvent,
  type ResolvedFabricAction,
} from "./core/action-registry.js";
import { semanticSearchActions } from "./core/semantic-search.js";
import { resolveJevModelRoute } from "./jev/routes.js";
import {
  ApprovalController,
  FabricSessionApprovals,
  type FabricAutoApprovalAudit,
} from "./core/approval-controller.js";
import { FabricAutoApprovalClassifier } from "./core/auto-approval-classifier.js";
import {
  codeUsesOrchestration,
  isBlockingOrchestrationRef,
} from "./runtime/orchestration.js";
import type { FabricCommittedCapabilityView, FabricGuestTypeSources, FabricMediaBlock } from "./protocol.js";
import {
  sanitizeFabricMediaText,
  sanitizeFabricMediaValue,
} from "./core/media-sanitize.js";
import { fabricExecTitleHintCached } from "./ui/fabric-title-hint.js";
import type {
  FabricHostCall,
  FabricHumanWait,
  FabricKernel,
  FabricKernelRuntime,
  FabricSandboxResult,
  FabricSandboxTerminationReason,
} from "./runtime/kernel.js";
import type { TypeScriptKernelRuntime } from "./runtime/typescript-kernel.js";
import {
  PROGRAM_CANCELLED_REASON,
  type ProviderParticipantRegistry,
  type ProviderParticipantStopOutcome,
} from "./topology/provider-participants.js";
import type { FabricTypeError, FabricTypeCheckResult } from "./runtime/type-checker.js";

const executionOutcomeFromTermination = (
  reason: FabricSandboxTerminationReason,
): "succeeded" | "failed" | "aborted" | "timed_out" => {
  switch (reason) {
    case "completed":
      return "succeeded";
    case "aborted":
      return "aborted";
    case "timed_out":
      return "timed_out";
    case "runtime_error":
      return "failed";
  }
};

const aggregateUsage = (usages: Usage[]): Usage => ({
  input: usages.reduce((total, usage) => total + usage.input, 0),
  output: usages.reduce((total, usage) => total + usage.output, 0),
  cacheRead: usages.reduce((total, usage) => total + usage.cacheRead, 0),
  cacheWrite: usages.reduce((total, usage) => total + usage.cacheWrite, 0),
  ...(usages.some((usage) => usage.cacheWrite1h !== undefined)
    ? { cacheWrite1h: usages.reduce((total, usage) => total + (usage.cacheWrite1h ?? 0), 0) }
    : {}),
  ...(usages.some((usage) => usage.reasoning !== undefined)
    ? { reasoning: usages.reduce((total, usage) => total + (usage.reasoning ?? 0), 0) }
    : {}),
  totalTokens: usages.reduce((total, usage) => total + usage.totalTokens, 0),
  cost: {
    input: usages.reduce((total, usage) => total + usage.cost.input, 0),
    output: usages.reduce((total, usage) => total + usage.cost.output, 0),
    cacheRead: usages.reduce((total, usage) => total + usage.cost.cacheRead, 0),
    cacheWrite: usages.reduce((total, usage) => total + usage.cost.cacheWrite, 0),
    total: usages.reduce((total, usage) => total + usage.cost.total, 0),
  },
});

// Each stop becomes a synthetic trace call whose projection keeps only the ref,
// reason, and outcome; a confirmed stop succeeds, an unconfirmed one fails.
const stopOwnedWork = async (
  participants: ProviderParticipantRegistry,
  invocationId: string,
  trace: FabricExecutionTraceRecorder,
): Promise<ProviderParticipantStopOutcome[]> => {
  const outcomes = await participants.cancelInvocation(invocationId, PROGRAM_CANCELLED_REASON);
  for (const stop of outcomes) {
    const operation = trace.issueCall("fabric.participant.stop", { ref: stop.ref, reason: PROGRAM_CANCELLED_REASON });
    if (stop.outcome === "confirmed") operation.succeed(stop);
    else operation.fail("invoke", undefined, "failed", stop);
  }
  return outcomes;
};

export interface FabricExecutionResult {
  success: boolean;
  kernel?: FabricKernel;
  value: unknown;
  logs: string[];
  /** Images hoisted out of `value` by the media sanitizer, indexed by descriptor. */
  media?: FabricMediaBlock[];
  audits: FabricCallAudit[];
  phases: string[];
  trace: FabricExecutionTraceV1;
  /** Opt-in (`trace.assessment`) timings and usage; never part of `trace`. */
  assessment?: FabricAssessmentTraceV1;
  elapsedMs: number;
  typeErrors?: FabricTypeError[];
  error?: string;
  handoffRequest?: Record<string, unknown>;
  usage?: Usage;
  /** Stop outcomes for owned provider participants after cancellation or timeout. */
  ownedWork?: ProviderParticipantStopOutcome[];
}

interface FabricExecutionPartial {
  audits: FabricCallAudit[];
  phases: string[];
  progress?: string | undefined;
}

export type FabricHeadlessApproval = (
  action: ResolvedFabricAction,
  reason: string | undefined,
  signal: AbortSignal | undefined,
) => Promise<boolean>;

/** One saved program run nested inside an active execution (`programs.run`). */
export interface FabricNestedProgramRun {
  /** `name@digest`, recorded on the `fabric.program.run` trace operation. */
  program: string;
  /** Guest source in the execution's kernel language. */
  code?: string;
  /** A single host action, used for Jev programs (`jev.run`). */
  call?: { ref: string; args: Record<string, unknown> };
}

/**
 * Runs a program through the enclosing execution's own host bridge: the same
 * capability view, approval controller, agent budget, signal and trace. It
 * can never widen what the calling program may do.
 */
export interface FabricNestedProgramRunner {
  kernel: FabricKernel;
  run(request: FabricNestedProgramRun, signal: AbortSignal | undefined): Promise<unknown>;
}

/** Bounds recursive `programs.run` chains within one outer execution. */
export const MAX_NESTED_PROGRAM_RUNS = 16;

export interface FabricExecutionAuthorizer {
  authorize(ref: string, parentToolCallId: string): Promise<void>;
}

export interface FabricExecutionOptions {
  code: string;
  strings?: Record<string, string>;
  /** Per-invocation whole-program deadline request from fabric_exec.timeoutMs.
   * Raises (never lowers) the configured executor.timeoutMs, subject to
   * executor.maxTimeoutMs. */
  requestedTimeoutMs?: number;
  /** Hard whole-script deadline; unlike timeoutMs this cannot be raised or paused. */
  hardTimeoutMs?: number;
  signal: AbortSignal | undefined;
  parentToolCallId: string;
  context: ExtensionContext;
  tokenBudget?: number;
  maxAgentCalls?: number;
  display?: FabricRunDisplay;
  /** Host-invoked program runs (`/fabric run`, the program run event). */
  invokedBy?: "host";
  onPartial(snapshot: FabricExecutionPartial): void;
}

const nativeProviders = new WeakMap<ActionRegistry, NativeCodemodeProvider>();

export class FabricExecutionService {
  #runtime: FabricKernelRuntime | undefined;
  #runtimeKind: string | undefined;
  #capabilityView: FabricCommittedCapabilityView | undefined;
  #emitEvent: ((channel: string, data: unknown) => void) | undefined;
  #headlessApproval: FabricHeadlessApproval | undefined;
  #participants: ProviderParticipantRegistry | undefined;
  readonly nativeCodemode: NativeCodemodeProvider;
  readonly #nestedRunners = new Map<string, FabricNestedProgramRunner>();
  constructor(
    readonly registry: ActionRegistry,
    readonly config: FabricConfig,
    readonly activity?: FabricActivityStore,
    readonly authorizer?: FabricExecutionAuthorizer,
    readonly autoApprovalClassifier = new FabricAutoApprovalClassifier(() => config.jev),
    readonly sessionApprovals = new FabricSessionApprovals(),
    readonly capturedTools?: CapturedToolCatalog,
    readonly brokeredNetwork?: (provider: string) => boolean,
  ) {
    const mounted = nativeProviders.get(registry);
    if (mounted) this.nativeCodemode = mounted;
    else {
      if (this.registry.has("native")) throw new Error("Fabric provider name native is reserved for Pi codemode compatibility");
      this.nativeCodemode = new NativeCodemodeProvider();
      this.registry.register(this.nativeCodemode);
      nativeProviders.set(registry, this.nativeCodemode);
    }
  }

  setCapabilityView(view: FabricCommittedCapabilityView | undefined): void {
    this.#capabilityView = view;
  }

  /** Host event bus for observation-only events such as workflow item transitions. */
  setEventEmitter(emit: ((channel: string, data: unknown) => void) | undefined): void {
    this.#emitEvent = emit;
  }

  /** Session registry behind `context.participants` and owned-work cancellation. */
  setParticipantRegistry(registry: ProviderParticipantRegistry | undefined): void {
    this.#participants = registry;
  }

  /** The nested program runner of the active execution with this outer call id. */
  nestedProgramRunner(parentToolCallId: string): FabricNestedProgramRunner | undefined {
    return this.#nestedRunners.get(parentToolCallId);
  }

  /** No-UI approval fallback used when approvals.headless is "decision". */
  setHeadlessApproval(handler: FabricHeadlessApproval | undefined): void {
    this.#headlessApproval = handler;
  }

  async execute(options: FabricExecutionOptions): Promise<FabricExecutionResult> {
    const executor = this.config.executor;
    const codemodeProfile = executor.codemodeProfile;
    if (
      process.env.PI_FABRIC_WRITE_POLICY &&
      (executor.kernel === "python"
        ? executor.pythonRuntime !== "monty"
        : this.config.schema.mode !== "enforce" && executor.runtime !== "quickjs")
    ) {
      // Native executors bypass a confined child's tool_call write guard.
      const { readWritePolicy } = await import("./agents/write-guard.js");
      if (readWritePolicy()?.shell !== "unconfined") {
        throw new Error('Fabric write policy refuses native executors (CPython, node-process, bun-process); the parent must request shell: "unconfined"');
      }
    }
    const startedAt = performance.now();
    const assessment = this.config.trace.assessment ? new FabricAssessmentRecorder() : undefined;
    const traceRecorder = new FabricExecutionTraceRecorder(assessment);
    let sessionId: string | undefined;
    try {
      sessionId = options.context.sessionManager?.getSessionId?.() || undefined;
    } catch {
      sessionId = undefined;
    }
    const itemTransitions = new FabricWorkflowItemTransitions(
      options.parentToolCallId,
      this.#emitEvent,
      sessionId,
    );
    this.activity?.start(
      options.parentToolCallId,
      options.display,
      options.display?.name?.trim() ? undefined
        : fabricExecTitleHintCached(options.code, this.config.executor.kernel)
          ?? (this.config.executor.kernel === "python" ? "Python program" : undefined),
    );
    const effectiveFullCodeMode =
      this.config.fullCodeMode || this.config.schema.mode === "enforce";
    const python = this.config.executor.kernel === "python";
    const enforce = this.config.schema.mode === "enforce";
    const monty = python && this.config.executor.pythonRuntime === "monty";
    // Snapshot kernel identity before awaits. Schema enforce isolates the selected
    // language rather than silently changing Python programs into TypeScript.
    const runtimeKind = python
      ? monty ? "python:monty" : `python:${this.config.executor.cpython.binary}:${enforce}`
      : `typescript:${enforce ? "quickjs" : this.config.executor.runtime}`;
    let runtime = this.#runtimeKind === runtimeKind ? this.#runtime : undefined;
    if (!runtime) {
      if (monty) {
        const { MontyRuntime } = await import("./runtime/monty-runtime.js");
        runtime = new MontyRuntime();
      } else if (python) {
        const { CPythonRuntime } = await import("./runtime/cpython-runtime.js");
        runtime = new CPythonRuntime(this.config.executor.cpython.binary, enforce);
      } else {
        const { TypeScriptKernelRuntime } = await import("./runtime/typescript-kernel.js");
        runtime = new TypeScriptKernelRuntime(enforce ? "quickjs" : this.config.executor.runtime);
      }
      this.#runtime = runtime;
      this.#runtimeKind = runtimeKind;
    }
    let code = options.code;
    let checked: FabricTypeCheckResult = { errors: [] };
    let guestTypeSources: FabricGuestTypeSources = {};
    const unavailable = new Map(
      this.registry.unavailableProviders().map((entry) => [entry.name, entry.reason]),
    );
    const coreOverrides = this.capturedTools?.list().map((entry) => ({
      name: entry.name, inputSchema: entry.definition.parameters,
    })) ?? [];
    const piToolCanonicalFields = Object.fromEntries(coreOverrides
      .filter((entry) => PI_CORE_TOOL_NAME_SET.has(entry.name))
      .map((entry) => [entry.name, Object.keys((entry.inputSchema as { properties?: object }).properties ?? {})]));
    if (!python) {
      // TypeScript alone consumes live schemas as compiler declarations. Python
      // compiles in CPython; both kernels share authoritative registry validation.
      guestTypeSources = await this.registry.guestTypeSources({
        cwd: options.context.cwd,
        signal: options.signal,
        parentToolCallId: options.parentToolCallId,
        nestedToolCallId: `${options.parentToolCallId}_typedecls`,
        extensionContext: options.context,
        update() {},
        ...(this.#capabilityView ? { capabilityView: this.#capabilityView } : {}),
      });
      ({ code, checked } = (runtime as TypeScriptKernelRuntime).prepare(
        options.code,
        effectiveFullCodeMode,
        [...unavailable.keys()],
        guestTypeSources,
        coreOverrides,
        false,
        codemodeProfile,
      ));
    }
    if (checked.errors.length > 0) {
      for (const error of checked.errors) {
        const missing = /^Cannot find name '([^']+)'/.exec(error.message);
        const reason = missing?.[1] ? unavailable.get(missing[1]) : undefined;
        if (missing && reason) {
          error.message = `${error.message} Fabric provider "${missing[1]}" is unavailable: ${reason}`;
        }
      }
      this.activity?.finish(options.parentToolCallId, false, "Type checking failed");
      const failedTrace = traceRecorder.seal(
        "failed",
        [],
        `Type checking failed (${checked.errors.length} ${checked.errors.length === 1 ? "error" : "errors"})`,
      );
      return {
        success: false,
        kernel: "typescript",
        value: undefined,
        logs: [],
        audits: [],
        phases: [],
        trace: failedTrace,
        ...(assessment ? { assessment: assessment.seal("failed") } : {}),
        elapsedMs: performance.now() - startedAt,
        typeErrors: checked.errors,
      };
    }

    const classifierUsages: Usage[] = [];
    const recordAutoDecision = (
      audit: FabricAutoApprovalAudit,
      decision?: { usage: Usage },
    ): void => {
      const operation = traceRecorder.issueCall("fabric.approval.auto", {
        action: audit.action,
        risk: audit.risk,
      });
      operation.succeed(audit);
      if (decision) {
        classifierUsages.push(decision.usage);
        const usage = readFabricAssessmentUsage(decision.usage);
        assessment?.attribute(operation.sequence, {
          source: "classifier",
          ...(audit.model ? { model: audit.model } : {}),
          ...(usage ? { usage } : {}),
        });
      }
    };
    const approval = new ApprovalController(
      this.config.approvals,
      options.context,
      this.sessionApprovals,
      this.autoApprovalClassifier,
      recordAutoDecision,
      this.brokeredNetwork,
      this.#headlessApproval
        ? (action, reason) => this.#headlessApproval!(action, reason, options.signal)
        : undefined,
    );
    const audits: FabricCallAudit[] = [];
    const phases: string[] = [];
    const workflowSpans = new Map<
      string,
      { kind: "parallel" | "pipeline"; operation: FabricExecutionTraceOperationHandle }
    >();
    let agentCalls = 0;
    let handoffRequest: Record<string, unknown> | undefined;
    const maxAgentCalls = Math.max(
      1,
      Math.min(
        options.maxAgentCalls ?? this.config.agents.maxPerExecution,
        this.config.agents.maxPerExecution,
      ),
    );
    const guardAgentCall = (ref: string): void => {
      if (
        ref !== "agents.run" &&
        ref !== "agents.handoff" &&
        ref !== "agents.spawn" &&
        ref !== "agents.create"
      ) return;
      agentCalls++;
      if (agentCalls > maxAgentCalls) {
        throw new FabricTraceSafeError(`Fabric agent budget exhausted (${maxAgentCalls} per execution)`);
      }
    };
    const fullCodeProvider = (value: string): "pi" | "extensions" | undefined => {
      const separator = value.indexOf(".");
      const provider = separator > 0 ? value.slice(0, separator) : value;
      return provider === "pi" || provider === "extensions" ? provider : undefined;
    };
    const guardFullCodeRef = (ref: string): void => {
      if (effectiveFullCodeMode) return;
      const provider = fullCodeProvider(ref);
      if (!provider) return;
      throw new FabricTraceSafeError(
        `Fabric full code mode is disabled; call ${provider === "pi" ? "Pi core" : "registered extension"} tools directly outside fabric_exec`,
      );
    };
    let currentProgress: string | undefined;
    let emitPending = false;
    let emitTimer: NodeJS.Timeout | undefined;
    const emitNow = (): void => {
      emitPending = false;
      options.onPartial({
        audits: audits.slice(),
        phases: phases.slice(),
        progress: currentProgress,
      });
    };
    const flushEmit = (): void => {
      if (emitTimer) clearTimeout(emitTimer);
      emitTimer = undefined;
      if (emitPending) emitNow();
    };
    // One execution-wide timer coalesces updates from every parallel nested
    // call. Keeping this global to the Fabric program prevents each call from
    // independently churning rows while preserving a trailing final snapshot.
    const emit = (): void => {
      emitPending = true;
      const debounceMs = this.config.ui.updateDebounceMs;
      if (debounceMs <= 0) {
        flushEmit();
        return;
      }
      // Throttle to one render per window without resetting the timer. A
      // trailing debounce starves continuously streaming tools because every
      // delta postpones the render until the tool finishes.
      if (emitTimer) return;
      emitTimer = setTimeout(() => {
        emitTimer = undefined;
        if (emitPending) emitNow();
      }, debounceMs);
      emitTimer.unref?.();
    };
    const update = (message: string): void => {
      currentProgress = message;
      emit();
    };
    const observeInvocation = (event: FabricRegistryActivityEvent): void => {
      if (this.activity) {
        if (event.type === "call_start") {
          this.activity.beginCall(options.parentToolCallId, event);
        } else if (event.type === "call_update") {
          this.activity.updateCall(options.parentToolCallId, event.callId, event.update);
        } else if (event.type === "call_args") {
          this.activity.updateCallArgs(options.parentToolCallId, event.callId, event.args);
        } else {
          this.activity.finishCall(options.parentToolCallId, event.callId, event);
        }
      }
      if (event.type === "call_end") emit();
    };
    const baseContext = {
      cwd: options.context.cwd,
      signal: options.signal,
      parentToolCallId: options.parentToolCallId,
      nestedToolCallId: `${options.parentToolCallId}_metadata`,
      extensionContext: options.context,
      update,
      ...(this.#capabilityView ? { capabilityView: this.#capabilityView } : {}),
    };
    // Start known orchestration programs with the longer deadline. Calls
    // reached through generic or computed refs are classified again at the
    // host bridge and can extend the active sandbox deadline before they run.
    // An explicit per-invocation request raises (never lowers) the starting
    // deadline, capped by the configured policy maximum.
    const orchestrationTimeoutMs = Math.max(
      this.config.executor.timeoutMs,
      this.config.agents.timeoutMs,
    );
    const requestedTimeoutMs =
      typeof options.requestedTimeoutMs === "number" &&
      Number.isFinite(options.requestedTimeoutMs)
        ? Math.max(1, Math.floor(options.requestedTimeoutMs))
        : 0;
    const effectiveTimeoutMs = Math.max(
      codeUsesOrchestration(code)
        ? orchestrationTimeoutMs
        : this.config.executor.timeoutMs,
      Math.min(requestedTimeoutMs, this.config.executor.maxTimeoutMs),
    );
    const nativeCallRefs = new Map<string, string | undefined>();
    const hostCallRef = (ref: string, args: Record<string, unknown>): string =>
      ref === "fabric.$call" && typeof args.ref === "string" ? args.ref
        : ref === "fabric.$nativeTool" && typeof args.name === "string" ? nativeCallRefs.get(args.name) ?? ref : ref;
    const minimumTimeoutMsForHostCall = (
      ref: string,
      args: Record<string, unknown>,
    ): number | undefined => {
      const targetRef = hostCallRef(ref, args);
      const targetArgs =
        (ref === "fabric.$call" || ref === "fabric.$nativeTool") &&
        typeof args.args === "object" &&
        args.args !== null &&
        !Array.isArray(args.args)
          ? (args.args as Record<string, unknown>)
          : args;
      if (isPiShellRef(targetRef)) {
        const repaired = normalizePiArguments(targetRef.slice(3), targetArgs, piToolCanonicalFields[targetRef.slice(3)]) as Record<string, unknown>;
        const seconds = repaired.timeout;
        const milliseconds = repaired.timeoutMs;
        const requested =
          typeof seconds === "number" && Number.isFinite(seconds)
            ? seconds * 1_000
            : typeof milliseconds === "number" && Number.isFinite(milliseconds)
              ? milliseconds
              : 0;
        if (requested > 0) {
          return Math.max(
            this.config.executor.timeoutMs,
            Math.min(Math.floor(requested) + 5_000, MAX_AGENT_TIMEOUT_MS),
          );
        }
      }
      // Exact-ref configured floors raise the enclosing deadline for known
      // long-running host calls without any tool-side timeout argument.
      const refFloor = this.config.executor.hostCallTimeouts[targetRef];
      if (refFloor !== undefined) {
        return Math.max(
          this.config.executor.timeoutMs,
          Math.min(Math.floor(refFloor), this.config.executor.maxTimeoutMs),
        );
      }
      if (!isBlockingOrchestrationRef(targetRef)) return undefined;
      const requestedTimeoutMs =
        targetRef === "agents.run" &&
        typeof targetArgs.timeoutMs === "number" &&
        Number.isFinite(targetArgs.timeoutMs)
          ? Math.max(
              MIN_AGENT_TIMEOUT_MS,
              Math.min(Math.floor(targetArgs.timeoutMs), MAX_AGENT_TIMEOUT_MS),
            )
          : 0;
      return Math.max(orchestrationTimeoutMs, requestedTimeoutMs);
    };
    const humanWaitRefs = new Set(this.config.executor.humanWaitRefs);
    const isHumanWaitHostCall = (ref: string, args: Record<string, unknown>): boolean =>
      humanWaitRefs.has(hostCallRef(ref, args));
    const traceAttempt = async <T>(
      ref: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
      run: (setStage: (stage: FabricExecutionFailureStageV1) => void) => T | Promise<T>,
    ): Promise<T> => {
      const operation = traceRecorder.issueCall(ref, args);
      let stage: FabricExecutionFailureStageV1 = "invoke";
      try {
        const value = await run((nextStage) => {
          stage = nextStage;
        });
        operation.succeed(undefined);
        return value;
      } catch (error) {
        operation.fail(stage, error, executionOutcomeFromError(error, signal));
        throw error;
      }
    };
    const invokeAction = async (
      ref: string,
      args: Record<string, unknown>,
      callContext: typeof baseContext & { signal: AbortSignal; nativeToolResult?: boolean },
      humanWait?: FabricHumanWait,
    ): Promise<unknown> => {
      const traceOperation = traceRecorder.issueCall(ref, args);
      // An approval prompt waits for a person, so the program deadline pauses
      // while it is open. An explicit hard timeout still bounds everything.
      const approvalWait = options.hardTimeoutMs === undefined ? humanWait : undefined;
      try {
        guardFullCodeRef(ref);
        guardAgentCall(ref);
      } catch (error) {
        traceOperation.fail(
          "guard",
          error,
          executionOutcomeFromError(error, callContext.signal),
        );
        throw error;
      }
      const participants = this.#participants;
      const separator = ref.indexOf(".");
      return this.registry.invoke(ref, args, {
        ...callContext,
        // The registry resolves `provider.action` by this exact prefix, so the
        // view is bound to the provider that receives it.
        ...(participants && separator > 0
          ? { participants: participants.view(ref.slice(0, separator), options.parentToolCallId) }
          : {}),
        ...(ref === "agents.handoff"
          ? {
              deferHandoff(request: Record<string, unknown>) {
                if (handoffRequest) {
                  throw new Error(
                    "Only one agents.handoff request is allowed per fabric_exec invocation",
                  );
                }
                handoffRequest = structuredClone(request);
                return {
                  scheduled: true,
                  status: "deferred",
                  boundary: "fabric_exec_end",
                };
              },
            }
          : {}),
        ...(this.authorizer
          ? {
              authorize: (action) =>
                this.authorizer!.authorize(action.ref, options.parentToolCallId),
            }
          : {}),
        approve: async (action, preparedArgs) => {
          if (action.ref === "schema.commit") {
            await approval.approve({ ...action, risk: "write" }, preparedArgs, approvalWait);
            await approval.approve({ ...action, risk: "execute" }, preparedArgs, approvalWait);
            return;
          }
          await approval.approve(action, preparedArgs, approvalWait);
        },
        audits,
        // Native images/state must stay intact; final output has its own bounds.
        maxResultChars: ref.startsWith("native.") || callContext.nativeToolResult ? 16_777_216 : this.config.executor.maxNestedResultChars,
        traceOperation,
        observeInvocation,
      });
    };
    const nativeTransaction = this.nativeCodemode.begin(options.parentToolCallId, options.context, !python && codemodeProfile === "native");
    const loadNativeCatalog = async (context: typeof baseContext) => {
      const api = await import("./native-tool-catalog.js");
      const definitions = ((options.context as Partial<import("@earendil-works/pi-coding-agent").ExtensionToolContext>).tools
        ?? this.capturedTools?.registeredTools().map(entry => entry.definition)
        ?? []) as import("@earendil-works/pi-coding-agent").ToolDefinition[];
      // A native host already supplies its callable catalog. Do not initialize
      // an independent MCP transport just to alias those registered tools.
      // Only Pi-native providers contribute aliases. An unrelated provider's
      // discovery failure or pending connection must not block every program.
      const providers = definitions.length ? ["pi", "extensions"] : ["pi", "extensions", "mcp"];
      const actions = (await Promise.all(providers.filter(provider => this.registry.has(provider))
        .map(provider => this.registry.list({provider, limit: 1_000}, context)))).flat();
      const refs = new Set(actions.map(action => action.ref));
      // Host registrations beyond the Fabric discovery page remain reachable.
      for (const definition of definitions) {
        const ref = nativeToolRef(definition, nativeMcpIdentity);
        if (refs.has(ref)) continue;
        refs.add(ref);
        try { actions.push(await this.registry.describe(ref, context)); } catch { /* hidden or unavailable */ }
      }
      const entries = api.nativeToolCatalog(actions.filter(action => effectiveFullCodeMode || !fullCodeProvider(action.provider)), definitions, nativeMcpIdentity);
      nativeCallRefs.clear();
      for (const entry of entries) nativeCallRefs.set(entry.name, nativeCallRefs.has(entry.name) ? undefined : entry.ref);
      return {api, entries};
    };
    // Like Pi, bind callable identifiers once per invocation. Actual dispatch
    // still rechecks live authority; a removed alias never retargets another tool.
    let nativeCatalogSnapshot: ReturnType<typeof loadNativeCatalog> | undefined;
    const nativeCatalog = (context: typeof baseContext) => nativeCatalogSnapshot ??= loadNativeCatalog(context);
    let nativeFinished = false;
    let sandboxResult: FabricSandboxResult;
    let hostCall: FabricHostCall | undefined;
    const sandboxBase = {
      cwd: options.context.cwd,
      nativeStoreEnabled: this.nativeCodemode.persistenceAvailable,
      nativeToolsEnabled: !python,
      codemodeProfile,
      memoryLimitBytes: this.config.executor.memoryLimitBytes,
      maxLogChars: this.config.executor.maxOutputChars,
      ...(options.hardTimeoutMs === undefined ? { minimumTimeoutMsForHostCall } : {}),
      ...(options.hardTimeoutMs === undefined && humanWaitRefs.size > 0 ? { isHumanWaitHostCall } : {}),
      ...(!python ? { piToolCanonicalFields } : {}),
      ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
    };
    // Saved programs (`programs.run`) execute through this same bridge, so a
    // nested program shares the caller's view, approvals, budgets and trace.
    const nestedLogs: string[] = [];
    let nestedLogChars = 0;
    let nestedRuns = 0;
    // Same source, same declarations: a repeated program type-checks once.
    const preparedPrograms = new Map<string, { code: string; checked: FabricTypeCheckResult }>();
    const runNestedProgram = async (
      request: FabricNestedProgramRun,
      signal: AbortSignal | undefined,
    ): Promise<unknown> => {
      const bridge = hostCall;
      if (!bridge) throw new Error("Fabric program runs need an active execution");
      nestedRuns++;
      if (nestedRuns > MAX_NESTED_PROGRAM_RUNS) {
        throw new FabricTraceSafeError(`Fabric nested program budget exhausted (${MAX_NESTED_PROGRAM_RUNS} per execution)`);
      }
      const operation = traceRecorder.issueCall("fabric.program.run", {
        program: request.program,
        ...(options.invokedBy ? { invokedBy: options.invokedBy } : {}),
      });
      const runSignal = signal ?? new AbortController().signal;
      let stage: FabricExecutionFailureStageV1 = "invoke";
      try {
        if (request.call) {
          const value = await bridge(request.call.ref, request.call.args, runSignal);
          operation.succeed(undefined);
          return value;
        }
        let source = request.code ?? "";
        let prepared: FabricTypeCheckResult = { errors: [] };
        if (!python) {
          stage = "prepare";
          const cached = preparedPrograms.get(source);
          const next = cached ?? (runtime as TypeScriptKernelRuntime).prepare(
            source,
            effectiveFullCodeMode,
            [...unavailable.keys()],
            guestTypeSources,
            coreOverrides,
            false,
            codemodeProfile,
          );
          if (!cached) preparedPrograms.set(source, next);
          ({ code: source, checked: prepared } = next);
          if (prepared.errors.length > 0) {
            throw new Error(`Program ${request.program} has type errors: ${prepared.errors
              .slice(0, 5)
              .map((error) => error.line > 0 ? `line ${error.line}:${error.column} ${error.message}` : error.message)
              .join("; ")}`);
          }
          stage = "invoke";
        }
        // Guest span ids restart in each program; keep them distinct per run.
        const spanPrefix = `program-${nestedRuns}:`;
        const nestedBridge: FabricHostCall = (ref, args, callSignal, humanWait) =>
          (ref === "fabric.$spanStart" || ref === "fabric.$spanEnd") && typeof args.id === "string"
            ? bridge(ref, { ...args, id: `${spanPrefix}${args.id}` }, callSignal, humanWait)
            : bridge(ref, args, callSignal, humanWait);
        const result = await runtime.execute(source, nestedBridge, {
          ...sandboxBase,
          timeoutMs: codeUsesOrchestration(source) ? orchestrationTimeoutMs : this.config.executor.timeoutMs,
          ...(prepared.javascript ? { transpiledCode: prepared.javascript } : {}),
          ...(prepared.sourceMap ? { transpiledSourceMap: prepared.sourceMap } : {}),
          signal: runSignal,
        });
        for (const line of result.logs) {
          if (nestedLogChars > this.config.executor.maxOutputChars) break;
          nestedLogChars += line.length;
          nestedLogs.push(nestedLogChars > this.config.executor.maxOutputChars
            ? `[${request.program}] (nested program logs truncated)`
            : `[${request.program}] ${line}`);
        }
        if (result.terminationReason !== "completed") {
          const outcome = executionOutcomeFromTermination(result.terminationReason);
          throw Object.assign(
            new Error(`Program ${request.program} ${outcome.replace("_", " ")}: ${result.error ?? "no result"}`),
            { programOutcome: outcome },
          );
        }
        operation.succeed(undefined);
        return result.value;
      } catch (error) {
        const outcome = (error as { programOutcome?: "failed" | "aborted" | "timed_out" }).programOutcome
          ?? executionOutcomeFromError(error, runSignal);
        operation.fail(stage, error, outcome);
        throw error;
      }
    };
    this.#nestedRunners.set(options.parentToolCallId, {
      kernel: python ? "python" : "typescript",
      run: runNestedProgram,
    });
    try {
      sandboxResult = await runtime.execute(
        code,
        hostCall = async (ref, args, runtimeSignal, humanWait) => {
          const callContext = { ...baseContext, signal: runtimeSignal };
          switch (ref) {
            case "fabric.$nativeTool": {
              if (!args.args || typeof args.args !== "object" || Array.isArray(args.args)) throw new Error("Native tools take one argument object");
              const {api, entries} = await nativeCatalog(callContext);
              const tool = api.resolveNativeTool(entries, args.name);
              return invokeAction(tool.ref, args.args as Record<string, unknown>, {...callContext, nativeToolResult: true}, humanWait);
            }
            case "fabric.$piAllTools":
            case "fabric.$piSearch":
            case "fabric.$piDescribe":
            case "fabric.$piNamespace": {
              const {api, entries} = await nativeCatalog(callContext);
              const info = (entry: typeof entries[number]) => ({name: entry.name, description: entry.description});
              if (ref === "fabric.$piAllTools") return entries.map(info);
              if (ref === "fabric.$piSearch") return api.searchNativeTools(entries, args.query, args.limit, args.namespace).map(info);
              if (typeof args.name !== "string") throw new Error("Native discovery expects a name string");
              if (ref === "fabric.$piDescribe") {
                const matches = entries.filter(entry => entry.name === args.name || entry.rawName === args.name);
                return matches.length === 1 ? matches[0]!.description : undefined;
              }
              const matches = entries.filter(entry => entry.namespace && (entry.namespace.name === args.name || nativeToolIdentifier(entry.namespace.name) === args.name));
              if (!matches.length) return undefined;
              return {...matches[0]!.namespace, tools: matches.map(entry => entry.name)};
            }
            case "fabric.$allTools":
            case "fabric.$nativeSearch":
            case "fabric.$nativeDescribe":
            case "fabric.$describeNamespace":
              return traceAttempt("fabric.discovery.compatibility", args, runtimeSignal, async () => {
                const actions = (await this.registry.list({ limit: 1_000 }, callContext)).filter(action => effectiveFullCodeMode || !fullCodeProvider(action.provider));
                if (ref === "fabric.$describeNamespace") {
                  const { describeNativeNamespace } = await import("./native-discovery.js");
                  return describeNativeNamespace(String(args.name ?? ""), actions, this.capturedTools, nativeMcpIdentity);
                }
                if (ref === "fabric.$nativeDescribe") {
                  const matches = actions.filter(action => action.ref === args.name || action.name === args.name);
                  if (matches.length !== 1) return undefined;
                  const action = matches[0]!;
                  const { describeFabricActionDeclaration } = await import("./runtime/dynamic-guest-types.js");
                  return { name: action.ref, description: action.description, declaration: describeFabricActionDeclaration(action.ref, action.inputSchema) };
                }
                if (ref === "fabric.$nativeSearch") {
                  const candidates = await this.registry.search(String(args.query ?? ""), callContext, 1_000);
                  const visible = new Set(actions.filter(action => args.namespace === undefined || action.namespace === args.namespace || action.provider === args.namespace).map(action => action.ref));
                  return candidates.filter(action => visible.has(action.ref)).slice(0, Math.max(1, Math.min(typeof args.limit === "number" ? args.limit : 8, 1_000))).map(action => ({ name: action.ref, description: action.description }));
                }
                return actions.map(action => ({ name: action.ref, description: action.description }));
              });
            case "fabric.$providers":
              return traceAttempt(
                "fabric.discovery.providers",
                args,
                runtimeSignal,
                () =>
                  this.registry
                    .providers(callContext)
                    .filter((provider) =>
                      !callContext.capabilityView ||
                      Object.values(callContext.capabilityView.bindings)
                        .some((binding) => binding.provider === provider.name),
                    )
                    .filter(
                      (provider) => effectiveFullCodeMode || !fullCodeProvider(provider.name),
                    ),
              );
            case "fabric.$catalog":
              return traceAttempt(
                "fabric.discovery.catalog",
                args,
                runtimeSignal,
                async (setStage) => {
                  const provider = typeof args.provider === "string" ? args.provider : undefined;
                  setStage("guard");
                  if (provider) guardFullCodeRef(`${provider}.*`);
                  setStage(provider && !this.registry.has(provider) ? "resolve" : "invoke");
                  return this.registry.catalog(callContext, {
                    ...(provider ? { provider } : {}),
                    ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
                    includeProvider: (name) => effectiveFullCodeMode || !fullCodeProvider(name),
                  });
                },
              );
            case "fabric.$models": {
              const operation = traceRecorder.issueCall("fabric.discovery.models", args);
              const registry = options.context.modelRegistry;
              try {
                const available =
                  typeof registry?.getAvailable === "function" ? registry.getAvailable() : [];
                const models = available.map((model) => ({
                  provider: String(model.provider),
                  id: String(model.id),
                  name: String(model.name ?? model.id),
                  key: `${model.provider}/${model.id}`,
                }));
                operation.succeed(undefined);
                return models;
              } catch (error) {
                operation.fail(
                  "invoke",
                  error,
                  executionOutcomeFromError(error, runtimeSignal),
                );
                return [];
              }
            }
            case "fabric.$list":
              return traceAttempt(
                "fabric.discovery.list",
                args,
                runtimeSignal,
                async (setStage) => {
                  setStage("guard");
                  if (typeof args.provider === "string") {
                    guardFullCodeRef(`${args.provider}.*`);
                  }
                  setStage(
                    typeof args.provider === "string" && !this.registry.has(args.provider)
                      ? "resolve"
                      : "invoke",
                  );
                  const request = {
                    ...(typeof args.provider === "string" ? { provider: args.provider } : {}),
                    ...(typeof args.namespace === "string" ? { namespace: args.namespace } : {}),
                    ...(typeof args.query === "string" ? { query: args.query } : {}),
                    ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
                  };
                  // Silent page caps make guests conclude actions are absent
                  // (tools.list is the trap: servers sorted past the cap look
                  // missing). envelope: true returns an honest page with totals;
                  // the bare-array default stays byte-for-byte unchanged.
                  if (args.envelope === true) {
                    const limit = fabricActionListLimit(
                      typeof args.limit === "number" ? args.limit : undefined,
                    );
                    // Enumerate past the caller's page (hard ceiling 1000, the
                    // registry's own) so totals reflect post-permission counts.
                    const { actions: capped } = await this.registry.listDetailed(
                      { ...request, limit: 1_000 },
                      callContext,
                    );
                    const visible = capped.filter(
                      (action) => effectiveFullCodeMode || !fullCodeProvider(action.provider),
                    );
                    const page = visible.slice(0, limit);
                    return {
                      kind: "pi-fabric.action-list",
                      version: 1,
                      actions: page,
                      total: visible.length,
                      truncated: visible.length > page.length,
                      limit,
                    };
                  }
                  const actions = await this.registry.list(request, callContext);
                  return actions.filter(
                    (action) => effectiveFullCodeMode || !fullCodeProvider(action.provider),
                  );
                },
              );
            case "fabric.$search":
              return traceAttempt(
                "fabric.discovery.search",
                args,
                runtimeSignal,
                async () => {
                  const query = String(args.query ?? "");
                  const limit = typeof args.limit === "number" ? args.limit : undefined;
                  const searchMode = args.searchMode;
                  if (
                    searchMode !== undefined &&
                    searchMode !== "lexical" &&
                    searchMode !== "semantic"
                  ) {
                    throw new Error("invalid_search_mode");
                  }
                  const visible = (actions: Awaited<ReturnType<ActionRegistry["search"]>>) =>
                    actions.filter(
                      (action) => effectiveFullCodeMode || !fullCodeProvider(action.provider),
                    );
                  if (searchMode === "semantic") {
                    if (!this.config.mcp.jev.semanticSearch) {
                      throw new Error(
                        "Jev semantic search is disabled. Enable it in /fabric settings → MCP.",
                      );
                    }
                    const listed = visible(await this.registry.list({ limit: 1_000 }, callContext));
                    const result = await semanticSearchActions({
                      query,
                      actions: listed,
                      blockedServers: this.config.mcp.jev.blockedServers,
                      candidateLimit: this.config.mcp.jev.semanticCandidateLimit,
                      minProbability: this.config.mcp.jev.semanticMinProbability,
                      signal: runtimeSignal ?? new AbortController().signal,
                      evaluate: async (request, signal) => {
                        const { JevClient, JevCredentials } = await import("./jev/client.js");
                        const route = resolveJevModelRoute(this.config.jev.model).route;
                        const extensionContext = callContext.extensionContext;
                        const client = new JevClient(
                          this.config.jev,
                          fetch,
                          new JevCredentials(
                            this.config.jev.credentialCommand,
                            process.env,
                            {
                              configured: () =>
                                extensionContext.modelRegistry.getProviderAuthStatus?.(route.providerId)
                                  ?.configured ?? false,
                              resolve: async (abort) => {
                                abort.throwIfAborted();
                                return extensionContext.modelRegistry.getApiKeyForProvider?.(
                                  route.providerId,
                                );
                              },
                            },
                            route.envKeys,
                          ),
                          route,
                        );
                        return client.evaluate(request, signal);
                      },
                    });
                    if (!result.ok) throw new Error(result.error.message);
                    return {
                      kind: "pi-fabric.action-search",
                      version: 1,
                      actions: result.actions.slice(
                        0,
                        Math.max(1, Math.min(limit ?? 30, 100)),
                      ),
                      backend: result.backend,
                    };
                  }
                  return visible(await this.registry.search(query, callContext, limit));
                },
              );
            case "fabric.$describe":
              return traceAttempt(
                "fabric.discovery.describe",
                args,
                runtimeSignal,
                async (setStage) => {
                  const targetRef = String(args.ref ?? "");
                  setStage("guard");
                  guardFullCodeRef(targetRef);
                  setStage("resolve");
                  return this.registry.describe(targetRef, callContext);
                },
              );
            case "fabric.$call": {
              if (typeof args.ref !== "string" || !args.ref.trim()) {
                throw new Error("tools.call requires a non-empty ref string; discover the exact ref with tools.search/describe.");
              }
              if (args.args !== undefined && (typeof args.args !== "object" || args.args === null || Array.isArray(args.args))) {
                throw new Error(python
                  ? 'tools.call args must be a dictionary; use await tools.call(ref="provider.action", args={"key": "value"}).'
                  : 'tools.call args must be an object; use await tools.call({ref: "provider.action", args: {key: "value"}}).');
              }
              const callArgs = { ...(args.args as Record<string, unknown> | undefined) };
              const targetRef = args.ref;
              const shell = isPiShellRef(targetRef);
              if (shell && callArgs.settle !== undefined && typeof callArgs.settle !== "boolean") {
                throw new Error(python ? "pi shell settle must be a boolean; use settle=True or settle=False" : "pi shell settle must be a boolean; use settle: true or settle: false");
              }
              const settle = shell && callArgs.settle === true;
              if (shell) delete callArgs.settle;
              try {
                return await invokeAction(targetRef, callArgs, callContext, humanWait);
              } catch (error) {
                const exit = settle ? piBashExitMetadata(error) : undefined;
                if (exit) return { ok: false, ...exit, details: null, error: error instanceof Error ? error.message : String(error) };
                throw error;
              }
            }
            case "fabric.$progress":
              return traceAttempt(
                "fabric.workflow.progress",
                args,
                runtimeSignal,
                () => update(String(args.message ?? "Working")),
              );
            case "fabric.$configure":
              return traceAttempt(
                "fabric.workflow.configure",
                args,
                runtimeSignal,
                () => {
                  const display: FabricRunDisplay = {
                    ...(typeof args.name === "string" ? { name: args.name } : {}),
                    ...(typeof args.description === "string" ? { description: args.description } : {}),
                  };
                  return this.activity?.configure(options.parentToolCallId, display) ?? display;
                },
              );
            case "fabric.$phase":
              return traceAttempt(
                "fabric.workflow.phase",
                args,
                runtimeSignal,
                (setStage) => {
                  setStage("validate");
                  const name =
                    typeof args.name === "string" ? args.name.trim() : "";
                  if (!name) throw new Error("Workflow phase name must be a non-empty string");
                  phases.push(name);
                  const phaseIndex = phases.length - 1;
                  const phaseInput: FabricPhaseInput = {
                    name,
                    ...(typeof args.id === "string" ? { id: args.id } : {}),
                    ...(typeof args.description === "string" ? { description: args.description } : {}),
                    ...(typeof args.total === "number" ? { total: args.total } : {}),
                  };
                  setStage("invoke");
                  const activityPhase = this.activity?.phase(options.parentToolCallId, phaseInput);
                  update(`Phase: ${name}`);
                  return {
                    name,
                    index: phaseIndex,
                    ...(activityPhase ? { id: activityPhase.id } : {}),
                  };
                },
              );
            case "fabric.$item":
              return traceAttempt(
                "fabric.workflow.item",
                args,
                runtimeSignal,
                (setStage) => {
                  setStage("validate");
                  // The trace projects the original args; meta stays out of it.
                  const transition = validateWorkflowItemInput(
                    args,
                    () => itemTransitions.nextDefaultId(),
                  );
                  setStage("invoke");
                  const { meta: _meta, ...rest } = args;
                  const item = { ...rest, id: transition.id } as unknown as FabricActivityItemInput;
                  const stored = this.activity?.upsertItem(options.parentToolCallId, item) ?? item;
                  itemTransitions.record(transition, stored.label);
                  return stored;
                },
              );
            case "fabric.$event":
              return traceAttempt(
                "fabric.workflow.event",
                args,
                runtimeSignal,
                () => {
                  const event = args as unknown as FabricActivityEventInput;
                  this.activity?.event(options.parentToolCallId, event);
                },
              );
            case "fabric.$spanStart": {
              const id = typeof args.id === "string" ? args.id : "";
              const kind = args.kind;
              if (!id || (kind !== "parallel" && kind !== "pipeline")) {
                throw new Error("Invalid internal workflow span start");
              }
              if (workflowSpans.has(id)) throw new Error("Duplicate internal workflow span");
              const operation = traceRecorder.issueCall(`fabric.workflow.${kind}`, args);
              workflowSpans.set(id, { kind, operation });
              return undefined;
            }
            case "fabric.$spanEnd": {
              const id = typeof args.id === "string" ? args.id : "";
              const span = workflowSpans.get(id);
              if (!span) throw new Error("Unknown internal workflow span");
              workflowSpans.delete(id);
              if (args.outcome === "succeeded") span.operation.succeed(undefined);
              else {
                span.operation.fail(
                  "invoke",
                  undefined,
                  executionOutcomeFromError(new Error("Workflow span failed"), runtimeSignal),
                );
              }
              return undefined;
            }
            default:
              return invokeAction(ref, args, callContext, humanWait);
          }
        },
        {
          ...sandboxBase,
          timeoutMs: options.hardTimeoutMs === undefined ? effectiveTimeoutMs : Math.min(options.hardTimeoutMs, this.config.executor.maxTimeoutMs),
          ...(checked.javascript ? { transpiledCode: checked.javascript } : {}),
          ...(checked.sourceMap ? { transpiledSourceMap: checked.sourceMap } : {}),
          ...(options.strings ? { strings: options.strings } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      try {
        classifierUsages.push(...nativeTransaction.finish(sandboxResult.terminationReason === "completed" && !options.signal?.aborted));
        nativeFinished = true;
      } catch (error) {
        sandboxResult.terminationReason = "runtime_error";
        sandboxResult.error = error instanceof Error ? error.message : String(error);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.activity?.finish(options.parentToolCallId, false, message);
      itemTransitions.finish(false);
      if (options.signal?.aborted) {
        await this.#participants?.cancelInvocation(options.parentToolCallId).catch(() => undefined);
      }
      throw error;
    } finally {
      if (!nativeFinished) classifierUsages.push(...nativeTransaction.finish(false));
      this.#nestedRunners.delete(options.parentToolCallId);
      await this.registry.endInvocation(options.parentToolCallId);
      flushEmit();
    }

    if (python && sandboxResult.terminationReason === "runtime_error" && sandboxResult.error) {
      const hint = pythonErrorRecoveryHint(code, sandboxResult.error, monty ? "monty" : "cpython");
      if (hint && !sandboxResult.error.includes(hint)) sandboxResult.error += `\n\nRecovery hint: ${hint}`;
    }
    const runOutcome = executionOutcomeFromTermination(sandboxResult.terminationReason);
    const succeeded = runOutcome === "succeeded";
    const ownedWork = (runOutcome === "aborted" || runOutcome === "timed_out") && this.#participants
      ? await stopOwnedWork(this.#participants, options.parentToolCallId, traceRecorder)
      : [];
    if (ownedWork.length > 0) {
      const summary = `Owned work stopped: ${ownedWork
        .map((stop) => `${stop.ref} ${stop.outcome}${stop.detail ? ` (${stop.detail})` : ""}`)
        .join("; ")}`;
      sandboxResult.error = sandboxResult.error ? `${sandboxResult.error}\n${summary}` : summary;
    }
    this.activity?.finish(options.parentToolCallId, succeeded, sandboxResult.error);
    itemTransitions.finish(succeeded);
    // Logs, results, and error text reach the model, the event stream, and
    // persisted traces. Raw media must not: images are hoisted out of band and
    // base64 payloads collapse to a descriptor (see core/media-sanitize.ts).
    const sanitizedValue = sanitizeFabricMediaValue({ value: sandboxResult.value, emitted: sandboxResult.emitted ?? [] });
    const imageArtifacts = !python && (sandboxResult.emitted?.length ?? 0) > 0
      ? await import("./native-image-artifacts.js").then(module => module.persistNativeImages(sanitizeFabricMediaValue(sandboxResult.emitted).images))
        .catch(error => [`Image artifact unavailable: ${String(error)}`])
      : [];
    return {
      success: succeeded,
      kernel: python ? "python" : "typescript",
      value: (sanitizedValue.value as { value: unknown }).value,
      logs: [...sandboxResult.logs, ...nestedLogs, ...imageArtifacts].map(sanitizeFabricMediaText),
      ...(sanitizedValue.images.length > 0 ? { media: sanitizedValue.images } : {}),
      audits,
      phases,
      // Guest and provider error text may embed tool output or source
      // literals, so the durable trace records only safe causes.
      trace: traceRecorder.seal(runOutcome, phases),
      ...(assessment ? { assessment: assessment.seal(runOutcome) } : {}),
      elapsedMs: performance.now() - startedAt,
      ...(sandboxResult.error ? { error: sanitizeFabricMediaText(sandboxResult.error) } : {}),
      ...(handoffRequest ? { handoffRequest } : {}),
      ...(ownedWork.length > 0 ? { ownedWork } : {}),
      ...(classifierUsages.length > 0
        ? { usage: aggregateUsage(classifierUsages) }
        : {}),
    };
  }
}
