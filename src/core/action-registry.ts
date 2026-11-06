import type { ProviderOperations, ProviderOperation } from "./provider-operations.js";
import { CapabilityAuthority } from "../verified/authority.js";
import { randomUUID } from "node:crypto";
import { effectConflictsBetween, registrationEffect, summarizeEffects } from "../components/effect-policy.js";

/** Effective page size for registry list(): caller default 100, hard cap 1000.
 *  Exported so guest discovery surfaces slice identically to the registry. */
export const fabricActionListLimit = (limit?: number): number =>
  Math.max(1, Math.min(limit ?? 100, 1_000));
import { repairCatalogInput, validateCatalogArgs, validationMessage } from "./action-arguments.js";
import {
  MAX_AUDIT_VALUE_CHARS,
  boundedPreviewValue,
  boundedResult,
  strictDecisionResult,
  failedResultError,
  failedResultOutcome,
  previewArgs,
  previewResult,
} from "./action-result.js";
import { runAbortable, settleWithin, throwIfAborted } from "../async-settlement.js";
import type {
  FabricCapabilityRequirement,
  FabricComponentProviderLease,
} from "../components/types.js";
import {
  executionOutcomeFromError,
  FabricResolutionError,
  FabricTraceSafeError,
  type FabricExecutionTraceOperationHandle,
  type FabricExecutionTraceRecorder,
} from "../audit/trace.js";
import {
  FABRIC_NESTED_TOOL_CALL_ID_PREFIX,
  type FabricActionDescriptor,
  type FabricActionEffect,
  type FabricCapabilityBindingView,
  type FabricCapabilityCatalog,
  type FabricCapabilityResolution,
  type FabricCommittedCapabilityView,
  type FabricGuestTypeSources,
  type FabricInvocationActivityUpdate,
  type FabricInvocationContext,
  type FabricMediaBlock,
  type FabricNamedActionTypeSource,
  type FabricProvider,
  type FabricProviderListRequest,
  type FabricProviderTypeSource,
  type FabricScope,
  type FabricScopedProviderResult,
} from "../protocol.js";
import {
  formatUnknownActionMessage,
  repairActionName,
} from "./action-repair.js";
import {
  applyActiveActionName,
  applyActiveArgRepairs,
  getActiveRepairCompiler,
} from "../repairs/active.js";
import {
  activeQuarantinedRefNames,
  effectiveInputSchema,
  normalizeActiveArguments,
  isActiveQuarantine,
} from "../entropy/active.js";
import { formatFabricEffectConflict } from "./effect-conflict.js";
import { providerGlobalNames } from "../provider-globals.js";
import { stableJsonHash } from "./stable-hash.js";
import type {
  FabricSpeculationReplay,
  FabricSpeculationRuntime,
} from "../speculation/types.js";
import type { FabricNestedToolResultProxy } from "./tool-result-proxy.js";
import type { FabricHostPolicy } from "./host-policy.js";
import {
  FabricProviderBindings,
  type FabricProviderBinding,
  type FabricProviderBindingEvent,
} from "./provider-bindings.js";

export interface ResolvedFabricAction extends FabricActionDescriptor {
  ref: string;
  provider: string;
}

interface FabricEffectConflict {
  withRef: string;
  resources: string[];
  reason: "shared_resource" | "unknown_resource";
}

export interface FabricCallAudit {
  ref: string;
  nestedToolCallId: string;
  startedAt: number;
  endedAt?: number;
  success?: boolean;
  error?: string;
  resultChars?: number;
  resultTruncated?: boolean;
  tool?: string;
  provider?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  media?: FabricMediaBlock[];
  mediaNote?: string;
  preview?: unknown;
  effectConflicts?: FabricEffectConflict[];
  /** Result was pre-launched while the program streamed and served from the speculation store. */
  speculated?: boolean;
  /** Spelled action name that repaired to the canonical one at resolve (e.g. search → recall). */
  repairedFrom?: string;
  /** The provider reported a nested result with Pi's `terminate: true`. In memory only. */
  terminate?: true;
}

export type FabricRegistryActivityEvent =
  | {
      type: "call_start";
      callId: string;
      ref: string;
      args: Record<string, unknown>;
    }
  | {
      type: "call_update";
      callId: string;
      update: FabricInvocationActivityUpdate;
    }
  | {
      type: "call_args";
      callId: string;
      args: Record<string, unknown>;
    }
  | {
      type: "call_end";
      callId: string;
      success: boolean;
      result?: unknown;
      preview?: unknown;
      error?: string;
    };

export interface FabricCapabilityViewLease extends FabricCapabilityResolution {
  release(): Promise<void>;
}

/** Built-in providers that hide tools outside a child's allowlist. */
interface AllowlistAwareProvider extends FabricProvider {
  notPermitted?(actionName: string): string | undefined;
}

export interface FabricRegistryInvocationContext extends FabricInvocationContext {
  authorize?(action: ResolvedFabricAction): Promise<void>;
  approve(
    action: ResolvedFabricAction,
    args: Record<string, unknown>,
    /** Effective call lifetime, including runtime deadline and registry/binding revocation. */
    signal?: AbortSignal,
  ): Promise<void>;
  audits: FabricCallAudit[];
  maxResultChars: number;
  trace?: FabricExecutionTraceRecorder;
  traceOperation?: FabricExecutionTraceOperationHandle;
  observeInvocation?(event: FabricRegistryActivityEvent): void;
}

/**
 * Prefix pi-fabric prepends to every nested tool-call id it generates inside a
 * fabric_exec run (one per pi., mcp., or agents. invocation). Extensions can
 * detect that a tool_call/tool_result event came from a nested fabric call —
 * rather than a top-level call the LLM made directly — by checking
 * `event.toolCallId.startsWith(NESTED_TOOL_CALL_ID_PREFIX)`. The LLM's own
 * tool-call ids (e.g. openai "call_…", anthropic "toolu_…") never use this
 * prefix, so the signal is unambiguous.
 */
export const NESTED_TOOL_CALL_ID_PREFIX = FABRIC_NESTED_TOOL_CALL_ID_PREFIX;

const providerNamePattern = /^[a-z][a-z0-9_-]*$/;
/** A provider whose catalog is slower than this keeps a loose program global for that execution. */
const PROVIDER_TYPE_SOURCE_TIMEOUT_MS = 500;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Lexical, deliberately loose: a miss only leaves that global loosely typed. */
const usesProviderGlobal = (code: string, name: string): boolean =>
  new RegExp(`(?<![\\w$.])${name}\\s*(?:\\?\\.|\\.|\\[)`).test(code);

/** Copies only the named fields the declaration builder reads; never the descriptor. */
const actionTypeSource = (name: unknown, inputSchema: unknown): FabricNamedActionTypeSource | undefined =>
  typeof name === "string" && name.length > 0 && name.length <= 256
    ? { name, inputSchema: isPlainRecord(inputSchema) ? inputSchema : {} }
    : undefined;
/** Process-wide issuance record owned by src/scope.ts. */
const SCOPE_HOLDER = Symbol.for("pi-fabric:scope:v1");

/** structuredClone detaches ordinary nested references, but deliberately shares
 * SharedArrayBuffer backing memory. Such payloads cannot be approved as stable
 * snapshots, including when hidden in maps, views, cycles or Error.cause.
 */
const snapshotArguments = (args: Record<string, unknown>): Record<string, unknown> => {
  const snapshot = structuredClone(args);
  const pending: unknown[] = [snapshot];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
      throw new FabricTraceSafeError("Fabric argument snapshots cannot contain shared memory");
    }
    // WebAssembly.Memory has no own data properties; its backing buffer is
    // nevertheless shared by structuredClone and must be inspected explicitly.
    if (Object.prototype.toString.call(value) === "[object WebAssembly.Memory]") {
      pending.push((value as { buffer: unknown }).buffer);
      continue;
    }
    if (ArrayBuffer.isView(value)) {
      pending.push(value.buffer);
      continue;
    }
    if (value instanceof Map) for (const [key, entry] of value) pending.push(key, entry);
    if (value instanceof Set) for (const entry of value) pending.push(entry);
    for (const key of Reflect.ownKeys(value)) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (property && "value" in property) pending.push(property.value);
    }
  }
  return snapshot;
};

const resolveDescriptor = (
  provider: FabricProvider,
  descriptor: FabricActionDescriptor,
): ResolvedFabricAction => ({
  ...descriptor,
  effect: descriptor.effect ?? (descriptor.risk === "read"
    ? { kind: "none", ordering: "commutative" }
    : { kind: "emission", ordering: "unknown" }),
  provider: provider.name,
  ref: `${provider.name}.${descriptor.name}`,
});

const descriptorHash = stableJsonHash;

const actionDescriptorHash = (action: ResolvedFabricAction): string =>
  descriptorHash({
    ref: action.ref,
    description: action.description,
    inputSchema: action.inputSchema,
    outputSchema: action.outputSchema,
    risk: action.risk,
    namespace: action.namespace,
    effect: action.effect,
  });

const discoveryTerms = (value: string): string[] =>
  [...value.normalize("NFKC").matchAll(/[\p{L}\p{N}]+/gu)]
    .map((match) => match[0].toLowerCase());

export const scoreActionSearch = (
  query: string,
  action: {
    ref: string;
    name: string;
    description: string;
    provider: string;
    namespace?: string;
    inputSchema: unknown;
  },
  providerDescription = "",
): number => {
  const normalizedQuery = query.normalize("NFKC").trim().toLowerCase();
  if (!normalizedQuery) return 0;
  const queryTerms = [...new Set(discoveryTerms(normalizedQuery))];
  const ref = action.ref.normalize("NFKC").toLowerCase();
  const name = action.name.normalize("NFKC").toLowerCase();
  const description = action.description.normalize("NFKC").toLowerCase();
  const provider = action.provider.normalize("NFKC").toLowerCase();
  const providerBody = providerDescription.normalize("NFKC").toLowerCase();
  const namespace = (action.namespace ?? "").normalize("NFKC").toLowerCase();
  const schema = JSON.stringify(action.inputSchema ?? {}).normalize("NFKC").toLowerCase();
  const tokenSets = {
    ref: new Set(discoveryTerms(ref)),
    name: new Set(discoveryTerms(name)),
    description: new Set(discoveryTerms(description)),
    provider: new Set(discoveryTerms(provider)),
    providerBody: new Set(discoveryTerms(providerBody)),
    namespace: new Set(discoveryTerms(namespace)),
    schema: new Set(discoveryTerms(schema)),
  };
  const fields = Object.values(tokenSets);
  let score = 0;
  if (ref === normalizedQuery) score += 1_000;
  if (name === normalizedQuery) score += 800;
  if (ref.startsWith(normalizedQuery)) score += 300;
  else if (ref.includes(normalizedQuery)) score += 120;
  if (description.includes(normalizedQuery)) score += 40;
  if (providerBody.includes(normalizedQuery)) score += 20;
  if (schema.includes(normalizedQuery)) score += 10;
  let matchedTerms = 0;
  for (const term of queryTerms) {
    const matched = fields.some((field) => field.has(term));
    if (!matched) continue;
    matchedTerms += 1;
    if (tokenSets.ref.has(term) || tokenSets.name.has(term)) score += 30;
    if (tokenSets.provider.has(term)) score += 20;
    if (tokenSets.description.has(term)) score += 8;
    if (tokenSets.providerBody.has(term)) score += 4;
    if (tokenSets.namespace.has(term)) score += 6;
    if (tokenSets.schema.has(term)) score += 2;
  }
  if (queryTerms.length > 0 && matchedTerms === queryTerms.length) score += 15;
  return score;
};

const conflictBetween = (
  left: FabricActionEffect,
  right: FabricActionEffect,
): { resources: string[]; reason: FabricEffectConflict["reason"] } | undefined => {
  return effectConflictsBetween(
    summarizeEffects([registrationEffect({ label: "left", ...left })]),
    summarizeEffects([registrationEffect({ label: "right", ...right })]),
  )[0];
};

export class ActionRegistry {
  readonly #shutdown = new AbortController();
  readonly #views = new WeakMap<FabricCommittedCapabilityView, { controller: AbortController; signal: AbortSignal; authority: CapabilityAuthority }>();
  #operations: Promise<ProviderOperations> | undefined;
  readonly #providerBindings = new FabricProviderBindings();
  readonly #activeEffects = new Map<string, { ref: string; effect: FabricActionEffect }>();
  readonly #unavailable = new Map<string, string>();
  #unavailableResolver: ((name: string) => string | undefined) | undefined;
  #hostPolicy: FabricHostPolicy | undefined;
  #speculation: FabricSpeculationRuntime | undefined;
  #speculationEligibility: ((action: ResolvedFabricAction) => boolean) | undefined;

  constructor(readonly toolResultProxy?: FabricNestedToolResultProxy) {
    this.#providerBindings.subscribe(() => this.#speculation?.reset?.());
  }

  /**
   * Attach the speculative-PTC runtime. Eligibility is re-checked against the
   * resolved descriptor at launch and replay, so a config/captured-tool change
   * cannot sneak a side-effecting ref into the store after the fact.
   */
  setSpeculation(
    runtime: FabricSpeculationRuntime | undefined,
    eligibility?: (action: ResolvedFabricAction) => boolean,
  ): void {
    this.#speculation = runtime;
    this.#speculationEligibility = eligibility;
  }

  #allowsSpeculation(action: ResolvedFabricAction): boolean {
    const localRead = action.risk === "read" && action.effect?.kind === "none";
    // MCP keeps its conservative network/effect classification. Only the live
    // eligibility callback can attest an allowlisted read; explicit unsafe
    // annotations still refuse even if a custom callback opts it in.
    const mcpRead = action.provider === "mcp" && action.risk === "network" &&
      action.annotations?.destructiveHint !== true && action.annotations?.readOnlyHint !== false;
    return (localRead || mcpRead) && this.#speculationEligibility?.(structuredClone(action)) === true;
  }

  register(provider: FabricProvider, options: { overwrite?: boolean } = {}): void {
    this.mount(provider, options);
  }

  mount(
    provider: FabricProvider,
    options: { overwrite?: boolean; staged?: boolean } = {},
  ): FabricComponentProviderLease {
    if (this.#shutdown.signal.aborted) throw new Error("Fabric registry is closed");
    if (!providerNamePattern.test(provider.name)) {
      throw new Error(`Invalid Fabric provider name: ${provider.name}`);
    }
    const lease = this.#providerBindings.mount(provider, options);
    this.#unavailable.delete(provider.name);
    return lease;
  }

  activateProviderBindings(bindingIds: readonly string[]): string[] {
    return this.#providerBindings.activate(bindingIds);
  }

  subscribeProviderChanges(
    listener: (event: FabricProviderBindingEvent) => void,
  ): () => void {
    return this.#providerBindings.subscribe(listener);
  }

  notifyCatalogChanged(provider: string): void {
    this.#providerBindings.notifyCatalogChanged(provider);
  }

  has(name: string): boolean {
    return this.#providerBindings.has(name);
  }

  setUnavailableResolver(resolve: (name: string) => string | undefined): void {
    this.#unavailableResolver = resolve;
  }

  /** Host restrictions checked before any provider prepares or runs an action. */
  setHostPolicy(policy: FabricHostPolicy | undefined): void {
    this.#hostPolicy = policy;
  }

  get hostPolicy(): FabricHostPolicy | undefined {
    return this.#hostPolicy;
  }

  #policyProviders(providers: FabricProvider[]): FabricProvider[] {
    return providers.filter((provider) => !this.#hostPolicy?.previewProviderHidden(provider.name));
  }

  #listProvider(
    provider: FabricProvider,
    request: FabricProviderListRequest,
    context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    return runAbortable(context.signal, () => {
      // Seal at actual admission, even without an active policy. Pure provider
      // previews and unused type globals must not seal an otherwise idle host.
      if (this.#hostPolicy?.providerHidden(provider.name)) return [];
      return this.#providerBindings.trackProvider(provider, () => provider.list(request, context));
    });
  }

  #policyRefs(refs: string[]): string[] {
    const policy = this.#hostPolicy;
    if (!policy?.active) return refs;
    return refs.filter((ref) => {
      const separator = ref.indexOf(".");
      return !policy.refDenial(ref.slice(0, separator), ref.slice(separator + 1));
    });
  }

  #policyActions<T extends { provider: string; name: string }>(actions: T[]): T[] {
    const policy = this.#hostPolicy;
    return policy?.active ? actions.filter((action) => !policy.refDenial(action.provider, action.name)) : actions;
  }

  /**
   * Decide again on the action that resolution produced. Name repair can turn
   * a ref the policy allowed as written (pi.Write, pi.save) into a denied
   * canonical action, so every caller checks the resolved name before it
   * prepares arguments or runs the provider.
   */
  #assertResolvedAllowed(action: { provider: string; name: string }): void {
    const denial = this.#hostPolicy?.refDenial(action.provider, action.name);
    if (denial) throw new FabricResolutionError(denial);
  }

  markUnavailable(name: string, reason: string): void {
    if (!providerNamePattern.test(name)) {
      throw new Error(`Invalid Fabric provider name: ${name}`);
    }
    if (this.#providerBindings.has(name)) {
      throw new Error(`Cannot mark a registered Fabric provider unavailable: ${name}`);
    }
    this.#unavailable.set(name, reason);
  }

  unavailableProviders(): Array<{ name: string; reason: string }> {
    return [...this.#unavailable.entries()]
      .map(([name, reason]) => ({ name, reason }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  unregister(
    name: string,
    options?: { provider?: FabricProvider; generation?: number | string; keepProviderOpen?: boolean },
  ): FabricProvider | undefined {
    return this.#providerBindings.unregister(name, options);
  }

  #visibleProviders(context?: FabricInvocationContext): FabricProvider[] {
    if (context) this.#scopeContext(context);
    return context?.capabilityView
      ? [...new Set(this.#viewAuthority(context.capabilityView).bindings().map(value => this.#providerBindings.binding(value.providerBindingId)?.provider).filter((provider): provider is FabricProvider => Boolean(provider)))]
      : this.#policyProviders(this.#providerBindings.providers());
  }

  providers(context?: FabricInvocationContext): Array<{ name: string; description: string }> {
    return this.#visibleProviders(context)
      .map((provider) => ({ name: provider.name, description: provider.description }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async inspectCapabilities(
    requirements: readonly (string | FabricCapabilityRequirement)[],
    context: FabricInvocationContext,
  ): Promise<FabricCapabilityResolution> {
    return this.#resolveCapabilities(requirements, context, false);
  }

  async acquireCapabilityView(
    requirements: readonly (string | FabricCapabilityRequirement)[],
    context: FabricInvocationContext,
  ): Promise<FabricCapabilityViewLease> {
    return this.#resolveCapabilities(requirements, context, true);
  }

  /**
   * Names of the visible providers that get a program global (see
   * src/provider-globals.ts): sorted, capped, and never a Fabric global, a
   * built-in provider, or a language keyword or builtin. A committed view
   * limits the names to the providers it binds.
   */
  providerGlobals(context?: FabricInvocationContext): string[] {
    return providerGlobalNames(this.#visibleProviders(context).map((provider) => provider.name));
  }

  /**
   * Snapshot the tool schemas backing the dynamic guest surfaces (mcp,
   * extensions and provider globals) so the type gate can reject
   * argument-shape mistakes before the sandbox runs. Side-effect-free by
   * construction: MCP data comes from the provider's cache-warm descriptor
   * slice (listing would schedule background revalidation), extension data
   * from the captured-tool catalog, provider-global data from each provider's
   * own list(). Providers that cannot supply data yet simply contribute no
   * section, or a loose global, and the loose declarations stand for that
   * execution. With `code`, a provider's list() runs only when the program
   * uses its global (`name.` or `name[`); other provider globals stay loose,
   * so a program never waits on, or triggers, a catalog it does not use.
   */
  async guestTypeSources(
    context: FabricInvocationContext,
    options: { code?: string } = {},
  ): Promise<FabricGuestTypeSources> {
    context = this.#scopeContext(context);
    const sources: FabricGuestTypeSources = {};
    const globals = this.providerGlobals(context);
    if (context.capabilityView) {
      const actions = await this.list({ limit: 1_000 }, context);
      if (globals.length > 0) {
        sources.providers = globals.map((provider) => ({
          provider,
          actions: actions
            .filter((action) => action.provider === provider)
            .flatMap((action) => actionTypeSource(action.name, action.inputSchema) ?? []),
        }));
      }
      const byServer = new Map<string, FabricNamedActionTypeSource[]>();
      for (const action of actions.filter((candidate) => candidate.provider === "mcp")) {
        const server = action.namespace;
        if (!server || server === "management" || action.name.startsWith("$")) continue;
        const prefix = `${server}.`;
        const name = action.name.startsWith(prefix)
          ? action.name.slice(prefix.length)
          : action.name;
        const tools = byServer.get(server) ?? [];
        tools.push({ name, inputSchema: action.inputSchema });
        byServer.set(server, tools);
      }
      if (byServer.size > 0) {
        sources.mcpServers = [...byServer.entries()].map(([server, tools]) => ({
          server,
          tools,
        }));
      }
      const extensionTools = actions
        .filter((action) => action.provider === "extensions")
        .map((action) => ({ name: action.name, inputSchema: action.inputSchema }));
      if (extensionTools.length > 0) sources.extensionTools = extensionTools;
      return sources;
    }
    const mcp = this.#providerBindings.current("mcp")?.provider as
      | (FabricProvider & { sliceDescriptors?: () => FabricActionDescriptor[] })
      | undefined;
    const mcpDescriptors = this.#hostPolicy?.active
      ? mcp?.sliceDescriptors?.().filter((descriptor) => !this.#hostPolicy!.previewDenial("mcp", descriptor.name))
      : mcp?.sliceDescriptors?.();
    if (mcpDescriptors && mcpDescriptors.length > 0) {
      const byServer = new Map<string, Map<string, FabricNamedActionTypeSource>>();
      for (const descriptor of mcpDescriptors) {
        const server = descriptor.namespace;
        if (!server || server === "management" || descriptor.name.startsWith("$")) continue;
        const prefix = `${server}.`;
        const toolName = descriptor.name.startsWith(prefix)
          ? descriptor.name.slice(prefix.length)
          : descriptor.name;
        let tools = byServer.get(server);
        if (!tools) {
          tools = new Map();
          byServer.set(server, tools);
        }
        // Teaching: the type gate checks programs against the compiled
        // schema, the same shape invoke validates against, so shape
        // mistakes surface before the sandbox runs.
        tools.set(toolName, {
          name: toolName,
          inputSchema: effectiveInputSchema(
            `mcp.${descriptor.name}`,
            descriptor.inputSchema,
          ) as Record<string, unknown>,
        });
      }
      if (byServer.size > 0) {
        sources.mcpServers = [...byServer.entries()].map(([server, tools]) => ({
          server,
          tools: [...tools.values()],
        }));
      }
    }
    const extensions = this.#providerBindings.current("extensions")?.provider;
    if (extensions) {
      try {
        const descriptors = this.#policyActions((await this.#listProvider(extensions, {}, context)).map((descriptor) => ({ ...descriptor, provider: "extensions" })));
        if (descriptors.length > 0) {
          sources.extensionTools = descriptors.map((descriptor) => ({
            name: descriptor.name,
            inputSchema: effectiveInputSchema(
              `extensions.${descriptor.name}`,
              descriptor.inputSchema,
            ) as Record<string, unknown>,
          }));
        }
      } catch {
        // Capture catalog not ready yet; the loose extensions surface stands
        // for this execution.
      }
    }
    if (globals.length > 0) {
      const { code } = options;
      sources.providers = await Promise.all(globals.map((name) =>
        code === undefined || usesProviderGlobal(code, name)
          ? this.#providerTypeSource(name, context)
          : { provider: name, actions: [] }));
    }
    return sources;
  }

  // A provider that fails, stalls past the bound, or lists nothing still gets
  // its global, declared loosely: the global's existence never depends on a
  // transient listing, and the registry validates every call at dispatch.
  async #providerTypeSource(name: string, context: FabricInvocationContext): Promise<FabricProviderTypeSource> {
    const provider = this.#providerBindings.current(name)?.provider;
    if (!provider) return { provider: name, actions: [] };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const descriptors = await Promise.race([
        this.#listProvider(provider, {}, context),
        new Promise<undefined>((resolve) => {
          const handle = setTimeout(() => resolve(undefined), PROVIDER_TYPE_SOURCE_TIMEOUT_MS);
          (handle as { unref?: () => void }).unref?.();
          timer = handle;
        }),
      ]);
      if (!Array.isArray(descriptors)) return { provider: name, actions: [] };
      const quarantined = activeQuarantinedRefNames();
      return {
        provider: name,
        actions: descriptors.flatMap((descriptor) => {
          if (!isPlainRecord(descriptor) || quarantined.has(`${name}.${String(descriptor.name)}`)) return [];
          if (this.#hostPolicy?.active && this.#hostPolicy.refDenial(name, String(descriptor.name))) return [];
          // Teaching: the type gate checks against the compiled schema,
          // the same shape invoke validates against.
          return actionTypeSource(
            descriptor.name,
            isPlainRecord(descriptor.inputSchema)
              ? effectiveInputSchema(`${name}.${descriptor.name}`, descriptor.inputSchema)
              : undefined,
          ) ?? [];
        }),
      };
    } catch {
      return { provider: name, actions: [] };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // The model-facing discovery view: quarantined refs hide here, and the
  // compiled overlay teaches: listed schemas show the compiled shape so
  // tightened enums are visible before the first call. Pass `declared: true`
  // for the compile's base-surface truth, which keeps quarantined refs
  // visible and schemas declared so base-digest proofs and artifact
  // carry-forward read the live contract. Capability-view paths stay
  // declared everywhere (see describe): committed views pin declared
  // digests, and a surface activation must never invalidate them.
  async listDetailed(
    request: FabricProviderListRequest & { provider?: string; declared?: boolean },
    context: FabricInvocationContext,
    include: (action: ResolvedFabricAction) => boolean = () => true,
  ): Promise<{ actions: ResolvedFabricAction[]; total: number; truncated: boolean }> {
    context = this.#scopeContext(context);
    if (context.capabilityView) {
      const refs = this.#policyRefs(this.#viewAuthority(context.capabilityView).bindings().map(binding => binding.ref))
        .filter((ref) => !request.provider || ref.startsWith(`${request.provider}.`))
        .filter((ref) => request.declared || !activeQuarantinedRefNames().has(ref))
        .sort();
      const actions = await Promise.all(refs.map((ref) => this.describe(ref, context)));
      const query = request.query?.normalize("NFKC").trim().toLowerCase();
      const filtered = actions
        .filter((action) => !request.namespace || action.namespace === request.namespace)
        .filter((action) =>
          !query || `${action.ref} ${action.description}`.toLowerCase().includes(query),
        )
        .filter(include);
      const page = filtered.slice(0, fabricActionListLimit(request.limit));
      return { actions: page, total: filtered.length, truncated: filtered.length > page.length };
    }
    const providers = this.#policyProviders(request.provider
      ? [this.#requireProvider(request.provider)]
      : this.#providerBindings.providers());
    const lists = await Promise.all(
      providers.map(async (provider) => {
        // Provider enumeration is exhaustive; only the registry applies the
        // presentation limit, after visibility filtering and total counting.
        const enumeration: FabricProviderListRequest = {
          ...(request.namespace === undefined ? {} : { namespace: request.namespace }),
          ...(request.query === undefined ? {} : { query: request.query }),
        };
        const descriptors = await this.#listProvider(provider, enumeration, context);
        return descriptors
          .filter(
            (descriptor) =>
              request.declared ||
              !activeQuarantinedRefNames().has(`${provider.name}.${descriptor.name}`),
          )
          .map((descriptor) => {
            const action = resolveDescriptor(provider, descriptor);
            // Teaching: the listing carries the compiled schema. Declared
            // requests (the compile snapshot) keep the live contract.
            return request.declared
              ? action
              : {
                  ...action,
                  inputSchema: effectiveInputSchema(
                    action.ref,
                    action.inputSchema,
                  ) as Record<string, unknown>,
                };
          });
      }),
    );
    const all = this.#policyActions(lists.flat()).filter(include);
    const page = all.slice(0, fabricActionListLimit(request.limit));
    return { actions: page, total: all.length, truncated: all.length > page.length };
  }
  async list(
    request: FabricProviderListRequest & { provider?: string; declared?: boolean },
    context: FabricInvocationContext,
  ): Promise<ResolvedFabricAction[]> {
    const { actions } = await this.listDetailed(request, context);
    return actions;
  }

  async catalog(
    context: FabricInvocationContext,
    options: {
      provider?: string;
      limit?: number;
      includeProvider?: (provider: string) => boolean;
    } = {},
  ): Promise<FabricCapabilityCatalog> {
    context = this.#scopeContext(context);
    const providers = (context.capabilityView
      ? [...new Map(
          this.#viewAuthority(context.capabilityView).bindings().flatMap((pinned) => {
            const binding = this.#providerBindings.binding(pinned.providerBindingId);
            return binding ? [[binding.name, binding.provider] as const] : [];
          }),
        ).values()]
      : options.provider
        ? [this.#requireProvider(options.provider)]
        : this.#providerBindings.providers())
      .filter((provider) => !options.provider || provider.name === options.provider)
      .filter((provider) => options.includeProvider?.(provider.name) ?? true)
      .filter((provider) => !this.#hostPolicy?.previewProviderHidden(provider.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    const lists = await Promise.all(
      providers.map(async (provider) => ({
        provider,
        actions: context.capabilityView
          ? await this.list({ provider: provider.name, limit: 1_000 }, context)
          : (await this.#listProvider(provider, {}, context))
              .filter(
                (descriptor) =>
                  !activeQuarantinedRefNames().has(`${provider.name}.${descriptor.name}`),
              )
              .map((descriptor) => resolveDescriptor(provider, descriptor)),
      })),
    ).then((entries) => entries.map(({ provider, actions }) => ({ provider, actions: this.#policyActions(actions) })));
    const allActions = lists.flatMap(({ actions }) => actions)
      .sort((left, right) => left.ref.localeCompare(right.ref));
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 1_000), 1_000));
    const retainedRefs = new Set(allActions.slice(0, limit).map((action) => action.ref));
    const providerHeads = lists.map(({ provider, actions }) => {
      const actionHeads = actions
        .filter((action) => retainedRefs.has(action.ref))
        .sort((left, right) => left.ref.localeCompare(right.ref))
        .map((action) => ({
          key: `action:${action.ref}`,
          parentKey: `provider:${provider.name}`,
          ref: action.ref,
          name: action.name,
          // Navigation only: full contracts and their hashes stay untouched.
          description: Array.from(action.description.trim().split(/\r?\n/, 1)[0]!).slice(0, 320).join(""),
          descriptorHash: actionDescriptorHash(action),
          risk: action.risk,
          ...(action.namespace === undefined ? {} : { namespace: action.namespace }),
          ...(action.effect === undefined ? {} : { effect: action.effect }),
        }));
      return {
        key: `provider:${provider.name}`,
        parentKey: "capability:fabric",
        name: provider.name,
        description: provider.description,
        descriptorHash: descriptorHash({
          name: provider.name,
          description: provider.description,
          actions: actionHeads.map((action) => action.descriptorHash),
        }),
        actions: actionHeads,
      };
    });
    const indexedActions = providerHeads.reduce((total, provider) => total + provider.actions.length, 0);
    const rootHash = descriptorHash(providerHeads.map((provider) => provider.descriptorHash));
    return {
      kind: "pi-fabric.capability-catalog",
      version: 1,
      root: {
        key: "capability:fabric",
        name: "Fabric capabilities",
        description: context.capabilityView
          ? "Committed provider and action metadata for this execution; not historical session evidence."
          : "Current registered provider and action metadata for navigation; not historical session evidence.",
        descriptorHash: rootHash,
      },
      providers: providerHeads,
      totalActions: allActions.length,
      indexedActions,
      complete: indexedActions === allActions.length,
      reasons: indexedActions === allActions.length ? [] : ["action_limit"],
    };
  }

  async search(
    query: string,
    context: FabricInvocationContext,
    limit = 30,
  ): Promise<ResolvedFabricAction[]> {
    const normalizedQuery = query.normalize("NFKC").trim().toLowerCase();
    if (!normalizedQuery) return [];
    const listed = await this.list({ limit: 1_000 }, context);
    return listed
      .map((action) => ({
        action,
        score: scoreActionSearch(
          normalizedQuery,
          action,
          this.#providerBindings.current(action.provider)?.provider.description ?? "",
        ),
      }))
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.action.ref.localeCompare(right.action.ref),
      )
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map((entry) => entry.action);
  }

  async describe(ref: string, context: FabricInvocationContext): Promise<ResolvedFabricAction> {
    context = this.#scopeContext(context);
    if (ref.includes(".")) {
      const { provider, actionName, expectedDescriptorHash } = this.#parseRef(
        ref,
        context.capabilityView,
      );
      const resolved = await this.#resolveActionDescriptor(
        provider,
        actionName,
        context,
        context.capabilityView === undefined,
      );
      if (!resolved.action) {
        throw new FabricResolutionError(formatUnknownActionMessage(ref, resolved.suggestions));
      }
      const action = resolved.action;
      this.#assertResolvedAllowed(action);
      if (expectedDescriptorHash && actionDescriptorHash(action) !== expectedDescriptorHash) {
        throw new FabricResolutionError(`Fabric capability descriptor changed: ${ref}`);
      }
      return action;
    }
    if (context.capabilityView) {
      const pinned = await Promise.all(
        this.#policyRefs(this.#viewAuthority(context.capabilityView).bindings().map(binding => binding.ref)).map((candidate) =>
          this.describe(candidate, context),
        ),
      );
      const matches = pinned.filter((action) => action.name === ref);
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) {
        throw new Error(
          `"${ref}" matches ${matches.length} committed Fabric actions; qualify with provider.action: ` +
            matches.map((match) => match.ref).sort().join(", "),
        );
      }
      throw new FabricResolutionError(`Unknown Fabric action in committed view: ${ref}`);
    }
    // Bare action names (what typed calls pragmatically use): walk every
    // provider for a unique action-name match.
    const matches: ResolvedFabricAction[] = [];
    const declaredNames: string[] = [];
    for (const provider of this.#policyProviders(this.#providerBindings.providers())) {
      let descriptors: FabricActionDescriptor[];
      try {
        descriptors = await this.#listProvider(provider, {}, context);
      } catch {
        continue;
      }
      for (const descriptor of descriptors) {
        declaredNames.push(descriptor.name);
        if (descriptor.name === ref) matches.push(resolveDescriptor(provider, descriptor));
      }
    }
    matches.splice(0, matches.length, ...this.#policyActions(matches));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(
        `"${ref}" matches ${matches.length} Fabric actions; qualify with provider.action: ` +
          matches.map((match) => match.ref).sort().join(", "),
      );
    }
    const repair = repairActionName(declaredNames, ref);
    throw new FabricResolutionError(formatUnknownActionMessage(ref, repair.suggestions));
  }

  async acquireScoped(
    ref: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext & Partial<Pick<FabricRegistryInvocationContext, "authorize" | "approve">>,
    adopt?: ProviderOperation["adopt"],
  ): Promise<FabricScopedProviderResult> {
    context = this.#scopeContext(context);
    args = snapshotArguments(args);
    const { binding, provider, actionName, expectedDescriptorHash } = this.#parseRef(
      ref,
      context.capabilityView,
    );
    context = this.#bindingContext(binding, context);
    const endInvocation = this.#providerBindings.beginInvocation(binding.id);
    const releaseBinding = this.#providerBindings.retain([binding.id]);
    try {
      const resolved = await this.#resolveActionDescriptor(
        provider,
        actionName,
        context,
        context.capabilityView === undefined,
      );
      if (!resolved.action) {
        throw new FabricResolutionError(formatUnknownActionMessage(ref, resolved.suggestions));
      }
      const action = resolved.action;
      this.#assertResolvedAllowed(action);
      const providerActionName = resolved.repairedFrom === undefined ? actionName : action.name;
      const authority = { ref: action.ref, descriptor: actionDescriptorHash(action) };
      if (expectedDescriptorHash && actionDescriptorHash(action) !== expectedDescriptorHash) {
        throw new FabricResolutionError(`Fabric capability descriptor changed: ${ref}`);
      }
      if (action.effect?.kind !== "scoped") {
        throw new Error(`Fabric action is not a scoped acquisition: ${ref}`);
      }
      if (!provider.acquire) {
        throw new Error(`Fabric provider does not implement scoped acquisition: ${provider.name}`);
      }
      // Supervised callers may supply the same policy hooks as invoke. Base
      // contexts remain supported; their host owns authorization/approval.
      if (context.authorize) {
        await runAbortable(context.signal, () => context.authorize!(structuredClone(action)));
      }
      const effectiveSchema = effectiveInputSchema(
        action.ref,
        action.inputSchema,
      ) as Record<string, unknown>;
      const catalogInput = repairCatalogInput(action.ref, effectiveSchema, args);
      const preparedArgs = provider.prepareArguments
        ? await runAbortable(context.signal, () =>
            this.#providerBindings.trackProvider(provider, () => provider.prepareArguments!(providerActionName, catalogInput.args, context)),
          )
        : catalogInput.args;
      if (typeof preparedArgs !== "object" || preparedArgs === null || Array.isArray(preparedArgs)) {
        throw new Error(`Argument preparation for ${ref} did not return an object`);
      }
      const catalog = validateCatalogArgs(
        action.ref,
        effectiveSchema,
        // Preparation may return provider-held nested references. Detach before
        // validation and never expose this validated snapshot to policy hooks.
        snapshotArguments(preparedArgs),
        catalogInput.observedUnexpected,
      );
      if (catalog.invalid) throw new Error(`Invalid arguments for ${ref}: ${catalog.invalid}`);
      if (context.approve) {
        await runAbortable(context.signal, () => context.approve!(structuredClone(action), snapshotArguments(catalog.args), context.signal));
      }
      const acquired = await runAbortable(context.signal, () =>
        this.#runPlanned(binding, providerActionName, authority, "acquire", catalog.args, context, undefined, adopt),
      ) as FabricScopedProviderResult;
      throwIfAborted(context.signal);
      if (!acquired || typeof acquired.dispose !== "function") {
        throw new Error(`Scoped acquisition ${ref} did not return a disposer`);
      }
      return { value: acquired.value, dispose: acquired.dispose };
    } finally {
      void endInvocation().catch(() => undefined);
      // The interpreter owns the returned resource lease. This temporary hold
      // protects resolution/acquisition only; cancellation must not await close.
      void releaseBinding().catch(() => undefined);
    }
  }

  async invoke(
    ref: string,
    args: Record<string, unknown>,
    context: FabricRegistryInvocationContext,
  ): Promise<unknown> {
    context = this.#scopeContext(context);
    args = snapshotArguments(args);
    const traceOperation = context.traceOperation ?? context.trace?.issueCall(ref, snapshotArguments(args));
    let failureStage: "resolve" | "guard" | "prepare" | "validate" | "approve" | "invoke" = "resolve";
    let audit: FabricCallAudit | undefined;
    let invocationActive = false;
    let endBindingInvocation: (() => Promise<void>) | undefined;
    try {
      const { binding, provider, actionName, expectedDescriptorHash } = this.#parseRef(
        ref,
        context.capabilityView,
      );
      context = this.#bindingContext(binding, context);
      endBindingInvocation = this.#providerBindings.beginInvocation(binding.id);
      const resolved = await this.#resolveActionDescriptor(
        provider,
        actionName,
        context,
        context.capabilityView === undefined,
      );
      if (!resolved.action) {
        throw new FabricResolutionError(formatUnknownActionMessage(ref, resolved.suggestions));
      }
      const action = resolved.action;
      this.#assertResolvedAllowed(action);
      const providerActionName = resolved.repairedFrom === undefined ? actionName : action.name;
      const authority = { ref: action.ref, descriptor: actionDescriptorHash(action) };
      if (expectedDescriptorHash && actionDescriptorHash(action) !== expectedDescriptorHash) {
        throw new FabricResolutionError(`Fabric capability descriptor changed: ${ref}`);
      }
      traceOperation?.resolved(action.provider, action.name);

      failureStage = "guard";
      if (action.effect?.kind === "scoped") {
        throw new FabricTraceSafeError(
          `Fabric scoped action ${ref} requires a supervised acquisition context`,
        );
      }
      if (context.authorize) {
        await runAbortable(context.signal, () => context.authorize!(structuredClone(action)));
      }

      failureStage = "prepare";
      const effectiveSchema = effectiveInputSchema(
        action.ref,
        action.inputSchema,
      ) as Record<string, unknown>;
      const catalogInput = repairCatalogInput(action.ref, effectiveSchema, args);
      const preparedArgs = provider.prepareArguments
        ? await runAbortable(context.signal, () =>
            this.#providerBindings.trackProvider(provider, () => provider.prepareArguments!(providerActionName, catalogInput.args, context)),
          )
        : catalogInput.args;
      if (typeof preparedArgs !== "object" || preparedArgs === null || Array.isArray(preparedArgs)) {
        throw new FabricTraceSafeError(`Argument preparation for ${ref} did not return an object`);
      }

      failureStage = "validate";
      const catalog = validateCatalogArgs(
        action.ref,
        effectiveSchema,
        // Preparation may return provider-held nested references. Detach before
        // validation and never expose this validated snapshot to policy hooks.
        snapshotArguments(preparedArgs),
        catalogInput.observedUnexpected,
      );
      traceOperation?.prepared(snapshotArguments(catalog.args));
      if (catalog.normalization) traceOperation?.normalized(structuredClone(catalog.normalization));
      // TypeBox validator messages describe schema expectations only — they
      // never echo argument values — so they are safe for durable traces.
      if (catalog.invalid) {
        // A validate-rejected attempt is in-domain evidence against the
        // effective surface, but rejected argument values are untrusted
        // input and never enter the durable record. The trace-safe feed
        // persists only values the live schema's own enums declare: for a
        // closed-domain parameter the refused value is already the author's
        // public vocabulary, so the observation pool can carry it and a
        // later reset (base drift or review) re-derives with it included.
        // Values outside the declared enums (typos, payloads) drop here,
        // the same pre-birth rule the derivation applies.
        const declaredSchema = action.inputSchema;
        const declaredProperties =
          typeof declaredSchema === "object" &&
          declaredSchema !== null &&
          !Array.isArray(declaredSchema) &&
          typeof (declaredSchema as Record<string, unknown>).properties === "object" &&
          (declaredSchema as Record<string, unknown>).properties !== null
            ? ((declaredSchema as Record<string, unknown>).properties as Record<string, unknown>)
            : undefined;
        const attemptArgs: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(catalog.args)) {
          const property = declaredProperties ? declaredProperties[key] : undefined;
          const declaredEnum =
            typeof property === "object" && property !== null
              ? (property as Record<string, unknown>).enum
              : undefined;
          if (!Array.isArray(declaredEnum)) continue;
          if (
            typeof value !== "string" &&
            typeof value !== "number" &&
            typeof value !== "boolean"
          ) {
            continue;
          }
          if (String(value).length > MAX_AUDIT_VALUE_CHARS) continue;
          if (!declaredEnum.includes(value)) continue;
          attemptArgs[key] = value;
        }
        if (Object.keys(attemptArgs).length > 0) {
          const attempt: FabricCallAudit = {
            ref,
            nestedToolCallId: `${NESTED_TOOL_CALL_ID_PREFIX}${randomUUID()}`,
            startedAt: Date.now(),
            tool: action.name,
            provider: action.provider,
            args: attemptArgs,
            success: false,
            error: `Invalid arguments for ${ref}: ${catalog.invalid}`,
            endedAt: Date.now(),
            ...(resolved.repairedFrom !== undefined
              ? { repairedFrom: resolved.repairedFrom }
              : {}),
          };
          context.audits.push(attempt);
        }
        throw new FabricTraceSafeError(`Invalid arguments for ${ref}: ${catalog.invalid}`);
      }

      failureStage = "approve";
      await runAbortable(context.signal, () => context.approve(structuredClone(action), snapshotArguments(catalog.args), context.signal));

      failureStage = "invoke";
      const nestedToolCallId = `${NESTED_TOOL_CALL_ID_PREFIX}${randomUUID()}`;
      const effect = action.effect!;
      const effectConflicts = [...this.#activeEffects.values()].flatMap((active) => {
        const conflict = conflictBetween(effect, active.effect);
        return conflict ? [{ withRef: active.ref, ...conflict }] : [];
      }).slice(0, 32);
      if (effectConflicts.length > 0 && context.effectPolicy === "strict") {
        failureStage = "guard";
        throw new FabricTraceSafeError(
          `Fabric effect conflict for ${ref}: ${effectConflicts
            .map((conflict) => formatFabricEffectConflict(
              conflict.withRef,
              conflict.resources,
              conflict.reason,
            ))
            .join("; ")}`,
        );
      }
      const argsPreview = previewArgs(ref, catalog.args);
      const activeAudit: FabricCallAudit = {
        ref,
        nestedToolCallId,
        startedAt: Date.now(),
        tool: action.name,
        provider: action.provider,
        args: boundedPreviewValue(
          argsPreview,
          MAX_AUDIT_VALUE_CHARS,
        ) as Record<string, unknown>,
        ...(effectConflicts.length > 0 ? { effectConflicts } : {}),
        ...(resolved.repairedFrom !== undefined
          ? { repairedFrom: resolved.repairedFrom }
          : {}),
      };
      audit = activeAudit;
      invocationActive = true;
      context.audits.push(activeAudit);
      context.observeInvocation?.({
        type: "call_start",
        callId: nestedToolCallId,
        ref,
        args: argsPreview,
      });
      context.update(`Calling ${ref}`);
      this.#activeEffects.set(nestedToolCallId, { ref, effect });
      let servedFromSpeculation = false;
      let providerValue: unknown;
      let providerInvoked = false;
      try {
      if (this.#speculation && this.#allowsSpeculation(action)) {
        const served = await runAbortable(context.signal, () =>
          this.#speculation!.tryServe(context.parentToolCallId, ref, snapshotArguments(catalog.args), JSON.stringify([binding.id, authority.descriptor, context.capabilityView?.id ?? null, context.scope?.digest ?? null, context.nativeToolResult === true])));
        if (served.hit) {
          providerValue = await runAbortable(context.signal, () => this.#runPlanned(binding, providerActionName, authority, "replay", catalog.args, context, served.value));
          servedFromSpeculation = true;
          activeAudit.speculated = true;
          if (served.replay.updatedArgs !== undefined) {
            const replayedPreview = previewArgs(ref, served.replay.updatedArgs);
            activeAudit.args = boundedPreviewValue(
              replayedPreview,
              MAX_AUDIT_VALUE_CHARS,
            ) as Record<string, unknown>;
            traceOperation?.prepared(snapshotArguments(served.replay.updatedArgs));
            context.observeInvocation?.({
              type: "call_args",
              callId: nestedToolCallId,
              args: replayedPreview,
            });
          }
          if (served.replay.media?.length) {
            activeAudit.media = [...(activeAudit.media ?? []), ...served.replay.media];
            if (served.replay.mediaNote) activeAudit.mediaNote = served.replay.mediaNote;
          }
          if (served.replay.preview !== undefined) activeAudit.preview = served.replay.preview;
          if (served.replay.terminate) activeAudit.terminate = true;
        }
      }
        if (!servedFromSpeculation) {
        providerInvoked = true;
        providerValue = await runAbortable(context.signal, () =>
          this.#runPlanned(binding, providerActionName, authority, "invoke", catalog.args, {
          ...context,
          nestedToolCallId,
          update(message) {
            if (!invocationActive) return;
            context.update(message);
            context.observeInvocation?.({
              type: "call_update",
              callId: nestedToolCallId,
              update: { type: "progress", message },
            });
          },
          activity(update) {
            if (!invocationActive) return;
            context.activity?.(update);
            context.observeInvocation?.({
              type: "call_update",
              callId: nestedToolCallId,
              update,
            });
          },
          attachMedia(blocks, note) {
            if (!invocationActive) return;
            if (!activeAudit.media) activeAudit.media = [];
            for (const block of blocks) activeAudit.media.push(block);
            if (note) activeAudit.mediaNote = note;
          },
          updateArguments(updatedArgs) {
            if (!invocationActive) return;
            const updatedPreview = previewArgs(ref, updatedArgs);
            activeAudit.args = boundedPreviewValue(
              updatedPreview,
              MAX_AUDIT_VALUE_CHARS,
            ) as Record<string, unknown>;
            traceOperation?.prepared(snapshotArguments(updatedArgs));
            context.observeInvocation?.({
              type: "call_args",
              callId: nestedToolCallId,
              args: updatedPreview,
            });
          },
          attachPreview(preview) {
            if (!invocationActive) return;
            activeAudit.preview = preview;
          },
          requestTerminate() {
            if (!invocationActive) return;
            activeAudit.terminate = true;
          },
          }).finally(() => {
            if (effect.kind !== "none") this.#speculation?.bumpEpoch();
            this.#activeEffects.delete(nestedToolCallId);
          }),
        );
        }
      } finally {
        if (!providerInvoked) this.#activeEffects.delete(nestedToolCallId);
      }
      const value = this.toolResultProxy
        ? await runAbortable(context.signal, () => this.toolResultProxy!.proxy({
            action,
            args: snapshotArguments(catalog.args),
            toolCallId: nestedToolCallId,
            parentToolCallId: context.parentToolCallId,
            value: providerValue,
            ...(context.signal ? { signal: context.signal } : {}),
          }))
        : providerValue;
      const bounded = action.ref === "jev.decide"
        ? strictDecisionResult(value)
        : boundedResult(value, context.maxResultChars);
      const resultError = failedResultError(value);
      activeAudit.success = resultError === undefined;
      if (resultError) activeAudit.error = resultError;
      activeAudit.resultChars = bounded.chars;
      activeAudit.resultTruncated = bounded.truncated;
      const resultPreview = previewResult(bounded.value);
      activeAudit.result = boundedPreviewValue(resultPreview, MAX_AUDIT_VALUE_CHARS);
      activeAudit.endedAt = Date.now();
      context.observeInvocation?.({
        type: "call_end",
        callId: nestedToolCallId,
        success: resultError === undefined,
        result: resultPreview,
        ...(activeAudit.preview !== undefined ? { preview: activeAudit.preview } : {}),
        ...(resultError ? { error: resultError } : {}),
      });
      if (resultError) {
        traceOperation?.fail("invoke", resultError, failedResultOutcome(value), bounded.value, {
          resultTruncated: bounded.truncated,
        });
      } else {
        traceOperation?.succeed(bounded.value, { resultTruncated: bounded.truncated });
      }
      throwIfAborted(context.signal);
      return bounded.value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      traceOperation?.fail(failureStage, error, executionOutcomeFromError(error, context.signal));
      if (audit) {
        audit.success = false;
        audit.error = message;
        audit.endedAt = Date.now();
        context.observeInvocation?.({
          type: "call_end",
          callId: audit.nestedToolCallId,
          success: false,
          error: audit.error,
        });
      }
      throw error;
    } finally {
      invocationActive = false;
      if (audit) audit.endedAt ??= Date.now();
      void endBindingInvocation?.().catch(() => undefined);
    }
  }

  /**
   * Prepare + pre-launch a speculative call discovered in a partially
   * streamed program (see src/speculation). Pure pipeline only: descriptor
   * resolution, the eligibility gate on the resolved action, argument
   * preparation, and schema validation. The compiled entropy surface gates
   * launches too: quarantined refs never pre-launch and overlays validate
   * prepared arguments, so the store never warms a call the serve path
   * would reject. authorize/approve/audits are skipped
   * because the eligibility gate restricts this path to actions that never
   * prompt, and the real call re-runs the full pipeline on a serve miss.
   * Side-channel outputs are captured into `replay` so the serve path can
   * project them into the real audit.
   */
  async speculate(
    ref: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
    replay: FabricSpeculationReplay,
  ): Promise<
    | {
        preparedArgs: Record<string, unknown>;
        bindingToken: string;
        execute(signal: AbortSignal | undefined): Promise<unknown>;
      }
    | undefined
  > {
    if (!this.#speculationEligibility) return undefined;
    try {
      context = this.#scopeContext(context);
      args = snapshotArguments(args);
      const { binding, provider, actionName, expectedDescriptorHash } = this.#parseRef(
        ref,
        context.capabilityView,
      );
      context = this.#bindingContext(binding, context);
      const descriptor = await runAbortable(context.signal, () =>
        this.#providerBindings.trackProvider(provider, () => provider.describe(actionName, context)));
      if (!descriptor) return undefined;
      const action = resolveDescriptor(provider, descriptor);
      if (this.#hostPolicy?.refDenial(action.provider, action.name)) return undefined;
      if (expectedDescriptorHash && actionDescriptorHash(action) !== expectedDescriptorHash) {
        return undefined;
      }
      if (isActiveQuarantine(provider.name, actionName, descriptor.inputSchema)) {
        return undefined;
      }
      const authority = { ref: action.ref, descriptor: actionDescriptorHash(action) };
      if (!this.#allowsSpeculation(action)) return undefined;
      const effectiveSchema = effectiveInputSchema(
        action.ref,
        action.inputSchema,
      ) as Record<string, unknown>;
      const catalogInput = applyActiveArgRepairs(action.ref, args, effectiveSchema);
      const preparedArgs = provider.prepareArguments
        ? await runAbortable(context.signal, () =>
            this.#providerBindings.trackProvider(provider, () => provider.prepareArguments!(action.name, catalogInput, context)))
        : catalogInput;
      if (
        typeof preparedArgs !== "object" ||
        preparedArgs === null ||
        Array.isArray(preparedArgs)
      ) {
        return undefined;
      }
      const repairedArgs = normalizeActiveArguments(action.ref, effectiveSchema,
        applyActiveArgRepairs(action.ref, snapshotArguments(preparedArgs), effectiveSchema),
      ).args;
      if (validationMessage(effectiveSchema, repairedArgs)) return undefined;
      const nestedToolCallId = `${NESTED_TOOL_CALL_ID_PREFIX}spec-${randomUUID()}`;
      const execute = await this.#preparePlanned(binding, action.name, authority, "speculate", repairedArgs, this.#bindingContext(binding, {
        ...context, nestedToolCallId, update() {}, activity() {},
        attachMedia(blocks, note) { replay.media = [...(replay.media ?? []), ...blocks]; if (note) replay.mediaNote = note; },
        updateArguments(updatedArgs) { replay.updatedArgs = updatedArgs; },
        attachPreview(preview) { replay.preview = preview; },
        requestTerminate() { replay.terminate = true; },
      }));
      return {
        get preparedArgs() { return snapshotArguments(repairedArgs); },
        bindingToken: JSON.stringify([binding.id, authority.descriptor, context.capabilityView?.id ?? null, context.scope?.digest ?? null, context.nativeToolResult === true]),
        execute: async signal => {
          const combined = AbortSignal.any([context.signal!, ...(signal ? [signal] : [])]);
          const actual = execute(combined);
          void actual.catch(() => undefined);
          return runAbortable(combined, () => actual);
        },
      };
    } catch {
      // Speculation degrades silently; the real call runs the full pipeline.
      return undefined;
    }
  }

  async endInvocation(parentToolCallId: string, timeoutMs = 1_000, signal?: AbortSignal): Promise<void> {
    this.#speculation?.onInvocationEnd?.(parentToolCallId);
    const providers = new Set(
      this.#providerBindings.entries().map((binding) => binding.provider),
    );
    const finalizers = [...providers].flatMap((provider) =>
      provider.invocationEnded
        ? [this.#providerBindings.trackProvider(provider, () => provider.invocationEnded!(parentToolCallId), true)]
        : [],
    );
    // Cancellation releases the foreground wait, not the tracked cleanup.
    // Provider retirement still owns these operations until they settle.
    await settleWithin(finalizers, timeoutMs, signal);
  }

  /** Revocation is distinct from rolling withdrawal: pinned old generations may
   * survive retirement, but revoked bindings admit no further work. */
  revokeProvider(name: string): void {
    const binding = this.#providerBindings.current(name);
    if (binding) this.#providerBindings.revoke(binding.id);
  }

  providerStatus(): Array<{ name: string; generation: number; state: string; inFlight: number; revoked: boolean; error?: string }> {
    return this.#providerBindings.entries().map(binding => ({ name: binding.name, generation: binding.generation, state: binding.state,
      inFlight: binding.inFlight, revoked: this.#providerBindings.signal(binding.id).aborted,
      ...(binding.closeError ? { error: binding.closeError } : {}) }));
  }

  async close(excludedProviderNames: Set<string> = new Set()): Promise<void> {
    this.#shutdown.abort(new Error("Fabric registry closed"));
    try {
      if (this.#operations) await (await this.#operations).close();
    } finally {
      await this.#providerBindings.close(excludedProviderNames);
    }
  }


  async #resolveCapabilities(
    requirements: readonly (string | FabricCapabilityRequirement)[],
    context: FabricInvocationContext,
    retain: boolean,
  ): Promise<FabricCapabilityViewLease> {
    context = this.#scopeContext(context);
    const normalized = new Map<string, boolean>();
    for (const requirement of requirements) {
      const ref = (typeof requirement === "string" ? requirement : requirement.ref).trim();
      if (!ref || ref.length > 256 || !ref.includes(".")) {
        throw new Error(`Fabric capability requirements must use provider.action: ${ref || "<empty>"}`);
      }
      const optional = typeof requirement === "string" ? false : requirement.optional === true;
      normalized.set(ref, (normalized.get(ref) ?? true) && optional);
    }

    const missing: string[] = [];
    const optionalMissing: string[] = [];
    const resolved = new Map<string, FabricCapabilityBindingView>();
    const temporaryReleases: Array<() => Promise<void>> = [];
    let permanentRelease: (() => Promise<void>) | undefined;
    try {
      for (const [ref, optional] of [...normalized].sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        try {
          const { binding, provider, actionName, expectedDescriptorHash } = this.#parseRef(ref, context.capabilityView);
          const release = this.#providerBindings.retain([binding.id]);
          temporaryReleases.push(release);
          const descriptor = await runAbortable(context.signal, () =>
            this.#providerBindings.trackProvider(provider, () => provider.describe(actionName, context)),
          );
          if (!descriptor) throw new FabricResolutionError(`Unknown Fabric action: ${ref}`);
          const action = resolveDescriptor(provider, descriptor);
          if (expectedDescriptorHash && actionDescriptorHash(action) !== expectedDescriptorHash) throw new FabricResolutionError(`Committed capability drifted: ${ref}`);
          resolved.set(ref, {
            ref,
            provider: provider.name,
            providerBindingId: binding.id,
            generation: binding.generation,
            descriptorHash: actionDescriptorHash(action),
          });
        } catch (error) {
          if (!(error instanceof FabricResolutionError)) throw error;
          (optional ? optionalMissing : missing).push(ref);
        }
      }

      let view: FabricCommittedCapabilityView | undefined;
      if (missing.length === 0) {
        // Resolution awaited provider code: recheck the parent immediately
        // before deriving, even for an empty/optional-only child. Never derive
        // from the public view's presentation fields.
        throwIfAborted(context.signal);
        const values = [...resolved.values()];
        const authority = context.capabilityView
          ? this.#viewAuthority(context.capabilityView).derive(values)
          : CapabilityAuthority.issue(values);
        if (!authority.active) throw new FabricResolutionError("Fabric capability view is unissued, released, or revoked");
        const bindings = Object.fromEntries(authority.bindings().map(value => [value.ref, value]));
        if (retain) permanentRelease = this.#providerBindings.retain(
          values.map((binding) => binding.providerBindingId),
        );
        for (const value of Object.values(bindings)) Object.freeze(value);
        view = Object.freeze({
          id: randomUUID(),
          digest: descriptorHash(values),
          semanticDigest: descriptorHash(
            values.map(({ ref, provider, descriptorHash: hash }) => ({
              ref,
              provider,
              descriptorHash: hash,
            })),
          ),
          bindings: Object.freeze(bindings),
        });
        const controller = new AbortController();
        const parent = context.capabilityView ? this.#requireView(context.capabilityView) : undefined;
        const signal = AbortSignal.any([this.#shutdown.signal, controller.signal, ...(parent ? [parent] : [])]);
        this.#views.set(view, { controller, signal, authority });
        const revoked = () => {
          authority.release();
          const release = permanentRelease;
          permanentRelease = undefined;
          void release?.().catch(() => undefined);
        };
        signal.addEventListener("abort", revoked, { once: true });
        if (signal.aborted) revoked();
      }
      return {
        satisfied: missing.length === 0,
        missing,
        optionalMissing,
        ...(view ? { view } : {}),
        release: async () => {
          const release = permanentRelease;
          permanentRelease = undefined;
          if (view) this.#views.get(view)?.controller.abort(new Error("Fabric capability view released"));
          await release?.();
        },
      };
    } finally {
      await Promise.allSettled(temporaryReleases.map((release) => release()));
    }
  }

  async #declaredActionNames(
    provider: FabricProvider,
    context: FabricInvocationContext,
  ): Promise<string[]> {
    try {
      const descriptors = await this.#listProvider(provider, {}, context);
      return descriptors.map((descriptor) => descriptor.name);
    } catch {
      return [];
    }
  }

  // Resolve a provider action descriptor, repairing a near-miss action name
  // (mirroring arg-normalization's prepare-stage argument repair) when the
  // caller is not pinned to a committed capability view. Committed views are
  // exact contracts: a pinned miss keeps the plain resolution error.
  async #resolveActionDescriptor(
    provider: FabricProvider,
    actionName: string,
    context: FabricInvocationContext,
    allowRepair: boolean,
  ): Promise<{ action?: ResolvedFabricAction; suggestions: string[]; repairedFrom?: string }> {
    const descriptor = await runAbortable(context.signal, () =>
      this.#providerBindings.trackProvider(provider, () => provider.describe(actionName, context)),
    );
    // A quarantined ref resolves as unknown: the model-facing catalog never
    // shows it, and a direct call gets the standard not-found message with
    // suggestions, exactly like any retired action.
    if (descriptor && !isActiveQuarantine(provider.name, actionName, descriptor.inputSchema)) {
      return {
        action: resolveDescriptor(provider, descriptor),
        suggestions: [],
        ...(descriptor.name !== actionName ? { repairedFrom: actionName } : {}),
      };
    }
    // A tool the parent has but this child's allowlist withholds is not
    // unknown: say so, and never repair the name to a permitted neighbour.
    const notPermitted = (provider as AllowlistAwareProvider).notPermitted?.(actionName);
    if (notPermitted) throw new FabricResolutionError(notPermitted);
    if (!allowRepair) return { suggestions: [] };
    const declared = (await this.#declaredActionNames(provider, context)).filter(
      (name) => !activeQuarantinedRefNames().has(`${provider.name}.${name}`),
    );
    const catalogName = applyActiveActionName(provider.name, actionName, declared);
    if (catalogName !== actionName) {
      const catalogDescriptor = await runAbortable(context.signal, () =>
        this.#providerBindings.trackProvider(provider, () => provider.describe(catalogName, context)),
      );
      if (catalogDescriptor) {
        return {
          action: resolveDescriptor(provider, catalogDescriptor),
          suggestions: [],
          repairedFrom: actionName,
        };
      }
    }
    const repair = repairActionName(declared, actionName);
    const compiler = getActiveRepairCompiler();
    if (repair.repaired !== undefined) {
      compiler?.observeUnknownAction(provider.name, actionName, declared, {
        countError: false,
      });
      const repairedDescriptor = await runAbortable(context.signal, () =>
        this.#providerBindings.trackProvider(provider, () => provider.describe(repair.repaired!, context)),
      );
      if (repairedDescriptor) {
        return {
          action: resolveDescriptor(provider, repairedDescriptor),
          suggestions: [],
          repairedFrom: actionName,
        };
      }
      compiler?.recordInvocationError();
    } else {
      compiler?.observeUnknownAction(provider.name, actionName, declared);
    }
    return {
      suggestions: repair.suggestions.map((name) => `${provider.name}.${name}`),
    };
  }

  #parseRef(
    ref: string,
    view?: FabricCommittedCapabilityView,
  ): {
    binding: FabricProviderBinding;
    provider: FabricProvider;
    actionName: string;
    expectedDescriptorHash?: string;
  } {
    if (view) this.#requireView(view);
    const separator = ref.indexOf(".");
    if (separator <= 0 || separator === ref.length - 1) {
      throw new Error(`Fabric action references must use provider.action: ${ref}`);
    }
    const providerName = ref.slice(0, separator);
    // The sealed host policy decides from the ref as written, before any
    // provider code (describe, list or prepareArguments) runs for a refused
    // action. Callers decide again on the resolved name with
    // #assertResolvedAllowed, because resolution can repair the name.
    const hostDenial = this.#hostPolicy?.refDenial(providerName, ref.slice(separator + 1));
    if (hostDenial) throw new FabricResolutionError(hostDenial);
    const pinned = view ? this.#viewAuthority(view).resolve(ref) : undefined;
    if (view && !pinned) {
      throw new FabricResolutionError(`Fabric capability is outside the committed view: ${ref}`);
    }
    const binding = pinned
      ? this.#providerBindings.binding(pinned.providerBindingId)
      : this.#providerBindings.current(providerName);
    if (!binding || binding.name !== providerName || (pinned && (pinned.generation !== binding.generation || pinned.provider !== providerName || pinned.ref !== ref))) {
      if (pinned) {
        throw new FabricResolutionError(
          `Fabric capability binding is no longer available: ${ref} (${pinned.providerBindingId})`,
        );
      }
      this.#requireProvider(providerName);
      throw new FabricResolutionError(`Unknown Fabric provider: ${providerName}`);
    }
    return {
      binding,
      provider: binding.provider,
      actionName: ref.slice(separator + 1),
      ...(pinned ? { expectedDescriptorHash: pinned.descriptorHash } : {}),
    };
  }

  #requireView(view: FabricCommittedCapabilityView): AbortSignal {
    const owned = this.#views.get(view);
    if (!owned || owned.signal.aborted || !owned.authority.active) throw new FabricResolutionError("Fabric capability view is unissued, released, or revoked");
    return owned.signal;
  }

  #viewAuthority(view: FabricCommittedCapabilityView): CapabilityAuthority {
    this.#requireView(view);
    return this.#views.get(view)!.authority;
  }

  #scopeContext<T extends FabricInvocationContext>(context: T): T {
    const view = context.capabilityView ? this.#requireView(context.capabilityView) : undefined;
    throwIfAborted(context.signal);
    if (this.#shutdown.signal.aborted) throw new FabricResolutionError("Fabric registry is closed");
    // Host-issued scope (src/scope.ts) replaces any caller value; failed issuance refuses every call.
    const issued = (globalThis as Record<symbol, { scope?: FabricScope; error?: string } | undefined>)[SCOPE_HOLDER];
    if (issued?.error) throw new FabricResolutionError(`Fabric scope issuance failed; provider calls are refused: ${issued.error}`);
    const scoped = { ...context, signal: AbortSignal.any([this.#shutdown.signal, ...(context.signal ? [context.signal] : []), ...(view ? [view] : [])]) };
    if (issued?.scope) scoped.scope = issued.scope;
    else delete scoped.scope;
    return scoped;
  }

  #bindingContext<T extends FabricInvocationContext>(binding: FabricProviderBinding, context: T): T {
    return { ...context, signal: AbortSignal.any([this.#providerBindings.signal(binding.id), ...(context.signal ? [context.signal] : [])]) };
  }

  async #preparePlanned(binding: FabricProviderBinding, actionName: string, authority: { ref: string; descriptor: string }, mode: ProviderOperation["mode"], args: Record<string, unknown>, context: FabricInvocationContext, replayValue?: unknown, adopt?: ProviderOperation["adopt"]): Promise<(signal?: AbortSignal) => Promise<unknown>> {
    const payload = snapshotArguments(args);
    this.#operations ??= import("./provider-operations.js").then(({ ProviderOperations }) => new ProviderOperations(this.#providerBindings));
    return (await this.#operations).prepare({ binding, action: actionName, ...authority, mode, args: payload, context, replayValue, ...(adopt ? { adopt } : {}),
      observe: async observedContext => {
        const descriptor = await binding.provider.describe(actionName, observedContext);
        if (!descriptor) return { ref: "", descriptor: "" };
        const action = resolveDescriptor(binding.provider, descriptor);
        return { ref: action.ref, descriptor: actionDescriptorHash(action) };
      },
    });
  }

  #runPlanned(binding: FabricProviderBinding, actionName: string, authority: { ref: string; descriptor: string }, mode: ProviderOperation["mode"], args: Record<string, unknown>, context: FabricInvocationContext, replayValue?: unknown, adopt?: ProviderOperation["adopt"]): Promise<unknown> {
    return this.#providerBindings.track(binding.id, async () => {
      const execute = await this.#preparePlanned(binding, actionName, authority, mode, args, context, replayValue, adopt);
      return execute();
    });
  }

  #requireProvider(name: string): FabricProvider {
    const provider = this.#providerBindings.current(name)?.provider;
    if (provider) return provider;
    const unavailableReason = this.#unavailable.get(name) ?? this.#unavailableResolver?.(name);
    if (unavailableReason) {
      throw new FabricResolutionError(
        `Fabric provider "${name}" is unavailable: ${unavailableReason}`,
      );
    }
    const registered = this.#providerBindings.providers()
      .map((provider) => provider.name)
      .sort((left, right) => left.localeCompare(right));
    throw new FabricResolutionError(
      `Unknown Fabric provider: ${name}` +
        (registered.length > 0 ? ` (registered providers: ${registered.join(", ")})` : ""),
    );
  }
}
