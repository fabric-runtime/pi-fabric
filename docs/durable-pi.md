# Durable Pi runner

`agents.runner` defaults to **`pi-durable`**: an isolated Pi SDK process with a real
`AgentSession`, native RPC, and a `DurableAgent` backed by the published durable
Harness. Pinned worker dependencies ship with Fabric; registration and idle hooks
do not load the worker or engines.
No manual setup is required. Main's outer Pi session is unchanged.

The subprocess owns a pinned SDK installed as `pi-fabric-worker-sdk` (an npm
alias), because Pi-managed installs deliberately omit host-provided peers.
Only the durable worker maps Pi imports to that SDK and its dependencies; the
extension continues to use Main's host modules. If a partial/older installation
reports a missing worker SDK, reinstall or update Fabric to restore its runtime
dependencies. Installing Pi peers manually is not required. When Bun launches
the parent worker, the durable SDK host runs through `node` on PATH and requires
Node.js 24+, matching Fabric's declared engine. This keeps module resolution
isolated without passing `NODE_PATH` to tools or borrowing Main's SDK.

Set `agents.runner: "pi"` (or `runner: "pi"` per request) for the previous Pi CLI
worker. Existing explicit configurations and stored actor runners are not
rewritten. Pi JSONL remains the history interchange format. Custom Pi CLI wrappers
and `PI_FABRIC_PI_BINARY` apply only to the explicit legacy `pi` runner; the
durable worker uses the SDK and inherited process environment directly.

## Full Pi/Fabric host

The default keeps native resource discovery, project trust, credentials/model
runtime, tools, extension hooks, images, virtual models, provider hooks, steering,
follow-ups, cancellation, and compaction. Fabric's existing process worker retains
model admission, schema validation, budgets, lineage, question routing, session
import/export, kernels, recursive Fabric, scopes, and write confinement. Actors
accept both Pi runners. Handoffs use the configured Pi runner; `rlm.query` defaults
to `pi-durable` and accepts an explicit `pi` override.

Unknown projects remain untrusted unless an existing policy or trusted bootstrap
extension grants trust. Extension-load errors fail closed; a permission guard is
never silently omitted.

## Recovery boundaries

Private per-run JSONL stores flush payloads and commit markers. An OS-held SQLite
exclusive transaction prevents concurrent writers, including directory aliases;
process death releases it without timeout-based stealing or lock-file deletion.
Reopening the same run uses its initial run ID for idempotent submission and
resumes checkpoints. Completed work is not repeated. An interrupted unsafe tool
fails closed, including `fabric_exec`, writes, and shell commands.

A worker's store lives in its run directory under `durable/`. Recovery never
replays streaming updates, so each provider delta and tool progress update commits
only an ordered marker; the full partial message or partial result reaches
observers from memory after that commit. The journal grows with the transcript,
not with the square of each streamed message. Run retention removes `durable/`
with its run, and unknown or linked files inside it still preserve the run.

Durability **does not restore arbitrary JavaScript continuations**, promise
general exactly-once external effects, or restart failed workers indefinitely.
The standard process/actor lifecycle controls stop/retry/retention. A new run is
new work; native RPC command IDs are response correlations, not deduplication keys
for arbitrary later prompts. Do not resend acknowledged controls as new commands.
Interrupted request/turn extension callbacks may be re-entered; callbacks with
external effects need their own idempotency policy. Restoring committed message
history does not redeliver message hooks or charge usage again. Normal session
switches receive fresh request identities and do not replay old answers.
Old leaf-adapter locators/journals are not silently migrated into worker stores.

Worker retries retain the original prompt identity, so a completed journal can
restore its answer even if the parent died before saving completion. Automatic
reattachment after the owning Fabric/resident process restarts currently covers
hosted adapters, not this built-in worker. Recovery of completed conversations
with additional steering/follow-up user messages also remains incomplete: strict
transcript correlation fails closed to avoid attributing a stale answer.
Control acknowledgements do not provide an end-to-end exactly-once delivery
contract; do not blindly resubmit a command whose acknowledgement was lost.

## Advanced: manually registered leaf adapter

The rest of this guide concerns the restricted `pi-fabric/durable` factory, **not**
the built-in default. `createPiDurableRunner` still accepts host-supplied Models,
Registry, environment, and storage. Its default ID is now `pi-durable-leaf`; the
built-in `pi-durable` ID is reserved. Existing custom registrations should select
the separate ID explicitly.

Exports include `PiDurableRunner`, `PiDurableRunnerOptions`,
`PiDurableStorageOptions`, `PiDurableStorageLease`, `PiDurableLocator`, and
`PiDurableMessageOptions`. Import/construction stays lazy and does not register a
runner. First use checks pinned `@earendil-works/pi-durable@1.1.0` and
`@earendil-works/chord@1.1.0`. Credentials remain in Models/environment, never in
a locator.

### Leaf host setup

```ts
import { createPiDurableRunner } from "pi-fabric/durable";
import { registerAgentRunner } from "pi-fabric/runners";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

// Supply a configured pi-ai Models collection and a durable Registry.
// Install only trusted tool implementations in that registry.
const runner = createPiDurableRunner({
  id: "pi-durable-leaf", // separate from the built-in full host
  models,
  registry,
  env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd! }),
  allowedModels: [{ provider: "openai", modelId: "your-model-id" }],
  defaultModel: { provider: "openai", modelId: "your-model-id" },
  storage: { kind: "jsonl", directory: "/absolute/private/durable-runs" },
  // Required for standard residency: "durable":
  // residentModule: "/absolute/path/to/host-registration.mjs",
});
const unregister = registerAgentRunner(runner);

// Select this runner explicitly, or set agents.runner to its registered id
// for a host that only uses the supported leaf-run capabilities.
// model can be omitted when defaultModel is configured above.
// { runner: "pi-durable-leaf", task: "...", tools: ["read"],
//   recursive: false, thinking: "off" }

// Detach only after the host has stopped delivering requests to this instance.
await runner.close();
unregister();
```

`residentModule` must be a real host-owned ES module that registers the adapter
with the same storage and credentials in the resident process. Merely setting the
path does not create a daemon. A session-resident runner needs no resident module.
The factory does not discover providers or credentials. `models()` advertises only
currently resolvable entries in `allowedModels`, with credential-free metadata.
An optional `defaultModel` must be allowlisted; without it an explicit model is
required. Model execution continues through the supplied `Models` collection.
Thinking is passed explicitly (omission means `off` at the adapter boundary);
unsupported levels are rejected; the adapter does not clamp them.

## Leaf adapter supported requests

- **Image input:** `images` is submitted as native image blocks alongside the task.
  The selected model must declare image input. PNG, JPEG, GIF and WebP are accepted
  as padded base64, with at most 32 images and 16 MiB of base64 characters total.
  Durable storage retains the images; Fabric's text transcript projection does not
  reproduce their bytes. Images never enter the locator.
- **Structured output:** `schema` is included in the model instructions, and the
  final answer is parsed and validated with Fabric's normal result validator.
  Invalid output fails the run; valid output is reported as `structured` and
  reaches the agent result's `value`. This is validation, not provider-enforced
  constrained decoding. Schemas are bounded to 262144 JSON characters.
- **Steering and follow-up:** admitted messages extend the same Fabric run's
  completion boundary. See below; a completed run cannot be reopened with a new
  message. This is not persistent actor/session support.

The committed request fingerprint includes image content and output schema;
reattaching the same run ID with changed inputs is refused.

## Storage and ownership

There is one isolated durable Session/root conversation **per Fabric run ID**.

### Built-in JSONL

`{ kind: "jsonl", directory }` opens the published Node JSONL backend with
`fsync: true`. Files live under `directory/sha256(runId)`; an atomic mkdir of
`directory/sha256(runId).writer` grants exclusive ownership. The base directory is
canonicalized before opening the lock and storage, so symlink aliases contend for
the same filesystem lock. A process-global ownership set also rejects two active
adapter instances with the same identity/run ID. An active run retains ownership,
including after settlement, until `close()`.

**No automatic stale-lock stealing.** Any existing lock (including malformed,
empty, unknown or remote ownership) is a refusal, never evidence of death. This
avoids both lease-timeout false deaths and the two-contender read/dead/unlink race.
Locks are intentionally empty and contain no credentials. Keep the directory
private to cooperating trusted hosts; this is not a hostile-filesystem sandbox.

After a crash, the host must:

1. Quiesce **all** recovery contenders/writers for this storage/run.
2. Positively establish that the previous process and any invocation using the
   storage have terminated (e.g. the supervised process's exit receipt). Timeouts,
   old mtimes, missing heartbeats, and unknown PID namespaces are insufficient.
3. Remove only the exact empty `sha256(runId).writer` directory while recovery is
   administratively serialized. Never blindly unlink a possibly replaced lock.
4. Reopen a new factory instance with the same directory and call attach using
   Fabric's persisted locator/context. Do not call start to repair missing work.

SIGKILL recovery is tested with exactly this manual restore procedure. Automatic
unattended crash recovery needs a host factory that supplies an appropriate lock.
JSONL durability remains subject to the published storage/filesystem contract;
this adapter does not promise power-loss-proof filesystem metadata.

### Host-provided storage

```ts
storage: {
  kind: "factory",
  identity: "tenant-a-durable-v1", // stable opaque identity, no secret required
  async acquire(runId) {
    // Acquire an exclusive process/host-wide lease; OS crash-released locking
    // can provide unattended recovery. Open the SAME isolated storage for runId.
    return { storage, async release() { /* release ownership, not work */ } };
  },
}
```

`acquire` must reject conflicting ownership, including other processes and
aliases, and must return a distinct isolated storage namespace per run ID.
It must clean up partial acquisition on failure. The adapter closes storage via
Harness before `release`, never releases while its invocations still run, and
joins accepted open/start operations during `close`. In-memory storage is useful
for tests but is not restart persistence. Failed closure/release fails closed;
its lease remains owned, and competing writers are refused. Well-behaved
host tools must observe cancellation: upstream close joins even tools that ignore
it, so such tools can block close indefinitely.

## Admission, attach, and reporting

Fabric persists the pure JSON locator before `start`. It contains backend/version,
a storage identity hash, and Fabric run ID only. `start` commits a request manifest
and submits with **requestId = Fabric run ID**. Repeated starts, including after
reopen, reuse the committed submission. A changed task/model/tools/cwd/thinking/
system prompt/images/schema under that run ID is rejected.

`attach` looks up the existing root and `submissionByRequest`; it never creates a
conversation or submits an input. A locator with no admitted submission throws;
the existing HostedRun protocol records the outcome as **indeterminate**, not
retryable work. A crash between manifest creation and submission is therefore
not automatically repaired. Locators must be retained with Fabric's context.

Committed conversation snapshots feed progress (turns, calls, current tool,
partial text), cumulative model/tool usage, and transcript messages/tool events.
Transcript attachment reconstructs the current committed history; it does not
rerun effects or guarantee exactly-once transcript delivery across host restarts.
The admitted submissions map to completed/text, aborted/stopped, or unanswered/failed.
Completion waits for the initial input and every accepted control message, and
returns their latest answer by answer-entry order (not message-admission order).
Liveness is running, settled, cancelled, interrupted, or unknown. Unowned/missing
work is unknown; explicit stop returns unconfirmed when no owned submission exists.

`stop` aborts the owned root's work, including background descendants, and joins
it. `close` instead seals the adapter, detaches observers, closes Harness without
writing an abort outcome, joins invocations, and releases ownership. A new
factory instance can attach afterward. `close` is idempotent, but a closed
instance cannot reopen. This is a resource lifecycle surface, not a sleep/wake
capability. Fabric's own explicit stop/shutdown/deadline policy is unchanged.

## Durable steering and follow-up

`runner.steer(locator, message, options?)` places input at a tool boundary;
`runner.followUp(locator, message, options?)` queues the next generation after
the current answer. The public methods can take a host-issued stable identity:

```ts
await runner.followUp(locator, "Also verify the migration", { requestId: "verify-1" });
```

Retrying the same `requestId`, message and method is a no-op, including after
reattachment or completion. Reusing it for different work is rejected. Without
`requestId`, each invocation is a distinct message. Other message-option fields
are rejected, not ignored. Normal Fabric `agents.steer`/`agents.followUp` calls
are also supported; their delivery acknowledgement is not a new completion receipt.

Admission uses the upstream submission's atomic, persisted request identity.
Recovery discovers committed submissions directly from storage, including a
message admitted just before a crash; it never replays the message as a new
submission. A persisted completion boundary rejects new messages after settlement.
Limits are 128 control messages per run, 16384 characters per message and 256
characters per supplied `requestId`. A failed generation withdraws queued
follow-ups so the Fabric run does not wait indefinitely. `stop` also
aborts an executing follow-up, even if the original input is already answered.

## Tools and limitations

Only names in `request.tools` are selected. Unknown names and unknown/disallowed
provider/model keys fail closed before admission. Registered tool definitions
are resolved last-installed-wins, host tool wrappers are applied in registry
order, and selected implementations are pinned in a private per-open registry.
Changes to the host registry do not rewrite in-flight code; reopen resolves the
host's current definitions and refuses missing requested names.

**This is a tool-only Registry integration.** Host extension sections, hooks,
and custom tasks are not installed in the private registry. The request system
prompt becomes conversation instructions; cwd is handed to the host environment.
Tool execution remains trusted host code, not a security sandbox. Host tools can
use their durable execution API; the adapter does not claim to confine arbitrary
host side effects or sub-work they create. Tool result `addTools` and `handoff`
controls are rejected. The requested allowlist stays fixed.

There is no built-in Fabric tool bridge, kernel, or JavaScript continuation
restoration. Replay is the published explicit task/checkpoint protocol: tools
are unsafe by default, and interruption returns an error. An uncertain side effect
is not replayed. Only a host's explicit replay-safe tool declaration
permits replay; the adapter never blanket-marks tools safe. A host-registered
`fabric_exec` implementation is always forced unsafe even if the host accidentally
marks it safe; no Fabric bridge is synthesized.

Unsupported capabilities still fail closed: recursive Fabric, kernels,
branch/session seeding, actors/persistent sessions, write confinement, scopes,
routed questions, explicit compaction, and sleep/wake.

## Full-host and leaf boundaries

The default is a **worker** adapter, preserving native permission and lifecycle
ownership. The manually registered leaf adapter remains **hosted**, with its
unsupported capability checks intact. Neither silently falls back to a native
Agent when durable execution fails.

Full-host coverage is in `tests/durable-agent.test.ts`,
`tests/durable-session.test.ts`, `tests/durable-worker-storage.test.ts`,
`tests/durable-worker-host.test.ts`, `tests/durable-worker-routing.test.ts`,
`tests/durable-worker-e2e.test.ts`, `tests/durable-fabric-exec.test.ts`,
`tests/handoff-continuation-worker.test.ts`, and `tests/durable-actors.test.ts`.

## Evidence

`tests/durable-runner.test.ts` exercises the real published packages with offline
faux models, MemoryStorage and fsync JSONL: real AgentManager execution, duplicate
admission, reopen/attach, cancellable unsafe interruption, a killed
process/manual recovery/no replay, exclusive ownership, stale-lock refusal,
close/open races, exact tools/model/thinking, usage/progress, configured leaf
defaults, model-metadata privacy, images, schema validation, message ordering and
deduplication, queued-message recovery, cancellation and unsupported requests.
`tests/durable-input.test.ts` covers request snapshots and input bounds.
`tests/durable-controls.test.ts` covers the completion-versus-cancellation race.
`tests/optional-durable-startup.test.ts` checks lazy engine loading even with built-in runner registration.
