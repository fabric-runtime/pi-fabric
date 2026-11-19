import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FabricPeerInfo } from "./types.js";

export const PEER_PRESENCE_MESSAGE_TYPE = "pi-fabric-peer-presence";

/**
 * Longer than the 15s host lease, so one missed heartbeat or a wake from sleep
 * is not reported as a departure followed by a rejoin.
 */
export const PEER_DEPARTURE_GRACE_MS = 20_000;
const MAX_LISTED_PEERS = 12;

/** The stable facts a notice states about one peer. No status, clock, or model. */
export interface PeerPresenceRecord {
  id: string;
  label: string;
  cwd?: string;
}

export interface PeerPresenceChange {
  joined: PeerPresenceRecord[];
  left: PeerPresenceRecord[];
  /** Every peer the model now believes present, after this change. */
  present: PeerPresenceRecord[];
}

interface PeerPresenceDetails {
  version: 1;
  present: PeerPresenceRecord[];
}

type PeerPresenceMessage = {
  customType: string;
  content: string;
  display: boolean;
  details: PeerPresenceDetails;
};

// Records come from other processes: keep them on one line and out of the envelope.
const clean = (text: string, limit: number): string =>
  text.replace(/[\u0000-\u001f\u007f<>]/g, " ").trim().slice(0, limit);

// Labels are minted in order, so numeric-aware label order is creation order.
const byLabel = (left: PeerPresenceRecord, right: PeerPresenceRecord): number =>
  left.label.localeCompare(right.label, "en", { numeric: true }) ||
  (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

export const peerPresenceRecord = (
  peer: Pick<FabricPeerInfo, "id" | "name" | "label" | "cwd">,
): PeerPresenceRecord => {
  const cwd = clean(peer.cwd ?? "", 240);
  return {
    id: clean(peer.id, 128),
    label: clean(peer.label ?? peer.name, 64) || "Peer",
    ...(cwd ? { cwd } : {}),
  };
};

const recordsFromEntry = (entry: unknown): PeerPresenceRecord[] | undefined => {
  if (typeof entry !== "object" || entry === null) return undefined;
  const candidate = entry as { type?: unknown; customType?: unknown; details?: unknown };
  if (candidate.type !== "custom_message" || candidate.customType !== PEER_PRESENCE_MESSAGE_TYPE) {
    return undefined;
  }
  const present = (candidate.details as { present?: unknown } | undefined)?.present;
  if (!Array.isArray(present)) return [];
  return present.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const record = value as Partial<PeerPresenceRecord>;
    if (typeof record.id !== "string" || !record.id || typeof record.label !== "string") return [];
    return [{
      id: record.id,
      label: record.label,
      ...(typeof record.cwd === "string" && record.cwd ? { cwd: record.cwd } : {}),
    }];
  });
};

/**
 * Branch-local record of which peers the model has been told about. Restored
 * from `pi-fabric-peer-presence` transcript entries only, so a resumed or
 * re-branched session never repeats a notice its context still holds.
 */
export class PeerPresenceLedger {
  readonly #known = new Map<string, PeerPresenceRecord>();
  readonly #missingSince = new Map<string, number>();

  reset(): void {
    this.#known.clear();
    this.#missingSince.clear();
  }

  restoreFromEntries(entries: readonly unknown[]): void {
    this.reset();
    for (const entry of entries) {
      // A compaction may have dropped every earlier notice from the context.
      if ((entry as { type?: unknown } | null)?.type === "compaction") {
        this.#known.clear();
        continue;
      }
      const records = recordsFromEntry(entry);
      if (!records) continue;
      this.#known.clear();
      for (const record of records) this.#known.set(record.id, record);
    }
    // Only a peer this process saw alive earns the grace window.
    for (const id of this.#known.keys()) this.#missingSince.set(id, Number.NEGATIVE_INFINITY);
  }

  /**
   * Start or clear the departure grace window of each known peer without
   * reporting anything, so a departure seen during a run is ripe by the next
   * prompt. Peers the model was never told about are not tracked.
   */
  observe(current: readonly PeerPresenceRecord[], now: number): void {
    const live = new Set(current.map((record) => record.id));
    for (const id of this.#known.keys()) {
      if (live.has(id)) this.#missingSince.delete(id);
      else if (!this.#missingSince.has(id)) this.#missingSince.set(id, now);
    }
  }

  take(current: readonly PeerPresenceRecord[], now: number): PeerPresenceChange | undefined {
    const live = new Map(current.map((record) => [record.id, record] as const));
    const joined = [...live.values()].filter((record) => !this.#known.has(record.id));
    const left: PeerPresenceRecord[] = [];
    for (const [id, record] of this.#known) {
      if (live.has(id)) {
        this.#missingSince.delete(id);
        continue;
      }
      const since = this.#missingSince.get(id);
      if (since === undefined) this.#missingSince.set(id, now);
      else if (now - since >= PEER_DEPARTURE_GRACE_MS) left.push(record);
    }
    if (joined.length === 0 && left.length === 0) return undefined;
    for (const record of left) {
      this.#known.delete(record.id);
      this.#missingSince.delete(record.id);
    }
    for (const record of joined) this.#known.set(record.id, record);
    return {
      joined: joined.sort(byLabel),
      left: left.sort(byLabel),
      present: [...this.#known.values()].sort(byLabel),
    };
  }
}

/**
 * How the model should treat the peers a notice names. Stated once in the
 * system prompt, so each notice carries only the change.
 */
export const PEER_COORDINATION_GUIDANCE =
  "Peer sessions: a <fabric-peers> notice names, by label, other Pi sessions that joined or left this project and share its files with you. " +
  "File or git changes you did not make may be theirs: do not revert or overwrite them. " +
  "Before a wide edit, a branch switch, a reset, or a dependency install, use `agents.peers` inside `fabric_exec` to see who is running and their ids, " +
  "and `agents.steer` to message one by id. " +
  "Coordinate only with relevant peers that are running or have pending messages, not every connected session. " +
  "Routine peer messages are passive; use triggerTurn: true only when a peer must act. Do not acknowledge informational updates unless action is needed.";

const listLabels = (records: readonly PeerPresenceRecord[], ownCwd: string | undefined): string => {
  const listed = records.slice(0, MAX_LISTED_PEERS).map((record) =>
    record.label + (record.cwd && record.cwd !== ownCwd ? ` (working in ${record.cwd})` : ""));
  const unlisted = records.length - MAX_LISTED_PEERS;
  return listed.join(", ") + (unlisted > 0 ? `, and ${unlisted} more` : "");
};

/**
 * Only the change, by label: ids stay behind `agents.peers`, and the advice on
 * what to do about peers lives in the system prompt. Deterministic for a given
 * change: no clock, run status, or model enters the text, so the persisted
 * notice never differs between two requests.
 */
export const formatPeerPresenceNotice = (change: PeerPresenceChange, selfCwd?: string): string => {
  const ownCwd = selfCwd === undefined ? undefined : clean(selfCwd, 240);
  const lines = ["<fabric-peers>"];
  if (change.joined.length > 0) lines.push(`joined: ${listLabels(change.joined, ownCwd)}`);
  if (change.left.length > 0) lines.push(`left: ${listLabels(change.left, ownCwd)}`);
  lines.push(change.present.length > 0
    ? `connected: ${change.present.length}`
    : "No other Pi session is connected to this project now.");
  lines.push("</fabric-peers>");
  return lines.join("\n");
};

const formatPeerPresenceNotification = (change: PeerPresenceChange): string => {
  const names = (records: PeerPresenceRecord[]) => records.slice(0, 3).map(record => record.label).join(", ") +
    (records.length > 3 ? ` +${records.length - 3} more` : "");
  return "Fabric peers: " + [
    change.joined.length ? `joined ${names(change.joined)}` : "",
    change.left.length ? `left ${names(change.left)}` : "",
    `${change.present.length} connected`,
  ].filter(Boolean).join("; ");
};

export interface PeerPresenceNotifierOptions {
  peers: () => FabricPeerInfo[];
  enabled: () => boolean;
  cwd: string;
  now?: () => number;
}

/**
 * Tells a root session's model when other root sessions join or leave the
 * project. A notice rides only a run the person started: every change since
 * the last notice is folded into one message at the next prompt, and a run
 * started by a custom message or continued after a tool call adds nothing.
 * Notices are persistent transcript messages and never touch an earlier
 * message, so the provider's cached prefix stays valid.
 */
export class PeerPresenceNotifier {
  readonly #ledger = new PeerPresenceLedger();
  readonly #unsubscribe: Array<() => void> = [];
  readonly #now: () => number;

  constructor(
    pi: ExtensionAPI,
    context: ExtensionContext,
    readonly options: PeerPresenceNotifierOptions,
  ) {
    this.#now = options.now ?? (() => Date.now());
    this.#restore(context);
    const subscribe = (event: string, handler: (...handlerArgs: any[]) => unknown): void => {
      if (typeof pi.on !== "function") return;
      const unsubscribe = (pi.on as (name: string, fn: (...fnArgs: any[]) => unknown) => unknown)(event, handler);
      if (typeof unsubscribe === "function") this.#unsubscribe.push(unsubscribe as () => void);
    };
    subscribe("before_agent_start", (event, ctx) => {
      // A run without a UI has no reader for the notice, and the model's reply to
      // it would replace the answer in `pi -p` output. A run a custom message
      // started (a completion, a peer message) is not the person's. Skip both
      // before the ledger moves, so the next prompt still carries the change.
      if (ctx?.hasUI === false || event?.messageType === "custom") return undefined;
      const message = this.#take(ctx);
      return message ? { message } : undefined;
    });
    // A departure seen mid-run starts its grace window now, so it is ripe by
    // the next prompt. Nothing is added to the run.
    subscribe("turn_end", () => { this.#observe(); return undefined; });
    subscribe("session_tree", (_event, ctx) => this.#restore(ctx));
    subscribe("session_compact", () => this.#ledger.reset());
  }

  close(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#ledger.reset();
  }

  #restore(context: ExtensionContext | undefined): void {
    try {
      this.#ledger.restoreFromEntries(context?.sessionManager?.getBranch?.() ?? []);
    } catch {
      this.#ledger.reset();
    }
  }

  #observe(): void {
    try {
      if (this.options.enabled()) this.#ledger.observe(this.options.peers().map(peerPresenceRecord), this.#now());
    } catch {
      // Presence is advisory: a damaged mesh read must never fail a turn.
    }
  }

  #take(context: ExtensionContext | undefined): PeerPresenceMessage | undefined {
    try {
      if (!this.options.enabled()) return undefined;
      const change = this.#ledger.take(this.options.peers().map(peerPresenceRecord), this.#now());
      if (!change) return undefined;
      // Human feedback is transient; the full safety advice remains in model
      // context, without a visible transcript card or an extra model turn.
      try { context?.ui?.notify?.(formatPeerPresenceNotification(change), "info"); } catch { /* UI failure must not lose model advice. */ }
      return {
        customType: PEER_PRESENCE_MESSAGE_TYPE,
        content: formatPeerPresenceNotice(change, this.options.cwd),
        display: false,
        details: { version: 1, present: change.present },
      };
    } catch {
      // Presence is advisory: a damaged mesh read must never fail a turn.
      return undefined;
    }
  }
}
