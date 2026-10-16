import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GlobalActorRegistry } from "../src/actors/global-registry.js";
import type { FabricActivityRun } from "../src/activity/types.js";
import type { FabricState } from "../src/fabric-state.js";
import type { AgentRunRecord } from "../src/agents/types.js";
import type { FabricParticipantInfo } from "../src/topology/types.js";
import { createDashboardSnapshot } from "../src/ui/snapshot.js";

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0 };

const record = (id: string, nestedAgents?: AgentRunRecord[]): AgentRunRecord => ({
  id,
  name: id,
  task: `Inspect ${id}`,
  status: "running",
  runner: "pi",
  transport: "process",
  cwd: "/tmp/project",
  startedAt: 100,
  updatedAt: 200,
  turns: 1,
  toolCalls: 1,
  text: "",
  usage,
  ...(nestedAgents ? { nestedAgents } : {}),
});

const run = (
  id: string,
  ref: string,
  entityId: string,
  startedAt: number,
  phaseId?: string,
): FabricActivityRun => ({
  id,
  name: id,
  status: "completed",
  phases: phaseId
    ? [{ id: phaseId, name: phaseId, status: "completed", startedAt, updatedAt: startedAt }]
    : [],
  calls: [
    {
      id: `${id}-call`,
      ref,
      label: ref,
      kind: "agent",
      status: "completed",
      entityId,
      startedAt,
      updatedAt: startedAt,
      ...(phaseId ? { phaseId } : {}),
    },
  ],
  items: [],
  events: [],
  startedAt,
  updatedAt: startedAt,
  finishedAt: startedAt,
});

const fakeState = (
  runs: FabricActivityRun[],
  records: AgentRunRecord[],
  actors: unknown[] = [],
  peers: unknown[] = [],
  participants: FabricParticipantInfo[] = [],
): FabricState =>
  ({
    activity: { runs: () => runs },
    peerInfos: () => peers,
    participantInfos: () => participants,
    mainAgentInfo: () => ({
      id: "session:test",
      name: "Main",
      kind: "main",
      status: "idle",
      runner: "pi",
      transport: "host",
      cwd: "/tmp/project",
      sessionId: "test",
      startedAt: 1,
      updatedAt: 1,
      pendingMessages: false,
      local: true,
    }),
    agents: { list: () => records },
    actors: { list: () => actors, instructions: () => "", messages: () => [] },
    globalActors: { list: () => [] },
    config: { mesh: { enabled: false } },
    mesh: { list: () => [] },
  }) as unknown as FabricState;

describe("dashboard snapshot agent ownership", () => {
  it("always includes the user-facing Main Pi agent", () => {
    const snapshot = createDashboardSnapshot(fakeState([], []), []);

    expect(snapshot.main).toMatchObject({
      id: "session:test",
      name: "Main",
      kind: "main",
      status: "idle",
      transport: "host",
      local: true,
    });
    expect(snapshot.agents).toEqual([]);
  });

  it("includes concurrent root sessions as peers without relabeling Main", () => {
    const peer = {
      id: "session:peer-session",
      name: "Peer peer-ses",
      kind: "peer",
      status: "running",
      runner: "pi",
      transport: "host",
      cwd: "/tmp/project",
      sessionId: "peer-session",
      startedAt: 1,
      updatedAt: 2,
      pendingMessages: false,
      local: false,
    };
    const snapshot = createDashboardSnapshot(fakeState([], [], [], [peer]), []);

    expect(snapshot.main.name).toBe("Main");
    expect(snapshot.peers).toEqual([peer]);
  });

  it("orders agents by creation regardless of status or recent activity", () => {
    const first = {
      ...record("first"),
      status: "completed" as const,
      startedAt: 100,
      updatedAt: 900,
    };
    const second = {
      ...record("second"),
      status: "running" as const,
      startedAt: 200,
      updatedAt: 800,
    };
    const third = {
      ...record("third"),
      status: "queued" as const,
      startedAt: 300,
      updatedAt: 700,
    };

    const snapshot = createDashboardSnapshot(fakeState([], [third, first, second]), []);

    expect(snapshot.agents.map((agent) => agent.id)).toEqual(["first", "second", "third"]);
  });

  it("preserves structured agent result values", () => {
    const structured = {
      ...record("structured"),
      status: "completed" as const,
      value: { findings: [{ severity: "high" }], approved: false },
    };

    const snapshot = createDashboardSnapshot(fakeState([], [structured]), []);

    expect(snapshot.agents[0]?.value).toEqual(structured.value);
    expect(snapshot.agents[0]?.value).not.toBe(structured.value);
  });

  it("keeps launch ownership when a later status call returns the same agent id", () => {
    const child = record("agent-child");
    const parent = record("agent-parent", [child]);
    const launch = run("launch-run", "agents.spawn", parent.id, 100, "investigate");
    const status = run("status-run", "agents.status", parent.id, 200);

    const snapshot = createDashboardSnapshot(fakeState([status, launch], [parent]), []);
    const parentUi = snapshot.agents.find((agent) => agent.id === parent.id);
    const childUi = snapshot.agents.find((agent) => agent.id === child.id);

    expect(snapshot.runs[0]?.id).toBe("launch-run");
    expect(parentUi).toMatchObject({ runId: "launch-run", phaseId: "investigate" });
    expect(childUi).toMatchObject({
      parentId: parent.id,
      runId: "launch-run",
      phaseId: "investigate",
    });
  });

  it("skips unrelated tool history when resolving agent ownership", () => {
    const parent = record("agent-parent");
    const launch = run("launch-run", "agents.spawn", parent.id, 100, "investigate");
    const unrelated = [1, 2].map((index) => ({
      id: `tool-${index}`,
      get ref(): string {
        throw new Error("unrelated tool call entered agent-link sorting");
      },
      label: "pi.read",
      kind: "tool" as const,
      status: "completed" as const,
      startedAt: index,
      updatedAt: index,
    }));
    launch.calls.push(...unrelated);

    const snapshot = createDashboardSnapshot(fakeState([launch], [parent]), []);

    expect(snapshot.agents[0]).toMatchObject({ runId: "launch-run", phaseId: "investigate" });
  });

  it("includes recursively nested agents with inherited ownership", () => {
    const grandchild = { ...record("agent-grandchild"), logFile: "/tmp/agent-grandchild/events.jsonl" };
    const child = record("agent-child", [grandchild]);
    const parent = record("agent-parent", [child]);
    const launch = run("launch-run", "agents.spawn", parent.id, 100, "investigate");

    const snapshot = createDashboardSnapshot(fakeState([launch], [parent]), []);
    expect(snapshot.agents.find((agent) => agent.id === parent.id)).not.toHaveProperty("nestingDepth");
    expect(snapshot.agents.find((agent) => agent.id === child.id)).toMatchObject({
      parentId: parent.id,
      nestingDepth: 1,
    });
    expect(snapshot.agents.find((agent) => agent.id === grandchild.id)).toMatchObject({
      parentId: child.id,
      nestingDepth: 2,
      runId: "launch-run",
      phaseId: "investigate",
      logFile: "/tmp/agent-grandchild/events.jsonl",
    });
  });

  it("bounds historical one-shot agents to the newest creation window", () => {
    const records = Array.from({ length: 300 }, (_, index) => ({
      ...record(`agent-${index}`),
      status: (index === 299 ? "running" : "completed") as "running" | "completed",
      startedAt: index,
      updatedAt: 300 - index,
    }));

    const snapshot = createDashboardSnapshot(fakeState([], records), []);
    expect(snapshot.agents).toHaveLength(240);
    expect(snapshot.agents[0]?.id).toBe("agent-60");
    expect(snapshot.agents.at(-1)?.id).toBe("agent-299");
  });

  it("keeps an active local agent when newer remote records fill the UI bound", () => {
    const local = {
      ...record("local-active"),
      startedAt: 1,
      updatedAt: 2,
      status: "running" as const,
    };
    const remote: FabricParticipantInfo[] = Array.from({ length: 240 }, (_, index) => ({
      format: 1,
      id: `remote-${index}`,
      kind: "agent",
      rootId: "session:test",
      ownerHostId: "session:peer",
      ownerIdentityId: "session:peer",
      parentId: "session:peer",
      name: `remote-${index}`,
      status: "running",
      runner: "pi",
      transport: "process",
      capabilities: ["steer", "followUp", "stop"],
      startedAt: 1_000 + index,
      updatedAt: 2_000 + index,
      controlProtocol: "v1",
      local: false,
      stale: false,
    }));

    const snapshot = createDashboardSnapshot(fakeState([], [local], [], [], remote), []);

    expect(snapshot.agents).toHaveLength(240);
    expect(snapshot.agents.some((agent) => agent.id === local.id)).toBe(true);
    expect(snapshot.agents.filter((agent) => agent.local === false)).toHaveLength(239);
  });

  it("excludes agents owned by another session's lineage", () => {
    const local = {
      ...record("local-agent"),
      startedAt: 1,
      updatedAt: 2,
      status: "running" as const,
    };
    const foreign: FabricParticipantInfo[] = Array.from({ length: 3 }, (_, index) => ({
      format: 1,
      id: `foreign-${index}`,
      kind: "agent",
      rootId: "session:other",
      ownerHostId: "session:other",
      ownerIdentityId: "session:other",
      parentId: "session:other",
      name: `foreign-${index}`,
      status: "running",
      runner: "pi",
      transport: "process",
      capabilities: ["steer", "followUp", "stop"],
      startedAt: 1_000 + index,
      updatedAt: 2_000 + index,
      controlProtocol: "v1",
      local: false,
      stale: false,
    }));

    const snapshot = createDashboardSnapshot(fakeState([], [local], [], [], foreign), []);

    expect(snapshot.agents.map((agent) => agent.id)).toEqual([local.id]);
  });

  it("does not overlay private local actor state when another host owns it", () => {
    const actor = {
      id: "actor:shared",
      name: "shared reviewer",
      status: "idle",
      events: [],
      topics: [],
      delivery: "mailbox",
      responseMode: "text",
      triggerTurn: false,
      coalesce: true,
      queued: 0,
      messages: 0,
      createdAt: 100,
      updatedAt: 200,
    };
    const participant: FabricParticipantInfo = {
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
      capabilities: ["steer", "followUp", "stop", "fabric"],
      startedAt: 100,
      updatedAt: 200,
      controlProtocol: "v1",
      local: false,
      stale: false,
    };

    const snapshot = createDashboardSnapshot(
      fakeState([], [], [actor], [], [participant]),
      [],
    );
    expect(snapshot.actors).toEqual([
      expect.objectContaining({
        id: actor.id,
        instructions: "",
        recentMessages: [],
        ownerHostId: "session:peer",
        local: false,
      }),
    ]);
    expect(snapshot.participants).toEqual([participant]);
  });

  it("prefers an active actor worker over a newer retained failure", () => {
    const failed = {
      ...record("actor-failed"),
      actorId: "actor-1",
      status: "failed" as const,
      updatedAt: 900,
    };
    const running = {
      ...record("actor-running"),
      actorId: "actor-1",
      status: "running" as const,
      updatedAt: 800,
    };
    const actor = {
      id: "actor-1",
      name: "reviewer",
      status: "running",
      events: [],
      topics: [],
      delivery: "mailbox",
      responseMode: "text",
      triggerTurn: false,
      coalesce: true,
      queued: 0,
      messages: 0,
      createdAt: 100,
      updatedAt: 900,
    };

    const snapshot = createDashboardSnapshot(fakeState([], [failed, running], [actor]), []);
    expect(snapshot.actors[0]?.worker?.id).toBe("actor-running");
  });

  it("shows provider-registered participants as agent rows", () => {
    const participant: FabricParticipantInfo = {
      format: 1,
      id: "provider:delegate:run-1",
      kind: "provider",
      provider: "delegate",
      rootId: "session:test",
      ownerHostId: "session:test",
      ownerIdentityId: "session:test",
      parentId: "session:test",
      name: "Delegated run",
      status: "running",
      transport: "host",
      capabilities: ["stop"],
      startedAt: 10,
      updatedAt: 20,
      currentTool: "build: compiling",
      controlProtocol: "v1",
      local: true,
      stale: false,
    };
    const snapshot = createDashboardSnapshot(fakeState([], [], [], [], [participant]), []);
    expect(snapshot.agents).toEqual([
      expect.objectContaining({
        id: participant.id,
        name: "Delegated run",
        status: "running",
        transport: "provider delegate",
        currentTool: "build: compiling",
        participantKind: "provider",
        capabilities: ["stop"],
      }),
    ]);
    expect(snapshot.agents[0]).not.toHaveProperty("runner");
  });
});

describe("dashboard snapshot global actors", () => {
  it("renders without templates when the global actor registry cannot be read", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-dashboard-global-"));
    try {
      const file = path.join(agentDir, "fabric", "actors", "global-actors.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{"format":1,"actors":[');
      const globalActors = new GlobalActorRegistry(agentDir, 64 * 1024);
      const state = { ...fakeState([], []), globalActors } as unknown as FabricState;

      const snapshot = createDashboardSnapshot(state, []);

      expect(snapshot.main).toMatchObject({ id: "session:test" });
      expect(snapshot.globalActors).toEqual([]);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
