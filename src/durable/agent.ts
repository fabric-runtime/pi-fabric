import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { Agent, runToolCall, type AgentOptions, type AgentEvent, type AgentMessage, type AgentState, type AgentTurnContext, type AgentContext, type AgentToolResult } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, getCurrentTools, getToolStateChanges, toToolDeclaration, normalizeContext } from "@earendil-works/pi-ai";
import type { AssistantMessage, ImageContent, Message, Models, ToolResultMessage } from "@earendil-works/pi-ai";
import { Harness, createRegistry, defineDoc, defineTask, type Storage, type TaskId, type Tx, type Conversation } from "@earendil-works/pi-durable";

// This is deliberately a worker-only module. The Harness scheduler owns both
// requests and tool invocations; no native Agent loop runs behind this adapter.
const EVENT = "fabric.agent.event.v1";
const HISTORY = "fabric.agent.history.v1";
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const wire = (value: unknown): JsonValue => copy(value) as JsonValue;
// Streaming updates are presentation only: recovery never replays them (open()
// reads HISTORY plus agent_start/message_end), and each provider partial or tool
// partialResult repeats everything streamed before it. Persisting those payloads
// grows a run's journal quadratically. Commit a slim, ordered marker instead and
// rehydrate the payload in memory when that commit is delivered.
type TransientEvent = Extract<AgentEvent, { type: "message_update" | "tool_execution_update" }>;
const TRANSIENT = "fabricTransient";
const Ledger = defineDoc<{
  runId: string; requests: Record<string, number>; active: number;
  controls?: Record<string, boolean>;
  context?: { messages: JsonValue[]; tools: string[] };
  config?: { model: JsonValue; thinking: AgentState["thinkingLevel"] };
  steering: JsonValue[]; followup: JsonValue[];
}>({ kind: "fabric.agent.ledger", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ runId: "", requests: {}, active: 0, steering: [], followup: [] }),
  checkpointWhen: () => true });

type RunInput = { request: string };
type Checkpoint =
  | { phase: "prepare"; next?: Omit<AgentTurnContext, "context">; pending?: AgentMessage[]; skipSteering?: boolean }
  | { phase: "model"; messages: Message[]; model: AgentState["model"]; thinking: AgentState["thinkingLevel"] }
  | { phase: "tools"; message: AssistantMessage; children: TaskId<ToolResultMessage>[] }
  | { phase: "boundary"; message: AssistantMessage; results: ToolResultMessage[]; terminate?: boolean }
  | { phase: "decide"; message: AssistantMessage; results: ToolResultMessage[]; action?: "end" | "continue"; terminate?: boolean };
type ToolInput = { replaySafe?: boolean; message: AssistantMessage; call: Extract<AssistantMessage["content"][number], { type: "toolCall" }> };
type ToolCheckpoint = { phase: "execute" };
// The Fabric extension can be another module instance in this process, so it
// reads the fence through this global. It is inline so neither startup graph
// gains a chunk shared with this worker module.
type ToolFence = {
  toolCallId: string; accept(): Promise<void>; arm(): Promise<void>;
  journal?: { path: string; digest?: string; accept(digest: string): Promise<void> };
};
// Each resume replays the journal and runs live from where it stopped. A program
// that keeps crashing its process before recording progress must not loop.
const MAX_JOURNAL_RESUMES = 3;

const fabricJournalPath = (directory: string, taskId: string, callId: string): string =>
  path.join(directory, `${createHash("sha256").update(`${taskId}\0${callId}`).digest("hex").slice(0, 32)}.jsonl`);

// A fabric_exec journal holds tool results. Delete it once the call's terminal
// result is committed; a crash before this leaves it to the worker's sweep.
async function removeFabricJournal(file: string): Promise<void> {
  await unlink(file).catch(() => undefined);
}
const toolFences = (): AsyncLocalStorage<ToolFence | undefined> => {
  const holder = globalThis as typeof globalThis & { [key: symbol]: AsyncLocalStorage<ToolFence | undefined> | undefined };
  return holder[Symbol.for("pi-fabric.durable-tool-fence.v1")] ??= new AsyncLocalStorage();
};
type Listener = (event: AgentEvent, signal: AbortSignal) => void | Promise<void>;

/** A public-API Agent facade over restartable pi-durable tasks. */
export class DurableAgent extends Agent {
  private readonly durableOptions: AgentOptions & { models: Models; storage: Storage; runId: string; fabricJournalDirectory?: string };
  private readonly observers = new Set<Listener>();
  private readonly registry = createRegistry();
  private engine?: Harness;
  private root?: Conversation;
  private opening?: Promise<void>;
  private releaseStartup!: (ready: boolean) => void;
  private readonly startup = new Promise<boolean>(resolve => { this.releaseStartup = resolve; });
  /** Reconcile committed history without replaying events, before any recovered task runs. */
  recoverHistory?: (messages: AgentMessage[]) => void | Promise<void>;
  private delivery: Promise<void> = Promise.resolve();
  private admission: Promise<void> = Promise.resolve();
  private running: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private requestId: string | undefined;
  private firstRequest = true;
  private closing = false;
  private closeRequested = false;
  private closed?: Promise<void>;
  private active = false;
  private partial: AgentMessage | undefined;
  private failure: string | undefined;
  private readonly pending = new Set<string>();
  private emitted: AgentMessage[] = [];
  private restored = false;
  private resetPending = false;
  private queuePreview: { mode: "steering" | "followup"; message: AgentMessage }[] = [];
  private readonly transient = new Map<number, TransientEvent>();
  private transientSequence = 0;
  // Harness keeps its scheduler alive between requests. Never inherit the
  // scheduler's first-request permission/extension scope for later work.
  private requestScope = AsyncLocalStorage.snapshot();
  private readonly toolTask;
  private readonly runTask;

  /** `fabricJournalDirectory` lets an interrupted fabric_exec resume from a crash journal. */
  constructor(options: AgentOptions & { models: Models; storage: Storage; runId: string; fabricJournalDirectory?: string }) {
    super(options);
    if (!options.runId) throw new Error("DurableAgent requires a non-empty runId");
    this.durableOptions = options;
    // Shadow only public state properties, never Agent's private implementation.
    Object.defineProperties(super.state, {
      isStreaming: { get: () => this.active },
      streamingMessage: { get: () => this.partial },
      pendingToolCalls: { get: () => this.pending },
      errorMessage: { get: () => this.failure },
    });
    this.toolTask = this.scopedTask<ToolInput, ToolCheckpoint, ToolResultMessage>({
      name: "fabric.agent.tool", version: 1, initial: () => ({ phase: "execute" }),
      phases: { execute: async (task, runtime, ctx) => {
        await this.delivery;
        const { call, message } = task.input;
        const context = await this.executionContext();
        const tool = context.tools?.find(t => t.name === call.name);
        const prior = await runtime.memo<boolean>("intent", ctx);
        if (!prior) {
          await runtime.memo("intent", true, ctx);
          await runtime.commit(async tx => { await this.event(tx, { type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments }); }, ctx);
          await this.delivery;
        }
        // Fabric accepts the fence before its program starts and arms it before
        // any effect, so an accepted, unarmed attempt changed nothing. Wrapper
        // layers drop tool replay metadata, so the fence is offered by name.
        const fabricExec = call.name === "fabric_exec";
        const journalDirectory = fabricExec ? this.durableOptions.fabricJournalDirectory : undefined;
        const journalPath = journalDirectory === undefined ? undefined : fabricJournalPath(journalDirectory, String(task.id), call.id);
        // Header digest of the journal Fabric recorded for this call, if any.
        const recorded = prior && journalPath ? await runtime.memo<string>("fabric.journal", ctx) : undefined;
        let execute = !prior || (task.input.replaySafe === true && tool?.replay === "safe");
        if (!execute && recorded !== undefined) {
          // Resume from the journal: recorded results are served, never rerun.
          for (let attempt = 1; attempt <= MAX_JOURNAL_RESUMES && !execute; attempt++) {
            if (await runtime.memo<boolean>(`fabric.resume.${attempt}`, ctx) === undefined) {
              execute = await runtime.memo(`fabric.resume.${attempt}`, true, ctx);
            }
          }
        } else if (!execute && fabricExec
          && await runtime.memo<boolean>("fabric.fence", ctx) === true
          && await runtime.memo<boolean>("fabric.armed", ctx) === undefined
          && await runtime.memo<boolean>("fabric.rerun", ctx) === undefined) {
          // One rerun only: a program that keeps crashing its process must not loop.
          execute = await runtime.memo("fabric.rerun", true, ctx);
        }
        const fence: ToolFence | undefined = fabricExec ? {
          toolCallId: call.id,
          accept: async () => {
            // A journal-aware Fabric skips accept when it resumes. Any other caller
            // would rerun recorded effects from the start.
            if (recorded !== undefined) throw new Error("This Fabric version cannot resume an interrupted fabric_exec from its journal. Nothing was rerun.");
            await runtime.memo("fabric.fence", true, ctx);
          },
          arm: async () => { await runtime.memo("fabric.armed", true, ctx); },
          ...(journalPath ? { journal: {
            path: journalPath,
            ...(recorded !== undefined ? { digest: recorded } : {}),
            accept: async (digest: string) => {
              if (await runtime.memo("fabric.journal", digest, ctx) !== digest) throw new Error("fabric_exec already recorded a different journal");
            },
          } } : {}),
        } : undefined;
        const outcome: { isError: boolean; result: AgentToolResult<any> } = !execute
          ? { isError: true, result: { content: [{ type: "text" as const, text: "Tool execution interrupted; unsafe effect was not replayed." }], details: { interrupted: true } } }
          // Every other tool runs outside any inherited fence.
          : await toolFences().run(fence, () => runToolCall(call, {
            tools: context.tools ?? [], assistantMessage: message, context, signal: runtime.signal,
            ...(this.beforeToolCall ? { beforeToolCall: this.beforeToolCall } : {}), ...(this.afterToolCall ? { afterToolCall: this.afterToolCall } : {}),
            onUpdate: async result => {
              await this.transientEvent(change => runtime.commit(change, ctx), { type: "tool_execution_update", toolCallId: call.id, toolName: call.name, args: call.arguments, partialResult: result });
            },
          }));
        const result: ToolResultMessage = { role: "toolResult", toolCallId: call.id, toolName: call.name,
          content: outcome.result.content ?? [], details: outcome.result.details, isError: outcome.isError,
          ...(outcome.result.usage ? { usage: outcome.result.usage } : {}), timestamp: Date.now() };
        await runtime.commit(async tx => {
          await this.event(tx, { type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: outcome.result, isError: outcome.isError });
          // Keep termination metadata in the child's durable outcome without changing the Pi message.
          return { status: "terminal", outcome: { status: "completed", result: copy({ ...result, terminate: "terminate" in outcome.result && outcome.result.terminate === true }) as ToolResultMessage } };
        }, ctx);
        // The result is durable now, so the journal can never be read again.
        if (journalPath) await removeFabricJournal(journalPath);
      } },
      abort: async (task, runtime, ctx) => {
        const { call } = task.input;
        const result: ToolResultMessage = { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "Tool execution aborted" }], isError: true, timestamp: Date.now() };
        await runtime.commit(async tx => {
          await this.event(tx, { type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result, isError: true });
          return { status: "terminal", outcome: { status: "completed", result } };
        }, ctx);
        const journalDirectory = call.name === "fabric_exec" ? this.durableOptions.fabricJournalDirectory : undefined;
        if (journalDirectory !== undefined) await removeFabricJournal(fabricJournalPath(journalDirectory, String(task.id), call.id));
      },
    });
    this.runTask = this.scopedTask<RunInput, Checkpoint, null>({
      name: "fabric.agent.run", version: 1, initial: () => ({ phase: "prepare" }),
      phases: {
        prepare: async (task, runtime, ctx) => {
          await this.delivery;
          let context = await this.executionContext();
          const saved = await this.engine!.snapshot(Ledger, runtime.conversationId, ctx);
          let model = (saved?.config?.model as unknown as AgentState["model"] | undefined) ?? this.state.model;
          let thinking = saved?.config?.thinking ?? this.state.thinkingLevel;
          if (task.state.checkpoint.next) {
            const turn = { ...task.state.checkpoint.next, context };
            const update = this.prepareNextTurnWithContext
              ? await this.prepareNextTurnWithContext(turn, runtime.signal)
              : await this.prepareNextTurn?.(runtime.signal);
            if (update?.context) context = update.context;
            model = update?.model ?? model;
            thinking = update?.thinkingLevel ?? thinking;
            await runtime.commit(async tx => { await this.event(tx, { type: "turn_start" }); }, ctx);
            await this.delivery;
            if (update?.messages?.length) {
              const additions = update.messages;
              await runtime.commit(async tx => { for (const m of additions) await this.message(tx, m); }, ctx);
              await this.delivery;
              context = { ...context, messages: [...context.messages, ...additions] };
            }
          }
          await this.admit(runtime.signal);
          await runtime.commit(async tx => {
            const ledger = await tx.doc(Ledger, runtime.conversationId);
            const queued = task.state.checkpoint.pending?.map(wire) ?? (task.state.checkpoint.skipSteering ? [] : ledger.steering.splice(0, this.steeringMode === "all" ? ledger.steering.length : 1));
            for (const value of queued) {
              const message = value as unknown as AgentMessage;
              await this.message(tx, message); context.messages.push(message);
            }
            const changes = getToolStateChanges(getCurrentTools(context.messages), (context.tools ?? []).map(toToolDeclaration));
            if (changes.toolsAdded.length || changes.toolsRemoved.length) {
              const message = { role: "system" as const, content: "", timestamp: Date.now(), ...changes };
              await this.message(tx, message); context.messages.push(message);
            }
          }, ctx);
          await this.delivery;
          const update = await this.prepareRequest?.({ context, model, thinkingLevel: thinking }, runtime.signal);
          context = update?.context ?? context;
          model = update?.model ?? model;
          thinking = update?.thinkingLevel ?? thinking;
          const transformed = this.transformContext ? await this.transformContext(context.messages, runtime.signal) : context.messages;
          const messages = await this.convertToLlm(transformed);
          await runtime.commit(async tx => {
            const ledger = await tx.doc(Ledger, runtime.conversationId);
            ledger.config = { model: wire(model), thinking };
            // Tools run from the public loadout, rebound by name, so a loadout
            // refresh that rebuilds same-name tool objects keeps the request valid.
            // A hook-only tool whose name is not registered cannot be recovered.
            const registered = new Set(this.state.tools.map(tool => tool.name));
            if ((context.tools ?? []).some(tool => !registered.has(tool.name))) throw new Error("Durable request tools must be registered in agent.state.tools");
            ledger.context = { messages: context.messages.map(wire), tools: (context.tools ?? []).map(tool => tool.name) };
            return { status: "running", checkpoint: { phase: "model", messages: copy(messages), model: copy(model), thinking } };
          }, ctx);
        },
        model: async (task, runtime, ctx) => {
          await this.delivery;
          const cp = task.state.checkpoint;
          const stream = await this.streamFunction(cp.model, normalizeContext({ messages: cp.messages }), {
            signal: runtime.signal, ...(cp.thinking === "off" ? {} : { reasoning: cp.thinking }),
            ...(this.sessionId ? { sessionId: this.sessionId } : {}),
            ...(this.thinkingBudgets ? { thinkingBudgets: this.thinkingBudgets } : {}), transport: this.transport,
            ...(this.maxRetryDelayMs !== undefined ? { maxRetryDelayMs: this.maxRetryDelayMs } : {}),
            ...(this.getApiKey ? { apiKey: (await this.getApiKey(cp.model.provider)) ?? "" } : {}),
            ...(this.onPayload ? { onPayload: this.onPayload } : {}),
            ...(this.onResponse ? { onResponse: this.onResponse } : {}),
            ...(this.onProviderStreamEvent ? { onProviderStreamEvent: this.onProviderStreamEvent } : {}),
          });
          let started = false;
          for await (const event of stream) {
            if (event.type === "done" || event.type === "error") continue;
            if (!started) {
              await runtime.commit(async tx => { await this.event(tx, { type: "message_start", message: event.partial }); }, ctx);
              await this.delivery;
            }
            started = true;
            if (event.type !== "start") await this.transientEvent(change => runtime.commit(change, ctx), { type: "message_update", message: event.partial, assistantMessageEvent: event });
          }
          const message = copy({ ...await stream.result(), thinkingLevel: cp.thinking });
          await runtime.commit(async tx => {
            if (!started) await this.event(tx, { type: "message_start", message });
            await this.event(tx, { type: "message_end", message });
            const calls = message.stopReason !== "error" && message.stopReason !== "aborted" ? message.content.filter(c => c.type === "toolCall") : [];
            if (message.stopReason === "length" && calls.length) {
              const results: ToolResultMessage[] = [];
              for (const call of calls) {
                const result = { content: [{ type: "text" as const, text: "Tool call was truncated by the output token limit; execution refused." }], details: {} };
                await this.event(tx, { type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
                await this.event(tx, { type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result, isError: true });
                const toolResult: ToolResultMessage = { role: "toolResult", toolCallId: call.id, toolName: call.name, ...result, isError: true, timestamp: Date.now() };
                results.push(toolResult); await this.message(tx, toolResult);
              }
              return { status: "running", checkpoint: { phase: "boundary", message, results } };
            }
            const sequential = this.toolExecution === "sequential" || calls.some(c => this.state.tools.find(t => t.name === c.name)?.executionMode === "sequential");
            const children: TaskId<ToolResultMessage>[] = [];
            for (const call of sequential ? calls.slice(0, 1) : calls) children.push(await tx.createTask(this.toolTask, { message, call, replaySafe: this.state.tools.find(t => t.name === call.name)?.replay === "safe" }, { ownership: { kind: "task", taskId: task.id } }));
            return children.length
              ? { status: "waiting", checkpoint: { phase: "tools", message, children }, on: children, policy: "allSettled" }
              : { status: "running", checkpoint: { phase: "boundary", message, results: [] } };
          }, ctx);
        },
        tools: async (task, runtime, ctx) => {
          await this.delivery;
          const { message, children } = task.state.checkpoint;
          const calls = message.content.filter(c => c.type === "toolCall");
          if (children.length < calls.length) {
            await runtime.commit(async tx => {
              const child = await tx.createTask(this.toolTask, { message, call: calls[children.length]!, replaySafe: this.state.tools.find(t => t.name === calls[children.length]!.name)?.replay === "safe" }, { ownership: { kind: "task", taskId: task.id } });
              return { status: "waiting", checkpoint: { phase: "tools", message, children: [...children, child] }, on: [child], policy: "allSettled" };
            }, ctx);
            return;
          }
          const outcomes = await runtime.outcomes(children, ctx);
          // pi-durable 1.5 outcomes are immutable snapshots. Strip our private
          // termination marker only from a copy, never from the stored result.
          const results = outcomes.map((o, index): ToolResultMessage => o.status === "completed" ? copy(o.result) : ({
            role: "toolResult", toolCallId: calls[index]!.id, toolName: calls[index]!.name,
            content: [{ type: "text", text: `Tool task ${o.status}` }], isError: true, timestamp: Date.now(),
          }));
          const terminate = results.length > 0 && results.every(r => (r as ToolResultMessage & { terminate?: boolean }).terminate);
          for (const result of results) delete (result as ToolResultMessage & { terminate?: boolean }).terminate;
          await runtime.commit(async tx => {
            for (const result of results) await this.message(tx, result);
            return { status: "running", checkpoint: copy({ phase: "boundary" as const, message, results, terminate }) };
          }, ctx);
        },
        boundary: async (task, runtime, ctx) => {
          await this.delivery;
          const { message, results, terminate } = task.state.checkpoint;
          const decision = await this.finishTurn?.({ message: this.lastAssistant(message), toolResults: this.canonicalToolResults(results), context: await this.executionContext(), newMessages: this.emitted.slice() }, runtime.signal);
          await runtime.commit(async tx => {
            await this.event(tx, { type: "turn_end", message, toolResults: results });
            return { status: "running", checkpoint: { phase: "decide", message, results, ...(decision ? { action: decision.action } : {}), ...(terminate ? { terminate: true } : {}) } };
          }, ctx);
        },
        decide: async (task, runtime, ctx) => {
          await this.delivery;
          await this.admit(runtime.signal);
          const cp = task.state.checkpoint;
          await runtime.commit(async tx => {
            const ledger = await tx.doc(Ledger, runtime.conversationId);
            const hardEnd = cp.message.stopReason === "error" || cp.message.stopReason === "aborted" || cp.action === "end";
            let queued: JsonValue[] = [];
            if (!hardEnd) {
              queued = ledger.steering.splice(0, this.steeringMode === "all" ? ledger.steering.length : 1);
              if (!queued.length && (!cp.results.length || cp.terminate) && cp.action !== "continue") queued = ledger.followup.splice(0, this.followUpMode === "all" ? ledger.followup.length : 1);
            }
            if (!hardEnd && (queued.length || (cp.results.length && !cp.terminate) || cp.action === "continue")) {
              const next = copy({ message: cp.message, toolResults: cp.results, newMessages: this.emitted.slice() });
              return { status: "running", checkpoint: { phase: "prepare", next, ...(queued.length ? { pending: copy(queued) as unknown as AgentMessage[] } : {}), skipSteering: queued.length > 0 } };
            }
            ledger.active = 0;
            await this.event(tx, { type: "agent_end", messages: this.emitted.slice() });
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, ctx);
        },
      },
      abort: async (task, runtime, ctx) => {
        await this.delivery;
        const results: ToolResultMessage[] = [];
        if (task.state.checkpoint.phase === "tools") {
          const { message, children } = task.state.checkpoint;
          const calls = message.content.filter(c => c.type === "toolCall");
          for (const [index, call] of calls.entries()) {
            const child = children[index] ? await runtime.getTask(children[index]!, ctx) : undefined;
            const outcome = child?.state.status === "terminal" ? child.state.outcome : undefined;
            const result = outcome?.status === "completed" ? copy(outcome.result) : {
              role: "toolResult" as const, toolCallId: call.id, toolName: call.name,
              content: [{ type: "text" as const, text: "Tool execution aborted" }], isError: true, timestamp: Date.now(),
            };
            delete (result as ToolResultMessage & { terminate?: boolean }).terminate;
            results.push(result);
          }
        }
        await runtime.commit(async tx => {
          const ledger = await tx.doc(Ledger, runtime.conversationId);
          ledger.active = 0;
          for (const result of results) await this.message(tx, result);
          const message = this.failureMessage("Operation aborted", true);
          await this.message(tx, message);
          await this.event(tx, { type: "turn_end", message, toolResults: results });
          await this.event(tx, { type: "agent_end", messages: [...this.emitted, ...results, message] });
          return { status: "terminal", outcome: { status: "aborted" } };
        }, ctx);
      },
    });
    this.registry.install({ name: "fabric-agent", tasks: [this.runTask, this.toolTask] });
  }

  private scopedTask<I, S extends { phase: string }, R>(definition: Parameters<typeof defineTask<I, S, R>>[0]) {
    const phases = Object.fromEntries(Object.entries(definition.phases).map(([name, handler]) => [name,
      async (...args: unknown[]) => {
        if (!await this.startup) throw new Error("DurableAgent recovery failed");
        return this.requestScope(handler as (...args: unknown[]) => unknown, ...args);
      },
    ])) as typeof definition.phases;
    const abort = definition.abort;
    return defineTask<I, S, R>({ ...definition, phases, ...(abort ? { abort: async (...args) => {
      if (!await this.startup) throw new Error("DurableAgent recovery failed");
      return this.requestScope(abort, ...args);
    } } : {}) });
  }
  private failureMessage(errorMessage: string, aborted: boolean): AssistantMessage {
    return { role: "assistant", content: [], api: this.state.model.api, provider: this.state.model.provider, model: this.state.model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: aborted ? "aborted" : "error", errorMessage, timestamp: Date.now() };
  }
  private context(): AgentContext { return { messages: this.state.messages.slice(), tools: this.state.tools.slice() }; }
  private async executionContext(): Promise<AgentContext> {
    const saved = await this.engine!.snapshot(Ledger, this.root!.id, BACKGROUND_CONTEXT);
    if (!saved?.context) return this.context();
    return { messages: copy(saved.context.messages) as unknown as AgentMessage[], tools: this.state.tools.filter(tool => saved.context!.tools.includes(tool.name)) };
  }
  private canonicalToolResults(results: ToolResultMessage[]): ToolResultMessage[] {
    const messages = this.state.messages.slice().reverse();
    return results.map(result => messages.find((message): message is ToolResultMessage =>
      message.role === "toolResult" && message.toolCallId === result.toolCallId) ?? result);
  }
  private lastAssistant(fallback: AssistantMessage): AssistantMessage {
    return this.state.messages.slice().reverse().find((m): m is AssistantMessage => m.role === "assistant") ?? fallback;
  }
  private async event(tx: Tx, event: AgentEvent) {
    await tx.appendEntry(this.root!.id, { kind: EVENT, data: wire(event) });
    if (event.type === "message_end") {
      const ledger = await tx.doc(Ledger, this.root!.id);
      ledger.context?.messages.push(wire(event.message));
    }
  }
  /** Commit an ordered, slim marker for a streaming update; its payload stays in memory until delivery. */
  private async transientEvent(commit: (change: (tx: Tx) => Promise<undefined>) => Promise<unknown>, event: TransientEvent) {
    const sequence = ++this.transientSequence;
    // Copy synchronously: providers and tools keep mutating their partials.
    this.transient.set(sequence, copy(event));
    let marker: Record<string, unknown>;
    if (event.type === "message_update") {
      const { partial: _partial, ...delta } = event.assistantMessageEvent as typeof event.assistantMessageEvent & { partial?: unknown };
      marker = { type: event.type, assistantMessageEvent: delta };
    } else marker = { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName };
    try {
      await commit(async tx => { await tx.appendEntry(this.root!.id, { kind: EVENT, data: wire({ ...marker, [TRANSIENT]: sequence }) }); return undefined; });
    } catch (error) {
      this.transient.delete(sequence);
      throw error;
    }
    await this.delivery;
  }
  /** Restore a committed streaming marker to the full event; undefined when its payload is not in this process. */
  private rehydrate(data: Record<string, unknown>): AgentEvent | undefined {
    const sequence = data[TRANSIENT];
    if (typeof sequence !== "number") return data as unknown as AgentEvent;
    const event = this.transient.get(sequence);
    this.transient.delete(sequence);
    return event;
  }
  private async message(tx: Tx, message: AgentMessage) {
    await this.event(tx, { type: "message_start", message });
    await this.event(tx, { type: "message_end", message });
  }
  private async expose(event: AgentEvent) {
    // Durable entries are JSON values; native Pi boundaries identify the exact
    // objects delivered by message_end, not independent deserialized copies.
    if (event.type === "turn_end") event = {
      ...event, message: event.message.role === "assistant" ? this.lastAssistant(event.message) : event.message,
      toolResults: this.canonicalToolResults(event.toolResults),
    };
    if (event.type === "message_start" && event.message.role === "assistant") this.partial = event.message;
    if (event.type === "message_update") this.partial = event.message;
    if (event.type === "message_end") {
      this.state.messages = [...this.state.messages, event.message];
      this.emitted.push(event.message);
      this.partial = undefined;
      if (event.message.role === "assistant") this.failure = event.message.errorMessage;
      const index = this.queuePreview.findIndex(q => JSON.stringify(q.message) === JSON.stringify(event.message));
      if (index >= 0) this.queuePreview.splice(index, 1);
    }
    if (event.type === "tool_execution_start") this.pending.add(event.toolCallId);
    if (event.type === "tool_execution_end") this.pending.delete(event.toolCallId);
    for (const observer of this.observers) await observer(event, this.controller?.signal ?? new AbortController().signal);
  }
  private async open() {
    if (this.closing) throw new Error("DurableAgent is closed");
    return this.opening ??= (async () => {
      // Session.close owns its Storage; this facade borrows the caller's handle.
      const borrowed = new Proxy(this.durableOptions.storage, { get(target, key) {
        if (key === "close") return async () => {};
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const harness = await Harness.open(borrowed, { models: this.durableOptions.models, registry: this.registry }, BACKGROUND_CONTEXT);
      this.engine = harness;
      this.root = await harness.root(BACKGROUND_CONTEXT);
      const ledger = await harness.snapshot(Ledger, this.root.id, BACKGROUND_CONTEXT);
      if (ledger?.runId && ledger.runId !== this.durableOptions.runId) throw new Error("DurableAgent storage belongs to a different runId");
      const history = (await this.root.context(BACKGROUND_CONTEXT)).entries;
      const messages: AgentMessage[] = [];
      for (const entry of history) {
        if (entry.kind === HISTORY) { messages.splice(0, messages.length, ...(entry.data as unknown as AgentMessage[])); this.restored = true; }
        if (entry.kind === EVENT) {
          const event = entry.data as unknown as AgentEvent;
          if (event.type === "agent_start") this.emitted = [];
          if (event.type === "message_end") { messages.push(event.message); this.emitted.push(event.message); }
        }
      }
      if (this.restored && !this.resetPending) this.state.messages = messages;
      if (this.restored && !this.resetPending) await this.recoverHistory?.(copy(messages));
      this.queuePreview = [ ...this.queuePreview, ...(ledger?.steering ?? []).map(message => ({ mode: "steering" as const, message: message as unknown as AgentMessage })), ...(ledger?.followup ?? []).map(message => ({ mode: "followup" as const, message: message as unknown as AgentMessage })) ];
      const advance: Parameters<Harness["observeCommits"]>[0]["advance"] = publication => {
        for (const change of publication.changes) {
          if (change.type !== "entry" || change.value.conversationId !== this.root!.id || change.value.kind !== EVENT) continue;
          // A marker whose payload is not in memory came from another process; it is never replayed.
          const event = this.rehydrate(copy(change.value.data) as Record<string, unknown>);
          if (!event) continue;
          this.delivery = this.delivery.then(() => this.requestScope(() => this.expose(event)));
          // Keep failures observable at every execution boundary, without an unhandled rejection.
          void this.delivery.catch(() => {});
        }
      };
      // 1.5 commit observers end with the Harness. Keep the 1.4 adapter usable.
      const legacy = harness as unknown as { subscribeCommits?: (listener: typeof advance) => unknown };
      if (typeof legacy.subscribeCommits === "function") legacy.subscribeCommits(advance);
      else harness.observeCommits({ advance, end: () => {} });
      this.releaseStartup(true);
    })().catch(error => { this.releaseStartup(false); throw error; });
  }
  /** Resolves only after all controls accepted so far have committed. */
  awaitControls(): Promise<void> { return this.admission; }
  /**
   * A phase's wait for accepted controls. abort() chains the engine abort onto admission, and that abort joins the
   * running invocation, so a phase that kept waiting on admission after its abort signal would wait on itself. The
   * phase's next commit then rejects on the durable abort mark and the abort handler settles the task.
   */
  private admit(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    let onAbort!: () => void;
    const aborted = new Promise<void>(resolve => { onAbort = resolve; signal.addEventListener("abort", onAbort, { once: true }); });
    return Promise.race([this.admission, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
  }
  setRequestId(id: string): void { if (!id) throw new Error("requestId must not be empty"); this.requestId = id; }
  override subscribe(listener: Listener) { this.observers.add(listener); return () => { this.observers.delete(listener); }; }
  override get signal() { return this.controller?.signal; }
  override waitForIdle() { return this.running ?? Promise.resolve(); }
  override abort() {
    this.controller?.abort();
    if (this.root && this.active) {
      const aborting = this.root.abort(BACKGROUND_CONTEXT);
      this.admission = this.admission.then(() => aborting);
      void this.admission.catch(() => {});
    }
  }
  override prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
  override prompt(input: string, images?: ImageContent[]): Promise<void>;
  override prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
    const messages: AgentMessage[] = typeof input === "string" ? [{ role: "user", content: images?.length ? [{ type: "text", text: input }, ...images] : input, timestamp: Date.now() }] : Array.isArray(input) ? input : [input];
    return this.start(messages);
  }
  override continue() { return this.start([]); }
  private start(messages: AgentMessage[]) {
    if (this.active) return Promise.reject(new Error("Agent is already processing a prompt"));
    if (this.closeRequested) return Promise.reject(new Error("DurableAgent is closed"));
    const request = this.requestId ?? (this.firstRequest && messages.length ? this.durableOptions.runId : randomUUID()); this.requestId = undefined; this.firstRequest = false;
    this.requestScope = AsyncLocalStorage.snapshot();
    this.active = true; this.failure = undefined; this.emitted = []; this.controller = new AbortController();
    const run = (async () => {
      await this.open();
      await this.admission;
      let id!: TaskId<null>;
      await this.root!.commit(async tx => {
        const ledger = await tx.doc(Ledger, this.root!.id);
        ledger.runId = this.durableOptions.runId;
        if (Object.hasOwn(ledger.requests, request)) { id = ledger.requests[request] as TaskId<null>; return; }
        if (ledger.active) {
          if (messages.length) throw new Error("Unfinished durable run: resume with continue() or its original requestId");
          id = ledger.active as TaskId<null>; ledger.requests = { ...ledger.requests, [request]: id }; return;
        }
        if (!messages.length) {
          const last = this.state.messages.at(-1);
          if (!last || this.state.messages.every(m => m.role === "system")) throw new Error("No messages to continue from");
          if (last.role === "assistant") {
            const queue = ledger.steering.length ? ledger.steering : ledger.followup;
            const mode = ledger.steering.length ? this.steeringMode : this.followUpMode;
            messages = queue.splice(0, mode === "all" ? queue.length : 1) as unknown as AgentMessage[];
            if (!messages.length) throw new Error("Cannot continue from message role: assistant");
          }
        }
        delete ledger.context;
        ledger.config = { model: wire(this.state.model), thinking: this.state.thinkingLevel };
        if (!this.restored || this.resetPending || !ledger.active) {
          await tx.appendEntry(this.root!.id, { kind: HISTORY, data: wire(this.state.messages) });
          this.restored = true; this.resetPending = false;
        }
        this.emitted = [];
        await this.event(tx, { type: "agent_start" });
        await this.event(tx, { type: "turn_start" });
        for (const message of messages) await this.message(tx, message);
        id = await tx.createTask(this.runTask, { request }, { ownership: { kind: "conversation" } });
        ledger.requests = { ...ledger.requests, [request]: id }; ledger.active = id;
      }, BACKGROUND_CONTEXT);
      await this.delivery;
      if (this.controller!.signal.aborted) await this.engine!.abortTask(id, BACKGROUND_CONTEXT);
      const settled = await this.engine!.waitForTask(id, BACKGROUND_CONTEXT);
      await this.delivery;
      if (settled.state.outcome.status === "failed" || settled.state.outcome.status === "faulted") {
        const message = this.failureMessage(settled.state.outcome.error.message, false);
        await this.root!.commit(async tx => {
          const ledger = await tx.doc(Ledger, this.root!.id);
          // A retried failed identity must not append the same failure twice.
          if (ledger.active !== id) return;
          ledger.active = 0;
          await this.message(tx, message);
          await this.event(tx, { type: "turn_end", message, toolResults: [] });
          await this.event(tx, { type: "agent_end", messages: [...this.emitted, message] });
        }, BACKGROUND_CONTEXT);
        await this.delivery;
      }
    })().finally(() => { this.active = false; this.partial = undefined; this.pending.clear(); this.controller = undefined; this.running = undefined; });
    this.running = run;
    return run;
  }
  private enqueue(mode: "steering" | "followup", message: AgentMessage) {
    if (this.closeRequested) throw new Error("DurableAgent is closed");
    const request = this.requestId; this.requestId = undefined;
    this.queuePreview.push({ mode, message: copy(message) });
    this.admission = this.admission.then(async () => {
      await this.open();
      await this.root!.commit(async tx => {
        const ledger = await tx.doc(Ledger, this.root!.id);
        ledger.runId ||= this.durableOptions.runId;
        ledger.controls ??= {};
        if (request && Object.hasOwn(ledger.controls, request)) {
          const index = this.queuePreview.findIndex(q => q.mode === mode && JSON.stringify(q.message) === JSON.stringify(message));
          if (index >= 0) this.queuePreview.splice(index, 1);
          return;
        }
        if (request) ledger.controls = { ...ledger.controls, [request]: true };
        ledger[mode].push(wire(message));
      }, BACKGROUND_CONTEXT);
    });
    void this.admission.catch(() => {});
  }
  override steer(message: AgentMessage) { this.enqueue("steering", message); }
  override followUp(message: AgentMessage) { this.enqueue("followup", message); }
  private clear(mode?: "steering" | "followup") {
    if (this.closeRequested) throw new Error("DurableAgent is closed");
    this.queuePreview = this.queuePreview.filter(q => mode !== undefined && q.mode !== mode);
    this.admission = this.admission.then(async () => {
      await this.open();
      await this.root!.commit(async tx => { const d = await tx.doc(Ledger, this.root!.id); if (!mode || mode === "steering") d.steering = []; if (!mode || mode === "followup") d.followup = []; }, BACKGROUND_CONTEXT);
    });
    void this.admission.catch(() => {});
  }
  override clearSteeringQueue() { this.clear("steering"); }
  override clearFollowUpQueue() { this.clear("followup"); }
  override clearAllQueues() { this.clear(); }
  override hasQueuedMessages() { return this.queuePreview.length > 0; }
  override peekQueuedMessages() {
    const steering = this.queuePreview.filter(q => q.mode === "steering").map(q => q.message);
    const followup = this.queuePreview.filter(q => q.mode === "followup").map(q => q.message);
    return steering.length ? (this.steeringMode === "all" ? steering : steering.slice(0, 1)) : (this.followUpMode === "all" ? followup : followup.slice(0, 1));
  }
  override reset() {
    if (this.active) throw new Error("Cannot reset a running DurableAgent");
    const baseline = getCurrentSystemMessage(this.state.messages);
    this.state.messages = baseline ? [baseline] : [];
    this.partial = undefined; this.failure = undefined; this.pending.clear();
    this.clearAllQueues(); this.resetPending = true;
  }
  /** Close cancels invocations, NOT durable tasks. A new Harness resumes their checkpoints. */
  close(): Promise<void> {
    this.closeRequested = true;
    return this.closed ??= (async () => {
      // Accepted queue writes may still need open(); seal only after they drain.
      // Even a rejected open (for example a foreign runId) must release Harness.
      const drained = await Promise.allSettled([this.opening, this.admission]);
      this.closing = true;
      if (this.engine) await this.engine.close(BACKGROUND_CONTEXT);
      await this.delivery;
      const rejected = drained.find(result => result.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
    })();
  }
}
