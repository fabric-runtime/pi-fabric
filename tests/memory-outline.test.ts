// memory.outline + the expand role filter: the structural door over the
// normalized session model. Pins the deterministic skeleton (ordered rows of
// index/type/role/tool/preview/size), the maxEntries cap with total/truncated,
// and the role filter on expand — applied before chunking and carried by the
// continuation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FabricMemoryConfig } from "../src/config.js";
import { encodeCwdDir } from "../src/memory/discovery.js";
import { MemoryProvider } from "../src/providers/memory-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import {
  assistantText,
  assistantToolCall,
  messageEntry,
  sessionHeader,
  toolResult,
  userMessage,
  writeSessionFile,
  type FixtureEntry,
} from "./fixtures/memory.js";

const temporary: string[] = [];
const temp = (name: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fabric-memory-outline-${name}-`));
  temporary.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const timestamp = (offset: number): string =>
  new Date(1_700_000_000_000 + offset * 1_000).toISOString();

const invocation = (cwd: string): FabricInvocationContext => ({
  cwd,
  signal: undefined,
  parentToolCallId: "memory-outline",
  nestedToolCallId: "memory-outline-nested",
  extensionContext: {} as FabricInvocationContext["extensionContext"],
  update() {},
});

const config = (indexDir: string): FabricMemoryConfig => ({
  enabled: true,
  indexDir,
  maxSessions: 500,
  maxEntryChars: 2_000,
  indexThinking: false,
  indexToolOutput: true,
  hotSessions: 50,
});

interface OutlineRow {
  index: number;
  type: string;
  role?: string;
  tool?: string;
  preview: string;
  size: number;
}

interface OutlineResponse {
  session: string;
  entryCount: number;
  total: number;
  truncated: boolean;
  entries: OutlineRow[];
  error?: { code: string };
}

const mixedSession = (dir: string): { agentDir: string; file: string } => {
  const agentDir = temp(`${dir}-agent`);
  const cwd = `/work/outline-${dir}`;
  const file = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), `${dir}.jsonl`, [
    sessionHeader(`${dir}`, cwd),
    messageEntry("o-user", null, timestamp(0), userMessage("outline the harbor plan first\nsecond line here")),
    messageEntry("o-assist", "o-user", timestamp(1), assistantText("Harbor plan acknowledged.", 1_700_000_000_001)),
    messageEntry(
      "o-call",
      "o-assist",
      timestamp(2),
      assistantToolCall("call-1", "read", { path: "/harbor/plan.md" }, 1_700_000_000_002),
    ),
    messageEntry("o-result", "o-call", timestamp(3), toolResult("call-1", "read", "plan body", false, 1_700_000_000_003)),
  ]);
  return { agentDir, file };
};

let providerIndex = 0;
const provider = (agentDir: string): MemoryProvider =>
  new MemoryProvider({ agentDir, cwd: "/work", config: config(temp(`idx-${++providerIndex}`)) });

describe("memory.outline skeleton", () => {
  it("returns the ordered deterministic skeleton with role and tool columns", async () => {
    const { agentDir, file } = mixedSession("skeleton");
    const first = await provider(agentDir).invoke("outline", { session: file }, invocation("/work")) as OutlineResponse;
    const second = await provider(agentDir).invoke("outline", { session: file }, invocation("/work")) as OutlineResponse;
    expect(first.error).toBeUndefined();
    expect(first).toEqual(second); // deterministic
    expect(first.entryCount).toBe(4);
    expect(first.total).toBe(4);
    expect(first.truncated).toBe(false);
    expect(first.entries.map((row) => row.index)).toEqual([0, 1, 2, 3]);
    expect(first.entries.map((row) => row.type)).toEqual(["message", "message", "message", "message"]);
    expect(first.entries.map((row) => row.role)).toEqual(["user", "assistant", "assistant", "toolResult"]);
    expect(first.entries.map((row) => row.tool)).toEqual([undefined, undefined, "read", "read"]);
    expect(first.entries[0]!.preview).toBe("outline the harbor plan first");
    expect(first.entries[0]!.size).toBe("outline the harbor plan first\nsecond line here".length);
    expect(first.entries[1]!.preview).toBe("Harbor plan acknowledged.");
  });

  it("bounds the preview to one collapsed line of 120 characters without splitting surrogates", async () => {
    const { agentDir, file } = mixedSession("preview");
    // Replace entry 0's text with pathological previews by rewriting the file.
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    const header = lines[0]!;
    const longLine = `${"x".repeat(300)}  ${"y".repeat(300)}`;
    const emojiLine = "😀".repeat(100);
    const entries = [
      header,
      JSON.stringify({
        type: "message",
        id: "p-long",
        parentId: null,
        timestamp: timestamp(0),
        message: { role: "user", content: `${longLine}\nquiet tail` },
      }),
      JSON.stringify({
        type: "message",
        id: "p-emoji",
        parentId: "p-long",
        timestamp: timestamp(1),
        message: { role: "user", content: emojiLine },
      }),
    ];
    fs.writeFileSync(file, `${entries.join("\n")}\n`, "utf8");

    const response = await provider(agentDir).invoke("outline", { session: file }, invocation("/work")) as OutlineResponse;
    const long = response.entries[0]!;
    expect(long.preview).toBe(`${`${"x".repeat(300)} y`.slice(0, 119)}…`);
    expect(long.preview.length).toBe(120);
    expect(long.size).toBe(`${longLine}\nquiet tail`.length);
    const emoji = response.entries[1]!;
    expect(emoji.preview.endsWith("…")).toBe(true);
    expect([...emoji.preview.slice(0, -1)].every((grapheme) => grapheme === "😀")).toBe(true);
    expect(emoji.size).toBe(200);
  });

  it("caps rows with maxEntries and reports total plus truncated", async () => {
    const { agentDir, file } = mixedSession("cap");
    const response = await provider(agentDir).invoke(
      "outline",
      { session: file, maxEntries: 2 },
      invocation("/work"),
    ) as OutlineResponse;
    expect(response.entries).toHaveLength(2);
    expect(response.total).toBe(4);
    expect(response.entryCount).toBe(4);
    expect(response.truncated).toBe(true);
    expect(response.entries.map((row) => row.index)).toEqual([0, 1]);
  });

  it("filters the skeleton by exact role", async () => {
    const { agentDir, file } = mixedSession("role");
    const response = await provider(agentDir).invoke(
      "outline",
      { session: file, role: "user" },
      invocation("/work"),
    ) as OutlineResponse;
    expect(response.entries.map((row) => row.index)).toEqual([0]);
    expect(response.entries[0]!.role).toBe("user");
    expect(response.total).toBe(1);
    expect(response.entryCount).toBe(4);
    expect(response.truncated).toBe(false);

    const empty = await provider(agentDir).invoke(
      "outline",
      { session: file, role: "bashExecution" },
      invocation("/work"),
    ) as OutlineResponse;
    expect(empty.entries).toEqual([]);
    expect(empty.total).toBe(0);
    expect(empty.truncated).toBe(false);
  });

  it("refuses a non-string role and reports session_not_found", async () => {
    const { agentDir, file } = mixedSession("guards");
    await expect(
      provider(agentDir).invoke("outline", { session: file, role: 3 }, invocation("/work")),
    ).rejects.toThrow(/role must be a non-empty/);
    const missing = await provider(agentDir).invoke(
      "outline",
      { session: "/nonexistent/session.jsonl" },
      invocation("/work"),
    ) as OutlineResponse;
    expect(missing.error?.code).toBe("session_not_found");
  });
});

describe("expand role filter", () => {
  const longUserSession = (name: string): { agentDir: string; file: string } => {
    const agentDir = temp(`${name}-agent`);
    const cwd = `/work/role-${name}`;
    const entries: FixtureEntry[] = [sessionHeader(`role-${name}`, cwd)];
    let parent: string | null = null;
    for (let index = 0; index < 4; index++) {
      const id = `u${index}`;
      entries.push(messageEntry(id, parent, timestamp(index * 2), userMessage(`user block ${index} ${"q".repeat(800)}`)));
      entries.push(
        messageEntry(`a${index}`, id, timestamp(index * 2 + 1), assistantText(`assistant ack ${index}`, 1_700_000_000_001)),
      );
      parent = `a${index}`;
    }
    const file = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), `${name}.jsonl`, entries);
    return { agentDir, file };
  };

  it("filters the resolved selection before chunking", async () => {
    const { agentDir, file } = longUserSession("filter");
    const page = await provider(agentDir).invoke(
      "expand",
      { session: file, entryRange: { first: 0, last: 7 }, role: "user" },
      invocation("/work"),
    ) as { entries: Array<{ index: number; role: string }>; entryCount: number; next: unknown };
    expect(page.entries.map((entry) => entry.index)).toEqual([0, 2, 4, 6]);
    for (const entry of page.entries) expect(entry.role).toBe("user");
    expect(page.entryCount).toBe(8);
  });

  it("carries the role through the continuation", async () => {
    const { agentDir, file } = longUserSession("continuation");
    const providerInstance = provider(agentDir);
    const page1 = await providerInstance.invoke(
      "expand",
      { session: file, entryRange: { first: 0, last: 7 }, role: "user", maxChars: 1_000 },
      invocation("/work"),
    ) as {
      entries: Array<{ index: number; role: string; textRange: { complete: boolean } }>;
      next: { ref: string; args: Record<string, unknown> } | null;
    };
    expect(page1.entries[0]!.index).toBe(0);
    expect(page1.next).not.toBeNull();
    expect(page1.next!.args.role).toBe("user");
    expect(page1.next!.args.entryRange).toEqual({ first: 0, last: 7 });

    const page2 = await providerInstance.invoke("expand", page1.next!.args, invocation("/work")) as {
      entries: Array<{ index: number; role: string }>;
      next: { args: Record<string, unknown> } | null;
    };
    expect(page2.entries.length).toBeGreaterThan(0);
    for (const entry of page2.entries) expect(entry.role).toBe("user");
    expect(page2.entries[0]!.index).toBe(2);
    // No assistant text leaked into the filtered continuation.
    for (const entry of [...page1.entries, ...page2.entries]) {
      expect(String(entry.role)).not.toBe("assistant");
    }
  });

  it("returns a plain empty view with no continuation when the role matches nothing", async () => {
    const { agentDir, file } = longUserSession("empty");
    const page = await provider(agentDir).invoke(
      "expand",
      { session: file, indices: [0, 1], role: "bashExecution" },
      invocation("/work"),
    ) as { entries: unknown[]; next: unknown; error?: { code: string }; entryCount: number };
    expect(page.entries).toEqual([]);
    expect(page.next).toBeNull();
    expect(page.error).toBeUndefined();
    expect(page.entryCount).toBe(8);
  });

  it("still rejects out-of-bounds indices before the role filter", async () => {
    const { agentDir, file } = longUserSession("bounds");
    const page = await provider(agentDir).invoke(
      "expand",
      { session: file, indices: [99], role: "user" },
      invocation("/work"),
    ) as { entries: unknown[]; error?: { code: string; message: string } };
    expect(page.error?.code).toBe("index_out_of_bounds");
  });
});
