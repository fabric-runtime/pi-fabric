// What a compaction summary puts in front of the model. Three kernels, each a
// claim about context salience rather than about cut safety:
//
// - summaryAllocation: the user's words take summary bytes before operational
//   residue (files, activity, failures, transcript) gets any.
// - userStaleness: how long the agent has run since the user last spoke,
//   counted from user messages only; background deliveries never reset it.
// - failureLedger: every failure is accounted exactly once as open, aged or
//   resolved. Unresolved failures from the newest window are itemized first;
//   failures an earlier summary already itemized fill only the room they leave.
import { all, bool, fun, min, nat, oneOf, rule, when, yes } from "gdp-wired";
import type { Kernel } from "./kernel.js";

export type ContextBug =
  | "operations are allocated first"
  | "allocation ignores the limit"
  | "background messages reset staleness"
  | "compactions before any user message count"
  | "aged failures vanish"
  | "aged failures crowd out fresh ones"
  | "itemized failures ignore the limit"
  | "resolved failures stay open";

/** Byte allocation inside the summary's remaining space. Demands are the
 * capped sizes of the protected user blocks and of the operational blocks. */
const allocation = (bug?: ContextBug) => fun("summary allocation")
  .inputs({ limit: nat, user: nat, operations: nat })
  .returns(({ limit, user, operations }) => {
    if (bug === "operations are allocated first") {
      const ops = min(operations, limit);
      return { userBytes: min(user, limit.minus(ops)), operationBytes: ops };
    }
    const userBytes = min(user, limit);
    const rest = bug === "allocation ignores the limit" ? limit : limit.minus(userBytes);
    return { userBytes, operationBytes: min(operations, rest) };
  });

/** Op codes, in order: 0 user, 1 background, 2 compaction, 3 other. */
export const STALENESS_OPS = ["user", "background", "compaction", "other"] as const;

const staleness = (bug?: ContextBug) => rule("user staleness")
  .inputs({ op: oneOf(...STALENESS_OPS) })
  .state({ seen: bool.from(false), compactions: 0, background: 0 })
  .step(({ op, seen, compactions, background }) => {
    const counting = bug === "compactions before any user message count" ? yes : seen;
    const resets = bug === "background messages reset staleness" ? op.is("user").or(op.is("background")) : op.is("user");
    return {
      seen: op.is("user").or(seen),
      compactions: when(resets, 0, when(op.is("compaction").and(counting), compactions.plus(1), compactions)),
      background: when(resets, 0, when(op.is("background").and(seen), background.plus(1), background)),
    };
  });

/** Production folds fresh failures newest first, then aged ones newest first,
 * then resolved ones. `skipped` counts fresh open failures left without room. */
const ledger = (bug?: ContextBug) => rule("failure ledger")
  .params({ limit: nat })
  .inputs({ fresh: bool, resolved: bool })
  .state({ total: 0, open: 0, aged: 0, settled: 0, itemized: 0, skipped: 0 })
  .flags(({ fresh, resolved, itemized, skipped, limit }) => ({
    isOpen: bug === "resolved failures stay open" ? fresh : resolved.not().and(fresh),
    isAged: resolved.not().and(fresh.not()),
    room: bug === "itemized failures ignore the limit" ? yes : itemized.lt(limit),
    agedAllowed: bug === "aged failures crowd out fresh ones" ? yes : skipped.eq(0),
  }))
  .step(({ resolved, total, open, aged, settled, itemized, skipped, isOpen, isAged, room, agedAllowed }) => ({
    total: total.plus(1),
    open: when(isOpen, open.plus(1), open),
    aged: bug === "aged failures vanish" ? aged : when(isAged, aged.plus(1), aged),
    settled: when(resolved.and(isOpen.not()), settled.plus(1), settled),
    itemized: when(room.and(isOpen.or(isAged.and(agedAllowed))), itemized.plus(1), itemized),
    skipped: when(isOpen.and(room.not()), skipped.plus(1), skipped),
  }));

export const contextKernels = (bug?: ContextBug): Kernel[] => {
  const a = allocation(bug), s = staleness(bug), l = ledger(bug);
  return [
    { id: "summaryAllocation", fun: a, decisions: [
      a.law("user_first: the user's words lose bytes only when they alone exceed the limit", () => [],
        ({ userBytes }, { user, limit }) => all(userBytes.atMost(user), userBytes.atMost(limit), userBytes.eq(user).or(userBytes.eq(limit)))),
      a.law("allocation_within: user and operational bytes together stay within the limit", () => [],
        ({ userBytes, operationBytes }, { limit }) => userBytes.plus(operationBytes).atMost(limit)),
      a.law("operations_use_the_rest: operations receive what the user leaves, up to their demand", () => [],
        ({ userBytes, operationBytes }, { limit, operations }) => all(
          operationBytes.atMost(operations),
          operationBytes.eq(operations).or(userBytes.plus(operationBytes).eq(limit)))),
    ] },
    {
      id: "userStaleness",
      rule: s,
      laws: [
        s.law("unanchored_is_zero: before any user message, nothing is counted", ({ seen, compactions, background }) =>
          seen.or(compactions.eq(0).and(background.eq(0)))),
      ],
      stepLaws: [
        s.stepLaw("user_resets: a user message anchors and clears staleness", (_e, after) =>
          all(after.seen, after.compactions.eq(0), after.background.eq(0)), ({ op }) => op.is("user")),
        s.stepLaw("background_never_resets: a background delivery leaves the compaction count and anchor alone", ({ seen, compactions }, after) =>
          all(after.compactions.eq(compactions), after.seen.iff(seen)), ({ op }) => op.is("background")),
        s.stepLaw("compaction_counts_once: an anchored compaction adds exactly one", ({ compactions }, after) =>
          after.compactions.eq(compactions.plus(1)), ({ op, seen }) => op.is("compaction").and(seen)),
        s.stepLaw("only_user_clears: no other entry lowers either count", ({ compactions, background }, after) =>
          all(compactions.atMost(after.compactions), background.atMost(after.background)), ({ op }) => op.is("user").not()),
      ],
    },
    {
      id: "failureLedger",
      rule: l,
      laws: [
        l.law("failures_conserved: every failure is open, aged or resolved, exactly once", ({ total, open, aged, settled }) =>
          total.eq(open.plus(aged).plus(settled))),
        l.law("itemized_bounded: itemized failures are unresolved and within the limit", ({ itemized, open, aged, limit }) =>
          itemized.atMost(open.plus(aged)).and(itemized.atMost(limit))),
        l.law("skipped_are_open: only fresh open failures are counted as left out", ({ skipped, open }) => skipped.atMost(open)),
      ],
      stepLaws: [
        l.stepLaw("resolved_never_itemized: a resolved failure is never itemized", ({ itemized }, after) =>
          after.itemized.eq(itemized), ({ resolved }) => resolved),
        l.stepLaw("open_itemized_with_room: a fresh open failure is itemized while room remains", ({ itemized }, after) =>
          after.itemized.eq(itemized.plus(1)), ({ fresh, resolved, itemized, limit }) => all(fresh, resolved.not(), itemized.lt(limit))),
        l.stepLaw("fresh_first: an aged failure takes no room once a fresh open failure was left out", ({ itemized }, after) =>
          after.itemized.eq(itemized), ({ fresh, resolved, skipped }) => all(fresh.not(), resolved.not(), skipped.gt(0))),
        l.stepLaw("aged_fills_room: an aged failure is itemized while room remains and no fresh one was left out", ({ itemized }, after) =>
          after.itemized.eq(itemized.plus(1)), ({ fresh, resolved, skipped, itemized, limit }) => all(fresh.not(), resolved.not(), skipped.eq(0), itemized.lt(limit))),
      ],
    },
  ];
};

export const CONTEXT_BUGS: ContextBug[] = [
  "operations are allocated first",
  "allocation ignores the limit",
  "background messages reset staleness",
  "compactions before any user message count",
  "aged failures vanish",
  "aged failures crowd out fresh ones",
  "itemized failures ignore the limit",
  "resolved failures stay open",
];
