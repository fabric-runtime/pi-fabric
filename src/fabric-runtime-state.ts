import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveAgentDir } from "./core/agent-dir.js";
import { loadHostSdk } from "./core/host-sdk.js";
import { requestChildTraceContext } from "./agents/trace-context-request.js";
import {
  resolveAvailablePiModel,
  type FabricModelCandidate,
} from "./core/model-resolution.js";
import { loadModelUsage } from "./core/model-usage.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FabricActivityStore } from "./activity/store.js";
import { ActorDirectory } from "./actors/directory.js";
import { resolvePiBinary } from "./agents/pi-binary.js";
import { isPiShellRef } from "./core/pi-tools.js";
import { DEFAULT_SHELL_HANG_MS, FabricShellJobStore } from "./core/shell-jobs.js";
import { GlobalActorRegistry } from "./actors/global-registry.js";
import { buildActorContext } from "./actors/context.js";
import { actorDeliveryNotice } from "./actors/delivery-policy.js";
import { prepareFabricActorHostPayload } from "./actors/host-event-payload.js";
import type { JevObservationHost } from "./jev/observation.js";
import { resolveJevModelRoute } from "./jev/routes.js";
import type { FabricActorHostEvent } from "./actors/types.js";
import { CapturedToolCatalog, type CapturedToolEntry } from "./capture/catalog.js";
import { FabricComponentCatalog } from "./components/catalog.js";
import { FabricComponentLoader } from "./components/loader.js";
import { FabricComponentControl } from "./components/control.js";
import { FabricComponentConfiguration, watchComponentConfiguration } from "./components/configuration.js";
import {
  resolveFabricModelGuidance,
  type FabricOwnedModelGuidance,
} from "./components/model-guidance.js";
import { builtinModelGuidance } from "./components/builtin-guidance.js";
import { FabricComponentSupervisor } from "./components/supervisor.js";
import {
  createProviderComponent,
  FABRIC_COMPONENT_PROVIDER_NAMES,
  FABRIC_PROVIDER_COMPONENT_PREFIX,
  FabricProviderComponentManifest,
} from "./components/provider-component.js";
import type {
  FabricComponentDefinition,
  FabricComponentGraph,
  FabricComponentInfo,
} from "./components/types.js";
import {
  DEFAULT_FABRIC_CONFIG,
  loadFabricConfig,
  type FabricConfig,
  type FabricResultFormat,
  type FabricSchemaMode,
} from "./config.js";
import {
  ActionRegistry,
  type FabricCapabilityViewLease,
} from "./core/action-registry.js";
import { FabricSessionApprovals } from "./core/approval-controller.js";
import { CompactController, type CompactLastCommit, type CompactPendingIntent } from "./core/compact-controller.js";
import { FabricToolResultProxy } from "./core/tool-result-proxy.js";
import { FabricExecutionService, type FabricExecutionResult } from "./execution-service.js";
import { RepairCompiler } from "./repairs/compiler.js";
import {
  clearActiveRepairCompiler,
  setActiveRepairCompiler,
} from "./repairs/active.js";
import { loadCompiledSurface } from "./entropy/compiled-store.js";
import {
  clearActiveCompiledSurface,
  setActiveCompiledSurface,
} from "./entropy/active.js";
import { RuntimeStateSpeculation } from "./runtime-state-speculation.js";
import { schemaRefAllowedInEnforce } from "./schema/policy.js";
import { actionApprovalOverride } from "./core/approval-overrides.js";
import type { FabricSpeculationStreamTap } from "./speculation/stream-tap.js";
import { MeshStore, type MeshIdentity } from "./mesh/store.js";
import { DecisionStore } from "./decisions/store.js";
import { requestHeadlessApproval, routeChildQuestion } from "./decisions/host.js";
import { LifecycleBroker } from "./lifecycle/broker.js";
import type { FabricLifecycleEventType } from "./lifecycle/types.js";
import { FabricControlPlane } from "./topology/control-plane.js";
import { ParticipantDirectory } from "./topology/participant-directory.js";
import type {
  FabricParticipantInfo,
  FabricParticipantListOptions,
  FabricPeerInfo,
} from "./topology/types.js";
import { actorParticipantRecord, agentParticipantRecords } from "./topology/records.js";
import { ProviderParticipantRegistry } from "./topology/provider-participants.js";
import {
  PrewalkController,
  type FabricPrewalkPlanCheckpoint,
} from "./prewalk/controller.js";
import { PrewalkDriftTracker } from "./prewalk/fs-drift.js";
import {
  deliverPrewalkPlanCheckpoint,
} from "./prewalk/messages.js";
import {
  claimFabricFsDriftHandoff,
  claimFabricHandoff,
  runFabricHandoffAtBoundary,
  type PendingFabricHandoff,
} from "./prewalk/handoff.js";
import type { AgentToolResultMessage } from "./agents/types.js";
import {
  MainAgentController,
  resolveFabricIdentity,
  type FabricAgentMessageDelivery,
  type FabricAgentMessageResult,
  type FabricMainAgentInfo,
} from "./main-agent.js";
import { AgentsProvider } from "./providers/agents-provider.js";
import { CompactProvider } from "./providers/compact-provider.js";
import { CacheProvider } from "./providers/cache-provider.js";
import { ThinkingProvider } from "./providers/thinking-provider.js";
import { ProgramsProvider } from "./providers/programs-provider.js";
import { ProgramStore, programsDirectory } from "./programs/store.js";
import { FabricThinkingController } from "./thinking-control.js";
import { PrewalkProvider } from "./providers/prewalk-provider.js";
import { ComponentsProvider } from "./providers/components-provider.js";
import type { McpProviderHooks } from "./providers/mcp-provider.js";
import { RuntimeStateBuiltins } from "./runtime-state-builtins.js";
import { SchemaProvider } from "./providers/schema-provider.js";
import { SchemaController } from "./schema/controller.js";
import { StateStore } from "./state/store.js";
import {
  FABRIC_COMPONENT_DISCOVER_EVENT,
  FABRIC_PROVIDER_DISCOVER_EVENT,
  type FabricActionDescriptor,
  type FabricComponentDiscovery,
  type FabricProvider,
  type FabricProviderDiscovery,
} from "./protocol.js";
import { AgentManager } from "./agents/manager.js";
import { AgentCompletionInbox } from "./agents/completion-inbox.js";
import { PeerPresenceNotifier } from "./topology/peer-presence.js";
import { ShellEventInbox } from "./core/shell-inbox.js";
import { FabricShellTimingBridge } from "./core/shell-timing.js";
import { readFabricBashMiddleware } from "./core/shell-middleware.js";
import { DurableShellBridge, JEV_FABRIC_START_MAX_MS } from "./jev-fabric/bridge.js";
import { createMeshGrant, meshCliArgv, wrapDurableNotifyScript } from "./mesh/grants.js";
import { assertPublicMeshTopic } from "./providers/mesh-provider.js";
import { resolveInheritedSessionPins } from "./agents/session-pins.js";
import { ResidencyClient } from "./residency/client.js";
import { RESIDENT_HOST_FORMAT, residentRoot } from "./residency/protocol.js";
import type { FabricRuntimePaths } from "./runtime-paths.js";

const inheritedCapabilityRequirements = (): string[] => {
  const source = process.env.PI_FABRIC_CAPABILITY_REQUIREMENTS;
  if (!source) return [];
  const parsed: unknown = JSON.parse(source);
  if (!Array.isArray(parsed) || parsed.length > 128) {
    throw new Error("PI_FABRIC_CAPABILITY_REQUIREMENTS must be an array of at most 128 refs");
  }
  const refs = parsed.filter((value): value is string => typeof value === "string");
  if (refs.length !== parsed.length || refs.some((ref) => ref.length > 256 || !ref.includes("."))) {
    throw new Error("PI_FABRIC_CAPABILITY_REQUIREMENTS contains an invalid provider.action ref");
  }
  return [...new Set(refs)];
};

const escapeXmlText = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");


import type { FabricManagedHost } from "./managed-host.js";
import { captureLoadedFileIdentity, type FabricLoadedFileIdentity } from "./build-identity.js";

// Loaded-code identity of this lazy runtime module. Stable-path lazy imports
// keep their first evaluation for the life of the host process, so a hash
// captured at activation is the ground truth a reload-freshness check compares
// the current disk file against.
const FABRIC_RUNTIME_MODULE_IDENTITY = captureLoadedFileIdentity(import.meta.url);

export interface FabricRuntimeStateOptions {
  managedHost?: FabricManagedHost;
  activity?: FabricActivityStore;
  prewalk?: PrewalkController;
  prewalkDrift?: PrewalkDriftTracker;
  sessionApprovals?: FabricSessionApprovals;
  thinking?: FabricThinkingController;
  paths?: FabricRuntimePaths;
  entryIdentity?: FabricLoadedFileIdentity;
  /** Foreground tools declared beside fabric_exec; fences cache holds. */
  foregroundTools?: () => readonly string[];
}

export class FabricRuntimeState {
  #registry: ActionRegistry | undefined;
  #config: FabricConfig | undefined;
  #execution: FabricExecutionService | undefined;
  #repairs: RepairCompiler | undefined;
  #speculation: RuntimeStateSpeculation | undefined;
  #agents: AgentManager | undefined;
  #completionInbox: AgentCompletionInbox | undefined;
  #peerPresence: PeerPresenceNotifier | undefined;
  #shellInbox: ShellEventInbox | undefined;
  #shellTiming: FabricShellTimingBridge | undefined;
  #actors: ActorDirectory | undefined;
  #jevObservationHost: JevObservationHost | undefined;
  #jevDecisionProfileSetter: ((profile: string | null | undefined) => void) | undefined;
  #globalActors: GlobalActorRegistry | undefined;
  #mesh: MeshStore | undefined;
  #identity: MeshIdentity | undefined;
  /** Durable decisions for headless approvals and routed child dialogs; mesh-enabled sessions only. */
  #decisions: DecisionStore | undefined;
  #mainAgent: MainAgentController | undefined;
  #participants: ParticipantDirectory | undefined;
  #providerParticipants = new ProviderParticipantRegistry();
  #control: FabricControlPlane | undefined;
  #lifecycle: LifecycleBroker | undefined;
  #residency: ResidencyClient | undefined;
  #agentsProvider: AgentsProvider | undefined;
  #compact: CompactController | undefined;
  #schema: SchemaController | undefined;
  #componentSupervisor: FabricComponentSupervisor | undefined;
  #componentLoader: FabricComponentLoader | undefined;
  #componentControl: FabricComponentControl | undefined;
  #componentConfiguration: FabricComponentConfiguration | undefined;
  #stopComponentWatch: (() => void) | undefined;
  readonly #componentTransitionSignatures = new Map<string, string>();
  readonly #componentTransitionPublications = new Set<Promise<void>>();
  #sessionCapabilityLease: FabricCapabilityViewLease | undefined;
  #unsubscribeCapturedCatalog: (() => void) | undefined;
  #cwd: string | undefined;
  readonly #externalProviders = new Map<string, FabricProvider>();
  readonly #builtinComponentNames = new Set<string>();
  readonly componentCatalog = new FabricComponentCatalog();
  readonly activity: FabricActivityStore;
  #shellJobs = new FabricShellJobStore();
  get shellJobs(): FabricShellJobStore { return this.#shellJobs; }
  readonly prewalk: PrewalkController;
  readonly prewalkDrift: PrewalkDriftTracker;
  readonly sessionApprovals: FabricSessionApprovals;
  readonly thinking: FabricThinkingController;
  readonly #paths: FabricRuntimePaths | undefined;
  readonly #managedHost: FabricManagedHost | undefined;
  readonly #entryIdentity: FabricLoadedFileIdentity | undefined;
  readonly #foregroundTools: (() => readonly string[]) | undefined;
  #widgetDismissedAt = 0;
  #suppressResidentGuidanceSync = false;

  constructor(
    readonly pi: ExtensionAPI,
    readonly capturedTools: CapturedToolCatalog,
    options: FabricRuntimeStateOptions = {},
  ) {
    this.activity = options.activity ?? new FabricActivityStore();
    this.prewalk = options.prewalk ?? new PrewalkController();
    this.prewalkDrift = options.prewalkDrift ?? new PrewalkDriftTracker();
    this.sessionApprovals = options.sessionApprovals ?? new FabricSessionApprovals();
    this.thinking = options.thinking ??
      new FabricThinkingController(pi, () => this.#config?.thinking?.bounds ?? {});
    this.#paths = options.paths;
    this.#managedHost = options.managedHost;
    this.#entryIdentity = options.entryIdentity;
    this.#foregroundTools = options.foregroundTools;
  }

  get initialized(): boolean {
    return Boolean(this.#execution);
  }

  get widgetDismissedAt(): number {
    return this.#widgetDismissedAt;
  }

  set widgetDismissedAt(value: number) {
    this.#widgetDismissedAt = value;
  }

  get cwd(): string | undefined {
    return this.#cwd;
  }

  get config(): FabricConfig {
    if (!this.#config) throw new Error("Pi Fabric has not initialized");
    return this.#config;
  }

  /** Stream tap for speculative PTC; undefined when speculation is disabled. */
  get speculationTap(): FabricSpeculationStreamTap | undefined {
    return this.#speculation?.tap;
  }

  /** Turn-boundary backstop: tap state and unserved entries never outlive a turn. */
  resetSpeculation(): void {
    this.#speculation?.reset();
  }

  get registry(): ActionRegistry {
    if (!this.#registry) throw new Error("Pi Fabric has not initialized");
    return this.#registry;
  }

  get components(): FabricComponentLoader {
    if (!this.#componentLoader) throw new Error("Pi Fabric has not initialized");
    return this.#componentLoader;
  }

  get execution(): FabricExecutionService {
    if (!this.#execution) throw new Error("Pi Fabric has not initialized");
    return this.#execution;
  }

  get agents(): AgentManager {
    if (!this.#agents) throw new Error("Pi Fabric has not initialized");
    return this.#agents;
  }

  get actors(): ActorDirectory {
    if (!this.#actors) throw new Error("Pi Fabric has not initialized");
    return this.#actors;
  }

  get globalActors(): GlobalActorRegistry {
    if (!this.#globalActors) throw new Error("Pi Fabric has not initialized");
    return this.#globalActors;
  }

  get mesh(): MeshStore {
    if (!this.#mesh) throw new Error("Pi Fabric has not initialized");
    return this.#mesh;
  }

  mainAgentInfo(context?: ExtensionContext): FabricMainAgentInfo {
    if (!this.#mainAgent) throw new Error("Pi Fabric has not initialized");
    return this.#mainAgent.info(context);
  }

  peerInfos(): FabricPeerInfo[] {
    return this.#participants?.peers() ?? [];
  }

  componentGraph(): FabricComponentGraph {
    return this.#componentLoader?.graph() ?? { components: [], edges: [], cycles: [] };
  }

  modelGuidance(): FabricOwnedModelGuidance[] {
    return [
      ...(this.#config ? builtinModelGuidance(this.#config) : []),
      ...(this.#componentSupervisor?.guidance() ?? []),
    ];
  }

  participantInfos(options: FabricParticipantListOptions = {}): FabricParticipantInfo[] {
    return this.#participants?.list(options) ?? [];
  }

  async queueUserMessage(
    targetId: string,
    message: string,
    delivery: FabricAgentMessageDelivery,
  ): Promise<FabricAgentMessageResult> {
    if (!this.#mainAgent || !this.#agentsProvider) {
      throw new Error("Pi Fabric has not initialized");
    }
    if (this.#mainAgent.matches(targetId) && this.#mainAgent.local) {
      return this.#mainAgent.deliverUser(message, delivery);
    }
    return this.#agentsProvider.routeMessage(targetId, message, undefined, delivery);
  }

  async stopParticipant(targetId: string): Promise<unknown> {
    if (!this.#agentsProvider) throw new Error("Pi Fabric has not initialized");
    return this.#agentsProvider.stopParticipant(targetId);
  }

  get compact(): CompactController {
    if (!this.#compact) throw new Error("Pi Fabric has not initialized");
    return this.#compact;
  }

  get repairs(): RepairCompiler {
    if (!this.#repairs) throw new Error("Pi Fabric has not initialized");
    return this.#repairs;
  }

  async initialize(context: ExtensionContext, bootstrapConfig?: FabricConfig): Promise<void> {
    this.#suppressResidentGuidanceSync = true;
    try {
      await this.#closeInternal();
      this.#shellJobs = new FabricShellJobStore();
      // Closed-world managed hosts must not reach the ambient session manager.
      const sessionId = this.#managedHost ? undefined : context.sessionManager?.getSessionId?.();
      if (sessionId && this.pi.events) {
        this.#shellTiming = new FabricShellTimingBridge(this.pi.events, sessionId, this.#shellJobs);
      }
    } finally {
      this.#suppressResidentGuidanceSync = false;
    }
    for (const name of this.#builtinComponentNames) this.componentCatalog.unregister(name);
    this.#builtinComponentNames.clear();
    this.prewalk.cancel();
    this.prewalkDrift.clear();
    context.ui.setStatus("fabric-prewalk", undefined);
    this.#speculation?.reset();
    this.#speculation = undefined;
    this.activity.reset();
    this.sessionApprovals.approvedRisks.clear();
    this.#cwd = context.cwd;
    const projectTrusted = this.#managedHost ? false : context.isProjectTrusted();
    this.#managedHost?.seal();
    this.#config = this.#managedHost?.config() ?? bootstrapConfig ?? loadFabricConfig({
      cwd: context.cwd,
      agentDir: resolveAgentDir(),
      projectTrusted,
    });
    if (!this.#managedHost && process.platform !== "win32") {
      this.#shellJobs.durable = new DurableShellBridge(this.#shellJobs, {
        cwd: context.cwd,
        agentDir: resolveAgentDir(),
        ownerId: context.sessionManager?.getSessionId?.(),
        settings: () => (this.#config ?? DEFAULT_FABRIC_CONFIG).executor.jevFabric,
        middleware: () => readFabricBashMiddleware(this.capturedTools.get("bash")?.definition),
        notify: async ({ topic, kind, taskId, description }) => {
          const mesh = this.#mesh;
          if (!mesh || !this.#identity || !this.#config?.mesh.enabled) {
            throw new Error("pi.bash notify requires an enabled Fabric mesh");
          }
          // One single-use grant per task; durable jobs end within 24 hours, so a
          // week covers a late exit (max(task timeout, 7 days), within the 30-day cap).
          const { token } = await createMeshGrant(mesh, {
            topic: assertPublicMeshTopic(topic),
            kind: kind ?? "task.completed",
            ttlMs: Math.max(JEV_FABRIC_START_MAX_MS, 7 * 24 * 3_600_000),
            uses: 1,
            createdBy: this.#identity,
          });
          const argv = meshCliArgv();
          return (command) => wrapDurableNotifyScript(command, {
            argv, root: mesh.root, token, kind: kind ?? "task.completed", taskId,
            ...(description !== undefined ? { description } : {}),
          });
        },
      });
    }
    this.#registry = new ActionRegistry(
      new FabricToolResultProxy(() => this.capturedTools.runner),
    );
    this.#configureSpeculation();
    this.#unsubscribeCapturedCatalog?.();
    this.#unsubscribeCapturedCatalog = this.capturedTools.subscribe(() => {
      this.#registry?.notifyCatalogChanged("extensions");
      if (this.#config?.mcp.nativeServers?.length) this.#registry?.notifyCatalogChanged("mcp");
      this.#refreshRepairCatalog();
    });
    this.#componentSupervisor = new FabricComponentSupervisor(this.#registry, {
      invocationContext: () => ({
        cwd: context.cwd,
        signal: undefined,
        parentToolCallId: "fabric-component",
        nestedToolCallId: "fabric-component",
        extensionContext: context,
        update() {},
      }),
      maxResultChars: this.#config.executor.maxNestedResultChars,
      acquire: async (ref, args, invocation) => {
        const action = await this.#registry!.describe(ref, invocation);
        await this.#schema?.authorize(action.ref, invocation.parentToolCallId);
        return this.#registry!.acquireScoped(ref, args, invocation);
      },
      invoke: (ref, args, invocation) => this.#registry!.invoke(ref, args, {
        ...invocation,
        ...(this.#schema
          ? { authorize: (action) => this.#schema!.authorize(action.ref, invocation.parentToolCallId) }
          : {}),
        approve: async () => {},
        audits: [],
        maxResultChars: this.#config!.executor.maxNestedResultChars,
      }),
    });
    this.#componentSupervisor.subscribe((componentId) =>
      this.#observeComponentTransitions(componentId),
    );
    this.#componentLoader = new FabricComponentLoader(
      this.componentCatalog,
      this.#componentSupervisor,
    );
    if (!this.#managedHost && this.#config.schema.mode !== "enforce") {
      this.#componentConfiguration = new FabricComponentConfiguration({
        cwd: context.cwd, agentDir: resolveAgentDir(), projectTrusted: () => context.isProjectTrusted(),
      });
    }
    this.#componentControl = new FabricComponentControl(this.#componentLoader, {
      ...(this.#componentConfiguration ? { store: this.#componentConfiguration } : {}),
      initialEntries: this.#config.schema.mode === "enforce" ? [] : this.#config.components,
      assertMutable: () => {
        if (this.#managedHost || this.#config?.schema.mode === "enforce") throw new Error("Live component configuration is unavailable in managed hosts and Schema enforce mode");
      },
      applied: entries => { if (this.#config) this.#config.components = entries; },
    });
    this.#registry.setUnavailableResolver(name => this.#componentLoader?.unavailableProviderMessage(name));
    this.#registry.register(this.#managedHost?.provider("components") ?? new ComponentsProvider(this.#componentLoader, this.#componentControl));
    const builtinManifest = new FabricProviderComponentManifest(
      this.componentCatalog,
      this.#componentLoader,
    );
    const builtins = new RuntimeStateBuiltins(
      builtinManifest,
      this.#registry,
      (name) => this.#builtinComponentNames.add(name),
      this.#managedHost,
    );
    const enforceSchema = this.#config.schema.mode === "enforce";
    await builtins.tools(context.cwd, this.#config, this.capturedTools, {
      jobs: this.shellJobs,
      getHangMs: () => this.#config?.executor.shellHangMs ?? DEFAULT_SHELL_HANG_MS,
    });
    if (!this.#managedHost && (this.#config.fullCodeMode || enforceSchema)) {
      this.#shellInbox = new ShellEventInbox(this.pi, context, this.shellJobs);
    }
    // One definition for both host modes: the controller belongs to this
    // runtime state, so managed and normal sessions share a single wiring site.
    await builtins.install(createProviderComponent({
      provider: "prewalk",
      description: "Frontier-first handoff readiness and plan record",
      create: () => new PrewalkProvider(this.prewalk, {
        buildIdentity: () => ({
          entry: this.#entryIdentity ?? null,
          lazyRuntime: FABRIC_RUNTIME_MODULE_IDENTITY,
        }),
      }),
    }));
    if (this.#managedHost) {
      this.#registry.markUnavailable("jev", "Jev programs are unavailable in managed hosts");
      this.#registry.markUnavailable("cache", "Native prompt-cache access is unavailable in managed hosts");
      this.#registry.markUnavailable("thinking", "Host thinking control is unavailable in managed hosts");
      this.#registry.markUnavailable("decisions", "Durable decisions are unavailable in managed hosts");
      this.#registry.markUnavailable("programs", "Saved programs are unavailable in managed hosts");
      // Closed-world hosts must never construct unused native managers, stores or model history.
      for (const name of ["agents", "schema", "compact", "memory", "mesh", "state"]) {
        if (["agents", "schema", "compact"].includes(name) || this.#managedHost.has(name)) {
          await builtins.install(createProviderComponent({
            provider: name, description: "Managed host provider",
            create: () => this.#managedHost!.provider(name),
          }));
        } else this.#registry.markUnavailable(name, "unavailable in managed host");
      }
      builtins.assertActive(this.#config);
      await this.#mountExecution(context, false);
      return;
    }
    const sessionId = context.sessionManager.getSessionId();
    const { identity, mainAgentId } = resolveFabricIdentity(sessionId);
    await builtins.install(createProviderComponent({
      provider: "cache",
      description: "Local prompt-cache observations and scoped native warming",
      create: () => new CacheProvider(this.pi, context, identity.kind === "main", this.#foregroundTools),
    }));
    await builtins.install(createProviderComponent({
      provider: "thinking",
      description: "Bounded host-session thinking control",
      create: () => new ThinkingProvider(this.thinking, sessionId),
    }));
    await builtins.install(createProviderComponent({
      provider: "programs",
      description: "Content-addressed saved programs",
      create: () => new ProgramsProvider(
        new ProgramStore(programsDirectory(context.cwd)),
        () => (this.#config ?? DEFAULT_FABRIC_CONFIG).executor.kernel,
        (parentToolCallId) => this.#execution?.nestedProgramRunner(parentToolCallId),
      ),
    }));
    const fabricSessionId = process.env.PI_FABRIC_SESSION_ID?.trim() || sessionId;
    const ownsPersistentActorRegistry =
      identity.kind === "main" &&
      !enforceSchema &&
      projectTrusted &&
      this.#config.mesh.enabled;
    const mainAgent = new MainAgentController(
      this.pi,
      mainAgentId,
      identity.kind === "main" && identity.id === mainAgentId,
      context.cwd,
      identity.kind === "main" ? sessionId : undefined,
    );
    this.#mainAgent = mainAgent;
    const projectRoot = process.env.PI_FABRIC_PROJECT_ROOT ?? context.cwd;
    const configuredMeshRoot = this.#config.mesh.root;
    const meshRoot =
      process.env.PI_FABRIC_MESH_ROOT ??
      (configuredMeshRoot
        ? path.resolve(projectRoot, configuredMeshRoot)
        : path.join(projectRoot, ".pi", "fabric", "mesh"));
    this.#mesh = new MeshStore(
      meshRoot,
      this.#config.mesh.maxEventBytes,
      this.#config.mesh.maxReadEvents,
    );
    const hostId = identity.kind === "main" ? mainAgentId : `runtime:${sessionId}`;
    this.#control = new FabricControlPlane(this.#mesh, identity, {
      enabled: this.#config.mesh.enabled,
      hostId,
      pollMs: this.#config.mesh.actorPollMs,
    });
    this.#participants = new ParticipantDirectory(this.#mesh, {
      enabled: this.#config.mesh.enabled,
      hostId,
      rootId: mainAgentId,
      identity,
      ownerIncarnation: this.#control.incarnation,
      ...(process.env.PI_FABRIC_OWNER_HOST_ID
        ? { selfOwnerHostId: process.env.PI_FABRIC_OWNER_HOST_ID }
        : {}),
      ...(process.env.PI_FABRIC_OWNER_IDENTITY_ID
        ? { selfOwnerIdentityId: process.env.PI_FABRIC_OWNER_IDENTITY_ID }
        : {}),
    });
    await builtins.mesh(this.#config, this.#mesh, identity, this.#participants);
    this.#decisions = this.#config.mesh.enabled ? new DecisionStore(this.#mesh, identity) : undefined;
    this.#schema = new SchemaController(
      context.cwd,
      this.#config.schema,
      this.#mesh,
      identity,
      new StateStore(this.#mesh),
    );
    await builtins.install(createProviderComponent({
      provider: "schema",
      description: "Schema verification and workspace transactions",
      create: () => new SchemaProvider(this.#schema!),
    }));
    this.#identity = identity;
    this.#compact = new CompactController({
      onRequest: (intent) => void this.#publishCompactEvent("requested", intent),
      onCommit: (info) => void this.#publishCompactEvent(info.status, info),
    });
    await builtins.install(createProviderComponent({
      provider: "compact",
      description: "Host context compaction controller",
      create: () => new CompactProvider(this.#compact!, {
        config: () => (this.#config ?? DEFAULT_FABRIC_CONFIG).compaction,
        appendEntry: (customType, data) => this.pi.appendEntry(customType, data),
      }),
    }));
    const agentConfig = enforceSchema
      ? { ...this.#config.agents, enabled: false }
      : this.#config.agents;
    const modelsConfig = this.#config.models;
    const visiblePiModels = () => {
      try {
        return context.modelRegistry.getAvailable();
      } catch {
        return [];
      }
    };
    const piModelState = (models = visiblePiModels()) => {
      const available: FabricModelCandidate[] = models.map((model) => ({
        provider: String(model.provider),
        id: String(model.id),
        ...(typeof model.name === "string" ? { name: model.name } : {}),
      }));
      const defaultModel = context.model
        ? `${context.model.provider}/${context.model.id}`
        : undefined;
      return {
        available,
        aliases: structuredClone(modelsConfig.aliases),
        ...(defaultModel ? { defaultModel } : {}),
      };
    };
    const resolveParticipantPiModel = (selector?: string) => {
      const models = visiblePiModels();
      const state = piModelState(models);
      const query = selector?.trim() || state.defaultModel || "";
      const resolved = resolveAvailablePiModel(query, {
        aliases: state.aliases,
        available: state.available,
        lastUsed: loadModelUsage(),
      });
      const model = models.find(
        (candidate) =>
          String(candidate.provider).toLowerCase() === resolved.provider.toLowerCase() &&
          String(candidate.id).toLowerCase() === resolved.id.toLowerCase(),
      );
      if (!model) {
        throw new Error(
          `Model ${JSON.stringify(query)} is not available to this Pi session. ` +
            'Use agents.models({ runner: "pi" }) to list the models visible to this session.',
        );
      }
      return { key: `${resolved.provider}/${resolved.id}`, model };
    };
    const completionInbox = new AgentCompletionInbox(this.pi, context);
    this.#completionInbox = completionInbox;
    this.#agents = new AgentManager(context.cwd, agentConfig, {
      fullCodeMode: this.#config.fullCodeMode,
      kernel: () => this.#config?.executor.kernel ?? "typescript",
      pythonRuntime: () => this.#config?.executor.pythonRuntime ?? "monty",
      mainAgentId,
      fabricSessionId,
      meshRoot,
      projectRoot,
      hostId,
      identityId: identity.id,
      retention: this.#config.retention,
      ...(this.#paths
        ? {
            workerPath: this.#paths.worker,
            fabricExtensionPath: this.#paths.extension,
          }
        : {}),
      resolveInheritedSessionPins: () =>
        resolveInheritedSessionPins(context.sessionManager?.getEntries?.() ?? []),
      thinkingBounds: () => this.#config?.thinking?.bounds ?? {},
      sessionId: () => context.sessionManager?.getSessionId?.(),
      executorRuntime: () => this.#config?.schema.mode === "enforce" ? "quickjs" : this.#config?.executor.runtime,
      resolveParticipantGuidance: ({ model, runner }) => {
        const targetModel = model ?? ((runner === "pi" || runner === "pi-durable") && context.model
          ? `${context.model.provider}/${context.model.id}`
          : undefined);
        if (!targetModel) return undefined;
        return resolveFabricModelGuidance(this.modelGuidance(), {
          model: targetModel,
          target: "participant",
          includeSlots: false,
        }).appendText || undefined;
      },
      resolveHandoffCompactionBudget: async (modelKey, cwd) => {
        const { model } = resolveParticipantPiModel(modelKey);
        // Load host settings only for an actual compacted handoff. Project
        // trust does not transfer implicitly to a different working directory.
        const { SettingsManager } = await loadHostSdk();
        const settings = SettingsManager.create(cwd, resolveAgentDir(), {
          projectTrusted: !this.#managedHost && cwd === context.cwd && context.isProjectTrusted(),
        }).getCompactionSettings(model);
        return {
          contextWindow: model.contextWindow,
          targetContextRatio: this.#config?.compaction.targetContextRatio ?? DEFAULT_FABRIC_CONFIG.compaction.targetContextRatio,
          reserveTokens: settings.reserveTokens,
          keepRecentTokens: settings.keepRecentTokens,
        };
      },
      preparePiModel: async (modelKey) => {
        const resolved = resolveParticipantPiModel(modelKey);
        const auth = await context.modelRegistry.getApiKeyAndHeaders(resolved.model);
        if (!auth.ok) throw new Error(auth.error);
        return resolved.key;
      },
      onLifecycle: (event) => {
        const lifecycle = this.#lifecycle;
        if (lifecycle) void lifecycle.publish(event).catch(() => undefined);
      },
      onBackgroundComplete: (result) => completionInbox.enqueue(result),
      onResultConsumed: (id) => completionInbox.acknowledge(id),
      onChildQuestion: (request) =>
        routeChildQuestion(request, { context, ...(this.#decisions ? { store: this.#decisions } : {}) }),
      resolveChildTraceContext: (launch) =>
        requestChildTraceContext((event, value) => this.pi.events?.emit(event, value), launch),
    });
    const canManageActor = (actorId: string): boolean | undefined => {
      const participant = this.#participants?.get(actorId);
      return participant ? participant.ownerHostId === hostId : undefined;
    };
    const lineageAlive = (rootId: string): boolean =>
      this.#participants?.get(rootId) !== undefined;
    const actorRoots = {
      project: path.join(meshRoot, "actors"),
      session: path.join(meshRoot, "actors", fabricSessionId),
    };
    const acquireActorCapabilityView = (
      requirements: Parameters<ActionRegistry["acquireCapabilityView"]>[0],
      signal: AbortSignal,
    ) => this.#registry!.acquireCapabilityView(requirements, {
      cwd: context.cwd,
      signal,
      parentToolCallId: "fabric-actor-capability",
      nestedToolCallId: "fabric-actor-capability",
      extensionContext: context,
      update() {},
    });
    this.#actors = new ActorDirectory([
      fabricSessionId,
      identity,
      this.#mesh,
      enforceSchema ? { ...this.#config.mesh, enabled: false } : this.#config.mesh,
      this.#agents,
      ({ actor, message, delivery, triggerTurn }) => {
        const text = message.text ?? "";
        if (!text) return;
        const deliveryNotice = actorDeliveryNotice(delivery, triggerTurn);
        this.pi.sendMessage(
          {
            customType: "pi-fabric-actor",
            content: [
              `<fabric-actor name=${JSON.stringify(actor.name)} id=${JSON.stringify(actor.id)}>\n${escapeXmlText(text)}\n</fabric-actor>`,
              deliveryNotice,
            ]
              .filter((line): line is string => Boolean(line))
              .join("\n"),
            display: true,
            details: {
              actor,
              message,
              delivery: { mode: delivery, triggerTurn, passive: Boolean(deliveryNotice) },
            },
          },
          { deliverAs: delivery, triggerTurn },
        );
      },
      ownsPersistentActorRegistry
        ? {
            persistent: true,
            mainAgent,
            canManageActor,
            lineageAlive,
            claimResidency: "session",
            rootId: mainAgentId,
            retention: this.#config.retention,
            resolvePiModel: (model) => resolveParticipantPiModel(model).key,
            acquireCapabilityView: acquireActorCapabilityView,
          }
        : {
            persistent: false,
            mainAgent,
            canManageActor,
            lineageAlive,
            claimResidency: "session",
            rootId: mainAgentId,
            retention: this.#config.retention,
            resolvePiModel: (model) => resolveParticipantPiModel(model).key,
            acquireCapabilityView: acquireActorCapabilityView,
          },
    ], actorRoots, this.#config.mesh.actorScope);
    this.#registry.subscribeProviderChanges(() => {
      this.#actors?.retryCapabilityWaiters();
      this.#refreshRepairCatalog();
    });
    this.#lifecycle = new LifecycleBroker(
      this.#mesh,
      identity,
      this.#participants,
      {
        enabled: this.#config.mesh.enabled && !enforceSchema,
        pollMs: this.#config.mesh.actorPollMs,
        maxReadEvents: this.#config.mesh.maxReadEvents,
      },
      async (subscription, event) => {
        if (!this.#agentsProvider) throw new Error("Fabric agents provider is unavailable");
        await this.#agentsProvider.deliverLifecycle(subscription, event);
      },
    );
    this.#globalActors = new GlobalActorRegistry(resolveAgentDir(), this.#config.mesh.maxEventBytes);
    const globalActorsError = this.#globalActors.loadError;
    if (globalActorsError) {
      // Global actor actions also fail with this error until the file reads again.
      const detail = `${globalActorsError.message}. Global actor templates are unavailable until the file is repaired.`;
      console.warn(`[pi-fabric] ${detail}`);
      if (context.hasUI) context.ui.notify(`Pi Fabric: ${detail}`, "warning");
    }
    this.#residency = ownsPersistentActorRegistry
      ? new ResidencyClient({
          config: {
            format: RESIDENT_HOST_FORMAT,
            rootId: mainAgentId,
            sessionId,
            cwd: context.cwd,
            projectRoot,
            meshRoot,
            actorRoot: actorRoots.project,
            sessionActorRoot: actorRoots.session,
            residencyRoot: residentRoot(meshRoot, mainAgentId),
            fullCodeMode: this.#config.fullCodeMode,
            kernel: this.#config.executor.kernel,
            pythonRuntime: this.#config.executor.pythonRuntime,
            agents: structuredClone(this.#config.agents),
            mesh: structuredClone(this.#config.mesh),
            retention: structuredClone(this.#config.retention),
            workerPath: this.#paths?.worker ?? fileURLToPath(new URL("./worker.js", import.meta.url)),
            fabricExtensionPath: this.#paths?.extension ?? fileURLToPath(new URL("./index.js", import.meta.url)),
            piBinary: resolvePiBinary(),
            claudeBinary:
              process.env.PI_FABRIC_CLAUDE_BINARY ?? this.#config.agents.claude.binary,
            vedaBinary:
              process.env.PI_FABRIC_VEDA_BINARY ?? this.#config.agents.veda.binary,
            piModels: piModelState(),
            modelGuidance: [],
          },
          mesh: this.#mesh,
          participants: this.#participants,
          mainAgent,
          onBackgroundComplete: (result, delivered) => completionInbox.enqueue(result, delivered),
          onResultConsumed: (id) => completionInbox.acknowledge(id),
          piModelState,
          ...(this.#paths ? { hostPath: this.#paths.residentHost } : {}),
        })
      : undefined;
    const firstSeenAgents = new Map<string, number>();
    if (mainAgent.local) {
      this.#participants.registerSource(() => [
        this.#participants!.root(mainAgent.info(context)),
      ]);
    }
    this.#participants.registerSource(() =>
      agentParticipantRecords(
        this.#agents!.listForUi(),
        mainAgentId,
        hostId,
        identity.id,
        identity.id,
        firstSeenAgents,
      ),
    );
    this.#participants.registerSource(() =>
      this.#actors!.listOwned().map((actor) =>
        actorParticipantRecord(actor, mainAgentId, hostId, identity.id, identity.id),
      ),
    );
    this.#agents.subscribeUi(() => this.#participants?.scheduleRefresh());
    this.#actors.subscribe(() => this.#participants?.scheduleRefresh());
    const providerParticipants = this.#providerParticipants;
    this.#participants.registerSource(() =>
      providerParticipants.records(mainAgentId, hostId, identity.id));
    providerParticipants.subscribe(() => this.#participants?.scheduleRefresh());
    const agentsProvider = new AgentsProvider(
      this.#agents,
      this.#actors,
      this.#globalActors,
      mainAgent,
      this.#participants,
      this.#control,
      this.#lifecycle,
      () => this.#config?.ui.showAgentToolPreview ?? true,
      this.#residency,
      false,
      () => this.#config?.models ?? DEFAULT_FABRIC_CONFIG.models,
    );
    agentsProvider.providerParticipants = providerParticipants;
    this.#agentsProvider = agentsProvider;
    this.#control.start((command, from, signal) =>
      agentsProvider.acceptControl(command, from, signal));
    try {
      await this.#participants.start();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `[pi-fabric] Initial mesh publish failed (${detail}); the participant heartbeat will keep retrying.`,
      );
      if (context.hasUI) {
        context.ui.notify(
          `Pi Fabric could not reach the mesh (${detail}); retrying in the background.`,
          "warning",
        );
      }
    }
    // Children are coordinated by their parent; only a root is told about peers.
    if (mainAgent.local && this.#config.mesh.enabled) {
      this.#peerPresence = new PeerPresenceNotifier(this.pi, context, {
        peers: () => this.peerInfos(),
        enabled: () => this.#config?.mesh.peerNotices === true,
        cwd: context.cwd,
      });
    }
    this.#lifecycle.start();
    this.#residency?.start();
    await builtins.install(createProviderComponent({
      provider: "agents",
      description: "Agents, actors, lifecycle delivery, and residency control",
      create: () => agentsProvider,
    }));
    if (this.#config.jev.enabled && !enforceSchema) {
      const { JevProvider } = await import("./providers/jev-provider.js");
      const { JevObservationHost } = await import("./jev/observation.js");
      await builtins.install(createProviderComponent({
        provider: "jev",
        description: "Shell orchestration and explicit typed Jev decisions",
        create: (component) => {
          const observationHost = identity.kind === "main" ? new JevObservationHost(context.sessionManager.getSessionId(), advice => {
            this.pi.sendMessage({
              customType: "pi-fabric-jev",
              content: [`<fabric-jev name=${JSON.stringify(escapeXmlText(advice.name))} id=${JSON.stringify(advice.runId)}>\n${escapeXmlText(advice.message)}\n</fabric-jev>`, actorDeliveryNotice(advice.delivery, advice.triggerTurn)].filter(Boolean).join("\n"),
              display: true,
              details: { runId: advice.runId, eventId: advice.eventId, delivery: { mode: advice.delivery, triggerTurn: advice.triggerTurn } },
            }, { deliverAs: advice.delivery, triggerTurn: advice.triggerTurn });
          }) : undefined;
          this.#jevObservationHost = observationHost;
          // A bare `jev.model` alias stays on TypeSafe; `typesafe/...` / `~typesafe/...` uses OpenRouter decisions, `typesafe-ai/...` uses Vercel AI Gateway, and `subq-...` uses SubQ.
          const jevRoute = resolveJevModelRoute(this.#config!.jev.model).route;
          const provider = new JevProvider({
            registry: this.#registry!, config: this.#config!, observationHost,
            credentialSource: {
              configured: () => context.modelRegistry.getProviderAuthStatus?.(jevRoute.providerId)?.configured ?? false,
              resolve: async (signal) => {
                signal.throwIfAborted();
                return context.modelRegistry.getApiKeyForProvider?.(jevRoute.providerId);
              },
            },
            authorize: (ref, parentToolCallId) => this.#schema!.authorize(ref, parentToolCallId),
            jevFabric: this.#shellJobs.durable,
          });
          const setDecisionProfile = (profile: string | null | undefined) => provider.setDecisionProfile(profile);
          this.#jevDecisionProfileSetter = setDecisionProfile;
          // A program may pin jev.evaluate itself. Cancel at owner retirement,
          // not only at provider.close(), which waits for those pins to drain.
          const stop = () => { observationHost?.close(); provider.manager.stopAll(); };
          component.signal.addEventListener("abort", stop, { once: true });
          component.defer(async () => {
            component.signal.removeEventListener("abort", stop);
            observationHost?.close();
            if (this.#jevObservationHost === observationHost) this.#jevObservationHost = undefined;
            if (this.#jevDecisionProfileSetter === setDecisionProfile) this.#jevDecisionProfileSetter = undefined;
            await provider.manager.close();
          }, { label: "jev-program-owner", kind: "transactional", resources: ["jev:programs"], ordering: "ordered" });
          return provider;
        },
      }));
    } else {
      this.#registry.markUnavailable("jev", enforceSchema ? "Jev network programs are unavailable in Schema enforce mode" : "disabled by configuration (jev.enabled=false)");
    }
    await builtins.memory(context, this.#config, sessionId);
    builtins.assertActive(this.#config);
    await this.#mountExecution(context, enforceSchema);
    const inheritedRequirements = inheritedCapabilityRequirements();
    const inheritedDigest = process.env.PI_FABRIC_CAPABILITY_DIGEST;
    const hasInheritedCommit =
      process.env.PI_FABRIC_CAPABILITY_REQUIREMENTS !== undefined && Boolean(inheritedDigest);
    if (inheritedRequirements.length > 0 || hasInheritedCommit) {
      const lease = await this.#registry.acquireCapabilityView(inheritedRequirements, {
        cwd: context.cwd,
        signal: undefined,
        parentToolCallId: "fabric-capability-commit",
        nestedToolCallId: "fabric-capability-commit",
        extensionContext: context,
        update() {},
      });
      if (!lease.satisfied || !lease.view) {
        await lease.release();
        throw new Error(
          `Required Fabric capabilities are unavailable: ${lease.missing.join(", ")}`,
        );
      }
      const expectedDigest = inheritedDigest;
      if (expectedDigest && lease.view.semanticDigest !== expectedDigest) {
        await lease.release();
        throw new Error(
          `Fabric capability commitment mismatch: expected ${expectedDigest}, resolved ${lease.view.semanticDigest}`,
        );
      }
      this.#sessionCapabilityLease = lease;
      this.execution.setCapabilityView(lease.view);
    }
    this.#repairs = new RepairCompiler({
      agentDir: resolveAgentDir(),
      enabled: this.#config.repairs.enabled,
    });
    // Commit the stable catalog surface before promotion can reach the
    // active compiler: an active compiler whose surface has not been
    // committed yet must never persist under a mid-reconcile catalog.
    this.#refreshRepairCatalog();
    setActiveRepairCompiler(this.#repairs);
    // Static compatibility is enabled on first use, even without a corpus.
    // Loaded plans re-prove their rule language and live schema at consult.
    // A damaged artifact disables normalization and surfaces on demand.
    const compiled = this.#config.entropy.compile ? loadCompiledSurface(resolveAgentDir()) : {};
    setActiveCompiledSurface(compiled.file, this.#config.entropy.compile && !compiled.error);
  }

  async #mountExecution(context: ExtensionContext, enforceSchema: boolean): Promise<void> {
    for (const provider of this.#externalProviders.values()) {
      this.registry.register(provider);
    }
    this.#execution = new FabricExecutionService(
      this.registry,
      this.config,
      this.activity,
      this.#schema,
      undefined,
      this.sessionApprovals,
      this.capturedTools,
      this.#managedHost ? (name) => this.#managedHost!.ownsProvider(name) : undefined,
    );
    this.#execution.nativeCodemode.setPersistence((type, data) => this.pi.appendEntry(type, data));
    this.#execution.setParticipantRegistry(this.#providerParticipants);
    const events = this.pi.events;
    if (events) this.#execution.setEventEmitter((channel, data) => events.emit(channel, data));
    const decisions = this.#decisions;
    if (decisions) {
      this.#execution.setHeadlessApproval((action, reason, signal) => requestHeadlessApproval(decisions, action, {
        ...(reason ? { reason } : {}),
        ...(this.#config?.approvals.headlessTimeoutMs ? { timeoutMs: this.#config.approvals.headlessTimeoutMs } : {}),
        ...(signal ? { signal } : {}),
      }));
    }
    const discovery: FabricProviderDiscovery = {
      version: 1,
      register: (provider, options) => this.registerExternal(provider, options),
    };
    this.pi.events.emit(FABRIC_PROVIDER_DISCOVER_EVENT, discovery);
    const componentDiscovery: FabricComponentDiscovery = {
      version: 1,
      register: (component, options) => this.registerExternalComponent(component, options),
    };
    this.pi.events.emit(FABRIC_COMPONENT_DISCOVER_EVENT, componentDiscovery);
    await this.components.reconcile(enforceSchema ? [] : this.config.components);
    const configuration = this.#componentConfiguration;
    const control = this.#componentControl;
    if (configuration && control) {
      this.#stopComponentWatch = watchComponentConfiguration(configuration.paths, () => {
        void control.reconcile().catch(error => {
          if (context.hasUI) context.ui.notify(`Pi Fabric component configuration not applied: ${error instanceof Error ? error.message : String(error)}`, "error");
        });
      });
      for (const warning of control.configuration().warnings) {
        if (context.hasUI) context.ui.notify(warning, "warning");
      }
    }
  }

  async ensure(context: ExtensionContext): Promise<void> {
    if (!this.initialized || this.#cwd !== context.cwd) await this.initialize(context);
  }

  // Accepts the config FabricState just loaded so a /fabric settings save
  // costs one loadFabricConfig instead of two. The runtime still stamps
  // schema.mode from its own previous config, preserving the existing
  // in-memory override chain (state and runtime share the same preserved
  // mode by construction: the runtime's config originates from FabricState).
  // Ephemeral schema mode override: mutates the live config in place so the
  // per-call readers (SchemaController.authorize, the top-level tool gate,
  // ExecutionService's runtime selection) see the change immediately without
  // a provider-topology rebuild. FabricState owns the coupling rules.
  setSchemaMode(mode: FabricSchemaMode, executorRuntime: FabricConfig["executor"]["runtime"]): void {
    if (this.#managedHost) throw new Error("Managed host policy is immutable");
    if (!this.#config) return;
    this.#config.schema.mode = mode;
    this.#config.executor.runtime = executorRuntime;
    this.#configureSpeculation();
  }

  /** Updates the active owner's defaults, never a managed program's captured target. */
  setDecisionProfile(profile: string | null | undefined): void {
    this.#jevDecisionProfileSetter?.(profile);
  }

  reloadConfig(context: ExtensionContext, next: FabricConfig): void {
    if (this.#managedHost) next = this.#managedHost.config();
    if (!this.#config || !this.#cwd) return;
    next.schema.mode = this.#config.schema.mode;
    this.#speculation?.reset();
    const previousComponents = structuredClone(this.#config.components);
    deepAssign(this.#config as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
    this.#configureSpeculation();
    // The persisted master switch wins over any live arm: disabling prewalk
    // via /fabric settings (or an external config edit followed by a reload)
    // cancels the arm so no later boundary can claim behind the user's back.
    if (next.prewalk.enabled === false && this.prewalk.status().state !== "idle") {
      this.prewalk.cancel();
      this.prewalkDrift.drop(context.sessionManager.getSessionId());
      if (context.hasUI) context.ui.setStatus("fabric-prewalk", undefined);
    }
    void (this.#componentControl?.reconcile(next.components) ?? this.#componentLoader?.reconcile(next.components))?.catch((error) => {
      if (this.#config) this.#config.components = previousComponents;
      const detail = error instanceof Error ? error.message : String(error);
      if (context.hasUI) context.ui.notify(`Pi Fabric component reload failed: ${detail}`, "error");
    });
  }

  #configureSpeculation(): void {
    this.#speculation?.reset();
    this.#speculation = undefined;
    this.#registry?.setSpeculation(undefined);
    const config = this.#config;
    // Native runtimes can mutate outside registry epochs; only isolated backends speculate.
    // Recreate the tap/store for every policy change so limits, epochs and
    // pending asynchronous scans cannot leak across an execution boundary.
    const eligible = (): boolean => {
      const current = this.#config;
      if (!current?.speculation.enabled) return false;
      return current.executor.kernel === "python"
        ? current.executor.pythonRuntime === "monty" || current.schema.mode === "enforce"
        : current.schema.mode === "enforce" || current.executor.runtime === "quickjs";
    };
    if (!config || !this.#registry || !eligible()) return;
    this.#speculation = new RuntimeStateSpeculation(
      this.#registry,
      () => eligible() ? this.#config?.speculation : undefined,
      () => this.#sessionCapabilityLease?.view,
      (ref) => {
        const current = this.#config!;
        const mode = actionApprovalOverride(current.approvals.actions, ref) ??
          current.approvals[ref.startsWith("mcp.") ? "network" : "read"];
        if (mode !== "allow") return false;
        if (ref.startsWith("pi.") && !current.fullCodeMode && current.schema.mode !== "enforce") return false;
        return current.schema.mode !== "enforce" || schemaRefAllowedInEnforce(ref);
      },
      config.executor.kernel,
      () => this.capturedTools.registeredTools().map(entry => entry.definition),
      () => this.#config?.executor.codemodeProfile === "native",
    );
  }

  async claimHandoff(
    execution: FabricExecutionResult,
    sessionId: string,
    resultFormat: FabricResultFormat,
    outerToolCallId: string,
  ): Promise<PendingFabricHandoff | undefined> {
    // Defense in depth behind cancel-at-disable: an arm that predates a
    // config edit must never claim once the master switch is off.
    if (this.#config?.prewalk.enabled === false) return undefined;
    let pending = claimFabricHandoff(this.prewalk, execution, sessionId, resultFormat);
    if (pending && pending.kind !== "explicit" && this.#config?.prewalk.detectShellWrites && this.#cwd) {
      // This audited outer boundary consumed all mutations in its window, even
      // when the plan gate withholds the handoff. Do not rediscover those edits
      // as shell drift on a later read. The fs-only path advances in evaluate().
      await this.prewalkDrift.captureBaseline(sessionId, this.#cwd);
    }
    if (!pending && this.#config?.prewalk.detectShellWrites) {
      pending = await this.#claimShellWriteHandoff(execution, sessionId, resultFormat);
    }
    if (pending?.kind === "prewalk-plan") {
      // Nothing hands off yet: the frontier model owes a plan checkpoint at this
      // boundary, and the arm stays armed for the mutation that follows it.
      if (!deliverPrewalkPlanCheckpoint(this.pi, pending)) {
        this.prewalk.reopenPlanCheckpoint();
      }
      return undefined;
    }
    if (pending) {
      this.activity.resume(outerToolCallId);
      this.activity.beginCall(outerToolCallId, {
        callId: pending.audit.nestedToolCallId,
        ref: pending.audit.ref,
        args: pending.args,
      });
    }
    return pending;
  }

  // Filesystem fallback for writes audits cannot attribute (shell heredocs,
  // sed -i, formatter binaries). Gated on a successful Pi shell call in the program
  // so read-only scans never pay the stat walk, and external saves can only
  // mis-fire inside a bash-running window. The tracker refreshes its baseline
  // on every evaluation, claimed or not, so one change never fires twice.
  async #claimShellWriteHandoff(
    execution: FabricExecutionResult,
    sessionId: string,
    resultFormat: FabricResultFormat,
  ): Promise<PendingFabricHandoff | FabricPrewalkPlanCheckpoint | undefined> {
    if (!this.prewalk.isArmed(sessionId) || !this.#cwd) return undefined;
    if (!execution.audits.some((audit) => isPiShellRef(audit.ref) && audit.success === true)) {
      return undefined;
    }
    const drift = await this.prewalkDrift.evaluate(sessionId, this.#cwd);
    if (!drift || drift.files.length === 0) return undefined;
    return claimFabricFsDriftHandoff(this.prewalk, execution, sessionId, drift, resultFormat);
  }

  async runHandoffAtBoundary(
    pending: PendingFabricHandoff,
    outerToolResult: AgentToolResultMessage,
    context: ExtensionContext,
  ): Promise<Record<string, unknown>> {
    if (!this.#agentsProvider) throw new Error("Pi Fabric has not initialized");
    const runId = outerToolResult.toolCallId;
    const callId = pending.audit.nestedToolCallId;
    const result = await runFabricHandoffAtBoundary(
      this.prewalk,
      this.#agentsProvider,
      this.pi,
      pending,
      outerToolResult,
      context,
      (update) => this.activity.updateCall(runId, callId, update),
    );
    const succeeded = result.completed === true || result.continued === true;
    const error = typeof result.error === "string" ? result.error : undefined;
    this.activity.finishCall(runId, callId, {
      success: succeeded,
      result,
      ...(pending.audit.preview !== undefined ? { preview: pending.audit.preview } : {}),
      ...(error ? { error } : {}),
    });
    this.activity.finish(runId, succeeded, error);
    return result;
  }

  get advisorsHalted(): boolean {
    return (!this.#config?.mesh.enabled || Boolean(this.#actors?.halted)) && (!this.#jevObservationHost || this.#jevObservationHost.halted);
  }

  haltAdvisors(): number {
    const actors = this.#config?.mesh.enabled ? this.#actors?.haltAll().halted ?? 0 : 0;
    return actors + (this.#jevObservationHost?.halt() ?? 0);
  }

  noteMainActivity(context: ExtensionContext): void {
    this.#actors?.noteMainActivity(context.isIdle());
    this.#participants?.scheduleRefresh();
  }

  dispatchHostEvent(
    event: FabricActorHostEvent,
    payload: unknown,
    context: ExtensionContext,
  ): number {
    const observed = this.#jevObservationHost?.observe(event, payload, {
      sessionId: context.sessionManager.getSessionId(), signal: context.signal,
    }) ?? 0;
    if (
      !this.#actors ||
      !this.#config?.mesh.enabled ||
      this.#config.schema.mode === "enforce"
    ) return observed;
    const idle = context.isIdle();
    if (!this.#actors.observeHostEvent(event, idle)) return observed;
    const branch = context.sessionManager.getBranch();
    const { digest, transcript } = buildActorContext(
      branch as unknown[],
      this.#config.mesh.actorContextEntries,
      this.#config.mesh.eventContextChars,
    );
    const prepared = prepareFabricActorHostPayload(
      payload,
      this.#config.mesh.eventContextChars,
    );
    const preparedContext = prepareFabricActorHostPayload(
      { digest, transcript },
      this.#config.mesh.eventContextChars,
    ).payload;
    const safeContext = isPlainObject(preparedContext)
      ? preparedContext
      : { digest: {}, transcript: [String(preparedContext)] };
    return observed + this.#actors.dispatchObservedHostEvent(
      event,
      {
        event,
        session: { id: context.sessionManager.getSessionId(), cwd: context.cwd },
        digest: safeContext.digest ?? {},
        transcript: safeContext.transcript ?? [],
        signal: {
          payload: prepared.payload,
          ...(prepared.media.length > 0 ? { media: prepared.media } : {}),
          idle,
          observedAt: Date.now(),
        },
      },
      prepared.images,
    );
  }

  #observeComponentTransitions(componentId?: string): void {
    if (!this.#suppressResidentGuidanceSync) {
      this.#residency?.updateModelGuidance(this.modelGuidance());
    }
    let components: FabricComponentInfo[];
    if (componentId) {
      try {
        components = this.#componentSupervisor
          ? [this.#componentSupervisor.status(componentId)]
          : [];
      } catch {
        this.#componentTransitionSignatures.delete(componentId);
        return;
      }
    } else {
      components = this.#componentSupervisor?.list() ?? [];
    }
    const visible = componentId ? undefined : new Set<string>();
    for (const component of components) {
      visible?.add(component.id);
      const signature = [
        component.state,
        component.revision,
        component.targetDigest ?? "",
        component.missing.join("\u0000"),
        component.optionalMissing.join("\u0000"),
        component.error ?? "",
        component.cleanupErrors?.join("\u0000") ?? "",
        JSON.stringify(component.guidance ?? []),
      ].join("\u0001");
      if (this.#componentTransitionSignatures.get(component.id) === signature) continue;
      this.#componentTransitionSignatures.set(component.id, signature);
      const publication = this.publishHostLifecycle("component.state", component)
        .catch(() => undefined);
      this.#componentTransitionPublications.add(publication);
      void publication.finally(() => this.#componentTransitionPublications.delete(publication));
    }
    if (visible) {
      for (const id of this.#componentTransitionSignatures.keys()) {
        if (!visible.has(id)) this.#componentTransitionSignatures.delete(id);
      }
    }
  }

  async publishHostLifecycle(
    event: FabricLifecycleEventType,
    payload: unknown,
  ): Promise<void> {
    if (
      !this.#lifecycle ||
      !this.#identity ||
      this.#identity.kind !== "main" ||
      !this.#participants
    ) return;
    const self = this.#participants.self();
    const metadata = lifecycleMetadata(event, payload);
    await this.#lifecycle.publish({
      source: {
        id: self.id,
        name: self.name,
        kind: self.kind,
        rootId: self.rootId,
        runner: self.runner ?? "pi",
        ownerHostId: self.ownerHostId,
        ownerIdentityId: self.ownerIdentityId,
      },
      event,
      occurredAt: lifecycleObservedAt(payload),
      ...(metadata !== undefined ? { data: metadata } : {}),
    });
  }

  registerExternal(provider: FabricProvider, options: { overwrite?: boolean } = {}): void {
    if (this.#managedHost) {this.#managedHost.register(provider, options.overwrite); return;}
    if (
      provider.name === "fabric" ||
      provider.name === "components" ||
      FABRIC_COMPONENT_PROVIDER_NAMES.some((name) => name === provider.name)
    ) {
      throw new Error(`Reserved Fabric provider name: ${provider.name}`);
    }
    if (this.#externalProviders.has(provider.name) && !options.overwrite) {
      throw new Error(`Fabric provider already registered: ${provider.name}`);
    }
    this.#externalProviders.set(provider.name, provider);
    if (this.#registry) this.#registry.register(provider, options);
  }

  /** Withdraw a direct registration through the same retire/release path a
   * component lease uses. The host owns the instance, so it is not closed. */
  withdrawExternal(name: string, generation?: number | string): boolean {
    if (this.#managedHost) return false;
    const provider = this.#externalProviders.get(name);
    if (!provider) return false;
    const registry = this.#registry;
    const withdrawn = registry?.unregister(name, {
      provider,
      ...(generation !== undefined ? { generation } : {}),
      keepProviderOpen: true,
    });
    if (!withdrawn && generation !== undefined) return false;
    this.#externalProviders.delete(name);
    // Detached participants outlive invocations but not their provider.
    this.#providerParticipants.releaseProvider(name);
    return true;
  }

  registerExternalComponent(
    component: FabricComponentDefinition,
    options: { overwrite?: boolean } = {},
  ): void {
    if (this.#managedHost) throw new Error("Managed host component registration is disabled");
    if (component.name.startsWith(FABRIC_PROVIDER_COMPONENT_PREFIX)) {
      throw new Error(`Reserved Fabric component name: ${component.name}`);
    }
    this.componentCatalog.register(component, options);
  }

  async settleComponents(): Promise<void> {
    await this.#componentControl?.settle();
    await this.#componentLoader?.settle();
  }

  async shutdown(): Promise<void> {
    this.#completionInbox?.close();
    this.#completionInbox = undefined;
    this.#peerPresence?.close();
    this.#peerPresence = undefined;
    this.#shellInbox?.close();
    this.#shellInbox = undefined;
    this.#shellTiming?.close();
    this.#shellTiming = undefined;
    this.#suppressResidentGuidanceSync = true;
    await this.#deactivateRepairs();
    clearActiveCompiledSurface();
    this.#releaseProviderParticipants();
    await this.#participants?.quiesce().catch(() => undefined);
    this.#stopComponentWatch?.();
    this.#stopComponentWatch = undefined;
    await this.#componentControl?.close();
    this.#componentControl = undefined;
    this.#componentConfiguration = undefined;
    await this.#componentLoader?.close();
    await Promise.allSettled([...this.#componentTransitionPublications]);
    await this.#sessionCapabilityLease?.release().catch(() => undefined);
    this.#sessionCapabilityLease = undefined;
    await this.#lifecycle?.close();
    await this.#control?.close();
    await this.#residency?.close();
    const actorsFailure = await this.#closeActors();
    await this.#agents?.close();
    await this.shellJobs.close();
    try {
      await this.#registry?.close();
    } finally {
      await this.#participants?.close();
    }
    this.#registry = undefined;
    this.#config = undefined;
    this.#execution?.nativeCodemode.invalidate();
    this.#execution = undefined;
    this.#agents = undefined;
    this.#actors = undefined;
    this.#globalActors = undefined;
    this.#mesh = undefined;
    this.#identity = undefined;
    this.#mainAgent = undefined;
    this.#participants = undefined;
    this.#control = undefined;
    this.#lifecycle = undefined;
    this.#residency = undefined;
    this.#agentsProvider = undefined;
    this.#compact = undefined;
    this.#schema = undefined;
    this.#componentSupervisor = undefined;
    this.#componentLoader = undefined;
    this.#componentTransitionSignatures.clear();
    this.#componentTransitionPublications.clear();
    this.#sessionCapabilityLease = undefined;
    this.#unsubscribeCapturedCatalog?.();
    this.#unsubscribeCapturedCatalog = undefined;
    this.componentCatalog.clear();
    this.#builtinComponentNames.clear();
    this.#cwd = undefined;
    this.activity.reset();
    this.#widgetDismissedAt = 0;
    this.#externalProviders.clear();
    this.prewalk.cancel();
    this.prewalkDrift.clear();
    if (actorsFailure) throw actorsFailure.error;
  }

  // ActorManager.close() rejects when it cannot read the shared actor registry,
  // because saving then would overwrite other hosts' rows. Teardown must still
  // release everything after the actors, so callers report this failure once
  // the rest of teardown has run.
  async #closeActors(): Promise<{ error: unknown } | undefined> {
    try {
      await this.#actors?.close();
      return undefined;
    } catch (error) {
      return { error };
    }
  }

  // Publish a best-effort mesh event to the durable `fabric.compact` topic so
  // other roots, agents, and actors can observe compaction transitions.
  // Activity-only sessions (mesh disabled) silently skip this.
  #publishCompactEvent(kind: string, data: CompactPendingIntent | CompactLastCommit): void {
    if (!this.#mesh || !this.#identity || !this.#config?.mesh.enabled) return;
    try {
      void this.#mesh.publish({
        topic: "fabric.compact",
        kind,
        from: this.#identity,
        data,
      });
    } catch {
      // Best-effort: a full event log or an oversized payload must not break
      // the host compaction path.
    }
  }

  #refreshRepairCatalog(): void {
    if (!this.#repairs || !this.#registry) return;
    // Capture suspension (session_start, /fabric reload) clears the catalog
    // only transiently: the same tools refill on re-arm, so recomputing here
    // would flip the digest to an empty-catalog value that promotion could
    // then persist, destroying the stable catalog's table. Freeze the surface
    // instead; the refill re-commits it (or legitimately starts a new one).
    if (this.capturedTools.suspended) return;
    this.#repairs.setCatalogSurface({
      providers: this.#registry.providers().map((provider) => provider.name),
      capturedTools: this.capturedTools.list().map((entry) => entry.name),
    });
  }

  // Session teardown forgets provider participants; providers own their work.
  #releaseProviderParticipants(): void {
    this.#providerParticipants.releaseAll();
    this.#providerParticipants = new ProviderParticipantRegistry();
  }

  async #deactivateRepairs(): Promise<void> {
    const repairs = this.#repairs;
    this.#repairs = undefined;
    clearActiveRepairCompiler(repairs);
    await repairs?.flush();
  }

  async #closeInternal(): Promise<void> {
    this.#completionInbox?.close();
    this.#completionInbox = undefined;
    this.#shellInbox?.close();
    this.#shellInbox = undefined;
    this.#shellTiming?.close();
    this.#shellTiming = undefined;
    await this.shellJobs.close();
    await this.#deactivateRepairs();
    if (!this.#registry) return;
    this.#releaseProviderParticipants();
    await this.#participants?.quiesce().catch(() => undefined);
    this.#stopComponentWatch?.();
    this.#stopComponentWatch = undefined;
    await this.#componentControl?.close();
    this.#componentControl = undefined;
    this.#componentConfiguration = undefined;
    await this.#componentLoader?.close();
    await Promise.allSettled([...this.#componentTransitionPublications]);
    await this.#sessionCapabilityLease?.release().catch(() => undefined);
    this.#sessionCapabilityLease = undefined;
    await this.#lifecycle?.close();
    await this.#control?.close();
    await this.#residency?.close();
    const actorsFailure = await this.#closeActors();
    await this.#agents?.close();
    const externalNames = new Set(this.#externalProviders.keys());
    try {
      await this.#registry.close(externalNames);
    } finally {
      await this.#participants?.close();
    }
    this.#registry = undefined;
    this.#execution?.nativeCodemode.invalidate();
    this.#execution = undefined;
    this.#agents = undefined;
    this.#actors = undefined;
    this.#mesh = undefined;
    this.#identity = undefined;
    this.#mainAgent = undefined;
    this.#participants = undefined;
    this.#control = undefined;
    this.#lifecycle = undefined;
    this.#residency = undefined;
    this.#agentsProvider = undefined;
    this.#compact = undefined;
    this.#schema = undefined;
    this.#componentSupervisor = undefined;
    this.#componentLoader = undefined;
    this.#componentTransitionSignatures.clear();
    this.#componentTransitionPublications.clear();
    this.#sessionCapabilityLease = undefined;
    this.#unsubscribeCapturedCatalog?.();
    this.#unsubscribeCapturedCatalog = undefined;
    if (actorsFailure) {
      // Reinitialization goes on: the new generation reads the registry again,
      // and its own saves keep refusing until the file is repaired.
      const error = actorsFailure.error;
      console.warn(`[pi-fabric] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const scalarMetadata = (
  value: unknown,
  keys: readonly string[],
): Record<string, string | number | boolean | null> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    const nested = source[key];
    if (
      typeof nested === "string" ||
      typeof nested === "number" ||
      typeof nested === "boolean" ||
      nested === null
    ) metadata[key] = nested;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
};

const lifecycleMetadata = (
  event: FabricLifecycleEventType,
  payload: unknown,
): Record<string, string | number | boolean | null> | undefined => {
  switch (event) {
    case "pi.input":
      return scalarMetadata(payload, ["source", "streamingBehavior"]);
    case "pi.agent_end":
      return scalarMetadata(payload, ["willRetry"]);
    case "pi.turn_end":
      return scalarMetadata(payload, ["turnIndex", "timestamp"]);
    case "pi.tool_error":
      return scalarMetadata(payload, ["toolCallId", "toolName"]);
    case "pi.session_compact":
      return scalarMetadata(payload, ["reason", "willRetry"]);
    case "component.state":
      return scalarMetadata(payload, [
        "id",
        "component",
        "parentId",
        "state",
        "guarantee",
        "revision",
        "targetDigest",
      ]);
    default:
      return undefined;
  }
};

const lifecycleObservedAt = (payload: unknown): number => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return Date.now();
  const timestamp = (payload as Record<string, unknown>).timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : Date.now();
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const deepAssign = (
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void => {
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key];
  }
  for (const [key, value] of Object.entries(source)) {
    const targetValue = target[key];
    if (isPlainObject(value) && isPlainObject(targetValue)) {
      deepAssign(targetValue, value);
    } else {
      target[key] = value;
    }
  }
};
