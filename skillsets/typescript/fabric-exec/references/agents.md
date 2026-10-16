# Agents and rlm reference

`fabric_exec` can spawn one-shot child agents, create persistent event-driven actors, and run recursive queries. For the sandbox model and `tools` discovery, see the parent `fabric-exec` skill; for actor coordination across sessions, see `mesh.md`.

Every method takes a single options object.

## One-shot child agents

`agents.wait({id})` is canonical; `agents.join({id})` is its alias with the same arguments, result, progress, and detached-completion notification behavior. Jev uses the same naming: `jev.wait` with `jev.join` as an alias.

- `agents.run(args)` runs to completion and returns `FabricAgentResult` with `{ id, runner, kernel?, status, text, value?, error?, usage, turns, toolCalls, runnerSessionId? }`.
- `agents.spawn(args)` returns a background `FabricAgentHandle` with an `id`. Then use `agents.wait({ id })`, `agents.status({ id })`, `agents.stop({ id })`.
- `agents.list({ scope? })` returns agent participants. `scope` defaults to `"local"`; use `"lineage"` for every agent under the same root across recursive runtimes, or `"project"` for all live project agents. Local entries retain full run detail; remote entries are bounded participant summaries.
- `agents.cleanup({ id, deleteBranch? })` returns `{ cleaned }` and removes a worktree branch.

`args` is a `FabricAgentRequest`: `{ task, name?, runner?, kernel?, transport?, model?, persona?, thinking?, thinkingBounds?, tools?, timeoutMs?, extensions?, recursive?, cwd?, worktree?, worktreeSetup?, seed?, seedMessages?, readOnly?, writableRoots?, shell?, scope?, schema?, systemPrompt? }`. `cwd` is a filesystem path only: absolute values are accepted, relative values resolve from the parent manager cwd, and Fabric reports the canonical directory after resolving symlinks. Invalid or non-directory targets fail without falling back. `persona` selects a Veda persona for that invocation and is rejected for Pi/Claude runners.

For Pi leaf or recursive agents, selecting `cwd` neither grants nor requires project trust. Fabric adds no trust gate and passes neither `--approve` nor `--no-approve`; Pi loads `AGENTS.override.md`, `AGENTS.md`, and `CLAUDE.md` under its normal rules, while protected project resources follow Pi's saved decisions and `defaultProjectTrust`. Other runners retain their native startup behavior. Generated worktree paths are evaluated at their own canonical paths.

- `runner` is `pi`, `claude`, or `veda` and defaults to `agents.runner` (`pi`). The `veda` runner drives the Veda CLI as a one-shot headless child; `agents.veda.backend` selects Veda’s underlying CLI (`agy`, `codex`, `claude-code`, `droid`, `pi`, or another backend registered by the installed Veda build), while `persona` selects its behavior. An explicit `agents.run({ model })` overrides `agents.veda.model`; if both are omitted, Veda selects its backend default (see `docs/agents.md`). Extensions may register more runner ids through `pi-fabric/runners`; requests needing a capability the runner does not declare fail before launch. A result with `outcome: "indeterminate"` means Fabric cannot confirm whether the work ran; it is never retried automatically, so inspect before re-running.
- `kernel` is `"typescript"`, `"python"`, or `"inherit"`. Omitted/`inherit` takes the caller's `executor.kernel`; a concrete value lets the model or skill choose its strongest language for the **child**. It never switches the current `fabric_exec` program. Concrete values require Pi with Fabric extensions; Claude/Veda/`extensions: false` reject them, while omitted/`inherit` leaves those runners native with no `kernel` in status. Supported handles/results/status expose the resolved language. Workflow, RLM, and council requests forward `kernel` too. Python uses the caller's configured `executor.pythonRuntime` backend (`monty` by default); there is no public per-request backend selector. Monty is sandboxed and fails closed if its optional dependency is missing. CPython requires explicit configuration and outside schema enforce is trusted native code, not QuickJS isolation.
- The caller's resolved language and configured Python backend are frozen before worker launch or durable/trajectory transfer. Recursive and alternate-cwd children inherit them through validated worker environment overrides after config merge, not the destination cwd's language defaults. Explicit kernels and inherited Python ensure Fabric is loaded even outside full-code mode. See [execution kernels](../../../../docs/kernels.md).
- `transport` is one of `auto`, `process`, `tmux`, `screen`, `localterm`, `herdr` (default `process`). `auto` tries Herdr when the parent runs inside a Herdr workspace, then LocalTerm, tmux, screen, and process.
- Pi `model` values resolve only within the execution owner's visible `tools.models()` / `agents.models({ runner: "pi" })` set; omitted uses `agents.model` or inherits the host model. Explicit values go through the `agents.switchModel` selector resolution: `models.aliases` names, exact matches, then the closest fuzzy match (pi-model-sort recency ties break toward the recently used model). Unresolved values and exhausted aliases fail before launch, and actor defaults or per-activation overrides are revalidated at their actual owner. Catalog-fresh or custom ids must first be visible in that registry. Claude values are `claude/<value>` keys from `agents.models({ runner: "claude" })`; omitted uses `agents.claude.model` or Claude Code's runtime default. Veda model strings continue to pass through to its backend unchanged. `agents.models()` defaults to the configured runner; Claude discovery is a local CLI control handshake and makes no model inference request.
- `systemPrompt` is appended to the child's system prompt (Veda gets it as a `<system_instructions>` block); blank is ignored and durable `spawn` refuses it.
- `thinking` is the reasoning effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); defaults to `agents.thinking` (`medium`) and is clamped to the model's supported levels (next highest when unsupported). With `thinking.bounds` configured it is first clamped into the child's bounds and the handle reports the original as `requestedThinking`. `thinkingBounds: {min?, max?}` narrows the child's bounds; it must lie inside the caller's bounds or the call fails, and children never widen them.
- Extension-enabled Pi children inherit the parent’s full-code mode, including non-recursive leaf runs: `fabric_exec` remains the required outer tool and the optional tool allowlist is enforced on nested Pi/captured-tool calls. `extensions: false` opts out, and a parent outside full-code mode keeps the native surface. Recursive runs additionally receive the delegated `agent` risk; ordinary leaf runs do not. Reload Fabric before launching children to pick up a changed launch policy.
- `tools` defaults to `agents.defaultTools`. Claude maps `read→Read`, `grep→Grep`, `find/ls→Glob`, `bash→Bash`, `edit→Edit`, and `write→Write`; other tool names fail before launch.
- `schema` is a JSON Schema; the worker returns validated structured data in `result.value`.
- `cwd?: string` selects a leaf or recursive Pi child's execution directory, including another repo or a loose non-Git directory. Relative paths resolve from the immediate caller’s effective cwd; explicit paths are validated and canonicalized. Workflow helpers, `council.run()`, and `rlm.query()` forward both `cwd` and `worktree`. Persistent actor definitions and trajectory handoff still do not accept `cwd`. Project/mesh lineage and kernel/backend inheritance do not change. Target project trust is evaluated by Pi at the effective path, without Fabric approval overrides. Descendants cannot widen the inherited optional-tool allowlist; recursion delegates only the `agent` risk, not write/execute/network approval. Cwd is not filesystem isolation.
- `worktree: true` creates a dedicated Git worktree on branch `pi-fabric/<name>-<id>` from the repository containing the selected `cwd`, retained until `agents.cleanup()`. Fabric writes it at `<repo>/.pi/fabric/worktrees/<id>` (agent id, not the target repo name) and clone-first copy-on-write keeps ignored build artifacts when the filesystem supports it. A selected repository subdirectory is preserved in the generated worktree when available. The effective cwd is the generated canonical path. Project and mesh ownership remain those of the caller.
- With `worktree: true` the result carries `worktreeResult: { path, branch?, baseRef?, changedFiles (sorted, ≤500), diffstat: { files, insertions, deletions }, kept, diffError? }`; `worktree` stays the path string. `worktreeSetup: "bun install"` (or config `agents.worktree.setup`) runs in the new worktree before launch; a non-zero exit fails the launch.
- `seed` (Pi only): `"task"` (default) sends the task alone; `"branch"` starts a non-blocking fork of this conversation up to its last completed turn (no dangling `fabric_exec` call; not durable); `"snippet"` prefixes the last `seedMessages` (1-50, default 12) user/assistant texts. Unlike `agents.handoff`, the caller keeps running.
- Write confinement (Pi only): `readOnly: true` refuses write/edit; `writableRoots: ["src"]` (≤32, relative to the child cwd, default the cwd) confines them. Any policy refuses `bash` unless `shell: "unconfined"`, which is not a sandbox. Native executors (CPython, node/bun-process) are refused unless unconfined. Nested children only narrow; Claude/Veda runners and durable spawns fail under a policy.
- `scope: { grants: [{ resource: "fs:/repo/src/**", actions: ["read"] }] }` narrows a host-issued scope for the child; each grant must be covered by one parent grant (`/*` one level, `/**` any depth, `<ns>:*` all). Omitted inherits it. Refused in an unscoped session. Durable spawns and actors keep the scope; each actor is bound to its creating principal, and messages from a sender that does not cover it arrive marked untrusted. Programs never set a principal.
- Children read `PI_FABRIC_LINEAGE` (`{ version: 1, rootSessionId, parentSessionId?, parentRunId?, runId, depth, childIndex, worker: true }`, also `agents.self().lineage`) `PI_FABRIC_WRITE_POLICY`, and `PI_FABRIC_SCOPE`; other `PI_FABRIC_*` variables are internal except `PI_FABRIC_THINKING_BOUNDS`, `PI_FABRIC_DEPTH`, and `PI_FABRIC_AGENT_NAME`.
- Worktree path gotcha: the directory name is the agent id, not the target repo. Repo identity lives in the registered worktree list and branch tip. Never instruct an agent to verify its location by directory-name pattern; verify by repo (`git rev-parse --show-toplevel` + `git log -1 --format=%H` against the expected base, or `git remote get-url origin`).
- Preferred pattern for parallel implementers (deterministic, full branch control): pre-create the worktrees yourself in the target repo (`git worktree add -b <branch> <path> <base>`), pass each canonical path as `cwd`, leave `worktree` unset, and state the exact expected top-level in the task. Canonical-path gotcha on macOS: `git rev-parse --show-toplevel` reports `/private/tmp/...` for worktrees created under `/tmp/...` — assign and verify the canonical `/private` form or the agent's guard will correctly refuse.
- Give every autonomous coding agent a mandatory first command that verifies repo identity (exact canonical toplevel or remote URL) and a hard rule to abort with zero changes on mismatch. Guards cost one cheap round when wrong and prevent cross-repo contamination when right — four successive guards caught a wrong-repo worktree, a self-inflicted symlink mismatch, and a too-literal directory check at zero bytes of damage.
- Cleanup after cancelled/failed agent runs: check `agents.list({ scope: "project" })` and `agents.stop` any still-running handles first; worktree registrations live in the repo that OWNS the worktree (check `git worktree list` in every candidate repo; `.pi/fabric/worktrees/<id>` names the agent, not the repo), then `git worktree remove --force` + `git branch -D` + `git worktree prune` in each. Leave pre-existing non-agent worktrees alone; filter by the branch prefix your runs created (e.g. `pi-fabric/<name>`).
- `residency` is available on `agents.spawn` only: `"session"` (default) ties the run to the current Pi host; `"durable"` launches it on Fabric's hidden resident host so it can finish after Main exits. Durable handles still support `status`, `wait`, `log`, `stop`, and `cleanup` when the same root resumes. It requires a trusted project mesh and is unavailable in Schema enforce mode.
- Omit `timeoutMs` normally. It defaults to `agents.timeoutMs` (24 hours by default, the policy ceiling), and per-call values below that configured default are ignored. Set it only to request a longer run.

```ts
const result = await agents.run({
  name: "security-review",
  task: "Review the current diff for concrete security defects. Do not edit files.",
  tools: ["read", "grep", "find", "ls"],
});
return result;
```

```ts
const handle = await agents.spawn({ task: "Map the persistence layer.", transport: "tmux" });
// independent work here
return await agents.wait({ id: handle.id });
```

Detached `agents.spawn()` runs notify Main on terminal completion when `agents.notifyOnComplete` is enabled (the default). Unread results are batched after the current tool turn, or wake idle Main once; concise UI notices appear immediately. `agents.wait()`/`join()` and terminal `agents.status()` acknowledge the result and retract pending notifications, even if completion preceded the wait. Running status and UI/list polling do not acknowledge it. Return the relevant outcome from your program so Main sees results you consumed. Use `wait` when the program needs a result; do not poll status in a loop. Durable spawns preserve unread deliveries and acknowledgment across reconnects. Escape/error parks results until new input. Use lifecycle subscriptions for explicit event-routing policies, not to duplicate automatic completion delivery.

## Participant lifecycle subscriptions

Lifecycle subscriptions are durable, source-qualified mesh routes. They let Main, an actor, or an active agent react to another root/agent/actor without model-authored polling.

- `agents.subscribe({ from, events, to?, delivery, triggerTurn, once? })` creates a subscription. `from` is an exact participant id; `"main"` means the caller's lineage root. `to` defaults to that Main id.
- `agents.subscriptions({ from?, to? })` lists project subscriptions.
- `agents.unsubscribe({ id })` removes one.
- `delivery` is `steer` or `followUp`. State `triggerTurn: true | false` explicitly; it controls whether delivery to an idle Main starts a turn.
- `once: true` removes the subscription after its first successful matching delivery. Omitted keeps it active.
- Creation starts at the current mesh sequence, so old lifecycle events are not replayed. Delivery cursors persist across owner restarts. Delivery is at-least-once across a crash between message insertion and cursor persistence; use the lifecycle event `id` to deduplicate side effects.

Exact Pi events are `pi.input`, `pi.agent_start`, `pi.agent_end`, `pi.turn_end`, `pi.agent_settled`, `pi.tool_error`, and `pi.session_compact`. Runner-neutral terminal events are `run.completed`, `run.failed`, `run.stopped`, and `run.timed_out`. Pi events are observed from Pi's host/RPC lifecycle; run events also cover Claude-backed children and actor activations. Envelopes contain bounded operational metadata, source identity, timestamps, and a run id when applicable, never a transcript snapshot.

`pi.agent_settled` means Pi has no automatic retry, compaction retry, or queued continuation left at that boundary. It does not mean a persistent root or actor can never receive future work. Use a `run.*` event when terminal process/run status is what matters.

```ts
const peer = (await agents.peers())[0];
if (!peer) return { subscribed: false };
return agents.subscribe({
  from: peer.id,
  events: ["pi.agent_settled"],
  to: "main",
  delivery: "followUp",
  triggerTurn: true,
  once: true,
});
```

## Trajectory handoff

`agents.handoff({ model, task?, when?, ... })` schedules a blocking Pi-to-Pi trajectory handoff at the end of the current outer `fabric_exec`. Inside the guest it returns a deferred marker immediately, so calls after it still run. Once the complete program and all outer result middleware finish, Fabric forks the native assistant `fabric_exec` call plus its exact native `toolResult`, starts the explicit `provider/id` target in the same workspace, and waits before Main can infer again. Do not expect child output inside the same guest program; Main receives it as the final outer tool result.

`when` is guest-only and must be a pure synchronous predicate over immutable successful-call facts. It is deleted before the host validates the request:

```ts
await pi.edit({ path: "src/guard.ts", edits: [{ oldText, newText }] });
await agents.handoff({
  model: "anthropic/claude-haiku-4-5",
  task: "Continue from this completed Fabric invocation.",
  when: ({ count }) => count("pi.edit") >= 1,
});
await pi.bash({ command: "pnpm test guard" });
return "Frontier invocation complete";
```

Facts include every successful resolved bridge call completed before `agents.handoff()`, from `pi.*`, `extensions.*`, `mcp.*`, external providers, and generic `tools.call()`. Use `count()` for all calls, `count(ref)` for one, or `count([ref, ...])` for a set. Computed calls are recorded under their target ref rather than `fabric.$call`; failed calls do not count. A false or asynchronous predicate starts no child and errors clearly. Omit `when` for unconditional scheduling.

The guest result is `{ scheduled: true, status: "deferred", boundary: "fabric_exec_end" }`; the final outer tool result is `{ handedOff, completed, status, agent, implementation, error? }`. `model` is required and handoff is always Pi-backed. It also accepts `name`, `kernel`, `transport`, `thinking`, `tools`, `timeoutMs`, `extensions`, `recursive`, and `schema`; it deliberately omits `worktree` so implementation remains in the caller's workspace. Do not run handoff in a parallel branch that keeps mutating the same files.

After the executor settles, a visible `pi-fabric-handoff-complete` follow-up reports its identity, status, and bounded conclusion, then wakes Main. Summarize the outcome and reported checks, preserving concrete identifiers; do not redo completed work. If the handoff failed, stopped, or timed out, explain the outcome and propose the next step without retrying or taking over unprompted. This is a queued follow-up, not steering.

Exception for an already-running trajectory executor: a failed nested handoff can queue one hidden `pi-fabric-handoff-continuation` per executor run. On that message, finish your original assignment directly in the same workspace, preserve completed work, and verify the remainder rather than returning only the failed-handoff report. Do not retry delegation, spawn a replacement, or raise limits. Fabric cancels the local Prewalk arm, keeps the boundary marked failed, and preserves the run's deadline and token accounting. Explicit stops, cancellation, timeouts, and token-limit termination never trigger this fallback. If genuinely blocked, report the blocker honestly. Main still reports terminal failures instead of taking over unprompted.

## Automatic prewalk

`prewalk.plan` is only an executor handoff checkpoint when Fabric's armed advisory or checkpoint explicitly requests one. It is not a task planner, checklist, or acceptance-ledger store. Keep ordinary acceptance checks in reasoning or concise progress notes (no tool call). Discovery exposes the action only while this session owes a plan; once recorded, it disappears until another plan is required. Do not probe `prewalk.status` as a routine planning prerequisite; it is for diagnostics.

`/fabric prewalk [task]` arms one automatic continuation when a Fabric invocation contains a successful `pi.edit`, `pi.write`, or `schema.commit`. With a task it submits immediately; without one it captures the next user input. The executor comes from `prewalk.model` or an interactive choice, and its reasoning effort from `prewalk.thinking` (inheriting `agents.thinking` when unset). `prewalk.alwaysRearm` keeps the controller armed until `/fabric prewalk --off`. That command cancels only the session arm; `/fabric prewalk --disable` persists the master switch and survives restarts, while `--enable` restores it.

The default `prewalk.mode: "in-place"` switches Main to the executor model at the finalized outer boundary and sends one hidden continuation as a passive context message. It carries the captured task text, the recorded plan, and — for foreign reasoning channels — a bounded advisory thinking digest. It does not spawn or wait for a child. The outer tool does not terminate: the same run continues on the executor model. The request-context hook supplies the canonical continuation exactly once even when competing user steers arrive before the persisted message; no extra completion-only turn is queued. After that continuation settles — or if a new session still has the executor selected, or prewalk is cancelled — Fabric restores the Main model captured at the switch. A failed return drops the arm instead of re-arming, preserves the captured Main model for a later session start or `/fabric reload`, and skips auto-arm while Main is still on the executor; explicit arming overrides. This mode requires full code mode but not enabled agents. `prewalk.requirePlan` (default on) gates the boundary on a recorded plan: an armed task owes `prewalk.plan({ outcome, steps, verification, risks })` inside `fabric_exec`, and a mutation boundary reached without one is withheld while Fabric delivers a hidden plan checkpoint. Main keeps working on the frontier model, and the handoff fires at the next successful mutation with the plan delivered in the executor's continuation or task — even when the `prewalk.plan` action result is discarded or the outer output is truncated. Fabric asks at most twice per task, then hands off unplanned with a visible warning. A plan is dropped when the task changes, cancelling or reloading resets readiness, and explicit `agents.handoff()` is never gated.

Set `prewalk.mode: "trajectory"` to fork the finalized call/result into a Pi child and wait. A hidden follow-up then has Main verify the child's work and summarize, so it never settles idle by design. The parent activity card shows the handoff call, child, progress/current tool, nested tools, metrics, and result. Trajectory mode requires enabled agents. Both modes let all nested calls settle before the boundary, drop the settled turn's captured task while keeping the arm armed when no handoff claimed it, defer to explicit `agents.handoff()`, and are disabled by Schema enforce mode. Use `/fabric prewalk --status` or `/fabric prewalk --off`.

Use `/fabric agents` to list children and `/fabric attach <id>` for the attach command. Abort signals propagate to the transport and selected child process. Claude runs use official `claude -p` stream JSON with `dontAsk`, `--tools`, and `--allowedTools`; `extensions: false` adds Claude safe mode. One-shot Claude sessions use `--no-session-persistence`. Claude cannot use `recursive: true`, `fabric_exec`, or direct mesh APIs.

## Unified participants and steering

Every live root, one-shot/recursive agent, and persistent actor is represented in one project participant directory. Participant kinds are intrinsic (`"root"`, `"agent"`, or `"actor"`); **Main** and **Peer** are UI/API views of root participants, not separate identity classes. **Peer is a reserved Fabric term for another root Pi session.** A request to inspect, wait for, or coordinate with a “peer” means call `agents.peers()` first; `agents.list()` lists child agents and cannot establish whether a peer root has settled. Execution remains local to an `ownerHostId` and authenticated `ownerIdentityId`, while `rootId` and optional `parentId` describe lineage. Host leases remove a crashed host and all participants it owns from live discovery together. Shared records deliberately omit agent prompts, results, and errors; full detail stays local.

- `agents.self()` returns the caller's `FabricParticipantInfo`.
- `agents.members({ scope?, kinds?, includeStale? })` returns the unified directory. `scope` is `"local"`, `"lineage"`, or `"project"` (default); `kinds` filters intrinsic kinds. Normal discovery excludes stale hosts.
- `agents.sessions()` returns every live root Pi session, including the caller's root and peers, as symmetric `FabricParticipantInfo` records. This is the primitive for session-to-session awaiting and DAG coordination.
- `agents.main()` remains the compatibility view of the caller's root as `{ id, name: "Main", kind: "main", ... }`; the stable alias `"main"` resolves to that exact root id.
- `agents.switchModel({ model, provider? })` switches Main's live Pi session model in place and keeps it. The selector resolves a `models.aliases` name (string target or first-available fallback chain), then an exact `provider/id`, an exact bare id, then the closest fuzzy match across provider, id, and display name (pi-model-sort recency breaks ties); unknown selectors throw instead of switching. The result carries `{ switched, model, previous?, via? }`, where `via` is the alias name or `closest`/`recent`/`latest`, or `{ switched: false, reason: "already-active" }` for the active model. List candidates with `tools.models()` (Pi runner entries).
- `agents.peers()` remains the compatibility view of other live roots as `Peer <session-prefix>`. It is derived from `agents.members`, not maintained by a second registry.
- A `<fabric-peers>` message in the transcript is a host notice, not a user request: it lists the other root sessions sharing this project's files by label and participant id, and is sent only when that set changes. Treat file or git changes you did not make as possibly theirs, and pass a listed id to `agents.steer` to coordinate.
- `agents.status({ id })` accepts any known participant id. Local runs/actors return full local detail; remote participants return their bounded directory summary.
- `agents.steer({ id, message, data? })` and `agents.followUp(...)` target Main, a live one-shot child, or an actor without discarding context.
- `agents.stop({ id })` can stop a local or remotely owned agent/actor when its participant advertises `"stop"`. It returns the local agent result, local actor info, or an acknowledged remote control result according to the target.
- Provider-registered work appears as `kind: "provider"` members with ids `provider:<provider>:<id>`. `agents.stop`, `agents.steer`, and `agents.followUp` accept those ids and call the provider; stop returns `{ ref, outcome: "confirmed" | "unconfirmed", detail? }`. Cancelling or timing out a program stops the non-detached provider work it started.
- `agents.setSteeringMode({ id, mode })` / `agents.setFollowUpMode({ id, mode })` remain local one-shot controls.

Local delivery returns `routed: "main" | "local"`. Cross-process delivery resolves the participant's exact owner host and identity, publishes an owner-addressed control command, and accepts only a version/target/identity-matched acknowledgement. Success returns `{ queued, messageId, routed: "mesh", acknowledged: true }`; an unknown id, stale owner, owner rejection, or acknowledgement timeout throws instead of reporting an unverified queue. If the owner restarted, an unexecuted command fails with "targets a previous owner incarnation"; Fabric does not retry, so re-read the participant and resend only if still wanted. This path requires `mesh.enabled`. Ordinary non-recursive Pi children can receive host-routed messages and use Fabric in inherited full-code mode, but do not receive recursive runs’ delegated `agent` risk. Claude children/actors remain host-routed and do not run Fabric themselves.

```ts
const main = await agents.main();
const project = await agents.members({ scope: "project" });
const peerRoot = project.find((participant) => participant.kind === "root" && participant.id !== main.id);
if (peerRoot) await agents.steer({ id: peerRoot.id, message: "Coordinate on the shared migration." });
await agents.followUp({ id: main.id, message: "After the audit, reconcile the worker findings." });
const handle = await agents.spawn({ task: "Audit auth flows.", tools: ["read", "grep", "find", "ls"] });
// Watch progress, then redirect between turns without losing the child's context.
const s = await agents.status({ id: handle.id });
if (s.text.includes("rotating refresh tokens")) {
  await agents.steer({ id: handle.id, message: "Skip refresh-token rotation; focus on session expiry only." });
  await agents.setSteeringMode({ id: handle.id, mode: "all" });
}
return await agents.wait({ id: handle.id });
```

Prefer `agents.steer` over `agents.stop` + `agents.spawn` when the child has useful context you would otherwise discard. Use `agents.stop` only when the child is genuinely off-track and a fresh task is cheaper than a redirect. Steering a finished agent throws; check `agents.status` or the participant capabilities first. When the user asks Main to correct a running child, use `agents.steer` directly; do not require the user to open a dashboard. The user can also press ctrl+shift+a or run `/fabric chat <id-or-name>` to open a focused conversation with direct steering, follow-ups, and parent/child navigation while Main keeps running. Completed one-shot runs are read-only; actors remain messageable through their mailbox. In the dashboard, `s`, `u`, and `x` use the same ownership-aware path for local and remote participants, and Shift+C opens their focused conversation.

## Persistent actors

`agents.create(args)` returns `FabricActorInfo`. An actor has a fixed `runner`, a serial mailbox, and optional subscriptions to parent events or durable mesh topics. It processes messages one at a time, coalesces repeated host events by default, and restores with the project actor registry. Pi actors resume their Fabric-owned Pi session file. Claude actors persist the session ID emitted by `claude -p` and launch later activations with `--resume <id>` while keeping a Fabric-owned stream transcript.

`args` is a `FabricActorRequest`. `delivery` defaults to `mailbox`. `steer` and `followUp` require `triggerTurn: true | false`; `mailbox` and `nextTurn` reject `triggerTurn: true`.

With project actor scope, all trusted sessions read one definition, mailbox, and history. Each Pi session has its own model and thinking binding. One authenticated owner runs the actor and processes host events once. Fabric stores the resolved values on each mailbox item before it queues:

```text
call override → session binding → project default → Fabric or runner default
```

- `kernel` accepts the same language choices as one-shot requests and freezes at creation, together with the configured Python backend. `ask`/`tell` do not accept language or backend overrides; recreate an actor to switch. Global templates preserve omitted/`inherit` until import; explicit template kernels stay explicit.
- `runner` is fixed at creation. Omitted uses `agents.runner`. Pi actors are recursively Fabric-equipped; Claude actors retain Claude context and use Claude Code tools, while mailbox/event delivery and coordination remain host-managed (no `fabric_exec` or direct `mesh.*` inside Claude).
- `residency` is `session` by default. Set `residency: "durable"` to transfer execution to Fabric's hidden resident host. Project sessions can still call `ask`, `tell`, `steer`, `followUp`, and `stop`, and can read the shared definition, mailbox, and logs. Shared runtime settings stay owner-only. Fabric routes durable actor removal to the resident owner. Durable residency requires a trusted project mesh and is unavailable in Schema enforce mode.
- `model` follows the selected runner's key format. At creation it is the project default. `agents.setModel({ id, model? })` changes this session binding by default; add `scope: "project"` for an owner-gated shared pin. `ask`/`tell` also accept `model` for one activation.
- `thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. It uses the same call/session/project layering as `model`, then inherits `agents.thinking` (default `medium`). Use `agents.setThinking({ id, thinking?, scope? })`; omitting the value clears the selected layer.
- `events` may contain any session-bound public Pi extension event: `resources_discover`; `session_start`, `session_info_changed`, `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_compact`, `session_shutdown`, `session_before_tree`, `session_tree`; `input`, `before_agent_start`; `agent_start`, `agent_end`, `agent_settled`; `turn_start`, `turn_end`; `message_start`, `message_update`, `message_end`; `context`, `before_provider_headers`, `before_provider_request`, `after_provider_response`; `tool_execution_start`, `tool_call`, `tool_execution_update`, `tool_result`, `tool_execution_end`; `model_select`, `thinking_level_select`, and `user_bash`. Fabric also provides synthetic `tool_error`. `project_trust` is unavailable because it precedes trusted actor-registry initialization. These are asynchronous observations and cannot mutate or block the originating Pi hook.
- Host events automatically forward every Pi `ImageContent` block to the actor's selected model. The JSON envelope and persisted mailbox contain only redacted indexed descriptors; raw base64 travels through the transient worker prompt and may then follow the selected runner's ordinary persistent-session semantics. No media flag is required. Credential-shaped fields and unrelated encoded blobs are redacted before persistence.
- `topics` lists durable mesh topics to subscribe to (see `mesh.md`).
- `responseMode` is `text` (every non-empty response becomes an outbox message) or `directive` (validated `{ action, message?, data? }` where `action` is `silent`, `message`, or `stop`; the actor decides whether to intervene).
- `delivery` is `mailbox`, `steer`, `followUp`, or `nextTurn`. An actor cannot escalate it in a response; the owner can replace it with `agents.setDeliveryPolicy({ id, delivery, triggerTurn, scope? })`.
- `triggerTurn` is mandatory for `steer`/`followUp`: `true` starts Main when idle; `false` is passive and the delivered message visibly says it will not start Main. `mailbox`/`nextTurn` never start Main. `coalesce` is on by default.
- `validWhile` is an optional pure synchronous predicate checked before an activation runs and again before its result is delivered. It receives immutable `{ activation, current }` facts. Return `false` or `{ valid: false, reason? }` to record the activation as stale and suppress delivery; an invalidated blocking `agents.ask()` rejects. The predicate source persists with project actors and global templates, so it cannot use closures, tools, promises, or host APIs.
- `timeoutMs` follows the same floor as one-shot agents: omit it normally and set it only above `agents.timeoutMs` when an activation needs longer.
- `tools` is the actor's persisted allowlist and defaults to `agents.defaultTools`. Replace it for future activations with `agents.setTools({ id, tools })`; an empty list disables optional tools. Pi actors retain the host-required `fabric_exec` tool unless created with `extensions: false`. Use `scope: "global"` to update a reusable template instead.
- `extensions` is `true` by default (a Pi actor is recursively Fabric-equipped with the host-required `fabric_exec` tool). Set `extensions: false` to disable Fabric for a Pi actor: the activation runs with `extensions: false` and `recursive: false`, so `fabric_exec` is not injected and the actor cannot call `agents.*` or `mesh.*`; the host still manages its mailbox and delivery (same coordination model as a Claude actor). This does not restrict ordinary tools: also use `tools: ["read", "grep", "find", "ls"]` for a read-only actor or `tools: []` for no tools. Fixed at creation.

```ts
return agents.create({
  name: "auth-supervisor",
  instructions: "Watch the main session until the auth migration is complete and tested. Prefer silence; reply with a directive only for material drift, a blocker, or verified completion.",
  events: ["agent_settled", "tool_error"],
  validWhile: ({ activation, current }) => {
    if (activation.kind !== "hostEvent") return true;
    if (activation.sequence !== current.latestActivationSequence) return false;
    return activation.event !== "tool_error" || activation.mainRevision === current.mainRevision;
  },
  responseMode: "directive",
  delivery: "steer",
  triggerTurn: true,
  tools: ["read", "grep", "find", "ls"],
});
```

For a native asynchronous vision handoff, create one actor with an explicit multimodal `model`, `events: ["input"]`, `responseMode: "directive"`, passive `delivery: "steer"`, `triggerTurn: false`, `coalesce: false`, `validWhile: ({ activation }) => activation.kind !== "hostEvent" || (activation.signal?.media?.length ?? 0) > 0`, `tools: []`, and usually `extensions: false`. Instruct it to return `silent` when no image is attached and otherwise return only a compact visual description for Main. Fabric attaches prompt images automatically; do not add base64 to the task or mailbox data. The actor does not block Main's current inference.

Mailbox:

- `agents.ask({ id, message, data?, model?, thinking? })` waits for a `FabricActorMessage` from the live owner. Its deadline follows the actor timeout. Caller cancellation aborts work on that owner. Large text and structured data share the mesh event budget; truncated data carries `fabricTruncated: true`.
- `agents.tell({ id, message, data?, model?, thinking? })` returns `{ queued, messageId }`. Optional binding values affect only that mailbox item.
- `agents.actorStatus({ id })` and `agents.actors()` return the shared project actor view. `model`/`thinking` are effective for this caller; `binding` and `projectDefaults` expose the two persisted layers.
- `agents.setModel({ id, model?, scope? })` and `agents.setThinking({ id, thinking?, scope? })` default to `scope: "session"`. Use `scope: "project"` only to pin a shared default.
- `agents.setTools({ id, tools, scope? })` replaces the persisted tool allowlist for a project actor (default) or global template.
- `agents.setDeliveryPolicy({ id, delivery, triggerTurn, scope? })` replaces the explicit project/global continuation policy without recreating the actor. In the dashboard, press `y` on an actor/template for the same control.
- `agents.messages({ id, limit? })` returns the actor mailbox history. Create the actor with `scope: "session"` when its history must be private to one root Pi session.
- `agents.remove({ id })` returns `{ removed }`. Session actors require the local owner. Durable actor removal routes to the resident owner.
- `agents.import({ id?, name?, as? })` stamps a global template into the current project as a fresh live actor with no inherited history (no messages, session, or run logs). Identify the template by `id` or `name`; `as` renames the imported actor so it cannot collide with a live one. From the TUI: `/fabric import`.
- `agents.export({ id, overwrite? })` writes a live project actor's definition to the global registry as a project-independent template, again without history. A name collision throws unless `overwrite` is `true`.
- `agents.log({ id, type?, lines?, runId? })` reads the shared actor log or a locally owned one-shot run. `type` is `session` (the actor's `session.jsonl` transcript — every user/assistant turn and tool call), `run` (the last retained run's `events.jsonl` event stream), or `all` (both; default `session` for actors). Actors retain their last `MAX_RETAINED_RUNS` runs so logs survive after success. Returns `{ actorId, actorName, sessionFile, logDir, session, run?, retainedRuns }` (actors) or `{ id, runDirectory, logFile, status?, events }` (one-shot runs). Use this to inspect what an "offending" actor actually sent to its model. From the TUI: `/fabric log <id>` previews, `/fabric export-log <id> [path]` writes the raw `session.jsonl` + retained `runs/` to disk.

## Recursive queries

`rlm.query(args)` is a budget-aware `agents.run({ ...args, runner: "pi", recursive: true })` with Fabric enabled in the child. Claude runners are deliberately rejected for recursion. Its usage counts toward `budget.spent()` and the `tokenBudget` guard. Recursion is rejected at `agents.maxDepth`; the setting accepts any non-negative safe integer, and `0` disables child spawning. Approving the initial recursive call delegates only the `agent` risk capability to recursive children; network, execution, and write approvals are not inherited. Each Fabric process enforces its own concurrency and timeout limits.

```ts
return rlm.query({ task: "Decompose this repository and produce a compact architecture map.", transport: "process" });
```

`council.run({ task, roles, synthesize?, ...agentOptions })` runs several `agents.run` calls concurrently under the agent semaphore and optionally synthesizes them. The full council pattern is user-invoked; never load `/skill:fabric-council` autonomously.
