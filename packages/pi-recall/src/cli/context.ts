// CLI context factory — shared by bin/pi-recall and tests. Mirrors the fork's
// standalone tiers (src/external/recall-standalone.ts): default agent tree via
// resolveAgentDir (PI_CODING_AGENT_DIR honored), memory defaults via
// resolveMemoryConfig (fabric.json file layer + PI_RECALL_INDEX_DIR — the
// write-path override).
import { resolveAgentDir } from "../core/agent-dir.js";
import { resolveMemoryConfig } from "../config.js";
import type { FabricMemoryConfig } from "../config.js";
import { createConfiguredMemorySourceRegistry } from "../memory/fs-source.js";
import type { MemoryProviderContext } from "../memory/request-context.js";

export const buildCliContext = (
  overrides: {
    agentDir?: string;
    cwd?: string;
    projectTrusted?: boolean;
    config?: Partial<FabricMemoryConfig>;
    sessionId?: string;
    sessionFile?: string;
  } = {},
): MemoryProviderContext => {
  const agentDir = overrides.agentDir ?? resolveAgentDir();
  const cwd = overrides.cwd ?? process.cwd();
  const config = resolveMemoryConfig(overrides.config, { agentDir, cwd, projectTrusted: overrides.projectTrusted === true });
  return {
    agentDir,
    cwd,
    config,
    // Mirror extensions/memory.ts seeding: configured fs sources answer
    // source-qualified CLI calls. Absent sources keep the context shape
    // identical to the pre-file-layer behavior.
    ...(config.sources !== undefined && config.sources.length > 0
      ? { sources: createConfiguredMemorySourceRegistry(config.sources) }
      : {}),
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    ...(overrides.sessionFile !== undefined ? { sessionFile: overrides.sessionFile } : {}),
  };
};
