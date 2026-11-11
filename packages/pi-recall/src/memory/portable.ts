// Portable memory sources: a versioned, host-embeddable interface that feeds
// explicit authorized session snapshots into the existing memory engine. This
// module stays lightweight: no extension, UI, command, or provider runtime.
import type { FabricScope } from "../protocol.js";

export const MEMORY_SOURCE_INTERFACE_VERSION = 1;

export type MemorySourceRecord = { [key: string]: unknown };

export interface MemorySourceSessionMetadata {
  sessionId?: string;
  title?: string;
  cwd?: string;
  updatedAt?: number;
}

/**
 * Adapter-reported coverage of its own retained data. Omit (or omit
 * `complete`) only when the adapter returned everything it currently holds;
 * an adapter that caps enumeration or record loading must report
 * `complete: false` with a stable machine-readable reason so the engine never
 * presents a silently truncated archive as authoritative.
 */
export interface MemorySourceCoverage {
  complete: boolean;
  reason?: string;
}

export interface MemorySourceSessionDescriptor {
  sessionKey: string;
  sessionId?: string;
  revision: string;
  metadata?: MemorySourceSessionMetadata;
}

export interface MemorySourceSnapshot extends MemorySourceSessionDescriptor {
  records: readonly MemorySourceRecord[];
  /** Authoritative live leaf; null means an empty active path, omitted uses persisted semantics. */
  selectedLeafId?: string | null;
  /** Record-loading coverage; omitted means complete. */
  coverage?: MemorySourceCoverage;
}

export interface MemorySourceListPage {
  sessions: readonly MemorySourceSessionDescriptor[];
  /** Enumeration coverage; omitted means complete. */
  coverage?: MemorySourceCoverage;
}

export type MemorySourceAction = "list" | "recall" | "expand";

export interface MemorySourceRequestContext {
  signal?: AbortSignal;
}

export interface PortableMemorySource {
  readonly interfaceVersion: typeof MEMORY_SOURCE_INTERFACE_VERSION;
  readonly id: string;
  listSessions(
    request: { limit: number } & MemorySourceRequestContext,
  ): Promise<readonly MemorySourceSessionDescriptor[] | MemorySourceListPage>;
  loadSession(
    sessionKey: string,
    request: MemorySourceRequestContext,
  ): Promise<MemorySourceSnapshot | null>;
  /** `scope` is the caller's host-issued scope, so a source can filter before content enters context. */
  authorize?(
    action: MemorySourceAction,
    sessionKey: string | null,
    scope?: Readonly<FabricScope>,
  ): boolean | Promise<boolean>;
}

export type MemorySourceErrorCode =
  | "source_not_found"
  | "source_unauthorized"
  | "invalid_source_response"
  | "session_not_found"
  | "aborted";

export class MemorySourceError extends Error {
  constructor(
    readonly code: MemorySourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MemorySourceError";
  }
}

const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const isRecord = (value: unknown): value is MemorySourceRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const assertValidSource = (source: PortableMemorySource): void => {
  if (!isRecord(source) || typeof source !== "object") {
    throw new TypeError("A portable memory source must be an object");
  }
  if (source.interfaceVersion !== MEMORY_SOURCE_INTERFACE_VERSION) {
    throw new TypeError(
      `Portable memory source interface version must be ${MEMORY_SOURCE_INTERFACE_VERSION}`,
    );
  }
  if (typeof source.id !== "string" || !SOURCE_ID_PATTERN.test(source.id)) {
    throw new TypeError(
      "Portable memory source id must be 1-128 chars of letters, digits, dot, underscore, or dash",
    );
  }
  if (typeof source.listSessions !== "function" || typeof source.loadSession !== "function") {
    throw new TypeError("A portable memory source requires listSessions and loadSession");
  }
};

/** Validate a portable memory source at registration time; returns it unchanged. */
export const defineMemorySource = (source: PortableMemorySource): PortableMemorySource => {
  assertValidSource(source);
  return source;
};

export interface MemorySourceRegistry {
  register(source: PortableMemorySource): void;
  get(id: string): PortableMemorySource | undefined;
  ids(): readonly string[];
}

export const createMemorySourceRegistry = (): MemorySourceRegistry => {
  const sources = new Map<string, PortableMemorySource>();
  return {
    register(source: PortableMemorySource) {
      assertValidSource(source);
      sources.set(source.id, source);
    },
    get(id: string) {
      return sources.get(id);
    },
    ids() {
      return [...sources.keys()].sort();
    },
  };
};
