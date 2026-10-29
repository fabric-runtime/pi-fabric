// pi-fabric/durable-extension: fabric_exec as a pi-durable registry extension.
//
// A host that runs its own pi-durable Harness (no Pi session, no ExtensionAPI)
// installs createFabricExtension() next to its tool extensions. Programs run in
// the QuickJS kernel. Inside a program `tools.<name>` reaches only the tools the
// conversation lets other tools call (`Agent.callable`), narrowed further by
// `options.tools`; each call goes through `ToolExecutionApi.executeTool`, so the
// host's ToolTask hooks (tenant guards, audits) see it as a nested call. Every
// Fabric provider (memory, agents, mcp, pi.*, ...) is refused unless the host
// grants it in `options.providers`. Nothing here touches files, a shell, the
// Pi UI, compaction, prewalk or topology. See docs/durable-extension.md.
//
// The module imports pi-durable and chord for types only: the extension is a
// plain object, so it does not pin a pi-durable runtime version, and its static
// graph holds no Node-only module (scripts/assert-build-artifacts.mjs checks).
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type {
  ConversationId,
  Extension,
  JsonObject,
  NestedToolExecutionResult,
  PromptSection,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { callPreview, FabricDurableJournal, FabricDurableJournalRefusal, FABRIC_DURABLE_JOURNAL_FORMAT, maybeRanReport } from "./durable-journal.js";
import { renderDeclarations, renderToolSignature, toCodemodeIdentifier, type RenderDeclarationsOptions } from "@earendil-works/pi-codemode/declarations";
import type { FabricHostCall, FabricKernelRuntime, FabricSandboxOptions, FabricSandboxResult } from "./runtime/kernel.js";

/** One granted action of a host provider. Arguments are the program's object, copied to plain JSON. */
export type FabricDurableAction = (
  args: JsonObject,
  call: { readonly api: ToolExecutionApi; readonly context: Context },
) => unknown | Promise<unknown>;

/**
 * A granted action with its replay rule. `repeatable: true` says running it twice does no harm (a read), so after a
 * restart an interrupted call simply runs again. Otherwise it counts as an effect: an intent is recorded before it runs,
 * and if a restart interrupts it, the program stops and the model is told it may have run.
 */
export interface FabricDurableActionEntry {
  readonly run: FabricDurableAction;
  readonly repeatable?: boolean;
}

/** A provider the host grants to programs, reachable as `<name>.<action>(args)` or `fabric.tools.call({ ref: "<name>.<action>", args })`. */
export interface FabricDurableProvider {
  readonly description?: string;
  /** A bare function is an effect (not repeatable). */
  readonly actions: Readonly<Record<string, FabricDurableAction | FabricDurableActionEntry>>;
}

/** Where an internal failure happened, for `onError`. Holds no program source or arguments. */
export interface FabricDurableErrorInfo {
  readonly conversationId: ConversationId;
  readonly callId: string;
}

export interface FabricExtensionOptions {
  /** Registry extension name; pi-durable reports section errors under it. Default `pi-fabric`. */
  readonly name?: string;
  /** Tool name. Default `fabric_exec`. */
  readonly toolName?: string;
  /**
   * Host tools programs may call, by name, out of the conversation's callable tools (`Agent.callable`).
   * Omitted: every callable tool. An empty list grants none. Never widens what the conversation allows.
   */
  readonly tools?: readonly string[];
  /** Fabric providers granted to programs. Omitted: none; every provider ref is refused. */
  readonly providers?: Readonly<Record<string, FabricDurableProvider>>;
  /** Whole-program deadline in milliseconds, nested calls included. Default 30 000. */
  readonly timeoutMs?: number;
  /** QuickJS heap limit in bytes. Default 64 MiB (67 108 864). */
  readonly memoryLimitBytes?: number;
  /** Characters of `print()`/`console.*` output kept per program; more is cut with a notice. Default 20 000. */
  readonly maxLogChars?: number;
  /** Characters of the whole result the model sees; more is cut with a notice. Default 40 000. */
  readonly maxResultChars?: number;
  /** Largest JSON argument object, in UTF-8 bytes, a program may pass to one nested tool call or provider action. Default 262 144. */
  readonly maxArgumentBytes?: number;
  /** Token budget (4 characters a token) for the tool declarations in the prompt section. Default 3 000. */
  readonly sectionTokenBudget?: number;
  /**
   * A precompiled QuickJS wasm module for the default kernel, for hosts that cannot compile wasm from bytes
   * (Cloudflare Workers). It must be the `@jitl/quickjs-singlefile-mjs-release-sync` build this package depends on.
   * Ignored when `runtime` is set. Default: the module compiles the wasm it bundles.
   */
  readonly quickJsWasmModule?: WebAssembly.Module;
  /** Kernel override, for example a sandbox in another isolate. Default: the in-process QuickJS kernel. */
  readonly runtime?: FabricKernelRuntime;
  /**
   * Receives internal failures: the kernel failing to load, a bug in this extension, a granted provider action
   * throwing anything but `FabricDurableRefusal`. The model sees only a fixed error either way. Its own throw is
   * dropped. Default: none (pi-durable gives a tool no report channel).
   */
  readonly onError?: (error: unknown, info: FabricDurableErrorInfo) => void;
}

/** The defaults `createFabricExtension` applies, for hosts that want to show or derive from them. */
export const FABRIC_DURABLE_DEFAULTS = Object.freeze({
  name: "pi-fabric",
  toolName: "fabric_exec",
  timeoutMs: 30_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxLogChars: 20_000,
  maxResultChars: 40_000,
  maxArgumentBytes: 256 * 1024,
  sectionTokenBudget: 3_000,
});

const PROVIDER_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const ACTION_NAME = /^[A-Za-z_$][\w$]{0,127}$/;
const MAX_PENDING_TIMERS = 64;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_LISTED_CALLS = 20;
const CHARS_PER_TOKEN = 4;
const TEXT_OUTPUT_SCHEMA = { type: "string" } as const;
/** pi-durable's diagnostic code for a nested call a restart interrupted after it may have started its effect. */
const INTERRUPTED_CODE = "interrupted";

/**
 * Names what replays a recorded run: the journal format, this package's version and the guest engine. A resume
 * recorded under another value is refused. tests/durable-extension-replay.test.ts checks it against package.json.
 * Keep this literal host-free for Worker imports; update it alongside package.json on each release.
 */
export const FABRIC_DURABLE_ENGINE = `${FABRIC_DURABLE_JOURNAL_FORMAT}/pi-fabric@0.129.2/quickjs-singlefile-0.32`;

/**
 * Refusal raised to the program; its message reaches the program as an Error. A granted provider action may throw
 * it to show the program a message; any other error becomes the fixed `Fabric action <ref> failed`.
 */
export class FabricDurableRefusal extends Error {
  override readonly name = "FabricDurableRefusal";
}

/** Thrown into the program after the run was stopped; the model sees the stop report instead. */
class ProgramStop extends Error {}

/** A nested tool's own error text, shown to the program as the tool reported it. */
class NestedToolError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

const positive = (value: number | undefined, fallback: number, label: string): number => {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen < 1) throw new Error(`createFabricExtension: ${label} must be a positive integer`);
  return chosen;
};

let sharedKernel: Promise<FabricKernelRuntime> | undefined;
const loadKernel = (wasmModule: WebAssembly.Module | undefined): Promise<FabricKernelRuntime> => {
  const load = () => import("./runtime/quickjs-runtime.js").then(({ QuickJsRuntime }) => new QuickJsRuntime({ ...(wasmModule ? { wasmModule } : {}) }));
  if (wasmModule !== undefined) return load();
  // A failed load is not cached: the next call retries.
  sharedKernel ??= load().catch((error: unknown) => {
    sharedKernel = undefined;
    throw error;
  });
  return sharedKernel;
};

/** The text of a schema-less tool's collapsed output: a string, or the text items of an array. */
const textOf = (value: JsonValue | undefined): string => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((item) => isObject(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n");
};

/** What a program gets for a nested call, as pi-durable's codemode does. */
const outcomeOf = (name: string, structured: boolean, result: NestedToolExecutionResult): { ok: true; value: unknown } | { ok: false; message: string } => {
  const value = structured ? result.structuredOutput : textOf(result.structuredOutput);
  if (!result.isError || (structured && value !== undefined)) return { ok: true, value: value ?? null };
  const message = structured ? "" : value as string;
  const diagnostics = result.diagnostics.filter((item) => item.severity === "error").map((item) => item.message).join("\n");
  return { ok: false, message: message || diagnostics || `Tool ${name} failed` };
};

const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1);

/** Rank tools by query words in their name (weight 3) and description (weight 1). */
const searchCatalog = (tools: readonly ToolRegistration[], query: string, limit: number) => {
  const terms = words(query);
  return tools
    .map((tool, index) => {
      const name = new Set(words(tool.name));
      const description = new Set(words(tool.description));
      const score = terms.reduce((sum, term) => sum + (name.has(term) ? 3 : 0) + (description.has(term) ? 1 : 0), 0);
      return { tool, index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ tool }) => ({ name: tool.name, description: tool.description }));
};

const schemaOf = (value: unknown): Record<string, unknown> => isObject(value) ? value : {};

type DeclaredTool = NonNullable<RenderDeclarationsOptions["tools"]>[number];
type DeclaredSchema = NonNullable<DeclaredTool["inputSchema"]>;

/** Declarations never run a tool; the renderer's type still asks for `execute`. */
const notCalled = async (): Promise<never> => { throw new Error("declaration only"); };

/** A tool as pi-codemode's declaration renderer takes it: schema-less output is text. */
const declaredTool = (tool: ToolRegistration): DeclaredTool => ({
  name: tool.name,
  execute: notCalled,
  description: tool.description,
  inputSchema: schemaOf(tool.parameters) as DeclaredSchema,
  outputSchema: schemaOf(tool.structuredOutputSchema ?? TEXT_OUTPUT_SCHEMA) as DeclaredSchema,
});

/** What describeTool() returns: the description and the tool's declaration, as the section renders it. */
const describeToolText = (tool: ToolRegistration): string =>
  `${tool.description.trim()}\n\n\`\`\`ts\ndeclare const tools: { ${renderToolSignature(declaredTool(tool))} };\n\`\`\``;

/**
 * pi-codemode's declarations for the tools that fit the budget, cheapest first, rendered in the conversation's order;
 * says whether any tool was left out.
 */
const selectDeclarations = (tools: readonly ToolRegistration[], budgetTokens: number) => {
  const entries = tools.map((tool, index) => {
    const declared = declaredTool(tool);
    return { index, declared, cost: Math.ceil(renderDeclarations({ tools: [declared] }).length / CHARS_PER_TOKEN) };
  });
  let remaining = budgetTokens;
  const shown = new Set<number>();
  for (const entry of [...entries].sort((a, b) => a.cost - b.cost || a.index - b.index)) {
    if (entry.cost > remaining) break;
    remaining -= entry.cost;
    shown.add(entry.index);
  }
  return { tools: entries.filter((entry) => shown.has(entry.index)).map((entry) => entry.declared), cut: shown.size < entries.length };
};

/** Each granted provider action as a member of a `declare const <provider>` namespace. */
const providerDeclarations = (providers: ReadonlyMap<string, FabricDurableProvider>): DeclaredTool[] =>
  [...providers].flatMap(([provider, granted]) => Object.keys(granted.actions).filter((action) => ACTION_NAME.test(action)).map((action) => ({
    name: `${provider}.${action}`,
    execute: notCalled,
    inputSchema: { type: "object", additionalProperties: true } as DeclaredSchema,
  })));

interface CallRecord {
  readonly name: string;
  ok?: boolean;
}

const describeCalls = (calls: readonly CallRecord[]): string => {
  if (calls.length === 0) return "No nested calls were made.";
  const listed = calls.slice(0, MAX_LISTED_CALLS).map((call) => `${call.name} (${call.ok === undefined ? "unfinished" : call.ok ? "ok" : "failed"})`);
  const more = calls.length > MAX_LISTED_CALLS ? `, and ${calls.length - MAX_LISTED_CALLS} more` : "";
  return `Nested calls made before the error (they are not undone): ${listed.join(", ")}${more}.`;
};

/** Add execution cancellation without importing a host runtime or losing context values. */
const withExecutionSignal = (context: Context, signal: AbortSignal): Context => ({
  abortSignal: context.abortSignal === undefined ? signal : AbortSignal.any([context.abortSignal, signal]),
  get telemetry() { return context.telemetry; },
  value: (key) => context.value(key),
  toString: () => context.toString(),
});

const cut = (text: string, max: number, what: string): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n[${what} truncated: ${max} of ${text.length} characters shown]`;

/** The fabric_exec tool and its prompt section, as one pi-durable extension. */
export function createFabricExtension(options: FabricExtensionOptions = {}): Extension {
  const d = FABRIC_DURABLE_DEFAULTS;
  const name = options.name ?? d.name;
  const toolName = options.toolName ?? d.toolName;
  const timeoutMs = positive(options.timeoutMs, d.timeoutMs, "timeoutMs");
  const memoryLimitBytes = positive(options.memoryLimitBytes, d.memoryLimitBytes, "memoryLimitBytes");
  const maxLogChars = positive(options.maxLogChars, d.maxLogChars, "maxLogChars");
  const maxResultChars = positive(options.maxResultChars, d.maxResultChars, "maxResultChars");
  const maxArgumentBytes = positive(options.maxArgumentBytes, d.maxArgumentBytes, "maxArgumentBytes");
  const sectionTokenBudget = positive(options.sectionTokenBudget, d.sectionTokenBudget, "sectionTokenBudget");
  const toolAllowlist = options.tools === undefined ? undefined : new Set(options.tools);
  const providers = new Map<string, FabricDurableProvider>();
  for (const [provider, granted] of Object.entries(options.providers ?? {})) {
    if (!PROVIDER_NAME.test(provider)) throw new Error(`Invalid Fabric provider name: ${provider}`);
    providers.set(provider, granted);
  }

  const report = (error: unknown, info: FabricDurableErrorInfo): void => {
    try {
      options.onError?.(error, info);
    } catch {
      // A throwing onError must not change the tool call.
    }
  };

  /** The host's tools a program may call: callable in this conversation, granted, never fabric_exec itself. */
  const grantedTools = (callable: readonly ToolRegistration[]): ToolRegistration[] =>
    callable.filter((tool) => tool.name !== toolName && (toolAllowlist === undefined || toolAllowlist.has(tool.name)));

  /** Copy a program value into plain JSON within the argument cap: no prototypes, getters or cycles cross into the host. */
  const copyArguments = (value: unknown, target: string): JsonObject => {
    if (value === undefined) value = {};
    if (!isObject(value)) throw new FabricDurableRefusal(`${target} takes one argument object`);
    const json = JSON.stringify(value);
    if (utf8Bytes(json) > maxArgumentBytes) {
      throw new FabricDurableRefusal(`${target} arguments exceed ${maxArgumentBytes} bytes`);
    }
    return JSON.parse(json) as JsonObject;
  };

  const hostCall = (
    api: ToolExecutionApi,
    context: Context,
    calls: CallRecord[],
    journal: FabricDurableJournal | undefined,
    stop: (report: string) => never,
    stopped: () => boolean,
  ): FabricHostCall => {
    const info = { conversationId: api.conversationId, callId: api.callId };
    // Per program: the catalog is read from this call's own conversation and never shared.
    let catalog: Promise<ToolRegistration[]> | undefined;
    const tools = () => catalog ??= api.agent(context).then((agent) => grantedTools(agent.callable));
    const granted = async (toolNameArg: unknown): Promise<ToolRegistration> => {
      // By name, or by the identifier the declarations show for a name that is not one.
      const tool = typeof toolNameArg === "string"
        ? (await tools()).find((item) => item.name === toolNameArg) ?? (await tools()).find((item) => toCodemodeIdentifier(item.name) === toolNameArg)
        : undefined;
      if (tool === undefined) throw new FabricDurableRefusal(`Tool not granted by this host: ${String(toolNameArg)}`);
      return tool;
    };
    const grantedAction = (ref: unknown): { ref: string; action: FabricDurableAction; repeatable: boolean } => {
      if (typeof ref !== "string") throw new FabricDurableRefusal("Fabric ref must be a string");
      const dot = ref.indexOf(".");
      const provider = dot < 0 ? ref : ref.slice(0, dot);
      const actionName = dot < 0 ? "" : ref.slice(dot + 1);
      const grantedProvider = providers.get(provider);
      if (grantedProvider === undefined) throw new FabricDurableRefusal(`Fabric provider not granted by this host: ${provider}`);
      const entry = ACTION_NAME.test(actionName) && Object.hasOwn(grantedProvider.actions, actionName) ? grantedProvider.actions[actionName] : undefined;
      const action = typeof entry === "function" ? entry : isObject(entry) && typeof entry.run === "function" ? entry.run as FabricDurableAction : undefined;
      if (action === undefined) throw new FabricDurableRefusal(`Fabric action not granted by this host: ${ref}`);
      return { ref, action, repeatable: typeof entry === "object" && entry.repeatable === true };
    };
    const checkActive = (signal: AbortSignal): void => {
      if (stopped()) throw new ProgramStop("fabric_exec stopped");
      context.abortSignal?.throwIfAborted();
      signal.throwIfAborted();
    };
    const runAction = async (ref: unknown, args: unknown, seq: number | undefined, signal: AbortSignal): Promise<unknown> => {
      const { ref: resolved, action, repeatable } = grantedAction(ref);
      const copied = copyArguments(args, resolved);
      // An effect is recorded before it runs, so a resume knows it may have run and does not repeat it.
      if (!repeatable && journal !== undefined && seq !== undefined) await journal.intent(seq, resolved);
      // Persistence can outlive the execution deadline. Never start the effect after it settles.
      checkActive(signal);
      try {
        const value = await action(copied, { api, context: withExecutionSignal(context, signal) });
        return value === undefined ? null : JSON.parse(JSON.stringify(value)) as unknown;
      } catch (error) {
        if (error instanceof FabricDurableRefusal) throw new FabricDurableRefusal(error.message);
        report(error, info);
        throw new FabricDurableRefusal(`Fabric action ${resolved} failed`);
      }
    };
    const dispatch: FabricHostCall = async (ref, args, signal, _humanWait, call) => {
      switch (ref) {
        case "fabric.$piAllTools":
          // `jsName` is the identifier pi-codemode's declarations use for a name that is not one (`my-tool` -> `my_tool`).
          return (await tools()).map((tool) => {
            const jsName = toCodemodeIdentifier(tool.name);
            return { name: tool.name, description: tool.description, ...(jsName === tool.name ? {} : { jsName }) };
          });
        case "fabric.$piSearch": {
          if (typeof args.query !== "string") throw new FabricDurableRefusal("searchTools() expects a query string");
          const limit = args.limit ?? DEFAULT_SEARCH_LIMIT;
          if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) throw new FabricDurableRefusal("searchTools() limit must be a positive integer");
          return searchCatalog(await tools(), args.query, limit);
        }
        case "fabric.$piDescribe": {
          const tool = await granted(args.name);
          return describeToolText(tool);
        }
        case "fabric.$nativeTool": {
          const tool = await granted(args.name);
          const copied = copyArguments(args.args, tool.name);
          const record: CallRecord = { name: tool.name };
          calls.push(record);
          // The issue number keys the nested call, so a resumed program gets the same call back, finished or still
          // running, and never starts a second one.
          let result: NestedToolExecutionResult;
          try {
            checkActive(signal);
            result = await api.executeTool(tool.name, copied, withExecutionSignal(context, signal), call === undefined ? {} : { key: `f${call.seq}` });
          } catch (error) {
            if (call !== undefined && error instanceof Error && /already made with another tool or other arguments/.test(error.message)) {
              stop(`fabric_exec could not resume after an interruption: the program did not repeat its recorded call ${call.seq + 1}. No call after the divergence ran.`);
            }
            throw error;
          }
          if (result.diagnostics.some((item) => item.code === INTERRUPTED_CODE)) {
            // A restart cut this call off after it may have taken effect: stop rather than guess.
            stop(maybeRanReport(callPreview("fabric.$nativeTool", { name: tool.name, args: copied }), journal?.replayedCalls() ?? 0));
          }
          const outcome = outcomeOf(tool.name, tool.structuredOutputSchema !== undefined, result);
          record.ok = outcome.ok;
          if (!outcome.ok) throw new NestedToolError(outcome.message);
          return outcome.value;
        }
        case "fabric.$providers":
          return [...providers].map(([provider, entry]) => ({ name: provider, description: entry.description ?? "", actions: Object.keys(entry.actions) }));
        case "fabric.$call":
          return runAction(args.ref, args.args, call?.seq, signal);
        default:
          // pi.*, agents.*, memory.*, mcp.*, jev.*, mesh.*, native.*, models and every other fabric.$ ref.
          throw new FabricDurableRefusal(`Not available in this durable host: ${ref}`);
      }
    };
    // Only refusals and a tool's own error text reach the program; any other host error (storage, a bug, an
    // abort) may hold paths or secrets, so it goes to onError and the program sees a fixed message.
    return async (ref, args, ...rest) => {
      // Once the run is stopped, nothing more reaches the host, even if the program caught the stop.
      if (stopped()) throw new ProgramStop("fabric_exec stopped");
      try {
        checkActive(rest[0]);
        return await dispatch(ref, args, ...rest);
      } catch (error) {
        if (error instanceof FabricDurableRefusal || error instanceof NestedToolError || error instanceof ProgramStop) throw error;
        report(error, info);
        throw new FabricDurableRefusal("Fabric host call failed");
      }
    };
  };

  const formatResult = (result: FabricSandboxResult, calls: readonly CallRecord[], stopReport: string | undefined): ToolExecutionResult => {
    // A resume that stopped (a call that may have run, a divergence) shows only its report.
    if (stopReport !== undefined) return { output: [{ type: "text", text: cut(stopReport, maxResultChars, `${toolName} output`) }], isError: true };
    const parts = [...result.logs];
    const failed = result.terminationReason !== "completed";
    if (failed) {
      parts.push(`Error (${result.terminationReason}): ${result.error ?? "program failed"}`, describeCalls(calls));
    } else if (result.value !== undefined) {
      parts.push(typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2));
    }
    const text = cut(parts.join("\n") || "(no result)", maxResultChars, `${toolName} output`);
    return { output: [{ type: "text", text }], ...(failed ? { isError: true } : {}) };
  };

  const internalError: ToolExecutionResult = {
    output: [{ type: "text", text: `${toolName} failed with an internal error. The program may not have run.` }],
    isError: true,
  };

  const tool: ToolRegistration = {
    name: toolName,
    description:
      "Run a TypeScript program in a sandbox. `tools.<name>(args)` calls this conversation's tools and returns their output; " +
      "run independent calls together with Promise.all. `searchTools(query)` and `describeTool(name)` find tools the prompt does not list. " +
      "`print()` logs; the program's return value is the result. No files, shell or network.",
    parameters: Type.Object({
      code: Type.String({ description: "TypeScript function body; top-level await and return are supported." }),
      payloads: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Named strings readable as π.<key>." })),
    }),
    // Rerun after a restart: the journal serves every recorded result, nested calls keep their keys, and a call that
    // may have taken effect stops the program instead of running twice.
    replay: "safe",
    // Programs cannot start programs.
    callers: ["model"],
    // This tool cuts its own output with a notice; the Harness limit only stops a runaway.
    outputLimits: { maxBytes: maxResultChars * 4 + 4_096, maxLines: 1_000_000 },
    async execute(args, api, context) {
      try {
        const input = args as { code: string; payloads?: Record<string, string> };
        const runtime = options.runtime ?? await loadKernel(options.quickJsWasmModule);
        const calls: CallRecord[] = [];
        const info = { conversationId: api.conversationId, callId: api.callId };
        const identity = {
          code: input.code,
          payloads: input.payloads ?? {},
          limits: [timeoutMs, memoryLimitBytes, maxLogChars],
          tools: toolAllowlist === undefined ? null : [...toolAllowlist].sort(),
          providers: [...providers].map(([provider, entry]) => [provider, Object.keys(entry.actions).sort()]),
        };
        let journal: FabricDurableJournal;
        try {
          journal = await FabricDurableJournal.open(api, context, identity, FABRIC_DURABLE_ENGINE, { onWriteError: (error) => report(error, info) });
        } catch (error) {
          if (error instanceof FabricDurableJournalRefusal) return { output: [{ type: "text", text: error.message }], isError: true };
          throw error;
        }
        let stopReport: string | undefined;
        const halt = new AbortController();
        const stop = (text: string): never => {
          stopReport ??= text;
          halt.abort(new Error(text));
          throw new ProgramStop(text);
        };
        const signal = context.abortSignal === undefined ? halt.signal : AbortSignal.any([context.abortSignal, halt.signal]);
        const sandbox: FabricSandboxOptions = {
          journal,
          timeoutMs,
          memoryLimitBytes,
          maxLogChars,
          maxPendingTimers: MAX_PENDING_TIMERS,
          codemodeProfile: "native",
          nativeToolsEnabled: true,
          nativeStoreEnabled: false,
          providerGlobals: [...providers.keys()],
          ...(input.payloads === undefined ? {} : { strings: { ...input.payloads } }),
          signal,
        };
        let settled = false;
        try {
          const result = await runtime.execute(input.code, hostCall(api, withExecutionSignal(context, signal), calls, journal, stop, () => settled || stopReport !== undefined), sandbox);
          return formatResult(result, calls, stopReport ?? journal.stopReport);
        } finally {
          // Runtime overrides can retain a dispatcher or leave host calls pending too.
          settled = true;
          halt.abort(new Error("fabric_exec execution ended"));
        }
      } catch (error) {
        report(error, { conversationId: api.conversationId, callId: api.callId });
        return internalError;
      }
    },
  };

  const guidance: PromptSection = {
    key: "fabric",
    render: (input) => {
      const callable = grantedTools(input.agent.callable);
      // Deferred tools stay callable but unlisted, as pi-durable's codemode does.
      const listed = callable.filter((item) => item.deferred !== true);
      const { tools: shown, cut: budgetCut } = selectDeclarations(listed, sectionTokenBudget);
      const hidden = budgetCut || listed.length < callable.length;
      const granted = [...providers.keys()];
      const declarations = renderDeclarations({ tools: shown, globals: providerDeclarations(providers) });
      return [
        `Use ${toolName} to batch several tool calls in one TypeScript program and return only the compact result.`,
        callable.length === 0 ? "Programs can call no tools here." : "Tools programs can call (`await tools.<name>(args)`):",
        ...(declarations === "" ? [] : ["```ts", declarations, "```"]),
        ...(hidden ? ["Some tools are not listed: find them with `searchTools(query)` and read one with `describeTool(name)`."] : []),
        granted.length
          ? `Granted providers: ${granted.map((provider) => { const about = providers.get(provider)?.description?.trim(); return about ? `${provider} (${about})` : provider; }).join(", ")}.`
          : "No Fabric providers are available.",
      ].join("\n");
    },
  };

  return { name, tools: [tool], sections: [guidance] };
}
