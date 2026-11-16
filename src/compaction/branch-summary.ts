import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { FabricTraceJsonValue } from "../audit/trace.js";
import { clipUtf8, sampleAddressed } from "./bounds.js";
import {
  FABRIC_BRANCH_SUMMARY_KIND,
  FABRIC_BRANCH_RUN_DESCRIPTION_MAX_BYTES,
  FABRIC_BRANCH_RUN_NAME_MAX_BYTES,
  FABRIC_BRANCH_SUMMARY_MAX_BYTES,
  FABRIC_BRANCH_SUMMARY_MAX_FACTS,
  FABRIC_BRANCH_SUMMARY_VERSION,
  type FabricBranchFactV2,
  type FabricBranchOperationFactV1,
  type FabricBranchSummaryDetailsV2,
} from "./branch-details.js";
import { NO_BUILTIN_ENRICHERS, runEnrichers, type CompactionEnricher } from "./enrichers.js";
import { decodeCompactionInstructions } from "./instructions.js";
import { normalizeEntries, type CompactionEvent, type ToolCallEvent } from "./normalize.js";
import { projectWithMetadata } from "./projections.js";
import { renderSummaryWithMetadata, SUMMARY_SECTIONS } from "./render.js";

const asJsonObject = (value: Record<string, unknown>): Record<string, FabricTraceJsonValue> | undefined => {
  try {
    const cloned = JSON.parse(JSON.stringify(value)) as unknown;
    return cloned && typeof cloned === "object" && !Array.isArray(cloned)
      ? cloned as Record<string, FabricTraceJsonValue>
      : undefined;
  } catch {
    return undefined;
  }
};

const directOperationFact = (
  call: ToolCallEvent,
  outcome: "succeeded" | "failed",
  error?: string,
): FabricBranchOperationFactV1 | undefined => {
  if (call.name === "fabric_exec") return undefined;
  const args = asJsonObject(call.args);
  if (!args) return undefined;
  const subordinal = `call:${call.toolCallId}`;
  return {
    kind: "operation",
    entryId: call.entryId,
    subordinal,
    address: `${call.entryId}/${subordinal}`,
    ref: call.name,
    action: call.name,
    tool: call.name,
    args,
    outcome,
    ...(error ? { error: clipUtf8(error, 8 * 1024) } : {}),
  };
};

const factsFromEvents = (events: CompactionEvent[]): FabricBranchFactV2[] => {
  const facts: FabricBranchFactV2[] = [];
  const calls = new Map<string, ToolCallEvent>();
  for (const event of events) {
    if (event.kind === "toolCall") calls.set(event.toolCallId, event);
  }
  for (const event of events) {
    if (event.kind === "user") {
      facts.push({
        kind: "user",
        entryId: event.entryId,
        subordinal: "user",
        address: `${event.entryId}/user`,
        text: clipUtf8(event.text, 2 * 1024),
      });
    } else if (event.kind === "customMessage") {
      facts.push({
        kind: "customMessage",
        entryId: event.entryId,
        subordinal: "custom-message",
        address: `${event.entryId}/custom-message`,
        customType: clipUtf8(event.customType, 256),
        text: clipUtf8(event.text, 4 * 1024),
        display: event.display,
        ...(event.details !== undefined ? { details: event.details } : {}),
      });
    } else if (event.kind === "fabricPhase") {
      facts.push({
        kind: "phase",
        entryId: event.entryId,
        subordinal: event.subordinal,
        address: event.address,
        phase: event.phase,
      });
    } else if (event.kind === "fabricRun") {
      facts.push({
        kind: "fabricRun",
        entryId: event.entryId,
        subordinal: event.subordinal,
        address: event.address,
        name: clipUtf8(event.name, FABRIC_BRANCH_RUN_NAME_MAX_BYTES),
        ...(event.description !== undefined
          ? { description: clipUtf8(event.description, FABRIC_BRANCH_RUN_DESCRIPTION_MAX_BYTES) }
          : {}),
        outcome: event.outcome,
      });
    } else if (event.kind === "fabricOperation") {
      facts.push({
        kind: "operation",
        entryId: event.entryId,
        subordinal: event.subordinal,
        address: event.address,
        ref: event.ref,
        ...(event.provider ? { provider: event.provider } : {}),
        ...(event.action ? { action: event.action } : {}),
        tool: event.tool,
        args: event.args,
        outcome: event.outcome,
        ...(event.error !== undefined ? { error: event.error } : {}),
        ...(event.result !== undefined ? { result: event.result } : {}),
      });
    } else if (event.kind === "toolResult" && event.toolName !== "bash") {
      const call = event.toolCallId ? calls.get(event.toolCallId) : undefined;
      if (!call) continue;
      const fact = directOperationFact(call, event.isError ? "failed" : "succeeded", event.isError ? event.text : undefined);
      if (fact) facts.push(fact);
    } else if (event.kind === "bash") {
      const call = event.toolCallId ? calls.get(event.toolCallId) : undefined;
      if (call) {
        const fact = directOperationFact(call, event.isError ? "failed" : "succeeded", event.error);
        if (fact) facts.push(fact);
      } else {
        const subordinal = "bash";
        facts.push({
          kind: "operation",
          entryId: event.entryId,
          subordinal,
          address: `${event.entryId}/${subordinal}`,
          ref: "bash",
          action: "bash",
          tool: "bash",
          args: { command: event.command },
          outcome: event.isError ? "failed" : "succeeded",
          ...(event.error ? { error: clipUtf8(event.error, 8 * 1024) } : {}),
        });
      }
    }
  }
  return facts;
};

const serializedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

const boundedDetails = (
  sourceEntries: SessionEntry[],
  facts: FabricBranchFactV2[],
  sections: string[],
  request: { text: string; sourceBytes: number; truncated: boolean },
  oldLeafId: string | null,
): FabricBranchSummaryDetailsV2 => {
  const sampled = sampleAddressed(facts, FABRIC_BRANCH_SUMMARY_MAX_FACTS);
  const details: FabricBranchSummaryDetailsV2 = {
    kind: FABRIC_BRANCH_SUMMARY_KIND,
    version: FABRIC_BRANCH_SUMMARY_VERSION,
    source: {
      firstEntryId: sourceEntries[0]?.id ?? "",
      lastEntryId: sourceEntries.at(-1)?.id ?? "",
      entryCount: sourceEntries.length,
      oldLeafId,
    },
    facts: sampled.values,
    omittedFacts: sampled.omitted,
    sections,
    request: {
      text: request.text,
      sourceBytes: request.sourceBytes,
      truncated: request.truncated,
    },
  };
  for (let index = details.facts.length - 1; serializedBytes(details) > FABRIC_BRANCH_SUMMARY_MAX_BYTES && index >= 0; index--) {
    const fact = details.facts[index]!;
    if (fact.kind === "operation" && fact.result !== undefined) delete fact.result;
  }
  while (serializedBytes(details) > FABRIC_BRANCH_SUMMARY_MAX_BYTES && details.facts.length > 0) {
    const middle = Math.floor(details.facts.length / 2);
    details.facts.splice(middle, 1);
    details.omittedFacts += 1;
  }
  return details;
};

export interface FabricBranchSummaryCompilation {
  summary: string;
  details: FabricBranchSummaryDetailsV2;
}

export const compileFabricBranchSummary = (
  entriesToSummarize: SessionEntry[],
  customInstructions?: string,
  enrichers: readonly CompactionEnricher[] = NO_BUILTIN_ENRICHERS,
  oldLeafId: string | null = null,
): FabricBranchSummaryCompilation | undefined => {
  const instructions = decodeCompactionInstructions(customInstructions);
  if (!instructions.ok) return undefined;
  const events = normalizeEntries(entriesToSummarize);
  if (events.length === 0) return undefined;
  const projected = projectWithMetadata(events);
  runEnrichers(enrichers, events, projected.sections);
  const sections = SUMMARY_SECTIONS
    .filter(({ key }) => projected.sections[key].length > 0)
    .map(({ header }) => header);
  if (instructions.requestLines.length > 0) {
    const userBlocks = (projected.sections.goal.length > 0 ? 1 : 0) + (projected.sections.dialogue.length > 0 ? 1 : 0);
    sections.splice(userBlocks, 0, "[Compaction Request]");
  }
  const rendered = renderSummaryWithMetadata(projected.sections, {
    firstEntryId: entriesToSummarize[0]?.id ?? "",
    lastEntryId: entriesToSummarize.at(-1)?.id ?? "",
    lastTimestamp: entriesToSummarize.at(-1)?.timestamp ?? "",
    ...(instructions.requestLines.length > 0 ? { requestLines: instructions.requestLines } : {}),
    summaryKind: "branch",
  });
  const request = {
    text: instructions.requestLines.join("\n"),
    sourceBytes: instructions.policy.sourceBytes,
    truncated: instructions.policy.truncated || rendered.requestOmittedBytes > 0,
  };
  return {
    summary: rendered.summary,
    details: boundedDetails(entriesToSummarize, factsFromEvents(events), sections, request, oldLeafId),
  };
};
