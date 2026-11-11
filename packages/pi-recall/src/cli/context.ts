// CLI context factory — shared by bin/pi-recall and tests. Mirrors the fork's
// standalone tiers (src/external/recall-standalone.ts): default agent tree via
// resolveAgentDir (PI_CODING_AGENT_DIR honored), memory defaults via
// resolveMemoryConfig (PI_RECALL_INDEX_DIR honored — the write-path override).
import { resolveAgentDir } from "../core/agent-dir.js";
import { resolveMemoryConfig } from "../config.js";
import type { FabricMemoryConfig } from "../config.js";
import type { MemoryProviderContext } from "../memory/request-context.js";

export const buildCliContext = (
  overrides: {
    agentDir?: string;
    cwd?: string;
    config?: Partial<FabricMemoryConfig>;
    sessionId?: string;
    sessionFile?: string;
  } = {},
): MemoryProviderContext => ({
  agentDir: overrides.agentDir ?? resolveAgentDir(),
  cwd: overrides.cwd ?? process.cwd(),
  config: resolveMemoryConfig(overrides.config),
  ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
  ...(overrides.sessionFile !== undefined ? { sessionFile: overrides.sessionFile } : {}),
});
