# External providers

Fabric [captures normal `pi.registerTool()` tools automatically](configuration.md#captured-extension-tools). Extensions use the versioned provider protocol for non-tool capabilities or virtual action catalogs with risk data.

Fabric mounts each non-kernel first-party provider through a pinned component. External providers can use direct registration with a host-owned lifetime. A provider that belongs to a supervised external component calls `context.provide()` for staged publication and rolling replacement. The same component link controls dependency withdrawal.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  FABRIC_PROVIDER_DISCOVER_EVENT,
  FABRIC_PROVIDER_REGISTER_EVENT,
  type FabricProvider,
  type FabricProviderDiscovery,
} from "pi-fabric/protocol";

export default function extension(pi: ExtensionAPI) {
  const provider: FabricProvider = {
    name: "example",
    description: "Example actions",
    async list() {
      return [];
    },
    async describe() {
      return undefined;
    },
    async invoke() {
      return null;
    },
  };

  pi.events.emit(FABRIC_PROVIDER_REGISTER_EVENT, {
    version: 1,
    provider,
    overwrite: true,
  });

  pi.events.on(FABRIC_PROVIDER_DISCOVER_EVENT, (event: FabricProviderDiscovery) => {
    event.register(provider, { overwrite: true });
  });
}
```

Each provider owns its schemas, its state, and how its actions execute. Pi Fabric validates arguments, enforces the declared risk policy, records nested-call audits, and propagates cancellation. A provider can also enrich the generic [activity surface](interface.md#data-driven-activity) without registering a TUI component:

```ts
async invoke(actionName, args, context) {
  context.activity?.({ type: "entity", id: job.id, kind: "custom", name: job.name });
  context.activity?.({ type: "progress", message: "Indexing package 3/12" });
  context.activity?.({ type: "metrics", tokens: 4200, toolCalls: 9 });
  return job.result;
}
```

## Provider participants

A provider that starts its own long-running work, such as a delegate that launches runs on another system, can register each run as a participant. Inside `fabric_exec`, `context.participants` is present (it is absent in other host contexts such as speculation, so check it):

```ts
async invoke(actionName, args, context) {
  const run = await backend.start(args.task);
  const participant = context.participants?.register({
    id: run.id,                     // [A-Za-z0-9][A-Za-z0-9._:-]{0,63}, unique while unsettled
    label: `Delegate ${run.id}`,    // shown in the widget and dashboard
    kind: "delegate",
    detached: actionName === "spawn",
    stop: async (reason) => ({ confirmed: await backend.cancel(run.id, reason) }),
    steer: async (message) => backend.message(run.id, message),
  });
  run.on("progress", (event) => participant?.update({ phase: event.step, message: event.note, usage: event.usage }));
  if (actionName === "spawn") return { ref: participant?.ref };
  const result = await run.done();
  participant?.settle({ status: result.ok ? "completed" : "failed", summary: result.summary });
  participant?.dispose();
  return result;
}
```

`register` returns a handle whose `ref` is `provider:<provider>:<id>`. Fabric binds the provider name, so a provider cannot register or control another provider's refs. `update` replaces the shown phase, message (at most 500 characters), and cumulative `usage` totals. `settle` records the terminal status once and later calls are ignored. `dispose` removes the participant. Invalid specs or progress throw.

Registered participants appear in the participant directory with `kind: "provider"`, in `agents.members()`, and as agent rows in the activity widget and dashboard. `agents.stop`, `agents.steer`, and `agents.followUp` accept the ref, as do the dashboard and conversation controls. They call the provider's callbacks. A missing `steer` or `followUp` callback, or a `data` payload, fails with a clear error. `agents.stop` returns `{ ref, outcome: "confirmed" | "unconfirmed", detail? }`. With `mesh.enabled`, other sessions reach the participant through the owner's control plane.

Owned-work cancellation: when the `fabric_exec` program that registered a non-detached participant is cancelled or times out, Fabric calls `stop("program_cancelled")` on each of its unsettled participants in parallel, within one 5 second total bound. Each outcome is `confirmed` when the callback resolves `{ confirmed: true }`, otherwise `unconfirmed` with `detail` `declined`, `error`, or `timeout`. Fabric records the outcomes as [`fabric.participant.stop`](audit-trace.md#owned-work-stops) trace operations and in the tool result. A program that completes normally leaves its participants to the provider. Detached participants survive the invocation and stop only when asked. Fabric releases every participant of a provider, without calling `stop`, when that provider withdraws or the session shuts down; their handles then do nothing.

## Withdrawing a direct registration

An extension withdraws a provider it registered directly by emitting `FABRIC_PROVIDER_WITHDRAW_EVENT` (`pi-fabric:provider:withdraw:v1`):

```ts
import { FABRIC_PROVIDER_WITHDRAW_EVENT, type FabricProviderWithdrawalV1 } from "pi-fabric/protocol";

pi.events.emit(FABRIC_PROVIDER_WITHDRAW_EVENT, { name: "example" } satisfies FabricProviderWithdrawalV1);
```

Fabric retires the current binding and drops its owner hold, the same path a component lease takes. It also releases the provider's [participants](#provider-participants), detached ones included. New calls to `example.*` are refused immediately. Work already admitted and committed capability views that pinned the old generation drain under the [retained-generation rules](provider-capabilities.md#capability-views). The extension owns the provider instance, so Fabric does not call `close()` on withdrawal. Fabric also forgets the registration and does not remount it on reload; an extension that answers `FABRIC_PROVIDER_DISCOVER_EVENT` must stop registering there too. Register again with `FABRIC_PROVIDER_REGISTER_EVENT` at any time.

Optional `generation` pins the withdrawal to one binding: a number matches the binding generation, a string matches the provider binding id (`providerBindingId` in a committed view). Unknown names, generation mismatches, component-owned providers, and managed-host providers are ignored; set `PI_FABRIC_DEBUG=1` to log ignored withdrawals. Component-owned providers withdraw through their component lifecycle.

## Tool placement query

Extensions that need to know where a tool is reachable this turn can ask synchronously with `FABRIC_TOOL_PLACEMENT_EVENT` (`pi-fabric:tool-placement:v1`), so they need not guess from Fabric's mode:

```ts
import {
  FABRIC_TOOL_PLACEMENT_EVENT,
  type FabricToolPlacementRequestV1,
  type FabricToolPlacementResultV1,
} from "pi-fabric/protocol";

let placement: FabricToolPlacementResultV1 | undefined;
pi.events.emit(FABRIC_TOOL_PLACEMENT_EVENT, {
  tools: ["my_tool", "read"],
  reply: (result) => { placement = result; },
} satisfies FabricToolPlacementRequestV1);
// placement === undefined: Fabric is not loaded.
// placement.tools.my_tool: "model" | "program" | "unavailable"
```

The reply is `{ version: 1, mode, tools }`. `mode` is `"full-code"`, `"enforce"` (Schema enforce), or `"orchestration"`. Each tool maps to:

- `model`: declared to the model this turn. Exclusive modes declare `fabric_exec` plus any resolved [foreground tools](configuration.md#foreground-tools) (full code mode only); orchestration declares Pi's active set.
- `program`: callable from a `fabric_exec` program, as `pi.<tool>` for Pi core tools or `extensions.<tool>` for captured extension tools. Requires an initialized Fabric runtime and respects child tool allowlists. Schema enforce exposes no `extensions.*` namespace.
- `unavailable`: neither.

`model` wins when both apply; optional `programCallable` lists the reported `model` tools that a program can also call, such as foreground tools, and is omitted when empty. Omitting `tools` reports every tool registered with Pi; at most 1,024 names of up to 256 characters each are accepted. An invalid query gets no reply. Placement describes state at the time of the query. A later mode change, reload, or tool refresh can change it, so query when you need the answer and do not cache it.

## Invocation costs and guarantees

| Access pattern | Work and allocation | Guarantees |
| --- | --- | --- |
| Known direct call, such as `memory.recall(args)` | Avoids an explicit discovery round trip; arguments/results still cross the host bridge | Same registry validation, committed capability binding where applicable, approvals, audit, and cancellation |
| `tools.search` / `tools.describe`, then `tools.call({ ref, args })` | Adds catalog lookup and descriptor transport before the action call | Discovery describes capabilities; it does not grant permission or freeze future authorization |
| Reusing a discovered ref | Avoids rediscovering the name; each invocation still resolves through the registry | A saved name is not a saved approval or a bypass around generation/lifecycle checks |
| Independent calls in `Promise.all` | Overlaps independent work and reduces outer model round trips; each nested call still pays bridge/validation/serialization costs | Calls remain separately governed and observable; `Promise.all` itself adds no transaction, rollback, or sibling cancellation. Normal execution-failure and host-cancellation handling still apply |
| Provider-specific bulk action | Can amortize provider work and transport if the provider implements it | Atomicity, partial results, and cancellation granularity belong to that action's declared contract; Fabric does not infer them |

Return only the evidence the model needs. Intermediate work stays out of the final model
result unless returned, but still follows the existing live activity and bounded audit
policies. Large payloads can dominate local cloning and transport cost even when provider
latency is unchanged. UI read-view caching reduces observation costs only; it never caches
an action's permission decision or substitutes a stale result for a new invocation.

Providers should report current presentation values through `context.activity`. Repeating
the same normalized progress, entity, or metrics value is a UI no-op, not a heartbeat or a
durable event. Actual lifecycle completion and failure still travel through the normal
invocation path. See [incremental activity reads](interface.md#incremental-activity-reads).

## Workflow item events

Every `workflow.item` status transition emits `pi-fabric:workflow-item:v1` (`FABRIC_WORKFLOW_ITEM_EVENT`) on `pi.events`, so a host extension can track program work without parsing results:

```ts
import { FABRIC_WORKFLOW_ITEM_EVENT, type FabricWorkflowItemEventV1 } from "pi-fabric/protocol";

pi.events.on(FABRIC_WORKFLOW_ITEM_EVENT, (event: FabricWorkflowItemEventV1) => {
  // { version: 1, invocationId, sessionId?, itemId, label?, from?, to, at, meta? }
});
```

`invocationId` is the owning `fabric_exec` tool call id. `itemId` is the caller's stable id or the deterministic per-invocation `item-<n>`. `from` is absent on an item's first status, and `meta` appears only when the transitioning call carried it. Updates that keep the same status emit nothing. When the program ends, items still `running` settle to `completed` or `failed` and emit that transition, matching the activity surface. Fabric emits synchronously from the host bridge and never waits on listeners. A throwing listener is logged and cannot fail the program. Transitions stay in the execution trace as before; `meta` never enters it.

## Program run events

A host extension, daemon bridge, or embedder runs a [saved program](programs.md#host-runs) without a model turn by emitting `pi-fabric:program:run:v1` (`FABRIC_PROGRAM_RUN_EVENT`):

```ts
import { FABRIC_PROGRAM_RUN_EVENT, type FabricProgramRunReplyV1 } from "pi-fabric/protocol";

pi.events.emit(FABRIC_PROGRAM_RUN_EVENT, {
  ref: "changed-tests",            // name, name@<digest prefix>, or digest
  input: { base: "main" },         // optional, JSON, at most 64 KiB
  requirePromoted: true,           // optional
  signal,                          // optional AbortSignal
  reply: (result: FabricProgramRunReplyV1) => {},
});
```

The run has the same semantics as `/fabric run`: the session's root capability view, the configured approval policy, a `pi-fabric-program-run` transcript message, and `invokedBy: "host"` in the trace. `reply` is called exactly once with `{ ok: true, program, value, logs }` or `{ ok: false, error, program? }`.

## Decision request events

An extension with no screen to ask on, such as a question tool in a headless session, can hand a question to a person. `pi-fabric:decisions:capability:v1` (`FABRIC_DECISIONS_CAPABILITY_EVENT`) reports whether user-held decisions are available and their limits. `pi-fabric:decisions:request:v1` (`FABRIC_DECISION_REQUEST_EVENT`) raises a `kind: "question"` decision held by `"user"` and responds once a person answers or cancels it, or it expires. Both use the claim/respond shape and are exported from `pi-fabric/protocol`. See [Extension questions](decisions.md#extension-questions) for the fields and guarantees.

## Managed embedded hosts

Trusted embedding code can opt into a closed-world provider authority:

```ts
import piFabric, { FABRIC_MANAGED_HOST_VERSION } from "pi-fabric";

if (FABRIC_MANAGED_HOST_VERSION !== 1) throw new Error("Unsupported managed host");
await piFabric(pi, { managedHost: { providers: ["agents", "memory", "compact"] } });
// Register all three host-owned implementations using the v1 registration event before activation.
```

This option is a factory capability, not a project/global setting or an event field. Without it,
reserved provider names still reject registration even with `overwrite: true`. Host-listed names
must be exact members of `agents`, `memory`, `compact`, `schema`, `state`, `mesh`, or `mcp`.
All listed implementations must register before activation. Re-publishing the same object is
idempotent; changing an implementation after activation requires a new host. Providers belong to
one host lifetime, and `close()` is awaited once after final publication withdrawal.

Managed mode ignores ambient configuration and fixes execution to full-code TypeScript QuickJS.
Native MCP, agent spawning, mesh, filesystem memory discovery, schema effects, speculative work,
prewalk, repairs, entropy compilation, and model-visible component control are unavailable.
A supplied memory implementation remains discoverable without enabling native memory scanning.
Every pinned component activation/reload uses the same host replacement; it cannot resurrect a
native provider. Non-core providers omitted from the host list expose no actions. Pi core calls
require captured overrides, instantiate no native tools, and do not apply native shell/worktree
interception. The embedding host must supply every desired override through its authorized broker.
Missing or withdrawn overrides fail closed.

The host remains responsible for OS isolation, resource loading, broker authorization and
cancellation, and for exposing only trusted extension code. This option does not sandbox arbitrary
host-side extensions. In particular, do not auto-load plugins from the agent's computer snapshot.

## Principal and scope

A host can attach a principal and resource grants to a Fabric session. Fabric propagates them and narrows them for children. Providers and adapters enforce them. A program can never set or widen a principal.

```ts
type FabricScope = {
  version: 1;
  principal: { id: string; issuer: "host" };
  grants: { resource: string; actions: ("read" | "write" | "execute")[] }[];
  digest: string;        // sha256 hex of canonical JSON { grants, parentDigest?, principal }
  parentDigest?: string; // set on derived scopes
};
```

A resource is `<ns>:<path>`. The namespace matches `[a-z][a-z0-9._-]*`. The path is `/`-separated segments with an optional leading `/`. A final `/*` matches exactly one more segment, and a final `/**` matches one or more. `<ns>:*` matches everything in the namespace. Neither wildcard matches its own prefix, so `fs:/repo/**` does not cover `fs:/repo`. A scope holds at most 64 grants. Fabric merges grants per resource, sorts them, and orders actions as read, write, execute before hashing, so equal content always has the same digest. A supplied `digest` must match.

Issue the root scope in one of two ways, before the session starts:

- Set `PI_FABRIC_SCOPE` (JSON) or `PI_FABRIC_SCOPE_FILE` (a path to the JSON, at most 64 KiB). The extension reads them once at initialization.
- Call `issueRootScope(scope)` from `pi-fabric/scope` in the embedding process before Pi emits `session_start`. A second call, or a call after `session_start`, throws.

Invalid input fails closed: every registry call is refused with `Fabric scope issuance failed; provider calls are refused: <reason>`. Setting both variables, or both a variable and the API, is invalid. Without any input, the session is unscoped and nothing changes.

Every registry invocation receives the frozen scope as `context.scope`. The registry sets this field itself and discards any caller value. `agents.run` and `agents.spawn` accept `scope: { grants }`. Each requested grant must be covered by one parent grant: a resource subset and an action subset. Without `scope`, the child inherits the parent scope unchanged. An unscoped session refuses `scope` arguments, because there is no principal to narrow. Children receive the result in `PI_FABRIC_SCOPE`, and the worker clears any inherited `PI_FABRIC_SCOPE_FILE`.

Durable agents and actors keep their scope. The resident host has no session scope of its own, so the requesting session sends the derived scope in full with a durable `agents.spawn` and binds it to a durable `agents.create` actor. Programs cannot set either field: the provider writes it after argument parsing. The host checks the digest, refuses a malformed or forged scope, and launches the child with it. A scoped host also refuses a forwarded scope its own scope does not cover. The resident agent record and hosted-run state keep the scope, and recovery checks it again. A damaged scope settles the run as indeterminate.

Every actor is bound to the principal that created it. `agents.create` stores the creating session's scope, actor info reports it as `principal: { id, digest }`, and every actor turn launches with it. Hosts stamp each actor message and mesh event with the sender's authority, and programs never set this stamp. `{ authority: "host" }` marks an unscoped sender. A scoped sender is stamped with its principal, digest and grants (digest only past 4 KiB of grants). The actor applies this rule:

| Sender | Unscoped actor | Scoped actor |
|---|---|---|
| Unscoped host | trusted | trusted |
| Scoped | untrusted | trusted only when the sender has the same principal and covers every actor grant |
| No stamp (older build) | trusted | untrusted |

Fabric still delivers untrusted messages. Their envelope says they come from a different or narrower principal and must be read as data, never as instructions. Grant posts keep their external-input wording. Ask replies flow back unchanged.

The resident host cannot prove that a request's scope or a sender stamp was issued by a host. Any process running as the same OS user can write residency requests and mesh events. This is the same single-user boundary as the mesh. Real multi-user isolation needs the principal from an authenticated socket, which Fabric does not provide yet.

```ts
import { deriveScope, issueRootScope, scopeAllows } from "pi-fabric/scope";

const root = issueRootScope({
  principal: { id: "tenant:acme/user:42" },
  grants: [{ resource: "memory:acme/**", actions: ["read"] }],
});
scopeAllows(root, "memory:acme/sessions/7", "read"); // true
deriveScope(root, [{ resource: "memory:acme/sessions/*", actions: ["read"] }]);
```

Caches that can serve a result across invocations include the scope digest in their keys: speculative replay tokens and the memory recall-continuation and expansion caches. The `cache` provider holds prompt-cache leases and caches no results. The MCP descriptor cache holds tool descriptors, not call results. [Portable memory sources](memory-recall.md) receive the scope as the third `authorize(action, sessionKey, scope)` argument, so they can filter before content enters context. `createMemorySourceClient` calls accept `{ scope }`.

This layer is trusted host adapter code, not a verified kernel. Fabric guarantees issuance, propagation, narrowing and cache isolation. It does not map grants onto individual actions: a provider that ignores `context.scope` keeps its native authority. Claude and Veda children receive the variable without a Fabric registry to read it. See [provider capabilities](provider-capabilities.md#future-verified-extension).

## Effect semantics and scoped acquisition

Action descriptors can declare effect semantics. Descriptor hashes and committed component and actor views carry this metadata. Omitting it is the conservative choice. Read-risk actions then resolve as commutative `none`, and every other risk resolves as unknown-order `emission`.

Actions with `kind: "scoped"` must implement `provider.acquire()` and return `{ value, dispose }`. Components call these actions through `context.acquire()`. That path validates arguments, pins the provider generation, and registers a single-shot disposer in the component scope. Ordinary `invoke()` stays available for `none`, `transactional`, and `emission` actions. A component that declares the `revertible` guarantee can normally call only `none` and `transactional` actions. Fabric rejects emissions from it.

The `resources` field names the affected resource classes, and `ordering` is `commutative`, `ordered`, or `unknown`. Fabric records concurrent non-read calls with an unknown footprint, along with overlapping non-commutative resources, in `audits[].effectConflicts`. Revertible components reject those calls. Fabric never reorders calls based on provider claims. These fields carry scheduling and lifecycle semantics. They do not replace authorization, and `risk` continues to drive approval policy. Providers whose descriptors can change in place may implement `subscribeCatalog(listener)`. Fabric then re-resolves dependent component targets and unsubscribes when that provider generation closes. See [components and committed capabilities](components.md).

## Nested `tool_result` proxy

Results from MCP, agent, memory, state, schema, mesh, components, compact, and external providers pass through Pi's `tool_result` middleware before Fabric enforces `maxNestedResultChars`. A user extension can then externalize or replace an oversized provider result before that result crosses into QuickJS.

A proxied event carries:

- `toolName` holding the fully qualified Fabric ref, such as `mcp.github.search`;
- a `toolCallId` that starts with `FABRIC_NESTED_TOOL_CALL_ID_PREFIX`, persisted as `nestedToolCallId` on the call's audit in the final `fabric_exec` details;
- `parentToolCallId`, the id of the call that issued it, normally the outer `fabric_exec` tool call;
- text `content` holding the raw string result or a JSON projection;
- `details` matching `FabricToolResultProxyDetailsV1`, whose `result` is the exact host-side structured value.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  FABRIC_NESTED_TOOL_CALL_ID_PREFIX,
  readFabricToolResultProxyDetailsV1,
} from "pi-fabric/protocol";

export default function resultGuard(pi: ExtensionAPI) {
  pi.on("tool_result", async (event) => {
    if (!event.toolCallId.startsWith(FABRIC_NESTED_TOOL_CALL_ID_PREFIX)) return;
    const proxy = readFabricToolResultProxyDetailsV1(event.details);
    if (!proxy || proxy.ref !== event.toolName) return;

    const serialized =
      typeof proxy.result === "string"
        ? proxy.result
        : (JSON.stringify(proxy.result) ?? String(proxy.result));
    if (serialized.length <= 6_144) return;

    const artifact = await persistPrivately(serialized);
    const replacement = {
      fabricTruncated: true,
      originalChars: serialized.length,
      preview: `${serialized.slice(0, 3_000)}\n…`,
      artifact,
    };
    return {
      content: [{ type: "text", text: replacement.preview }],
      details: { ...proxy, result: replacement },
    };
  });
}
```

If you change only `content`, the nested sandbox value becomes the patched text. To keep a structured replacement, return the proxy envelope in `details` with a changed `result`, as in the example above. When both fields are patched, a valid changed `details.result` takes precedence. Returning `isError: true` fails the nested provider invocation.

Pi core tools and captured extension tools skip this generic proxy, because they already replay their native `tool_call`, `tool_result`, and `tool_execution_*` lifecycle. Nested shell calls still emit their native identity: `pi.bash()` uses `toolName: "bash"`/`isBashToolResult()`, while `pi.powershell()` uses `toolName: "powershell"`/`isPowerShellToolResult()`. Proxied events act as middleware only. They create no separate persisted tool-result messages.

Those replayed `tool_call`, `tool_result`, and `tool_execution_*` events carry the same `parentToolCallId`, as Pi's own nested calls do. A listener can then attribute a nested call to its `fabric_exec` when several run in parallel. A call Fabric issues outside a `fabric_exec`, such as one from a Jev program or a component, carries Fabric's own id for that caller.
