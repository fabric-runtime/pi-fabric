import type {
  FabricExecutionOutcomeV1,
  FabricTraceJsonValue,
} from "../audit/trace.js";

export const FABRIC_BRANCH_SUMMARY_KIND = "pi-fabric.branch-summary" as const;
const FABRIC_BRANCH_SUMMARY_VERSION_V1 = 1 as const;
export const FABRIC_BRANCH_SUMMARY_VERSION = 2 as const;
export const FABRIC_BRANCH_SUMMARY_MAX_BYTES = 128 * 1024;
export const FABRIC_BRANCH_SUMMARY_MAX_FACTS = 256;
export const FABRIC_BRANCH_RUN_NAME_MAX_BYTES = 256;
export const FABRIC_BRANCH_RUN_DESCRIPTION_MAX_BYTES = 1024;

interface BranchFactBase {
  entryId: string;
  subordinal: string;
  address: string;
}

interface FabricBranchUserFactV1 extends BranchFactBase {
  kind: "user";
  text: string;
}

interface FabricBranchCustomMessageFactV1 extends BranchFactBase {
  kind: "customMessage";
  customType: string;
  text: string;
  display: boolean;
  details?: FabricTraceJsonValue;
}

interface FabricBranchPhaseFactV1 extends BranchFactBase {
  kind: "phase";
  phase: string;
}

export interface FabricBranchOperationFactV1 extends BranchFactBase {
  kind: "operation";
  ref: string;
  provider?: string;
  action?: string;
  tool: string;
  args: Record<string, FabricTraceJsonValue>;
  outcome: FabricExecutionOutcomeV1;
  error?: string;
  result?: FabricTraceJsonValue;
}

type FabricBranchFactV1 =
  | FabricBranchUserFactV1
  | FabricBranchCustomMessageFactV1
  | FabricBranchPhaseFactV1
  | FabricBranchOperationFactV1;

interface FabricBranchRunFactV2 extends BranchFactBase {
  kind: "fabricRun";
  name: string;
  description?: string;
  outcome: FabricExecutionOutcomeV1;
}

export type FabricBranchFactV2 = FabricBranchFactV1 | FabricBranchRunFactV2;

interface FabricBranchSummarySource {
  firstEntryId: string;
  lastEntryId: string;
  entryCount: number;
  /** Canonical abandoned-branch provenance. Absent only on older v1 envelopes. */
  oldLeafId?: string | null;
}

interface FabricBranchSummaryRequest {
  text: string;
  sourceBytes: number;
  truncated: boolean;
}

export interface FabricBranchSummaryDetailsV1 {
  kind: typeof FABRIC_BRANCH_SUMMARY_KIND;
  version: typeof FABRIC_BRANCH_SUMMARY_VERSION_V1;
  source: FabricBranchSummarySource;
  facts: FabricBranchFactV1[];
  omittedFacts: number;
  sections: string[];
  request: FabricBranchSummaryRequest;
}

export interface FabricBranchSummaryDetailsV2 {
  kind: typeof FABRIC_BRANCH_SUMMARY_KIND;
  version: typeof FABRIC_BRANCH_SUMMARY_VERSION;
  source: FabricBranchSummarySource;
  facts: FabricBranchFactV2[];
  omittedFacts: number;
  sections: string[];
  request: FabricBranchSummaryRequest;
}

export type FabricBranchSummaryDetails =
  | FabricBranchSummaryDetailsV1
  | FabricBranchSummaryDetailsV2;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

interface JsonValidationState {
  nodes: number;
  ancestors: Set<object>;
}

const MAX_DETAILS_JSON_NODES = 4096;
const MAX_DETAILS_JSON_COLLECTION = 256;

const isJsonValue = (
  value: unknown,
  state: JsonValidationState,
  depth = 0,
): value is FabricTraceJsonValue => {
  state.nodes += 1;
  if (state.nodes > MAX_DETAILS_JSON_NODES) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 16 || state.ancestors.has(value)) return false;
  state.ancestors.add(value);
  let valid = false;
  try {
    if (Array.isArray(value)) {
      valid = value.length <= MAX_DETAILS_JSON_COLLECTION
        && value.every((item) => isJsonValue(item, state, depth + 1));
    } else {
      const keys = Object.keys(value);
      valid = keys.length <= MAX_DETAILS_JSON_COLLECTION
        && keys.every((key) => isJsonValue((value as Record<string, unknown>)[key], state, depth + 1));
    }
  } finally {
    state.ancestors.delete(value);
  }
  return valid;
};

const outcomes = new Set<FabricExecutionOutcomeV1>(["succeeded", "failed", "aborted", "timed_out"]);

const validBase = (fact: Record<string, unknown>): boolean =>
  typeof fact.entryId === "string"
  && typeof fact.subordinal === "string"
  && typeof fact.address === "string"
  && fact.address === `${fact.entryId}/${fact.subordinal}`;

const isFactV1 = (value: unknown, jsonState: JsonValidationState): value is FabricBranchFactV1 => {
  if (!isRecord(value) || !validBase(value)) return false;
  if (value.kind === "user") {
    return hasOnlyKeys(value, ["kind", "entryId", "subordinal", "address", "text"])
      && typeof value.text === "string";
  }
  if (value.kind === "customMessage") {
    return hasOnlyKeys(value, [
      "kind", "entryId", "subordinal", "address", "customType", "text", "display", "details",
    ])
      && typeof value.customType === "string"
      && typeof value.text === "string"
      && typeof value.display === "boolean"
      && (value.details === undefined || isJsonValue(value.details, jsonState));
  }
  if (value.kind === "phase") {
    return hasOnlyKeys(value, ["kind", "entryId", "subordinal", "address", "phase"])
      && typeof value.phase === "string";
  }
  if (value.kind !== "operation") return false;
  if (!hasOnlyKeys(value, [
    "kind", "entryId", "subordinal", "address", "ref", "provider", "action", "tool", "args",
    "outcome", "error", "result",
  ])) return false;
  return typeof value.ref === "string"
    && (value.provider === undefined || typeof value.provider === "string")
    && (value.action === undefined || typeof value.action === "string")
    && typeof value.tool === "string"
    && isRecord(value.args)
    && isJsonValue(value.args, jsonState)
    && outcomes.has(value.outcome as FabricExecutionOutcomeV1)
    && (value.error === undefined || typeof value.error === "string")
    && (value.result === undefined || isJsonValue(value.result, jsonState));
};

const isFactV2 = (value: unknown, jsonState: JsonValidationState): value is FabricBranchFactV2 => {
  if (isRecord(value) && value.kind === "fabricRun") {
    return validBase(value)
      && typeof value.subordinal === "string"
      && value.subordinal.startsWith("call:")
      && value.subordinal.length > "call:".length
      && hasOnlyKeys(value, [
        "kind", "entryId", "subordinal", "address", "name", "description", "outcome",
      ])
      && typeof value.name === "string"
      && value.name.trim().length > 0
      && Buffer.byteLength(value.name, "utf8") <= FABRIC_BRANCH_RUN_NAME_MAX_BYTES
      && (value.description === undefined
        || (typeof value.description === "string"
          && Buffer.byteLength(value.description, "utf8") <= FABRIC_BRANCH_RUN_DESCRIPTION_MAX_BYTES))
      && outcomes.has(value.outcome as FabricExecutionOutcomeV1);
  }
  return isFactV1(value, jsonState);
};

const serializedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

const validEnvelope = (
  value: Record<string, unknown>,
  version: 1 | 2,
  factValidator: (fact: unknown, state: JsonValidationState) => boolean,
): boolean => {
  if (!hasOnlyKeys(value, [
    "kind", "version", "source", "facts", "omittedFacts", "sections", "request",
  ])) return false;
  if (value.kind !== FABRIC_BRANCH_SUMMARY_KIND || value.version !== version) return false;
  if (!isRecord(value.source)
    || !hasOnlyKeys(value.source, ["firstEntryId", "lastEntryId", "entryCount", "oldLeafId"])) return false;
  if (typeof value.source.firstEntryId !== "string" || typeof value.source.lastEntryId !== "string") return false;
  if (!Number.isSafeInteger(value.source.entryCount) || (value.source.entryCount as number) < 0) return false;
  if (value.source.oldLeafId !== undefined
    && value.source.oldLeafId !== null
    && typeof value.source.oldLeafId !== "string") return false;
  const jsonState: JsonValidationState = { nodes: 0, ancestors: new Set<object>() };
  if (!Array.isArray(value.facts)
    || value.facts.length > FABRIC_BRANCH_SUMMARY_MAX_FACTS
    || !value.facts.every((fact) => factValidator(fact, jsonState))) return false;
  if (!Number.isSafeInteger(value.omittedFacts) || (value.omittedFacts as number) < 0) return false;
  if (!Array.isArray(value.sections)
    || value.sections.length > 64
    || !value.sections.every((section) => typeof section === "string")) return false;
  if (!isRecord(value.request)
    || !hasOnlyKeys(value.request, ["text", "sourceBytes", "truncated"])) return false;
  if (typeof value.request.text !== "string" || typeof value.request.truncated !== "boolean") return false;
  if (!Number.isSafeInteger(value.request.sourceBytes) || (value.request.sourceBytes as number) < 0) return false;
  return serializedBytes(value) <= FABRIC_BRANCH_SUMMARY_MAX_BYTES;
};

export const readFabricBranchSummaryDetailsV1 = (
  value: unknown,
): FabricBranchSummaryDetailsV1 | undefined => {
  try {
    if (!isRecord(value) || !validEnvelope(value, FABRIC_BRANCH_SUMMARY_VERSION_V1, isFactV1)) {
      return undefined;
    }
    return value as unknown as FabricBranchSummaryDetailsV1;
  } catch {
    return undefined;
  }
};

export const readFabricBranchSummaryDetailsV2 = (
  value: unknown,
): FabricBranchSummaryDetailsV2 | undefined => {
  try {
    if (!isRecord(value) || !validEnvelope(value, FABRIC_BRANCH_SUMMARY_VERSION, isFactV2)) {
      return undefined;
    }
    return value as unknown as FabricBranchSummaryDetailsV2;
  } catch {
    return undefined;
  }
};

export const readFabricBranchSummaryDetails = (
  value: unknown,
): FabricBranchSummaryDetails | undefined =>
  readFabricBranchSummaryDetailsV2(value) ?? readFabricBranchSummaryDetailsV1(value);
