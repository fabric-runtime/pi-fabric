import { isNormalFormWitness, type NormalFormWitness } from "../entropy/normal-form.js";

// The persisted trace shape and its validators. Tool ownership and result
// rendering read traces at startup; recording them stays in trace.ts.
export const FABRIC_EXECUTION_TRACE_KIND = "pi-fabric.execution" as const;
export const FABRIC_EXECUTION_TRACE_VERSION = 1 as const;
export const FABRIC_EXECUTION_TRACE_MAX_BYTES = 512 * 1024;
export const MAX_TRACE_DEPTH = 12;

export type FabricTraceJsonPrimitive = string | number | boolean | null;
export type FabricTraceJsonValue =
  | FabricTraceJsonPrimitive
  | FabricTraceJsonValue[]
  | { [key: string]: FabricTraceJsonValue };

export type FabricExecutionOutcomeV1 = "succeeded" | "failed" | "aborted" | "timed_out";
export type FabricExecutionFailureStageV1 =
  | "resolve"
  | "prepare"
  | "validate"
  | "approve"
  | "invoke"
  | "guard";

export interface FabricExecutionTraceOperationV1 {
  type: "call";
  sequence: number;
  ref: string;
  provider?: string;
  action?: string;
  args: { [key: string]: FabricTraceJsonValue };
  outcome: FabricExecutionOutcomeV1;
  normalization?: NormalFormWitness;
  failureStage?: FabricExecutionFailureStageV1;
  error?: string;
  result?: FabricTraceJsonValue;
  resultTruncated?: boolean;
}

export interface FabricExecutionTraceCountsV1 {
  droppedValues: number;
  truncatedValues: number;
  redactedValues: number;
  droppedOperations: number;
}

export interface FabricExecutionTraceV1 {
  kind: typeof FABRIC_EXECUTION_TRACE_KIND;
  version: typeof FABRIC_EXECUTION_TRACE_VERSION;
  outcome: FabricExecutionOutcomeV1;
  phases: string[];
  operations: FabricExecutionTraceOperationV1[];
  counts: FabricExecutionTraceCountsV1;
  error?: string;
}

// Errors whose messages contain no tool output, argument payloads, or
// user/source text and are safe to quote verbatim in durable traces: registry
// resolution failures, policy denials, and Fabric-generated guard messages.
export class FabricTraceSafeError extends Error {}

// Thrown by the registry when a provider or action cannot be resolved.
export class FabricResolutionError extends FabricTraceSafeError {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const outcomes = new Set<FabricExecutionOutcomeV1>(["succeeded", "failed", "aborted", "timed_out"]);
const stages = new Set<FabricExecutionFailureStageV1>(["resolve", "prepare", "validate", "approve", "invoke", "guard"]);

const isJsonValue = (value: unknown, ancestors = new Set<object>(), depth = 0): value is FabricTraceJsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > MAX_TRACE_DEPTH + 2 || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors, depth + 1))
    : Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, ancestors, depth + 1));
  ancestors.delete(value);
  return valid;
};

const isFabricExecutionTraceOperationV1Unchecked = (
  value: unknown,
): value is FabricExecutionTraceOperationV1 => {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["type", "sequence", "ref", "provider", "action", "args", "outcome", "normalization", "failureStage", "error", "result", "resultTruncated"])) return false;
  if (value.type !== "call" || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0) return false;
  if (typeof value.ref !== "string" || !isRecord(value.args) || !isJsonValue(value.args)) return false;
  if (!outcomes.has(value.outcome as FabricExecutionOutcomeV1)) return false;
  if (value.provider !== undefined && typeof value.provider !== "string") return false;
  if (value.action !== undefined && typeof value.action !== "string") return false;
  if (value.failureStage !== undefined && !stages.has(value.failureStage as FabricExecutionFailureStageV1)) return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  if (value.normalization !== undefined && !isNormalFormWitness(value.normalization)) return false;
  if (value.resultTruncated !== undefined && typeof value.resultTruncated !== "boolean") return false;
  return value.result === undefined || isJsonValue(value.result);
};

export const isFabricExecutionTraceOperationV1 = (
  value: unknown,
): value is FabricExecutionTraceOperationV1 => {
  try {
    return isFabricExecutionTraceOperationV1Unchecked(value);
  } catch {
    return false;
  }
};

const isFabricExecutionTraceV1Unchecked = (value: unknown): value is FabricExecutionTraceV1 => {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["kind", "version", "outcome", "phases", "operations", "counts", "error"])) return false;
  if (value.kind !== FABRIC_EXECUTION_TRACE_KIND || value.version !== FABRIC_EXECUTION_TRACE_VERSION) return false;
  if (!outcomes.has(value.outcome as FabricExecutionOutcomeV1)) return false;
  if (!Array.isArray(value.phases) || !value.phases.every((phase) => typeof phase === "string")) return false;
  if (!Array.isArray(value.operations) || !value.operations.every(isFabricExecutionTraceOperationV1)) return false;
  if (!isRecord(value.counts) || !hasOnlyKeys(value.counts, ["droppedValues", "truncatedValues", "redactedValues", "droppedOperations"])) return false;
  const counts = value.counts;
  if (!["droppedValues", "truncatedValues", "redactedValues", "droppedOperations"].every((key) => Number.isSafeInteger(counts[key]) && (counts[key] as number) >= 0)) return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  for (let index = 1; index < value.operations.length; index++) {
    if (value.operations[index]!.sequence <= value.operations[index - 1]!.sequence) return false;
  }
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= FABRIC_EXECUTION_TRACE_MAX_BYTES;
};

export const isFabricExecutionTraceV1 = (value: unknown): value is FabricExecutionTraceV1 => {
  try {
    return isFabricExecutionTraceV1Unchecked(value);
  } catch {
    return false;
  }
};

export const readFabricExecutionTraceV1 = (value: unknown): FabricExecutionTraceV1 | undefined =>
  isFabricExecutionTraceV1(value) ? value : undefined;
