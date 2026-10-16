import releaseSyncVariant from "@jitl/quickjs-singlefile-mjs-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import ts from "typescript";
import { runAbortable, settleWithin } from "../async-settlement.js";
import { piBashExitMetadata } from "../core/pi-bash-error.js";
import { PI_ARGUMENT_NORMALIZATION_SOURCE } from "../core/pi-arguments.js";
import { PI_CORE_TOOL_NAMES } from "../core/pi-tools.js";
import { HumanWaitDeadlinePause } from "./deadline-pause.js";
import { createGuestStackMap, remapGuestErrorText } from "./guest-stack-map.js";
import { transpileFabricCodeWithSourceMap } from "./type-checker.js";

import type {
  FabricHostCall,
  FabricSandboxOptions,
  FabricSandboxResult,
  FabricSandboxTerminationReason,
} from "./kernel.js";
// Preserve existing import paths for runtime consumers.
export type {
  FabricHostCall,
  FabricSandboxOptions,
  FabricSandboxResult,
  FabricSandboxTerminationReason,
} from "./kernel.js";

type QuickJsModule = Awaited<ReturnType<typeof newQuickJSWASMModuleFromVariant>>;

let quickJsModulePromise: Promise<QuickJsModule> | undefined;

// Static π.<identifier> references (bracket access like π[k] is not provable).
// Parse instead of scanning text so examples inside strings and comments do not
// become false missing-payload failures.
const referencedPiKeys = (code: string): string[] => {
  const source = ts.createSourceFile(
    "fabric-exec.ts",
    `async function __fabricProgram() {\n${code}\n}`,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const keys: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "π" &&
      !keys.includes(node.name.text)
    ) {
      keys.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return keys;
};

// Models routinely reference π.<key> without providing the payloads parameter,
// and the runtime error only lands after a full execution round trip (#68).
// Reject up front when a referenced key is statically provable missing, before
// QuickJS is even loaded.
const missingStringsKeys = (
  code: string,
  strings: Record<string, string> | undefined,
): string[] => {
  const provided = strings ?? {};
  return referencedPiKeys(code).filter((key) => !(key in provided));
};

const quickJsModule = (): Promise<QuickJsModule> => {
  quickJsModulePromise ??= newQuickJSWASMModuleFromVariant(releaseSyncVariant);
  return quickJsModulePromise;
};

export const guestSetupSource = (fields?: Record<string, string[]>, nativeStoreEnabled = false, profile = "additive", nativeToolsEnabled = false): string =>
  `const __piCanonicalFields = ${JSON.stringify(fields ?? {})}; const __nativeStoreEnabled = ${nativeStoreEnabled}; const __nativeProfile = ${profile === "native"}; const __nativeToolsEnabled = ${nativeToolsEnabled};\n${GUEST_SETUP}`;

import { NATIVE_CODEMODE_GUEST } from "./native-codemode-guest.js";

export const GUEST_SETUP = `
(() => {
const __fabricBridge = globalThis.__fabricHostCall;
delete globalThis.__fabricHostCall;
const __successfulCalls = [];
const __resolvedCallRef = (ref, args) =>
  ref === "fabric.$call" && args && typeof args.ref === "string" ? args.ref : ref;
const __recordSuccessfulCall = (ref, args) => {
  __successfulCalls.push(Object.freeze({ ref: __resolvedCallRef(ref, args) }));
};
const __handoffFacts = () => {
  const calls = Object.freeze(__successfulCalls.slice());
  const count = (ref) => {
    if (ref === undefined) return calls.length;
    const refs = new Set(Array.isArray(ref) ? ref : [ref]);
    return calls.reduce((total, call) => total + (refs.has(call.ref) ? 1 : 0), 0);
  };
  return Object.freeze({ calls, count });
};
const __call = async (ref, args) => {
  const normalizedArgs = args ?? {};
  const value = await __fabricBridge(ref, normalizedArgs);
  __recordSuccessfulCall(ref, normalizedArgs);
  return value;
};
const __toolsBase = {
  providers: () => __call("fabric.$providers", {}),
  catalog: (args = {}) => __call("fabric.$catalog", args),
  list: (args = {}) => __call("fabric.$list", args),
  search: (args) => __call(
    "fabric.$search",
    typeof args === "string" ? { query: args } : args,
  ),
  describe: (args) => __call("fabric.$describe", args),
  call: (args) => __call("fabric.$call", args),
  progress: (args) => __call("fabric.$progress", args),
  models: () => __call("fabric.$models", {}),
};
${NATIVE_CODEMODE_GUEST}
const __nativeToolNames = new Set();
let __nativeCatalogReady = false;
globalThis.nativeTools = new Proxy(Object.create(null), {
  get(_target, property) {
    if (typeof property === "symbol" || (__nativeCatalogReady ? !__nativeToolNames.has(property) : property === "then")) return undefined;
    return args => __call("fabric.$nativeTool", { name: String(property), args: args === undefined ? {} : args });
  },
  ownKeys() { return [...__nativeToolNames]; },
  getOwnPropertyDescriptor(_target, property) { return __nativeToolNames.has(property) ? {enumerable:true, configurable:true} : undefined; },
  set() { return true; },
  deleteProperty() { return true; },
});
const __fabricTools = new Proxy(__toolsBase, {
  get(target, property) {
    if (property === "then" || typeof property === "symbol") return undefined;
    return Object.prototype.hasOwnProperty.call(target, property) ? target[property] : globalThis.nativeTools[property];
  },
  set() { return true; },
  deleteProperty() { return true; },
});
globalThis.fabric = Object.freeze({ tools: __fabricTools });
globalThis.tools = typeof __nativeProfile !== "undefined" && __nativeProfile ? globalThis.nativeTools : __fabricTools;
const __piStringFields = { bash: "command", powershell: "command", read: "path", ls: "path", grep: "pattern", find: "pattern" };
// Object aliases and coercions are shared with host preparation in core/pi-arguments.ts.

// Multi-arg positional order, used only when a call passes >= 2 args and the
// (primary, options) merge in __positionalToArgs does not apply. One-field
// tools (read/bash/ls) stay absent: their two-arg form is a bare string plus
// an options object, repaired by the merge instead of a wrong-arity (2554)
// type error; only a non-object second arg still fails 2554.
const __piPositionalFields = {
  grep: ["pattern", "path", "limit"],
  find: ["pattern", "path", "limit"],
  write: ["path", "content"],
  edit: ["path", "oldText", "newText"],
};

// (primary, options) two-arg merge for the string-primary tools:
// pi.read("index.ts", { limit: 120 }) becomes { path: "index.ts", limit: 120 }.
// A plain-object second arg is never a valid positional value for these tools
// (grep/find take (pattern, path, limit) strings/numbers), so merging is
// unambiguous; the positional string wins the primary field on conflict. The
// merged object flows through the same alias, unit, and numeric normalization
// in __normalizePiArgs as any other options object.
const __positionalToArgs = (name, rest) => {
  const first = rest[0];
  const second = rest[1];
  const primaryField = __piStringFields[name];
  if (
    rest.length === 2 &&
    typeof first === "string" &&
    primaryField !== undefined &&
    second !== null && typeof second === "object" && !Array.isArray(second)
  ) {
    const merged = { ...second };
    merged[primaryField] = first;
    return merged;
  }
  const order = __piPositionalFields[name];
  if (!order) return rest.length > 0 ? first : {};
  const out = {};
  for (let i = 0; i < rest.length && i < order.length; i++) {
    const v = rest[i];
    if (v !== undefined) out[order[i]] = v;
  }
  return out;
};
${PI_ARGUMENT_NORMALIZATION_SOURCE}
// shell/edit/write resolve envelope objects { ok, output, details }, and the
// type-checker deliberately suppresses property-miss (2339) diagnostics, so
// result.trim() on an envelope typechecks and then dies with QuickJS's terse
// "not a function" — an error models cannot localize (observed: misdirected
// debugging spirals probing unrelated globals). Guard envelopes with a proxy
// that throws an actionable TypeError for string-method access and iteration,
// naming the tool and the .output fix. Ordinary reads (ok/output/details/
// exitCode/error), destructuring, 'in' checks, and JSON marshaling pass through.
const __piEnvelopeTools = { bash: true, powershell: true, edit: true, write: true };
const __piEnvelopeStringTraps = new Set([
  "anchor", "at", "big", "blink", "bold", "charAt", "charCodeAt", "codePointAt",
  "concat", "endsWith", "fixed", "fontcolor", "fontsize", "includes", "indexOf",
  "italics", "lastIndexOf", "length", "link", "localeCompare", "match", "matchAll",
  "normalize", "padEnd", "padStart", "repeat", "replace", "replaceAll", "search",
  "slice", "small", "split", "startsWith", "strike", "sub", "substr", "substring",
  "sup", "toLocaleLowerCase", "toLocaleUpperCase", "toLowerCase", "toUpperCase",
  "trim", "trimEnd", "trimStart",
]);
const __piEnvelopeGuard = (name, value) => {
  if (value === null || typeof value !== "object" || typeof value.ok !== "boolean") return value;
  return new Proxy(value, {
    get(target, property, receiver) {
      if (property === Symbol.iterator || property === Symbol.asyncIterator) {
        throw new TypeError(
          "pi." + name + "(...) resolves an envelope { ok, output, details }, which is not iterable. " +
          "Iterate the text instead: (await pi." + name + "(...)).output.split('\\\\n')"
        );
      }
      if (typeof property === "string" && __piEnvelopeStringTraps.has(property)) {
        throw new TypeError(
          "pi." + name + "(...) resolves an envelope { ok, output, details }, not a string, so ." + property +
          " is unavailable on it. Read the text first: const out = (await pi." + name + "(...)).output; then out." + property +
          "(...). Shell commands reject on a nonzero exit — pass settle: true to receive an ok:false envelope instead."
        );
      }
      return Reflect.get(target, property, receiver);
    },
  });
};
// The pi proxy accepts: a bare string (primary field), an options object, a
// (primary, options) two-arg merge for the string-primary tools, or a
// positional spread mapped by __piPositionalFields. 0/1 args preserve the
// legacy (args = {}) default so existing programs are unchanged.
globalThis.pi = new Proxy({}, {
  get(_target, property) {
    if (property === "then") return undefined;
    const name = String(property);
    return (...rest) => {
      let args;
      if (rest.length <= 1) {
        const first = rest.length === 1 ? rest[0] : undefined;
        args = first === undefined ? {} : first;
      } else {
        args = __positionalToArgs(name, rest);
      }
      // Shell tools reject on an ordinary nonzero exit; settle:true returns
      // {ok:false, exitCode, ...} instead (opt-in). Other failures still reject.
      const settle = (name === "bash" || name === "powershell") &&
        typeof args === "object" && args !== null && args.settle === true;
      const call = __call("pi." + name, __normalizePiArgs(name, args, typeof __piCanonicalFields === "undefined" ? undefined : __piCanonicalFields[name]));
      const promise = settle ? call.catch((error) => {
        // node-process bridge errors originate in a different VM realm.
        const message = typeof error?.message === "string" ? error.message : String(error);
        const exit = error?.__fabricBashExit;
        if (!exit || !Number.isSafeInteger(exit.exitCode) || exit.exitCode <= 0 ||
            typeof exit.output !== "string") throw error;
        return {
          ok: false,
          output: exit.output,
          details: null,
          exitCode: exit.exitCode,
          error: message,
        };
      }) : call;
      return __piEnvelopeTools[name] === true
        ? promise.then((value) => __piEnvelopeGuard(name, value))
        : promise;
    };
  },
});
const __piToolNames = ${JSON.stringify(PI_CORE_TOOL_NAMES)};
const __piStrings = (typeof globalThis["π"] === "object" && globalThis["π"] !== null) ? globalThis["π"] : {};
globalThis["π"] = new Proxy(__piStrings, {
  get(target, property) {
    if (typeof property === "symbol") return undefined;
    const name = String(property);
    if (name === "then" || name === "toJSON" || name === "constructor") return undefined;
    if (Object.prototype.hasOwnProperty.call(target, name)) return target[name];
    if (__piToolNames.indexOf(name) >= 0) {
      throw new Error(
        "π." + name + " is the strings accessor, not a tool. For the Pi core tool, call pi." + name + "(args)."
      );
    }
    const provided = Object.keys(target);
    throw new Error(
      "π." + name + " is not defined. π only exposes keys from the fabric_exec payloads parameter" +
      (provided.length ? " (provided: " + provided.join(", ") + ")" : " (none provided)") +
      ". Pass payloads: { " + name + ": '...' } to use π." + name + "." +
      " For large or quote-heavy content, keep it in top-level payloads and reference π." + name + " instead of escaping it inside code."
    );
  },
  ownKeys(target) { return Reflect.ownKeys(target); },
  getOwnPropertyDescriptor(target, prop) { return Reflect.getOwnPropertyDescriptor(target, prop); },
  has(target, prop) { return Object.prototype.hasOwnProperty.call(target, prop); }
});
// Stable providers share a lazy dispatch proxy; the guest declarations keep
// their known actions typed while the registry remains the runtime authority.
// extensions' per-tool surface is additionally rendered from the captured
// catalog by guestTypeDeclarations (runtime/dynamic-guest-types.ts).
const __memorySelectionKeys = [
  "indices",
  "entryIds",
  "operationAddresses",
  "entryRange",
  "index",
  "entry_ids",
  "operation_addresses",
  "entry_range",
];
const __hasMemorySelection = (args) => __memorySelectionKeys.some((key) => {
  const value = args[key];
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
});
const __memoryWalk = async (args, visitor) => {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new TypeError("memory.walk expects an expansion options object");
  }
  if (typeof visitor !== "function") {
    throw new TypeError("memory.walk expects a visitor function as its second argument");
  }

  let request = { ...args };
  if (Number(request.textOffset ?? request.text_offset ?? 0) !== 0) {
    throw new TypeError("memory.walk must start at text offset 0 to yield complete entries");
  }
  if (!__hasMemorySelection(request)) {
    if (request.entryOffset !== undefined || request.entry_offset !== undefined ||
        request.textOffset !== undefined || request.text_offset !== undefined) {
      throw new TypeError("memory.walk continuation offsets require an explicit selection");
    }
    if (Number(request.before ?? 0) > 0 || Number(request.after ?? 0) > 0) {
      throw new TypeError("memory.walk before/after requires an explicit selection");
    }
    const head = await __call("memory.expand", request);
    if (!head || typeof head !== "object") {
      throw new Error("memory.expand returned an invalid metadata response");
    }
    if (head.error) return { visited: 0, stopped: false, error: head.error };
    if (!Number.isSafeInteger(head.entryCount) || head.entryCount < 0) {
      throw new Error("memory.expand metadata omitted a valid entryCount");
    }
    if (head.entryCount === 0) return { visited: 0, stopped: false };
    request = {
      ...request,
      session: head.session ?? request.session,
      expectedSourceHash: head.sourceHash,
      expectedLineageFingerprint: head.lineageFingerprint,
      branches: head.branches,
      entryRange: { first: 0, last: head.entryCount - 1 },
    };
  }

  let visited = 0;
  let pending = null;
  let pendingStart = 0;
  let pendingEnd = 0;
  let pendingTotal = 0;
  const seen = new Set([JSON.stringify({ ref: "memory.expand", args: request })]);
  let page = await __call("memory.expand", request);

  while (true) {
    if (!page || typeof page !== "object") {
      throw new Error("memory.expand returned an invalid page");
    }
    if (page.error) return { visited, stopped: false, error: page.error };
    if (!Array.isArray(page.entries)) {
      throw new Error("memory.expand page omitted entries");
    }

    for (const chunk of page.entries) {
      if (!chunk || typeof chunk !== "object" || typeof chunk.text !== "string") {
        throw new Error("memory.expand returned an invalid entry chunk");
      }
      const range = chunk.textRange;
      if (!range || typeof range !== "object" ||
          !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
          !Number.isSafeInteger(range.total) || range.start < 0 ||
          range.end < range.start || range.total < range.end) {
        throw new Error("memory.expand returned an invalid textRange");
      }
      if (chunk.text.length !== range.end - range.start) {
        throw new Error("memory.expand entry chunk disagrees with textRange");
      }

      if (pending === null) {
        pending = { ...chunk, text: "" };
        pendingStart = range.start;
        pendingEnd = range.start;
        pendingTotal = range.total;
      } else if (pending.index !== chunk.index) {
        throw new Error("memory.expand advanced before completing an entry");
      }
      if (range.start !== pendingEnd || range.total !== pendingTotal) {
        throw new Error("memory.expand returned discontinuous entry chunks");
      }
      for (const key of Object.keys(chunk)) {
        if (pending[key] === undefined) pending[key] = chunk[key];
      }
      pending.text += chunk.text;
      pendingEnd = range.end;

      if (range.complete) {
        pending.textRange = {
          start: pendingStart,
          end: pendingEnd,
          total: pendingTotal,
          complete: true,
        };
        const entry = pending;
        pending = null;
        const keepGoing = await visitor(entry, visited);
        visited += 1;
        if (keepGoing === false) return { visited, stopped: true };
      }
    }

    if (page.next === null || page.next === undefined) {
      if (pending !== null) {
        throw new Error("memory.expand ended before completing an entry");
      }
      return { visited, stopped: false };
    }
    if (page.next.ref !== "memory.expand" || !page.next.args ||
        typeof page.next.args !== "object" || Array.isArray(page.next.args)) {
      throw new Error("memory.expand returned an invalid continuation");
    }
    const continuationKey = JSON.stringify(page.next);
    if (seen.has(continuationKey)) {
      throw new Error("memory.expand returned a cyclic continuation");
    }
    seen.add(continuationKey);
    page = await __call(page.next.ref, page.next.args);
  }
};

const __providerProxy = (provider, local = {}) => new Proxy(local, {
  get(target, property) {
    if (property === "then" || typeof property === "symbol") return undefined;
    if (Object.prototype.hasOwnProperty.call(target, property)) return target[property];
    return (args = {}) => __call(provider + "." + String(property), args);
  },
});
globalThis.extensions = __providerProxy("extensions");
globalThis.memory = __providerProxy("memory", { walk: __memoryWalk });
globalThis.state = __providerProxy("state");
globalThis.schema = __providerProxy("schema");
globalThis.components = __providerProxy("components");
globalThis.compact = __providerProxy("compact");
globalThis.cache = __providerProxy("cache");
globalThis.thinking = __providerProxy("thinking");
globalThis.decisions = __providerProxy("decisions");
globalThis.programs = __providerProxy("programs");
globalThis.prewalk = __providerProxy("prewalk");
globalThis.jev = __providerProxy("jev");
const __createActor = async (args = {}) => {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new TypeError("agents.create expects an options object");
  }
  const request = { ...args };
  const validWhile = request.validWhile;
  if (validWhile !== undefined) {
    if (typeof validWhile !== "function") {
      throw new TypeError("agents.create validWhile must be a pure predicate function");
    }
    const source = Function.prototype.toString.call(validWhile);
    if (source.trimStart().startsWith("async")) {
      throw new TypeError("agents.create validWhile must be synchronous");
    }
    request.validWhile = { version: 1, source };
  }
  return __call("agents.create", request);
};
const __handoff = async (args = {}) => {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new TypeError("agents.handoff expects an options object");
  }
  const request = { ...args };
  const when = request.when;
  delete request.when;
  if (when !== undefined) {
    if (typeof when !== "function") {
      throw new TypeError("agents.handoff when must be a pure predicate function");
    }
    const decision = when(__handoffFacts());
    if (decision && typeof decision.then === "function") {
      throw new TypeError("agents.handoff when must return a boolean synchronously");
    }
    if (decision !== true) {
      throw new Error("agents.handoff predicate returned false; no agent was started");
    }
  }
  return __call("agents.handoff", request);
};
globalThis.agents = Object.freeze({
  run: (args) => __call("agents.run", args),
  handoff: __handoff,
  spawn: (args) => __call("agents.spawn", args),
  wait: (args) => __call("agents.wait", args),
  join: (args) => __call("agents.join", args),
  status: (args) => __call("agents.status", args),
  list: (args = {}) => __call("agents.list", args),
  members: (args = {}) => __call("agents.members", args),
  self: () => __call("agents.self", {}),
  main: () => __call("agents.main", {}),
  sessions: () => __call("agents.sessions", {}),
  peers: () => __call("agents.peers", {}),
  subscribe: (args) => __call("agents.subscribe", args),
  subscriptions: (args = {}) => __call("agents.subscriptions", args),
  unsubscribe: (args) => __call("agents.unsubscribe", args),
  models: (args = {}) => __call("agents.models", args),
  stop: (args) => __call("agents.stop", args),
  cleanup: (args) => __call("agents.cleanup", args),
  create: __createActor,
  ask: (args) => __call("agents.ask", args),
  tell: (args) => __call("agents.tell", args),
  steer: (args) => __call("agents.steer", args),
  followUp: (args) => __call("agents.followUp", args),
  setSteeringMode: (args) => __call("agents.setSteeringMode", args),
  setFollowUpMode: (args) => __call("agents.setFollowUpMode", args),
  compact: (args) => __call("agents.compact", args),
  actorStatus: (args) => __call("agents.actorStatus", args),
  setModel: (args) => __call("agents.setModel", args),
  switchModel: (args) => __call("agents.switchModel", args),
  setThinking: (args) => __call("agents.setThinking", args),
  setTools: (args) => __call("agents.setTools", args),
  setEvents: (args) => __call("agents.setEvents", args),
  setDeliveryPolicy: (args) => __call("agents.setDeliveryPolicy", args),
  clearMessages: (args) => __call("agents.clearMessages", args),
  setInstructions: (args) => __call("agents.setInstructions", args),
  actors: () => __call("agents.actors", {}),
  messages: (args) => __call("agents.messages", args),
  remove: (args) => __call("agents.remove", args),
  // Keyword keys for the actor-template routes, spelled as the provider,
  // audit projection, and docs already spell them.
  "import": (args) => __call("agents.import", args),
  "export": (args) => __call("agents.export", args),
  log: (args) => __call("agents.log", args),
});
globalThis.mesh = Object.freeze({
  self: () => __call("mesh.self", {}),
  publish: (args) => __call("mesh.publish", args),
  read: (args = {}) => __call("mesh.read", args),
  members: (args = {}) => __call("mesh.members", args),
  get: (args) => __call("mesh.get", args),
  list: (args = {}) => __call("mesh.list", args),
  put: (args) => __call("mesh.put", args),
  delete: (args) => __call("mesh.delete", args),
  scheduled: (args = {}) => __call("mesh.scheduled", args),
  unschedule: (args) => __call("mesh.unschedule", args),
  grant: (args) => __call("mesh.grant", args),
  revoke: (args) => __call("mesh.revoke", args),
  grants: () => __call("mesh.grants", {}),
});
// The mcp proxy itself stays schema-less — the registry validates args at
// dispatch — but guestTypeDeclarations renders per-server argument types from
// the live descriptor cache (runtime/dynamic-guest-types.ts), so known tools
// fail type-check on argument-shape mistakes before this proxy ever runs.
globalThis.mcp = new Proxy({}, {
  get(_target, server) {
    if (server === "then") return undefined;
    if (server === "servers") return () => __call("mcp.$servers", {});
    if (server === "reload") return () => __call("mcp.$reload", {});
    if (server === "register") return (args) => __call("mcp.$register", args);
    if (server === "call") return (args) => __call("mcp.$call", args);
    return new Proxy({}, {
      get(_serverTarget, tool) {
        if (tool === "then") return undefined;
        return (args = {}) => __call("mcp." + String(server) + "." + String(tool), args);
      },
    });
  },
});
let __workflowSpentTokens = 0;
const __workflowBudgetTotal = Number.isFinite(globalThis.__fabricTokenBudget)
  ? Math.max(0, globalThis.__fabricTokenBudget)
  : Number.POSITIVE_INFINITY;
const __recordAgentUsage = (result) => {
  const usage = result && result.usage;
  if (usage) __workflowSpentTokens += Number(usage.input || 0) + Number(usage.output || 0);
  return result;
};
const __workflowAgent = async (prompt, options = {}) => {
  if (__workflowSpentTokens >= __workflowBudgetTotal) {
    throw new Error("Fabric workflow token budget exhausted");
  }
  const { label, ...agentOptions } = options;
  const workerName = String(label || agentOptions.name || "Fabric workflow agent");
  const result = __recordAgentUsage(await agents.run({
    ...agentOptions,
    ...(label && !agentOptions.name ? { name: label } : {}),
    task: prompt,
  }));
  if (!result || result.status !== "completed") {
    const reason = result && result.error ? result.error : "agent did not complete";
    throw new Error(workerName + " failed: " + reason);
  }
  return result.value !== undefined ? result.value : result.text;
};
// Budget-aware agents.run used by council.run and rlm.query so their usage is
// counted in budget.spent() and the tokenBudget guard can preempt them, just
// like workflow.agent(). Without this, councils bypass the budget entirely.
const __budgetedRun = async (args) => {
  if (__workflowSpentTokens >= __workflowBudgetTotal) {
    throw new Error("Fabric workflow token budget exhausted");
  }
  return __recordAgentUsage(await agents.run(args));
};
let __nextWorkflowSpanId = 0;
const __workflowSpanMetadata = (kind, items, options, stageCount) => {
  const itemCount = Array.isArray(items) ? items.length : undefined;
  let concurrency;
  if (kind === "parallel" && itemCount !== undefined) {
    if (itemCount === 0) concurrency = 0;
    else {
      const concurrencyOpt = typeof options === "number" ? { concurrency: options } : options ?? {};
      const requested = Number(concurrencyOpt.concurrency ?? itemCount);
      if (Number.isFinite(requested) && requested >= 1) {
        concurrency = Math.max(1, Math.min(itemCount, Math.floor(requested)));
      }
    }
  }
  return {
    kind,
    ...(itemCount !== undefined ? { itemCount } : {}),
    ...(stageCount !== undefined ? { stageCount } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
  };
};
const __withWorkflowSpan = async (metadata, body) => {
  const id = "span-" + __nextWorkflowSpanId++;
  await __call("fabric.$spanStart", { id, ...metadata });
  try {
    const value = await body();
    await __call("fabric.$spanEnd", { id, outcome: "succeeded" });
    return value;
  } catch (error) {
    try { await __call("fabric.$spanEnd", { id, outcome: "failed" }); } catch { /* preserve the workflow error */ }
    throw error;
  }
};
const __runParallel = async (thunks, options) => {
  if (!Array.isArray(thunks) || thunks.some((thunk) => typeof thunk !== "function")) {
    throw new TypeError("workflow.parallel expects an array of functions or (items, mapper)");
  }
  if (thunks.length === 0) return [];
  const concurrencyOpt = typeof options === "number" ? { concurrency: options } : options ?? {};
  const requestedConcurrency = Number(concurrencyOpt.concurrency ?? thunks.length);
  if (!Number.isFinite(requestedConcurrency) || requestedConcurrency < 1) {
    throw new RangeError("workflow.parallel concurrency must be a positive finite number");
  }
  const concurrency = Math.max(1, Math.min(thunks.length || 1, Math.floor(requestedConcurrency)));
  const results = new Array(thunks.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < thunks.length) {
      const index = cursor++;
      results[index] = await thunks[index]();
    }
  }));
  return results;
};
const __workflowParallel = async (items, arg2, arg3) => {
  const options = typeof arg2 === "function" ? arg3 : arg2;
  return __withWorkflowSpan(
    __workflowSpanMetadata("parallel", items, options),
    async () => {
      if (typeof arg2 === "function") {
        if (!Array.isArray(items)) throw new TypeError("workflow.parallel expects an array as the first argument");
        return __runParallel(items.map((item, index) => () => arg2(item, index)), arg3);
      }
      return __runParallel(items, arg2);
    },
  );
};
const __workflowPipeline = async (items, ...stages) =>
  __withWorkflowSpan(
    __workflowSpanMetadata("pipeline", items, undefined, stages.length),
    async () => {
      if (!Array.isArray(items) || stages.some((stage) => typeof stage !== "function")) {
        throw new TypeError("workflow.pipeline expects an array followed by stage functions");
      }
      return __workflowParallel(items.map((original, index) => async () => {
        let value = original;
        for (const stage of stages) value = await stage(value, original, index);
        return value;
      }));
    },
  );
globalThis.workflow = Object.freeze({
  agent: __workflowAgent,
  parallel: __workflowParallel,
  pipeline: __workflowPipeline,
  configure: (args) => __call("fabric.$configure", args),
  phase: (nameOrInput, options = {}) => {
    const input =
      nameOrInput && typeof nameOrInput === "object" && !Array.isArray(nameOrInput)
        ? { ...nameOrInput }
        : { ...options, name: nameOrInput };
    return __call("fabric.$phase", input);
  },
  item: (args) => __call("fabric.$item", args),
  event: (args) => __call("fabric.$event", args),
  log: (...values) => print(...values),
  budget: Object.freeze({
    total: __workflowBudgetTotal,
    spent: () => __workflowSpentTokens,
    remaining: () => Math.max(0, __workflowBudgetTotal - __workflowSpentTokens),
  }),
});
globalThis.agent = __workflowAgent;
globalThis.parallel = __workflowParallel;
globalThis.pipeline = __workflowPipeline;
globalThis.phase = workflow.phase;
globalThis.log = workflow.log;
globalThis.budget = workflow.budget;
globalThis.rlm = Object.freeze({
  query: (args) => {
    if (args && args.runner && args.runner !== "pi" && args.runner !== "pi-durable") {
      throw new Error("rlm.query requires a Pi runner (pi-durable or pi) for recursive Fabric");
    }
    return __budgetedRun({ ...args, runner: args?.runner ?? "pi-durable", recursive: true });
  },
});
globalThis.council = Object.freeze({
  async run(args) {
    const { task, roles, synthesize = true, ...agentOptions } = args;
    const results = await Promise.all(roles.map((role) => __budgetedRun({
      ...agentOptions,
      name: role,
      task: "Act as the " + role + " council member. Independently analyze this task:\\n\\n" + task,
    })));
    if (!synthesize) return results;
    return __budgetedRun({
      ...agentOptions,
      name: "council-synthesizer",
      task: "Synthesize the council's independent reports into one decision. Preserve disagreements and cite which role raised each concern.\\n\\nTask:\\n" + task + "\\n\\nReports:\\n" + JSON.stringify(results),
    });
  },
});
globalThis.console = Object.freeze({ log: print, info: print, warn: print, error: print, debug: print });
const __timerCallbacks = new Map();
let __nextTimerId = 1;
globalThis.setTimeout = (callback, ms = 0) => {
  const id = __nextTimerId++;
  __timerCallbacks.set(id, { callback, interval: false });
  __call("fabric.$timer", { ms }).then(() => {
    const entry = __timerCallbacks.get(id);
    if (!entry) return;
    __timerCallbacks.delete(id);
    try { entry.callback(); } catch { /* swallow timer callback errors */ }
  });
  return id;
};
globalThis.setInterval = (callback, ms = 0) => {
  const id = __nextTimerId++;
  __timerCallbacks.set(id, { callback, interval: true });
  const schedule = () => {
    __call("fabric.$timer", { ms }).then(() => {
      const entry = __timerCallbacks.get(id);
      if (!entry) return;
      try { entry.callback(); } catch { /* swallow timer callback errors */ }
      if (__timerCallbacks.has(id)) schedule();
    });
  };
  schedule();
  return id;
};
globalThis.clearTimeout = (id) => { __timerCallbacks.delete(id); };
globalThis.clearInterval = (id) => { __timerCallbacks.delete(id); };
})();
`;

const formatValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const jsonText = (value: unknown): string => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return "null";
  return serialized;
};

const jsonHandle = (
  context: any,
  jsonObject: any,
  jsonParse: any,
  value: unknown,
): any => {
  if (value === undefined) return context.undefined;
  if (value === null) return context.null;
  if (typeof value === "string") return context.newString(value);
  if (typeof value === "boolean") return value ? context.true : context.false;
  if (typeof value === "number") {
    return Number.isFinite(value) ? context.newNumber(value) : context.null;
  }
  const serialized = context.newString(jsonText(value));
  try {
    return context.unwrapResult(context.callFunction(jsonParse, jsonObject, serialized));
  } finally {
    serialized.dispose();
  }
};

const HOST_TASK_SETTLE_GRACE_MS = 250;

// The release-sync WASM variant otherwise exhausts the host stack before
// QuickJS can throw its guest-catchable InternalError.
const QUICKJS_MAX_STACK_SIZE_BYTES = 256 * 1024;
const QUICKJS_GC_LIST_ASSERTION = "list_empty(&rt->gc_obj_list)";

// Preserve an already-computed result for this known Emscripten teardown
// assertion while allowing every unrelated disposal failure to escape.
const disposeQuickJsContext = (context: any): void => {
  try {
    context.dispose();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(QUICKJS_GC_LIST_ASSERTION) && message.includes("JS_FreeRuntime")) return;
    throw error;
  }
};

export class QuickJsRuntime {
  async execute(
    code: string,
    hostCall: FabricHostCall,
    options: FabricSandboxOptions,
  ): Promise<FabricSandboxResult> {
    if (options.signal?.aborted) {
      return {
        value: undefined,
        logs: [],
        terminationReason: "aborted",
        error: "Execution cancelled",
      };
    }
    const missingKeys = missingStringsKeys(code, options.strings);
    if (missingKeys.length > 0) {
      const provided = Object.keys(options.strings ?? {});
      return {
        value: undefined,
        logs: [],
        terminationReason: "runtime_error",
        error:
          "Pre-execution check: " + missingKeys.map((key) => "π." + key).join(", ")
          + (missingKeys.length === 1 ? " is referenced in code but its key is missing from the payloads parameter"
            : " are referenced in code but their keys are missing from the payloads parameter")
          + (provided.length ? " (provided: " + provided.join(", ") + ")" : " (none provided)")
          + ". Add payloads: { " + missingKeys.join(": '...', ") + ": '...' } to the fabric_exec arguments, then reference the value as π.<key>."
          + " For large or quote-heavy content, keep it in top-level payloads and reference π.<key> instead of escaping it inside code.",
      };
    }
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) {
      return {
        value: undefined,
        logs: [],
        terminationReason: "runtime_error",
        error: "QuickJS timeout must be positive",
      };
    }
    if (options.maxLogChars !== undefined && (!Number.isSafeInteger(options.maxLogChars) || options.maxLogChars < 0)) {
      return {
        value: undefined,
        logs: [],
        terminationReason: "runtime_error",
        error: "QuickJS log limit must be a nonnegative safe integer",
      };
    }
    if (
      !Number.isSafeInteger(options.memoryLimitBytes) ||
      options.memoryLimitBytes < 1 ||
      options.memoryLimitBytes > 0xffff_ffff
    ) {
      return {
        value: undefined,
        logs: [],
        terminationReason: "runtime_error",
        error: "QuickJS memory limit must be an integer between 1 byte and 4294967295 bytes (WASM32 maximum)",
      };
    }
    const module = await quickJsModule();
    const context = module.newContext();
    const runtime = context.runtime;
    const jsonObject = context.getProp(context.global, "JSON");
    const jsonParse = context.getProp(jsonObject, "parse");
    const executionStartedAt = Date.now();
    let effectiveTimeoutMs = options.timeoutMs;
    let executionDeadlineAt = executionStartedAt + effectiveTimeoutMs;
    let interruptedByDeadline = false;
    let interruptedByCpu = false;
    let cpuDeadlineAt = Infinity;
    const pumpJobs = () => {
      cpuDeadlineAt = Date.now() + (options.maxCpuSliceMs ?? Infinity);
      return runtime.executePendingJobs();
    };
    runtime.setMemoryLimit(options.memoryLimitBytes);
    runtime.setMaxStackSize(QUICKJS_MAX_STACK_SIZE_BYTES);
    runtime.setInterruptHandler(() => {
      if (options.signal?.aborted === true) return true;
      if (interruptedByCpu || Date.now() > cpuDeadlineAt) {
        interruptedByCpu = true;
        return true;
      }
      if (Date.now() <= executionDeadlineAt) return false;
      interruptedByDeadline = true;
      return true;
    });
    const emittedSnapshot = (): unknown[] => {
      try {
        const handle = context.getProp(context.global, "__fabricEmitted");
        try { const value = context.dump(handle); return Array.isArray(value) ? value : []; }
        finally { handle.dispose(); }
      } catch { return []; }
    };
    const logs: string[] = [];
    const maxLogChars = options.maxLogChars ?? 100_000;
    let logChars = 0;
    let logsTruncated = false;
    const pendingHostPromises = new Set<any>();
    const hostTasks = new Set<Promise<void>>();
    const pendingTimers = new Set<NodeJS.Timeout>();
    let closing = false;
    let cancelled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let rejectDeadline: ((error: Error) => void) | undefined;
    let abortHandler: (() => void) | undefined;
    let activePromiseHandle: any;
    let executionGate: any;
    let pendingResolution: Promise<any> | undefined;
    const hostAbortController = new AbortController();
    const abortHostCalls = (reason: string): void => {
      if (!hostAbortController.signal.aborted) {
        hostAbortController.abort(new Error(reason));
      }
    };

    const rejectExecutionGate = (message: string): void => {
      if (!executionGate || executionGate.alive === false) return;
      const errorHandle = context.newError(message);
      executionGate.reject(errorHandle);
      errorHandle.dispose();
      pumpJobs();
    };

    const timeoutMessage = (): string =>
      interruptedByCpu
        ? `Guest exceeded ${options.maxCpuSliceMs}ms uninterrupted CPU; await host work or program.sleep() in loops`
        : `Execution timed out after ${effectiveTimeoutMs}ms`;
    const expireDeadline = (): void => {
      if (closing || cancelled || timedOut) return;
      timedOut = true;
      const message = timeoutMessage();
      abortHostCalls(message);
      rejectExecutionGate(message);
      rejectDeadline?.(new Error(message));
    };
    const scheduleDeadline = (): void => {
      if (!rejectDeadline || closing || cancelled || timedOut) return;
      clearTimeout(timeout);
      if (!Number.isFinite(executionDeadlineAt)) return;
      timeout = setTimeout(expireDeadline, Math.min(2_147_483_647, Math.max(0, executionDeadlineAt - Date.now())));
    };
    const extendExecutionTimeout = (
      ref: string,
      args: Record<string, unknown>,
    ): void => {
      const requestedTimeoutMs = options.minimumTimeoutMsForHostCall?.(ref, args);
      if (
        typeof requestedTimeoutMs !== "number" ||
        !Number.isFinite(requestedTimeoutMs)
      ) {
        return;
      }
      const requestedDurationMs = Math.max(1, Math.floor(requestedTimeoutMs));
      if (humanWait.paused) {
        humanWait.raise(requestedDurationMs);
        return;
      }
      const nextDeadlineAt = Date.now() + requestedDurationMs;
      const nextTimeoutMs = nextDeadlineAt - executionStartedAt;
      if (nextDeadlineAt <= executionDeadlineAt) return;
      effectiveTimeoutMs = nextTimeoutMs;
      executionDeadlineAt = nextDeadlineAt;
      scheduleDeadline();
    };

    const humanWait = new HumanWaitDeadlinePause({
      remainingMs: () => executionDeadlineAt - Date.now(),
      suspend: () => {
        clearTimeout(timeout);
        executionDeadlineAt = Infinity;
      },
      resume: (remainingMs) => {
        executionDeadlineAt = Date.now() + remainingMs;
        scheduleDeadline();
      },
    });

    try {
      const hostFunction = context.newFunction(
        "__fabricHostCall",
        (referenceHandle: any, argsHandle: any) => {
          const reference = context.getString(referenceHandle);
          const dumpedArgs = context.dump(argsHandle);
          const args =
            typeof dumpedArgs === "object" && dumpedArgs !== null && !Array.isArray(dumpedArgs)
              ? (dumpedArgs as Record<string, unknown>)
              : {};
          extendExecutionTimeout(reference, args);
          const promise = context.newPromise();
          pendingHostPromises.add(promise);
          void promise.settled.then(() => pendingHostPromises.delete(promise));
          if (reference === "fabric.$timer") {
            if (pendingTimers.size >= (options.maxPendingTimers ?? Infinity)) {
              const errorHandle = context.newError("Guest pending timer limit exceeded");
              promise.reject(errorHandle);
              errorHandle.dispose();
              return promise.handle;
            }
            const ms = Math.max(0, Number(args.ms ?? 0));
            const timer = setTimeout(() => {
              if (closing || promise.alive === false) return;
              promise.resolve(context.undefined);
              pumpJobs();
            }, ms);
            timer.unref?.();
            pendingTimers.add(timer);
            void promise.settled.then(() => pendingTimers.delete(timer));
            return promise.handle;
          }
          const waitsForHuman = options.isHumanWaitHostCall?.(reference, args) === true;
          if (waitsForHuman) humanWait.enter();
          const task = runAbortable(hostAbortController.signal, () =>
            hostCall(reference, args, hostAbortController.signal, (wait) => humanWait.run(wait)),
          )
            .finally(() => {
              if (waitsForHuman) humanWait.leave();
            })
            .then((value) => {
              if (closing || promise.alive === false) return;
              cpuDeadlineAt = Date.now() + (options.maxCpuSliceMs ?? Infinity);
              const handle = jsonHandle(context, jsonObject, jsonParse, value);
              promise.resolve(handle);
              handle.dispose();
            })
            .catch((error) => {
              if (closing || promise.alive === false) return;
              const errorHandle = context.newError(
                error instanceof Error ? error.message : String(error),
              );
              const exit = reference === "pi.bash" || reference === "pi.powershell"
                ? piBashExitMetadata(error)
                : undefined;
              if (exit) {
                const metadata = jsonHandle(context, jsonObject, jsonParse, exit);
                context.setProp(errorHandle, "__fabricBashExit", metadata);
                metadata.dispose();
              }
              for (const [key, value] of guestErrorFields(error)) {
                const field = context.newNumber(value);
                context.setProp(errorHandle, key, field);
                field.dispose();
              }
              promise.reject(errorHandle);
              errorHandle.dispose();
            })
            .finally(() => {
              if (!closing) pumpJobs();
            });
          hostTasks.add(task);
          void task.finally(() => hostTasks.delete(task));
          return promise.handle;
        },
      );
      context.setProp(context.global, "__fabricHostCall", hostFunction);
      hostFunction.dispose();

      const printFunction = context.newFunction("print", (...handles: any[]) => {
        if (logsTruncated) return;
        const line = handles.map((handle) => formatValue(context.dump(handle))).join(" ");
        const remaining = maxLogChars - logChars;
        if (line.length > remaining) {
          if (remaining > 0) logs.push(line.slice(0, remaining));
          logs.push("[Pi Fabric log output truncated]");
          logsTruncated = true;
          return;
        }
        logs.push(line);
        logChars += line.length;
      });
      context.setProp(context.global, "print", printFunction);
      printFunction.dispose();

      const strings = jsonHandle(context, jsonObject, jsonParse, options.strings ?? {});
      context.setProp(context.global, "π", strings);
      strings.dispose();
      const tokenBudget = context.newNumber(options.tokenBudget ?? Number.POSITIVE_INFINITY);
      context.setProp(context.global, "__fabricTokenBudget", tokenBudget);
      tokenBudget.dispose();

      cpuDeadlineAt = Date.now() + (options.maxCpuSliceMs ?? Infinity);
      const setupResult = context.evalCode(guestSetupSource(options.piToolCanonicalFields, options.nativeStoreEnabled, options.codemodeProfile, options.nativeToolsEnabled), "pi-fabric-setup.js");
      if (setupResult.error) {
        const deadlineExceeded = interruptedByDeadline || interruptedByCpu || Date.now() > executionDeadlineAt;
        if (deadlineExceeded) timedOut = true;
        const error = options.signal?.aborted
          ? "Execution cancelled"
          : deadlineExceeded
            ? timeoutMessage()
            : formatValue(context.dump(setupResult.error));
        setupResult.error.dispose();
        abortHostCalls(error);
        return {
          value: undefined,
          logs,
          terminationReason: options.signal?.aborted
            ? "aborted"
            : deadlineExceeded
              ? "timed_out"
              : "runtime_error",
          error,
        };
      }
      setupResult.value.dispose();

      executionGate = context.newPromise();
      context.setProp(context.global, "__fabricExecutionGate", executionGate.handle);
      const guestBundle = options.transpiledCode === undefined
        ? transpileFabricCodeWithSourceMap(code)
        : { code: options.transpiledCode, sourceMap: options.transpiledSourceMap };
      const guestStackMap = createGuestStackMap(guestBundle.sourceMap);
      const guestLineCount = guestBundle.code.split("\n").length;
      const wrappedCode = `${guestBundle.code}\nPromise.race([globalThis.__fabricRun(__piFabricMain), globalThis.__fabricExecutionGate])`;
      cpuDeadlineAt = Date.now() + (options.maxCpuSliceMs ?? Infinity);
      const evaluation = context.evalCode(wrappedCode, "pi-fabric-guest.js");
      pumpJobs();
      if (evaluation.error) {
        const deadlineExceeded = interruptedByDeadline || interruptedByCpu || Date.now() > executionDeadlineAt;
        if (deadlineExceeded) timedOut = true;
        const error = options.signal?.aborted
          ? "Execution cancelled"
          : deadlineExceeded
            ? timeoutMessage()
            : remapGuestErrorText(formatValue(context.dump(evaluation.error)), guestStackMap, guestLineCount);
        evaluation.error.dispose();
        abortHostCalls(error);
        return {
          value: undefined,
          logs,
          terminationReason: options.signal?.aborted
            ? "aborted"
            : deadlineExceeded
              ? "timed_out"
              : "runtime_error",
          error,
        };
      }

      activePromiseHandle = evaluation.value;
      const cancellation = new Promise<never>((_resolve, reject) => {
        abortHandler = () => {
          cancelled = true;
          hostAbortController.abort(options.signal?.reason);
          rejectExecutionGate("Execution cancelled");
          reject(new Error("Execution cancelled"));
        };
        if (options.signal?.aborted) abortHandler();
        else options.signal?.addEventListener("abort", abortHandler, { once: true });
      });
      void cancellation.catch(() => undefined);
      const deadline = new Promise<never>((_resolve, reject) => {
        rejectDeadline = reject;
        scheduleDeadline();
      });
      pendingResolution = context.resolvePromise(activePromiseHandle);
      pumpJobs();
      const resolution = await Promise.race([pendingResolution, deadline, cancellation]);
      pendingResolution = undefined;
      activePromiseHandle.dispose();
      activePromiseHandle = undefined;
      if (resolution.error) {
        const deadlineExceeded = timedOut || interruptedByDeadline || interruptedByCpu || Date.now() > executionDeadlineAt;
        if (deadlineExceeded) timedOut = true;
        const error = options.signal?.aborted
          ? "Execution cancelled"
          : deadlineExceeded
            ? timeoutMessage()
            : remapGuestErrorText(formatValue(context.dump(resolution.error)), guestStackMap, guestLineCount);
        resolution.error.dispose();
        const emittedHandle = context.getProp(context.global, "__fabricEmitted");
        const emitted = context.dump(emittedHandle) as unknown[];
        emittedHandle.dispose();
        abortHostCalls(error);
        return {
          value: undefined,
          logs,
          emitted,
          terminationReason: options.signal?.aborted
            ? "aborted"
            : deadlineExceeded
              ? "timed_out"
              : "runtime_error",
          error,
        };
      }
      const value = context.dump(resolution.value);
      resolution.value.dispose();
      const emittedHandle = context.getProp(context.global, "__fabricEmitted");
      const emitted = context.dump(emittedHandle) as unknown[];
      emittedHandle.dispose();
      return { value, logs, emitted, terminationReason: "completed" };
    } catch (error) {
      const deadlineExceeded = timedOut || interruptedByDeadline || interruptedByCpu || Date.now() > executionDeadlineAt;
      if (deadlineExceeded) timedOut = true;
      abortHostCalls(error instanceof Error ? error.message : String(error));
      return {
        value: undefined,
        logs,
        emitted: emittedSnapshot(),
        terminationReason: cancelled ? "aborted" : deadlineExceeded ? "timed_out" : "runtime_error",
        error: cancelled
          ? "Execution cancelled"
          : deadlineExceeded
            ? timeoutMessage()
            : error instanceof Error
              ? error.message
              : String(error),
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      for (const timer of pendingTimers) clearTimeout(timer);
      if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
      if (hostTasks.size > 0) {
        abortHostCalls("Fabric guest execution ended before its host calls settled");
        const settled = await settleWithin(hostTasks, HOST_TASK_SETTLE_GRACE_MS);
        if (!settled) {
          abortHostCalls("Fabric guest execution ended before its host calls settled");
          await settleWithin(hostTasks, HOST_TASK_SETTLE_GRACE_MS);
        }
        pumpJobs();
      }
      closing = true;
      if (timedOut || cancelled || pendingHostPromises.size > 0) {
        const cleanupMessage = cancelled
          ? "Execution cancelled"
          : timedOut
            ? timeoutMessage()
            : "Fabric guest execution ended before its host calls settled";
        if (!hostAbortController.signal.aborted) hostAbortController.abort(new Error(cleanupMessage));
        rejectExecutionGate(cleanupMessage);
        const errorHandle = context.newError(cleanupMessage);
        for (const promise of pendingHostPromises) promise.reject(errorHandle);
        errorHandle.dispose();
        pumpJobs();
        await new Promise((resolve) => setImmediate(resolve));
        const settled = await Promise.race<any>([
          pendingResolution ? pendingResolution.catch(() => undefined) : Promise.resolve(undefined),
          new Promise<undefined>((resolve) => {
            const timer = setTimeout(() => resolve(undefined), 1_000);
            timer.unref?.();
          }),
        ]);
        if (settled?.error) settled.error.dispose();
        if (settled?.value) settled.value.dispose();
        for (const promise of pendingHostPromises) {
          if (promise.alive !== false) promise.dispose();
        }
      }
      if (activePromiseHandle?.alive !== false) activePromiseHandle?.dispose();
      if (executionGate?.alive !== false) executionGate?.dispose();
      pumpJobs();
      jsonParse.dispose();
      jsonObject.dispose();
      disposeQuickJsContext(context);
    }
  }
}

/**
 * Finite numeric fields a host error opts to expose on the guest's error
 * object (for example a Jev HTTP status), never its message internals.
 */
function guestErrorFields(error: unknown): Array<[string, number]> {
  const fields = error instanceof Error ? (error as { guestFields?: unknown }).guestFields : undefined;
  if (typeof fields !== "object" || fields === null) return [];
  return Object.entries(fields).filter((entry): entry is [string, number] =>
    /^[a-z][A-Za-z]{0,31}$/.test(entry[0]) && !["message", "name", "stack", "cause"].includes(entry[0]) &&
    typeof entry[1] === "number" && Number.isFinite(entry[1])).slice(0, 8);
}
