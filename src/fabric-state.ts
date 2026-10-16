import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveAgentDir } from "./core/agent-dir.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { FabricActivityStore } from "./activity/store.js";
import { CapturedToolCatalog } from "./capture/catalog.js";
import {
  FABRIC_COMPONENT_PROVIDER_NAMES,
  FABRIC_PROVIDER_COMPONENT_PREFIX,
} from "./components/provider-component.js";
import { builtinModelGuidance } from "./components/builtin-guidance.js";
import type { FabricOwnedModelGuidance } from "./components/model-guidance.js";
import type { FabricComponentGraph } from "./components/types.js";
import {
  loadFabricConfig,
  loadFabricConfigForScope,
  type FabricConfig,
  type FabricResultFormat,
  type FabricSchemaMode,
} from "./config.js";
import { FabricSessionApprovals } from "./core/approval-controller.js";
import { readChildToolAllowlist } from "./core/child-tool-allowlist.js";
import { NO_FOREGROUND, resolveForegroundTools, type FabricForegroundResolution } from "./core/foreground-tools.js";
import { PrewalkController } from "./prewalk/controller.js";
import { PrewalkDriftTracker } from "./prewalk/fs-drift.js";
import type { FabricThinkingController } from "./thinking-control.js";
import { FABRIC_THINKING_ENTRY_TYPE } from "./thinking.js";
import type { PendingFabricHandoff } from "./prewalk/handoff.js";
import type { AgentToolResultMessage } from "./agents/types.js";
import type { FabricExecutionResult } from "./execution-service.js";
import type {
  FabricParticipantInfo,
  FabricParticipantListOptions,
  FabricPeerInfo,
} from "./topology/types.js";
import {
  resolveFabricIdentity,
  type FabricAgentMessageDelivery,
  type FabricAgentMessageResult,
  type FabricMainAgentInfo,
} from "./main-agent.js";
import type { FabricActorHostEvent } from "./actors/types.js";
import type { FabricLifecycleEventType } from "./lifecycle/types.js";
import type {
  FabricActionDescriptor,
  FabricComponentDefinition,
  FabricProvider,
} from "./protocol.js";
import type { FabricRuntimeState } from "./fabric-runtime-state.js";
import type { DecisionStore } from "./decisions/store.js";
import type { FabricRuntimePaths } from "./runtime-paths.js";
import type { FabricLoadedFileIdentity } from "./build-identity.js";

import { FabricManagedHost, type FabricManagedHostOptions } from "./managed-host.js";

export interface FabricStateOptions {
  managedHost?: FabricManagedHostOptions;
  paths?: FabricRuntimePaths;
  runtimeLoader?: () => Promise<typeof import("./fabric-runtime-state.js")>;
  entryIdentity?: FabricLoadedFileIdentity;
}

type ActivationHook = (context: ExtensionContext) => void | Promise<void>;
type ActivationFailureHook = () => void | Promise<void>;

export class FabricState {
  #runtime: FabricRuntimeState | undefined;
  #activatingRuntime: FabricRuntimeState | undefined;
  #activation: Promise<FabricRuntimeState> | undefined;
  #activationGeneration: number | undefined;
  #config: FabricConfig | undefined;
  #kernelReloadRequired = false;

  #cwd: string | undefined;
  #generation = 0;
  #everActivated = false;
  #activationHook: ActivationHook | undefined;
  #activationFailureHook: ActivationFailureHook | undefined;
  readonly #externalProviders = new Map<string, FabricProvider>();
  readonly #externalComponents = new Map<string, FabricComponentDefinition>();
  readonly #options: FabricStateOptions;
  readonly #managedHost: FabricManagedHost | undefined;
  readonly #entryIdentity: FabricLoadedFileIdentity | undefined;
  readonly activity = new FabricActivityStore();
  readonly prewalk = new PrewalkController();
  readonly prewalkDrift = new PrewalkDriftTracker();
  readonly sessionApprovals = new FabricSessionApprovals();
  // agent_end must revert an override even before activation; the controller
  // itself loads only when an override can exist.
  readonly thinking: FabricThinkingHost;
  #widgetDismissedAt = 0;

  constructor(
    readonly pi: ExtensionAPI,
    readonly capturedTools: CapturedToolCatalog,
    options: FabricStateOptions = {},
  ) {
    this.#options = options;
    this.#managedHost = options.managedHost ? new FabricManagedHost(options.managedHost) : undefined;
    this.#entryIdentity = options.entryIdentity;
    this.thinking = new FabricThinkingHost(async () => {
      const { FabricThinkingController } = await import("./thinking-control.js");
      return new FabricThinkingController(pi, () => this.#config?.thinking?.bounds ?? {});
    });
  }

  get kernelReloadRequired(): boolean {
    return this.#kernelReloadRequired;
  }

  get initialized(): boolean {
    return this.#current()?.initialized === true;
  }

  // Lightweight bootstrap seam: true once configuration is loaded, with no
  // dependency on the heavyweight runtime. Rendering reads this instead of
  // initialized so a resumed session honors bootstrapped presentation
  // preferences while the runtime is intentionally inactive.
  get bootstrapped(): boolean {
    return this.#config !== undefined;
  }

  get activated(): boolean {
    return this.#everActivated;
  }

  get config(): FabricConfig {
    if (!this.#config) throw new Error("Pi Fabric has not bootstrapped");
    return this.#config;
  }

  get cwd(): string | undefined {
    return this.#cwd;
  }

  /** Foreground tools declared beside fabric_exec. prepareLoadout passes its pending active set. */
  foregroundTools(active?: readonly string[]): FabricForegroundResolution {
    const config = this.#config;
    if (!config || config.foreground.tools.length === 0) return NO_FOREGROUND;
    return resolveForegroundTools({
      policy: config.foreground,
      mode: config.schema.mode === "enforce" ? "enforce" : config.fullCodeMode ? "full-code" : "orchestration",
      managedHost: this.#managedHost !== undefined,
      registered: this.pi.getAllTools(),
      active: new Set(active ?? this.pi.getActiveTools()),
      allowlist: readChildToolAllowlist(),
    });
  }

  get widgetDismissedAt(): number {
    return this.#current()?.widgetDismissedAt ?? this.#widgetDismissedAt;
  }

  set widgetDismissedAt(value: number) {
    this.#widgetDismissedAt = value;
    const runtime = this.#current();
    if (runtime) runtime.widgetDismissedAt = value;
  }

  get registry(): FabricRuntimeState["registry"] { return this.#required().registry; }
  get execution(): FabricRuntimeState["execution"] { return this.#required().execution; }

  /** Speculative-PTC stream tap; undefined pre-init or when speculation is disabled. */
  get speculationTap(): FabricRuntimeState["speculationTap"] { return this.#runtime?.speculationTap; }

  /** Turn-boundary backstop for the speculation store; safe before initialization. */
  resetSpeculation(): void { this.#runtime?.resetSpeculation(); }
  get agents(): FabricRuntimeState["agents"] { return this.#required().agents; }
  get actors(): FabricRuntimeState["actors"] { return this.#required().actors; }
  get shellJobs(): FabricRuntimeState["shellJobs"] | undefined { return this.#runtime?.shellJobs; }
  get globalActors(): FabricRuntimeState["globalActors"] { return this.#required().globalActors; }
  get mesh(): FabricRuntimeState["mesh"] { return this.#required().mesh; }
  get compact(): FabricRuntimeState["compact"] { return this.#required().compact; }
  get repairs(): FabricRuntimeState["repairs"] { return this.#required().repairs; }
  get components(): FabricRuntimeState["components"] { return this.#required().components; }

  setActivationHook(hook: ActivationHook, onFailure?: ActivationFailureHook): void {
    this.#activationHook = hook;
    this.#activationFailureHook = onFailure;
  }

  async bootstrap(context: ExtensionContext): Promise<void> {
    const generation = ++this.#generation;
    this.#cwd = context.cwd;
    // A failed config load must not leak the previous session's configuration
    // into this one: clear before the read so bootstrapped stays false and
    // presentation falls back to the safe default until a load succeeds.
    this.#config = undefined;
    const config = this.#managedHost?.config() ?? loadFabricConfig({
      cwd: context.cwd,
      agentDir: resolveAgentDir(),
      projectTrusted: context.isProjectTrusted(),
    });
    this.#config = config;
    this.#kernelReloadRequired = false;
    this.prewalk.cancel();
    this.prewalkDrift.clear();
    this.activity.reset();
    this.sessionApprovals.approvedRisks.clear();
    this.#widgetDismissedAt = 0;
    context.ui.setStatus("fabric-prewalk", undefined);

    const pending = this.#activation;
    if (pending) await pending.catch(() => undefined);
    if (generation !== this.#generation) return;
    if (this.#everActivated) await this.#activate(context, true);
  }

  async initialize(context: ExtensionContext): Promise<void> {
    if (!this.#config || this.#cwd !== context.cwd) {
      await this.bootstrap(context);
    } else {
      const next = this.#managedHost?.config() ?? loadFabricConfig({
        cwd: context.cwd,
        agentDir: resolveAgentDir(),
        projectTrusted: context.isProjectTrusted(),
      });
      this.#kernelReloadRequired = next.executor.kernel !== this.#config.executor.kernel;
      next.executor.kernel = this.#config.executor.kernel;
      this.#config = next;
    }
    await this.#activate(context, true);
  }

  async ensure(context: ExtensionContext): Promise<void> {
    if (!this.#config || this.#cwd !== context.cwd) await this.bootstrap(context);
    await this.#activate(context, false);
  }

  shouldEagerlyActivate(context: ExtensionContext): boolean {
    if (
      process.env.PI_FABRIC_CAPABILITY_REQUIREMENTS !== undefined &&
      Boolean(process.env.PI_FABRIC_CAPABILITY_DIGEST)
    ) return true;
    if (this.config.prewalk.alwaysRearm) return true;
    if (this.config.components.some((component) => component.disabled !== true)) return true;
    if (!context.isProjectTrusted() || !this.config.mesh.enabled || this.config.schema.mode === "enforce") {
      return false;
    }
    const sessionId = context.sessionManager.getSessionId();
    if (resolveFabricIdentity(sessionId).identity.kind !== "main") return false;
    const projectRoot = process.env.PI_FABRIC_PROJECT_ROOT ?? context.cwd;
    const meshRoot = process.env.PI_FABRIC_MESH_ROOT ??
      (this.config.mesh.root
        ? path.resolve(projectRoot, this.config.mesh.root)
        : path.join(projectRoot, ".pi", "fabric", "mesh"));
    const fabricSessionId = process.env.PI_FABRIC_SESSION_ID?.trim() || sessionId;
    const actorRoots = [
      path.join(meshRoot, "actors"),
      path.join(meshRoot, "actors", fabricSessionId),
    ];
    return actorRoots.some((actorRoot) => {
      try {
        const registry = JSON.parse(fs.readFileSync(path.join(actorRoot, "actors.json"), "utf8")) as unknown;
        if (typeof registry !== "object" || registry === null || Array.isArray(registry)) return false;
        const actors = (registry as { actors?: unknown }).actors;
        return Array.isArray(actors) && actors.some((value) => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
          const actor = value as Record<string, unknown>;
          return typeof actor.id === "string" && /^[a-f0-9]{32}$/.test(actor.id) &&
            typeof actor.name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,59}$/.test(actor.name) &&
            typeof actor.instructions === "string" &&
            Buffer.byteLength(actor.instructions, "utf8") <= this.config.mesh.maxEventBytes &&
            typeof actor.createdAt === "number" && Number.isFinite(actor.createdAt);
        });
      } catch {
        return false;
      }
    });
  }

  mainAgentInfo(context?: ExtensionContext): FabricMainAgentInfo { return this.#required().mainAgentInfo(context); }
  peerInfos(): FabricPeerInfo[] { return this.#current()?.peerInfos() ?? []; }
  /** Managed hosts do not expose decisions, matching the `decisions.*` provider. */
  decisionStore(): DecisionStore | undefined {
    return this.#managedHost ? undefined : this.#current()?.decisionStore();
  }
  componentGraph(): FabricComponentGraph {
    return this.#current()?.componentGraph() ?? { components: [], edges: [], cycles: [] };
  }
  modelGuidance(): FabricOwnedModelGuidance[] {
    // Built-in provider guidance is a pure function of configuration, so it is
    // already available before (and independent of) runtime activation.
    return this.#current()?.modelGuidance() ?? (this.#config ? builtinModelGuidance(this.#config) : []);
  }
  participantInfos(options: FabricParticipantListOptions = {}): FabricParticipantInfo[] {
    return this.#current()?.participantInfos(options) ?? [];
  }
  queueUserMessage(targetId: string, message: string, delivery: FabricAgentMessageDelivery): Promise<FabricAgentMessageResult> {
    return this.#required().queueUserMessage(targetId, message, delivery);
  }
  stopParticipant(targetId: string): Promise<unknown> { return this.#required().stopParticipant(targetId); }
  claimHandoff(execution: FabricExecutionResult, sessionId: string, resultFormat: FabricResultFormat, outerToolCallId: string): Promise<PendingFabricHandoff | undefined> {
    return this.#required().claimHandoff(execution, sessionId, resultFormat, outerToolCallId);
  }
  runHandoffAtBoundary(pending: PendingFabricHandoff, result: AgentToolResultMessage, context: ExtensionContext): Promise<Record<string, unknown>> {
    return this.#required().runHandoffAtBoundary(pending, result, context);
  }
  get advisorsHalted(): boolean { return this.#current()?.advisorsHalted ?? false; }
  haltAdvisors(): number { return this.#current()?.haltAdvisors() ?? 0; }
  noteMainActivity(context: ExtensionContext): void { this.#current()?.noteMainActivity(context); }
  dispatchHostEvent(event: FabricActorHostEvent, payload: unknown, context: ExtensionContext): number {
    return this.#current()?.dispatchHostEvent(event, payload, context) ?? 0;
  }
  publishHostLifecycle(event: FabricLifecycleEventType, payload: unknown): Promise<void> {
    return this.#current()?.publishHostLifecycle(event, payload) ?? Promise.resolve();
  }

  registerExternal(provider: FabricProvider, options: { overwrite?: boolean } = {}): void {
    if (this.#managedHost) {
      this.#managedHost.register(provider, options.overwrite);
      return;
    }
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
    this.#current()?.registerExternal(provider, options);
  }

  /** False when the name is unknown, managed, or the generation pin does not match. */
  withdrawExternal(name: string, generation?: number | string): boolean {
    if (this.#managedHost || !this.#externalProviders.has(name)) return false;
    // A generation pin needs a live binding to match; an unpinned withdrawal
    // also forgets registrations no runtime has mounted yet.
    const withdrawn = this.#current()?.withdrawExternal(name, generation) ?? false;
    if (!withdrawn && generation !== undefined) return false;
    this.#externalProviders.delete(name);
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
    if (this.#externalComponents.has(component.name) && !options.overwrite) {
      throw new Error(`Fabric component already registered: ${component.name}`);
    }
    this.#externalComponents.set(component.name, component);
    this.#current()?.registerExternalComponent(component, options);
  }

  /** Apply only the decision selector; existing program snapshots and policy stay intact. */
  setDecisionProfile(profile: string | null | undefined): void {
    const profiles = this.config.jev.decisionProfiles?.profiles;
    if (profile !== undefined && profile !== null &&
        (typeof profile !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(profile) ||
         ["__proto__", "prototype", "constructor"].includes(profile) || !profiles || !Object.hasOwn(profiles, profile))) {
      throw new Error("Decision profile must name a configured profile or use document default");
    }
    this.#runtime?.setDecisionProfile(profile);
    if (profile === undefined) delete this.config.jev.decisionProfile;
    else this.config.jev.decisionProfile = profile;
  }

  reloadConfig(context: ExtensionContext): void {
    const next = this.#managedHost?.config() ?? loadFabricConfig({
      cwd: context.cwd,
      agentDir: resolveAgentDir(),
      projectTrusted: context.isProjectTrusted(),
    });
    if (this.#config) {
      // Pi skill discovery is additive. Keep execution aligned with the loaded
      // skill tree until Pi reload creates a fresh extension/resource runtime.
      this.#kernelReloadRequired = next.executor.kernel !== this.#config.executor.kernel;
      next.executor.kernel = this.#config.executor.kernel;
      next.schema.mode = this.#config.schema.mode;
      // Isolate the selected language, including when a live schema override
      // differs from disk. CPython selects its OS sandbox at execution time.
      if (next.schema.mode === "enforce" && next.executor.kernel === "typescript") {
        next.executor.runtime = "quickjs";
      }
    }
    this.#config = next;
    this.#runtime?.reloadConfig(context, next);
  }

  // Ephemeral, session-only schema mode: mutates the live config (guidance,
  // resolved-action gate, and executor runtime all read it per call) without
  // touching fabric.json, so the next session starts from the configured mode.
  // reloadConfig preserves the override like the startup mode does.
  setSchemaMode(context: ExtensionContext, mode: FabricSchemaMode): void {
    if (this.#managedHost) throw new Error("Managed host policy is immutable");
    if (!this.#config) throw new Error("Fabric is not initialized");
    const previous = this.#config.schema.mode;
    if (mode === "enforce" && previous !== "enforce" && !this.#config.fullCodeMode) {
      throw new Error(
        "Schema enforce requires full code mode; enable fullCodeMode or start a session with schema.mode=enforce",
      );
    }
    this.#config.schema.mode = mode;
    if (mode === "enforce") {
      if (this.#config.executor.kernel === "typescript") this.#config.executor.runtime = "quickjs";
    } else if (previous === "enforce") {
      this.#config.executor.runtime = this.#diskConfig(context).executor.runtime;
    }
    this.#runtime?.setSchemaMode(mode, this.#config.executor.runtime);
  }

  schemaStatus(context: ExtensionContext): {
    mode: FabricSchemaMode;
    source: "config" | "session override";
    executorRuntime: string;
  } {
    const disk = this.#diskConfig(context);
    const mode = this.#config?.schema.mode ?? disk.schema.mode;
    return {
      mode,
      source: this.#config && this.#config.schema.mode !== disk.schema.mode
        ? "session override"
        : "config",
      executorRuntime: (this.#config ?? disk).executor.kernel === "python"
        ? (this.#config ?? disk).executor.pythonRuntime
        : this.#config?.executor.runtime ?? disk.executor.runtime,
    };
  }

  #diskConfig(context: ExtensionContext): FabricConfig {
    if (this.#managedHost) return this.#managedHost.config();
    const projectTrusted = context.isProjectTrusted();
    return loadFabricConfigForScope(
      { cwd: context.cwd, agentDir: resolveAgentDir(), projectTrusted },
      projectTrusted ? "project" : "global",
    );
  }

  async shutdown(): Promise<void> {
    const generation = ++this.#generation;
    const activation = this.#activation;
    if (activation) await activation.catch(() => undefined);
    if (generation !== this.#generation) return;

    const runtime = this.#runtime;
    this.#runtime = undefined;
    try {
      await runtime?.shutdown();
      await this.#managedHost?.close();
    } finally {
      if (generation === this.#generation) {
        this.#config = undefined;
        this.#cwd = undefined;
        this.#externalProviders.clear();
        this.#externalComponents.clear();
        this.#everActivated = false;
        this.activity.reset();
        this.prewalk.cancel();
        this.prewalkDrift.clear();
      }
    }
  }

  async #activate(context: ExtensionContext, reinitialize: boolean): Promise<FabricRuntimeState> {
    if (this.#activation) {
      if (this.#activationGeneration === this.#generation) return this.#activation;
      await this.#activation.catch(() => undefined);
      return this.#activate(context, reinitialize);
    }
    if (this.#runtime?.initialized && !reinitialize) return this.#runtime;

    const generation = this.#generation;
    const config = this.config;
    const existing = this.#runtime;
    const reusable = existing?.initialized ? existing : undefined;
    const orphan = existing && !existing.initialized ? existing : undefined;
    this.#runtime = undefined;
    let candidate: FabricRuntimeState | undefined;
    const assertCurrent = (): void => {
      if (generation !== this.#generation) {
        throw new Error("Pi Fabric activation was superseded by a session change");
      }
    };
    const activation = (async () => {
      try {
        await orphan?.shutdown().catch(() => undefined);
        assertCurrent();
        candidate = reusable ?? await this.#createRuntime();
        if (!reusable) {
          for (const component of this.#externalComponents.values()) {
            candidate.registerExternalComponent(component, { overwrite: true });
          }
        }
        // Bootstrap stays cheap and may precede first use by minutes. Refresh only
        // the component plane here; executor/language policy remains bootstrapped.
        if (!this.#managedHost && !reinitialize) {
          const { FabricComponentConfiguration } = await import("./components/configuration.js");
          try {
            config.components = new FabricComponentConfiguration({
              cwd: context.cwd, agentDir: resolveAgentDir(), projectTrusted: () => context.isProjectTrusted(),
            }).read().entries;
          } catch (error) {
            // Keep the bootstrapped manifest usable for repair. The live control
            // plane records this read failure and watches for a corrected file.
            if (context.hasUI) context.ui.notify(`Pi Fabric component configuration not applied: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
        }
        await candidate.initialize(context, config);
        assertCurrent();
        for (const provider of this.#externalProviders.values()) {
          candidate.registerExternal(provider, { overwrite: true });
        }
        await candidate.settleComponents?.();
        assertCurrent();
        this.#activatingRuntime = candidate;
        candidate.widgetDismissedAt = this.#widgetDismissedAt;
        await this.#activationHook?.(context);
        assertCurrent();
        this.#runtime = candidate;
        this.#activatingRuntime = undefined;
        this.#everActivated = true;
        return candidate;
      } catch (error) {
        try {
          await this.#activationFailureHook?.();
        } catch {
          // Cleanup is best-effort; preserve the activation failure.
        }
        if (this.#activatingRuntime === candidate) this.#activatingRuntime = undefined;
        if (candidate) await candidate.shutdown().catch(() => undefined);
        if (this.#runtime === candidate) this.#runtime = undefined;
        throw error;
      }
    })();
    this.#activation = activation;
    this.#activationGeneration = generation;
    void activation.finally(() => {
      if (this.#activation === activation) {
        this.#activation = undefined;
        this.#activationGeneration = undefined;
      }
    }).catch(() => undefined);
    return activation;
  }

  async #createRuntime(): Promise<FabricRuntimeState> {
    const module = await (this.#options.runtimeLoader?.() ?? import("./fabric-runtime-state.js"));
    return new module.FabricRuntimeState(
      this.pi,
      this.capturedTools,
      {
        ...(this.#managedHost ? {managedHost: this.#managedHost} : {}),
        activity: this.activity,
        prewalk: this.prewalk,
        prewalkDrift: this.prewalkDrift,
        sessionApprovals: this.sessionApprovals,
        thinking: await this.thinking.load(),
        ...(this.#options.paths ? { paths: this.#options.paths } : {}),
        ...(this.#entryIdentity ? { entryIdentity: this.#entryIdentity } : {}),
        foregroundTools: () => this.foregroundTools().tools,
      },
    );
  }

  #current(): FabricRuntimeState | undefined {
    return this.#runtime ?? this.#activatingRuntime;
  }

  #required(): FabricRuntimeState {
    const runtime = this.#current();
    if (!runtime?.initialized) throw new Error("Pi Fabric has not activated");
    return runtime;
  }
}

type ThinkingHookContext = Pick<ExtensionContext, "sessionManager" | "model">;

/** True when the active branch's latest Fabric thinking entry holds an override. */
const branchHasThinkingOverride = (context: ThinkingHookContext): boolean => {
  const branch = context.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== FABRIC_THINKING_ENTRY_TYPE) continue;
    const data = entry.data as { override?: unknown } | undefined;
    return data?.override !== null && data?.override !== undefined;
  }
  return false;
};

/**
 * Lazy front for the host thinking controller. Before first use an override
 * can only come from a persisted session entry, so lifecycle hooks scan the
 * branch instead of loading the controller module.
 */
export class FabricThinkingHost {
  #controller: FabricThinkingController | undefined;
  #loading: Promise<FabricThinkingController> | undefined;

  constructor(private readonly create: () => Promise<FabricThinkingController>) {}

  load(): Promise<FabricThinkingController> {
    this.#loading ??= this.create().then((controller) => {
      this.#controller = controller;
      return controller;
    });
    return this.#loading;
  }

  invalidate(): void {
    this.#controller?.invalidate();
  }

  async agentEnded(context: ThinkingHookContext): Promise<void> {
    if (!this.#controller && !branchHasThinkingOverride(context)) return;
    (await this.load()).agentEnded(context);
  }

  async enforceBounds(context: ThinkingHookContext): Promise<void> {
    (await this.load()).enforceBounds(context);
  }
}
