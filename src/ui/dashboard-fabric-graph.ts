import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { truncateStyledText as truncateToWidth } from "./truncate.js";
import type { FabricActivityRun } from "../activity/types.js";
import type { Entity, StatusFilter } from "./dashboard-model.js";
import { colorStatus, entityTail, statusGlyph } from "./dashboard-presentation.js";
import { padToWidth, safeText } from "./format.js";
import type { FabricProjectMeshModel, FabricProjectMeshRoute } from "./topology.js";
import type { FabricDashboardSnapshot } from "./types.js";
import { isActiveStatus } from "./types.js";
import { loadStateFilePreview, renderStateFilePreview } from "./state-file-preview.js";

export interface FabricGraphPoint {
  x: number;
  y: number;
}

type GraphNodeKind =
  | "main"
  | "peer"
  | "agent"
  | "actor"
  | "participant"
  | "component"
  | "group"
  | "topic"
  | "state"
  | "route";

interface GraphNode {
  id: string;
  label: string;
  status: string;
  kind: GraphNodeKind;
  parentId?: string;
  activityAt?: number;
  startedAt?: number;
  queued?: number;
  stale?: boolean;
  order?: number;
  x: number;
  y: number;
}

interface GraphEdge {
  from: string;
  to: string;
  kind: "structure" | "route" | "subscription";
  route?: FabricProjectMeshRoute;
}

interface FabricGraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  positions: Map<string, FabricGraphPoint>;
}

interface Cell {
  char: string;
  style: "plain" | "edge" | "dim" | "muted" | "accent" | "success" | "warning" | "error";
}

export interface FabricGraphAnimation {
  now: number;
  reducedMotion: boolean;
  showHistory: boolean;
  replayRouteId?: string;
  replayLabel?: string;
}

const kindRank: Record<GraphNodeKind, number> = {
  agent: 0,
  actor: 1,
  participant: 2,
  component: 3,
  peer: 4,
  group: 5,
  topic: 6,
  state: 7,
  route: 8,
  main: 9,
};

const activeRank = (status: string): number =>
  isActiveStatus(status) && status !== "blocked" ? 0 : status === "blocked" ? 1 : 2;

const nodeKind = (entity: Entity): GraphNodeKind => {
  if (entity.kind === "component") return "component";
  if (entity.kind === "meshParticipant") return "participant";
  if (entity.kind === "meshTopic") return "topic";
  if (entity.kind === "meshRoute") return "route";
  if (entity.kind === "globalActor" || entity.kind === "call" || entity.kind === "item") {
    return "state";
  }
  return entity.kind;
};

const rawIdentity = (entity: Entity): Array<string | undefined> => {
  if (entity.kind === "main" || entity.kind === "peer" || entity.kind === "agent" || entity.kind === "actor") {
    return [entity.value.id, entity.value.name];
  }
  if (entity.kind === "meshParticipant") {
    return [entity.value.id, entity.value.name, entity.value.participant?.sessionId];
  }
  if (entity.kind === "meshTopic") return [entity.value.id, entity.value.name];
  if (entity.kind === "state") return [entity.value.key, entity.value.label];
  if (entity.kind === "meshRoute") return [entity.value.id];
  if (entity.kind === "component") {
    return [entity.value.id, entity.id];
  }
  return [entity.id, entity.label];
};

const graphLabel = (value: string, maxWidth: number): string => {
  let output = "";
  let width = 0;
  for (const char of value) {
    const charWidth = visibleWidth(char);
    if (width + charWidth > maxWidth) {
      while (width + 1 > maxWidth && output.length > 0) {
        const parts = [...output];
        const removed = parts.pop();
        output = parts.join("");
        width -= removed ? visibleWidth(removed) : 0;
      }
      return output + "…";
    }
    output += char;
    width += charWidth;
  }
  return output;
};

const graphGlyph = (node: GraphNode, animation: FabricGraphAnimation): string => {
  if (node.stale) return animation.reducedMotion ? "·" : ["▧", "▫", "·", " "][Math.floor(animation.now / 240) % 4]!;
  const frame = Math.floor(animation.now / 160);
  const active = isActiveStatus(node.status);
  if (node.kind === "main") return active && !animation.reducedMotion ? ["◇", "◈", "◆", "◈"][frame % 4]! : "◆";
  if (node.kind === "actor") {
    if ((node.queued ?? 0) > 0 && !animation.reducedMotion) return ["◇", "◈", "◆", "◈"][frame % 4]!;
    return "◇";
  }
  if (node.kind === "peer") return "◈";
  if (node.kind === "group") return "▱";
  if (node.kind === "topic") {
    const hot = node.activityAt !== undefined && animation.now - node.activityAt <= 10_000;
    return hot && !animation.reducedMotion ? ["◎", "◉", "⦿", "◉"][frame % 4]! : "◎";
  }
  if (node.kind === "state") {
    if (/certified|committed|complete/.test(node.status) && !animation.reducedMotion) {
      return ["◫", "▣", "✦", "▣"][Math.floor(animation.now / 280) % 4]!;
    }
    return "◫";
  }
  if (node.kind === "participant") return "▧";
  if (node.kind === "component") return "⬡";
  if (node.kind === "agent" && !animation.reducedMotion) {
    const spawnAge = node.startedAt === undefined ? Number.POSITIVE_INFINITY : animation.now - node.startedAt;
    if (spawnAge >= 0 && spawnAge <= 1_600) {
      return ["·", "▪", "▫", "▣", "■"][Math.min(4, Math.floor(spawnAge / 320))]!;
    }
    if (active) return ["■", "▣", "▪", "▣"][frame % 4]!;
  }
  return "■";
};

const PARTICIPANTS_GROUP_ID = "group:participants";
const MESH_GROUP_ID = "group:mesh";
const TOPICS_GROUP_ID = "group:mesh:topics";
const STATE_GROUP_ID = "group:mesh:state";
const COMPONENTS_GROUP_ID = "group:components";

export interface FabricTopologyGroupSegment {
  id: string;
  label: string;
}

export const topologyParticipantGroup = (
  kind: "root" | "peer" | "agent" | "actor",
): FabricTopologyGroupSegment & { order: number } => {
  if (kind === "actor") return { id: "actors", label: "Actors", order: 2 };
  if (kind === "agent") return { id: "agents", label: "Agents", order: 1 };
  return { id: "sessions", label: "Sessions", order: 0 };
};

const titleSegment = (value: string): string =>
  value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);

const namespaceParts = (value: string): string[] =>
  value.split(/[.:/]+/).map((part) => part.trim()).filter(Boolean);

export const topologyTopicGroupPath = (name: string): FabricTopologyGroupSegment[] => {
  const parts = namespaceParts(name);
  if (parts[0] === "fabric") {
    return [
      { id: "fabric", label: "Fabric" },
      ...(parts.length > 2 && parts[1]
        ? [{ id: `fabric:${parts[1]}`, label: titleSegment(parts[1]) }]
        : []),
    ];
  }
  return [
    { id: "project", label: "Project topics" },
    ...(parts.length > 1 && parts[0]
      ? [{ id: `project:${parts[0]}`, label: parts[0] }]
      : []),
  ];
};

export const topologyStateGroupPath = (key: string): FabricTopologyGroupSegment[] => {
  const parts = key.split("/").map((part) => part.trim()).filter(Boolean);
  if (parts[0] === "state") {
    const path: FabricTopologyGroupSegment[] = [{ id: "world", label: "World state" }];
    if (parts[1] === "complexity") {
      let prefix = "world:complexity";
      path.push({ id: prefix, label: "Complexity" });
      for (const directory of parts.slice(2, -1)) {
        prefix += `:${directory}`;
        path.push({ id: prefix, label: directory });
      }
    } else {
      let prefix = "world";
      for (const directory of parts.slice(1, -1)) {
        prefix += `:${directory}`;
        path.push({ id: prefix, label: titleSegment(directory) });
      }
    }
    return path;
  }
  if (parts[0] === "schema") {
    const path: FabricTopologyGroupSegment[] = [{ id: "schema", label: "Schema" }];
    const family = parts[1];
    if (family === "hypothesis") path.push({ id: "schema:hypotheses", label: "Hypotheses" });
    else if (family === "certificate") path.push({ id: "schema:certificates", label: "Certificates" });
    else {
      let prefix = "schema";
      for (const directory of parts.slice(1, -1)) {
        prefix += `:${directory}`;
        path.push({ id: prefix, label: titleSegment(directory) });
      }
    }
    return path;
  }
  const path: FabricTopologyGroupSegment[] = [{ id: "project", label: "Project state" }];
  let prefix = "project";
  for (const directory of parts.slice(0, -1)) {
    prefix += `:${directory}`;
    path.push({ id: prefix, label: directory });
  }
  return path;
};

const parentReference = (entity: Entity): string | undefined => {
  if (entity.kind === "agent") return entity.value.parentId ?? entity.value.actorId;
  if (entity.kind === "meshParticipant") return entity.value.participant?.parentId;
  if (entity.kind === "meshRoute") return entity.value.fromId;
  return undefined;
};

const buildLayout = (
  snapshot: FabricDashboardSnapshot,
  entities: Entity[],
  selectedRun: FabricActivityRun | undefined,
  mesh: FabricProjectMeshModel,
): FabricGraphLayout => {
  const aliases = new Map<string, string>();
  const entityById = new Map(entities.map((entity) => [entity.id, entity] as const));
  for (const entity of entities) {
    for (const identity of rawIdentity(entity)) {
      if (identity) aliases.set(identity, entity.id);
    }
  }
  const mainId = entities.find((entity) => entity.kind === "main")?.id ?? `main:${snapshot.main.id}`;
  aliases.set(snapshot.main.id, mainId);
  aliases.set(snapshot.main.name, mainId);
  aliases.set("main", mainId);

  const groups = new Map<string, GraphNode>();
  const ensureGroup = (
    id: string,
    label: string,
    parentId: string,
    order: number,
  ): string => {
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        label,
        status: "idle",
        kind: "group",
        parentId,
        order,
        x: 0,
        y: 0,
      });
    }
    return id;
  };
  const ensurePath = (
    rootId: string,
    path: FabricTopologyGroupSegment[],
  ): string => {
    let parentId = rootId;
    for (let index = 0; index < path.length; index++) {
      const segment = path[index]!;
      const id = `${rootId}:${segment.id}`;
      parentId = ensureGroup(id, segment.label, parentId, index);
    }
    return parentId;
  };
  const participantCategory = (entity: Entity): FabricTopologyGroupSegment & { order: number } => {
    if (entity.kind === "actor") return topologyParticipantGroup("actor");
    if (entity.kind === "agent") return topologyParticipantGroup("agent");
    if (entity.kind === "peer") return topologyParticipantGroup("peer");
    const kind = entity.kind === "meshParticipant" ? entity.value.participant?.kind ?? "root" : "root";
    return topologyParticipantGroup(kind === "provider" ? "agent" : kind);
  };
  const nodes: GraphNode[] = entities
    .filter((entity) => entity.kind !== "meshRoute")
    .map((entity) => {
      const parentRef = parentReference(entity);
      const explicitParentId = parentRef ? aliases.get(parentRef) : undefined;
      let parentId = explicitParentId;
      if (entity.kind !== "main") {
        if (entity.kind === "component") {
          parentId = ensureGroup(COMPONENTS_GROUP_ID, "Components", mainId, 2);
        } else if (
          ["agent", "actor", "peer", "meshParticipant"].includes(entity.kind) &&
          (!parentId || parentId === mainId)
        ) {
          ensureGroup(PARTICIPANTS_GROUP_ID, "Participants", mainId, 0);
          const category = participantCategory(entity);
          parentId = ensureGroup(
            `${PARTICIPANTS_GROUP_ID}:${category.id}`,
            category.label,
            PARTICIPANTS_GROUP_ID,
            category.order,
          );
        } else if (entity.kind === "meshTopic") {
          ensureGroup(MESH_GROUP_ID, "Mesh", mainId, 1);
          ensureGroup(TOPICS_GROUP_ID, "Topics", MESH_GROUP_ID, 0);
          parentId = ensurePath(TOPICS_GROUP_ID, topologyTopicGroupPath(entity.value.name));
        } else if (entity.kind === "state") {
          ensureGroup(MESH_GROUP_ID, "Mesh", mainId, 1);
          ensureGroup(STATE_GROUP_ID, "State", MESH_GROUP_ID, 1);
          parentId = ensurePath(STATE_GROUP_ID, topologyStateGroupPath(entity.value.key));
        } else if (!parentId) {
          parentId = mainId;
        }
      }
      const activityAt = entity.kind === "meshTopic" ? entity.value.lastEventAt : undefined;
      const startedAt = entity.kind === "agent" ? entity.value.startedAt : undefined;
      const queued = entity.kind === "actor" ? entity.value.queued : undefined;
      const stale = entity.kind === "meshParticipant"
        ? entity.value.participant?.stale
        : entity.kind === "agent"
          ? entity.value.stale
          : undefined;
      return {
        id: entity.id,
        label: entity.kind === "main"
          ? "Main"
          : entity.kind === "state" && entity.value.label === entity.value.key
            ? entity.value.key.split("/").at(-1) ?? entity.value.label
            : entity.label,
        status: entity.status,
        kind: nodeKind(entity),
        ...(parentId ? { parentId } : {}),
        ...(activityAt !== undefined ? { activityAt } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(queued !== undefined ? { queued } : {}),
        ...(stale !== undefined ? { stale } : {}),
        x: 0,
        y: 0,
      };
    });
  nodes.push(...groups.values());

  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const children = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (!node.parentId || node.parentId === node.id || !nodeById.has(node.parentId)) continue;
    const bucket = children.get(node.parentId) ?? [];
    bucket.push(node);
    children.set(node.parentId, bucket);
  }
  const inSelectedRun = (node: GraphNode): boolean => {
    const entity = entityById.get(node.id);
    return Boolean(selectedRun && entity?.kind === "agent" && entity.value.runId === selectedRun.id);
  };
  for (const bucket of children.values()) {
    bucket.sort(
      (left, right) =>
        activeRank(left.status) - activeRank(right.status) ||
        Number(inSelectedRun(right)) - Number(inSelectedRun(left)) ||
        (left.order ?? 0) - (right.order ?? 0) ||
        kindRank[left.kind] - kindRank[right.kind] ||
        left.label.localeCompare(right.label),
    );
  }

  let nextLeafY = 0;
  const visited = new Set<string>();
  const place = (node: GraphNode, depth: number): number => {
    if (visited.has(node.id)) return node.y;
    visited.add(node.id);
    node.x = depth * 20;
    const descendants = (children.get(node.id) ?? []).filter((child) => !visited.has(child.id));
    if (descendants.length === 0) {
      node.y = nextLeafY;
      nextLeafY += 2;
      return node.y;
    }
    const childRows = descendants.map((child) => place(child, depth + 1));
    node.y = (childRows[0]! + childRows[childRows.length - 1]!) / 2;
    return node.y;
  };
  const main = nodeById.get(mainId);
  if (main) place(main, 0);
  for (const node of nodes) {
    if (!visited.has(node.id)) place(node, 1);
  }
  const mainY = main?.y ?? 0;
  for (const node of nodes) node.y = Math.round(node.y - mainY);

  const edges: GraphEdge[] = [];
  for (const node of nodes) {
    if (node.parentId && nodeById.has(node.parentId) && node.parentId !== node.id) {
      edges.push({ from: node.parentId, to: node.id, kind: node.kind === "route" ? "route" : "structure" });
    }
  }
  for (const topic of mesh.topics) {
    const target = aliases.get(topic.id) ?? aliases.get(topic.name);
    if (!target) continue;
    for (const subscriber of topic.subscribers) {
      const source = aliases.get(subscriber.id) ?? aliases.get(subscriber.name);
      if (source && source !== target) edges.push({ from: source, to: target, kind: "subscription" });
    }
  }
  for (const entity of entities) {
    if (entity.kind !== "state" || !entity.value.owner) continue;
    const owner = aliases.get(entity.value.owner);
    const target = aliases.get(entity.value.key) ?? aliases.get(entity.value.label);
    if (owner && target && owner !== target) {
      edges.push({ from: owner, to: target, kind: "subscription" });
    }
  }
  for (const dependency of snapshot.componentGraph.edges) {
    const source = aliases.get(dependency.from);
    const target = aliases.get(dependency.to);
    if (source && target && source !== target) {
      edges.push({ from: source, to: target, kind: "subscription" });
    }
  }
  for (const route of mesh.routes) {
    const source = aliases.get(route.fromId) ?? aliases.get(route.fromName);
    const target = aliases.get(route.targetId) ?? aliases.get(route.targetName) ?? aliases.get(route.topic);
    if (source && target && source !== target) {
      edges.push({ from: source, to: target, kind: "route", route });
    }
  }
  const positions = new Map(nodes.map((node) => [node.id, { x: node.x, y: node.y }] as const));
  for (const edge of edges) {
    if (!edge.route) continue;
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) continue;
    positions.set(edge.route.id, {
      x: Math.round((from.x + to.x) / 2),
      y: Math.round((from.y + to.y) / 2),
    });
  }
  return { nodes, edges, positions };
};

const lineChar = (mask: number): string => {
  const chars: Record<number, string> = {
    1: "│", 2: "─", 3: "└", 4: "│", 5: "│", 6: "┌", 7: "├",
    8: "─", 9: "┘", 10: "─", 11: "┴", 12: "┐", 13: "┤", 14: "┬", 15: "┼",
  };
  return chars[mask] ?? "·";
};

const styleForStatus = (status: string): Cell["style"] => {
  if (["failed", "timed_out", "error", "quarantined"].includes(status)) return "error";
  if (["blocked", "waiting"].includes(status)) return "warning";
  if (isActiveStatus(status)) return "success";
  return "dim";
};

export const topologyTreeRouteNodeIds = (
  nodes: ReadonlyMap<string, { parentId?: string }>,
  fromId: string,
  toId: string,
): string[] => {
  if (fromId === toId) return [fromId];
  const ancestry = (start: string): string[] => {
    const path: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = start;
    while (current && !seen.has(current)) {
      path.push(current);
      seen.add(current);
      current = nodes.get(current)?.parentId;
    }
    return path;
  };
  const fromAncestors = ancestry(fromId);
  const fromSet = new Set(fromAncestors);
  const toAncestors = ancestry(toId);
  const common = toAncestors.find((id) => fromSet.has(id));
  if (!common) return [fromId, toId];
  return [
    ...fromAncestors.slice(0, fromAncestors.indexOf(common) + 1),
    ...toAncestors.slice(0, toAncestors.indexOf(common)).reverse(),
  ];
};

const routeGlyph = (route: FabricProjectMeshRoute): string => {
  if (route.status === "failed") return "!";
  const kind = route.kind.toLowerCase();
  if (kind.includes("certif")) return "✦";
  if (kind.includes("commit")) return "◆";
  if (kind.includes("control") || kind.includes("steer")) return "↯";
  if (kind.includes("message") || kind.includes("directive")) return "✉";
  return "•";
};

const routeStyle = (route: FabricProjectMeshRoute): Cell["style"] =>
  route.status === "failed"
    ? "error"
    : route.kind.toLowerCase().includes("certif")
      ? "warning"
      : "accent";

const renderCanvas = (
  theme: Theme,
  layout: FabricGraphLayout,
  selectedEntityId: string | undefined,
  width: number,
  height: number,
  camera: FabricGraphPoint,
  animation: FabricGraphAnimation,
): string[] => {
  const originX = Math.round(camera.x - width / 2);
  const originY = Math.round(camera.y - height / 2);
  const cells: Cell[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ char: " ", style: "plain" as const })),
  );
  const masks: number[][] = Array.from({ length: height }, () => Array<number>(width).fill(0));
  const nodeById = new Map(layout.nodes.map((node) => [node.id, node] as const));
  const selectedRoute = layout.edges.find((edge) => edge.route?.id === selectedEntityId)?.route;
  const related = new Set<string>(selectedEntityId ? [selectedEntityId] : []);
  for (const edge of layout.edges) {
    if (edge.from === selectedEntityId || edge.to === selectedEntityId || edge.route?.id === selectedEntityId) {
      related.add(edge.from);
      related.add(edge.to);
      if (edge.route) related.add(edge.route.id);
    }
  }
  const setCell = (x: number, y: number, char: string, style: Cell["style"]): void => {
    const sx = x - originX;
    const sy = y - originY;
    if (sx < 0 || sx >= width || sy < 0 || sy >= height) return;
    cells[sy]![sx] = { char, style };
  };
  const addMask = (x: number, y: number, mask: number): void => {
    const sx = x - originX;
    const sy = y - originY;
    if (sx < 0 || sx >= width || sy < 0 || sy >= height) return;
    masks[sy]![sx] = (masks[sy]![sx] ?? 0) | mask;
  };
  const horizontal = (x1: number, x2: number, y: number): void => {
    if (y < originY || y >= originY + height) return;
    const worldStart = Math.min(x1, x2);
    const worldEnd = Math.max(x1, x2);
    const start = Math.max(worldStart, originX);
    const end = Math.min(worldEnd, originX + width - 1);
    for (let x = start; x <= end; x++) {
      addMask(x, y, (x > worldStart ? 8 : 0) | (x < worldEnd ? 2 : 0));
    }
  };
  const vertical = (x: number, y1: number, y2: number): void => {
    if (x < originX || x >= originX + width) return;
    const worldStart = Math.min(y1, y2);
    const worldEnd = Math.max(y1, y2);
    const start = Math.max(worldStart, originY);
    const end = Math.min(worldEnd, originY + height - 1);
    for (let y = start; y <= end; y++) {
      addMask(x, y, (y > worldStart ? 1 : 0) | (y < worldEnd ? 4 : 0));
    }
  };
  const edgePathPoints = (from: GraphNode, to: GraphNode): FabricGraphPoint[] => {
    const fromEnd = from.x + Math.min(16, visibleWidth(safeText(from.label)) + 3);
    const toStart = to.x - 2;
    const bend = Math.max(fromEnd + 1, Math.floor((fromEnd + toStart) / 2));
    const points: FabricGraphPoint[] = [];
    const appendLine = (x1: number, y1: number, x2: number, y2: number): void => {
      const dx = Math.sign(x2 - x1);
      const dy = Math.sign(y2 - y1);
      const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
      for (let step = points.length === 0 ? 0 : 1; step <= steps; step++) {
        points.push({ x: x1 + dx * step, y: y1 + dy * step });
      }
    };
    appendLine(fromEnd, from.y, bend, from.y);
    appendLine(bend, from.y, bend, to.y);
    appendLine(bend, to.y, toStart, to.y);
    return points;
  };
  const treePathPoints = (from: GraphNode, to: GraphNode): FabricGraphPoint[] => {
    const ids = topologyTreeRouteNodeIds(nodeById, from.id, to.id);
    const points: FabricGraphPoint[] = [];
    for (let index = 0; index < ids.length - 1; index++) {
      const left = nodeById.get(ids[index]!);
      const right = nodeById.get(ids[index + 1]!);
      if (!left || !right) continue;
      const segment = right.parentId === left.id
        ? edgePathPoints(left, right)
        : left.parentId === right.id
          ? edgePathPoints(right, left).reverse()
          : edgePathPoints(left, right);
      const previous = points.at(-1);
      const first = segment[0];
      if (previous && first && previous.x === first.x && previous.y === first.y) segment.shift();
      points.push(...segment);
    }
    return points;
  };

  for (const edge of layout.edges) {
    if (edge.kind !== "structure") continue;
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) continue;
    const fromEnd = from.x + Math.min(16, visibleWidth(safeText(from.label)) + 3);
    const toStart = to.x - 2;
    const bend = Math.max(fromEnd + 1, Math.floor((fromEnd + toStart) / 2));
    horizontal(fromEnd, bend, from.y);
    vertical(bend, from.y, to.y);
    horizontal(bend, toStart, to.y);
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const mask = masks[y]?.[x] ?? 0;
      if (mask) cells[y]![x] = { char: lineChar(mask), style: "edge" };
    }
  }

  const traffic = new Map<string, { from: GraphNode; to: GraphNode; routes: FabricProjectMeshRoute[] }>();
  for (const edge of layout.edges) {
    if (edge.kind === "structure") continue;
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) continue;
    if (!edge.route) {
      if (edge.from !== selectedEntityId && edge.to !== selectedEntityId) continue;
      const points = treePathPoints(from, to);
      for (let index = 0; index < points.length; index += 2) {
        const point = points[index]!;
        setCell(point.x, point.y, "·", "accent");
      }
      continue;
    }
    const key = `${edge.from}\u0000${edge.to}`;
    const group = traffic.get(key) ?? { from, to, routes: [] };
    group.routes.push(edge.route);
    traffic.set(key, group);
  }

  for (const group of traffic.values()) {
    const points = treePathPoints(group.from, group.to);
    if (points.length === 0) continue;
    const selected = group.routes.find((route) => route.id === selectedEntityId);
    const replay = group.routes.find((route) => route.id === animation.replayRouteId);
    const newest = group.routes.reduce((latest, route) => route.lastAt > latest.lastAt ? route : latest);
    const route = replay ?? selected ?? newest;
    const age = Math.max(0, animation.now - route.lastAt);
    const connected = group.from.id === selectedEntityId || group.to.id === selectedEntityId;
    const visible = Boolean(replay || selected || connected || animation.showHistory || age <= 60_000);
    if (!visible) continue;
    const fresh = Boolean(replay || age <= 10_000);
    const style: Cell["style"] = selected || replay
      ? routeStyle(route)
      : fresh
        ? "accent"
        : "dim";
    const stride = fresh ? 1 : 2;
    for (let index = 0; index < points.length; index += stride) {
      const point = points[index]!;
      const trail = fresh && !animation.reducedMotion && index % 3 === 0 ? "━" : fresh ? "·" : "╌";
      setCell(point.x, point.y, trail, style);
    }
    const packetActive = !animation.reducedMotion && Boolean(replay || age <= 2_000);
    if (packetActive) {
      const duration = 1_200;
      const phase = replay
        ? (animation.now % duration) / duration
        : Math.min(0.999, age / 2_000);
      const packetIndex = Math.min(points.length - 1, Math.floor(phase * points.length));
      const point = points[packetIndex]!;
      setCell(point.x, point.y, routeGlyph(route), routeStyle(route));
      if (route.kind.toLowerCase().includes("certif")) {
        const ripple = points[Math.max(0, points.length - 1 - packetIndex)]!;
        setCell(ripple.x, ripple.y, "✦", "warning");
      } else if (route.status === "failed") {
        const impact = points.at(-1)!;
        setCell(impact.x, impact.y, Math.floor(animation.now / 120) % 2 === 0 ? "╳" : "!", "error");
      }
      const label = graphLabel(animation.replayLabel ?? route.kind, 18);
      let offset = 2;
      for (const char of label) {
        setCell(point.x + offset, point.y, char, routeStyle(route));
        offset += visibleWidth(char);
      }
    } else {
      const count = group.routes.reduce((total, candidate) => total + candidate.count, 0);
      if (count > 1) {
        const point = points[Math.floor(points.length / 2)]!;
        const label = `×${count}`;
        for (let index = 0; index < label.length; index++) {
          setCell(point.x + index, point.y, label[index]!, style);
        }
      }
    }
  }

  for (const node of layout.nodes) {
    const selected = node.id === selectedEntityId;
    const spotlighted = !selectedRoute || related.has(node.id);
    const glyph = selected ? "▣" : graphGlyph(node, animation);
    const label = graphLabel(safeText(node.label), 14);
    const nodeStyle = selected
      ? "accent"
      : !spotlighted
        ? "dim"
        : styleForStatus(node.status);
    setCell(node.x, node.y, glyph, nodeStyle);
    setCell(node.x + 1, node.y, " ", "plain");
    let offset = 0;
    for (const char of label) {
      setCell(node.x + 2 + offset, node.y, char, selected ? "accent" : spotlighted ? "muted" : "dim");
      offset += visibleWidth(char);
    }
  }

  const apply = (style: Cell["style"], value: string): string => {
    if (style === "edge") return theme.fg("borderMuted", value);
    if (style === "dim") return theme.fg("dim", value);
    if (style === "muted") return theme.fg("muted", value);
    if (style === "accent") return theme.fg("accent", theme.bold(value));
    if (style === "success") return theme.fg("success", value);
    if (style === "warning") return theme.fg("warning", value);
    if (style === "error") return theme.fg("error", value);
    return value;
  };
  return cells.map((row) => {
    let rendered = "";
    let style = row[0]?.style ?? "plain";
    let run = "";
    for (const cell of row) {
      if (cell.style !== style) {
        rendered += apply(style, run);
        style = cell.style;
        run = "";
      }
      run += cell.char;
    }
    rendered += apply(style, run);
    return truncateToWidth(rendered, width, "");
  });
};
const wrapInspector = (theme: Theme, label: string, value: string, width: number): string[] => {
  const clean = safeText(value);
  const first = truncateToWidth(clean, Math.max(1, width - label.length - 1), "…");
  return [theme.fg("muted", `${label} ${first}`)];
};

const inspectorLines = (
  theme: Theme,
  entity: Entity | undefined,
  snapshot: FabricDashboardSnapshot,
  run: FabricActivityRun | undefined,
  width: number,
  height: number,
  invalidate?: () => void,
): string[] => {
  const inner = Math.max(1, width - 2);
  const border = (value: string): string => theme.fg("borderMuted", value);
  const content: string[] = [];
  if (entity) {
    content.push(theme.fg("accent", theme.bold(truncateToWidth(safeText(entity.label), inner - 2, "…"))));
    content.push(colorStatus(theme, entity.status, `${statusGlyph(entity.status)} ${entity.kind} · ${entity.status}`));
    content.push("");
    content.push(theme.fg("dim", truncateToWidth(safeText(entityTail(entity, snapshot.now)), inner - 2, "…")));
    if (entity.kind === "agent") {
      const agentRun = snapshot.runs.find((candidate) => candidate.id === entity.value.runId) ?? run;
      const phase = agentRun?.phases.find((candidate) => candidate.id === entity.value.phaseId);
      if (agentRun) content.push(theme.fg("muted", `run   ${safeText(agentRun.name)}`));
      if (phase) content.push(theme.fg("muted", `phase ${safeText(phase.name)}`));
      if (entity.value.currentTool) content.push(theme.fg("muted", `tool  ${safeText(entity.value.currentTool)}`));
      if (entity.value.model) content.push(theme.fg("muted", `model ${safeText(entity.value.model)}`));
      if (entity.value.task) content.push(...wrapInspector(theme, "task", entity.value.task, inner - 2));
    } else if (entity.kind === "actor") {
      content.push(theme.fg("muted", `runner ${entity.value.runner}`));
      content.push(theme.fg("muted", `queue  ${entity.value.queued}`));
      if (entity.value.topics.length > 0) content.push(theme.fg("muted", `${entity.value.topics.length} subscriptions`));
    } else if (entity.kind === "component") {
      content.push(theme.fg("muted", `definition ${safeText(entity.value.component)}`));
      content.push(theme.fg("muted", `guarantee  ${entity.value.guarantee}`));
      if (entity.value.parentId) {
        content.push(theme.fg("muted", `parent     ${safeText(entity.value.parentId)}`));
      }
      if (entity.value.effects?.length) {
        content.push(theme.fg("muted", `effects    ${entity.value.effects.length}`));
      }
      if (entity.value.effectConflicts?.length) {
        content.push(theme.fg("warning", `conflicts  ${entity.value.effectConflicts.length}`));
      }
      if (entity.value.requirements.length > 0) {
        content.push(theme.fg("muted", `requires   ${entity.value.requirements.join(", ")}`));
      }
      if (entity.value.provisions.length > 0) {
        content.push(theme.fg("muted", `provides   ${entity.value.provisions.join(", ")}`));
      }
      const cycles = snapshot.componentGraph.cycles.filter((cycle) =>
        cycle.includes(entity.value.id),
      );
      if (cycles.length > 0) {
        content.push(theme.fg("warning", `cycles     ${cycles.map((cycle) => cycle.join(" → ")).join("; ")}`));
      }
      if (entity.value.error) content.push(theme.fg("error", safeText(entity.value.error)));
    } else if (entity.kind === "meshTopic") {
      content.push(theme.fg("muted", `${entity.value.subscribers.length} subscribers`));
      content.push(theme.fg("muted", `${entity.value.recentEvents} recent events`));
    } else if (entity.kind === "meshRoute") {
      content.push(theme.fg("muted", `${safeText(entity.value.fromName)} → ${safeText(entity.value.targetName)}`));
      content.push(theme.fg("muted", `kind  ${safeText(entity.value.kind)}`));
      content.push(theme.fg("muted", `topic ${safeText(entity.value.topic)}`));
      content.push(theme.fg("muted", `count ${entity.value.count}`));
    } else if (entity.kind === "state") {
      content.push(theme.fg("muted", `version ${entity.value.version}`));
      if (entity.value.owner) content.push(theme.fg("muted", `owner   ${safeText(entity.value.owner)}`));
      const filePreview = loadStateFilePreview(entity.value, snapshot.main.cwd ?? process.cwd());
      if (filePreview) {
        content.push("");
        content.push(theme.fg("muted", `file ${safeText(filePreview.path)}`));
        content.push(...renderStateFilePreview(
          filePreview,
          theme,
          Math.max(1, inner - 2),
          Math.max(0, height - content.length - 3),
          invalidate,
        ));
      }
    }
  } else {
    content.push(theme.fg("dim", "No node selected"));
  }
  const title = " selected ";
  const rows = [border(`╭${title}${"─".repeat(Math.max(0, inner - visibleWidth(title)))}╮`)];
  for (let index = 0; index < height - 2; index++) {
    rows.push(`${border("│")}${padToWidth(` ${content[index] ?? ""}`, inner)}${border("│")}`);
  }
  rows.push(border(`╰${"─".repeat(inner)}╯`));
  return rows.slice(0, height);
};

const graphContextEntities = (allEntities: Entity[], entities: Entity[]): Entity[] => {
  const byRawId = new Map<string, Entity>();
  for (const entity of allEntities) {
    for (const identity of rawIdentity(entity)) {
      if (identity) byRawId.set(identity, entity);
    }
  }
  const visible = new Map(entities.map((entity) => [entity.id, entity] as const));
  for (const entity of entities) {
    let parentRef = parentReference(entity);
    const visited = new Set<string>();
    while (parentRef && !visited.has(parentRef)) {
      visited.add(parentRef);
      const parent = byRawId.get(parentRef);
      if (!parent) break;
      visible.set(parent.id, parent);
      parentRef = parentReference(parent);
    }
  }
  return allEntities.filter((entity) => visible.has(entity.id));
};

export interface FabricTopologyRenderResult {
  lines: string[];
  positions: Map<string, FabricGraphPoint>;
  selectedPosition?: FabricGraphPoint;
}

export const renderFabricTopologyPanel = ({
  theme,
  filter,
  selectedEntityId,
  snapshot,
  run,
  mesh,
  allEntities,
  entities,
  width,
  height,
  camera,
  animation,
  invalidate,
}: {
  theme: Theme;
  filter: StatusFilter;
  selectedEntityId: string | undefined;
  snapshot: FabricDashboardSnapshot;
  run: FabricActivityRun | undefined;
  mesh: FabricProjectMeshModel;
  allEntities: Entity[];
  entities: Entity[];
  width: number;
  height: number;
  camera: FabricGraphPoint;
  animation: FabricGraphAnimation;
  invalidate?: () => void;
}): FabricTopologyRenderResult => {
  const graphEntities = graphContextEntities(allEntities, entities);
  const layout = buildLayout(snapshot, graphEntities, run, mesh);
  const selectableIds = new Set(entities.map((entity) => entity.id));
  const selected = entities.find((entity) => entity.id === selectedEntityId) ?? entities[0];
  const inspectorWidth = width >= 92 ? Math.min(36, Math.max(30, Math.floor(width * 0.3))) : 0;
  const graphWidth = Math.max(1, width - inspectorWidth);
  const graph = renderCanvas(theme, layout, selected?.id, graphWidth, height, camera, animation);
  const inspector = inspectorWidth > 0
    ? inspectorLines(theme, selected, snapshot, run, inspectorWidth, height, invalidate)
    : [];
  const lines = inspectorWidth > 0
    ? graph.map((line, index) =>
        `${padToWidth(line, graphWidth)}${inspector[index] ?? ""}`,
      )
    : graph;
  const active = entities.filter((entity) => isActiveStatus(entity.status)).length;
  const originX = Math.round(camera.x - graphWidth / 2);
  const originY = Math.round(camera.y - height / 2);
  const hiddenLeft = layout.nodes.filter((node) => node.x < originX).length;
  const hiddenRight = layout.nodes.filter((node) => node.x + 2 > originX + graphWidth).length;
  const hiddenUp = layout.nodes.filter((node) => node.y < originY).length;
  const hiddenDown = layout.nodes.filter((node) => node.y >= originY + height).length;
  const offCanvas = new Set(
    layout.nodes
      .filter(
        (node) =>
          node.x < originX || node.x + 2 > originX + graphWidth ||
          node.y < originY || node.y >= originY + height,
      )
      .map((node) => node.id),
  ).size;
  const directions = [
    hiddenLeft > 0 ? "←" : "",
    hiddenRight > 0 ? "→" : "",
    hiddenUp > 0 ? "↑" : "",
    hiddenDown > 0 ? "↓" : "",
  ].join("");
  if (lines.length > 0 && height > 1) {
    const legend = [
      offCanvas > 0 ? `${directions} ${offCanvas} off-canvas` : undefined,
      `${active} active`,
      "◆ Main",
      "■ agent",
      "◇ actor",
      "◎ topic",
      "▱ group",
      animation.replayRouteId ? "▶ replay" : animation.showHistory ? "history" : "live decay",
      "⬡ component",
      animation.reducedMotion ? "reduced motion" : undefined,
      filter !== "all" ? `${entities.length}/${allEntities.length} ${filter}` : undefined,
    ].filter((value): value is string => Boolean(value)).join(" · ");
    const graphLegend = padToWidth(theme.fg("dim", truncateToWidth(legend, graphWidth, "")), graphWidth);
    lines[0] = truncateToWidth(
      graphLegend + (inspectorWidth > 0 ? inspector[0] ?? "" : ""),
      width,
      "",
    );
  }
  const selectedPosition = selected ? layout.positions.get(selected.id) : undefined;
  return {
    lines,
    positions: new Map(
      [...layout.positions].filter(([id]) => selectableIds.has(id)),
    ),
    ...(selectedPosition ? { selectedPosition } : {}),
  };
};

export const directionalGraphTarget = (
  positions: ReadonlyMap<string, FabricGraphPoint>,
  currentId: string | undefined,
  direction: "left" | "right" | "up" | "down",
): string | undefined => {
  const current = currentId ? positions.get(currentId) : undefined;
  if (!current) return positions.keys().next().value;
  let best: { id: string; score: number } | undefined;
  for (const [id, point] of positions) {
    if (id === currentId) continue;
    const dx = point.x - current.x;
    const dy = point.y - current.y;
    const primary = direction === "left" ? -dx : direction === "right" ? dx : direction === "up" ? -dy : dy;
    if (primary <= 0) continue;
    const secondary = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
    const score = primary + secondary * 2.4;
    if (!best || score < best.score) best = { id, score };
  }
  return best?.id;
};
