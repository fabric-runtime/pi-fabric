import path from "node:path";
import type { FabricMemoryConfig } from "../config.js";
import type { MemorySourceRegistry } from "./portable.js";
import type { FabricScope } from "../protocol.js";
import {
  enumerateAllSessions,
  resolveScope,
  type ResolveScopeInput,
  type SessionRef,
} from "./discovery.js";
import type { LiveSessionBranch, MemoryBranches } from "./lineage.js";
import { DEFAULT_HOT_SESSIONS, type MemoryIndexOptions } from "./index.js";

export interface MemoryProviderContext {
  agentDir: string;
  cwd: string;
  config: FabricMemoryConfig;
  sessionId?: string;
  sessionFile?: string;
  getLiveBranch?: () => LiveSessionBranch;
  /** Registered portable memory sources; present enables host-backed calls. */
  sources?: MemorySourceRegistry;
  /** Per-call host-issued scope: forwarded to source authorization and keyed into request caches. */
  fabricScope?: Readonly<FabricScope>;
}

export const parseBranches = (value: unknown, action: string): MemoryBranches => {
  if (value === undefined) return "active";
  if (value === "active" || value === "all") return value;
  throw new Error(`${action} branches must be "active" or "all"`);
};

export const resolveIndexOptions = (
  config: FabricMemoryConfig,
  agentDir: string,
  branches: MemoryBranches,
  liveBranchForFile?: MemoryIndexOptions["liveBranchForFile"],
): MemoryIndexOptions => ({
  indexDir: config.indexDir ?? `${agentDir}/fabric/memory-index`,
  maxEntryChars: config.maxEntryChars,
  branches,
  indexThinking: config.indexThinking ?? false,
  indexToolOutput: config.indexToolOutput ?? true,
  ...(liveBranchForFile ? { liveBranchForFile } : {}),
  hotSessions: config.hotSessions ?? DEFAULT_HOT_SESSIONS,
  digestTerms: config.digestTerms ?? 200,
  ...(config.maxColdVocabularyBytes === undefined
    ? {} : { maxColdVocabularyBytes: config.maxColdVocabularyBytes }),
  ...(config.maxColdCacheBytes === undefined ? {} : { maxColdCacheBytes: config.maxColdCacheBytes }),
  ...(config.maxSyncSessions === undefined ? {} : { maxSyncSessions: config.maxSyncSessions }),
  ...(config.maxSyncSourceBytes === undefined ? {} : { maxSyncSourceBytes: config.maxSyncSourceBytes }),
  ...(config.maxCacheCleanupFiles === undefined
    ? {} : { maxCacheCleanupFiles: config.maxCacheCleanupFiles }),
});

export const resolveTierRefs = (refs: SessionRef[], context: MemoryProviderContext): SessionRef[] => {
  const all = enumerateAllSessions(context.agentDir, Number.MAX_SAFE_INTEGER);
  const known = new Set(all.map((ref) => ref.file));
  for (const ref of refs) {
    if (!known.has(ref.file)) all.push(ref);
  }
  return all;
};

export const resolveRefs = (
  scope: string | undefined,
  context: MemoryProviderContext,
  boundedBrowse: boolean,
): SessionRef[] => {
  const effectiveScope = scope ?? "session";
  const input: ResolveScopeInput = {
    agentDir: context.agentDir,
    cwd: context.cwd,
    scope: effectiveScope,
    maxSessions: boundedBrowse ? context.config.maxSessions : Number.MAX_SAFE_INTEGER,
  };
  if (context.sessionId) input.sessionId = context.sessionId;
  if (context.sessionFile) input.sessionFile = context.sessionFile;
  return resolveScope(input);
};

export const liveBranchResolver = (
  context: MemoryProviderContext,
): MemoryIndexOptions["liveBranchForFile"] | undefined => {
  if (!context.sessionFile || !context.getLiveBranch) return undefined;
  const current = path.resolve(context.sessionFile);
  return (sessionFile) => path.resolve(sessionFile) === current
    ? context.getLiveBranch?.()
    : undefined;
};

export const stalePointerError = (
  sessionFile: string,
  expectedSourceHash: string | undefined,
  actualSourceHash: string,
  expectedLineageFingerprint?: string,
  actualLineageFingerprint?: string,
) => ({
  code: "stale_pointer",
  message: expectedLineageFingerprint !== undefined &&
    expectedLineageFingerprint !== actualLineageFingerprint
    ? "Session active lineage changed after the pointer was issued."
    : "Session source changed after the pointer was issued.",
  sessionFile,
  ...(expectedSourceHash === undefined ? {} : { expectedSourceHash }),
  actualSourceHash,
  ...(expectedLineageFingerprint === undefined ? {} : { expectedLineageFingerprint }),
  ...(actualLineageFingerprint === undefined ? {} : { actualLineageFingerprint }),
});

export const addressError = (message: string, entryCount?: number) => ({
  code: "index_out_of_bounds",
  message,
  ...(entryCount === undefined ? {} : { entryCount }),
});

export const recallFailure = (error: { code: string; message: string; [key: string]: unknown }) => ({
  total: 0,
  hits: [],
  next: null,
  coverage: {
    complete: false,
    indexedSessions: 0,
    eligibleSessions: 0,
    staleSessions: 0,
    incompleteSessions: 0,
    reasons: [error.code],
  },
  error,
});
