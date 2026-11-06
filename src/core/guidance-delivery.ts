import { promptGuidance } from "../verified/generated/prompt-guidance.js";

export interface FabricGuidanceDelivery {
  section: boolean;
  append: boolean;
  native: boolean;
}

/** Execute the proved routing decision; no provider-name heuristics. */
export function fabricGuidanceDelivery(active: boolean, sections: boolean, forced: boolean): FabricGuidanceDelivery {
  const output = promptGuidance.step({}, promptGuidance.init({}), {
    active: active ? 1 : 0, sections: sections ? 1 : 0, forced: forced ? 1 : 0,
  }).scalars;
  return { section: output["out.section"] === 1, append: output["out.append"] === 1, native: output["out.native"] === 1 };
}

/** Remove only exact owned bullet lines, not prose mentioning their text. */
export function stripFabricRuleBullets(prompt: string, ownedGuidelines: readonly string[]): string {
  const owned = new Set(ownedGuidelines);
  return prompt.split("\n").filter((line) =>
    !line.startsWith("- ") || !owned.has(line.slice(2).trim()),
  ).join("\n");
}

/**
 * Prepare, without mutating host options. The caller commits only after every
 * fallible renderer succeeds. String retention is tested, not claimed by the
 * routing proof; an existing forced/legacy prompt is cleaned separately.
 */
export function relocateFabricGuidelines(
  toolGuidelines: Record<string, string[]> | undefined,
  guidelines: readonly string[],
  delivery: FabricGuidanceDelivery,
  ownedGuidelines: readonly string[] = guidelines,
): { text?: string; remaining?: string[] } {
  if (delivery.native) return {};
  const owned = new Set(ownedGuidelines);
  for (const text of guidelines) owned.add(text);
  return {
    text: "Fabric execution rules:\n" + guidelines.map((text) => `- ${text}`).join("\n"),
    ...(toolGuidelines?.fabric_exec ? {
      remaining: toolGuidelines.fabric_exec.filter((text) => !owned.has(text.trim())),
    } : {}),
  };
}
