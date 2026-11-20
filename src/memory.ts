// Lightweight public memory-source entry (pi-fabric/memory): portable source
// registration plus the explicit host client. No extension, UI, or command
// runtime is loaded through this subpath.
export {
  MEMORY_SOURCE_INTERFACE_VERSION,
  MemorySourceError,
  createMemorySourceRegistry,
  defineMemorySource,
} from "./memory/portable.js";
export type {
  MemorySourceAction,
  MemorySourceCoverage,
  MemorySourceErrorCode,
  MemorySourceListPage,
  MemorySourceRecord,
  MemorySourceRegistry,
  MemorySourceRequestContext,
  MemorySourceSessionDescriptor,
  MemorySourceSessionMetadata,
  MemorySourceSnapshot,
  PortableMemorySource,
} from "./memory/portable.js";
export { createConfiguredMemorySourceRegistry, createFileSystemMemorySource } from "./memory/fs-source.js";
export type { FileSystemMemorySourceOptions } from "./memory/fs-source.js";
export type {
  MemorySourceCallOptions,
  MemorySourceClientOptions,
} from "./memory/client.js";
export { createMemorySourceClient } from "./memory/client.js";
export { createMemoryProvider } from "./memory/provider.js";
export type { MemoryProviderAction, MemoryProviderDispatch, MemoryProviderOptions } from "./memory/provider.js";
export { memoryActionSchemas } from "./providers/memory-provider.js";

// Standalone-consumer surface (pi-recall wrapper): the names the CLI layer
// imports directly instead of going through provider machinery.
export { AmbiguousSessionError, enumerateAllSessions } from "./memory/discovery.js";
export { MEMORY_CACHE_VERSION, bm25Score, loadTieredIndex } from "./memory/index.js";
export { MemoryRequestCache } from "./memory/request-cache.js";
export { planMemoryQuery } from "./memory/tokenize.js";
export { presentRecall } from "./memory/context.js";
export { processMemoryExpand } from "./memory/expand-service.js";
export { processMemoryOutline } from "./memory/outline-service.js";
export { processMemoryRecall } from "./memory/recall-service.js";
export { processMemorySessions } from "./memory/sessions-service.js";
export { recallFailure, resolveIndexOptions } from "./memory/request-context.js";
export type { MemoryProviderContext } from "./memory/request-context.js";
export { searchMemoryIndex } from "./memory/search.js";

// Request-limit constants and shard types for standalone consumers.
export {
  EXPAND_DEFAULT_MAX_CHARS,
  EXPAND_DEFAULT_MAX_ENTRIES,
  EXPAND_MAX_CHARS,
  EXPAND_MAX_CONTEXT,
  EXPAND_MAX_ENTRIES,
  EXPAND_MAX_EXACT_SELECTORS,
  OUTLINE_MAX_ENTRIES,
} from "./memory/request-limits.js";
export {
  RECALL_DEFAULT_PAGE_SIZE,
  RECALL_DEFAULT_SNIPPET_CHARS,
  RECALL_MAX_PAGE_SIZE,
  RECALL_MAX_SNIPPET_CHARS,
} from "./memory/context.js";
export type { Shard, DigestShard } from "./memory/index.js";
