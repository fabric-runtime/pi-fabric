import { randomUUID } from "node:crypto";
import type { AgentUsage } from "../agents/types.js";
import type { FabricAgentMessageResult } from "../main-agent.js";
import type {
  FabricInvocationParticipants,
  FabricParticipantHandle,
  FabricParticipantProgress,
  FabricParticipantSettlement,
  FabricParticipantSpec,
} from "../protocol.js";
import type {
  FabricControlAcceptance,
  FabricControlCommand,
  FabricControlPlane,
  FabricControlResult,
} from "./control-plane.js";
import type {
  FabricParticipantCapability,
  FabricParticipantRecord,
  FabricParticipantSource,
} from "./types.js";

export const PROVIDER_PARTICIPANT_PREFIX = "provider:";
/** Owned-work cancellation reason passed to `stop()` when a program ends early. */
export const PROGRAM_CANCELLED_REASON = "program_cancelled";
/** Total bound for the parallel owned-work stop sweep after cancellation. */
export const OWNED_WORK_STOP_TIMEOUT_MS = 5_000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const KIND_PATTERN = /^[a-z][a-z0-9._-]{0,31}$/;
const MAX_LABEL_CHARS = 120;
const MAX_PHASE_CHARS = 64;
const MAX_MESSAGE_CHARS = 500;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_CONTROL_MESSAGE_CHARS = 20_000;
const MAX_ACTIVE = 256;
const MAX_SETTLED = 64;
const SETTLED_STATUSES = new Set(["completed", "failed", "stopped"]);

export type ProviderParticipantStatus = "running" | FabricParticipantSettlement["status"];

export interface ProviderParticipantStopOutcome {
  ref: string;
  outcome: "confirmed" | "unconfirmed";
  /** Why a stop is unconfirmed: the provider declined, threw, or missed the deadline. */
  detail?: "declined" | "error" | "timeout";
}

interface Entry {
  readonly generation: string;
  readonly ref: string;
  readonly provider: string;
  readonly id: string;
  readonly label: string;
  readonly kind: string | undefined;
  readonly detached: boolean;
  readonly invocationId: string;
  readonly spec: FabricParticipantSpec;
  readonly startedAt: number;
  status: ProviderParticipantStatus;
  updatedAt: number;
  finishedAt?: number;
  phase?: string;
  message?: string;
  summary?: string;
  usage?: AgentUsage;
}

export interface ProviderParticipantInfo {
  generation: string;
  ref: string;
  provider: string;
  id: string;
  label: string;
  kind?: string;
  detached: boolean;
  status: ProviderParticipantStatus;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  phase?: string;
  message?: string;
  summary?: string;
  usage?: AgentUsage;
  capabilities: FabricParticipantCapability[];
}

export const isProviderParticipantRef = (value: string): boolean =>
  value.startsWith(PROVIDER_PARTICIPANT_PREFIX);

const boundedText = (value: unknown, field: string, max: number, required = false): string | undefined => {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new TypeError(`Fabric participant ${field} must be a string`);
  const text = value.trim();
  if (required && !text) throw new TypeError(`Fabric participant ${field} must not be empty`);
  if (text.length > max) throw new RangeError(`Fabric participant ${field} exceeds ${max} characters`);
  return text || undefined;
};

const usageFrom = (value: unknown): AgentUsage | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Fabric participant usage must be an object");
  }
  const record = value as Record<string, unknown>;
  const usage: AgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const key of Object.keys(record)) {
    if (!(key in usage)) throw new TypeError(`Unknown Fabric participant usage field: ${key}`);
    const amount = record[key];
    if (amount === undefined) continue;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new RangeError(`Fabric participant usage.${key} must be a non-negative finite number`);
    }
    usage[key as keyof AgentUsage] = amount;
  }
  return usage;
};

const capabilitiesOf = (entry: Entry): FabricParticipantCapability[] =>
  entry.status !== "running"
    ? []
    : [
        ...(entry.spec.steer ? (["steer"] as const) : []),
        ...(entry.spec.followUp ? (["followUp"] as const) : []),
        "stop",
      ];

const activityOf = (entry: Entry): string | undefined => {
  const text = entry.status === "running"
    ? entry.phase && entry.message ? `${entry.phase}: ${entry.message}` : entry.phase ?? entry.message
    : entry.summary;
  return text ? text.slice(0, 160) : undefined;
};

/**
 * Session-owned registry of provider-registered participants. Providers reach
 * it only through the per-invocation `context.participants` view, which binds
 * the provider name, so one provider cannot register or impersonate another's
 * refs. Callbacks run in this process; remote hosts reach them through the
 * participant control plane.
 */
export class ProviderParticipantRegistry {
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<() => void>();

  /** Per-invocation, provider-bound registration view handed to `invoke`. */
  view(provider: string, invocationId: string): FabricInvocationParticipants {
    return Object.freeze({
      register: (spec: FabricParticipantSpec) => this.#register(provider, invocationId, spec),
    });
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  has(ref: string): boolean {
    return this.#entries.has(ref);
  }

  get(ref: string): ProviderParticipantInfo | undefined {
    const entry = this.#entries.get(ref);
    return entry ? this.#info(entry) : undefined;
  }

  list(): ProviderParticipantInfo[] {
    return [...this.#entries.values()].map((entry) => this.#info(entry));
  }

  /** Directory records; the directory stamps owner host and identity on publish. */
  records(rootId: string, ownerHostId: string, ownerIdentityId: string): FabricParticipantRecord[] {
    return [...this.#entries.values()].map((entry) => {
      const activity = activityOf(entry);
      return {
        format: 1,
        id: entry.ref,
        kind: "provider",
        rootId,
        ownerHostId,
        ownerIdentityId,
        parentId: rootId,
        name: entry.label,
        status: entry.status,
        residency: "session",
        provider: entry.provider,
        transport: "host",
        capabilities: capabilitiesOf(entry),
        startedAt: entry.startedAt,
        updatedAt: entry.updatedAt,
        ...(entry.finishedAt !== undefined ? { finishedAt: entry.finishedAt } : {}),
        ...(activity ? { currentTool: activity } : {}),
        ...(entry.usage ? { usage: { ...entry.usage } } : {}),
        controlProtocol: "v1",
      };
    });
  }

  async stop(ref: string, reason = "stopped"): Promise<ProviderParticipantStopOutcome> {
    const entry = this.#require(ref);
    if (entry.status !== "running") throw new Error(`Fabric participant ${ref} is already ${entry.status}`);
    return this.#stop(entry, reason, undefined);
  }

  async deliver(ref: string, operation: "steer" | "followUp", message: string): Promise<void> {
    const entry = this.#require(ref);
    if (entry.status !== "running") throw new Error(`Fabric participant ${ref} is already ${entry.status}`);
    const deliver = entry.spec[operation];
    if (!deliver) throw new Error(`Fabric participant ${ref} does not support ${operation}`);
    const text = boundedText(message, "message", MAX_CONTROL_MESSAGE_CHARS, true)!;
    await deliver.call(entry.spec, text);
  }

  /**
   * Stop every unsettled, non-detached participant registered during the
   * invocation, in parallel, within one shared deadline.
   */
  async cancelInvocation(
    invocationId: string,
    reason = PROGRAM_CANCELLED_REASON,
    timeoutMs = OWNED_WORK_STOP_TIMEOUT_MS,
  ): Promise<ProviderParticipantStopOutcome[]> {
    const owned = [...this.#entries.values()].filter(
      (entry) => entry.invocationId === invocationId && !entry.detached && entry.status === "running",
    );
    if (owned.length === 0) return [];
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
      timer.unref?.();
    });
    try {
      return await Promise.all(owned.map((entry) => this.#stop(entry, reason, deadline)));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Forget a withdrawn provider's participants; their handles become inert. */
  releaseProvider(provider: string): number {
    let released = 0;
    for (const [ref, entry] of this.#entries) {
      if (entry.provider !== provider) continue;
      this.#entries.delete(ref);
      released++;
    }
    if (released > 0) this.#notify();
    return released;
  }

  /** Session shutdown: forget every participant without calling providers. */
  releaseAll(): void {
    const had = this.#entries.size > 0;
    this.#entries.clear();
    if (had) this.#notify();
    this.#listeners.clear();
  }

  #register(provider: string, invocationId: string, spec: FabricParticipantSpec): FabricParticipantHandle {
    if (typeof spec !== "object" || spec === null) throw new TypeError("Fabric participant spec must be an object");
    if (typeof spec.id !== "string" || !ID_PATTERN.test(spec.id)) {
      throw new TypeError("Fabric participant id must match [A-Za-z0-9][A-Za-z0-9._:-]{0,63}");
    }
    const label = boundedText(spec.label, "label", MAX_LABEL_CHARS, true)!;
    if (spec.kind !== undefined && (typeof spec.kind !== "string" || !KIND_PATTERN.test(spec.kind))) {
      throw new TypeError("Fabric participant kind must match [a-z][a-z0-9._-]{0,31}");
    }
    if (spec.detached !== undefined && typeof spec.detached !== "boolean") {
      throw new TypeError("Fabric participant detached must be a boolean");
    }
    if (typeof spec.stop !== "function") throw new TypeError("Fabric participant stop must be a function");
    for (const optional of ["steer", "followUp"] as const) {
      if (spec[optional] !== undefined && typeof spec[optional] !== "function") {
        throw new TypeError(`Fabric participant ${optional} must be a function`);
      }
    }
    const ref = `${PROVIDER_PARTICIPANT_PREFIX}${provider}:${spec.id}`;
    const existing = this.#entries.get(ref);
    if (existing?.status === "running") throw new Error(`Fabric participant ${ref} is already registered`);
    if (existing) this.#entries.delete(ref);
    const active = [...this.#entries.values()].filter((entry) => entry.status === "running").length;
    if (active >= MAX_ACTIVE) throw new Error(`Fabric participant limit reached (${MAX_ACTIVE} active)`);
    const now = Date.now();
    const entry: Entry = {
      generation: randomUUID(),
      ref,
      provider,
      id: spec.id,
      label,
      kind: spec.kind,
      detached: spec.detached === true,
      invocationId,
      // Freeze the callbacks at registration so later spec mutation cannot
      // change what a stop or steer reaches.
      spec: Object.freeze({
        id: spec.id,
        label,
        stop: spec.stop.bind(spec),
        ...(spec.steer ? { steer: spec.steer.bind(spec) } : {}),
        ...(spec.followUp ? { followUp: spec.followUp.bind(spec) } : {}),
      }),
      startedAt: now,
      status: "running",
      updatedAt: now,
    };
    this.#entries.set(ref, entry);
    this.#notify();
    const live = (): boolean => this.#entries.get(ref) === entry;
    return Object.freeze({
      ref,
      update: (progress: FabricParticipantProgress) => {
        if (!live() || entry.status !== "running") return;
        if (typeof progress !== "object" || progress === null) {
          throw new TypeError("Fabric participant progress must be an object");
        }
        const phase = boundedText(progress.phase, "phase", MAX_PHASE_CHARS);
        const message = boundedText(progress.message, "message", MAX_MESSAGE_CHARS);
        const usage = usageFrom(progress.usage);
        if (progress.phase !== undefined) {
          if (phase) entry.phase = phase;
          else delete entry.phase;
        }
        if (progress.message !== undefined) {
          if (message) entry.message = message;
          else delete entry.message;
        }
        if (usage) entry.usage = usage;
        entry.updatedAt = Date.now();
        this.#notify();
      },
      settle: (result: FabricParticipantSettlement) => {
        if (typeof result !== "object" || result === null || !SETTLED_STATUSES.has(result.status)) {
          throw new TypeError('Fabric participant settle status must be "completed", "failed", or "stopped"');
        }
        const summary = boundedText(result.summary, "summary", MAX_SUMMARY_CHARS);
        if (!live() || entry.status !== "running") return;
        this.#settle(entry, result.status, summary);
      },
      dispose: () => {
        if (!live()) return;
        this.#entries.delete(ref);
        this.#notify();
      },
    });
  }

  async #stop(
    entry: Entry,
    reason: string,
    deadline: Promise<"timeout"> | undefined,
  ): Promise<ProviderParticipantStopOutcome> {
    let settled: { confirmed: boolean } | "timeout" | "error";
    try {
      const request = Promise.resolve().then(() => entry.spec.stop(reason));
      settled = await (deadline ? Promise.race([request, deadline]) : request);
    } catch {
      settled = "error";
    }
    if (settled === "timeout" || settled === "error") {
      return { ref: entry.ref, outcome: "unconfirmed", detail: settled };
    }
    if (typeof settled !== "object" || settled === null || settled.confirmed !== true) {
      return { ref: entry.ref, outcome: "unconfirmed", detail: "declined" };
    }
    if (this.#entries.get(entry.ref) === entry && entry.status === "running") {
      this.#settle(entry, "stopped", undefined);
    }
    return { ref: entry.ref, outcome: "confirmed" };
  }

  #settle(entry: Entry, status: FabricParticipantSettlement["status"], summary: string | undefined): void {
    entry.status = status;
    if (summary) entry.summary = summary;
    entry.finishedAt = entry.updatedAt = Date.now();
    const settled = [...this.#entries.values()].filter((candidate) => candidate.status !== "running");
    for (const stale of settled.slice(0, Math.max(0, settled.length - MAX_SETTLED))) {
      this.#entries.delete(stale.ref);
    }
    this.#notify();
  }

  #require(ref: string): Entry {
    const entry = this.#entries.get(ref);
    if (!entry) throw new Error(`Unknown Fabric participant: ${ref}`);
    return entry;
  }

  #info(entry: Entry): ProviderParticipantInfo {
    return {
      generation: entry.generation,
      ref: entry.ref,
      provider: entry.provider,
      id: entry.id,
      label: entry.label,
      ...(entry.kind ? { kind: entry.kind } : {}),
      detached: entry.detached,
      status: entry.status,
      startedAt: entry.startedAt,
      updatedAt: entry.updatedAt,
      ...(entry.finishedAt !== undefined ? { finishedAt: entry.finishedAt } : {}),
      ...(entry.phase ? { phase: entry.phase } : {}),
      ...(entry.message ? { message: entry.message } : {}),
      ...(entry.summary ? { summary: entry.summary } : {}),
      ...(entry.usage ? { usage: { ...entry.usage } } : {}),
      capabilities: capabilitiesOf(entry),
    };
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // Directory refresh is best effort.
      }
    }
  }
}

/**
 * Route `agents.stop/steer/followUp` for a `provider:` ref: local callbacks
 * when this session owns it, otherwise the owner's control plane.
 */
export const controlProviderParticipant = async (
  registry: ProviderParticipantRegistry | undefined,
  directory: Pick<FabricParticipantSource, "get">,
  control: Pick<FabricControlPlane, "request"> | undefined,
  ref: string,
  operation: "stop" | "steer" | "followUp",
  message?: string,
  data?: unknown,
): Promise<ProviderParticipantStopOutcome | FabricAgentMessageResult | FabricControlResult> => {
  if (operation !== "stop" && data !== undefined) {
    throw new Error(`Fabric participant ${ref} does not accept message data`);
  }
  if (registry?.has(ref)) {
    if (operation === "stop") return registry.stop(ref);
    await registry.deliver(ref, operation, message ?? "");
    return { queued: true, messageId: randomUUID(), routed: "local" };
  }
  const participant = directory.get(ref);
  if (!participant || participant.kind !== "provider" || participant.local) {
    throw new Error(`Unknown Fabric participant: ${ref}`);
  }
  if (!participant.capabilities.includes(operation)) {
    throw new Error(`Fabric participant ${ref} does not support ${operation}`);
  }
  if (!control) throw new Error("Fabric control plane is unavailable");
  return control.request(
    participant.ownerHostId,
    participant.id,
    operation,
    {
      ...(operation === "stop" ? {} : { message: message ?? "" }),
      ...(participant.ownerIncarnation ? { ownerIncarnation: participant.ownerIncarnation } : {}),
    },
    participant.ownerIdentityId,
  );
};

/** Owner side of a remote control command aimed at a `provider:` ref. */
export const acceptProviderParticipantControl = async (
  registry: ProviderParticipantRegistry | undefined,
  command: FabricControlCommand,
): Promise<FabricControlAcceptance> => {
  const ref = command.targetId;
  if (!registry?.has(ref)) return { accepted: false, error: `Owner does not control Fabric participant ${ref}` };
  try {
    if (command.operation === "stop") {
      return { accepted: true, messageId: command.commandId, result: await registry.stop(ref) };
    }
    if (command.operation === "steer" || command.operation === "followUp") {
      await registry.deliver(ref, command.operation, command.message ?? "");
      return { accepted: true, messageId: command.commandId };
    }
    return { accepted: false, error: `Fabric participant ${ref} does not support ${command.operation}` };
  } catch (error) {
    return { accepted: false, error: error instanceof Error ? error.message : String(error) };
  }
};
