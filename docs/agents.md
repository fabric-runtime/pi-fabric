# Agents, actors & mesh

Fabric exposes its multi-agent runtime through the model-facing APIs in [`skillsets/typescript/fabric-exec/references/agents.md`](../skillsets/typescript/fabric-exec/references/agents.md) and [`mesh.md`](../skillsets/typescript/fabric-exec/references/mesh.md). Reusable patterns are in the [skills](../skillsets/typescript/): `fabric-workflow`, `fabric-swarm`, `fabric-council`, `fabric-rlm`, `fabric-supervisor`, `fabric-advisor`, and `fabric-fusion`. For the `agents` and `mesh` settings, see [configuration](configuration.md).

Python uses the same public skill names from the [Python tree](../skillsets/python/), with native `agents.run` and `asyncio.gather` programs and its own [agent reference](../skillsets/python/fabric-exec/references/agents.md). The helper examples below are TypeScript-only.

## Workflows

Fabric programs keep orchestration and intermediate values in code. The workflow globals provide Claude Code-style names and progress phases without adding another JavaScript runtime.

Use these helpers:

- Use `workflow.agent(prompt, options)` or `agent(...)` to start one worker. Set `label` on each call.
- Use `workflow.parallel(thunks, { concurrency })` or `parallel(...)` for fan-out. Supply functions to these APIs.
- Use `workflow.pipeline(items, ...stages)` or `pipeline(...)` to run sequential stages for each item with concurrency across items.
- Use `workflow.configure({ name, description })` to name the activity surface.
- Use `workflow.phase(name, { id?, description?, total? })` or `phase(...)` to define progress groups.
- Use `workflow.item(...)` for non-agent work items that change status over time. An optional stable `id` (1–128 characters of `[A-Za-z0-9._:/-]`) keeps one item across updates; without one, each call creates `item-<n>` in invocation order. An optional `meta` plain JSON object (at most 2 KiB serialized) rides only on the host [`pi-fabric:workflow-item:v1`](providers.md#workflow-item-events) event. Invalid ids, statuses, or meta fail the call.
- Use `workflow.event(...)` to record important milestones in the dashboard feed.
- Use `workflow.log(...)` to add short progress notes.
- Read `workflow.budget` for token-budget observations.

You can give `fabric_exec` optional `agentBudget` and `tokenBudget` limits. Configuration sets a hard agent limit for each execution. Add a JSON Schema to an agent request to make the worker return validated structured data in `result.value`. Workflow helpers return this value directly. Without a schema value, they return the agent's final text. See [`/skill:fabric-workflow`](../skillsets/typescript/fabric-workflow/SKILL.md) for the complete pattern.

## Agents

`agents.wait({id})` waits for a spawned agent; `agents.join({id})` is an alias with identical arguments, result, progress, and notification behavior. Use `wait` as the canonical spelling. The hosted `AgentService` and `AgentServiceClient` expose both methods too. [Jev programs](jev.md) follow the same `wait`/`join` naming.

### Background completion inbox

`agents.spawn` returns immediately; independent work can continue without polling. With `agents.notifyOnComplete` enabled (the default), a concise UI notice appears when a detached run finishes. Full outcomes remain in agent activity and logs. Unread results are batched into Main's context after the current assistant turn's entire tool batch, without waiting for its final answer. If Main is idle, unread results wake it once.

`agents.wait`/`join`, terminal `agents.status`, and cleanup acknowledge the result and retract any pending notification, including completion that arrived before the wait. Running status and UI/list polling do not acknowledge results. Acknowledgment means the Fabric program received the result: return the relevant outcome to Main when it needs to reason about it. Prefer `wait` over a polling loop.

Durable spawns use the same inbox. Undelivered envelopes survive disconnects; receipts survive reconnects. Escape or an errored Main turn parks pending results until new input; Main does not restart immediately. Explicit lifecycle subscriptions, actor messages, and trajectory handoffs retain their separate delivery policies. A terminal run can still report incomplete work; Main must inspect its result.

### Stalled Pi error recovery

After a failed or aborted assistant response (including `Error: Terminated`), Fabric allows Pi's own retries to recover. If no recovery output arrives for 60 seconds, the worker fails the run with the original error and terminates the child, escalating from SIGTERM to SIGKILL after another 5 seconds. Repeated retry announcements, errors, or lifecycle events do not extend this deadline. Nonempty text/thinking/tool-call deltas refresh it; a successful assistant response clears it. Healthy inference and tool execution are not subject to this recovery timer, and the overall run deadline still applies.

Fabric handles exhausted retries explicitly without waiting forever on an earlier `willRetry` flag. Child shutdown after RPC stdin closes is also bounded: 5 seconds for graceful exit, then SIGTERM and a further 5 seconds before SIGKILL. These failures settle `agents.wait`/`join` and notify detached callers normally; they do not automatically replay potentially side-effecting work. Already-running workers must be stopped and respawned to use the fix.

### Image-heavy lifecycle events

Pi repeats message history in `agent_end.messages` and tool results in `turn_end.toolResults`. Fabric streams past these redundant top-level fields, recording empty arrays in the worker event log. Large accumulated histories therefore do not trip the event-size guard or interrupt completion/retries. Authoritative message/tool events, final text, usage, and Pi's persisted session history are unchanged.

The 4,194,304-character guard still applies to other event data, including a single oversized authoritative message. It is not a model token limit. Already-running workers keep their loaded implementation; newly launched workers use the rebuilt/updated package.

### Reuse discovered model keys

Use `agents.models({ runner: "pi" })` and copy the returned `key` verbatim, or use an explicitly configured `models.aliases` name. Reuse the `model` returned by a successful spawn. Do not reconstruct it from an agent's display name. For example, an agent named “Sol” need not share the version number of one named “Astra”. Prior success with one key does not validate a different key.

`provider/model` selectors prefer an exact visible match. A near-miss ID resolves to the closest available model on the **same provider**, using Fabric's existing similarity ranking; ties prefer recent usage, then canonical key order. For example, `openai-codex/gpt-6-sol` resolves to `openai-codex/gpt-5.6-sol` when that is the closest visible model. The returned handle's `model` and the worker's `requestedModel` contain the canonical selection. Unknown providers and names without sufficient resemblance still fail before launch. Model IDs containing `/` stay provider-scoped. Configured aliases keep their ordered, exact-target fallback chains.

For independent launches, await `Promise.allSettled` and inspect every result. An uncaught `Promise.all` rejection ends the Fabric program and can abort sibling calls still in flight; it does not prove every requested model was unavailable. Already completed calls are not rolled back, so retain successful handles and retry only failed launches.

```ts
const results = await Promise.allSettled(requests.map(request => agents.spawn(request)));
return results.map(result => result.status === "fulfilled"
  ? { ok: true, handle: result.value }
  : { ok: false, error: String(result.reason) });
```

### Requested models are authoritative

For Pi workers, Fabric reapplies the resolved `provider/model` over RPC **after startup extensions finish**, reapplies the requested thinking level, and independently reads `get_state` before sending the task. A successful `set_model` response alone is insufficient: it can echo the requested model even when an extension switches away during `model_select`. Thinking is reported at Pi's effective, capability-clamped level.

With `thinking.bounds` configured, Fabric clamps each run's level into the bounds before launch and reports the original as `requestedThinking`. `agents.run` and `agents.spawn` also accept `thinkingBounds: {min?, max?}` inside the caller's bounds; children inherit the effective bounds and never widen them. See [thinking control](thinking.md#child-runs).

Startup waits for a correlated RPC readiness response. Startup, model admission, and task execution share the run's configured `timeoutMs`; there is no separate 15-second admission cap. RPC readiness does not guarantee a fast `set_model`: authentication checks and async `model_select` hooks can still wait on provider initialization or shared resources during concurrent launches. A slow handshake may use the remaining run budget, but it never resets or extends the overall deadline.

Selectors with no available match, rejected/malformed RPC responses, or a remaining model mismatch fail the run without sending its task. A startup or admission stall exhausts the overall deadline with `timed_out`, also without sending the task. Queued controls wait for admission too. After parent-side selector resolution, the worker must use that canonical model: it does not substitute an MRU model or fall back during admission. Standalone `AgentManager` callers can also supply a unique exact bare model ID; ambiguous IDs must be provider-qualified.

`requestedModel` preserves launch intent in run records; `model` follows verified child state and actual assistant attribution. The manager and participant UI preserve that observed value; the launch label cannot overwrite it. If assistant attribution drifts after admission, Fabric terminates the child and reports both requested and observed models in the failure. This verifies Pi's local provider/model identity, not a remote provider's internal routing.

Existing workers are not retroactively changed by rebuilding or reloading the parent. Stop and respawn affected workers to apply model admission.

Pi workers with extensions enabled also inherit the parent session's `pi-multiprovider` `/switch-account` pin, when that extension is installed. Fabric forwards the pin as `PI_MULTIPROVIDER_SESSION_PINS`; the child rebinds it to its own session id. This is host state, not a model argument. Claude and Veda runners, and `extensions: false` children, do not receive it.

### Choose the child's language

`agents.run`, `agents.spawn`, `agents.create`, and `agents.handoff` accept `kernel: "typescript" | "python" | "inherit"`. Omit it or use `"inherit"` to inherit the caller's `executor.kernel`; use a concrete value so a skill or model can choose its strongest language for the task. Workflow agents, `rlm.query`, and council members/synthesis forward the same option. This selects the **child's** Fabric language, not the language of the current `fabric_exec` program; that program still uses its configured kernel.

TypeScript caller example:

```ts
return agents.run({
  task: "Analyze the dataset and report a compact result.",
  runner: "pi-durable",
  kernel: "python",
});
```

Python caller example:

```python
return await agents.run({
    "task": "Inspect TypeScript API compatibility and report concrete findings.",
    "runner": "pi-durable",
    "kernel": "typescript",
})
```

Concrete kernels require a Pi runner (`pi-durable` or `pi`) with Fabric extensions enabled. Claude, Veda, and `extensions: false` reject concrete choices before launch; omitted/`inherit` keeps those runners native and their status has no Fabric kernel. Invalid kernel values reject without guessing. A supported run's handle, result, and status record expose the resolved `kernel`, never `inherit`. Explicit kernels and inherited Python load the Fabric extension/tool even when the parent is outside full-code mode.

Language and configured Python backend policy (`executor.pythonRuntime`, default `monty`) are frozen before launch and forwarded to workers, recursive children, alternate-cwd children, and resident handoffs. There is no public per-request backend selector. Monty is the sandboxed default and fails closed if its optional dependency is unavailable; it never falls back to CPython. CPython is an explicitly configured native escape hatch, trusted outside schema enforce; selecting Python does not promise the same isolation or library support across backends. See [execution kernels](kernels.md).

Persistent actors freeze their language and Python backend when created. `ask`/`tell` cannot switch either; recreate the actor for a different language. Do not mix languages in one persistent session. Global templates preserve omitted/`inherit` kernel selection until import into a new actor; an explicit template kernel stays explicit. A trajectory handoff freezes the caller choice when scheduled and keeps the original session history unchanged.

```ts
const result = await agents.run({
  name: "security-review",
  task: "Review the current diff for concrete security defects. Do not edit files.",
  transport: "localterm",
  tools: ["read", "grep", "find", "ls"],
});
return result;
```

Create background handles explicitly:

```ts
const handle = await agents.spawn({
  task: "Map the persistence layer and identify its public entry points.",
  transport: "tmux",
});

// Continue with independent work here.

return await agents.wait({ id: handle.id });
```

Set `cwd` on `agents.run()` or `agents.spawn()` to choose a leaf or recursive Pi child's filesystem execution directory, including another repository or a non-Git directory. Absolute paths are accepted; relative paths resolve from the parent Fabric manager's cwd. Fabric canonicalizes the directory (including symlinks) before launch, and reports that effective path in the handle, status, participant snapshot, result, and log status. Invalid, missing, inaccessible, or non-directory paths fail without falling back to the parent. Workflow helpers, `council.run()`, and `rlm.query()` forward `cwd` and `worktree`. Persistent actor definitions and trajectory handoff still do not accept `cwd`. Omission inherits the immediate caller’s cwd; descendants resolve relative paths from that effective directory, not the original project root. Project/mesh lineage, recursion depth/budget, and the caller’s resolved kernel/backend remain unchanged.

For Pi children, selecting `cwd` neither grants nor requires project trust. Fabric adds no trust gate and passes neither `--approve` nor `--no-approve`; Pi loads `AGENTS.override.md`, `AGENTS.md`, and `CLAUDE.md` under its normal context rules, while protected project resources remain governed by Pi's saved decisions and `defaultProjectTrust`. Each runner keeps its native startup behavior. A generated worktree is evaluated at its own canonical path.

Extension-enabled Pi children inherit the parent’s full-code mode, including ordinary non-recursive leaves. They retain `fabric_exec` as the outer tool, and their optional `tools` allowlist also constrains nested Pi and captured-tool calls. `extensions: false` explicitly opts out; Claude/Veda and parents outside full-code mode keep their existing tool surfaces. Recursive children additionally receive only the delegated `agent` risk. An inherited optional-tool allowlist is intersected with requested/default descendant tools before launch (including durable transfer); malformed inherited allowlists fail closed. Selecting another cwd cannot restore filtered tools. This is not filesystem isolation: enabled tools, trusted extensions, and native execution retain their normal host privileges. A launch-policy change requires `/reload` and newly launched children; it does not hot-swap an already running worker’s tools.

### Durable participant residency

`agents.spawn()` and `agents.create()` accept `residency: "session" | "durable"`. The default is `session`. It keeps the usual lifecycle: the current Pi host owns the participant and stops or suspends it when the host shuts down. The model chooses `durable` during execution. Users do not configure it as a setting.

```ts
const audit = await agents.spawn({
  name: "integration-audit",
  task: "Run the integration audit and report concrete failures.",
  residency: "durable",
  tools: ["read", "grep", "find", "ls", "bash"],
});

const supervisor = await agents.create({
  name: "migration-supervisor",
  residency: "durable",
  instructions: "Process migration messages until verification succeeds.",
  topics: ["team.migration"],
  delivery: "followUp",
  triggerTurn: true,
});

await agents.tell({ id: supervisor.id, message: "Own the remaining migration." });
return { audit, supervisor };
```

The first durable request starts one hidden resident host for the current root when needed. Fabric transfers actor ownership to this host or starts the one-shot run there. It publishes the owner in the standard participant directory. Fabric routes `steer`, `followUp`, `tell`, blocking `ask`, and `stop` through the acknowledged mesh control plane. The process uses the captured agent, mesh, timeout, recursion, and cost-ceiling configuration. It also uses the runner, model, and tool capabilities that the originating call explicitly authorized. Users do not configure a daemon profile or workflow policy.

The original TUI can shut down after the transfer. Durable agents continue until they reach a terminal status. A resumed copy of the same root can call `agents.status`, `agents.wait`, `agents.log`, and `agents.cleanup`. The mesh stores terminal notifications and active actor deliveries until Main resumes. Durable actors keep their registry definition, mailbox history, runner session, mesh subscriptions, and replay cursor. Main relays session-bound host events while it is available. The cross-process relay can omit oversized raw image blocks. The relay keeps their redacted media descriptors.

A durable actor has one resident execution owner. Other trusted sessions in the project can call `ask`, `tell`, `steer`, `followUp`, and `stop`; Fabric routes each call to that owner. Direct messages carry the caller's model and thinking binding. Actor status, mailbox history, logs, and definition export are shared project views. Only the owner can clear the mailbox or change tools, events, instructions, delivery policy, and project defaults. Fabric sends durable actor removal to the resident owner. The hidden host exits after a short idle grace when it owns no live durable actor or running durable agent. Durable residency requires a trusted project and `mesh.enabled`. Schema enforce mode does not support it.

Recursive cwd also works with durable `agents.spawn()`: the caller resolves explicit relative cwd before ownership transfer, and persisted handles retain effective cwd, kernel, and recursion metadata for later status/log reads. Startup retries reuse the original launch (including effective worktree cwd and capability flags); they do not resolve the target again. Resident-host recovery does not replay an interrupted spawn: its outcome is reported as indeterminate to avoid duplicate execution. This is not migration of a running session to a new cwd; existing workers must finish or be replaced by a new launch.

### Trajectory-preserving handoff

A handoff delegates work from Pi to Pi through a real fork of the caller's active session branch. It blocks while the delegated work runs. The worker receives more than a task string. One complete `fabric_exec` invocation forms the atomic frontier unit. An explicit `agents.handoff()` call records a deferred request in the guest. It does not create a child or stop the program at that line. Later sequential and parallel calls continue as usual.

Pi finalizes the native outer `fabric_exec` tool result after the complete Fabric program returns. At the `message_end` boundary, Fabric forks through the original assistant entry that contains the native `fabric_exec` call. It appends the exact finalized native `toolResult` to the child branch. Fabric then starts the selected executor in the same workspace and waits before Pi performs another Main inference. The child sees the outer call and frontier result exactly as finalized before handoff replacement. This context includes the Fabric source, output, and persisted trace. Fabric does not rewrite nested calls as synthetic assistant turns. It materializes an in-memory source in the same native Pi session format.

Fabric sets no special count or size limit for handoffs. The normal `fabric_exec` output and trace projection limits apply before the boundary. Handoff fails closed when Fabric cannot identify the active outer turn or when that turn belongs to an incomplete parallel top-level tool batch.

```ts
await pi.edit({ path: "src/guard.ts", edits: [{ oldText, newText }] });
await agents.handoff({
  model: "anthropic/claude-haiku-4-5",
  task: "Continue from this completed Fabric invocation.",
  when: ({ count }) => count("pi.edit") >= 1,
});
await pi.bash({ command: "pnpm test guard" });
return "Frontier Fabric invocation completed";
```

`when` is an optional pure synchronous predicate that runs inside the Fabric guest. It receives immutable `{ calls, count(ref?) }` facts for each successful resolved bridge call that finished earlier in the same `fabric_exec` program. These calls include `pi.*`, `extensions.*`, `mcp.*`, external providers, and computed `tools.call()` refs. `count()` counts all calls. `count("pi.edit")` counts one ref. `count(["pi.edit", "schema.commit"])` counts a set. Fabric records each generic call under its resolved target. Fabric excludes failed calls. A false predicate does not start a child and reports a clear failure. The function never crosses the host bridge. Omit `when` to schedule unconditionally.

In the guest, `agents.handoff()` resolves to `{ scheduled: true, status: "deferred", boundary: "fabric_exec_end" }`. Code later in the same Fabric invocation cannot consume the child output. At the outer boundary, Fabric replaces Main's tool result with the compact completion `{ handedOff, completed, status, agent, implementation, error? }`. The `model` field is required. The target runner is Pi. The `worktree` field is unavailable because the implementation must remain visible in the caller's workspace. You can also set `task`, `name`, `kernel`, `transport`, `thinking`, `tools`, `timeoutMs`, `extensions`, `recursive`, `schema`, and `compact`. Fabric does not switch or rewrite the history of the source session.

After an explicit handoff settles, Fabric queues one visible `pi-fabric-handoff-complete` custom message as a follow-up and wakes Main. The TUI shows the executor name, model, status, and a bounded conclusion. Main summarizes the outcome and reported checks, preserving links and other concrete identifiers without redoing the delegated work. Failed, stopped, and timed-out handoffs (including launch errors) instead prompt Main to explain what happened and propose a next step without retrying or taking over unprompted. Internal continuation instructions are included in model context but omitted by the message renderer. Prewalk keeps its existing verification continuation.

**Executor-local failure continuation.** If a running trajectory executor encounters a failed nested handoff (including a launch or depth-limit error), Fabric queues one hidden `pi-fabric-handoff-continuation` follow-up in that same executor. It tells the executor what failed and to finish its original assignment directly in the existing workspace, preserving completed work and running verification without stopping at a handoff-failed report. It must not retry the handoff, spawn a replacement executor, or raise limits. Fabric cancels any local Prewalk arm so the next write cannot delegate again. The failed boundary remains failed; this is not a retry or a claim that the work succeeded.

This fallback is available once per executor run, with a persisted receipt that survives reload and worker recovery. Main, ordinary children, and actors keep their existing completion policy. Explicit stops, cancelled callers, timeouts, and token-limit termination do not trigger the fallback; the executor's original deadline, permissions, and token accounting remain in force. A blocked executor reports its blocker honestly. Fabric does not classify free-form final answers as failures or relaunch an agent merely because its answer contains failure text.

**Trajectory compaction.** Set `compact` to give the executor a compacted transcript in place of the full raw branch. A value of `true` applies the default summary. Use `{ instructions?, preserve? }` to add compaction instructions of up to 8K characters and as many as 16 explicit preserve facts of up to 2K characters each. These limits match `compact.request`. Fabric budgets the complete inherited context, including the finalized outer `fabric_exec` result and any thinking-transfer digest, before appending the compaction marker. The executor sees the projected summary plus a bounded, tool-pair-safe raw tail; an oversized outer call/result pair is summarized together to avoid leaving an orphan result. When available, the destination model window and its Pi compaction settings apply, including trusted project/model overrides. Source-model usage is not treated as destination calibration. Without model metadata, the raw tail is still bounded (20K estimated tokens by default). The append-only child file retains the full raw trajectory. Fabric records the successful outcome under `compaction` in the child's `pi-fabric-handoff` custom entry, including sections, tokens, and cut point. If requested compaction cannot produce a valid result, the handoff fails; the unbounded fork is never silently launched. Omit `compact` to keep the fork verbatim.

### Context-inheriting spawn

`agents.run()` and `agents.spawn()` accept `seed: "task" | "branch" | "snippet"` for Pi children. The default `"task"` keeps the historical behavior: the child receives the task alone. Other runners fail before launch when `seed` is not `"task"`.

`seed: "branch"` starts the child from a copy of the caller's current session branch, with the task appended as a new user turn. Unlike `agents.handoff()`, it never blocks Main or waits for the `fabric_exec` boundary; the caller keeps running and can `wait` later. The copy ends at the caller's last completed turn: Fabric drops the in-flight assistant turn that holds the outer `fabric_exec` call (the newest assistant entry after the latest user message with an unresolved tool call), so the child never sees a dangling tool call. Fabric materializes the copy with the same session machinery as handoff, applies thinking transfer when the child model's reasoning channel differs, and records a `pi-fabric-fork` custom entry with `boundary: "last_completed_turn"`. The seed works with `worktree: true`. Durable `agents.spawn()` refuses `seed: "branch"` because the resident host accepts no session seeds; use `"snippet"` there.

`seed: "snippet"` prefixes the task with the last `seedMessages` user and assistant messages (1 to 50, default 12) inside an `<inherited-conversation>` block. Only text survives: tool calls, tool results, thinking, and images are dropped, and each message is truncated to 4,000 characters. The cut is deterministic and works with durable residency.

A supervised fork pairs a mailbox actor with a branch-seeded worker. The worker inherits the conversation; the supervisor reviews each result:

```ts
const supervisor = await agents.create({
  name: "fork-supervisor",
  instructions: "Review a worker result. Reply APPROVE or a concrete correction.",
});
let task = "Implement the plan we just agreed on.";
for (let round = 0; round < 3; round++) {
  const worker = await agents.run({ task, seed: "branch", worktree: true });
  const verdict = await agents.ask({ id: supervisor.id, message: worker.text, data: worker.worktreeResult });
  if (verdict.text?.includes("APPROVE")) return worker;
  task = `Revise the previous attempt in a fresh fork: ${verdict.text}`;
}
return "Supervisor did not approve after 3 rounds";
```

### Automatic Fabric-boundary prewalk

`/fabric prewalk` adapts Can Bölük's [Prewalk research](https://stencil.so/blog/prewalk) for Fabric. OMP changes models inside one live agent loop at the first edit or write that a todo gates. Fabric uses a coarser atomic boundary. The first successful monitored mutation marks the current outer `fabric_exec`. All remaining nested calls settle before prewalk continues. This behavior preserves programmable sequential and parallel Fabric semantics.

```text
/fabric prewalk
/fabric prewalk Implement the token guard and run its tests
/fabric prewalk --status
/fabric prewalk --off
/fabric prewalk --disable
/fabric prewalk --enable
```

When you supply a task, Fabric arms prewalk and immediately submits the task to Main. Without a task, it captures the next user input. Select the executor in `/fabric settings` under **Prewalk**. **Always re-arm** uses `prewalk.model` to arm prewalk automatically at each Main session start without interaction. It also arms prewalk after each completed handoff. Child agents and actors do not auto-arm from inherited settings, so trajectory executors finish their assigned work without handing it off again on their first write. Explicit arming remains available. `/fabric prewalk --off` cancels only the current session arm. `/fabric prewalk --disable` persists the master switch to the project config when trusted (global config otherwise), cancels any live arm, and keeps prewalk inert after restart; `--enable` reverses it.

Host extensions that must serialize work after prewalk can use the acknowledged protocol exported from `pi-fabric/protocol`. Emit `FABRIC_PREWALK_REQUEST_EVENT` with `{ version: 1, context, claim, respond }`. Fabric calls `claim()` synchronously; the first claimant owns the request. It calls `respond({ ok: true })` only after prewalk is armed, or `respond({ ok: false, error })` after cancellation or failure. A request that is not claimed means no compatible Fabric runtime is installed. The protocol intentionally arms without submitting a task, so the caller can deliver its next queued row only after the acknowledgment.

The default value of `prewalk.mode` is `"in-place"`:

1. The arm owes a recorded plan before any handoff. With `prewalk.requirePlan` (default on), a mutation boundary reached without one is withheld: Fabric delivers a hidden plan checkpoint to Main that asks for `prewalk.plan({ outcome, steps, verification, risks })` inside `fabric_exec`. That recorded plan is the readiness signal: Fabric snapshots it at claim time and delivers it in the hidden continuation (in-place) or the executor task (trajectory), so the executor receives it even if the action result is discarded or the outer output is truncated. Main keeps working on the frontier model, nothing is selected or switched, and the arm stays armed.
2. Fabric detects the next successful `pi.edit`, `pi.write`, or `schema.commit`, then lets the full outer program settle. An audited mutation also consumes the shell-write drift window, so those edits cannot re-fire as `fs.drift` on a later read-only shell boundary. A successful `pi.bash` or `pi.powershell` can also trigger detection when no audited mutation occurred. In that case, a stat-baseline diff of the work tree identifies shell writes such as heredocs, `sed -i`, and formatter binaries as a filesystem trigger (`fs.drift`). Set `prewalk.detectShellWrites` to `false` to disable this behavior.
3. At the finalized outer result boundary, Fabric selects `prewalk.model` on Main.
4. Fabric sends one hidden continuation as a passive context message. It tells Main to continue the current task, complete the remaining implementation, check related call sites, and run verification. That single message carries the captured task text, the recorded plan when one exists, and, when the reasoning channel is not replayable, a bounded advisory digest of the frontier model's deliberation. Fabric also keeps it as the claim's canonical payload, and the request-context hook injects it into any request that would otherwise run without it.
5. The boundary does not terminate the outer tool. The same Main session keeps running on the executor model and its next request follows naturally, carrying the continuation exactly once. Claiming a prewalk-in-place handoff therefore suppresses `terminate` from the boundary result. Competing user steers drain in order into that request without delaying the continuation, and no completion-only turn follows. The passive message is persisted after the boundary turn's tool results, so later turns and runs read it from the transcript.
6. After the continuation settles, Fabric compacts the session with the configured compaction engine. Set `prewalk.compactOnReturn` to `false` to skip this step. Fabric then restores the Main model captured at the boundary.

In-place mode uses Main directly and keeps one transcript. It works with `agents.enabled` set to `false`. Pi's public extension model switch can leave the executor selected on Main, including in a later session that inherits it, so Fabric restores the captured Main model when the continuation settles, when a new session is still on that executor, and when prewalk is cancelled or reloaded. A switch can fail before continuation when the model is unavailable or unauthenticated. The outer result then reports the cause, and because the in-place boundary does not terminate, Main keeps running on its captured model and explains the failure in that same run; no queued follow-up repeats it. The return after a settled continuation can also fail. Fabric then drops the arm without re-arming, keeps the failure visible, and preserves the captured Main model: a later session start or `/fabric reload` retries the return, auto-arm stays skipped while Main is still on the executor, and an explicit `/fabric prewalk` arm overrides.

Set `prewalk.mode` to `"trajectory"` to use child-based behavior. Fabric forks the exact finalized outer call and result into a Pi child. It starts the selected executor in the shared workspace and waits. When the child finishes, Fabric replaces the boundary result with the executor report and queues a hidden continuation. Main verifies the implementation with the applicable checks and provides a summary. It does not repeat completed executor work, and it relays links, PR numbers, and commit hashes verbatim. If the child fails, stops, or times out, Fabric queues a hidden follow-up that reports the result and proposes an action. Main always tells the user how execution ended and what the child completed. Every boundary reports a result. The executor uses `prewalk.thinking` for reasoning effort. When unset, it inherits `agents.thinking`. The parent Fabric card and activity UI display the synthetic `agents.handoff` call, child identity, live status or current tool, nested preview, metrics, and terminal result. Users can see progress during the wait. Trajectory mode requires enabled agents. Explicit `agents.handoff()` also uses this behavior.

**Thinking transfer across models.** Providers define the shape of stored thinking blocks. Codex uses encrypted reasoning items. Anthropic requires valid signatures. Replaying these blocks to another provider can place them in unusable request fields or cause failure. Fabric applies a family policy when it writes the trajectory child session. It uses `preserved` when the executor has the same provider and API family as the source model. For openai-completions reasoning targets, it uses `re-signed`. This policy keeps the thinking text and normalizes the signature to `reasoning_content`, which lets preserve-thinking servers receive earlier reasoning. For other targets, Fabric uses `stripped`. Fabric removes the thinking blocks and foreign thought signatures, then adds a bounded digest custom message with entry IDs for continuity. The digest covers the current task's deliberation from the boundary model only (never an earlier task's or another model's reasoning) and is omitted when no current task boundary carries usable thinking. Fabric records the policy and counts under `thinkingTransfer` in the child's `pi-fabric-handoff` custom entry. In-place prewalk cannot rewrite Pi's session log. When channels are incompatible, it embeds the same digest in the hidden continuation message. Fabric never modifies the source session.

Prewalk does not add system-prompt instructions. It queues its hidden continuation only after a matching mutation boundary, so the continuation is not an open-ended prompt on each turn. The plan checkpoint is one hidden custom message per boundary that still owes a plan, delivered as a steer so it lands before the frontier model's next call, and it is never a system prompt. Readiness comes from the `prewalk.plan` action, and the claimed handoff carries the plan explicitly: the executor sees the full recorded plan in its first continuation request or task, not just a nested tool result. While a handoff is in flight, `prewalk.status` also reports the claim's `claimedReadiness` (`planned`, `disabled`, or `unplanned`), distinguishing a plan that was recorded and consumed from an arm that never recorded one. A boundary keeps withholding while the plan is missing and asks at most twice for a task, then hands off unplanned with a visible warning so an armed session cannot stall. A recorded plan survives a failed handoff and is dropped when the captured task changes; re-arming, cancelling, or reloading Fabric resets readiness so the next task plans again. Use `prewalk.status` inside `fabric_exec` for the arm state and its readiness flags. It also reports the loaded build identity of the extension entry and the lazy runtime module against the files currently on disk (`runtime.entry`, `runtime.lazyRuntime`, each with `loadedSha256`, `diskSha256`, and `stale`). Pi's loader native-imports `type: module` ESM extensions, and `/reload` clears only its factory cache, not the process ESM registry: an extension path the process has already imported keeps its first evaluation until the session process restarts. After rebuilding pi-fabric, restart the session to run the new build; `prewalk.status` is the one-call check for whether the loaded runtime is stale. A turn that settles without a handoff leaves prewalk armed. A matching mutation consumes the arm through an in-place switch or trajectory spawn. A completed explicit `agents.handoff()` also consumes it, as does `/fabric prewalk --off`. Fabric drops the settled turn's captured task text so that it captures the next prompt as new input. Both modes require full code mode. Schema enforce mode does not support them.

The filesystem fallback compares each file's size and mtime with a baseline captured when prewalk was armed. Fabric refreshes the baseline after every considered boundary and settle. In Git work trees, it lists files through the index, so ignored build output does not register. In trees without Git, it walks the files and skips only `.git` and `node_modules`. Both listings exclude Fabric's own state directory before the tracked-file cap, so runtime cache writes are bookkeeping that neither triggers prewalk nor consumes the tracking budget. Other tools keep their own directories, and Fabric does not encode them: a Git work tree follows the project's ignore rules, so adding a tool directory to `.gitignore` removes it from the listing. Artifact writes elsewhere then count as drift. The diff cannot identify who made a change. An external editor save during a shell-running window also counts. The fallback scans only programs that ran `pi.bash`, so read-only turns have no scan cost and cannot trigger it. Stat drift can occur without a content change, for example from rare `touch` churn. This drift triggers prewalk. The report lists affected files in `trigger.files`.

### Claude Code runner

Install and authenticate the official Claude Code CLI (`claude`) through its normal process. Fabric calls this binary directly. Select it for one call or for all calls:

```ts
const models = await agents.models({ runner: "claude" });
const haiku = models.find((model) => model.key === "claude/haiku");
return agents.run({
  runner: "claude",
  model: haiku?.key,
  task: "Review the current diff. Do not edit files.",
  tools: ["read", "grep", "find", "ls"],
});
```

`agents.models({ runner: "claude" })` requests the initialization model catalog from the installed CLI. The catalog includes aliases, resolved IDs, descriptions, and supported effort levels. Fabric does not hard-code this list. The handshake sends no user prompt or model inference request, so discovery has no model charge. The call starts the configured local binary. Starting the local binary gives model-authored `agents.models` calls Fabric's `execute` risk. Fabric caches the catalog for 60 seconds. Claude model keys have the form `claude/<runtime-value>`, such as `claude/default`, `claude/sonnet`, and `claude/haiku`. Fabric removes this namespace before passing the value to `--model`.

Claude runs call `claude -p` with stream-JSON input and output, partial messages, `--permission-mode dontAsk`, `--tools`, and `--allowedTools`. Fabric converts its portable core allowlist as shown below:

| Fabric tool  | Mapped Claude Code tool |
| ------------ | ----------------------- |
| `read`       | `Read`                  |
| `grep`       | `Grep`                  |
| `find`, `ls` | `Glob`                  |
| `bash`       | `Bash`                  |
| `edit`       | `Edit`                  |
| `write`      | `Write`                 |

Unknown tools cause failure before launch. Set `extensions: false` to start Claude in safe mode. The default value, `true`, keeps the user's standard Claude Code customizations. The explicit tool list continues to control the tools that the model can use. JSON schemas use Claude's native `--json-schema`. Fabric normalizes usage, cost, turns, tool activity, errors, and Claude's session ID into the standard Fabric result and dashboard transcript. It adds `--no-session-persistence` to one-shot runs.

Claude-backed children have no recursive Fabric capabilities. Fabric rejects `recursive: true`, `fabric_exec`, and direct `mesh.*` access. Choose `runner: "pi"` for RLM or recursive Fabric. For host-managed mailbox and event coordination, use a persistent actor backed by Claude.

### Veda runner

The `veda` runner starts the [Veda CLI](https://github.com/kennyfrc/veda) as a one-shot headless child. Install and authenticate the configured backend CLI with its normal procedure. Veda can use `agy`, `codex`, `claude-code`, `droid`, `pi`, and any backend that the installed Veda build registers. Fabric invokes `agents.veda.binary` with `-b <backend> -p <persona> --json`. It sends the task through stdin:

```ts
return agents.run({
  runner: "veda",
  persona: "frontend", // select a built-in or custom Veda persona
  model: "agy/gemini-3.1-pro-high", // send this value to the configured backend
  task: "Review the current implementation for architectural risks. Do not edit files.",
  tools: ["read", "grep", "find", "ls"],
});
```

Fabric forwards Veda model values unchanged to the selected backend. Use `agents.veda.model` to set a backend-specific default. An explicit `agents.run({ model })` value has priority. If you omit both values, Veda selects its own backend default. Personas do not depend on models. Add custom personas at `~/.config/veda/personas/<name>/AGENTS.md`. Set the global default with `agents.veda.persona`, or select a persona for one run with `agents.run({ persona })`. `agents.models({ runner: "veda" })` currently returns an empty advisory list. Fabric normalizes usage (`inputTokens`/`outputTokens`/`cachedTokens`), backend conversation ID, turns, and errors from the Veda `--json` envelope. The data appears in the standard Fabric result, dashboard, lifecycle events, and budget ledger.

For each run, Fabric passes `--tools <allowlist>`. It passes `--no-tools` for an empty allowlist. This setting has priority over tool frontmatter in the persona. The built-in read-only personas specify `tools: none`. The `worker` persona specifies `tools: all` with `sandbox: workspace-write`. Fabric does not pass `--sandbox`, so persona frontmatter defines the sandbox, and `worker` agents can change files. The `navigator-plan` persona also requires a `<program>` design block, and `worker` requires a `<worker_report>`. A failure in either protocol appears as a run error, so `navigator-chat` is the default for free-form tasks.

Each run gets an isolated `fabric-<run-id>` Veda session through `-S` and `--no-sel`. Parallel children cannot share selection or conversation state. Veda stores these sessions under `.veda/sessions/` at the project root. Outside a Git repository, it uses `~/.config/veda`. This repository includes `.veda/` in `.gitignore`.

Veda children do not have recursive Fabric capabilities. Fabric rejects `recursive: true`. Veda does not support steering, so steer and follow-up calls throw when called. It also cannot run persistent actors because each invocation executes one headless prompt. Use `runner: "pi"` when you need recursive Fabric or persistent coordination.

### Custom runners

The default `pi-durable` runner uses the full isolated Pi/Fabric worker host; explicit `pi` selects the legacy CLI. See [Durable Pi runner](durable-pi.md) for recovery boundaries and the separate `pi-durable-leaf` hosted factory. Neither restores arbitrary `fabric_exec` continuations.

A Pi extension can add a runner through the `pi-fabric/runners` subpath. The subpath is never loaded by the Fabric extension at startup.

```ts
import { registerAgentRunner, listAgentRunners, getAgentRunner } from "pi-fabric/runners";

const unregister = registerAgentRunner(adapter); // FabricWorkerRunner | FabricHostedRunner
```

Every adapter has an `id` (`/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/`, at most 64 characters; `pi`, `claude`, and `veda` cannot be replaced), a `label`, and a `capabilities` object in which every flag is a required boolean: `recursiveFabric`, `steer`, `followUp`, `persistentSessions`, `kernels`, `handoff`, `modelDiscovery`, `imageInput`, `compaction`, `questions`, `sleep`, `writePolicy`. Optional hooks are `models()`, `defaultModel()`, `normalizeModel()`, and `mapTools()`. The built-in runners declare their flags in the same table, so every capability check is uniform. Fabric refuses a request that needs an undeclared capability before admission, budget, or worktree side effects: `recursive: true` needs `recursiveFabric`, an explicit `kernel` needs `kernels`, `images` need `imageInput`, session seeds (trajectory handoff, `seed: "branch"`) need `handoff`, `readOnly`/`writableRoots`/`shell` or an inherited confinement need `writePolicy`, routed child dialogs need `questions`, `agents.compact` needs `compaction`, and actors need `persistentSessions`. A runner that declares `writePolicy` receives the effective policy in its launch context and must enforce it. In a scoped session, every launch context also carries `scope`: the host-issued [scope](providers.md#principal-and-scope) narrowed for that run. Runners pass it on to any provider that reads data for the run.

Two kinds exist:

- `kind: "worker"`: `launch(context)` returns `{ workerPath, workerArguments }`. Fabric runs that script under the selected transport and reads the [worker protocol](#worker-protocol) files. The context carries the run files, the task and launch facts, and `fabricWorker`, the launch Fabric would use for its own worker, so an adapter can wrap it. The optional `stop()` runs before the transport kills the process. A worker that dies before any progress is relaunched with the same launch (startup retry); Fabric never re-prompts a custom worker mid-run.
- `kind: "hosted"`: no Fabric process. The adapter owns execution, for example in a daemon. `prepare(context)` must be pure and returns a JSON locator of at most 8 KiB. Fabric writes it to the run record (`hosted.locator`) and `hosted.json` before it calls `start(locator, context, reporter)`. `context.idempotencyKey` is the Fabric run id, so a second submission with the same key must not start a second run. `liveness(locator)` answers `running`, `sleeping`, `settled`, `cancelled`, `interrupted`, or `unknown`. `stop(locator, reason)` is required and returns `{ confirmed }`. `abort`, `sleep`/`wake` (with the `sleep` capability), `steer`, and `followUp` are optional. The adapter delivers steer and follow-up messages itself; a delivery failure lands in the run transcript.

The hosted `reporter` has `progress({ turns, toolCalls, currentTool, text })`, `usage(total)` with the cumulative run usage (Fabric records the increase, which feeds budgets and `tokens.usage` lifecycle events), `transcript(event)`, `question(q)`, `finish({ status, output, structured? })`, and `fail({ error, retryable })`. When the run has a `schema`, Fabric validates a `completed` finish against it as it does for its own worker: `structured` (`null` included), or `output` parsed as JSON when `structured` is absent, must match. A mismatch, or a value over 1 MiB from either source, settles the run `failed` with `Structured agent output was invalid: ...`. `question` routes like a Pi child dialog: direct UI when the parent has one, otherwise a [decision](decisions.md#routed-child-questions), and only with `agents.childQuestions: "route"`. The run record shows `blockedOn` while it waits.

Fabric never relaunches or re-prompts a hosted run. A `sleeping` run stays `running` with `sleeping: true`. When liveness reports `interrupted` or `unknown` (or `settled` without a result), the run settles `failed` with `outcome: "indeterminate"`. The same outcome marks a stop the adapter did not confirm, and a durable spawn request the resident host was processing when it restarted. Hosted runs work with `agents.run`, `spawn`, `wait`, `status`, `stop`, `steer`, `followUp`, the dashboard, budgets, and `residency: "durable"`. Persistent actors need a worker runner.

Registration is process-local. The resident host runs Pi with `--no-extensions`, so a durable run of a custom runner requires `residentModule`: an absolute path to an ES module that registers the adapter when imported. Fabric refuses a durable spawn without it. The resident host imports the module before launch. On restart it imports it again and calls `attach(locator, context, reporter)` for every unfinished hosted run; a run whose runner cannot be loaded settles indeterminate. When the resident host shuts down, durable hosted runs are detached; they keep running and are re-attached on the next start. Session hosted runs are stopped with the session.

An illustrative daemon-backed adapter:

```ts
import { registerAgentRunner, type FabricHostedRunner } from "pi-fabric/runners";

const daemon = "http://127.0.0.1:7777"; // hypothetical job daemon
const call = async (path: string, body?: unknown) =>
  (await fetch(`${daemon}${path}`, { method: body ? "POST" : "GET", body: JSON.stringify(body) })).json();

const runner: FabricHostedRunner = {
  kind: "hosted",
  id: "jobd",
  label: "Job daemon",
  residentModule: new URL(import.meta.url).pathname,
  capabilities: {
    recursiveFabric: false, steer: true, followUp: false, persistentSessions: false,
    kernels: false, handoff: false, modelDiscovery: false, imageInput: false,
    compaction: false, questions: false, sleep: false, writePolicy: false,
  },
  prepare: (context) => ({ job: context.idempotencyKey }),
  start: async ({ job }: any, context, reporter) => {
    await call("/jobs", { id: job, task: context.task, cwd: context.cwd }); // idempotent by id
    void follow(job, reporter);
  },
  attach: async ({ job }: any, _context, reporter) => void follow(job, reporter),
  liveness: async ({ job }: any) => (await call(`/jobs/${job}`)).state ?? "unknown",
  stop: async ({ job }: any) => ({ confirmed: (await call(`/jobs/${job}/stop`, {})).stopped === true }),
  steer: async ({ job }: any, message) => void (await call(`/jobs/${job}/input`, { message })),
};

async function follow(job: string, reporter: Parameters<FabricHostedRunner["start"]>[2]) {
  const result = await call(`/jobs/${job}/wait`); // replays the result after a restart
  reporter.usage(result.usage);
  reporter.finish({ status: result.ok ? "completed" : "failed", output: result.text });
}

registerAgentRunner(runner);
```

### Worker protocol

A worker runner process talks to Fabric through four files named in `context.files`. `pi-fabric/runners` exports a JSON Schema for each (`AgentRunRecordSchema`, `LifecycleLineSchema`, `TranscriptEventSchema`, `SteerCommandSchema`, protocol version `FABRIC_WORKER_PROTOCOL_VERSION = 1`). Readers ignore unknown fields.

| File | Direction | Content |
| --- | --- | --- |
| `statusFile` | worker writes | The run record, replaced atomically (write a temporary file, then rename). `status` moves from `running` to `completed`, `failed`, `stopped`, or `timed_out`; `text`, `value`, `error`, `turns`, `toolCalls`, `usage` (cumulative), `currentTool`, and `blockedOn` are the public fields. |
| `lifecycleFile` | worker appends | One `{ version: 1, event, occurredAt, data }` line per event: `tokens.usage` (a per-event increase), `question` (a dialog to route), and the `pi.*` lifecycle events. |
| `logFile` | worker appends | Transcript events for logs and the dashboard: `message_end` with a `user` or `assistant` message, `tool_execution_start`, `tool_execution_end`, and `extension_error`. |
| `steerFile` | Fabric appends | Commands with `id` and `ts`: `steer`, `follow_up`, `set_steering_mode`, `set_follow_up_mode`, `compact`, and `ui_response` (`requestId` plus `value`, `confirmed`, or `cancelled`) answering a routed `question`. |

A worker that exits without a terminal record is treated as a dead transport: it is relaunched only when it made no progress, and otherwise settles failed.

### Switching Main's session model

`agents.switchModel` changes the live Pi session model in place and keeps it there:

```ts
await agents.switchModel({ model: "anthropic/claude-opus-4-5" });
await agents.switchModel({ model: "cheap" });
```

The selector resolves in order: a `models.aliases` entry (a string alias is one target; an array is a fallback chain where the first authenticated target wins), an exact `provider/id`, an exact model id, then the closest match across provider, id, and display name. Closeness ties fall to the most recently used model, read from the [pi-model-sort](https://github.com/monotykamary/pi-model-sort) extension's usage store when it is installed, and then to the highest-sorting key, mirroring pi's newest-alias convention. An optional `provider` argument narrows every stage. Selectors with no resemblance to an authenticated entry and exhausted alias chains throw; the session model stays unchanged. `agents.models()` enumerates the authenticated registry entries this resolution runs against. The result reports the active model, the previous one, and how the selector resolved: `via` is the alias name for configured aliases, or `closest`, `recent`, or `latest` for fuzzy picks. A call naming the active model returns `{ switched: false, reason: "already-active" }`. The switch applies to the next model turn and later, unlike `prewalk`, which temporarily installs an executor model at a mutation boundary and then restores the boundary model.

Pi-runner `model` arguments on `agents.run`, `agents.spawn`, `agents.create`, and `agents.handoff`, plus actor defaults and activation overrides, resolve through the same selector logic (aliases, closest match, recency). The execution owner's `agents.models({ runner: "pi" })` result is authoritative: provider-qualified near-misses are matched only on that provider, selectors with no similar visible candidate and exhausted aliases fail with a session-availability error. Fabric revalidates the canonical model at the worker launch boundary, including remote and durable actor execution, so stale bindings cannot start a model that is no longer visible. Catalog-fresh or custom IDs must appear in the owner's visible registry before a Pi participant can use them. Claude and Veda model values keep their runner-specific behavior.

This is the host-level equivalent of the `pi-model-switch` extension's `switch_model` tool, with aliases moved into Fabric configuration so project and agent scopes behave like every other Fabric section.

### Transports

| Transport   | Operation                                                     | Command to attach            |
| ----------- | ------------------------------------------------------------- | ---------------------------- |
| `process`   | Runs a detached local worker process with the lowest overhead. This is the default transport | none |
| `tmux`      | Creates one detached tmux session for each child              | `tmux attach-session -t …`   |
| `screen`    | Creates one detached GNU Screen session for each child        | `screen -r …`                |
| `localterm` | Creates one pinned LocalTerm PTY for each child               | `localterm session attach …` |
| `herdr`     | Creates one background Herdr tab for each child               | `herdr terminal attach …`    |
| `auto`      | Tries Herdr, LocalTerm, tmux, screen, and then process         | Depends on the transport     |

Herdr uses its local socket API to create an argv-backed background tab as one atomic operation. It does not change focus or require shell quoting. Automatic selection works only when the parent Pi process already runs in Herdr. This requires `HERDR_ENV=1` with an injected workspace and socket. Select `transport: "herdr"` under the same conditions. Use the attach command in the handle to open a child directly.

LocalTerm provides the required primitives that match tmux: detached creation, pinning, listing, capture, exec, attach, and kill. Pi Fabric requires no LocalTerm patch. Start the daemon before you select this transport:

```bash
localterm start
```

`/fabric agents` lists the children. Run `/fabric attach <id>` to show the correct attach command. A caller abort stops a run that never produced progress and detaches a run that already did: the child keeps working to its own terminal state and reports it, so a returned program or a cancelled tool call cannot discard a long participant's work. A worker that catches an external signal mid-run, or whose transport dies after doing work, is resumed, so an interruption the run can recover from never becomes a terminal stop. The manager relaunches the same run in the same directory, hands the child a continuation of the task, keeps the stopped attempt's turns and token usage in the run record, and emits `run.resumed`. An explicit stop, a run deadline, and the `agents.maxTokensPerChild` limit stay terminal. Three resumes bound one run, and the run deadline covers every attempt. When a program uses orchestration entry points such as `agent`/`workflow.agent`, `agents.run`/`agents.wait`/`agents.ask`, `council.run`, or `rlm.query`, Fabric increases the whole-program `executor.timeoutMs` to at least `agents.timeoutMs`. The same increase applies to `agents.*` refs called through `tools.call()` and to refs calculated at runtime. The parent deadline then cannot stop a child that remains within its own agent budget.

Set `worktree: true` to create a dedicated Git worktree and a `pi-fabric/<name>-<id>` branch from the repository containing the selected `cwd`. Fabric writes that worktree at `<repo>/.pi/fabric/worktrees/<id>` so copy-on-write cloning can keep ignored build artifacts on the same volume, and it records the path in the repository `.git/info/exclude` file. Simple `git worktree add` commands run through `pi.bash` take the same clone-first path. Fabric retains worktrees for inspection until you call `agents.cleanup()`. When the selected cwd is a repository subdirectory, Fabric uses the matching subdirectory in the generated worktree when it exists; otherwise it uses the worktree root. The reported effective cwd is the generated worktree path, and Pi evaluates that generated path as its own canonical cwd. The caller's project and mesh roots remain unchanged, so a child targeting another repository still belongs to the orchestrating Fabric topology. A recursive child in a worktree stays in the same participant directory and does not create another `.pi/fabric/mesh` inside that worktree.

At settlement, a `worktree: true` result and status carry `worktreeResult: { path, branch?, baseRef?, changedFiles, diffstat: { files, insertions, deletions }, kept, diffError? }` beside the existing `worktree` path string. `baseRef` is the commit the branch started from. `changedFiles` is the sorted union of tracked changes against `baseRef` (committed or not) and untracked, non-ignored files, capped at 500 entries; `diffstat.files` counts all of them. Untracked text files up to 1 MiB count their lines as insertions. Fabric computes the summary with two bounded Git calls (15 second timeout each); a Git failure leaves the counts at zero and sets `diffError`. `kept` reports whether the worktree still exists; worktrees stay until `agents.cleanup()`.

Set `agents.worktree.setup` in [configuration](configuration.md#agents) or `worktreeSetup` on one request (which wins) to run a shell command in the new worktree root before the child starts, for example `"bun install --frozen-lockfile"`. The command runs through `/bin/sh -c` (`cmd /c` on Windows) with a 10 minute limit. A non-zero exit or timeout fails the launch with the last 2,000 characters of output and removes the worktree and its branch.

### Write confinement

`agents.run()` and `agents.spawn()` accept `readOnly?: boolean`, `writableRoots?: string[]`, and `shell?: "deny" | "unconfined"` for Pi children. Setting any of them creates a write policy:

- `readOnly: true` refuses every `write` and `edit`.
- `writableRoots` (at most 32) resolve against the child's cwd, including a generated worktree. Omitted roots default to that cwd. A root must exist or be creatable inside the cwd; Fabric creates missing ones. `write` and `edit` outside the roots fail. Fabric checks the lexical absolute path and the real path of the nearest existing ancestor, so a symlink cannot escape a root, and an unresolvable path fails closed.
- `bash` and `powershell` are refused under any write policy unless the request sets `shell: "unconfined"`. Fabric does not parse shell commands: an unconfined shell can write anywhere the process can, so it is not a sandbox.

The child Pi process enforces the policy. The worker passes it as `PI_FABRIC_WRITE_POLICY` and loads a small guard extension with `-e`, so it applies even with `extensions: false`. The guard blocks top-level tool calls through Pi's `tool_call` hook and nested `pi.write`, `pi.edit`, and `pi.bash` calls inside `fabric_exec`. It covers tools named `write`, `edit`, `bash`, and `powershell`, including captured overrides with those names; other extension tools and MCP servers are outside it. Native Fabric executors (CPython, `node-process`, `bun-process`) run outside the hook: a confined launch that would use one fails before launch, and a confined child refuses to run one, unless `shell: "unconfined"`. QuickJS and Monty stay available.

Confinement is inherited and only narrows. A confined agent's own children inherit its policy when they request none; an explicit request must keep `readOnly`, cannot switch to `shell: "unconfined"`, and must name roots inside the caller's roots. Claude and Veda runners fail before launch under any policy because Fabric cannot enforce it there. A confined agent cannot start durable agents or actors, since the shared resident host does not inherit its confinement.

### Scope narrowing

In a session with a host-issued [principal and scope](providers.md#principal-and-scope), every child inherits that scope. `agents.run()` and `agents.spawn()` accept `scope: { grants: [{ resource, actions }] }` to narrow it: each grant must be covered by one parent grant, or the launch fails before admission. The principal always stays the parent's. An unscoped session refuses `scope`. Durable spawns and actors keep the scope: the session sends it to the resident host with the request, so the durable child launches with the same scope it would get locally.

```ts
await agents.run({ task: "Summarize build logs", scope: { grants: [{ resource: "mesh:jobs/build", actions: ["read"] }] } });
```

### Child environment contract

Fabric children may read these environment variables. They are stable and versioned where noted; every other `PI_FABRIC_*` variable is internal and may change.

| Variable | Contents |
| --- | --- |
| `PI_FABRIC_LINEAGE` | JSON `{ version: 1, rootSessionId, parentSessionId?, parentRunId?, runId, depth, childIndex, worker: true }`. `childIndex` is the launch ordinal within the parent process. `agents.self()` adds the same object as `lineage` inside a child. |
| `PI_FABRIC_WRITE_POLICY` | JSON `{ readOnly, writableRoots, shell }` with canonical absolute roots. Present only for confined children. Malformed values fail closed to read-only with shell denied. |
| `PI_FABRIC_THINKING_BOUNDS` | JSON `{ min?, max? }` thinking bounds; see [thinking](thinking.md). |
| `PI_FABRIC_SCOPE` | JSON `FabricScope` `{ version: 1, principal, grants, digest, parentDigest? }`. Present only when the parent is scoped: the inherited or narrowed scope. The worker always clears `PI_FABRIC_SCOPE_FILE`. A child Fabric reads it as its root scope and fails closed when it is malformed. See [principal and scope](providers.md#principal-and-scope). |
| `PI_FABRIC_DEPTH` | Recursion depth of the child (the root is 0). |
| `PI_FABRIC_AGENT_NAME` | The child's display name. |
| `TRACEPARENT`, `TRACESTATE` | W3C Trace Context headers an extension supplied for this launch; see [child trace context](#child-trace-context). Without a reply the child keeps the values its worker inherited. |

### Child trace context

A child agent is its own process, so its telemetry joins the parent's trace only when the parent's trace context reaches its environment. Before each child launch and each relaunch (startup retry, resume), Fabric emits `FABRIC_CHILD_TRACE_CONTEXT_EVENT` (`pi-fabric:child-trace-context:v1`) on Pi's event bus, so a tracing extension can answer for that launch alone:

```ts
import {
  FABRIC_CHILD_TRACE_CONTEXT_EVENT,
  type FabricChildTraceContextRequestV1,
} from "pi-fabric/protocol";

pi.events.on(FABRIC_CHILD_TRACE_CONTEXT_EVENT, (value) => {
  const request = value as FabricChildTraceContextRequestV1;
  // parentToolCallId: the outer fabric_exec call. nestedToolCallId: the agents.* call.
  const span = spanForToolCall(request.nestedToolCallId ?? request.parentToolCallId);
  if (span) request.reply({ traceparent: traceparentOf(span), tracestate: tracestateOf(span) });
});
```

The request is `{ version: 1, parentToolCallId?, nestedToolCallId?, runId?, runner, name, reply }`. `nestedToolCallId` is the id the call's [audit](audit-trace.md) and proxied `tool_result` carry. Actor turns have neither call id. A durable `agents.spawn` has no `runId`: the session asks before it hands the request to the resident host, which mints the id and reuses the answer for its own relaunches.

`reply` must be called synchronously, before the listener's first `await`. The first valid reply wins. Fabric carries it to the worker beside the lineage (`--trace-context`), and the worker exports `TRACEPARENT` and `TRACESTATE` to the child, replacing both inherited values. That reaches every transport, including tmux, screen, LocalTerm, and Herdr sessions that start from the multiplexer's environment, and deferred handoffs that launch after `fabric_exec` returns. A relaunch that gets no reply keeps the context of the launch before it.

A reply can set only those two headers. `traceparent` must be a lowercase W3C `version-traceid-parentid-flags` value with non-zero ids; `tracestate` is optional printable ASCII of at most 512 characters. `reply` throws on anything else, and on a call after the launch, so the mistake surfaces in the listener. A listener that throws never blocks a launch. With no reply Fabric sets nothing, and the child keeps whatever `TRACEPARENT` its worker inherited. Custom [runner adapters](#custom-runners) receive the context as `context.traceContext`.

[Model-guidance components](components.md#model-facing-guidance-components) can target participants by canonical provider/model. Direct agents and actors retain their role prompt and receive matching append guidance after it. Recursive Pi children load the project components and resolve their own replaceable Fabric execution slot, so the parent does not duplicate guidance. Durable owners use the latest atomically committed guidance snapshot for each launch. Guidance changes prompts only; it cannot widen tools, approvals, or committed capabilities. Task text, message envelopes, run IDs, and timestamps stay out of the guidance system prompt, so repeated runs with the same role, model, and component projection retain a byte-stable prefix.

## Unified participants and steering

Fabric uses one participant directory for each project. Every live entity has a fixed `kind` of `root`, `agent`, `actor`, or `provider` (work a provider registered as a [participant](providers.md#provider-participants), with `provider` set and no `runner`). It also has a `rootId`, an optional `parentId`, an `ownerHostId`, and an authenticated owner identity for the process that controls its lifecycle. **Main** is the local user-facing view of one root. **Peers** provide compatibility views of the other roots. These views do not use separate registries or control planes. **Fabric reserves Peer for another root Pi session. The term never means a child agent.** When asked about a peer, call `agents.peers()` first. `agents.list()` reports only child agents, so it cannot determine whether a peer root has settled.

`agents.self()` returns the participant record for the caller. `agents.sessions()` lists every live root Pi session, including the caller's root and peers, as symmetric participant records for session-to-session coordination. Call `agents.members({ scope?, kinds?, includeStale? })` to list all kinds. `agents.list({ scope? })` lists agents and uses `scope: "local"` by default. Set the scope to `"lineage"` for descendants of the same root across recursive runtimes. Use `"project"` for all live project agents. `agents.main()` and `agents.peers()` remain convenient compatibility projections. Standard discovery hides participants with expired execution-host leases. Shared summaries include operational metadata. They exclude agent prompts, results, and errors.

```ts
const main = await agents.main();
const sessions = await agents.sessions();
const peerRoot = sessions.find((participant) => participant.id !== main.id);
if (peerRoot) {
  await agents.steer({ id: peerRoot.id, message: "Coordinate on the shared migration." });
}
await agents.followUp({ id: main.id, message: "After the audit, reconcile the findings." });

const lineage = await agents.list({ scope: "lineage" });
return { self: await agents.self(), lineage };
```

Child dialogs (`select`, `confirm`, `input`, `editor`) are cancelled by default. With `agents.childQuestions: "route"` they reach the parent's UI, or a root-held [durable decision](decisions.md#routed-child-questions) when the parent is headless; the run record shows `blockedOn` while one waits.

For Main and one-shot agents, `steer` arrives after the tool calls in the current turn and before the next model call. `followUp` waits until the current run settles. For actors, both operations add a message to the serial mailbox. `agents.status({ id })` accepts any participant ID. It returns complete details for a local run or actor and a bounded directory summary for a remote participant. `agents.setSteeringMode` and `setFollowUpMode` continue to control local one-shot runs.

Local routing returns `"main"` or `"local"`. For cross-process `steer`, `followUp`, and `stop`, Fabric resolves the exact owner of the target. It sends a control command addressed to that owner and waits for an acknowledgement that matches the version, target, and owner identity. Success returns `routed: "mesh", acknowledged: true` after this verified acknowledgement. Unknown IDs, stale owners, rejection, and timeout throw an error. The dashboard actions `s`, `u`, and `x` use the same route. Set `mesh.enabled` to use cross-process control. See [`references/agents.md`](../skillsets/typescript/fabric-exec/references/agents.md).

#### Stale commands after restart

An owner keeps its host ID across restarts (a Pi session's Main ID, or a resident host's root-derived ID), and a durable actor keeps its participant ID. Each control plane process therefore has a random `incarnation`, and every participant record it publishes carries it as `ownerIncarnation`. Requesters copy that value onto `steer`, `followUp`, `stop`, and `ask` commands. A restarted owner replays the retained control log. It refuses an unclaimed command that names an earlier incarnation and never executes it. The caller receives this error without change: `Fabric control command targets a previous owner incarnation; the owner restarted. Re-resolve the participant and retry.` Fabric does not retry. Read the participant again and decide whether to resend. A command claimed by the earlier process before it stopped still reports its recorded outcome, or an indeterminate one. Acknowledgements carry the acknowledging incarnation, and a requester ignores an acknowledgement from any other incarnation than the one it targeted, except the fencing refusal above. Commands and records without an incarnation, from older Fabric versions, behave as before. Fencing assumes one live process per owner host ID at a time.

### Peer labels and queue gates

Every root participant mints a project-scoped label such as `FAB-1` when it first publishes: the prefix derives from the project directory basename (initials for multi-word names, up to three letters for single-word names) and the number comes from a mesh-wide monotonic counter, so retired labels are never reused. Labels appear on participant records, peer projections, and the dashboard, giving other sessions' tooling a stable handle to show users in place of raw session ids.

Two host-local, versioned events on `pi.events` let queue extensions coordinate with peers:

- `pi-fabric:peers:cards:v1` claims and resolves with live peer cards (`{ id, label, status, model?, cwd?, startedAt, updatedAt, pendingMessages }`), sorted by creation time.
- `pi-fabric:peer:await-settle:v1` claims and resolves once every watched peer (a `selector` label/id, or all peers when omitted) has been quiet for `settledForMs` (default 3s) since its last observed run. Peers that vanish from the mesh count as settled. The request accepts an `AbortSignal` for cancellation, and an optional `update` callback reports per-peer waiting status. Requests fail when the mesh is disabled.

[pi-queue-steer](https://github.com/monotykamary/pi-queue-steer-factory) uses both: its `/fabric await LABEL` gate row holds queued rows until the target peers settle.

### Peer presence notices

A root session's model learns that other root Pi sessions are working in the same project without calling `agents.peers()` first. When the set of peers changes, Fabric adds one `pi-fabric-peer-presence` message to the transcript:

```text
<fabric-peers>
Other Pi sessions are working in this project and share its files with you:
- FAB-2 (id session:6f1c…)
- FAB-3 (id session:a09e…), just joined
No longer present: FAB-1.
File or git changes you did not make may be theirs: do not revert or overwrite them. Before a wide edit, a branch switch, a reset, or a dependency install, use `agents.peers` inside `fabric_exec` to see who is running and `agents.steer` to message one by id.
</fabric-peers>
```

- **When.** At the start of a prompt, and at the end of any turn that continues into another model call, so a peer that joins during a long run is noticed before the next request. A final turn adds nothing; the next prompt folds every change made while idle into one notice.
- **Cache safety.** The notice is a persistent transcript message appended at a turn boundary. The system prompt, tool declarations, and every earlier message stay byte-identical, so the provider's cached prefix remains valid and only the notice itself is new input. The mid-run notice is a native `turn_end` boundary entry: it rides the request the run was about to make and never triggers an extra one. The text is deterministic for a given change. It carries labels, participant ids, and a working directory when that differs from the caller's, and no clock, run status, or model.
- **Once per change.** Fabric rebuilds what the model was told from the notices on the active branch, so resuming or navigating a session does not repeat one. A compaction may drop earlier notices from the context, so the current peers are stated again at the next boundary.
- **Departures are debounced.** A peer is reported gone only after it has been absent for 20 seconds, longer than the 15-second host lease, so a missed heartbeat or a wake from sleep is not reported as a departure and a rejoin. Arrivals are reported at once.
- **Scope.** Only root sessions receive notices. Child agents and actors are coordinated by their parent. A notice shares what the participant directory already shares: prompts, results, and errors stay local.

**Limitation:** a session joins the participant directory when its Fabric runtime activates, which is normally its first `fabric_exec` call. Before that it neither sees peers nor is seen by them, so the first notice of a fresh session arrives after that first call, before the next model request. A session that never runs `fabric_exec` stays invisible.

The notice is advisory. It does not lock files or block edits: use [`mesh.put` compare-and-swap claims](#durable-mesh-coordination), or give each session its own Git worktree, when two sessions must not touch the same files. Set `mesh.peerNotices` to `false` to turn notices off.

### Participant lifecycle subscriptions

Use durable, source-qualified subscriptions when one participant must respond to the Pi or run lifecycle of another participant. Subscriptions differ from `agents.status()` because the host manages them across turns. The model does not need to poll.

```ts
const [peer] = await agents.peers();
if (peer) {
  await agents.subscribe({
    from: peer.id,
    events: ["pi.agent_settled"],
    to: "main",
    delivery: "followUp",
    triggerTurn: true,
    once: true,
  });
}
```

`agents.subscribe` accepts an exact source participant ID. You can use `"main"` for the caller's root. Supply one or more lifecycle events and an optional target, which defaults to Main. Set a `steer` or `followUp` delivery mode, an explicit `triggerTurn` policy, and the optional `once` flag. Inspect routes with `agents.subscriptions()`, and remove one with `agents.unsubscribe({ id })`. A subscription starts at the current mesh sequence and does not replay earlier events. Its delivery cursor remains durable across host restarts. Delivery is at least once when a host crashes between inserting the target message and saving the cursor. Consumers can use the lifecycle event `id` to deduplicate side effects.

Pi events use these names: `pi.input`, `pi.agent_start`, `pi.agent_end`, `pi.turn_end`, `pi.agent_settled`, `pi.tool_error`, and `pi.session_compact`. Runner-neutral terminal events use `run.completed`, `run.failed`, `run.stopped`, and `run.timed_out`. Recovery events use `run.resumed` for a relaunched attempt after an unexpected stop, and `run.detached` for a run that outlived its caller's cancellation. The `tokens.usage` event provides bounded usage. The `component.state` event reports supervised component transitions. Lifecycle envelopes contain source identity and bounded operational metadata. They do not contain session transcripts.

A detached local `agents.spawn()` has a smaller convenience route. When `agents.notifyOnComplete` is enabled, terminal completion automatically sends Main a triggered follow-up. A call to `agents.wait()` makes the run foreground work and disables that detached notification.

For a code-owned typed alternative to a reasoning actor, use [Jev Main-turn observers](jev.md#main-turn-advisors-and-supervisors). They consume bounded selected event context with `program.nextEvent()`, work without mesh, and can explicitly opt into freshness-checked advice. They are session-owned Jev runs, not participant subscription targets.

## Persistent actors

`agents.create()` makes a named actor. The actor has a fixed runner, persistent runner session, serial mailbox, and optional subscriptions to parent-session events or durable mesh topics:

```ts
return agents.create({
  name: "auth-supervisor",
  instructions: `Watch the main session until the auth migration is complete and tested.
Prefer silence. Reply with a directive only for material drift, a blocker, or verified completion.`,
  events: ["agent_settled", "tool_error"],
  responseMode: "directive",
  delivery: "steer",
  triggerTurn: true,
  thinking: "high",
  tools: ["read", "grep", "find", "ls"],
  requires: ["memory.recall", { ref: "mcp.github.search", optional: true }],
});
```

A host-managed Claude actor uses the same mailbox and event interface. It keeps Claude Code context between activations:

```ts
return agents.create({
  name: "claude-reviewer",
  runner: "claude",
  model: "claude/haiku",
  instructions: "Review each delivered event and report only concrete regressions.",
  events: ["agent_settled", "tool_error"],
  responseMode: "directive",
  delivery: "steer",
  triggerTurn: false,
  tools: ["read", "grep", "find", "ls"],
});
```

Claude actors can keep context and use mapped Claude Code tools to inspect or edit. They consume host events and mesh messages that Fabric delivers, then return text or directives. They cannot directly call `fabric_exec`, `agents.*`, or `mesh.*`. Use a Pi actor when the actor must coordinate recursively through Fabric.

In a scoped session, every actor is bound to the principal that created it. Actor info reports `principal: { id, digest }`, and every turn, durable ones included, launches with that scope. Fabric delivers a message whose sender does not cover the actor's scope as untrusted data from a different or narrower principal, so a narrower session cannot borrow the actor's authority. An unscoped actor treats any scoped sender this way. See [principal and scope](providers.md#principal-and-scope) for the trust table.

### Shared actors and session bindings

A project-scoped actor stores one definition for the project. Select storage per actor with `agents.create({ scope: "project" | "session", ... })`; omitted scope uses `mesh.actorScope` as a compatibility default. Fabric keeps three pieces of state:

- **Project definition.** The shared registry stores the actor ID, instructions, runner, subscriptions, tools, and project model and thinking defaults.
- **Session binding.** A mode-`0600` file stores only `model` and `thinking` for one Pi session ID. It survives a resume of that session and does not rewrite `actors.json`.
- **Runtime.** One owner keeps the stable actor identity, serial mailbox, and runner session. Other sessions send direct work to that owner.

Fabric resolves each activation in this order:

```text
call override → session binding → project default → Fabric or runner default
```

```ts
// Change only this Pi session.
await agents.setModel({ id: actor.id, model: "anthropic/claude-sonnet-4-6" });
await agents.setThinking({ id: actor.id, thinking: "low" });

// Override one call without changing the session binding.
await agents.ask({
  id: actor.id,
  message: "Review the release diff.",
  model: "anthropic/claude-opus-4-6",
  thinking: "high",
});

// Change the shared project default. This requires the runtime owner.
await agents.setModel({
  id: actor.id,
  model: "anthropic/claude-sonnet-4-6",
  scope: "project",
});
```

Omit `model` or `thinking` to clear the selected layer. A cleared session binding inherits the project default. A cleared project default inherits Fabric or runner configuration.

`FabricActorInfo.model` and `thinking` show the effective values for the caller. `binding` shows the session layer. `projectDefaults` shows the shared definition layer.

Fabric stores the resolved binding on each mailbox item before it queues. Later binding changes cannot alter a running activation or an older queued item. `ask` waits for the owner to return a result. `tell`, `steer`, and `followUp` enqueue through the same owner. Pi and Claude actors both support these direct-call bindings.

The mailbox, history, and runner session remain shared. Host events and mesh subscriptions run once on the owner and use the owner's session binding. Opening another Pi session does not start another copy of the actor.

Use `scope: "session"` when one root Pi session needs its own definition, mailbox, history, and runtime; use `scope: "project"` for repository-wide guardians. Both run concurrently. Session identity propagates to recursive participant agents in the same lineage. Under project scope, every trusted session can read shared actor definitions, mailbox history, and logs. Do not store secrets in them.

Use `requires` to declare exact `provider.action` capabilities for every activation. An entry can use `{ ref, optional: true }`. Before launch, the host resolves and keeps one view identified by its descriptor hash. Pi children separately resolve the portable semantic digest. They run with a closed-world Fabric surface, so a live provider addition cannot expand the actor during a run. When required refs are missing, mailbox work stays queued. `missingCapabilities` reports which capabilities are available, separately from `idle | queued | running | stopped`. Changes to providers or catalogs retry dispatch. Actor status and run metadata include the normalized requirements and last committed digest. Claude actors receive the host availability commitment. They have no child Fabric surface to limit. If the private Claude session was removed, the next activation reports a clear failure and preserves actor context. Recreate the actor when you need a new Claude session.

This primitive supports emergent supervisors and advisors without another extension. Actors can observe all session-bound public Pi extension events. These include resource discovery; session start, info, switch, fork, compaction, tree, and shutdown events; input and before-agent-start; agent, turn, and message lifecycle; context and provider request or response lifecycle; tool call, result, and execution lifecycle; model and thinking changes; and user bash. Event names match the Pi extension names, such as `input`, `before_agent_start`, `tool_call`, and `tool_result`. Fabric also adds the synthetic `tool_error`. The only exception is `project_trust`, which fires before Fabric can read the trusted project actor registry. Actors only observe intercepting Pi hooks. An actor runs asynchronously and cannot block a tool, rewrite context, change provider headers, or return another extension hook result. Shutdown observations and observations during immediate session replacement are best effort because the owner runtime is shutting down.

Fabric sanitizes host-event JSON before placing it in the mailbox. The JSON includes a bounded snapshot of the recent session. Fabric redacts fields that resemble credentials and encoded blobs. Pi `ImageContent` blocks follow another path. Fabric replaces every persisted block with an indexed descriptor. It sends the raw image outside the mailbox with the transient activation and automatically submits it to the selected Pi or Claude actor model. There is no media opt-in flag because the explicit event subscription defines the trust boundary. Raw image bytes never enter `actors.json` or the actor mailbox record. The selected runner's persistent model session can retain images through its standard session behavior. Use `activation.signal.media` to read descriptor metadata for freshness predicates and correlation.

Actors handle one message at a time. By default, they coalesce repeated host events, which is useful for `message_update` and `tool_execution_update`. They restore from the trusted project actor registry.

### Native asynchronous vision handoff

A vision handoff does not require a separate extension that watches events. Create one persistent actor, select a multimodal model, and subscribe to `input`. Fabric automatically detects and attaches images from the prompt. Passive `steer` sends the description to Main without starting an unrelated idle turn. Set `coalesce: false` to preserve separate image prompts while the vision actor is busy:

```ts
return agents.create({
  name: "vision-handoff",
  instructions: `Inspect every attached image from the parent prompt.
Return { action: "silent" } when no image is attached.
Otherwise return { action: "message", message } with a precise, compact visual description
that Main can use without seeing the image. Do not answer the user's broader coding task.`,
  events: ["input"],
  runner: "pi",
  model: "provider/multimodal-model", // use a key from tools.models()
  responseMode: "directive",
  delivery: "steer",
  triggerTurn: false,
  coalesce: false,
  validWhile: ({ activation }) =>
    activation.kind !== "hostEvent" || (activation.signal?.media?.length ?? 0) > 0,
  tools: [],
  extensions: false,
});
```

`validWhile` removes input activations without images before a model run. Ordinary text prompts use no vision-agent inference. The actor persists. Dispatch stays asynchronous. Main never waits for the visual description during its current inference. Subscribe to `before_agent_start` when the actor needs Pi's expanded prompt or system context. A subscription to both events creates two activations for one user prompt.

`validWhile` supplies a programmable freshness guard for persistent actors. Fabric serializes the source of its pure synchronous function. It checks the function before starting queued work and before delivering completed work. Fabric also stores it with project actors and global templates. The immutable `activation` fact describes a `hostEvent`, `direct`, or `mesh` activation. The `current` object contains `latestActivationSequence`, `mainRevision`, `taskRevision`, `idle`, and `now`. Main revisions increase after completed tools and lifecycle events. A tool-error review can become stale after Main recovers. Return `false` or `{ valid: false, reason? }` to discard stale work. Fabric records invalidated fire-and-forget work as a silent stale outbox entry. An invalidated `agents.ask()` rejects. Predicates must be synchronous. They cannot call tools or use closures because their source must run after restoration.

```ts
return agents.create({
  name: "fresh-reviewer",
  instructions: "Review only the latest useful parent-session event.",
  events: ["tool_error", "agent_settled"],
  responseMode: "directive",
  delivery: "steer",
  triggerTurn: false,
  validWhile: ({ activation, current }) => {
    if (activation.kind !== "hostEvent") return true;
    if (activation.sequence !== current.latestActivationSequence) {
      return { valid: false, reason: "a newer activation exists" };
    }
    if (activation.event === "tool_error") {
      const signal = JSON.stringify(activation.signal ?? {});
      const incidental = /ENOENT|no matches found|exit code 1/i.test(signal);
      if (incidental && activation.mainRevision !== current.mainRevision) return false;
    }
    return activation.taskRevision === current.taskRevision;
  },
});
```

Pi actors keep model context in a Fabric-owned Pi session file. Claude actors keep the session ID returned by the official CLI and use `--resume <id>` after the first message. Every activation reapplies tools, permissions, schema, and system-prompt flags. Fabric also stores a runner-neutral stream transcript. `thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` and uses the precedence described above. In the dashboard, `e` changes this session and `E` changes the project default. The persisted `tools` array is an allowlist. Set it during creation, replace it with `agents.setTools({ id, tools })`, or press `o` in the dashboard. An empty array disables optional tools. Pi actors keep the host-required `fabric_exec` capability for mailbox and mesh coordination unless you create them with `extensions: false`. This setting removes Fabric from a Pi actor. Its activation then runs without `fabric_exec`, `agents.*`, or `mesh.*`. The host continues to manage its mailbox and delivery. The setting alone does not make the actor read-only because `tools` still defaults to `agents.defaultTools`. Also set `tools: ["read", "grep", "find", "ls"]` for a read-only persistent actor. Use `tools: []` for an actor without tools.

### Response modes and delivery

Choose one of these response modes:

- With `text`, each non-empty response becomes an actor outbox message.
- With `directive`, validated output in the form `{ action: "silent" | "message" | "stop", message?, data? }` lets the actor choose whether to intervene.

Delivery can stay in `mailbox` or enter the main session through `steer`, `followUp`, or `nextTurn`. For `steer` and `followUp`, explicitly set `triggerTurn: true | false`. A value of `true` starts Main when it is idle. A value of `false` is passive, and Fabric labels it as unable to start Main. The `mailbox` and `nextTurn` modes never start Main, so they reject `triggerTurn: true`. This policy keeps a delivered actor message from looking like a stalled continuation. Fabric applies no extra 8,000-character truncation to local actor or agent messages sent to Main. Standard limits for model context, providers, and cross-mesh event size still apply.

The actor cannot change delivery from its response. The owner can update a live actor or global template and keep its history:

```ts
await agents.setDeliveryPolicy({
  id: actor.id,
  delivery: "steer",
  triggerTurn: true,
});
```

Set `scope: "global"` to update a reusable template. In the dashboard, press `y` on an actor or template, then choose mailbox, steer, follow-up, or next-turn delivery. Lowercase `m` and `e` change this Pi session. Uppercase `M` and `E` change the owner-gated project defaults. These changes keep the Pi or Claude runner session. Use `agents.ask()` for a blocking exchange and `agents.tell()` for fire-and-forget mail. Both accept one-activation `model` and `thinking` overrides. Read shared history with `agents.messages()`. `agents.remove()` is local-owner-only for session actors and routes durable actors to the resident owner.

## Paged agent logs

`agents.log()` reads bounded pages from JSONL logs. It does not load the full file. The first call returns the newest entries. If `hasMore` is true, pass the returned `before` cursor to load the next older page. For an actor session, use `sessionHasMore` and `sessionBefore`:

```ts
const newest = await agents.log({ id, type: "run", lines: 100 });
if ("before" in newest && newest.hasMore) {
  const older = await agents.log({ id, type: "run", lines: 100, before: newest.before });
  return older;
}
return newest;
```

The `offset` values on log lines and all page cursors are byte offsets in the JSONL file.

## Global actor templates

Persistent actors belong to a project mesh. If you want to reuse a persona in several projects, store it in the project-independent **template library**. This library is in your agent directory at `~/.pi/agent/fabric/actors/`. A template contains only an actor definition, including its name, instructions, subscriptions, and run settings. It contains no mailbox, session transcript, run logs, or other history. Templates are inactive. Import one into a project to run it.

```ts
// Store a reusable persona in the global registry. This does not create a live actor.
return agents.create({
  name: "security-reviewer",
  instructions: "Review changes for security defects. Reply with a directive only for material drift.",
  events: ["agent_settled"],
  responseMode: "directive",
  scope: "global",
});

// List the templates. Then create a new actor from one in the current project.
const [template] = agents.actors({ scope: "global" });
return agents.import({ name: template.name });                       // create it without inherited history
return agents.import({ name: "security-reviewer", as: "security-reviewer-2" }); // rename it if the name exists

// Copy a tuned project actor to the global library without its history.
return agents.export({ id: actorId, overwrite: true });

// Change the default instruction and continuation policy of a template.
await agents.setInstructions({ id: template.id, instructions: "Be brief.", scope: "global" });
return agents.setDeliveryPolicy({
  id: template.id,
  delivery: "steer",
  triggerTurn: false,
  scope: "global",
});
```

`agents.setInstructions` can also change a live project actor. Its default scope is `"project"`. The new instruction applies to the next queued actor message. Only definitions cross the project⇄global boundary. Import and export never move history. Slash commands provide the same operations. `/fabric global` lists templates. `/fabric import <name> [as <new>]` creates one in the project. `/fabric export <id> [--overwrite]` promotes a project actor. The dashboard shows global templates with live actors. From there, you can import, export, delete, edit instructions, and change delivery policy without code. Existing persisted actors and templates continue to load as passive. New active delivery definitions must explicitly set `triggerTurn`.

## Councils

```ts
return council.run({
  task: "Review the current implementation and recommend whether it is ready to merge.",
  roles: ["correctness reviewer", "security reviewer", "test reviewer"],
  transport: "localterm",
  synthesize: true,
});
```

Council members run at the same time under the global agent semaphore. When `synthesize: true`, a final child agent combines their reports. See [`/skill:fabric-council`](../skillsets/typescript/fabric-council/SKILL.md).

## Recursive queries

```ts
return rlm.query({
  runner: "pi",
  task: "Recursively decompose this repository and produce a compact architecture map.",
  transport: "process",
});
```

`rlm.query()` calls `agents.run({ runner: "pi-durable", recursive: true })` by default (an explicit `runner: "pi"` uses the legacy worker) with Fabric enabled in the child; it accepts `cwd?: string` and `worktree?: boolean`, just like one-shot agent runs. Recursive spawning means Fabric agent composition, not recursive filesystem traversal. Fabric rejects Claude runners for recursive use. It also rejects recursion at `agents.maxDepth`. This setting accepts any non-negative safe integer, and `0` disables child spawning. Approval for the initial recursive call delegates only the `agent` risk capability to recursive children. It does not delegate approvals for network access, execution, or writes. Each Fabric process applies its own configured concurrency and timeout limits. When `agents.budgetUsd` is set, a shared append-only cost ledger limits total spending across the recursion tree. Each node writes the cost of its children to one ledger file that it receives through the environment. A node rejects a new child when accumulated spending reaches the budget. This check is best effort. Concurrent children can pass the check before another child records cost, so the tree can exceed the limit slightly. Use `agents.maxPerExecution` as the race-free ceiling. Results and live status for each recursive child include a `budget` summary with `limit`, `spent`, `remaining`, and `tokens`. Fabric keeps the latest bounded nested-agent status tree in memory. Session-owned nested agents stop when their owning Pi child exits; a detached spawn does not outlive that owner. The child manager leaves nested status and transcript files with the enclosing run so completed leaves remain inspectable in **Topology · Run** and `/fabric chat`. The enclosing run's cleanup, retention, or root-session shutdown removes those artifacts. Every terminal path refreshes the nested tree. A descendant without a retained terminal result is shown as failed with an owner-ended diagnostic, not indefinitely running; Fabric does not invent a successful result or rewrite the worker's status file. Independently durable descendants retain their own lifecycle. Fabric releases the snapshot when the parent run is cleaned up or the Fabric session shuts down.

`agents.maxTokensPerChild` limits cumulative token use for each child. Its default value, `0`, disables the limit. The wall-clock `timeoutMs` limits time, and `budgetUsd` limits cost. This limit caps the context of one runaway child before the host session compacts. Fabric stops the child with the same `timed_out` status and a `token limit` error. See [`/skill:fabric-rlm`](../skillsets/typescript/fabric-rlm/SKILL.md).

## Durable mesh coordination

The `mesh` API provides project-scoped, event-sourced coordination:

```ts
const event = await mesh.publish({
  topic: "team.auth",
  kind: "finding",
  text: "Refresh-token rotation is not atomic",
  data: { path: "src/auth/refresh.ts" },
});

const task = await mesh.put({
  key: "tasks/auth-review",
  value: { status: "ready", owner: null },
  ifVersion: 0,
});

const claimed = await mesh.put({
  key: task.key,
  value: { status: "claimed", owner: "security-reviewer" },
  ifVersion: task.version,
});
return { event, claimed };
```

Topics provide durable channels and direct messages with sequence cursors. `mesh.members({ scope?, kinds? })` returns the same combined directory of roots, agents, and actors as `agents.members()`. Versioned `get`, `put`, and `delete` operations provide compare-and-swap state for task claims, leases, reservations, and decisions. You can combine these operations with persistent actors to implement messenger-style swarms in Fabric code. Messenger-style swarms need no fixed planner and worker roles or user-managed daemon. When guest code requests durable residency, Fabric starts the hidden resident host described earlier. See [`/skill:fabric-swarm`](../skillsets/typescript/fabric-swarm/SKILL.md) for the pattern and [`references/mesh.md`](../skillsets/typescript/fabric-exec/references/mesh.md) for the complete API.

Each event carries a host-set `sender` with the publishing session's authority: `{ authority: "host" }` when unscoped, or its principal and scope digest. A scheduled event keeps the stamp from scheduling time. Events from older builds and grant posts have none. Actors use the stamp for the [principal trust rule](providers.md#principal-and-scope).

A headless resident host can also be woken by time and by an outside process. Both primitives are small: recurrence, retries and routing stay in actor code.

### Scheduled events

```ts
const pending = await mesh.publish({
  topic: "jobs.nightly",
  kind: "tick",
  notBefore: "2030-01-01T02:00:00Z", // or epoch ms, or afterMs: 3_600_000
  key: "nightly",                    // optional: replace or cancel by key
});
await mesh.unschedule({ key: "nightly" });       // { removed: boolean }
return await mesh.scheduled({ topic: "jobs.nightly" });
```

- `notBefore` (epoch milliseconds or an ISO 8601 date-time) or `afterMs` stores the event as a pending schedule and returns it with `scheduled: true`. A due time in the past is appended at once. Due times may be at most 366 days ahead, and a mesh root holds at most 1000 pending schedules.
- `key` (at most 128 characters) makes a schedule replaceable: publishing again with the same key replaces the pending one in the same locked write, so concurrent publishers never leave two. `mesh.unschedule({ key })` cancels it. `mesh.scheduled({ topic?, limit? })` lists pending schedules by due time; it is a read and is speculation-eligible.
- Release: whichever Fabric process polls the mesh first after the due time appends the event, under the mesh store lock, so two releasers cannot append it twice. Every actor mesh monitor checks for due schedules on each poll and arms a timer to the next due time; `mesh.publish`, `mesh.read` and `pi-fabric mesh post` release due schedules too. The released event keeps the schedule's id as its event id and carries `scheduled: { dueAt, key? }`. Fabric appends the events before it shrinks the schedule file, so a crash between those two writes re-appends with the same id: consumers that must be exactly-once deduplicate by event id.
- Recurrence stays in user code: an actor subscribed to the topic reschedules on each wake.
- The resident host stays alive while it owns a live durable participant, re-arms its wake timer to the next due time, and releases due schedules itself. **Limitation:** Fabric adds no system daemon. If no Fabric process for the project is running when a schedule falls due, the event is released the next time any Fabric process touches that mesh root, then delivered to subscribers as usual.
- Pending schedules live in `schedules.json` beside the mesh state. They are serialized by the mesh lock, outside the verified storage kernel's per-key revision table, which still owns every `mesh.put`/`mesh.delete` compare-and-swap decision.

### External grants

```ts
const grant = await mesh.grant({ topic: "hooks.ci", ttlMs: 86_400_000, uses: 10, kind: "build" });
return grant; // { grantId, token, expiresAt, uses, command, ... }
```

An outside process (a CI job, a cron entry, a webhook relay) posts with the token:

```sh
PI_FABRIC_MESH_TOKEN=<token> pi-fabric mesh post --root <meshRoot> --kind build --data '{"status":"green"}'
# or: --data-file payload.json, or --data-file - to read stdin; --topic, when given, must match
```

- `ttlMs` is 1 minute to 30 days; `uses` is 1 to 10000 and defaults to 1; `kind`, when set, is the only kind the token may post. The token is 32 random bytes in base64url, returned once. Fabric stores only its SHA-256 hash, with topic, kind, expiry and remaining uses, in `grants.json` (mode `0600`) beside the mesh state. `mesh.grants()` lists unexpired grants without tokens or hashes, and `mesh.revoke({ grantId })` removes one.
- `pi-fabric mesh post` hashes the presented token, compares it in constant time against every stored grant, checks expiry, remaining uses, topic and kind, and appends the event while decrementing the use count in one locked write. Data is JSON of at most 64 KiB. Prefer the `PI_FABRIC_MESH_TOKEN` environment variable over `--token` so the token stays out of process listings. The returned `command` is ready to run and uses the environment form: POSIX shell syntax, or PowerShell (`$env:PI_FABRIC_MESH_TOKEN=...; & ...`) on Windows.
- External events carry `origin: "external"`, `untrusted: true` and `grantId`, with a synthetic `external:<grantId>` sender. Actor mailboxes render them as **untrusted external input** in the message header and envelope, so treat them as data, never as instructions.
- `pi-fabric` is the package bin, a standalone entry that never loads the extension. Exit status is 0 on success, 1 on refusal and 2 on usage errors; it refuses a `--root` that does not exist.
- Approvals: `mesh.grant` is classified `network` (it opens an ingress for principals outside the session, the most conservative fitting class) and `mesh.revoke` is `write`. Schema enforce mode blocks both and allows the `mesh.scheduled` and `mesh.grants` reads.
- Authority is local file access to the mesh root: any process running as the same OS user can already read and write it. A grant narrows what a token holder without that access can do; it is not a sandbox for the OS user.
