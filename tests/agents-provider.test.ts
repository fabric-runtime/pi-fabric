import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachedMonitors } from "../src/core/attached-monitors.js";
import { FabricShellJobStore } from "../src/core/shell-jobs.js";
import { TasksProvider } from "../src/providers/tasks-provider.js";
import { ActorManager } from "../src/actors/manager.js";
import type { FabricActorInfo, FabricActorRequest } from "../src/actors/types.js";
import { GlobalActorRegistry } from "../src/actors/global-registry.js";
import { LifecycleBroker } from "../src/lifecycle/broker.js";
import type {
  FabricLifecycleEvent,
  FabricLifecycleSubscription,
} from "../src/lifecycle/types.js";
import {
  DEFAULT_FABRIC_CONFIG,
  type FabricAgentConfig,
  type FabricModelsConfig,
} from "../src/config.js";
import type {
  FabricMainAgentDeliveryRequest,
  FabricMainAgentTarget,
} from "../src/main-agent.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import type {
  FabricParticipantInfo,
  FabricParticipantSource,
  FabricPeerInfo,
} from "../src/topology/types.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import { FabricControlPlane } from "../src/topology/control-plane.js";
import { AgentsProvider, collectAgentToolPreviewNodes } from "../src/providers/agents-provider.js";
import { ResidencyClient } from "../src/residency/client.js";
import { RESIDENT_HOST_FORMAT, residentRoot } from "../src/residency/protocol.js";
import { Value } from "typebox/value";
import {
  EXACT_MODEL_FORM_ERROR,
  EXACT_MODEL_RUNNER_ERROR,
  normalizeModelAliases,
  resolvePiModelSelector,
} from "../src/core/model-resolution.js";
import { snapshotHandoffSession } from "../src/agents/handoff.js";
import { AgentManager } from "../src/agents/manager.js";
import type { AgentRunRecord } from "../src/agents/types.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { clearActiveCompiledSurface, setActiveCompiledSurface } from "../src/entropy/active.js";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";
import { registerAgentRunner, type FabricHostedRunner, type FabricRunnerCapabilities } from "../src/runners.js";

const roots: string[] = [];
const actorManagers: ActorManager[] = [];
const agentManagers: AgentManager[] = [];
const controlPlanes: FabricControlPlane[] = [];

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const visiblePiModels = [
  { provider: "anthropic", id: "executor", name: "Executor" },
  { provider: "anthropic", id: "frontier", name: "Frontier" },
  { provider: "provider", id: "project" },
  { provider: "provider", id: "project-default" },
  { provider: "provider", id: "one-off" },
  { provider: "provider", id: "session" },
  { provider: "provider", id: "model-a" },
  { provider: "provider", id: "model-b" },
];

const visibleModelRegistry = {
  getAvailable: () => visiblePiModels,
  find: (provider: string, id: string) =>
    visiblePiModels.find((model) => model.provider === provider && model.id === id),
};

const context: FabricInvocationContext = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "test",
  nestedToolCallId: "nested",
  extensionContext: { modelRegistry: visibleModelRegistry } as unknown as ExtensionContext,
  update() {},
  activity() {},
};

const setup = (
  peers: FabricPeerInfo[] = [],
  members: FabricParticipantInfo[] = [],
  control?: FabricControlPlane,
  options?: {
    switchModel?: FabricMainAgentTarget["switchModel"];
    modelsConfig?: FabricModelsConfig;
    agentsConfig?: Partial<FabricAgentConfig>;
    preparePiModel?: (
      model: string | undefined,
      options?: { modelMatch?: "exact" },
    ) => Promise<string | void>;
  },
) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-agents-provider-"));
  roots.push(root);
  const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 100);
  const agents = new AgentManager(
    process.cwd(),
    { ...DEFAULT_FABRIC_CONFIG.agents, ...options?.agentsConfig },
    {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      claudeBinary: path.resolve("tests/fixtures/fake-claude.mjs"),
      vedaBinary: path.resolve("tests/fixtures/fake-veda.mjs"),
      runRoot: path.join(root, "runs"),
      ...(options?.preparePiModel ? { preparePiModel: options.preparePiModel } : {}),
    },
  );
  agentManagers.push(agents);
  const identity: MeshIdentity = {
    id: "session:test",
    name: "main",
    kind: "main",
    sessionId: "test",
  };
  const meshConfig = { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 };
  const mainDeliveries: FabricMainAgentDeliveryRequest[] = [];
  const mainAgent = {
    id: identity.id,
    local: true,
    matches: (id: string) => id === "main" || id === identity.id,
    info: () => ({
      id: identity.id,
      name: "Main" as const,
      kind: "main" as const,
      status: "idle" as const,
      runner: "pi" as const,
      transport: "host" as const,
      cwd: process.cwd(),
      sessionId: "test",
      startedAt: 1,
      updatedAt: 1,
      pendingMessages: false,
      local: true,
    }),
    deliverAgent: (request: FabricMainAgentDeliveryRequest) => {
      mainDeliveries.push(request);
      return {
        queued: true as const,
        messageId: `main-message-${mainDeliveries.length}`,
        routed: "main" as const,
      };
    },
    ...(options?.switchModel ? { switchModel: options.switchModel } : {}),
  };
  const actors = new ActorManager("test", identity, mesh, meshConfig, agents, () => {}, {
    actorRoot: path.join(root, "actors"),
    persistent: true,
    mainAgent,
  });
  actorManagers.push(actors);
  const globalActors = new GlobalActorRegistry(root, 64 * 1024);
  const participants: FabricParticipantSource = {
    list: (options = {}) =>
      members.filter(
        (participant) =>
          (!options.kinds || options.kinds.includes(participant.kind)) &&
          (options.scope !== "local" || participant.local) &&
          (options.scope !== "lineage" || participant.rootId === identity.id),
      ),
    get: (id) => members.find((participant) => participant.id === id),
    self: () => ({
      format: 1,
      id: identity.id,
      kind: "root",
      rootId: identity.id,
      ownerHostId: identity.id,
      ownerIdentityId: identity.id,
      name: "main",
      status: "idle",
      runner: "pi",
      transport: "host",
      capabilities: ["steer", "followUp", "fabric"],
      cwd: process.cwd(),
      sessionId: "test",
      startedAt: 1,
      updatedAt: 1,
      pendingMessages: false,
      controlProtocol: "v1",
      local: true,
      stale: false,
    }),
    peers: () => peers,
    async refresh() {},
    scheduleRefresh() {},
  };
  let provider: AgentsProvider;
  const lifecycle = new LifecycleBroker(
    mesh,
    identity,
    participants,
    { enabled: true, pollMs: 20, maxReadEvents: 100 },
    async (subscription, event) => provider.deliverLifecycle(subscription, event),
  );
  provider = new AgentsProvider(
    agents,
    actors,
    globalActors,
    mainAgent,
    participants,
    control,
    lifecycle,
    undefined,
    undefined,
    undefined,
    () => options?.modelsConfig ?? DEFAULT_FABRIC_CONFIG.models,
  );
  return {
    root,
    mesh,
    identity,
    mainAgent,
    participants,
    control,
    lifecycle,
    actors,
    agents,
    globalActors,
    provider,
    mainDeliveries,
  };
};

describe("AgentsProvider observation", () => {
  it("shares task observation without replacing lifecycle subscriptions or invoking an agent", async () => {
    const { provider, agents } = setup();
    const jobs = new FabricShellJobStore();
    const observations = new AttachedMonitors(jobs, {
      get: id => id === "local-run" ? { id, generation: "run-1", name: "Worker", status: "running", terminal: false, progress: { turns: 1 } } : undefined,
      subscribe: () => () => {},
    });
    const spawn = vi.spyOn(agents, "spawn");
    try {
      expect(await provider.describe("observe", context)).toBeUndefined();
      provider.observations = () => observations;
      expect((await provider.list({}, context)).map(d => d.name)).toContain("observe");
      expect(await provider.describe("subscribe", context)).toBeDefined();
      const result = await provider.invoke("observe", { id: "local-run", delivery: "ui" }, context) as { task: { id: string; observes: unknown } };
      expect(result.task.observes).toEqual({ kind: "participant", id: "local-run" });
      expect(spawn).not.toHaveBeenCalled();
      await expect(provider.invoke("observe", { id: "local-run", delivery: "ui", match: "secret" }, context)).rejects.toThrow("Invalid agents.observe");
      expect(await new TasksProvider(jobs).invoke("stop", { id: result.task.id }, context)).toMatchObject({ stopped: true });
      expect(jobs.get(result.task.id)!.abort.signal.aborted).toBe(true);
    } finally { observations.close(); await jobs.close(); }
  });
});

describe("AgentsProvider runtime ownership lifecycle", () => {
  it("does not close shared runtime services when it is not the owner", async () => {
    const { agents, actors, globalActors, mainAgent, participants, control, lifecycle } = setup();
    const provider = new AgentsProvider(
      agents, actors, globalActors, mainAgent, participants, control, lifecycle,
      undefined, undefined, false,
    );
    const closeLifecycle = vi.spyOn(lifecycle, "close");
    const closeActors = vi.spyOn(actors, "close");
    const closeAgents = vi.spyOn(agents, "close");
    await provider.close();
    expect(closeLifecycle).not.toHaveBeenCalled();
    expect(closeActors).not.toHaveBeenCalled();
    expect(closeAgents).not.toHaveBeenCalled();
  });

  it("closes agents even if actor shutdown fails, after stopping lifecycle delivery", async () => {
    const { provider, agents, actors, lifecycle } = setup();
    const failure = new Error("actor shutdown failed");
    const order: string[] = [];
    vi.spyOn(lifecycle, "close").mockImplementationOnce(async () => { order.push("lifecycle"); });
    vi.spyOn(actors, "close").mockImplementationOnce(async () => {
      order.push("actors");
      throw failure;
    });
    vi.spyOn(agents, "close").mockImplementationOnce(async () => { order.push("agents"); });
    await expect(provider.close()).rejects.toBe(failure);
    expect(order).toEqual(["lifecycle", "actors", "agents"]);
  });
});

afterEach(async () => {
  await Promise.all(controlPlanes.splice(0).map((control) => control.close()));
  await Promise.all(actorManagers.splice(0).map((manager) => manager.close()));
  await Promise.all(agentManagers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for actor state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const createRequest = {
  name: "reviewer",
  instructions: "Review code for security defects and reply concisely.",
  events: ["turn_end"],
  delivery: "steer",
  responseMode: "directive",
  triggerTurn: false,
};

const lifecycleSubscription = (
    overrides: Partial<FabricLifecycleSubscription> = {},
  ): FabricLifecycleSubscription => ({
    format: 1,
    id: `sub-${Math.random().toString(36).slice(2, 8)}`,
    from: "session:source",
    events: ["run.completed"],
    to: "session:test",
    delivery: "followUp",
    triggerTurn: true,
    once: false,
    afterSequence: 0,
    createdAt: 1,
    updatedAt: 1,
    createdBy: { id: "session:source", name: "source", kind: "main" },
    ...overrides,
  });

  const lifecycleEvent = (
    overrides: Partial<FabricLifecycleEvent> = {},
  ): FabricLifecycleEvent => ({
    version: 1,
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    sequence: Math.floor(Math.random() * 10_000),
    event: "run.completed",
    source: {
      id: "session:source",
      name: "Peer source",
      kind: "root",
      rootId: "session:source",
      runner: "pi",
      ownerHostId: "session:source",
      ownerIdentityId: "session:source",
    },
    occurredAt: Date.now(),
    publishedAt: Date.now(),
    ...overrides,
  });

  describe("AgentsProvider lifecycle coalescing", () => {
    it("coalesces a burst of followUp lifecycle events into one wake delivery", async () => {
      const { provider, mainDeliveries } = setup();
      for (let index = 0; index < 5; index += 1) {
        await provider.deliverLifecycle(
          lifecycleSubscription(),
          lifecycleEvent({ source: { ...lifecycleEvent().source, id: `agent-${index}`, name: `worker-${index}` } }),
        );
      }
      await provider.flushLifecycleDeliveries();
      expect(mainDeliveries.length).toBe(1);
      const delivery = mainDeliveries[0]!;
      expect(delivery.delivery).toBe("followUp");
      expect(delivery.triggerTurn).toBe(true);
      expect(delivery.message).toContain("Fabric lifecycle events (5)");
      expect(delivery.message).toContain("worker-0");
      expect(delivery.message).toContain("worker-4");
    });

    it("delivers steer lifecycle events immediately without coalescing", async () => {
      const { provider, mainDeliveries } = setup();
      await provider.deliverLifecycle(
        lifecycleSubscription({ delivery: "steer" }),
        lifecycleEvent(),
      );
      await provider.flushLifecycleDeliveries();
      expect(mainDeliveries.length).toBe(1);
      expect(mainDeliveries[0]!.delivery).toBe("steer");
    });

    it("keeps separate targets on separate wake deliveries", async () => {
      const { provider, mainDeliveries } = setup();
      await provider.deliverLifecycle(
        lifecycleSubscription({ to: "session:test" }),
        lifecycleEvent(),
      );
      await provider.deliverLifecycle(
        lifecycleSubscription({ to: "main" }),
        lifecycleEvent(),
      );
      await provider.flushLifecycleDeliveries();
      expect(mainDeliveries.length).toBe(2);
    });

    it("keeps single-event deliveries in the original message format", async () => {
      const { provider, mainDeliveries } = setup();
      await provider.deliverLifecycle(
        lifecycleSubscription(),
        lifecycleEvent({ runId: "run-12345678", status: "completed" }),
      );
      await provider.flushLifecycleDeliveries();
      expect(mainDeliveries.length).toBe(1);
      expect(mainDeliveries[0]!.message).toBe(
        "Fabric lifecycle run.completed from Peer source (session:source) (run run-1234) with status completed.",
      );
      expect(mainDeliveries[0]!.message).not.toContain("Fabric lifecycle events");
    });
  });

describe("AgentsProvider runner support", () => {
  it("exposes model-programmable residency on spawn and create", async () => {
    const { provider } = setup();
    const spawn = await provider.describe("spawn", context);
    const create = await provider.describe("create", context);
    const run = await provider.describe("run", context);
    const spawnProperties = (spawn?.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    const createProperties = (create?.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    const runProperties = (run?.inputSchema as { properties: Record<string, unknown> }).properties;

    expect(spawnProperties.residency?.enum).toEqual(["session", "durable"]);
    expect(createProperties.residency?.enum).toEqual(["session", "durable"]);
    expect(runProperties).not.toHaveProperty("residency");
  });

  it("exposes actor activation overrides and scoped binding setters", async () => {
    const { provider } = setup();
    const ask = await provider.describe("ask", context);
    const tell = await provider.describe("tell", context);
    const setModel = await provider.describe("setModel", context);
    const setThinking = await provider.describe("setThinking", context);
    const properties = (descriptor: typeof ask) =>
      (descriptor?.inputSchema as {
        properties: Record<string, { enum?: string[] }>;
      }).properties;

    expect(properties(ask)).toHaveProperty("model");
    expect(properties(ask).thinking?.enum).toContain("xhigh");
    expect(properties(tell)).toHaveProperty("model");
    expect(properties(setModel).scope?.enum).toEqual(["session", "project"]);
    expect(properties(setThinking).scope?.enum).toEqual(["session", "project"]);
  });
  it("exposes the Veda runner and per-run persona on run and spawn", async () => {
    const { provider } = setup();
    const run = await provider.describe("run", context);
    const spawn = await provider.describe("spawn", context);
    type RunnerProperty = { enum?: string[]; pattern?: string; type?: string; description?: string };
    const runProperties = (run?.inputSchema as { properties: Record<string, RunnerProperty> }).properties;
    const spawnProperties = (spawn?.inputSchema as { properties: Record<string, RunnerProperty> }).properties;
    for (const properties of [runProperties, spawnProperties]) {
      expect(properties.runner?.description).toContain("pi, claude, veda");
      expect(new RegExp(properties.runner!.pattern!).test("veda")).toBe(true);
      expect(new RegExp(properties.runner!.pattern!).test("Bad Runner")).toBe(false);
    }
    expect(runProperties.persona?.type).toBe("string");
    expect(runProperties.persona?.description).toContain("Veda persona");
    expect(spawnProperties.persona?.type).toBe("string");
    expect(spawnProperties.persona?.description).toContain("Veda persona");
    // Veda forwards any -m value to the backend, so model discovery is an
    // empty advisory list rather than a runtime enumeration.
    await expect(provider.invoke("models", { runner: "veda" }, context)).resolves.toEqual([]);
  });

  it("rejects unavailable durable actor residency before creating an actor", async () => {
    const { provider, actors } = setup();

    await expect(
      provider.invoke(
        "create",
        {
          name: "resident",
          instructions: "Remain active.",
          residency: "durable",
        },
        context,
      ),
    ).rejects.toThrow("trusted project");
    expect(actors.list()).toEqual([]);
  });

  it("routes durable creates and imports when the local registry is already owned", async () => {
    const state = setup();
    // Simulate the transferred registry: a live foreign actor over the shared
    // registry makes the local manager's create guard throw.
    const peerIdentity: MeshIdentity = {
      id: "session:foreign-owner",
      name: "main",
      kind: "main",
      sessionId: "foreign-owner",
    };
    const peer = new ActorManager(
      "foreign-owner",
      peerIdentity,
      state.mesh,
      { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 },
      state.agents,
      () => {},
      {
        actorRoot: path.join(state.root, "actors"),
        persistent: true,
        claimResidency: "session",
        rootId: peerIdentity.id,
      },
    );
    actorManagers.push(peer);
    const foreign = await peer.create({
      name: "first-durable",
      instructions: "Ceded to the resident host.",
      residency: "durable",
    });
    // A manager that sees every live actor as owned by another host, like
    // Main after the registry transferred to the resident host.
    const guardedActors = new ActorManager(
      "guarded-main",
      state.identity,
      state.mesh,
      { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 },
      state.agents,
      () => {},
      {
        actorRoot: path.join(state.root, "actors"),
        persistent: true,
        claimResidency: "session",
        rootId: state.identity.id,
        canManageActor: () => false,
      },
    );
    actorManagers.push(guardedActors);
    await waitFor(() => guardedActors.list().some((entry) => entry.id === foreign.id));

    let sequence = 0;
    const createActor = vi.fn(async (request: FabricActorRequest): Promise<FabricActorInfo> => {
      const now = Date.now();
      sequence += 1;
      return {
        id: `resident-actor-${sequence}`,
        scope: request.scope ?? "project",
        name: request.name,
        status: "idle",
        runner: request.runner ?? "pi",
        events: request.events ?? [],
        topics: request.topics ?? [],
        delivery: request.delivery ?? "mailbox",
        responseMode: request.responseMode ?? "text",
        triggerTurn: request.triggerTurn ?? false,
        coalesce: request.coalesce ?? true,
        residency: "durable",
        queued: 0,
        messages: 0,
        createdAt: now,
        updatedAt: now,
      };
    });
    const residency = {
      ensureHost: vi.fn(async () => undefined),
      createActor,
    } as unknown as ResidencyClient;
    const provider = new AgentsProvider(
      state.agents,
      guardedActors,
      state.globalActors,
      state.mainAgent,
      state.participants,
      state.control,
      state.lifecycle,
      undefined,
      residency,
      undefined,
      () => DEFAULT_FABRIC_CONFIG.models,
    );

    const created = (await provider.invoke(
      "create",
      {
        name: "second-durable",
        instructions: "Created via the resident host.",
        residency: "durable",
      },
      context,
    )) as FabricActorInfo;
    state.globalActors.create({
      name: "durable-template",
      instructions: "Imported via the resident host.",
      residency: "durable",
    });
    const imported = (await provider.invoke(
      "import",
      { name: "durable-template" },
      context,
    )) as FabricActorInfo;

    expect(created).toMatchObject({ id: "resident-actor-1", name: "second-durable" });
    expect(imported).toMatchObject({ id: "resident-actor-2", name: "durable-template" });
    expect(createActor).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: "second-durable", residency: "durable" }),
    );
    expect(createActor).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: "durable-template", residency: "durable" }),
    );
  });

  it("does not reroute a failed local durable activation", async () => {
    const state = setup();
    const activationError = new Error(
      "Fabric actor registry is owned by another host after local creation",
    );
    const createActor = vi.fn();
    const residency = {
      ensureHost: vi.fn(async () => undefined),
      ensureActor: vi.fn(async () => {
        throw activationError;
      }),
      removeActor: vi.fn(async () => ({ removed: true })),
      createActor,
    } as unknown as ResidencyClient;
    const provider = new AgentsProvider(
      state.agents,
      state.actors,
      state.globalActors,
      state.mainAgent,
      state.participants,
      state.control,
      state.lifecycle,
      undefined,
      residency,
      undefined,
      () => DEFAULT_FABRIC_CONFIG.models,
    );

    await expect(
      provider.invoke(
        "create",
        {
          name: "activation-failure",
          instructions: "Do not reroute this failed transfer.",
          residency: "durable",
        },
        context,
      ),
    ).rejects.toBe(activationError);
    expect(createActor).not.toHaveBeenCalled();
  });
  it("lists live peer sessions separately from Main", async () => {
    const peer: FabricPeerInfo = {
      id: "session:peer",
      name: "Peer peer",
      kind: "peer",
      status: "idle",
      runner: "pi",
      transport: "host",
      cwd: process.cwd(),
      sessionId: "peer",
      startedAt: 1,
      updatedAt: 2,
      pendingMessages: false,
      local: false,
    };
    const { provider } = setup([peer]);

    await expect(provider.invoke("peers", {}, context)).resolves.toEqual([peer]);
    expect((await provider.describe("peers", context))?.risk).toBe("read");
  });

  it("lists current and peer roots as symmetric session agents", async () => {
    const roots: FabricParticipantInfo[] = [
      {
        format: 1, id: "session:test", kind: "root", rootId: "session:test",
        ownerHostId: "session:test", ownerIdentityId: "session:test", name: "main",
        status: "idle", runner: "pi", transport: "host",
        capabilities: ["steer", "followUp", "fabric"], sessionId: "test",
        startedAt: 1, updatedAt: 2, controlProtocol: "v1", local: true, stale: false,
      },
      {
        format: 1, id: "session:peer", kind: "root", rootId: "session:peer",
        ownerHostId: "session:peer", ownerIdentityId: "session:peer", name: "main",
        status: "running", runner: "pi", transport: "host",
        capabilities: ["steer", "followUp", "fabric"], sessionId: "peer",
        startedAt: 1, updatedAt: 2, controlProtocol: "v1", local: false, stale: false,
      },
    ];
    const { provider } = setup([], roots);

    await expect(provider.invoke("sessions", {}, context)).resolves.toEqual(roots);
    expect((await provider.describe("sessions", context))?.risk).toBe("read");
  });

  it("creates, lists, and removes source-qualified lifecycle subscriptions", async () => {
    const target: FabricParticipantInfo = {
      format: 1,
      id: "session:test",
      kind: "root",
      rootId: "session:test",
      ownerHostId: "session:test",
      ownerIdentityId: "session:test",
      name: "main",
      status: "idle",
      runner: "pi",
      transport: "host",
      capabilities: ["steer", "followUp", "fabric"],
      cwd: process.cwd(),
      sessionId: "test",
      startedAt: 1,
      updatedAt: 1,
      controlProtocol: "v1",
      local: true,
      stale: false,
    };
    const source: FabricParticipantInfo = {
      ...target,
      id: "session:peer",
      rootId: "session:peer",
      ownerHostId: "session:peer",
      ownerIdentityId: "session:peer",
      name: "Peer peer",
      sessionId: "peer",
      local: false,
    };
    const { provider } = setup([], [target, source]);

    const subscription = await provider.invoke(
      "subscribe",
      {
        from: source.id,
        events: ["pi.agent_settled"],
        delivery: "followUp",
        triggerTurn: false,
        once: true,
      },
      context,
    ) as { id: string };

    await expect(provider.invoke("subscriptions", { to: "main" }, context)).resolves.toEqual([
      expect.objectContaining({
        id: subscription.id,
        from: source.id,
        to: target.id,
        events: ["pi.agent_settled"],
        triggerTurn: false,
        once: true,
      }),
    ]);
    await expect(
      provider.invoke("unsubscribe", { id: subscription.id }, context),
    ).resolves.toEqual({ removed: true });
    expect((await provider.describe("subscribe", context))?.risk).toBe("agent");
  });

  it("delivers lifecycle envelopes to Main with source identity and passive policy", async () => {
    const { provider, mainDeliveries } = setup();
    const subscription: FabricLifecycleSubscription = {
      format: 1,
      id: "subscription-1",
      from: "session:peer",
      events: ["pi.agent_settled"],
      to: "session:test",
      delivery: "followUp",
      triggerTurn: false,
      once: false,
      afterSequence: 0,
      createdAt: 1,
      updatedAt: 1,
      createdBy: { id: "session:test", name: "main", kind: "main" },
    };
    const event: FabricLifecycleEvent = {
      version: 1,
      id: "event-1",
      sequence: 1,
      event: "pi.agent_settled",
      source: {
        id: "session:peer",
        name: "Peer peer",
        kind: "root",
        rootId: "session:peer",
        runner: "pi",
      },
      occurredAt: 2,
      publishedAt: 3,
    };

    await provider.deliverLifecycle(subscription, event);
    await provider.flushLifecycleDeliveries();

    expect(mainDeliveries).toEqual([
      expect.objectContaining({
        from: { id: "session:peer", name: "Peer peer", kind: "main" },
        delivery: "followUp",
        triggerTurn: false,
        data: event,
      }),
    ]);
  });

  it("rejects remote Main delivery after its capabilities are withdrawn", async () => {
    const remoteRoot: FabricParticipantInfo = {
      format: 1,
      id: "session:test",
      kind: "root",
      rootId: "session:test",
      ownerHostId: "session:test",
      ownerIdentityId: "session:test",
      name: "main",
      status: "idle",
      runner: "pi",
      transport: "host",
      capabilities: [],
      cwd: process.cwd(),
      sessionId: "test",
      startedAt: 1,
      updatedAt: 2,
      controlProtocol: "v1",
      local: false,
      stale: false,
    };
    const { provider } = setup([], [remoteRoot]);
    (provider.mainAgent as { local: boolean }).local = false;

    await expect(provider.invoke("status", { id: "main" }, context)).resolves.toEqual(
      remoteRoot,
    );
    await expect(
      provider.routeMessage("main", "too late", undefined, "steer"),
    ).rejects.toThrow(
      "does not support steer",
    );
  });

  it("projects remote agents through members, scoped list, and status", async () => {
    const remote: FabricParticipantInfo = {
      format: 1,
      id: "agent:remote",
      kind: "agent",
      rootId: "session:peer",
      ownerHostId: "session:peer",
      ownerIdentityId: "session:peer",
      parentId: "session:peer",
      name: "remote reviewer",
      status: "running",
      runner: "pi",
      transport: "process",
      capabilities: ["steer", "followUp", "stop"],
      cwd: process.cwd(),
      startedAt: 1,
      updatedAt: 2,
      controlProtocol: "v1",
      local: false,
      stale: false,
    };
    const { provider } = setup([], [remote]);

    await expect(
      provider.invoke("members", { scope: "project" }, context),
    ).resolves.toEqual([remote]);
    await expect(
      provider.invoke("list", { scope: "project" }, context),
    ).resolves.toEqual([remote]);
    await expect(
      provider.invoke("status", { id: remote.id }, context),
    ).resolves.toEqual(remote);
    await expect(
      provider.invoke("list", { scope: "lineage" }, context),
    ).resolves.toEqual([]);
  });

  it("defers explicit handoff until the finalized outer Fabric result", async () => {
    const { provider, root } = setup();
    const source = SessionManager.create(process.cwd(), path.join(root, "source-session"));
    source.appendMessage({
      role: "user",
      content: "Implement the rare token guard 43117",
      timestamp: 1,
    });
    source.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "I found the guard and am completing the full program." },
        {
          type: "toolCall",
          id: context.parentToolCallId,
          name: "fabric_exec",
          arguments: {
            code: "await pi.read(...); await pi.edit(...); await pi.edit(...); return 'verified';",
          },
        },
      ],
      api: "anthropic",
      provider: "anthropic",
      model: "frontier",
      usage,
      stopReason: "toolUse",
      timestamp: 2,
    });
    const updates: string[] = [];
    let deferredRequest: Record<string, unknown> | undefined;
    const handoffContext: FabricInvocationContext = {
      ...context,
      extensionContext: {
        ...context.extensionContext,
        sessionManager: source,
        model: { provider: "anthropic", id: "frontier" },
      } as unknown as ExtensionContext,
      update(message) {
        updates.push(message);
      },
      deferHandoff(args) {
        deferredRequest = structuredClone(args);
        return {
          scheduled: true,
          status: "deferred",
          boundary: "fabric_exec_end",
        };
      },
    };
    const args = {
      model: "anthropic/executor",
      task: "Finish the implementation and verify it.",
      transport: "process",
    };

    await expect(provider.invoke("handoff", args, handoffContext)).resolves.toMatchObject({
      status: "deferred",
      boundary: "fabric_exec_end",
    });
    expect(deferredRequest).toEqual({ ...args, runner: "pi-durable", extensions: true, kernel: "typescript", pythonRuntime: "monty" });
    expect(fs.existsSync(path.join(root, "runs"))).toBe(false);

    const outerToolResult = {
      role: "toolResult" as const,
      toolCallId: context.parentToolCallId,
      toolName: "fabric_exec",
      content: [{ type: "text" as const, text: "verified after every nested call" }],
      details: { success: true },
      isError: false,
      timestamp: 3,
    };
    const seed = snapshotHandoffSession(
      source,
      { provider: "anthropic", id: "frontier" },
      outerToolResult,
      context.parentToolCallId,
    );
    const result = (await provider.executeHandoff(
      deferredRequest!,
      handoffContext,
      seed,
    )) as {
      handedOff: boolean;
      completed: boolean;
      status: string;
      implementation: string;
      agent: { id: string; model: string };
    };

    expect(result).toMatchObject({
      handedOff: true,
      completed: true,
      status: "completed",
      implementation: "fake worker complete",
      agent: { model: "anthropic/executor" },
    });
    expect(updates).toContainEqual(expect.stringContaining("caller is waiting"));
    expect(updates).toContainEqual(expect.stringContaining("completed implementation"));
    const task = fs.readFileSync(
      path.join(root, "runs", result.agent.id, "task.txt"),
      "utf8",
    );
    expect(task).toContain("inherited conversation trajectory");
    expect(task).toContain("End with a concise conclusion for the caller");
    expect(task).toContain("unfinished or blocked work");
    expect(task).toContain("artifact paths verbatim");
    expect(task).toContain("Finish the implementation and verify it.");
    expect(task).toContain("If the request is read-only");
    expect(task).not.toContain("caller has handed implementation to you");
    const handoffDirectory = path.join(root, "runs", result.agent.id, "handoff-session");
    const [sessionName] = fs.readdirSync(handoffDirectory);
    const seededSession = SessionManager.open(path.join(handoffDirectory, sessionName!));
    const seededMessages = seededSession.buildSessionContext().messages;
    expect(JSON.stringify(seededMessages)).toContain("Implement the rare token guard 43117");
    expect(seededMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(seededMessages[1]).toMatchObject({
      role: "assistant",
      content: expect.arrayContaining([
        expect.objectContaining({
          type: "toolCall",
          name: "fabric_exec",
          id: context.parentToolCallId,
        }),
      ]),
    });
    expect(seededMessages[2]).toEqual(outerToolResult);
    expect(seededSession.getEntries().some((entry) => entry.type === "custom_message")).toBe(false);
  });

  it("requires an explicit target model for handoff", async () => {
    const { provider, root } = setup();
    const source = SessionManager.inMemory(root);
    const handoffContext = {
      ...context,
      extensionContext: {
        ...context.extensionContext,
        sessionManager: source,
      } as unknown as ExtensionContext,
    };
    await expect(provider.invoke("handoff", {}, handoffContext)).rejects.toThrow(
      /requires an explicit Pi target model/,
    );
    const descriptor = await provider.describe("handoff", handoffContext);
    expect(descriptor?.risk).toBe("agent");
    const schema = descriptor?.inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(["model"]);
    expect(schema.properties).toHaveProperty("task");
    expect(schema.properties).not.toHaveProperty("when");
    expect(schema.properties).not.toHaveProperty("checkpoint");
  });

  it("exposes cwd on one-shot schemas but not handoff or actor definitions", async () => {
    const { provider } = setup();
    const run = await provider.describe("run", context);
    const spawn = await provider.describe("spawn", context);
    const handoff = await provider.describe("handoff", context);
    const create = await provider.describe("create", context);
    const properties = (descriptor: typeof run) =>
      (descriptor?.inputSchema as { properties: Record<string, unknown> }).properties;

    expect(properties(run)).toHaveProperty("cwd", expect.objectContaining({ type: "string" }));
    expect(properties(run)).toHaveProperty("recursive", { type: "boolean" });
    expect(properties(spawn)).toHaveProperty("cwd");
    expect(properties(handoff)).not.toHaveProperty("cwd");
    expect(properties(create)).not.toHaveProperty("cwd");
  });

  it("rejects invalid durable recursive cwd before the provider can transfer ownership", async () => {
    const { provider, root } = setup();

    await expect(
      provider.invoke(
        "spawn",
        { task: "must remain recursive", cwd: path.join(root, "missing"), recursive: true, residency: "durable" },
        context,
      ),
    ).rejects.toThrow(/Invalid Fabric agent cwd/);
    expect(fs.existsSync(path.join(root, "runs"))).toBe(false);
  });

  it("shows the effective cwd in run and spawn launch activity", async () => {
    const { provider } = setup();
    const updates: string[] = [];
    const invocationContext = { ...context, update: (message: string) => updates.push(message) };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-agent-activity-"));
    roots.push(root);
    const target = path.join(root, "leaf");
    fs.mkdirSync(target);
    const requested = path.join(root, "leaf-link");
    fs.symlinkSync(target, requested, "dir");
    const canonical = fs.realpathSync(target);

    const runResult = await provider.invoke(
      "run",
      { task: "report the launch directory", cwd: requested, recursive: true },
      invocationContext,
    ) as { cwd: string };
    expect(runResult.cwd).toBe(canonical);
    expect(updates.some((message) => message.endsWith(`cwd ${canonical}`))).toBe(true);

    updates.length = 0;
    const handle = await provider.invoke(
      "spawn",
      { task: "report the launch directory", cwd: requested, recursive: true },
      invocationContext,
    ) as { id: string; cwd: string };
    expect(handle.cwd).toBe(canonical);
    expect(updates.some((message) => message.endsWith(`cwd ${canonical}`))).toBe(true);
    await provider.invoke("wait", { id: handle.id }, invocationContext);
    await provider.invoke("cleanup", { id: handle.id }, invocationContext);
  });

  it.skipIf(process.platform === "win32")("bounds and escapes control characters in cwd launch activity", async () => {
    const { provider } = setup();
    const updates: string[] = [];
    const invocationContext = { ...context, update: (message: string) => updates.push(message) };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-agent-activity-"));
    roots.push(root);
    const longPart = "x".repeat(96);
    const target = path.join(root, longPart, longPart, `leaf-\u001b-${"y".repeat(96)}`);
    fs.mkdirSync(target, { recursive: true });
    const requested = path.join(root, "leaf-link");
    fs.symlinkSync(target, requested, "dir");
    const canonical = fs.realpathSync(target);
    const safe = canonical.replace(/[\u0000-\u001f\u007f]/g, (character) =>
      `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
    );
    const shown = safe.length <= 240 ? safe : `…${safe.slice(-239)}`;

    const runResult = await provider.invoke(
      "run",
      { task: "report the launch directory", cwd: requested, recursive: true },
      invocationContext,
    ) as { cwd: string };
    expect(runResult.cwd).toBe(canonical);
    expect(updates.some((message) => message.endsWith(`cwd ${shown}`))).toBe(true);

    updates.length = 0;
    const handle = await provider.invoke(
      "spawn",
      { task: "report the launch directory", cwd: requested, recursive: true },
      invocationContext,
    ) as { id: string; cwd: string };
    expect(handle.cwd).toBe(canonical);
    expect(updates.some((message) => message.endsWith(`cwd ${shown}`))).toBe(true);
    expect(updates.every((message) => !/[\u0000-\u001f\u007f]/.test(message))).toBe(true);
    expect(updates.every((message) => message.length < 512)).toBe(true);
    await provider.invoke("wait", { id: handle.id }, invocationContext);
    await provider.invoke("cleanup", { id: handle.id }, invocationContext);
  });

  it("exposes the compact option on handoff only and validates it before deferring", async () => {
    const { provider, root } = setup();
    const source = SessionManager.inMemory(root);
    const handoffContext = {
      ...context,
      extensionContext: {
        ...context.extensionContext,
        sessionManager: source,
      } as unknown as ExtensionContext,
    };
    const handoffDescriptor = await provider.describe("handoff", handoffContext);
    const handoffSchema = handoffDescriptor?.inputSchema as { properties: Record<string, unknown> };
    expect(handoffSchema.properties).toHaveProperty("compact");
    const runDescriptor = await provider.describe("run", handoffContext);
    expect(
      (runDescriptor?.inputSchema as { properties: Record<string, unknown> }).properties,
    ).not.toHaveProperty("compact");
    const spawnDescriptor = await provider.describe("spawn", handoffContext);
    expect(
      (spawnDescriptor?.inputSchema as { properties: Record<string, unknown> }).properties,
    ).not.toHaveProperty("compact");

    await expect(
      provider.invoke(
        "handoff",
        { model: "anthropic/executor", compact: "yes" },
        handoffContext,
      ),
    ).rejects.toThrow(/must be true or an object/);
    await expect(
      provider.invoke(
        "handoff",
        {
          model: "anthropic/executor",
          compact: { preserve: Array.from({ length: 17 }, (_, index) => String(index)) },
        },
        handoffContext,
      ),
    ).rejects.toThrow(/exceeds 16 items/);
  });

  it("compacts the handed-off trajectory when the caller requests it", async () => {
    const { provider, root } = setup();
    const source = SessionManager.create(process.cwd(), path.join(root, "source-session"));
    source.appendMessage({
      role: "user",
      content: "Implement the rare token guard 43117",
      timestamp: 1,
    });
    source.appendMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Long scratch exploration of guard internals. ${"filler ".repeat(30)}SCRATCH_TAIL_99231`,
        },
      ],
      api: "anthropic",
      provider: "anthropic",
      model: "frontier",
      usage,
      stopReason: "stop",
      timestamp: 2,
    });
    source.appendMessage({ role: "user", content: "Proceed", timestamp: 3 });
    source.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Completing the full program at the boundary." },
        {
          type: "toolCall",
          id: context.parentToolCallId,
          name: "fabric_exec",
          arguments: { code: "await pi.edit(...); return 'verified';" },
        },
      ],
      api: "anthropic",
      provider: "anthropic",
      model: "frontier",
      usage,
      stopReason: "toolUse",
      timestamp: 4,
    });
    let deferredRequest: Record<string, unknown> | undefined;
    const handoffContext: FabricInvocationContext = {
      ...context,
      extensionContext: {
        ...context.extensionContext,
        sessionManager: source,
        model: { provider: "anthropic", id: "frontier" },
      } as unknown as ExtensionContext,
      deferHandoff(args) {
        deferredRequest = structuredClone(args);
        return {
          scheduled: true,
          status: "deferred",
          boundary: "fabric_exec_end",
        };
      },
    };
    const args = {
      model: "anthropic/executor",
      transport: "process",
      compact: { preserve: ["Guard threshold stays at 90 percent 5678"] },
    };

    await expect(provider.invoke("handoff", args, handoffContext)).resolves.toMatchObject({
      status: "deferred",
      boundary: "fabric_exec_end",
    });
    expect(deferredRequest).toEqual({ ...args, runner: "pi-durable", extensions: true, kernel: "typescript", pythonRuntime: "monty" });

    const outerToolResult = {
      role: "toolResult" as const,
      toolCallId: context.parentToolCallId,
      toolName: "fabric_exec",
      content: [{ type: "text" as const, text: "verified after every nested call" }],
      details: { success: true },
      isError: false,
      timestamp: 5,
    };
    const seed = snapshotHandoffSession(
      source,
      { provider: "anthropic", id: "frontier" },
      outerToolResult,
      context.parentToolCallId,
    );
    const result = (await provider.executeHandoff(
      deferredRequest!,
      handoffContext,
      seed,
    )) as { handedOff: boolean; completed: boolean; agent: { id: string } };
    expect(result).toMatchObject({ handedOff: true, completed: true });

    const handoffDirectory = path.join(root, "runs", result.agent.id, "handoff-session");
    const [sessionName] = fs.readdirSync(handoffDirectory);
    const seededSession = SessionManager.open(path.join(handoffDirectory, sessionName!));
    const seededMessages = seededSession.buildSessionContext().messages;
    expect(seededMessages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(JSON.stringify(seededMessages[0])).toContain("Guard threshold stays at 90 percent 5678");
    expect(JSON.stringify(seededMessages[0])).toContain("Implement the rare token guard 43117");
    expect(JSON.stringify(seededMessages[0])).toContain("Historical assistant response (not a verified outcome)");
    expect(JSON.stringify(seededMessages[0])).toContain("SCRATCH_TAIL_99231");
    expect(JSON.stringify(seededMessages.slice(1))).not.toContain("SCRATCH_TAIL_99231");
    expect(
      seededSession.getEntries().some((entry) => JSON.stringify(entry).includes("SCRATCH_TAIL_99231")),
    ).toBe(true);
    expect(
      seededSession.getEntries().some((entry) => entry.type === "compaction"),
    ).toBe(true);
    expect(seededSession.getEntries().at(-1)).toMatchObject({
      type: "custom",
      customType: "pi-fabric-handoff",
      data: { compaction: { applied: true } },
    });
  });

  it("attaches a structured child-tool preview to blocking agent runs", async () => {
    const { provider } = setup();
    const previews: unknown[] = [];
    const previewContext: FabricInvocationContext = {
      ...context,
      attachPreview(preview) {
        previews.push(preview);
      },
    };

    await provider.invoke(
      "run",
      { task: "return a short result", name: "preview-agent", transport: "process" },
      previewContext,
    );

    expect(previews.at(-1)).toMatchObject({
      kind: "fabric-agent-tools",
      name: "preview-agent",
      status: "completed",
      runner: "pi-durable",
      owner: "agent",
      text: "fake worker complete",
      tools: expect.any(Array),
    });
  });

  it("refreshes bounded agent previews when only the transcript changes", async () => {
    const { provider } = setup();
    const previews: Array<Record<string, unknown>> = [];
    const previewContext: FabricInvocationContext = {
      ...context,
      attachPreview(preview) {
        previews.push(preview as Record<string, unknown>);
      },
    };

    await provider.invoke(
      "run",
      { task: "STREAM_PREVIEW", name: "stream-preview-agent", transport: "process" },
      previewContext,
    );

    const liveTools = previews
      .filter((preview) => preview.status === "running")
      .flatMap((preview) => preview.tools as Array<{ label?: string; toolName?: string }> ?? []);
    expect(liveTools.some((tool) => (tool.toolName ?? tool.label) === "read")).toBe(true);
    expect(liveTools.some((tool) => (tool.toolName ?? tool.label) === "bash")).toBe(true);
    expect(previews.length).toBeLessThanOrEqual(4);
  }, 10_000);

  it("acknowledges model-facing terminal status but not running status or UI polling", async () => {
    const { provider, agents } = setup();
    const acknowledge = vi.spyOn(agents, "markForeground");
    const handle = await provider.invoke("spawn", { task: "return a short result", transport: "process" }, context) as { id: string };
    const initial = await provider.invoke("status", { id: handle.id }, context) as AgentRunRecord;
    if (initial.status === "running") expect(acknowledge).not.toHaveBeenCalled();
    acknowledge.mockClear();
    await waitFor(() => agents.status(handle.id).status === "completed");
    agents.listForUi();
    expect(acknowledge).not.toHaveBeenCalled();
    await provider.invoke("status", { id: handle.id }, context);
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith(handle.id);
  });

  it.each(["wait", "join"])("attaches previews and reports friendly names through %s for spawned agents", async (method) => {
    const { provider, agents } = setup();
    const wait = vi.spyOn(agents, "wait");
    const updates: string[] = [];
    const previews: Array<Record<string, unknown>> = [];
    const previewContext: FabricInvocationContext = {
      ...context,
      update(message) {
        updates.push(message);
      },
      attachPreview(preview) {
        previews.push(preview as Record<string, unknown>);
      },
    };
    const handle = await provider.invoke(
      "spawn",
      { task: "return a short result", name: "wait-preview-agent", transport: "process" },
      previewContext,
    ) as { id: string; name: string };

    await provider.invoke(method, { id: handle.id }, previewContext);
    expect(wait).toHaveBeenCalledExactlyOnceWith(handle.id);

    expect(updates.some((message) => message.startsWith("Agent wait-preview-agent:"))).toBe(true);
    expect(updates.join("\n")).not.toContain(handle.id.slice(0, 8));
    expect(previews.at(-1)).toMatchObject({
      kind: "fabric-agent-tools",
      id: handle.id,
      name: "wait-preview-agent",
      status: "completed",
      owner: "agent",
    });
  });

  it("attaches the final preview for actors that settle before the first poll", async () => {
    const { provider } = setup();
    const actor = (await provider.invoke("create", createRequest, context)) as { id: string };
    const previews: Array<Record<string, unknown>> = [];
    const previewContext: FabricInvocationContext = {
      ...context,
      attachPreview(preview) {
        previews.push(preview as Record<string, unknown>);
      },
    };

    await provider.invoke("ask", { id: actor.id, message: "inspect quickly" }, previewContext);

    expect(previews.at(-1)).toMatchObject({
      kind: "fabric-agent-tools",
      status: "completed",
      owner: "actor",
      tools: expect.any(Array),
    });
  });

  it("ignores actor timeout overrides below the configured default", async () => {
    // Pin the configured default below the 24-hour ceiling: that is the only
    // configuration where a per-actor or per-call timeout can raise a run.
    const { provider, actors } = setup([], [], undefined, {
      agentsConfig: { timeoutMs: 3_600_000 },
    });
    const inherited = (await provider.invoke(
      "create",
      { ...createRequest, name: "inherited-timeout", timeoutMs: 240_000 },
      context,
    )) as { id: string };
    const longer = (await provider.invoke(
      "create",
      { ...createRequest, name: "longer-timeout", timeoutMs: 7_200_000 },
      context,
    )) as { id: string };

    expect(actors.definition(inherited.id)).not.toHaveProperty("timeoutMs");
    expect(actors.definition(longer.id).timeoutMs).toBe(7_200_000);
  });

  it("enumerates Claude models and preserves runner on actors", async () => {
    const { provider } = setup();
    const models = (await provider.invoke("models", { runner: "claude" }, context)) as Array<{
      runner: string;
      key: string;
      resolvedModel: string;
    }>;
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runner: "claude",
          key: "claude/haiku",
          resolvedModel: "claude-haiku-test",
        }),
      ]),
    );

    const actor = (await provider.invoke(
      "create",
      {
        name: "claude-reviewer",
        instructions: "Review messages.",
        runner: "claude",
      },
      context,
    )) as { runner: string };
    expect(actor.runner).toBe("claude");
  });
});

describe("AgentsProvider exact model lookup", () => {
  const piKeys = visiblePiModels.map((model) => `${model.provider}/${model.id}`);

  it("keeps the unfiltered Pi model list unchanged", async () => {
    const { provider } = setup();
    await expect(provider.invoke("models", { runner: "pi" }, context)).resolves.toEqual(
      visiblePiModels.map((model) => ({
        runner: "pi",
        provider: model.provider,
        id: model.id,
        name: model.name ?? model.id,
        key: `${model.provider}/${model.id}`,
      })),
    );
    expect(piKeys).toContain("anthropic/executor");
  });

  it("returns only the Pi entry whose key equals the requested model", async () => {
    const { provider } = setup();
    await expect(
      provider.invoke("models", { runner: "pi", model: "anthropic/executor" }, context),
    ).resolves.toEqual([
      { runner: "pi", provider: "anthropic", id: "executor", name: "Executor", key: "anthropic/executor" },
    ]);
  });

  it.each([
    ["a differently cased key", "Anthropic/Executor"],
    ["an alias name", "budget"],
    ["a near id", "anthropic/executr"],
    ["a provider-only string", "anthropic"],
    ["a bare id", "executor"],
    ["an unknown key", "nobody/nothing"],
    ["a whitespace-padded key", " anthropic/executor"],
  ])("returns no Pi entries for %s", async (_label, model) => {
    const { provider } = setup([], [], undefined, {
      modelsConfig: { aliases: { budget: { targets: ["anthropic/executor"] } } },
    });
    await expect(provider.invoke("models", { runner: "pi", model }, context)).resolves.toEqual([]);
  });

  it("filters Claude runtime models by exact key", async () => {
    const { provider } = setup();
    const all = (await provider.invoke("models", { runner: "claude" }, context)) as Array<{ key: string }>;
    const haiku = all.filter((model) => model.key === "claude/haiku");
    expect(haiku).toHaveLength(1);
    await expect(
      provider.invoke("models", { runner: "claude", model: "claude/haiku" }, context),
    ).resolves.toEqual(haiku);
    await expect(
      provider.invoke("models", { runner: "claude", model: "claude/Haiku" }, context),
    ).resolves.toEqual([]);
    await expect(
      provider.invoke("models", { runner: "claude", model: "haiku" }, context),
    ).resolves.toEqual([]);
  });

  it("filters a registered runner's model list by exact key", async () => {
    const listed = [
      { runner: "acme-lookup", provider: "acme", id: "large", name: "Acme Large", key: "acme/large" },
      { runner: "acme-lookup", provider: "acme", id: "large-2", name: "Acme Large 2", key: "acme/large-2" },
    ];
    const unregister = registerAgentRunner({
      kind: "worker",
      id: "acme-lookup",
      label: "Acme",
      capabilities: {
        recursiveFabric: false,
        steer: false,
        followUp: false,
        persistentSessions: false,
        kernels: false,
        handoff: false,
        modelDiscovery: true,
        imageInput: false,
        compaction: false,
        questions: false,
        sleep: false,
        writePolicy: false,
      },
      models: () => listed,
      launch: () => {
        throw new Error("not launched");
      },
    });
    try {
      const { provider } = setup();
      await expect(provider.invoke("models", { runner: "acme-lookup" }, context)).resolves.toEqual(listed);
      await expect(
        provider.invoke("models", { runner: "acme-lookup", model: "acme/large" }, context),
      ).resolves.toEqual([listed[0]]);
      await expect(
        provider.invoke("models", { runner: "acme-lookup", model: "ACME/large" }, context),
      ).resolves.toEqual([]);
      await expect(
        provider.invoke("models", { runner: "acme-lookup", model: "acme" }, context),
      ).resolves.toEqual([]);
    } finally {
      unregister();
    }
  });

  it("keeps Veda advisory-empty when a model is requested", async () => {
    const { provider } = setup();
    await expect(
      provider.invoke("models", { runner: "veda", model: "anything/at-all" }, context),
    ).resolves.toEqual([]);
  });

  it.each([
    ["an empty string", ""],
    ["a string over 256 characters", "a".repeat(257)],
    ["a number", 42],
    ["null", null],
    ["an array", ["anthropic/executor"]],
  ])("refuses %s as the model", async (_label, model) => {
    const { provider } = setup();
    await expect(provider.invoke("models", { runner: "pi", model }, context)).rejects.toThrow(
      /agents\.models model must be a string of 1 to 256 characters/,
    );
  });

  it("accepts a 256-character model and declares the bound in the schema", async () => {
    const { provider } = setup();
    await expect(
      provider.invoke("models", { runner: "pi", model: "a".repeat(256) }, context),
    ).resolves.toEqual([]);
    const descriptor = await provider.describe("models", context);
    const properties = (descriptor?.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(properties.model).toMatchObject({ type: "string", minLength: 1, maxLength: 256 });
  });

  // The guest route prepares arguments before validating them; these go through it.
  const registryRoute = (provider: AgentsProvider, models: unknown[] = visiblePiModels) => {
    const registry = new ActionRegistry();
    registry.register(provider);
    const approve = vi.fn(async () => {});
    const routeContext = {
      ...context,
      extensionContext: { modelRegistry: { getAvailable: () => models } } as unknown as ExtensionContext,
      approve,
      audits: [],
      maxResultChars: 100_000,
    };
    return {
      registry,
      routeContext,
      approve,
      invoke: (args: Record<string, unknown>) => registry.invoke("agents.models", args, routeContext),
      close: () => registry.close(),
    };
  };

  const acmeEntry = { runner: "acme-null", provider: "acme", id: "large", name: "Large", key: "acme/large" };
  const registerAcme = (models: () => unknown[]) =>
    registerAgentRunner({
      kind: "worker",
      id: "acme-null",
      label: "Acme",
      capabilities: {
        recursiveFabric: false,
        steer: false,
        followUp: false,
        persistentSessions: false,
        kernels: false,
        handoff: false,
        modelDiscovery: true,
        imageInput: false,
        compaction: false,
        questions: false,
        sleep: false,
        writePolicy: false,
      },
      models: models as never,
      launch: () => {
        throw new Error("not launched");
      },
    });

  const refusedModel = /Invalid arguments for agents\.models: model must be a string of 1 to 256 characters/;
  // Spellings the argument normalizers repair to model.
  const modelSpellings = ["model", "Model", "MODEL", "m_o_d_e_l", "mo-del", " model "];
  // One exact key per runner, and what looking it up returns.
  const exactLookups: Record<string, { model: string; expected: unknown[] }> = {
    pi: {
      model: "anthropic/executor",
      expected: [{ runner: "pi", provider: "anthropic", id: "executor", name: "Executor", key: "anthropic/executor" }],
    },
    "pi-durable": {
      model: "anthropic/executor",
      expected: [
        { runner: "pi-durable", provider: "anthropic", id: "executor", name: "Executor", key: "anthropic/executor" },
      ],
    },
    claude: { model: "claude/haiku", expected: [expect.objectContaining({ key: "claude/haiku" })] },
    veda: { model: "anything/at-all", expected: [] },
    "acme-null": { model: "acme/large", expected: [acmeEntry] },
  };

  // Compiled normalization is on by default (entropy.compile) and runs after
  // provider preparation; the bare registry leaves it off.
  describe.each([
    ["the default runtime route (compiled normalization on)", true],
    ["a bare registry (compiled normalization off)", false],
  ])("on %s", (_label, compiled) => {
    beforeEach(() => {
      expect(DEFAULT_FABRIC_CONFIG.entropy.compile).toBe(true);
      if (compiled) setActiveCompiledSurface(undefined, DEFAULT_FABRIC_CONFIG.entropy.compile);
      else clearActiveCompiledSurface();
    });
    afterEach(() => clearActiveCompiledSurface());

    it.each(Object.keys(exactLookups))(
      "refuses a null model and its spellings before approval for the %s runner",
      async (runner) => {
        const discover = vi.fn(() => [acmeEntry]);
        const unregister = registerAcme(discover);
        const route = registryRoute(setup().provider);
        try {
          for (const spelling of modelSpellings) {
            await expect(route.invoke({ runner, [spelling]: null })).rejects.toThrow(refusedModel);
          }
          // A null canonical model is not rescued by a valid spelling variant.
          await expect(
            route.invoke({ runner, model: null, Model: exactLookups[runner]!.model }),
          ).rejects.toThrow(refusedModel);
          expect(route.approve).not.toHaveBeenCalled();
          expect(discover).not.toHaveBeenCalled();
        } finally {
          unregister();
          await route.close();
        }
      },
    );

    it.each([
      ["false", { model: false }],
      ["zero", { model: 0 }],
      ["a number", { model: 42 }],
      ["an empty string", { model: "" }],
      ["an empty string under a spelling variant", { Model: "" }],
      ["a string over 256 characters", { model: "a".repeat(257) }],
      ["an object", { model: {} }],
      ["an object wrapping a key", { model: { value: "anthropic/executor" } }],
      ["an array", { model: ["anthropic/executor"] }],
      ["an empty array", { model: [] }],
    ])("refuses %s as the model before approval", async (_label, modelArgs) => {
      const route = registryRoute(setup().provider);
      try {
        await expect(route.invoke({ runner: "pi", ...modelArgs })).rejects.toThrow(refusedModel);
        expect(route.approve).not.toHaveBeenCalled();
      } finally {
        await route.close();
      }
    });

    it.each(Object.keys(exactLookups))(
      "keeps listing without a model and lets a real model win over a null spelling for the %s runner",
      async (runner) => {
        const unregister = registerAcme(() => [acmeEntry]);
        const route = registryRoute(setup().provider);
        try {
          const all = await route.invoke({ runner });
          await expect(route.invoke({ runner, model: undefined })).resolves.toEqual(all);
          const { model, expected } = exactLookups[runner]!;
          await expect(route.invoke({ runner, model })).resolves.toEqual(expected);
          await expect(route.invoke({ runner, model, Model: null })).resolves.toEqual(expected);
          await expect(route.invoke({ runner, Model: model })).resolves.toEqual(expected);
        } finally {
          unregister();
          await route.close();
        }
      },
    );
  });

  it("refuses a null model from a QuickJS guest on the default runtime route", async () => {
    setActiveCompiledSurface(undefined, DEFAULT_FABRIC_CONFIG.entropy.compile);
    const route = registryRoute(setup().provider);
    try {
      const result = await new QuickJsRuntime().execute(
        `let refused = "";
         try { await agents.models({ runner: "pi", model: null }); } catch (error) { refused = String(error); }
         const pinned = await agents.models({ runner: "pi", model: "anthropic/executor" });
         return { refused, pinned };`,
        (ref, args) => route.registry.invoke(ref, args as Record<string, unknown>, route.routeContext),
        { timeoutMs: 5_000, memoryLimitBytes: 32 * 1024 * 1024 },
      );
      expect(result.terminationReason).toBe("completed");
      expect(result.value).toEqual({
        refused: expect.stringMatching(refusedModel),
        pinned: [{ runner: "pi", provider: "anthropic", id: "executor", name: "Executor", key: "anthropic/executor" }],
      });
    } finally {
      clearActiveCompiledSurface();
      await route.close();
    }
  });

  it("counts supplementary characters as one character each, like the schema", async () => {
    const id256 = "😀".repeat(256 - "anthropic/".length);
    const atBound = `anthropic/${id256}`;
    const overBound = `${atBound}😀`;
    expect([...atBound]).toHaveLength(256);
    expect(atBound.length).toBeGreaterThan(256);
    const unicodeModel = { provider: "anthropic", id: id256, name: "Unicode" };
    const { provider } = setup();
    const route = registryRoute(provider, [...visiblePiModels, unicodeModel]);
    try {
      await expect(route.invoke({ runner: "pi", model: atBound })).resolves.toEqual([
        { runner: "pi", provider: "anthropic", id: id256, name: "Unicode", key: atBound },
      ]);
      await expect(route.invoke({ runner: "pi", model: overBound })).rejects.toThrow(refusedModel);
      // The provider's own guard agrees with the schema on both sides of the bound.
      await expect(provider.invoke("models", { runner: "pi", model: overBound }, context)).rejects.toThrow(
        /agents\.models model must be a string of 1 to 256 characters/,
      );
    } finally {
      await route.close();
    }
  });
});

describe("AgentsProvider shared actor definitions", () => {
  it("exposes the shared definition, mailbox, and logs while keeping mutation owner-gated", async () => {
    const members: FabricParticipantInfo[] = [];
    const { provider, actors } = setup([], members);
    const actor = await actors.create(createRequest as FabricActorRequest);
    members.push({
      format: 1,
      id: actor.id,
      kind: "actor",
      rootId: "session:peer",
      ownerHostId: "session:peer",
      ownerIdentityId: "session:peer",
      parentId: "session:peer",
      name: actor.name,
      status: "idle",
      runner: "pi",
      transport: "host",
      capabilities: ["steer", "followUp", "stop", "ask", "actor-bindings", "fabric"],
      startedAt: actor.createdAt,
      updatedAt: actor.updatedAt,
      controlProtocol: "v1",
      local: false,
      stale: false,
    });

    await expect(provider.invoke("actors", {}, context)).resolves.toHaveLength(1);
    await expect(provider.invoke("actorStatus", { id: actor.id }, context)).resolves.toMatchObject({
      id: actor.id,
      name: actor.name,
    });
    await expect(provider.invoke("messages", { id: actor.id }, context)).resolves.toEqual([]);
    await expect(provider.invoke("log", { id: actor.id }, context)).resolves.toMatchObject({
      actorId: actor.id,
    });
    await expect(provider.invoke("export", { id: actor.id }, context)).resolves.toMatchObject({
      name: actor.name,
    });
  });

  it("routes passive-session ask and tell with the caller's pinned binding", async () => {
    const members: FabricParticipantInfo[] = [];
    const response = {
      id: "remote-response",
      actorId: "pending",
      actorName: "reviewer",
      direction: "out" as const,
      source: "direct",
      createdAt: Date.now(),
      text: "remote answer",
    };
    const requestResult = vi.fn().mockResolvedValue(response);
    const request = vi.fn().mockResolvedValue({
      queued: true,
      messageId: "remote-message",
      routed: "mesh",
      acknowledged: true,
    });
    const control = { requestResult, request } as unknown as FabricControlPlane;
    const { provider, actors } = setup([], members, control);
    const actor = await actors.create({
      ...createRequest,
      model: "provider/project",
      thinking: "medium",
      timeoutMs: 2 * 60 * 60 * 1_000,
    } as FabricActorRequest);
    response.actorId = actor.id;
    await actors.cede(actor.id);
    await actors.setModel(actor.id, "provider/session");
    await actors.setThinking(actor.id, "low");
    members.push({
      format: 1,
      id: actor.id,
      kind: "actor",
      rootId: "session:owner",
      ownerHostId: "host:owner",
      ownerIdentityId: "identity:owner",
      parentId: "session:owner",
      name: actor.name,
      status: "idle",
      runner: "pi",
      transport: "host",
      capabilities: ["steer", "followUp", "stop", "ask", "actor-bindings", "fabric"],
      startedAt: actor.createdAt,
      updatedAt: actor.updatedAt,
      controlProtocol: "v1",
      local: false,
      stale: false,
    });

    await expect(provider.invoke("ask", {
      id: actor.name,
      message: "review",
      model: "provider/one-off",
      thinking: "xhigh",
    }, context)).resolves.toEqual(response);
    expect(requestResult).toHaveBeenCalledWith(
      "host:owner",
      actor.id,
      "ask",
      expect.objectContaining({
        message: "review",
        binding: { model: "provider/one-off", thinking: "xhigh" },
      }),
      "identity:owner",
      { timeoutMs: 2 * 60 * 60 * 1_000 + 30_000 },
    );

    await expect(
      provider.invoke(
        "ask",
        { id: actor.name, message: "x".repeat(62 * 1_024) },
        context,
      ),
    ).rejects.toThrow("after reserving the Fabric envelope");
    expect(requestResult).toHaveBeenCalledTimes(1);

    await provider.invoke("tell", { id: actor.name, message: "queue" }, context);
    expect(request).toHaveBeenCalledWith(
      "host:owner",
      actor.id,
      "followUp",
      expect.objectContaining({
        message: "queue",
        binding: { model: "provider/session", thinking: "low" },
      }),
      "identity:owner",
    );
  });

  it("routes ask and tell for a remote actor absent from the local registry", async () => {
    const participant: FabricParticipantInfo = {
      format: 1,
      id: "actor:resident-child",
      kind: "actor",
      rootId: "session:test",
      ownerHostId: "host:resident",
      ownerIdentityId: "identity:resident",
      parentId: "session:test",
      name: "resident child",
      status: "idle",
      residency: "durable",
      runner: "pi",
      transport: "host",
      capabilities: ["steer", "followUp", "stop", "ask", "actor-bindings", "fabric"],
      startedAt: 1,
      updatedAt: 1,
      controlProtocol: "v1",
      local: false,
      stale: false,
    };
    const members = [participant];
    const response = {
      id: "remote-response",
      actorId: participant.id,
      actorName: participant.name,
      direction: "out" as const,
      source: "direct",
      createdAt: Date.now(),
      text: "PONG",
    };
    const requestResult = vi.fn().mockResolvedValue(response);
    const request = vi.fn().mockResolvedValue({
      queued: true,
      messageId: "remote-message",
      routed: "mesh",
      acknowledged: true,
    });
    const control = { requestResult, request } as unknown as FabricControlPlane;
    const { provider } = setup([], members, control);

    await expect(provider.invoke("ask", {
      id: participant.id,
      message: "PING",
    }, context)).resolves.toEqual(response);
    expect(requestResult).toHaveBeenCalledWith(
      "host:resident",
      participant.id,
      "ask",
      { message: "PING" },
      "identity:resident",
      { timeoutMs: DEFAULT_FABRIC_CONFIG.agents.timeoutMs + 30_000 },
    );

    await provider.invoke("tell", {
      id: participant.id,
      message: "queue",
    }, context);
    expect(request).toHaveBeenCalledWith(
      "host:resident",
      participant.id,
      "followUp",
      expect.objectContaining({ message: "queue" }),
      "identity:resident",
    );
  });

  it("executes one shared actor with each caller's session binding", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-two-sessions-"));
    roots.push(root);
    const meshRoot = path.join(root, "mesh");
    const actorRoot = path.join(root, "actors");
    const meshConfig = { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 };
    const ownerIdentity: MeshIdentity = {
      id: "session:a",
      name: "Main A",
      kind: "main",
      sessionId: "a",
    };
    const peerIdentity: MeshIdentity = {
      id: "session:b",
      name: "Main B",
      kind: "main",
      sessionId: "b",
    };
    const ownerMesh = new MeshStore(meshRoot, 64 * 1_024, 1_000);
    const peerMesh = new MeshStore(meshRoot, 64 * 1_024, 1_000);
    const workerPath = path.resolve("tests/fixtures/fake-worker.mjs");
    const ownerAgents = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath,
      runRoot: path.join(root, "owner-runs"),
    });
    const peerAgents = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath,
      runRoot: path.join(root, "peer-runs"),
    });
    agentManagers.push(ownerAgents, peerAgents);
    const makeMain = (identity: MeshIdentity): FabricMainAgentTarget => ({
      id: identity.id,
      local: true,
      matches: (id) => id === "main" || id === identity.id,
      info: () => ({
        id: identity.id,
        name: "Main",
        kind: "main",
        status: "idle",
        runner: "pi",
        transport: "host",
        cwd: process.cwd(),
        sessionId: identity.sessionId ?? identity.id,
        startedAt: 1,
        updatedAt: 1,
        pendingMessages: false,
        local: true,
      }),
      deliverAgent: () => ({ queued: true, messageId: "main-message", routed: "main" }),
    });
    const ownerActors = new ActorManager(
      "a",
      ownerIdentity,
      ownerMesh,
      meshConfig,
      ownerAgents,
      () => {},
      {
        actorRoot,
        persistent: true,
        canManageActor: () => true,
        mainAgent: makeMain(ownerIdentity),
      },
    );
    actorManagers.push(ownerActors);
    const actor = await ownerActors.create({
      name: "shared reviewer",
      instructions: "Review each direct request.",
      model: "provider/project-default",
      thinking: "medium",
    });
    const peerActors = new ActorManager(
      "b",
      peerIdentity,
      peerMesh,
      meshConfig,
      peerAgents,
      () => {},
      {
        actorRoot,
        persistent: true,
        canManageActor: () => false,
        mainAgent: makeMain(peerIdentity),
      },
    );
    actorManagers.push(peerActors);

    const participantFor = (local: boolean): FabricParticipantInfo => ({
      format: 1,
      id: actor.id,
      kind: "actor",
      rootId: ownerIdentity.id,
      ownerHostId: "host:a",
      ownerIdentityId: ownerIdentity.id,
      parentId: ownerIdentity.id,
      name: actor.name,
      status: "idle",
      runner: "pi",
      transport: "host",
      capabilities: ["steer", "followUp", "stop", "ask", "actor-bindings", "fabric"],
      startedAt: actor.createdAt,
      updatedAt: actor.updatedAt,
      controlProtocol: "v1",
      local,
      stale: false,
    });
    const sourceFor = (
      identity: MeshIdentity,
      hostId: string,
      local: boolean,
    ): FabricParticipantSource => ({
      list: () => [participantFor(local)],
      get: (id) => id === actor.id ? participantFor(local) : undefined,
      self: () => ({
        format: 1,
        id: identity.id,
        kind: "root",
        rootId: identity.id,
        ownerHostId: hostId,
        ownerIdentityId: identity.id,
        name: identity.name,
        status: "idle",
        runner: "pi",
        transport: "host",
        capabilities: ["steer", "followUp", "fabric"],
        sessionId: identity.sessionId ?? identity.id,
        startedAt: 1,
        updatedAt: 1,
        pendingMessages: false,
        controlProtocol: "v1",
        local: true,
        stale: false,
      }),
      peers: () => [],
      async refresh() {},
      scheduleRefresh() {},
    });
    const ownerSource = sourceFor(ownerIdentity, "host:a", true);
    const peerSource = sourceFor(peerIdentity, "host:b", false);
    const ownerControl = new FabricControlPlane(ownerMesh, ownerIdentity, {
      enabled: true,
      hostId: "host:a",
      pollMs: 20,
      acknowledgementTimeoutMs: 1_000,
    });
    const peerControl = new FabricControlPlane(peerMesh, peerIdentity, {
      enabled: true,
      hostId: "host:b",
      pollMs: 20,
      acknowledgementTimeoutMs: 1_000,
    });
    controlPlanes.push(ownerControl, peerControl);
    const ownerLifecycle = new LifecycleBroker(
      ownerMesh,
      ownerIdentity,
      ownerSource,
      { enabled: true, pollMs: 20, maxReadEvents: 100 },
      async () => {},
    );
    const peerLifecycle = new LifecycleBroker(
      peerMesh,
      peerIdentity,
      peerSource,
      { enabled: true, pollMs: 20, maxReadEvents: 100 },
      async () => {},
    );
    const globals = new GlobalActorRegistry(root, 64 * 1_024);
    const ownerProvider = new AgentsProvider(
      ownerAgents,
      ownerActors,
      globals,
      makeMain(ownerIdentity),
      ownerSource,
      ownerControl,
      ownerLifecycle,
      () => false,
      undefined,
      false,
    );
    const peerProvider = new AgentsProvider(
      peerAgents,
      peerActors,
      globals,
      makeMain(peerIdentity),
      peerSource,
      peerControl,
      peerLifecycle,
      () => false,
      undefined,
      false,
    );
    ownerControl.start((command, from, signal) =>
      ownerProvider.acceptControl(command, from, signal));
    peerControl.start((command, from, signal) =>
      peerProvider.acceptControl(command, from, signal));
    const run = vi.spyOn(ownerAgents, "run");

    await ownerProvider.invoke("setModel", { id: actor.id, model: "provider/model-a" }, context);
    await peerProvider.invoke("setModel", { id: actor.id, model: "provider/model-b" }, context);
    await ownerProvider.invoke("ask", { id: actor.id, message: "Review from A" }, context);
    await peerProvider.invoke("ask", { id: actor.id, message: "Review from B" }, context);

    expect(run.mock.calls.map(([request]) => request.model)).toEqual([
      "provider/model-a",
      "provider/model-b",
    ]);
    expect(ownerActors.status(actor.id)).toMatchObject({
      id: actor.id,
      model: "provider/model-a",
      binding: { model: "provider/model-a", sessionId: "a" },
      projectDefaults: { model: "provider/project-default" },
    });
    expect(peerActors.status(actor.id)).toMatchObject({
      id: actor.id,
      model: "provider/model-b",
      binding: { model: "provider/model-b", sessionId: "b" },
      projectDefaults: { model: "provider/project-default" },
    });
    const registry = JSON.parse(
      fs.readFileSync(path.join(actorRoot, "actors.json"), "utf8"),
    ) as { actors: Array<{ id: string; model?: string }> };
    expect(registry.actors).toContainEqual(
      expect.objectContaining({ id: actor.id, model: "provider/project-default" }),
    );
  });

});

describe("AgentsProvider global actors", () => {
  it("creates a global template and lists it separately from project actors", async () => {
    const { provider, actors, globalActors } = setup();
    const template = await provider.invoke("create", { ...createRequest, scope: "global" }, context);
    expect((template as { name: string }).name).toBe("reviewer");
    expect(globalActors.list()).toHaveLength(1);
    // project scope (default) lists live actors, not templates
    expect(await provider.invoke("actors", {}, context)).toEqual([]);
    expect(await provider.invoke("actors", { scope: "global" }, context)).toHaveLength(1);
    expect(actors.list()).toEqual([]);
  });

  it("imports a global template as a fresh live actor without history", async () => {
    const { provider, actors } = setup();
    await provider.invoke("create", { ...createRequest, scope: "global" }, context);
    const actor = (await provider.invoke("import", { name: "reviewer" }, context)) as {
      id: string;
      name: string;
      messages: number;
    };
    expect(actor.name).toBe("reviewer");
    expect(actors.list()).toHaveLength(1);
    // fresh actor starts with no mailbox history
    expect(actor.messages).toBe(0);
    expect(actors.instructions(actor.id)).toBe(createRequest.instructions);
  });

  it("exports a project actor to a global template without its history", async () => {
    const { provider, actors, globalActors } = setup();
    const actor = (await provider.invoke(
      "create",
      { ...createRequest, extensions: false, tools: ["read"] },
      context,
    )) as { id: string };
    // build some mailbox history so we can prove it is not exported
    await provider.invoke("ask", { id: actor.id, message: "inspect auth" }, context);
    await waitFor(() => actors.status(actor.id).status === "idle");
    expect(actors.status(actor.id).messages).toBeGreaterThan(0);

    const template = (await provider.invoke("export", { id: actor.id }, context)) as {
      name: string;
      instructions: string;
    };
    expect(template.name).toBe("reviewer");
    expect(template.instructions).toBe(createRequest.instructions);
    expect(globalActors.list()).toHaveLength(1);
    // a template carries no history at all
    const stored = globalActors.resolve("reviewer")!;
    expect(stored).not.toHaveProperty("messages");
    expect(stored).not.toHaveProperty("sessionFile");
    expect(stored.extensions).toBe(false);

    // re-importing yields a fresh actor with no inherited history
    const fresh = (await provider.invoke("import", { name: "reviewer", as: "reviewer-2" }, context)) as {
      messages: number;
      extensions?: boolean;
    };
    expect(fresh.messages).toBe(0);
    expect(fresh.extensions).toBe(false);
  });

  it("export collides without overwrite and replaces with it", async () => {
    const { provider } = setup();
    await provider.invoke("create", { ...createRequest, scope: "global" }, context);
    const actor = (await provider.invoke("create", createRequest, context)) as { id: string };
    await expect(provider.invoke("export", { id: actor.id }, context)).rejects.toThrow(/already exists/);
    const replaced = (await provider.invoke("export", { id: actor.id, overwrite: true }, context)) as {
      name: string;
    };
    expect(replaced.name).toBe("reviewer");
  });

  it("migrates a persistent actor model and thinking without replacing its session", async () => {
    const { provider, actors } = setup();
    const actor = (await provider.invoke("create", createRequest, context)) as {
      id: string;
      sessionFile?: string;
    };
    const sessionFile = actors.status(actor.id).sessionFile;

    await provider.invoke(
      "setModel",
      { id: actor.id, model: "anthropic/executor" },
      context,
    );
    await provider.invoke("setThinking", { id: actor.id, thinking: "low" }, context);
    expect(actors.status(actor.id)).toMatchObject({
      model: "anthropic/executor",
      thinking: "low",
      sessionFile,
    });

    await provider.invoke("setModel", { id: actor.id }, context);
    await provider.invoke("setThinking", { id: actor.id }, context);
    expect(actors.status(actor.id)).not.toHaveProperty("model");
    expect(actors.status(actor.id)).not.toHaveProperty("thinking");
    expect(actors.status(actor.id).sessionFile).toBe(sessionFile);
  });

  it("updates tool allowlists for project actors and global templates", async () => {
    const { provider, actors, globalActors } = setup();
    const actor = (await provider.invoke("create", createRequest, context)) as { id: string };
    await provider.invoke("setTools", { id: actor.id, tools: ["read", "grep"] }, context);
    expect(actors.status(actor.id).tools).toEqual(["read", "grep"]);

    await provider.invoke("create", { ...createRequest, name: "templar", scope: "global" }, context);
    const templateId = globalActors.resolve("templar")!.id;
    await provider.invoke(
      "setTools",
      { id: templateId, tools: [], scope: "global" },
      context,
    );
    expect(globalActors.resolve("templar")!.tools).toEqual([]);
  });


  it("accepts the complete host-event catalog through create and setEvents", async () => {
    const { provider, actors } = setup();
    const actor = (await provider.invoke(
      "create",
      {
        ...createRequest,
        events: ["before_agent_start", "tool_call", "tool_result", "message_update"],
      },
      context,
    )) as { id: string };
    expect(actors.status(actor.id).events).toEqual([
      "before_agent_start",
      "tool_call",
      "tool_result",
      "message_update",
    ]);

    await provider.invoke(
      "setEvents",
      { id: actor.id, events: ["context", "before_provider_request", "session_tree"] },
      context,
    );
    expect(actors.status(actor.id).events).toEqual([
      "context",
      "before_provider_request",
      "session_tree",
    ]);
  });

  it("validates and updates delivery policies for project actors and global templates", async () => {
    const { provider, actors, globalActors } = setup();
    const { triggerTurn: _triggerTurn, ...ambiguous } = createRequest;
    await expect(provider.invoke("create", ambiguous, context)).rejects.toThrow(
      /requires explicit triggerTurn/,
    );

    const actor = (await provider.invoke("create", createRequest, context)) as { id: string };
    await provider.invoke(
      "setDeliveryPolicy",
      { id: actor.id, delivery: "steer", triggerTurn: true },
      context,
    );
    expect(actors.status(actor.id)).toMatchObject({ delivery: "steer", triggerTurn: true });

    await provider.invoke(
      "create",
      { ...createRequest, name: "templar", scope: "global" },
      context,
    );
    const templateId = globalActors.resolve("templar")!.id;
    await provider.invoke(
      "setDeliveryPolicy",
      { id: templateId, delivery: "followUp", triggerTurn: true, scope: "global" },
      context,
    );
    expect(globalActors.resolve(templateId)).toMatchObject({
      delivery: "followUp",
      triggerTurn: true,
    });
  });

  it("edits instructions for project and global scopes", async () => {
    const { provider, actors, globalActors } = setup();
    const actor = (await provider.invoke("create", createRequest, context)) as { id: string };
    await provider.invoke("setInstructions", { id: actor.id, instructions: "Be brief." }, context);
    expect(actors.instructions(actor.id)).toBe("Be brief.");

    await provider.invoke("create", { ...createRequest, name: "templar", scope: "global" }, context);
    const globalId = globalActors.resolve("templar")!.id;
    await provider.invoke("setInstructions", { id: globalId, instructions: "Template brief.", scope: "global" }, context);
    expect(globalActors.resolve("templar")!.instructions).toBe("Template brief.");
  });

  it("removes a global template via scoped remove", async () => {
    const { provider, globalActors } = setup();
    const template = (await provider.invoke(
      "create",
      { ...createRequest, scope: "global" },
      context,
    )) as { id: string };
    await provider.invoke("remove", { id: template.id, scope: "global" }, context);
    expect(globalActors.list()).toEqual([]);
  });
});

describe("AgentsProvider steering", () => {
  const readSteerFile = (root: string, id: string): Array<Record<string, unknown>> => {
    const file = path.join(root, "runs", id, "steer.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  it("discovers and addresses the root Main agent through its stable alias", async () => {
    const { provider, mainDeliveries } = setup();

    await expect(provider.invoke("main", {}, context)).resolves.toMatchObject({
      id: "session:test",
      name: "Main",
      kind: "main",
      local: true,
    });
    await expect(
      provider.invoke("status", { id: "main" }, context),
    ).resolves.toMatchObject({ id: "session:test", name: "Main" });

    const steer = await provider.invoke(
      "steer",
      { id: "main", message: "prioritize the failing test", data: { source: "supervisor" } },
      context,
    );
    const followUp = await provider.invoke(
      "followUp",
      { id: "session:test", message: "then summarize the fix" },
      context,
    );

    expect(steer).toEqual({
      queued: true,
      messageId: "main-message-1",
      routed: "main",
    });
    expect(followUp).toEqual({
      queued: true,
      messageId: "main-message-2",
      routed: "main",
    });
    expect(mainDeliveries).toMatchObject([
      {
        from: { id: "session:test", kind: "main" },
        message: "prioritize the failing test",
        delivery: "steer",
        data: { source: "supervisor" },
      },
      {
        message: "then summarize the fix",
        delivery: "followUp",
      },
    ]);
  });

  it("steer routes to a local running agent and queues a steer command", async () => {
    const { provider, root } = setup();
    const handle = (await provider.invoke(
      "spawn",
      { task: "HANG", transport: "process" },
      context,
    )) as { id: string };
    const result = (await provider.invoke(
      "steer",
      { id: handle.id, message: "focus on refresh tokens" },
      context,
    )) as { queued: boolean; messageId: string; routed: string };
    expect(result).toEqual({ queued: true, messageId: expect.any(String), routed: "local" });
    const entries = readSteerFile(root, handle.id);
    expect(entries[0]).toMatchObject({ type: "steer", message: "focus on refresh tokens" });
    await provider.invoke("stop", { id: handle.id }, context);
  });

  it("accepts an owner-addressed control command for a local agent", async () => {
    const { provider, root } = setup();
    const handle = (await provider.invoke(
      "spawn",
      { task: "HANG", transport: "process" },
      context,
    )) as { id: string };
    const acceptance = await provider.acceptControl(
      {
        version: 1,
        commandId: "command-1",
        targetId: handle.id,
        operation: "followUp",
        replyTo: "session:peer",
        message: "summarize after the current turn",
        requestedAt: Date.now(),
      },
      { id: "session:peer", name: "peer", kind: "main", sessionId: "peer" },
    );

    expect(acceptance).toMatchObject({ accepted: true, messageId: expect.any(String) });
    expect(readSteerFile(root, handle.id)[0]).toMatchObject({
      type: "follow_up",
      message: "summarize after the current turn",
    });
    await provider.invoke("stop", { id: handle.id }, context);
  });

  it("steer routes to a local actor as a mailbox message", async () => {
    const { provider } = setup();
    const actor = (await provider.invoke(
      "create",
      { name: "steered", instructions: "reply", responseMode: "text" },
      context,
    )) as { id: string };
    const result = (await provider.invoke(
      "steer",
      { id: actor.id, message: "check session expiry" },
      context,
    )) as { routed: string };
    expect(result.routed).toBe("local");
    const messages = (await provider.invoke("messages", { id: actor.id }, context)) as Array<{
      direction: string;
      data?: { message?: string };
    }>;
    expect(
      messages.some(
        (message) => message.direction === "in" && message.data?.message === "check session expiry",
      ),
    ).toBe(true);
  });

  it("rejects an unknown remote id instead of broadcasting an unverified steer", async () => {
    const { provider } = setup();
    await expect(
      provider.invoke(
        "steer",
        { id: "not-a-local-id", message: "from elsewhere" },
        context,
      ),
    ).rejects.toThrow("Unknown Fabric participant");
  });

  it("setSteeringMode routes to a local agent", async () => {
    const { provider, root } = setup();
    const handle = (await provider.invoke(
      "spawn",
      { task: "HANG", transport: "process" },
      context,
    )) as { id: string };
    await provider.invoke("setSteeringMode", { id: handle.id, mode: "all" }, context);
    const entries = readSteerFile(root, handle.id);
    expect(entries[0]).toMatchObject({ type: "set_steering_mode", mode: "all" });
    await provider.invoke("stop", { id: handle.id }, context);
  });

  it("setSteeringMode throws for a non-local id (no mesh fallback)", async () => {
    const { provider } = setup();
    await expect(
      provider.invoke("setSteeringMode", { id: "unknown-id", mode: "all" }, context),
    ).rejects.toThrow(/Unknown Fabric agent/);
  });

  it("setSteeringMode rejects an invalid mode", async () => {
    const { provider } = setup();
    const handle = (await provider.invoke(
      "spawn",
      { task: "HANG", transport: "process" },
      context,
    )) as { id: string };
    await expect(
      provider.invoke("setSteeringMode", { id: handle.id, mode: "always" }, context),
    ).rejects.toThrow(/Invalid steering mode/);
    await provider.invoke("stop", { id: handle.id }, context);
  });

  it("compact enqueues a compact entry for a running pi child", async () => {
    const { provider, root } = setup();
    const handle = (await provider.invoke(
      "spawn",
      { task: "HANG", transport: "process" },
      context,
    )) as { id: string };
    const result = (await provider.invoke(
      "compact",
      { id: handle.id, instructions: "Keep the test plan" },
      context,
    )) as { queued: true; messageId: string };
    expect(result.queued).toBe(true);
    expect(typeof result.messageId).toBe("string");
    const entries = readSteerFile(root, handle.id);
    expect(entries[0]).toMatchObject({ type: "compact", instructions: "Keep the test plan" });
    await provider.invoke("stop", { id: handle.id }, context);
  });

  it("compact descriptor is agent-risk with required id", async () => {
    const { provider } = setup();
    const descriptor = await provider.describe("compact", context);
    expect(descriptor?.risk).toBe("agent");
    const schema = descriptor?.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(["id"]);
    expect(schema.properties).toHaveProperty("instructions");
    expect(schema.additionalProperties).toBe(false);
  });

  it("compact rejects an unknown id", async () => {
    const { provider } = setup();
    await expect(
      provider.invoke("compact", { id: "not-a-real-id" }, context),
    ).rejects.toThrow(/Unknown Fabric agent/);
  });
});

describe("collectAgentToolPreviewNodes", () => {
  const previewRecord = (overrides: Record<string, unknown>): AgentRunRecord =>
    ({
      id: "id",
      name: "agent",
      task: "task",
      status: "running",
      runner: "pi",
      transport: "process",
      cwd: "/tmp",
      startedAt: 0,
      updatedAt: 0,
      turns: 0,
      toolCalls: 0,
      text: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      ...overrides,
    }) as AgentRunRecord;

  const toolEntry = (record: AgentRunRecord) => ({
    id: `tool-${record.id}`,
    kind: "tool" as const,
    label: "read",
  });

  it("maps a nested run tree onto recursive preview nodes", () => {
    const nodes = collectAgentToolPreviewNodes(
      [
        previewRecord({
          id: "parent",
          name: "parent",
          nestedAgents: [
            previewRecord({
              id: "child",
              name: "child",
              currentTool: "grep",
              nestedAgents: [previewRecord({ id: "grand", name: "grand" })],
            }),
          ],
        }),
      ],
      { tools: (record) => [toolEntry(record)] },
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.tools[0]?.id).toBe("tool-parent");
    const child = nodes[0]?.agents?.[0];
    expect(child).toMatchObject({ id: "child", name: "child", currentTool: "grep", owner: "agent" });
    expect(child?.tools[0]?.id).toBe("tool-child");
    expect(child?.agents?.[0]).toMatchObject({ id: "grand" });
    expect(child?.agentsTruncated).toBeUndefined();
  });

  it("marks nodes whose descendants exceed the depth budget", () => {
    const nodes = collectAgentToolPreviewNodes(
      [
        previewRecord({
          id: "parent",
          nestedAgents: [
            previewRecord({ id: "child", nestedAgents: [previewRecord({ id: "grand" })] }),
          ],
        }),
      ],
      { tools: () => [], maxDepth: 2 },
    );

    const child = nodes[0]?.agents?.[0];
    expect(child?.agents).toBeUndefined();
    expect(child?.agentsTruncated).toBe(true);
  });

  it("caps the total node count across the breadth of the tree", () => {
    const nodes = collectAgentToolPreviewNodes(
      [
        previewRecord({ id: "first" }),
        previewRecord({ id: "second", nestedAgents: [previewRecord({ id: "third" })] }),
        previewRecord({ id: "fourth" }),
      ],
      { tools: () => [], maxNodes: 2 },
    );

    expect(nodes.map((node) => node.id)).toEqual(["first", "second"]);
    expect(nodes[1]?.agents).toBeUndefined();
    expect(nodes[1]?.agentsTruncated).toBe(true);
  });

  it("labels actor-runs with the actor owner kind", () => {
    const nodes = collectAgentToolPreviewNodes(
      [previewRecord({ id: "run", actorId: "actor-1", actorName: "mailbox-bot" })],
      { tools: () => [] },
    );

    expect(nodes[0]).toMatchObject({ owner: "actor", name: "mailbox-bot" });
  });
});

describe("AgentsProvider switchModel", () => {
  const registryModels = [
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { provider: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ];

  const modelContext = (current?: { provider: string; id: string }): FabricInvocationContext => ({
    ...context,
    extensionContext: {
      modelRegistry: { getAvailable: () => registryModels },
      ...(current ? { model: current } : {}),
    } as unknown as ExtensionContext,
  });

  it("describes the action with a required model selector", async () => {
    const { provider } = setup();
    const descriptor = await provider.describe("switchModel", context);
    expect(descriptor?.inputSchema).toMatchObject({ required: ["model"] });
    expect(descriptor?.risk).toBe("agent");
  });

  it("switches an exact provider/id and reports the previous model", async () => {
    const switchModel = vi.fn(async () => ({ ok: true }));
    const { provider } = setup([], [], undefined, {
      switchModel: switchModel as FabricMainAgentTarget["switchModel"],
    });
    const invocation = modelContext({ provider: "anthropic", id: "claude-opus-4-5" });
    const result = await provider.invoke(
      "switchModel",
      { model: "google/gemini-2.5-flash" },
      invocation,
    );
    expect(result).toEqual({
      switched: true,
      model: "google/gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      previous: "anthropic/claude-opus-4-5",
    });
    expect(switchModel).toHaveBeenCalledWith(
      { provider: "google", id: "gemini-2.5-flash" },
      invocation.extensionContext,
    );
  });

  it("resolves aliases configured in models.aliases with fallback chains", async () => {
    const switchModel = vi.fn(async () => ({ ok: true }));
    const { provider } = setup([], [], undefined, {
      switchModel: switchModel as FabricMainAgentTarget["switchModel"],
      modelsConfig: { aliases: { budget: { targets: ["cohere/command-r", "google/gemini-2.5-pro"] } } },
    });
    const result = await provider.invoke(
      "switchModel",
      { model: "Budget" },
      modelContext(),
    );
    expect(result).toMatchObject({
      switched: true,
      model: "google/gemini-2.5-pro",
      alias: "budget",
    });
  });

  it("keeps the current model when the selector is already active", async () => {
    const switchModel = vi.fn(async () => ({ ok: true }));
    const { provider } = setup([], [], undefined, {
      switchModel: switchModel as FabricMainAgentTarget["switchModel"],
    });
    const result = await provider.invoke(
      "switchModel",
      { model: "claude-opus" },
      modelContext({ provider: "anthropic", id: "claude-opus-4-5" }),
    );
    expect(result).toEqual({
      switched: false,
      reason: "already-active",
      model: "anthropic/claude-opus-4-5",
      name: "Claude Opus 4.5",
    });
    expect(switchModel).not.toHaveBeenCalled();
  });

  it("resolves inexact selectors to the closest match and reports the pick", async () => {
    const switchModel = vi.fn(async () => ({ ok: true }));
    const { provider } = setup([], [], undefined, {
      switchModel: switchModel as FabricMainAgentTarget["switchModel"],
    });
    const result = await provider.invoke(
      "switchModel",
      { model: "gemini" },
      modelContext(),
    );
    expect(result).toMatchObject({
      switched: true,
      model: "google/gemini-2.5-pro",
      via: "closest",
    });
    expect(switchModel).toHaveBeenCalledWith(
      { provider: "google", id: "gemini-2.5-pro" },
      expect.anything(),
    );
  });

  it("resolves visible exact, fuzzy, and alias run models before spawning", async () => {
    const { provider, agents } = setup([], [], undefined, {
      modelsConfig: {
        aliases: { fast: { targets: ["opencode/hidden", "google/gemini-2.5-flash"] } },
      },
    });
    const spawn = vi.spyOn(agents, "spawn");
    const selectors = [
      ["google/gemini-2.5-flash", "google/gemini-2.5-flash"],
      ["gemini", "google/gemini-2.5-pro"],
      ["google/gemni-2.5-flash", "google/gemini-2.5-flash"],
      ["fast", "google/gemini-2.5-flash"],
    ] as const;

    for (const [model, expected] of selectors) {
      await provider.invoke(
        "run",
        { task: `run ${model}`, model },
        modelContext(),
      );
      expect(spawn).toHaveBeenLastCalledWith(
        expect.objectContaining({ model: expected }),
        undefined,
      );
    }
  });

  it.each(["run", "spawn"] as const)(
    "preserves a case-insensitive alias thinking default in agents.%s",
    async (action) => {
      const { provider, agents } = setup([], [], undefined, {
        modelsConfig: {
          aliases: {
            fast: { targets: ["provider/model-a"], thinking: "high" },
          },
        },
        agentsConfig: { thinking: "medium" },
      });
      const spawn = vi.spyOn(agents, "spawn");

      const result = await provider.invoke(
        action,
        { task: `alias ${action}`, model: "FAST" },
        context,
      );

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({ model: "provider/model-a", thinking: "high" }),
        undefined,
      );
      if (action === "run") {
        expect(result).toMatchObject({ thinking: "high" });
      } else {
        await expect(agents.wait((result as { id: string }).id)).resolves.toMatchObject({
          thinking: "high",
        });
      }
    },
  );

  it("keeps explicit thinking above an alias and the agent default below it", async () => {
    const { provider, agents } = setup([], [], undefined, {
      modelsConfig: {
        aliases: {
          fast: { targets: ["provider/model-a"], thinking: "high" },
          steady: { targets: ["provider/model-b"] },
        },
      },
      agentsConfig: { thinking: "medium" },
    });
    const spawn = vi.spyOn(agents, "spawn");

    const explicit = (await provider.invoke(
      "spawn",
      { task: "explicit alias level", model: "fast", thinking: "low" },
      context,
    )) as { id: string };
    expect(spawn).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "provider/model-a", thinking: "low" }),
      undefined,
    );
    await expect(agents.wait(explicit.id)).resolves.toMatchObject({ thinking: "low" });

    const fallback = (await provider.invoke(
      "spawn",
      { task: "global default level", model: "steady" },
      context,
    )) as { id: string };
    expect(spawn).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "provider/model-b" }),
      undefined,
    );
    expect(spawn.mock.calls.at(-1)?.[0]).not.toHaveProperty("thinking");
    await expect(agents.wait(fallback.id)).resolves.toMatchObject({ thinking: "medium" });
  });

  it.each(["run", "spawn"] as const)(
    "rejects unavailable exact models for agents.%s",
    async (action) => {
      const { provider, agents } = setup();
      const spawn = vi.spyOn(agents, "spawn");

      await expect(
        provider.invoke(
          action,
          { task: "do not launch", model: "opencode/ox-alpha" },
          modelContext(),
        ),
      ).rejects.toThrow(/not available to this Pi session/);
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it.each(["run", "spawn"] as const)(
    "starts the listed model for agents.%s with modelMatch exact, not an alias with the same name",
    async (action) => {
      const aliases = normalizeModelAliases({
        "provider/model-a": { model: "provider/model-b", thinking: "high" },
      });
      const prepared: Array<[string | undefined, unknown]> = [];
      const { provider, agents } = setup([], [], undefined, {
        modelsConfig: { aliases },
        agentsConfig: { thinking: "medium" },
        // Mirrors the host's launch-boundary re-resolution of the already resolved key.
        preparePiModel: async (model, options) => {
          prepared.push([model, options]);
          const resolved = resolvePiModelSelector(
            model ?? "",
            { aliases, available: visiblePiModels },
            options?.modelMatch,
          );
          return `${resolved.provider}/${resolved.id}`;
        },
      });
      const spawn = vi.spyOn(agents, "spawn");
      const started = async (args: Record<string, unknown>) => {
        const result = await provider.invoke(action, { task: `exact ${action}`, ...args }, context);
        return action === "run"
          ? (result as { model: string; thinking?: string })
          : agents.wait((result as { id: string }).id);
      };

      // Control: without modelMatch the alias wins, with its thinking level.
      await expect(started({ model: "provider/model-a" })).resolves.toMatchObject({
        model: "provider/model-b",
        thinking: "high",
      });
      expect(spawn).toHaveBeenLastCalledWith(
        expect.objectContaining({ model: "provider/model-b", thinking: "high" }),
        undefined,
      );

      await expect(started({ model: "provider/model-a", modelMatch: "exact" })).resolves.toMatchObject({
        model: "provider/model-a",
        thinking: "medium",
      });
      expect(spawn).toHaveBeenLastCalledWith(
        expect.objectContaining({ model: "provider/model-a", modelMatch: "exact" }),
        undefined,
      );
      expect(spawn.mock.calls.at(-1)?.[0]).not.toHaveProperty("thinking");
      expect(prepared.at(-1)).toEqual(["provider/model-a", { modelMatch: "exact" }]);
    },
  );

  it.each(["run", "spawn"] as const)(
    "starts no child for agents.%s when the exact model is not listed",
    async (action) => {
      const { provider, agents } = setup();
      const spawn = vi.spyOn(agents, "spawn");

      await expect(
        provider.invoke(action, { task: "do not launch", model: "provider/model-z", modelMatch: "exact" }, context),
      ).rejects.toThrow(
        'Model "provider/model-z" is not available to this Pi session. ' +
          'Use agents.models({ runner: "pi" }) to list the models visible to this session.',
      );
      expect(spawn).not.toHaveBeenCalled();

      // Control: the same selector without modelMatch resolves to the closest listed model.
      await provider.invoke(action, { task: "closest", model: "provider/model-z" }, context);
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["a bare selector", { model: "model-a" }, EXACT_MODEL_FORM_ERROR],
    ["no model", {}, EXACT_MODEL_FORM_ERROR],
    ["the Claude runner", { runner: "claude", model: "claude/sonnet" }, EXACT_MODEL_RUNNER_ERROR],
    ["the Veda runner", { runner: "veda", model: "provider/model-a" }, EXACT_MODEL_RUNNER_ERROR],
    ["an unknown mode", { model: "provider/model-a", modelMatch: "fuzzy" }, "Invalid Fabric agent modelMatch"],
  ] as const)("refuses modelMatch exact with %s before any child starts", async (_label, args, message) => {
    const { provider, agents } = setup();
    const spawn = vi.spyOn(agents, "spawn");
    for (const action of ["run", "spawn"] as const) {
      await expect(
        provider.invoke(action, { task: "do not launch", modelMatch: "exact", ...args }, context),
      ).rejects.toThrow(message);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("offers modelMatch only on run and spawn, restricted to exact", async () => {
    const { provider } = setup();
    for (const action of ["run", "spawn"]) {
      const schema = (await provider.describe(action, context))?.inputSchema as {
        properties: Record<string, unknown>;
      };
      expect(schema.properties.modelMatch).toMatchObject({ type: "string", enum: ["exact"] });
      const description = (schema.properties.modelMatch as { description: string }).description;
      expect(description).toMatch(/not a security guarantee or final-dispatch enforcement/);
      expect(description).toMatch(/later hooks, unknown API payloads, providers and extension-made calls/i);
      expect(description).toMatch(/only after a call/);
      expect(description).toMatch(/Do not rely on it to prevent data disclosure/);
      expect(Value.Check(schema, { task: "t", model: "provider/model-a", modelMatch: "exact" })).toBe(true);
      expect(Value.Check(schema, { task: "t", model: "provider/model-a", modelMatch: "fuzzy" })).toBe(false);
    }
    // These actions would resolve the model with aliases, so their schemas must refuse the field.
    for (const action of ["handoff", "create", "ask", "tell", "import"]) {
      const schema = (await provider.describe(action, context))?.inputSchema as {
        properties: Record<string, unknown>;
      };
      expect(schema.properties).not.toHaveProperty("modelMatch");
    }
    const handoff = (await provider.describe("handoff", context))?.inputSchema as Parameters<typeof Value.Check>[0];
    expect(Value.Check(handoff, { model: "provider/model-a" })).toBe(true);
    expect(Value.Check(handoff, { model: "provider/model-a", modelMatch: "exact" })).toBe(false);
  });

  it("prominently documents the exact-model contract before use", () => {
    for (const file of ["docs/agents.md", "skillsets/typescript/fabric-exec/references/agents.md", "skillsets/python/fabric-exec/references/agents.md"]) {
      const text = fs.readFileSync(file, "utf8");
      const start = text.indexOf("modelMatch");
      const warning = text.indexOf("not a security guarantee or final-dispatch enforcement", start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(warning).toBeGreaterThan(start);
      expect(text.slice(warning, warning + 400)).toMatch(/later hooks, unknown API payloads, providers[, ]+and extension-made calls/i);
      expect(text.slice(warning, warning + 400)).toMatch(/prevent data disclosure/);
    }
  });

  it("launches near-miss models canonically while isolating unrelated batch failures", async () => {
    const { provider, agents } = setup();
    const spawn = vi.spyOn(agents, "spawn");
    const invocation: FabricInvocationContext = {
      ...context,
      extensionContext: {
        modelRegistry: { getAvailable: () => [
          { provider: "openai-codex", id: "gpt-6-astra" },
          { provider: "openai-codex", id: "gpt-5.6-sol" },
        ] },
      } as unknown as ExtensionContext,
    };
    const results = await Promise.allSettled([
      provider.invoke("spawn", { task: "Astra", model: "openai-codex/gpt-6-astra" }, invocation),
      provider.invoke("spawn", { task: "Sol", model: "openai-codex/gpt-6-sol" }, invocation),
      provider.invoke("spawn", { task: "Unrelated", model: "openai-codex/zzzz" }, invocation),
    ]);
    expect(results[0]).toMatchObject({ status: "fulfilled", value: { model: "openai-codex/gpt-6-astra" } });
    expect(results[1]).toMatchObject({ status: "fulfilled", value: { model: "openai-codex/gpt-5.6-sol" } });
    expect(results[2]).toMatchObject({ status: "rejected", reason: expect.any(Error) });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ model: "openai-codex/gpt-5.6-sol" }), undefined);
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const handle = result.value as { id: string; model: string };
      await expect(agents.wait(handle.id)).resolves.toMatchObject({ status: "completed", model: handle.model });
    }
  });

  it("rejects exhausted Pi model aliases instead of forwarding them", async () => {
    const { provider } = setup([], [], undefined, {
      modelsConfig: {
        aliases: { retired: { targets: ["opencode/old", "opencode/older"] } },
      },
    });

    await expect(
      provider.invoke(
        "run",
        { task: "do not launch", model: "retired" },
        modelContext(),
      ),
    ).rejects.toThrow(/not available to this Pi session.*opencode\/old, opencode\/older/);
  });

  it("rejects unavailable Pi models for handoff and actor creation", async () => {
    const { provider, actors } = setup();
    const deferHandoff = vi.fn(() => ({
      scheduled: true as const,
      status: "deferred" as const,
      boundary: "fabric_exec_end" as const,
    }));
    const invocation = { ...modelContext(), deferHandoff };

    await expect(
      provider.invoke("handoff", { model: "opencode/ox-alpha" }, invocation),
    ).rejects.toThrow(/not available to this Pi session/);
    expect(deferHandoff).not.toHaveBeenCalled();
    await expect(
      provider.invoke(
        "create",
        { name: "hidden actor", instructions: "Do not create.", model: "opencode/ox-alpha" },
        modelContext(),
      ),
    ).rejects.toThrow(/not available to this Pi session/);
    expect(actors.list()).toEqual([]);
  });

  it("rejects unavailable actor setModel and activation overrides", async () => {
    const { provider } = setup();
    const actor = await provider.invoke(
      "create",
      {
        name: "visible actor",
        instructions: "Use only visible models.",
        model: "google/gemini-2.5-flash",
      },
      modelContext(),
    ) as FabricActorInfo;

    await expect(
      provider.invoke("setModel", { id: actor.id, model: "opencode/ox-alpha" }, modelContext()),
    ).rejects.toThrow(/not available to this Pi session/);
    await expect(
      provider.invoke(
        "ask",
        { id: actor.id, message: "Do not run", model: "opencode/ox-alpha" },
        modelContext(),
      ),
    ).rejects.toThrow(/not available to this Pi session/);
    await expect(
      provider.invoke(
        "tell",
        { id: actor.id, message: "Do not queue", model: "opencode/ox-alpha" },
        modelContext(),
      ),
    ).rejects.toThrow(/not available to this Pi session/);
  });

  it("passes Claude and Veda model strings through unchanged", async () => {
    const { provider, agents } = setup();
    const spawn = vi.spyOn(agents, "spawn");

    await provider.invoke(
      "spawn",
      { task: "Claude pass-through", runner: "claude", model: "private/claude-model" },
      modelContext(),
    );
    await provider.invoke(
      "spawn",
      { task: "Veda pass-through", runner: "veda", model: "private/veda-model" },
      modelContext(),
    );

    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      runner: "claude",
      model: "private/claude-model",
    });
    expect(spawn.mock.calls[1]?.[0]).toMatchObject({
      runner: "veda",
      model: "private/veda-model",
    });
  });

  it("rejects unknown selectors and exhausted alias chains", async () => {
    const { provider } = setup([], [], undefined, {
      switchModel: vi.fn(async () => ({ ok: true })) as FabricMainAgentTarget["switchModel"],
      modelsConfig: { aliases: { budget: { targets: ["cohere/command-r", "mistral/mistral-large"] } } },
    });
    await expect(
      provider.invoke("switchModel", { model: "cohere/command-r" }, modelContext()),
    ).rejects.toThrow(/no available model matching "cohere\/command-r"/);
    await expect(
      provider.invoke("switchModel", { model: "budget" }, modelContext()),
    ).rejects.toThrow(/Tried: cohere\/command-r, mistral\/mistral-large/);
  });

  it("surfaces host switch failures as errors", async () => {
    const { provider } = setup([], [], undefined, {
      switchModel: vi.fn(async () => ({
        ok: false,
        error: "No authentication configured for model: google/gemini-2.5-flash",
      })) as FabricMainAgentTarget["switchModel"],
    });
    await expect(
      provider.invoke("switchModel", { model: "google/gemini-2.5-flash" }, modelContext()),
    ).rejects.toThrow(/No authentication configured/);
  });

  it("rejects when Main is not a local host with model control", async () => {
    const { provider } = setup();
    await expect(
      provider.invoke("switchModel", { model: "google/gemini-2.5-flash" }, modelContext()),
    ).rejects.toThrow(/requires a local Main session/);
  });

  const failingRegistryContext = (): FabricInvocationContext => ({
    ...context,
    extensionContext: {
      modelRegistry: {
        getAvailable: () => {
          throw new Error("models.json is not valid JSON");
        },
      },
    } as unknown as ExtensionContext,
  });

  it("rejects agents.models with the registry error instead of an empty list", async () => {
    const { provider } = setup();
    await expect(
      provider.invoke("models", { runner: "pi" }, failingRegistryContext()),
    ).rejects.toThrow(/models\.json is not valid JSON/);
  });

  it("names the registry error when a run model cannot be resolved", async () => {
    const { provider, agents } = setup();
    const spawn = vi.spyOn(agents, "spawn");
    await expect(
      provider.invoke("run", { task: "do not launch", model: "google/gemini-2.5-flash" }, failingRegistryContext()),
    ).rejects.toThrow(/not available to this Pi session[\s\S]*models\.json is not valid JSON/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("names the registry error when switchModel cannot read the registry", async () => {
    const switchModel = vi.fn(async () => ({ ok: true }));
    const { provider } = setup([], [], undefined, {
      switchModel: switchModel as FabricMainAgentTarget["switchModel"],
    });
    await expect(
      provider.invoke("switchModel", { model: "google/gemini-2.5-flash" }, failingRegistryContext()),
    ).rejects.toThrow(/models\.json is not valid JSON/);
    expect(switchModel).not.toHaveBeenCalled();
  });

  it("requires a non-empty model selector", async () => {
    const { provider } = setup([], [], undefined, {
      switchModel: vi.fn(async () => ({ ok: true })) as FabricMainAgentTarget["switchModel"],
    });
    await expect(
      provider.invoke("switchModel", { model: "  " }, modelContext()),
    ).rejects.toThrow(/requires a model selector/);
  });
});

describe("AgentsProvider sleep and wake", () => {
  const NO_CAPABILITIES: FabricRunnerCapabilities = {
    recursiveFabric: false, steer: false, followUp: false, persistentSessions: false, kernels: false,
    handoff: false, modelDiscovery: false, imageInput: false, compaction: false, questions: false,
    sleep: false, writePolicy: false,
  };
  const unregister: Array<() => void> = [];
  afterEach(() => {
    for (const dispose of unregister.splice(0)) dispose();
  });

  const hostedRunner = (id: string, sleep: boolean): { adapter: FabricHostedRunner; calls: string[] } => {
    const calls: string[] = [];
    const adapter: FabricHostedRunner = {
      kind: "hosted",
      id,
      label: `Daemon ${id}`,
      capabilities: { ...NO_CAPABILITIES, sleep },
      prepare: (runContext) => ({ job: runContext.idempotencyKey }),
      start: () => {},
      attach: () => {},
      liveness: () => "running",
      stop: () => ({ confirmed: true }),
      sleep: (locator) => { calls.push(`sleep:${(locator as { job: string }).job}`); },
      wake: (locator) => { calls.push(`wake:${(locator as { job: string }).job}`); },
    };
    unregister.push(registerAgentRunner(adapter));
    return { adapter, calls };
  };

  it("parks and resumes a hosted run through the adapter", async () => {
    const { provider } = setup();
    const { calls } = hostedRunner("napper", true);
    const handle = await provider.invoke("spawn", { task: "Long task", runner: "napper" }, context) as { id: string };

    await expect(provider.invoke("sleep", { id: handle.id }, context))
      .resolves.toEqual({ id: handle.id, requested: "sleep" });
    expect(calls).toEqual([`sleep:${handle.id}`]);
    await expect(provider.invoke("wake", { id: handle.id }, context))
      .resolves.toEqual({ id: handle.id, requested: "wake" });
    expect(calls).toEqual([`sleep:${handle.id}`, `wake:${handle.id}`]);
  });

  it("refuses unknown runs and runners without the sleep capability", async () => {
    const { provider } = setup();
    const { calls } = hostedRunner("insomniac", false);
    const handle = await provider.invoke("spawn", { task: "Long task", runner: "insomniac" }, context) as { id: string };

    await expect(provider.invoke("sleep", { id: handle.id }, context)).rejects.toThrow(/does not support sleep/);
    await expect(provider.invoke("wake", { id: handle.id }, context)).rejects.toThrow(/does not support sleep/);
    expect(calls).toEqual([]);
    await expect(provider.invoke("sleep", { id: "missing" }, context)).rejects.toThrow(/Unknown Fabric agent: missing/);
    await expect(provider.invoke("wake", { id: "missing" }, context)).rejects.toThrow(/Unknown Fabric agent: missing/);
  });

  it("refuses a run whose runner is not hosted", async () => {
    const { provider } = setup();
    const handle = await provider.invoke("spawn", { task: "return a short result", runner: "pi", transport: "process" }, context) as { id: string };

    await expect(provider.invoke("sleep", { id: handle.id }, context)).rejects.toThrow(/^The Pi runner does not support sleep$/);
  });

  it("declares both actions with an id-only input and the agent risk class", async () => {
    const { provider } = setup();
    for (const name of ["sleep", "wake"]) {
      const descriptor = await provider.describe(name, context);
      expect(descriptor).toMatchObject({
        risk: "agent",
        inputSchema: { type: "object", required: ["id"], additionalProperties: false },
        outputSchema: { type: "object", required: ["id", "requested"] },
      });
    }
  });
});

describe("AgentsProvider durable runs from an earlier session", () => {
  it("waits for and reports a durable run that another root session of the project spawned", async () => {
    const state = setup();
    const meshRoot = path.join(state.root, "mesh");
    // The earlier root session's resident host left a settled run in the project mesh.
    const earlierRoot = residentRoot(meshRoot, "session:earlier");
    const id = "9".repeat(32);
    const runDirectory = path.join(earlierRoot, "runs", id);
    fs.mkdirSync(runDirectory, { recursive: true });
    fs.mkdirSync(path.join(earlierRoot, "agents"), { recursive: true });
    const result = {
      id, name: "earlier worker", status: "completed", text: "collected by a new session", task: "work",
      runner: "pi", transport: "process", cwd: process.cwd(), startedAt: 1, updatedAt: 2, finishedAt: 2,
      turns: 1, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    };
    fs.writeFileSync(path.join(runDirectory, "status.json"), JSON.stringify(result));
    fs.writeFileSync(path.join(earlierRoot, "agents", `${id}.json`), JSON.stringify({
      format: RESIDENT_HOST_FORMAT, rootId: "session:earlier", id, runDirectory, handle: result, createdAt: 1, updatedAt: 2,
    }));
    const residency = new ResidencyClient({
      config: {
        format: RESIDENT_HOST_FORMAT,
        rootId: state.identity.id,
        sessionId: "test",
        cwd: process.cwd(),
        projectRoot: process.cwd(),
        meshRoot,
        actorRoot: path.join(state.root, "actors"),
        residencyRoot: residentRoot(meshRoot, state.identity.id),
        fullCodeMode: true,
        agents: DEFAULT_FABRIC_CONFIG.agents,
        mesh: DEFAULT_FABRIC_CONFIG.mesh,
        retention: DEFAULT_FABRIC_CONFIG.retention,
        workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
        fabricExtensionPath: path.resolve("dist/index.js"),
        piBinary: "pi",
        claudeBinary: "claude",
        vedaBinary: "veda",
      },
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      callerScope: () => undefined,
    });
    const provider = new AgentsProvider(
      state.agents,
      state.actors,
      state.globalActors,
      state.mainAgent,
      state.participants,
      state.control,
      state.lifecycle,
      undefined,
      residency,
      undefined,
      () => DEFAULT_FABRIC_CONFIG.models,
    );
    try {
      await expect(provider.invoke("wait", { id }, context)).resolves.toMatchObject({
        id, status: "completed", residency: "durable", text: "collected by a new session",
      });
      await expect(provider.invoke("status", { id }, context)).resolves.toMatchObject({
        id, status: "completed", text: "collected by a new session",
      });
      await expect(provider.invoke("log", { id }, context)).resolves.toMatchObject({ id, runDirectory });
      // A run outside this project's mesh stays unknown.
      await expect(provider.invoke("wait", { id: "8".repeat(32) }, context)).rejects.toThrow(/Unknown Fabric agent/);
    } finally {
      await residency.close();
    }
  });
});
