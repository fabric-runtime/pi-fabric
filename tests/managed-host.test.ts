import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ExtensionRunner, RegisteredTool } from "@earendil-works/pi-coding-agent";
import { FabricManagedHost } from "../src/managed-host.js";
import { FabricState } from "../src/fabric-state.js";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { createProviderComponent, FabricProviderComponentManifest } from "../src/components/provider-component.js";
import { FabricComponentCatalog } from "../src/components/catalog.js";
import { FabricComponentLoader } from "../src/components/loader.js";
import { FabricComponentSupervisor } from "../src/components/supervisor.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { ApprovalController } from "../src/core/approval-controller.js";
import { RuntimeStateBuiltins } from "../src/runtime-state-builtins.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import { CapturedToolsProvider } from "../src/providers/captured-tools-provider.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import type { FabricProvider } from "../src/protocol.js";

const provider = (name: string): FabricProvider => ({name, description: "authorized", list: async () => [{name: "run", description: "authorized", inputSchema: {type: "object", properties: {}}, risk: "agent"}], describe: async (action) => action === "run" ? {name: "run", description: "authorized", inputSchema: {type: "object", properties: {}}, risk: "agent"} : undefined, invoke: async () => "broker", close: vi.fn(async () => undefined)});
const ctx = {cwd: "/work", signal: undefined, parentToolCallId: "test", nestedToolCallId: "nested", extensionContext: {} as ExtensionContext, update() {}};
const invocation = () => ({...ctx, approve: async () => undefined, audits: [], maxResultChars: 10000});

describe("explicit managed host", () => {
  it("preserves default reserved-name rejection, even with overwrite", () => {
    const state = new FabricState({} as ExtensionAPI, new CapturedToolCatalog());
    for (const name of ["agents", "memory", "compact", "schema", "state", "mesh", "mcp"]) expect(() => state.registerExternal(provider(name), {overwrite: true})).toThrow(/Reserved/);
  });
  it("accepts only exact host-authorized names before sealing", () => {
    const host = new FabricManagedHost({providers: ["agents"]});
    const agents = provider("agents");
    expect(() => host.register(provider("memory"), true)).toThrow(/not authorized/);
    expect(() => host.seal()).toThrow(/missing/);
    host.register(agents, true); host.seal();
    host.register(agents, true);
    expect(() => host.register(provider("agents"), true)).toThrow(/sealed/);
    for (const name of ["pi", "extensions", "components", "fabric", "agents.evil"]) expect(() => new FabricManagedHost({providers: [name]})).toThrow(/cannot replace/);
  });
  it("publishes only replacements across reload, then withdraws and closes once", async () => {
    const host = new FabricManagedHost({providers: ["agents", "memory", "mesh", "state"]});
    const agents = provider("agents");
    host.register(agents); host.register(provider("memory")); host.register(provider("mesh")); host.register(provider("state")); host.seal();
    const registry = new ActionRegistry();
    const catalog = new FabricComponentCatalog();
    const supervisor = new FabricComponentSupervisor(registry, {invocationContext: () => ctx});
    const loader = new FabricComponentLoader(catalog, supervisor);
    const builtins = new RuntimeStateBuiltins(new FabricProviderComponentManifest(catalog, loader), registry, () => undefined, host);
    const native = vi.fn(() => provider("agents"));
    await builtins.install(createProviderComponent({provider: "agents", description: "native", create: native}));
    await builtins.install(createProviderComponent({provider: "schema", description: "native", create: () => {throw new Error("native schema constructed");}}));
    await builtins.memory({sessionManager: {getSessionFile: () => {throw new Error("native source discovery");}}} as unknown as ExtensionContext, host.config(), "test");
    expect(await registry.invoke("agents.run", {}, invocation())).toBe("broker");
    expect(await registry.describe("memory.run", ctx)).toBeDefined();
    await builtins.mesh(host.config(), undefined as never, undefined as never, undefined as never);
    expect(await registry.invoke("state.run", {}, invocation())).toBe("broker");
    expect(await registry.invoke("mesh.run", {}, invocation())).toBe("broker");
    await loader.reload("fabric.provider.agents");
    expect(await registry.invoke("agents.run", {}, invocation())).toBe("broker");
    expect(native).not.toHaveBeenCalled();
    expect(agents.close).not.toHaveBeenCalled();
    await expect(registry.invoke("schema.commit", {}, invocation())).rejects.toThrow();
    await loader.close();
    expect(registry.has("agents")).toBe(false);
    await host.close(); await host.close();
    expect(agents.close).toHaveBeenCalledOnce();
  });
  it("delegates network approval only to sealed live host providers", async () => {
    vi.stubEnv("PI_FABRIC_GRANTED_RISKS", "network");
    try {
      const host = new FabricManagedHost({ providers: ["mcp"] });
      const approvals = new ApprovalController(host.config().approvals, ctx.extensionContext,
        undefined, undefined, undefined, name => host.ownsProvider(name));
      const action = { name: "read", description: "brokered", inputSchema: {}, risk: "network" as const,
        ref: "mcp.read", provider: "mcp" };
      await expect(approvals.approve(action)).rejects.toThrow("denied");
      host.register(provider("mcp"));
      await expect(approvals.approve(action)).rejects.toThrow("denied");
      host.seal();
      expect(host.config().approvals.network).toBe("deny");
      await expect(approvals.approve(action)).resolves.toBeUndefined();
      approvals.sessionApprovals.approvedRisks.add("network");
      for (const name of ["external", "mcp-other", "pi", "extensions"]) {
        await expect(approvals.approve({ ...action, ref: `${name}.read`, provider: name }))
          .rejects.toThrow("denied");
      }
      await host.close();
      await expect(approvals.approve(action)).rejects.toThrow("denied");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("owns independent output ceilings and freezes the host snapshot", () => {
    const executor = { maxOutputChars: 262_144, maxNestedResultChars: 123_456 };
    const host = new FabricManagedHost({ providers: [], executor });
    executor.maxOutputChars = 1;
    expect(host.config().executor).toMatchObject({ maxCpuSliceMs: 1000, maxOutputChars: 262_144, maxNestedResultChars: 123_456 });
    const mutated = host.config();
    mutated.executor.maxOutputChars = 2;
    mutated.executor.maxNestedResultChars = 3;
    expect(host.config().executor).toMatchObject({ maxOutputChars: 262_144, maxNestedResultChars: 123_456 });
    expect(Object.isFrozen(host.options.executor)).toBe(true);
    // JavaScript callers can pass undefined despite exactOptionalPropertyTypes.
    const defaults = new FabricManagedHost({ providers: [], executor: { maxOutputChars: undefined } as never });
    expect(defaults.config().executor.maxOutputChars).toBe(DEFAULT_FABRIC_CONFIG.executor.maxOutputChars);
    expect(defaults.config().executor.maxNestedResultChars).toBe(DEFAULT_FABRIC_CONFIG.executor.maxNestedResultChars);
    const finalOnly = new FabricManagedHost({ providers: [], executor: { maxOutputChars: 262_144 } });
    expect(finalOnly.config().executor).toMatchObject({ maxOutputChars: 262_144, maxNestedResultChars: DEFAULT_FABRIC_CONFIG.executor.maxNestedResultChars });
    const nestedOnly = new FabricManagedHost({ providers: [], executor: { maxNestedResultChars: 123_456 } });
    expect(nestedOnly.config().executor).toMatchObject({ maxOutputChars: DEFAULT_FABRIC_CONFIG.executor.maxOutputChars, maxNestedResultChars: 123_456 });
  });
  it("normalizes nullable host ceilings independently to their numeric defaults", () => {
    const defaults = new FabricManagedHost({ providers: [], executor: { maxOutputChars: null, maxNestedResultChars: null } });
    expect(defaults.config().executor).toMatchObject({
      maxOutputChars: DEFAULT_FABRIC_CONFIG.executor.maxOutputChars,
      maxNestedResultChars: DEFAULT_FABRIC_CONFIG.executor.maxNestedResultChars,
    });
    expect(defaults.options.executor).toMatchObject({
      maxOutputChars: DEFAULT_FABRIC_CONFIG.executor.maxOutputChars,
      maxNestedResultChars: DEFAULT_FABRIC_CONFIG.executor.maxNestedResultChars,
    });
    const finalDefault = new FabricManagedHost({ providers: [], executor: { maxOutputChars: null, maxNestedResultChars: 123_456 } });
    expect(finalDefault.config().executor).toMatchObject({ maxOutputChars: DEFAULT_FABRIC_CONFIG.executor.maxOutputChars, maxNestedResultChars: 123_456 });
    const nestedDefault = new FabricManagedHost({ providers: [], executor: { maxOutputChars: 262_144, maxNestedResultChars: null } });
    expect(nestedDefault.config().executor).toMatchObject({ maxOutputChars: 262_144, maxNestedResultChars: DEFAULT_FABRIC_CONFIG.executor.maxNestedResultChars });
  });
  it("rejects malformed host output limits rather than accepting ambient or fallback values", () => {
    for (const key of ["maxOutputChars", "maxNestedResultChars"] as const) {
      for (const value of ["100", false, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => new FabricManagedHost({ providers: [], executor: { [key]: value } as never }))
          .toThrow(`managedHost.executor.${key} must be a positive safe integer`);
      }
    }
  });
  it("fixes the execution policy independently of ambient configuration", () => {
    const host = new FabricManagedHost({providers: []});
    const config = host.config();
    expect(config.executor.runtime).toBe("quickjs");
    expect(config.executor.kernel).toBe("typescript");
    expect(config.mcp.enabled || config.mesh.enabled || config.memory.enabled || config.agents.enabled).toBe(false);
    config.executor.runtime = "node-process";
    config.components.push({id: "evil", component: "evil", config: {}});
    expect(host.config().executor.runtime).toBe("quickjs");
    expect(host.config().components).toEqual([]);
  });
  it("requires captured core overrides and does not intercept git worktree on the native host", async () => {
    const catalog = new CapturedToolCatalog();
    const broker = vi.fn(async () => ({content: [{type: "text" as const, text: "broker shell"}], details: {}}));
    const runner = {createContext: () => ({}), getActiveTools: () => [], emit: async () => undefined, emitToolCall: async () => undefined, emitToolResult: async () => undefined} as unknown as ExtensionRunner;
    const tool = {definition: {name: "bash", label: "bash", description: "broker", parameters: {type: "object", properties: {command: {type: "string"}}, required: ["command"]}, execute: broker}, sourceInfo: {path: "/host/broker.ts", source: "inline", scope: "temporary", origin: "top-level"}} as unknown as RegisteredTool;
    catalog.replace([tool], runner, DEFAULT_FABRIC_CONFIG.capture, "/host/fabric.ts");
    const tools = new PiToolsProvider("/does-not-exist", catalog, new CapturedToolsProvider(catalog), {requireCapturedOverrides: true, powerShellToolDefinitionFactory: undefined});
    expect(await tools.invoke("bash", {command: "git worktree add /outside"}, ctx)).toMatchObject({ok: true, output: "broker shell"});
    expect(broker).toHaveBeenCalledOnce();
    catalog.replace([], runner, DEFAULT_FABRIC_CONFIG.capture, "/host/fabric.ts");
    await expect(tools.invoke("read", {path: "/etc/passwd"}, ctx)).rejects.toThrow(/requires an authorized/);
    await expect(tools.invoke("bash", {command: "echo unsafe"}, ctx)).rejects.toThrow(/requires an authorized/);
  });
});
