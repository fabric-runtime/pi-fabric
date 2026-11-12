import crypto from "node:crypto";
import fs from "node:fs";

export type MemoryBranches = "active" | "all";

export interface LiveSessionBranch {
  entries: readonly unknown[];
  leafId: string | null;
}

export interface SessionLineage {
  branches: MemoryBranches;
  leafId: string | null;
  entryOrdinals: ReadonlySet<number> | null;
  fingerprint: string;
  coverageReasons: string[];
}

interface PersistedNode {
  id: string;
  parentId: string | null;
  ordinal: number;
}

interface PersistedRecord {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
}

const asPersistedRecord = (value: unknown): PersistedRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as PersistedRecord
    : null;

const isHeaderRecord = (record: PersistedRecord): boolean => record.type === "session";

const hasParentLink = (
  record: PersistedRecord,
): record is PersistedRecord & { id: string; parentId: string | null } =>
  typeof record.id === "string" && (record.parentId === null || typeof record.parentId === "string");

const persistedNodesFromRecords = (records: readonly unknown[]): PersistedNode[] => {
  const nodes: PersistedNode[] = [];
  let ordinal = 0;
  for (const value of records) {
    const record = asPersistedRecord(value);
    if (!record || isHeaderRecord(record)) continue;
    if (hasParentLink(record)) nodes.push({ id: record.id, parentId: record.parentId, ordinal });
    ordinal += 1;
  }
  return nodes;
};

const fingerprint = (branches: MemoryBranches, leafId: string | null, ids: string[]): string =>
  crypto.createHash("sha256").update(JSON.stringify({ branches, leafId, ids })).digest("hex");

const readPersistedNodes = (sessionFile: string): PersistedNode[] => {
  let content: string;
  try {
    content = fs.readFileSync(sessionFile, "utf8");
  } catch {
    return [];
  }
  const records: unknown[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return persistedNodesFromRecords(records);
};

const allLineage = (): SessionLineage => ({
  branches: "all",
  leafId: null,
  entryOrdinals: null,
  fingerprint: fingerprint("all", null, []),
  coverageReasons: [],
});

/**
 * Reconstruct Pi 0.80.6's persisted leaf semantics without treating append
 * order as a transcript: the final persisted entry is the leaf, duplicate IDs
 * resolve to their last record in the ID map, and parent links are walked to a
 * root. Cycles are stopped defensively and reported as incomplete coverage.
 */
export const reconstructSessionLineage = (
  sessionFile: string,
  branches: MemoryBranches,
  liveBranch?: LiveSessionBranch,
): SessionLineage =>
  branches === "all" ? allLineage() : buildActiveLineage(readPersistedNodes(sessionFile), liveBranch);

const buildActiveLineage = (nodes: PersistedNode[], liveBranch?: LiveSessionBranch, selectedLeafId?: string | null): SessionLineage => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const liveIds = liveBranch?.entries.flatMap((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const id = (entry as Record<string, unknown>).id;
    return typeof id === "string" ? [id] : [];
  });
  const leafId = liveBranch ? liveBranch.leafId : selectedLeafId !== undefined ? selectedLeafId : (nodes[nodes.length - 1]?.id ?? null);
  const path: PersistedNode[] = [];
  const reasons = new Set<string>();

  if (liveIds) {
    for (const id of liveIds) {
      const node = byId.get(id);
      if (node) path.push(node);
    }
  } else {
    const seen = new Set<string>();
    let current = leafId ? byId.get(leafId) : undefined;
    while (current) {
      if (seen.has(current.id)) {
        reasons.add("invalid_parent_graph");
        break;
      }
      seen.add(current.id);
      path.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    path.reverse();
  }

  const ids = liveIds ?? path.map((node) => node.id);
  return {
    branches: "active",
    leafId,
    entryOrdinals: new Set(path.map((node) => node.ordinal)),
    fingerprint: fingerprint("active", leafId, ids),
    coverageReasons: [...reasons].sort(),
  };
};

/**
 * Records variant of {@link reconstructSessionLineage}: identical Pi 0.80.6
 * leaf semantics applied to already-parsed session records instead of a file.
 */
export const reconstructRecordsLineage = (
  records: readonly unknown[],
  branches: MemoryBranches,
  liveBranch?: LiveSessionBranch,
  selectedLeafId?: string | null,
): SessionLineage =>
  branches === "all" ? allLineage() : buildActiveLineage(persistedNodesFromRecords(records), liveBranch, selectedLeafId);
