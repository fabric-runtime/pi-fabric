import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { createModels } from "@earendil-works/pi-ai/models";
import { awaitWithContext } from "@earendil-works/chord/context";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, MemoryStorage } from "@earendil-works/pi-durable";
import { createPiDurableRunner, type PiDurableRunnerOptions } from "../src/durable.js";
import type { FabricHostedRunContext, FabricHostedReporter } from "../src/runners.js";
import { registerAgentRunner } from "../src/runners.js";
import { AgentManager } from "../src/agents/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function temp() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-durable-")); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function setup(persistent = false, images = false) {
  const models = createModels();
  const faux = fauxProvider({ provider: "offline", models: [{ id: "test", reasoning: true, input: images ? ["text", "image"] : ["text"] }], tokensPerSecond: 100000 });
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const root = temp();
  const options: PiDurableRunnerOptions = { models, registry, env: () => undefined, allowedModels: [{ provider: "offline", modelId: "test" }], storage: persistent ? { kind: "jsonl", directory: path.join(root, "storage") } : { kind: "factory", identity: root, acquire: async () => ({ storage: new MemoryStorage(), release() {} }) } };
  const make = () => { const runner = createPiDurableRunner(options); cleanup.push(() => runner.close()); return runner; };
  return { faux, registry, options, root, make };
}
function context(changes: Partial<FabricHostedRunContext> = {}): FabricHostedRunContext {
  return { id: "stable-run", idempotencyKey: "stable-run", name: "test", task: "hello", cwd: process.cwd(), runDirectory: "/unused", residency: "session", deadlineAt: Date.now() + 60000, depth: 0, lineage: { version: 1, rootSessionId: "root", runId: "stable-run", depth: 0, childIndex: 0, worker: true }, tools: [], model: "offline/test", thinking: "off", recursive: false, ...changes };
}
function reporter() {
  let resolve!: (result: { status: string; output: string }) => void;
  const done = new Promise<{ status: string; output: string }>(r => { resolve = r; });
  const target: FabricHostedReporter = { progress: vi.fn(), usage: vi.fn(), transcript: vi.fn(), question: vi.fn(), finish: vi.fn(result => resolve(result)), fail: vi.fn(error => resolve({ status: "failed", output: error.error })) };
  return { target, done };
}
function interruptedTool(onEffect: () => void, entered: () => void) {
  return defineTool({ name: "effect", description: "unsafe side effect", parameters: Type.Object({}), execute: async (_args, _api, ctx) => {
    onEffect(); entered();
    await awaitWithContext(new Promise<void>(() => {}), ctx);
    return {};
  } });
}

describe("published Pi durable hosted adapter", () => {
  it("runs through real Fabric AgentManager with explicit model and usage", async () => {
    const f = setup(); f.faux.setResponses([fauxAssistantMessage("real durable answer")]);
    const runner = f.make(); cleanup.push(registerAgentRunner(runner));
    const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents }, { runRoot: path.join(f.root, "runs"), fullCodeMode: false }); cleanup.push(() => manager.close());
    const result = await manager.run({ task: "hello", runner: runner.id, model: "offline/test", tools: [], thinking: "off", recursive: false });
    expect(result).toMatchObject({ status: "completed", transport: "hosted", text: "real durable answer" });
    expect(f.faux.state.callCount).toBe(1);
    expect(result.usage?.output).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(manager.runDirectory(result.id)!, "events.jsonl"), "utf8")).toContain("real durable answer");
    const state = JSON.parse(fs.readFileSync(path.join(manager.runDirectory(result.id)!, "hosted.json"), "utf8"));
    expect(state.locator.runId).toBe(result.id);
    expect(state.context.idempotencyKey).toBe(result.id);
  });

  it("duplicate starts and persistent reopen attach do not duplicate submission or effects", async () => {
    const f = setup(true); let effects = 0;
    const tool = defineTool({ name: "effect", description: "effect", parameters: Type.Object({}), execute: async () => { effects++; return { output: [{ type: "text", text: "effect done" }] }; } });
    f.registry.install(defineExtension({ name: "tools", tools: [tool] }));
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
    const ctx = context({ tools: ["effect"] }); const runner = f.make(); const loc = runner.prepare(ctx); const a = reporter(); const b = reporter();
    await Promise.all([runner.start(loc, ctx, a.target), runner.start(loc, ctx, b.target)]);
    expect(await a.done).toEqual({ status: "completed", output: "done" }); expect(await b.done).toEqual({ status: "completed", output: "done" });
    await runner.close();
    const reopened = f.make(); const c = reporter(); await reopened.attach(loc, ctx, c.target);
    expect(await c.done).toEqual({ status: "completed", output: "done" });
    expect(effects).toBe(1); expect(f.faux.state.callCount).toBe(2);
    expect(await reopened.liveness(loc)).toBe("settled");
    await expect(reopened.start(loc, { ...ctx, task: "changed" }, reporter().target)).rejects.toThrow(/different work/);
  });

  it("close detaches without abort and interrupted unsafe tool is not replayed on attach", async () => {
    const f = setup(true); let effects = 0; let enter!: () => void; const entered = new Promise<void>(r => { enter = r; });
    f.registry.install(defineExtension({ name: "tools", tools: [interruptedTool(() => effects++, enter)] }));
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" }), (transcript) => {
      const toolResult = transcript.messages.find(message => message.role === "toolResult");
      expect(JSON.stringify(toolResult)).toContain("interrupted");
      return fauxAssistantMessage("recovered without replay");
    }]);
    const ctx = context({ tools: ["effect"] }); const runner = f.make(); const loc = runner.prepare(ctx); const a = reporter();
    await runner.start(loc, ctx, a.target); await entered; await runner.close();
    expect(a.target.finish).not.toHaveBeenCalled(); expect(a.target.fail).not.toHaveBeenCalled();
    const reopened = f.make(); const b = reporter(); await reopened.attach(loc, ctx, b.target);
    expect(await b.done).toEqual({ status: "completed", output: "recovered without replay" }); expect(effects).toBe(1);
  });

  it("recovers after real SIGKILL only after host-confirmed stale-lock removal, without unsafe replay", async () => {
    const f = setup(true);
    const ready = path.join(f.root, "ready.json"); const effects = path.join(f.root, "effects"); const script = path.join(f.root, "killed.ts");
    const project = process.cwd(); const ctx = context({ tools: ["effect"] });
    fs.writeFileSync(script, `
import fs from "node:fs";
import { Type } from ${JSON.stringify(import.meta.resolve("typebox"))};
import { createModels } from ${JSON.stringify(path.join(project, "node_modules/@earendil-works/pi-ai/dist/models.js"))};
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(path.join(project, "node_modules/@earendil-works/pi-ai/dist/providers/faux.js"))};
import { createRegistry, defineExtension, defineTool } from ${JSON.stringify(path.join(project, "node_modules/@earendil-works/pi-durable/dist/index.js"))};
import { createPiDurableRunner } from ${JSON.stringify(path.join(project, "src/durable.ts"))};
const models = createModels(); const faux = fauxProvider({provider:"offline",models:[{id:"test",reasoning:true}],tokensPerSecond:100000}); models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage(fauxToolCall("effect",{}),{stopReason:"toolUse"})]);
const registry = createRegistry(); const context = ${JSON.stringify(ctx)};
let locator; let entered; const entering = new Promise(resolve => { entered = resolve; });
registry.install(defineExtension({name:"tools",tools:[defineTool({name:"effect",description:"effect",parameters:Type.Object({}),execute:async()=>{
 fs.appendFileSync(${JSON.stringify(effects)},"effect\\n");
 entered();
 await new Promise(()=>{}); return {};
}})]}));
const runner=createPiDurableRunner({models,registry,env:()=>undefined,allowedModels:[{provider:"offline",modelId:"test"}],storage:${JSON.stringify(f.options.storage)}});
locator=runner.prepare(context); await runner.start(locator,context,{progress(){},usage(){},transcript(){},question:async()=>({}),finish(){},fail(error){console.error(error)}});
await entering; await runner.followUp(locator,"surviving follow-up",{requestId:"survivor"});
fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({locator,pid:process.pid}));
setInterval(()=>{},1000);
`);
    const child = spawn("bun", [script], { stdio: ["ignore", "ignore", "pipe"] });
    const exited = once(child, "exit"); let errors = ""; child.stderr.on("data", chunk => { errors = (errors + String(chunk)).slice(-4000); });
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(ready)) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(`Child failed to reach unsafe tool: ${errors}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const admitted = JSON.parse(fs.readFileSync(ready, "utf8"));
    child.kill("SIGKILL"); await exited; // Positive process-exit evidence, not a lease timeout.
    f.registry.install(defineExtension({ name: "tools", tools: [defineTool({ name: "effect", description: "effect", parameters: Type.Object({}), execute: async () => { fs.appendFileSync(effects, "REPLAY\n"); return {}; } })] }));
    f.faux.setResponses([
      transcript => { expect(JSON.stringify(transcript)).toContain("interrupted"); return fauxAssistantMessage("after kill"); },
      transcript => { expect(JSON.stringify(transcript)).toContain("surviving follow-up"); return fauxAssistantMessage("after recovered follow-up"); },
    ]);
    const runner = f.make(); await expect(runner.attach(admitted.locator, ctx, reporter().target)).rejects.toThrow(/single-writer lock/);
    const directory = (f.options.storage as { directory: string }).directory;
    const lock = fs.readdirSync(directory).find(name => name.endsWith(".writer"))!;
    fs.rmdirSync(path.join(directory, lock)); // Host restore after the child exit receipt.
    const result = reporter(); await runner.attach(admitted.locator, ctx, result.target);
    expect(await result.done).toEqual({ status: "completed", output: "after recovered follow-up" });
    const duplicate = reporter(); await runner.start(admitted.locator, ctx, duplicate.target); expect((await duplicate.done).output).toBe("after recovered follow-up");
    await runner.followUp(admitted.locator, "surviving follow-up", { requestId: "survivor" });
    expect(fs.readFileSync(effects, "utf8")).toBe("effect\n"); expect(f.faux.state.callCount).toBe(2);
  }, 20000);

  it("close joins opening/start, rejects new work and releases ownership exactly once", async () => {
    const f = setup(); let acquired!: () => void; let unblock!: () => void;
    const entering = new Promise<void>(r => { acquired = r; }); const gate = new Promise<void>(r => { unblock = r; }); const release = vi.fn();
    f.options.storage = { kind: "factory", identity: f.root, acquire: async () => { acquired(); await gate; return { storage: new MemoryStorage(), release }; } };
    f.faux.setResponses([fauxAssistantMessage("done")]);
    const runner = f.make(); const ctx = context(); const loc = runner.prepare(ctx);
    const start = runner.start(loc, ctx, reporter().target); await entering; const close = runner.close();
    await expect(runner.attach(loc, ctx, reporter().target)).rejects.toThrow(/closed/);
    expect(release).not.toHaveBeenCalled(); unblock(); await start; await close; await runner.close(); expect(release).toHaveBeenCalledTimes(1);
  });

  it.each(["close", "release"] as const)("retains ownership when failed-open cleanup fails (%s)", async (stage) => {
    const f = setup();
    const storage = new MemoryStorage();
    vi.spyOn(storage, "scanTasks").mockRejectedValue(new Error("open failed"));
    const release = vi.fn(async () => {});
    if (stage === "close") vi.spyOn(storage, "close").mockRejectedValue(new Error("close failed"));
    else release.mockRejectedValue(new Error("release failed"));
    f.options.storage = { kind: "factory", identity: f.root, acquire: async () => ({ storage, release }) };
    const runner = f.make(); const ctx = context(); const loc = runner.prepare(ctx);
    const failure: unknown = await Promise.resolve(runner.start(loc, ctx, reporter().target)).catch((error: unknown) => error);
    if (!(failure instanceof AggregateError)) throw new Error("Expected aggregated open/cleanup failure", { cause: failure });
    expect(failure.message).toContain("lease remains owned");
    expect(failure.errors.map((error: Error) => error.message)).toEqual(["open failed", `${stage} failed`]);
    expect(release).toHaveBeenCalledTimes(stage === "close" ? 0 : 1);
    await expect(f.make().attach(loc, ctx, reporter().target)).rejects.toThrow(/active writer/);
    expect(f.faux.state.callCount).toBe(0);
  });

  it("never treats a host-registered fabric_exec as replay-safe", async () => {
    const f = setup(true); let effects = 0; let enter!: () => void; const entered = new Promise<void>(r => { enter = r; });
    const effect = interruptedTool(() => effects++, () => enter());
    f.registry.install(defineExtension({ name: "tools", tools: [{ ...effect, name: "fabric_exec", replay: "safe" }] }));
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("fabric_exec", {}), { stopReason: "toolUse" }), transcript => { expect(JSON.stringify(transcript)).toContain("interrupted"); return fauxAssistantMessage("not replayed"); }]);
    const ctx = context({ tools: ["fabric_exec"] }); const runner = f.make(); const loc = runner.prepare(ctx);
    await runner.start(loc, ctx, reporter().target); await entered; await runner.close();
    const next = f.make(); const result = reporter(); await next.attach(loc, ctx, result.target);
    expect((await result.done).output).toBe("not replayed"); expect(effects).toBe(1);
  });

  it("pins selected registry implementations while open and refuses missing tools on reopen", async () => {
    const f = setup(true); let effects = 0;
    const effect = defineTool({ name: "effect", description: "effect", parameters: Type.Object({}), execute: async () => { effects++; return {}; } });
    const extension = defineExtension({ name: "tools", tools: [effect] }); f.registry.install(extension);
    f.faux.setResponses([() => { f.registry.install(defineExtension({ name: "tools", tools: [{ ...effect, execute: async () => { throw new Error("should not replace open code"); } }] })); return fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" }); }, fauxAssistantMessage("pinned")]);
    const runner = f.make(); const ctx = context({ tools: ["effect"] }); const loc = runner.prepare(ctx); const r = reporter(); await runner.start(loc, ctx, r.target); expect((await r.done).output).toBe("pinned"); expect(effects).toBe(1);
    await runner.close(); f.registry.uninstall(extension);
    await expect(f.make().attach(loc, ctx, reporter().target)).rejects.toThrow(/Unknown Pi durable tool/);
  });

  it("never admits missing work on attach, and reports unknown liveness", async () => {
    const f = setup(true); const runner = f.make(); const ctx = context(); const loc = runner.prepare(ctx);
    await expect(runner.attach(loc, ctx, reporter().target)).rejects.toThrow(/indeterminate.*not resubmitted/);
    expect(await runner.liveness(loc)).toBe("unknown"); expect(f.faux.state.callCount).toBe(0);
    expect(await runner.stop(loc, "requested")).toEqual({ confirmed: false });
  });

  it("exclusive writer prevents another session opening until close releases ownership", async () => {
    const f = setup(true); f.faux.setResponses([fauxAssistantMessage("done")]);
    const a = f.make(); const b = f.make(); const ctx = context(); const loc = a.prepare(ctx); const r = reporter();
    await a.start(loc, ctx, r.target); await r.done;
    await expect(b.attach(loc, ctx, reporter().target)).rejects.toThrow(/active writer/);
    await a.close(); const next = reporter(); await b.attach(loc, ctx, next.target); expect((await next.done).status).toBe("completed");
  });

  it("fails closed on existing filesystem locks instead of stealing stale ownership", async () => {
    const f = setup(true); f.faux.setResponses([fauxAssistantMessage("done")]); const a = f.make(); const ctx = context(); const loc = a.prepare(ctx); const r = reporter();
    await a.start(loc, ctx, r.target); await r.done; await a.close();
    const dir = (f.options.storage as { directory: string }).directory;
    const stem = fs.readdirSync(dir)[0]!; fs.mkdirSync(path.join(dir, `${stem}.writer`));
    await expect(f.make().attach(loc, ctx, reporter().target)).rejects.toThrow(/single-writer lock/);
  });

  it("offers only allowlisted registry tools and preserves prompt, cwd and thinking", async () => {
    const f = setup(); const used = vi.fn();
    f.registry.install(defineExtension({ name: "all", tools: [defineTool({ name: "allowed", description: "allowed", parameters: Type.Object({}), execute: async () => ({}) }), defineTool({ name: "forbidden", description: "forbidden", parameters: Type.Object({}), execute: async () => { used(); return {}; } })] }));
    f.faux.setResponses([(transcript, opts) => {
      expect(JSON.stringify(transcript)).toContain("special instructions");
      expect(JSON.stringify(transcript)).not.toContain('"name":"forbidden"');
      expect(opts?.reasoning).toBe("high");
      return fauxAssistantMessage(fauxToolCall("forbidden", {}), { stopReason: "toolUse" });
    }, fauxAssistantMessage("done")]);
    const ctx = context({ tools: ["allowed"], systemPrompt: "special instructions", thinking: "high", cwd: "/host-cwd" });
    const runner = f.make(); const r = reporter(); await runner.start(runner.prepare(ctx), ctx, r.target); expect((await r.done).status).toBe("completed"); expect(used).not.toHaveBeenCalled();
    expect(r.target.progress).toHaveBeenCalledWith(expect.objectContaining({ toolCalls: 1 }));
  });

  it("stop aborts owned tool work, maps cancellation and leaves other runs untouched", async () => {
    const f = setup(); let enter!: () => void; const entered = new Promise<void>(r => { enter = r; });
    f.registry.install(defineExtension({ name: "tools", tools: [interruptedTool(() => {}, () => enter())] }));
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" })]);
    const runner = f.make(); const ctx = context({ tools: ["effect"] }); const loc = runner.prepare(ctx); const r = reporter(); await runner.start(loc, ctx, r.target); await entered;
    f.faux.appendResponses([fauxAssistantMessage("other run done")]);
    const otherCtx = context({ id: "other", idempotencyKey: "other" }); const otherLoc = runner.prepare(otherCtx); const otherReporter = reporter();
    await runner.start(otherLoc, otherCtx, otherReporter.target); expect((await otherReporter.done).output).toBe("other run done");
    expect(await runner.liveness(loc)).toBe("running"); expect(await runner.stop(loc, "requested")).toEqual({ confirmed: true }); expect((await r.done).status).toBe("stopped"); expect(await runner.liveness(loc)).toBe("cancelled");
    expect(await runner.liveness(otherLoc)).toBe("settled");
    await expect(runner.steer(loc, "too late")).rejects.toThrow(/no longer accepts messages/);
    await expect(runner.followUp(loc, "too late")).rejects.toThrow(/no longer accepts messages/);
  });

  it("can be a configured leaf-run default with allowlisted, credential-free model discovery", async () => {
    const f = setup();
    f.options.defaultModel = { provider: "offline", modelId: "test" };
    Object.assign(f.faux.getModel(), { headers: { Authorization: "private-token" }, apiKey: "private-token" });
    f.faux.setResponses([fauxAssistantMessage("default selected")]);
    const runner = f.make(); cleanup.push(registerAgentRunner(runner));
    const models = await runner.models!({ cwd: process.cwd(), refresh: false });
    expect(models).toMatchObject([{ runner: runner.id, key: "offline/test", input: ["text"] }]);
    expect(JSON.stringify(models)).not.toContain("private-token");
    const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, runner: runner.id }, { runRoot: path.join(f.root, "runs") });
    cleanup.push(() => manager.close());
    expect(await manager.run({ task: "use the configured runner", tools: [], thinking: "off" })).toMatchObject({ runner: runner.id, model: "offline/test", status: "completed", text: "default selected" });
    expect(() => createPiDurableRunner({ ...f.options, defaultModel: { provider: "other", modelId: "no" } })).toThrow(/default model must be allowlisted/);
  });

  it("admits image input only for a compatible model and fingerprints its exact content", async () => {
    const f = setup(true, true);
    const image = { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" };
    f.faux.setResponses([transcript => {
      expect(JSON.stringify(transcript)).toContain(image.data);
      expect(JSON.stringify(transcript)).toContain("image/png");
      return fauxAssistantMessage("image received");
    }]);
    const ctx = context({ images: [image] }); const runner = f.make(); const loc = runner.prepare(ctx); const r = reporter();
    await runner.start(loc, ctx, r.target); expect((await r.done).output).toBe("image received");
    expect(JSON.stringify(loc)).not.toContain(image.data);
    await runner.close();
    const reopened = f.make();
    await expect(reopened.attach(loc, { ...ctx, images: [{ ...image, data: "Ynll" }] }, reporter().target)).rejects.toThrow(/different work/);
    const textOnly = setup();
    expect(() => textOnly.make().prepare(ctx)).toThrow(/does not accept image input/);
    expect(textOnly.faux.state.callCount).toBe(0);
  });

  it.each([
    ['{"answer":42}', "completed"],
    ['{"answer":"wrong"}', "failed"],
    ["not json", "failed"],
  ])("validates structured output %s (%s)", async (output, status) => {
    const f = setup(); const schema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false };
    f.faux.setResponses([transcript => {
      expect(JSON.stringify(transcript)).toContain("Your final response must contain only JSON");
      return fauxAssistantMessage(output!);
    }]);
    const runner = f.make(); const ctx = context({ schema }); const loc = runner.prepare(ctx); const r = reporter();
    await runner.start(loc, ctx, r.target); expect((await r.done).status).toBe(status);
    if (status === "completed") expect(r.target.finish).toHaveBeenCalledWith(expect.objectContaining({ structured: { answer: 42 } }));
    else expect((await r.done).output).toContain("Structured agent output was invalid");
    await expect(runner.start(loc, { ...ctx, schema: { type: "string" } }, reporter().target)).rejects.toThrow(/different work/);
  });

  it.each(["steer-first", "follow-up-first"])("waits for steering and follow-ups and deduplicates message identities across reopen (%s)", async order => {
    const f = setup(true); let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    f.registry.install(defineExtension({ name: "hold", tools: [defineTool({ name: "hold", description: "hold", parameters: Type.Object({}), execute: async (_args, _api, ctx) => { enter(); await awaitWithContext(gate, ctx); return {}; } })] }));
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      transcript => { expect(JSON.stringify(transcript)).toContain("steering note"); return fauxAssistantMessage("initial answer"); },
      transcript => { expect(JSON.stringify(transcript)).toContain("follow-up note"); return fauxAssistantMessage("follow-up answer"); },
    ]);
    const ctx = context({ tools: ["hold"] }); const runner = f.make(); const loc = runner.prepare(ctx); const r = reporter();
    await runner.start(loc, ctx, r.target); await entered;
    if (order === "follow-up-first") await runner.followUp(loc, "follow-up note", { requestId: "follow-1" });
    await runner.steer(loc, "steering note", { requestId: "steer-1" });
    await runner.steer(loc, "steering note", { requestId: "steer-1" });
    await expect(runner.steer(loc, "different", { requestId: "steer-1" })).rejects.toThrow(/different work/);
    if (order === "steer-first") await runner.followUp(loc, "follow-up note", { requestId: "follow-1" });
    expect(r.target.finish).not.toHaveBeenCalled(); expect(await runner.liveness(loc)).toBe("running"); release();
    expect(await r.done).toEqual({ status: "completed", output: "follow-up answer" });
    expect(f.faux.state.callCount).toBe(3); expect(await runner.liveness(loc)).toBe("settled");
    await expect(runner.followUp(loc, "late note")).rejects.toThrow(/no longer accepts messages/);
    await runner.close(); const reopened = f.make(); const again = reporter(); await reopened.attach(loc, ctx, again.target);
    expect(await again.done).toEqual({ status: "completed", output: "follow-up answer" });
    await reopened.followUp(loc, "follow-up note", { requestId: "follow-1" });
    await expect(reopened.steer(loc, "follow-up note", { requestId: "follow-1" })).rejects.toThrow(/different work/);
    expect(f.faux.state.callCount).toBe(3);
  });

  it("recovers queued follow-ups without replaying an interrupted unsafe tool", async () => {
    const f = setup(true); let effects = 0; let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    f.registry.install(defineExtension({ name: "tools", tools: [interruptedTool(() => effects++, () => enter())] }));
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("recovered first answer"),
      transcript => { expect(JSON.stringify(transcript)).toContain("durable follow-up"); return fauxAssistantMessage("recovered follow-up"); },
    ]);
    const ctx = context({ tools: ["effect"] }); const runner = f.make(); const loc = runner.prepare(ctx); const first = reporter();
    await runner.start(loc, ctx, first.target); await entered;
    await runner.followUp(loc, "durable follow-up", { requestId: "durable-message" });
    await runner.close(); expect(first.target.finish).not.toHaveBeenCalled(); expect(first.target.fail).not.toHaveBeenCalled();
    const reopened = f.make(); const next = reporter(); await reopened.attach(loc, ctx, next.target);
    expect(await next.done).toEqual({ status: "completed", output: "recovered follow-up" });
    expect(effects).toBe(1); expect(f.faux.state.callCount).toBe(3);
  });

  it("withdraws queued follow-ups when the active generation fails", async () => {
    const f = setup(); let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    f.registry.install(defineExtension({ name: "hold", tools: [defineTool({ name: "hold", description: "hold", parameters: Type.Object({}), execute: async (_args, _api, ctx) => { enter(); await awaitWithContext(gate, ctx); return {}; } })] }));
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "offline failure" }),
      fauxAssistantMessage("must not run"),
    ]);
    const ctx = context({ tools: ["hold"] }); const runner = f.make(); const loc = runner.prepare(ctx); const r = reporter();
    await runner.start(loc, ctx, r.target); await entered;
    await runner.followUp(loc, "queued work", { requestId: "queued" }); release();
    expect((await r.done).status).toBe("failed"); expect(f.faux.state.callCount).toBe(2);
    expect(await runner.liveness(loc)).toBe("interrupted");
    await expect(runner.followUp(loc, "new work")).rejects.toThrow(/no longer accepts messages/);
  });

  it("keeps the run live while a follow-up is executing and stops it", async () => {
    const f = setup(); let firstEnter!: () => void; let nextEnter!: () => void; let release!: () => void; let calls = 0;
    const firstEntered = new Promise<void>(r => { firstEnter = r; }); const nextEntered = new Promise<void>(r => { nextEnter = r; }); const gate = new Promise<void>(r => { release = r; });
    f.registry.install(defineExtension({ name: "hold", tools: [defineTool({ name: "hold", description: "hold", parameters: Type.Object({}), execute: async (_args, _api, ctx) => {
      if (++calls === 1) { firstEnter(); await awaitWithContext(gate, ctx); }
      else { nextEnter(); await awaitWithContext(new Promise<void>(() => {}), ctx); }
      return {};
    } })] }));
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }), fauxAssistantMessage("first answer"), fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" })]);
    const ctx = context({ tools: ["hold"] }); const runner = f.make(); const loc = runner.prepare(ctx); const r = reporter();
    await runner.start(loc, ctx, r.target); await firstEntered;
    await runner.followUp(loc, "more work"); release(); await nextEntered;
    expect(r.target.finish).not.toHaveBeenCalled(); expect(await runner.liveness(loc)).toBe("running");
    expect(await runner.stop(loc, "requested")).toEqual({ confirmed: true });
    expect((await r.done).status).toBe("stopped"); expect(await runner.liveness(loc)).toBe("cancelled");
  });

  it("bounds and validates message controls before admission", async () => {
    const f = setup(); let enter!: () => void; const entered = new Promise<void>(r => { enter = r; });
    f.registry.install(defineExtension({ name: "tools", tools: [interruptedTool(() => {}, () => enter())] }));
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" })]);
    const ctx = context({ tools: ["effect"] }); const runner = f.make(); const loc = runner.prepare(ctx); const r = reporter();
    await runner.start(loc, ctx, r.target); await entered;
    await expect(runner.steer(loc, " ")).rejects.toThrow(/characters/);
    await expect(runner.steer(loc, "x".repeat(16385))).rejects.toThrow(/characters/);
    await expect(runner.steer(loc, "note", { requestId: "" })).rejects.toThrow(/requestId/);
    await expect(runner.steer(loc, "note", { images: [] } as never)).rejects.toThrow(/only requestId/);
    for (let i = 0; i < 128; i++) await runner.followUp(loc, `queued ${i}`, { requestId: `message-${i}` });
    await expect(runner.followUp(loc, "overflow")).rejects.toThrow(/128 messages/);
    await runner.stop(loc, "requested"); expect((await r.done).status).toBe("stopped");
    expect(f.faux.state.callCount).toBe(1);
  });

  it("rejects missing models/tools and every unsupported launch capability before admission", () => {
    const f = setup(); const runner = f.make();
    expect(() => runner.prepare(context({ model: "offline/unknown" }))).toThrow(/model/);
    expect(() => runner.prepare(context({ model: undefined } as unknown as Partial<FabricHostedRunContext>))).toThrow(/model/);
    expect(() => runner.prepare(context({ tools: ["fabric_exec"] }))).toThrow(/tool/);
    for (const changes of [{ recursive: true }, { kernel: "typescript" }, { sessionFile: "/seed" }, { actorId: "actor" }, { writePolicy: {} }, { scope: {} }, { residency: "durable" }]) {
      expect(() => runner.prepare(context(changes as Partial<FabricHostedRunContext>))).toThrow(/does not support|requires/);
    }
    expect(f.faux.state.callCount).toBe(0);
  });
});
