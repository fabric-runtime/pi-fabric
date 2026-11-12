import type { ExtensionContext, MessageUpdateEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeFabricConfig } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import type { FabricActionDescriptor } from "../src/protocol.js";
import { mcpToolDescriptor } from "../src/providers/mcp-provider.js";
import { RuntimeStateSpeculation } from "../src/runtime-state-speculation.js";
import { LiteralCallScanner } from "../src/speculation/scanner.js";
import { PythonLiteralCallScanner } from "../src/speculation/python-scanner.js";
import { availablePythonBackends } from "./fixtures/python-backends.js";

const context = {
  cwd: process.cwd(), hasUI: false,
  sessionManager: { getSessionId: () => "speculation-execution", getSessionFile: () => undefined },
} as unknown as ExtensionContext;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

type Kernel = "quickjs" | "monty" | "cpython";
const fixture = (kernel: Kernel = "quickjs", provider = "mcp") => {
  const python = kernel !== "quickjs";
  const config = normalizeFabricConfig({
    executor: { kernel: python ? "python" : "typescript", runtime: "quickjs", pythonRuntime: python ? kernel : "monty", memoryLimitBytes: 256 * 1024 * 1024 },
    speculation: { mcpAllowlist: ["docs.*"] }, approvals: { network: "allow" },
  });
  const descriptor: FabricActionDescriptor = provider === "mcp"
    ? mcpToolDescriptor("docs", { name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: false } })
    : { name: "scheduled", description: "Read scheduled events", inputSchema: { type: "object" }, risk: "read" };
  const ref = `${provider}.${descriptor.name}`;
  const invoke = vi.fn(async () => ({ value: "fresh" }));
  const registry = new ActionRegistry();
  registry.register({ name: provider, description: "Read fixture", async list() { return [descriptor]; }, async describe() { return descriptor; }, invoke });
  const mutation = { name: "transition", description: "Mutation fixture", inputSchema: { type: "object" }, risk: "write" as const };
  registry.register({ name: "state", description: "Mutation fixture", async list() { return [mutation]; }, async describe() { return mutation; }, async invoke() { return {}; } });
  const service = new FabricExecutionService(registry, config);
  // Native CPython exercises only this controlled pure program, as in the existing
  // Python integration tests. Production requires schema-enforced OS isolation.
  const speculation = new RuntimeStateSpeculation(registry, () => config.speculation, () => undefined,
    () => (config.approvals[provider === "mcp" ? "network" : "read"] ?? config.approvals.default ?? "allow") === "allow", python ? "python" : "typescript");
  speculation.tap!.setScannerFactory(() => python ? new PythonLiteralCallScanner() : new LiteralCallScanner());
  cleanups.push(async () => { speculation.reset(); await registry.close(); });
  const code = `return await ${ref}({})`;
  const stream = () => {
    for (const type of ["toolcall_start", "toolcall_delta"] as const) {
      speculation.tap!.handleMessageUpdate({ assistantMessageEvent: {
        type, contentIndex: 0, delta: JSON.stringify({ code }).slice(0, -2),
        partial: { content: [{ type: "toolCall", name: "fabric_exec", id: "streamed-call" }] },
      } } as MessageUpdateEvent, context);
    }
  };
  const execute = (prefix = "") => service.execute({ code: prefix + code, signal: undefined, parentToolCallId: "streamed-call", context, onPartial() {} });
  return { config, descriptor, invoke, registry, speculation, ref, stream, execute };
};

describe.each(["quickjs", "monty", "cpython"] as const)("%s streamed speculative execution", kernel => {
  it.skipIf(kernel !== "quickjs" && !availablePythonBackends[kernel]).each(["mcp", "mesh"])("warms and replays %s before the argument stream ends", async provider => {
    const { invoke, ref, stream, execute } = fixture(kernel, provider);
    stream();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    const result = await execute();
    expect(result.success, result.error).toBe(true);
    expect(result.value).toEqual({ value: "fresh" });
    expect(invoke).toHaveBeenCalledOnce();
    expect(result.audits.find(audit => audit.ref === ref)).toMatchObject({ success: true, speculated: true });
  });
});

describe("MCP speculative policy and fallback", () => {
  it.each(["not allowlisted", "destructive", "not read-only", "ask", "deny"] as const)("refuses launch when %s", async mode => {
    const { config, descriptor, registry, speculation, invoke, ref } = fixture();
    if (mode === "not allowlisted") config.speculation.mcpAllowlist = [];
    if (mode === "destructive") descriptor.annotations = { destructiveHint: true };
    if (mode === "not read-only") descriptor.annotations = { readOnlyHint: false };
    if (mode === "ask" || mode === "deny") config.approvals.network = mode;
    const prepared = await registry.speculate(ref, {}, {
      cwd: context.cwd, signal: undefined, parentToolCallId: "streamed-call", nestedToolCallId: "probe", extensionContext: context, update() {},
    }, {});
    expect(prepared).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
    speculation.reset();
  });

  it("allows the operator's read assertion when MCP annotations are absent", async () => {
    const { descriptor, invoke, stream, execute, ref } = fixture();
    delete descriptor.annotations;
    stream();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    const result = await execute();
    expect(result.success, result.error).toBe(true);
    expect(result.audits.find(audit => audit.ref === ref)?.speculated).toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it.each(["allowlist revoked", "disabled", "approval denied", "descriptor changed", "error", "mutation"] as const)("rechecks the real call after %s", async mode => {
    const { config, descriptor, invoke, stream, execute, ref } = fixture();
    if (mode === "error") invoke.mockRejectedValueOnce(new Error("Speculative failure"));
    stream();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    if (mode === "allowlist revoked") config.speculation.mcpAllowlist = [];
    if (mode === "disabled") config.speculation.enabled = false;
    if (mode === "approval denied") config.approvals.network = "deny";
    if (mode === "descriptor changed") descriptor.annotations = { readOnlyHint: false };
    const result = await execute(mode === "mutation" ? "await state.transition({}); " : "");
    expect(result.success).toBe(mode !== "approval denied");
    expect(invoke).toHaveBeenCalledTimes(mode === "approval denied" ? 1 : 2);
    expect(result.audits.find(audit => audit.ref === ref)?.speculated).not.toBe(true);
    if (result.success) expect(result.value).toEqual({ value: "fresh" });
  });
});
