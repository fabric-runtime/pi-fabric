// Public entry of pi-transcript-recall — the extracted pi-fabric memory
// module. Same shape as the fork's src/memory.ts subpath (portable source
// registration, explicit host client, provider factory, action schemas);
// the engine-only extractive subsection is not part of this package.
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
export { createMemorySourceClient } from "./memory/client.js";
export type {
  MemorySourceCallOptions,
  MemorySourceClientOptions,
} from "./memory/client.js";
export { createMemoryProvider } from "./memory/provider.js";
export type { MemoryProviderAction, MemoryProviderDispatch, MemoryProviderOptions } from "./memory/provider.js";
export { memoryActionSchemas, memoryActionDescriptors, normalizeMemoryArgs, MemoryProvider } from "./providers/memory-provider.js";
export { processMemoryRecall } from "./memory/recall-service.js";
export { processMemoryExpand } from "./memory/expand-service.js";
export { processMemorySessions } from "./memory/sessions-service.js";
export { MEMORY_CACHE_VERSION, DEFAULT_HOT_SESSIONS, shardPathForSession, digestPathForSession } from "./memory/index.js";
export type { MemoryIndexOptions, Shard, DigestShard } from "./memory/index.js";
export type { MemoryProviderContext } from "./memory/request-context.js";
export { resolveMemoryConfig, DEFAULT_MEMORY_CONFIG, INDEX_DIR_ENV } from "./config.js";
export type { FabricMemoryConfig, FabricMemorySourceConfig } from "./config.js";
