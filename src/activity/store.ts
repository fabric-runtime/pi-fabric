import { randomUUID } from "node:crypto";
import { headlineArg } from "../core/call-preview.js";
import { providerCallMetadata } from "../core/call-presentation.js";
import type { FabricInvocationActivityUpdate } from "../protocol.js";
import type {
  FabricActivityCall,
  FabricActivityEventInput,
  FabricActivityItem,
  FabricActivityItemInput,
  FabricActivityKind,
  FabricActivityMetrics,
  FabricActivityPhase,
  FabricActivityRun,
  FabricActivityStatus,
  FabricPhaseInput,
  FabricRunDisplay,
} from "./types.js";

const MAX_RUNS = 24;
const MAX_CALLS = 1_000;
const MAX_ITEMS = 1_000;
const MAX_EVENTS = 200;
const MAX_NAME_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_DETAIL_CHARS = 1_000;
const MAX_DATA_CHARS = 8_000;
const MAX_CALL_PAYLOAD_CHARS = 64_000;
const MAX_CALL_SUMMARY_CHARS = 120;

const terminalStatuses = new Set<FabricActivityStatus>([
  "completed",
  "failed",
  "stopped",
]);

const cleanText = (value: unknown, maxChars: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ").trim();
  if (!text) return undefined;
  return text.slice(0, maxChars);
};

export const WORKFLOW_ITEM_ID_MAX_CHARS = 128;
const WORKFLOW_ITEM_ID_PATTERN = /^[A-Za-z0-9._:/-]+$/;

/** Stable `workflow.item` id grammar (kept here so the store stays off the lazy workflow-items module). */
export const isWorkflowItemId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= WORKFLOW_ITEM_ID_MAX_CHARS &&
  WORKFLOW_ITEM_ID_PATTERN.test(value);

const cleanId = (value: unknown, fallback: string): string => {
  const text = cleanText(value, 160);
  if (!text) return fallback;
  const safe = text.replace(/[^a-zA-Z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || fallback;
};

const boundedData = (value: unknown, maxChars = MAX_DATA_CHARS): unknown => {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value, (_key, nested) =>
      typeof nested === "bigint" ? String(nested) : nested,
    );
    if (serialized === undefined) return undefined;
    if (serialized.length <= maxChars) return JSON.parse(serialized) as unknown;
    return {
      fabricTruncated: true,
      originalChars: serialized.length,
      preview: serialized.slice(0, Math.max(1, maxChars - 100)),
    };
  } catch {
    return cleanText(String(value), maxChars);
  }
};

const kindForRef = (ref: string): FabricActivityKind => {
  if (ref.startsWith("agents.")) {
    return ["agents.create", "agents.ask", "agents.tell", "agents.actorStatus"].includes(ref)
      ? "actor"
      : "agent";
  }
  if (ref.startsWith("mcp.")) return "mcp";
  if (ref.startsWith("extensions.")) return "extension";
  if (ref.startsWith("mesh.")) return ref === "mesh.put" ? "task" : "mesh";
  return "tool";
};

const summarizeCallResult = (result: unknown): string | undefined => {
  let text: string | undefined;
  if (typeof result === "string") text = result;
  else if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (typeof record.output === "string") text = record.output;
    else if (typeof record.content === "string") text = record.content;
    else if (typeof record.text === "string") text = record.text;
  }
  if (!text) return undefined;
  return cleanText(text.replace(/\s+/g, " "), MAX_CALL_SUMMARY_CHARS);
};

const labelForCall = (ref: string, args: Record<string, unknown>): string => {
  const metadata = providerCallMetadata(ref, args);
  if (metadata) return metadata.detail ? `${metadata.title} · ${metadata.detail}` : metadata.title;
  const explicit =
    cleanText(args.label, MAX_NAME_CHARS) ??
    cleanText(args.name, MAX_NAME_CHARS) ??
    cleanText(args.title, MAX_NAME_CHARS);
  if (explicit) return explicit;

  const target = headlineArg(args, MAX_NAME_CHARS);
  return target ? `${ref} · ${target}` : ref;
};

// Providers report metrics; NaN or Infinity must not reach the totals.
const finiteCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;

const metricsFrom = (value: unknown): FabricActivityMetrics | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const usage =
    typeof record.usage === "object" && record.usage !== null && !Array.isArray(record.usage)
      ? (record.usage as Record<string, unknown>)
      : undefined;
  const input = finiteCount(usage?.input) ?? 0;
  const output = finiteCount(usage?.output) ?? 0;
  const tokens = input + output;
  const toolCalls = finiteCount(record.toolCalls);
  const cost = finiteCount(usage?.cost);
  if (tokens <= 0 && toolCalls === undefined && cost === undefined) return undefined;
  return {
    ...(tokens > 0 ? { tokens } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
};

const resultStatus = (value: unknown): "failed" | "stopped" | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const status = (value as Record<string, unknown>).status;
  if (status === "stopped") return "stopped";
  return status === "failed" || status === "timed_out" ? "failed" : undefined;
};

// Store payloads are bounded JSON values. Freeze copies, never provider objects.
const freezeProjection = (value: unknown): void => {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (current === null || typeof current !== "object" || Object.isFrozen(current)) continue;
    Object.freeze(current);
    for (const child of Object.values(current)) pending.push(child);
  }
};

const createRowProjection = (detailed: boolean, revisions: WeakMap<object, number>) => {
  const cache = new WeakMap<object, {
    source: Record<string, unknown>;
    value: Record<string, unknown>;
    revision: number;
  }>();
  return <T extends object>(row: T): T => {
    const revision = revisions.get(row) ?? 0;
    const previous = cache.get(row);
    if (previous?.revision === revision) return previous.value as T;
    const source = { ...row } as Record<string, unknown>;
    if (!detailed) {
      delete source.args;
      delete source.result;
      delete source.preview;
      delete source.data;
    }
    const keys = Object.keys(source);
    if (previous && keys.length === Object.keys(previous.source).length &&
      keys.every((key) => Object.hasOwn(previous.source, key) &&
        Object.is(source[key], previous.source[key]))) {
      previous.revision = revision;
      return previous.value as T;
    }
    const value: Record<string, unknown> = {};
    for (const key of keys) {
      value[key] = previous && Object.hasOwn(previous.source, key) &&
        Object.is(source[key], previous.source[key])
        ? previous.value[key] : structuredClone(source[key]);
      freezeProjection(value[key]);
    }
    Object.freeze(value);
    cache.set(row, { source, value, revision });
    return value as T;
  };
};

export class FabricActivityStore {
  readonly #runs = new Map<string, FabricActivityRun>();
  readonly #callIndex = new Map<string, Map<string, FabricActivityCall>>();
  readonly #listeners = new Set<() => void>();
  #revision = 0;
  readonly #runRevisions = new WeakMap<FabricActivityRun, number>();
  readonly #rowRevisions = new WeakMap<object, number>();

  revision(): number {
    return this.#revision;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  reset(): void {
    if (this.#runs.size === 0) return;
    this.#runs.clear();
    this.#callIndex.clear();
    this.#emit();
  }

  start(id: string, display: FabricRunDisplay = {}, nameHint?: string): FabricActivityRun {
    const now = Date.now();
    const name =
      cleanText(display.name, MAX_NAME_CHARS) ??
      cleanText(nameHint, MAX_NAME_CHARS) ??
      "Fabric program";
    const description = cleanText(display.description, MAX_DESCRIPTION_CHARS);
    const run: FabricActivityRun = {
      id,
      name,
      status: "running",
      phases: [],
      calls: [],
      items: [],
      events: [],
      startedAt: now,
      updatedAt: now,
      ...(description ? { description } : {}),
    };
    this.#runs.delete(id);
    this.#runs.set(id, run);
    this.#callIndex.set(id, new Map());
    this.#prune();
    this.#emit(run);
    return structuredClone(run);
  }

  resume(runId: string): void {
    const run = this.#require(runId);
    run.status = "running";
    run.updatedAt = Date.now();
    delete run.finishedAt;
    delete run.error;
    this.#emit(run);
  }

  configure(runId: string, display: FabricRunDisplay): FabricActivityRun {
    const run = this.#require(runId);
    const name = cleanText(display.name, MAX_NAME_CHARS);
    const description = cleanText(display.description, MAX_DESCRIPTION_CHARS);
    if (name) run.name = name;
    if (description) run.description = description;
    run.updatedAt = Date.now();
    this.#emit(run);
    return structuredClone(run);
  }

  phase(runId: string, input: FabricPhaseInput): FabricActivityPhase {
    const run = this.#require(runId);
    const name = cleanText(input.name, MAX_NAME_CHARS);
    if (!name) throw new Error("Workflow phase name must not be empty");
    const requestedId = cleanId(input.id, cleanId(name.toLowerCase(), `phase-${run.phases.length + 1}`));
    let phase = run.phases.find(
      (candidate) => candidate.id === requestedId || (!input.id && candidate.name === name),
    );
    const now = Date.now();

    if (run.currentPhaseId && run.currentPhaseId !== phase?.id) {
      const previous = run.phases.find((candidate) => candidate.id === run.currentPhaseId);
      if (previous?.status === "running") {
        previous.status = "completed";
        previous.updatedAt = now;
        previous.finishedAt = now;
      }
    }

    if (!phase) {
      let id = requestedId;
      let suffix = 2;
      while (run.phases.some((candidate) => candidate.id === id)) id = `${requestedId}-${suffix++}`;
      const description = cleanText(input.description, MAX_DESCRIPTION_CHARS);
      const total =
        typeof input.total === "number" && Number.isFinite(input.total)
          ? Math.max(0, Math.floor(input.total))
          : undefined;
      phase = {
        id,
        name,
        status: "running",
        startedAt: now,
        updatedAt: now,
        ...(description ? { description } : {}),
        ...(total !== undefined ? { total } : {}),
      };
      run.phases.push(phase);
    } else {
      phase.name = name;
      phase.status = "running";
      phase.updatedAt = now;
      delete phase.finishedAt;
      const description = cleanText(input.description, MAX_DESCRIPTION_CHARS);
      if (description) phase.description = description;
      if (typeof input.total === "number" && Number.isFinite(input.total)) {
        phase.total = Math.max(0, Math.floor(input.total));
      }
    }

    run.currentPhaseId = phase.id;
    run.updatedAt = now;
    if (run.name === "Fabric program" && run.phases.length === 1) run.name = name;
    this.#emit(run, run.phases);
    return structuredClone(phase);
  }

  upsertItem(runId: string, input: FabricActivityItemInput): FabricActivityItem {
    const run = this.#require(runId);
    // Stable workflow item ids (validated by the execution bridge) stay verbatim.
    const id = isWorkflowItemId(input.id) ? input.id : cleanId(input.id, `item-${run.items.length + 1}`);
    const label = cleanText(input.label, MAX_NAME_CHARS);
    if (!label) throw new Error("Workflow activity item label must not be empty");
    const now = Date.now();
    let item = run.items.find((candidate) => candidate.id === id);
    // An update that names no status keeps the item's current one.
    const status = input.status ?? item?.status ?? "running";
    const phaseId =
      input.phase !== undefined
        ? this.#resolvePhaseId(run, input.phase)
        : item?.phaseId ?? run.currentPhaseId;
    const detail = cleanText(input.detail, MAX_DETAIL_CHARS);
    const current = cleanText(input.current, MAX_DETAIL_CHARS);
    const total =
      typeof input.total === "number" && Number.isFinite(input.total)
        ? Math.max(0, Math.floor(input.total))
        : undefined;
    const completed =
      typeof input.completed === "number" && Number.isFinite(input.completed)
        ? Math.max(0, Math.floor(input.completed))
        : undefined;
    const data = boundedData(input.data);

    if (!item) {
      if (run.items.length >= MAX_ITEMS) run.items.splice(0, run.items.length - MAX_ITEMS + 1);
      item = {
        id,
        label,
        status,
        kind: input.kind ?? "custom",
        createdAt: now,
        updatedAt: now,
        ...(phaseId ? { phaseId } : {}),
        ...(detail ? { detail } : {}),
        ...(current ? { current } : {}),
        ...(total !== undefined ? { total } : {}),
        ...(completed !== undefined ? { completed } : {}),
        ...(data !== undefined ? { data } : {}),
        ...(terminalStatuses.has(status) ? { finishedAt: now } : {}),
      };
      run.items.push(item);
    } else {
      item.label = label;
      item.status = status;
      item.kind = input.kind ?? item.kind;
      item.updatedAt = now;
      if (phaseId) item.phaseId = phaseId;
      if (detail) item.detail = detail;
      if (current) item.current = current;
      if (total !== undefined) item.total = total;
      if (completed !== undefined) item.completed = completed;
      if (data !== undefined) item.data = data;
      if (terminalStatuses.has(status)) item.finishedAt = now;
      else delete item.finishedAt;
    }

    run.updatedAt = now;
    this.#emit(run, item);
    return structuredClone(item);
  }

  event(runId: string, input: FabricActivityEventInput): void {
    const run = this.#require(runId);
    const message = cleanText(input.message, MAX_DETAIL_CHARS);
    if (!message) throw new Error("Workflow activity event message must not be empty");
    const data = boundedData(input.data);
    run.events.push({
      id: randomUUID(),
      message,
      level: input.level ?? "info",
      createdAt: Date.now(),
      ...(data !== undefined ? { data } : {}),
    });
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
    run.updatedAt = Date.now();
    this.#emit(run, run.events.at(-1));
  }

  // Streaming providers may report lifecycle events after session teardown resets
  // the store. Call tracking is best-effort, so stale events must be ignored.
  beginCall(
    runId: string,
    input: { callId: string; ref: string; args: Record<string, unknown> },
  ): void {
    const run = this.#runs.get(runId);
    if (!run) return;
    const now = Date.now();
    const index = this.#callIndex.get(runId) ?? new Map<string, FabricActivityCall>();
    this.#callIndex.set(runId, index);
    const existing = index.get(input.callId);
    if (existing) {
      existing.ref = input.ref;
      existing.label = labelForCall(input.ref, input.args);
      existing.kind = kindForRef(input.ref);
      existing.status = "running";
      existing.args = boundedData(
        input.args,
        MAX_CALL_PAYLOAD_CHARS,
      ) as Record<string, unknown>;
      existing.updatedAt = now;
      delete existing.finishedAt;
      delete existing.result;
      delete existing.error;
      delete existing.detail;
      delete existing.progress;
      run.updatedAt = now;
      this.#emit(run, existing);
      return;
    }
    if (run.calls.length >= MAX_CALLS) {
      const removed = run.calls.splice(0, run.calls.length - MAX_CALLS + 1);
      for (const call of removed) index.delete(call.id);
    }
    const call: FabricActivityCall = {
      id: input.callId,
      ref: input.ref,
      label: labelForCall(input.ref, input.args),
      kind: kindForRef(input.ref),
      status: "running",
      args: boundedData(input.args, MAX_CALL_PAYLOAD_CHARS) as Record<string, unknown>,
      ...(run.currentPhaseId ? { phaseId: run.currentPhaseId } : {}),
      startedAt: now,
      updatedAt: now,
    };
    run.calls.push(call);
    index.set(call.id, call);
    run.updatedAt = now;
    this.#emit(run, call);
  }

  updateCallArgs(runId: string, callId: string, args: Record<string, unknown>): void {
    const run = this.#runs.get(runId);
    if (!run) return;
    const call = this.#callIndex.get(runId)?.get(callId);
    if (!call) return;
    call.args = boundedData(args, MAX_CALL_PAYLOAD_CHARS) as Record<string, unknown>;
    call.label = labelForCall(call.ref, args);
    call.updatedAt = Date.now();
    run.updatedAt = call.updatedAt;
    this.#emit(run, call);
  }

  updateCall(runId: string, callId: string, update: FabricInvocationActivityUpdate): void {
    const run = this.#runs.get(runId);
    if (!run) return;
    const call = this.#callIndex.get(runId)?.get(callId);
    if (!call) return;
    const before = { progress: call.progress, entityId: call.entityId, entityKind: call.entityKind,
      label: call.label, metrics: call.metrics };
    const now = Date.now();
    if (update.type === "progress") {
      const message = cleanText(update.message, MAX_DETAIL_CHARS);
      if (message) call.progress = message;
    } else if (update.type === "entity") {
      call.entityId = cleanId(update.id, update.id.slice(0, 160));
      call.entityKind = update.kind;
      const name = cleanText(update.name, MAX_NAME_CHARS);
      if (name) call.label = name;
    } else if (update.type === "metrics") {
      const tokens = finiteCount(update.tokens);
      const toolCalls = finiteCount(update.toolCalls);
      const cost = finiteCount(update.cost);
      call.metrics = {
        ...(call.metrics ?? {}),
        ...(tokens !== undefined ? { tokens } : {}),
        ...(toolCalls !== undefined ? { toolCalls } : {}),
        ...(cost !== undefined ? { cost } : {}),
      };
    }
    if (before.progress === call.progress && before.entityId === call.entityId &&
      before.entityKind === call.entityKind && before.label === call.label &&
      Object.is(before.metrics?.tokens, call.metrics?.tokens) &&
      Object.is(before.metrics?.toolCalls, call.metrics?.toolCalls) &&
      Object.is(before.metrics?.cost, call.metrics?.cost)) {
      if (before.metrics) call.metrics = before.metrics;
      else delete call.metrics;
      return;
    }
    call.updatedAt = now;
    run.updatedAt = now;
    this.#emit(run, call);
  }

  finishCall(
    runId: string,
    callId: string,
    input: { success: boolean; result?: unknown; preview?: unknown; error?: string },
  ): void {
    const run = this.#runs.get(runId);
    if (!run) return;
    const call = this.#callIndex.get(runId)?.get(callId);
    if (!call) return;
    const now = Date.now();
    const reported = resultStatus(input.result);
    call.status = !input.success ? "failed" : reported ?? "completed";
    call.updatedAt = now;
    call.finishedAt = now;
    const error = cleanText(input.error, MAX_DETAIL_CHARS);
    if (error) call.error = error;
    if (input.result !== undefined) {
      call.result = boundedData(input.result, MAX_CALL_PAYLOAD_CHARS);
    }
    if (input.preview !== undefined) {
      call.preview = boundedData(input.preview, MAX_CALL_PAYLOAD_CHARS);
    }
    const metrics = metricsFrom(input.result);
    if (metrics) call.metrics = { ...(call.metrics ?? {}), ...metrics };
    if (call.status === "completed") {
      const detail = summarizeCallResult(input.result);
      if (detail) call.detail = detail;
    }
    if (typeof input.result === "object" && input.result !== null && !Array.isArray(input.result)) {
      const record = input.result as Record<string, unknown>;
      if (typeof record.id === "string") call.entityId = cleanId(record.id, record.id.slice(0, 160));
      if (call.kind === "agent") call.entityKind = "agent";
      if (call.kind === "actor") call.entityKind = "actor";
      if (!error && typeof record.error === "string") {
        const resultError = cleanText(record.error, MAX_DETAIL_CHARS);
        if (resultError) call.error = resultError;
      }
    }
    run.updatedAt = now;
    this.#emit(run, call);
  }

  /** `cancelled` comes from the caller's abort signal, never from error text. */
  finish(runId: string, success: boolean, error?: string, cancelled = false): void {
    const run = this.#runs.get(runId);
    if (!run || run.status !== "running") return;
    const now = Date.now();
    run.status = success ? "completed" : cancelled ? "cancelled" : "failed";
    run.updatedAt = now;
    run.finishedAt = now;
    const cleanError = cleanText(error, MAX_DETAIL_CHARS);
    if (cleanError) run.error = cleanError;

    for (const phase of run.phases) {
      if (phase.status !== "running") continue;
      phase.status = success ? "completed" : "failed";
      phase.updatedAt = now;
      phase.finishedAt = now;
    }
    for (const call of run.calls) {
      if (call.status !== "running") continue;
      call.status = success ? "completed" : "failed";
      call.updatedAt = now;
      call.finishedAt = now;
    }
    for (const item of run.items) {
      if (item.status !== "running") continue;
      item.status = success ? "completed" : "failed";
      item.updatedAt = now;
      item.finishedAt = now;
    }
    this.#emit(run, [...run.phases, ...run.calls, ...run.items]);
  }

  // Reader-local, weakly keyed projections never own execution state. Switching
  // detail mode drops the previous cache rather than retaining both payload tiers.
  createRunView(): (detailed?: boolean) => FabricActivityRun[] {
    let detailed = false;
    let revision = -1;
    let ordered: FabricActivityRun[] = [];
    let runs = new WeakMap<FabricActivityRun, { revision: number; value: FabricActivityRun }>();
    let rows = createRowProjection(false, this.#rowRevisions);
    return (nextDetailed = false) => {
      if (detailed !== nextDetailed) {
        detailed = nextDetailed;
        runs = new WeakMap();
        rows = createRowProjection(detailed, this.#rowRevisions);
        revision = -1;
      }
      if (revision !== this.#revision) {
        ordered = this.#orderedRuns().map((run) => {
          const runRevision = this.#runRevisions.get(run) ?? 0;
          const cached = runs.get(run);
          if (cached?.revision === runRevision) return cached.value;
          const value: FabricActivityRun = {
            ...run,
            phases: Object.freeze(run.phases.map(rows)) as FabricActivityPhase[],
            calls: Object.freeze(run.calls.map(rows)) as FabricActivityCall[],
            items: Object.freeze(run.items.map(rows)) as FabricActivityItem[],
            events: Object.freeze(run.events.map(rows)) as FabricActivityRun["events"],
          };
          Object.freeze(value);
          runs.set(run, { revision: runRevision, value });
          return value;
        });
        revision = this.#revision;
      }
      // The outer list remains independently sortable; its contents are read-only.
      return ordered.slice();
    };
  }

  runs(): FabricActivityRun[] {
    return this.#orderedRuns().map((run) => structuredClone(run));
  }

  // Ordered, isolated copies with per-call payloads (args/result/preview, item
  // and event data) stripped. The UI refreshes at up to 10 Hz while a run
  // streams; copying 1,000 calls with bounded-but-large payloads every tick
  // stalls input. The dashboard's detail views still use runs().
  runSummaries(): FabricActivityRun[] {
    return this.#orderedRuns().map(leanRun);
  }

  get(id: string): FabricActivityRun | undefined {
    const run = this.#runs.get(id);
    return run ? structuredClone(run) : undefined;
  }

  #resolvePhaseId(run: FabricActivityRun, phase: string | undefined): string | undefined {
    if (!phase) return run.currentPhaseId;
    return run.phases.find((candidate) => candidate.id === phase || candidate.name === phase)?.id;
  }

  #require(id: string): FabricActivityRun {
    const run = this.#runs.get(id);
    if (!run) throw new Error(`Unknown Fabric activity run: ${id}`);
    return run;
  }

  #orderedRuns(): FabricActivityRun[] {
    return [...this.#runs.values()].sort((left, right) => {
      if (left.status === "running" && right.status !== "running") return -1;
      if (right.status === "running" && left.status !== "running") return 1;
      return right.updatedAt - left.updatedAt;
    });
  }

  #prune(): void {
    if (this.#runs.size <= MAX_RUNS) return;
    const removable = [...this.#runs.values()]
      .filter((run) => run.status !== "running")
      .sort((left, right) => left.updatedAt - right.updatedAt);
    while (this.#runs.size > MAX_RUNS && removable.length > 0) {
      const run = removable.shift();
      if (!run) break;
      this.#runs.delete(run.id);
      this.#callIndex.delete(run.id);
    }
  }

  #emit(run?: FabricActivityRun, changed?: object): void {
    this.#revision++;
    if (run) this.#runRevisions.set(run, this.#revision);
    if (Array.isArray(changed)) {
      for (const row of changed) this.#rowRevisions.set(row, this.#revision);
    } else if (changed) this.#rowRevisions.set(changed, this.#revision);
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch { /* a listener throwing must not break the others */ }
    }
  }
}

// Payload-free copy: every remaining field is a scalar except metrics, which
// is shallow-copied so callers can never mutate store state through it.
const leanRun = (run: FabricActivityRun): FabricActivityRun => ({
  id: run.id,
  name: run.name,
  ...(run.description ? { description: run.description } : {}),
  status: run.status,
  phases: run.phases.map((phase) => ({ ...phase })),
  calls: run.calls.map(({ args: _args, result: _result, preview: _preview, ...call }) => ({
    ...call,
    ...(call.metrics ? { metrics: { ...call.metrics } } : {}),
  })),
  items: run.items.map(({ data: _data, ...item }) => item),
  events: run.events.map(({ data: _data, ...event }) => event),
  ...(run.currentPhaseId ? { currentPhaseId: run.currentPhaseId } : {}),
  startedAt: run.startedAt,
  updatedAt: run.updatedAt,
  ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
  ...(run.error ? { error: run.error } : {}),
});
