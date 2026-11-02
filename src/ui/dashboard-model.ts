import type {
  FabricActivityCall,
  FabricActivityItem,
  FabricActivityKind,
  FabricActivityPhase,
  FabricActivityRun,
} from "../activity/types.js";
import { isRoutineInternalCall } from "../core/call-presentation.js";
import type { GlobalActorDefinition } from "../actors/types.js";
import type { FabricComponentInfo } from "../components/types.js";
import type {
  FabricDashboardSnapshot,
  FabricUiActor,
  FabricUiAgent,
  FabricUiMain,
  FabricUiPeer,
  FabricUiStateEntry,
} from "./types.js";
import { isActiveStatus, orderAgentsByCreation } from "./types.js";
import {
  buildProjectMeshTopology,
  type FabricProjectMeshModel,
  type FabricProjectMeshParticipant,
  type FabricProjectMeshRoute,
  type FabricProjectMeshTopic,
} from "./topology.js";

export type Entity =
  | { id: string; kind: "main"; label: string; status: string; value: FabricUiMain }
  | { id: string; kind: "peer"; label: string; status: string; value: FabricUiPeer }
  | { id: string; kind: "agent"; label: string; status: string; value: FabricUiAgent }
  | { id: string; kind: "actor"; label: string; status: string; value: FabricUiActor }
  | {
      id: string;
      kind: "globalActor";
      label: string;
      status: string;
      value: GlobalActorDefinition;
    }
  | { id: string; kind: "call"; label: string; status: string; value: FabricActivityCall }
  | { id: string; kind: "item"; label: string; status: string; value: FabricActivityItem }
  | { id: string; kind: "state"; label: string; status: string; value: FabricUiStateEntry }
  | { id: string; kind: "component"; label: string; status: string; value: FabricComponentInfo }
  | {
      id: string;
      kind: "meshParticipant";
      label: string;
      status: string;
      value: FabricProjectMeshParticipant;
    }
  | {
      id: string;
      kind: "meshTopic";
      label: string;
      status: string;
      value: FabricProjectMeshTopic;
    }
  | {
      id: string;
      kind: "meshRoute";
      label: string;
      status: string;
      value: FabricProjectMeshRoute;
    };

type PanelKind = "phase" | "unphased" | "session";

export interface PhasePanel {
  id: string;
  name: string;
  status: string;
  completed: number;
  total: number;
  phase?: FabricActivityPhase;
  kind: PanelKind;
  agents?: number;
  tokens?: number;
  elapsedMs?: number;
}

export type Pane = "phases" | "entities";
export type OverviewView = "activity" | "topology";

type EntityGroupKind =
  | FabricActivityKind
  | "globalActor"
  | "peer"
  | "state"
  | "component"
  | "meshParticipant"
  | "meshTopic"
  | "meshRoute";

export interface EntityGroup {
  kind: EntityGroupKind;
  label: string;
  entries: Array<{ entity: Entity; index: number }>;
}

const entityGroupOrder: readonly EntityGroupKind[] = [
  "agent",
  "peer",
  "actor",
  "globalActor",
  "tool",
  "extension",
  "mcp",
  "mesh",
  "task",
  "custom",
  "state",
  "component",
  "meshParticipant",
  "meshTopic",
  "meshRoute",
];

const entityGroupLabels: Record<EntityGroupKind, string> = {
  agent: "Agents",
  peer: "Peers",
  actor: "Actors",
  globalActor: "Global templates",
  tool: "Tools",
  extension: "Extensions",
  mcp: "MCP",
  mesh: "Mesh",
  task: "Tasks",
  custom: "Custom items",
  state: "Shared state",
  component: "Components",
  meshParticipant: "Project participants",
  meshTopic: "Topics",
  meshRoute: "Recent routes",
};

const entityGroupKind = (entity: Entity): EntityGroupKind => {
  if (entity.kind === "main" || entity.kind === "agent") return "agent";
  if (entity.kind === "peer") return "peer";
  if (entity.kind === "actor") return "actor";
  if (entity.kind === "globalActor") return "globalActor";
  if (entity.kind === "state") return "state";
  if (entity.kind === "component") return "component";
  if (entity.kind === "meshParticipant") return "meshParticipant";
  if (entity.kind === "meshTopic") return "meshTopic";
  if (entity.kind === "meshRoute") return "meshRoute";
  if (entity.kind === "call") return entity.value.entityKind ?? entity.value.kind;
  return entity.value.kind;
};

const entityGroupRanks = new Map(
  entityGroupOrder.map((kind, index) => [kind, index] as const),
);

const orderEntitiesByGroup = (entities: Entity[]): Entity[] =>
  entities
    .map((entity, index) => ({ entity, index }))
    .sort(
      (left, right) =>
        (entityGroupRanks.get(entityGroupKind(left.entity)) ?? Number.MAX_SAFE_INTEGER) -
          (entityGroupRanks.get(entityGroupKind(right.entity)) ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index,
    )
    .map(({ entity }) => entity);

export const groupEntities = (entities: Entity[]): EntityGroup[] => {
  const indexed = entities.map((entity, index) => ({ entity, index }));
  return entityGroupOrder.flatMap((kind) => {
    const entries = indexed.filter(({ entity }) => entityGroupKind(entity) === kind);
    return entries.length > 0 ? [{ kind, label: entityGroupLabels[kind], entries }] : [];
  });
};

export type StatusFilter = "all" | "active" | "completed" | "failed";

export const filters: StatusFilter[] = ["all", "active", "completed", "failed"];

const linkedEntityId = (entityId: string | undefined, id: string): boolean =>
  Boolean(entityId && (id.startsWith(entityId) || entityId.startsWith(id)));

const linkedAgent = (call: FabricActivityCall, agent: FabricUiAgent): boolean =>
  linkedEntityId(call.entityId, agent.id);

const agentLaunchRefs = new Set(["agents.run", "agents.spawn"]);

const mainEntity = (snapshot: FabricDashboardSnapshot): Entity => ({
  id: `main:${snapshot.main.id}`,
  kind: "main",
  label: "Main",
  status: snapshot.main.status,
  value: snapshot.main,
});

const UNPHASED_PANEL_ID = "__fabric_unphased";
const SESSION_PANEL_ID = "__fabric_session";

const callsForPanel = (
  run: FabricActivityRun | undefined,
  panel: PhasePanel,
): FabricActivityCall[] => {
  if (!run || panel.kind === "session") return [];
  return run.calls.filter((call) =>
    !isRoutineInternalCall(call) && (panel.kind === "unphased" ? !call.phaseId : call.phaseId === panel.id),
  );
};

const itemsForPanel = (
  run: FabricActivityRun | undefined,
  panel: PhasePanel,
): FabricActivityItem[] => {
  if (!run || panel.kind === "session") return [];
  return run.items.filter((item) =>
    panel.kind === "unphased" ? !item.phaseId : item.phaseId === panel.id,
  );
};

const entitiesFor = (
  snapshot: FabricDashboardSnapshot,
  run: FabricActivityRun | undefined,
  panel: PhasePanel | undefined,
): Entity[] => {
  if (!panel || panel.kind === "session") {
    const unlinkedAgents: Entity[] = orderAgentsByCreation(snapshot.agents)
      .filter((agent) => agent.runId !== run?.id && isActiveStatus(agent.status))
      .map((agent) => ({
        id: `agent:${agent.id}`,
        kind: "agent",
        label: agent.name,
        status: agent.status,
        value: agent,
      }));
    const peers: Entity[] = snapshot.peers.map((peer) => ({
      id: `peer:${peer.id}`,
      kind: "peer",
      label: peer.name,
      status: peer.status,
      value: peer,
    }));
    const actors: Entity[] = snapshot.actors.map((actor) => ({
      id: `actor:${actor.id}`,
      kind: "actor",
      label: actor.name,
      status: actor.lastError ? "failed" : actor.status,
      value: actor,
    }));
    const globalActors: Entity[] = snapshot.globalActors.map((definition) => ({
      id: `globalActor:${definition.id}`,
      kind: "globalActor",
      label: definition.name,
      status: "global",
      value: definition,
    }));
    const components: Entity[] = snapshot.componentGraph.components.map((component) => ({
      id: `component:${component.id}`,
      kind: "component",
      label: component.id,
      status: component.state,
      value: component,
    }));
    const state: Entity[] = snapshot.state.map((entry) => ({
      id: `state:${entry.key}`,
      kind: "state",
      label: entry.label,
      status: entry.status,
      value: entry,
    }));
    return orderEntitiesByGroup([
      mainEntity(snapshot),
      ...unlinkedAgents,
      ...peers,
      ...actors,
      ...globalActors,
      ...components,
      ...state,
    ]);
  }

  const calls = callsForPanel(run, panel);
  const panelAgents = orderAgentsByCreation(snapshot.agents).filter((agent) => {
    const ownedByPanel =
      agent.runId === run?.id &&
      (panel.kind === "unphased" ? !agent.phaseId : agent.phaseId === panel.id);
    return ownedByPanel || (!agent.runId && calls.some((call) => linkedAgent(call, agent)));
  });
  const linkedAgents: Entity[] = panelAgents.map((agent) => ({
    id: `agent:${agent.id}`,
    kind: "agent",
    label: agent.name,
    status: agent.status,
    value: agent,
  }));
  const visibleCalls: Entity[] = calls
    .filter((call) => {
      const representedAgentLaunch =
        call.kind === "agent" &&
        agentLaunchRefs.has(call.ref) &&
        panelAgents.some((agent) => linkedAgent(call, agent));
      const representedActorCreation =
        call.kind === "actor" &&
        call.ref === "agents.create" &&
        snapshot.actors.some((actor) => linkedEntityId(call.entityId, actor.id));
      return !representedAgentLaunch && !representedActorCreation;
    })
    .map((call) => ({
      id: `call:${call.id}`,
      kind: "call",
      label: call.label,
      status: call.status,
      value: call,
    }));
  const items: Entity[] = itemsForPanel(run, panel).map((item) => ({
    id: `item:${item.id}`,
    kind: "item",
    label: item.label,
    status: item.status,
    value: item,
  }));
  return orderEntitiesByGroup([
    mainEntity(snapshot),
    ...linkedAgents,
    ...visibleCalls,
    ...items,
  ]);
};

const projectMeshEntitiesFor = (
  snapshot: FabricDashboardSnapshot,
  topology?: FabricProjectMeshModel,
): Entity[] => {
  const model = topology ?? buildProjectMeshTopology({
    main: snapshot.main,
    actors: snapshot.actors,
    agents: snapshot.agents,
    state: snapshot.state,
    events: snapshot.events,
    ...(snapshot.participants ? { participants: snapshot.participants } : {}),
    now: snapshot.now,
  });
  const entities = model.rows.flatMap((row): Entity[] => {
    if (row.kind === "meshRoot") return [mainEntity(snapshot)];
    if (row.kind === "meshActor") {
      return [{
        id: row.entityId,
        kind: "actor",
        label: row.actor.name,
        status: row.actor.lastError ? "failed" : row.actor.status,
        value: row.actor,
      }];
    }
    if (row.kind === "meshAgent") {
      if (row.participant.agent) {
        return [{
          id: row.entityId,
          kind: "agent",
          label: row.participant.agent.name,
          status: row.participant.agent.status,
          value: row.participant.agent,
        }];
      }
      return [{
        id: row.entityId,
        kind: "meshParticipant",
        label: row.participant.name,
        status: row.participant.status,
        value: row.participant,
      }];
    }
    if (row.kind === "meshTopic") {
      return [{
        id: row.entityId,
        kind: "meshTopic",
        label: row.topic.name,
        status: row.topic.status,
        value: row.topic,
      }];
    }
    if (row.kind === "meshState") {
      return [{
        id: row.entityId,
        kind: "state",
        label: row.state.label,
        status: row.state.status,
        value: row.state,
      }];
    }
    if (row.kind === "meshRoute") {
      return [{
        id: row.entityId,
        kind: "meshRoute",
        label: `${row.route.fromName} → ${row.route.targetName}`,
        status: row.route.status,
        value: row.route,
      }];
    }
    return [];
  });
  return [
    ...entities,
    ...snapshot.componentGraph.components.map((component): Entity => ({
      id: `component:${component.id}`,
      kind: "component",
      label: component.id,
      status: component.state,
      value: component,
    })),
  ];
};

const unifiedTopologyEntitiesFor = (
  snapshot: FabricDashboardSnapshot,
  run: FabricActivityRun | undefined,
  topology?: FabricProjectMeshModel,
): Entity[] => {
  const orderedAgents = orderAgentsByCreation(snapshot.agents).sort(
    (left, right) =>
      Number(right.runId === run?.id) - Number(left.runId === run?.id) ||
      Number(isActiveStatus(right.status)) - Number(isActiveStatus(left.status)),
  );
  const canonical: Entity[] = [
    mainEntity(snapshot),
    ...orderedAgents.map((agent): Entity => ({
      id: `agent:${agent.id}`,
      kind: "agent",
      label: agent.name,
      status: agent.status,
      value: agent,
    })),
    ...snapshot.actors.map((actor): Entity => ({
      id: `actor:${actor.id}`,
      kind: "actor",
      label: actor.name,
      status: actor.lastError ? "failed" : actor.status,
      value: actor,
    })),
    ...snapshot.peers.map((peer): Entity => ({
      id: `peer:${peer.id}`,
      kind: "peer",
      label: peer.name,
      status: peer.status,
      value: peer,
    })),
  ];
  const seen = new Set(canonical.map((entity) => entity.id));
  const seenParticipantIds = new Set([
    snapshot.main.id,
    ...snapshot.agents.map((agent) => agent.id),
    ...snapshot.actors.map((actor) => actor.id),
    ...snapshot.peers.map((peer) => peer.id),
  ]);
  for (const entity of projectMeshEntitiesFor(snapshot, topology)) {
    if (seen.has(entity.id)) continue;
    if (entity.kind === "meshParticipant" && seenParticipantIds.has(entity.value.id)) continue;
    seen.add(entity.id);
    canonical.push(entity);
  }
  return canonical;
};

export const entitiesForOverview = (
  snapshot: FabricDashboardSnapshot,
  run: FabricActivityRun | undefined,
  panel: PhasePanel | undefined,
  view: OverviewView,
  projectMesh?: FabricProjectMeshModel,
): Entity[] => {
  if (view === "topology") return unifiedTopologyEntitiesFor(snapshot, run, projectMesh);
  return entitiesFor(snapshot, run, panel);
};
const panelStatus = (entities: Entity[], fallback: string): string => {
  if (entities.some((entity) => ["failed", "timed_out", "error"].includes(entity.status))) {
    return "failed";
  }
  if (entities.some((entity) => entity.status === "blocked")) return "blocked";
  if (entities.some((entity) => isActiveStatus(entity.status))) return "running";
  if (
    entities.length > 0 &&
    entities.every((entity) =>
      ["completed", "done", "stopped", "cancelled", "global", "idle", "state"].includes(
        entity.status,
      ),
    )
  ) {
    return "completed";
  }
  return fallback;
};

const withPanelProgress = (
  snapshot: FabricDashboardSnapshot,
  run: FabricActivityRun | undefined,
  panel: PhasePanel,
  projectedEntities?: Entity[],
): PhasePanel => {
  const entities = projectedEntities ?? entitiesFor(snapshot, run, panel);
  const progressEntities =
    panel.kind === "session" ? entities : entities.filter((entity) => entity.kind !== "main");
  const status =
    panel.kind === "session"
      ? progressEntities.some((entity) =>
          ["failed", "timed_out", "error"].includes(entity.status),
        )
        ? "failed"
        : progressEntities.some((entity) => isActiveStatus(entity.status))
          ? "running"
          : "idle"
      : panelStatus(progressEntities, panel.status);
  const agents = progressEntities.filter((entity) => entity.kind === "agent");
  const tokens = agents.reduce(
    (sum, entity) =>
      sum +
      (entity.kind === "agent" && entity.value.usage
        ? entity.value.usage.input + entity.value.usage.output
        : 0),
    0,
  );
  const starts = progressEntities
    .flatMap((entity) => {
      if (entity.kind === "agent" || entity.kind === "call") return [entity.value.startedAt ?? 0];
      if (entity.kind === "item") return [entity.value.createdAt];
      return [];
    })
    .filter((value) => value > 0);
  const startedAt = starts.length > 0 ? Math.min(...starts) : undefined;
  const hasActive = progressEntities.some((entity) => isActiveStatus(entity.status));
  const finishes = progressEntities
    .flatMap((entity) => {
      if (entity.kind === "agent" || entity.kind === "call") return [entity.value.finishedAt ?? 0];
      if (entity.kind === "item") return [entity.value.finishedAt ?? 0];
      return [];
    })
    .filter((value) => value > 0);
  const finishedAt = hasActive
    ? snapshot.now
    : finishes.length > 0
      ? Math.max(...finishes)
      : undefined;
  return {
    ...panel,
    status,
    completed: progressEntities.filter(
      (entity) => entity.status === "completed" || entity.status === "done",
    ).length,
    total: Math.max(panel.total, progressEntities.length),
    ...(agents.length > 0 ? { agents: agents.length } : {}),
    ...(tokens > 0 ? { tokens } : {}),
    ...(startedAt && finishedAt ? { elapsedMs: Math.max(0, finishedAt - startedAt) } : {}),
  };
};

const activityEntitiesByPanel = (
  snapshot: FabricDashboardSnapshot,
  run: FabricActivityRun,
): Map<string, Entity[]> => {
  const calls = new Map<string, FabricActivityCall[]>();
  const items = new Map<string, FabricActivityItem[]>();
  const agents = new Map<string, Map<string, FabricUiAgent>>();
  const keyFor = (phaseId: string | undefined): string => phaseId ?? UNPHASED_PANEL_ID;
  for (const call of run.calls) {
    if (isRoutineInternalCall(call)) continue;
    const key = keyFor(call.phaseId);
    const bucket = calls.get(key) ?? [];
    bucket.push(call);
    calls.set(key, bucket);
  }
  for (const item of run.items) {
    const key = keyFor(item.phaseId);
    const bucket = items.get(key) ?? [];
    bucket.push(item);
    items.set(key, bucket);
  }
  const detachedAgents: FabricUiAgent[] = [];
  for (const agent of snapshot.agents) {
    if (agent.runId === run.id) {
      const key = keyFor(agent.phaseId);
      const bucket = agents.get(key) ?? new Map<string, FabricUiAgent>();
      bucket.set(agent.id, agent);
      agents.set(key, bucket);
    } else if (!agent.runId) {
      detachedAgents.push(agent);
    }
  }
  if (detachedAgents.length > 0) {
    for (const [key, panelCalls] of calls) {
      for (const call of panelCalls) {
        for (const agent of detachedAgents) {
          if (!linkedAgent(call, agent)) continue;
          const bucket = agents.get(key) ?? new Map<string, FabricUiAgent>();
          bucket.set(agent.id, agent);
          agents.set(key, bucket);
        }
      }
    }
  }
  const keys = new Set<string>([
    UNPHASED_PANEL_ID,
    ...run.phases.map((phase) => phase.id),
  ]);
  const projected = new Map<string, Entity[]>();
  for (const key of keys) {
    const panelAgents = [...(agents.get(key)?.values() ?? [])];
    const agentEntities: Entity[] = panelAgents.map((agent) => ({
      id: `agent:${agent.id}`,
      kind: "agent",
      label: agent.name,
      status: agent.status,
      value: agent,
    }));
    const callEntities: Entity[] = (calls.get(key) ?? [])
      .filter((call) => {
        const representedAgentLaunch =
          call.kind === "agent" &&
          agentLaunchRefs.has(call.ref) &&
          panelAgents.some((agent) => linkedAgent(call, agent));
        const representedActorCreation =
          call.kind === "actor" &&
          call.ref === "agents.create" &&
          snapshot.actors.some((actor) => linkedEntityId(call.entityId, actor.id));
        return !representedAgentLaunch && !representedActorCreation;
      })
      .map((call) => ({
        id: `call:${call.id}`,
        kind: "call" as const,
        label: call.label,
        status: call.status,
        value: call,
      }));
    const itemEntities: Entity[] = (items.get(key) ?? []).map((item) => ({
      id: `item:${item.id}`,
      kind: "item",
      label: item.label,
      status: item.status,
      value: item,
    }));
    projected.set(key, [...agentEntities, ...callEntities, ...itemEntities]);
  }
  return projected;
};

export const phasePanels = (
  snapshot: FabricDashboardSnapshot,
  run: FabricActivityRun | undefined,
): PhasePanel[] => {
  const panels: PhasePanel[] = [];
  const activityEntities = run
    ? activityEntitiesByPanel(snapshot, run)
    : new Map<string, Entity[]>();

  if (run) {
    const runActivity: PhasePanel = {
      id: UNPHASED_PANEL_ID,
      name: "Run activity",
      status: run.status,
      completed: 0,
      total: 0,
      kind: "unphased",
    };
    if ((activityEntities.get(UNPHASED_PANEL_ID)?.length ?? 0) > 0) panels.push(runActivity);
  }

  panels.push(
    ...(run?.phases.map((phase) => ({
      id: phase.id,
      name: phase.name,
      status: phase.status,
      completed: 0,
      total: phase.total ?? 0,
      phase,
      kind: "phase" as const,
    })) ?? []),
  );

  const session: PhasePanel = {
    id: SESSION_PANEL_ID,
    name: "Project participants & shared state",
    status: "idle",
    completed: 0,
    total: 0,
    kind: "session",
  };
  const sessionEntities = entitiesFor(snapshot, run, session);
  if (sessionEntities.length > 0 || panels.length === 0) panels.push(session);

  return panels.map((panel) =>
    withPanelProgress(
      snapshot,
      run,
      panel,
      panel.kind === "session" ? sessionEntities : activityEntities.get(panel.id) ?? [],
    ),
  );
};

export const matchesFilter = (status: string, filter: StatusFilter): boolean => {
  if (filter === "all") return true;
  if (filter === "active") return isActiveStatus(status);
  if (filter === "completed") return status === "completed" || status === "done";
  return status === "failed" || status === "timed_out" || status === "blocked" || status === "error";
};

export const tokensFor = (
  snapshot: FabricDashboardSnapshot,
  run: FabricActivityRun | undefined,
): number =>
  snapshot.agents
    .filter((agent) => !run || agent.runId === run.id)
    .reduce(
      (sum, agent) => sum + (agent.usage ? agent.usage.input + agent.usage.output : 0),
      0,
    );
