// Safety-critical: every index WRITE in this package must be redirectable to
// an isolated tree via PI_RECALL_INDEX_DIR, and the default must remain the
// agent-tree location (${agentDir}/fabric/memory-index) — never a path owned
// by another contour's live index. This test builds a real index from a
// synthetic session in a temp agent tree and asserts where the bytes landed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { INDEX_DIR_ENV, resolveMemoryConfig } from "../src/config.js";
import { buildCliContext } from "../src/cli/context.js";
import { runRecall, renderRecall } from "../src/cli/recall.js";
import { runExpandCall } from "../src/cli/expand.js";
import { resolveIndexOptions } from "../src/memory/request-context.js";
// Hard compat invariant: the live index (~/.pi/agent/fabric/memory-index) is
// MEMORY_CACHE_VERSION 6; this package must read and write exactly that.
import { MEMORY_CACHE_VERSION, loadTieredIndex } from "../src/memory/index.js";
import { enumerateAllSessions } from "../src/memory/discovery.js";
import { readFileSync } from "node:fs";

let root: string;
let agentDir: string;
let indexDir: string;
let sessionFile: string;
const previousIndexDir = process.env[INDEX_DIR_ENV];

const writeSession = (file: string, sessionId: string, cwd: string, texts: string[]): void => {
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-11-11T00:00:00.000Z", cwd }),
    ...texts.map((text, position) =>
      JSON.stringify({
        type: "message",
        id: `entry${position}`,
        parentId: position === 0 ? null : `entry${position - 1}`,
        timestamp: `2026-11-11T00:0${position}:00.000Z`,
        message: { role: "user", content: text },
      }),
    ),
  ];
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
};

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "pi-recall-test-"));
  agentDir = path.join(root, "agent");
  indexDir = path.join(root, "isolated-index");
  mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
  const projectDir = path.join(agentDir, "sessions", "--tmp-recall-proj--");
  mkdirSync(projectDir, { recursive: true });
  sessionFile = path.join(projectDir, "2026-11-11T00-00-00-000Z_00000000-0000-0000-0000-000000000001.jsonl");
  writeSession(
    sessionFile,
    "00000000-0000-0000-0000-000000000001",
    "/tmp/recall-proj",
    [
      "quokka-lighthouse is the agreed signal phrase for this synthetic session",
      "an unrelated second entry about tea kettles",
    ],
  );
  process.env[INDEX_DIR_ENV] = indexDir;
});

afterAll(() => {
  if (previousIndexDir === undefined) delete process.env[INDEX_DIR_ENV];
  else process.env[INDEX_DIR_ENV] = previousIndexDir;
  rmSync(root, { recursive: true, force: true });
});

describe("PI_RECALL_INDEX_DIR write isolation", () => {
  test("MEMORY_CACHE_VERSION stays 6", () => {
    expect(MEMORY_CACHE_VERSION).toBe(6);
  });

  test("resolveMemoryConfig applies the env override", () => {
    expect(resolveMemoryConfig().indexDir).toBe(indexDir);
  });

  test("default index dir stays the agent-tree location when the env is unset", () => {
    delete process.env[INDEX_DIR_ENV];
    try {
      const config = resolveMemoryConfig();
      expect(config.indexDir).toBeUndefined();
      const options = resolveIndexOptions(config, agentDir, "active");
      expect(options.indexDir).toBe(path.join(agentDir, "fabric", "memory-index"));
    } finally {
      process.env[INDEX_DIR_ENV] = indexDir;
    }
  });

  test("recall builds the index lazily inside the override dir, not the agent tree", async () => {
    expect(existsSync(indexDir)).toBe(false);
    const response = await runRecall(
      { query: "quokka-lighthouse", scope: "global" },
      buildCliContext({ agentDir }),
    );
    const rendered = renderRecall(response);
    expect(rendered.ok).toBe(true);
    expect(rendered.lines.some((line) => line.includes("quokka-lighthouse"))).toBe(true);
    // The write proof: shard bytes exist only under the override dir.
    const files = readdirSync(indexDir);
    expect(files.some((name) => name.endsWith(".jsonl.json"))).toBe(true);
    expect(existsSync(path.join(agentDir, "fabric"))).toBe(false);
    // Written shards carry the compat version — zero migration vs the live index.
    const shardFile = files.find((name) => name.endsWith(".jsonl.json"))!;
    const shard = JSON.parse(readFileSync(path.join(indexDir, shardFile), "utf8"));
    expect(shard.cacheVersion).toBe(6);
    expect(shard.kind).toBe("shard");
  });

  test("expand reads the full entry back through the same isolated tree", async () => {
    const result = await runExpandCall(
      { session: sessionFile, idx: [0] },
      buildCliContext({ agentDir }),
    );
    expect(result.ok).toBe(true);
    expect(result.lines.join("\n")).toContain("quokka-lighthouse is the agreed signal phrase");
    expect(result.lines.join("\n")).toContain("# entry #0");
  });

  test("tiered index and discovery enumerate only the temp tree", () => {
    const refs = enumerateAllSessions(agentDir, 100);
    expect(refs.map((ref) => ref.file)).toEqual([sessionFile]);
    const context = buildCliContext({ agentDir });
    const options = resolveIndexOptions(context.config, context.agentDir, "active");
    const index = loadTieredIndex(refs, refs, options);
    expect(index.shards.length + index.digests.length).toBeGreaterThan(0);
    expect(options.indexDir).toBe(indexDir);
  });
});
