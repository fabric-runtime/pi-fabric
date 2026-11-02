// Replay-safe fabric_exec on programs a host's model writes: parallel knowledge searches, a loop over
// alerts, reads then one write, an effect in flight, a timer, polling with backoff, a classifier
// action, and a partial failure. Each one is crashed after every storage commit of a full run and
// recovered by a fresh Harness, as in tests/durable-extension-replay.test.ts. The tools are stubs:
// reads are replay-safe, writes replay-unsafe, and the poll stub answers by how often it was called.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, type Storage, type StorageWrite } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createFabricExtension, FABRIC_DURABLE_ENGINE, type FabricDurableProvider } from "../src/durable-extension.js";

const MODEL = { provider: "test", modelId: "scripted" } as const;
const MAYBE_RAN = "fabric_exec was interrupted during this call, which may have run:";
const ALERTS = [{ id: "a1", severity: "high", title: "Credential stuffing" }, { id: "a2", severity: "low", title: "Port scan" }, { id: "a3", severity: "high", title: "Phishing" }];

/** A stub tool. `calls` counts this tool's calls in the world so far, including those before a crash. */
interface Stub {
  readonly name: string;
  readonly effect?: boolean;
  readonly run: (args: Record<string, unknown>, calls: number) => string;
}

interface UseCase {
  readonly id: string;
  readonly program: string;
  readonly tools: readonly Stub[];
  readonly providers?: (log: (line: string) => void) => Record<string, FabricDurableProvider>;
  /** The result of an uninterrupted run. */
  readonly expected: unknown;
  /** True when some crash point must leave a write in flight, which stops the program. */
  readonly stops?: boolean;
  /**
   * For a program whose reads see a world that moves on (a poll): a read cut off by the crash is rerun and may see
   * a later state, so a resume may finish sooner. It must still follow the same path: `delays` is a prefix.
   */
  readonly worldMoves?: boolean;
}

const search: Stub = { name: "search_knowledge", run: (args) => {
  if (args.query === "bad") throw new Error("search_knowledge failed with status 502");
  return JSON.stringify({ shared: [{ ref: "s1", title: `Result: ${String(args.query)}` }], private: [] });
} };
const listAlerts: Stub = { name: "list_alerts", run: () => JSON.stringify(ALERTS) };
const hit = (query: string) => JSON.stringify({ shared: [{ ref: "s1", title: `Result: ${query}` }], private: [] });

const USE_CASES: readonly UseCase[] = [
  {
    id: "parallel knowledge searches",
    program: `const topics = ["phishing", "ransomware", "credential stuffing"];
const res = await Promise.all(topics.map((q) => tools.search_knowledge({ query: q })));
return topics.map((t, i) => ({ topic: t, hits: res[i] }));`,
    tools: [search],
    expected: ["phishing", "ransomware", "credential stuffing"].map((topic) => ({ topic, hits: hit(topic) })),
  },
  {
    id: "a loop that searches each high alert in turn",
    program: `const alerts = JSON.parse(await tools.list_alerts({}));
const out = [];
for (const a of alerts.filter((a) => a.severity === "high")) {
  const hits = await tools.search_knowledge({ query: a.title });
  out.push({ alert: a.id, hits });
}
return out;`,
    tools: [listAlerts, search],
    expected: [{ alert: "a1", hits: hit("Credential stuffing") }, { alert: "a3", hits: hit("Phishing") }],
  },
  {
    id: "two reads, then one incident note",
    program: `const [alerts, g] = await Promise.all([tools.list_alerts({}), tools.search_knowledge({ query: "incident response" })]);
return await tools.create_incident_note({ title: "Weekly summary", body: alerts + "\\n" + g });`,
    tools: [listAlerts, search, { name: "create_incident_note", effect: true, run: () => JSON.stringify({ id: "note-1" }) }],
    expected: { id: "note-1" },
    stops: true,
  },
  {
    id: "a notification in flight",
    program: `return await tools.send_notification({ channel: "soc", text: "High alert a1" });`,
    tools: [{ name: "send_notification", effect: true, run: () => JSON.stringify({ sent: true }) }],
    expected: { sent: true },
    stops: true,
  },
  {
    id: "a finished write before a read",
    program: `const n = await tools.create_incident_note({ title: "Triage", body: "started" });
const a = await tools.list_alerts({});
return { note: JSON.parse(n), alerts: JSON.parse(a).length };`,
    tools: [{ name: "create_incident_note", effect: true, run: () => JSON.stringify({ id: "note-1" }) }, listAlerts],
    expected: { note: { id: "note-1" }, alerts: 3 },
    stops: true,
  },
  {
    id: "a timer between two reads",
    program: `const t0 = Date.now();
const first = JSON.parse(await tools.list_alerts({}));
await new Promise((r) => setTimeout(r, 20));
const second = JSON.parse(await tools.list_alerts({}));
return { new: second.length - first.length, waited: Date.now() - t0 >= 20, startedAt: t0 };`,
    tools: [listAlerts],
    // startedAt is the journal's pinned clock: a resume must give the same value.
    expected: undefined,
  },
  {
    id: "polling a scan with backoff",
    program: `const { jobId } = JSON.parse(await tools.start_scan({ target: "example.org" }));
let s;
const delays = [];
for (let i = 0; i < 10; i++) {
  s = JSON.parse(await tools.scan_status({ jobId }));
  if (s.state === "done") break;
  // Backoff with jitter: a resume must draw the same Math.random() values.
  const delay = 2 * 2 ** i + Math.floor(Math.random() * 5);
  delays.push(delay);
  await new Promise((r) => setTimeout(r, delay));
}
return { ...s, delays };`,
    tools: [
      { name: "start_scan", effect: true, run: () => JSON.stringify({ jobId: "j1" }) },
      { name: "scan_status", run: (_args, calls) => JSON.stringify(calls < 2 ? { state: "running" } : { state: "done", findings: 2 }) },
    ],
    expected: { state: "done", findings: 2 },
    stops: true,
    worldMoves: true,
  },
  {
    id: "a classifier action per alert",
    program: `const alerts = JSON.parse(await tools.list_alerts({}));
const out = [];
for (const a of alerts) {
  const r = await triage.classify({ state: a.title, question: "Is this urgent?" });
  out.push({ id: a.id, urgent: r.probability > 0.5 });
}
return out;`,
    tools: [listAlerts],
    providers: (log) => ({ triage: { actions: {
      // A paid model call: an effect, so an interrupted one is reported rather than paid for twice.
      classify: async (args) => { log(`triage.classify ${String(args.state)}`); return { probability: String(args.state) === "Port scan" ? 0.2 : 0.9 }; },
    } } }),
    expected: [{ id: "a1", urgent: true }, { id: "a2", urgent: false }, { id: "a3", urgent: true }],
    stops: true,
  },
  {
    id: "allSettled with one failing search",
    program: `const qs = ["phishing", "bad", "malware"];
const r = await Promise.allSettled(qs.map((q) => tools.search_knowledge({ query: q })));
return r.map((x, i) => ({ q: qs[i], ok: x.status === "fulfilled", err: x.status === "rejected" ? String(x.reason.message) : undefined }));`,
    tools: [search],
    expected: [{ q: "phishing", ok: true }, { q: "bad", ok: false, err: "search_knowledge failed with status 502" }, { q: "malware", ok: true }],
  },
];

type Event = { commit: number } | { call: string };

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

/** One host running `useCase` once. `prior` holds the calls made before a crash, so stateful stubs carry on. */
const openRun = async (useCase: UseCase, storage: Storage, log: (line: string) => void, prior: readonly string[] = []) => {
  const models = createModels();
  const faux = fauxProvider({ provider: "test", models: [{ id: "scripted" }] });
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 20 }, () => (context: { messages: Message[] }) =>
    context.messages.at(-1)?.role === "toolResult"
      ? fauxAssistantMessage(fauxText("done"))
      : fauxAssistantMessage(fauxToolCall("fabric_exec", { code: useCase.program }, { id: "call_1" }), { stopReason: "toolUse" })));
  const counts = new Map<string, number>();
  for (const line of prior) counts.set(line.split(" ")[0]!, (counts.get(line.split(" ")[0]!) ?? 0) + 1);
  const registry = createRegistry();
  registry.install(defineExtension({
    name: "host-tools",
    tools: useCase.tools.map((stub) => defineTool({
      name: stub.name, description: stub.name, replay: stub.effect ? "unsafe" : "safe",
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async (args: Record<string, unknown>) => {
        const calls = counts.get(stub.name) ?? 0;
        counts.set(stub.name, calls + 1);
        log(`${stub.name} ${JSON.stringify(args)}`);
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { output: [{ type: "text", text: stub.run(args, calls) }] };
      },
    })),
  }));
  registry.install(createFabricExtension({ timeoutMs: 20_000, ...(useCase.providers ? { providers: useCase.providers(log) } : {}) }));
  return { harness: await Harness.open(storage, { models, registry }, ctx), storage };
};

const outcome = async (run: { harness: Harness; storage: Storage }) => {
  await run.harness.waitForIdle(ctx);
  for (const conversation of (await run.storage.scanConversations({}, 10, undefined, ctx)).items) {
    for (const entry of (await run.storage.scanEntries({ conversationId: conversation.id }, 500, undefined, ctx)).items) {
      for (const message of entry.model ?? []) {
        if (message.role === "toolResult" && message.toolCallId === "call_1") {
          return { called: true, isError: message.isError === true, text: message.content.map((item) => (item.type === "text" ? item.text : "")).join("\n") };
        }
      }
    }
  }
  return { called: false, isError: false, text: "" };
};

const effectNames = (useCase: UseCase) => new Set([...useCase.tools.filter((stub) => stub.effect).map((stub) => stub.name), "triage.classify"]);

describe("replay-safe fabric_exec on host programs, crashed after every commit", () => {
  for (const useCase of USE_CASES) {
    it(useCase.id, async () => {
      const timeline: Event[] = [];
      const commits: StorageWrite[][] = [];
      const first = await openRun(useCase, recording(timeline, commits), (line) => timeline.push({ call: line }));
      const conversation = await first.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MODEL } }, ctx);
      await (await conversation.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      const original = await outcome(first);
      await first.harness.close(ctx);
      expect(original.isError, original.text).toBe(false);
      const value = JSON.parse(original.text) as unknown;
      if (useCase.expected !== undefined) expect(value).toMatchObject(useCase.expected as object);
      else expect(value).toMatchObject({ new: 0, waited: true });
      const header = commits.findIndex((writes) => JSON.stringify(writes).includes(FABRIC_DURABLE_ENGINE)) + 1;
      expect(header).toBeGreaterThan(0);
      const firstResult = commits.findIndex((writes, index) => index >= header && /"c":0[,}]/.test(JSON.stringify(writes))) + 1;
      expect(firstResult).toBeGreaterThan(header);
      const effects = effectNames(useCase);
      const originalCount = (name: string) => timeline.filter((event) => "call" in event && event.call.startsWith(`${name} `)).length;
      const kinds = new Set<string>();
      for (let count = 0; count <= commits.length; count++) {
        const label = `${useCase.id}: crash after commit ${count}/${commits.length}`;
        const before: string[] = [];
        for (const event of timeline) {
          if ("commit" in event && event.commit > count) break;
          if ("call" in event) before.push(event.call);
        }
        const storage = new MemoryStorage();
        for (const writes of commits.slice(0, count)) await commitWrites(storage, writes, ctx);
        const after: string[] = [];
        const run = await openRun(useCase, storage, (line) => after.push(line), before);
        let result;
        try { result = await outcome(run); } finally { await run.harness.close(ctx); }
        // No write ran twice: the same write line never appears twice across the crash.
        const writes = [...before, ...after].filter((line) => effects.has(line.split(" ")[0]!));
        expect(new Set(writes).size, `${label}: ${writes.join(", ")}`).toBe(writes.length);
        if (!result.called) {
          expect(writes, label).toEqual([]);
          kinds.add("none");
        } else if (!result.isError) {
          // A resume returns what the uninterrupted run returned, every write done exactly once.
          // The guest clock is the time of the latest result it got, so once the first result is stored a resume
          // reads the same Date.now() and Math.random() as the original run.
          const resumed = JSON.parse(result.text) as { delays?: number[] };
          if (count >= firstResult && useCase.worldMoves) {
            const original = value as { delays: number[] };
            expect(resumed, label).toMatchObject(useCase.expected as object);
            expect(original.delays.slice(0, resumed.delays?.length ?? -1), label).toEqual(resumed.delays);
          } else if (count >= firstResult) expect(resumed, label).toEqual(value);
          else if (useCase.expected !== undefined) expect(JSON.parse(result.text), label).toMatchObject(useCase.expected as object);
          for (const name of effects) {
            expect(writes.filter((line) => line.startsWith(`${name} `)).length, `${label}: ${name}`).toBe(originalCount(name));
          }
          kinds.add("completed");
        } else {
          expect(result.text, label).toContain(MAYBE_RAN);
          expect(result.text).toContain("Check whether it took effect, or ask the user");
          kinds.add("stopped");
        }
      }
      expect(kinds.has("completed"), useCase.id).toBe(true);
      expect(kinds.has("stopped"), useCase.id).toBe(useCase.stops === true);
    }, 120_000);
  }
});
