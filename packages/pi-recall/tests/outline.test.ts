// Pins the v0.3.0 structural door: `pi-recall outline` (argv shape, table +
// --json rendering, bin wiring) and the expand `role=` key (filter in and out
// of the continuation hint). Fixtures mirror tests/review-regressions.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCliContext } from "../src/cli/context.js";
import { parseExpandArgv, runExpandCall } from "../src/cli/expand.js";
import { parseOutlineArgv, renderOutline, runOutlineCall } from "../src/cli/outline.js";

const PACKAGE_ROOT = path.join(import.meta.dir, "..");
const BIN = path.join(PACKAGE_ROOT, "bin", "pi-recall");

let root: string;
let agentDir: string;
let sessionFile: string;

const writeMixedSession = (file: string, sessionId: string): void => {
  const message = (id: string, parentId: string | null, offset: number, message: Record<string, unknown>): string =>
    JSON.stringify({
      type: "message",
      id,
      parentId,
      timestamp: `2026-11-11T00:0${offset}:00.000Z`,
      message,
    });
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-11-11T00:00:00.000Z", cwd: "/tmp/recall-proj" }),
    message("m0", null, 1, { role: "user", content: "first user question\nwith a second line" }),
    message("m1", "m0", 2, { role: "assistant", content: [{ type: "text", text: "assistant answer" }] }),
    message("m2", "m1", 3, {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/x" } }],
    }),
    message("m3", "m2", 4, { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "file body" }] }),
    message("m4", "m3", 5, { role: "user", content: `second user question ${"z".repeat(400)}` }),
  ];
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
};

const runBin = (...argv: string[]): { code: number; stdout: string; stderr: string } => {
  const proc = Bun.spawnSync(["bun", BIN, ...argv], {
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_RECALL_INDEX_DIR: path.join(root, "index"),
    },
  });
  return {
    code: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
};

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "pi-recall-outline-"));
  agentDir = path.join(root, "agent");
  const projectDir = path.join(agentDir, "sessions", "--tmp-recall-proj--");
  mkdirSync(projectDir, { recursive: true });
  sessionFile = path.join(projectDir, "2026-11-11T00-00-00-000Z_00000000-0000-0000-0000-0000000000dd.jsonl");
  writeMixedSession(sessionFile, "outline-fixture");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("outline argv parsing", () => {
  test("session= is required; role= and branches= are accepted", () => {
    expect(() => parseOutlineArgv([])).toThrow(/outline needs session=/);
    expect(() => parseOutlineArgv(["role=user"])).toThrow(/outline needs session=/);
    const call = parseOutlineArgv([`session=${sessionFile}`, "role=user", "branches=all"]);
    expect(call).toEqual({ session: sessionFile, role: "user", branches: "all" });
  });

  test("malformed lines, empty values, and unknown keys are refused with help", () => {
    expect(() => parseOutlineArgv(["session"])).toThrow(/malformed outline argument/);
    expect(() => parseOutlineArgv(["session="])).toThrow(/outline session= is empty/);
    expect(() => parseOutlineArgv([`session=${sessionFile}`, "idx=1"])).toThrow(/unknown outline argument: idx/);
  });
});

describe("outline rendering and engine wiring", () => {
  test("renderOutline prints the ordered table with role and tool columns", () => {
    const lines = renderOutline({
      session: sessionFile,
      total: 4,
      truncated: false,
      entries: [
        { index: 0, type: "message", role: "user", preview: "first user question", size: 35 },
        { index: 2, type: "message", role: "assistant", tool: "read", preview: "Tool: read(…)", size: 30 },
      ],
    });
    expect(lines[0]).toContain(`# session ${sessionFile}`);
    expect(lines[0]).toContain("4 entries");
    expect(lines[1]).toContain("0");
    expect(lines[1]).toContain("user");
    expect(lines[2]).toContain("read");
  });

  test("runOutlineCall returns the full skeleton; role= filters it", async () => {
    const context = buildCliContext({ agentDir });
    const full = await runOutlineCall({ session: sessionFile }, context);
    expect(full.ok).toBe(true);
    expect(full.lines).toHaveLength(6); // header + 5 rows
    expect(full.lines[1]).toContain("first user question");
    expect(full.lines[3]).toContain("read");

    const users = await runOutlineCall({ session: sessionFile, role: "user" }, context);
    expect(users.ok).toBe(true);
    expect(users.lines).toHaveLength(3); // header + 2 rows
    expect(users.lines[1]).toContain("user");
    expect(users.lines[2]).toContain("user");
  });

  test("--json emits one parseable response with total/truncated", async () => {
    const context = buildCliContext({ agentDir });
    const result = await runOutlineCall({ session: sessionFile }, context, true);
    expect(result.ok).toBe(true);
    expect(result.lines).toHaveLength(1);
    const parsed = JSON.parse(result.lines[0]!) as { total: number; truncated: boolean; entries: unknown[] };
    expect(parsed.total).toBe(5);
    expect(parsed.truncated).toBe(false);
    expect(parsed.entries).toHaveLength(5);
  });

  test("an unresolvable session throws the CLI resolution error (bin exits 1)", async () => {
    const context = buildCliContext({ agentDir });
    try {
      await runOutlineCall({ session: "/nonexistent/session.jsonl" }, context);
      throw new Error("expected resolveSessionFile to throw");
    } catch (error) {
      expect((error as Error).message).toContain("no session file matches");
    }
  });
});

describe("bin/pi-recall outline", () => {
  test("prints the skeleton table to stdout", () => {
    const result = runBin("outline", `session=${sessionFile}`);
    expect(result.code).toBe(0);
    expect(result.stdout.split("\n").filter((line) => line.includes("message"))).toHaveLength(5);
    expect(result.stdout).toContain("first user question");
  });

  test("--json prints a single JSON document", () => {
    const result = runBin("outline", `session=${sessionFile}`, "--json");
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { total: number };
    expect(parsed.total).toBe(5);
  });

  test("role= filters the table", () => {
    const result = runBin("outline", `session=${sessionFile}`, "role=toolResult");
    expect(result.code).toBe(0);
    expect(result.stdout.split("\n").filter((line) => line.includes("message"))).toHaveLength(1);
  });

  test("a missing session= exits 1 with the usage help", () => {
    const result = runBin("outline", "role=user");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("outline needs session=");
  });
});

describe("expand role= key", () => {
  test("parseExpandArgv accepts role= and forwards it", () => {
    const call = parseExpandArgv([`session=${sessionFile}`, "idx=0,1", "role=user"]);
    expect(call.role).toBe("user");
  });

  test("runExpandCall filters returned entries and the continuation hint carries role=", async () => {
    const context = buildCliContext({ agentDir });
    const page1 = await runExpandCall(
      { session: sessionFile, idx: [0, 1, 2, 3, 4], role: "user", maxChars: 30 },
      context,
    );
    expect(page1.ok).toBe(true);
    const text = page1.lines.join("\n");
    expect(text).toContain("# entry #0");
    expect(text).not.toContain("# entry #1");
    expect(text).not.toContain("assistant answer");
    const hint = page1.lines.find((line) => line.includes("more entries"));
    expect(hint).toBeString();
    expect(hint).toContain("role=user");

    const offset = Number(/offset=(\d+)/.exec(hint!)![1]);
    const page2 = await runExpandCall(
      { session: sessionFile, idx: [0, 1, 2, 3, 4], role: "user", offset, maxChars: 30 },
      context,
    );
    expect(page2.ok).toBe(true);
    expect(page2.lines.join("\n")).toContain("# entry #4");
  });
});
