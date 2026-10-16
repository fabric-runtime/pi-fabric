import { isDeepStrictEqual } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FabricActivityRun } from "../activity/types.js";
import type { FabricState } from "../fabric-state.js";
import type { MeshEvent, MeshStateEntry } from "../mesh/store.js";
import type { AgentHandleInfo, AgentRunRecord } from "../agents/types.js";
import type { GlobalActorDefinition } from "../actors/types.js";
import { safeText } from "./format.js";
import {
  activeStatuses,
  orderAgentsByCreation,
  type FabricDashboardSnapshot,
  type FabricUiAgent,
  type FabricUiStateEntry,
} from "./types.js";

const MAX_UI_AGENTS = 240;

const boundedUiAgents = (
  local: FabricUiAgent[],
  remote: FabricUiAgent[],
): FabricUiAgent[] => {
  const selected = new Map<string, FabricUiAgent>();
  for (const agent of local) {
    if (activeStatuses.has(agent.status)) selected.set(agent.id, agent);
  }
  const addNewest = (agents: FabricUiAgent[]): void => {
    for (let index = agents.length - 1; index >= 0 && selected.size < MAX_UI_AGENTS; index--) {
      const agent = agents[index];
      if (agent) selected.set(agent.id, agent);
    }
  };
  addNewest(orderAgentsByCreation(local));
  addNewest(orderAgentsByCreation(remote));
  return orderAgentsByCreation([...selected.values()]);
};

const isRunRecord = (
  value: AgentRunRecord | AgentHandleInfo,
): value is AgentRunRecord => "startedAt" in value;

const numberFrom = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const stateEntry = (entry: MeshStateEntry): FabricUiStateEntry => {
  const value =
    typeof entry.value === "object" && entry.value !== null && !Array.isArray(entry.value)
      ? (entry.value as Record<string, unknown>)
      : undefined;
  const label = safeText(
    value?.title ?? value?.label ?? value?.name ?? value?.task ?? entry.key,
  ).slice(0, 160);
  const status = safeText(value?.status ?? value?.state ?? "state").toLowerCase() || "state";
  const owner = safeText(value?.owner ?? value?.claimedBy ?? value?.claimed_by);
  const detail = safeText(
    value?.current ?? value?.activity ?? value?.description ?? value?.summary,
  );
  return {
    key: entry.key,
    label: label || entry.key,
    status,
    value: entry.value,
    version: entry.version,
    updatedAt: entry.updatedAt,
    ...(owner ? { owner } : {}),
    ...(detail ? { detail: detail.slice(0, 500) } : {}),
  };
};

/** Poll-only memoization. Event-driven refreshes and dispatch bypass this cache. */
export class FabricDashboardSnapshotCache {
  private inputs: unknown;
  private snapshot: FabricDashboardSnapshot | undefined;

  get(inputs: unknown): FabricDashboardSnapshot | undefined {
    return this.snapshot && isDeepStrictEqual(this.inputs, inputs)
      ? { ...this.snapshot, now: Date.now() } : undefined;
  }

  set(
    inputs: { runs: FabricActivityRun[] } & Record<string, unknown>,
    snapshot: FabricDashboardSnapshot,
    immutableActivity = false,
  ): void {
    // Only the controller-owned revision view guarantees deep immutability.
    // Legacy/mutable inputs must still be copied to detect in-place updates.
    const { runs, ...other } = inputs;
    this.inputs = immutableActivity
      ? { ...structuredClone(other), runs: runs.slice() }
      : structuredClone(inputs);
    this.snapshot = snapshot;
  }

  clear(): void {
    this.inputs = undefined;
    this.snapshot = undefined;
  }
}

export const createDashboardSnapshot = (
  state: FabricState,
  events: MeshEvent[],
  context?: ExtensionContext,
  activityRuns?: FabricActivityRun[],
  cache?: FabricDashboardSnapshotCache,
  immutableActivity = false,
): FabricDashboardSnapshot => {
  const runs = activityRuns ?? state.activity.runs();
  const agentRecords =
    typeof state.agents.listForUi === "function"
      ? state.agents.listForUi()
      : state.agents.list();
  // Observe externally owned domains on every poll, including remote lease
  // expiry and model/usage updates that need not emit a local manager event.
  const participants = typeof state.participantInfos === "function"
    ? state.participantInfos({ scope: "project" }) : [];
  const actorRecords = state.actors.list();
  const main = state.mainAgentInfo(context);
  const peers = typeof state.peerInfos === "function" ? state.peerInfos() : [];
  // An unreadable registry is reported at startup and by every global actor
  // action; the dashboard shows no templates rather than failing to render.
  let globalActors: GlobalActorDefinition[];
  try {
    globalActors = state.globalActors.list();
  } catch {
    globalActors = [];
  }
  const componentGraph = typeof state.componentGraph === "function"
    ? state.componentGraph() : { components: [], edges: [], cycles: [] };
  const meshEntries = state.config.mesh.enabled ? state.mesh.list("", 200) : [];
  const shells = state.shellJobs?.list().filter(job => job.spilledAt !== undefined || job.monitor) ?? [];
  const inputs = { runs, agentRecords, actorRecords, participants, main, peers, shells,
    globalActors, componentGraph, meshEntries, events, widgetDismissedAt: state.widgetDismissedAt };
  const previous = cache?.get(inputs);
  if (previous) return previous;
  const agentLinks: Array<{ runId: string; call: FabricActivityRun["calls"][number] }> = [];
  for (const run of runs) {
    for (const call of run.calls) {
      if (call.entityId) agentLinks.push({ runId: run.id, call });
    }
  }
  agentLinks.sort((left, right) => {
    const leftLaunch = left.call.ref === "agents.spawn" || left.call.ref === "agents.run";
    const rightLaunch = right.call.ref === "agents.spawn" || right.call.ref === "agents.run";
    if (leftLaunch !== rightLaunch) return leftLaunch ? -1 : 1;
    return left.call.startedAt - right.call.startedAt;
  });
  const agentFromRecord = (
    record: AgentRunRecord | AgentHandleInfo,
    nestingDepth: number,
    parentId?: string,
    parent?: FabricUiAgent,
  ): FabricUiAgent => {
    const linked = parentId
      ? undefined
      : agentLinks.find(
          ({ call }) =>
            call.entityId &&
            (record.id.startsWith(call.entityId) || call.entityId.startsWith(record.id)),
        );
    const base: FabricUiAgent = {
      id: record.id,
      name: record.name,
      status: record.status,
      runner: record.runner,
      transport: record.transport,
      cwd: record.cwd,
      ...(!isRunRecord(record) && linked ? { startedAt: linked.call.startedAt } : {}),
      ...(record.model ? { model: record.model } : {}),
      ...(record.thinking ? { thinking: record.thinking } : {}),
      ...(record.attachCommand ? { attachCommand: record.attachCommand } : {}),
      ...(isRunRecord(record) && record.logFile ? { logFile: record.logFile } : {}),
      ...(record.branch ? { branch: record.branch } : {}),
      ...(record.worktree ? { worktree: record.worktree } : {}),
      ...(record.actorId ? { actorId: record.actorId } : {}),
      ...(record.actorName ? { actorName: record.actorName } : {}),
      ...(parentId ? { parentId } : {}),
      ...(nestingDepth > 0 ? { nestingDepth } : {}),
      ...(linked ? { runId: linked.runId } : parent?.runId ? { runId: parent.runId } : {}),
      ...(linked?.call.phaseId
        ? { phaseId: linked.call.phaseId }
        : parent?.phaseId
          ? { phaseId: parent.phaseId }
          : {}),
    };
    if (!isRunRecord(record)) return base;
    return {
      ...base,
      task: record.task,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
      ...(record.currentTool ? { currentTool: record.currentTool } : {}),
      turns: record.turns,
      toolCalls: record.toolCalls,
      usage: { ...record.usage },
      ...(record.text ? { text: record.text } : {}),
      ...(record.value !== undefined ? { value: structuredClone(record.value) } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  };
  const allAgents: FabricUiAgent[] = [];
  const appendAgent = (
    record: AgentRunRecord | AgentHandleInfo,
    nestingDepth: number,
    parentId?: string,
    parent?: FabricUiAgent,
  ): void => {
    const agent = agentFromRecord(record, nestingDepth, parentId, parent);
    allAgents.push(agent);
    if (!isRunRecord(record)) return;
    for (const nested of record.nestedAgents ?? []) {
      appendAgent(nested, nestingDepth + 1, record.id, agent);
    }
  };
  for (const record of agentRecords) appendAgent(record, 0);

  const workerByActor = new Map<string, FabricUiAgent>();
  for (const agent of allAgents) {
    if (!agent.actorId) continue;
    const previous = workerByActor.get(agent.actorId);
    const active = Number(activeStatuses.has(agent.status)) -
      Number(previous !== undefined && activeStatuses.has(previous.status));
    const recency = (numberFrom(agent.updatedAt) ?? numberFrom(agent.startedAt) ?? 0) -
      (numberFrom(previous?.updatedAt) ?? numberFrom(previous?.startedAt) ?? 0);
    // Strict improvement retains the first source-order worker on exact ties,
    // matching the previous stable filter/sort selection.
    if (!previous || (active || recency) > 0) workerByActor.set(agent.actorId, agent);
  }
  const participantById = new Map(participants.map((participant) => [participant.id, participant]));
  const actors = actorRecords
    .map((actor) => {
      const participant = participantById.get(actor.id);
      const worker = workerByActor.get(actor.id);
      return {
        ...actor,
        instructions: state.actors.instructions(actor.id),
        recentMessages: state.actors.messages(actor.id, 12),
        ...(participant
          ? { ownerHostId: participant.ownerHostId, local: participant.local }
          : {}),
        ...(worker ? { worker } : {}),
      };
    });
  const localAgents = allAgents
    .filter((agent) => !agent.actorId)
    .map((agent) => {
      const participant = participantById.get(agent.id);
      return participant
        ? {
            ...agent,
            ...(agent.parentId ? {} : participant.parentId ? { parentId: participant.parentId } : {}),
            rootId: participant.rootId,
            ownerHostId: participant.ownerHostId,
            local: participant.local,
            stale: participant.stale,
            participantKind: participant.kind,
            ...(participant.residency ? { residency: participant.residency } : {}),
            capabilities: [...participant.capabilities],
          }
        : agent;
    });
  const localAgentIds = new Set(localAgents.map((agent) => agent.id));
  // This snapshot describes one session. The project-scoped directory also
  // carries agents owned by other concurrent sessions of the same project;
  // they are not this conversation's work and stay out of its agent rows.
  const remoteAgents: FabricUiAgent[] = participants
    .filter((participant) =>
      (participant.kind === "agent" || participant.kind === "provider") &&
      participant.rootId === main.id &&
      !localAgentIds.has(participant.id))
    .map((participant) => ({
      id: participant.id,
      name: participant.name,
      status: participant.status,
      ...(participant.runner ? { runner: participant.runner } : {}),
      transport: participant.provider ? `provider ${participant.provider}` : participant.transport,
      cwd: participant.cwd ?? "",
      ...(participant.model ? { model: participant.model } : {}),
      ...(participant.thinking ? { thinking: participant.thinking } : {}),
      ...(participant.currentTool ? { currentTool: participant.currentTool } : {}),
      startedAt: participant.startedAt,
      updatedAt: participant.updatedAt,
      ...(participant.finishedAt !== undefined ? { finishedAt: participant.finishedAt } : {}),
      ...(participant.turns !== undefined ? { turns: participant.turns } : {}),
      ...(participant.toolCalls !== undefined ? { toolCalls: participant.toolCalls } : {}),
      ...(participant.usage ? { usage: { ...participant.usage } } : {}),
      ...(participant.parentId ? { parentId: participant.parentId } : {}),
      rootId: participant.rootId,
      ownerHostId: participant.ownerHostId,
      local: participant.local,
      stale: participant.stale,
      participantKind: participant.kind,
      ...(participant.residency ? { residency: participant.residency } : {}),
      capabilities: [...participant.capabilities],
    }));
  const agents = [...localAgents, ...remoteAgents];
  const visibleAgents = boundedUiAgents(localAgents, remoteAgents);
  const activeRunIds = new Set(
    agents
      .filter((agent) => agent.runId && activeStatuses.has(agent.status))
      .map((agent) => agent.runId as string),
  );
  const orderedRuns = runs
    .map((run, index) => ({ run, index }))
    .sort((left, right) => {
      const leftActive = activeRunIds.has(left.run.id) ? 1 : 0;
      const rightActive = activeRunIds.has(right.run.id) ? 1 : 0;
      return rightActive - leftActive || left.index - right.index;
    })
    .map(({ run }) => run);

  const stateEntries = meshEntries
    .filter(
      (entry) =>
        !entry.key.startsWith("actors/") &&
        !entry.key.startsWith("sessions/") &&
        !entry.key.startsWith("topology/"),
    )
    .map(stateEntry)
    .sort((left, right) => {
      const leftActive = activeStatuses.has(left.status) ? 1 : 0;
      const rightActive = activeStatuses.has(right.status) ? 1 : 0;
      return rightActive - leftActive || right.updatedAt - left.updatedAt;
    })
    .slice(0, 120);

  const snapshot: FabricDashboardSnapshot = {
    now: Date.now(),
    shells,
    runs: orderedRuns,
    main,
    peers,
    participants,
    widgetDismissedAt: state.widgetDismissedAt,
    globalActors,
    agents: visibleAgents,
    componentGraph,
    actors: actors.sort((left, right) => {
      const leftActive = activeStatuses.has(left.status) ? 1 : 0;
      const rightActive = activeStatuses.has(right.status) ? 1 : 0;
      return rightActive - leftActive || right.updatedAt - left.updatedAt;
    }),
    state: stateEntries,
    events: events.map((event) => structuredClone(event)),
  };
  cache?.set(inputs, snapshot, immutableActivity);
  return snapshot;
};
