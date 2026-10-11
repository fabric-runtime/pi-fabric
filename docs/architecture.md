# Architecture & security

## Architecture

```text
fabric_exec
    │
    ▼
TypeScript checker → QuickJS sandbox (default)
                   └→ disposable Node process (unsafe opt-in)
    │ JSON-only host bridge
    ▼
ActionRegistry ◀── staged commit ── ComponentSupervisor
    ├── pi.*                          ├── pinned first-party providers
    ├── extensions.*                  └── configured and discovered components
    ├── mcp.*
    ├── agents.* ──▶ actors + participant control
    ├── mesh.* ──▶ state.*
    ├── schema.*
    ├── memory.*
    ├── compact.*
    ├── cache.* local observations + optional native warming leases
    ├── thinking.* bounded host-session reasoning effort
    ├── decisions.* durable approvals and questions over the mesh
    ├── programs.* content-addressed saved programs, run nested
    ├── components.* kernel diagnostics and reload
    └── external providers

ActivityStore → compact widget + footer status + interactive dashboard
```

Unique provider extra keys and unknown actions feed a [catalog repair table](repairs.md). Session JSONL is the log; `current.json` holds unique schema maps. Effect failures (bash, edit miss) and guest typecheck are classified for status but never promoted.

In the default QuickJS runtime, guest code runs without `process`, `require`, filesystem, network, or subprocess globals. Every effect crosses the host bridge, and schemas, approvals, audit records, timeouts, and cancellation apply there. Each execution gets a fresh QuickJS context. Strings the caller names in the `payloads` tool parameter appear as `π.key`. Reading a missing key throws a clear, actionable error that lists the provided keys.

The optional `node-process` executor runs the same type-checked guest API and host-call protocol inside a fresh child process with a configurable V8 heap. It serves workloads that exceed the WASM32 memory ceiling. This mode is not a security boundary, because Node's `vm` module cannot safely contain hostile code. Fabric restricts this mode to trusted configuration and describes it as unsafe in `/fabric settings`. Schema enforce mode disables it. Parent-side deadlines and cancellation terminate the whole child process.

## Component control plane

The [component plane](components.md) supervises provider registry changes under the lifecycle laws and author duties in the [component calculus](component-calculus.md). A [provider specialization](provider-component-calculus.md) applies those rules to first-party namespaces and rolling replacement.

Before activation, a definition declares its required actions and optional services while the loader resolves a capability view with versioned descriptor hashes. Mounted providers stay staged until their effects finish and the target passes a second check, which makes publication atomic.

Replacement retires the old generation, which makes dependents unload before its provider inverse runs. Retained views and active calls can use that generation until quiescence. Transition epochs prevent stale publication at yield boundaries, and disjoint provisions keep each namespace unique. Parent-owned child fibers unwind before the parent. Effect scopes apply their inverses in LIFO order and send cleanup failures to quarantine.

The dashboard renders the requirement graph as a component group. Participant ownership uses a separate topology. Enabled first-party providers mount through pinned components. `components.*` remains in the kernel and controls the graph. Runtime initialization completes each pinned mount before it creates the execution service.

The same committed-view protocol can close an actor child's Fabric surface around a portable descriptor digest. The child resolves that digest, then each nested call uses the pinned view. This behavior defines capability coherence. Host component code runs as trusted code outside the sandbox.

## Tool discovery and generic calls

Inside `fabric_exec`, the `tools` surface discovers and calls any provider generically. This helps when you do not know the exact ref ahead of time:

```ts
const providers = await tools.providers();
const candidates = await tools.search({ query: "GitHub issues" });
const schema = await tools.describe({ ref: candidates[0].ref });
const result = await tools.call({
  ref: schema.ref,
  args: { query: "is:open label:bug" },
});
return result;
```

Known actions keep first-class proxies, and they still cross the same registry path: `mcp.<sanitized_server>.<sanitized_tool>(args)`, `memory.*`, `state.*`, `schema.*`, `components.*`, and `compact.*`. `mcp.fal_ai.get_model_schema(args)` resolves the mcporter names `fal-ai` and `get-model-schema`. Captured extension tools take the form `extensions.<tool>(args)` in full code mode. Reserve `tools.call()` for refs you discover or compute at runtime.

Refs are namespaced: `pi.grep`, `extensions.<tool>`, `mcp.<server>.<tool>`, `schema.<action>`. Calls with bare names are rejected. `tools.describe({ref})` falls back to a bare action name when exactly one provider exposes it, and ambiguous names return an error that lists the qualified refs. `tools.providers()` → `[{name,description}]`; `tools.catalog({provider?,limit?})` → the deterministic current provider/action head tree with descriptor hashes and explicit non-historical metadata; `tools.search({query,limit?})` → `FabricAction[]`; `tools.describe({ref})` → the full `FabricAction` (read its `inputSchema` first); `tools.call({ref,args?})`; `tools.list({provider?,namespace?,query?,limit?})`; `tools.models()` → Pi `[{provider,id,name,key}]`; `agents.models({runner:"claude"})` → Claude Code runtime models. For the exact signatures and the read → describe → retry error loop, see the model-facing `fabric-exec` skill.

`tools.list` pages at 100 entries by default (hard cap 1000) and the bare-array result carries no truncation marker, so a short result never proves an action is absent. `tools.list({envelope: true})` returns a `{kind: "pi-fabric.action-list", version, actions, total, truncated, limit}` envelope whose totals are computed after guest-visibility filtering; targeted discovery should prefer `tools.search`. See [tool entropy](entropy.md) for how observed rejection rates relate to discovery friction.

## Tool-call robustness

The model-facing `fabric_exec` schema is flat. It carries one large `code` string plus scalar/optional parameters, and it contains no nested arrays-of-objects holding escaped content. Newer SOTA models are post-trained on one dominant harness's flat tool shapes. Such models can invent trailing keys at the highest-entropy point of a nested escaped-JSON field, for example right after closing a long multiline string, and a strict schema rejects those keys. The only nested field, `display`, ignores unknown keys. The schema accepts extras and filters them to `{ name, description }` before execution, which mirrors the silent-filter behavior the dominant harness's client is trained against.

The model writes TypeScript that calls tools. Deterministic, type-checked code builds each nested object. Fabric's TypeScript checker catches incorrect code and returns an actionable error with line numbers.

Pi Fabric applies a narrow compatibility layer at each boundary before authoritative validation runs. The outer `fabric_exec.prepareArguments` hook wraps a root code string, joins all-string code arrays, omits null optional metadata, and canonicalizes `display`. Inside the guest, `pi.*` calls normalize positional forms, observed field aliases, numeric strings, and known optional nulls. The registry then validates against the native Pi schema. Required nulls, mixed arrays, unknown keys, and otherwise ambiguous shapes still fail normally.

For provider-level corruption, or for sessions that expose Pi tools directly, install [pi-tool-repair](https://github.com/monotykamary/pi-tool-repair) as a companion. Pi 0.84 validates before `tool_call`. The companion repairs the finalized assistant `toolCall` arguments at `message_end` against each active tool's live schema, and it revalidates them before committing. In full code mode it can repair the outer `fabric_exec` call, leaked tool-call grammars, anchor bleed, and phantom tool-use responses. Fabric stays responsible for nested `pi.*` calls that the TypeScript guest creates later. The packages register no competing tool wrappers.

The provider owns the Anthropic strict tool use setting. When enabled, strict mode stops the server from sampling keys that are absent from the schema. Anthropic limits the complexity of strict tool definitions.

## Shell exit status and result middleware

`pi.bash(..., { settle: true })` and Windows-only `pi.powershell(..., { settle: true })` convert an ordinary native nonzero exit into
`{ ok: false, exitCode, output, details, error }`. Fabric classifies that exit
before `tool_result` middleware runs and transports the status separately from
display text in both runtimes. Trimming, redaction, newline changes, or replacing
the display text cannot erase the exit status. `output` and `error` use the final
middleware text; they never restore text removed by a middleware. Native status
line removal is best-effort display cleanup; ambiguous text is preserved.

Timeout, cancellation, approval and preflight failures remain exceptions. A
middleware failure after a successful command also remains an exception, and
middleware recovery through `isError: false` remains effective. Pi's
`emitToolResult` returns the **effective** `isError`, without identifying whether
a handler introduced a new failure. After a native nonzero exit, Fabric cannot
distinguish an annotation/redaction from an additional middleware veto expressed
only through text and `isError: true`. Such a veto needs a separate explicit
provenance contract; this limitation is not solved by shell settlement. For now,
checks that must prevent command execution belong in approval or `tool_call`
preflight, and callers requiring all final errors to throw should omit `settle`.

## Model-context economy

Fabric caps final `fabric_exec` output at 50,000 characters by default, which matches Pi's built-in 50KB tool ceiling. Failed executions get a tighter 20,000-character visible ceiling, and the complete output stays in the same private artifact. An oversized structured return shares that budget across every multiline section and preserves both ends with explicit omission markers. Unstructured output keeps its global beginning and end. Fabric writes the complete output to a mode-`0600` temporary artifact and includes the artifact path inside the visible ceiling. The model can then retrieve a targeted range without carrying the entire result. Type-check diagnostics use the same ceiling. Models should still filter noisy commands and return only useful evidence, because source-side projection preserves more relevant information than post-format truncation. When a later nested call fails after earlier calls completed, the error adds a bounded list of completed refs and paths. The model can inspect that list before repeating side effects. Nested outputs the guest did not return are never exposed. Raw media never enters those text channels: image payloads in `fabric_exec` logs, results, and error text, in worker event lines, and in actor host events are replaced by a `{type: "image", mediaIndex, mimeType, redacted: true}` descriptor and hoisted out of band, so a nested `pi.read` image stays available to a multimodal model without pushing hundreds of KB of base64 into one serialized line. A child event line that only exceeds the 4 MB cap because it embeds raw base64 is sanitized to avoid failing the run.

### Foreground tools

Full code mode keeps `fabric_exec` as the single model tool so that every effect passes one typed, budgeted, audited path. A few extension tools only make sense as a direct model turn, such as a question to the human. The `foreground` policy declares a capped, explicit list of such registered tools beside `fabric_exec`. It changes declaration only. It grants no new authority: a direct call takes the same `tool_call` hooks, the same `extensions.<name>` approval ref and risk class as the program path, and the tool stays callable from programs. Pi core tools, Pi built-ins, and Schema enforce mode are excluded. See [foreground tools](configuration.md#foreground-tools).

## Federated participant topology

Fabric separates **identity** from **execution ownership**. Each root, one-shot or recursive agent, and actor carries a single intrinsic participant record with `rootId`, optional `parentId`, `ownerHostId`, `residency`, and the owner's authenticated wire identity. Main and Peer are projections of root records. Every process publishes one leased host record plus the participants it manages directly. An ancestor never re-advertises recursively discovered UI descendants. Readers treat every record behind an expired host as stale. Crash cleanup then covers the whole host. Shared summaries contain operational metadata only. Agent prompts, results, and errors stay local. Local run/actor managers overlay richer private detail only when the directory marks that participant local.

Cross-process control targets one resolved owner. The sender addresses a versioned command to that owner and accepts a reply only when its target and wire identity match. Before execution, the owner checks the target against its local managers. Unknown, stale, rejected, spoofed, replayed, and expired commands fail closed.

The owner claims each command ID in reserved state before execution and stores the result before replying. Claims remain while the command is present in the bounded retained event log. A restart can return the stored result without running the command again. A crash after the claim but before the result returns an explicit indeterminate rejection.

Long actor asks run outside the control poll loop, so they do not block stop or cancellation commands. The request deadline aborts work on the owner. Caller cancellation sends an authenticated cancel command to the same owner. Actor replies share one mesh byte budget across text and structured data; an unexpected oversized result becomes an explicit rejection and never becomes a silent timeout.

Control topics and topology and legacy state prefixes are reserved from guest mesh writes. The old `fabric.steer` relay and dual-written root and actor presence remain for mixed-version sessions. Pi children inherit absolute project and mesh roots, including worktree and recursive launches, so descendants join the same topology.

## Security and limitations

- When no captured override exists, Pi Fabric invokes separately constructed Pi built-in definitions. With Pi's extension runner available, Fabric replays their native `tool_call`, `tool_result`, and `tool_execution_*` lifecycle. Captured overrides and extension tools use that same lifecycle. Fabric's approval and audit layer stays authoritative around every nested call.
- A captured exact-name core override contributes only a bounded, execution-local object overload and authored guidance to its existing `pi.<name>` slot wherever Fabric uses effective full-code execution, including Schema enforce mode. Built-in shorthand and normalized result contracts remain unchanged; the live registry schema and enforce host gate remain authoritative.
- Non-Pi provider results emit a transient namespaced `tool_result` proxy before the QuickJS result bound. The proxy's details envelope exposes the exact host-side result to trusted user extensions. Those extensions can inspect or externalize sensitive provider data. The proxy does not create a separate persisted tool-result message.
- Captured tools execute with the full privileges of their owning extension. Hiding a tool schema optimizes context. It does not sandbox anything. Captured tools keep their definitions and native renderers. Nested calls still render inside the enclosing Fabric execution, so they do not appear as separate native tool rows.
- Registry interception composes through the public `ExtensionRunner.getAllRegisteredTools()` method. If an extension replaces that method and fails to delegate to the previous implementation, it can prevent capture.
- MCP servers, external providers, and component definitions execute with their own host privileges. Review their configuration and code before you enable them. Component effect scopes can unwind registered effects only. Ambient side effects hidden from the supervisor are outside their reach.
- Type checking improves reliability. It is not a security boundary. In the default runtime, QuickJS isolation and the host capability bridge form the boundaries. The optional Node process runs as trusted native execution outside the QuickJS boundary.
- Child Pi processes load normal extensions by default, so provider-backed models keep working. With `extensions: false`, Fabric loads only the requested model's provider registration from its extension and discards the rest of that extension (see [third-party model providers](configuration.md#third-party-model-providers)). Claude children use the official installed CLI with its existing authentication. Both runners restrict the active model-facing tools to `defaultTools`. Pi adds `fabric_exec` only for explicit recursion. Claude rejects recursion and unmapped tools.
- `agents.handoff` schedules an explicit `agent`-risk delegation at the complete outer `fabric_exec` boundary. The guest call returns a deferred marker, and the rest of the Fabric program continues. Once every nested call and the outer result middleware finish, Fabric forks through the native assistant `fabric_exec` entry, appends its exact finalized native `toolResult`, and starts the target from that branch. Fabric does not create synthetic nested assistant turns or a custom context dump. The mode-`0600` child session lives inside the managed run directory. The source session and its history stay unchanged. Normal outer output and trace limits apply before the fork. The target model can see the Fabric source and result, so do not hand off a trajectory that contains secrets to a provider that should not receive them.
- `/fabric prewalk` pre-authorizes the same one-shot delegation through `prewalk.model` or an interactively selected Pi executor. The command adapts [Stencil's Prewalk](https://stencil.so/blog/prewalk) and [oh-my-pi's in-place implementation](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/agent-session.ts) into a prompt-free form. It uses a coarser atomic boundary. The first monitored mutation marks the outer Fabric invocation, every remaining nested call still runs, and the executor starts only from the complete native `fabric_exec` call/result pair.
- Claude `extensions: true` preserves the user's normal Claude Code customizations, including applicable settings and hooks. Those hooks execute with their usual host privileges. Set `extensions: false` for Claude safe mode. When allowed, `Bash` stays unrestricted inside the child, in the same way as Fabric's `bash` capability.
- Claude model discovery sends a local initialization control request and never invokes a model. One-shot and actor activations use the account or API billing already configured in Claude Code. Fabric records the CLI's reported `total_cost_usd` in its normal usage and budget ledgers.
- A Git worktree isolates files. It does not isolate credentials, network access, processes, or external services. Fabric-managed worktrees live at `<repo>/.pi/fabric/worktrees/<id>` and clone the source tree copy-on-write when the filesystem allows it.
- Fabric projects agent transcripts from local `events.jsonl` run logs. The dashboard redacts common credentials from compact tool previews. The permission-restricted raw event log can still contain assistant text, tool arguments and results, diagnostics, and extension protocol payloads. Persisted `fabric_exec` traces also retain projected bash command text for command previews. Treat retained session and run data as sensitive.
- Fabric stops session-resident background children when the parent Pi session shuts down. A hidden per-root resident host launches `agents.spawn({ residency: "durable" })`, and that child continues after the TUI exits. A detached spawn sends a follow-up completion message unless the caller later waits for it or `notifyOnComplete` is disabled. Resident completion messages queue in mesh state until Main resumes. Durable participant lifecycle subscriptions deliver source-qualified Pi and run notifications across roots, agents, and actors with no transcript disclosure. Completed worktrees are retained on purpose.
- Fabric suspends session-resident actors on shutdown and restores them after project trust. `agents.create({ residency: "durable" })` transfers execution to the hidden resident host before it returns. The mailbox, mesh subscriptions, relayed Main events, and runner session continue after Main exits.
- Claude actor session IDs point to Claude Code's private session store. Removing that session makes resume fail. Removing the Fabric actor does not delete Claude Code's transcript.
- Project actors live under `.pi/fabric/mesh/actors/` and survive `/new`; session actors live under `.pi/fabric/mesh/actors/<sessionId>/`. `agents.create({ scope })` selects either boundary per actor, while `mesh.actorScope` supplies the omitted default, so both kinds coexist. Mode-`0600` binding files store each caller session's model and thinking values without changing project defaults. Root session identity propagates through participant agents. Mesh topics and shared state remain project-scoped. Do not put secrets in actor prompts, messages, or mesh state.
- Approving `agents.create()` delegates future subscribed events until someone stops the actor. Durable residency lets that delegation outlive the approving TUI. Each mailbox item stores one model and thinking view before it queues: call override → session binding → project default → Fabric default. The runner and tool allowlist remain fixed for that activation. Review them before approval. Tool changes affect later activations only.
- Only an approved durable `agents.spawn` or `agents.create` action in a trusted mesh-enabled project starts the hidden resident host. Its mode-`0600` config, command spool, run metadata, and PID lock live below the root's mesh residency directory. This IPC is crash-conservative: an interrupted claimed request reports an indeterminate outcome, and the request is not replayed. The IPC is not a boundary against arbitrary host filesystem access. Trusted code with direct access to `.pi/fabric` can corrupt residency state in the same way it can corrupt the mesh. Empty resident hosts exit after a short grace period. Lock and owner liveness is PID-namespace aware; see [containers and PID namespaces](residency-runtime.md#containers-and-pid-namespaces).
- Actor responses enter the main context only through the delivery policy fixed at creation. Directive output passes schema validation. It is still untrusted model output, and the main agent should weigh it.
- A project-scoped actor has one execution owner. Passive sessions do not consume host events, drain a second mailbox, or persist shutdown state. They can read the shared definition, mailbox, and logs; change their own model and thinking binding; and send direct calls to the authenticated owner. The owner can also execute a routed `stop`. Shared runtime settings stay owner-only. Fabric routes durable removal to the resident owner.
- A persisted actor can lose its advertised owner after a host lease expires. If its lineage root is also absent, a residency-matched host may adopt it and change `rootId`. The registry grants ownership only after it stores the new `rootId` and an `adoptedAt` fence under lock. Concurrent starters converge on one adopter. The 30-second fence gives a new adopter time to publish its participant record.
- Shared `actors.json` writes use a stale-safe lock and merge only records owned by the writer. One owner cannot overwrite another owner's newer actor record. Use session scope for independent actor sets or private mailbox histories. Different model or thinking choices do not require it. Mesh events remain append-only until bounded compaction keeps the newest tail. Archive or remove an old mesh root when that retained history is no longer useful.
