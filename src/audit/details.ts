import { isRoutineInternalCall } from "../core/call-presentation.js";
import type { FabricKernel } from "../runtime/kernel.js";
import type { FabricAssessmentTraceV1 } from "./assessment.js";
import {
  isFabricExecutionTraceV1,
  type FabricExecutionTraceOperationV1,
  type FabricExecutionTraceV1,
} from "./trace-schema.js";

export const FABRIC_EXECUTION_DETAILS_MAX_BYTES = 512 * 1024;

export interface FabricPersistedExecutionDetailsV1 {
  success: boolean;
  kernel?: FabricKernel;
  trace: FabricExecutionTraceV1;
  /** Opt-in (`trace.assessment`) timings and usage, separate from the deterministic trace. */
  assessment?: FabricAssessmentTraceV1;
  /** Rich render audits persisted verbatim (minus in-memory media) so a resumed transcript re-renders — and expands — exactly like the live one. */
  audits: FabricLegacyRenderAudit[];
  phases: string[];
  error?: string;
  outputFormat?: "yaml" | "json";
  outputFormatStartLine?: number;
  outputFormatLines?: number;
  /** Audits the size bound dropped; the resumed card still counts them. */
  omittedCalls?: FabricOmittedCalls;
}

/**
 * The audit fields that cross into the session record; read back by
 * {@link legacyAudit}. In-memory-only payloads (image blocks, media notes)
 * never persist.
 */
export interface FabricPersistableAuditInput {
  ref: string;
  nestedToolCallId?: string;
  tool?: string;
  provider?: string;
  success?: boolean;
  error?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  resultTruncated?: boolean;
  preview?: unknown;
  startedAt?: number;
  endedAt?: number;
}

export interface FabricLegacyRenderAudit {
  ref: string;
  /** The call's opaque id; a proxied `tool_result` carries the same value as its `toolCallId`. Absent in older transcripts and trace-derived audits. */
  nestedToolCallId?: string;
  tool?: string;
  provider?: string;
  success?: boolean;
  error?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  resultTruncated?: boolean;
  preview?: unknown;
  /** Set only when reconstructed from the durable trace: args are privacy-projected and results/previews are not retained. */
  fromTrace?: boolean;
  startedAt?: number;
  endedAt?: number;
}

export interface FabricExecutionRenderDetails {
  success?: boolean;
  kernel?: FabricKernel;
  error?: string;
  progress?: string;
  outputFormat?: "yaml" | "json";
  outputFormatStartLine?: number;
  outputFormatLines?: number;
  phases: string[];
  audits: FabricLegacyRenderAudit[];
  /** Calls a progress update left out to stay bounded; the live card still counts them. */
  omittedCalls?: FabricOmittedCalls;
}

export interface FabricOmittedCalls {
  count: number;
  /** How many of the omitted calls had finished. */
  done: number;
  /** How many omitted calls failed (absent in older records). */
  failed?: number;
  /** Successful internal plumbing among these raw omitted calls; excluded only by UI projections. */
  internal?: number;
}

const serializedBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const cloneTrace = (trace: FabricExecutionTraceV1): FabricExecutionTraceV1 =>
  structuredClone(trace);

const persistableAudit = (audit: FabricPersistableAuditInput): FabricLegacyRenderAudit =>
  structuredClone({
    ref: audit.ref,
    ...(audit.nestedToolCallId !== undefined ? { nestedToolCallId: audit.nestedToolCallId } : {}),
    ...(audit.tool !== undefined ? { tool: audit.tool } : {}),
    ...(audit.provider !== undefined ? { provider: audit.provider } : {}),
    ...(audit.success !== undefined ? { success: audit.success } : {}),
    ...(audit.error !== undefined ? { error: audit.error } : {}),
    ...(audit.args !== undefined ? { args: audit.args } : {}),
    ...(audit.result !== undefined ? { result: audit.result } : {}),
    ...(audit.resultTruncated !== undefined ? { resultTruncated: audit.resultTruncated } : {}),
    ...(audit.preview !== undefined ? { preview: audit.preview } : {}),
    ...(audit.startedAt !== undefined ? { startedAt: audit.startedAt } : {}),
    ...(audit.endedAt !== undefined ? { endedAt: audit.endedAt } : {}),
  });

/**
 * Creates the only object stored in final fabric_exec details. The
 * privacy-projected trace stays the functional record for compaction and tool
 * ownership; rich call audits persist verbatim (minus in-memory media) so a
 * resumed transcript re-renders and expands exactly like the live one — the
 * collapsed display, not the session record, is the visual boundary. The
 * aggregate object, not each member independently, is bound; display-only
 * audits trim before the functional trace.
 */
export const createFabricPersistedExecutionDetails = (input: {
  success: boolean;
  kernel?: FabricKernel;
  trace: FabricExecutionTraceV1;
  assessment?: FabricAssessmentTraceV1;
  audits?: readonly FabricPersistableAuditInput[];
  phases?: readonly string[];
  error?: string;
  outputFormat?: "yaml" | "json";
  outputFormatStartLine?: number;
  outputFormatLines?: number;
}): FabricPersistedExecutionDetailsV1 => {
  const details: FabricPersistedExecutionDetailsV1 = {
    success: input.success,
    ...(input.kernel ? { kernel: input.kernel } : {}),
    trace: cloneTrace(input.trace),
    // The execution service builds the projection; it is cloned, not re-guarded.
    ...(input.assessment
      ? { assessment: structuredClone(input.assessment) }
      : {}),
    audits: (input.audits ?? []).map(persistableAudit),
    phases: (input.phases ?? []).filter((phase): phase is string => typeof phase === "string"),
    ...(typeof input.error === "string" && input.error ? { error: input.error } : {}),
    ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
    ...(input.outputFormatStartLine !== undefined
      ? { outputFormatStartLine: Math.max(0, Math.floor(input.outputFormatStartLine)) }
      : {}),
    ...(input.outputFormatLines !== undefined
      ? { outputFormatLines: Math.max(0, Math.floor(input.outputFormatLines)) }
      : {}),
  };
  while (
    serializedBytes(details) > FABRIC_EXECUTION_DETAILS_MAX_BYTES &&
    details.audits.length > 0
  ) {
    const dropped = details.audits.pop()!;
    const omitted = details.omittedCalls ?? { count: 0, done: 0 };
    details.omittedCalls = {
      count: omitted.count + 1,
      done: omitted.done + (dropped.success !== undefined ? 1 : 0),
      ...((omitted.internal ?? 0) + Number(isRoutineInternalCall(dropped)) > 0
        ? { internal: (omitted.internal ?? 0) + Number(isRoutineInternalCall(dropped)) } : {}),
      ...((omitted.failed ?? 0) + (dropped.success === false ? 1 : 0) > 0
        ? { failed: (omitted.failed ?? 0) + (dropped.success === false ? 1 : 0) } : {}),
    };
  }
  // Assessment rows are optional observability: they yield before the trace,
  // and their totals survive.
  while (
    serializedBytes(details) > FABRIC_EXECUTION_DETAILS_MAX_BYTES &&
    details.assessment &&
    details.assessment.operations.length > 0
  ) {
    details.assessment.operations.pop();
    details.assessment.counts.droppedOperations++;
  }
  while (
    serializedBytes(details) > FABRIC_EXECUTION_DETAILS_MAX_BYTES &&
    details.trace.operations.length > 0
  ) {
    details.trace.operations.pop();
    details.trace.counts.droppedOperations++;
  }
  while (
    serializedBytes(details) > FABRIC_EXECUTION_DETAILS_MAX_BYTES &&
    details.phases.length > 0
  ) {
    details.phases.pop();
  }
  while (
    serializedBytes(details) > FABRIC_EXECUTION_DETAILS_MAX_BYTES &&
    details.trace.phases.length > 0
  ) {
    details.trace.phases.pop();
    details.trace.counts.droppedValues++;
  }
  if (serializedBytes(details) > FABRIC_EXECUTION_DETAILS_MAX_BYTES) {
    delete details.trace.error;
    details.trace.counts.droppedValues++;
  }
  return details;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const legacyAudit = (value: unknown): FabricLegacyRenderAudit | undefined => {
  if (!isRecord(value) || typeof value.ref !== "string") return undefined;
  return {
    ref: value.ref,
    ...(typeof value.nestedToolCallId === "string" ? { nestedToolCallId: value.nestedToolCallId } : {}),
    ...(typeof value.tool === "string" ? { tool: value.tool } : {}),
    ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
    ...(typeof value.success === "boolean" ? { success: value.success } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(isRecord(value.args) ? { args: value.args } : {}),
    ...(value.result !== undefined ? { result: value.result } : {}),
    ...(typeof value.resultTruncated === "boolean"
      ? { resultTruncated: value.resultTruncated }
      : {}),
    ...(value.preview !== undefined ? { preview: value.preview } : {}),
    ...(typeof value.startedAt === "number" ? { startedAt: value.startedAt } : {}),
    ...(typeof value.endedAt === "number" ? { endedAt: value.endedAt } : {}),
  };
};

const auditFromOperation = (
  operation: FabricExecutionTraceOperationV1,
): FabricLegacyRenderAudit => ({
  ref: operation.ref,
  fromTrace: true,
  ...(operation.action ? { tool: operation.action } : {}),
  ...(operation.provider ? { provider: operation.provider } : {}),
  success: operation.outcome === "succeeded",
  ...(operation.error ? { error: operation.error } : {}),
  ...(Object.keys(operation.args).length > 0 ? { args: operation.args } : {}),
  ...(operation.result !== undefined ? { result: operation.result } : {}),
  ...(operation.resultTruncated === true ? { resultTruncated: true } : {}),
});

/**
 * Adapts both old audit-bearing session details and current trace-only details
 * for rendering. Legacy audits win when present so old transcripts retain
 * their historical rich previews.
 */
export const readFabricExecutionRenderDetails = (
  value: unknown,
): FabricExecutionRenderDetails => {
  if (!isRecord(value)) return { audits: [], phases: [] };
  const trace = isFabricExecutionTraceV1(value.trace) ? value.trace : undefined;
  const oldAudits = Array.isArray(value.audits)
    ? value.audits.map(legacyAudit).filter((audit): audit is FabricLegacyRenderAudit => audit !== undefined)
    : undefined;
  const oldPhases = Array.isArray(value.phases)
    ? value.phases.filter((phase): phase is string => typeof phase === "string")
    : undefined;
  return {
    ...(value.kernel === "typescript" || value.kernel === "python" ? { kernel: value.kernel } : {}),
    ...(typeof value.success === "boolean"
      ? { success: value.success }
      : trace
        ? { success: trace.outcome === "succeeded" }
        : {}),
    ...(typeof value.error === "string"
      ? { error: value.error }
      : trace?.error
        ? { error: trace.error }
        : {}),
    ...(typeof value.progress === "string" ? { progress: value.progress } : {}),
    ...(value.outputFormat === "yaml" || value.outputFormat === "json"
      ? { outputFormat: value.outputFormat }
      : {}),
    ...(typeof value.outputFormatStartLine === "number" &&
      Number.isFinite(value.outputFormatStartLine) &&
      value.outputFormatStartLine >= 0
      ? { outputFormatStartLine: Math.floor(value.outputFormatStartLine) }
      : {}),
    ...(typeof value.outputFormatLines === "number" &&
      Number.isFinite(value.outputFormatLines) &&
      value.outputFormatLines >= 0
      ? { outputFormatLines: Math.floor(value.outputFormatLines) }
      : {}),
    phases: oldPhases ?? trace?.phases ?? [],
    audits: oldAudits ?? trace?.operations.map(auditFromOperation) ?? [],
    ...(omittedCalls(value.omittedCalls) ?? {}),
  };
};

const omittedCalls = (value: unknown): { omittedCalls: FabricOmittedCalls } | undefined => {
  if (!isRecord(value)) return undefined;
  const { count, done, failed, internal } = value;
  if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) return undefined;
  const finished = typeof done === "number" && Number.isInteger(done) ? Math.min(Math.max(0, done), count) : 0;
  const failures = typeof failed === "number" && Number.isInteger(failed) ? Math.min(Math.max(0, failed), finished) : 0;
  const plumbing = typeof internal === "number" && Number.isInteger(internal)
    ? Math.min(Math.max(0, internal), finished - failures) : 0;
  return { omittedCalls: { count, done: finished, ...(failures > 0 ? { failed: failures } : {}), ...(plumbing > 0 ? { internal: plumbing } : {}) } };
};

/** Byte budget for the call audits in one fabric_exec progress update. */
export const FABRIC_PARTIAL_AUDITS_MAX_BYTES = 128 * 1024;
/** Complete onUpdate envelope, including the second copy of progress in content. */
export const FABRIC_PARTIAL_UPDATE_MAX_BYTES = 256 * 1024;
// The expanded live card shows the first 30 calls; the collapsed one shows
// running calls first. Keep those, plus the newest, and count the rest.
const PARTIAL_HEAD_AUDITS = 30;
const PARTIAL_TAIL_AUDITS = 30;
const PARTIAL_PHASES = 64;
const PARTIAL_PROGRESS_CHARS = 8_000;
const SLIM_ARG_KEYS = 8;
const SLIM_TEXT_CHARS = 240;

export interface FabricPartialExecutionDetails {
  progress?: string;
  deadlineAt?: number;
  phases: string[];
  audits: FabricLegacyRenderAudit[];
  omittedCalls?: FabricOmittedCalls;
}

const clipText = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max)}…`;

// A call row without its payloads: enough for the title and the status glyph.
const slimAudit = (audit: FabricLegacyRenderAudit): FabricLegacyRenderAudit => {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(audit.args ?? {}).slice(0, SLIM_ARG_KEYS)) {
    if (typeof value === "string") args[key] = clipText(value, SLIM_TEXT_CHARS);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) args[key] = value;
  }
  return {
    ref: audit.ref,
    ...(audit.nestedToolCallId !== undefined ? { nestedToolCallId: audit.nestedToolCallId } : {}),
    ...(audit.tool !== undefined ? { tool: audit.tool } : {}),
    ...(audit.provider !== undefined ? { provider: audit.provider } : {}),
    ...(audit.success !== undefined ? { success: audit.success } : {}),
    ...(audit.error !== undefined ? { error: clipText(audit.error, SLIM_TEXT_CHARS) } : {}),
    ...(Object.keys(args).length > 0 ? { args } : {}),
    ...(audit.startedAt !== undefined ? { startedAt: audit.startedAt } : {}),
    ...(audit.endedAt !== undefined ? { endedAt: audit.endedAt } : {}),
  };
};

/**
 * Builds the details of one fabric_exec progress update. Each update replaces
 * the previous one, so it must stand alone, yet its size must not grow with
 * the number of nested calls: hundreds of calls with full arguments and
 * results once made a single update line megabytes long. The final result is
 * built separately and keeps every audit.
 */
export const createFabricPartialExecutionDetails = (input: {
  audits: readonly FabricPersistableAuditInput[];
  phases: readonly string[];
  progress?: string | undefined;
  deadlineAt?: number | undefined;
}): FabricPartialExecutionDetails => {
  const total = input.audits.length;
  const running: number[] = [];
  for (let index = 0; index < total; index++) {
    if (input.audits[index]!.success === undefined) running.push(index);
  }
  // Priority order: running calls, then the newest, then the first ones.
  const candidates = new Set<number>(running.slice(-PARTIAL_TAIL_AUDITS).reverse());
  for (let index = total - 1; index >= Math.max(0, total - PARTIAL_TAIL_AUDITS); index--) candidates.add(index);
  for (let index = 0; index < Math.min(total, PARTIAL_HEAD_AUDITS); index++) candidates.add(index);
  const kept = new Map<number, FabricLegacyRenderAudit>();
  let used = 0;
  for (const index of candidates) {
    const full = persistableAudit(input.audits[index]!);
    const fullBytes = serializedBytes(full);
    if (used + fullBytes <= FABRIC_PARTIAL_AUDITS_MAX_BYTES) {
      kept.set(index, full);
      used += fullBytes;
      continue;
    }
    const slim = slimAudit(full);
    const slimBytes = serializedBytes(slim);
    if (used + slimBytes <= FABRIC_PARTIAL_AUDITS_MAX_BYTES) {
      kept.set(index, slim);
      used += slimBytes;
    }
  }
  const audits = [...kept.keys()].sort((left, right) => left - right).map((index) => kept.get(index)!);
  let omittedDone = 0;
  let omittedFailed = 0;
  let omittedInternal = 0;
  for (let index = 0; index < total; index++) {
    if (!kept.has(index)) {
      if (input.audits[index]!.success !== undefined) omittedDone++;
      if (input.audits[index]!.success === false) omittedFailed++;
      if (isRoutineInternalCall(input.audits[index]!)) omittedInternal++;
    }
  }
  const omitted = total - audits.length;
  const progress = input.progress === undefined || input.progress.length <= PARTIAL_PROGRESS_CHARS
    ? input.progress
    : `…${input.progress.slice(-PARTIAL_PROGRESS_CHARS)}`;
  const details: FabricPartialExecutionDetails = {
    ...(progress !== undefined ? { progress } : {}),
    ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    phases: [],
    audits,
    ...(omitted > 0 ? { omittedCalls: { count: omitted, done: omittedDone, ...(omittedFailed > 0 ? { failed: omittedFailed } : {}), ...(omittedInternal > 0 ? { internal: omittedInternal } : {}) } } : {}),
  };
  // Audits take at most 128 KiB, and each copy of the 8,001-code-unit
  // progress string takes at most six bytes per code unit in JSON. This
  // leaves room below 256 KiB even before admitting any phase names.
  // Measure the actual envelope: UTF-8 and JSON escaping are not char counts.
  let bytes = serializedBytes({ content: [{ type: "text", text: progress ?? "" }], details });
  for (let index = input.phases.length - 1; index >= Math.max(0, input.phases.length - PARTIAL_PHASES); index--) {
    const phase = clipText(input.phases[index]!, SLIM_TEXT_CHARS);
    const extra = serializedBytes(phase) + (details.phases.length > 0 ? 1 : 0);
    if (bytes + extra > FABRIC_PARTIAL_UPDATE_MAX_BYTES) break;
    details.phases.unshift(phase);
    bytes += extra;
  }
  return details;
};
