import { describe, expect, it } from "vitest";
import { buildSessionContext, estimateTokens, type SessionEntry, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { compileFabricSummary, fabricCompactionVersion } from "../src/compaction/hook.js";
import { compileFabricBranchSummary } from "../src/compaction/branch-summary.js";
import { normalizeEntries } from "../src/compaction/normalize.js";
import { project, projectWithMetadata } from "../src/compaction/projections.js";
import { recentDialogue } from "../src/compaction/dialogue.js";
import { qaReport } from "../src/compaction/qa.js";
import { decodeCompactionInstructions, encodeCompactionRequest } from "../src/compaction/instructions.js";
import { renderSummary, SUMMARY_SECTIONS } from "../src/compaction/render.js";
import { MAX_SUMMARY_BYTES, utf8Bytes } from "../src/compaction/bounds.js";

type AssistantPart = { type: "text"; text: string } | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: { path: string } };
const text = (value: string): AssistantPart => ({ type: "text", text: value });
const fixture = () => {
  const entries: SessionEntry[] = [];
  const append = (entry: Omit<SessionMessageEntry, "id" | "parentId" | "timestamp"> | { type: "compaction"; summary: string; firstKeptEntryId: string; tokensBefore: number; details?: unknown }) => {
    const result = { ...entry, id: `dialogue-${entries.length}`, parentId: entries.at(-1)?.id ?? null, timestamp: "2026-01-01T00:00:00.000Z" } as SessionEntry;
    entries.push(result);
    return result;
  };
  const user = (content: string) => append({ type: "message", message: { role: "user", content, timestamp: 1 } });
  const assistant = (...content: AssistantPart[]) => append({
    type: "message",
    message: {
      role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: 1,
    },
  });
  const tools = (count: number) => {
    for (let i = 0; i < count; i++) {
      const id = `call-${entries.length}`;
      assistant({ type: "toolCall", id, name: "read", arguments: { path: `src/history-${i}.ts` } });
      append({ type: "message", message: {
        role: "toolResult", toolCallId: id, toolName: "read", isError: false, timestamp: 1,
        content: [{ type: "text", text: "TOOL_PROSE_IS_NOT_A_USER_INSTRUCTION" }],
      } });
    }
  };
  const compile = (instructions?: string) => {
    const result = compileFabricSummary(entries, 100_000, undefined, instructions);
    if (!("compaction" in result)) throw new Error(result.reason);
    return result.compaction;
  };
  return { entries, append, user, assistant, tools, compile };
};

const proposal = [
  "Smallest credible replacement architecture",
  "",
  "Replace the adapter/matcher boundary. Return the existing ScanMatch and OutlineFile contracts.",
  "Preserve existing Fovea normalization and graph behavior.",
  "No graph rewrite, no second normalization layer, no per-fixture parser patches.",
  "",
  "Planning estimate: 2,000–6,000 handwritten runtime lines, excluding tests and generated/parser assets.",
].join("\n");
const reset = "Makes sense. Stash everything and start completely from scratch. No experiment folder this time.\n\n> Replace ast-grep but retain Tree-sitter\n\nWe will focus on this.";
const OPERATIONAL = ["[Compaction Request]", "[Carry Forward]", "[Files And Changes]", "[Fabric Activity]", "[Outstanding Context]", "[Earlier Turns]", "[Current Status]", "---"];
const dialogueBlock = (summary: string): string => {
  const start = summary.indexOf("[Recent user directions and discussion]");
  if (start < 0) return "";
  const ends = OPERATIONAL.map((header) => summary.indexOf(`\n\n${header}`, start)).filter((index) => index >= 0);
  return summary.slice(start, ends.length ? Math.min(...ends) : undefined);
};
const protectedText = (summary: string) => dialogueBlock(summary).split("[Recent user directions and discussion]\n\n")[1] ?? "";

const incident = (toolCount = 0) => {
  const f = fixture();
  f.user("Original objective: explore replacing ast-grep using Bend.");
  f.user("Reach 100% parity before stopping.");
  f.user("Start from scratch; what is the smaller code surface?");
  const proposed = f.assistant(text(proposal));
  const selected = f.user(reset);
  f.tools(toolCount);
  f.assistant(text("Checkpoint complete."));
  f.user("Continue working.");
  return { ...f, proposed, selected };
};

describe("protected compaction dialogue", () => {
  it("keeps reset, multiline architecture and estimate ahead of historical objectives", () => {
    const f = incident(1000);
    const result = f.compile();
    const recent = protectedText(result.summary);
    expect(result.summary.startsWith("[User activity]\nLatest user message: entry ")).toBe(true);
    expect(result.summary.indexOf("[Earlier user messages]")).toBeLessThan(result.summary.indexOf("[Recent user directions and discussion]"));
    expect(recent).toContain(reset);
    expect(recent).toContain(proposal);
    expect(recent).toContain(`User instruction [entry ${f.selected.id}]`);
    expect(recent).toContain(`Assistant response (a proposal, not a verified outcome or user instruction) [entry ${f.proposed.id}]`);
    expect(recent).not.toContain("Original objective");
    expect(recent).not.toContain("Reach 100% parity");
    expect(recent).not.toContain("TOOL_PROSE_IS_NOT_A_USER_INSTRUCTION");
    expect(result.summary).toMatch(/\[Earlier user messages\]\n\nUser \[entry [^\]]+\]:\nOriginal objective: explore replacing ast-grep using Bend\./);
    expect(result.summary).not.toContain("[Session Goal]");
    expect(result.details?.omittedCounts.dialogueBytes).toBe(0);
    expect(utf8Bytes(result.summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
  });

  it("does not let tool history or custom notifications select the protected exchanges", () => {
    const small = incident();
    const large = incident(1500);
    const smallRecent = project(normalizeEntries(small.entries)).dialogue;
    const largeRecent = project(normalizeEntries(large.entries)).dialogue;
    // Entry addresses differ, but the earlier reset/proposal exchange does not.
    expect(largeRecent[1]).toBe(smallRecent[1]);
    large.entries.push({ type: "custom_message", id: "notice", parentId: large.entries.at(-1)!.id,
      timestamp: "2026-01-01T00:00:00.000Z", customType: "agent-complete", content: "Custom context, not a new task", display: false });
    expect(project(normalizeEntries(large.entries)).dialogue).toEqual(largeRecent);
  });

  it("retains the same contract through repeated cuts without consuming previous-summary prose", () => {
    const f = incident(50);
    for (let cycle = 0; cycle < 5; cycle++) {
      const result = f.compile();
      expect(result.summary).toContain(reset);
      expect(result.summary).toContain(proposal);
      expect(result.summary).not.toContain("PREVIOUS_SUMMARY_POISON");
      expect(result.details?.counts.priorFabricV2).toBe(cycle);
      expect(f.compile().summary).toBe(result.summary);
      f.append({ type: "compaction", ...result, summary: `${result.summary}\nPREVIOUS_SUMMARY_POISON` });
      f.tools(50);
    }
  });

  it("pairs a summarized response with a user selection retained raw by Pi", () => {
    const f = fixture();
    f.user("Evaluate a smaller architecture.");
    const answer = f.assistant(text(proposal));
    const selected = f.user(reset);
    f.tools(3);
    const result = f.compile();
    expect(result.firstKeptEntryId).toBe(selected.id);
    expect(result.summary).toContain(proposal);
    expect(result.summary).toContain(`[entry ${answer.id}]`);
    expect(result.summary).toContain(`User instruction [entry ${selected.id}; retained raw]`);
    expect(result.summary).not.toContain(reset);
    const events = normalizeEntries(f.entries);
    const prefix = normalizeEntries(f.entries.slice(0, f.entries.findIndex((e) => e.id === selected.id)));
    expect(qaReport(events, prefix.length, result.summary).failures).toEqual([]);
    f.append({ type: "compaction", ...result });
    const context = buildSessionContext(f.entries).messages;
    expect(context.filter((m) => m.role === "compactionSummary")).toHaveLength(1);
    expect(JSON.stringify(context)).toContain("retain Tree-sitter");
    expect(JSON.stringify(context)).toContain("2,000–6,000");
  });

  it.each([1, 3, 10])("does not spend prefix exchange slots on %i fully raw exchanges", (count) => {
    const f = incident(3);
    const prefix = normalizeEntries(f.entries);
    const expected = projectWithMetadata(prefix).sections.dialogue;
    const boundary = f.entries.length;
    for (let i = 0; i < count; i++) {
      f.assistant(text(`Raw response ${i}`));
      f.user(`Raw reply ${i}`);
    }
    const tail = normalizeEntries(f.entries.slice(boundary));
    expect(projectWithMetadata(prefix, tail).sections.dialogue).toEqual(expected);
    expect(recentDialogue(prefix, tail)).toHaveLength(3);
  });

  it("retains a crossing exchange even after several fully raw exchanges", () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) f.user(`Prefix request ${i}`);
    const answer = f.assistant(text(proposal));
    const boundary = f.entries.length;
    const selected = f.user(reset);
    for (let i = 0; i < 4; i++) {
      f.assistant(text(`Raw response ${i}`));
      f.user(`Raw reply ${i}`);
    }
    const prefix = normalizeEntries(f.entries.slice(0, boundary));
    const tail = normalizeEntries(f.entries.slice(boundary));
    const exchanges = recentDialogue(prefix, tail);
    expect(exchanges.map(({ user }) => user.entryId)).toEqual([f.entries[1]!.id, f.entries[2]!.id, selected.id]);
    expect(exchanges.at(-1)).toMatchObject({ user: { retained: true }, assistant: { entryId: answer.id, retained: false } });
    const dialogue = projectWithMetadata(prefix, tail).sections.dialogue.join("\n");
    expect(dialogue).toContain(proposal);
    expect(dialogue).toContain(`User instruction [entry ${selected.id}; retained raw]`);
    expect(dialogue).not.toContain(reset);
    expect(dialogue).not.toContain("Raw response");
  });

  it("keeps the reset contract when the real continuity cut retains several newer user turns", () => {
    const f = incident(500);
    const rawReplies: SessionEntry[] = [];
    for (let i = 0; i < 3; i++) {
      f.assistant(text(`Raw progress ${i}`));
      rawReplies.push(f.user(`Correction ${i}: stay within the agreed architecture.`));
    }
    const tokensBefore = buildSessionContext(f.entries).messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    const compiled = compileFabricSummary(f.entries, tokensBefore, [], undefined, {
      contextWindow: 200_000, targetContextRatio: 0.65, reserveTokens: 16_384, keepRecentTokens: 1500,
    });
    if (!("compaction" in compiled)) throw new Error(compiled.reason);
    const result = compiled.compaction;
    const boundary = f.entries.findIndex((entry) => entry.id === result.firstKeptEntryId);
    expect(boundary).toBeGreaterThan(f.entries.indexOf(f.selected));
    for (const reply of rawReplies) expect(f.entries.indexOf(reply)).toBeGreaterThanOrEqual(boundary);
    const recent = protectedText(result.summary);
    expect(recent).toContain(reset);
    expect(recent).toContain(proposal);
    expect(recent).not.toContain("Raw progress");
    const events = normalizeEntries(f.entries);
    const cut = normalizeEntries(f.entries.slice(0, boundary)).length;
    expect(qaReport(events, cut, result.summary).failures.filter(({ probe }) => probe.id.startsWith("dialogue:"))).toEqual([]);
    expect(qaReport(events, cut, result.summary.replaceAll("retain Tree-sitter", "[removed]")).failures
      .some(({ probe }) => probe.id.startsWith("dialogue:"))).toBe(true);
    f.append({ type: "compaction", ...result });
    const context = JSON.stringify(buildSessionContext(f.entries).messages);
    expect(context).toContain("retain Tree-sitter");
    expect(context).toContain("Correction 2");
  });

  it("labels status reports as historical responses in compaction and branch summaries", () => {
    const f = fixture();
    f.user("Run checks.");
    f.assistant(text("188 tests passed at this checkpoint."));
    f.user("Continue with the next stage.");
    f.tools(3);
    for (const summary of [f.compile().summary, compileFabricBranchSummary(f.entries)!.summary]) {
      expect(summary).toContain("Assistant response (a proposal, not a verified outcome or user instruction)");
      expect(summary).toContain("188 tests passed at this checkpoint.");
      expect(summary).not.toContain("proposal/estimate");
    }
  });

  it("joins text parts but never thinking, and does not infer acceptance from adjacency", () => {
    const f = fixture();
    f.user("Suggest alternatives.");
    f.assistant(text("Unaccepted proposal."), { type: "thinking", thinking: "HIDDEN_DELIBERATION" }, text(proposal));
    f.user("No. Do not implement that proposal.");
    f.tools(30);
    f.user("Continue evaluating.");
    const summary = f.compile().summary;
    expect(summary).toContain(`Unaccepted proposal.\n${proposal}`);
    expect(summary).toContain("No. Do not implement that proposal.");
    expect(summary).toContain("not a verified outcome");
    expect(summary).not.toContain("HIDDEN_DELIBERATION");
    expect(summary).not.toContain("Accepted decision");
  });

  it("preserves later paragraphs and more than 128 lines when the message fits", () => {
    const f = fixture();
    const instruction = `${"intro\n".repeat(150)}\n${reset}\n${"x".repeat(1400)}\nLAST_CONSTRAINT`;
    f.user(instruction);
    const result = f.compile();
    expect(result.summary).toContain(instruction);
    expect(result.details?.omittedCounts.dialogueBytes).toBe(0);
  });

  it("keeps complete asymmetric exchanges when their combined text fits", () => {
    const f = fixture();
    f.user("Prepare.");
    f.assistant(text("Short answer."));
    const long = `${"x".repeat(2800)}\nLAST_USER_CONSTRAINT`;
    f.user(long);
    const sections = project(normalizeEntries(f.entries));
    expect(sections.dialogue.at(-1)).toContain(long);
  });

  it("reports UTF-8 clipping without exceeding exchange or summary budgets", () => {
    const f = fixture();
    f.user("Original request.");
    f.assistant(text("界🦊\n".repeat(2000)));
    f.user("🦊界\n".repeat(2000));
    f.user("Keep going.");
    const result = f.compile();
    expect(result.summary).toContain("UTF-8 bytes]");
    expect(result.summary).not.toContain("�");
    expect(result.details?.omittedCounts.dialogueBytes).toBeGreaterThan(0);
    expect(utf8Bytes(result.summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    const block = dialogueBlock(result.summary);
    expect(utf8Bytes(block)).toBeLessThanOrEqual(12288);
  });

  it("uses a bounded recency window rather than pretending to retain permanent decisions", () => {
    const f = incident();
    for (let i = 0; i < 5; i++) f.user(`New direction ${i}`);
    const sections = project(normalizeEntries(f.entries));
    expect(sections.dialogue).toHaveLength(3);
    expect(sections.dialogue.join("\n")).not.toContain(reset);
    expect(sections.dialogue.join("\n")).toContain("New direction 4");
  });

  it("fails QA if a later architectural constraint or user choice is removed", () => {
    const f = incident(60);
    const result = f.compile();
    const boundary = f.entries.findIndex((e) => e.id === result.firstKeptEntryId);
    const events = normalizeEntries(f.entries);
    const cut = normalizeEntries(f.entries.slice(0, boundary)).length;
    expect(qaReport(events, cut, result.summary).failures).toEqual([]);
    for (const essential of ["retain Tree-sitter", "no second normalization layer", "2,000–6,000"]) {
      const mutated = result.summary.replaceAll(essential, "[removed]");
      expect(qaReport(events, cut, mutated).failures.some(({ probe }) => probe.id.startsWith("dialogue:"))).toBe(true);
    }
  });

  it("keeps an incident-sized proposal and short selection together in full", () => {
    const f = fixture();
    f.user("Compare the architectures.");
    const longProposal = `${"Context paragraph.\n".repeat(170)}${proposal}`;
    expect(utf8Bytes(longProposal)).toBeGreaterThan(3400);
    f.assistant(text(longProposal));
    f.user(reset);
    f.tools(30);
    f.user("Continue.");
    const result = f.compile();
    expect(result.summary).toContain(longProposal);
    expect(result.summary).toContain(reset);
    expect(result.details?.omittedCounts.dialogueBytes).toBe(0);
  });

  it("keeps old v2 details readable and rejects malformed optional byte counts", () => {
    const details = incident().compile().details!;
    const legacy = structuredClone(details);
    delete legacy.omittedCounts.dialogueBytes;
    delete legacy.instructionPolicy.renderedOmittedBytes;
    expect(fabricCompactionVersion(legacy)).toBe(2);
    expect(fabricCompactionVersion({ ...details, omittedCounts: { ...details.omittedCounts, dialogueBytes: -1 } })).toBeUndefined();
    expect(fabricCompactionVersion({ ...details, instructionPolicy: { ...details.instructionPolicy, renderedOmittedBytes: "bad" } })).toBeUndefined();
  });

  it("does not add a state dependency or increase the summary reservation", () => {
    // Protected user blocks (earlier messages, dialogue, request, carry, user
    // activity) plus the footer leave room for every operational header.
    const protectedCeilings = SUMMARY_SECTIONS.filter(({ key }) => key === "goal" || key === "dialogue")
      .reduce((sum, section) => sum + section.maxBytes, 0) + 3072 + 3072 + 512;
    expect(protectedCeilings + 1536).toBeLessThanOrEqual(29.5 * 1024);
    expect(MAX_SUMMARY_BYTES).toBe(32 * 1024);
    expect(fabricCompactionVersion(incident().compile().details)).toBe(2);
  });
});

describe("explicit request rendering", () => {
  it("retains a valid preserve item beyond the old 1024-byte line cap", () => {
    const f = fixture();
    f.user("Task.");
    const item = `${"x".repeat(1800)} LAST_PRESERVE_CONSTRAINT`;
    const result = f.compile(encodeCompactionRequest({ preserve: [item] }));
    expect(result.summary).toContain(item);
    expect(result.details?.instructionPolicy).toMatchObject({ truncated: false, renderedOmittedBytes: 0 });
  });

  it("reports rendering loss even when decoding itself did not truncate", () => {
    const f = fixture();
    f.user("Task.");
    const request = encodeCompactionRequest({ preserve: Array.from({ length: 6 }, (_, i) => `ITEM_${i}: ${"界".repeat(500)}`) });
    const decoded = decodeCompactionInstructions(request);
    expect(decoded.ok && decoded.policy.truncated).toBe(false);
    const result = f.compile(request);
    expect(result.details?.instructionPolicy.truncated).toBe(true);
    expect(result.details?.instructionPolicy.renderedOmittedBytes).toBeGreaterThan(0);
    expect(result.details?.omittedCounts.preserve).toBe(0); // Every item has an excerpt.
    for (let i = 0; i < 6; i++) expect(result.summary).toContain(`ITEM_${i}:`);
    expect(result.summary).toContain("UTF-8 bytes]");
    expect(utf8Bytes(result.summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    const branch = compileFabricBranchSummary(f.entries, request)!;
    expect(branch.details.request.truncated).toBe(true);
    expect(branch.summary).toContain("UTF-8 bytes]");
  });

  it("keeps explicit preserve one-shot rather than silently adding durable state", () => {
    const f = fixture();
    f.user("Task.");
    const first = f.compile(encodeCompactionRequest({ preserve: ["ONE_SHOT_PIN"] }));
    expect(first.summary).toContain("ONE_SHOT_PIN");
    f.append({ type: "compaction", ...first });
    f.tools(3);
    expect(f.compile().summary).not.toContain("ONE_SHOT_PIN");
  });

  it("bounds all populated sections together while keeping dialogue and the footer", () => {
    const f = incident();
    const sections = project(normalizeEntries(f.entries));
    for (const key of ["goal", "files", "activity", "outstanding", "earlierTurns", "status", "transcript"] as const) {
      sections[key] = Array.from({ length: 200 }, () => "界".repeat(1000));
    }
    const summary = renderSummary(sections, { firstEntryId: "a", lastEntryId: "b", lastTimestamp: "t", requestLines: ["x".repeat(8192)] });
    expect(summary).toContain(reset);
    expect(summary).toContain(proposal);
    expect(summary).toContain("memory.recall");
    expect(utf8Bytes(summary)).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
  });
});
