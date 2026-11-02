import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { DurableAgent } from "../src/durable/agent.js";

const agents: DurableAgent[] = [];
const dirs: string[] = [];
afterEach(async () => { await Promise.all(agents.splice(0).map(a => a.close().catch(() => {}))); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function setup(storage: Storage = new MemoryStorage(), tools: AgentTool[] = [], tokenSize?: { min: number; max: number }, fabricJournalDirectory?: string) {
  const faux = fauxProvider({ tokensPerSecond: Infinity, ...(tokenSize ? { tokenSize } : {}) });
  const models = createModels(); models.setProvider(faux.provider);
  const agent = new DurableAgent({ models, storage, runId: "run-one", streamFn: models.streamSimple.bind(models), initialState: { model: faux.getModel(), tools, systemPrompt: "Be helpful" }, ...(fabricJournalDirectory ? { fabricJournalDirectory } : {}) });
  agents.push(agent);
  return { agent, faux, models };
}
const tool = (execute: AgentTool["execute"]): AgentTool => ({ name: "effect", label: "Effect", description: "effect", parameters: Type.Object({}), execute });
// Fabric reads the fence through this process-global key, never through an import.
type Fence = { toolCallId: string; accept(): Promise<void>; arm(): Promise<void>; journal?: { path: string; digest?: string; accept(digest: string): Promise<void> } };
const fenceStore = () => (globalThis as { [key: symbol]: unknown })[Symbol.for("pi-fabric.durable-tool-fence.v1")] as AsyncLocalStorage<Fence> | undefined;
// Interrupts the first `crashes` attempts of one fabric_exec call, then recovers.
async function interruptFabricExec(step: (fence: Fence | undefined) => Promise<void>, crashes = 1, journals = false) {
  const dir = await mkdtemp(join(tmpdir(), "durable-agent-")); dirs.push(dir);
  const journalDirectory = journals ? join(dir, "fabric-journal") : undefined;
  let entered = deferred(); const seen: (Fence | undefined)[] = [];
  const program: AgentTool = { ...tool(async (_id, _args, signal) => {
    seen.push(fenceStore()?.getStore());
    if (seen.length > crashes) return { content: [{ type: "text", text: "rerun" }], details: {} };
    await step(seen.at(-1)); entered.resolve();
    await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
    return { content: [{ type: "text", text: "late" }], details: {} };
  }), name: "fabric_exec" };
  const first = setup(await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), [program], undefined, journalDirectory);
  first.faux.setResponses([fauxAssistantMessage(fauxToolCall("fabric_exec", {}, { id: "program" }), { stopReason: "toolUse" })]);
  const run = first.agent.prompt("do it").catch(() => {});
  await entered.promise; await first.agent.close(); await run;
  for (let attempt = 1; attempt < crashes; attempt++) {
    entered = deferred();
    const again = setup(await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), [program], undefined, journalDirectory);
    again.faux.setResponses([fauxAssistantMessage("recovered")]);
    const resumed = again.agent.prompt("do it").catch(() => {});
    // A missing rerun settles the prompt instead of reaching the tool.
    await Promise.race([entered.promise, resumed]); await again.agent.close(); await resumed;
  }
  const second = setup(await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), [program], undefined, journalDirectory);
  second.faux.setResponses([fauxAssistantMessage("recovered")]);
  await second.agent.prompt("do it");
  const results = second.agent.state.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
  await second.agent.close();
  return { seen, results };
}
const journalBytes = async (dir: string) => {
  let total = 0;
  for (const name of await readdir(dir)) total += (await stat(join(dir, name))).size;
  return total;
};

describe("DurableAgent", () => {
  it("gates recovered tasks until asynchronous host reconciliation and subscription finish", async () => {
    const entered = deferred(); const restored = deferred(); const release = deferred();
    const effect = vi.fn(async (_id, _args, signal) => {
      entered.resolve(); await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { content: [], details: {} };
    });
    const storage = new MemoryStorage(); const first = setup(storage, [tool(effect)]);
    first.faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" })]);
    const original = first.agent.prompt("recover me").catch(() => {});
    await entered.promise; await first.agent.close(); await original;
    const second = setup(storage, [tool(effect)]); const events: AgentEvent[] = [];
    second.agent.subscribe(event => { events.push(event); });
    second.agent.recoverHistory = async messages => {
      expect(JSON.stringify(messages)).toContain("recover me");
      restored.resolve(); await release.promise;
    };
    second.faux.setResponses([fauxAssistantMessage("recovered")]);
    const run = second.agent.continue(); await restored.promise;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(events).toEqual([]); expect(second.faux.state.callCount).toBe(0);
    release.resolve(); await run;
    expect(effect).toHaveBeenCalledOnce();
    expect(events.some(event => event.type === "agent_end")).toBe(true);
    expect(second.agent.state.messages.filter(m => m.role === "user")).toHaveLength(1);
  });

  it("recovers safe tools under fresh request permissions, not the original scheduler scope", async () => {
    const scope = new AsyncLocalStorage<boolean>(); const entered = deferred();
    const execute = vi.fn(async (_id, _args, signal: AbortSignal | undefined) => {
      entered.resolve(); await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { content: [], details: {} };
    });
    const safe: AgentTool = { ...tool(execute), replay: "safe" }; const storage = new MemoryStorage();
    const first = setup(storage, [safe]);
    first.agent.beforeToolCall = async () => scope.getStore() ? undefined : { block: true, reason: "revoked" };
    first.faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" })]);
    const run = scope.run(true, () => first.agent.prompt("go")).catch(() => {});
    await entered.promise; await first.agent.close(); await run;
    const second = setup(storage, [safe]); second.agent.beforeToolCall = first.agent.beforeToolCall;
    second.faux.setResponses([fauxAssistantMessage("blocked after reopen")]);
    await scope.run(false, () => second.agent.prompt("go"));
    expect(execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(second.agent.state.messages)).toContain("revoked");
  });

  it("uses the request-projected context in tools and subsequent turn hooks", async () => {
    const { agent, faux } = setup(new MemoryStorage(), [tool(async () => ({ content: [], details: {} }))]);
    let prepared = false;
    agent.prepareRequest = ({ context }) => {
      if (prepared) return undefined; prepared = true;
      return { context: { ...context, messages: [{ role: "user", content: "projected", timestamp: 1 }] } };
    };
    const check = (messages: typeof agent.state.messages) => {
      expect(messages.some(m => m.role === "user" && m.content === "projected")).toBe(true);
      expect(messages.some(m => m.role === "user" && m.content === "private original")).toBe(false);
    };
    agent.beforeToolCall = async ({ context }) => { check(context.messages); return undefined; };
    agent.finishTurn = ({ context }) => { check(context.messages); };
    agent.prepareNextTurnWithContext = ({ context }) => { check(context.messages); return undefined; };
    faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
    await agent.prompt("private original");
  });

  it("rejects truncated tool calls without running effects", async () => {
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const { agent, faux } = setup(new MemoryStorage(), [tool(execute)]);
    faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "length" }), fauxAssistantMessage("recovered")]);
    await agent.prompt("go");
    expect(execute).not.toHaveBeenCalled();
    expect(agent.state.messages.some(m => m.role === "toolResult" && m.isError)).toBe(true);
    expect(faux.state.callCount).toBe(2);
  });

  it("applies afterToolCall replacement content, usage and termination without leaking metadata", async () => {
    const { agent, faux } = setup(new MemoryStorage(), [tool(async () => ({ content: [{ type: "text", text: "raw" }], details: {} }))]);
    agent.afterToolCall = async () => ({ content: [{ type: "text", text: "redacted" }], isError: true, terminate: true });
    faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" })]);
    await agent.prompt("go");
    const result = agent.state.messages.find(m => m.role === "toolResult");
    expect(result).toMatchObject({ content: [{ type: "text", text: "redacted" }], isError: true });
    expect(result).not.toHaveProperty("terminate"); expect(faux.state.callCount).toBe(1);
  });

  it("borrows storage, restores completed identities, and admits a distinct later request", async () => {
    const storage = new MemoryStorage(); const close = vi.spyOn(storage, "close");
    const first = setup(storage); first.faux.setResponses([fauxAssistantMessage("first")]);
    first.agent.setRequestId("__proto__"); await first.agent.prompt("one"); await first.agent.close();
    expect(close).not.toHaveBeenCalled();
    const second = setup(storage); second.faux.setResponses([fauxAssistantMessage("second")]);
    second.agent.setRequestId("__proto__"); await second.agent.prompt("duplicate");
    expect(second.faux.state.callCount).toBe(0);
    second.agent.setRequestId("later"); await second.agent.prompt("two");
    expect(second.agent.state.messages.filter(m => m.role === "user")).toHaveLength(2);
    expect(second.faux.state.callCount).toBe(1);
  });

  it("deduplicates durable queue controls across reopen and continues queued work", async () => {
    const storage = new MemoryStorage(); const first = setup(storage);
    first.faux.setResponses([fauxAssistantMessage("first")]); await first.agent.prompt("one");
    const queued = { role: "user" as const, content: "queued", timestamp: 5 };
    first.agent.setRequestId("queue-one"); first.agent.followUp(queued); await first.agent.close();
    const second = setup(storage); second.faux.setResponses([fauxAssistantMessage("followed")]);
    second.agent.setRequestId("queue-one"); second.agent.followUp(queued);
    await second.agent.continue();
    expect(second.agent.state.messages.filter(m => m.role === "user" && m.content === "queued")).toHaveLength(1);
    expect(second.agent.hasQueuedMessages()).toBe(false);
    expect(second.faux.state.callCount).toBe(1);
  });

  it("preserves model/thinking and provider overrides across tool turns", async () => {
    const { agent, faux } = setup(new MemoryStorage(), [tool(async () => ({ content: [], details: {} }))]);
    const stream = agent.streamFunction; const seen: unknown[] = [];
    agent.streamFunction = (model, context, options) => { seen.push({ model, options }); return stream(model, context, options); };
    agent.sessionId = "provider-session"; agent.transport = "sse"; agent.maxRetryDelayMs = 77;
    agent.thinkingBudgets = { low: 42 }; agent.getApiKey = () => "test-key";
    agent.onPayload = payload => payload; agent.onResponse = () => {}; agent.onProviderStreamEvent = () => {};
    let n = 0;
    const model = { ...faux.getModel(), name: "override" };
    agent.prepareRequest = () => ++n === 1 ? { model, thinkingLevel: "low" } : undefined;
    faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
    await agent.prompt("go");
    expect(seen).toHaveLength(2);
    for (const call of seen) expect(call).toMatchObject({ model: { name: "override" }, options: { reasoning: "low", sessionId: "provider-session", transport: "sse", maxRetryDelayMs: 77, apiKey: "test-key", thinkingBudgets: { low: 42 }, onPayload: agent.onPayload, onResponse: agent.onResponse, onProviderStreamEvent: agent.onProviderStreamEvent } });
    expect(agent.state.messages.filter(m => m.role === "assistant").every(m => m.thinkingLevel === "low")).toBe(true);
  });

  it("declares changed public tools and persists externally replaced history", async () => {
    const storage = new MemoryStorage(); const { agent, faux } = setup(storage);
    agent.state.tools = [tool(async () => ({ content: [], details: {} }))];
    faux.setResponses([ctx => { expect(getCurrentTools(ctx.messages).map(t => t.name)).toContain("effect"); return fauxAssistantMessage("first"); }, fauxAssistantMessage("second")]);
    await agent.prompt("one");
    agent.state.messages = [{ role: "user", content: "compacted", timestamp: 1 }];
    await agent.continue(); await agent.close();
    const reopened = setup(storage); reopened.agent.setRequestId("run-one"); await reopened.agent.prompt("retry");
    expect(reopened.agent.state.messages.some(m => m.role === "user" && m.content === "compacted")).toBe(true);
    expect(reopened.agent.state.messages.some(m => m.role === "user" && m.content === "one")).toBe(false);
  });

  it("emits terminal error events for provider exceptions and can start another request", async () => {
    const { agent, faux } = setup(); const stream = agent.streamFunction;
    const events: AgentEvent[] = []; agent.subscribe(e => { events.push(e); });
    agent.streamFunction = () => { throw new Error("provider unavailable"); };
    await agent.prompt("one");
    expect(agent.state.errorMessage).toBe("provider unavailable");
    expect(events.slice(-3).map(e => e.type)).toEqual(["message_end", "turn_end", "agent_end"]);
    expect(agent.state.isStreaming).toBe(false);
    agent.streamFunction = stream; faux.setResponses([fauxAssistantMessage("recovered")]); await agent.prompt("two");
    expect(agent.state.errorMessage).toBeUndefined();
  });

  it("resets public state without touching private Agent lifecycle fields", async () => {
    const { agent, faux } = setup(); faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
    await agent.prompt("one"); agent.followUp({ role: "user", content: "discard", timestamp: 1 }); agent.reset();
    expect(agent.state.messages.every(m => m.role === "system")).toBe(true);
    expect(agent.hasQueuedMessages()).toBe(false); await agent.prompt("two");
    expect(agent.state.messages.filter(m => m.role === "user")).toHaveLength(1);
  });

  it("is a public Agent, persists before delivery, awaits subscribers, and deduplicates identities", async () => {
    const storage = new MemoryStorage();
    const { agent, faux } = setup(storage);
    expect(agent).toBeInstanceOf(Agent);
    const events: AgentEvent[] = [];
    const gate = deferred(); const ended = deferred();
    agent.subscribe(async e => { events.push(e); if (e.type === "agent_end") { ended.resolve(); await gate.promise; } });
    faux.setResponses([fauxAssistantMessage("hello"), fauxAssistantMessage("second")]);
    agent.setRequestId("one"); const run = agent.prompt("hi");
    await ended.promise;
    expect(agent.state.isStreaming).toBe(true);
    gate.resolve(); await run; await agent.waitForIdle();
    expect(agent.state.isStreaming).toBe(false);
    expect(events[0]?.type).toBe("agent_start");
    expect(events.at(-1)?.type).toBe("agent_end");
    agent.setRequestId("one"); await agent.prompt("hi");
    expect(faux.state.callCount).toBe(1);
    await agent.prompt("again"); expect(faux.state.callCount).toBe(2);
    expect(agent.state.messages.filter(m => m.role === "user")).toHaveLength(2);
  });

  it("runs tools through blocking and result hooks, with turn refresh and context projection", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "effect" }], details: {} }));
    const { agent, faux } = setup(new MemoryStorage(), [tool(execute)]);
    const seen: string[] = [];
    agent.beforeToolCall = async () => ({ block: true, reason: "denied" });
    agent.afterToolCall = async () => { seen.push("after-tool"); return undefined; };
    agent.prepareRequest = async ({ context }) => { seen.push("prepare"); return { context }; };
    agent.prepareNextTurnWithContext = async ({ context }) => { seen.push("next"); return { context }; };
    agent.transformContext = async messages => { seen.push("transform"); return messages; };
    agent.finishTurn = async () => { seen.push("finish"); };
    faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}, { id: "call-1" }), { stopReason: "toolUse" }), (ctx) => {
      expect(ctx.messages.some(m => m.role === "toolResult" && m.isError)).toBe(true);
      return fauxAssistantMessage("done");
    }]);
    await agent.prompt("call it");
    expect(execute).not.toHaveBeenCalled();
    expect(seen.filter(s => s === "prepare")).toHaveLength(2);
    expect(seen).toContain("next");
    expect(seen.filter(s => s === "finish")).toHaveLength(2);
  });

  it("accepts request tools rebuilt as same-name objects and runs the registered one", async () => {
    const stale = vi.fn(async () => ({ content: [{ type: "text" as const, text: "stale" }], details: {} }));
    const current = vi.fn(async () => ({ content: [{ type: "text" as const, text: "current" }], details: {} }));
    const { agent, faux } = setup(new MemoryStorage(), [tool(stale)]);
    // A tool loadout refresh replaces every tool object while the request context still holds the old ones.
    agent.prepareRequest = ({ context }) => { agent.state.tools = [tool(current)]; return { context }; };
    faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
    await agent.prompt("go");
    expect(agent.state.errorMessage).toBeUndefined();
    expect(current).toHaveBeenCalledOnce();
    expect(stale).not.toHaveBeenCalled();
  });

  it("refuses request tools whose name is not registered", async () => {
    const { agent, faux } = setup(new MemoryStorage(), [tool(async () => ({ content: [], details: {} }))]);
    const anonymous: AgentTool = { ...tool(async () => ({ content: [], details: {} })), name: "anonymous" };
    agent.prepareRequest = ({ context }) => ({ context: { ...context, tools: [...(context.tools ?? []), anonymous] } });
    faux.setResponses([fauxAssistantMessage("done")]);
    await agent.prompt("go");
    expect(agent.state.errorMessage).toBe("Durable request tools must be registered in agent.state.tools");
    expect(faux.state.callCount).toBe(0);
  });

  it("steers after tools and drains followups before idle", async () => {
    const { agent, faux } = setup();
    let n = 0;
    agent.subscribe(e => { if (e.type === "message_end" && e.message.role === "assistant" && ++n === 1) { agent.steer({ role: "user", content: "steer", timestamp: 1 }); agent.followUp({ role: "user", content: "follow", timestamp: 2 }); } });
    faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("steered"), fauxAssistantMessage("followed")]);
    await agent.prompt("start");
    expect(faux.state.callCount).toBe(3);
    expect(agent.hasQueuedMessages()).toBe(false);
  });

  it("honors finishTurn end after a tool batch and continue after text", async () => {
    const { agent, faux } = setup(new MemoryStorage(), [tool(async () => ({ content: [{ type: "text", text: "ok" }], details: {} }))]);
    faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" })]);
    agent.finishTurn = turn => ({ action: turn.toolResults.length ? "end" : "continue" });
    await agent.prompt("go");
    expect(faux.state.callCount).toBe(2);
  });

  it("closes without aborting durable work and never replays an interrupted unsafe tool", async () => {
    const dir = await mkdtemp(join(tmpdir(), "durable-agent-")); dirs.push(dir);
    const entered = deferred(); let effects = 0;
    const unsafe = tool(async (_id, _args, signal) => {
      effects++; entered.resolve();
      await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { content: [{ type: "text", text: "late" }], details: {} };
    });
    const first = setup(await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), [unsafe]);
    first.faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}, { id: "unsafe" }), { stopReason: "toolUse" })]);
    const run = first.agent.prompt("do it").catch(() => {});
    await entered.promise; await first.agent.close(); await run;
    // A newly safe declaration cannot retroactively authorize an unsafe retry.
    const second = setup(await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), [{ ...unsafe, replay: "safe" }]);
    second.faux.setResponses([fauxAssistantMessage("recovered")]);
    await second.agent.prompt("do it");
    expect(effects).toBe(1);
    expect(second.agent.state.messages.filter(m => m.role === "user")).toHaveLength(1);
    expect(second.agent.state.messages.some(m => m.role === "toolResult" && m.isError)).toBe(true);
    await second.agent.close();
  });

  it("reruns an interrupted fabric_exec that accepted its fence and never armed it", async () => {
    const { seen, results } = await interruptFabricExec(async fence => { await fence!.accept(); });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ toolCallId: "program" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ isError: false, content: [{ type: "text", text: "rerun" }] });
  });

  it("never reruns an interrupted fabric_exec after it armed its fence", async () => {
    const { seen, results } = await interruptFabricExec(async fence => { await fence!.accept(); await fence!.arm(); });
    expect(seen).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ isError: true, details: { interrupted: true } });
  });

  it("never reruns an interrupted fabric_exec that did not accept its fence", async () => {
    const { seen, results } = await interruptFabricExec(async () => {});
    expect(seen[0]).toMatchObject({ toolCallId: "program" });
    expect(seen).toHaveLength(1);
    expect(results[0]).toMatchObject({ isError: true, details: { interrupted: true } });
  });

  it("reruns an interrupted fabric_exec at most once", async () => {
    const { seen, results } = await interruptFabricExec(async fence => { await fence!.accept(); }, 2);
    expect(seen).toHaveLength(2);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ isError: true, details: { interrupted: true } });
  });

  it("offers fabric_exec a private journal path and resumes it with the recorded digest", async () => {
    const digest = "d".repeat(64);
    const { seen, results } = await interruptFabricExec(async fence => { await fence!.accept(); await fence!.journal!.accept(digest); }, 1, true);
    expect(seen).toHaveLength(2);
    const [first, second] = seen;
    expect(first!.journal).toMatchObject({ path: expect.stringMatching(/fabric-journal[/\\][0-9a-f]{32}\.jsonl$/) });
    expect(first!.journal!.digest).toBeUndefined();
    expect(second!.journal).toMatchObject({ path: first!.journal!.path, digest });
    // A Fabric that cannot resume from a journal must not rerun the program from the start.
    await expect(second!.accept()).rejects.toThrow("cannot resume an interrupted fabric_exec from its journal");
    expect(results[0]).toMatchObject({ isError: false, content: [{ type: "text", text: "rerun" }] });
  });

  it("resumes a journaled fabric_exec even after it armed, but at most three times", async () => {
    // Like Fabric: accept and record a journal on the first attempt, resume from it after.
    const armed = async (fence: Fence | undefined) => {
      if (fence!.journal!.digest === undefined) { await fence!.accept(); await fence!.journal!.accept("e".repeat(64)); }
      await fence!.arm();
    };
    const resumed = await interruptFabricExec(armed, 3, true);
    expect(resumed.seen).toHaveLength(4);
    expect(resumed.results[0]).toMatchObject({ isError: false });
    const exhausted = await interruptFabricExec(armed, 4, true);
    expect(exhausted.seen).toHaveLength(4);
    expect(exhausted.results[0]).toMatchObject({ isError: true, details: { interrupted: true } });
  });

  it("deletes the fabric_exec journal once its result is committed, on success and after a resume", async () => {
    const dir = await mkdtemp(join(tmpdir(), "durable-agent-")); dirs.push(dir);
    const journalDirectory = join(dir, "fabric-journal");
    const paths: string[] = [];
    const program: AgentTool = { ...tool(async () => {
      const offer = fenceStore()!.getStore()!.journal!;
      paths.push(offer.path);
      await mkdir(journalDirectory, { recursive: true }); await writeFile(offer.path, "secret tool output\n");
      return { content: [{ type: "text", text: "done" }], details: {} };
    }), name: "fabric_exec" };
    const { agent, faux } = setup(await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), [program], undefined, journalDirectory);
    faux.setResponses([fauxAssistantMessage(fauxToolCall("fabric_exec", {}, { id: "program" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
    await agent.prompt("go");
    expect(paths).toHaveLength(1);
    expect(existsSync(paths[0]!)).toBe(false);

    // An interrupted call keeps its journal until the resumed result commits.
    const resumed = await interruptFabricExec(async fence => {
      await fence!.accept(); await fence!.journal!.accept("d".repeat(64));
      await mkdir(join(fence!.journal!.path, ".."), { recursive: true }); await writeFile(fence!.journal!.path, "secret\n");
      paths.push(fence!.journal!.path);
    }, 1, true);
    expect(resumed.seen[1]!.journal).toMatchObject({ path: paths[1], digest: "d".repeat(64) });
    expect(resumed.results).toHaveLength(1);
    expect(existsSync(paths[1]!)).toBe(false);
  });

  it("deletes the fabric_exec journal when the call is aborted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "durable-agent-")); dirs.push(dir);
    const journalDirectory = join(dir, "fabric-journal");
    const entered = deferred(); let file = "";
    const program: AgentTool = { ...tool(async (_id, _args, signal) => {
      file = fenceStore()!.getStore()!.journal!.path;
      await mkdir(journalDirectory, { recursive: true }); await writeFile(file, "secret tool output\n");
      entered.resolve(); await new Promise<void>(r => signal?.addEventListener("abort", () => r(), { once: true }));
      return { content: [], details: {} };
    }), name: "fabric_exec" };
    const { agent, faux } = setup(await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), [program], undefined, journalDirectory);
    faux.setResponses([fauxAssistantMessage(fauxToolCall("fabric_exec", {}, { id: "program" }), { stopReason: "toolUse" })]);
    const run = agent.prompt("go"); await entered.promise; agent.abort(); await run; await agent.waitForIdle();
    expect(file).not.toBe("");
    expect(existsSync(file)).toBe(false);
  });

  it("offers the rerun fence only to fabric_exec", async () => {
    let offered: Fence | undefined | "unseen" = "unseen";
    const { agent, faux } = setup(new MemoryStorage(), [tool(async () => { offered = fenceStore()?.getStore(); return { content: [], details: {} }; })]);
    faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
    await agent.prompt("go");
    expect(offered).toBeUndefined();
  });

  it("journals streaming updates linearly while delivering every full partial (#229)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "durable-agent-")); dirs.push(dir);
    const text = "streamed output ".repeat(1_000);
    const chunks = Array.from({ length: 300 }, (_, index) => `line ${index} `.padEnd(64, "."));
    const effect = tool(async (_id, _args, _signal, onUpdate) => {
      let output = "";
      for (const chunk of chunks) { output += chunk; onUpdate?.({ content: [{ type: "text", text: output }], details: {} }); }
      return { content: [{ type: "text", text: output }], details: {} };
    });
    const { agent, faux } = setup(await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), [effect], { min: 4, max: 4 });
    faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" }), fauxAssistantMessage(text)]);
    const events: AgentEvent[] = [];
    agent.subscribe(event => { events.push(event); });
    await agent.prompt("stream");
    const updates = events.filter((event): event is Extract<AgentEvent, { type: "message_update" }> => event.type === "message_update");
    const deltas = updates.flatMap(event => event.assistantMessageEvent.type === "text_delta" ? [event.assistantMessageEvent.delta] : []);
    expect(deltas.length).toBeGreaterThanOrEqual(1_000);
    expect(deltas.join("")).toBe(text);
    // Observers still receive the complete partial on both fields.
    const last = updates.filter(event => event.assistantMessageEvent.type === "text_delta").at(-1)!;
    expect(last.assistantMessageEvent).toHaveProperty("partial", last.message);
    expect(last.message).toMatchObject({ role: "assistant", content: [{ type: "text", text }] });
    const toolUpdates = events.filter((event): event is Extract<AgentEvent, { type: "tool_execution_update" }> => event.type === "tool_execution_update");
    expect(toolUpdates).toHaveLength(chunks.length);
    expect(toolUpdates.at(-1)).toMatchObject({ toolName: "effect", args: {}, partialResult: { content: [{ type: "text", text: chunks.join("") }] } });
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text }] });
    await agent.close();
    // Re-sending every growing partial would journal well over 20 MB here.
    expect(await journalBytes(dir)).toBeLessThan(2_000_000);
    // Recovery reads committed history, not streaming payloads.
    const reopened = setup(await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT));
    reopened.faux.setResponses([fauxAssistantMessage("next")]);
    reopened.agent.setRequestId("later"); await reopened.agent.prompt("again");
    expect(JSON.stringify(reopened.agent.state.messages)).toContain(text);
    expect(reopened.faux.state.callCount).toBe(1);
  });

  it("aborts an executing tool and settles waitForIdle", async () => {
    const entered = deferred();
    const { agent, faux } = setup(new MemoryStorage(), [tool(async (_id, _args, signal) => {
      entered.resolve(); await new Promise<void>(r => signal?.addEventListener("abort", () => r(), { once: true }));
      return { content: [], details: {} };
    })]);
    faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" })]);
    const run = agent.prompt("go"); await entered.promise; agent.abort(); await run; await agent.waitForIdle();
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.pendingToolCalls.size).toBe(0);
    expect(agent.state.messages.some(m => m.role === "toolResult")).toBe(true);
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
  });

  it("settles abort() and close() while a turn is still preparing", async () => {
    const { agent, faux } = setup(new MemoryStorage(), [tool(async () => ({ content: [], details: {} }))]);
    faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" }), fauxAssistantMessage("never")]);
    const preparing = deferred(); const release = deferred(); let turns = 0;
    // The second turn's prepare phase commits turn_start itself and then waits for its delivery, so stalling that
    // delivery holds the run invocation before its admission wait while abort lands.
    agent.subscribe(async event => { if (event.type === "turn_start" && ++turns === 2) { preparing.resolve(); await release.promise; } });
    const run = agent.prompt("go").catch(() => {});
    await preparing.promise;
    agent.abort();
    const closing = agent.close();
    release.resolve();
    // The engine abort joins the running invocation; close() waits on the abort. Neither may wait on the other.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("abort/close deadlocked: close() did not settle within 2s")), 2_000); });
    try {
      await Promise.race([Promise.all([closing, run, agent.waitForIdle()]), timeout]);
    } finally { clearTimeout(timer); }
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
  });
});
