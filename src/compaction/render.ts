import { boundedExcerpt, clipUtf8, MAX_SUMMARY_BYTES, utf8Bytes } from "./bounds.js";
import type { Sections } from "./projections.js";
import { allocateSummaryBytes } from "../verified/context.js";

// These are per-block ceilings, not reservations. Historical blocks share
// the space left by actual protected content inside the global ceiling.
// The user's words lead, oldest first: earlier messages, then recent exchanges.
// Both are protected blocks that take bytes before any operational section.
export const SUMMARY_SECTIONS: { key: keyof Sections; header: string; maxBytes: number }[] = [
  { key: "goal", header: "[Earlier user messages]", maxBytes: 8192 },
  { key: "dialogue", header: "[Recent user directions and discussion]", maxBytes: 12288 },
  { key: "files", header: "[Files And Changes]", maxBytes: 4608 },
  { key: "activity", header: "[Fabric Activity]", maxBytes: 2048 },
  { key: "outstanding", header: "[Outstanding Context]", maxBytes: 4608 },
  { key: "earlierTurns", header: "[Earlier Turns]", maxBytes: 3072 },
  { key: "status", header: "[Current Status]", maxBytes: 2048 },
];

export const CARRY_FORWARD_HEADER = "[Carry Forward]";
export const USER_ACTIVITY_HEADER = "[User activity]";
const USER_ACTIVITY_MAX_BYTES = 512;

const REQUEST_MAX_BYTES = 3072;
const CARRY_MAX_BYTES = 3072;
const TRANSCRIPT_MAX_BYTES = 5120;
const FOOTER_MAX_BYTES = 1536;
const MAX_INPUT_LINES_PER_SECTION = 128;
const MAX_RENDERED_LINE_BYTES = 1024;

export interface RenderOptions {
  firstEntryId: string;
  lastEntryId: string;
  lastTimestamp: string;
  requestLines?: string[];
  /** Persistent carry-forward focus; rendered in every summary until cleared. */
  carryLines?: string[];
  summaryKind?: "compaction" | "branch";
  /** How long the agent has worked since the latest user message; see userActivityLine. */
  userActivity?: string;
}

const POINTER_LINE =
  "For exact pre-summary history, use memory.recall on this range, then memory.expand by stable entry or operation address.";

const sampledLines = (lines: readonly string[], keep: number): string[] => {
  if (lines.length <= keep) return [...lines];
  const earliest = Math.ceil(keep / 2);
  const latest = Math.floor(keep / 2);
  return [
    ...lines.slice(0, earliest),
    `… omitted ${lines.length - keep} rendered lines`,
    ...lines.slice(lines.length - latest),
  ];
};

const boundedBlock = (header: string, sourceLines: readonly string[], maxBytes: number): string => {
  const clipped = sourceLines.map((line) => clipUtf8(line, MAX_RENDERED_LINE_BYTES));
  const capped = sampledLines(clipped, Math.min(clipped.length, MAX_INPUT_LINES_PER_SECTION));
  for (let keep = capped.length; keep >= 0; keep--) {
    const lines = sampledLines(capped, keep);
    const block = [header, ...lines].join("\n");
    if (utf8Bytes(block) <= maxBytes) return block;
  }
  return clipUtf8(header, maxBytes);
};

interface HistoryBlock {
  header: string;
  lines: readonly string[];
  maxBytes: number;
}

const boundedHistory = (blocks: HistoryBlock[], maxBytes: number): string[] => {
  const candidates = blocks.map((block) => {
    const text = boundedBlock(block.header, block.lines, block.maxBytes);
    const bytes = utf8Bytes(text);
    const minimum = block.lines.length === 1 ? bytes
      : Math.min(bytes, utf8Bytes([block.header, ...sampledLines(block.lines, 0)].join("\n")));
    return { ...block, text, bytes, minimum };
  });
  const total = candidates.reduce((sum, block) => sum + block.bytes, 0);
  if (total <= maxBytes) return candidates.map(({ text }) => text);

  // Reserve headers/omission markers (or complete single-line blocks), then divide
  // remaining space proportionally to capped demand. Sampling slack goes to
  // later blocks rather than being reserved for content we did not render.
  const minimum = candidates.reduce((sum, block) => sum + block.minimum, 0);
  let remaining = maxBytes - minimum;
  let demand = total - minimum;
  return candidates.map((block) => {
    const wanted = block.bytes - block.minimum;
    const extra = demand === 0 ? 0 : Math.min(wanted, Math.floor(remaining * wanted / demand));
    const text = boundedBlock(block.header, block.lines, block.minimum + extra);
    remaining -= utf8Bytes(text) - block.minimum;
    demand -= wanted;
    return text;
  });
};

// Dialogue and explicit requests are not historical line samples. Keep every
// item; only shorten text when the entire block exceeds its byte allocation.
const protectedBlock = (header: string, items: readonly string[], maxBytes: number): { text: string; omittedBytes: number } => {
  const text = [header, ...items].join("\n\n");
  if (utf8Bytes(text) <= maxBytes) return { text, omittedBytes: 0 };
  let remaining = Math.max(0, maxBytes - utf8Bytes(header) - 2 * items.length);
  const share = Math.floor(remaining / items.length);
  const budgets = items.map((item) => Math.min(utf8Bytes(item), share));
  remaining -= budgets.reduce((sum, bytes) => sum + bytes, 0);
  let omittedBytes = 0;
  const excerpts = items.map((item, index) => {
    const extra = Math.min(remaining, utf8Bytes(item) - budgets[index]!);
    remaining -= extra;
    const excerpt = boundedExcerpt(item, budgets[index]! + extra);
    omittedBytes += excerpt.omittedBytes;
    return excerpt.text;
  });
  return { text: [header, ...excerpts].join("\n\n"), omittedBytes };
};

export interface RenderedSummary {
  summary: string;
  requestOmittedBytes: number;
  dialogueOmittedBytes: number;
  carryOmittedBytes: number;
}

export const renderSummaryWithMetadata = (sections: Sections, options: RenderOptions): RenderedSummary => {
  const blocks: string[] = [];
  const history: HistoryBlock[] = [];
  let requestOmittedBytes = 0;
  let dialogueOmittedBytes = 0;
  let carryOmittedBytes = 0;
  const request = (): void => {
    if (options.requestLines?.length) {
      const rendered = protectedBlock("[Compaction Request]", options.requestLines, REQUEST_MAX_BYTES);
      blocks.push(rendered.text);
      requestOmittedBytes = rendered.omittedBytes;
    }
    if (options.carryLines?.length) {
      const rendered = protectedBlock(CARRY_FORWARD_HEADER, options.carryLines, CARRY_MAX_BYTES);
      blocks.push(rendered.text);
      carryOmittedBytes = rendered.omittedBytes;
    }
  };
  if (options.userActivity) {
    blocks.push(clipUtf8(`${USER_ACTIVITY_HEADER}\n${options.userActivity}`, USER_ACTIVITY_MAX_BYTES));
  }
  for (const { key, header, maxBytes } of SUMMARY_SECTIONS) {
    const lines = sections[key];
    if (key === "goal") {
      if (lines.length > 0) {
        const rendered = protectedBlock(header, lines, maxBytes);
        blocks.push(rendered.text);
        dialogueOmittedBytes += rendered.omittedBytes;
      }
    } else if (key === "dialogue") {
      if (lines.length > 0) {
        const rendered = protectedBlock(header, lines, maxBytes);
        blocks.push(rendered.text);
        dialogueOmittedBytes += rendered.omittedBytes;
      }
      request();
    } else if (lines.length > 0) {
      history.push({ header, lines, maxBytes });
    }
  }

  if (sections.transcript.length > 0) {
    history.push({ header: "---", lines: sections.transcript, maxBytes: TRANSCRIPT_MAX_BYTES });
  }

  const timestamp = options.lastTimestamp || "(unknown time)";
  const range = options.firstEntryId || options.lastEntryId
    ? `${options.firstEntryId || "(start)"} → ${options.lastEntryId || "(end)"}`
    : "(no entries)";
  const footer = options.summaryKind === "branch"
    ? `[branch summarized ${timestamp}; structural source entries ${range}]`
    : `[compacted ${timestamp}; cumulative source entries ${range}]`;
  const footerBlock = boundedBlock("---", [footer, POINTER_LINE], FOOTER_MAX_BYTES);
  // Count every separator plus the final newline before allocating history.
  const framingBytes = utf8Bytes(footerBlock) + 2 * (blocks.length + history.length) + 1;
  // The verified allocation gives the user's protected blocks their bytes first;
  // operational history receives only what remains.
  const protectedBytes = blocks.reduce((sum, block) => sum + utf8Bytes(block), 0);
  const historyDemand = history.reduce((sum, block) => sum + utf8Bytes(boundedBlock(block.header, block.lines, block.maxBytes)), 0);
  const allocation = allocateSummaryBytes(Math.max(0, MAX_SUMMARY_BYTES - framingBytes), protectedBytes, historyDemand);
  blocks.push(...boundedHistory(history, allocation.operationBytes), footerBlock);

  const summary = `${blocks.join("\n\n")}\n`;
  return {
    summary: utf8Bytes(summary) <= MAX_SUMMARY_BYTES ? summary : `${clipUtf8(summary, MAX_SUMMARY_BYTES - 1, "")}\n`,
    requestOmittedBytes,
    dialogueOmittedBytes,
    carryOmittedBytes,
  };
};

export const renderSummary = (sections: Sections, options: RenderOptions): string =>
  renderSummaryWithMetadata(sections, options).summary;
