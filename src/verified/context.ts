// Bridges for proofs/context.ts: what a compaction summary puts in front of
// the model. Production code supplies typed facts; the compiled machines decide.
import { failureLedger as ledgerMachine, summaryAllocation as allocationMachine, userStaleness as stalenessMachine } from "./generated/context.js";

const isNatural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const natural = (value: number, what: string): number => {
  if (!isNatural(value)) throw new RangeError(`${what} must be a safe natural, not ${value}`);
  return value;
};

export interface SummaryAllocation {
  userBytes: number;
  operationBytes: number;
}

/** The user's words take bytes first; operational residue gets the rest. */
export const allocateSummaryBytes = (limit: number, user: number, operations: number): SummaryAllocation => {
  const input = { limit: natural(limit, "limit"), user: natural(user, "user"), operations: natural(operations, "operations") };
  const out = allocationMachine.step({}, allocationMachine.init({}), input).scalars;
  return { userBytes: out["out.userBytes"]!, operationBytes: out["out.operationBytes"]! };
};

/** Entry kinds in the order proofs/context.ts declares them. */
export type StalenessOp = "user" | "background" | "compaction" | "other";
const STALENESS_CODES: Record<StalenessOp, number> = { user: 0, background: 1, compaction: 2, other: 3 };

export interface UserStaleness {
  /** A user message exists on the folded path. */
  anchored: boolean;
  /** Compaction markers after the latest user message. */
  compactions: number;
  /** Background deliveries after the latest user message. */
  background: number;
}

export const foldUserStaleness = (ops: Iterable<StalenessOp>): UserStaleness => {
  let state = stalenessMachine.init({});
  for (const op of ops) state = stalenessMachine.step({}, state, { op: STALENESS_CODES[op] });
  const { seen, compactions, background } = state.scalars;
  return { anchored: seen === 1, compactions: compactions!, background: background! };
};

export interface FailureFact {
  /** The failure happened after the previous compaction marker. */
  fresh: boolean;
  /** A later exact structural success resolved it. */
  resolved: boolean;
}

export interface FailureLedger {
  /** Parallel to the input: whether each failure is itemized. */
  itemized: boolean[];
  total: number;
  open: number;
  aged: number;
  resolved: number;
}

/** Pass fresh failures newest first, then aged ones newest first, then resolved ones:
 * the newest fresh failures take room first, and aged ones fill only what is left. */
export const foldFailureLedger = (failures: readonly FailureFact[], limit: number): FailureLedger => {
  const params = { limit: natural(limit, "limit") };
  let state = ledgerMachine.init(params);
  const itemized: boolean[] = [];
  for (const failure of failures) {
    const before = state.scalars.itemized!;
    state = ledgerMachine.step(params, state, { fresh: failure.fresh ? 1 : 0, resolved: failure.resolved ? 1 : 0 });
    itemized.push(state.scalars.itemized! > before);
  }
  const { total, open, aged, settled } = state.scalars;
  return { itemized, total: total!, open: open!, aged: aged!, resolved: settled! };
};
