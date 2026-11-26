import type { CapturedToolCatalog } from "../capture/catalog.js";
import type { FabricKernel } from "../runtime/kernel.js";
import { isCodemodeScriptGuideline, PI_CORE_TOOL_NAMES } from "./pi-tools.js";

/**
 * An override line about "a codemode script" describes Pi's native codemode
 * results (`nativeTools.*`, or `tools.*` in the native profile), not the
 * Fabric results of `pi.*` and `extensions.*`. Dropped here (and relabelled
 * "nativeTools only: " on the fabric_exec description in the additive profile);
 * the compatibility block below states what holds for programs.
 */
export { isCodemodeScriptGuideline };

/** Fabric-authored program contract for an anchor-aware read override (hashline). */
export const ANCHOR_READ_COMPATIBILITY_GUIDANCE = [
  "Program results with this read override:",
  "- `pi.read(path)` returns plain file text; `pi.read({path, anchors: true})` returns `anchor│content` rows (a string) for `extensions.replace`/`replace_match`/`insert`.",
  "- `pi.grep` returns anchored rows as a string. `nativeTools.read({path, anchors: true})` returns `{ text, lines[].anchor }`; `nativeTools.grep` returns `{ text, results }`.",
  "- `extensions.<edit tool>` resolves to `{ text, details, structuredContent }` and rejects on failure; `structuredContent.anchors[].anchor` holds fresh anchors for the next edit. `pi.write`/`pi.edit` reject too, e.g. a write refused for copied anchors.",
].join("\n");

const anchorReadCompatibilityGuidance = (kernel: FabricKernel, hasGrepOverride: boolean): string => {
  if (kernel === "typescript" && hasGrepOverride) return ANCHOR_READ_COMPATIBILITY_GUIDANCE;
  if (kernel === "python") {
    return [
      "Program results with this read override:",
      "- `pi.read(path)` returns plain file text; `pi.read(path=path, anchors=True)` returns `anchor│content` rows (a string) for `extensions.replace`/`replace_match`/`insert`.",
      ...(hasGrepOverride ? ["- `pi.grep` returns anchored rows as a string."] : []),
      "- `extensions.<edit tool>` returns a dict with `text`, `details`, and `structuredContent` and raises on failure; `structuredContent[\"anchors\"]` holds fresh anchors for the next edit. `pi.write`/`pi.edit` raise on failure too, e.g. a write refused for copied anchors.",
    ].join("\n");
  }
  return [
    "Program results with this read override:",
    "- `pi.read(path)` returns plain file text; `pi.read({path, anchors: true})` returns `anchor│content` rows (a string) for `extensions.replace`/`replace_match`/`insert`.",
    "- `nativeTools.read({path, anchors: true})` returns `{ text, lines[].anchor }`.",
    "- `extensions.<edit tool>` resolves to `{ text, details, structuredContent }` and rejects on failure; `structuredContent.anchors[].anchor` holds fresh anchors for the next edit. `pi.write`/`pi.edit` reject too, e.g. a write refused for copied anchors.",
  ].join("\n");
};

// The hashline contract is the read tool's own `anchors` parameter. An output
// schema alone says nothing about anchored rows or edit anchors.
const anchorAwareRead = (definition: { parameters?: unknown }): boolean => {
  const properties = (definition.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  return properties !== undefined && Object.hasOwn(properties, "anchors");
};

/**
 * Append authored guidance from the current exact-name core overrides without
 * presenting those definitions as separate extension tools.
 */
export const coreOverridePromptGuidance = (
  catalog: CapturedToolCatalog,
  allowlist?: { has(name: string): boolean },
  options?: { kernel?: FabricKernel },
): string => {
  const kernel = options?.kernel ?? "typescript";
  const hasGrepOverride = Boolean(catalog.get("grep") && (!allowlist || allowlist.has("grep")));
  const sections: string[] = [];
  for (const name of PI_CORE_TOOL_NAMES) {
    if (allowlist && !allowlist.has(name)) continue;
    const entry = catalog.get(name);
    if (!entry) continue;
    const lines: string[] = [];
    if (entry.definition.promptSnippet) {
      lines.push(`Additional guidance for \`pi.${name}\`: ${entry.definition.promptSnippet}`);
    }
    const guidelines = (entry.definition.promptGuidelines ?? []).filter((guideline) => !isCodemodeScriptGuideline(guideline));
    if (guidelines.length > 0) {
      lines.push(`Guidelines for \`pi.${name}\`:`);
      lines.push(...guidelines.map((guideline) => `- ${guideline}`));
    }
    if (name === "read" && anchorAwareRead(entry.definition)) {
      lines.push(anchorReadCompatibilityGuidance(kernel, hasGrepOverride));
    }
    if (lines.length > 0) sections.push(lines.join("\n"));
  }
  return sections.length > 0
    ? `\n\nEffective compatible core override guidance:\n${sections.join("\n")}`
    : "";
};
