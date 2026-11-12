import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assistantText,
  assistantToolCall,
  bashExecution,
  messageEntry,
  sessionHeader,
  toolResult,
  userMessage,
  writeSessionFile,
  type FixtureEntry,
} from "./fixtures/memory.js";
import { normalizeSession, extractFullText, expandSessionEntry } from "../src/memory/normalize.js";
import { encodeCwdDir, resolveScope, enumerateAllSessions } from "../src/memory/discovery.js";
import { bm25Score, loadShard, loadShards, recentEntries } from "../src/memory/index.js";
import { searchShards } from "../src/memory/search.js";
import { MemoryProvider } from "../src/providers/memory-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import type { FabricMemoryConfig } from "../src/config.js";
import { RECALL_MAX_RESPONSE_CHARS } from "../src/memory/context.js";

const tempDirs: string[] = [];

const makeTempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fabric-memory-${prefix}-`));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const buildSession = (cwd: string, id: string): { entries: FixtureEntry[]; push: (e: FixtureEntry) => void } => {
  const entries: FixtureEntry[] = [sessionHeader(id, cwd)];
  let parent: string | null = null;
  let counter = 0;
  const push = (entry: FixtureEntry) => {
    entries.push(entry);
    parent = entry.id;
    void counter++;
  };
  void parent;
  return { entries, push };
};

const ts = (n: number): string => new Date(1_700_000_000_000 + n * 1_000).toISOString();

const sessionId = (file: string): string => file;

const msg = (
  id: string,
  parentId: string | null,
  timestamp: string,
  message: Record<string, unknown>,
): FixtureEntry => ({ type: "message", id, parentId, timestamp, message });

const makeMemoryConfig = (indexDir: string): FabricMemoryConfig => ({
  enabled: true,
  indexDir,
  maxSessions: 500,
  maxEntryChars: 2_000,
  indexThinking: false,
  indexToolOutput: true,
});

const invocationContext = (cwd: string): FabricInvocationContext => ({
  cwd,
  signal: undefined,
  parentToolCallId: "test",
  nestedToolCallId: "nested",
  extensionContext: {} as FabricInvocationContext["extensionContext"],
  update() {},
});

describe("memory normalize", () => {
  let agentDir: string;
  let indexDir: string;

  beforeEach(() => {
    agentDir = makeTempDir("agent");
    indexDir = makeTempDir("index");
  });

  it("extracts typed entries from a session JSONL", () => {
    const cwd = "/home/user/project";
    const file = writeSessionFile(
      path.join(agentDir, "sessions", encodeCwdDir(cwd)),
      "1_session-a.jsonl",
      [
        sessionHeader("a", cwd),
        msg("e1", null, ts(0), userMessage("fix the auth bug")),
        msg("e2", "e1", ts(1), assistantText("I will inspect the auth module.")),
        msg("e3", "e2", ts(2), assistantToolCall("c1", "read", { path: "src/auth.ts" })),
        msg("e4", "e3", ts(3), toolResult("c1", "read", "export function auth() {}")),
        msg("e5", "e4", ts(4), bashExecution("pnpm test", "all tests passed", 0)),
        msg("e6", "e5", ts(5), toolResult("c2", "bash", "command failed", true)),
      ],
    );
    const { entries, header } = normalizeSession(file, 2_000);
    expect(header?.sessionId).toBe("a");
    expect(header?.cwd).toBe(cwd);
    expect(entries.map((e) => e.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "toolResult",
      "bashExecution",
      "toolResult",
    ]);
    expect(entries.map((e) => e.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(entries[2]!.toolName).toBe("read");
    expect(entries[2]!.text).toContain("Tool: read(");
    expect(entries[3]!.toolName).toBe("read");
    expect(entries[3]!.text).toContain("toolResult(read):");
    expect(entries[4]!.role).toBe("bashExecution");
    expect(entries[4]!.text).toContain("bash$ pnpm test");
    expect(entries[4]!.text).toContain("all tests passed");
    expect(entries[5]!.isError).toBe(true);
    expect(entries.map((e) => e.sessionId)).toEqual(Array(6).fill("a"));
  });

  it("truncates long text but expand returns the full text", () => {
    const cwd = "/home/user/long";
    const longText = "x".repeat(3_000);
    const file = writeSessionFile(
      path.join(agentDir, "sessions", encodeCwdDir(cwd)),
      "1_long.jsonl",
      [
        sessionHeader("long", cwd),
        msg("e1", null, ts(0), userMessage(longText)),
      ],
    );
    const { entries } = normalizeSession(file, 100);
    expect(entries[0]!.text.length).toBe(100);
    expect(entries[0]!.truncated).toBe(true);
    const full = expandSessionEntry(file, 0);
    expect(full).toBe(longText);
  });

  it("skips structural-only entries (model_change, label, custom)", () => {
    const cwd = "/home/user/skip";
    const file = writeSessionFile(
      path.join(agentDir, "sessions", encodeCwdDir(cwd)),
      "1_skip.jsonl",
      [
        sessionHeader("skip", cwd),
        msg("e1", null, ts(0), userMessage("hello")),
        { type: "model_change", id: "m1", parentId: "e1", timestamp: ts(1), provider: "anthropic", modelId: "x" },
        { type: "label", id: "l1", parentId: "m1", timestamp: ts(2), targetId: "e1", label: "checkpoint" },
        msg("e2", "e1", ts(3), assistantText("hi")),
        { type: "custom", id: "c1", parentId: "e2", timestamp: ts(4), customType: "ext", data: { x: 1 } },
      ],
    );
    const { entries } = normalizeSession(file, 2_000);
    expect(entries.map((e) => e.role)).toEqual(["user", "assistant"]);
    expect(entries.map((e) => e.index)).toEqual([0, 1]);
  });

  it("excludes thinking by default and includes it only when configured", () => {
    const raw = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning here" },
          { type: "text", text: "response" },
          { type: "toolCall", id: "c1", name: "grep", arguments: { pattern: "TODO" } },
        ],
      },
    };
    const defaultText = extractFullText(raw);
    expect(defaultText).not.toContain("reasoning here");
    expect(defaultText).toContain("response");
    expect(defaultText).toContain("Tool: grep(");
    expect(extractFullText(raw, { indexThinking: true })).toContain("reasoning here");
  });
});

describe("memory discovery", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = makeTempDir("agent");
  });

  const seed = (cwd: string, name: string, id: string): string => {
    // mtime ordering: write with small delays via utimes
    const file = writeSessionFile(
      path.join(agentDir, "sessions", encodeCwdDir(cwd)),
      name,
      [sessionHeader(id, cwd), msg("e1", null, ts(0), userMessage(`session ${id}`))],
    );
    return file;
  };

  it("encodeCwdDir matches pi's encoding shape", () => {
    const cwd = path.resolve(path.sep, "home", "user", "project");
    const encoded = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
    expect(encodeCwdDir(cwd)).toBe(`--${encoded}--`);
  });

  it("project scope lists all sessions for the cwd dir", () => {
    const cwd = "/home/user/proj-a";
    seed(cwd, "1_a.jsonl", "a");
    seed(cwd, "2_b.jsonl", "b");
    const refs = resolveScope({
      agentDir,
      cwd,
      scope: "project",
      maxSessions: 500,
    });
    expect(refs.map((r) => r.id).sort()).toEqual(["a", "b"]);
    for (const ref of refs) {
      expect(ref.cwd).toBe(cwd);
    }
  });

  it("global scope lists sessions across all cwd dirs, newest first", () => {
    const cwdA = "/home/user/g-a";
    const cwdB = "/home/user/g-b";
    const fileA = seed(cwdA, "1_a.jsonl", "a");
    const fileB = seed(cwdB, "1_b.jsonl", "b");
    // make fileB newer than fileA
    const older = Date.now() / 1_000 - 60;
    const newer = Date.now() / 1_000;
    fs.utimesSync(fileA, older, older);
    fs.utimesSync(fileB, newer, newer);
    const refs = enumerateAllSessions(agentDir, 500);
    expect(refs.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("global scope respects maxSessions bound", () => {
    seed("/home/user/c1", "1_x.jsonl", "x");
    seed("/home/user/c2", "1_y.jsonl", "y");
    seed("/home/user/c3", "1_z.jsonl", "z");
    const refs = enumerateAllSessions(agentDir, 2);
    expect(refs.length).toBe(2);
  });

  it("session:<id> resolves a specific session by id", () => {
    const cwd = "/home/user/spec";
    seed(cwd, "1_target.jsonl", "target-id");
    const refs = resolveScope({ agentDir, cwd, scope: "session:target-id", maxSessions: 500 });
    expect(refs.length).toBe(1);
    expect(refs[0]!.id).toBe("target-id");
  });

  it("session:<path> resolves a specific session by file path", () => {
    const cwd = "/home/user/specpath";
    const file = seed(cwd, "1_p.jsonl", "p");
    const refs = resolveScope({ agentDir, cwd, scope: `session:${file}`, maxSessions: 500 });
    expect(refs.length).toBe(1);
    expect(refs[0]!.file).toBe(file);
  });

  it("session scope defaults to newest session for cwd when no sessionFile", () => {
    const cwd = "/home/user/def";
    const fileA = seed(cwd, "1_a.jsonl", "a");
    const fileB = seed(cwd, "2_b.jsonl", "b");
    fs.utimesSync(fileA, Date.now() / 1_000 - 10, Date.now() / 1_000 - 10);
    fs.utimesSync(fileB, Date.now() / 1_000, Date.now() / 1_000);
    const refs = resolveScope({ agentDir, cwd, scope: "session", maxSessions: 500 });
    expect(refs.length).toBe(1);
    expect(refs[0]!.id).toBe("b");
  });
});

describe("memory shard index", () => {
  let agentDir: string;
  let indexDir: string;

  beforeEach(() => {
    agentDir = makeTempDir("agent");
    indexDir = makeTempDir("index");
  });

  const seedSession = (cwd: string, name: string, id: string, messages: FixtureEntry[]): string =>
    writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), name, [
      sessionHeader(id, cwd),
      ...messages,
    ]);

  it("persists a shard and reuses it when mtime + size are unchanged", () => {
    const file = seedSession("/home/user/cache", "1.jsonl", "c", [
      msg("e1", null, ts(0), userMessage("index me please")),
    ]);
    const options = { indexDir, maxEntryChars: 2_000 };
    const ref = { id: "c", file, cwd: "/home/user/cache", mtime: fs.statSync(file).mtimeMs };
    const first = loadShard(ref, options);
    expect(first.entries.length).toBe(1);
    const shardFiles = fs.readdirSync(indexDir);
    expect(shardFiles.length).toBe(1);
    const second = loadShard(ref, options);
    expect(second).toEqual(first);
  });

  it("invalidates and re-parses the shard when mtime changes", () => {
    const file = seedSession("/home/user/inval", "1.jsonl", "i", [
      msg("e1", null, ts(0), userMessage("original content")),
    ]);
    const options = { indexDir, maxEntryChars: 2_000 };
    const stat = fs.statSync(file);
    const ref = { id: "i", file, cwd: "/home/user/inval", mtime: stat.mtimeMs };
    const first = loadShard(ref, options);
    expect(first.entries[0]!.text).toContain("original content");
    // append a new line, changing mtime + size
    const later = Date.now() / 1_000 + 5;
    fs.appendFileSync(file, `${JSON.stringify(msg("e2", "e1", ts(1), userMessage("appended")))}\n`);
    fs.utimesSync(file, later, later);
    const newStat = fs.statSync(file);
    const refreshed = loadShard(
      { id: "i", file, cwd: "/home/user/inval", mtime: newStat.mtimeMs },
      options,
    );
    expect(refreshed.entries.length).toBe(2);
    expect(refreshed.entries[1]!.text).toContain("appended");
  });

  it("BM25 ranking is deterministic: same query twice yields identical ordering", () => {
    const file = seedSession("/home/user/det", "1.jsonl", "d", [
      msg("e1", null, ts(0), userMessage("auth login bug in the auth module")),
      msg("e2", "e1", ts(1), assistantText("the auth module handles login")),
      msg("e3", "e2", ts(2), userMessage("deployment pipeline config")),
      msg("e4", "e3", ts(3), assistantText("the config lives in config.yaml")),
    ]);
    const options = { indexDir, maxEntryChars: 2_000 };
    const { shards } = loadShards(
      [{ id: "d", file, cwd: "/home/user/det", mtime: fs.statSync(file).mtimeMs }],
      options,
    );
    const run = () =>
      bm25Score(shards, ["auth", "module"], {})
        .map((s) => s.entry.index);
    const first = run();
    const second = run();
    expect(second).toEqual(first);
    // only the two entries mentioning both terms match
    expect([...first].sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it("BM25 tie-break is deterministic by mtime desc then index asc", () => {
    const fileA = seedSession("/home/user/tie-a", "1.jsonl", "a", [
      msg("e1", null, ts(0), userMessage("deploy deploy deploy")),
    ]);
    const fileB = seedSession("/home/user/tie-b", "1.jsonl", "b", [
      msg("e1", null, ts(0), userMessage("deploy deploy deploy")),
    ]);
    fs.utimesSync(fileA, Date.now() / 1_000 - 5, Date.now() / 1_000 - 5);
    fs.utimesSync(fileB, Date.now() / 1_000, Date.now() / 1_000);
    const options = { indexDir, maxEntryChars: 2_000 };
    const { shards } = loadShards(
      [
        { id: "a", file: fileA, cwd: "/home/user/tie-a", mtime: fs.statSync(fileA).mtimeMs },
        { id: "b", file: fileB, cwd: "/home/user/tie-b", mtime: fs.statSync(fileB).mtimeMs },
      ],
      options,
    );
    const indices = bm25Score(shards, ["deploy"], {}).map((s) => s.entry.sessionFile);
    // both same score; newer session (b) should come first
    expect(indices[0]).toBe(fileB);
    expect(indices[1]).toBe(fileA);
  });

  it("recentEntries returns newest-mtime-first without a query", () => {
    const fileA = seedSession("/home/user/rec-a", "1.jsonl", "a", [
      msg("e1", null, ts(0), userMessage("older session")),
    ]);
    const fileB = seedSession("/home/user/rec-b", "1.jsonl", "b", [
      msg("e1", null, ts(0), userMessage("newer session")),
    ]);
    fs.utimesSync(fileA, Date.now() / 1_000 - 5, Date.now() / 1_000 - 5);
    fs.utimesSync(fileB, Date.now() / 1_000, Date.now() / 1_000);
    const options = { indexDir, maxEntryChars: 2_000 };
    const { shards } = loadShards(
      [
        { id: "a", file: fileA, cwd: "/home/user/rec-a", mtime: fs.statSync(fileA).mtimeMs },
        { id: "b", file: fileB, cwd: "/home/user/rec-b", mtime: fs.statSync(fileB).mtimeMs },
      ],
      options,
    );
    const recent = recentEntries(shards, {}, 25);
    expect(recent[0]!.entry.sessionFile).toBe(fileB);
    expect(recent[1]!.entry.sessionFile).toBe(fileA);
  });
});

describe("memory search pipeline", () => {
  let agentDir: string;
  let indexDir: string;

  beforeEach(() => {
    agentDir = makeTempDir("agent");
    indexDir = makeTempDir("index");
  });

  const seedSession = (cwd: string, name: string, id: string, messages: FixtureEntry[]): string =>
    writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), name, [
      sessionHeader(id, cwd),
      ...messages,
    ]);

  const load = (files: { file: string; id: string; cwd: string }[]) => {
    const options = { indexDir, maxEntryChars: 2_000 };
    return loadShards(
      files.map((f) => ({ id: f.id, file: f.file, cwd: f.cwd, mtime: fs.statSync(f.file).mtimeMs })),
      options,
    ).shards;
  };

  it("groups hits into segments bounded by user messages, with context entries", async () => {
    const file = seedSession("/home/user/seg", "1.jsonl", "s", [
      msg("e1", null, ts(0), userMessage("investigate the auth login flow")),
      msg("e2", "e1", ts(1), assistantText("looking at auth.ts")),
      msg("e3", "e2", ts(2), userMessage("now check the deployment scripts")),
      msg("e4", "e3", ts(3), assistantText("checking deploy.sh")),
      msg("e5", "e4", ts(4), assistantText("auth also appears here in a comment")),
    ]);
    const shards = load([{ file, id: "s", cwd: "/home/user/seg" }]);
    const result = await searchShards(shards, { query: "auth", limit: 50 });
    // matches at e1, e2, e5; segment 1 = e1+e2 (both match), segment 2 = e3,e4,e5 (e5 matches, e3/e4 context)
    expect(result.matchedCount).toBe(3);
    const segment2 = result.segments.find((s) => s.entries.some((e) => e.entry.index === 4));
    expect(segment2).toBeDefined();
    const e4 = segment2!.entries.find((e) => e.entry.index === 3);
    const e5 = segment2!.entries.find((e) => e.entry.index === 4);
    expect(e4?.matched).toBe(false);
    expect(e4?.marker).toBe(" ");
    expect(e5?.matched).toBe(true);
    expect(e5?.marker).toBe(">");
  });

  it("uses regex only in explicit regex mode", async () => {
    const file = seedSession("/home/user/re", "1.jsonl", "r", [
      msg("e1", null, ts(0), userMessage("error code 42 in module alpha")),
      msg("e2", "e1", ts(1), assistantText("error code 99 in module beta")),
    ]);
    const shards = load([{ file, id: "r", cwd: "/home/user/re" }]);
    const literal = await searchShards(shards, {
      query: "code 4[0-9]",
      queryMatch: "any",
      limit: 50,
    });
    expect(literal.matchedCount).toBe(2);
    const result = await searchShards(shards, {
      query: "code 4[0-9]",
      queryMode: "regex",
      limit: 50,
    });
    expect(result.matchedCount).toBe(1);
    expect(result.segments[0]!.entries[0]!.entry.text).toContain("code 42");
  });

  it("applies role and tool filters structurally", async () => {
    const file = seedSession("/home/user/filt", "1.jsonl", "f", [
      msg("e1", null, ts(0), userMessage("grep for TODO")),
      msg("e2", "e1", ts(1), assistantToolCall("c1", "grep", { pattern: "TODO" })),
      msg("e3", "e2", ts(2), toolResult("c1", "grep", "TODO: fix auth")),
      msg("e4", "e3", ts(3), assistantText("found a TODO")),
    ]);
    const shards = load([{ file, id: "f", cwd: "/home/user/filt" }]);
    const toolFiltered = await searchShards(shards, { query: "TODO", filters: { tool: "grep" } });
    // grep toolCall + grep toolResult both match (2); user/assistant text do not
    expect(toolFiltered.matchedCount).toBe(2);
    const matchedTools = toolFiltered.segments
      .flatMap((s) => s.entries)
      .filter((e) => e.matched)
      .map((e) => e.entry.toolName);
    expect(matchedTools.every((t) => t === "grep")).toBe(true);
    const roleFiltered = await searchShards(shards, { query: "TODO", filters: { role: "user" } });
    expect(roleFiltered.matchedCount).toBe(1);
    expect(roleFiltered.segments[0]!.entries.find((e) => e.matched)!.entry.role).toBe("user");
  });

  it("browse mode (no query) retains all bounded candidates for pagination with > markers", async () => {
    const messages: FixtureEntry[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 30; i += 1) {
      const entry = msg(`u${i}`, parent, ts(i), userMessage(`entry number ${i}`));
      messages.push(entry);
      parent = `u${i}`;
    }
    const file = seedSession("/home/user/browse", "1.jsonl", "b", messages);
    const shards = load([{ file, id: "b", cwd: "/home/user/browse" }]);
    const result = await searchShards(shards, {});
    expect(result.matchedCount).toBe(30);
    expect(result.segments.length).toBeGreaterThan(0);
    expect(result.segments[0]!.entries[0]!.marker).toBe(">");
  });

});

describe("MemoryProvider", () => {
  let agentDir: string;
  let indexDir: string;
  let cwd: string;

  beforeEach(() => {
    agentDir = makeTempDir("agent");
    indexDir = makeTempDir("index");
    cwd = "/home/user/provider-proj";
    writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "1_main.jsonl", [
      sessionHeader("main", cwd),
      msg("e1", null, ts(0), userMessage("remember the auth refactor")),
      msg("e2", "e1", ts(1), assistantText("the auth refactor touched login.ts")),
      msg("e3", "e2", ts(2), userMessage("ship the deploy pipeline")),
      msg("e4", "e3", ts(3), assistantText("deploy pipeline configured")),
    ]);
  });

  const provider = (scope?: { sessionFile?: string }) =>
    new MemoryProvider({
      agentDir,
      cwd,
      config: makeMemoryConfig(indexDir),
      sessionId: "main",
      ...(scope?.sessionFile ? { sessionFile: scope.sessionFile } : {}),
    });

  it("describes bounded recall hits and context expansion as public contracts", async () => {
    const recall = await provider().describe("recall", invocationContext(cwd));
    const expand = await provider().describe("expand", invocationContext(cwd));
    const recallInput = recall!.inputSchema as { properties: Record<string, unknown> };
    const expandInput = expand!.inputSchema as { properties: Record<string, unknown> };
    const recallOutput = recall!.outputSchema as { properties: Record<string, unknown> };
    const expandOutput = expand!.outputSchema as { properties: Record<string, unknown> };

    expect(recallInput.properties).toEqual(expect.objectContaining({
      queryMode: expect.any(Object),
      queryMatch: expect.any(Object),
      offset: expect.any(Object),
      snippetChars: expect.any(Object),
    }));
    expect(expandInput.properties).toEqual(expect.objectContaining({
      before: expect.any(Object),
      after: expect.any(Object),
      textOffset: expect.any(Object),
      maxChars: expect.any(Object),
    }));
    expect(recallOutput.properties).toEqual(expect.objectContaining({
      hits: expect.any(Object),
      next: expect.any(Object),
    }));
    expect(expandOutput.properties).toEqual(expect.objectContaining({
      entries: expect.any(Object),
      next: expect.any(Object),
    }));
  });

  it("recall with no query browses recent entries in session scope", async () => {
    const result = (await provider().invoke(
      "recall",
      { scope: "session" },
      invocationContext(cwd),
    )) as { total: number; hits: unknown[] };
    expect(result.total).toBeGreaterThan(0);
    expect(result.hits).toHaveLength(result.total);
  });

  it("recall with a query returns deterministic BM25 matches", async () => {
    const first = (await provider().invoke("recall", { scope: "session", query: "auth" }, invocationContext(cwd))) as {
      hits: Array<{ snippet: string }>;
    };
    const second = (await provider().invoke("recall", { scope: "session", query: "auth" }, invocationContext(cwd))) as {
      hits: Array<{ snippet: string }>;
    };
    expect(first).toEqual(second);
    expect(first.hits.some((hit) => hit.snippet.includes("auth"))).toBe(true);
    expect(first).not.toHaveProperty("text");
  });

  it("project scope searches all sessions for the cwd", async () => {
    const otherCwd = cwd; // same project dir
    writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(otherCwd)), "2_other.jsonl", [
      sessionHeader("other", otherCwd),
      msg("e1", null, ts(0), userMessage("auth pipeline note in another session")),
    ]);
    const result = (await provider().invoke(
      "recall",
      { scope: "project", query: "auth" },
      invocationContext(cwd),
    )) as { total: number; hits: Array<{ sessionId: string }> };
    const sessionIds = new Set(result.hits.map((hit) => hit.sessionId));
    expect(sessionIds.has("main")).toBe(true);
    expect(sessionIds.has("other")).toBe(true);
  });

  it("expand returns full untruncated text for indices", async () => {
    const longText = "y".repeat(3_000);
    const file = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "3_long.jsonl", [
      sessionHeader("long", cwd),
      msg("e1", null, ts(0), userMessage(longText)),
    ]);
    const result = (await provider().invoke("expand", { session: file, indices: [0] }, invocationContext(cwd))) as {
      entries: { index: number; text: string | null }[];
    };
    expect(result.entries[0]!.text).toBe(longText);
  });

  it("expand resolves a session by id", async () => {
    const result = (await provider().invoke("expand", { session: "main", indices: [0] }, invocationContext(cwd))) as {
      entries: { index: number; text: string | null }[];
    };
    expect(result.entries[0]!.text).toContain("remember the auth refactor");
  });

  it("supports explicit all-term and phrase matching", async () => {
    const file = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "2_query-modes.jsonl", [
      sessionHeader("query-modes", cwd),
      msg("root", null, ts(0), userMessage("investigate the browser choice")),
      msg("distractor", "root", ts(1), assistantText("Use the browser already present in Heddlework.")),
      msg(
        "decision",
        "distractor",
        ts(2),
        assistantText("Recommendation: Use CEF for Heddlework browser in Stage 1."),
      ),
    ]);
    const literal = await provider().invoke(
      "recall",
      {
        scope: `session:${file}`,
        query: '"Use CEF" "Stage 1" browser Heddlework',
        queryMatch: "all",
      },
      invocationContext(cwd),
    ) as { total: number; hits: Array<{ index: number }> };
    expect(literal.total).toBe(1);
    expect(literal.hits.map((hit) => hit.index)).toEqual([2]);

    const phrase = await provider().invoke(
      "recall",
      { scope: `session:${file}`, query: "use cef for heddlework", queryMode: "phrase" },
      invocationContext(cwd),
    ) as { total: number; hits: Array<{ index: number }> };
    expect(phrase.total).toBe(1);
    expect(phrase.hits[0]!.index).toBe(2);
  });

  it("rejects queryMatch outside literal mode", async () => {
    for (const queryMode of ["phrase", "regex"] as const) {
      await expect(provider().invoke(
        "recall",
        { query: "auth", queryMode, queryMatch: "all" },
        invocationContext(cwd),
      )).rejects.toThrow("queryMatch is only valid with literal queryMode");
    }
  });

  it("ranks human decisions ahead of recall-query plumbing", async () => {
    const file = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "3_provenance.jsonl", [
      sessionHeader("provenance", cwd),
      msg("root", null, ts(0), userMessage("choose the desktop engine")),
      msg(
        "echo",
        "root",
        ts(1),
        assistantToolCall("recall-call", "fabric_exec", {
          code: 'memory.recall({ query: "Use CEF Stage 1 browser Heddlework" })',
        }),
      ),
      msg(
        "echo-result",
        "echo",
        ts(2),
        toolResult("recall-call", "fabric_exec", "Use CEF Stage 1 browser Heddlework"),
      ),
      msg(
        "decision",
        "echo-result",
        ts(3),
        assistantText("CEF/Chromium is the better Heddlework main-browser engine."),
      ),
    ]);
    const result = await provider().invoke(
      "recall",
      {
        scope: `session:${file}`,
        query: '"Use CEF" "Stage 1" browser Heddlework',
        pageSize: 10,
      },
      invocationContext(cwd),
    ) as { hits: Array<{ index: number; tool: string | null; snippet: string }> };
    expect(result.hits[0]).toEqual(expect.objectContaining({
      index: 3,
      tool: null,
      snippet: expect.stringContaining("better Heddlework"),
    }));
  });

  it("bounds broad recall by exact hits and provides a lossless continuation", async () => {
    const entries: FixtureEntry[] = [
      sessionHeader("broad", cwd),
      msg("root", null, ts(0), userMessage("start retrieval regression")),
    ];
    let parent = "root";
    for (let index = 0; index < 600; index += 1) {
      const id = `assistant-${index}`;
      entries.push(msg(
        id,
        parent,
        ts(index + 1),
        assistantText(
          `${index === 0 ? "Use CEF Stage 1 Heddlework " : ""}browser result ${index} ${"x".repeat(1_400)}`,
        ),
      ));
      parent = id;
    }
    const file = writeSessionFile(
      path.join(agentDir, "sessions", encodeCwdDir(cwd)),
      "3_broad.jsonl",
      entries,
    );
    const memory = provider();
    const readFile = vi.spyOn(fs, "readFileSync");
    const sourceReads = (): number => readFile.mock.calls.filter(
      ([candidate]) => path.resolve(String(candidate)) === path.resolve(file),
    ).length;
    const first = await memory.invoke(
      "recall",
      {
        scope: `session:${file}`,
        query: '"Use CEF" "Stage 1" browser Heddlework',
        queryMatch: "any",
        pageSize: 50,
        snippetChars: 2_000,
      },
      invocationContext(cwd),
    ) as {
      total: number;
      hits: Array<{ index: number }>;
      next: { ref: string; args: Record<string, unknown> } | null;
    };
    expect(first.total).toBe(600);
    expect(first.hits.length).toBeGreaterThan(0);
    expect(first.hits.length).toBeLessThan(50);
    expect(first.hits[0]!.index).toBe(1);
    expect(first.next).not.toBeNull();
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(RECALL_MAX_RESPONSE_CHARS);
    expect(first.next!.args).toEqual(expect.objectContaining({
      scope: `session:${file}`,
      expectedSourceHash: expect.any(String),
      expectedLineageFingerprint: expect.any(String),
      offset: first.hits.length,
    }));

    const readsAfterFirstPage = sourceReads();
    const second = await memory.invoke("recall", first.next!.args, invocationContext(cwd)) as {
      hits: Array<{ index: number }>;
    };
    expect(second.hits[0]!.index).not.toBe(first.hits[0]!.index);
    expect(sourceReads()).toBe(readsAfterFirstPage);

    fs.appendFileSync(
      file,
      `${JSON.stringify(msg("late", parent, ts(700), assistantText("late browser result")))}\n`,
    );
    const stale = await memory.invoke("recall", first.next!.args, invocationContext(cwd)) as {
      error: { code: string };
      hits: unknown[];
    };
    expect(stale.error.code).toBe("stale_pointer");
    expect(stale.hits).toEqual([]);
  });

  it("expands nearby context in bounded chunks that continue without JSONL tooling", async () => {
    const longText = `TARGET_CONTEXT_TOKEN ${"z".repeat(55_000)}`;
    const file = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "4_context.jsonl", [
      sessionHeader("context", cwd),
      msg("before", null, ts(0), userMessage("before context")),
      msg("target", "before", ts(1), assistantText(longText)),
      msg("after", "target", ts(2), userMessage("after context")),
    ]);
    const memory = provider();
    const recalled = await memory.invoke(
      "recall",
      { scope: `session:${file}`, query: "TARGET_CONTEXT_TOKEN" },
      invocationContext(cwd),
    ) as { hits: Array<{ follow: { args: Record<string, unknown> } }> };

    const readFile = vi.spyOn(fs, "readFileSync");
    let expanded = await memory.invoke(
      "expand",
      { ...recalled.hits[0]!.follow.args, before: 2, after: 2 },
      invocationContext(cwd),
    ) as {
      entries: Array<{ index: number; anchor?: boolean; text: string; textRange: { complete: boolean } }>;
      next: { args: Record<string, unknown> } | null;
    };
    const textByIndex = new Map<number, string>();
    let anchorChunks = 0;
    let calls = 0;
    while (true) {
      calls += 1;
      expect(JSON.stringify(expanded).length).toBeLessThan(30_000);
      for (const entry of expanded.entries) {
        textByIndex.set(entry.index, `${textByIndex.get(entry.index) ?? ""}${entry.text}`);
        if (entry.anchor) anchorChunks += 1;
      }
      if (expanded.next === null) break;
      expect(expanded.next).not.toBeNull();
      expanded = await memory.invoke(
        "expand",
        expanded.next!.args,
        invocationContext(cwd),
      ) as typeof expanded;
    }
    const sourceReads = readFile.mock.calls.filter(
      ([candidate]) => path.resolve(String(candidate)) === path.resolve(file),
    ).length;
    expect(calls).toBeGreaterThan(1);
    expect(sourceReads).toBeLessThanOrEqual(5);
    expect(anchorChunks).toBeGreaterThan(1);
    expect(textByIndex.get(0)).toBe("before context");
    expect(textByIndex.get(1)).toBe(longText);
    expect(textByIndex.get(2)).toBe("after context");
  });

  it("invalidates cached expansion pages when the session changes", async () => {
    const file = writeSessionFile(
      path.join(agentDir, "sessions", encodeCwdDir(cwd)),
      "5_stale-expansion.jsonl",
      [
        sessionHeader("stale-expansion", cwd),
        msg("entry", null, ts(0), assistantText(`stable ${"x".repeat(2_000)}`)),
      ],
    );
    const memory = provider();
    const first = await memory.invoke(
      "expand",
      { session: file, indices: [0], maxChars: 256 },
      invocationContext(cwd),
    ) as { next: { args: Record<string, unknown> } | null };
    expect(first.next).not.toBeNull();

    fs.appendFileSync(
      file,
      `${JSON.stringify(msg("late", "entry", ts(1), assistantText("changed")))}\n`,
    );
    const stale = await memory.invoke(
      "expand",
      first.next!.args,
      invocationContext(cwd),
    ) as { error: { code: string }; entries: unknown[] };
    expect(stale.error.code).toBe("stale_pointer");
    expect(stale.entries).toEqual([]);
  });

  it("hard-bounds expansion metadata while preserving lossless text continuations", async () => {
    const longText = `METADATA_BUDGET_TOKEN ${"m".repeat(23_500)}`;
    const longPaths = Array.from(
      { length: 20 },
      (_, index) => `/tmp/${index}-${"path".repeat(300)}`,
    );
    const file = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "5_metadata.jsonl", [
      sessionHeader("metadata", cwd),
      msg("entry", null, ts(0), {
        role: "assistant",
        content: [
          { type: "text", text: longText },
          { type: "toolCall", id: "paths", name: "read", arguments: { paths: longPaths } },
        ],
      }),
    ]);
    const expected = normalizeSession(file, Number.MAX_SAFE_INTEGER).entries[0]!.text;
    let result = await provider().invoke(
      "expand",
      { session: file, indices: [0], maxChars: 24_000, maxEntries: 20 },
      invocationContext(cwd),
    ) as {
      entries: Array<{ text: string }>;
      next: { args: Record<string, unknown> } | null;
    };
    let reconstructed = "";
    let calls = 0;
    while (true) {
      calls += 1;
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(RECALL_MAX_RESPONSE_CHARS);
      reconstructed += result.entries.map((entry) => entry.text).join("");
      if (result.next === null) break;
      result = await provider().invoke("expand", result.next!.args, invocationContext(cwd)) as typeof result;
    }
    expect(calls).toBeGreaterThan(1);
    expect(reconstructed).toBe(expected);
  });

  it("sessions lists known sessions with entry counts", async () => {
    const result = (await provider().invoke("sessions", { scope: "project" }, invocationContext(cwd))) as {
      sessions: { id: string; entryCount: number; cwd: string }[];
    };
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0]!.id).toBe("main");
    expect(result.sessions[0]!.entryCount).toBe(4);
    expect(result.sessions[0]!.cwd).toBe(cwd);
  });

  it("lists and describes its actions", async () => {
    const ctx = invocationContext(cwd);
    const list = await provider().list({}, ctx);
    expect(list.map((d) => d.name).sort()).toEqual(["expand", "outline", "recall", "sessions"]);
    const described = await provider().describe("recall", ctx);
    expect(described?.risk).toBe("read");
  });
});
