// Provider-neutral routing: a provider may discard Pi's generated rules but
// preserve named sections or an explicitly appended prompt. No text semantics
// are assumed here; the adapter tests pin the exact strings and host behavior.
import { bool, fun } from "gdp-wired";
import type { Kernel } from "./kernel.js";

type PromptGuidanceBug = "drop portable rules" | "duplicate delivery" | "ignore forced prompt" | "inject while inactive" | "keep duplicate native rules";

const decision = (bug?: PromptGuidanceBug) => fun("portable prompt guidance")
  .inputs({ active: bool, sections: bool, forced: bool })
  .returns(({ active, sections, forced }) => ({
    section: bug === "drop portable rules" ? active.and(active.not())
      : bug === "inject while inactive" ? sections.and(forced.not())
      : bug === "ignore forced prompt" ? active.and(sections)
      : active.and(sections, forced.not()),
    append: bug === "duplicate delivery" ? active
      : bug === "drop portable rules" ? active.and(active.not())
      : bug === "ignore forced prompt" ? active.and(sections.not())
      : active.and(sections.not().or(forced)),
    native: bug === "keep duplicate native rules" ? active.or(active.not()) : active.not(),
  }));

export const promptGuidanceKernels = (bug?: PromptGuidanceBug): Kernel[] => {
  const f = decision(bug);
  return [{ id: "promptGuidance", fun: f, decisions: [
    f.law("active guidance has exactly one portable destination and no duplicate native rules",
      ({ active }) => active, (o) => o.section.or(o.append).and(o.section.and(o.append).not(), o.native.not())),
    f.law("inactive guidance keeps native ownership and injects nothing",
      ({ active }) => active.not(), (o) => o.native.and(o.section.not(), o.append.not())),
    f.law("an unforced structured prompt carries guidance in its section",
      ({ active, sections, forced }) => active.and(sections, forced.not()), (o) => o.section.and(o.append.not())),
    f.law("a forced or legacy prompt carries guidance in its append",
      ({ active, sections, forced }) => active.and(sections.not().or(forced)), (o) => o.append.and(o.section.not())),
  ] }];
};
export const PROMPT_GUIDANCE_BUGS: PromptGuidanceBug[] = [
  "drop portable rules", "duplicate delivery", "ignore forced prompt", "inject while inactive", "keep duplicate native rules",
];
