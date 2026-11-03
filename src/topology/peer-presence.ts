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
 * Deterministic for a given change: no clock, run status, or model enters the
 * text, so the persisted notice never differs between two requests.
 */
export const formatPeerPresenceNotice = (change: PeerPresenceChange, selfCwd?: string): string => {
  const joined = new Set(change.joined.map((record) => record.id));
  const markJoined = change.present.length > joined.size;
  const ownCwd = selfCwd === undefined ? undefined : clean(selfCwd, 240);
  const lines = ["<fabric-peers>"];
  if (change.present.length > 0) {
    lines.push("Other Pi sessions are working in this project and share its files with you:");
    for (const record of change.present.slice(0, MAX_LISTED_PEERS)) {
      lines.push(
        `- ${record.label} (id ${record.id})` +
          (record.cwd && record.cwd !== ownCwd ? `, working in ${record.cwd}` : "") +
          (markJoined && joined.has(record.id) ? ", just joined" : ""),
      );
    }
    const unlisted = change.present.length - MAX_LISTED_PEERS;
    if (unlisted > 0) lines.push(`- and ${unlisted} more`);
  } else {
    lines.push("No other Pi session is working in this project any more.");
  }
  if (change.left.length > 0) {
    lines.push(`No longer present: ${change.left.map((record) => record.label).join(", ")}.`);
  }
  if (change.present.length > 0) {
    lines.push(
      "File or git changes you did not make may be theirs: do not revert or overwrite them. " +
        "Before a wide edit, a branch switch, a reset, or a dependency install, use `agents.peers` " +
        "inside `fabric_exec` to see who is running and `agents.steer` to message one by id.",
    );
  }
  lines.push("</fabric-peers>");
  return lines.join("\n");
};

const formatPeerPresenceNotification = (change: PeerPresenceChange): string => {
  const names = (records: PeerPresenceRecord[]) => records.slice(0, 3).map(record => record.label).join(", ") +
    (records.length > 3 ? ` +${records.length - 3} more` : "");
  return "Fabric peers: " + [
    change.joined.length ? `joined ${names(change.joined)}` : "",
    change.left.length ? `left ${names(change.left)}` : "",
    `${change.present.length} active`,
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
 * project. Notices are appended at a turn boundary as persistent transcript
 * messages and never touch the system prompt or an earlier message, so the
 * provider's cached prefix stays valid.
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
    subscribe("before_agent_start", (_event, ctx) => {
      // A run without a UI has no reader for the notice, and the model's reply to
      // it would replace the answer in `pi -p` output. Skip before the ledger moves.
      if (ctx?.hasUI === false) return undefined;
      const message = this.#take(ctx);
      return message ? { message } : undefined;
    });
    subscribe("turn_end", (event, ctx) => {
      // Only a turn that goes on to another model call. A final turn waits for
      // the next prompt, which folds every change made while idle into one notice.
      if (ctx?.hasUI === false || ctx?.signal?.aborted || event?.message?.role !== "assistant" || event.message.stopReason !== "toolUse") {
        return undefined;
      }
      const message = this.#take(ctx);
      if (!message) return undefined;
      // A boundary entry rides the next request without forcing an extra one.
      return { entries: [...(event.entries ?? []), { type: "custom_message", ...message }] };
    });
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
