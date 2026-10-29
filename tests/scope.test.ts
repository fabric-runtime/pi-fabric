import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ActorManager } from "../src/actors/manager.js";
import type { GlobalActorRegistry } from "../src/actors/global-registry.js";
import type { LifecycleBroker } from "../src/lifecycle/broker.js";
import type { FabricMainAgentTarget } from "../src/main-agent.js";
import type { FabricParticipantSource } from "../src/topology/types.js";
import {
  childScope,
  deriveScope,
  issueRootScope,
  normalizeScope,
  scopeAllows,
  sealRootScope,
  sessionScope,
  type FabricScope,
} from "../src/scope.js";
import { ActionRegistry, type FabricCallAudit } from "../src/core/action-registry.js";
import type { FabricInvocationContext, FabricProvider } from "../src/protocol.js";
import { FabricSpeculationStore } from "../src/speculation/store.js";
import type { FabricSpeculationReplay } from "../src/speculation/types.js";
import { AgentManager } from "../src/agents/manager.js";
import { AgentsProvider } from "../src/providers/agents-provider.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { parseWorkerOptions } from "../src/worker/options.js";
import {
  createMemorySourceClient,
  createMemorySourceRegistry,
  type MemorySourceAction,
  type MemorySourceRecord,
  type PortableMemorySource,
} from "../src/memory.js";
import { MemoryProvider } from "../src/providers/memory-provider.js";
import { MemoryRequestCache, recallContinuationKey, type ExpansionSnapshot } from "../src/memory/request-cache.js";
import { observeHostSource } from "../src/memory/source-observation.js";
import { assistantText, messageEntry, sessionHeader, userMessage } from "./fixtures/memory.js";

const HOLDER = Symbol.for("pi-fabric:scope:v1");
const holder = globalThis as unknown as Record<symbol, { sealed?: boolean; scope?: FabricScope; error?: string } | undefined>;
const roots: string[] = [];
const managers: AgentManager[] = [];

afterEach(async () => {
  delete holder[HOLDER];
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  delete process.env.FAKE_PI_BEHAVIOR;
});

const tempRoot = (prefix: string): string => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
};

const root = (grants: FabricScope["grants"] = [
  { resource: "fs:/repo/**", actions: ["read", "write"] },
  { resource: "mesh:jobs/*", actions: ["read"] },
  { resource: "memory:*", actions: ["read"] },
]): FabricScope => normalizeScope({ principal: { id: "user:alice" }, grants });

const scoped = (scope: FabricScope | undefined): void => {
  holder[HOLDER] = { sealed: true, ...(scope ? { scope } : {}) };
};

describe("scope grammar and subset logic", () => {
  it("accepts the documented resource forms and refuses malformed ones", () => {
    const valid = ["fs:/repo/src", "fs:/repo/*", "fs:/repo/**", "fs:/*", "mesh:jobs/build", "mesh:*", "a.b-c:x/y/z"];
    for (const resource of valid) expect(() => root([{ resource, actions: ["read"] }])).not.toThrow();
    const invalid = ["fs", ":x", "fs:", "Fs:x", "fs:**", "fs:a//b", "fs:a/*/b", "fs:a/../b", "fs:a/./b", "fs:a b", "fs:/", "fs:a/**x"];
    for (const resource of invalid) {
      expect(() => root([{ resource, actions: ["read"] }]), resource).toThrow(/Invalid scope resource/);
    }
    expect(() => root([{ resource: "fs:a", actions: [] }])).toThrow(/actions/);
    expect(() => root([{ resource: "fs:a", actions: ["delete" as "read"] }])).toThrow(/actions/);
    expect(() => root(Array.from({ length: 65 }, (_, index) => ({ resource: `fs:a${index}`, actions: ["read" as const] }))))
      .toThrow(/at most 64/);
  });

  it("distinguishes one-level /* from any-depth /** and the namespace wildcard", () => {
    const scope = root();
    expect(scopeAllows(scope, "fs:/repo/src/a.ts", "read")).toBe(true);
    expect(scopeAllows(scope, "fs:/repo/src/a.ts", "execute")).toBe(false);
    expect(scopeAllows(scope, "fs:/repo", "read")).toBe(false);
    expect(scopeAllows(scope, "fs:repo/src", "read")).toBe(false);
    expect(scopeAllows(scope, "fs:/other/x", "read")).toBe(false);
    expect(scopeAllows(scope, "mesh:jobs/build", "read")).toBe(true);
    expect(scopeAllows(scope, "mesh:jobs/build/step", "read")).toBe(false);
    expect(scopeAllows(scope, "mesh:jobs", "read")).toBe(false);
    expect(scopeAllows(scope, "memory:anything/at/all", "read")).toBe(true);
    expect(scopeAllows(scope, "memory:*", "read")).toBe(true);
    expect(scopeAllows(scope, "state:x", "read")).toBe(false);
    expect(() => scopeAllows(scope, "not a resource", "read")).toThrow(/Invalid scope resource/);
  });

  it("derives only covered grants and keeps the parent's principal", () => {
    const parent = root();
    const child = deriveScope(parent, [
      { resource: "fs:/repo/src/**", actions: ["read"] },
      { resource: "fs:/repo/src/*", actions: ["write"] },
      { resource: "mesh:jobs/build", actions: ["read"] },
      { resource: "memory:session/x", actions: ["read"] },
    ]);
    expect(child.principal).toEqual({ id: "user:alice", issuer: "host" });
    expect(child.parentDigest).toBe(parent.digest);
    expect(Object.isFrozen(child) && Object.isFrozen(child.grants) && Object.isFrozen(child.grants[0])).toBe(true);
    // A one-level parent cannot hand out a deeper or recursive child.
    expect(() => deriveScope(parent, [{ resource: "mesh:jobs/*", actions: ["read"] }])).not.toThrow();
    expect(() => deriveScope(parent, [{ resource: "mesh:jobs/a/b", actions: ["read"] }])).toThrow(/not covered/);
    expect(() => deriveScope(parent, [{ resource: "mesh:jobs/**", actions: ["read"] }])).toThrow(/not covered/);
    expect(() => deriveScope(parent, [{ resource: "mesh:*", actions: ["read"] }])).toThrow(/not covered/);
    expect(() => deriveScope(parent, [{ resource: "fs:/repo/**", actions: ["execute"] }])).toThrow(/not covered/);
    expect(() => deriveScope(parent, [{ resource: "fs:/repo", actions: ["read"] }])).toThrow(/not covered/);
    expect(deriveScope(parent, []).grants).toEqual([]);
    // A narrowed child narrows further from its own grants only.
    expect(() => deriveScope(child, [{ resource: "fs:/repo/src/*", actions: ["write"] }])).not.toThrow();
    // Each requested grant needs one covering parent grant; a union of two does not count.
    expect(() => deriveScope(child, [{ resource: "fs:/repo/src/*", actions: ["read", "write"] }])).toThrow(/not covered/);
    expect(() => deriveScope(child, [{ resource: "fs:/repo/lib/x", actions: ["read"] }])).toThrow(/not covered/);
  });

  it("computes a stable digest over canonical content and refuses a forged digest", () => {
    const a = root([
      { resource: "mesh:jobs/*", actions: ["read"] },
      { resource: "fs:/repo/**", actions: ["write", "read"] },
    ]);
    const b = root([
      { resource: "fs:/repo/**", actions: ["read"] },
      { resource: "fs:/repo/**", actions: ["write", "read"] },
      { resource: "mesh:jobs/*", actions: ["read"] },
    ]);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(b.digest).toBe(a.digest);
    expect(a.grants).toEqual([
      { resource: "fs:/repo/**", actions: ["read", "write"] },
      { resource: "mesh:jobs/*", actions: ["read"] },
    ]);
    expect(normalizeScope(JSON.parse(JSON.stringify(a))).digest).toBe(a.digest);
    expect(normalizeScope({ principal: { id: "user:bob" }, grants: a.grants }).digest).not.toBe(a.digest);
    expect(deriveScope(a, a.grants).digest).not.toBe(a.digest);
    expect(() => normalizeScope({ ...a, digest: "0".repeat(64) })).toThrow(/digest does not match/);
    expect(() => normalizeScope({ ...a, grants: [] })).toThrow(/digest does not match/);
    expect(() => normalizeScope({ ...a, principal: { id: "x", issuer: "program" } })).toThrow(/issuer/);
    expect(() => normalizeScope({ ...a, extra: true })).toThrow(/unsupported fields/);
  });
});

describe("scope issuance", () => {
  it("issues once before session_start and fails closed on invalid input", () => {
    const scope = issueRootScope({ principal: { id: "svc" }, grants: [{ resource: "fs:*", actions: ["read"] }] });
    expect(sessionScope()).toBe(scope);
    expect(() => issueRootScope({ principal: { id: "svc" }, grants: [] })).toThrow(/already issued/);
    sealRootScope({});
    expect(sessionScope()).toBe(scope);
    delete holder[HOLDER];
    sealRootScope({});
    expect(sessionScope()).toBeUndefined();
    expect(() => issueRootScope({ principal: { id: "late" }, grants: [] })).toThrow(/before session_start/);
    delete holder[HOLDER];
    expect(() => issueRootScope({ principal: { id: "" }, grants: [] })).toThrow(/principal id/);
    sealRootScope({});
    expect(() => sessionScope()).toThrow(/issuance failed; provider calls are refused: .*principal id/);
  });

  it("reads PI_FABRIC_SCOPE or PI_FABRIC_SCOPE_FILE once and refuses conflicts", () => {
    const scope = root();
    sealRootScope({ json: JSON.stringify(scope) });
    expect(sessionScope()?.digest).toBe(scope.digest);
    sealRootScope({ json: "{}" });
    expect(sessionScope()?.digest).toBe(scope.digest);

    delete holder[HOLDER];
    const file = path.join(tempRoot("pi-fabric-scope-file-"), "scope.json");
    fs.writeFileSync(file, JSON.stringify({ principal: scope.principal, grants: scope.grants }));
    sealRootScope({ file });
    expect(sessionScope()?.digest).toBe(scope.digest);

    for (const env of [{ json: "{nope" }, { json: "{}", file }, { file: path.join(path.dirname(file), "missing.json") }]) {
      delete holder[HOLDER];
      sealRootScope(env);
      expect(() => sessionScope()).toThrow(/provider calls are refused/);
    }
    delete holder[HOLDER];
    issueRootScope({ principal: { id: "api" }, grants: [] });
    sealRootScope({ json: JSON.stringify(scope) });
    expect(() => sessionScope()).toThrow(/both the host API and the environment/);
  });

  it("inherits, narrows, or refuses child scopes", () => {
    expect(childScope(undefined)).toBeUndefined();
    expect(() => childScope({ grants: [] })).toThrow(/requires a scoped parent session/);
    const parent = root();
    scoped(parent);
    expect(childScope(undefined)).toBe(parent);
    expect(childScope({ grants: [{ resource: "fs:/repo/a", actions: ["read"] }] })?.parentDigest).toBe(parent.digest);
    expect(() => childScope({ grants: [], principal: { id: "root" } })).toThrow(/never sets a principal/);
    expect(() => childScope({ grants: [{ resource: "fs:/etc/**", actions: ["read"] }] })).toThrow(/not covered/);
    expect(() => childScope("fs:*")).toThrow(/object \{ grants \}/);
  });
});

const echoProvider = (calls: string[], seen: Array<FabricInvocationContext["scope"]>): FabricProvider => ({
  name: "spec",
  description: "scope test provider",
  async list() {
    return [{
      name: "echo",
      description: "Echo (read)",
      inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
      risk: "read" as const,
      effect: { kind: "none" as const, resources: ["spec:echo"], ordering: "commutative" as const },
    }];
  },
  async describe(name, context) {
    return (await this.list({}, context)).find((descriptor) => descriptor.name === name);
  },
  async invoke(_name, args, context) {
    calls.push(String(args.value));
    seen.push(context.scope);
    return `ran:${String(args.value)}`;
  },
});

const invocation = (parentToolCallId = "outer"): FabricInvocationContext => ({
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId,
  nestedToolCallId: "nested",
  extensionContext: {} as ExtensionContext,
  update() {},
});

const full = (toolCallId: string) => ({
  ...invocation(toolCallId),
  approve: vi.fn(async () => {}),
  audits: [] as FabricCallAudit[],
  maxResultChars: 10_000,
});

describe("registry scope propagation", () => {
  it("injects the frozen host scope, replaces caller values, and refuses calls after failed issuance", async () => {
    const calls: string[] = [];
    const seen: Array<FabricInvocationContext["scope"]> = [];
    const registry = new ActionRegistry();
    registry.register(echoProvider(calls, seen));
    const forged = { ...root(), principal: { id: "program", issuer: "host" as const } };
    await registry.invoke("spec.echo", { value: "a" }, { ...full("t1"), scope: forged });
    expect(seen[0]).toBeUndefined();
    const scope = root();
    scoped(scope);
    await registry.invoke("spec.echo", { value: "b" }, { ...full("t2"), scope: forged });
    expect(seen[1]).toBe(scope);
    expect(Object.isFrozen(seen[1])).toBe(true);
    holder[HOLDER] = { sealed: true, error: "PI_FABRIC_SCOPE is not valid JSON" };
    await expect(registry.invoke("spec.echo", { value: "c" }, full("t3")))
      .rejects.toThrow(/Fabric scope issuance failed; provider calls are refused: PI_FABRIC_SCOPE is not valid JSON/);
    await expect(registry.list({}, invocation())).rejects.toThrow(/provider calls are refused/);
    expect(calls).toEqual(["a", "b"]);
  });

  it("never serves a speculative result cached under another scope", async () => {
    const launch = async (registry: ActionRegistry, store: FabricSpeculationStore, toolCallId: string) => {
      const replay: FabricSpeculationReplay = {};
      const spec = await registry.speculate("spec.echo", { value: "x" }, invocation(toolCallId), replay);
      expect(spec).toBeDefined();
      store.launch(toolCallId, "spec.echo", spec!.preparedArgs, spec!.execute, undefined, replay, spec!.bindingToken);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const calls: string[] = [];
    const registry = new ActionRegistry();
    registry.register(echoProvider(calls, []));
    const store = new FabricSpeculationStore({ maxConcurrent: 4, maxEntries: 8, entryTtlMs: 60_000 });
    registry.setSpeculation(store, () => true);

    scoped(root());
    await launch(registry, store, "same");
    await registry.invoke("spec.echo", { value: "x" }, full("same"));
    expect(calls).toHaveLength(1);
    expect(store.stats()).toMatchObject({ served: 1 });

    await launch(registry, store, "cross");
    scoped(root([{ resource: "fs:/elsewhere/**", actions: ["read"] }]));
    await registry.invoke("spec.echo", { value: "x" }, full("cross"));
    expect(calls).toHaveLength(3);
    expect(store.stats()).toMatchObject({ served: 1 });
  });
});

const records = (id: string, texts: string[]): MemorySourceRecord[] => [
  sessionHeader(id, "/work/archive"),
  ...texts.map((text, index) => messageEntry(
    `${id}-${index}`,
    index === 0 ? null : `${id}-${index - 1}`,
    new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    index % 2 === 0 ? userMessage(text) : assistantText(text),
  )),
];

const memorySource = (authorized: Array<{ action: MemorySourceAction; scope?: string }>): PortableMemorySource => ({
  interfaceVersion: 1,
  id: "archive",
  async listSessions() {
    return [{ sessionKey: "k", revision: "r1" }, { sessionKey: "k2", revision: "r1" }];
  },
  async loadSession(sessionKey) {
    return sessionKey === "k" || sessionKey === "k2"
      ? { sessionKey, revision: "r1", records: records(sessionKey, Array.from({ length: 8 }, (_, index) => `needle entry ${index}`)) }
      : null;
  },
  authorize(action, _sessionKey, scope) {
    authorized.push({ action, ...(scope ? { scope: scope.principal.id } : {}) });
    return !scope || scopeAllows(scope, "memory:archive/k", "read");
  },
});

describe("memory scope", () => {
  it("passes the caller scope to source authorization", async () => {
    const authorized: Array<{ action: MemorySourceAction; scope?: string }> = [];
    const sources = createMemorySourceRegistry();
    sources.register(memorySource(authorized));
    const client = createMemorySourceClient({ sources });
    await client.sessions({ source: "archive" });
    expect(authorized.at(-1)).toEqual({ action: "list" });
    const denied = await client.sessions({ source: "archive" }, { scope: root([{ resource: "fs:*", actions: ["read"] }]) }) as {
      error?: { code: string };
    };
    expect(denied.error?.code).toBe("source_unauthorized");
    expect(authorized.at(-1)).toEqual({ action: "list", scope: "user:alice" });

    const provider = new MemoryProvider({ agentDir: "", cwd: "", config: DEFAULT_FABRIC_CONFIG.memory, sources });
    const recalled = await provider.invoke("recall", { source: "archive", query: "needle" }, { ...invocation(), scope: root() }) as {
      hits: unknown[];
    };
    expect(recalled.hits.length).toBeGreaterThan(0);
    expect(authorized.at(-1)).toEqual({ action: "recall", scope: "user:alice" });
  });

  it("keys recall continuations and expansion snapshots by scope digest", async () => {
    const a = root();
    const b = root([{ resource: "memory:*", actions: ["read"] }]);
    const sources = createMemorySourceRegistry();
    sources.register(memorySource([]));
    const provider = new MemoryProvider({ agentDir: "", cwd: "", config: DEFAULT_FABRIC_CONFIG.memory, sources });
    const lookup = vi.spyOn(MemoryRequestCache.prototype, "cachedRecallContinuation");
    try {
      const first = await provider.invoke("recall", { source: "archive", query: "needle", pageSize: 2 }, { ...invocation(), scope: a }) as {
        next: { args: Record<string, unknown> } | null;
      };
      expect(first.next).not.toBeNull();
      const next = provider.prepareArguments("recall", first.next!.args);
      await provider.invoke("recall", next, { ...invocation(), scope: a });
      expect(lookup.mock.results.at(-1)?.value).toBeDefined();
      await provider.invoke("recall", next, { ...invocation(), scope: b });
      expect(lookup.mock.results.at(-1)?.value).toBeUndefined();
    } finally {
      lookup.mockRestore();
    }
    expect(recallContinuationKey({ query: "q" }, a.digest)).not.toBe(recallContinuationKey({ query: "q" }, b.digest));

    const cache = new MemoryRequestCache();
    const observation = observeHostSource("/s", "r1", "h");
    const snapshot = {
      file: "/s", branches: "active", scopeDigest: a.digest, sourceHash: "h", lineageFingerprint: "l",
      observation, entries: [], selections: new Map(), touchedAt: Date.now(),
    } as ExpansionSnapshot;
    cache.rememberExpansionSnapshot(snapshot);
    expect(cache.cachedExpansionSnapshot("/s", "active", observation, a.digest)).toBe(snapshot);
    expect(cache.cachedExpansionSnapshot("/s", "active", observation, b.digest)).toBeUndefined();
    expect(cache.cachedExpansionSnapshot("/s", "active", observation)).toBeUndefined();
  });
});

// Records its argv beside the status file.
const workerSource = `
import fs from "node:fs";
import path from "node:path";
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index].slice(2), process.argv[index + 1]);
const statusFile = args.get("status-file");
fs.mkdirSync(path.dirname(statusFile), { recursive: true });
fs.writeFileSync(path.join(path.dirname(statusFile), "argv.json"), JSON.stringify(Object.fromEntries(args)));
const now = Date.now();
fs.writeFileSync(statusFile, JSON.stringify({
  id: args.get("id"), name: args.get("name"), task: "t", status: "completed",
  runner: args.get("runner"), transport: args.get("transport"), cwd: process.cwd(),
  startedAt: now, updatedAt: now, finishedAt: now, turns: 1, toolCalls: 0, text: "done", exitCode: 0,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
}));
fs.writeFileSync(args.get("log-file"), JSON.stringify({ type: "agent_start" }) + "\\n");
`;

describe("agent scope narrowing", () => {
  const createManager = (cwd: string) => {
    const dir = tempRoot("pi-fabric-scope-runs-");
    const workerPath = path.join(dir, "worker.mjs");
    fs.writeFileSync(workerPath, workerSource);
    const manager = new AgentManager(cwd, { ...DEFAULT_FABRIC_CONFIG.agents, timeoutMs: 10_000 }, {
      workerPath, runRoot: path.join(dir, "runs"), fullCodeMode: false,
    });
    managers.push(manager);
    return { manager, runRoot: path.join(dir, "runs") };
  };
  const argv = (runRoot: string, id: string): Record<string, string> =>
    JSON.parse(fs.readFileSync(path.join(runRoot, id, "argv.json"), "utf8"));

  it("inherits or narrows the parent scope and refuses widening before launch", async () => {
    const cwd = tempRoot("pi-fabric-scope-cwd-");
    const { manager, runRoot } = createManager(cwd);
    const unscoped = await manager.run({ task: "plain", transport: "process" });
    expect(argv(runRoot, unscoped.id).scope).toBeUndefined();
    await expect(manager.spawn({ task: "x", transport: "process", scope: { grants: [] } }))
      .rejects.toThrow(/requires a scoped parent session/);

    const parent = root();
    scoped(parent);
    const inherited = await manager.run({ task: "inherit", transport: "process" });
    expect(JSON.parse(argv(runRoot, inherited.id).scope!)).toEqual(JSON.parse(JSON.stringify(parent)));
    const narrowed = await manager.run({
      task: "narrow", transport: "process",
      scope: { grants: [{ resource: "fs:/repo/src/**", actions: ["read"] }] },
    });
    const child = normalizeScope(JSON.parse(argv(runRoot, narrowed.id).scope!));
    expect(child).toMatchObject({ principal: parent.principal, parentDigest: parent.digest, grants: [{ resource: "fs:/repo/src/**", actions: ["read"] }] });
    const before = fs.readdirSync(runRoot).length;
    await expect(manager.spawn({
      task: "widen", transport: "process",
      scope: { grants: [{ resource: "fs:/**", actions: ["read"] }] },
    })).rejects.toThrow(/not covered by the parent scope/);
    expect(fs.readdirSync(runRoot)).toHaveLength(before);
    expect(parseWorkerOptions([
      "node", "worker.js", "--id", "w", "--name", "n", "--runner", "pi", "--task-file", "t",
      "--status-file", "s", "--lifecycle-file", "l", "--log-file", "g", "--cwd", "/",
      "--pi-binary", "pi", "--claude-binary", "c", "--veda-binary", "v", "--veda-backend", "b",
      "--veda-persona", "p", "--timeout-ms", "1", "--depth", "1", "--full-code-mode", "false",
      "--extensions", "false", "--tools", "[]", "--granted-risks", "[]", "--transport", "process",
      "--scope", JSON.stringify(child),
    ])).toMatchObject({ scope: JSON.stringify(child) });
  });

  it("exports exactly the derived PI_FABRIC_SCOPE to the child process", async () => {
    process.env.FAKE_PI_BEHAVIOR = "child-contract";
    const saved = { scope: process.env.PI_FABRIC_SCOPE, file: process.env.PI_FABRIC_SCOPE_FILE };
    process.env.PI_FABRIC_SCOPE_FILE = "/inherited/scope.json";
    try {
      const dir = tempRoot("pi-fabric-scope-worker-");
      const manager = new AgentManager(dir, { ...DEFAULT_FABRIC_CONFIG.agents, timeoutMs: 20_000 }, {
        workerPath: path.resolve("src/worker.ts"),
        piBinary: path.resolve("tests/fixtures/fake-pi.mjs"),
        runRoot: path.join(dir, "runs"),
        fullCodeMode: false,
      });
      managers.push(manager);
      const parent = root();
      scoped(parent);
      const result = await manager.run({
        task: "report", runner: "pi", transport: "process", extensions: false,
        scope: { grants: [{ resource: "mesh:jobs/build", actions: ["read"] }] },
      });
      expect(result.status).toBe("completed");
      const report = JSON.parse(result.text) as { scope: string | null; scopeFile: string | null };
      expect(report.scopeFile).toBeNull();
      expect(normalizeScope(JSON.parse(report.scope!))).toMatchObject({ parentDigest: parent.digest });
    } finally {
      if (saved.scope === undefined) delete process.env.PI_FABRIC_SCOPE;
      else process.env.PI_FABRIC_SCOPE = saved.scope;
      if (saved.file === undefined) delete process.env.PI_FABRIC_SCOPE_FILE;
      else process.env.PI_FABRIC_SCOPE_FILE = saved.file;
    }
  }, 30_000);

  it("forwards the derived scope host-only with durable spawns", async () => {
    const requests: unknown[] = [];
    const resident: unknown[] = [];
    const handle = { id: "child", name: "child", status: "running", runner: "pi", transport: "process", cwd: "/" };
    const manager = {
      config: DEFAULT_FABRIC_CONFIG.agents,
      resolveKernel: () => undefined,
      resolvePythonRuntime: () => "monty",
      resolveCwd: (cwd: string) => cwd,
      applyRecursiveDefault: (request: unknown) => request,
      childThinkingBounds: () => ({}),
      forwardedTraceContext: () => undefined,
      detachSignal() {},
      spawn: async (request: unknown) => {
        requests.push(request);
        return handle;
      },
    } as unknown as AgentManager;
    const residency = { spawnAgent: async (request: unknown) => (resident.push(request), handle) };
    const provider = new AgentsProvider(
      manager, {} as ActorManager, {} as GlobalActorRegistry, {} as FabricMainAgentTarget,
      { scheduleRefresh() {} } as unknown as FabricParticipantSource, undefined, {} as LifecycleBroker,
      () => true, residency as unknown as ConstructorParameters<typeof AgentsProvider>[8],
    );
    const context = { ...invocation(), extensionContext: { model: { provider: "p", id: "m" } } as unknown as ExtensionContext };
    const parent = root();
    scoped(parent);
    const forged = normalizeScope({ principal: { id: "user:mallory" }, grants: [{ resource: "fs:*", actions: ["write"] }] });
    await provider.invoke("spawn", { task: "x", residency: "durable", inheritedScope: forged }, context);
    await provider.invoke("spawn", {
      task: "y", residency: "durable", scope: { grants: [{ resource: "memory:*", actions: ["read"] }] },
    }, context);
    expect(resident[0]).toMatchObject({ inheritedScope: parent });
    expect(resident[1]).toMatchObject({ inheritedScope: { principal: parent.principal, parentDigest: parent.digest } });
    expect(resident[1]).not.toHaveProperty("scope");
    await provider.invoke("spawn", { task: "x", scope: { grants: [{ resource: "memory:*", actions: ["read"] }] } }, context);
    expect(requests).toEqual([expect.objectContaining({ scope: { grants: [{ resource: "memory:*", actions: ["read"] }] } })]);
    expect(requests[0]).not.toHaveProperty("inheritedScope");
    scoped(undefined);
    await provider.invoke("spawn", { task: "z", residency: "durable" }, context);
    expect(resident[2]).not.toHaveProperty("inheritedScope");
  });
});
