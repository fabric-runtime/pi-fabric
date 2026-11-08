import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FabricTerminalTitle, TERMINAL_TITLE_ENTRY_TYPE } from "../src/ui/terminal-title.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkedHandoffCompaction,
  snapshotHandoffSession,
  writeHandoffSession,
} from "../src/agents/handoff.js";
import type { AgentToolResultMessage } from "../src/agents/types.js";
import { rawContextTokens } from "../src/compaction/hook.js";

const roots: string[] = [];
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistant = (content: Array<Record<string, unknown>>) => ({
  role: "assistant" as const,
  content,
  api: "anthropic",
  provider: "anthropic",
  model: "frontier",
  usage,
  stopReason: content.some((part) => part.type === "toolCall")
    ? "toolUse" as const
    : "stop" as const,
  timestamp: Date.now(),
}) as unknown as Parameters<SessionManager["appendMessage"]>[0];

const outerResult = (toolCallId: string): AgentToolResultMessage => ({
  role: "toolResult",
  toolCallId,
  toolName: "fabric_exec",
  content: [{
    type: "text",
    text: "full Fabric program completed: read, edit one, edit two, tests passed",
  }],
  details: {
    success: true,
    trace: {
      kind: "pi-fabric.execution",
      version: 1,
      operations: ["pi.read", "pi.edit", "pi.edit", "pi.bash"],
    },
  },
  isError: false,
  timestamp: 20,
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("trajectory handoff sessions", () => {
  it("forks through the outer fabric_exec call and appends its finalized native result", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-handoff-"));
    roots.push(root);
    const source = SessionManager.create(root, path.join(root, "source"));
    source.appendMessage({ role: "user", content: "Implement the token guard", timestamp: 1 });
    source.appendMessage(assistant([{ type: "text", text: "I found src/token.ts." }]));
    source.appendMessage({ role: "user", content: "Proceed", timestamp: 2 });
    const activeEntryId = source.appendMessage(
      assistant([
        { type: "thinking", thinking: "Run the complete implementation program." },
        { type: "text", text: "I will implement and verify the change." },
        {
          type: "toolCall",
          id: "outer-fabric-call",
          name: "fabric_exec",
          arguments: {
            code: "await pi.read(...); await pi.edit(...); await pi.edit(...); await pi.bash(...);",
          },
        },
      ]),
    );

    const result = outerResult("outer-fabric-call");
    const seed = snapshotHandoffSession(
      source,
      { provider: "anthropic", id: "frontier" },
      result,
      "outer-fabric-call",
    );
    const sessionFile = writeHandoffSession(seed, root, path.join(root, "child"));
    const child = SessionManager.open(sessionFile);
    const messages = child.buildSessionContext().messages;

    expect(seed.sourceBranchLeafId).toBe(activeEntryId);
    expect(child.getHeader()?.parentSession).toBe(source.getSessionFile());
    expect(child.getSessionId()).not.toBe(source.getSessionId());
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Run the complete implementation program." },
        { type: "text", text: "I will implement and verify the change." },
        {
          type: "toolCall",
          id: "outer-fabric-call",
          name: "fabric_exec",
          arguments: {
            code: "await pi.read(...); await pi.edit(...); await pi.edit(...); await pi.bash(...);",
          },
        },
      ],
    });
    expect(messages[4]).toEqual(result);
    expect(child.getEntries().some((entry) => entry.type === "custom_message")).toBe(false);
    expect(JSON.stringify(messages)).not.toContain("fabric_nested_");
    expect(source.getLeafId()).toBe(activeEntryId);
    expect(source.buildSessionContext().messages.at(-1)?.role).toBe("assistant");
    if (process.platform !== "win32") {
      expect(fs.statSync(sessionFile).mode & 0o777).toBe(0o600);
    }
  });

  it("materializes an in-memory source with the complete outer boundary", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-handoff-"));
    roots.push(root);
    const source = SessionManager.inMemory(root);
    source.appendMessage({ role: "user", content: "Preserve rare fact 43117", timestamp: 1 });
    source.appendMessage(
      assistant([
        { type: "text", text: "Rare fact retained." },
        {
          type: "toolCall",
          id: "outer-in-memory",
          name: "fabric_exec",
          arguments: { code: "await pi.write(...); await pi.bash(...);" },
        },
      ]),
    );

    const result = outerResult("outer-in-memory");
    const seed = snapshotHandoffSession(
      source,
      { provider: "anthropic", id: "frontier" },
      result,
      "outer-in-memory",
    );
    const sessionFile = writeHandoffSession(seed, root, path.join(root, "child"));
    const child = SessionManager.open(sessionFile);

    expect(child.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "Preserve rare fact 43117" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Rare fact retained." },
          { type: "toolCall", name: "fabric_exec" },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "outer-in-memory",
        toolName: "fabric_exec",
        isError: false,
      },
    ]);
    expect(child.getEntries().at(-1)).toMatchObject({
      type: "custom",
      customType: "pi-fabric-handoff",
      data: {
        sourceSessionId: source.getSessionId(),
        boundary: "fabric_exec_end",
      },
    });
  });

  it.each(["persisted", "in-memory"])("keeps terminal-title metadata across a %s trajectory handoff (#384)", (kind) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-title-handoff-"));
    roots.push(root);
    const source = kind === "persisted"
      ? SessionManager.create(root, path.join(root, "source"))
      : SessionManager.inMemory(root);
    source.appendMessage({ role: "user", content: "Implement the guard", timestamp: 1 });
    const activeId = source.appendMessage(assistant([
      { type: "toolCall", id: "outer-title", name: "fabric_exec", arguments: { display: { name: "Implement guard" } } },
    ]));
    // The real title path runs at execute() entry, before trajectory snapshotting.
    const title = new FabricTerminalTitle({
      appendEntry: (type, data) => { source.appendCustomEntry(type, data); },
    }, () => true);
    title.show({ mode: "tui", hasUI: true, ui: { setTitle: () => {} } } as unknown as ExtensionContext, "Implement guard");
    const leafId = source.getLeafId();
    expect(leafId).not.toBe(activeId);
    const result = outerResult("outer-title");
    const seed = snapshotHandoffSession(source, undefined, result, "outer-title");
    expect(seed.sourceBranchLeafId).toBe(leafId);
    const child = SessionManager.open(writeHandoffSession(seed, root, path.join(root, "child")));
    expect(child.buildSessionContext().messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(child.buildSessionContext().messages.at(-1)).toEqual(result);
    expect(child.getEntries()).toContainEqual(expect.objectContaining({
      type: "custom", customType: TERMINAL_TITLE_ENTRY_TYPE, data: { version: 1, title: "Implement guard" },
    }));
    expect(source.getLeafId()).toBe(leafId);
  });

  it.each(["user", "toolResult", "assistant", "custom_message", "compaction", "context_edit"])(
    "does not cross a later %s entry hidden behind title metadata", (kind) => {
      const source = SessionManager.inMemory();
      const activeId = source.appendMessage(assistant([
        { type: "toolCall", id: "outer", name: "fabric_exec", arguments: {} },
      ]));
      if (kind === "user") source.appendMessage({ role: "user", content: "Another task", timestamp: 2 });
      else if (kind === "toolResult") source.appendMessage(outerResult("outer"));
      else if (kind === "assistant") source.appendMessage(assistant([
        { type: "toolCall", id: "different-turn", name: "fabric_exec", arguments: {} },
      ]));
      else if (kind === "custom_message") source.appendCustomMessageEntry("other", "Another task", false);
      else if (kind === "compaction") source.appendCompaction("summary", activeId, 100);
      else source.appendContextEdit(activeId, null);
      source.appendCustomEntry(TERMINAL_TITLE_ENTRY_TYPE, { version: 1, title: "Another title" });
      expect(() => snapshotHandoffSession(source, undefined, outerResult("outer"), "outer"))
        .toThrow(/active fabric_exec assistant turn/);
    },
  );

  it.each([true, false])("rejects cyclic metadata without hanging (self-cycle: %s)", (selfCycle) => {
    const metadata = (id: string, parentId: string) => ({
      type: "custom" as const, id, parentId, timestamp: new Date(0).toISOString(),
      customType: TERMINAL_TITLE_ENTRY_TYPE, data: { title: "Corrupt title" },
    });
    const entries = new Map([
      ["first", metadata("first", selfCycle ? "first" : "second")],
      ["second", metadata("second", "first")],
    ]);
    const source = {
      getLeafId: () => "first",
      getEntry: (id: string) => entries.get(id),
      getBranch: () => { throw new Error("Must reject before collecting the branch"); },
      getSessionFile: () => undefined,
      getSessionId: () => "corrupt-session",
    };
    expect(() => snapshotHandoffSession(source, undefined, outerResult("outer"), "outer"))
      .toThrow("Trajectory handoff encountered cyclic session metadata");
  });

  it("fails rather than forking an incomplete parallel top-level tool batch", () => {
    const source = SessionManager.inMemory();
    source.appendMessage({ role: "user", content: "Do both", timestamp: 1 });
    source.appendMessage(
      assistant([
        { type: "toolCall", id: "outer", name: "fabric_exec", arguments: {} },
        { type: "toolCall", id: "sibling", name: "read", arguments: { path: "x" } },
      ]),
    );

    expect(() =>
      snapshotHandoffSession(
        source,
        { provider: "anthropic", id: "frontier" },
        outerResult("outer"),
        "outer",
      )
    ).toThrow(/only top-level tool call/);
  });

  it("re-signs foreign thinking for an openai-completions reasoning executor", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-handoff-"));
    roots.push(root);
    const source = SessionManager.inMemory(root);
    source.appendMessage({ role: "user", content: "Implement the guard", timestamp: 1 });
    const activeEntryId = source.appendMessage(
      assistant([
        {
          type: "thinking",
          thinking: "**Plan the token guard**\n\nsteps",
          thinkingSignature: '{"id":"rs_blob","type":"reasoning","encrypted_content":"gAAA"}',
        },
        { type: "text", text: "Implementing now." },
        {
          type: "toolCall",
          id: "outer-transfer",
          name: "fabric_exec",
          arguments: { code: "await pi.edit(...);" },
        },
      ]),
    );

    const seed = snapshotHandoffSession(
      source,
      { provider: "openai-codex", id: "gpt-5.6-sol" },
      outerResult("outer-transfer"),
      "outer-transfer",
    );
    const sessionFile = writeHandoffSession(seed, root, path.join(root, "child"), {
      source: { provider: "openai-codex", modelId: "gpt-5.6-sol", api: "openai-responses" },
      target: {
        provider: "neuralwatt",
        modelId: "kimi-k3",
        api: "openai-completions",
        reasoning: true,
      },
    });
    const child = SessionManager.open(sessionFile);

    const assistantMessage = child
      .buildSessionContext()
      .messages.find((message) => message.role === "assistant");
    const content = (assistantMessage as unknown as { content: Array<Record<string, unknown>> }).content;
    expect(content).toContainEqual(
      expect.objectContaining({ type: "thinking", thinkingSignature: "reasoning_content" }),
    );
    expect(child.getEntries().some((entry) => entry.type === "custom_message")).toBe(false);
    expect(child.getEntries().at(-1)).toMatchObject({
      type: "custom",
      customType: "pi-fabric-handoff",
      data: {
        thinkingTransfer: {
          policy: "re-signed",
          translated: 1,
          dropped: 0,
          target: "neuralwatt/kimi-k3",
        },
      },
    });
    expect(source.getLeafId()).toBe(activeEntryId);
  });

  it("strips foreign thinking and appends a digest for an incompatible executor", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-handoff-"));
    roots.push(root);
    const source = SessionManager.create(root, path.join(root, "source"));
    source.appendMessage({ role: "user", content: "Implement the guard", timestamp: 1 });
    const activeEntryId = source.appendMessage({
      ...assistant([
        {
          type: "thinking",
          thinking: "**Plan the token guard**\n\nsteps",
          thinkingSignature: '{"id":"rs_blob","type":"reasoning","encrypted_content":"gAAA"}',
        },
        { type: "text", text: "Implementing now." },
        {
          type: "toolCall",
          id: "outer-strip",
          name: "fabric_exec",
          arguments: { code: "await pi.edit(...);" },
        },
      ]),
      // The transfer below declares openai-codex/gpt-5.6-sol as the thinking
      // source, and the rs_blob signature is a Codex Responses item: keep the
      // message metadata honest so the source-scoped digest can attribute it.
      api: "openai-responses",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
    } as Parameters<SessionManager["appendMessage"]>[0]);

    const seed = snapshotHandoffSession(
      source,
      { provider: "openai-codex", id: "gpt-5.6-sol" },
      outerResult("outer-strip"),
      "outer-strip",
    );
    const sessionFile = writeHandoffSession(seed, root, path.join(root, "child"), {
      source: { provider: "openai-codex", modelId: "gpt-5.6-sol", api: "openai-responses" },
      target: {
        provider: "anthropic",
        modelId: "executor",
        api: "anthropic-messages",
        reasoning: true,
      },
    });
    const child = SessionManager.open(sessionFile);

    const messages = child.buildSessionContext().messages;
    for (const message of messages) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      expect(
        message.content.some((part) => (part as { type?: string }).type === "thinking"),
      ).toBe(false);
    }
    const digest = child
      .getEntries()
      .find((entry) => entry.type === "custom_message");
    expect(digest).toMatchObject({
      customType: "pi-fabric-handoff-thinking",
      display: false,
      details: { policy: "stripped", citedBlocks: 1 },
    });
    expect(JSON.stringify(digest)).toContain(`[entry ${activeEntryId}]`);
    expect(JSON.stringify(digest)).toContain("Plan the token guard");
    expect(child.getEntries().at(-1)).toMatchObject({
      type: "custom",
      customType: "pi-fabric-handoff",
      data: {
        sourceSessionId: source.getSessionId(),
        boundary: "fabric_exec_end",
        thinkingTransfer: {
          policy: "stripped",
          translated: 0,
          dropped: 1,
          target: "anthropic/executor",
        },
      },
    });
    expect(child.getHeader()?.parentSession).toBe(source.getSessionFile());
  });

  it("compacts the inherited trajectory with Fabric's deterministic compactor", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-handoff-"));
    roots.push(root);
    const source = SessionManager.create(root, path.join(root, "source"));
    source.appendMessage({ role: "user", content: "Implement the token guard 43117", timestamp: 1 });
    source.appendMessage(
      assistant([
        {
          type: "text",
          text: `Scratched src/token.ts internals at length. ${"filler ".repeat(30)}SCRATCH_TAIL_99231`,
        },
      ]),
    );
    const proceedEntryId = source.appendMessage({ role: "user", content: "Proceed", timestamp: 2 });
    source.appendMessage(
      assistant([
        { type: "text", text: "Continuing at the boundary." },
        {
          type: "toolCall",
          id: "outer-compact",
          name: "fabric_exec",
          arguments: { code: "await pi.edit(...);" },
        },
      ]),
    );

    const result = outerResult("outer-compact");
    const seed = snapshotHandoffSession(
      source,
      { provider: "anthropic", id: "frontier" },
      result,
      "outer-compact",
    );
    const sessionFile = writeHandoffSession(seed, root, path.join(root, "child"), undefined, {
      instructions: "Focus on the guard outcome.",
      preserve: ["Threshold is 90 percent of the context window"],
    });
    const child = SessionManager.open(sessionFile);
    const messages = child.buildSessionContext().messages;

    expect(messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "assistant",
      "toolResult",
    ]);
    const summary = JSON.stringify(messages[0]);
    expect(summary).toContain("[Recent user directions and discussion]");
    expect(summary).toContain("Implement the token guard 43117");
    expect(summary).toContain("[Compaction Request]");
    expect(summary).toContain("Threshold is 90 percent of the context window");
    // This is visible assistant text, not thinking: the response preceding
    // the raw user reply now survives in full when it fits the dialogue budget.
    expect(summary).toContain("SCRATCH_TAIL_99231");
    expect(summary).toContain("not a verified outcome");
    // The append-only file still retains the original branch beneath the marker.
    expect(
      child.getEntries().some((entry) => JSON.stringify(entry).includes("SCRATCH_TAIL_99231")),
    ).toBe(true);
    const compactionEntry = child.getEntries().find((entry) => entry.type === "compaction");
    expect(compactionEntry).toMatchObject({
      type: "compaction",
      fromHook: true,
      firstKeptEntryId: proceedEntryId,
    });
    expect(
      (compactionEntry as { details?: Record<string, unknown> } | undefined)?.details,
    ).toMatchObject({ compactor: "fabric", version: 2 });
    expect(child.getEntries().at(-1)).toMatchObject({
      type: "custom",
      customType: "pi-fabric-handoff",
      data: { compaction: { applied: true, firstKeptEntryId: proceedEntryId } },
    });
    expect(messages.at(-1)).toEqual(result);
  });

  it("bounds huge trajectories through repeated compacted handoffs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-handoff-bounds-"));
    roots.push(root);
    let source = SessionManager.inMemory(root);
    source.appendMessage({ role: "user", content: "Retain the architectural boundary.", timestamp: 1 });
    for (let cycle = 0; cycle < 4; cycle++) {
      for (let i = 0; i < 32; i++) source.appendMessage(assistant([{ type: "text", text: `Work ${i}: ${"x".repeat(16_000)}` }]));
      const id = `outer-cycle-${cycle}`;
      source.appendMessage(assistant([{ type: "toolCall", id, name: "fabric_exec", arguments: {} }]));
      const seed = snapshotHandoffSession(source, undefined, outerResult(id), id);
      const child = SessionManager.open(writeHandoffSession(seed, root, path.join(root, `child-${cycle}`), undefined, {}));
      const messages = child.buildSessionContext().messages;
      expect(messages.filter(m => m.role === "compactionSummary")).toHaveLength(1);
      expect(rawContextTokens(child.getBranch())).toBeLessThan(30_000);
      expect(messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: id });
      expect(JSON.stringify(messages)).toContain(`\"id\":\"${id}\"`);
      expect(child.getBranch().filter(e => e.type === "compaction")).toHaveLength(cycle + 1);
      source = child;
    }
  });

  it("budgets the finalized outer result and never leaves its result orphaned", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-handoff-result-"));
    roots.push(root);
    const source = SessionManager.inMemory(root);
    source.appendMessage({ role: "user", content: "Read a large result.", timestamp: 1 });
    source.appendMessage(assistant([{ type: "toolCall", id: "huge-result", name: "fabric_exec", arguments: {} }]));
    const result = outerResult("huge-result");
    result.content = [{ type: "text", text: "x".repeat(500_000) }];
    const seed = snapshotHandoffSession(source, undefined, result, "huge-result");
    const child = SessionManager.open(writeHandoffSession(seed, root, path.join(root, "child"), undefined, {}));
    expect(rawContextTokens(child.getBranch())).toBeLessThan(30_000);
    expect(child.buildSessionContext().messages.map(m => m.role)).toEqual(["compactionSummary"]);
    expect(child.getBranch().some(e => e.type === "message" && e.message.role === "toolResult")).toBe(true);
    expect(source.getBranch().some(e => e.type === "compaction")).toBe(false);
  });

  it("includes thinking-transfer digests in the budget and compacted prefix", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-handoff-digest-budget-"));
    roots.push(root);
    const source = SessionManager.inMemory(root);
    source.appendMessage({ role: "user", content: `Implement the guard. ${"x".repeat(60_000)}`, timestamp: 1 });
    source.appendMessage(assistant([
      { type: "thinking", thinking: "Plan the token guard", thinkingSignature: "opaque" },
      { type: "toolCall", id: "digest-budget", name: "fabric_exec", arguments: {} },
    ]));
    const seed = snapshotHandoffSession(source, undefined, outerResult("digest-budget"), "digest-budget");
    const child = SessionManager.open(writeHandoffSession(seed, root, path.join(root, "child"), {
      source: { provider: "anthropic", modelId: "frontier", api: "anthropic-messages" },
      target: { provider: "openai", modelId: "executor", api: "openai-responses", reasoning: true },
    }, {}, { contextWindow: 200_000, targetContextRatio: 0.65, reserveTokens: 16384, keepRecentTokens: 0 }));
    const entries = child.getBranch();
    const digest = entries.findIndex(e => e.type === "custom_message" && e.customType === "pi-fabric-handoff-thinking");
    const marker = entries.findIndex(e => e.type === "compaction");
    expect(digest).toBeGreaterThan(-1);
    expect(digest).toBeLessThan(marker);
    expect(entries[marker]).toMatchObject({ tokensBefore: rawContextTokens(entries.slice(0, marker)), details: { budget: { retainedRawTokens: 0 } } });
    expect(child.buildSessionContext().messages.map(m => m.role)).toEqual(["compactionSummary"]);
  });

  it("uses destination limits without calibrating from foreign model usage", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-handoff-budget-"));
    roots.push(root);
    const source = SessionManager.inMemory(root);
    source.appendMessage({ role: "user", content: "Continue the bounded task.", timestamp: 1 });
    for (let i = 0; i < 40; i++) {
      const message = assistant([{ type: "text", text: "x".repeat(16_000) }]);
      if (message.role === "assistant") message.usage = { ...usage, input: (i + 1) * 1000, totalTokens: (i + 1) * 1000 };
      source.appendMessage(message);
    }
    source.appendMessage(assistant([{ type: "toolCall", id: "target-budget", name: "fabric_exec", arguments: {} }]));
    const seed = snapshotHandoffSession(source, undefined, outerResult("target-budget"), "target-budget");
    const child = SessionManager.open(writeHandoffSession(seed, root, path.join(root, "child"), undefined, {}, { contextWindow: 40_000, targetContextRatio: 0.5, reserveTokens: 5000, keepRecentTokens: 2500 }));
    const marker = child.getBranch().find(e => e.type === "compaction");
    expect(marker).toMatchObject({ details: { budget: { contextWindow: 40_000, keepRecentTokens: 2500, rawTailTokenBudget: 2500, tokenScale: 1, fixedOverheadTokens: 0 } } });
    expect(rawContextTokens(child.getBranch())).toBeLessThan(11_000);
    expect(() => writeHandoffSession(seed, root, path.join(root, "too-small"), undefined, {}, { contextWindow: 10, targetContextRatio: 0.5, reserveTokens: 5, keepRecentTokens: 0 })).toThrow("Handoff compaction cancelled");
  });

  it("applies the default compaction for a bare compact request", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-handoff-"));
    roots.push(root);
    const source = SessionManager.inMemory(root);
    source.appendMessage({ role: "user", content: "Preserve rare fact 43117", timestamp: 1 });
    source.appendMessage(
      assistant([{ type: "text", text: "Scratch exploration 99231." }]),
    );
    source.appendMessage({ role: "user", content: "Proceed", timestamp: 2 });
    source.appendMessage(
      assistant([
        {
          type: "toolCall",
          id: "outer-bare-compact",
          name: "fabric_exec",
          arguments: { code: "await pi.write(...);" },
        },
      ]),
    );

    const seed = snapshotHandoffSession(
      source,
      { provider: "anthropic", id: "frontier" },
      outerResult("outer-bare-compact"),
      "outer-bare-compact",
    );
    const sessionFile = writeHandoffSession(seed, root, path.join(root, "child"), undefined, {});
    const child = SessionManager.open(sessionFile);
    const messages = child.buildSessionContext().messages;

    expect(messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(JSON.stringify(messages[0])).not.toContain("[Compaction Request]");
    expect(child.getEntries().at(-1)).toMatchObject({
      type: "custom",
      customType: "pi-fabric-handoff",
      data: { compaction: { applied: true } },
    });
  });

  it("summarizes the whole trajectory when no turn boundary qualifies to keep", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-handoff-"));
    roots.push(root);
    const source = SessionManager.inMemory(root);
    source.appendMessage(
      assistant([
        { type: "text", text: "Single-turn scratch 99231." },
        {
          type: "toolCall",
          id: "outer-skip-compact",
          name: "fabric_exec",
          arguments: { code: "await pi.read(...);" },
        },
      ]),
    );

    const seed = snapshotHandoffSession(
      source,
      undefined,
      outerResult("outer-skip-compact"),
      "outer-skip-compact",
    );
    const sessionFile = writeHandoffSession(seed, root, path.join(root, "child"), undefined, {});
    const child = SessionManager.open(sessionFile);

    const compactionEntry = child.getEntries().find((entry) => entry.type === "compaction");
    expect(compactionEntry).toMatchObject({
      type: "compaction",
      fromHook: true,
      firstKeptEntryId: "",
    });
    expect(child.buildSessionContext().messages.map((message) => message.role)).toEqual([
      "compactionSummary",
    ]);
    expect(child.getEntries().at(-1)).toMatchObject({
      type: "custom",
      customType: "pi-fabric-handoff",
      data: { compaction: { applied: true } },
    });
  });
});

describe("checkedHandoffCompaction", () => {
  it("normalizes and bounds-checks the agents.handoff compact option", () => {
    expect(checkedHandoffCompaction(undefined)).toBeUndefined();
    expect(checkedHandoffCompaction(false)).toBeUndefined();
    expect(checkedHandoffCompaction(true)).toEqual({});
    expect(checkedHandoffCompaction({ instructions: "x", preserve: ["a"] })).toEqual({
      instructions: "x",
      preserve: ["a"],
    });
    expect(() => checkedHandoffCompaction("yes")).toThrow(/must be true or an object/);
    expect(() => checkedHandoffCompaction({ instructions: 5 })).toThrow(
      /instructions must be a string/,
    );
    expect(() => checkedHandoffCompaction({ preserve: "a" })).toThrow(/array of strings/);
    expect(() => checkedHandoffCompaction({ instructions: "x".repeat(9 * 1024) })).toThrow(
      /exceed/,
    );
    expect(() =>
      checkedHandoffCompaction({
        preserve: Array.from({ length: 17 }, (_, index) => String(index)),
      })
    ).toThrow(/exceeds 16 items/);
  });
});
