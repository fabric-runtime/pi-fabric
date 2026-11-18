// Severed seam of the pi-fabric extraction: only the memory-section config
// *shape* and defaults cross the boundary. Field-for-field identical to the
// fork's FabricMemoryConfig / FabricMemorySourceConfig (src/config.ts), so
// src/memory/* stays byte-identical; the engine's fabric.json parsing and the
// extractive subsection stay fork-side (extractive-history is live-prompt
// machinery wired into the engine's extension, not the recall module).
//
// The memory *subsection* parser below is a verbatim port of the fork's
// normalizeFabricConfig memory rules (commit ef0c4ceb): wrong-typed scalars
// fall back to defaults, but a present `sources` array with a malformed entry
// is a hard config error. Only the memory section is ever read from
// fabric.json — the file layer never writes, migrates, or validates any other
// section, and unknown keys inside memory are ignored.
import fs from "node:fs";
import path from "node:path";

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

const readFabricJson = (filePath: string): Record<string, unknown> | undefined => {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  if (!source.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

// Ported verbatim from the fork's src/config.ts (commit ef0c4ceb) so error
// coordinates and clamp tables stay identical across engine and recall tiers.
const objectValue = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const booleanValue = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const boundedInteger = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isInteger(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;

const MEMORY_SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,127}$/;

/**
 * Parse `memory.sources`. A wrong-typed value stays absent like every other
 * memory key, but a present array with malformed entries is a hard config
 * error: a silently dropped source would surface only as a confusing
 * `source_not_found` at call time. The id charset is the portable registry's
 * SOURCE_ID_PATTERN restricted to lowercase.
 */
const memorySourcesValue = (value: unknown): FabricMemorySourceConfig[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const sources: FabricMemorySourceConfig[] = [];
  const seen = new Set<string>();
  value.forEach((raw, index) => {
    const entry = objectValue(raw);
    const where = `memory.sources[${index}]`;
    const id = stringValue(entry.id);
    if (!id || !MEMORY_SOURCE_ID_PATTERN.test(id)) {
      throw new Error(
        `Invalid ${where}: id must be 1-128 chars of lowercase letters, digits, dot, underscore, or dash, starting with a letter or digit`,
      );
    }
    if (entry.kind !== "fs") {
      throw new Error(
        `Invalid ${where}: unknown kind ${JSON.stringify(entry.kind ?? null)}; expected "fs"`,
      );
    }
    const root = stringValue(entry.root);
    if (!root || !path.isAbsolute(root)) {
      throw new Error(`Invalid ${where}: root must be an absolute directory path`);
    }
    if (seen.has(id)) {
      throw new Error(`Invalid ${where}: duplicate source id ${JSON.stringify(id)}`);
    }
    seen.add(id);
    sources.push({ id, kind: "fs", root });
  });
  return sources.length > 0 ? sources : undefined;
};

// Port of the fork's normalizeFabricConfig memory subsection (commit ef0c4ceb):
// same fields, same clamp tables, same defaults source. Wrong-typed scalars
// stay at their defaults; only a malformed present `sources` array throws.
const parseMemorySection = (memory: Record<string, unknown>): FabricMemoryConfig => {
  const memoryIndexDir = stringValue(memory.indexDir);
  const memorySources = memorySourcesValue(memory.sources);
  return {
    enabled: booleanValue(memory.enabled, DEFAULT_MEMORY_CONFIG.enabled),
    ...(memoryIndexDir ? { indexDir: memoryIndexDir } : {}),
    ...(memorySources ? { sources: memorySources } : {}),
    maxSessions: boundedInteger(
      memory.maxSessions,
      DEFAULT_MEMORY_CONFIG.maxSessions,
      1,
      100_000,
    ),
    maxEntryChars: boundedInteger(
      memory.maxEntryChars,
      DEFAULT_MEMORY_CONFIG.maxEntryChars,
      100,
      1_000_000,
    ),
    indexThinking: booleanValue(
      memory.indexThinking,
      DEFAULT_MEMORY_CONFIG.indexThinking ?? false,
    ),
    indexToolOutput: booleanValue(
      memory.indexToolOutput,
      DEFAULT_MEMORY_CONFIG.indexToolOutput ?? true,
    ),
    hotSessions: boundedInteger(
      memory.hotSessions,
      DEFAULT_MEMORY_CONFIG.hotSessions ?? 50,
      0,
      100_000,
    ),
    digestTerms: boundedInteger(
      memory.digestTerms,
      DEFAULT_MEMORY_CONFIG.digestTerms ?? 200,
      1,
      10_000,
    ),
    maxColdVocabularyBytes: boundedInteger(
      memory.maxColdVocabularyBytes,
      DEFAULT_MEMORY_CONFIG.maxColdVocabularyBytes ?? 512 * 1024,
      2,
      64 * 1024 * 1024,
    ),
    maxColdCacheBytes: boundedInteger(
      memory.maxColdCacheBytes,
      DEFAULT_MEMORY_CONFIG.maxColdCacheBytes ?? 1024 * 1024,
      512,
      128 * 1024 * 1024,
    ),
    maxSyncSessions: boundedInteger(
      memory.maxSyncSessions,
      DEFAULT_MEMORY_CONFIG.maxSyncSessions ?? 10_000,
      1,
      1_000_000,
    ),
    maxSyncSourceBytes: boundedInteger(
      memory.maxSyncSourceBytes,
      DEFAULT_MEMORY_CONFIG.maxSyncSourceBytes ?? 512 * 1024 * 1024,
      1_024,
      8 * 1024 * 1024 * 1024,
    ),
    maxCacheCleanupFiles: boundedInteger(
      memory.maxCacheCleanupFiles,
      DEFAULT_MEMORY_CONFIG.maxCacheCleanupFiles ?? 100_000,
      1,
      1_000_000,
    ),
    regexMaxPatternBytes: boundedInteger(
      memory.regexMaxPatternBytes,
      DEFAULT_MEMORY_CONFIG.regexMaxPatternBytes ?? 1_024,
      1,
      64 * 1024,
    ),
    regexMaxHaystackTerms: boundedInteger(
      memory.regexMaxHaystackTerms,
      DEFAULT_MEMORY_CONFIG.regexMaxHaystackTerms ?? 20_000,
      1,
      1_000_000,
    ),
    regexMaxHaystackBytes: boundedInteger(
      memory.regexMaxHaystackBytes,
      DEFAULT_MEMORY_CONFIG.regexMaxHaystackBytes ?? 2 * 1024 * 1024,
      1_024,
      128 * 1024 * 1024,
    ),
    regexTimeoutMs: boundedInteger(
      memory.regexTimeoutMs,
      DEFAULT_MEMORY_CONFIG.regexTimeoutMs ?? 250,
      10,
      10_000,
    ),
  };
};

/** Config file locations feeding the read-only fabric.json layer. Absent keys
 *  mean "do not touch the filesystem" — the pure defaults+env+overrides path
 *  used by tests and embedding hosts. */
export interface MemoryConfigFiles {
  /** Directory whose fabric.json is read first (the agent tree). */
  agentDir?: string;
  /** Working directory whose .pi/fabric.json merges on top when explicitly trusted. */
  cwd?: string;
  projectTrusted?: boolean;
}

/** Resolution order (later wins), mirroring the engine's resolveFabricConfig
 *  (agent-dir plan first, project merge second):
 *  1. DEFAULT_MEMORY_CONFIG
 *  2. memory section of ${agentDir}/fabric.json
 *  3. memory section of ${cwd}/.pi/fabric.json, only when trusted
 * 4. explicit overrides (tests / embedding hosts)
 * 5. PI_RECALL_INDEX_DIR (the existing write-path override)
 * A missing or unparseable file at either location is skipped silently, and
 * only the memory section is ever consulted: this layer never writes,
 * migrates, or validates the rest of fabric.json. */
export const resolveMemoryConfig = (
  overrides: Partial<FabricMemoryConfig> = {},
  files: MemoryConfigFiles = {},
): FabricMemoryConfig => {
  let memoryDocument: Record<string, unknown> = {};
  const plans = [
    files.agentDir !== undefined
      ? readFabricJson(path.join(files.agentDir, "fabric.json"))
      : undefined,
    files.cwd !== undefined && files.projectTrusted === true
      ? readFabricJson(path.join(files.cwd, ".pi", "fabric.json"))
      : undefined,
  ].filter((document): document is Record<string, unknown> => document !== undefined);
  for (const document of plans) {
    memoryDocument = { ...memoryDocument, ...objectValue(document.memory) };
  }
  const indexDir = process.env[INDEX_DIR_ENV];
  return {
    ...DEFAULT_MEMORY_CONFIG,
    ...parseMemorySection(memoryDocument),
    ...overrides,
    ...(indexDir !== undefined && indexDir !== "" ? { indexDir } : {}),
  };
};
