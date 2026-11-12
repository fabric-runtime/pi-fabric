// Severed seam of the pi-fabric extraction: only the memory-section config
// *shape* and defaults cross the boundary. Field-for-field identical to the
// fork's FabricMemoryConfig / FabricMemorySourceConfig (src/config.ts), so
// src/memory/* stays byte-identical; the engine's fabric.json parsing and the
// extractive subsection stay fork-side (extractive-history is live-prompt
// machinery wired into the engine's extension, not the recall module).

export interface FabricMemorySourceConfig {
  /** Registry id used as `args.source` in source-qualified memory calls. */
  id: string;
  /** Adapter kind; `"fs"` walks a local directory of session JSONL files. */
  kind: "fs";
  /** Absolute directory the `fs` adapter enumerates recursively. */
  root: string;
}

export interface FabricMemoryConfig {
  enabled: boolean;
  indexDir?: string;
  maxSessions: number;
  maxEntryChars: number;
  indexThinking: boolean;
  indexToolOutput: boolean;
  hotSessions?: number;
  digestTerms?: number;
  maxColdVocabularyBytes?: number;
  maxColdCacheBytes?: number;
  maxSyncSessions?: number;
  maxSyncSourceBytes?: number;
  maxCacheCleanupFiles?: number;
  regexMaxPatternBytes?: number;
  regexMaxHaystackTerms?: number;
  regexMaxHaystackBytes?: number;
  regexTimeoutMs?: number;
  /** Configured portable sources; present enables source-qualified calls. */
  sources?: FabricMemorySourceConfig[];
}

/** Defaults mirror the fork's DEFAULT_FABRIC_CONFIG.memory exactly; the
 * default index location (`${agentDir}/fabric/memory-index`) is applied by
 * resolveIndexOptions in src/memory/request-context.ts, unchanged. */
export const DEFAULT_MEMORY_CONFIG: FabricMemoryConfig = {
  enabled: true,
  maxSessions: 500,
  maxEntryChars: 2_000,
  indexThinking: false,
  indexToolOutput: true,
  hotSessions: 50,
  digestTerms: 200,
  maxColdVocabularyBytes: 512 * 1024,
  maxColdCacheBytes: 1024 * 1024,
  maxSyncSessions: 10_000,
  maxSyncSourceBytes: 512 * 1024 * 1024,
  maxCacheCleanupFiles: 100_000,
  regexMaxPatternBytes: 1_024,
  regexMaxHaystackTerms: 20_000,
  regexMaxHaystackBytes: 2 * 1024 * 1024,
  regexTimeoutMs: 250,
};

/** Index-directory override for this package's surfaces (CLI, pi extension).
 * The engine fork has no env override (fabric.json is its channel); tests and
 * multi-machine mounts point writes at isolated trees through this variable —
 * never at the live index of another contour. */
export const INDEX_DIR_ENV = "PI_RECALL_INDEX_DIR";

export const resolveMemoryConfig = (overrides: Partial<FabricMemoryConfig> = {}): FabricMemoryConfig => {
  const indexDir = process.env[INDEX_DIR_ENV];
  return {
    ...DEFAULT_MEMORY_CONFIG,
    ...overrides,
    ...(indexDir !== undefined && indexDir !== "" ? { indexDir } : {}),
  };
};
