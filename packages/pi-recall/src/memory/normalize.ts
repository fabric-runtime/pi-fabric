import fs from "node:fs";
import type { FabricExecutionOutcomeV1, FabricTraceJsonValue } from "../audit/trace.js";
import {
  readFabricBranchSummaryDetails,
  type FabricBranchFactV2,
} from "../compaction/branch-details.js";
import { readFabricProjectionTrace } from "../compaction/trace-events.js";
import type { SessionLineage } from "./lineage.js";
import { lineageSelected } from "../verified/policy.js";

export interface MemoryIndexPrivacyPolicy {
  indexThinking: boolean;
  indexToolOutput: boolean;
}

export const DEFAULT_MEMORY_INDEX_PRIVACY: MemoryIndexPrivacyPolicy = {
  indexThinking: false,
  indexToolOutput: true,
};

export interface NormalizeSessionOptions extends Partial<MemoryIndexPrivacyPolicy> {
  lineage?: SessionLineage;
}

const privacyPolicy = (options: NormalizeSessionOptions = {}): MemoryIndexPrivacyPolicy => ({
  indexThinking: options.indexThinking ?? DEFAULT_MEMORY_INDEX_PRIVACY.indexThinking,
  indexToolOutput: options.indexToolOutput ?? DEFAULT_MEMORY_INDEX_PRIVACY.indexToolOutput,
});

/**
 * A typed, structure-derived projection of one session JSONL line.
 *
 * Text is truncated to `maxEntryChars` for index storage; the full untruncated
 * text remains addressable via {@link expandSession} / `memory.expand`, which
 * re-reads the source line on demand. The `index` is the dense position of the
 * entry among normalized entries within its session (0-based), so it stays
 * stable across re-parse and can address the same line on expand.
 */
export interface NormalizedEntry {
  sessionFile: string;
  sessionId: string;
  index: number;
  entryId: string | null;
  parentId: string | null;
  type: string;
  role: string | null;
  toolName: string | null;
  text: string;
  timestamp: number | null;
  isError: boolean;
  truncated: boolean;
  filesTouched?: string[];
  parentEntryId?: string | null;
  operationAddress?: string;
  ref?: string;
  provider?: string;
  action?: string;
  outcome?: FabricExecutionOutcomeV1;
  operation?: NormalizedFabricOperation;
  branchFact?: NormalizedFabricBranchFact;
  factAddress?: string;
  carrierEntryId?: string;
  carrierParentId?: string | null;
  carrierFromId?: string | null;
}

interface NormalizedFabricOperation {
  address: string;
  parentEntryId: string;
  sequence?: number;
  subordinal?: string;
  tool: string;
  ref: string;
  provider?: string;
  action?: string;
  args: Record<string, FabricTraceJsonValue>;
  outcome: FabricExecutionOutcomeV1;
  error?: string;
  result?: FabricTraceJsonValue;
  resultOmitted?: boolean;
}

interface NormalizedFabricBranchFact {
  kind: FabricBranchFactV2["kind"];
  address: string;
  entryId: string;
  subordinal: string;
  carrierEntryId: string;
  carrierParentId: string | null;
  carrierFromId: string | null;
  text?: string;
  customType?: string;
  display?: boolean;
  phase?: string;
  name?: string;
  description?: string;
  ref?: string;
  provider?: string;
  action?: string;
  tool?: string;
  args?: Record<string, FabricTraceJsonValue>;
  outcome?: FabricExecutionOutcomeV1;
  error?: string;
  result?: FabricTraceJsonValue;
}

export interface NormalizationCoverage {
  complete: boolean;
  reasons: string[];
}

export interface SessionHeaderInfo {
  sessionId: string;
  cwd: string;
  parentSession?: string;
}

const truncate = (text: string, max: number): { text: string; truncated: boolean } => {
  const scalarLimit = Math.max(0, Math.floor(max));
  if (scalarLimit >= text.length) return { text, truncated: false };
  let scalarCount = 0;
  let utf16End = 0;
  for (const scalar of text) {
    if (scalarCount >= scalarLimit) return { text: text.slice(0, utf16End), truncated: true };
    utf16End += scalar.length;
    scalarCount += 1;
  }
  return { text, truncated: false };
};

const asString = (value: unknown): string =>
  typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);

const joinTextParts = (parts: unknown[]): string => {
  const out: string[] = [];
  for (const part of parts) {
    if (part === null || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      out.push(record.text);
    }
  }
  return out.join("\n");
};

const summarizeArgs = (args: unknown, max = 400): string => {
  let serialized: string;
  try {
    serialized = JSON.stringify(args) ?? "";
  } catch {
    serialized = String(args);
  }
  const bounded = truncate(serialized, max);
  return bounded.truncated ? `${bounded.text}…` : bounded.text;
};

const collectPathArguments = (value: unknown, key: string | null, paths: string[]): void => {
  if (typeof value === "string") {
    if (key !== null && /(?:file|path)s?$/i.test(key) && value.trim()) paths.push(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathArguments(item, key, paths);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    collectPathArguments(childValue, childKey, paths);
  }
};

const extractFilesTouched = (raw: Record<string, unknown>): string[] => {
  if (asString(raw.type) !== "message") return [];
  const message = raw.message as Record<string, unknown> | undefined;
  if (!message || asString(message.role) !== "assistant" || !Array.isArray(message.content)) return [];
  const paths: string[] = [];
  for (const block of message.content) {
    if (block === null || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type === "toolCall") collectPathArguments(record.arguments, null, paths);
  }
  return [...new Set(paths)];
};

const TRACE_OPERATION_MAX_BYTES = 96 * 1024;
const PI_FILE_REFS = new Set(["pi.read", "pi.grep", "pi.find", "pi.ls", "pi.edit", "pi.write"]);

const traceFilesTouched = (ref: string, tool: string, args: Record<string, FabricTraceJsonValue>): string[] => {
  if (!PI_FILE_REFS.has(ref) || ref !== `pi.${tool}`) return [];
  const path = args.path ?? args.file ?? args.dir;
  return typeof path === "string" && path.trim() ? [path.trim()] : [];
};

const boundedTraceOperation = (
  parentEntryId: string,
  operation: NonNullable<ReturnType<typeof readFabricProjectionTrace>>["operations"][number],
  includeToolOutput: boolean,
): NormalizedFabricOperation => {
  const address = `${parentEntryId}/${operation.sequence}`;
  const normalized: NormalizedFabricOperation = {
    address,
    parentEntryId,
    sequence: operation.sequence,
    tool: operation.tool,
    ref: operation.ref,
    ...(operation.provider ? { provider: operation.provider } : {}),
    ...(operation.action ? { action: operation.action } : {}),
    args: operation.args,
    outcome: operation.outcome,
    ...(operation.error !== undefined ? { error: operation.error } : {}),
    ...(includeToolOutput && operation.result !== undefined ? { result: operation.result } : {}),
    ...(!includeToolOutput && operation.result !== undefined ? { resultOmitted: true } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > TRACE_OPERATION_MAX_BYTES && normalized.result !== undefined) {
    delete normalized.result;
    normalized.resultOmitted = true;
  }
  return normalized;
};

const traceChildren = (
  raw: Record<string, unknown>,
  base: Omit<NormalizedEntry, "index">,
  policy: MemoryIndexPrivacyPolicy,
): Array<Omit<NormalizedEntry, "index">> => {
  if (base.type !== "message" || base.role !== "toolResult" || base.toolName !== "fabric_exec") return [];
  const message = raw.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return [];
  const nested = readFabricProjectionTrace((message as Record<string, unknown>).details);
  if (!nested || nested.source !== "trace" || base.entryId === null) return [];
  return nested.operations.map((operation) => {
    const normalized = boundedTraceOperation(base.entryId!, operation, policy.indexToolOutput);
    const filesTouched = traceFilesTouched(normalized.ref, normalized.tool, normalized.args);
    const text = `Fabric operation ${normalized.ref}\n${JSON.stringify(normalized)}`;
    return {
      sessionFile: base.sessionFile,
      sessionId: base.sessionId,
      entryId: normalized.address,
      parentId: base.parentId,
      type: "fabric_operation",
      role: "fabricOperation",
      toolName: normalized.tool,
      text,
      timestamp: base.timestamp,
      isError: normalized.outcome !== "succeeded",
      truncated: false,
      parentEntryId: base.entryId,
      operationAddress: normalized.address,
      ref: normalized.ref,
      ...(normalized.provider ? { provider: normalized.provider } : {}),
      ...(normalized.action ? { action: normalized.action } : {}),
      outcome: normalized.outcome,
      operation: normalized,
      ...(filesTouched.length > 0 ? { filesTouched } : {}),
    };
  });
};

const branchDetails = (raw: Record<string, unknown>) => {
  const type = asString(raw.type);
  const message = raw.message;
  const messageRecord = message && typeof message === "object" && !Array.isArray(message)
    ? message as Record<string, unknown>
    : undefined;
  if (type !== "branch_summary" && !(type === "message" && asString(messageRecord?.role) === "branchSummary")) {
    return undefined;
  }
  return readFabricBranchSummaryDetails(raw.details)
    ?? readFabricBranchSummaryDetails(messageRecord?.details);
};

const branchFilesTouched = (fact: Extract<FabricBranchFactV2, { kind: "operation" }>): string[] => {
  const paths: string[] = [];
  collectPathArguments(fact.args, null, paths);
  return [...new Set(paths)];
};

const branchFactChild = (
  fact: FabricBranchFactV2,
  base: Omit<NormalizedEntry, "index">,
  carrierFromId: string | null,
  policy: MemoryIndexPrivacyPolicy,
): Omit<NormalizedEntry, "index"> => {
  const carrierEntryId = base.entryId!;
  const carrierParentId = base.parentId;
  const common: Omit<NormalizedEntry, "index" | "text" | "role" | "toolName" | "isError"> = {
    sessionFile: base.sessionFile,
    sessionId: base.sessionId,
    entryId: fact.address,
    parentId: base.parentId,
    type: "fabric_branch_fact",
    timestamp: base.timestamp,
    truncated: false,
    parentEntryId: carrierEntryId,
    factAddress: fact.address,
    carrierEntryId,
    carrierParentId,
    carrierFromId,
  };
  const normalizedFact: NormalizedFabricBranchFact = {
    kind: fact.kind,
    address: fact.address,
    entryId: fact.entryId,
    subordinal: fact.subordinal,
    carrierEntryId,
    carrierParentId,
    carrierFromId,
    ...(fact.kind === "user" ? { text: fact.text } : {}),
    ...(fact.kind === "customMessage" ? {
      text: fact.text,
      customType: fact.customType,
      display: fact.display,
    } : {}),
    ...(fact.kind === "phase" ? { phase: fact.phase } : {}),
    ...(fact.kind === "fabricRun" ? {
      name: fact.name,
      ...(fact.description !== undefined ? { description: fact.description } : {}),
      outcome: fact.outcome,
    } : {}),
    ...(fact.kind === "operation" ? {
      ref: fact.ref,
      ...(fact.provider ? { provider: fact.provider } : {}),
      ...(fact.action ? { action: fact.action } : {}),
      tool: fact.tool,
      args: fact.args,
      outcome: fact.outcome,
      ...(fact.error !== undefined ? { error: fact.error } : {}),
      ...(policy.indexToolOutput && fact.result !== undefined ? { result: fact.result } : {}),
    } : {}),
  };
  if (fact.kind === "user") {
    return {
      ...common,
      role: "branchUser",
      toolName: null,
      text: fact.text,
      isError: false,
      branchFact: normalizedFact,
    };
  }
  if (fact.kind === "customMessage") {
    return {
      ...common,
      role: "branchCustomMessage",
      toolName: null,
      text: fact.customType ? `[${fact.customType}] ${fact.text}` : fact.text,
      isError: false,
      branchFact: normalizedFact,
    };
  }
  if (fact.kind === "phase") {
    return {
      ...common,
      role: "fabricPhase",
      toolName: null,
      text: `Fabric phase ${fact.phase}`,
      isError: false,
      branchFact: normalizedFact,
    };
  }
  if (fact.kind === "fabricRun") {
    const description = fact.description ? ` — ${fact.description}` : "";
    return {
      ...common,
      role: "fabricRun",
      toolName: "fabric_exec",
      text: `Fabric run ${fact.name}${description} → ${fact.outcome}`,
      isError: fact.outcome !== "succeeded",
      operationAddress: fact.address,
      ref: "fabric_exec",
      outcome: fact.outcome,
      branchFact: normalizedFact,
    };
  }
  const operation: NormalizedFabricOperation = {
    address: fact.address,
    parentEntryId: fact.entryId,
    subordinal: fact.subordinal,
    tool: fact.tool,
    ref: fact.ref,
    ...(fact.provider ? { provider: fact.provider } : {}),
    ...(fact.action ? { action: fact.action } : {}),
    args: fact.args,
    outcome: fact.outcome,
    ...(fact.error !== undefined ? { error: fact.error } : {}),
    ...(policy.indexToolOutput && fact.result !== undefined ? { result: fact.result } : {}),
    ...(!policy.indexToolOutput && fact.result !== undefined ? { resultOmitted: true } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(operation), "utf8") > TRACE_OPERATION_MAX_BYTES && operation.result !== undefined) {
    delete operation.result;
    operation.resultOmitted = true;
  }
  const filesTouched = branchFilesTouched(fact);
  return {
    ...common,
    role: "fabricOperation",
    toolName: fact.tool,
    text: `Fabric branch operation ${fact.ref}\n${JSON.stringify(operation)}`,
    isError: fact.outcome !== "succeeded",
    operationAddress: fact.address,
    ref: fact.ref,
    ...(fact.provider ? { provider: fact.provider } : {}),
    ...(fact.action ? { action: fact.action } : {}),
    outcome: fact.outcome,
    operation,
    branchFact: normalizedFact,
    ...(filesTouched.length > 0 ? { filesTouched } : {}),
  };
};

/**
 * Extract searchable text from a parsed JSONL entry, structurally — from the
 * typed message content arrays, tool-call name + args, tool-result content,
 * and bashExecution command + output. No regex over prose lives here.
 */
export const extractFullText = (
  raw: Record<string, unknown>,
  options: NormalizeSessionOptions = {},
): string => {
  const policy = privacyPolicy(options);
  const type = asString(raw.type);
  if (type === "message") {
    const message = raw.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") return "";
    const role = asString(message.role);
    const content = message.content;
    if (role === "user") {
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return joinTextParts(content);
      return "";
    }
    if (role === "assistant") {
      const parts: string[] = [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block === null || typeof block !== "object") continue;
          const record = block as Record<string, unknown>;
          if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
          else if (
            policy.indexThinking &&
            record.type === "thinking" &&
            typeof record.thinking === "string"
          ) {
            parts.push(record.thinking);
          } else if (record.type === "toolCall") {
            const name = asString(record.name);
            parts.push(`Tool: ${name}(${summarizeArgs(record.arguments)})`);
          }
        }
      }
      const errorMessage = asString(message.errorMessage);
      if (errorMessage) parts.push(`Error: ${errorMessage}`);
      return parts.join("\n");
    }
    if (role === "toolResult") {
      const toolName = asString(message.toolName);
      let body = "";
      if (Array.isArray(message.content)) body = joinTextParts(message.content);
      else if (typeof message.content === "string") body = message.content;
      const errorSuffix = message.isError === true ? " [error]" : "";
      const prefix = toolName ? `toolResult(${toolName})${errorSuffix}` : `toolResult${errorSuffix}`;
      return policy.indexToolOutput && body ? `${prefix}: ${body}` : prefix;
    }
    if (role === "bashExecution") {
      const command = asString(message.command);
      const output = asString(message.output);
      const exit = message.exitCode;
      const exitSuffix = typeof exit === "number" ? ` [exit ${exit}]` : "";
      return policy.indexToolOutput && output
        ? `bash$ ${command}${exitSuffix}\n${output}`
        : `bash$ ${command}${exitSuffix}`;
    }
    if (role === "custom") {
      const customType = asString(message.customType);
      let body = "";
      if (typeof message.content === "string") body = message.content;
      else if (Array.isArray(message.content)) body = joinTextParts(message.content);
      return customType ? `[${customType}] ${body}` : body;
    }
    if (role === "compactionSummary") return `compaction: ${asString(message.summary)}`;
    if (role === "branchSummary") return "";
    return "";
  }
  if (type === "compaction") return `compaction: ${asString(raw.summary)}`;
  if (type === "branch_summary") return "";
  if (type === "custom_message") {
    let body = "";
    if (typeof raw.content === "string") body = raw.content;
    else if (Array.isArray(raw.content)) body = joinTextParts(raw.content);
    const customType = asString(raw.customType);
    return customType ? `[${customType}] ${body}` : body;
  }
  return "";
};

const entryRoleAndTool = (
  raw: Record<string, unknown>,
): { role: string | null; toolName: string | null; isError: boolean } => {
  const type = asString(raw.type);
  if (type === "message") {
    const message = raw.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") return { role: null, toolName: null, isError: false };
    const role = asString(message.role) || null;
    let toolName: string | null = null;
    if (role === "toolResult") toolName = asString(message.toolName) || null;
    else if (role === "bashExecution") toolName = "bash";
    else if (role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block === null || typeof block !== "object") continue;
        const record = block as Record<string, unknown>;
        if (record.type === "toolCall" && typeof record.name === "string") {
          toolName = record.name;
          break;
        }
      }
    }
    const isError = Boolean(message.isError);
    return { role, toolName, isError };
  }
  if (type === "compaction") return { role: "compaction", toolName: null, isError: false };
  if (type === "branch_summary") return { role: "branchSummary", toolName: null, isError: false };
  if (type === "custom_message") return { role: "custom", toolName: null, isError: false };
  return { role: null, toolName: null, isError: false };
};

const parseTimestamp = (raw: unknown): number | null => {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const entryTimestamp = parseTimestamp(record.timestamp);
    if (entryTimestamp !== null) return entryTimestamp;
    const message = record.message as Record<string, unknown> | undefined;
    if (message) return parseTimestamp(message.timestamp);
  }
  return null;
};

/**
 * Normalize already-parsed session records (JSON values) into typed
 * {@link NormalizedEntry} records. This is the single normalization engine:
 * file-backed sessions parse JSONL lines into values and delegate here, and
 * portable host sources pass adapter-supplied values directly. Records that
 * are not JSON objects are skipped without consuming an ordinal, matching the
 * file path's treatment of unparsable lines.
 *
 * Only entries that carry searchable text are emitted (message, compaction,
 * branch_summary, custom_message); structural-only entries (model_change,
 * thinking_level_change, label, custom, session_info) are skipped, so `index`
 * counts only content-bearing records. A `type: "session"` record supplies
 * the header; otherwise the explicit `identity` fallbacks apply.
 */
export const normalizeRecords = (
  records: readonly unknown[],
  identity: { sessionFile: string; sessionId?: string; cwd?: string },
  maxEntryChars: number,
  options: NormalizeSessionOptions = {},
): { entries: NormalizedEntry[]; header: SessionHeaderInfo | null; indexCoverage: NormalizationCoverage } => {
  let header: SessionHeaderInfo | null = null;
  const entries: NormalizedEntry[] = [];
  const reasons = new Set<string>();
  const seenBranchFactAddresses = new Set<string>();
  const policy = privacyPolicy(options);
  for (const reason of options.lineage?.coverageReasons ?? []) reasons.add(reason);
  let index = 0;
  let rawOrdinal = 0;
  let sessionId = "";
  for (const value of records) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const raw = value as Record<string, unknown>;
    if (asString(raw.type) === "session") {
      sessionId = asString(raw.id);
      header = {
        sessionId,
        cwd: asString(raw.cwd),
        ...(typeof raw.parentSession === "string" ? { parentSession: raw.parentSession } : {}),
      };
      continue;
    }
    const type = asString(raw.type);
    const ordinal = rawOrdinal;
    rawOrdinal += 1;
    if (!lineageSelected(
      !options.lineage || options.lineage.entryOrdinals === null,
      options.lineage?.entryOrdinals?.has(ordinal) ?? false,
    )) {
      continue;
    }
    if (
      type !== "message" &&
      type !== "compaction" &&
      type !== "branch_summary" &&
      type !== "custom_message"
    ) {
      continue;
    }
    const { role, toolName, isError } = entryRoleAndTool(raw);
    const filesTouched = extractFilesTouched(raw);
    const fullText = extractFullText(raw, policy);
    const { text, truncated } = truncate(fullText, maxEntryChars);
    if (!text.trim() && role === null) continue;
    const entryId = typeof raw.id === "string" ? raw.id : null;
    const parentId = typeof raw.parentId === "string" ? raw.parentId : null;
    const base: Omit<NormalizedEntry, "index"> = {
      sessionFile: identity.sessionFile,
      sessionId: sessionId || identity.sessionId || "",
      entryId,
      parentId,
      type,
      role,
      toolName,
      text,
      timestamp: parseTimestamp(raw),
      isError,
      truncated,
      ...(filesTouched.length > 0 ? { filesTouched } : {}),
    };
    entries.push({ ...base, index });
    if (truncated) reasons.add("max_entry_chars");
    index += 1;
    for (const child of traceChildren(raw, base, policy)) {
      const bounded = truncate(child.text, maxEntryChars);
      entries.push({ ...child, index, text: bounded.text, truncated: bounded.truncated });
      if (bounded.truncated) reasons.add("max_entry_chars");
      index += 1;
    }
    const details = branchDetails(raw);
    if (details && base.entryId !== null) {
      const localAddresses = new Set<string>();
      const duplicateAddress = details.facts.find((fact) => {
        if (localAddresses.has(fact.address)) return true;
        localAddresses.add(fact.address);
        return false;
      });
      if (duplicateAddress) {
        reasons.add("duplicate_branch_fact_address");
        if (duplicateAddress.kind === "operation") reasons.add("duplicate_operation_address");
      } else {
        const message = raw.message;
        const messageRecord = message && typeof message === "object" && !Array.isArray(message)
          ? message as Record<string, unknown>
          : undefined;
        const carrierFromId = typeof raw.fromId === "string"
          ? raw.fromId
          : typeof messageRecord?.fromId === "string" ? messageRecord.fromId : null;
        for (const fact of details.facts) {
          if (seenBranchFactAddresses.has(fact.address)) continue;
          seenBranchFactAddresses.add(fact.address);
          const child = branchFactChild(fact, base, carrierFromId, policy);
          const bounded = truncate(child.text, maxEntryChars);
          entries.push({ ...child, index, text: bounded.text, truncated: bounded.truncated });
          if (bounded.truncated) reasons.add("max_entry_chars");
          index += 1;
        }
      }
    }
  }
  if (header === null && (identity.sessionId !== undefined || identity.cwd !== undefined)) {
    header = {
      sessionId: identity.sessionId ?? "",
      cwd: identity.cwd ?? "",
    };
    sessionId = sessionId || identity.sessionId || "";
  }

  const entryIds = new Set<string>();
  const operationAddresses = new Set<string>();
  for (const entry of entries) {
    if (entry.entryId !== null) {
      if (entryIds.has(entry.entryId)) reasons.add("duplicate_entry_id");
      entryIds.add(entry.entryId);
    }
    if (entry.operationAddress !== undefined) {
      if (operationAddresses.has(entry.operationAddress)) reasons.add("duplicate_operation_address");
      operationAddresses.add(entry.operationAddress);
    }
  }
  const sortedReasons = [...reasons].sort();
  return {
    entries,
    header,
    indexCoverage: { complete: sortedReasons.length === 0, reasons: sortedReasons },
  };
};

/**
 * Parse a session JSONL file into typed {@link NormalizedEntry} records.
 * File-backed convenience wrapper over {@link normalizeRecords}.
 */
export const normalizeSession = (
  sessionFile: string,
  maxEntryChars: number,
  options: NormalizeSessionOptions = {},
): { entries: NormalizedEntry[]; header: SessionHeaderInfo | null; indexCoverage: NormalizationCoverage } => {
  let content: string;
  try {
    content = fs.readFileSync(sessionFile, "utf8");
  } catch {
    return { entries: [], header: null, indexCoverage: { complete: false, reasons: ["source_unavailable"] } };
  }
  const records: unknown[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }
  return normalizeRecords(records, { sessionFile }, maxEntryChars, options);
};

/** Read only the session header (first JSONL line). */
export const readSessionHeader = (sessionFile: string): SessionHeaderInfo | null => {
  try {
    const fd = fs.openSync(sessionFile, "r");
    const buffer = Buffer.alloc(8_192);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    const slice = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = slice.indexOf("\n");
    const firstLine = (newline === -1 ? slice : slice.slice(0, newline)).trim();
    if (!firstLine) return null;
    const raw = JSON.parse(firstLine) as Record<string, unknown>;
    if (asString(raw.type) !== "session") return null;
    return {
      sessionId: asString(raw.id),
      cwd: asString(raw.cwd),
      ...(typeof raw.parentSession === "string" ? { parentSession: raw.parentSession } : {}),
    };
  } catch {
    return null;
  }
};

/** Re-read a single session line and return its full, untruncated text. */
export const expandSessionEntry = (
  sessionFile: string,
  index: number,
  options: NormalizeSessionOptions = {},
): string | null => {
  const { entries } = normalizeSession(sessionFile, Number.MAX_SAFE_INTEGER, options);
  return entries.find((entry) => entry.index === index)?.text ?? null;
};

export interface ExpandSessionSelection {
  indices?: number[];
  entryIds?: string[];
  operationAddresses?: string[];
  entryRange?: { first: number; last: number };
}

export interface ExpandedSessionEntry {
  index: number;
  entryId: string | null;
  parentId: string | null;
  type: string;
  role: string | null;
  timestamp: number | null;
  isError: boolean;
  text: string;
  parentEntryId?: string | null;
  operationAddress?: string;
  toolName?: string | null;
  ref?: string;
  provider?: string;
  action?: string;
  outcome?: FabricExecutionOutcomeV1;
  filesTouched?: string[];
  operation?: NormalizedFabricOperation;
  branchFact?: NormalizedFabricBranchFact;
  factAddress?: string;
  carrierEntryId?: string;
  carrierParentId?: string | null;
  carrierFromId?: string | null;
}

const toExpandedSessionEntry = (entry: NormalizedEntry): ExpandedSessionEntry => ({
  index: entry.index,
  entryId: entry.entryId,
  parentId: entry.parentId,
  type: entry.type,
  role: entry.role,
  timestamp: entry.timestamp,
  isError: entry.isError,
  text: entry.text,
  ...(entry.parentEntryId !== undefined ? { parentEntryId: entry.parentEntryId } : {}),
  ...(entry.operationAddress ? { operationAddress: entry.operationAddress } : {}),
  ...(entry.toolName ? { toolName: entry.toolName } : {}),
  ...(entry.ref ? { ref: entry.ref } : {}),
  ...(entry.provider ? { provider: entry.provider } : {}),
  ...(entry.action ? { action: entry.action } : {}),
  ...(entry.outcome ? { outcome: entry.outcome } : {}),
  ...(entry.filesTouched ? { filesTouched: entry.filesTouched } : {}),
  ...(entry.operation ? { operation: entry.operation } : {}),
  ...(entry.branchFact ? { branchFact: entry.branchFact } : {}),
  ...(entry.factAddress ? { factAddress: entry.factAddress } : {}),
  ...(entry.carrierEntryId ? { carrierEntryId: entry.carrierEntryId } : {}),
  ...(entry.carrierParentId !== undefined ? { carrierParentId: entry.carrierParentId } : {}),
  ...(entry.carrierFromId !== undefined ? { carrierFromId: entry.carrierFromId } : {}),
});

/** Resolve index, stable entry-id, or inclusive range addresses from one normalized snapshot. */
const expandNormalizedEntries = (
  entries: readonly NormalizedEntry[],
  selection: ExpandSessionSelection,
): ExpandedSessionEntry[] => {
  const indices = new Set(selection.indices ?? []);
  const entryIds = new Set(selection.entryIds ?? []);
  const operationAddresses = new Set(selection.operationAddresses ?? []);
  const range = selection.entryRange;
  return entries
    .filter((entry) =>
      indices.has(entry.index) ||
      (entry.entryId !== null && entryIds.has(entry.entryId)) ||
      (entry.operationAddress !== undefined && operationAddresses.has(entry.operationAddress)) ||
      (range !== undefined && entry.index >= range.first && entry.index <= range.last),
    )
    .map(toExpandedSessionEntry);
};

/** Re-read source once and resolve index, stable entry-id, or inclusive range addresses. */
export const expandSessionEntries = (
  sessionFile: string,
  selection: ExpandSessionSelection,
  options: NormalizeSessionOptions = {},
): ExpandedSessionEntry[] => {
  const { entries } = normalizeSession(sessionFile, Number.MAX_SAFE_INTEGER, options);
  return expandNormalizedEntries(entries, selection);
};

interface ExpansionAddressError {
  code: "ambiguous_address" | "address_not_found";
  message: string;
  addressType: "entry_id" | "operation_address";
  address: string;
  matches: number;
}

export type ExpandSessionResult =
  | { expanded: ExpandedSessionEntry[] }
  | { expanded: []; error: ExpansionAddressError };

/** Resolve every requested stable address from a source or snapshot, refusing missing or ambiguous identities. */
export const expandSessionEntriesChecked = (
  sessionFileOrEntries: string | readonly NormalizedEntry[],
  selection: ExpandSessionSelection,
  options: NormalizeSessionOptions = {},
): ExpandSessionResult => {
  const entries = typeof sessionFileOrEntries === "string"
    ? normalizeSession(sessionFileOrEntries, Number.MAX_SAFE_INTEGER, options).entries
    : sessionFileOrEntries;
  const requestedEntryIds = new Set(selection.entryIds ?? []);
  const requestedOperationAddresses = new Set(selection.operationAddresses ?? []);
  const entryIdCounts = new Map([...requestedEntryIds].map((address) => [address, 0]));
  const operationAddressCounts = new Map(
    [...requestedOperationAddresses].map((address) => [address, 0]),
  );
  for (const entry of entries) {
    if (entry.entryId !== null && requestedEntryIds.has(entry.entryId)) {
      entryIdCounts.set(entry.entryId, (entryIdCounts.get(entry.entryId) ?? 0) + 1);
    }
    if (
      entry.operationAddress !== undefined &&
      requestedOperationAddresses.has(entry.operationAddress)
    ) {
      operationAddressCounts.set(
        entry.operationAddress,
        (operationAddressCounts.get(entry.operationAddress) ?? 0) + 1,
      );
    }
  }
  for (const address of requestedEntryIds) {
    const matches = entryIdCounts.get(address) ?? 0;
    if (matches !== 1) {
      return {
        expanded: [],
        error: {
          code: matches === 0 ? "address_not_found" : "ambiguous_address",
          message: matches === 0
            ? `Entry address ${JSON.stringify(address)} was not found.`
            : `Entry address ${JSON.stringify(address)} resolves to ${matches} records.`,
          addressType: "entry_id",
          address,
          matches,
        },
      };
    }
  }
  for (const address of requestedOperationAddresses) {
    const matches = operationAddressCounts.get(address) ?? 0;
    if (matches !== 1) {
      return {
        expanded: [],
        error: {
          code: matches === 0 ? "address_not_found" : "ambiguous_address",
          message: matches === 0
            ? `Operation address ${JSON.stringify(address)} was not found.`
            : `Operation address ${JSON.stringify(address)} resolves to ${matches} records.`,
          addressType: "operation_address",
          address,
          matches,
        },
      };
    }
  }
  return { expanded: expandNormalizedEntries(entries, selection) };
};
