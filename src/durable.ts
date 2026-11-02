import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import type { Harness, HarnessOptions, ModelRef, Registry, Storage, Conversation, Submission, ConversationWatch, ConversationView, ToolRegistration } from "@earendil-works/pi-durable";
import type { FabricHostedRunner, FabricHostedRunContext, FabricHostedReporter, FabricHostedLiveness } from "./agents/runner-registry.js";
import type { AgentUsage } from "./agents/types.js";
import { durableInput } from "./durable-input.js";
import { openDurableControls, type PiDurableControls, type PiDurableMessageOptions } from "./durable-controls.js";
export type { PiDurableMessageOptions } from "./durable-controls.js";

/** The host must hold exclusive ownership until release, including across processes. */
export interface PiDurableStorageLease {
  storage: Storage;
  release(): void | Promise<void>;
}
export type PiDurableStorageOptions =
  | { kind: "jsonl"; directory: string }
  | { kind: "factory"; identity: string; acquire(runId: string): Promise<PiDurableStorageLease> };
export interface PiDurableRunnerOptions {
  id?: string;
  label?: string;
  residentModule?: string;
  models: HarnessOptions["models"];
  registry: Registry;
  env: NonNullable<HarnessOptions["env"]>;
  allowedModels: readonly ModelRef[];
  /** Optional host-selected model, which must also appear in allowedModels. */
  defaultModel?: ModelRef;
  storage: PiDurableStorageOptions;
}
export interface PiDurableRunner extends FabricHostedRunner {
  steer(locator: unknown, message: string, options?: PiDurableMessageOptions): Promise<void>;
  followUp(locator: unknown, message: string, options?: PiDurableMessageOptions): Promise<void>;
  /** Seal this instance, join invocations and release storage; never abort work. Create a new runner to reopen. */
  close(): Promise<void>;
}
export interface PiDurableLocator {
  version: 1;
  backend: "pi-durable";
  storage: string;
  runId: string;
}

type Runtime = { durable: typeof import("@earendil-works/pi-durable"); context: typeof import("@earendil-works/chord/context") };
let runtimePromise: Promise<Runtime> | undefined;
async function runtime(): Promise<Runtime> {
  return runtimePromise ??= Promise.resolve().then(() => {
    const require = createRequire(import.meta.url);
    for (const name of ["@earendil-works/pi-durable", "@earendil-works/chord"]) {
      const metadata = require(`${name}/package.json`) as { version?: string };
      if (!["1.4.0", "1.5.0"].includes(metadata.version ?? "")) throw new Error(`Unsupported ${name} version ${metadata.version ?? "unknown"}; expected 1.4.0 or 1.5.0`);
    }
    return Promise.all([import("@earendil-works/pi-durable"), import("@earendil-works/chord/context")]);
  })
    .then(([durable, context]) => ({ durable, context }))
    .catch((cause: unknown) => {
      runtimePromise = undefined;
      throw new Error(`Pi durable runner requires tested dependencies @earendil-works/pi-durable and @earendil-works/chord (1.4.0 or 1.5.0): ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    });
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const ownershipSymbol = Symbol.for("pi-fabric.durable.owners.v1");
const globals = globalThis as unknown as Record<symbol, Set<string> | undefined>;
const owners = globals[ownershipSymbol] ??= new Set<string>();
interface OpenRun {
  harness: Harness;
  conversation?: Conversation;
  submission?: Submission;
  controls?: PiDurableControls;
  lease: PiDurableStorageLease;
  ownerKey: string;
  watch?: ConversationWatch;
  reporters: Set<FabricHostedReporter>;
  observing?: Promise<void>;
  fingerprint?: string;
}

/** Opt-in hosted adapter. No registration or runtime package loading occurs at factory creation. */
export function createPiDurableRunner(options: PiDurableRunnerOptions): PiDurableRunner {
  if (!options.models || !options.registry || typeof options.env !== "function") throw new Error("Pi durable requires host models, registry and environment");
  const storage = options.storage;
  // HarnessOptions.models may be a getter so hosts can swap catalogs; read it at each use, as the Harness does.
  const currentModels = () => typeof options.models === "function" ? options.models() : options.models;
  const directory = storage.kind === "jsonl" ? path.resolve(storage.directory) : undefined;
  if (storage.kind === "factory" && (!storage.identity || typeof storage.acquire !== "function")) throw new Error("Storage factory requires identity and exclusive acquire()");
  const identity = hash(storage.kind === "jsonl" ? `jsonl:${directory}` : `factory:${storage.identity}`);
  const allowed = new Map(options.allowedModels.map(model => [`${model.provider}/${model.modelId}`, { ...model }]));
  if (!allowed.size) throw new Error("Pi durable requires an explicit model allowlist");
  const id = options.id ?? "pi-durable-leaf";
  const defaultModel = options.defaultModel ? `${options.defaultModel.provider}/${options.defaultModel.modelId}` : undefined;
  if (defaultModel && !allowed.has(defaultModel)) throw new Error("Pi durable default model must be allowlisted");
  const runs = new Map<string, OpenRun>();
  const transcriptSeen = new WeakMap<FabricHostedReporter, Set<import("@earendil-works/pi-durable").EntryId>>();
  let sealed = false;
  let tail: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    if (sealed) return Promise.reject(new Error("Pi durable runner is closed"));
    const result = tail.then(fn);
    tail = result.catch(() => undefined);
    return result;
  };
  function locator(value: unknown): PiDurableLocator {
    const loc = value as Partial<PiDurableLocator> | null;
    if (!loc || loc.version !== 1 || loc.backend !== "pi-durable" || loc.storage !== identity || typeof loc.runId !== "string" || !loc.runId || loc.runId.length > 512) throw new Error("Invalid Pi durable locator or storage identity");
    return loc as PiDurableLocator;
  }
  function validate(context: FabricHostedRunContext) {
    if (context.id !== context.idempotencyKey) throw new Error("Pi durable requires Fabric run ID as idempotencyKey");
    if (context.residency === "durable" && !options.residentModule) throw new Error("Durable residency requires an explicit residentModule");
    for (const key of ["kernel", "sessionFile", "actorId", "actorName", "writePolicy", "scope"] as const) {
      if (context[key] !== undefined) throw new Error(`Pi durable does not support ${key}`);
    }
    if (context.recursive) throw new Error("Pi durable does not support recursiveFabric");
    const modelKey = context.model ?? defaultModel;
    const model = modelKey ? allowed.get(modelKey) : undefined;
    if (!model || !currentModels().getModel(model.provider, model.modelId)) throw new Error(`Unknown or disallowed Pi durable model: ${modelKey ?? "(missing explicit provider/model)"}`);
    const catalogModel = currentModels().getModel(model.provider, model.modelId)!;
    const input = durableInput(context, catalogModel.input.includes("image"));
    if (context.thinking && ((!catalogModel.reasoning && context.thinking !== "off") || catalogModel.thinkingLevelMap?.[context.thinking] === null)) throw new Error(`Unsupported thinking level: ${context.thinking}`);
    const snapshot = options.registry.snapshot();
    const available = new Map(snapshot.tools().map(({ tool }) => [tool.name, tool]));
    const tools = context.tools.map(name => {
      let tool = available.get(name);
      if (!tool) throw new Error(`Unknown Pi durable tool: ${name}`);
      for (const extension of snapshot.installed()) for (const wrap of extension.wraps ?? []) {
        if ("tool" in wrap && wrap.tool === name) tool = wrap.wrap(tool);
      }
      if (tool.name !== name) throw new Error(`Registry wrapper renamed tool ${name}`);
      const implementation = tool;
      return { ...implementation, replay: name === "fabric_exec" ? "unsafe" as const : implementation.replay ?? "unsafe", execute: async (...args: Parameters<ToolRegistration["execute"]>) => {
        const result = await implementation.execute(...args);
        if (result.control?.addTools || result.control?.handoff) throw new Error("Pi durable adapter does not support tool-set changes or handoff controls");
        return result;
      } } satisfies ToolRegistration;
    });
    const fingerprint = hash(JSON.stringify({ task: context.task, cwd: context.cwd, model, tools: [...context.tools], thinking: context.thinking ?? "off", systemPrompt: context.systemPrompt ?? "", ...(input.images?.length ? { images: input.images } : {}), ...(input.schema ? { schema: input.schema } : {}) }));
    return { model, tools, fingerprint, input };
  }
  async function acquire(runId: string, rt: Runtime): Promise<PiDurableStorageLease> {
    if (storage.kind === "factory") return storage.acquire(runId);
    const base = directory!;
    await fs.mkdir(base, { recursive: true });
    const canonical = await fs.realpath(base);
    const stem = hash(runId);
    const lock = path.join(canonical, `${stem}.writer`);
    try { await fs.mkdir(lock); } catch (cause) { throw new Error(`Pi durable single-writer lock unavailable: ${lock}. Never remove a stale lock until its owner is verified dead.`, { cause }); }
    try {
      const { openNodeJsonlStorage } = await import("@earendil-works/pi-durable/storage/jsonl/node");
      const opened = await openNodeJsonlStorage(path.join(canonical, stem), rt.context.BACKGROUND_CONTEXT, { fsync: true });
      return { storage: opened, release: () => fs.rmdir(lock) };
    } catch (error) { await fs.rmdir(lock); throw error; }
  }
  async function open(runId: string, selected: ReturnType<typeof validate>): Promise<OpenRun> {
    const existing = runs.get(runId);
    if (existing) {
      if (existing.fingerprint && existing.fingerprint !== selected.fingerprint) throw new Error("Fabric run ID already bound to different work");
      return existing;
    }
    const ownerKey = `${identity}:${runId}`;
    if (owners.has(ownerKey)) throw new Error("Pi durable storage already has an active writer");
    owners.add(ownerKey);
    let lease: PiDurableStorageLease | undefined;
    try {
      const rt = await runtime();
      lease = await acquire(runId, rt);
      // Deliberately import only requested tool implementations; no registry hooks, sections or tasks.
      const registry = rt.durable.createRegistry();
      registry.install(rt.durable.defineExtension({ name: "fabric.durable.tools", tools: selected.tools }));
      const harness = await rt.durable.Harness.open(lease.storage, { models: options.models, registry, env: options.env, settings: { compaction: { enabled: false }, retry: { enabled: false }, stream: { maxRetries: 0 } } }, rt.context.BACKGROUND_CONTEXT);
      const run: OpenRun = { harness, lease, ownerKey, reporters: new Set() };
      runs.set(runId, run);
      return run;
    } catch (error) {
      if (lease) {
        try {
          await lease.storage.close((await runtime()).context.BACKGROUND_CONTEXT);
          await lease.release();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Pi durable open failed; cleanup failed, lease remains owned");
        }
      }
      owners.delete(ownerKey);
      throw error;
    }
  }
  async function bind(value: unknown, context: FabricHostedRunContext, reporter: FabricHostedReporter, admit: boolean): Promise<void> {
    const loc = locator(value);
    if (loc.runId !== context.id) throw new Error("Pi durable locator does not match Fabric run ID");
    const selected = validate(context);
    const rt = await runtime();
    const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai/models");
    if (!getSupportedThinkingLevels(currentModels().getModel(selected.model.provider, selected.model.modelId)!).includes(context.thinking ?? "off")) throw new Error(`Unsupported thinking level: ${context.thinking ?? "off"}`);
    const ctx = rt.context.BACKGROUND_CONTEXT;
    const run = await open(loc.runId, selected);
    const Manifest = rt.durable.defineDoc<{ fingerprint: string }>({ kind: "fabric.durable.request", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ fingerprint: selected.fingerprint }), checkpointWhen: () => true });
    let conversation = await run.harness.conversation(rt.durable.ROOT_CONVERSATION_ID, ctx);
    if (!conversation && admit) conversation = await run.harness.root(ctx, { agent: { model: selected.model, tools: selected.tools, thinkingLevel: context.thinking ?? "off", cwd: context.cwd, instructions: selected.input.instructions }, init: async (tx, id) => { await tx.doc(Manifest, id); } });
    if (!conversation) throw new Error("Pi durable attach found no existing conversation; outcome indeterminate (not resubmitted)");
    const manifest = await run.harness.snapshot(Manifest, conversation.id, ctx);
    if (manifest?.fingerprint !== selected.fingerprint) throw new Error("Fabric run ID already bound to different work or missing committed manifest");
    run.fingerprint = selected.fingerprint;
    run.conversation = conversation;
    const found = await conversation.commit(tx => tx.submissionByRequest(conversation!.id, context.id), ctx);
    let submission = found ? await run.harness.submission(found.id, ctx) : undefined;
    if (!submission && admit) submission = await conversation.submit({ type: "input", content: selected.input.content, requestId: context.id }, ctx);
    if (!submission) throw new Error("Pi durable attach found no existing submission; outcome indeterminate (not resubmitted)");
    run.submission = submission;
    if (!run.controls) {
      run.controls = await openDurableControls({ durable: rt.durable, context: ctx, harness: run.harness, storage: run.lease.storage, conversation, initial: submission, runId: context.id, serialize: serial, closed: () => sealed });
    }
    run.reporters.add(reporter);
    if (!run.watch) {
      run.watch = await conversation.watch(ctx);
      run.watch.start(async call => {
        // Pi 1.5 uses tagged watch calls; 1.4 passed the view directly.
        const view = "kind" in call ? (call.kind === "value" ? call.value : undefined) : call;
        if (view) for (const target of run.reporters) report(view, target);
      });
    }
    report(run.watch.value, reporter);
    if (!run.observing) {
      run.observing = run.controls.wait().then(async result => {
        if (sealed || !result) return;
        const view = await conversation!.context(ctx);
        const answer = result.type === "input" && result.status === "done" ? view.entries.find(entry => entry.id === result.answer) : undefined;
        const output = answer?.model?.flatMap(message => message.role === "assistant" ? message.content.filter(block => block.type === "text").map(block => block.text) : []).join("") ?? "";
        const completion: { status: "completed" | "stopped" | "failed"; text: string; value?: unknown; error?: string } = {
          status: result.status === "done" ? "completed" : result.reason === "aborted" ? "stopped" : "failed",
          text: result.status === "done" ? output : `Pi durable unanswered: ${result.reason}`,
        };
        if (selected.input.schema) {
          const { validateAgentResult } = await import("./agents/result.js");
          validateAgentResult(completion, selected.input.schema);
        }
        const usage = await run.harness.usage(ctx);
        for (const target of run.reporters) {
          target.usage(totalUsage(usage));
          target.finish({ status: completion.status, output: completion.error ?? completion.text, ...(completion.value !== undefined ? { structured: completion.value } : {}) });
        }
        delete run.observing;
      }).catch(error => { if (!sealed) for (const target of run.reporters) target.fail({ error: `Pi durable observation failed: ${String(error)}` }); });
    }
  }
  function totalUsage(usage: import("@earendil-works/pi-durable").UsageState): AgentUsage {
    const total: AgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const bucket of [usage.models, usage.tools]) for (const item of Object.values(bucket)) {
      total.input += item.input; total.output += item.output; total.cacheRead += item.cacheRead; total.cacheWrite += item.cacheWrite; total.cost += item.cost.total;
    }
    return total;
  }
  function report(view: ConversationView, reporter: FabricHostedReporter): void {
    let seen = transcriptSeen.get(reporter);
    if (!seen) { seen = new Set(); transcriptSeen.set(reporter, seen); }
    for (const entry of view.entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      for (const message of entry.model ?? []) {
        if (message.role === "assistant" || message.role === "user") {
          const content = typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => ({ type: "text" as const, text: block.text }));
          reporter.transcript({ type: "message_end", message: { role: message.role, content } });
          if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") reporter.transcript({ type: "tool_execution_start", toolCallId: block.id, toolName: block.name, args: block.arguments });
        } else if (message.role === "toolResult") reporter.transcript({ type: "tool_execution_end", toolCallId: message.toolCallId, toolName: message.toolName, result: message.content, isError: message.isError });
      }
    }
    const assistants = view.entries.flatMap(entry => entry.model?.filter(message => message.role === "assistant") ?? []);
    const live = view.docs["pi.live"] as unknown as import("@earendil-works/pi-durable").LiveState | undefined;
    const last = live?.generation?.message ?? assistants.at(-1);
    const calls = assistants.flatMap(message => message.role === "assistant" ? message.content.filter(block => block.type === "toolCall") : []);
    reporter.progress({ turns: assistants.length, toolCalls: calls.length, currentTool: live?.tools?.find(tool => tool.status === "running")?.name ?? null, text: last?.role === "assistant" ? last.content.filter(block => block.type === "text").map(block => block.text).join("") : "" });
    const usage = view.docs["pi.usage"];
    if (usage) reporter.usage(totalUsage(usage as unknown as import("@earendil-works/pi-durable").UsageState));
  }
  return {
    id, label: options.label ?? "Pi durable (opt-in)", kind: "hosted", ...(options.residentModule ? { residentModule: options.residentModule } : {}),
    capabilities: Object.freeze({ recursiveFabric: false, steer: true, followUp: true, persistentSessions: false, kernels: false, handoff: false, modelDiscovery: true, imageInput: true, compaction: false, questions: false, sleep: false, writePolicy: false }),
    defaultModel: () => defaultModel,
    models: () => [...allowed.values()].flatMap(ref => {
      const model = currentModels().getModel(ref.provider, ref.modelId);
      return model ? [{ runner: id, provider: ref.provider, id: ref.modelId, key: `${ref.provider}/${ref.modelId}`, name: model.name, input: [...model.input], reasoning: model.reasoning, contextWindow: model.contextWindow, maxTokens: model.maxTokens }] : [];
    }),
    prepare(context) { if (sealed) throw new Error("Pi durable runner is closed"); validate(context); return { version: 1, backend: "pi-durable", storage: identity, runId: context.id } satisfies PiDurableLocator; },
    normalizeModel(model) { if (!allowed.has(model)) throw new Error(`Unknown or disallowed Pi durable model: ${model}`); return model; },
    mapTools(tools) { const names = new Set(options.registry.snapshot().tools().map(item => item.tool.name)); for (const tool of tools) if (!names.has(tool)) throw new Error(`Unknown Pi durable tool: ${tool}`); return [...tools]; },
    start: (loc, context, reporter) => serial(() => bind(loc, context, reporter, true)),
    attach: (loc, context, reporter) => serial(() => bind(loc, context, reporter, false)),
    steer: (value, message, data) => serial(async () => {
      const run = runs.get(locator(value).runId);
      if (!run?.controls) throw new Error("Pi durable run is not attached");
      await run.controls.send("steer", message, data);
    }),
    followUp: (value, message, data) => serial(async () => {
      const run = runs.get(locator(value).runId);
      if (!run?.controls) throw new Error("Pi durable run is not attached");
      await run.controls.send("followUp", message, data);
    }),
    liveness: value => serial(async (): Promise<FabricHostedLiveness> => {
      const run = runs.get(locator(value).runId);
      return run?.controls ? run.controls.liveness() : "unknown";
    }),
    stop: value => serial(async () => {
      const run = runs.get(locator(value).runId);
      if (!run?.controls) return { confirmed: false };
      await run.controls.stop();
      return { confirmed: true };
    }),
    close() {
      if (closing) return closing;
      sealed = true;
      closing = tail.then(async () => {
        const results = await Promise.allSettled([...runs].map(async ([id, run]) => {
          await run.watch?.stop();
          await run.harness.close((await runtime()).context.BACKGROUND_CONTEXT);
          await run.observing;
          await run.lease.release();
          owners.delete(run.ownerKey);
          runs.delete(id);
        }));
        const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Pi durable close failed; failed leases remain owned");
      });
      return closing;
    },
  };
}
