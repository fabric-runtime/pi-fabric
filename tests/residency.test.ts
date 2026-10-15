import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorManager } from "../src/actors/manager.js";
import { AgentManager } from "../src/agents/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import type { FabricMainAgentDeliveryRequest, FabricMainAgentTarget } from "../src/main-agent.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { ResidencyClient } from "../src/residency/client.js";
import { registerAgentRunner } from "../src/runners.js";
import { normalizeScope, type FabricScope } from "../src/scope.js";
import { ResidentActorClient } from "../src/residency/actor-client.js";
import {
  RESIDENT_HOST_FORMAT,
  residentDeliveryPrefix,
  residentHostId,
  residentRoot,
  type ResidentHostConfig,
  type ResidentHostOwner,
} from "../src/residency/protocol.js";
import { FabricControlPlane } from "../src/topology/control-plane.js";
import { ParticipantDirectory } from "../src/topology/participant-directory.js";
import { actorParticipantRecord } from "../src/topology/records.js";
import type { FabricParticipantSource } from "../src/topology/types.js";

const repo = process.cwd();
const hostPath = path.resolve("dist/residency/launcher.js");
const fakeWorker = path.resolve("tests/fixtures/fake-worker.mjs");
const hasResidentHost = fs.existsSync(hostPath);
const roots: string[] = [];

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// Git normalizes worktree paths its own way (forward slashes, Windows 8.3
// short names resolved), while Node never expands the short form from
// os.tmpdir(), so path text can never match there. Assert the worktree's
// branch registration instead — that is what these checks mean.
const worktreeBranches = (repository: string): string[] =>
  git(repository, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("branch refs/heads/"))
    .map((line) => line.slice("branch refs/heads/".length));

const initRepository = (directory: string): void => {
  fs.mkdirSync(directory, { recursive: true });
  git(directory, "init", "-q");
  git(directory, "config", "user.email", "pi-fabric-tests@example.invalid");
  git(directory, "config", "user.name", "Pi Fabric tests");
  fs.writeFileSync(path.join(directory, "README.md"), "test repository\n");
  git(directory, "add", ".");
  git(directory, "commit", "-qm", "initial");
};

const waitFor = async (predicate: () => boolean, timeoutMs = 7_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for durable residency state");
    await delay(25);
  }
};

const mainTarget = (
  identity: MeshIdentity,
  deliveries: FabricMainAgentDeliveryRequest[],
): FabricMainAgentTarget => ({
  id: identity.id,
  local: true,
  matches: (id) => id === "main" || id === identity.id,
  info: () => {
    throw new Error("not used by residency tests");
  },
  deliverAgent: (request) => {
    deliveries.push(request);
    return { queued: true, messageId: randomId(), routed: "main" };
  },
});

const randomId = (): string => Math.random().toString(16).slice(2);

interface RootHarness {
  root: string;
  mesh: MeshStore;
  meshConfig: typeof DEFAULT_FABRIC_CONFIG.mesh;
  identity: MeshIdentity;
  participants: ParticipantDirectory;
  mainAgent: FabricMainAgentTarget;
  deliveries: FabricMainAgentDeliveryRequest[];
  config: ResidentHostConfig;
}

const rootHarness = async (name: string): Promise<RootHarness> => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fabric-${name}-`));
  roots.push(root);
  const meshRoot = path.join(root, "mesh");
  const meshConfig = { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 };
  const mesh = new MeshStore(meshRoot, meshConfig.maxEventBytes, meshConfig.maxReadEvents);
  const identity: MeshIdentity = {
    id: `session:${name}:${randomId()}`,
    name: "main",
    kind: "main",
    sessionId: name,
  };
  const participants = new ParticipantDirectory(mesh, {
    enabled: true,
    hostId: identity.id,
    rootId: identity.id,
    identity,
    heartbeatMs: 50,
    leaseMs: 300,
  });
  participants.registerSource(() => [{
    format: 1,
    id: identity.id,
    kind: "root",
    rootId: identity.id,
    ownerHostId: identity.id,
    ownerIdentityId: identity.id,
    name: "main",
    status: "idle",
    residency: "session",
    runner: "pi",
    transport: "host",
    capabilities: ["steer", "followUp", "fabric"],
    cwd: repo,
    sessionId: name,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    controlProtocol: "v1",
  }]);
  await participants.start();
  const residencyRoot = residentRoot(meshRoot, identity.id);
  const deliveries: FabricMainAgentDeliveryRequest[] = [];
  return {
    root,
    mesh,
    meshConfig,
    identity,
    participants,
    mainAgent: mainTarget(identity, deliveries),
    deliveries,
    config: {
      format: RESIDENT_HOST_FORMAT,
      rootId: identity.id,
      sessionId: name,
      cwd: repo,
      projectRoot: repo,
      meshRoot,
      actorRoot: path.join(meshRoot, "actors"),
      sessionActorRoot: path.join(meshRoot, "actors", name),
      residencyRoot,
      fullCodeMode: true,
      agents: { ...DEFAULT_FABRIC_CONFIG.agents, timeoutMs: 10_000 },
      mesh: meshConfig,
      retention: DEFAULT_FABRIC_CONFIG.retention,
      workerPath: fakeWorker,
      fabricExtensionPath: path.resolve("dist/index.js"),
      piBinary: "pi",
      claudeBinary: "claude",
      vedaBinary: "veda",
      piModels: {
        available: [
          { provider: "provider", id: "visible", name: "Visible" },
          { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" },
        ],
        aliases: {},
        defaultModel: "provider/visible",
      },
    },
  };
};

const stopResident = async (config: ResidentHostConfig): Promise<void> => {
  const ownerPath = path.join(config.residencyRoot, "owner.json");
  const owner = (() => {
    try {
      return JSON.parse(fs.readFileSync(ownerPath, "utf8")) as ResidentHostOwner;
    } catch {
      return undefined;
    }
  })();
  if (owner?.pid) {
    try {
      process.kill(owner.pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
    await waitFor(() => !fs.existsSync(ownerPath)).catch(() => undefined);
  }
};

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    const residencyDirectory = path.join(root, "mesh", "residency");
    try {
      for (const entry of fs.readdirSync(residencyDirectory)) {
        const config = JSON.parse(
          fs.readFileSync(path.join(residencyDirectory, entry, "config.json"), "utf8"),
        ) as ResidentHostConfig;
        await stopResident(config);
      }
    } catch {
      // No resident host was created.
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("durable cwd validation", () => {
  it("rejects invalid recursive cwd before creating a resident host or request", async () => {
    const state = await rootHarness("resident-cwd-rejection");
    const client = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      hostPath,
    });

    try {
      await expect(
        client.spawnAgent({
          task: "must remain recursive",
          cwd: path.join(state.root, "missing"),
          recursive: true,
          residency: "durable",
        }),
      ).rejects.toThrow(/Invalid Fabric agent cwd/);
      expect(fs.existsSync(path.join(state.config.residencyRoot, "owner.json"))).toBe(false);
      expect(fs.existsSync(path.join(state.config.residencyRoot, "requests"))).toBe(false);
    } finally {
      await client.close();
      await state.participants.close();
    }
  });

  it("refuses a durable custom runner that the resident host could not load", async () => {
    const state = await rootHarness("resident-runner-module");
    const unregister = registerAgentRunner({
      kind: "worker",
      id: "local-only",
      label: "Local only",
      capabilities: {
        recursiveFabric: false, steer: false, followUp: false, persistentSessions: false,
        kernels: false, handoff: false, modelDiscovery: false, imageInput: false,
        compaction: false, questions: false, sleep: false, writePolicy: false,
      },
      launch: () => ({ workerPath: "/bin/true", workerArguments: [] }),
    });
    const client = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      hostPath,
    });
    try {
      await expect(
        client.spawnAgent({ task: "durable", runner: "local-only", residency: "durable" }),
      ).rejects.toThrow(/declares no residentModule/);
      expect(fs.existsSync(path.join(state.config.residencyRoot, "owner.json"))).toBe(false);
    } finally {
      unregister();
      await client.close();
      await state.participants.close();
    }
  });
});

// Known Windows limitation: cross-spawn of the pi binary through bun's
// node_modules shims hangs before the child starts, so the launcher never
// reaches its spawn trace. Durable residency E2E stays POSIX-only until that
// spawn path is resolved; the launcher logic tests below run everywhere.
describe("durable completion receipts", () => {
  const seedCompletion = async (state: RootHarness, status = "completed") => {
    const id = "a".repeat(32);
    const runDirectory = path.join(state.config.residencyRoot, "runs", id);
    const agentsPath = path.join(state.config.residencyRoot, "agents");
    fs.mkdirSync(runDirectory, { recursive: true });
    fs.mkdirSync(agentsPath, { recursive: true });
    const result = {
      id, name: "durable worker", status, text: "authoritative full result", task: "work",
      runner: "pi", transport: "process", cwd: state.root, startedAt: 1, updatedAt: 2, finishedAt: 2,
      turns: 1, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    };
    fs.writeFileSync(path.join(runDirectory, "status.json"), JSON.stringify(result));
    const metadataPath = path.join(agentsPath, `${id}.json`);
    fs.writeFileSync(metadataPath, JSON.stringify({
      format: RESIDENT_HOST_FORMAT, rootId: state.identity.id, id, runDirectory, handle: result, createdAt: 1, updatedAt: 2,
    }));
    const key = `${residentDeliveryPrefix(state.identity.id)}receipt-test`;
    await state.mesh.put({
      key, identity: { id: residentHostId(state.identity.id), name: "resident", kind: "main" }, ifVersion: 0,
      value: {
        format: RESIDENT_HOST_FORMAT, id: "receipt-test", rootId: state.identity.id,
        agentCompletionId: id, from: { id, name: result.name, kind: "agent" },
        delivery: "followUp", triggerTurn: true, message: "truncated legacy summary",
        data: { fabricTruncated: true }, createdAt: 2,
      },
    });
    return { id, result, runDirectory, metadataPath, key };
  };

  it("retracts an already queued completion on late wait and persists the receipt across reconnects", async () => {
    const state = await rootHarness("late-completion-wait");
    const seeded = await seedCompletion(state);
    const onBackgroundComplete = vi.fn();
    const onResultConsumed = vi.fn();
    const options = { config: state.config, mesh: state.mesh, participants: state.participants, mainAgent: state.mainAgent, onBackgroundComplete, onResultConsumed };
    const client = new ResidencyClient(options);
    const reconnect = new ResidencyClient(options);
    try {
      client.start();
      await waitFor(() => onBackgroundComplete.mock.calls.length > 0);
      expect(onBackgroundComplete.mock.calls[0]![0].text).toBe("authoritative full result");
      expect(state.deliveries).toHaveLength(0);
      expect(state.mesh.listAll(residentDeliveryPrefix(state.identity.id))).toHaveLength(1);
      expect((await client.waitAgent(seeded.id)).status).toBe("completed");
      expect(onResultConsumed).toHaveBeenCalledWith(seeded.id);
      expect(JSON.parse(fs.readFileSync(seeded.metadataPath, "utf8")).completionConsumedAt).toBeGreaterThan(0);
      await client.close();
      onBackgroundComplete.mockClear();
      reconnect.start();
      await waitFor(() => state.mesh.listAll(residentDeliveryPrefix(state.identity.id)).length === 0);
      expect(onBackgroundComplete).not.toHaveBeenCalled();
      expect(state.deliveries).toHaveLength(0);
    } finally {
      await client.close();
      await reconnect.close();
      await state.participants.close();
    }
  });

  it("retains an unread envelope across disconnect and acknowledges only actual inbox delivery", async () => {
    const state = await rootHarness("unread-completion-resume");
    const seeded = await seedCompletion(state);
    const onBackgroundComplete = vi.fn();
    const options = { config: state.config, mesh: state.mesh, participants: state.participants, mainAgent: state.mainAgent, onBackgroundComplete };
    const client = new ResidencyClient(options);
    const reconnect = new ResidencyClient(options);
    try {
      client.start();
      await waitFor(() => onBackgroundComplete.mock.calls.length > 0);
      await client.close();
      expect(JSON.parse(fs.readFileSync(seeded.metadataPath, "utf8")).completionConsumedAt).toBeUndefined();
      onBackgroundComplete.mockClear();
      reconnect.start();
      await waitFor(() => onBackgroundComplete.mock.calls.length > 0);
      onBackgroundComplete.mock.calls[0]![1]();
      await waitFor(() => state.mesh.listAll(residentDeliveryPrefix(state.identity.id)).length === 0);
      expect(JSON.parse(fs.readFileSync(seeded.metadataPath, "utf8")).completionConsumedAt).toBeGreaterThan(0);
    } finally {
      await client.close();
      await reconnect.close();
      await state.participants.close();
    }
  });

  it("honors disabled completion notifications for envelopes from an older resident host", async () => {
    const state = await rootHarness("disabled-completion-resume");
    await seedCompletion(state);
    state.config.agents.notifyOnComplete = false;
    const onBackgroundComplete = vi.fn();
    const client = new ResidencyClient({ config: state.config, mesh: state.mesh, participants: state.participants, mainAgent: state.mainAgent, onBackgroundComplete });
    try {
      client.start();
      await waitFor(() => state.mesh.listAll(residentDeliveryPrefix(state.identity.id)).length === 0);
      expect(onBackgroundComplete).not.toHaveBeenCalled();
      expect(state.deliveries).toHaveLength(0);
    } finally {
      await client.close();
      await state.participants.close();
    }
  });

  it("does not consume a result when a durable wait is aborted", async () => {
    const state = await rootHarness("aborted-completion-wait");
    const seeded = await seedCompletion(state, "running");
    const onBackgroundComplete = vi.fn();
    const client = new ResidencyClient({ config: state.config, mesh: state.mesh, participants: state.participants, mainAgent: state.mainAgent, onBackgroundComplete });
    try {
      await expect(client.waitAgent(seeded.id, AbortSignal.abort())).rejects.toThrow("aborted");
      expect(JSON.parse(fs.readFileSync(seeded.metadataPath, "utf8")).completionConsumedAt).toBeUndefined();
      fs.writeFileSync(path.join(seeded.runDirectory, "status.json"), JSON.stringify({ ...seeded.result, status: "completed" }));
      client.start();
      await waitFor(() => onBackgroundComplete.mock.calls.length > 0);
      expect(state.deliveries).toHaveLength(0);
    } finally {
      await client.close();
      await state.participants.close();
    }
  });
});

describe.skipIf(!hasResidentHost || process.platform === "win32")("durable participant residency", () => {
  it("keeps a durable actor responsive after its originating Main closes", { timeout: 45_000 }, async () => {
    const state = await rootHarness("resident-actor");
    const agents = new AgentManager(repo, state.config.agents, {
      workerPath: fakeWorker,
      runRoot: path.join(state.root, "parent-runs"),
      mainAgentId: state.identity.id,
      meshRoot: state.config.meshRoot,
      projectRoot: repo,
      hostId: state.identity.id,
      identityId: state.identity.id,
    });
    const canManage = (id: string): boolean | undefined => {
      const participant = state.participants.get(id);
      return participant ? participant.ownerHostId === state.identity.id : undefined;
    };
    const actors = new ActorManager(
      state.config.sessionId,
      state.identity,
      state.mesh,
      state.meshConfig,
      agents,
      () => {},
      {
        actorRoot: state.config.actorRoot,
        persistent: true,
        canManageActor: canManage,
        claimResidency: "session",
        rootId: state.identity.id,
      },
    );
    state.participants.registerSource(() =>
      actors.listOwned().map((actor) =>
        actorParticipantRecord(
          actor,
          state.identity.id,
          state.identity.id,
          state.identity.id,
          state.identity.id,
        ),
      ),
    );
    actors.subscribe(() => state.participants.scheduleRefresh());
    const client = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      hostPath,
    });
    const actor = await actors.create({
      name: "resident actor",
      instructions: "Persist across Main shutdown.",
      residency: "durable",
      delivery: "mailbox",
    });
    await actors.cede(actor.id);
    await state.participants.refresh();
    await client.ensureActor(actor.id);

    const messageCount = (): number => {
      const registry = JSON.parse(
        fs.readFileSync(path.join(state.config.actorRoot, "actors.json"), "utf8"),
      ) as { actors: Array<{ id: string; messages?: unknown[] }> };
      return registry.actors.find((candidate) => candidate.id === actor.id)?.messages?.length ?? 0;
    };
    const originalControl = new FabricControlPlane(state.mesh, state.identity, {
      enabled: true,
      hostId: state.identity.id,
      pollMs: 20,
      acknowledgementTimeoutMs: 3_000,
    });
    originalControl.start(() => ({ accepted: false }));
    await originalControl.request(
      client.hostId,
      actor.id,
      "followUp",
      { message: "before Main shutdown" },
      client.hostId,
    );
    await waitFor(() => messageCount() >= 2);
    await originalControl.close();

    await actors.close();
    await agents.close();
    await state.participants.close();
    await client.close();

    const peerIdentity: MeshIdentity = {
      id: `session:peer:${randomId()}`,
      name: "peer",
      kind: "main",
      sessionId: "peer",
    };
    const peerControl = new FabricControlPlane(state.mesh, peerIdentity, {
      enabled: true,
      hostId: peerIdentity.id,
      pollMs: 20,
      acknowledgementTimeoutMs: 3_000,
    });
    peerControl.start(() => ({ accepted: false }));
    const before = messageCount();
    await peerControl.request(
      residentHostId(state.identity.id),
      actor.id,
      "followUp",
      { message: "after Main shutdown" },
      residentHostId(state.identity.id),
    );
    await waitFor(() => messageCount() >= before + 2);
    await peerControl.request(
      residentHostId(state.identity.id),
      actor.id,
      "stop",
      {},
      residentHostId(state.identity.id),
    );
    await peerControl.close();

    expect(messageCount()).toBeGreaterThanOrEqual(before + 2);
    const detachedParticipants: FabricParticipantSource = {
      list: () => [],
      get: () => undefined,
      self: () => {
        throw new Error("not used by detached residency client");
      },
      peers: () => [],
      async refresh() {},
      scheduleRefresh() {},
    };
    const reconnect = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: detachedParticipants,
      mainAgent: state.mainAgent,
      hostPath,
    });
    await expect(reconnect.removeActor(actor.id)).resolves.toEqual({ removed: true });
    const registry = JSON.parse(
      fs.readFileSync(path.join(state.config.actorRoot, "actors.json"), "utf8"),
    ) as { actors: Array<{ id: string }> };
    expect(registry.actors.some((candidate) => candidate.id === actor.id)).toBe(false);
    await reconnect.close();
  });

  it("queues passive actor delivery until Main resumes", { timeout: 45_000 }, async () => {
    const state = await rootHarness("resident-delivery");
    const agents = new AgentManager(repo, state.config.agents, {
      workerPath: fakeWorker,
      runRoot: path.join(state.root, "parent-delivery-runs"),
      mainAgentId: state.identity.id,
      meshRoot: state.config.meshRoot,
      projectRoot: repo,
      hostId: state.identity.id,
      identityId: state.identity.id,
    });
    const actors = new ActorManager(
      state.config.sessionId,
      state.identity,
      state.mesh,
      state.meshConfig,
      agents,
      () => {},
      {
        actorRoot: state.config.actorRoot,
        persistent: true,
        claimResidency: "session",
        rootId: state.identity.id,
      },
    );
    state.participants.registerSource(() =>
      actors.listOwned().map((actor) =>
        actorParticipantRecord(
          actor,
          state.identity.id,
          state.identity.id,
          state.identity.id,
          state.identity.id,
        ),
      ),
    );
    actors.subscribe(() => state.participants.scheduleRefresh());
    const client = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      hostPath,
    });
    const actor = await actors.create({
      name: "resident delivery",
      instructions: "Reply to every message.",
      residency: "durable",
      delivery: "followUp",
      triggerTurn: false,
    });
    await actors.cede(actor.id);
    await state.participants.refresh();
    await client.ensureActor(actor.id);
    const control = new FabricControlPlane(state.mesh, state.identity, {
      enabled: true,
      hostId: state.identity.id,
      pollMs: 20,
      acknowledgementTimeoutMs: 3_000,
    });
    control.start(() => ({ accepted: false }));
    await control.request(client.hostId, actor.id, "followUp", { message: "respond" }, client.hostId);
    const prefix = residentDeliveryPrefix(state.identity.id);
    await waitFor(() => state.mesh.listAll(prefix).length === 1);
    expect(state.deliveries).toEqual([]);

    client.start();
    await waitFor(() => state.deliveries.length === 1);
    expect(state.deliveries[0]).toMatchObject({
      from: { id: actor.id, kind: "actor" },
      delivery: "followUp",
      triggerTurn: false,
      message: "fake worker complete",
    });
    // Delivery lands before MeshStore.delete completes its locked write, so
    // poll the queue drain instead of asserting the removal synchronously.
    await waitFor(() => state.mesh.listAll(prefix).length === 0);
    expect(state.mesh.listAll(prefix)).toEqual([]);

    await client.removeActor(actor.id);
    await control.close();
    await client.close();
    await actors.close();
    await agents.close();
    await state.participants.close();
  });

  it("creates durable actors through root and nested owner channels while Main owns the registry", { timeout: 45_000 }, async () => {
    const state = await rootHarness("resident-recruitment");
    const agents = new AgentManager(repo, state.config.agents, {
      workerPath: fakeWorker,
      runRoot: path.join(state.root, "recruitment-runs"),
      mainAgentId: state.identity.id,
      meshRoot: state.config.meshRoot,
      projectRoot: repo,
      hostId: state.identity.id,
      identityId: state.identity.id,
    });
    const canManage = (id: string): boolean | undefined => {
      const participant = state.participants.get(id);
      return participant ? participant.ownerHostId === state.identity.id : undefined;
    };
    const actors = new ActorManager(
      state.config.sessionId,
      state.identity,
      state.mesh,
      state.meshConfig,
      agents,
      () => {},
      {
        actorRoot: state.config.actorRoot,
        persistent: true,
        canManageActor: canManage,
        claimResidency: "session",
        rootId: state.identity.id,
      },
    );
    state.participants.registerSource(() =>
      actors.listOwned().map((actor) =>
        actorParticipantRecord(
          actor,
          state.identity.id,
          state.identity.id,
          state.identity.id,
          state.identity.id,
        ),
      ),
    );
    actors.subscribe(() => state.participants.scheduleRefresh());
    const client = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      hostPath,
    });

    try {
      const mainOwned = await actors.create({
        name: "main registry owner",
        instructions: "Keep the local registry guarded.",
        residency: "session",
      });
      await state.participants.refresh();
      expect(state.participants.get(mainOwned.id)?.ownerHostId).toBe(state.identity.id);

      const first = await client.createActor({
        name: "recruited architect",
        instructions: "Design the bounded change.",
        residency: "durable",
      });
      expect(state.participants.get(first.id)).toMatchObject({
        ownerHostId: client.hostId,
        residency: "durable",
      });

      const recruitment = new ResidentActorClient(
        state.config.meshRoot,
        state.identity.id,
      );
      const second = await recruitment.createActor({
        scope: "session",
        name: "recruited advisor",
        instructions: "Challenge the design.",
        residency: "durable",
      });
      await waitFor(() => state.participants.get(second.id)?.ownerHostId === client.hostId);

      const residentActors = [first, second];
      expect(residentActors.map((actor) => actor.name).sort()).toEqual([
        "recruited advisor",
        "recruited architect",
      ]);
      expect(residentActors.every((actor) => actor.residency === "durable")).toBe(true);
      expect(first.scope).toBe("project");
      expect(second.scope).toBe("session");
      expect(second.sessionFile).toContain(path.join(state.config.sessionActorRoot!, second.id));
      expect(new Set(residentActors.map((actor) => actor.sessionFile)).size).toBe(2);

      for (const actor of residentActors) await client.removeActor(actor.id);
      await actors.remove(mainOwned.id);
    } finally {
      await client.close();
      await actors.close();
      await agents.close();
      await state.participants.close();
    }
  });

  it("rejects a durable actor model that became hidden at the resident owner", { timeout: 45_000 }, async () => {
    const state = await rootHarness("resident-hidden-model");
    const client = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      hostPath,
    });
    const control = new FabricControlPlane(state.mesh, state.identity, {
      enabled: true,
      hostId: state.identity.id,
      pollMs: 20,
      acknowledgementTimeoutMs: 3_000,
    });
    control.start(() => ({ accepted: false }));

    try {
      const actor = await client.createActor({
        name: "visibility witness",
        instructions: "Run only while the bound model remains visible.",
        residency: "durable",
        runner: "pi",
        model: "provider/visible",
      });
      state.config.piModels = {
        available: [],
        aliases: {},
        defaultModel: "provider/visible",
      };
      await client.ensureHost();

      await expect(
        control.request(
          client.hostId,
          actor.id,
          "followUp",
          { message: "Do not launch the hidden binding" },
          client.hostId,
        ),
      ).rejects.toThrow(/not available to this Pi session/);
      await client.removeActor(actor.id);
    } finally {
      await control.close();
      await client.close();
      await state.participants.close();
      await stopResident(state.config);
    }
  });

  it("applies live model guidance snapshots to durable participants", { timeout: 45_000 }, async () => {
    const state = await rootHarness("resident-guidance");
    const client = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      hostPath,
    });
    const guidance = (content: string) => [{
      componentId: "deepseek-guidance",
      component: "deepseek-guidance",
      revision: 1,
      label: "deepseek",
      models: ["deepseek/*"],
      targets: ["participant" as const],
      placement: "append" as const,
      content,
    }];

    client.updateModelGuidance(guidance("First durable guidance"));
    const first = await client.spawnAgent({
      task: "First guided durable agent",
      transport: "process",
      residency: "durable",
      model: "deepseek/deepseek-chat",
    });
    const firstResult = await client.waitAgent(first.id);
    expect((firstResult as typeof firstResult & { systemPrompt?: string }).systemPrompt).toBe(
      "First durable guidance",
    );

    client.updateModelGuidance(guidance("Revised durable guidance"));
    const second = await client.spawnAgent({
      task: "Second guided durable agent",
      transport: "process",
      residency: "durable",
      model: "deepseek/deepseek-chat",
    });
    const secondResult = await client.waitAgent(second.id);
    expect((secondResult as typeof secondResult & { systemPrompt?: string }).systemPrompt).toBe(
      "Revised durable guidance",
    );

    await client.cleanupAgent(first.id);
    await client.cleanupAgent(second.id);
    await client.close();
    await state.participants.close();
  });

  it("launches durable agents with the forwarded scope and records it", { timeout: 45_000 }, async () => {
    const state = await rootHarness("resident-scope");
    const client = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      hostPath,
    });
    const scope = normalizeScope({ principal: { id: "user:alice" }, grants: [{ resource: "fs:/repo/**", actions: ["read"] }] });
    const handle = await client.spawnAgent({
      task: "Scoped durable agent", transport: "process", residency: "durable", inheritedScope: scope,
    });
    const metadata = JSON.parse(fs.readFileSync(
      path.join(state.config.residencyRoot, "agents", `${handle.id}.json`), "utf8",
    )) as { scope?: FabricScope };
    expect(metadata.scope).toEqual(JSON.parse(JSON.stringify(scope)));
    await expect(client.spawnAgent({
      task: "Forged", transport: "process", residency: "durable",
      inheritedScope: { ...scope, grants: [{ resource: "fs:*", actions: ["write"] }] },
    })).rejects.toThrow(/Invalid forwarded Fabric scope/);
    await client.waitAgent(handle.id);
    await client.cleanupAgent(handle.id);
    await client.close();
    await state.participants.close();
  });

  it("completes and cleans a durable agent after its originating Main closes", { timeout: 45_000 }, async () => {
    const state = await rootHarness("resident-agent");
    const client = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      hostPath,
    });
    const handle = await client.spawnAgent({
      task: "STREAM_PREVIEW",
      transport: "process",
      residency: "durable",
    });
    expect(handle.residency).toBe("durable");

    await client.close();
    await state.participants.close();

    const detachedParticipants: FabricParticipantSource = {
      list: () => [],
      get: () => undefined,
      self: () => {
        throw new Error("not used by detached residency client");
      },
      peers: () => [],
      async refresh() {},
      scheduleRefresh() {},
    };
    const reconnect = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: detachedParticipants,
      mainAgent: state.mainAgent,
      hostPath,
    });
    const result = await reconnect.waitAgent(handle.id);
    expect(result).toMatchObject({
      id: handle.id,
      status: "completed",
      residency: "durable",
      text: "stream preview complete",
    });
    await expect(reconnect.cleanupAgent(handle.id)).resolves.toEqual({ cleaned: true });
    expect(reconnect.hasAgent(handle.id)).toBe(false);
    await reconnect.close();
  });

  it("rejects tampered durable worktree metadata before destructive cleanup", { timeout: 45_000 }, async () => {
    const state = await rootHarness("resident-worktree-tamper");
    const source = path.join(state.root, "source");
    const unrelated = path.join(state.root, "unrelated");
    initRepository(source);
    initRepository(unrelated);
    const id = randomId().padEnd(32, "0").slice(0, 32);
    const branch = `pi-fabric/tampered-${id.slice(0, 8)}`;
    const worktree = path.join(source, ".pi", "fabric", "worktrees", id);
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    git(source, "worktree", "add", "-q", "-b", branch, worktree, "HEAD");
    const runDirectory = path.join(state.config.residencyRoot, "runs", id);
    fs.mkdirSync(runDirectory, { recursive: true });
    fs.writeFileSync(path.join(runDirectory, "status.json"), JSON.stringify({
      id,
      name: "tampered worktree",
      task: "test",
      status: "completed",
      runner: "pi",
      transport: "process",
      cwd: worktree,
      startedAt: 1,
      updatedAt: 1,
      finishedAt: 1,
      turns: 0,
      toolCalls: 0,
      text: "complete",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    }));
    const metadataPath = path.join(state.config.residencyRoot, "agents", `${id}.json`);
    const metadata = {
      format: RESIDENT_HOST_FORMAT,
      rootId: state.identity.id,
      id,
      runDirectory,
      handle: {
        id,
        name: "tampered worktree",
        status: "completed",
        runner: "pi",
        transport: "process",
        cwd: worktree,
        residency: "durable",
        branch,
        worktree,
      },
      worktreeGitRoot: unrelated,
      createdAt: 1,
      updatedAt: 1,
    };
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    const client = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      hostPath,
    });

    try {
      await expect(client.cleanupAgent(id, true)).rejects.toThrow(/not registered/);
      expect(worktreeBranches(source)).toContain(branch);
      expect(git(source, "branch", "--list", branch)).toContain(branch);
      expect(fs.existsSync(runDirectory)).toBe(true);

      fs.writeFileSync(metadataPath, JSON.stringify({ ...metadata, worktreeGitRoot: source }));
      await expect(client.cleanupAgent(id, true)).resolves.toEqual({ cleaned: true });
      expect(worktreeBranches(source)).not.toContain(branch);
      expect(git(source, "branch", "--list", branch)).toBe("");
      expect(fs.existsSync(runDirectory)).toBe(false);
    } finally {
      try {
        git(source, "worktree", "remove", "--force", worktree);
      } catch {
        // A failed assertion may follow an implementation that already removed it.
      }
      try {
        git(source, "branch", "-D", branch);
      } catch {
        // The worktree removal may already have removed its branch.
      }
      await client.close();
      await state.participants.close();
    }
  });

  it.each([false, true])("forwards and reports a canonical durable agent cwd (recursive=%s)", { timeout: 45_000 }, async (recursive) => {
    const state = await rootHarness("resident-agent-cwd");
    state.config.cwd = state.root;
    state.config.projectRoot = state.root;
    const target = path.join(state.root, "child");
    fs.mkdirSync(target);
    if (recursive) vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", '["read","fabric_exec"]');
    const client = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      hostPath,
    });

    const handle = await client.spawnAgent({
      task: "REPORT_RECURSIVE_CWD",
      kernel: "python",
      cwd: "child",
      tools: ["read", "bash", "write"],
      recursive,
      transport: "process",
      residency: "durable",
    });
    const canonical = fs.realpathSync(target);
    expect(handle.cwd).toBe(canonical);
    expect(handle.kernel).toBe("python");

    const result = await client.waitAgent(handle.id);
    expect(result.cwd).toBe(canonical);
    if (recursive) {
      expect(result).toMatchObject({ recursive: true, tools: ["read", "fabric_exec"], grantedRisks: ["agent"] });
    }
    expect(client.statusAgent(handle.id)).toMatchObject({ cwd: canonical });
    expect(client.readAgentLog(handle.id).status?.cwd).toBe(canonical);
    const reopened = new ResidencyClient(client.options);
    expect(reopened.statusAgent(handle.id)).toMatchObject({ cwd: canonical, kernel: "python", ...(recursive ? { recursive: true } : {}) });
    await reopened.close();
    await expect(client.cleanupAgent(handle.id)).resolves.toEqual({ cleaned: true });
    await client.close();
    await state.participants.close();
  });
});

const hostedRunnerModule = path.resolve("tests/fixtures/resident-hosted-runner.mjs");
const crashingHostPath = path.resolve("tests/fixtures/fake-resident-host-crash.mjs");

const readOwnerPid = (config: ResidentHostConfig): number | undefined => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(config.residencyRoot, "owner.json"), "utf8")) as ResidentHostOwner).pid;
  } catch {
    return undefined;
  }
};

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A durable agent record left non-terminal, as a host that died mid-run leaves it. */
const seedRunningDurableAgent = (state: RootHarness, options: { hosted: boolean }): string => {
  const id = "b".repeat(32);
  const runDirectory = path.join(state.config.residencyRoot, "runs", id);
  const agentsPath = path.join(state.config.residencyRoot, "agents");
  fs.mkdirSync(runDirectory, { recursive: true });
  fs.mkdirSync(agentsPath, { recursive: true });
  const record = {
    id, name: "orphaned durable worker", status: "running", text: "", task: "work",
    runner: options.hosted ? "seeded-hosted" : "pi", transport: "process", cwd: state.root, startedAt: 1, updatedAt: 1,
    turns: 0, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    ...(options.hosted ? { hosted: { locator: { runDirectory } } } : {}),
  };
  fs.writeFileSync(path.join(runDirectory, "status.json"), JSON.stringify(record));
  fs.writeFileSync(path.join(agentsPath, `${id}.json`), JSON.stringify({
    format: RESIDENT_HOST_FORMAT, rootId: state.identity.id, id, runDirectory, handle: record, createdAt: 1, updatedAt: 1,
  }));
  return id;
};

// These run a real resident host, so they need the build output and a POSIX host.
const skipRealResidentHost = (skip: (condition: boolean, note?: string) => void): void => {
  skip(!hasResidentHost, "needs dist/residency/launcher.js; run `bun run build` first");
  skip(process.platform === "win32", "POSIX-only: on Windows spawnDetached does not detach the resident host, and the resident-host suites here are not verified there");
};

describe("durable wait after the resident host dies", () => {
  it("restarts the resident host once for concurrent waiters and returns the re-attached result", { timeout: 60_000 }, async ({ skip }) => {
    skipRealResidentHost(skip);
    const state = await rootHarness("resident-wait-dead-host");
    // The repository's own pi, with a scratch agent directory.
    state.config.piBinary = path.resolve("node_modules/.bin/pi");
    state.config.agents.timeoutMs = 120_000;
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(state.root, "pi-agent"));
    const fixture = await import(hostedRunnerModule) as { RESIDENT_HOSTED_RUNNER_ID: string; HOSTED_EVENTS_FILE: string; unregister: () => void };
    const client = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      hostPath,
    });
    try {
      const handle = await client.spawnAgent({
        task: "settles only after a re-attach",
        runner: fixture.RESIDENT_HOSTED_RUNNER_ID,
        residency: "durable",
      });
      const eventsFile = path.join(state.config.residencyRoot, "runs", handle.id, fixture.HOSTED_EVENTS_FILE);
      await waitFor(() => fs.existsSync(eventsFile));
      const firstHost = readOwnerPid(state.config);
      expect(firstHost).toBeTypeOf("number");
      process.kill(firstHost!, "SIGKILL");
      await waitFor(() => !processAlive(firstHost!));
      expect(client.statusAgent(handle.id).status).toBe("running");

      const launcherStarts = (): number => fs.readFileSync(path.join(state.config.residencyRoot, "launcher.log"), "utf8")
        .split("\n").filter((line) => line.includes('"launcher-started"')).length;
      expect(launcherStarts()).toBe(1);

      // Two concurrent waiters; bounded so a wait that never restarts the host fails instead of hanging.
      const results = await Promise.all([
        client.waitAgent(handle.id, AbortSignal.timeout(40_000)),
        client.waitAgent(handle.id, AbortSignal.timeout(40_000)),
      ]);

      for (const result of results) {
        expect(result).toMatchObject({ id: handle.id, status: "completed", text: "finished after re-attach" });
      }
      // The waiters shared one restart.
      expect(launcherStarts()).toBe(2);
      const secondHost = readOwnerPid(state.config);
      expect(secondHost).toBeTypeOf("number");
      expect(secondHost).not.toBe(firstHost);
      expect(fs.readFileSync(eventsFile, "utf8").trim().split("\n")).toEqual([
        `start ${firstHost}`,
        `attach ${secondHost}`,
      ]);
    } finally {
      fixture.unregister();
      await client.close();
      await state.participants.close();
    }
  });

  it("fails the wait with the start error when the resident host cannot start", { timeout: 30_000 }, async ({ skip }) => {
    skipRealResidentHost(skip);
    const state = await rootHarness("resident-wait-unstartable-host");
    state.config.piBinary = path.join(state.root, "missing-pi-binary");
    const id = seedRunningDurableAgent(state, { hosted: true });
    const client = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      hostPath,
    });
    try {
      await expect(client.waitAgent(id, AbortSignal.timeout(20_000)))
        .rejects.toThrow(/Fabric resident host failed to start: .*missing-pi-binary/);
    } finally {
      await client.close();
      await state.participants.close();
    }
  });
});

describe("durable wait against a resident host that keeps dying", () => {
  it("fails at once, without starting a host, for a run a new host cannot re-attach", { timeout: 30_000 }, async () => {
    const state = await rootHarness("resident-wait-unadoptable-run");
    const id = seedRunningDurableAgent(state, { hosted: false });
    const client = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      hostPath: crashingHostPath,
    });
    fs.writeFileSync(path.join(state.config.residencyRoot, "fake-host.json"), JSON.stringify({ hostId: client.hostId }));
    try {
      await expect(client.waitAgent(id, AbortSignal.timeout(20_000)))
        .rejects.toThrow(`Durable Fabric agent ${id} (runner pi) cannot finish: its resident host ${client.hostId} stopped, and a new host re-attaches only hosted runs`);
      expect(fs.existsSync(path.join(state.config.residencyRoot, "launches.log"))).toBe(false);
      expect(client.statusAgent(id).status).toBe("running");
    } finally {
      await client.close();
      await state.participants.close();
    }
  });

  it("restarts the host a bounded number of times, then fails the wait", { timeout: 30_000 }, async () => {
    const state = await rootHarness("resident-wait-crashing-host");
    const id = seedRunningDurableAgent(state, { hosted: true });
    const client = new ResidencyClient({
      config: state.config,
      mesh: state.mesh,
      participants: state.participants,
      mainAgent: state.mainAgent,
      hostPath: crashingHostPath,
    });
    fs.writeFileSync(path.join(state.config.residencyRoot, "fake-host.json"), JSON.stringify({ hostId: client.hostId }));
    try {
      await expect(client.waitAgent(id, AbortSignal.timeout(20_000)))
        .rejects.toThrow(/resident host .* stopped 3 times/);
      const launches = fs.readFileSync(path.join(state.config.residencyRoot, "launches.log"), "utf8").trim().split("\n");
      expect(launches).toHaveLength(3);
      expect(client.statusAgent(id).status).toBe("running");
    } finally {
      await client.close();
      await state.participants.close();
    }
  });
});
