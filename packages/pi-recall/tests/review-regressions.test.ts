// Regression tests for the first CodeRabbit review round (PR #415). Each
// block pins one reviewed defect: CLI operand/limit parsing, expand id
// resolution and continuations, host-source boundary hardening, response
// bounds, continuation staleness, cold-search coverage, and BM25 token
// handling. Fixtures mirror tests/isolated-index.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { INDEX_DIR_ENV } from "../src/config.js";
import { buildCliContext } from "../src/cli/context.js";
import { runRecall } from "../src/cli/recall.js";
import { resolveMemoryId, runExpandCall } from "../src/cli/expand.js";
import { presentRecall } from "../src/memory/context.js";
import type { DigestShard, Shard } from "../src/memory/index.js";
import { bm25Score } from "../src/memory/index.js";
import { processMemoryExpand } from "../src/memory/expand-service.js";
import { processMemoryRecall } from "../src/memory/recall-service.js";
import { MemoryRequestCache } from "../src/memory/request-cache.js";
import { searchMemoryIndex } from "../src/memory/search.js";
import { planMemoryQuery } from "../src/memory/tokenize.js";
import {
  createMemorySourceRegistry,
  defineMemorySource,
  MEMORY_SOURCE_INTERFACE_VERSION,
} from "../src/memory/portable.js";
import { createMemorySourceClient } from "../src/memory/client.js";

const PACKAGE_ROOT = path.join(import.meta.dir, "..");
const BIN = path.join(PACKAGE_ROOT, "bin", "pi-recall");

const writeSession = (file: string, sessionId: string, texts: string[]): void => {
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-11-11T00:00:00.000Z", cwd: "/tmp/recall-proj" }),
    ...texts.map((text, position) =>
      JSON.stringify({
        type: "message",
        id: `entry${position}`,
        parentId: position === 0 ? null : `entry${position - 1}`,
        timestamp: `2026-11-11T00:0${position % 10}:00.000Z`,
        message: { role: "user", content: text },
      }),
    ),
  ];
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
};

const runBin = (...argv: string[]): { code: number; stderr: string } => {
  const proc = Bun.spawnSync(["bun", BIN, ...argv], {
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: "/tmp/pi-recall-empty-agent",
      PI_RECALL_INDEX_DIR: "/tmp/pi-recall-empty-idx",
    },
  });
  return {
    code: proc.exitCode,
    stderr: new TextDecoder().decode(proc.stderr),
  };
};

// ---------------------------------------------------------------------------
// bin/pi-recall: flag tokens are not operand values; --limit must be positive.
// ---------------------------------------------------------------------------
describe("CLI argument parsing", () => {
  test("--scope rejects a flag token as its operand", () => {
    const result = runBin("recall", "foo", "--scope", "--all");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--scope does not accept a flag as its value: --all");
  });

  test("--scope still accepts documented values such as session:", () => {
    const result = runBin("recall", "foo", "--scope", "session:abc");
    expect(result.stderr).not.toContain("does not accept a flag");
  });

  test("--limit rejects zero and empty values", () => {
    for (const value of ["0", ""]) {
      const result = runBin("recall", "foo", "--limit", value);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("--limit needs a positive integer");
    }
  });

  test("--offset still accepts zero", () => {
    const result = runBin("recall", "foo", "--offset", "0");
    expect(result.stderr).not.toContain("integer");
  });
});

// ---------------------------------------------------------------------------
// expand: id resolution scans every index file, refuses stale ids, forwards
// entryOffset, and prints the continuation.
// ---------------------------------------------------------------------------
describe("expand id resolution and continuations", () => {
  let root: string;
  let agentDir: string;
  let indexDir: string;
  let sessionA: string;
  let sessionB: string;
  const previousIndexDir = process.env[INDEX_DIR_ENV];

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "pi-recall-expand-"));
    agentDir = path.join(root, "agent");
    indexDir = path.join(root, "index");
    const projectDir = path.join(agentDir, "sessions", "--tmp-recall-proj--");
    mkdirSync(projectDir, { recursive: true });
    sessionA = path.join(projectDir, "2026-11-11T00-00-00-000Z_00000000-0000-0000-0000-00000000000a.jsonl");
    sessionB = path.join(projectDir, "2026-11-11T01-00-00-000Z_00000000-0000-0000-0000-00000000000b.jsonl");
    process.env[INDEX_DIR_ENV] = indexDir;
  });

  afterAll(() => {
    if (previousIndexDir === undefined) delete process.env[INDEX_DIR_ENV];
    else process.env[INDEX_DIR_ENV] = previousIndexDir;
    rmSync(root, { recursive: true, force: true });
  });

  const context = () => buildCliContext({ agentDir });

  test("a stale id is refused instead of expanding whatever now sits at the cached index", async () => {
    writeSession(sessionA, "session-a", ["alpha needle one", "alpha needle two"]);
    await runRecall({ query: "alpha", scope: "global" }, context());
    const matches = resolveMemoryId("entry0", context());
    expect(matches).toHaveLength(1);
    expect(matches[0]!.sourceHash).toBeString();

    writeSession(sessionA, "session-a", ["rewritten session carries different entry ids"]);
    const result = await runExpandCall({ id: "entry0", idx: [] }, context());
    expect(result.ok).toBe(false);
    const codes = result.lines.join("\n");
    expect(codes.includes("stale_pointer") || codes.includes("address_not_found")).toBe(true);
  });

  test("the same id in two sessions is ambiguous, not silently newest-wins", async () => {
    writeSession(sessionA, "session-a", ["alpha needle one", "alpha needle two"]);
    writeSession(sessionB, "session-b", ["beta needle one", "beta needle two"]);
    await runRecall({ query: "needle", scope: "global" }, context());
    expect(resolveMemoryId("entry0", context())).toHaveLength(2);
    const result = await runExpandCall({ id: "entry0", idx: [] }, context());
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toContain("matches 2 sessions");
    expect(result.lines.some((line) => line.includes(path.basename(sessionA)))).toBe(true);
    expect(result.lines.some((line) => line.includes(path.basename(sessionB)))).toBe(true);
  });

  test("offset is forwarded as entryOffset and the continuation is printed", async () => {
    writeSession(sessionA, "session-a", [
      "alpha " + "x".repeat(1_200),
      "beta " + "y".repeat(1_200),
      "gamma " + "z".repeat(1_200),
    ]);
    writeSession(sessionB, "session-b", ["unrelated beta"]);
    await runRecall({ query: "alpha", scope: "global" }, context());

    const page1 = await runExpandCall({ session: sessionA, idx: [0, 1, 2], maxChars: 1_500 }, context());
    expect(page1.ok).toBe(true);
    expect(page1.lines.find((line) => line.startsWith("# entry"))).toContain("# entry #0");
    const hint = page1.lines.find((line) => line.includes("more entries"));
    expect(hint).toBeString();
    expect(hint).toContain("offset=");

    const offset = Number(/offset=(\d+)/.exec(hint!)![1]);
    expect(offset).toBeGreaterThan(0);
    const textOffsetMatch = /textOffset=(\d+)/.exec(hint!);
    const page2 = await runExpandCall({
      session: sessionA,
      idx: [0, 1, 2],
      offset,
      ...(textOffsetMatch ? { textOffset: Number(textOffsetMatch[1]) } : {}),
      maxChars: 1_500,
    }, context());
    expect(page2.ok).toBe(true);
    // The continuation resumes at entry #1; before the entryOffset fix the
    // CLI's offset was ignored and every page restarted at entry #0.
    expect(page2.lines.find((line) => line.startsWith("# entry"))).toContain("# entry #1");
  });
});

// ---------------------------------------------------------------------------
// Host-source boundary: adapter failures are sanitized, metadata field types
// are validated, and display keys resolve in session-scoped recall.
// ---------------------------------------------------------------------------
describe("portable source boundary", () => {
  const seenKeys: string[] = [];
  const records = (sessionId: string) => [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-11-11T00:00:00.000Z", cwd: "/w" }),
    ...["one quokka", "two quokka"].map((text, position) =>
      JSON.stringify({
        type: "message",
        id: `m${position}`,
        parentId: position === 0 ? null : `m${position - 1}`,
        timestamp: `2026-11-11T00:0${position}:00.000Z`,
        message: { role: "user", content: text },
      })),
  ].map((line) => JSON.parse(line) as Record<string, unknown>);

  const client = createMemorySourceClient({
    sources: (() => {
      const registry = createMemorySourceRegistry();
      registry.register(defineMemorySource({
        interfaceVersion: MEMORY_SOURCE_INTERFACE_VERSION,
        id: "testsrc",
        async listSessions() {
          return [{ sessionKey: "k1", sessionId: "sid-1", revision: "r1" }];
        },
        async loadSession(sessionKey: string) {
          seenKeys.push(sessionKey);
          if (sessionKey === "boom") throw new Error("ECONNREFUSED at 10.0.0.5:5432 (user=admin)");
          return {
            sessionKey,
            sessionId: 42 as unknown as string,
            revision: "r1",
            metadata: { updatedAt: "yesterday" as unknown as number, cwd: "/w", extra: true },
            records: records("sid-1"),
          };
        },
      }));
      return registry;
    })(),
  });

  test("a raw adapter rejection becomes a sanitized source_unavailable failure", async () => {
    const response = await client.recall({ source: "testsrc", scope: "session:boom" }) as Record<string, unknown>;
    const error = response.error as { code: string; message: string };
    expect(error?.code).toBe("source_unavailable");
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("ECONNREFUSED");
    expect(serialized).not.toContain("admin");
  });

  test("non-string sessionId falls back and mistyped metadata fields are dropped", async () => {
    const response = await client.sessions({ source: "testsrc" }) as { sessions: Array<{ id: string; mtime: number }> };
    expect(response.sessions).toHaveLength(1);
    // updatedAt:"yesterday" must not reach the recency sort as mtime.
    expect(response.sessions[0]!.mtime).toBe(0);
  });

  test("session-scoped recall accepts display keys", async () => {
    const response = await client.recall({
      source: "testsrc",
      scope: "session:memory-source:testsrc/k1",
      query: "quokka",
    }) as { error?: { code: string } };
    expect(response.error).toBeUndefined();
    expect(seenKeys).toContain("k1");
    expect(seenKeys).not.toContain("memory-source:testsrc/k1");
  });
});

// ---------------------------------------------------------------------------
// Response bound: an oversized echoed query cannot bypass the page limit.
// ---------------------------------------------------------------------------
describe("recall response bound", () => {
  const segment = () => ({
    sessionId: "s",
    sessionFile: "s.jsonl",
    sourceHash: "h",
    branches: "active" as const,
    lineageFingerprint: "f",
    sessionMtime: 1,
    range: "#0-#1",
    entryRange: { first: 0, last: 1 },
    entries: [0, 1].map((index) => ({
      entry: {
        index,
        entryId: `e${index}`,
        parentId: null,
        type: "message",
        role: "user",
        toolName: null,
        timestamp: null,
        isError: false,
        text: `hit text ${index}`,
        sessionFile: "s.jsonl",
      },
      matched: true,
      marker: ">" as const,
      score: 1,
    })),
    exactMatches: [],
    matchedCount: 2,
    score: 1,
    tier: "hot" as const,
  });
  const result = () => ({
    matchMode: "lexical" as const,
    matchedCount: 2,
    totalMatches: 2,
    totalItems: 1,
    segmentCount: 1,
    segments: [],
    digestHits: [],
    items: [{ kind: "entry" as const, segment: segment() }],
    queryCoverage: { complete: true, reasons: [] },
  });
  const coverage = {
    complete: true,
    indexedSessions: 1,
    eligibleSessions: 1,
    staleSessions: 0,
    incompleteSessions: 0,
    reasons: [],
  };

  test("a bounded query still pages normally", () => {
    const response = presentRecall({
      result: result() as never,
      query: "hit",
      queryMode: "literal",
      coverage,
      pageSize: 1,
      snippetChars: 480,
      requestArgs: { query: "hit", pageSize: 1, snippetChars: 480 },
    });
    expect(response.hits).toHaveLength(1);
    expect(response.next).not.toBeNull();
  });

  test("a one-hit page whose continuation echo alone exceeds the bound fails bounded", () => {
    const oversized = "x ".repeat(16_000);
    expect(() =>
      presentRecall({
        result: result() as never,
        query: oversized,
        queryMode: "literal",
        coverage,
        pageSize: 1,
        snippetChars: 480,
        requestArgs: { query: oversized, pageSize: 1, snippetChars: 480 },
      }),
    ).toThrow(/character bound/);
  });
});

// ---------------------------------------------------------------------------
// Continuations: a remembered multi-session continuation whose sources changed
// is refused instead of paging an old offset through fresh results.
// ---------------------------------------------------------------------------
describe("recall continuation staleness", () => {
  let root: string;
  let agentDir: string;
  let fileA: string;
  let fileB: string;
  const previousIndexDir = process.env[INDEX_DIR_ENV];

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "pi-recall-stale-"));
    agentDir = path.join(root, "agent");
    const projectDir = path.join(agentDir, "sessions", "--tmp-recall-proj--");
    mkdirSync(projectDir, { recursive: true });
    fileA = path.join(projectDir, "2026-11-11T00-00-00-000Z_00000000-0000-0000-0000-0000000000aa.jsonl");
    fileB = path.join(projectDir, "2026-11-11T02-00-00-000Z_00000000-0000-0000-0000-0000000000bb.jsonl");
    writeSession(fileA, "stale-a", Array.from({ length: 14 }, (_, i) => `needle entry ${i} in a`));
    writeSession(fileB, "stale-b", Array.from({ length: 14 }, (_, i) => `needle entry ${i} in b`));
    process.env[INDEX_DIR_ENV] = path.join(root, "index");
  });

  afterAll(() => {
    if (previousIndexDir === undefined) delete process.env[INDEX_DIR_ENV];
    else process.env[INDEX_DIR_ENV] = previousIndexDir;
    rmSync(root, { recursive: true, force: true });
  });

  const invocation = { update: () => {}, signal: undefined };

  test("sources changed between pages → stale_continuation, not a shifted page", async () => {
    const cache = new MemoryRequestCache();
    const context = buildCliContext({ agentDir });
    const page1 = await processMemoryRecall(
      { query: "needle", scope: "global", pageSize: 10 },
      invocation,
      context,
      cache,
    ) as { hits: unknown[]; next: unknown };
    expect(page1.hits).toHaveLength(10);
    expect(page1.next).not.toBeNull();

    const unchanged = await processMemoryRecall(
      { query: "needle", scope: "global", pageSize: 10, offset: 10 },
      invocation,
      context,
      cache,
    ) as { hits: unknown[]; error?: { code: string } };
    expect(unchanged.error).toBeUndefined();
    expect(unchanged.hits).toHaveLength(10);

    appendFileSync(fileA, `${JSON.stringify({
      type: "message",
      id: "appended",
      parentId: "entry13",
      timestamp: "2026-11-11T00:09:00.000Z",
      message: { role: "user", content: "needle appended" },
    })}\n`, "utf8");
    const stale = await processMemoryRecall(
      { query: "needle", scope: "global", pageSize: 10, offset: 10 },
      invocation,
      context,
      cache,
    ) as { error?: { code: string } };
    expect(stale.error?.code).toBe("stale_continuation");
  });
});

// ---------------------------------------------------------------------------
// Expand selection cache: a mixed selection must not be served to a later
// range-only request.
// ---------------------------------------------------------------------------
describe("expand selection cache isolation", () => {
  let root: string;
  let agentDir: string;
  let file: string;
  const previousIndexDir = process.env[INDEX_DIR_ENV];

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "pi-recall-canonical-"));
    agentDir = path.join(root, "agent");
    const projectDir = path.join(agentDir, "sessions", "--tmp-recall-proj--");
    mkdirSync(projectDir, { recursive: true });
    file = path.join(projectDir, "2026-11-11T00-00-00-000Z_00000000-0000-0000-0000-0000000000cc.jsonl");
    writeSession(file, "canonical", Array.from({ length: 5 }, (_, i) => `canonical entry ${i}`));
    process.env[INDEX_DIR_ENV] = path.join(root, "index");
  });

  afterAll(() => {
    if (previousIndexDir === undefined) delete process.env[INDEX_DIR_ENV];
    else process.env[INDEX_DIR_ENV] = previousIndexDir;
    rmSync(root, { recursive: true, force: true });
  });

  test("a range-only request after a mixed request resolves its own selection", async () => {
    const cache = new MemoryRequestCache();
    const context = buildCliContext({ agentDir });
    const mixed = await processMemoryExpand(
      { session: file, indices: [4], entryRange: { first: 0, last: 2 } },
      context,
      cache,
    ) as { entries: Array<{ index: number }> };
    expect(mixed.entries.map((entry) => entry.index)).toEqual([0, 1, 2, 4]);

    const rangeOnly = await processMemoryExpand(
      { session: file, entryRange: { first: 0, last: 2 } },
      context,
      cache,
    ) as { entries: Array<{ index: number }> };
    expect(rangeOnly.entries.map((entry) => entry.index)).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Cold search: vocabulary misses cannot establish complete regex coverage;
// phrase candidates keep substring matches.
// ---------------------------------------------------------------------------
describe("cold search coverage", () => {
  const coldDigest = (vocabulary: string[], file = "cold.jsonl") => ({
    kind: "digest",
    sessionId: "c",
    file,
    cwd: "",
    firstTs: null,
    lastTs: null,
    entryCount: 0,
    filesTouched: [],
    toolHistogram: {},
    errorCount: 0,
    sourceHash: "h",
    branches: "active" as const,
    lineageFingerprint: "f",
    mtime: 0,
    size: 0,
    policy: "p",
    cacheBytes: 0,
    cacheSourceRatio: 0,
    vocabulary,
    addresses: [],
    indexCoverage: { complete: true, vocabularyBytes: 2, reasons: [] },
  }) as unknown as DigestShard;

  test("regex over unhydrated cold sessions is never reported complete", async () => {
    const result = await searchMemoryIndex([], [coldDigest(["42", "error"])], {
      query: "error\\s+42",
      queryMode: "regex",
    });
    expect(result.queryCoverage.complete).toBe(false);
    expect(result.queryCoverage.reasons).toContain("cold_regex_requires_hydration");
  });

  test("regex over a hydrated session keeps complete coverage", async () => {
    const shard = { entries: [], mtime: 0, sessionFile: "cold.jsonl" } as unknown as Shard;
    const result = await searchMemoryIndex([shard], [coldDigest(["42", "error"])], {
      query: "error\\s+42",
      queryMode: "regex",
    });
    expect(result.queryCoverage.complete).toBe(true);
  });

  test("phrase cold candidates keep substring matches; literal stays token-exact", async () => {
    const digest = coldDigest(["authentication"]);
    const phrase = await searchMemoryIndex([], [digest], { query: "auth", queryMode: "phrase" });
    expect(phrase.digestHits).toHaveLength(1);
    expect(phrase.queryCoverage.reasons).toContain("cold_phrase_requires_hydration");
    const literal = await searchMemoryIndex([], [digest], { query: "auth", queryMode: "literal" });
    expect(literal.digestHits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// BM25: planned terms are scored as-is; re-tokenization would split tokens
// whose lowercase form carries a combining mark (İstanbul → "i̇stanbul").
// ---------------------------------------------------------------------------
describe("BM25 planned tokens", () => {
  test("an exact literal query keeps its single planned token", () => {
    const shard = {
      entries: [{ index: 0, sessionFile: "s.jsonl", text: "İstanbul notes" }],
      mtime: 1,
    } as unknown as Shard;
    const plan = planMemoryQuery("İstanbul");
    expect(plan.kind).toBe("terms");
    const terms = plan.kind === "terms" ? plan.terms : [];
    expect(terms).toHaveLength(1);
    expect(bm25Score([shard], terms, {})).toHaveLength(1);
  });
});
