import { humanWaitAdmission, outputCeiling } from "./generated/execution.js";
// Keep the Boolean codec local: managed-host construction is in the startup
// graph, while the stateful codecs in machine.ts load at first use.
const bit = (value: boolean): number => value ? 1 : 0;

/** Trusted numeric codec: nullish options mean omitted; only positive safe
 * integers reach an override input. Other invalid values must be refused. */
export const hostOutputCeiling = (requested: number | null | undefined, fallback: number, label: string): number => {
  if (!Number.isSafeInteger(fallback) || fallback <= 0) throw new Error(`Invalid default for ${label}`);
  const valid = typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0;
  const result = outputCeiling.step({}, outputCeiling.init({}), {
    present: bit(requested !== undefined && requested !== null), valid: bit(valid), requested: valid ? requested : 0, fallback,
  }).scalars;
  if (result["out.accepted"] !== 1) throw new Error(`${label} must be a positive safe integer`);
  return result["out.limit"]!;
};

/** Callback identity is host-owned. No guest argument can enable pausing, and
 * an explicit whole-script deadline always withholds the capability. */
export const providerHumanWait = <T>(callback: T | undefined, hardTimeoutMs: number | undefined): T | undefined => {
  const result = humanWaitAdmission.step({}, humanWaitAdmission.init({}), {
    available: bit(callback !== undefined), hardDeadline: bit(hardTimeoutMs !== undefined),
  }).scalars;
  return result["out.allowed"] === 1 ? callback : undefined;
};
