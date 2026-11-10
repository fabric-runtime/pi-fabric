import { fabricControlAbort } from "../core/control-abort.js";
import { stableJsonHash } from "../core/stable-hash.js";
import { consume } from "../verified/policy.js";
import { admitSpeculation, checkSpeculation, speculationExpired, SpeculationAccounting } from "../verified/speculation.js";
import type { FabricFreshnessChecker } from "./freshness.js";
import type {
  FabricSpeculationConfig,
  FabricSpeculationReplay,
  FabricSpeculationRuntime,
  FabricSpeculationServeResult,
  FabricSpeculationStats,
} from "./types.js";

// Ending speculative work is control flow: anything left awaiting it sees a
// branded reason the crash guard recognizes, never a bare DOMException.
const ended = (why: string): Error => fabricControlAbort(`Fabric speculation ${why}`);

interface SpeculationEntry {
  parentToolCallId: string;
  ref: string;
  birthEpoch: number;
  createdAt: number;
  active: boolean;
  controller: AbortController;
  freshness: FabricFreshnessChecker | undefined;
  replay: FabricSpeculationReplay;
  promise: Promise<unknown>;
  failed: boolean;
}

/**
 * Turn-scoped store of pre-launched speculation promises.
 *
 * Compiled kernels decide admission, consume each entry once, classify both
 * serve checkpoints, and update accounting. The host owns keyed storage and
 * observes actual promise settlement, epochs, time, freshness and aborts.
 * Binding identity is part of the key, so an old binding cannot serve a new one.
 * The concurrency observation counts retained nonfailed entries, not every
 * unsettled external effect. Reset aborts work and advances the epoch.
 */
export class FabricSpeculationStore implements FabricSpeculationRuntime {
  readonly #accounting = new SpeculationAccounting();
  readonly #entries = new Map<string, SpeculationEntry>();
  readonly #serving = new Set<SpeculationEntry>();
  readonly #endedInvocations = new Set<string>();
  readonly #maxConcurrent: number;
  readonly #maxEntries: number;
  readonly #entryTtlMs: number;

  constructor(config: Pick<FabricSpeculationConfig, "maxConcurrent" | "maxEntries" | "entryTtlMs">) {
    this.#maxConcurrent = config.maxConcurrent;
    this.#maxEntries = config.maxEntries;
    this.#entryTtlMs = config.entryTtlMs;
  }

  get epoch(): number { return this.#accounting.epoch; }

  stats(): FabricSpeculationStats & { pending: number } {
    return { ...this.#accounting.stats(), pending: this.#entries.size };
  }

  bumpEpoch(): void { this.#accounting.record("bump"); }

  /** Fence descriptor/argument preparation across resets, effects and invocation end. */
  captureLaunch(parentToolCallId: string): () => boolean {
    const epoch = this.epoch;
    return () => epoch === this.epoch && !this.#endedInvocations.has(parentToolCallId);
  }

  static key(parentToolCallId: string, ref: string, preparedArgs: Record<string, unknown>, bindingToken: string): string {
    return `${parentToolCallId}\n${ref}\n${stableJsonHash(preparedArgs)}\n${bindingToken}`;
  }

  /** Register and start work only after the compiled admission decision. */
  launch(
    parentToolCallId: string,
    ref: string,
    preparedArgs: Record<string, unknown>,
    execute: (signal: AbortSignal) => Promise<unknown>,
    freshness: FabricFreshnessChecker | undefined,
    replay: FabricSpeculationReplay,
    bindingToken: string,
  ): boolean {
    // Preserve the host protocol: an ended invocation neither sweeps nor skips.
    if (this.#endedInvocations.has(parentToolCallId)) return false;
    this.#sweepExpired(Date.now());
    const admission = (duplicate: boolean) => admitSpeculation({
      ended: this.#endedInvocations.has(parentToolCallId), duplicate,
      entries: this.#entries.size, inFlight: this.#inFlightCount(),
      maxEntries: this.#maxEntries, maxConcurrent: this.#maxConcurrent,
    });
    const refuse = (plan: ReturnType<typeof admitSpeculation>) => {
      if (plan === "skip") this.#accounting.record("skipped");
      return false;
    };
    // Do not hash caller arguments if capacity already refuses the request.
    const room = admission(false);
    if (room !== "admit") return refuse(room);
    const key = FabricSpeculationStore.key(parentToolCallId, ref, preparedArgs, bindingToken);
    const plan = admission(this.#entries.has(key));
    if (plan !== "admit") return refuse(plan);
    const controller = new AbortController();
    const entry: SpeculationEntry = {
      parentToolCallId, ref, birthEpoch: this.epoch, createdAt: Date.now(), active: true,
      controller, freshness, replay,
      promise: Promise.resolve().then(() => execute(controller.signal)).catch(() => {
        entry.failed = true;
        return undefined;
      }),
      failed: false,
    };
    // A synchronous executor throw becomes a settled failed entry, not a launch throw.
    this.#entries.set(key, entry);
    this.#accounting.record("launched");
    return true;
  }

  async tryServe(parentToolCallId: string, ref: string, preparedArgs: Record<string, unknown>, bindingToken: string): Promise<FabricSpeculationServeResult> {
    const key = FabricSpeculationStore.key(parentToolCallId, ref, preparedArgs, bindingToken);
    const entry = this.#entries.get(key);
    if (!entry || entry.parentToolCallId !== parentToolCallId) return { hit: false, reason: "absent" };
    this.#entries.delete(key);
    // Reserve before any await. The shared compiled token law forbids replay.
    const taken = consume(entry.active);
    entry.active = taken.active;
    if (!taken.released) return { hit: false, reason: "absent" };
    const before = this.#check(entry, false);
    if (before !== "ready") return this.#refuse(entry, before);
    this.#serving.add(entry);
    let value: unknown;
    try { value = await entry.promise; }
    finally { this.#serving.delete(entry); }
    const after = this.#check(entry, true);
    if (after !== "ready") return this.#refuse(entry, after);
    this.#accounting.record("served");
    return { hit: true, value, replay: entry.replay };
  }

  /** Freshness callbacks remain lazy, after epoch/expiry guards at each checkpoint. */
  #check(entry: SpeculationEntry, settled: boolean): ReturnType<typeof checkSpeculation> {
    const observation = {
      settled, aborted: entry.controller.signal.aborted, now: Date.now(),
      createdAt: entry.createdAt, ttl: this.#entryTtlMs,
      birthEpoch: entry.birthEpoch, epoch: this.epoch, fresh: true, failed: entry.failed,
    };
    // Provider failure follows freshness, so do not short-circuit its callback.
    const outcome = checkSpeculation({ ...observation, failed: false });
    if (outcome !== "ready") return outcome;
    return checkSpeculation({ ...observation, fresh: entry.freshness ? entry.freshness() : true });
  }

  #refuse(entry: SpeculationEntry, reason: Exclude<ReturnType<typeof checkSpeculation>, "ready">): FabricSpeculationServeResult {
    const event = { absent: "wasted", epoch: "epochInvalidated", freshness: "freshnessInvalidated", failed: "failed" } as const;
    this.#accounting.record(event[reason]);
    // Staleness invalidates the signal at either checkpoint. A current
    // provider failure has already settled and historically does not abort.
    if (reason !== "failed") entry.controller.abort(ended(`refused (${reason})`));
    return { hit: false, reason };
  }

  /** Execution for this tool call finished: everything unserved is waste. */
  onInvocationEnd(parentToolCallId: string): void {
    this.#endedInvocations.add(parentToolCallId);
    for (const entry of this.#serving) {
      if (entry.parentToolCallId === parentToolCallId) entry.controller.abort(ended("ended with its invocation"));
    }
    for (const [key, entry] of this.#entries) {
      if (entry.parentToolCallId !== parentToolCallId) continue;
      entry.controller.abort(ended("ended with its invocation"));
      this.#entries.delete(key);
      this.#accounting.record("wasted");
    }
  }

  /** Turn backstop: speculation never outlives a turn. */
  reset(): void {
    this.bumpEpoch();
    for (const entry of this.#serving) entry.controller.abort(ended("reset"));
    for (const entry of this.#entries.values()) entry.controller.abort(ended("reset"));
    this.#entries.clear();
    this.#endedInvocations.clear();
  }

  #inFlightCount(): number {
    let count = 0;
    for (const entry of this.#entries.values()) if (!entry.failed) count += 1;
    return count;
  }

  #sweepExpired(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (!speculationExpired(now, entry.createdAt, this.#entryTtlMs)) continue;
      entry.controller.abort(ended("expired"));
      this.#entries.delete(key);
      this.#accounting.record("wasted");
    }
  }
}
