import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapturedToolCatalog } from "./capture/catalog.js";
import { createProviderComponent, type FabricProviderComponent, type FabricProviderComponentManifest } from "./components/provider-component.js";
import type { FabricConfig } from "./config.js";
import type { ActionRegistry } from "./core/action-registry.js";
import { resolveAgentDir } from "./core/agent-dir.js";
import { createConfiguredMemorySourceRegistry } from "./memory/fs-source.js";
import type { MeshStore, MeshIdentity } from "./mesh/store.js";
import type { ParticipantDirectory } from "./topology/participant-directory.js";
import { CapturedToolsProvider } from "./providers/captured-tools-provider.js";
import { McpDescriptorCacheStore, mcpDescriptorCachePath } from "./providers/mcp-descriptor-cache.js";
import { McpProvider } from "./providers/mcp-provider.js";
import { PiNativeMcpTools } from "./providers/pi-native-mcp.js";
import { isSelectedNativeMcpTool } from "./core/native-mcp-identity.js";
import type { MemoryProviderContext } from "./providers/memory-provider.js";
import { WorkerMemoryProvider } from "./memory/worker-provider.js";
import { MeshProvider } from "./providers/mesh-provider.js";
import { DecisionsProvider } from "./providers/decisions-provider.js";
import { DecisionStore } from "./decisions/store.js";
import { PiToolsProvider } from "./providers/pi-tools-provider.js";
import { powerShellToolDefinitionFactory } from "./providers/pi-bash-cwd.js";
import type { FabricShellJobStore } from "./core/shell-jobs.js";
import { SessionsProvider, toolCallShellPreflight } from "./providers/sessions-provider.js";
import { TasksProvider } from "./providers/tasks-provider.js";
import type { ObservationSource } from "./core/observation-actions.js";
import { StateProvider } from "./providers/state-provider.js";

import type { FabricManagedHost } from "./managed-host.js";

/** Built-in provider recipes and policy; the runtime chooses installation order. */
export class RuntimeStateBuiltins {
  /** Installed only with a jev-fabric bridge: off Windows, outside managed hosts. */
  #sessions = false;
  constructor(
    private readonly manifest: FabricProviderComponentManifest,
    private readonly registry: ActionRegistry,
    private readonly onInstalled: (name: string) => void,
    private readonly managedHost?: FabricManagedHost,
  ) {}

  async install(component: FabricProviderComponent): Promise<void> {
    await this.manifest.install(this.managedHost?.component(component) ?? component);
    this.onInstalled(component.definition.name);
  }

  async tools(
    cwd: string,
    config: FabricConfig,
    capturedTools: CapturedToolCatalog,
    shell: { jobs: FabricShellJobStore; getHangMs: () => number; observations?: ObservationSource },
  ): Promise<void> {
    let mcpProvider: McpProvider | undefined;
    const enforceSchema = config.schema.mode === "enforce";
    const effectiveFullCodeMode = config.fullCodeMode || enforceSchema;
    // Enforce keeps this provider private to the Pi adapter: core overrides
    // still resolve through pi.* while the schema authorizer blocks protected
    // mutations and external effects. Do not expose the generic extensions.*
    // namespace in enforce mode.
    const capturedToolsProvider =
      effectiveFullCodeMode && (config.capture.enabled || enforceSchema)
        ? new CapturedToolsProvider(capturedTools, entry => config.mcp.enabled && isSelectedNativeMcpTool(entry.definition, config.mcp.nativeServers))
        : undefined;
    if (effectiveFullCodeMode) {
      await this.install(createProviderComponent({
        provider: "pi",
        description: "Pi core tools adapter",
        create: () => new PiToolsProvider(
          cwd,
          capturedTools,
          capturedToolsProvider,
          this.managedHost
            ? {requireCapturedOverrides: true, powerShellToolDefinitionFactory: undefined}
            : {
                powerShellToolDefinitionFactory,
                shellJobs: shell.jobs, getShellHangMs: shell.getHangMs,
                requireToolHooks: () => this.registry.hostPolicy?.active === true,
              },
        ),
      }));
    }
    if (effectiveFullCodeMode && !this.managedHost) {
      await this.install(createProviderComponent({
        provider: "tasks", description: "Session-owned shell tasks and monitors",
        create: () => new TasksProvider(shell.jobs, shell.observations),
      }));
      // Interactive children need jev-fabric, which exists only off Windows and outside managed hosts.
      const durable = shell.jobs.durable;
      if (durable) {
        this.#sessions = true;
        await this.install(createProviderComponent({
          provider: "sessions", description: "Interactive jev-fabric children: open, write, read, wait and stop",
          create: () => new SessionsProvider(durable, {
            cwd,
            shellOverride: () => capturedTools.get("bash") !== undefined,
            preflight: toolCallShellPreflight(() => capturedTools.runner, () => capturedTools.runnerUnavailable),
          }),
        }));
      }
    }
    await this.install(createProviderComponent({
      provider: "mcp",
      description: "MCP runtime and descriptor cache",
      create: () => new McpProvider(cwd, config.mcp, {
        ...(config.mcp.nativeServers?.length
          ? { native: new PiNativeMcpTools(capturedTools, config.mcp.nativeServers, config.mcp.callTimeoutMs) }
          : {}),
        ...(config.mcp.cache.enabled
          ? {
              cache: new McpDescriptorCacheStore(mcpDescriptorCachePath(cwd)),
            }
          : {}),
        hooks: {
          onSliceChanged: () => {
            this.registry.notifyCatalogChanged("mcp");
          },
        },
      }),
      mounted: (provider) => { mcpProvider = provider; },
      unmounted: (provider) => {
        if (mcpProvider === provider) mcpProvider = undefined;
      },
      start: (provider) => { provider.warmup(); },
    }));
    if (capturedToolsProvider && !enforceSchema) {
      await this.install(createProviderComponent({
        provider: "extensions",
        description: "Captured extension tool catalog",
        create: () => capturedToolsProvider,
      }));
    }
  }

  async mesh(config: FabricConfig, mesh: MeshStore, identity: MeshIdentity, participants: ParticipantDirectory): Promise<void> {
    if (this.managedHost) {
      for (const provider of ["mesh", "state"]) {
        if (this.managedHost.has(provider)) await this.install(createProviderComponent({provider, description: "Managed scoped provider", create: () => this.managedHost!.provider(provider)}));
        else this.registry.markUnavailable(provider, "unavailable in managed host");
      }
    } else if (config.mesh.enabled) {
      await this.install(createProviderComponent({
        provider: "mesh",
        description: "Project mesh and participant directory",
        create: () => new MeshProvider(mesh, identity, participants),
      }));
      await this.install(createProviderComponent({
        provider: "state",
        description: "Labeled world state over the project mesh",
        requires: ["mesh.get"],
        create: () => new StateProvider(mesh, identity, { schemaMode: config.schema.mode }),
      }));
      await this.install(createProviderComponent({
        provider: "decisions",
        description: "Durable pending decisions over the project mesh",
        requires: ["mesh.get"],
        create: () => new DecisionsProvider(new DecisionStore(mesh, identity), identity, config.executor.maxTimeoutMs),
      }));
    } else {
      const meshDisabled =
        'disabled by configuration (mesh.enabled=false); set "mesh": { "enabled": true } in .pi/fabric.json or the agent fabric.json';
      this.registry.markUnavailable("mesh", `${meshDisabled} to enable mesh.* actions`);
      this.registry.markUnavailable("state", `${meshDisabled}; state.* actions run on the mesh`);
      this.registry.markUnavailable("decisions", `${meshDisabled}; decisions.* actions run on the mesh`);
    }
  }

  async memory(context: ExtensionContext, config: FabricConfig, sessionId: string): Promise<void> {
    if (this.managedHost?.has("memory")) {
      await this.install(createProviderComponent({provider: "memory", description: "Managed current-session recall", create: () => this.managedHost!.provider("memory")}));
    } else if (config.memory.enabled) {
      const sessionFile = context.sessionManager.getSessionFile();
      const sources = config.memory.sources && config.memory.sources.length > 0
        ? createConfiguredMemorySourceRegistry(config.memory.sources)
        : undefined;
      const memoryContext: MemoryProviderContext = {
        agentDir: resolveAgentDir(),
        cwd: context.cwd,
        config: config.memory,
        sessionId,
        ...(sessionFile ? { sessionFile } : {}),
        ...(sources ? { sources } : {}),
        getLiveBranch: () => ({
          entries: context.sessionManager.getBranch(),
          leafId: context.sessionManager.getLeafId(),
        }),
      };
      await this.install(createProviderComponent({
        provider: "memory",
        description: "Session memory index and source hydration",
        create: () => new WorkerMemoryProvider(memoryContext),
      }));
    } else {
      this.registry.markUnavailable(
        "memory",
        'disabled by configuration (memory.enabled=false); set "memory": { "enabled": true } in .pi/fabric.json or the agent fabric.json to enable memory.* actions',
      );
    }
  }

  assertActive(config: FabricConfig): void {
    const expectedBuiltinProviders = new Set<string>([
      ...(config.fullCodeMode || config.schema.mode === "enforce" ? ["pi", ...(!this.managedHost ? ["tasks"] : [])] : []),
      ...(this.#sessions ? ["sessions"] : []),
      ...(config.fullCodeMode && config.capture.enabled && config.schema.mode !== "enforce" ? ["extensions"] : []),
      "mcp",
      ...(config.mesh.enabled ? ["mesh", "state"] : ["mesh", "state"].filter((name) => this.managedHost?.has(name))),
      ...(config.mesh.enabled && !this.managedHost ? ["decisions"] : []),
      "schema",
      "compact",
      ...(!this.managedHost ? ["cache", "thinking", "programs"] : []),
      "prewalk",
      "agents",
      ...(!this.managedHost && config.jev.enabled && config.schema.mode !== "enforce" ? ["jev"] : []),
      ...(config.memory.enabled || this.managedHost?.has("memory") ? ["memory"] : []),
    ]);
    this.manifest.assertActive(expectedBuiltinProviders, this.registry);
  }
}
