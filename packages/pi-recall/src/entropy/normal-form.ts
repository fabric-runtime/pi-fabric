// Minimal seam of the pi-fabric extraction: only the NormalFormWitness shape
// and its validator are needed here (audit/trace-schema.ts validates persisted
// traces). The derivation machinery (deriveNormalFormPlan, applyNormalFormPlan)
// stays fork-side; it is engine entropy-tooling, not memory-module surface.
export const NORMAL_FORM_VERSION = 1 as const;
export const MAX_NORMAL_FORM_RULES = 128;
const RULE_KINDS = ["key-form", "enum-form", "numeric-string", "optional-null"] as const;
export type NormalFormRuleKind = typeof RULE_KINDS[number];
export interface NormalFormRule { kind: NormalFormRuleKind; key: string }
export interface NormalFormWitness {
  version: typeof NORMAL_FORM_VERSION;
  baseSchemaDigest: string;
  beforeShape: string;
  afterShape: string;
  rules: NormalFormRule[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const safeKey = (key: string): boolean => key.length <= 128 &&
  !["__proto__", "prototype", "constructor"].includes(key);
const isRule = (value: unknown): value is NormalFormRule => isRecord(value) &&
  Object.keys(value).length === 2 && typeof value.key === "string" && safeKey(value.key) &&
  RULE_KINDS.includes(value.kind as NormalFormRuleKind);
const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export const isNormalFormWitness = (value: unknown): value is NormalFormWitness => isRecord(value) &&
  Object.keys(value).length === 5 && value.version === NORMAL_FORM_VERSION &&
  isDigest(value.baseSchemaDigest) && isDigest(value.beforeShape) && isDigest(value.afterShape) &&
  Array.isArray(value.rules) && value.rules.length > 0 && value.rules.length <= MAX_NORMAL_FORM_RULES &&
  value.rules.every(isRule);
