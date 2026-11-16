// fabric.json memory-section file layer: parse, precedence, strict sources
// validation, and an end-to-end recall through a configured fs source with no
// env vars. The parser is a port of the fork's normalizeFabricConfig memory
// subsection (commit ef0c4ceb); these tests pin the ported coordinates,
// clamp tables, and the read-only layer's silence on missing/corrupt files.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_MEMORY_CONFIG, INDEX_DIR_ENV, resolveMemoryConfig } from "../src/config.js";
import { buildCliContext } from "../src/cli/context.js";
import { runRecall, renderRecall } from "../src/cli/recall.js";

let root: string;
let agentDir: string;
let projectDir: string;
let plainAgentDir: string;
let plainProjectDir: string;
let sourceRoot: string;
const previousIndexDir = process.env[INDEX_DIR_ENV];

const writeFabric = (file: string, document: unknown): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, "utf8");
};

const writeRawFabric = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
};

// Flat-archive session for the fs source: same JSONL shape the isolated-index
// fixture writes into the agent tree, dropped directly under the source root.
const writeSession = (file: string, sessionId: string, texts: string[]): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-11-11T00:00:00.000Z",
      cwd: "/tmp/laptop-proj",
    }),
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
  root = mkdtempSync(path.join(tmpdir(), "pi-recall-config-"));
  agentDir = path.join(root, "agent");
  projectDir = path.join(root, "project");
  writeFabric(path.join(agentDir, "fabric.json"), {
    memory: {
      sources: [{ id: "laptop", kind: "fs", root: path.join(root, "source") }],
      maxSessions: 42,
      maxEntryChars: 12_345,
      indexThinking: true,
    },
  });
  writeFabric(path.join(projectDir, ".pi", "fabric.json"), {
    memory: { maxSessions: 7 },
  });
  plainAgentDir = path.join(root, "plain-agent");
  plainProjectDir = path.join(root, "plain-project");
  mkdirSync(plainAgentDir, { recursive: true });
  mkdirSync(plainProjectDir, { recursive: true });
  sourceRoot = path.join(root, "source");
  writeSession(
    path.join(sourceRoot, "2026-11-11T00-00-00-000Z_00000000-0000-0000-0000-000000000002.jsonl"),
    "00000000-0000-0000-0000-000000000002",
    [
      "tsuki-orbit is the laptop archive signal phrase for configured-source recall",
      "an unrelated entry about river barges",
    ],
  );
});

afterAll(() => {
  if (previousIndexDir === undefined) delete process.env[INDEX_DIR_ENV];
  else process.env[INDEX_DIR_ENV] = previousIndexDir;
  rmSync(root, { recursive: true, force: true });
});

describe("fabric.json memory section parsing", () => {
  test("valid section lands: sources and budgets come from the agent-dir file", () => {
    const config = resolveMemoryConfig({}, { agentDir, cwd: plainProjectDir });
    expect(config.sources).toEqual([
      { id: "laptop", kind: "fs", root: path.join(root, "source") },
    ]);
    expect(config.maxSessions).toBe(42);
    expect(config.maxEntryChars).toBe(12_345);
    expect(config.indexThinking).toBe(true);
    // Untouched fields stay at defaults.
    expect(config.enabled).toBe(DEFAULT_MEMORY_CONFIG.enabled);
    expect(config.regexTimeoutMs).toBe(DEFAULT_MEMORY_CONFIG.regexTimeoutMs);
    expect(config.indexDir).toBeUndefined();
  });

  test("project .pi/fabric.json overrides agent-dir values field-wise", () => {
    const config = resolveMemoryConfig({}, { agentDir, cwd: projectDir });
    expect(config.maxSessions).toBe(7);
    // Sibling fields from the agent file survive the deep merge.
    expect(config.maxEntryChars).toBe(12_345);
    expect(config.sources).toEqual([
      { id: "laptop", kind: "fs", root: path.join(root, "source") },
    ]);
  });

  test("a project sources array replaces the agent-dir array atomically", () => {
    const overrideAgent = path.join(root, "atomic-agent");
    const overrideProject = path.join(root, "atomic-project");
    writeFabric(path.join(overrideAgent, "fabric.json"), {
      memory: { sources: [{ id: "alpha", kind: "fs", root: "/tmp/alpha" }] },
    });
    writeFabric(path.join(overrideProject, ".pi", "fabric.json"), {
      memory: { sources: [{ id: "beta", kind: "fs", root: "/tmp/beta" }] },
    });
    const config = resolveMemoryConfig({}, { agentDir: overrideAgent, cwd: overrideProject });
    expect(config.sources).toEqual([{ id: "beta", kind: "fs", root: "/tmp/beta" }]);
  });

  test("missing fabric.json at both locations stays at defaults, no throw", () => {
    delete process.env[INDEX_DIR_ENV];
    try {
      const config = resolveMemoryConfig({}, { agentDir: plainAgentDir, cwd: plainProjectDir });
      expect(config).toEqual(DEFAULT_MEMORY_CONFIG);
    } finally {
      if (previousIndexDir !== undefined) process.env[INDEX_DIR_ENV] = previousIndexDir;
    }
  });

  test("corrupt, empty, and non-object fabric.json files are skipped silently", () => {
    const corruptAgent = path.join(root, "corrupt-agent");
    const corruptProject = path.join(root, "corrupt-project");
    writeRawFabric(path.join(corruptAgent, "fabric.json"), "{not json at all");
    writeRawFabric(path.join(corruptProject, ".pi", "fabric.json"), "[1, 2, 3]");
    const emptyAgent = path.join(root, "empty-agent");
    writeRawFabric(path.join(emptyAgent, "fabric.json"), "   \n");
    const config = resolveMemoryConfig({}, { agentDir: corruptAgent, cwd: corruptProject });
    expect(config.enabled).toBe(DEFAULT_MEMORY_CONFIG.enabled);
    const emptyConfig = resolveMemoryConfig({}, { agentDir: emptyAgent });
    expect(emptyConfig.maxSessions).toBe(DEFAULT_MEMORY_CONFIG.maxSessions);
  });

  test("wrong-typed memory section and scalars stay silently at defaults", () => {
    const wrongAgent = path.join(root, "wrong-agent");
    writeFabric(path.join(wrongAgent, "fabric.json"), { memory: "nope" });
    const wrongSection = resolveMemoryConfig({}, { agentDir: wrongAgent });
    expect(wrongSection.maxSessions).toBe(DEFAULT_MEMORY_CONFIG.maxSessions);
    expect(wrongSection.sources).toBeUndefined();

    const scalarAgent = path.join(root, "scalar-agent");
    writeFabric(path.join(scalarAgent, "fabric.json"), {
      memory: {
        enabled: "yes",
        maxSessions: "many",
        regexTimeoutMs: 5.5,
        sources: "nope",
      },
    });
    const config = resolveMemoryConfig({}, { agentDir: scalarAgent });
    expect(config.enabled).toBe(DEFAULT_MEMORY_CONFIG.enabled);
    expect(config.maxSessions).toBe(DEFAULT_MEMORY_CONFIG.maxSessions);
    expect(config.regexTimeoutMs).toBe(DEFAULT_MEMORY_CONFIG.regexTimeoutMs);
    expect(config.sources).toBeUndefined();
  });

  test("present integers clamp to the fork's bounds, unknown memory keys are ignored", () => {
    const clampAgent = path.join(root, "clamp-agent");
    writeFabric(path.join(clampAgent, "fabric.json"), {
      memory: {
        maxSessions: 10_000_000,
        maxEntryChars: 1,
        digestTerms: 0,
        zork: true,
      },
    });
    const config = resolveMemoryConfig({}, { agentDir: clampAgent });
    expect(config.maxSessions).toBe(100_000);
    expect(config.maxEntryChars).toBe(100);
    expect(config.digestTerms).toBe(1);
    expect("zork" in config).toBe(false);
  });
});

describe("strict memory.sources validation (fork coordinates)", () => {
  const expectExactError = (document: unknown, message: string): void => {
    const dir = path.join(root, "strict-agent");
    writeFabric(path.join(dir, "fabric.json"), document);
    let thrown: unknown;
    try {
      resolveMemoryConfig({}, { agentDir: dir });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(message);
  };

  test("bad id charset throws the exact coordinate error", () => {
    expectExactError(
      { memory: { sources: [{ id: "Big_ID", kind: "fs", root: "/tmp/x" }] } },
      "Invalid memory.sources[0]: id must be 1-128 chars of lowercase letters, digits, dot, underscore, or dash, starting with a letter or digit",
    );
  });

  test("non-fs kind throws with the JSON-encoded kind", () => {
    expectExactError(
      { memory: { sources: [{ id: "ok", kind: "s3", root: "/tmp/x" }] } },
      'Invalid memory.sources[0]: unknown kind "s3"; expected "fs"',
    );
  });

  test("missing kind is reported like any other wrong kind", () => {
    expectExactError(
      { memory: { sources: [{ id: "ok", root: "/tmp/x" }] } },
      'Invalid memory.sources[0]: unknown kind null; expected "fs"',
    );
  });

  test("relative root throws", () => {
    expectExactError(
      { memory: { sources: [{ id: "ok", kind: "fs", root: "relative/path" }] } },
      "Invalid memory.sources[0]: root must be an absolute directory path",
    );
  });

  test("duplicate id throws at the duplicate's index", () => {
    expectExactError(
      {
        memory: {
          sources: [
            { id: "twice", kind: "fs", root: "/tmp/a" },
            { id: "twice", kind: "fs", root: "/tmp/b" },
          ],
        },
      },
      'Invalid memory.sources[1]: duplicate source id "twice"',
    );
  });

  test("a non-object entry throws the id error at its index", () => {
    expectExactError(
      { memory: { sources: [42] } },
      "Invalid memory.sources[0]: id must be 1-128 chars of lowercase letters, digits, dot, underscore, or dash, starting with a letter or digit",
    );
  });
});

describe("resolution order: overrides > env > project > agent > defaults", () => {
  test("env PI_RECALL_INDEX_DIR beats the file's indexDir; explicit overrides beat env", () => {
    const indexAgent = path.join(root, "index-agent");
    writeFabric(path.join(indexAgent, "fabric.json"), {
      memory: { indexDir: "/tmp/from-file" },
    });
    process.env[INDEX_DIR_ENV] = "/tmp/from-env";
    try {
      expect(resolveMemoryConfig({}, { agentDir: indexAgent }).indexDir).toBe("/tmp/from-env");
      expect(
        resolveMemoryConfig({ indexDir: "/tmp/from-override" }, { agentDir: indexAgent }).indexDir,
      ).toBe("/tmp/from-override");
    } finally {
      if (previousIndexDir === undefined) delete process.env[INDEX_DIR_ENV];
      else process.env[INDEX_DIR_ENV] = previousIndexDir;
    }
  });

  test("pure path without files stays defaults + env + overrides only", () => {
    process.env[INDEX_DIR_ENV] = "/tmp/from-env";
    try {
      expect(resolveMemoryConfig().indexDir).toBe("/tmp/from-env");
      expect(resolveMemoryConfig({ maxSessions: 9 }).maxSessions).toBe(9);
    } finally {
      if (previousIndexDir === undefined) delete process.env[INDEX_DIR_ENV];
      else process.env[INDEX_DIR_ENV] = previousIndexDir;
    }
  });
});

describe("CLI end-to-end over a configured fs source", () => {
  test("buildCliContext seeds the source registry from fabric.json", () => {
    const context = buildCliContext({ agentDir, cwd: plainProjectDir });
    expect(context.sources?.get("laptop")).toBeDefined();
    expect(context.sources?.get("absent")).toBeUndefined();
    // No fabric.json → no registry, context shape unchanged.
    const bare = buildCliContext({ agentDir: plainAgentDir, cwd: plainProjectDir });
    expect(bare.sources).toBeUndefined();
  });

  test("malformed sources entry fails CLI context construction with the coordinate error", () => {
    const badAgent = path.join(root, "bad-agent");
    writeFabric(path.join(badAgent, "fabric.json"), {
      memory: { sources: [{ id: "bad", kind: "http", root: "/tmp/x" }] },
    });
    let thrown: unknown;
    try {
      buildCliContext({ agentDir: badAgent, cwd: plainProjectDir });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe('Invalid memory.sources[0]: unknown kind "http"; expected "fs"');
  });

  test("bin rejects an empty --source operand instead of silently recalling the filesystem scopes", () => {
    const bin = path.resolve(import.meta.dir, "../bin/pi-recall");
    const proc = Bun.spawnSync([
      "sh",
      "-c",
      `bun "${bin}" recall --source "" tsuki-orbit`,
    ], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    });
    expect(proc.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(proc.stderr)).toContain("recall source= is empty");
  });

  test("source-qualified recall answers through the configured source with no env vars", async () => {
    delete process.env[INDEX_DIR_ENV];
    try {
      const context = buildCliContext({ agentDir, cwd: plainProjectDir });
      const response = (await runRecall({ query: "tsuki-orbit", source: "laptop" }, context)) as {
        total?: number;
        hits?: { follow?: { args?: { source?: string; session?: string } } }[];
      };
      expect(response.total).toBe(1);
      // Source-qualified marker: the follow pointer names the configured
      // source and its host display key (memory-source:<id>/<key>).
      const follow = response.hits?.[0]?.follow?.args;
      expect(follow?.source).toBe("laptop");
      expect(follow?.session?.startsWith("memory-source:laptop/")).toBe(true);
      const rendered = renderRecall(response);
      expect(rendered.ok).toBe(true);
      expect(rendered.lines.some((line) => line.includes("tsuki-orbit"))).toBe(true);
    } finally {
      if (previousIndexDir !== undefined) process.env[INDEX_DIR_ENV] = previousIndexDir;
    }
  });
});
