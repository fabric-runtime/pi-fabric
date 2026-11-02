// What createFabricExtension does across conversations, restarts, cancellation, fork and
// compaction, and on Node and Bun, including the replay-safe resume after a process kill.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, type Message } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, type Report, type ToolRegistration } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFabricExtension } from "../src/durable-extension.js";
import type { FabricKernelRuntime } from "../src/runtime/kernel.js";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";
import { ctx, latch, openHost } from "./durable-extension-host.js";

const project = process.cwd();
const roots: string[] = [];
const tempRoot = (label: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `f067-${label}-`));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const parsed = <T>(text: string): T => JSON.parse(text) as T;
const textTool = (name: string, execute: ToolRegistration["execute"]): ToolRegistration =>
  defineTool({ name, description: `Test tool ${name}`, parameters: Type.Object({}, { additionalProperties: true }), execute });
const ok = (text: string) => ({ output: [{ type: "text" as const, text }] });

describe("no state crosses conversations or tenants in one process", () => {
  it("keeps globals, prototypes and module state of two concurrent tenants apart", async () => {
    // Each program writes its marks, then waits until the other tenant's program has written
    // its own, so both run at once and a shared realm would show the other's marks.
    const alphaIn = latch();
    const betaIn = latch();
    const rendezvous = textTool("rendezvous", async (args) => {
      const tenant = (args as { tenant: string }).tenant;
      if (tenant === "t_alpha") { alphaIn.open(); await betaIn.opened; } else { betaIn.open(); await alphaIn.opened; }
      return ok(tenant);
    });
    const host = await openHost({ tools: [rendezvous] });
    try {
      const program = (tenant: string) => `
        const before = { global: typeof globalThis.mark, proto: ({}).mark ?? null, array: [].mark ?? null, pi: typeof π };
        globalThis.mark = "${tenant}";
        Object.prototype.mark = "${tenant}";
        Array.prototype.mark = "${tenant}";
        (globalThis.tenantCache ??= []).push("${tenant}");
        const met = await tools.rendezvous({ tenant: "${tenant}" });
        const found = await tools.search_knowledge({ query: "${tenant}" });
        return { before, met, found, after: { global: globalThis.mark, proto: ({}).mark, array: [].mark, cache: globalThis.tenantCache.join(",") } };`;
      const alpha = await host.conversation("t_alpha");
      const beta = await host.conversation("t_beta");
      const [a, b] = await Promise.all([
        host.turn(alpha, "alpha turn", program("t_alpha")),
        host.turn(beta, "beta turn", program("t_beta")),
      ]);
      for (const [run, tenant] of [[a, "t_alpha"], [b, "t_beta"]] as const) {
        expect(run.isError).toBe(false);
        expect(parsed(run.text)).toEqual({
          before: { global: "undefined", proto: null, array: null, pi: "object" },
          met: tenant,
          found: `search_knowledge:${tenant}`,
          after: { global: tenant, proto: tenant, array: tenant, cache: tenant },
        });
      }
      // Each nested call ran as its own conversation's call, never the other tenant's.
      expect(host.calls.filter((call) => call.name === "search_knowledge").map((call) => [call.conversationId, call.args]))
        .toEqual(expect.arrayContaining([[alpha.id, { query: "t_alpha" }], [beta.id, { query: "t_beta" }]]));
      // A later program in the same conversation starts clean too.
      const again = await host.turn(alpha, "alpha again", "return [typeof globalThis.mark, ({}).mark ?? null, typeof globalThis.tenantCache]");
      expect(parsed(again.text)).toEqual(["undefined", null, "undefined"]);
    } finally {
      await host.close();
    }
  }, 30_000);
});

/** One child process that starts a fabric_exec program and dies inside its second nested call. */
const killMidProgram = async (root: string, secondReplay: "safe" | "unsafe") => {
  const db = path.join(root, "harness.db");
  const effects = path.join(root, "effects");
  const ready = path.join(root, "ready");
  const script = path.join(root, "child.ts");
  const dependency = (name: string) => JSON.stringify(pathToFileURL(path.join(project, "node_modules", name)).href);
  fs.writeFileSync(script, `
import fs from "node:fs";
import { BACKGROUND_CONTEXT as ctx } from ${dependency("@earendil-works/chord/dist/context/index.js")};
import { Type } from ${JSON.stringify(import.meta.resolve("typebox"))};
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from ${dependency("@earendil-works/pi-ai/dist/index.js")};
import { createRegistry, defineExtension, defineTool, Harness } from ${dependency("@earendil-works/pi-durable/dist/index.js")};
import { openNodeSqliteStorage } from ${dependency("@earendil-works/pi-durable/dist/storage/sqlite/node.js")};
import { createFabricExtension } from ${JSON.stringify(pathToFileURL(path.join(project, "src/durable-extension.ts")).href)};
const models = createModels();
const faux = fauxProvider({ provider: "test", models: [{ id: "scripted" }] });
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage(fauxToolCall("fabric_exec", {
  code: "const a = await tools.first({ n: 1 }); const b = await tools.second({ n: 2 }); return [a, b, Date.now() > 0];",
}, { id: "call_kill" }), { stopReason: "toolUse" })]);
const registry = createRegistry();
const log = (line) => fs.appendFileSync(${JSON.stringify(effects)}, line + "\\n");
registry.install(defineExtension({ name: "host-tools", tools: [
  defineTool({ name: "first", description: "first", parameters: Type.Object({ n: Type.Number() }),
    execute: async (args) => { log("first " + args.n); return { output: [{ type: "text", text: "done " + args.n }] }; } }),
  defineTool({ name: "second", description: "second", replay: ${JSON.stringify(secondReplay)}, parameters: Type.Object({ n: Type.Number() }),
    execute: async (args) => {
      log("second " + args.n);
      // The process dies inside this call.
      fs.writeFileSync(${JSON.stringify(ready)}, "1"); await new Promise(() => {});
    } }),
] }));
registry.install(createFabricExtension({ timeoutMs: 60000 }));
const harness = await Harness.open(await openNodeSqliteStorage(${JSON.stringify(db)}), { models, registry }, ctx);
const conversation = await harness.root(ctx, { agent: { model: { provider: "test", modelId: "scripted" } } });
await conversation.submit({ type: "input", content: "go" }, ctx);
setInterval(() => {}, 1000);
`);
  const child = spawn("bun", [script], { stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors = (errors + String(chunk)).slice(-4000); });
  const exited = once(child, "exit");
  try {
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(ready)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Child did not reach the second call: ${errors}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
  expect(child.signalCode).toBe("SIGKILL");
  return { db, effects };
};

/** Reopen the killed child's storage with the same extensions and let recovery run. */
const reopen = async (db: string, effects: string, secondReplay: "safe" | "unsafe") => {
  const requests: Message[][] = [];
  const models = createModels();
  const faux = fauxProvider({ provider: "test", models: [{ id: "scripted" }] });
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 4 }, () => (context: { messages: Message[] }) => {
    requests.push([...context.messages]);
    return fauxAssistantMessage(fauxText("after restart"));
  }));
  const log = (line: string) => fs.appendFileSync(effects, `${line}\n`);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "host-tools", tools: [
    defineTool({ name: "first", description: "first", parameters: Type.Object({ n: Type.Number() }),
      execute: async (args) => { log(`AGAIN first ${args.n}`); return ok("first again"); } }),
    defineTool({ name: "second", description: "second", replay: secondReplay, parameters: Type.Object({ n: Type.Number() }),
      execute: async (args) => { log(`AGAIN second ${args.n}`); return ok(`second rerun ${args.n}`); } }),
  ] }));
  registry.install(createFabricExtension({ timeoutMs: 60_000 }));
  const storage = await openNodeSqliteStorage(db);
  const harness = await Harness.open(storage, { models, registry }, ctx);
  const conversation = await harness.root(ctx);
  await conversation.waitForIdle(ctx);
  const tasks = (await storage.scanTasks({ conversationId: conversation.id, kind: "pi.tool" }, 100, undefined, ctx)).items;
  const result = requests[0]?.find((message) => message.role === "toolResult") as { toolCallId: string; isError: boolean; content: { text: string }[] } | undefined;
  return { harness, conversation, tasks, requests, result, text: result?.content.map((item) => item.text).join("\n") ?? "" };
};

describe("fabric_exec resumes from its journal across a real process kill", () => {
  it("replays the finished call, gets the interrupted replay-safe call back, and finishes the program", async () => {
    const root = tempRoot("kill-safe");
    const { db, effects } = await killMidProgram(root, "safe");
    const run = await reopen(db, effects, "safe");
    try {
      // The program reran: the finished first call came from the journal, and pi-durable reran only the
      // replay-safe second call, once.
      expect(fs.readFileSync(effects, "utf8")).toBe("first 1\nsecond 2\nAGAIN second 2\n");
      expect(run.result).toMatchObject({ toolCallId: "call_kill", isError: false });
      expect(parsed(run.text)).toEqual(["done 1", "second rerun 2", true]);
      const program = run.tasks.find((task) => (task.input as { kind?: string }).kind === "model");
      expect(program?.state).toMatchObject({ status: "terminal", outcome: { status: "completed" } });
      // Two nested calls, keyed by issue number (0 is the guest's catalog read): the rerun made no third one.
      expect(run.tasks.filter((task) => (task.input as { kind?: string }).kind === "nested").map((task) => (task.input as { key: string }).key).sort())
        .toEqual(["f1", "f2"]);
      const next = await (await run.conversation.submit({ type: "input", content: "next" }, ctx)).wait(ctx);
      expect(next.status).toBe("done");
    } finally {
      await run.harness.close(ctx);
    }
  });

  it("stops at an interrupted call that may have run, repeats nothing, tells the model, and the conversation continues", async () => {
    const root = tempRoot("kill-unsafe");
    const { db, effects } = await killMidProgram(root, "unsafe");
    const run = await reopen(db, effects, "unsafe");
    try {
      // Neither call ran again.
      expect(fs.readFileSync(effects, "utf8")).toBe("first 1\nsecond 2\n");
      expect(run.result).toMatchObject({ toolCallId: "call_kill", isError: true });
      expect(run.text).toContain("fabric_exec was interrupted during this call, which may have run:\n  second({\"n\":2})");
      expect(run.text).toContain("1 earlier tool call finished before the interruption and was replayed from the journal without running again.");
      expect(run.text).toContain("Check whether it took effect, or ask the user, before running it or the rest of the program again.");
      const nested = run.tasks.filter((task) => (task.input as { kind?: string }).kind === "nested");
      expect(nested.map((task) => [(task.input as { key: string }).key, task.state.status === "terminal" ? task.state.outcome.status : task.state.status]).sort())
        .toEqual([["f1", "completed"], ["f2", "failed"]]);
      const next = await (await run.conversation.submit({ type: "input", content: "next" }, ctx)).wait(ctx);
      expect(next.status).toBe("done");
      expect(run.requests).toHaveLength(2);
    } finally {
      await run.harness.close(ctx);
    }
  });
});
describe("cancelling the turn", () => {
  it("aborts the in-flight nested call and the program, and leaves no kernel running", async () => {
    const started = latch();
    const signals: string[] = [];
    const block = textTool("block", async (_args, _api, context) => {
      started.open();
      await new Promise<void>((resolve) => {
        context.abortSignal?.addEventListener("abort", () => { signals.push("block aborted"); resolve(); }, { once: true });
      });
      return ok("unblocked");
    });
    const after = textTool("after_cancel", async () => { signals.push("after_cancel ran"); return ok("after"); });
    // The real kernel, counted: a program still running after the cancel would hold a QuickJS context.
    const kernel = new QuickJsRuntime();
    let running = 0;
    const runtime: FabricKernelRuntime = {
      execute: async (...args) => { running++; try { return await kernel.execute(...args); } finally { running--; } },
    };
    const host = await openHost({ tools: [block, after], fabric: { runtime, timeoutMs: 60_000 } });
    try {
      const conversation = await host.conversation("t_alpha");
      // After the cancel the program waits on a long timer: only the abort signal can end it early.
      const turn = host.turn(conversation, "cancel me", `
        try { await tools.block({}); } catch {}
        await new Promise((resolve) => setTimeout(resolve, 50_000));
        await tools.after_cancel({});
        return "finished";`);
      await started.opened;
      expect(running).toBe(1);
      const cancelledAt = Date.now();
      await conversation.abort(ctx);
      const run = await turn;
      expect(run.status).not.toBe("done");
      expect(signals).toContain("block aborted");
      // The kernel returned long before the 60 s deadline.
      await vi.waitFor(() => expect(running).toBe(0), { timeout: 5_000, interval: 20 });
      expect(Date.now() - cancelledAt).toBeLessThan(5_000);
      // The program did not go on after the cancel: no later call ran, now or after a pause.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(signals).toEqual(["block aborted"]);
    } finally {
      await host.close();
    }
  }, 30_000);

  it("ends a program waiting on a timer, with no nested call in flight, as soon as the turn is cancelled", async () => {
    const started = latch();
    const signals: string[] = [];
    const ready = textTool("ready", async () => { started.open(); return ok("ready"); });
    const after = textTool("after_cancel", async () => { signals.push("after_cancel ran"); return ok("after"); });
    const kernel = new QuickJsRuntime();
    let running = 0;
    const runtime: FabricKernelRuntime = {
      execute: async (...args) => { running++; try { return await kernel.execute(...args); } finally { running--; } },
    };
    const host = await openHost({ tools: [ready, after], fabric: { runtime, timeoutMs: 60_000 } });
    try {
      const conversation = await host.conversation("t_alpha");
      // Only the turn's abort signal can end this program early: no nested call is running when the cancel comes.
      const turn = host.turn(conversation, "cancel me", `
        await tools.ready({});
        await new Promise((resolve) => setTimeout(resolve, 50_000));
        await tools.after_cancel({});
        return "finished";`);
      await started.opened;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(running).toBe(1);
      const cancelledAt = Date.now();
      await conversation.abort(ctx);
      const run = await turn;
      expect(run.status).not.toBe("done");
      await vi.waitFor(() => expect(running).toBe(0), { timeout: 5_000, interval: 20 });
      expect(Date.now() - cancelledAt).toBeLessThan(5_000);
      expect(signals).toEqual([]);
    } finally {
      await host.close();
    }
  }, 30_000);
});

describe("fork and compaction keep fabric_exec and its section", () => {
  it("offers fabric_exec with its section in a forked and in a compacted conversation", async () => {
    // Keep almost nothing verbatim, so the compaction summarizes the first turn.
    const host = await openHost({ settings: { compaction: { keepRecentTokens: 1 } } });
    try {
      const source = await host.conversation("t_alpha");
      const first = await host.turn(source, "first", 'return await tools.search_knowledge({ query: "one" })');
      expect(first.text).toBe("search_knowledge:one");
      const check = (run: Awaited<ReturnType<typeof host.turn>>, query: string) => {
        expect(run.offered).toContain("fabric_exec");
        const section = run.sections.fabric ?? "";
        expect(section).toContain("Use fabric_exec to batch several tool calls");
        expect(section).toContain("  search_knowledge(args: { query?: string; }): Promise<string>;");
        expect(run.isError).toBe(false);
        expect(run.text).toBe(`search_knowledge:${query}`);
      };

      const newest = (await source.entries({ order: "descending" }, 1, undefined, ctx)).items[0]!;
      const fork = await source.fork(newest.id, { ownership: { kind: "ownerless" } }, ctx);
      host.tenants.set(fork.id, "t_alpha");
      check(await host.turn(fork, "in the fork", 'return await tools.search_knowledge({ query: "forked" })'), "forked");

      const compaction = await source.compact(undefined, ctx);
      const { outcome } = (await host.harness.waitForTask(compaction, ctx)).state;
      expect(outcome.status).toBe("completed");
      const placed = outcome.status === "completed" ? outcome.result.submissionId : undefined;
      expect(placed).toBeDefined();
      expect((await (await host.harness.submission(placed!, ctx))!.wait(ctx)).status).toBe("done");
      expect((await source.context(ctx)).head?.kind).toBe("pi.compaction");
      check(await host.turn(source, "after compaction", 'return await tools.search_knowledge({ query: "compacted" })'), "compacted");
    } finally {
      await host.close();
    }
  }, 30_000);
});

describe("errors reach onReport and never crash the Harness", () => {
  it("reports a section render failure as extension_error with the extension's name, and the turn still runs", async () => {
    // A host tool whose description getter throws while Fabric renders its section (and only
    // there: pi-durable's own tool list reads it too) makes that render throw.
    const broken = textTool("broken_tool", async () => ok("broken"));
    let armed = false;
    Object.defineProperty(broken, "description", { get: () => {
      if (armed && /\brender \(.*durable-extension\.ts/.test(new Error().stack ?? "")) throw new Error("description store unavailable");
      return "Broken tool";
    } });
    const reports: Report[] = [];
    const onError = vi.fn();
    const host = await openHost({ tools: [broken], fabric: { onError }, onReport: report => { reports.push(report); } });
    try {
      const conversation = await host.conversation("t_alpha");
      armed = true;
      const run = await host.turn(conversation, "render fails", 'return await tools.search_knowledge({ query: "still works" })');
      armed = false;
      const extensionErrors = reports.filter(report => report.kind === "extension_error");
      expect(extensionErrors.length).toBeGreaterThan(0);
      // pi-durable names the extension; a section error carries no conversation id.
      expect(extensionErrors[0]).toMatchObject({ kind: "extension_error", extension: "pi-fabric" });
      expect((extensionErrors[0]!.error as Error).message).toBe("description store unavailable");
      // The Harness carried on: the turn ran and the program's call worked.
      expect(run.status).toBe("done");
      expect(run.text).toBe("search_knowledge:still works");
      expect(reports.filter(report => report.kind === "storage_failed")).toEqual([]);
      // Section errors belong to onReport, not onError.
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await host.close();
    }
  }, 30_000);
});

describe("Node and Bun", () => {
  const built = path.join(project, "dist/durable-extension.js");
  const script = (root: string) => {
    const file = path.join(root, "run.mjs");
    const dependency = (name: string) => JSON.stringify(pathToFileURL(path.join(project, "node_modules", name)).href);
    fs.writeFileSync(file, `
import { BACKGROUND_CONTEXT as ctx } from ${dependency("@earendil-works/chord/dist/context/index.js")};
import { Type } from ${JSON.stringify(import.meta.resolve("typebox"))};
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from ${dependency("@earendil-works/pi-ai/dist/index.js")};
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from ${dependency("@earendil-works/pi-durable/dist/index.js")};
import { createFabricExtension } from ${JSON.stringify(pathToFileURL(built).href)};
const models = createModels();
const faux = fauxProvider({ provider: "test", models: [{ id: "scripted" }] });
models.setProvider(faux.provider);
let result;
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("fabric_exec", { code: "const [a, b] = await Promise.all([tools.stub({ q: 'a' }), tools.stub({ q: 'b' })]); return { a, b, runtime: typeof Bun === 'undefined' ? 'no Bun' : 'Bun visible' };" }), { stopReason: "toolUse" }),
  (context) => { result = context.messages.at(-1); return fauxAssistantMessage(fauxText("done")); },
]);
const registry = createRegistry();
registry.install(defineExtension({ name: "host-tools", tools: [defineTool({ name: "stub", description: "stub", parameters: Type.Object({ q: Type.String() }),
  execute: async (args) => ({ output: [{ type: "text", text: "stub:" + args.q }] }) })] }));
registry.install(createFabricExtension());
const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
const conversation = await harness.root(ctx, { agent: { model: { provider: "test", modelId: "scripted" } } });
const record = await (await conversation.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
await harness.close(ctx);
console.log(JSON.stringify({ status: record.status, isError: result?.isError === true, text: result?.content?.[0]?.text, host: typeof Bun === "undefined" ? "node" : "bun" }));
`);
    return file;
  };

  it.each([["node", process.execPath], ["bun", "bun"]] as const)("runs the built entry on %s", async (host, binary) => {
    expect(fs.existsSync(built), "run `bun run build` first: this test loads the published entry").toBe(true);
    const { stdout } = await promisify(execFile)(binary, [script(tempRoot(`runtime-${host}`))], { timeout: 60_000 });
    const line = stdout.trim().split("\n").at(-1)!;
    expect(parsed(line)).toEqual({
      status: "done",
      isError: false,
      text: JSON.stringify({ a: "stub:a", b: "stub:b", runtime: "no Bun" }, null, 2),
      host,
    });
  }, 90_000);
});
