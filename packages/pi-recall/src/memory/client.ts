import type { FabricMemoryConfig } from "../config.js";
import type { MemoryProviderContext } from "./request-context.js";
import { MemoryRequestCache } from "./request-cache.js";
import type { MemorySourceRegistry } from "./portable.js";
import type { FabricScope } from "../protocol.js";
import { processMemoryRecall } from "./recall-service.js";
import { processMemoryExpand } from "./expand-service.js";
import { processMemorySessions } from "./sessions-service.js";

export interface MemorySourceClientOptions {
  /** Registered portable memory sources; every call must name one by id. */
  sources: MemorySourceRegistry;
  /** Engine bounds override; filesystem indexDir is unused for host sources. */
  config?: Partial<FabricMemoryConfig>;
}

export interface MemorySourceCallOptions {
  /** Checked between adapter loads and index builds; aborted work fails with code "aborted". */
  signal?: AbortSignal;
  /** Host-issued caller scope: passed to source authorize() and keyed into the request cache. */
  scope?: FabricScope;
}

const CLIENT_CONFIG: FabricMemoryConfig = {
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

const requireSource = (args: Record<string, unknown> | undefined): string => {
  const source = args?.source;
  if (typeof source !== "string" || source.length === 0) {
    throw new TypeError(
      "Memory source client calls require args.source: a registered portable memory source id. There is no implicit filesystem fallback.",
    );
  }
  return source;
};

/**
 * Lightweight host entry for embedded memory sources. Bound calls resolve
 * only against the registered adapter: no filesystem index, no session
 * discovery, no ambient recall policy. Bounds, integrity pointers, coverage,
 * and provenance are the engine's own.
 */
export const createMemorySourceClient = (options: MemorySourceClientOptions) => {
  if (!options?.sources || typeof options.sources.get !== "function") {
    throw new TypeError("createMemorySourceClient requires a MemorySourceRegistry");
  }
  const context: MemoryProviderContext = {
    agentDir: "",
    cwd: "",
    config: { ...CLIENT_CONFIG, ...options.config },
    sources: options.sources,
  };
  const cache = new MemoryRequestCache();
  const scoped = (call: MemorySourceCallOptions | undefined): MemoryProviderContext =>
    call?.scope ? { ...context, fabricScope: call.scope } : context;
  return {
    recall: (args: { source: string } & Record<string, unknown>, call?: MemorySourceCallOptions) =>
      processMemoryRecall(
        { ...args, source: requireSource(args) },
        { update: () => {}, signal: call?.signal },
        scoped(call),
        cache,
      ),
    expand: (
      args: { source: string; session: string } & Record<string, unknown>,
      call?: MemorySourceCallOptions,
    ) => processMemoryExpand({ ...args, source: requireSource(args) }, scoped(call), cache, call?.signal),
    sessions: (args: { source: string } & Record<string, unknown>, call?: MemorySourceCallOptions) =>
      processMemorySessions({ ...args, source: requireSource(args) }, scoped(call), call?.signal),
  };
};
