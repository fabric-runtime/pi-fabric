# Agents and recursive queries — Python

Use native dictionaries and await host methods. Every call accepts one dictionary or keyword arguments. Discover exact optional fields with `await tools.describe(ref="agents.run")`. Advanced workflows are user-invoked; never load `/skill:fabric-council` or other advanced skills autonomously. All references in this tree target Python; sibling [mesh.md](mesh.md) covers coordination.

## One-shot children

`agents.wait(id=...)` is canonical; `agents.join(id=...)` is its alias with the same arguments, result, progress, and detached-completion notification behavior. Jev likewise uses canonical `jev.wait` and alias `jev.join` through `tools.call`.

`agents.run` returns a dictionary with id, runner, optional kernel, status, text, optional value/error, usage, turns, toolCalls and runnerSessionId. Check `status == "completed"` before relying on text/value; a returned failure status does not raise automatically. Structured schema output is in `value`.

```python
result = await agents.run(name="security-review", task="Review the current diff for concrete security defects. Do not edit files.", tools=["read", "grep", "find", "ls"])
return {"status": result["status"], "text": result["text"], "error": result.get("error")}
```

Request fields include task, name, runner, kernel, transport, model, persona, thinking, thinkingBounds, tools, timeoutMs, extensions, recursive, cwd, worktree, worktreeSetup, seed, seedMessages, readOnly, writableRoots, shell, scope, schema, systemPrompt. Omit timeoutMs normally; per-call values below the configured agent timeout floor are ignored. Use top-level agentBudget for bounded calls; the Python guest has no callback-helper tokenBudget API. Host concurrency and settled-usage checks still apply.

- Pi children inherit Python and its configured backend, including recursive and alternate-cwd launches. Explicit child kernel selection changes only the child, never this invocation. Claude/Veda and extensions=False reject concrete Fabric kernels; omitted/inherit leaves their harness native. Do not hop interpreters to run this program.
- `runner` defaults to configured policy; Pi, Claude, and Veda are available. Only Pi supports recursion. Veda persona/model follow its backend; Claude keys come from `await agents.models(runner="claude")`. Extensions may register more runner ids; requests needing an undeclared runner capability fail before launch. `outcome == "indeterminate"` means Fabric cannot confirm the work ran and never retries it; inspect before re-running.
- `systemPrompt` is appended to the child's system prompt (Veda gets it as a `<system_instructions>` block); blank is ignored and durable spawn refuses it.
- Pi models must resolve in the owner's visible registry. `await tools.models()` lists Pi models; `agents.models` uses the requested or configured runner. Use canonical keys; report unresolved/ambiguous choices rather than guessing.
- `tools` is a native allowlist, inherited by nested calls for extension-enabled full-code Pi children. Claude maps supported core tools to its native names. `extensions=False` disables Fabric, not ordinary tools.
- `cwd` is a real directory, relative to the caller or absolute; symlinks canonicalize. Invalid/non-directory paths fail without fallback. Recursive Pi requests accept cwd too (`agents.run(..., runner="pi", recursive=True, cwd="../other")`). Omission inherits the immediate caller’s effective directory. Project/mesh lineage and kernel/backend inheritance stay with the caller; cwd does not grant project trust, and Pi evaluates the actual target/worktree path under its own rules. Descendant tools are intersected with the inherited optional-tool allowlist, including durable transfer. Cwd is not filesystem isolation.
- `worktree=True` creates a retained dedicated Git worktree in the selected repository. Verify canonical repository identity, never infer it from directory naming. Abort with zero changes on mismatch. Partition concurrent edit ownership; never edit shared files concurrently. Inspect and stop active work before cleanup; leave unrelated worktrees alone.
- With `worktree=True` the result has `worktreeResult` (`path`, `branch`, `baseRef`, sorted `changedFiles` ≤500, `diffstat` files/insertions/deletions, `kept`, optional `diffError`); `worktree` stays the path. `worktreeSetup="bun install"` (or config `agents.worktree.setup`) runs in the new worktree first; non-zero exit fails the launch.
- `seed` (Pi only): `"task"` default; `"branch"` forks this conversation up to its last completed turn without blocking the caller (not durable); `"snippet"` prefixes the last `seedMessages` (1-50, default 12) user/assistant texts.
- Write confinement (Pi only): `readOnly=True` refuses write/edit; `writableRoots=["src"]` (≤32, relative to the child cwd, default the cwd) confines them. Any policy refuses bash unless `shell="unconfined"` (not a sandbox); CPython and node/bun-process executors are refused unless unconfined. Nested children only narrow; Claude/Veda and durable spawns fail under a policy.
- `scope={"grants": [{"resource": "fs:/repo/src/**", "actions": ["read"]}]}` narrows a host-issued scope for the child; each grant must be covered by one parent grant (`/*` one level, `/**` any depth, `<ns>:*` all). Omitted inherits it. Refused in an unscoped session. Durable spawns and actors keep the scope; each actor is bound to its creating principal, and messages from a sender that does not cover it arrive marked untrusted. Programs never set a principal.
- Children may read `PI_FABRIC_LINEAGE` (also `(await agents.self())["lineage"]`), `PI_FABRIC_WRITE_POLICY`, `PI_FABRIC_SCOPE`, `PI_FABRIC_THINKING_BOUNDS`, `PI_FABRIC_DEPTH`, and `PI_FABRIC_AGENT_NAME`; other `PI_FABRIC_*` variables are internal.
- `schema` requests validated structured output. `thinking` is configured/clamped reasoning effort; with `thinking.bounds` configured a clamped run reports `requestedThinking`. `thinkingBounds={"min": ..., "max": ...}` narrows the child's bounds and must lie inside the caller's bounds.

`agents.spawn` returns a handle; `wait`, `status`, `stop`, and `cleanup` take its id. Unread detached results are batched after the current tool turn, or wake idle Main once; concise UI notices appear immediately. `wait`/`join` and terminal `status` acknowledge results and retract pending notifications, even after completion. Running status and UI/list polling do not acknowledge them. Return the relevant outcome to Main from your program; prefer `wait` over status polling. Escape/error parks results until new input. `residency="durable"` is a spawn-only opt-in to outlive Main, requiring trusted mesh and no Schema enforce; unread deliveries and acknowledgments survive reconnects.

```python
handle = await agents.spawn(task="Map the persistence layer.", tools=["read", "grep", "find", "ls"])
return await agents.wait(id=handle["id"])
```

`agents.list(scope="local")` lists local children; lineage/project include federated participants. Peer is reserved for another root Pi session: query `await agents.peers()` first, not children. A `<fabric-peers>` transcript message is a host notice (not a user request) listing the other root sessions sharing this project's files by label and participant id, sent only when that set changes; pass a listed id to `agents.steer` to coordinate. `agents.self`, `members`, and `main` expose participant identity and capabilities. Cross-process steer/followUp/stop route through the authenticated owner and return after acknowledgment; do not publish control topics yourself. If the owner restarted, an unexecuted command fails with "targets a previous owner incarnation"; Fabric does not retry, so re-read the participant and resend only if still wanted. Prefer steering useful running children over destroying their context. Check status before steering a finished child. Provider-registered work appears as `kind="provider"` members with ids `provider:<provider>:<id>`; `agents.stop`, `steer`, and `followUp` accept those ids and call the provider (stop returns `{"ref", "outcome": "confirmed" | "unconfirmed"}`). Cancelling or timing out a program stops the non-detached provider work it started.

## Lifecycle subscriptions

`agents.subscribe` takes exact from/to participant ids (`main` aliases the caller's root), events, delivery (steer/followUp), explicit triggerTurn, and optional once. subscriptions/unsubscribe list and remove routes. Events include pi.input, pi.agent_start, pi.agent_end, pi.turn_end, pi.agent_settled, pi.tool_error, pi.session_compact, and runner-neutral run.completed/failed/stopped/timed_out. pi.agent_settled means no retries/queued continuations remain, not permanent termination. Subscriptions start at the current cursor; crash recovery is at-least-once, so deduplicate effects by event id.

```python
peers = await agents.peers()
if not peers:
    return {"subscribed": False}
return await agents.subscribe({"from": peers[0]["id"], "events": ["pi.agent_settled"], "to": "main", "delivery": "followUp", "triggerTurn": True, "once": True})
```

## Persistent actors

`agents.create` returns an actor dictionary; runner and resolved kernel are fixed at creation. Pi actors are Fabric-equipped; native Claude actors use their own tools while the host manages mailboxes/events. Use `ask` for a blocking reply or `tell` for asynchronous mail. Neither switches the actor kernel. Durable residency requires trusted mesh and is unavailable in Schema enforce. Actor state can be session/private or project-shared; the authenticated owner serializes activations.

```python
return await agents.create(name="auth-supervisor", instructions="Watch until the auth migration is complete and tested. Prefer silence; emit a directive only for material drift, blockers, or verified completion.", events=["agent_settled", "tool_error"], responseMode="directive", delivery="steer", triggerTurn=True, coalesce=True, tools=["read", "grep", "find", "ls"])
```

- `responseMode="directive"` validates action silent/message/stop. `delivery` is mailbox/steer/followUp/nextTurn. Steer/followUp require explicit triggerTurn; mailbox/nextTurn reject True. Actors cannot escalate delivery themselves.
- `events` observe public Pi lifecycle events asynchronously; synthetic tool_error is supported. Observers cannot block/mutate the originating event. Host event images attach automatically, with credential-shaped fields redacted from persisted envelopes. Topics subscribe to durable mesh channels.
- `coalesce` defaults on. Native tool allowlists persist; an empty list disables optional tools, not Pi's host-required fabric_exec when extensions remain enabled.
- `setInstructions`, `setTools`, `setEvents`, `setDeliveryPolicy` update future activations. Model/thinking use per-call override → session binding → project default → configured default. `setModel`/`setThinking` default to session scope; project defaults require owner authority.
- `actors`, `actorStatus`, `messages`, and `log` inspect state/history. `remove` deletes through the owner. Use discovered schemas for scope and bounded history options; avoid transcript dumps.
- Python must not supply guest callback predicates (`validWhile`, handoff predicates); those are not native Python host-call functions. Use supported host fields and explicit checks instead.

## Recursive work and handoff

Use `await agents.run(task="...", runner="pi", recursive=True)` only for oversized context; plain children handle bounded leaves. Host maxDepth (0 disables spawning), approvals, concurrency, and budget limits remain active. Recursion delegates agent risk only, not filesystem/network/execute permissions. Keep durable context in mesh keys or project-relative files plus digests, not whole-corpus child prompts.

`agents.handoff` without a predicate schedules an explicit Pi-to-Pi trajectory handoff at the completed outer fabric_exec boundary; later calls in the program still run. It is not a subroutine result. Use host schemas and a canonical target model; no Python guest predicate callbacks. Preserve successful effects rather than retrying the original program blindly.

A running trajectory executor may receive one hidden `pi-fabric-handoff-continuation` after a failed nested handoff. Finish the original assignment directly in the same workspace, preserve completed work, and verify the remainder instead of returning only a failure report. Do not retry delegation, spawn a replacement, or raise limits. Fabric cancels the local Prewalk arm and preserves the failed boundary, original deadline, permissions, and token accounting. Explicit stops, cancellation, timeouts, and token-limit termination stay terminal. Main continues to report terminal failures and propose a next step; it does not take over unprompted.
