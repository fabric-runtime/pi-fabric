import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { writeJsonAtomic } from "../core/atomic-write.js";
import { validateAgentResult } from "./result.js";
import type {
  FabricHostedLiveness,
  FabricHostedReporter,
  FabricHostedRunContext,
  FabricHostedRunner,
  FabricRunStopReason,
  FabricRunnerQuestion,
} from "./runner-registry.js";
import type {
  AgentChildQuestionResponse,
  AgentRunRecord,
  AgentTransportHandle,
  AgentUsage,
} from "./types.js";

/** Persisted beside status.json; recovery rebuilds the run from it. */
export const HOSTED_STATE_FILE = "hosted.json";
const MAX_HOSTED_LOCATOR_BYTES = 8 * 1024;
const ADAPTER_CALL_TIMEOUT_MS = 30_000;
const LIVENESS_TIMEOUT_MS = 10_000;
const LIVENESS_POLL_MS = 1_000;
const MAX_TEXT_CHARS = 100_000;
const MAX_ERROR_CHARS = 20_000;
const MAX_TOOL_CHARS = 200;
const MAX_TRANSCRIPT_EVENT_BYTES = 64 * 1024;
const MAX_STRUCTURED_BYTES = 1024 * 1024;
const MAX_QUESTION_TITLE_CHARS = 1_000;
const MAX_QUESTION_TEXT_CHARS = 8_000;
const MAX_QUESTION_OPTIONS = 64;
const MAX_QUESTION_TIMEOUT_MS = 86_400_000;
const LIVENESS_STATES = new Set<FabricHostedLiveness>([
  "running",
  "sleeping",
  "settled",
  "cancelled",
  "interrupted",
  "unknown",
]);
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;
const TERMINAL = new Set(["completed", "failed", "stopped", "timed_out"]);

export interface HostedRunState {
  version: 1;
  runner: string;
  locator: unknown;
  context: FabricHostedRunContext;
}

export interface HostedRunFiles {
  statusFile: string;
  lifecycleFile: string;
  logFile: string;
  stateFile: string;
}

export interface HostedRunHooks {
  /** Route a dialog through the parent (UI or decision); absent when childQuestions is not "route". */
  ask?: (question: Record<string, unknown>) => Promise<AgentChildQuestionResponse>;
  questionTimeoutMs: number;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const withTimeout = async <T>(work: () => T | Promise<T>, label: string, timeoutMs = ADAPTER_CALL_TIMEOUT_MS): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** A JSON round trip of at most 8 KiB, or a clear refusal. */
const checkedLocator = (runner: string, value: unknown): unknown => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`Fabric runner ${runner} returned a locator that is not JSON: ${message(error)}`);
  }
  if (serialized === undefined) throw new Error(`Fabric runner ${runner} returned no locator`);
  if (Buffer.byteLength(serialized) > MAX_HOSTED_LOCATOR_BYTES) {
    throw new Error(`Fabric runner ${runner} returned a locator over ${MAX_HOSTED_LOCATOR_BYTES} bytes`);
  }
  return JSON.parse(serialized) as unknown;
};

export const readHostedRunState = (filePath: string): HostedRunState | undefined => {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<HostedRunState>;
    return value?.version === 1 &&
      typeof value.runner === "string" &&
      typeof value.context === "object" &&
      value.context !== null &&
      typeof value.context.id === "string"
      ? (value as HostedRunState)
      : undefined;
  } catch {
    return undefined;
  }
};

const boundedText = (value: string, max: number): string =>
  value.length <= max ? value : value.slice(-max);

const questionText = (value: unknown, max: number): string | undefined =>
  typeof value === "string" ? value.slice(0, max) : undefined;

/**
 * One adapter-owned run. Fabric spawns no process: this object writes the same
 * status, lifecycle and transcript files a worker would, so the manager's
 * monitor, budgets, dashboard and residency readers need no hosted branch.
 */
export class HostedRun {
  readonly handle: AgentTransportHandle;
  #record: AgentRunRecord;
  /** Settled or detached: adapter reports are ignored from here on. */
  #closed = false;
  /** Stop finished; the monitor must not poll liveness again. */
  #released = false;
  #detached = false;
  #shutdown = false;
  #pendingQuestions = 0;
  #deliveries: Promise<void> = Promise.resolve();
  lastLiveness: FabricHostedLiveness = "running";
  readonly reporter: FabricHostedReporter;

  private constructor(
    readonly adapter: FabricHostedRunner,
    readonly locator: unknown,
    readonly context: FabricHostedRunContext,
    readonly files: HostedRunFiles,
    record: AgentRunRecord,
    readonly hooks: HostedRunHooks,
  ) {
    this.#record = record;
    this.handle = {
      kind: "hosted",
      livenessPollIntervalMs: LIVENESS_POLL_MS,
      isAlive: () => this.#isAlive(),
      stop: () => this.stop(),
    };
    this.reporter = {
      progress: (update) => this.#progress(update),
      usage: (total) => this.#usage(total),
      transcript: (event) => this.#transcript(event),
      question: (question) => this.#question(question),
      finish: (result) => this.#finish(result),
      fail: (failure) => this.#fail(failure),
    };
  }

  /** `prepare`, then persist the locator in the run record before anything is submitted. */
  static async prepare(
    adapter: FabricHostedRunner,
    context: FabricHostedRunContext,
    files: HostedRunFiles,
    record: AgentRunRecord,
    hooks: HostedRunHooks,
  ): Promise<HostedRun> {
    const locator = checkedLocator(adapter.id, await withTimeout(() => adapter.prepare(context), `${adapter.id}.prepare`));
    const run = new HostedRun(adapter, locator, context, files, { ...record, hosted: { locator } }, hooks);
    const state: HostedRunState = { version: 1, runner: adapter.id, locator, context };
    writeJsonAtomic(files.stateFile, state, { space: 2 });
    run.#write();
    return run;
  }

  /** Rebuild a run persisted by `prepare`; never calls `start`. */
  static recover(
    adapter: FabricHostedRunner,
    state: HostedRunState,
    files: HostedRunFiles,
    record: AgentRunRecord,
    hooks: HostedRunHooks,
  ): HostedRun {
    return new HostedRun(adapter, state.locator, state.context, files, { ...record, hosted: { locator: state.locator } }, hooks);
  }

  get record(): AgentRunRecord {
    return this.#record;
  }

  get terminal(): boolean {
    return TERMINAL.has(this.#record.status);
  }

  /** Submit once. A failed submission may still have started remote work. */
  async start(): Promise<void> {
    try {
      await withTimeout(() => this.adapter.start(this.locator, this.context, this.reporter), `${this.adapter.id}.start`);
    } catch (error) {
      this.#settle({ status: "failed", error: `Hosted runner start failed: ${message(error)}`, outcome: "indeterminate" });
    }
  }

  /** Re-attach after a restart; an unreachable or interrupted run is indeterminate. */
  async attach(): Promise<void> {
    try {
      await withTimeout(() => this.adapter.attach(this.locator, this.context, this.reporter), `${this.adapter.id}.attach`);
    } catch (error) {
      this.#settle({ status: "failed", error: `Hosted runner attach failed: ${message(error)}`, outcome: "indeterminate" });
      return;
    }
    if (this.terminal) return;
    if (!(await this.#isAlive())) this.settleLost();
  }

  /** Terminal record for a run whose adapter reports it gone without a result. */
  settleLost(): AgentRunRecord {
    if (!this.terminal && !this.#detached) {
      if (this.lastLiveness === "cancelled") {
        this.#settle({ status: "stopped", error: "Hosted run was cancelled outside Fabric" });
      } else {
        this.#settle({
          status: "failed",
          error: `Hosted run outcome is indeterminate (liveness: ${this.lastLiveness}); Fabric does not restart hosted runs`,
          outcome: "indeterminate",
        });
      }
    }
    return this.#record;
  }

  async stop(): Promise<void> {
    if (this.#released || this.#closed || this.terminal) return;
    const reason: FabricRunStopReason = Date.now() >= this.context.deadlineAt
      ? "timeout"
      : this.#shutdown ? "shutdown" : "requested";
    let confirmed = false;
    let failure: string | undefined;
    try {
      const result = await withTimeout(() => this.adapter.stop(this.locator, reason), `${this.adapter.id}.stop`);
      confirmed = result?.confirmed === true;
    } catch (error) {
      failure = message(error);
    }
    if (!confirmed && this.adapter.abort) {
      await withTimeout(() => this.adapter.abort!(this.locator, reason), `${this.adapter.id}.abort`).catch(() => undefined);
    }
    this.#released = true;
    if (this.terminal) return;
    const base = reason === "timeout"
      ? `Agent timed out after ${Math.max(0, this.context.deadlineAt - this.#record.startedAt)}ms`
      : "Agent stopped";
    this.#settle({
      status: reason === "timeout" ? "timed_out" : "stopped",
      error: confirmed ? base : `${base}; the hosted runner did not confirm the stop${failure ? `: ${failure}` : ""}`,
      ...(confirmed ? {} : { outcome: "indeterminate" as const }),
    });
  }

  /** The owning session is ending: the next stop carries reason "shutdown". */
  markShutdown(): void {
    this.#shutdown = true;
  }

  /** Settle a prepared run that was never submitted; recovery must not attach to it. */
  abandon(error: string): void {
    this.#settle({ status: "failed", error });
    this.#closed = true;
  }

  /** Keep the remote run alive and stop observing it; recovery re-attaches. */
  detach(): void {
    this.#closed = true;
    this.#released = true;
    this.#detached = true;
  }

  get detached(): boolean {
    return this.#detached;
  }

  close(): void {
    this.#closed = true;
  }

  deliver(kind: "steer" | "followUp", text: string, data?: unknown): string {
    const send = kind === "steer" ? this.adapter.steer : this.adapter.followUp;
    if (!send) throw new Error(`The ${this.adapter.label} runner does not support ${kind}`);
    const messageId = randomUUID();
    // Ordered, adapter-delivered; a failure lands in the run transcript.
    this.#deliveries = this.#deliveries.then(async () => {
      try {
        await withTimeout(() => send(this.locator, text, data), `${this.adapter.id}.${kind}`);
      } catch (error) {
        this.#appendLog({ type: "extension_error", error: `Hosted ${kind} ${messageId} failed: ${message(error)}` });
      }
    });
    return messageId;
  }

  async park(action: "sleep" | "wake"): Promise<void> {
    const call = this.adapter[action];
    if (!this.adapter.capabilities.sleep || !call) {
      throw new Error(`The ${this.adapter.label} runner does not support sleep`);
    }
    if (this.#closed || this.terminal) throw new Error(`Fabric agent ${this.#record.id} already finished`);
    await withTimeout(() => call(this.locator), `${this.adapter.id}.${action}`);
  }

  async #isAlive(): Promise<boolean> {
    if (this.#released || this.#closed || this.terminal) return false;
    let state: FabricHostedLiveness;
    try {
      const value = await withTimeout(() => this.adapter.liveness(this.locator), `${this.adapter.id}.liveness`, LIVENESS_TIMEOUT_MS);
      state = LIVENESS_STATES.has(value) ? value : "unknown";
    } catch {
      state = "unknown";
    }
    this.lastLiveness = state;
    // Sleeping is healthy: the run stays running with a sleeping detail.
    const sleeping = state === "sleeping";
    if (!this.#closed && !this.terminal && sleeping !== (this.#record.sleeping === true)) {
      if (sleeping) this.#record.sleeping = true;
      else delete this.#record.sleeping;
      this.#write();
    }
    return state === "running" || state === "sleeping";
  }

  #progress(update: Parameters<FabricHostedReporter["progress"]>[0]): void {
    if (this.#closed || this.terminal || typeof update !== "object" || update === null) return;
    const record = this.#record;
    if (typeof update.turns === "number" && Number.isFinite(update.turns)) {
      record.turns = Math.max(record.turns, Math.floor(update.turns));
    }
    if (typeof update.toolCalls === "number" && Number.isFinite(update.toolCalls)) {
      record.toolCalls = Math.max(record.toolCalls, Math.floor(update.toolCalls));
    }
    if (update.currentTool === null) delete record.currentTool;
    else if (typeof update.currentTool === "string") record.currentTool = update.currentTool.slice(0, MAX_TOOL_CHARS);
    if (typeof update.text === "string") record.text = boundedText(update.text, MAX_TEXT_CHARS);
    this.#write();
  }

  #usage(total: AgentUsage): void {
    if (this.#closed || this.terminal || typeof total !== "object" || total === null) return;
    const delta = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const field of USAGE_FIELDS) {
      const value = total[field];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
      delta[field] = Math.max(0, value - this.#record.usage[field]);
      this.#record.usage[field] = Math.max(this.#record.usage[field], value);
    }
    if (USAGE_FIELDS.every((field) => delta[field] === 0)) return;
    this.#write();
    const usage = this.#record.usage;
    this.#appendLifecycle("tokens.usage", {
      runId: this.#record.id,
      name: this.#record.name,
      runner: this.#record.runner,
      depth: this.context.depth,
      ...(this.#record.actorId ? { actorId: this.#record.actorId } : {}),
      ...(this.#record.actorName ? { actorName: this.#record.actorName } : {}),
      cumulativeTokens: usage.input + usage.cacheRead + usage.cacheWrite,
      ...delta,
    });
  }

  #transcript(event: Parameters<FabricHostedReporter["transcript"]>[0]): void {
    if (this.#closed || typeof event !== "object" || event === null || typeof event.type !== "string") return;
    this.#appendLog(event);
  }

  async #question(question: FabricRunnerQuestion): Promise<AgentChildQuestionResponse> {
    if (!this.adapter.capabilities.questions) {
      throw new Error(`Fabric runner ${this.adapter.id} did not declare the questions capability`);
    }
    const method = question?.method;
    if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") {
      throw new Error("Hosted runner question method must be select, confirm, input, or editor");
    }
    const options = Array.isArray(question.options)
      ? question.options.filter((option): option is string => typeof option === "string").slice(0, MAX_QUESTION_OPTIONS)
      : undefined;
    if (method === "select" && !options?.length) throw new Error("A select question needs options");
    if (this.#closed || this.terminal || !this.hooks.ask) return { cancelled: true };
    const timeout = Math.min(
      typeof question.timeoutMs === "number" && question.timeoutMs > 0 ? Math.floor(question.timeoutMs) : this.hooks.questionTimeoutMs,
      MAX_QUESTION_TIMEOUT_MS,
    );
    const messageText = questionText(question.message, MAX_QUESTION_TEXT_CHARS);
    const placeholder = questionText(question.placeholder, MAX_QUESTION_TEXT_CHARS);
    const prefill = questionText(question.prefill, MAX_QUESTION_TEXT_CHARS);
    if (this.#pendingQuestions++ === 0) {
      this.#record.blockedOn = { since: Date.now() };
      this.#write();
    }
    try {
      const response = await withTimeout(() => this.hooks.ask!({
        requestId: randomUUID(),
        method,
        title: questionText(question.title, MAX_QUESTION_TITLE_CHARS) ?? "",
        ...(messageText !== undefined ? { message: messageText } : {}),
        ...(options ? { options } : {}),
        ...(placeholder !== undefined ? { placeholder } : {}),
        ...(prefill !== undefined ? { prefill } : {}),
        timeout,
      }), "Hosted runner question", timeout + 1_000).catch((): AgentChildQuestionResponse => ({ cancelled: true }));
      if (method === "confirm") return "confirmed" in response ? response : { cancelled: true };
      if (!("value" in response) || (method === "select" && !options!.includes(response.value))) {
        return { cancelled: true };
      }
      return response;
    } finally {
      if (--this.#pendingQuestions === 0 && !this.#closed && !this.terminal) {
        delete this.#record.blockedOn;
        this.#write();
      }
    }
  }

  #finish(result: Parameters<FabricHostedReporter["finish"]>[0]): void {
    if (this.#closed || this.terminal || typeof result !== "object" || result === null) return;
    const status = result.status === "failed" || result.status === "stopped" ? result.status : "completed";
    const output = typeof result.output === "string" ? result.output : "";
    let value: unknown;
    let truncated: string | undefined;
    if (result.structured !== undefined) {
      try {
        const serialized = JSON.stringify(result.structured);
        if (serialized !== undefined && Buffer.byteLength(serialized) <= MAX_STRUCTURED_BYTES) {
          value = JSON.parse(serialized);
        } else {
          truncated = `structured value was truncated at the ${MAX_STRUCTURED_BYTES}-byte limit`;
        }
      } catch {
        truncated = "structured value could not be serialized as JSON and was truncated";
      }
      if (truncated) value = { fabricTruncated: true };
    }
    const settled: { status: AgentRunRecord["status"]; text: string; value?: unknown; error?: string } = {
      status,
      text: output,
      ...(value !== undefined ? { value } : {}),
      ...(status === "completed" ? {} : { error: output.slice(0, MAX_ERROR_CHARS) || `Hosted run ${status}` }),
    };
    // The same check a Fabric worker applies: a completed run with a schema
    // must return a matching value, or it fails as invalid structured output.
    // A truncated value cannot carry what the schema asks for, so name the cause.
    if (truncated && status === "completed" && this.context.schema) {
      settled.status = "failed";
      settled.error = `Structured agent output was invalid: ${truncated}`;
    } else {
      const fromText = settled.value === undefined;
      validateAgentResult(settled, this.context.schema);
      // A value parsed from the text output gets the same size limit as a
      // structured one, so a large JSON answer is not persisted in full.
      if (fromText && settled.status === "completed" && settled.value !== undefined &&
          Buffer.byteLength(JSON.stringify(settled.value) ?? "") > MAX_STRUCTURED_BYTES) {
        settled.status = "failed";
        settled.value = { fabricTruncated: true };
        settled.error = `Structured agent output was invalid: value parsed from the output was truncated at the ${MAX_STRUCTURED_BYTES}-byte limit`;
      }
    }
    this.#settle(settled);
  }

  #fail(failure: Parameters<FabricHostedReporter["fail"]>[0]): void {
    if (this.#closed || this.terminal) return;
    const error = typeof failure?.error === "string" && failure.error ? failure.error : "Hosted run failed";
    this.#settle({
      status: "failed",
      error,
      ...(typeof failure?.retryable === "boolean" ? { retryable: failure.retryable } : {}),
    });
  }

  #settle(patch: Partial<AgentRunRecord> & { status: AgentRunRecord["status"] }): void {
    if (this.terminal) return;
    const now = Date.now();
    const record: AgentRunRecord = { ...this.#record, ...patch, finishedAt: now };
    if (typeof record.text === "string") record.text = boundedText(record.text, MAX_TEXT_CHARS);
    if (record.error) record.error = record.error.slice(0, MAX_ERROR_CHARS);
    delete record.currentTool;
    delete record.blockedOn;
    delete record.sleeping;
    this.#record = record;
    this.#write();
  }

  #write(): void {
    this.#record.updatedAt = Date.now();
    try {
      writeJsonAtomic(this.files.statusFile, this.#record, { space: 2 });
    } catch {
      // The monitor keeps the last readable record; the next report retries.
    }
  }

  #appendLog(event: unknown): void {
    try {
      const line = JSON.stringify(event);
      if (line === undefined || Buffer.byteLength(line) > MAX_TRANSCRIPT_EVENT_BYTES) return;
      fs.appendFileSync(this.files.logFile, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Transcript logging is best-effort, as in the worker.
    }
  }

  #appendLifecycle(event: string, data: unknown): void {
    try {
      fs.appendFileSync(
        this.files.lifecycleFile,
        `${JSON.stringify({ version: 1, event, occurredAt: Date.now(), data })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      // Lifecycle telemetry is best-effort; the settle gap closes usage.
    }
  }
}
