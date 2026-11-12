import { randomUUID } from "node:crypto";
import type { ResolvedFabricAction } from "./action-registry.js";
import { stableJsonHash } from "./stable-hash.js";
import { boundedPreviewValue, previewArgs, strictDecisionResult } from "./action-result.js";
import { consume, transitionCurrent } from "../verified/policy.js";

export type PermissionStatus = "pending" | "allowed" | "denied" | "used" | "expired";
export interface FabricPermissionRecord {
  id: string;
  ref: string;
  risk: ResolvedFabricAction["risk"];
  cwd: string;
  preview: string;
  reason: string;
  status: PermissionStatus;
  createdAt: number;
  expiresAt: number;
}
interface Entry { record: FabricPermissionRecord; key: string; epoch: number }
const TTL_MS = 30 * 60_000;
const MAX_RECORDS = 200;

/** Session-local retry authorizations, never saved arguments or executable
 * closures. Allowing a ticket does not execute it: the next identical call
 * must pass the live registry, schema, host policy and approval checks again.
 * Host assumptions: SHA-256 identity covers the normalized descriptor, cwd
 * and complete JSON arguments; one JS turn owns each mutation. The existing
 * verified transition/consume kernels enforce current, one-use grants. */
export class FabricPermissionQueue {
  #entries = new Map<string, Entry>();
  #keys = new Map<string, string>();
  #epoch = 0;
  constructor(readonly now: () => number = Date.now) {}

  #key(action: ResolvedFabricAction, args: Record<string, unknown>, cwd: string): string {
    // Reject lossy JSON rather than minting a grant for an ambiguous payload.
    strictDecisionResult(args);
    return stableJsonHash({ action, args, cwd });
  }
  #expire(): void {
    for (const entry of this.#entries.values()) {
      if ((entry.record.status === "pending" || entry.record.status === "allowed" || entry.record.status === "denied") && this.now() >= entry.record.expiresAt) {
        entry.record.status = "expired";
        if (this.#keys.get(entry.key) === entry.record.id) this.#keys.delete(entry.key);
      }
    }
  }
  list(): FabricPermissionRecord[] {
    this.#expire();
    return [...this.#entries.values()].map(entry => structuredClone(entry.record)).reverse();
  }
  get pendingCount(): number { return this.list().filter(record => record.status === "pending").length; }

  take(action: ResolvedFabricAction, args: Record<string, unknown>, cwd: string): "allowed" | FabricPermissionRecord | undefined {
    this.#expire();
    const key = this.#key(action, args, cwd);
    const entry = this.#entries.get(this.#keys.get(key) ?? "");
    if (!entry || entry.epoch !== this.#epoch) return undefined;
    if (entry.record.status === "allowed") {
      const token = consume(true);
      if (!token.released || token.active) throw new Error("Permission token could not be consumed");
      entry.record.status = "used";
      this.#keys.delete(key);
      return "allowed";
    }
    return structuredClone(entry.record);
  }

  block(action: ResolvedFabricAction, args: Record<string, unknown>, cwd: string, reason: string): FabricPermissionRecord {
    this.#expire();
    const key = this.#key(action, args, cwd);
    const old = this.#entries.get(this.#keys.get(key) ?? "");
    if (old) return structuredClone(old.record);
    for (const [id, entry] of this.#entries) {
      if (this.#entries.size < MAX_RECORDS) break;
      if (entry.record.status === "used" || entry.record.status === "expired") this.#entries.delete(id);
    }
    if (this.#entries.size >= MAX_RECORDS) throw new Error("Permission queue is full; triage with /fabric permissions");
    const record: FabricPermissionRecord = {
      id: `perm_${randomUUID()}`, ref: action.ref, risk: action.risk, cwd,
      preview: JSON.stringify(boundedPreviewValue(previewArgs(action.ref, args), 16_000), null, 2),
      reason: reason.slice(0, 2000), status: "pending", createdAt: this.now(), expiresAt: this.now() + TTL_MS,
    };
    this.#entries.set(record.id, { record, key, epoch: this.#epoch });
    this.#keys.set(key, record.id);
    return structuredClone(record);
  }

  decide(id: string, decision: "allowed" | "denied"): FabricPermissionRecord {
    this.#expire();
    const entry = this.#entries.get(id);
    if (!entry || !transitionCurrent(false, entry.epoch === this.#epoch, true, entry.record.status !== "pending")) {
      throw new Error("Permission is no longer pending");
    }
    entry.record.status = decision;
    return structuredClone(entry.record);
  }

  message(record: FabricPermissionRecord): string {
    return record.status === "denied"
      ? `Permission ${record.id} denied for ${record.ref}; the call did not run.`
      : `Permission ${record.id} pending for ${record.ref}; the call did not run. Continue independent work. The user can review /fabric permissions; after approval, retry only this call with identical arguments.`;
  }

  clear(): void { this.#epoch++; this.#entries.clear(); this.#keys.clear(); }
}
