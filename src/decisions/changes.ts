import { ActorMeshMonitor } from "../actors/mesh-monitor.js";
import type { MeshEvent, MeshStore } from "../mesh/store.js";
import type { FabricDecisionsChangedV1 } from "../protocol.js";
import {
  DECISION_PREFIX,
  DECISIONS_TOPIC,
  isDecisionRecord,
  onLocalDecisionChange,
  type DecisionChange,
  type DecisionRecord,
} from "./store.js";

// Turns decision writes into `pi-fabric:decisions:changed:v1` payloads for
// extensions in this Pi process. Two sources feed it:
//
// - Writes by a DecisionStore in this process arrive at once through the
//   in-process listener, with the exact change and the mesh version written.
// - Writes by another process (the decisions CLI, a child agent, another
//   session) arrive as `fabric.decisions` mesh wake hints. The feed then reads
//   the record from the mesh as it stands. It never calls the store, so it
//   never applies a deadline or writes anything.
//
// Both paths pass the mesh version of the record, and the feed emits a record
// only when its version is newer than the last one it emitted for that id. So
// each change reaches subscribers once per process, the hint for a local
// write is dropped, and a burst of remote changes coalesces to the latest.

const DECISION_ID = /^dec_[A-Za-z0-9_-]{8,64}$/;
const MAX_TRACKED_DECISIONS = 2_000;

export type DecisionFeedMesh = Pick<MeshStore, "root" | "latestOffset" | "tail" | "get">;

export class DecisionChangeFeed {
  #emitted = new Map<string, number>();
  #monitor: ActorMeshMonitor | undefined;
  #unsubscribe: (() => void) | undefined;
  #closed = false;

  constructor(
    readonly mesh: DecisionFeedMesh,
    readonly config: { actorPollMs: number; maxReadEvents: number },
    readonly emit: (payload: FabricDecisionsChangedV1) => void,
  ) {}

  start(): void {
    if (this.#closed || this.#monitor) return;
    this.#unsubscribe = onLocalDecisionChange(this.mesh.root, (change, record, version) => {
      this.#deliver(change, record, version);
    });
    // Only the read side of the mesh: the monitor must not release schedules.
    const mesh = this.mesh;
    this.#monitor = new ActorMeshMonitor(
      { root: mesh.root, latestOffset: () => mesh.latestOffset(), tail: (cursor, limit) => mesh.tail(cursor, limit) },
      { enabled: true, actorPollMs: this.config.actorPollMs, maxReadEvents: this.config.maxReadEvents },
      { beforePoll: () => !this.#closed, onEvent: (event) => this.#onEvent(event) },
    );
    this.#monitor.start();
  }

  /** Read the mesh log now instead of waiting for the next file event. */
  refresh(): void {
    this.#monitor?.schedule();
  }

  close(): void {
    this.#closed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#monitor?.close();
    this.#monitor = undefined;
    this.#emitted.clear();
  }

  #onEvent(event: MeshEvent): void {
    if (event.topic !== DECISIONS_TOPIC) return;
    const data = event.data;
    const id = typeof data === "object" && data !== null ? (data as Record<string, unknown>).id : undefined;
    if (typeof id !== "string" || !DECISION_ID.test(id)) return;
    let entry: ReturnType<DecisionFeedMesh["get"]>;
    try {
      entry = this.mesh.get(DECISION_PREFIX + id);
    } catch {
      return;
    }
    if (!entry || !isDecisionRecord(entry.value)) return;
    this.#deliver(changeOf(entry.value), entry.value, entry.version);
  }

  #deliver(change: DecisionChange, record: DecisionRecord, version: number): void {
    if (this.#closed) return;
    const last = this.#emitted.get(record.id);
    if (last !== undefined && version <= last) return;
    this.#emitted.delete(record.id);
    this.#emitted.set(record.id, version);
    if (this.#emitted.size > MAX_TRACKED_DECISIONS) {
      const oldest = this.#emitted.keys().next().value;
      if (oldest !== undefined) this.#emitted.delete(oldest);
    }
    const payload: FabricDecisionsChangedV1 = deepFreeze({
      version: 1,
      change,
      decision: structuredClone(record),
    });
    try {
      this.emit(payload);
    } catch {
      // A subscriber's failure never affects the decision or the feed.
    }
  }
}

/** Name a record read from the mesh by its state; local writes pass the exact change instead. */
const changeOf = (record: DecisionRecord): DecisionChange => {
  if (record.status !== "open") return record.status;
  return record.history?.length ? "escalated" : "raised";
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};
