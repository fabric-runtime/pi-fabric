// Severed seam of the pi-fabric extraction: the memory module touches the
// engine protocol only through these *types*. They are carried over
// structurally identical (field-for-field with fork src/protocol.ts) so the
// copied memory sources type-check unmodified; no runtime behavior from the
// protocol module is used. The invocation context keeps only the fields the
// memory services read (update/signal/scope) plus the host identity fields
// they thread through — the full engine context (humanWait, participants, …)
// stays fork-side.

export type FabricScopeAction = "read" | "write" | "execute";
export interface FabricScopeGrant {
  /** `<ns>:<path>`, `<ns>:<path>/*` (one level), `<ns>:<path>/**` (any depth) or `<ns>:*`. */
  resource: string;
  actions: FabricScopeAction[];
}
export interface FabricScope {
  version: 1;
  principal: { id: string; issuer: "host" };
  /** At most 64, merged per resource and sorted. */
  grants: FabricScopeGrant[];
  /** sha256 hex of canonical JSON { grants, parentDigest?, principal }. */
  digest: string;
  parentDigest?: string;
}

export interface FabricInvocationContext {
  cwd: string;
  signal: AbortSignal | undefined;
  parentToolCallId: string;
  nestedToolCallId: string;
  /** Host context object; memory services thread it but never read it. */
  extensionContext: unknown;
  update(message: string): void;
  /** Host-issued per-call scope; keyed into request caches, forwarded to sources. */
  scope?: Readonly<FabricScope>;
}

export type FabricRisk = "read" | "write" | "execute" | "network" | "agent";
export type FabricEffectKind = "none" | "scoped" | "transactional" | "emission";
export type FabricEffectOrdering = "commutative" | "ordered" | "unknown";
export interface FabricActionEffect {
  kind: FabricEffectKind;
  resources?: string[];
  ordering?: FabricEffectOrdering;
}
export interface FabricToolAnnotations {
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

export interface FabricActionDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  risk: FabricRisk;
  namespace?: string;
  effect?: FabricActionEffect;
  annotations?: FabricToolAnnotations;
}

export interface FabricProviderListRequest {
  namespace?: string;
  query?: string;
  /** Optional presentation cap. Omitted means enumerate all matching descriptors. */
  limit?: number;
}

export interface FabricProvider {
  name: string;
  description: string;
  list(
    request: FabricProviderListRequest,
    context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]>;
  describe(
    actionName: string,
    context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined>;
  prepareArguments?(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown>;
  close?(): Promise<void>;
}
