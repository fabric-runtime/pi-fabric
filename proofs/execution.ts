// Host output ceilings and provider deadline-pause admission. The adapter owns
// JS number validation and callback identity; the compiled decisions own policy.
import { bool, fun, nat, when } from "gdp-wired";
import type { Kernel } from "./kernel.js";

type ExecutionBug = "invalid ceiling accepted" | "zero ceiling accepted" | "override discarded" | "default discarded"
  | "hard deadline pauses" | "missing callback admitted" | "human wait refused";

export const executionKernels = (bug?: ExecutionBug): Kernel[] => {
  const ceiling = fun("host output ceiling")
    .inputs({ present: bool, valid: bool, requested: nat, fallback: nat })
    .returns(({ present, valid, requested, fallback }) => ({
      accepted: bug === "invalid ceiling accepted" ? present.or(present.not())
        : present.not().or(valid.and(bug === "zero ceiling accepted" ? requested.atLeast(0) : requested.gt(0))),
      limit: bug === "override discarded" ? fallback
        : bug === "default discarded" ? requested
        : when(present.and(valid, requested.gt(0)), requested, fallback),
    }));
  const wait = fun("provider human wait admission")
    .inputs({ available: bool, hardDeadline: bool })
    .returns(({ available, hardDeadline }) => ({
      allowed: bug === "hard deadline pauses" ? available
        : bug === "missing callback admitted" ? hardDeadline.not()
        : bug === "human wait refused" ? available.and(available.not())
        : available.and(hardDeadline.not()),
    }));
  return [{ id: "outputCeiling", fun: ceiling, decisions: [
    ceiling.law("ceiling_safe: a present accepted override is valid and positive", () => [],
      (o, e) => o.accepted.and(e.present).implies(e.valid.and(e.requested.gt(0)))),
    ceiling.law("ceiling_complete: absent or valid positive overrides are accepted",
      e => e.present.not().or(e.valid.and(e.requested.gt(0))), o => o.accepted),
    ceiling.law("ceiling_default: omission preserves the host default", e => e.present.not(),
      (o, e) => o.limit.eq(e.fallback)),
    ceiling.law("ceiling_override: a valid positive host override is preserved exactly",
      e => e.present.and(e.valid, e.requested.gt(0)), (o, e) => o.limit.eq(e.requested)),
    ceiling.law("ceiling_positive: accepted limits stay positive with a positive default",
      e => e.fallback.gt(0), o => o.accepted.implies(o.limit.gt(0))),
  ] }, { id: "humanWaitAdmission", fun: wait, decisions: [
    wait.law("human_wait_safe: a callback requires runtime support and no hard deadline", () => [],
      (o, e) => o.allowed.implies(e.available.and(e.hardDeadline.not()))),
    wait.law("human_wait_complete: runtime support without a hard deadline exposes the callback",
      e => e.available.and(e.hardDeadline.not()), o => o.allowed),
  ] }];
};
export const EXECUTION_BUGS: ExecutionBug[] = [
  "invalid ceiling accepted", "zero ceiling accepted", "override discarded", "default discarded",
  "hard deadline pauses", "missing callback admitted", "human wait refused",
];
