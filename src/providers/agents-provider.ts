import { observeExisting, type ObservationSource } from "../core/observation-actions.js";
import { ActorManager, ActorRegistryOwnershipError } from "../actors/manager.js";
import { GlobalActorRegistry } from "../actors/global-registry.js";
import { isFabricActorHostEvent } from "../actors/types.js";
import type {
  FabricActorDelivery,
  FabricActorHostEvent,
  FabricActorInfo,
  FabricActorMessage,
  FabricActorRequest,
  FabricActorRunBinding,
} from "../actors/types.js";
import type {
  FabricAgentMessageResult,
  FabricMainAgentTarget,
} from "../main-agent.js";
import type { MeshIdentity } from "../mesh/store.js";
import {
  acceptProviderParticipantControl,
  controlProviderParticipant,
  isProviderParticipantRef,
  type ProviderParticipantRegistry,
} from "../topology/provider-participants.js";
import { LifecycleBroker } from "../lifecycle/broker.js";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_LIFECYCLE_COALESCE_MS,
  LifecycleDeliveryScheduler,
  type PendingLifecycleDelivery,
} from "../lifecycle/delivery-scheduler.js";
import {
  isFabricLifecycleEventType,
  lifecycleSourceIdentity,
  type FabricLifecycleEvent,
  type FabricLifecycleSubscription,
} from "../lifecycle/types.js";
import {
  FabricControlPlane,
  type FabricControlCommand,
  type FabricControlAcceptance,
} from "../topology/control-plane.js";
import type {
  FabricParticipantInfo,
  FabricParticipantScope,
  FabricParticipantSource,
} from "../topology/types.js";
import type {
  FabricActionDescriptor,
  FabricCapabilityRequirement,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";
import {
  effectiveAgentTimeoutMs,
  AgentManager,
} from "../agents/manager.js";
import { checkedHandoffCompaction } from "../agents/handoff.js";
import { checkedSeed, completedBranchPrefix, snippetTask } from "../agents/fork-seed.js";
import { readAgentLineage } from "../agents/child-env.js";
import { childScope, sessionScope } from "../scope.js";
import { withInheritedSessionPins } from "../agents/session-pins.js";
import type {
  AgentHandleInfo,
  AgentRunRecord,
  AgentRunRequest,
  AgentRunResult,
  AgentSessionSeed,
} from "../agents/types.js";
import type { ThinkingTransferInput } from "../agents/thinking-transfer.js";
import {
  DEFAULT_FABRIC_CONFIG,
  type FabricAgentRunner,
  type FabricModelsConfig,
} from "../config.js";
import {
  FUZZY_RESOLUTION_MARKERS,
  aliasThinking,
  assertExactModelRequest,
  resolvePiModelSelector,
  resolveFabricModel,
  type FabricModelCandidate,
  type FabricModelMatch,
} from "../core/model-resolution.js";
import { loadModelUsage } from "../core/model-usage.js";
import { resolveAgentDir } from "../core/agent-dir.js";
import { AGENTS_ACTION_DESCRIPTORS } from "./agents-actions.js";
import { FabricTraceSafeError } from "../audit/trace.js";
import { actionArgNormalizer } from "./arg-normalization.js";
import { isFabricThinking } from "../thinking.js";
import { normalizeAgentRunRequest } from "../agents/request.js";
import {
  BUILT_IN_RUNNER_IDS,
  isFabricRunnerId,
  requireAgentRunner,
} from "../agents/runner-registry.js";
import { ResidencyClient } from "../residency/client.js";
import { ResidentActorClient } from "../residency/actor-client.js";
import { AgentTranscriptReader } from "../ui/transcript.js";
import { waitWithProgress, waitWithActorProgress } from "./agents-progress.js";
import { AgentMessageRouter } from "./agents-message-router.js";
import { terminalAgentStatuses } from "../agents/lifecycle.js";

export { collectAgentToolPreviewNodes, type AgentToolPreviewTreeOptions } from "./agents-progress.js";

const REMOTE_ASK_ACK_GRACE_MS = 30_000;
const MAX_ACTIVITY_CWD_CHARS = 240;

const displaySafeCwd = (cwd: string): string => {
  const safe = cwd.replace(/[\u0000-\u001f\u007f]/g, (character) =>
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
  );
  if (safe.length <= MAX_ACTIVITY_CWD_CHARS) return safe;
  return `…${safe.slice(-(MAX_ACTIVITY_CWD_CHARS - 1))}`;
};

const agentStartedMessage = (handle: AgentHandleInfo): string =>
  `Agent ${handle.name} ${handle.status === "queued" ? "queued for a slot" : "started"} via ${handle.runner}/${handle.transport}${handle.attachCommand ? ` · ${handle.attachCommand}` : ""} · cwd ${displaySafeCwd(handle.cwd)}`;

// Resolve source and executor reasoning channels for the trajectory handoff
// boundary. The executor model must be registered to transfer at all; an
// unresolvable source model simply yields no family comparison, so the
// transfer falls back to the target-driven policy.
const resolveThinkingTransfer = (
  extensionContext: FabricInvocationContext["extensionContext"],
  targetKey: string,
  sourceModel?: { provider: string; modelId: string },
): ThinkingTransferInput | undefined => {
  const separator = targetKey.indexOf("/");
  if (separator <= 0 || separator === targetKey.length - 1) return undefined;
  // Invocation contexts don't always thread the extension host (tests, nested
  // runners); without a registry no family comparison is possible.
  const registry = extensionContext?.modelRegistry;
  if (!registry) return undefined;
  const target = registry.find(targetKey.slice(0, separator), targetKey.slice(separator + 1));
  if (!target) return undefined;
  const source = sourceModel
    ? {
        provider: sourceModel.provider,
        modelId: sourceModel.modelId,
        api: registry.find(sourceModel.provider, sourceModel.modelId)?.api,
      }
    : undefined;
  return {
    ...(source ? { source } : {}),
    target: {
      provider: target.provider,
      modelId: target.id,
      api: target.api,
      reasoning: target.reasoning,
      ...((target.compat as { requiresThinkingAsText?: boolean } | undefined)
        ?.requiresThinkingAsText !== undefined
        ? {
            requiresThinkingAsText: (target.compat as { requiresThinkingAsText?: boolean })
              .requiresThinkingAsText,
          }
        : {}),
    },
  };
};

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;

const actorRunBinding = (args: Record<string, unknown>): FabricActorRunBinding => ({
  ...(typeof args.model === "string" && args.model.trim()
    ? { model: args.model.trim() }
    : {}),
  ...(isFabricThinking(args.thinking) ? { thinking: args.thinking } : {}),
});

const longerTimeoutOverride = (
  value: unknown,
  manager: AgentManager,
): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const effective = effectiveAgentTimeoutMs(manager.config.timeoutMs, value);
  return effective > manager.config.timeoutMs ? effective : undefined;
};

const checkedRunner = (value: unknown, fallback: FabricAgentRunner): FabricAgentRunner => {
  if (value === undefined) return fallback;
  if (!isFabricRunnerId(value)) throw new Error(`Invalid Fabric agent runner: ${JSON.stringify(value)}`);
  return value;
};

const MAX_MODEL_KEY_CHARS = 256;
const MODEL_KEY_RULE =
  `model must be a string of 1 to ${MAX_MODEL_KEY_CHARS} characters (an exact key from agents.models())`;

// Count code points, as the schema's minLength/maxLength do, not UTF-16 units.
const isModelKey = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && [...value].length <= MAX_MODEL_KEY_CHARS;

/** agents.models({ model }): an exact, untrimmed key; undefined means the unfiltered list. */
const checkedModelKey = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (!isModelKey(value)) throw new Error(`agents.models ${MODEL_KEY_RULE}`);
  return value;
};

const checkedKernel = (value: unknown): AgentRunRequest["kernel"] => {
  if (value === undefined || value === "inherit" || value === "typescript" || value === "python") return value;
  throw new Error(`Invalid Fabric agent kernel: ${String(value)}`);
};

const runRequest = (
  args: Record<string, unknown>,
  context: FabricInvocationContext,
  manager: AgentManager,
  modelsConfig: FabricModelsConfig,
  options: {allowCwd?: boolean} = {},
): AgentRunRequest => ({
  ...normalizeAgentRunRequest(
    {...args, timeoutMs: longerTimeoutOverride(args.timeoutMs, manager)},
    {
      ...manager.config,
      models: modelsConfig,
      ...(context.extensionContext.model ? {inheritedModel: context.extensionContext.model} : {}),
    },
    options,
  ),
  // Host-only: lets a trace-context listener parent the child under this call.
  traceOrigin: {parentToolCallId: context.parentToolCallId, nestedToolCallId: context.nestedToolCallId},
});

const handoffTask = (args: Record<string, unknown>): string => {
  const task = typeof args.task === "string" ? args.task.trim() : "";
  const lines = [
    "Continue and complete the current user task from the inherited conversation trajectory and current workspace.",
    "The caller is blocked awaiting this run. Finish what the user actually requested. If the request is read-only — a plan, review, or investigation — deliver the answer without changing files. For implementation requests, complete the remaining changes and verification; do not merely restate the plan.",
    "Treat the inherited conversation, completed outer Fabric result, and current workspace as grounded context. Inspect again only where the workspace or a failed check makes it necessary.",
    "Keep the work scoped, run the relevant test module or equivalent verification, and report the result plus checks honestly.",
    "End with a concise conclusion for the caller: what you completed, which checks passed or failed, and any unfinished or blocked work. Include links, PR and issue numbers, commit hashes, and artifact paths verbatim.",
  ];
  if (task) lines.push("Additional continuation task:", task);
  return lines.join("\n\n");
};

const compactHandoffResult = (
  result: AgentRunResult,
): Record<string, unknown> => ({
  handedOff: true,
  completed: result.status === "completed",
  status: result.status,
  agent: {
    id: result.id,
    name: result.name,
    runner: result.runner,
    ...(result.kernel ? { kernel: result.kernel } : {}),
    transport: result.transport,
    ...(result.model ? { model: result.model } : {}),
    ...(result.thinking ? { thinking: result.thinking } : {}),
    turns: result.turns,
    toolCalls: result.toolCalls,
    usage: result.usage,
  },
  implementation: result.value ?? result.text,
  ...(result.error ? { error: result.error } : {}),
});

const actorRequest = (
  args: Record<string, unknown>,
  context: FabricInvocationContext,
  manager: AgentManager,
  inheritModel = true,
): FabricActorRequest => {
  const events = Array.isArray(args.events)
    ? args.events.filter(
        (event): event is FabricActorHostEvent => isFabricActorHostEvent(event),
      )
    : undefined;
  const topics = stringArray(args.topics);
  const tools = stringArray(args.tools);
  const requires = Array.isArray(args.requires)
    ? args.requires.reduce<Array<string | FabricCapabilityRequirement>>(
        (result, requirement) => {
          if (typeof requirement === "string") result.push(requirement);
          else if (
            typeof requirement === "object" &&
            requirement !== null &&
            !Array.isArray(requirement) &&
            typeof (requirement as { ref?: unknown }).ref === "string"
          ) {
            result.push({
              ref: (requirement as { ref: string }).ref,
              ...((requirement as { optional?: unknown }).optional === true
                ? { optional: true }
                : {}),
            });
          }
          return result;
        },
        [],
      )
    : undefined;
  const timeoutMs = longerTimeoutOverride(args.timeoutMs, manager);
  const validWhile = typeof args.validWhile === "object" && args.validWhile !== null &&
    !Array.isArray(args.validWhile) &&
    (args.validWhile as { version?: unknown }).version === 1 &&
    typeof (args.validWhile as { source?: unknown }).source === "string"
    ? { version: 1 as const, source: (args.validWhile as { source: string }).source }
    : undefined;
  const runner = checkedRunner(args.runner, manager.config.runner);
  const runnerAdapter = requireAgentRunner(runner);
  if (!runnerAdapter.capabilities.persistentSessions) {
    throw new Error(
      runner === "veda"
        ? 'The Veda runner does not support persistent actors: Veda executes one headless prompt per invocation. Use a Pi or Claude actor, or agents.run({ runner: "veda" }).'
        : `The ${runnerAdapter.label} runner does not declare persistentSessions; use agents.run() or a runner that supports persistent actors.`,
    );
  }
  const requestedKernel = checkedKernel(args.kernel);
  const kernelRequest = {
    runner,
    ...(requestedKernel !== undefined ? { kernel: requestedKernel } : {}),
    extensions: typeof args.extensions === "boolean" ? args.extensions : true,
  };
  // Templates retain inheritance until import; live actors freeze at creation.
  const kernel = inheritModel ? manager.resolveKernel(kernelRequest) : requestedKernel;
  if (!inheritModel && kernel !== undefined && kernel !== "inherit") manager.resolveKernel(kernelRequest);
  const inheritedModel =
    inheritModel && (runner === "pi" || runner === "pi-durable") && !manager.config.model && context.extensionContext.model
      ? `${context.extensionContext.model.provider}/${context.extensionContext.model.id}`
      : undefined;
  return {
    ...(args.scope === "session" || args.scope === "project" ? { scope: args.scope } : {}),
    name: String(args.name),
    instructions: String(args.instructions),
    runner,
    ...(kernel !== undefined ? { kernel } : {}),
    ...(events ? { events } : {}),
    ...(topics ? { topics } : {}),
    ...(args.delivery === "mailbox" ||
    args.delivery === "steer" ||
    args.delivery === "followUp" ||
    args.delivery === "nextTurn"
      ? { delivery: args.delivery }
      : {}),
    ...(args.responseMode === "text" || args.responseMode === "directive"
      ? { responseMode: args.responseMode }
      : {}),
    ...(typeof args.triggerTurn === "boolean" ? { triggerTurn: args.triggerTurn } : {}),
    ...(typeof args.coalesce === "boolean" ? { coalesce: args.coalesce } : {}),
    ...(args.residency === "session" || args.residency === "durable"
      ? { residency: args.residency }
      : {}),
    ...(typeof args.model === "string"
      ? { model: args.model }
      : inheritedModel
        ? { model: inheritedModel }
        : {}),
    ...(isFabricThinking(args.thinking) ? { thinking: args.thinking } : {}),
    ...(tools ? { tools } : {}),
    ...(args.transport === "auto" ||
    args.transport === "process" ||
    args.transport === "tmux" ||
    args.transport === "screen" ||
    args.transport === "localterm" ||
    args.transport === "herdr" ||
    args.transport === "herdr-core"
      ? { transport: args.transport }
      : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(typeof args.extensions === "boolean" ? { extensions: args.extensions } : {}),
    ...(requires ? { requires } : {}),
    ...(validWhile ? { validWhile } : {}),
  };
};

// Argument repair derives from the action schemas plus the shared synonym
// lexicon; no agents-specific table remains.
export const normalizeAgentsArgs = actionArgNormalizer(() => AGENTS_ACTION_DESCRIPTORS);

/** True when a null argument is model or a spelling the normalizer repairs to model. */
const nullModelSpelling = (args: Record<string, unknown>): boolean =>
  Object.entries(args).some(
    ([key, value]) => value === null && "model" in normalizeAgentsArgs("models", { [key]: "" }),
  );

/**
 * Refuse an invalid agents.models model while preparing it. Normalization both
 * here and after preparation deletes a null optional field, which would turn
 * the lookup into the full list, so the schema check cannot be relied on.
 */
const refuseInvalidModelsModel = (
  args: Record<string, unknown>,
  prepared: Record<string, unknown>,
): void => {
  const invalid = prepared.model === undefined ? nullModelSpelling(args) : !isModelKey(prepared.model);
  if (invalid) throw new FabricTraceSafeError(`Invalid arguments for agents.models: ${MODEL_KEY_RULE}`);
};

export class AgentsProvider implements FabricProvider {
  observations: ObservationSource | undefined;
  readonly #transcripts = new AgentTranscriptReader();
  readonly #router: AgentMessageRouter;
  readonly name = "agents";
  /** Session registry of `provider:` participants; stop/steer/followUp route there. */
  providerParticipants: ProviderParticipantRegistry | undefined;
  /** This session's commands (pi.getCommands()); the `skills` option resolves against its skills. */
  sessionCommands: (() => readonly SlashCommandInfo[]) | undefined;
  readonly description =
    "The user-facing Main target, one-shot Pi or Claude Code agents, and persistent mailbox actors over process, tmux, screen, LocalTerm, or Herdr";

  constructor(
    readonly manager: AgentManager,
    readonly actorManager: ActorManager,
    readonly globalActors: GlobalActorRegistry,
    readonly mainAgent: FabricMainAgentTarget,
    readonly participants: FabricParticipantSource,
    readonly control: FabricControlPlane | undefined,
    readonly lifecycle: LifecycleBroker,
    readonly agentToolPreviewEnabled: () => boolean = () => true,
    readonly residency?: ResidencyClient,
    readonly ownsRuntime = true,
    readonly modelsConfig: () => FabricModelsConfig = () => DEFAULT_FABRIC_CONFIG.models,
  ) {
    this.#router = new AgentMessageRouter(
      manager, actorManager, mainAgent, participants, control,
      (binding, runner, context) => this.#resolvePiRunBinding(binding, runner, context),
    );
    this.#lifecycleScheduler = new LifecycleDeliveryScheduler(
      DEFAULT_LIFECYCLE_COALESCE_MS,
      (target, batch) => this.#routeLifecycleBatch(target, batch),
      (target, batch, error) => {
        console.warn(
          `[pi-fabric] lifecycle delivery to ${target} failed for ${batch.length} event(s): ` +
            (error instanceof Error ? error.message : String(error)),
        );
      },
    );
  }

  readonly #lifecycleScheduler: LifecycleDeliveryScheduler;

  #lifecycleMessage(event: FabricLifecycleEvent): string {
    const status = event.status ? ` with status ${event.status}` : "";
    const run = event.runId ? ` (run ${event.runId.slice(0, 8)})` : "";
    return `Fabric lifecycle ${event.event} from ${event.source.name} (${event.source.id})${run}${status}.`;
  }

  async #routeLifecycleBatch(
    target: string,
    batch: PendingLifecycleDelivery[],
  ): Promise<void> {
    const first = batch[0]!;
    const single = batch.length === 1;
    const message = single
      ? this.#lifecycleMessage(first.event)
      : `Fabric lifecycle events (${batch.length}):\n` +
        batch.map((delivery) => `- ${this.#lifecycleMessage(delivery.event)}`).join("\n");
    const data = single ? first.event : batch.map((delivery) => delivery.event);
    const last = batch[batch.length - 1]!;
    await this.routeMessage(
      target,
      message,
      data,
      first.subscription.delivery,
      undefined,
      {
        from: single
          ? lifecycleSourceIdentity(first.event.source)
          : lifecycleSourceIdentity(last.event.source),
        triggerTurn: batch.some((delivery) => delivery.subscription.triggerTurn),
      },
    );
  }

  /** Resolve a Pi participant selector only within this session's visible registry. */
  #resolvePiModel(
    model: string,
    context: FabricInvocationContext,
    modelMatch?: FabricModelMatch,
  ): string {
    let available: FabricModelCandidate[] = [];
    let registryError: unknown;
    try {
      available = context.extensionContext.modelRegistry.getAvailable().map((candidate) => ({
        provider: String(candidate.provider),
        id: String(candidate.id),
        ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
      }));
    } catch (error) {
      // The authoritative visible set is empty when registry discovery fails;
      // the resolution error names the registry failure.
      registryError = error;
    }
    const resolved = resolvePiModelSelector(model, {
      aliases: this.modelsConfig().aliases,
      available,
      lastUsed: loadModelUsage(),
      ...(registryError === undefined ? {} : { registryError }),
    }, modelMatch);
    return `${resolved.provider}/${resolved.id}`;
  }

  /** Roots for named agent files. Project files load only for a project the host trusts. */
  #agentFileRoots(context: FabricInvocationContext) {
    const trusted = context.extensionContext?.isProjectTrusted;
    return {
      agentDir: resolveAgentDir(),
      projectRoot: this.manager.projectRoot,
      projectTrusted: typeof trusted === "function" && trusted.call(context.extensionContext) === true,
    };
  }

  /**
   * Resolve args.agent into the request before anything else reads it, so model aliases,
   * runner checks and the durable-spawn refusal all see the file's values. The loader is
   * imported here, at first use; a call without agent never touches it.
   */
  async #applyAgentFile(
    args: Record<string, unknown>,
    context: FabricInvocationContext,
    residency?: unknown,
  ): Promise<Record<string, unknown>> {
    if (args.agent === undefined) return args;
    const { resolveAgentFile, applyAgentDefinition } = await import("../agents/agent-files.js");
    const definition = resolveAgentFile(String(args.agent), this.#agentFileRoots(context));
    if (residency === "durable" && definition.request.systemPrompt !== undefined && args.systemPrompt === undefined) {
      throw new Error(
        `Agent "${definition.name}" (${definition.path}) has instructions, which a durable agents.spawn does not accept. Spawn without residency: "durable" or remove the file body.`,
      );
    }
    if (definition.warnings.length > 0) {
      context.update(`Agent "${definition.name}" (${definition.path}): ${definition.warnings.join("; ")}`);
    }
    return applyAgentDefinition(args, definition);
  }

  #resolvePiModelArgs(
    args: Record<string, unknown>,
    context: FabricInvocationContext,
    runnerOverride?: FabricAgentRunner,
  ): Record<string, unknown> {
    const runner = runnerOverride ?? checkedRunner(args.runner, this.manager.config.runner);
    // Exact matching is checked before the non-Pi early return so it can never be skipped silently.
    assertExactModelRequest({ modelMatch: args.modelMatch, runner, model: args.model });
    if (runner !== "pi" && runner !== "pi-durable") return args;
    const model = typeof args.model === "string" ? args.model.trim() : "";
    if (args.modelMatch === "exact") {
      // No alias, closest or fuzzy step, and no alias thinking level.
      return { ...args, model: this.#resolvePiModel(model, context, "exact") };
    }
    if (!model) return args;
    const thinking = isFabricThinking(args.thinking)
      ? args.thinking
      : aliasThinking(this.modelsConfig().aliases, model);
    const resolved = this.#resolvePiModel(model, context);
    return {
      ...args,
      ...(thinking ? { thinking } : {}),
      ...(resolved === model ? {} : { model: resolved }),
    };
  }

  #resolvePiRunBinding(
    binding: FabricActorRunBinding,
    runner: FabricAgentRunner,
    context: FabricInvocationContext,
  ): FabricActorRunBinding {
    if ((runner !== "pi" && runner !== "pi-durable") || !binding.model) return binding;
    return { ...binding, model: this.#resolvePiModel(binding.model, context) };
  }

  async list(
    request: FabricProviderListRequest,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    const available = AGENTS_ACTION_DESCRIPTORS.filter(d => d.name !== "observe" || this.observations);
    return query
      ? available.filter((descriptor) =>
          `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query),
        )
      : available;
  }

  async describe(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    if (actionName === "observe" && !this.observations) return undefined;
    return AGENTS_ACTION_DESCRIPTORS.find((descriptor) => descriptor.name === actionName);
  }

  prepareArguments(
    actionName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const prepared = normalizeAgentsArgs(actionName, args);
    if (actionName === "models") refuseInvalidModelsModel(args, prepared);
    return prepared;
  }

  async handoff(
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<Record<string, unknown>> {
    const model = typeof args.model === "string" ? args.model.trim() : "";
    if (!model) throw new Error("agents.handoff requires an explicit Pi target model");
    checkedHandoffCompaction(args.compact);
    if (!context.deferHandoff) {
      throw new Error(
        "agents.handoff must be scheduled from inside fabric_exec and completed at its outer result boundary",
      );
    }
    const runner = this.manager.config.runner === "pi" ? "pi" : "pi-durable";
    const handoffArgs = this.#resolvePiModelArgs(
      { ...args, model, runner },
      context,
      runner,
    );
    delete handoffArgs.cwd;
    const request = runRequest({ ...handoffArgs, runner }, context, this.manager, this.modelsConfig());
    const kernel = this.manager.resolveKernel(request);
    delete handoffArgs.kernel;
    if (kernel) handoffArgs.kernel = kernel;
    handoffArgs.extensions = request.extensions ?? this.manager.config.extensions;
    if (kernel) handoffArgs.pythonRuntime = this.manager.resolvePythonRuntime();
    return context.deferHandoff(handoffArgs);
  }

  async executeHandoff(
    args: Record<string, unknown>,
    context: FabricInvocationContext,
    sessionSeed: AgentSessionSeed,
  ): Promise<Record<string, unknown>> {
    const model = typeof args.model === "string" ? args.model.trim() : "";
    if (!model) throw new Error("agents.handoff requires an explicit Pi target model");
    const runner = args.runner === "pi" || args.runner === "pi-durable"
      ? args.runner : this.manager.config.runner === "pi" ? "pi" : "pi-durable";
    const request = runRequest(
      this.#resolvePiModelArgs(
        {
          ...args,
          task: handoffTask(args),
          name:
            typeof args.name === "string" && args.name.trim()
              ? args.name
              : "Trajectory handoff",
          runner,
          model,
        },
        context,
      ),
      context,
      this.manager,
      this.modelsConfig(),
      { allowCwd: false },
    );
    request.runner = runner;
    if (args.pythonRuntime !== undefined) {
      // Only host-created deferred handoffs carry this internal policy snapshot.
      request.pythonRuntime = this.manager.resolvePythonRuntime(args.pythonRuntime as AgentRunRequest["pythonRuntime"]);
    }
    request.sessionSeed = sessionSeed;
    const targetModel = request.model ?? model;
    const handoffCompaction = checkedHandoffCompaction(args.compact);
    if (handoffCompaction) request.handoffCompact = handoffCompaction;
    request.thinkingTransfer = resolveThinkingTransfer(
      context.extensionContext,
      targetModel,
      sessionSeed.sourceModel,
    );
    const handle = await this.manager.spawn(request, context.signal);
    context.activity?.({
      type: "entity",
      id: handle.id,
      kind: "agent",
      name: handle.name,
    });
    context.update(
      `Trajectory handed off to ${handle.name} (${targetModel}); caller is waiting for implementation`,
    );
    const completed = await waitWithProgress(
      this.manager,
      this.#transcripts,
      handle.id,
      context,
      this.agentToolPreviewEnabled,
    );
    context.update(
      completed.status === "completed"
        ? `Handoff ${handle.name} completed implementation`
        : `Handoff ${handle.name} ended with ${completed.status}`,
    );
    return compactHandoffResult(completed);
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown> {
    switch (actionName) {
      case "observe":
        return observeExisting(this.observations?.(), "participant", args, context);
      case "run": {
        const runArgs = await this.#applyAgentFile(args, context);
        const handle = await this.manager.spawn(
          await this.#applyChildSkills(
            runArgs,
            this.#applySeed(
              runArgs,
              runRequest(this.#resolvePiModelArgs(runArgs, context), context, this.manager, this.modelsConfig()),
              context,
            ),
            context,
          ),
          context.signal,
        );
        this.participants.scheduleRefresh();
        context.activity?.({
          type: "entity",
          id: handle.id,
          kind: "agent",
          name: handle.name,
        });
        context.update(agentStartedMessage(handle));
        return waitWithProgress(
          this.manager,
          this.#transcripts,
          handle.id,
          context,
          this.agentToolPreviewEnabled,
        );
      }
      case "handoff":
        return this.handoff(args, context);
      case "spawn": {
        const spawnArgs = await this.#applyAgentFile(args, context, args.residency);
        const request = await this.#applyChildSkills(
          spawnArgs,
          this.#applySeed(
            spawnArgs,
            runRequest(this.#resolvePiModelArgs(spawnArgs, context), context, this.manager, this.modelsConfig()),
            context,
          ),
          context,
        );
        if (request.residency === "durable" && request.queue === true) {
          throw new Error('queue: true is not supported with residency: "durable"');
        }
        if (request.residency === "durable") this.#assertUnconfinedDurable();
        const kernel = this.manager.resolveKernel(request);
        const { kernel: _requestedKernel, ...requestWithScope } = request;
        // The resident host has no session scope: send the derived scope in full.
        const inheritedScope = request.residency === "durable" ? childScope(request.scope) : undefined;
        const { scope: _narrowing, ...unscopedRequest } = requestWithScope;
        const baseRequest = request.residency === "durable" ? unscopedRequest : requestWithScope;
        const durableRequest = withInheritedSessionPins({
          ...baseRequest,
          ...(inheritedScope ? { inheritedScope } : {}),
          ...(kernel ? { kernel, pythonRuntime: this.manager.resolvePythonRuntime() } : {}),
          extensions: request.extensions ?? this.manager.config.extensions,
          ...(request.residency === "durable" && request.cwd !== undefined
            ? { cwd: this.manager.resolveCwd(request.cwd) }
            : {}),
          // The resident host does not know this session's bounds: send them narrowed.
          ...(request.residency === "durable"
            ? { thinkingBounds: this.manager.childThinkingBounds(request.thinkingBounds) }
            : {}),
        }, context.extensionContext.sessionManager?.getEntries?.() ?? []);
        // The resident host loads no extensions: ask this session's and send the answer.
        const traceContext = durableRequest.residency === "durable"
          ? this.manager.forwardedTraceContext(durableRequest)
          : undefined;
        const handle = durableRequest.residency === "durable"
          ? await this.#resident().spawnAgent({ ...durableRequest, ...(traceContext ? { traceContext } : {}) }, context.signal)
          : await this.manager.spawn(durableRequest, context.signal);
        if (request.residency !== "durable") this.manager.detachSignal(handle.id);
        this.participants.scheduleRefresh();
        context.activity?.({
          type: "entity",
          id: handle.id,
          kind: "agent",
          name: handle.name,
        });
        context.update(agentStartedMessage(handle));
        return handle;
      }
      case "join":
      case "wait": {
        const id = String(args.id);
        if (this.residency?.hasAgent(id)) {
          const status = this.residency.statusAgent(id);
          context.activity?.({ type: "entity", id, kind: "agent", name: status.name });
          context.update(`Waiting for durable agent ${status.name}`);
          return this.residency.waitAgent(id, context.signal);
        }
        let status: ReturnType<AgentManager["status"]>;
        try {
          status = this.manager.status(id);
        } catch (error) {
          // A durable run another root session of this project spawned.
          if (!(error instanceof Error && /Unknown Fabric agent/.test(error.message))) throw error;
          if (!this.residency?.hasProjectAgent(id)) throw error;
          const durable = this.residency.statusAgent(id);
          context.activity?.({ type: "entity", id, kind: "agent", name: durable.name });
          context.update(`Waiting for durable agent ${durable.name}`);
          return this.residency.waitProjectAgent(id, context.signal);
        }
        context.activity?.({ type: "entity", id, kind: "agent", name: status.name });
        return waitWithProgress(
          this.manager,
          this.#transcripts,
          id,
          context,
          this.agentToolPreviewEnabled,
        );
      }
      case "status": {
        const id = String(args.id);
        if (this.mainAgent.matches(id)) {
          if (this.mainAgent.local) return this.mainAgent.info(context.extensionContext);
          const root = this.participants.get(this.mainAgent.id);
          if (!root) throw new Error(`Unknown Fabric Main participant: ${this.mainAgent.id}`);
          return root;
        }
        try {
          const result = this.manager.status(id);
          // Model-facing terminal status returns the result; UI polling must not acknowledge it.
          if (terminalAgentStatuses.has(result.status)) this.manager.markForeground(id);
          return result;
        } catch (error) {
          if (!(error instanceof Error && /Unknown Fabric agent/.test(error.message))) throw error;
        }
        if (this.residency?.hasAgent(id)) {
          const result = this.residency.statusAgent(id);
          if (terminalAgentStatuses.has(result.status)) this.residency.acknowledgeCompletion(id);
          return result;
        }
        // Another root session's run: read it, but leave its completion receipt to that session.
        if (this.residency?.hasProjectAgent(id)) return this.residency.statusAgent(id);
        const known = this.participants.get(id);
        if (known && !known.local) return known;
        try {
          return this.actorManager.status(id);
        } catch (error) {
          if (!(error instanceof Error && /Unknown Fabric actor/.test(error.message))) throw error;
        }
        const participant = this.participants.get(id);
        if (!participant) throw new Error(`Unknown Fabric participant: ${id}`);
        return participant;
      }
      case "list":
        return this.#listAgents(args.scope);
      case "members": {
        const kinds = Array.isArray(args.kinds)
          ? args.kinds.filter(
              (kind): kind is "root" | "agent" | "actor" =>
                kind === "root" || kind === "agent" || kind === "actor",
            )
          : undefined;
        return this.participants.list({
          scope: this.#participantScope(args.scope, "project"),
          ...(kinds ? { kinds } : {}),
          ...(args.includeStale === true ? { includeStale: true } : {}),
        });
      }
      case "self": {
        const self = await this.participants.self();
        const lineage = readAgentLineage();
        return lineage ? { ...self, lineage } : self;
      }
      case "main":
        return this.mainAgent.info(context.extensionContext);
      case "sessions":
        return this.participants.sessions?.() ??
          this.participants.list({ scope: "project", kinds: ["root"] });
      case "peers":
        return this.participants.peers();
      case "departed":
        return this.participants.departed?.(
          typeof args.limit === "number" ? { limit: args.limit } : {},
        ) ?? [];
      case "definitions": {
        const { listAgentFiles } = await import("../agents/agent-files.js");
        return listAgentFiles(this.#agentFileRoots(context), (notice) => context.update(notice));
      }
      case "subscribe": {
        const events = Array.isArray(args.events)
          ? args.events.filter(isFabricLifecycleEventType)
          : [];
        if (typeof args.triggerTurn !== "boolean") {
          throw new Error("Lifecycle subscriptions require explicit triggerTurn: true or false");
        }
        const delivery = args.delivery === "steer" || args.delivery === "followUp"
          ? args.delivery
          : undefined;
        if (!delivery) throw new Error("Invalid lifecycle subscription delivery");
        const subscription = await this.lifecycle.subscribe({
          from: this.#participantAlias(String(args.from)),
          events,
          to: this.#participantAlias(typeof args.to === "string" ? args.to : "main"),
          delivery,
          triggerTurn: args.triggerTurn,
          ...(args.once === true ? { once: true } : {}),
        });
        context.update(
          `Subscribed ${subscription.to.slice(0, 8)} to ${subscription.events.join(", ")} from ${subscription.from.slice(0, 8)}`,
        );
        return subscription;
      }
      case "subscriptions":
        return this.lifecycle.list({
          ...(typeof args.from === "string"
            ? { from: this.#participantAlias(args.from) }
            : {}),
          ...(typeof args.to === "string"
            ? { to: this.#participantAlias(args.to) }
            : {}),
        });
      case "unsubscribe":
        return this.lifecycle.unsubscribe(String(args.id));
      case "models": {
        const runner = checkedRunner(args.runner, this.manager.config.runner);
        const exactKey = checkedModelKey(args.model);
        const runnerAdapter = requireAgentRunner(runner);
        const matching = <T extends { key: string }>(models: readonly T[]): T[] =>
          exactKey === undefined ? [...models] : models.filter((model) => model.key === exactKey);
        if (!BUILT_IN_RUNNER_IDS.has(runner)) {
          // A registered runner discovers its own models; none means an advisory empty list.
          return runnerAdapter.models
            ? matching(await runnerAdapter.models({ cwd: this.manager.cwd, refresh: args.refresh === true }))
            : [];
        }
        if (runner === "veda") {
          // Veda forwards any -m value to the configured backend; model
          // discovery would require parsing `veda models <backend>`. Return an
          // empty advisory list so callers can still pass model strings
          // directly to agents.run({ runner: "veda", model }).
          return [];
        }
        if (runner === "claude") {
          const models = await this.manager.claudeModels(args.refresh === true);
          return matching(models.map((model) => ({
            runner: "claude",
            provider: "claude",
            id: model.value,
            name: model.displayName,
            key: `claude/${model.value}`,
            ...model,
          })));
        }
        // A registry failure rejects: an empty list would read as "no models".
        const available = context.extensionContext.modelRegistry.getAvailable();
        return matching(available.map((model) => ({
          runner,
          provider: String(model.provider),
          id: String(model.id),
          name: String(model.name ?? model.id),
          key: `${model.provider}/${model.id}`,
        })));

      }
      case "switchModel": {
        const query = typeof args.model === "string" ? args.model.trim() : "";
        if (!query) {
          throw new Error(
            "agents.switchModel requires a model selector: provider/id, models.aliases name, or search term",
          );
        }
        const registry = context.extensionContext.modelRegistry;
        let available: FabricModelCandidate[] = [];
        try {
          available = registry.getAvailable().map((model) => ({
            provider: String(model.provider),
            id: String(model.id),
            ...(typeof model.name === "string" ? { name: model.name } : {}),
          }));
        } catch (error) {
          throw new Error(
            `agents.switchModel could not read the model registry: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        if (available.length === 0) {
          throw new Error(
            "agents.switchModel found no authenticated models; configure a provider key or check agents.models()",
          );
        }
        const currentModel = context.extensionContext.model ?? undefined;
        const resolution = resolveFabricModel(query, {
          aliases: this.modelsConfig().aliases,
          available,
          lastUsed: loadModelUsage(),
          ...(currentModel
            ? { current: { provider: currentModel.provider, id: currentModel.id } }
            : {}),
          ...(typeof args.provider === "string" && args.provider.trim()
            ? { provider: args.provider.trim() }
            : {}),
        });
        if (resolution.kind === "already-active") {
          return {
            switched: false,
            reason: "already-active",
            model: `${resolution.model.provider}/${resolution.model.id}`,
            ...(resolution.model.name ? { name: resolution.model.name } : {}),
          };
        }
        if (resolution.kind === "ambiguous") {
          throw new Error(
            `agents.switchModel: "${query}" matches multiple models: ${resolution.candidates
              .map((candidate) => `${candidate.provider}/${candidate.id}`)
              .join(", ")}. Pass an exact provider/id.`,
          );
        }
        if (resolution.kind === "not-found") {
          throw new Error(
            resolution.tried !== undefined
              ? `agents.switchModel: alias "${query}" has no available target. Tried: ${resolution.tried.join(", ")}`
              : `agents.switchModel: no available model matching "${query}"`,
          );
        }
        if (typeof this.mainAgent.switchModel !== "function") {
          throw new Error("agents.switchModel requires a local Main session");
        }
        const previous = currentModel
          ? `${currentModel.provider}/${currentModel.id}`
          : undefined;
        const outcome = await this.mainAgent.switchModel(
          { provider: resolution.model.provider, id: resolution.model.id },
          context.extensionContext,
        );
        if (!outcome.ok) {
          throw new Error(`agents.switchModel: ${outcome.error ?? "switch failed"}`);
        }
        try {
          this.residency?.syncPiModels();
        } catch {
          // The next durable command retries synchronization before execution.
        }
        context.activity?.({
          type: "progress",
          message: `Main model ${previous ? `${previous} → ` : ""}${resolution.model.provider}/${resolution.model.id}`,
        });
        return {
          switched: true,
          model: `${resolution.model.provider}/${resolution.model.id}`,
          ...(resolution.model.name ? { name: resolution.model.name } : {}),
          ...(previous ? { previous } : {}),
          ...(resolution.via !== undefined ? { via: resolution.via } : {}),
          ...(resolution.via !== undefined &&
          !(FUZZY_RESOLUTION_MARKERS as readonly string[]).includes(resolution.via)
            ? { alias: resolution.via }
            : {}),
        };
      }
      case "stop":
        return this.stopParticipant(String(args.id));
      case "sleep":
      case "wake": {
        const id = String(args.id);
        await (actionName === "sleep" ? this.manager.sleep(id) : this.manager.wake(id));
        return { id, requested: actionName };
      }
      case "cleanup": {
        const id = String(args.id);
        return this.residency?.hasAgent(id)
          ? this.residency.cleanupAgent(id, args.deleteBranch === true)
          : this.manager.cleanup(id, args.deleteBranch === true);
      }
      case "create": {
        const createArgs = this.#resolvePiModelArgs(args, context);
        if (createArgs.scope === "global") {
          return this.globalActors.create(actorRequest(createArgs, context, this.manager, false));
        }
        const request = actorRequest(createArgs, context, this.manager);
        const actor = await this.#createActor(request);
        this.participants.scheduleRefresh();
        context.activity?.({ type: "entity", id: actor.id, kind: "actor", name: actor.name });
        return actor;
      }
      case "ask": {
        const id = String(args.id);
        const message = String(args.message);
        this.actorManager.validateDirectMessage(message, args.data);
        const { actor, participant } = this.#resolveActorTarget(id);
        const ownsActor = actor ? this.actorManager.owns(actor.id) : false;
        const requestedOverrides = actorRunBinding(args);
        const overrides = ownsActor
          ? this.#resolvePiRunBinding(requestedOverrides, actor!.runner, context)
          : requestedOverrides;
        context.activity?.({
          type: "entity",
          id: actor?.id ?? participant!.id,
          kind: "actor",
          name: actor?.name ?? participant!.name,
        });
        if (actor && ownsActor) {
          return waitWithActorProgress(
            this.manager,
            this.#transcripts,
            actor.id,
            actor.name,
            this.actorManager.ask(actor.id, message, args.data, context.signal, { overrides }),
            context,
            this.agentToolPreviewEnabled,
          );
        }
        if (!participant) throw new Error(`Fabric actor ${actor!.id} has no live execution owner`);
        if (!participant.capabilities.includes("ask")) {
          throw new Error(`Fabric actor owner ${participant.ownerHostId} does not support remote ask`);
        }
        const binding = actor ? this.actorManager.resolveBinding(actor.id, overrides) : overrides;
        const needsBinding = Boolean(binding.model || binding.thinking);
        if (needsBinding && !participant.capabilities.includes("actor-bindings")) {
          throw new Error(`Fabric actor owner ${participant.ownerHostId} does not support session bindings`);
        }
        if (!this.control || participant.controlProtocol === "legacy") {
          throw new Error(`Fabric actor owner ${participant.ownerHostId} has no result control channel`);
        }
        return this.control.requestResult<FabricActorMessage>(
          participant.ownerHostId,
          participant.id,
          "ask",
          {
            message,
            ...(args.data === undefined ? {} : { data: args.data }),
            ...(needsBinding ? { binding } : {}),
            ...(participant.ownerIncarnation
              ? { ownerIncarnation: participant.ownerIncarnation }
              : {}),
          },
          participant.ownerIdentityId,
          {
            timeoutMs: (actor?.timeoutMs ?? this.manager.config.timeoutMs) +
              REMOTE_ASK_ACK_GRACE_MS,
            ...(context.signal ? { signal: context.signal } : {}),
          },
        );
      }
      case "tell":
        return this.routeMessage(
          String(args.id),
          String(args.message),
          args.data,
          "followUp",
          context,
          { binding: actorRunBinding(args) },
        );
      case "steer":
        return this.routeMessage(
          String(args.id),
          String(args.message),
          args.data,
          "steer",
          context,
        );
      case "followUp":
        return this.routeMessage(
          String(args.id),
          String(args.message),
          args.data,
          "followUp",
          context,
        );
      case "setSteeringMode":
        return this.manager.setSteeringMode(String(args.id), this.#steeringMode(args.mode));
      case "setFollowUpMode":
        return this.manager.setFollowUpMode(String(args.id), this.#steeringMode(args.mode));
      case "compact": {
        const id = String(args.id);
        const status = this.manager.status(id);
        context.activity?.({ type: "entity", id, kind: "agent", name: status.name });
        const instructions = typeof args.instructions === "string" ? args.instructions : undefined;
        const result = this.manager.compact(id, instructions);
        context.activity?.({
          type: "progress",
          message: `Compaction enqueued for agent ${id.slice(0, 8)} (advisory; commits at the child's next turn boundary)`,
        });
        return result;
      }
      case "actorStatus":
        return this.actorManager.status(String(args.id));
      case "actors":
        return args.scope === "global" ? this.globalActors.list() : this.actorManager.list();
      case "messages": {
        const actor = this.actorManager.status(String(args.id));
        return this.actorManager.messages(
          actor.id,
          typeof args.limit === "number" ? args.limit : 50,
        );
      }
      case "setModel": {
        const id = String(args.id);
        const model = typeof args.model === "string" ? args.model.trim() : "";
        const target = this.#resolveActorTarget(id);
        const ownsActor = target.actor ? this.actorManager.owns(target.actor.id) : false;
        const runner = target.actor?.runner ?? target.participant!.runner;
        const resolvedModel = model && ownsActor
          ? this.#resolvePiModelArgs({ model }, context, runner).model as string
          : model || undefined;
        return this.actorManager.setModel(
          id,
          resolvedModel,
          args.scope === "project" ? "project" : "session",
        );
      }
      case "setThinking":
        return this.actorManager.setThinking(
          String(args.id),
          typeof args.thinking === "string" ? args.thinking : undefined,
          args.scope === "project" ? "project" : "session",
        );
      case "setTools": {
        const tools = stringArray(args.tools) ?? [];
        if (args.scope === "global") {
          return this.globalActors.update(String(args.id), { tools });
        }
        return this.actorManager.setTools(String(args.id), tools);
      }
      case "setEvents": {
        const events = Array.isArray(args.events)
          ? args.events.filter(
              (event): event is FabricActorHostEvent => isFabricActorHostEvent(event),
            )
          : [];
        return this.actorManager.setEvents(String(args.id), events);
      }
      case "setDeliveryPolicy": {
        const delivery = args.delivery as FabricActorDelivery;
        if (typeof args.triggerTurn !== "boolean") {
          throw new Error("setDeliveryPolicy requires explicit triggerTurn: true or false");
        }
        const triggerTurn = args.triggerTurn;
        if (args.scope === "global") {
          return this.globalActors.update(String(args.id), { delivery, triggerTurn });
        }
        return this.actorManager.setDeliveryPolicy(String(args.id), delivery, triggerTurn);
      }
      case "clearMessages":
        return this.actorManager.clearMessages(String(args.id));
      case "remove": {
        if (args.scope === "global") return this.globalActors.remove(String(args.id));
        const { actor, participant } = this.#resolveActorTarget(String(args.id));
        if (actor && this.actorManager.owns(actor.id)) return this.actorManager.remove(actor.id);
        const residency = actor?.residency ?? participant?.residency;
        if (residency !== "durable") throw new Error("Only the owning host can remove this actor");
        const id = actor?.id ?? participant!.id;
        return this.residency
          ? this.residency.removeActor(id)
          : this.#residentActorClient().removeActor(id);
      }
      case "setInstructions": {
        const id = String(args.id);
        const instructions = String(args.instructions);
        if (args.scope === "global") {
          return this.globalActors.update(id, { instructions });
        }
        return this.actorManager.setInstructions(id, instructions);
      }
      case "import": {
        const key =
          typeof args.id === "string" && args.id.trim()
            ? args.id.trim()
            : typeof args.name === "string" && args.name.trim()
              ? args.name.trim()
              : "";
        if (!key) throw new Error("Import requires a template id or name");
        const def = this.globalActors.resolve(key);
        if (!def) throw new Error(`Unknown global actor: ${key}`);
        const as =
          typeof args.as === "string" && args.as.trim() ? args.as.trim() : undefined;
        const request = this.globalActors.toRequest(def, as);
        const resolvedRequest = request.model
          ? {
              ...request,
              model: this.#resolvePiModelArgs(
                { model: request.model },
                context,
                request.runner ?? this.manager.config.runner,
              ).model as string,
            }
          : request;
        const actor = await this.#createActor(resolvedRequest);
        this.participants.scheduleRefresh();
        context.activity?.({ type: "entity", id: actor.id, kind: "actor", name: actor.name });
        return actor;
      }
      case "export": {
        const actor = this.actorManager.status(String(args.id));
        const overwrite = args.overwrite === true;
        const def = this.actorManager.definition(actor.id);
        return this.globalActors.create(def, overwrite);
      }
      case "log": {
        const id = String(args.id);
        const type = args.type === "run" || args.type === "all" ? args.type : "session";
        const lines = typeof args.lines === "number" ? args.lines : 200;
        const runId = typeof args.runId === "string" ? args.runId : undefined;
        const before = typeof args.before === "number" ? args.before : undefined;
        try {
          const actor = this.actorManager.status(id);
          return this.actorManager.readLog(actor.id, {
            type,
            lines,
            ...(runId ? { runId } : {}),
            ...(before !== undefined ? { before } : {}),
          });
        } catch (error) {
          if (!(error instanceof Error && /Unknown Fabric actor/.test(error.message))) throw error;
          /* not an actor — fall through to agent */
        }
        if (this.residency?.hasAgent(id)) {
          return this.residency.readAgentLog(id, {
            lines,
            ...(before !== undefined ? { before } : {}),
          });
        }
        try {
          return this.manager.readLog(id, { lines, ...(before !== undefined ? { before } : {}) });
        } catch (error) {
          // A durable run another root session of this project spawned.
          if (!(error instanceof Error && /Unknown Fabric agent/.test(error.message))) throw error;
          if (!this.residency?.hasProjectAgent(id)) throw error;
          return this.residency.readAgentLog(id, { lines, ...(before !== undefined ? { before } : {}) });
        }
      }
      default:
        throw new Error(`Unknown agents action: ${actionName}`);
    }
  }

  async routeMessage(
    id: string,
    message: string,
    data: unknown,
    kind: "steer" | "followUp",
    context?: FabricInvocationContext,
    options: {
      from?: MeshIdentity;
      triggerTurn?: boolean;
      binding?: FabricActorRunBinding;
    } = {},
  ): Promise<FabricAgentMessageResult> {
    if (isProviderParticipantRef(id)) {
      return controlProviderParticipant(
        this.providerParticipants, this.participants, this.control, id, kind, message, data,
      ) as Promise<FabricAgentMessageResult>;
    }
    return this.#router.routeMessage(id, message, data, kind, context, options);
  }

  /** Flush pending coalesced lifecycle deliveries; used by tests and shutdown. */
  flushLifecycleDeliveries(): Promise<void> {
    return this.#lifecycleScheduler.flushAll();
  }

  async deliverLifecycle(
    subscription: FabricLifecycleSubscription,
    event: FabricLifecycleEvent,
  ): Promise<void> {
    // Buffered per target: bursts of run completions coalesce into a single
    // orchestrator wake turn instead of one full run per event (#85). steer
    // deliveries bypass the buffer inside the scheduler.
    this.#lifecycleScheduler.schedule(subscription.to, { subscription, event });
  }

  async acceptControl(
    command: FabricControlCommand,
    from: MeshIdentity,
    signal?: AbortSignal,
  ): Promise<FabricControlAcceptance> {
    if (isProviderParticipantRef(command.targetId)) {
      return acceptProviderParticipantControl(this.providerParticipants, command);
    }
    return this.#router.acceptControl(command, from, signal);
  }

  #resolveActorTarget(id: string): {
    actor?: FabricActorInfo;
    participant?: FabricParticipantInfo;
  } {
    return this.#router.resolveActorTarget(id);
  }

  async #createActor(request: FabricActorRequest): Promise<FabricActorInfo> {
    // Also freeze imported templates before any resident host sees the request.
    const extensions = request.extensions ?? true;
    const kernel = this.manager.resolveKernel({ ...request, extensions });
    const { kernel: _requestedKernel, principalScope: _forged, ...baseRequest } = request;
    // Bind the actor to the creating principal; the resident host has no scope of its own.
    const principalScope = sessionScope();
    request = {
      ...baseRequest,
      runner: request.runner ?? this.manager.config.runner,
      extensions,
      ...(kernel ? { kernel, pythonRuntime: this.manager.resolvePythonRuntime(request.pythonRuntime) } : {}),
      ...(principalScope ? { principalScope } : {}),
    };
    if (request.residency !== "durable") return this.actorManager.create(request);
    this.#assertUnconfinedDurable();
    if (!this.residency) return this.#residentActorClient().createActor(request);

    await this.residency.ensureHost();
    let actor: FabricActorInfo;
    try {
      actor = await this.actorManager.create(request);
    } catch (error) {
      if (!(error instanceof ActorRegistryOwnershipError)) throw error;
      return this.residency.createActor(request);
    }
    await this.#activateDurableActor(actor);
    return actor;
  }

  // The shared resident host cannot inherit this process's write confinement;
  // scope travels with the request (inheritedScope, principalScope) instead.
  #assertUnconfinedDurable(): void {
    if (process.env.PI_FABRIC_WRITE_POLICY) {
      throw new Error("A write-confined agent cannot start durable agents or actors");
    }
  }

  /** seed: "branch" forks the caller's completed turns; "snippet" prefixes recent text. */
  /**
   * Resolve the `skills` option (from the call or an agent file) against this
   * session's skills before anything starts. An unknown name fails here. The
   * resolver is imported at first use; a call without skills never loads it.
   */
  async #applyChildSkills(
    args: Record<string, unknown>,
    request: AgentRunRequest,
    context: FabricInvocationContext,
  ): Promise<AgentRunRequest> {
    if (args.skills === undefined) return request;
    const { childSkillsSelection, resolveChildSkills, sessionSkills } = await import("../agents/child-skills.js");
    const selection = childSkillsSelection(args.skills);
    if (!selection) return request;
    if (request.residency === "durable") {
      throw new Error(
        'A durable agents.spawn does not accept skills (an agent file\'s skills and context.skills count too). Spawn without residency: "durable" or leave skills out.',
      );
    }
    const childSkills = resolveChildSkills(selection, sessionSkills(this.sessionCommands?.() ?? []), (message) => context.update(message));
    return { ...request, childSkills };
  }

  #applySeed(
    args: Record<string, unknown>,
    request: AgentRunRequest,
    context: FabricInvocationContext,
  ): AgentRunRequest {
    const { seed, seedMessages } = checkedSeed(args.seed, args.seedMessages);
    if (seed === "task") return request;
    const runner = request.runner ?? this.manager.config.runner;
    if (runner !== "pi" && runner !== "pi-durable") {
      throw new Error(`seed: "${seed}" requires the Pi runner`);
    }
    const session = context.extensionContext.sessionManager;
    const branch = session?.getBranch?.();
    if (!session || !branch) throw new Error(`seed: "${seed}" requires a Pi session`);
    if (seed === "snippet") return { ...request, task: snippetTask(branch, seedMessages, request.task) };
    if (request.residency === "durable") {
      throw new Error('seed: "branch" is unavailable for durable agents; use seed: "snippet"');
    }
    const model = context.extensionContext.model;
    const sourceSessionFile = session.getSessionFile?.();
    const thinkingTransfer = request.model
      ? resolveThinkingTransfer(
          context.extensionContext,
          request.model,
          model ? { provider: model.provider, modelId: model.id } : undefined,
        )
      : undefined;
    return {
      ...request,
      forkSeed: {
        sourceSessionId: session.getSessionId(),
        ...(sourceSessionFile ? { sourceSessionFile } : {}),
        sourceBranch: completedBranchPrefix(branch),
      },
      ...(thinkingTransfer ? { thinkingTransfer } : {}),
    };
  }

  #residentActorClient(): ResidentActorClient {
    const client = ResidentActorClient.fromEnv();
    if (client) return client;
    throw new Error(
      "Durable residency requires a trusted project with Fabric mesh persistence enabled",
    );
  }

  #resident(): ResidencyClient {
    if (!this.residency) {
      throw new Error(
        "Durable residency requires a trusted project with Fabric mesh persistence enabled",
      );
    }
    return this.residency;
  }

  async #activateDurableActor(actor: FabricActorInfo): Promise<void> {
    const residency = this.#resident();
    await this.actorManager.cede(actor.id);
    await this.participants.refresh();
    try {
      await residency.ensureActor(actor.id);
    } catch (error) {
      try {
        await residency.removeActor(actor.id);
      } catch {
        this.actorManager.reclaim(actor.id);
      }
      await this.participants.refresh().catch(() => undefined);
      throw error;
    }
  }

  #listAgents(scopeValue: unknown): Array<AgentRunRecord | AgentHandleInfo | ReturnType<FabricParticipantSource["self"]>> {
    const scope = this.#participantScope(scopeValue, "local");
    if (scope === "local") return this.manager.list();
    const local = new Map<string, AgentRunRecord | AgentHandleInfo>();
    const append = (record: AgentRunRecord | AgentHandleInfo): void => {
      local.set(record.id, record);
      if ("nestedAgents" in record) {
        for (const nested of record.nestedAgents ?? []) append(nested);
      }
    };
    for (const record of this.manager.list()) append(record);
    for (const record of this.residency?.listAgents() ?? []) append(record);
    const listed = this.participants
      .list({ scope, kinds: ["agent"] })
      .map((participant) => local.get(participant.id) ?? participant);
    const seen = new Set(listed.map((record) => record.id));
    for (const record of this.residency?.listAgents() ?? []) {
      if (!seen.has(record.id)) listed.push(record);
    }
    return listed;
  }

  #participantAlias(value: string): string {
    const id = value.trim();
    return id === "main" ? this.mainAgent.id : id;
  }

  #participantScope(
    value: unknown,
    fallback: FabricParticipantScope,
  ): FabricParticipantScope {
    return value === "local" || value === "lineage" || value === "project" ? value : fallback;
  }

  async stopParticipant(id: string): Promise<unknown> {
    if (isProviderParticipantRef(id)) {
      return controlProviderParticipant(this.providerParticipants, this.participants, this.control, id, "stop");
    }
    try {
      const result = await this.manager.stop(id);
      this.participants.scheduleRefresh();
      return result;
    } catch (error) {
      if (!(error instanceof Error && /Unknown Fabric agent/.test(error.message))) throw error;
    }
    try {
      const actor = this.actorManager.status(id);
      const ownership = this.participants.get(actor.id);
      if (!ownership || ownership.local) {
        const result = await this.actorManager.stop(actor.id);
        this.participants.scheduleRefresh();
        return result;
      }
    } catch (error) {
      if (!(error instanceof Error && /Unknown Fabric actor/.test(error.message))) throw error;
    }
    const participant = this.participants.get(id);
    if (!participant) throw new Error(`Unknown Fabric participant: ${id}`);
    if (!participant.capabilities.includes("stop")) {
      throw new Error(`Fabric participant ${id} cannot be stopped`);
    }
    if (!this.control) throw new Error("Fabric control plane is unavailable");
    const result = await this.control.request(
      participant.ownerHostId,
      participant.id,
      "stop",
      participant.ownerIncarnation ? { ownerIncarnation: participant.ownerIncarnation } : {},
      participant.ownerIdentityId,
    );
    if (this.residency?.hasAgent(id)) this.residency.acknowledgeCompletion(id);
    return result;
  }

  #steeringMode(mode: unknown): "all" | "one-at-a-time" {
    if (mode === "all" || mode === "one-at-a-time") return mode;
    throw new Error(
      `Invalid steering mode: ${String(mode)} (expected "all" or "one-at-a-time")`,
    );
  }

  async close(): Promise<void> {
    this.#transcripts.clear();
    if (!this.ownsRuntime) return;
    await this.lifecycle.close();
    try {
      await this.actorManager.close();
    } finally {
      await this.manager.close();
    }
  }
}
