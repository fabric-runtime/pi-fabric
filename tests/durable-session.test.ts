import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentSession, createExtensionRuntime, createSyntheticSourceInfo, ModelRuntime, SessionManager, SettingsManager,
  type CreateAgentSessionOptions, type Extension, type ResourceLoader, type ToolDefinition,
  type ToolCallEvent, type BeforeProviderHeadersEvent, type ContextEvent,
} from "@earendil-works/pi-coding-agent";
import { DurableAgent } from "../src/durable/agent.js";
import { createDurableAgentSession } from "../src/durable/session.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "fabric-durable-session-"));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const faux = fauxProvider({ provider: "offline", models: [{ id: "test", reasoning: true, input: ["text", "image"] }], tokensPerSecond: 100000 });
  modelRuntime.registerNativeProvider({ ...faux.provider, auth: { apiKey: { name: "Offline", resolve: async () => ({
    auth: { apiKey: "offline-key", headers: { "x-model-header": "configured" } },
  }) } } });
  await modelRuntime.setRuntimeApiKey("offline", "offline-key");
  await modelRuntime.getAvailable();
  const extension: Extension = {
    path: "<inline:guard>", resolvedPath: "<inline:guard>",
    sourceInfo: createSyntheticSourceInfo("<inline:guard>", { source: "inline" }),
    handlers: new Map(), tools: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(), messageRenderers: new Map(),
  };
  const runtime = createExtensionRuntime();
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [extension], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Isolated durable test assistant", getSystemPromptSource: () => extension.sourceInfo,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
  };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const sessionManager = SessionManager.inMemory(cwd);
  const storage = new MemoryStorage();
  const create = async (overrides: Partial<CreateAgentSessionOptions> = {}) => {
    const host = await createDurableAgentSession({ cwd, modelRuntime, model: faux.getModel(), resourceLoader, settingsManager,
      sessionManager, storage, runId: `session-${Math.random().toString(36).slice(2)}`, ...overrides });
    cleanup.push(() => host.close());
    return host;
  };
  return { cwd, faux, modelRuntime, extension, resourceLoader, settingsManager, sessionManager, storage, create };
}

const tool = (execute: ToolDefinition["execute"]): ToolDefinition => ({
  name: "effect", label: "Effect", description: "An effect", parameters: Type.Object({}), execute,
});

describe("durable public SDK host", () => {
  it.each(["missing", "prefix"] as const)("reconciles %s native history before recovered tools/requests without hook replay", async mode => {
    const f = await fixture();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const effect = vi.fn(async (_id, _args, signal) => {
      entered();
      await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { content: [{ type: "text" as const, text: "late effect" }], details: {} };
    });
    f.sessionManager.appendMessage({ role: "system", content: "prior system seed", timestamp: 1,
      toolsAdded: [{ name: "legacy", description: "historical only", parameters: Type.Object({}) }] });
    f.sessionManager.appendMessage({ role: "user", content: "prior history seed", timestamp: 2 });
    const before = vi.fn(); const after = vi.fn(); const messageEnd = vi.fn();
    f.extension.handlers.set("before_agent_start", [before]);
    f.extension.handlers.set("agent_end", [after]);
    f.extension.handlers.set("message_end", [messageEnd]);
    const options = { cwd: f.cwd, modelRuntime: f.modelRuntime, model: f.faux.getModel(), resourceLoader: f.resourceLoader,
      settingsManager: f.settingsManager, storage: f.storage, runId: "recovery", tools: ["effect"], customTools: [tool(effect)] };
    const first = await createDurableAgentSession({ ...options, sessionManager: f.sessionManager });
    await first.session.bindExtensions({});
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}, { id: "interrupted" }), { stopReason: "toolUse" })]);
    const run = first.session.prompt("recovered user request").catch(() => {});
    await started;
    await first.agent.close(); await run; first.session.dispose();
    const prefix = f.sessionManager.getEntries();
    const callIndex = prefix.findIndex(entry => entry.type === "message" && entry.message.role === "assistant");
    const manager = SessionManager.inMemory(f.cwd, undefined, mode === "prefix" ? prefix.slice(0, callIndex) : undefined);
    const beforeCount = before.mock.calls.length; const afterCount = after.mock.calls.length;
    const ends = messageEnd.mock.calls.length;
    const second = await createDurableAgentSession({ ...options, sessionManager: manager, tools: [], customTools: [] });
    cleanup.push(() => second.close());
    await second.session.bindExtensions({});
    f.faux.setResponses([context => {
      const text = JSON.stringify(context.messages);
      expect(text).toContain("prior history seed"); expect(text).toContain("prior system seed");
      expect(text).toContain("recovered user request"); expect(text).toContain("interrupted");
      return fauxAssistantMessage("restored reply");
    }]);
    await second.agent.continue();
    expect(second.session.getLastAssistantText()).toBe("restored reply");
    expect(effect).toHaveBeenCalledOnce(); expect(before).toHaveBeenCalledTimes(beforeCount);
    expect(after).toHaveBeenCalledTimes(afterCount + 1);
    // Only the interrupted result, current loadout change, and new response are delivered.
    expect(messageEnd.mock.calls.slice(ends).some(([event]) => JSON.stringify(event).includes("recovered user request"))).toBe(false);
    const messages = manager.buildSessionContext().messages;
    expect(messages.filter(m => m.role === "user" && m.content === "prior history seed")).toHaveLength(1);
    expect(messages.filter(m => m.role === "user" && JSON.stringify(m.content).includes("recovered user request"))).toHaveLength(1);
    expect(messages.filter(m => m.role === "assistant" && m.content.some(c => c.type === "toolCall"))).toHaveLength(1);
    expect(JSON.stringify(messages)).toContain("legacy");
    expect(second.session.getActiveToolNames()).toEqual([]);
    const entries = manager.getEntries().length;
    await second.agent.recoverHistory?.(second.agent.state.messages);
    expect(manager.getEntries()).toHaveLength(entries);
  });

  it.each(["compaction", "branch", "edit"] as const)("keeps native %s projection authoritative during reconciliation", async mode => {
    const f = await fixture();
    const first = f.sessionManager.appendMessage({ role: "user", content: "old context", timestamp: 1 });
    const kept = f.sessionManager.appendMessage({ role: "user", content: "kept context", timestamp: 2 });
    const history = f.sessionManager.buildSessionContext().messages;
    if (mode === "compaction") f.sessionManager.appendCompaction("summary", kept, 100);
    if (mode === "branch") f.sessionManager.branchWithSummary(first, "branch summary");
    if (mode === "edit") f.sessionManager.appendContextEdit(kept, null);
    const projection = f.sessionManager.buildSessionContext().messages;
    const host = await f.create({ tools: [] });
    const count = f.sessionManager.getEntries().length;
    await host.agent.recoverHistory?.(history);
    expect(f.sessionManager.getEntries()).toHaveLength(count);
    expect(host.agent.state.messages).toEqual(projection);
  });

  it("preserves repeated identical messages and reconstructs a missing compacted seed", async () => {
    const f = await fixture(); const host = await f.create({ tools: [] });
    const repeated = { role: "user" as const, content: "same", timestamp: 1 };
    f.sessionManager.appendMessage(repeated);
    await host.agent.recoverHistory?.([repeated, repeated]);
    expect(f.sessionManager.buildSessionContext().messages).toEqual([repeated, repeated]);
    await host.agent.recoverHistory?.([repeated, repeated]);
    expect(f.sessionManager.buildSessionContext().messages).toEqual([repeated, repeated]);
    const manager = SessionManager.inMemory(f.cwd);
    const compacted = await f.create({ tools: [], sessionManager: manager });
    await compacted.agent.recoverHistory?.([
      { role: "system", content: "seed system", timestamp: 1 },
      { role: "compactionSummary", summary: "seed summary", tokensBefore: 100, timestamp: 2 },
      repeated,
    ]);
    expect(JSON.stringify(manager.buildSessionContext().messages)).toContain("seed summary");
    expect(JSON.stringify(manager.buildSessionContext().messages)).toContain("seed system");
    expect(manager.buildSessionContext().messages.at(-1)).toEqual(repeated);
  });

  it.each(["steer", "followUp"] as const)("awaits durable admission before native %s acknowledgment", async method => {
    const f = await fixture(); const host = await f.create({ tools: [] });
    await host.session.bindExtensions({});
    let release!: () => void; let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const commit = f.storage.commit.bind(f.storage);
    vi.spyOn(f.storage, "commit").mockImplementation(async (...args) => { reached(); await gate; return commit(...args); });
    let acknowledged = false;
    const control = host.session[method]("durable control").then(result => { acknowledged = true; return result; });
    await entered; expect(acknowledged).toBe(false);
    release(); await control; await host.agent.awaitControls();
    expect(host.agent.hasQueuedMessages()).toBe(true);
  });

  it("keeps SDK ownership, scoped tool guards/results, source metadata, and session history", async () => {
    const f = await fixture();
    const scope = new AsyncLocalStorage<{ allowWrite: boolean }>();
    const effect = vi.fn(async () => ({ content: [{ type: "text" as const, text: "raw" }], details: {} }));
    const starts = vi.fn(); const shutdowns = vi.fn();
    f.extension.handlers.set("session_start", [starts]);
    f.extension.handlers.set("session_shutdown", [shutdowns]);
    f.extension.handlers.set("tool_call", [async raw => {
      const event = raw as ToolCallEvent;
      if (event.toolName === "effect" && !scope.getStore()?.allowWrite) return { block: true, reason: "scoped write guard" };
      return undefined;
    }]);
    const results = vi.fn(async () => ({ content: [{ type: "text", text: "redacted by native hook" }] }));
    f.extension.handlers.set("tool_result", [results]);
    const host = await f.create({ tools: ["effect", "read"], customTools: [tool(effect)] });
    expect(host.session).toBeInstanceOf(AgentSession);
    expect(host.agent).toBeInstanceOf(DurableAgent);
    expect(host.session.agent).toBe(host.agent);
    expect(starts).not.toHaveBeenCalled();
    await host.session.bindExtensions({});
    expect(starts).toHaveBeenCalledOnce();
    expect(host.session.getAllTools().find(tool => tool.name === "read")?.sourceInfo).toMatchObject({ path: "builtin:read" });
    expect(host.session.systemPrompt).toContain("Isolated durable test assistant");
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("effect", {}, { id: "blocked" }), { stopReason: "toolUse" }), fauxAssistantMessage("blocked safely"),
      fauxAssistantMessage(fauxToolCall("effect", {}, { id: "allowed" }), { stopReason: "toolUse" }), fauxAssistantMessage("done"),
      fauxAssistantMessage(fauxToolCall("effect", {}, { id: "blocked-again" }), { stopReason: "toolUse" }), fauxAssistantMessage("blocked again"),
    ]);
    await scope.run({ allowWrite: false }, () => host.session.prompt("try blocked write"));
    expect(effect).not.toHaveBeenCalled();
    expect(JSON.stringify(host.session.messages)).toContain("scoped write guard");
    await scope.run({ allowWrite: true }, () => host.session.prompt("allowed write"));
    expect(effect).toHaveBeenCalledOnce();
    expect(results).toHaveBeenCalled();
    expect(JSON.stringify(f.sessionManager.buildSessionContext().messages)).toContain("redacted by native hook");
    expect(host.session.getLastAssistantText()).toBe("done");
    await scope.run({ allowWrite: false }, () => host.session.prompt("permission revoked"));
    expect(effect).toHaveBeenCalledOnce();
    expect(host.session.getLastAssistantText()).toBe("blocked again");
    await Promise.all([host.close(), host.close()]);
    expect(shutdowns).toHaveBeenCalledOnce();
  });

  it("preserves persisted message identities at native turn_end boundaries", async () => {
    const f = await fixture();
    const boundaries: unknown[] = []; const errors: unknown[] = [];
    f.extension.handlers.set("turn_end", [async event => { boundaries.push(event); }]);
    const host = await f.create({ tools: ["effect"], customTools: [tool(async () => ({ content: [{ type: "text", text: "effect result" }], details: {} }))] });
    await host.session.bindExtensions({ onError: error => errors.push(error) });
    f.faux.setResponses([fauxAssistantMessage([fauxToolCall("effect", {})]), fauxAssistantMessage("done")]);
    await host.session.prompt("use effect");
    expect(errors).toEqual([]);
    expect(boundaries).toHaveLength(2);
    expect(boundaries[0]).toMatchObject({ messageEntryId: expect.any(String), toolResultEntryIds: [expect.any(String)] });
    expect(boundaries[1]).toMatchObject({ messageEntryId: expect.any(String), toolResultEntryIds: [] });
  });

  it("preserves provider auth/header/payload/response hooks and request-local context transforms", async () => {
    const f = await fixture();
    const response = vi.fn(); const streamEvent = vi.fn();
    f.extension.handlers.set("before_provider_headers", [async event => { (event as BeforeProviderHeadersEvent).headers["x-extension"] = "present"; }]);
    f.extension.handlers.set("before_provider_request", [async () => ({ changed: true })]);
    f.extension.handlers.set("after_provider_response", [response]);
    f.extension.handlers.set("provider_stream_event", [streamEvent]);
    f.extension.handlers.set("context", [async event => ({ messages: [...(event as ContextEvent).messages, { role: "user", content: "request-local context", timestamp: 1 }] })]);
    f.faux.setResponses([async (context, options, _state, model) => {
      expect(JSON.stringify(context.messages)).toContain("request-local context");
      expect(options?.apiKey).toBe("offline-key");
      expect(options).toMatchObject({ timeoutMs: 1234, maxRetries: 2, maxRetryDelayMs: 3456,
        websocketConnectTimeoutMs: 4567, transport: "sse", sessionId: f.sessionManager.getSessionId() });
      expect(options?.headers).toMatchObject({ "x-model-header": "configured", "x-extension": "present" });
      // Faux has no HTTP payload/raw event parser; exercise the supplied provider callbacks.
      expect(await options?.onPayload?.({ original: true }, model)).toEqual({ changed: true });
      await options?.onProviderStreamEvent?.({ type: "offline" }, model);
      return fauxAssistantMessage("instrumented");
    }]);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false },
      retry: { enabled: false, provider: { timeoutMs: 1234, maxRetries: 2, maxRetryDelayMs: 3456 } },
      httpIdleTimeoutMs: 6789, websocketConnectTimeoutMs: 4567, transport: "sse" });
    const host = await f.create({ tools: [], settingsManager });
    await host.session.bindExtensions({});
    await host.session.prompt("hello");
    expect(host.session.getLastAssistantText(), JSON.stringify(host.session.messages)).toBe("instrumented");
    expect(response).toHaveBeenCalled(); expect(streamEvent).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.sessionManager.buildSessionContext().messages)).not.toContain("request-local context");
  });

  it("executes native read tools relative to the session cwd", async () => {
    const f = await fixture();
    writeFileSync(join(f.cwd, "fixture.txt"), "native read evidence");
    const host = await f.create({ tools: ["read"] });
    await host.session.bindExtensions({});
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" }), { stopReason: "toolUse" }),
      context => {
        expect(JSON.stringify(context.messages)).toContain("native read evidence");
        return fauxAssistantMessage("read complete");
      },
    ]);
    await host.session.prompt("read fixture.txt");
    expect(host.session.getLastAssistantText()).toBe("read complete");
  });

  it("keeps storage borrowed before and after engine startup, including shutdown failure", async () => {
    const f = await fixture();
    const storageClose = vi.spyOn(f.storage, "close");
    const idle = await f.create({ tools: [] });
    await idle.close();
    expect(storageClose).not.toHaveBeenCalled();
    const host = await f.create({ tools: [] });
    await host.session.bindExtensions({});
    f.faux.setResponses([fauxAssistantMessage("done")]);
    await host.session.prompt("hello");
    const dispose = vi.spyOn(host.session, "dispose");
    vi.spyOn(host.session.extensionRunner, "emit").mockRejectedValueOnce(new Error("shutdown failed"));
    const closing = host.close();
    expect(host.close()).toBe(closing);
    await expect(closing).rejects.toThrow("shutdown failed");
    expect(dispose).toHaveBeenCalledOnce();
    expect(storageClose).not.toHaveBeenCalled();
    await commitWrites(f.storage, [{ type: "conversation", value: { id: await f.storage.mintId() } }], BACKGROUND_CONTEXT);
    // A rejected close remains idempotent; don't make afterEach rethrow it.
    cleanup.pop();
  });

  it("does not silently replace unavailable configured or restored models", async () => {
    const f = await fixture();
    const options = { cwd: f.cwd, modelRuntime: f.modelRuntime, resourceLoader: f.resourceLoader,
      storage: f.storage, runId: "no-fallback", tools: [] };
    await expect(createDurableAgentSession({ ...options, sessionManager: f.sessionManager,
      settingsManager: SettingsManager.inMemory({ defaultProvider: "offline", defaultModel: "missing" }) }))
      .rejects.toThrow("Configured durable model is unavailable");
    f.sessionManager.appendModelChange("offline", "missing");
    f.sessionManager.appendMessage({ role: "user", content: "saved history", timestamp: 1 });
    await expect(createDurableAgentSession({ ...options, sessionManager: f.sessionManager, settingsManager: f.settingsManager }))
      .rejects.toThrow("Cannot restore durable session model");
  });

  it("retains native allowlists, denylists, and noTools modes", async () => {
    const f = await fixture(); const effect = tool(async () => ({ content: [], details: {} }));
    const allowed = await f.create({ tools: ["effect", "read", "write"], excludeTools: ["write"], customTools: [effect] });
    expect(allowed.session.getActiveToolNames().sort()).toEqual(["effect", "read"]);
    allowed.session.setActiveToolsByName(["effect", "read", "write", "bash"]);
    expect(allowed.session.getActiveToolNames().sort()).toEqual(["effect", "read"]);
    const none = await f.create({ noTools: "all", customTools: [effect] });
    none.session.setActiveToolsByName(["effect", "read"]);
    expect(none.session.getActiveToolNames()).toEqual([]);
    const noBuiltin = await f.create({ noTools: "builtin", customTools: [effect] });
    expect(noBuiltin.session.getActiveToolNames()).toEqual(["effect"]);
  });

  it("expands native relative selectors and cannot reactivate an excluded recursive tool", async () => {
    const f = await fixture();
    const recursive = { ...tool(async () => ({ content: [], details: {} })), name: "fabric_exec" };
    const host = await f.create({
      tools: ["+fabric_exec", "-write"], excludeTools: ["fabric_exec"], customTools: [recursive],
      settingsManager: SettingsManager.inMemory({ defaultTools: ["read", "write"] }),
    });
    expect(host.session.getActiveToolNames()).toEqual(["read"]);
    host.session.setActiveToolsByName(["read", "fabric_exec"]);
    expect(host.session.getActiveToolNames()).toEqual(["read"]);
    const wildcard = await f.create({ tools: ["*"], excludeTools: ["fabric_exec"], customTools: [recursive] });
    expect(wildcard.session.getActiveToolNames()).toContain("read");
    expect(wildcard.session.getActiveToolNames()).not.toContain("fabric_exec");
  });

  it("routes virtual models through public AgentSession hooks and restores the virtual selection", async () => {
    const f = await fixture();
    const route = vi.fn(() => ({ model: f.faux.getModel(), thinkingLevel: "off" as const, state: { routed: true } }));
    f.modelRuntime.registerVirtualModel({ provider: "router", id: "auto", name: "Auto", route });
    const model = f.modelRuntime.getModel("router", "auto")!;
    const host = await f.create({ model, tools: [] });
    await host.session.bindExtensions({});
    f.faux.setResponses([fauxAssistantMessage("physical reply")]);
    await host.session.prompt("route me");
    expect(route).toHaveBeenCalledOnce();
    expect(host.session.model?.id).toBe("auto");
    expect(host.session.messages.some(message => message.role === "assistant" && message.provider === "offline")).toBe(true);
    expect(f.sessionManager.getBranch().some(entry => entry.type === "custom" && entry.customType === "pi.virtual-model-state")).toBe(true);
    await host.close();
    const restored = await createDurableAgentSession({ cwd: f.cwd, modelRuntime: f.modelRuntime, resourceLoader: f.resourceLoader,
      settingsManager: f.settingsManager, sessionManager: f.sessionManager, storage: f.storage, runId: "restored", tools: [] });
    cleanup.push(() => restored.close());
    expect(restored.session.model?.id).toBe("auto");
    expect(restored.session.getLastAssistantText()).toBe("physical reply");
  });

  it("starts from compacted SessionManager context and respects dynamic image blocking", async () => {
    const f = await fixture();
    f.sessionManager.appendMessage({ role: "user", content: "old discarded text", timestamp: 1 });
    const kept = f.sessionManager.appendMessage({ role: "user", content: [
      { type: "text", text: "kept text" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ], timestamp: 2 });
    f.sessionManager.appendCompaction("summary of earlier context", kept, 100);
    f.faux.setResponses([context => {
      const text = JSON.stringify(context.messages);
      expect(text).toContain("summary of earlier context"); expect(text).toContain("kept text");
      expect(text).not.toContain("old discarded text"); expect(text).toContain("Image reading is disabled.");
      expect(text).not.toContain('"type":"image"');
      return fauxAssistantMessage("compacted");
    }]);
    const host = await f.create({ tools: [] });
    await host.session.bindExtensions({});
    f.settingsManager.setBlockImages(true); // conversion reads live settings, not a constructor snapshot
    await host.session.prompt("inspect");
    expect(host.session.getLastAssistantText(), JSON.stringify(host.session.messages)).toBe("compacted");
    expect(f.sessionManager.getBranch().some(entry => entry.type === "thinking_level_change")).toBe(true);
  });
});
