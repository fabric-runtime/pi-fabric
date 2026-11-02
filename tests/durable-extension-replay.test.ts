// Replay-safe fabric_exec: a crash after every storage commit of a run, a resume the journal
// cannot trust, and a randomised replay fuzz. Each crash is a storage prefix: the commits of one
// full run up to that point, opened by a fresh Harness with fresh extensions, which then recovers.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, type Storage, type StorageWrite } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createFabricExtension, FABRIC_DURABLE_ENGINE, type FabricExtensionOptions } from "../src/durable-extension.js";

const MODEL = { provider: "test", modelId: "scripted" } as const;

type Event = { commit: number } | { effect: string };

/** A storage that records every commit, so a test can rebuild the state as of any point. */
const recording = (timeline: Event[], commits: StorageWrite[][]): Storage => {
  const inner = new MemoryStorage();
  return new Proxy(inner, {
    get(target, property) {
      if (property === "commit") {
        return async (...[batches, receive, context]: Parameters<Storage["commit"]>) =>
          target.commit(batches, (index, seq) => {
            commits.push(structuredClone([...batches[index]!]));
            timeline.push({ commit: commits.length });
            receive(index, seq);
          }, context);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as Storage;
};

const prefixStorage = async (commits: readonly StorageWrite[][], count: number, edit?: (json: string) => string): Promise<Storage> => {
  const storage = new MemoryStorage();
  for (const writes of commits.slice(0, count)) {
    await commitWrites(storage, edit ? JSON.parse(edit(JSON.stringify(writes))) as StorageWrite[] : writes, ctx);
  }
  return storage;
};

interface Run {
  readonly harness: Harness;
  readonly storage: Storage;
}

/** One host: a scripted model that runs `code` once, read and effect stub tools, a provider with an effect. */
const openRun = async (code: string, storage: Storage, log: (line: string) => void, fabric: FabricExtensionOptions = {}): Promise<Run> => {
  const models = createModels();
  const faux = fauxProvider({ provider: "test", models: [{ id: "scripted" }] });
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 20 }, () => (context: { messages: Message[] }) =>
    context.messages.at(-1)?.role === "toolResult"
      ? fauxAssistantMessage(fauxText("done"))
      : fauxAssistantMessage(fauxToolCall("fabric_exec", { code }, { id: "call_1" }), { stopReason: "toolUse" })));
  const registry = createRegistry();
  registry.install(defineExtension({
    name: "host-tools",
    tools: [
      defineTool({ name: "read", description: "read", replay: "safe", parameters: Type.Object({ q: Type.String() }),
        execute: async (args) => { log(`read ${args.q}`); await new Promise((resolve) => setTimeout(resolve, 1)); return { output: [{ type: "text", text: `read:${args.q}` }] }; } }),
      defineTool({ name: "pay", description: "pay", replay: "unsafe", parameters: Type.Object({ q: Type.String() }),
        execute: async (args) => { log(`pay ${args.q}`); await new Promise((resolve) => setTimeout(resolve, 1)); return { output: [{ type: "text", text: `paid:${args.q}` }] }; } }),
    ],
  }));
  registry.install(createFabricExtension({
    timeoutMs: 20_000,
    providers: {
      notes: {
        actions: {
          add: async (args) => { log(`notes.add ${String(args.text)}`); return { id: `note:${String(args.text)}` }; },
          peek: { repeatable: true, run: async (args) => { log(`notes.peek ${String(args.text)}`); return `peek:${String(args.text)}`; } },
        },
      },
    },
    ...fabric,
  }));
  const harness = await Harness.open(storage, { models, registry }, ctx);
  return { harness, storage };
};

interface Outcome {
  readonly called: boolean;
  readonly isError: boolean;
  readonly text: string;
}

/** The fabric_exec result the model got, read from the transcript once the Harness is idle. */
const outcome = async (run: Run): Promise<Outcome> => {
  await run.harness.waitForIdle(ctx);
  const conversations = (await run.storage.scanConversations({}, 10, undefined, ctx)).items;
  for (const conversation of conversations) {
    const entries = (await run.storage.scanEntries({ conversationId: conversation.id }, 500, undefined, ctx)).items;
    for (const entry of entries) {
      for (const message of entry.model ?? []) {
        if (message.role === "toolResult" && message.toolCallId === "call_1") {
          const text = message.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
          return { called: true, isError: message.isError === true, text };
        }
      }
    }
  }
  return { called: false, isError: false, text: "" };
};

const start = async (code: string, fabric: FabricExtensionOptions = {}) => {
  const timeline: Event[] = [];
  const commits: StorageWrite[][] = [];
  const storage = recording(timeline, commits);
  const run = await openRun(code, storage, (line) => timeline.push({ effect: line }), fabric);
  const conversation = await run.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MODEL } }, ctx);
  await (await conversation.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  const result = await outcome(run);
  await run.harness.close(ctx);
  return { timeline, commits, result };
};

/** Effects that may have run while storage held the first `count` commits: a crash may come after any of them. */
const effectsBefore = (timeline: readonly Event[], count: number): string[] => {
  const effects: string[] = [];
  for (const event of timeline) {
    if ("commit" in event && event.commit > count) break;
    if ("effect" in event) effects.push(event.effect);
  }
  return effects;
};

const recover = async (code: string, commits: readonly StorageWrite[][], count: number, fabric: FabricExtensionOptions = {}, edit?: (json: string) => string) => {
  const storage = await prefixStorage(commits, count, edit);
  const effects: string[] = [];
  const run = await openRun(code, storage, (line) => effects.push(line), fabric);
  try {
    return { result: await outcome(run), effects };
  } finally {
    await run.harness.close(ctx);
  }
};

const EFFECT = /^(pay|notes\.add) /;
const MAYBE_RAN = "fabric_exec was interrupted during this call, which may have run:";

/** What must hold after a crash at commit `count` and a recovery. */
const checkCrash = (code: string, original: Outcome, before: readonly string[], after: { result: Outcome; effects: string[] }, label: string, compare: (text: string) => unknown) => {
  const effects = [...before, ...after.effects].filter((line) => EFFECT.test(line));
  // No effect ran twice.
  expect(new Set(effects).size, `${label}: effects ${effects.join(", ")}`).toBe(effects.length);
  if (!after.result.called) {
    expect(effects, label).toEqual([]);
    return "none";
  }
  if (!after.result.isError) {
    expect(compare(after.result.text), label).toEqual(compare(original.text));
    return "completed";
  }
  // The only error a crash may cause: a call that may have run, which ran at most once and was not repeated.
  expect(after.result.text, `${label}: ${after.result.text}`).toContain(MAYBE_RAN);
  expect(after.result.text).toContain("Check whether it took effect, or ask the user");
  void code;
  return "stopped";
};

const PROGRAM = `
const [a, b] = await Promise.all([tools.read({ q: "a" }), tools.read({ q: "b" })]);
await new Promise((resolve) => setTimeout(resolve, 2));
const seen = await notes.peek({ text: a });
const r = Math.random();
const p = await tools.pay({ q: a + b });
const n = await notes.add({ text: p });
const c = await tools.read({ q: p });
return { a, b, seen, p, n, c, r };`;

describe("replay-safe fabric_exec: a crash after every commit", () => {
  it("never runs an effect twice, and either finishes with the original result or stops at a call that may have run", async () => {
    const first = await start(PROGRAM);
    expect(first.result.isError, first.result.text).toBe(false);
    const values = JSON.parse(first.result.text) as Record<string, unknown>;
    expect(values).toMatchObject({ a: "read:a", b: "read:b", seen: "peek:read:a", p: "paid:read:aread:b", n: { id: "note:paid:read:aread:b" }, c: "read:paid:read:aread:b" });
    const headerCommit = first.commits.findIndex((writes) => JSON.stringify(writes).includes(FABRIC_DURABLE_ENGINE)) + 1;
    expect(headerCommit).toBeGreaterThan(0);
    const seen = new Map<string, number[]>();
    for (let count = 0; count <= first.commits.length; count++) {
      const after = await recover(PROGRAM, first.commits, count);
      const kind = checkCrash(PROGRAM, first.result, effectsBefore(first.timeline, count), after, `crash after commit ${count}/${first.commits.length}`, (text) => {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        // The seeded Math.random repeats once the journal header is stored.
        return count >= headerCommit ? parsed : { ...parsed, r: "fresh" };
      });
      seen.set(kind, [...(seen.get(kind) ?? []), count]);
    }
    // Every outcome happened: a crash before the call, a resume that finished, and a stop at an effect in flight.
    expect([...seen.keys()].sort()).toEqual(["completed", "none", "stopped"]);
    // Both kinds of effect were caught in flight at least once.
    const stoppedTexts = new Set<string>();
    for (const count of seen.get("stopped") ?? []) {
      const after = await recover(PROGRAM, first.commits, count);
      stoppedTexts.add(after.result.text.split("\n")[1]!.trim().replace(/\(.*/, ""));
    }
    expect([...stoppedTexts].sort()).toEqual(["notes.add", "pay"]);
  }, 120_000);
});

describe("replay-safe fabric_exec: a resume the journal cannot trust", () => {
  const inFlight = async () => {
    const first = await start(PROGRAM);
    // The last commit before the effect: the journal holds the reads, and nothing after them.
    const count = first.commits.findIndex((writes) => JSON.stringify(writes).includes("\"ref\":\"pay\"") || JSON.stringify(writes).includes("pay")) ;
    return { first, count: Math.max(count, 1) };
  };

  it("refuses when the program's settings changed since it started, and runs nothing", async () => {
    const { first } = await inFlight();
    const header = first.commits.findIndex((writes) => JSON.stringify(writes).includes(FABRIC_DURABLE_ENGINE)) + 1;
    const after = await recover(PROGRAM, first.commits, header, { timeoutMs: 19_000 });
    expect(after.result).toMatchObject({ called: true, isError: true });
    expect(after.result.text).toBe("fabric_exec could not resume after an interruption: the program, its payloads, or its settings changed since it started. The program did not run again.");
    expect(after.effects).toEqual([]);
  });

  it("refuses a journal another engine or format wrote, and runs nothing", async () => {
    const { first } = await inFlight();
    const header = first.commits.findIndex((writes) => JSON.stringify(writes).includes(FABRIC_DURABLE_ENGINE)) + 1;
    const upgraded = await recover(PROGRAM, first.commits, header, {}, (json) => json.replaceAll(FABRIC_DURABLE_ENGINE, "pi-fabric.durable-journal.v1/pi-fabric@0.1.0/quickjs-old"));
    expect(upgraded.result.text).toBe("fabric_exec could not resume after an interruption: Fabric's program engine changed since the program started. The program did not run again.");
    expect(upgraded.effects).toEqual([]);
    const format = await recover(PROGRAM, first.commits, header, {}, (json) => json.replaceAll("\"pi-fabric.durable-journal.v1\"", "\"pi-fabric.durable-journal.v0\""));
    expect(format.result.text).toBe("fabric_exec could not resume after an interruption: its journal was written in format pi-fabric.durable-journal.v0, which this Fabric cannot replay. The program did not run again.");
    expect(format.effects).toEqual([]);
  });

  it("stops at a recorded call the program does not repeat, before anything after it runs", async () => {
    const first = await start(PROGRAM);
    // Every commit up to and including the two first reads' completions.
    const reads = first.commits.findIndex((writes) => (JSON.stringify(writes).match(/\"d\":\"[0-9a-f]{64}\"/g) ?? []).length > 0 && JSON.stringify(writes).includes("read:b")) + 1;
    expect(reads).toBeGreaterThan(0);
    // Tamper the first recorded completion's argument digest: the program's first call no longer matches it.
    let tampered = false;
    const after = await recover(PROGRAM, first.commits, reads, {}, (json) => json.replace(/\"d\":\"[0-9a-f]{64}\"/, () => { tampered = true; return `"d":"${"0".repeat(64)}"`; }));
    expect(tampered).toBe(true);
    expect(after.result).toMatchObject({ called: true, isError: true });
    expect(after.result.text).toContain("fabric_exec could not resume after an interruption: the program did not repeat its recorded");
    expect(after.result.text).toContain("No call after the divergence ran.");
    expect(after.effects.filter((line) => EFFECT.test(line))).toEqual([]);
  });

  it("names the engine after this package's version and its QuickJS build", () => {
    const require = createRequire(import.meta.url);
    const own = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string };
    const quickjs = (require("@jitl/quickjs-singlefile-mjs-release-sync/package.json") as { version: string }).version.split(".").slice(0, 2).join(".");
    expect(FABRIC_DURABLE_ENGINE).toBe(`pi-fabric.durable-journal.v1/pi-fabric@${own.version}/quickjs-singlefile-${quickjs}`);
  });
});

/** A seeded generator, so a failing fuzz case can be rerun. */
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** A random program of reads, effects, timers, parallel groups, provider calls and nondeterministic values. */
const randomProgram = (random: () => number): string => {
  const lines = ["const out = [];"];
  const steps = 3 + Math.floor(random() * 5);
  for (let step = 0; step < steps; step++) {
    const id = `s${step}`;
    const pick = random();
    if (pick < 0.25) lines.push(`out.push(await tools.read({ q: "${id}" }));`);
    else if (pick < 0.4) lines.push(`out.push(await tools.pay({ q: "${id}" + out.length }));`);
    else if (pick < 0.55) lines.push(`out.push(...(await Promise.all([tools.read({ q: "${id}a" }), tools.read({ q: "${id}b" }), notes.peek({ text: "${id}" })])));`);
    else if (pick < 0.65) lines.push(`await new Promise((resolve) => setTimeout(resolve, ${1 + Math.floor(random() * 3)}));`);
    else if (pick < 0.75) lines.push(`out.push((await notes.add({ text: "${id}" })).id);`);
    else if (pick < 0.85) lines.push(`out.push(Math.random() < 2 ? "r" + Math.floor(Math.random() * 1e6) : "");`);
    else lines.push(`if (out.length % 2) out.push(await tools.read({ q: "odd${id}" })); else out.push(await tools.read({ q: "even${id}" }));`);
  }
  lines.push("return out;");
  return lines.join("\n");
};

describe("replay-safe fabric_exec: randomised replay", () => {
  it("keeps every invariant for random programs crashed at random commits", async () => {
    const seed = Number(process.env.FABRIC_REPLAY_FUZZ_SEED ?? 20261027);
    const random = prng(seed);
    const kinds = new Map<string, number>();
    for (let index = 0; index < 12; index++) {
      const code = randomProgram(random);
      const first = await start(code);
      expect(first.result.isError, `${code}\n${first.result.text}`).toBe(false);
      const header = first.commits.findIndex((writes) => JSON.stringify(writes).includes(FABRIC_DURABLE_ENGINE)) + 1;
      for (let sample = 0; sample < 4; sample++) {
        const count = Math.floor(random() * (first.commits.length + 1));
        const after = await recover(code, first.commits, count);
        const label = `seed ${seed} program ${index} crash after commit ${count}/${first.commits.length}\n${code}`;
        const kind = checkCrash(code, first.result, effectsBefore(first.timeline, count), after, label, (text) => {
          const values = JSON.parse(text) as unknown[];
          return count >= header ? values : values.map((value) => (typeof value === "string" && value.startsWith("r") && !value.startsWith("read") ? "r*" : value));
        });
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      }
    }
    expect(kinds.get("completed") ?? 0).toBeGreaterThan(10);
  }, 240_000);
});
