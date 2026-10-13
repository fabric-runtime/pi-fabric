import fs from "node:fs";
import path from "node:path";
import { resolveAgentDir } from "../core/agent-dir.js";

// The tuner's learned rules: one user-owned Markdown file that enters the
// system prompt when `tuner.enabled` is true. `pi-fabric tune` writes
// candidates of this file and keeps the ones that score better.

/** Hard bounds on the learned rules; the tuner discards a candidate above them. */
export const MAX_LEARNED_CHARS = 8_000;
export const MAX_LEARNED_LINES = 200;

export const learnedRulesPath = (agentDir: string = resolveAgentDir()): string =>
  path.join(agentDir, "fabric", "tuner", "learned.md");

/** System-prompt section for the learned rules; undefined when there are none. */
export const readLearnedGuidance = (agentDir?: string): string | undefined => {
  let text: string;
  try {
    text = fs.readFileSync(learnedRulesPath(agentDir), "utf8").trim();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  return `## Learned rules\n\nThese rules come from measured task runs in this environment (pi-fabric tuner). Obey them.\n\n${text.slice(0, MAX_LEARNED_CHARS)}`;
};
