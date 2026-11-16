import { describe, expect, it } from "vitest";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/pi-ai";
import { FabricExecutionTraceRecorder } from "../src/audit/trace.js";
import { compileFabricSummary } from "../src/compaction/hook.js";
import { normalizeEntries } from "../src/compaction/normalize.js";
import { qaReport } from "../src/compaction/qa.js";
import { latestRequestLine, userActivity } from "../src/compaction/user-activity.js";

// A replay of a failed long-running session's shape: one original objective,
// a long autonomous stretch woken by background deliveries, failures that are
// never retried byte-for-byte, and Fabric's own setup calls in every run.

const usage = {
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let clock = Date.parse("2026-11-15T00:00:00.000Z");
const at = (): string => new Date(clock += 60_000).toISOString();
let parent: string | null = null;
const link = <T extends SessionEntry>(entry: T): T => {
  parent = entry.id;
  return entry;
};

const message = (id: string, msg: SessionMessageEntry["message"]): SessionMessageEntry =>
  link({ type: "message", id, parentId: parent, timestamp: at(), message: msg });
const user = (id: string, text: string) => message(id, { role: "user", content: text, timestamp: 1 });
const assistant = (id: string, text: string) => message(id, {
  role: "assistant", content: [{ type: "text", text }], api: "anthropic", provider: "anthropic", model: "test",
  usage, stopReason: "stop", timestamp: 2,
});
const custom = (id: string, customType: string, content: string, display: boolean, details: unknown): SessionEntry =>
  link({ type: "custom_message", id, parentId: parent, timestamp: at(), customType, content, display, details } as SessionEntry);
const marker = (id: string, firstKeptEntryId: string): SessionEntry =>
  link({ type: "compaction", id, parentId: parent, timestamp: at(), summary: "earlier summary", firstKeptEntryId, tokensBefore: 1000 } as SessionEntry);

/** One fabric_exec run: Fabric's setup calls, then a failing grep with a unique pattern. */
const failingRun = (n: number): SessionEntry[] => {
  const recorder = new FabricExecutionTraceRecorder();
  recorder.issueCall("fabric.discovery.compatibility", {}).succeed({ ok: true });
  recorder.issueCall("native.load", {}).succeed({});
  recorder.issueCall("pi.grep", { pattern: `diagnostic-${n}(`, path: "scripts" }).fail("invoke", new Error(`regex parse error ${n}`));
  const trace = recorder.seal("failed", []);
  const callId = `call-${n}`;
  return [
    message(`a${n}`, {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "fabric_exec", arguments: { code: `run(${n})`, display: { name: `Diagnose validation ${n}` } } }],
      api: "anthropic", provider: "anthropic", model: "test", usage, stopReason: "toolUse", timestamp: 2,
    }),
    message(`r${n}`, {
      role: "toolResult", toolCallId: callId, toolName: "fabric_exec",
      content: [{ type: "text", text: `{"ok":true,"output":"Successfully wrote 112 bytes"}\n\nRuntime error: regex parse error ${n}` }],
      details: { trace, error: `regex parse error ${n}` } as unknown as JsonValue,
      isError: true, timestamp: 3,
    }),
  ];
};

/** A plain read tool failure on a unique path, outside any fabric_exec run. */
const readFailure = (n: number): SessionEntry[] => {
  const callId = `read-${n}`;
  return [
    message(`ra${n}`, {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: `missing-${n}.ts` } }],
      api: "anthropic", provider: "anthropic", model: "test", usage, stopReason: "toolUse", timestamp: 2,
    }),
    message(`rr${n}`, {
      role: "toolResult", toolCallId: callId, toolName: "read",
      content: [{ type: "text", text: `ENOENT ${n}` }], isError: true, timestamp: 3,
    }),
  ];
};

const objective = "Help me update all 62 templates.\nKeep the publication gates intact.\nAdd https://github.com/example/lotion to the list.";

const session = (): SessionEntry[] => {
  clock = Date.parse("2026-11-15T00:00:00.000Z");
  parent = null;
  const entries: SessionEntry[] = [user("u1", objective)];
  for (let n = 0; n < 4; n++) entries.push(...failingRun(n));
  entries.push(assistant("p1", "We need to promote the validation fixes into maintained tooling first."));
  entries.push(user("u2", "Proceed on."));
  entries.push(custom("s1", "queue-steer:user", "How much do we have left?", true, { version: 1, source: "user" }));
  for (let n = 4; n < 8; n++) entries.push(...failingRun(n));
  entries.push(marker("c1", "r7"));
  for (let n = 8; n < 40; n++) {
    entries.push(...failingRun(n));
    entries.push(custom(`bg${n}`, "pi-fabric-agent-complete", `Agent diag-${n} completed.`, false, { ids: [`x${n}`] }));
  }
  entries.push(assistant("p2", "Next: finish the raw-stream protocol tooling."));
  entries.push(user("tail", "Keep going."));
  return entries;
};

const compile = (entries: SessionEntry[]) => {
  const result = compileFabricSummary(entries, 100_000);
  if (!("compaction" in result)) throw new Error(result.reason);
  return result.compaction;
};

describe("context salience in compaction summaries", () => {
  it("leads with user activity and every earlier user message verbatim", () => {
    const { summary, details } = compile(session());
    expect(summary.startsWith("[User activity]\nLatest user message: entry tail")).toBe(true);
    const earlier = summary.indexOf("[Earlier user messages]");
    const recent = summary.indexOf("[Recent user directions and discussion]");
    expect(earlier).toBeGreaterThan(0);
    expect(earlier).toBeLessThan(recent);
    // The whole multi-line objective survives, not a first-line sample.
    expect(summary.slice(earlier, recent)).toContain(`User [entry u1]:\n${objective}`);
    expect(details!.sections.slice(0, 3)).toEqual(["[User activity]", "[Earlier user messages]", "[Recent user directions and discussion]"]);
  });

  it("counts staleness from the user, never from background deliveries", () => {
    const entries = session().slice(0, -2); // drop the final proposal and user reply
    const activity = userActivity(entries)!;
    expect(activity.anchor.entryId).toBe("s1");
    expect(activity.compactions).toBe(1);
    expect(activity.background).toBe(32);
    const { summary } = compile(entries);
    expect(summary).toContain("Latest user message: entry s1");
    expect(summary).toContain("1 earlier compaction, 32 background deliveries.");
    // A steering message is the user's own words, and stays the last request.
    expect(summary).toContain("Last request: How much do we have left? [entry s1]");
    expect(summary).toMatch(/Later context: custom "pi-fabric-agent-complete"/);
  });

  it("labels assistant replies as proposals", () => {
    const { summary } = compile(session());
    expect(summary).toContain("Assistant response (a proposal, not a verified outcome or user instruction) [entry p2]");
    expect(summary).not.toContain("Historical assistant response");
  });

  it("itemizes fresh failures first, with typed run errors, and addresses the rest", () => {
    const { summary } = compile(session());
    const outstanding = summary.slice(summary.indexOf("[Outstanding Context]"), summary.indexOf("[Earlier Turns]"));
    // Each failed run is two records: the traced operation and the run's typed error.
    expect(outstanding).toContain("- pi.grep scripts: Call failed during invoke [entry r39/2]");
    expect(outstanding).toContain("- fabric_exec: regex parse error 39 [entry a39]");
    // The newest 24 fresh records are itemized; older fresh ones keep one address range.
    expect(outstanding).toContain("… omitted 40 older open error records; source entries a8 → r27/2");
    // Fresh failures used every slot, so failures before the marker stay one addressed count.
    expect(outstanding).toContain("… omitted 16 open error records already itemized by an earlier compaction; source entries a0 → r7/2");
    expect(outstanding).not.toContain("regex parse error 7 ");
    // Program output is never quoted as an error, and resolved failures are not itemized.
    expect(outstanding).not.toContain("Successfully wrote");
    expect(outstanding).not.toContain("[RESOLVED]");
  });

  it("lets failures from an earlier window fill room that fresh ones leave", () => {
    clock = Date.parse("2026-11-15T00:00:00.000Z");
    parent = null;
    const entries: SessionEntry[] = [user("u1", objective)];
    for (let n = 0; n < 3; n++) entries.push(...readFailure(n));
    entries.push(marker("c1", `rr${2}`));
    entries.push(user("u2", "Continue."));
    for (let n = 3; n < 5; n++) entries.push(...readFailure(n));
    entries.push(user("tail", "Keep going."));
    const { summary } = compile(entries);
    for (let n = 0; n < 5; n++) expect(summary).toContain(`- read missing-${n}.ts: ENOENT ${n} [entry ra${n}]`);
    expect(summary).not.toContain("already itemized by an earlier compaction");
  });

  it("drops Fabric's routine setup calls from every view", () => {
    const { summary } = compile(session());
    expect(summary).not.toContain("native.load");
    expect(summary).not.toContain("fabric.discovery.compatibility");
    expect(summary).toContain("Diagnose validation 39 → failed");
  });

  it("passes reconstruction QA with the same freshness view", () => {
    clock = Date.parse("2026-11-15T00:00:00.000Z");
    parent = null;
    const entries: SessionEntry[] = [user("u1", objective)];
    for (let n = 0; n < 10; n++) entries.push(...readFailure(n));
    entries.push(marker("c1", "rr9"));
    entries.push(user("u2", "Continue."));
    for (let n = 10; n < 40; n++) entries.push(...readFailure(n));
    entries.push(user("tail", "Keep going."));
    const { summary, firstKeptEntryId } = compile(entries);
    expect(summary).toContain("… omitted 6 older open error records; source entries ra10 → ra15");
    expect(summary).toContain("… omitted 10 open error records already itemized by an earlier compaction; source entries ra0 → ra9");
    const keptIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
    const prefix = entries.slice(0, keptIndex >= 0 ? keptIndex : entries.length);
    const events = normalizeEntries(prefix);
    const markerIndex = entries.findIndex((entry) => entry.id === "c1");
    const freshEntryIds = new Set(entries.slice(markerIndex + 1).map((entry) => entry.id));
    const report = qaReport([...events, ...normalizeEntries(entries.slice(prefix.length))], events.length, summary, { freshEntryIds });
    expect(report.failures).toEqual([]);
  });

  it("names the user's latest request for background deliveries", () => {
    const entries = session();
    expect(latestRequestLine({ sessionManager: { getBranch: () => entries } }))
      .toMatch(/^The user's latest request \[entry tail, 2026-11-15T[\d:.]+Z\]: "Keep going\."$/);
    expect(latestRequestLine({ sessionManager: { getBranch: () => { throw new Error("closed"); } } })).toBeUndefined();
    expect(latestRequestLine({})).toBeUndefined();
  });
});
