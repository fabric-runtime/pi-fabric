import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActionRegistry,
  fabricActionListLimit,
  type FabricCallAudit,
} from "../src/core/action-registry.js";
import type {
  FabricInvocationContext,
  FabricProvider,
} from "../src/protocol.js";
import { setActiveRepairCompiler } from "../src/repairs/active.js";
import { RepairCompiler } from "../src/repairs/compiler.js";
import { setActiveCompiledSurface } from "../src/entropy/active.js";
import { FabricExecutionTraceRecorder, readFabricExecutionTraceV1 } from "../src/audit/trace.js";
import { schemaDigest, compileEntropySurface, type CompiledSurfaceFile } from "../src/entropy/index.js";

const provider = (): FabricProvider => ({
  name: "demo",
  description: "Demo provider",
  async list() {
    return [
      {
        name: "echo",
        description: "Echo a string",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        risk: "read",
      },
    ];
  },
  async describe(name) {
    return name === "echo" ? (await this.list({}, context))[0] : undefined;
  },
  async invoke(_name, args, invocationContext) {
    invocationContext.activity?.({ type: "progress", message: "echoing" });
    invocationContext.attachPreview?.({ renderer: "rich" });
    invocationContext.activity?.({
      type: "entity",
      id: "demo-entity",
      kind: "custom",
      name: "Echo operation",
    });
    return args.value;
  },
});

const context: FabricInvocationContext = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "parent",
  nestedToolCallId: "metadata",
  extensionContext: {} as ExtensionContext,
  update() {},
};

const actionProvider = (...names: string[]): FabricProvider => ({
  name: "demo",
  description: "Demo provider",
  async list() {
    return names.map((name) => ({
      name,
      description: `demo ${name}`,
      inputSchema: { type: "object", properties: {} },
      risk: "read" as const,
    }));
  },
  async describe(name) {
    return names.includes(name)
      ? (await this.list({}, context)).find((descriptor) => descriptor.name === name)
      : undefined;
  },
  async invoke(name) {
    return name;
  },
});

const invokeContext = (audits: FabricCallAudit[] = []) => ({
  ...context,
  approve: async () => {},
  audits,
  maxResultChars: 10_000,
});

const repairTmp: string[] = [];
afterEach(() => {
  setActiveRepairCompiler(undefined);
  for (const dir of repairTmp.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const attachCompiler = (): RepairCompiler => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-registry-repairs-"));
  repairTmp.push(agentDir);
  const compiler = new RepairCompiler({ agentDir });
  compiler.setCatalogSurface({ providers: ["demo"], capturedTools: [] });
  setActiveRepairCompiler(compiler);
  return compiler;
};

describe("ActionRegistry", () => {
  it("lists, searches, describes, and invokes providers", async () => {
    const registry = new ActionRegistry();
    registry.register(provider());
    expect((await registry.list({}, context))[0]?.ref).toBe("demo.echo");
    expect((await registry.search("echo", context))[0]?.ref).toBe("demo.echo");
    expect((await registry.describe("demo.echo", context)).risk).toBe("read");

    const approve = vi.fn(async () => {});
    const audits: FabricCallAudit[] = [];
    const result = await registry.invoke("demo.echo", { value: "hello" }, {
      ...context,
      approve,
      audits,
      maxResultChars: 10_000,
    });
    expect(result).toBe("hello");
    expect(approve).toHaveBeenCalledOnce();
    expect(audits).toMatchObject([
      {
        ref: "demo.echo",
        provider: "demo",
        tool: "echo",
        args: { value: "hello" },
        success: true,
      },
    ]);
  });

  it("describes a bare action name through the unique-name fallback", async () => {
    const registry = new ActionRegistry();
    registry.register(provider());
    const described = await registry.describe("echo", context);
    expect(described.ref).toBe("demo.echo");
    expect(described.risk).toBe("read");
  });

  it("rejects a bare action name that matches more than one provider", async () => {
    const registry = new ActionRegistry();
    registry.register(provider());
    registry.register({ ...provider(), name: "demo-two" });
    await expect(registry.describe("echo", context)).rejects.toThrow(
      /qualify with provider\.action: demo-two\.echo, demo\.echo/,
    );
    await expect(registry.describe("missing", context)).rejects.toThrow(
      "Unknown Fabric action: missing",
    );
  });

  it("repairs a near-miss action to the sole semantic synonym", async () => {
    const registry = new ActionRegistry();
    registry.register(actionProvider("recall", "expand", "sessions"));
    const audits: FabricCallAudit[] = [];
    const result = await registry.invoke("demo.search", {}, invokeContext(audits));
    expect(result).toBe("recall");
    expect(audits[0]).toMatchObject({
      ref: "demo.search",
      tool: "recall",
      provider: "demo",
      repairedFrom: "search",
      success: true,
    });
  });

  it("repairs exact spelling forms but only suggests fuzzy action matches", async () => {
    const registry = new ActionRegistry();
    registry.register(actionProvider("checkGoal", "setSteeringMode", "echo", "sessions"));
    expect(await registry.invoke("demo.check_goal", {}, invokeContext())).toBe("checkGoal");
    for (const spelling of ["setSteerMode", "ech", "session"]) {
      await expect(registry.invoke(`demo.${spelling}`, {}, invokeContext())).rejects.toThrow("Unknown Fabric action");
    }
  });

  it("leaves ambiguous synonyms unrepaired and names the candidates", async () => {
    const registry = new ActionRegistry();
    registry.register(actionProvider("ask", "tell"));
    await expect(registry.invoke("demo.say", {}, invokeContext())).rejects.toThrow(
      "Unknown Fabric action: demo.say (did you mean: demo.ask, demo.tell?)",
    );
    const meshLike = new ActionRegistry();
    meshLike.register(actionProvider("get", "read"));
    await expect(meshLike.invoke("demo.fetch", {}, invokeContext())).rejects.toThrow(
      "(did you mean: demo.get, demo.read?)",
    );
  });

  it("keeps the plain unknown-action error when nothing is close", async () => {
    const registry = new ActionRegistry();
    registry.register(actionProvider("echo"));
    const error = await registry.invoke("demo.missing", {}, invokeContext()).then(
      () => null,
      (cause: Error) => cause,
    );
    expect(error?.message).not.toContain("did you mean");
    expect(error?.message).toContain("Unknown Fabric action: demo.missing");
  });

  it("suggests close declared names for bare unknown actions", async () => {
    const registry = new ActionRegistry();
    registry.register(actionProvider("recall", "expand", "sessions"));
    await expect(registry.describe("recal", context)).rejects.toThrow(
      "Unknown Fabric action: recal (did you mean: recall?)",
    );
  });

  it("builds deterministic provider/action heads and searches the complete catalog before ranking", async () => {
    const registry = new ActionRegistry();
    const descriptors = [{
      name: "inspect",
      description: "Inspect stored records",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Local filesystem path" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      risk: "read" as const,
      namespace: "records",
    }];
    registry.register({
      name: "storage",
      description: "Filesystem discovery capabilities",
      async list(request) {
        if (!request.query) return descriptors;
        const query = request.query.toLowerCase();
        return descriptors.filter((descriptor) =>
          `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query),
        );
      },
      async describe(name) {
        return name === "inspect" ? descriptors[0] : undefined;
      },
      async invoke() {
        return null;
      },
    });

    expect((await registry.search("local filesystem path", context))[0]?.ref)
      .toBe("storage.inspect");
    expect((await registry.search("filesystem discovery", context))[0]?.ref)
      .toBe("storage.inspect");

    const first = await registry.catalog(context);
    const second = await registry.catalog(context);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      kind: "pi-fabric.capability-catalog",
      version: 1,
      complete: true,
      totalActions: 1,
      indexedActions: 1,
      root: {
        key: "capability:fabric",
        description: expect.stringContaining("not historical session evidence"),
        descriptorHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      providers: [{
        key: "provider:storage",
        parentKey: "capability:fabric",
        actions: [{
          key: "action:storage.inspect",
          parentKey: "provider:storage",
          ref: "storage.inspect",
          descriptorHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }],
      }],
    });

    const originalHash = first.root.descriptorHash;
    descriptors[0]!.description = "Inspect archived records";
    const drifted = await registry.catalog(context);
    expect(drifted.root.descriptorHash).not.toBe(originalHash);
    expect(drifted.providers[0]!.actions[0]!.ref).toBe("storage.inspect");
  });

  it("emits structured invocation activity without exposing another model tool", async () => {
    const registry = new ActionRegistry();
    registry.register(provider());
    const events: unknown[] = [];
    await registry.invoke("demo.echo", { value: "hello" }, {
      ...context,
      approve: async () => {},
      audits: [],
      maxResultChars: 10_000,
      observeInvocation: (event) => events.push(event),
    });

    expect(events).toMatchObject([
      { type: "call_start", ref: "demo.echo", args: { value: "hello" } },
      { type: "call_update", update: { type: "progress", message: "echoing" } },
      {
        type: "call_update",
        update: { type: "entity", id: "demo-entity", kind: "custom" },
      },
      {
        type: "call_end",
        success: true,
        result: "hello",
        preview: { renderer: "rich" },
      },
    ]);
  });

  it("populates audit preview metadata before invoking the provider", async () => {
    const registry = new ActionRegistry();
    const audits: FabricCallAudit[] = [];
    let observed: FabricCallAudit | undefined;
    registry.register({
      ...provider(),
      async invoke(_name, args) {
        observed = audits[0] ? { ...audits[0] } : undefined;
        return args.value;
      },
    });

    await registry.invoke("demo.echo", { value: "in flight" }, {
      ...context,
      approve: async () => {},
      audits,
      maxResultChars: 10_000,
    });

    expect(observed).toMatchObject({
      ref: "demo.echo",
      provider: "demo",
      tool: "echo",
      args: { value: "in flight" },
    });
    expect(observed?.success).toBeUndefined();
  });

  it("keeps a larger bounded content preview for transient write audits", async () => {
    const registry = new ActionRegistry();
    const audits: FabricCallAudit[] = [];
    const content = "x".repeat(20_000);
    registry.register({
      name: "pi",
      description: "Pi tools",
      async list() {
        return [{
          name: "write",
          description: "Write a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
            additionalProperties: false,
          },
          risk: "write",
        }];
      },
      async describe(name) {
        return name === "write" ? (await this.list({}, context))[0] : undefined;
      },
      async invoke() {
        return { ok: true };
      },
    });

    await registry.invoke(
      "pi.write",
      { path: "preview.md", content },
      {
        ...context,
        approve: async () => {},
        audits,
        maxResultChars: 10_000,
      },
    );

    const preview = audits[0]?.args?.content;
    expect(typeof preview).toBe("string");
    expect((preview as string).length).toBeGreaterThan(2_000);
    expect((preview as string).length).toBeLessThan(content.length);
    expect(preview).toMatch(/…$/);
  });

  it("marks failed agent results as failed nested calls without hiding the result", async () => {
    const registry = new ActionRegistry();
    const audits: FabricCallAudit[] = [];
    const events: unknown[] = [];
    registry.register({
      name: "agents",
      description: "Test agents",
      async list() {
        return [{
          name: "run",
          description: "Run a test agent",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          risk: "agent",
        }];
      },
      async describe(name) {
        return name === "run" ? (await this.list({}, context))[0] : undefined;
      },
      async invoke() {
        return { status: "failed", error: "provider unavailable" };
      },
    });

    const result = await registry.invoke("agents.run", {}, {
      ...context,
      approve: async () => {},
      audits,
      maxResultChars: 10_000,
      observeInvocation: (event) => events.push(event),
    });

    expect(result).toEqual({ status: "failed", error: "provider unavailable" });
    expect(audits).toMatchObject([{ success: false, error: "provider unavailable" }]);
    expect(events.at(-1)).toMatchObject({
      type: "call_end",
      success: false,
      error: "provider unavailable",
    });
  });

  it("bounds retained audit previews without shrinking provider results", async () => {
    const registry = new ActionRegistry();
    const large = "x".repeat(20_000);
    registry.register({
      ...provider(),
      async invoke() {
        return Object.fromEntries(
          Array.from({ length: 8 }, (_, index) => [`field${index}`, large]),
        );
      },
    });
    const audits: FabricCallAudit[] = [];
    const result = (await registry.invoke("demo.echo", { value: "large" }, {
      ...context,
      approve: async () => {},
      audits,
      maxResultChars: 1_000_000,
    })) as Record<string, string>;

    expect(result.field0).toHaveLength(20_000);
    expect(audits[0]?.result).toMatchObject({ fabricTruncated: true });
    expect(JSON.stringify(audits[0]?.result).length).toBeLessThanOrEqual(64_000);
  });

  it("caps nested results before crossing the sandbox bridge", async () => {
    const registry = new ActionRegistry();
    registry.register(provider());
    const audits: FabricCallAudit[] = [];
    const result = await registry.invoke("demo.echo", { value: "x".repeat(100) }, {
      ...context,
      approve: async () => {},
      audits,
      maxResultChars: 40,
    });
    expect(result).toMatchObject({ fabricTruncated: true, originalChars: 102 });
    expect(audits).toMatchObject([{ resultTruncated: true, resultChars: 102 }]);
  });

  it("validates arguments before approval or execution", async () => {
    const registry = new ActionRegistry();
    registry.register(provider());
    const approve = vi.fn(async () => {});
    await expect(
      registry.invoke("demo.echo", { value: 42 }, {
        ...context,
        approve,
        audits: [],
        maxResultChars: 10_000,
      }),
    ).rejects.toThrow("Invalid arguments");
    expect(approve).not.toHaveBeenCalled();
  });

  it("bounds non-cooperative provider invocation finalizers", async () => {
    const registry = new ActionRegistry();
    registry.register({
      ...provider(),
      async invocationEnded() {
        await new Promise(() => undefined);
      },
    });
    const startedAt = Date.now();

    await registry.endInvocation("parent", 20);

    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it.each([false, true])("keeps finalizers tracked without blocking cancellation (already aborted: %s)", async (alreadyAborted) => {
    vi.useFakeTimers();
    const registry = new ActionRegistry();
    const controller = new AbortController();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const invocationEnded = vi.fn(() => pending);
    registry.register({ ...provider(), invocationEnded });
    try {
      if (alreadyAborted) controller.abort();
      const wait = registry.endInvocation("parent", 10_000, controller.signal);
      if (!alreadyAborted) controller.abort();
      await wait;
      expect(invocationEnded).toHaveBeenCalledExactlyOnceWith("parent");
      expect(registry.providerStatus()[0]?.inFlight).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      release();
      await pending;
      await Promise.resolve();
      expect(registry.providerStatus()[0]?.inFlight).toBe(0);
    } finally {
      release();
      vi.useRealTimers();
      await registry.close();
    }
  });

  it("rejects duplicate and malformed provider names", () => {
    const registry = new ActionRegistry();
    registry.register(provider());
    expect(() => registry.register(provider())).toThrow("already registered");
    expect(() => registry.register({ ...provider(), name: "Bad Name" })).toThrow(
      "Invalid Fabric provider name",
    );
  });

  it("explains why marked providers are unavailable", async () => {
    const registry = new ActionRegistry();
    registry.register(provider());
    registry.markUnavailable("memory", "disabled by configuration (memory.enabled=false)");

    expect(registry.unavailableProviders()).toEqual([
      { name: "memory", reason: "disabled by configuration (memory.enabled=false)" },
    ]);
    await expect(registry.describe("memory.recall", context)).rejects.toThrow(
      'Fabric provider "memory" is unavailable: disabled by configuration (memory.enabled=false)',
    );
  });

  it("lists registered providers for unknown provider names", async () => {
    const registry = new ActionRegistry();
    registry.register(provider());

    await expect(registry.describe("memry.recall", context)).rejects.toThrow(
      "Unknown Fabric provider: memry (registered providers: demo)",
    );
  });

  it("rejects marking registered or malformed providers unavailable", () => {
    const registry = new ActionRegistry();
    registry.register(provider());

    expect(() => registry.markUnavailable("demo", "off")).toThrow(
      "Cannot mark a registered Fabric provider unavailable: demo",
    );
    expect(() => registry.markUnavailable("Bad Name", "off")).toThrow(
      "Invalid Fabric provider name",
    );
  });

  it("clears the unavailable mark when the provider later registers", async () => {
    const registry = new ActionRegistry();
    registry.markUnavailable("demo", "off");
    expect(registry.unavailableProviders()).toEqual([{ name: "demo", reason: "off" }]);

    registry.register(provider());

    expect(registry.unavailableProviders()).toEqual([]);
    await expect(registry.describe("demo.echo", context)).resolves.toMatchObject({
      ref: "demo.echo",
    });
  });

  it("persists a unique live action alias and applies it on the next miss", async () => {
    const compiler = attachCompiler();
    const registry = new ActionRegistry();
    registry.register(actionProvider("recall", "expand"));
    expect(await registry.invoke("demo.search", {}, invokeContext())).toBe("recall");
    expect(compiler.repairs).toContainEqual({
      kind: "actionAlias",
      provider: "demo",
      from: "search",
      to: "recall",
    });
  });

  it("does not apply action aliases when a committed capability view is pinned", async () => {
    attachCompiler();
    const registry = new ActionRegistry();
    registry.register(actionProvider("recall", "expand"));
    expect(await registry.invoke("demo.search", {}, invokeContext())).toBe("recall");
    const pinned = await registry.acquireCapabilityView(["demo.recall"], context);
    expect(pinned.satisfied).toBe(true);
    await expect(
      registry.invoke("demo.search", {}, {
        ...invokeContext(),
        capabilityView: pinned.view!,
      }),
    ).rejects.toThrow(/Unknown Fabric action|outside the committed view/);
    await pinned.release();
  });

  it("does not learn accepted extension keys", async () => {
    const compiler = attachCompiler();
    const registry = new ActionRegistry();
    registry.register({
      name: "demo",
      description: "extensible action",
      async list() {
        return [await this.describe("echo", context)].filter((entry) => entry !== undefined);
      },
      async describe(name) {
        return name === "echo"
          ? {
              name: "echo",
              description: "echo",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                additionalProperties: true,
              },
              risk: "read" as const,
            }
          : undefined;
      },
      async invoke(_name, args) {
        return args.val;
      },
    });
    expect(await registry.invoke("demo.echo", { val: "ok" }, invokeContext())).toBe("ok");
    expect(compiler.repairs).toEqual([]);
  });

  it("repairs before provider preparation and scopes the row to the resolved action", async () => {
    const compiler = attachCompiler();
    const proxy = {
      proxy: vi.fn(async (request: {
        value: unknown;
        args: Record<string, unknown>;
      }) => request.value),
    };
    const registry = new ActionRegistry(proxy);
    registry.register({
      name: "demo",
      description: "session action",
      async list() {
        return [await this.describe("recall", context)].filter((entry) => entry !== undefined);
      },
      async describe(name) {
        return name === "recall"
          ? {
              name: "recall",
              description: "recall",
              inputSchema: {
                type: "object",
                properties: { session: { type: "string" } },
                required: ["session"],
                additionalProperties: false,
              },
              risk: "read" as const,
            }
          : undefined;
      },
      async prepareArguments(_name, args) {
        if ("sessionId" in args) throw new Error("preparer received spilled arguments");
        return { ...args, session: String(args.session).trim() };
      },
      async invoke(_name, args) {
        return args.session;
      },
    });
    expect(
      await registry.invoke("demo.search", { sessionId: " s1 " }, invokeContext()),
    ).toBe("s1");
    expect(compiler.repairs).toContainEqual({
      kind: "keyAlias",
      ref: "demo.recall",
      from: "sessionId",
      to: "session",
    });
    expect(proxy.proxy).toHaveBeenCalledWith(
      expect.objectContaining({ args: { session: "s1" }, value: "s1" }),
    );
    expect(compiler.status()).toMatchObject({ invocationErrors: 0 });

    registry.setSpeculation({
      async tryServe() { return { hit: false, reason: "absent" }; },
      bumpEpoch() {},
    }, () => true);
    const speculation = await registry.speculate(
      "demo.recall",
      { sessionId: " s2 " },
      context,
      {},
    );
    expect(speculation?.preparedArgs).toEqual({ session: "s2" });
    await expect(speculation?.execute(undefined)).resolves.toBe("s2");
  });

  it("counts an unrepaired invalid-argument occurrence once", async () => {
    const compiler = attachCompiler();
    const registry = new ActionRegistry();
    registry.register({
      name: "demo",
      description: "ambiguous session action",
      async list() {
        return [await this.describe("expand", context)].filter((entry) => entry !== undefined);
      },
      async describe(name) {
        return name === "expand"
          ? {
              name: "expand",
              description: "expand",
              inputSchema: {
                type: "object",
                properties: { session: { type: "string" }, path: { type: "string" } },
                required: ["session"],
                additionalProperties: false,
              },
              risk: "read" as const,
            }
          : undefined;
      },
      async invoke() { return undefined; },
    });
    await expect(
      registry.invoke("demo.expand", { id: "ambiguous" }, invokeContext()),
    ).rejects.toThrow("Invalid arguments");
    expect(compiler.repairs).toEqual([]);
    expect(compiler.status()).toMatchObject({
      invocationErrors: 1,
      fingerprints: [expect.objectContaining({ count: 1, fingerprint: "args:demo.expand:id" })],
    });
  });

  it("repairs scoped acquisition arguments before provider preparation", async () => {
    const compiler = attachCompiler();
    const dispose = vi.fn(async () => {});
    const registry = new ActionRegistry();
    registry.register({
      name: "demo",
      description: "scoped session action",
      async list() {
        return [await this.describe("open", context)].filter((entry) => entry !== undefined);
      },
      async describe(name) {
        return name === "open"
          ? {
              name: "open",
              description: "open",
              inputSchema: {
                type: "object",
                properties: { session: { type: "string" } },
                required: ["session"],
                additionalProperties: false,
              },
              risk: "execute" as const,
              effect: { kind: "scoped" as const, resources: ["session"], ordering: "ordered" as const },
            }
          : undefined;
      },
      async prepareArguments(_name, args) {
        if ("sessionId" in args) throw new Error("preparer received spilled arguments");
        return args;
      },
      async invoke() {
        throw new Error("use acquire");
      },
      async acquire(_name, args) {
        return { value: args.session, dispose };
      },
    });
    const acquired = await registry.acquireScoped("demo.open", { sessionId: "s1" }, context);
    expect(acquired.value).toBe("s1");
    expect(compiler.repairs).toContainEqual({
      kind: "keyAlias",
      ref: "demo.open",
      from: "sessionId",
      to: "session",
    });
    await acquired.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

const liveEchoSchema = () => ({
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
});

const overlayArtifact = (baseSchema: unknown): CompiledSurfaceFile => ({
  version: 1,
  metricVersion: 2,
  actions: [
    {
      ref: "demo.echo",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string", enum: ["alpha", "beta"] } },
        required: ["value"],
        additionalProperties: false,
      },
      baseSchemaDigest: schemaDigest(baseSchema),
    },
  ],
  quarantined: [],
  applied: [
    { kind: "enum-tighten", ref: "demo.echo", detail: "value: 2 observed values" },
  ],
  gate: { passed: true, beforeScore: 0.25, afterScore: 0.18, reasons: [] },
  evidenceDigest: "test",
});

describe("compiled entropy capability preservation", () => {
  afterEach(() => {
    setActiveCompiledSurface(undefined);
  });

  it("never enforces legacy restrictions at the validate stage", async () => {
    const registry = new ActionRegistry();
    registry.register(provider());
    await registry.invoke("demo.echo", { value: "free-form" }, invokeContext());
    setActiveCompiledSurface(overlayArtifact(liveEchoSchema()));
    await registry.invoke("demo.echo", { value: "alpha" }, invokeContext());
    await expect(
      registry.invoke("demo.echo", { value: "off-modal" }, invokeContext()),
    ).resolves.toBe("off-modal");
  });

  it("preserves declared enum members and rejects out-of-domain values without persisting them", async () => {
    const enumProvider = (): FabricProvider => ({
      name: "demo",
      description: "Demo provider",
      async list() {
        return [
          {
            name: "echo",
            description: "Echo a string",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string", enum: ["alpha", "beta"] } },
              required: ["value"],
              additionalProperties: false,
            },
            risk: "read" as const,
          },
        ];
      },
      async describe(name) {
        return name === "echo" ? (await this.list({}, context))[0] : undefined;
      },
      async invoke(_name, args) {
        return (args as { value: string }).value;
      },
    });
    const liveEnumSchema = () => ({
      type: "object",
      properties: { value: { type: "string", enum: ["alpha", "beta"] } },
      required: ["value"],
      additionalProperties: false,
    });
    const tightOverlay = (): CompiledSurfaceFile => ({
      version: 1,
      metricVersion: 2,
      actions: [
        {
          ref: "demo.echo",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string", enum: ["alpha"] } },
            required: ["value"],
            additionalProperties: false,
          },
          baseSchemaDigest: schemaDigest(liveEnumSchema()),
        },
      ],
      quarantined: [],
      applied: [{ kind: "enum-tighten", ref: "demo.echo", detail: "value: 1 observed values" }],
      gate: { passed: true, beforeScore: 0.25, afterScore: 0.18, reasons: [] },
      evidenceDigest: "test",
    });
    const registry = new ActionRegistry();
    registry.register(enumProvider());
    setActiveCompiledSurface(tightOverlay());
    const audits: FabricCallAudit[] = [];
    await registry.invoke("demo.echo", { value: "alpha" }, invokeContext(audits));
    await expect(
      registry.invoke("demo.echo", { value: "beta" }, invokeContext(audits)),
    ).resolves.toBe("beta");
    await expect(
      registry.invoke("demo.echo", { value: "untrusted-secret" }, invokeContext(audits)),
    ).rejects.toThrow(/Invalid arguments for demo\.echo/);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ ref: "demo.echo", success: true });
    expect(audits[1]).toMatchObject({
      ref: "demo.echo",
      tool: "echo",
      provider: "demo",
      success: true,
      args: { value: "beta" },
    });
    expect(audits[1]?.startedAt).toBeGreaterThan(0);
    expect(audits[1]?.endedAt).toBeGreaterThanOrEqual(audits[1]?.startedAt ?? 0);
    expect(JSON.stringify(audits)).not.toContain("untrusted-secret");
  });

  it("drops the overlay when the live schema changed underneath the compile", async () => {
    const registry = new ActionRegistry();
    registry.register(provider());
    setActiveCompiledSurface(
      overlayArtifact({ type: "object", properties: { other: { type: "string" } } }),
    );
    await registry.invoke("demo.echo", { value: "still free" }, invokeContext());
  });

  it("keeps legacy-quarantined refs visible and callable", async () => {
    const registry = new ActionRegistry();
    registry.register(provider());
    expect((await registry.list({ limit: 10 }, context)).map((a) => a.ref)).toEqual([
      "demo.echo",
    ]);
    setActiveCompiledSurface({
      version: 1,
      metricVersion: 2,
      actions: [],
      quarantined: [{ ref: "demo.echo", baseSchemaDigest: schemaDigest(liveEchoSchema()) }],
      applied: [
        { kind: "noise-quarantine", ref: "demo.echo", detail: "2 failed vs 1 succeeded" },
      ],
      gate: { passed: true, beforeScore: 0.25, afterScore: 0.18, reasons: [] },
      evidenceDigest: "test",
    });
    expect((await registry.list({ limit: 10 }, context)).map((action) => action.ref)).toEqual(["demo.echo"]);
    await expect(
      registry.invoke("demo.echo", { value: "x" }, invokeContext()),
    ).resolves.toBe("x");
  });
  it("keeps one unchanged canonical schema in model-facing discovery", async () => {
    const registry = new ActionRegistry();
    registry.register(provider());
    const artifact = overlayArtifact(liveEchoSchema());
    setActiveCompiledSurface(artifact);
    const listed = await registry.list({ limit: 10 }, context);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.inputSchema).toEqual(liveEchoSchema());
    const declared = await registry.list({ limit: 10, declared: true }, context);
    expect(declared[0]!.inputSchema).toEqual(liveEchoSchema());
  });

  it("keeps quarantined refs in the declared view for compile snapshots", async () => {
    const registry = new ActionRegistry();
    registry.register(provider());
    setActiveCompiledSurface({
      version: 1,
      metricVersion: 2,
      actions: [],
      quarantined: [{ ref: "demo.echo", baseSchemaDigest: schemaDigest(liveEchoSchema()) }],
      applied: [
        { kind: "noise-quarantine", ref: "demo.echo", detail: "2 failed vs 1 succeeded" },
      ],
      gate: { passed: true, beforeScore: 0.25, afterScore: 0.18, reasons: [] },
      evidenceDigest: "test",
    });
    expect((await registry.list({ limit: 10 }, context)).map((action) => action.ref)).toEqual(["demo.echo"]);
    const declared = await registry.list({ limit: 10, declared: true }, context);
    expect(declared.map((action) => action.ref)).toEqual(["demo.echo"]);
  });

  it("preserves speculation capabilities despite legacy restrictions", async () => {
    const registry = new ActionRegistry();
    registry.register(provider());
    registry.setSpeculation(undefined, () => true);
    const replay = {} as Parameters<typeof registry.speculate>[3];
    setActiveCompiledSurface(overlayArtifact(liveEchoSchema()));
    expect(
      await registry.speculate("demo.echo", { value: "off-modal" }, invokeContext(), replay),
    ).toMatchObject({ preparedArgs: { value: "off-modal" } });
    const launched = await registry.speculate(
      "demo.echo",
      { value: "alpha" },
      invokeContext(),
      replay,
    );
    expect(launched?.preparedArgs).toEqual({ value: "alpha" });
    setActiveCompiledSurface({
      version: 1,
      metricVersion: 2,
      actions: [],
      quarantined: [{ ref: "demo.echo", baseSchemaDigest: schemaDigest(liveEchoSchema()) }],
      applied: [
        { kind: "noise-quarantine", ref: "demo.echo", detail: "2 failed vs 1 succeeded" },
      ],
      gate: { passed: true, beforeScore: 0.25, afterScore: 0.18, reasons: [] },
      evidenceDigest: "test",
    });
    expect(
      await registry.speculate("demo.echo", { value: "alpha" }, invokeContext(), replay),
    ).toMatchObject({ preparedArgs: { value: "alpha" } });
    registry.setSpeculation(undefined);
  });

  it("normalizes on the first call without a corpus, preserves approval, and records a bounded witness", async () => {
    const registry = new ActionRegistry();
    const p = provider();
    const invoke = vi.fn(p.invoke.bind(p));
    registry.register({ ...p, invoke });
    const snapshot = { version: 1 as const, actions: [{ ref: "demo.echo", inputSchema: liveEchoSchema() }] };
    const compiled = compileEntropySurface({ traces: [], surface: snapshot });
    expect(compiled.artifact?.normalizations).toHaveLength(1);
    setActiveCompiledSurface(undefined, true);
    const recorder = new FabricExecutionTraceRecorder();
    const approve = vi.fn(async () => {});
    const raw = { VALUE: "sensitive payload" };
    const value = await registry.invoke("demo.echo", raw, { ...invokeContext(), approve, trace: recorder });
    expect(value).toBe("sensitive payload");
    expect(raw).toEqual({ VALUE: "sensitive payload" });
    expect(invoke).toHaveBeenCalledOnce();
    expect(approve).toHaveBeenCalledWith(expect.anything(), { value: "sensitive payload" }, expect.any(AbortSignal));
    const trace = recorder.seal("succeeded", []);
    expect(readFabricExecutionTraceV1(trace)).toBe(trace);
    const witness = trace.operations[0]!.normalization!;
    expect(witness.rules).toEqual([{ kind: "key-form", key: "value" }]);
    expect(JSON.stringify(witness)).not.toContain("sensitive payload");
    expect(readFabricExecutionTraceV1({ ...trace, operations: [{ ...trace.operations[0], normalization: { ...witness, beforeShape: "raw-secret" } }] })).toBeUndefined();
    setActiveCompiledSurface(undefined);
    await expect(registry.invoke("demo.echo", raw, invokeContext())).rejects.toThrow("Invalid arguments");
  });

  it.each(["guard", "approve", "invoke"] as const)("never masks a %s failure or bypasses its gate", async (stage) => {
    const registry = new ActionRegistry();
    const p = provider();
    const invoke = vi.fn(async () => { if (stage === "invoke") throw new Error("effect failed"); return "ok"; });
    registry.register({ ...p, invoke });
    setActiveCompiledSurface(undefined, true);
    const recorder = new FabricExecutionTraceRecorder();
    const approve = vi.fn(async () => { if (stage === "approve") throw new Error("approval denied"); });
    const authorize = vi.fn(async () => { if (stage === "guard") throw new Error("authorization denied"); });
    await expect(registry.invoke("demo.echo", { VALUE: "x" }, { ...invokeContext(), authorize, approve, trace: recorder })).rejects.toThrow();
    const operation = recorder.seal("failed", []).operations[0]!;
    expect(operation).toMatchObject({ outcome: "failed", failureStage: stage });
    expect(invoke).toHaveBeenCalledTimes(stage === "invoke" ? 1 : 0);
    if (stage === "guard") expect(operation.normalization).toBeUndefined();
    else expect(operation.normalization?.rules).toEqual([{ kind: "key-form", key: "value" }]);
  });

  it("preserves provider preparation precedence over generic normal forms", async () => {
    const registry = new ActionRegistry();
    const p = provider();
    registry.register({ ...p, prepareArguments(_name, args) {
      if (args.VALUE === "deny") throw new Error("provider preparation refused");
      return Object.hasOwn(args, "VALUE") ? { value: "provider interpretation" } : args;
    } });
    setActiveCompiledSurface(undefined, true);
    expect(await registry.invoke("demo.echo", { VALUE: "x" }, invokeContext())).toBe("provider interpretation");
    await expect(registry.invoke("demo.echo", { VALUE: "deny" }, invokeContext())).rejects.toThrow("provider preparation refused");
  });

  it("uses the same normal form in speculation without changing discovery", async () => {
    const registry = new ActionRegistry();
    registry.register(provider());
    registry.setSpeculation(undefined, () => true);
    setActiveCompiledSurface(undefined, true);
    const replay = {} as Parameters<typeof registry.speculate>[3];
    expect((await registry.speculate("demo.echo", { VALUE: "x" }, invokeContext(), replay))?.preparedArgs).toEqual({ value: "x" });
    expect((await registry.describe("demo.echo", context)).inputSchema).toEqual(liveEchoSchema());
    registry.setSpeculation(undefined);
  });
});

describe("ActionRegistry list pagination", () => {
  it("keeps list() paging silent while listDetailed() reports totals", async () => {
    const registry = new ActionRegistry();
    registry.register(actionProvider("a", "b", "c", "d", "e"));
    expect(await registry.list({ limit: 2 }, context)).toHaveLength(2);
    expect(await registry.list({}, context)).toHaveLength(5);
    const detailed = await registry.listDetailed({ limit: 2 }, context);
    expect(detailed.actions).toHaveLength(2);
    expect(detailed.total).toBe(5);
    expect(await registry.listDetailed({}, context)).toMatchObject({ total: 5 });
  });

  it("caps list() at the hard ceiling and keeps totals honest", async () => {
    const registry = new ActionRegistry();
    const many = Array.from({ length: 12 }, (_, i) => `n${i}`);
    registry.register(actionProvider(...many));
    expect(await registry.list({ limit: 1000 }, context)).toHaveLength(12);
    const detailed = await registry.listDetailed({ limit: 3 }, context);
    expect(detailed.total).toBe(12);
    expect(fabricActionListLimit(undefined)).toBe(100);
    expect(fabricActionListLimit(5000)).toBe(1000);
    expect(fabricActionListLimit(0)).toBe(1);
  });
});

