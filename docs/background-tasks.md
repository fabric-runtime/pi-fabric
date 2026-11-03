# Background tasks and monitors

Fabric-managed `pi.bash` and `pi.powershell` commands have session-owned job IDs.
`background: true`, the shell hang threshold, or Ctrl+B twice detaches a command;
an explicit shell `timeout` remains a hard cap. A foreground shell shows the
shortcut while it waits, including while output streams; the first keypress prompts
for confirmation.
Completed jobs have terminal states
(`exited`, `failed`, `killed`, `timed_out`), not the old `spilled` state. `exited`
means exit code zero, not that the user's assignment is verified.

```ts
const result = await pi.bash({cmd: "bun run build", background: true, description: "Build bundle"});
return result; // details.taskId, pid, logPath when detached
```

`background: true` and `durable: true` always return the task, even when the
command ran only briefly. When it has already ended, `details.running` is `false` and the
notice gives its exit code. A command that never started fails the call.

Completion sends a bounded, batched automated event to the **owning Pi session**.
The same mechanism works inside a Fabric-enabled child: it does not route child
shell output directly into the parent's Main. No LLM is used to wait for a process.
Events are outcomes, not user input or approval. Idle wakeups do not compete with
already queued messages. Aborted/error turns suspend wakeups until new user input;
branch navigation discards delivery from old-frontier jobs. Session shutdown/reload
closes the inbox before aborting jobs, so cleanup cannot start a new turn.
Print-mode processes do not stay alive indefinitely just to receive late events.

## Background programs

A whole `fabric_exec` program can leave its tool call the same way. Pi delivers
a steering message to Main only after the current tool calls finish, so while a
long workflow runs inside one `fabric_exec`, a message typed to Main waits for
every agent in it. Moving the program to the background ends that tool call and
Main takes the steer on its next request.

- **Ctrl+B twice** within one second, from an empty editor, while a
  `fabric_exec` runs. A nested shell that is still waiting is spilled first, as
  before; press the chord again to move the program. With text in the editor,
  Ctrl+B stays cursor-left.
- **`/fabric background`** moves the whole running workflow to the background
  directly, even when a nested shell is still waiting. Extension commands are
  handled before queued chat input. It does not stop or restart any work. This
  command applies to all currently running foreground Fabric programs; the
  existing Ctrl+B chord remains shell-first.
- **`background: true`** on the `fabric_exec` call starts the program as a task
  and returns at once. Long workflows can keep necessary shell/agent awaits
  inside the background program even when their results are required for the
  assignment. Main should continue independent work or yield for completion,
  not immediately open another foreground wait. Yielding is not task completion.

The tool call returns the task ID. The program keeps running with its own
cancellation signal: Esc and later turns no longer stop it, and `tasks.stop`,
the task detail's `x`, or session shutdown do (stopping also stops the child
agents it owns). Its child agents stay steerable through `agents.steer`,
`/fabric chat`, or the agent list. Progress lines and the final result go to
the task's bounded log; the result reaches the owning agent as a background
task event, bounded to about 6,000 characters, with the same batching, wakeup,
and suspension rules as shell tasks. The live-task reminder lists running
programs. A background program never claims a Prewalk handoff, and the shell
timing bridge below does not report programs.

Main and a background program can edit the same files at the same time. Detach
only work whose files Main will not touch, or tell Main what it should leave
alone.

## Extension timing bridge

Fabric emits `pi-fabric:shell:timing:v1` on the owning session's `pi.events` bus.
`FABRIC_SHELL_TIMING_EVENT` and `FabricShellTimingV1` are exported from
`pi-fabric/protocol`; optional consumers may mirror the contract without importing
Fabric. The payload contains only:

```ts
{ version: 1, sessionId, taskId, tool: "bash" | "powershell",
  phase: "started" | "finished", timestamp }
```

`started` is emitted synchronously at background handoff (explicit, hang threshold,
manual, or monitor), not process creation. `finished` is emitted at terminal
observation for any outcome, or before runtime teardown closes the job store.
Timestamps are observation times in epoch milliseconds, not backdated process
start/exit times. Foreground-only jobs emit neither event. No command, output,
path, credentials, or model message is included. Acknowledgements and output
monitor batches do not change timing, and UI-only jobs are included.

Consumers must filter by session, deduplicate task transitions, and union these
intervals with foreground tool calls without adding full job durations to
already-metered calls. pi-ledger records only the additional background union as
agent tool time, including between turns. No polling, model wakeup, or new setting
is involved. Shutdown/reload closes live spans; processes and clocks are not
restored on restart. Billing consumers should also flush at their own shutdown
before sealing their log, regardless of extension shutdown order.

## Agent awareness and yielding

When a task moves to the background, Fabric appends one note to the result of
the tool call that spilled it, independently of the returned `fabric_exec`
value. Even if a program discards the nested shell result, the owning agent can
see that work is running. Tasks spilled by one call share one note, which
includes at most eight task IDs and short, quoted labels, with an omitted count
for additional jobs, and never elapsed time or process output. The note
**never triggers a turn** itself.

The note records a moment and is never edited or retracted; later task events
report each outcome in transcript order. Fabric does not rewrite requests for
awareness, so each request extends the previous one and the provider's prompt
cache keeps hitting while tasks run. A reminder projected at the end of every
request would be missing from the next request in that position, which caps
the cached prefix at the last request without it. The note lives in an ordinary
tool result, not a custom message, because Pi rebuilds custom-message objects
on every refresh and its idle cache warmer, which compares objects by identity,
then treats the conversation as changed. After compaction, which replaces the
prefix anyway, Fabric restates still-running tasks on the next tool result.

For ordinary detached commands and wake-enabled monitors, it tells the agent to
continue independent work or **end the turn if it needs their results**. Completion
(or a matching monitor event) can resume the owning agent; polling and sleep loops
are unnecessary. UI-only monitors are explicitly marked **no automatic wakeup**,
including on completion, so the agent must not yield expecting them to resume it.
Pending required results are not evidence that the assignment is complete.

Foreground jobs, jobs that end before the next tool result, abandoned-branch
jobs, and durable tasks reattached after a restart are not announced; the
process that spilled a reattached task already wrote its note. A note stays on
its own branch of the session tree. Reload/session shutdown closes the inbox.
Awareness works without a terminal and does not restore processes across Pi
restarts.

### Prompt-cache warming while yielded

Spilling ends the tool call, so the agent run settles and Pi's cache warmer moves
to its idle phase. Pi prices idle refreshes with a fixed low continuation
probability, because an idle session usually waits on a person. While a
spilled job whose completion wakes this agent is still running, the next real
request is near-certain. The inbox handles Pi's `cache_warming_decision` and,
only when Pi chose `stop` in the idle phase, re-prices that refresh at
probability 1 against Pi's own $0.05 savings threshold, returning `warm` if it
clears.

It never downgrades `warm` or touches streaming-phase decisions, and counts the
same jobs as the reminder above minus UI-only monitors. Refreshes are ordinary
paid `cache_warm` usage, not a guarantee of a cache hit or net savings. Fabric
neither changes Pi's warming setting nor bypasses native request eligibility.

To opt in, merge these fields into Pi's **global** `~/.pi/agent/settings.json`
(or the settings file under your custom Pi agent directory), not project settings:

```json
{
  "cacheWarming": "idle",
  "showCacheMissNotices": true
}
```

`showCacheMissNotices` is optional diagnostics. Restart Pi after a file edit and
send a new real request; changing the policy cannot revive an already stopped
warmer or recover a cache entry that has expired. Pi's default `"streaming"` mode
stops warming when the run settles, before any extension is asked. `"off"`
remains off. No extra Fabric setting or `cache.hold` call is required for this
idle-decision override; scoped leases are a separate optional capability.

For the five-minute cache tier, Pi's first refresh is due at 270 seconds after
the real request. Fabric's default 120-second shell spill can settle the run
before then, which explains why streaming warming records no refresh while the
agent waits. With idle warming enabled, `/session` shows the native warming
state/decision; successful refreshes appear as `cache_warm` usage, and
`cache.status()` exposes their receipts in its bounded observation window.
A missing receipt alone does not prove a cache miss: small prompts, unsupported
models, unsafe replays, changed context, or expired refresh deadlines can prevent
warming.

Pi's 30-minute idle safety horizon still applies, measured from the real request
that started warming, **not** from spill or the latest refresh. Jobs may outlast
both warming and the cache TTL; this patch does not keep them warm indefinitely.
`tests/shell-cache-warming-sdk.test.ts` exercises native scheduling, replay,
receipts, completion wakeup, default/off/UI-only exclusions, and the safety
horizon with an offline provider; it does not measure live-provider cache hits.

## Inspection and control

- Focus the footer list with **↓** from an empty editor or `/fabric tasks`, then
  press **Enter** on a task to open its lazy detail.
  `/fabric tasks <id-or-unique-prefix>` opens a specific task directly.
- The footer lists tasks individually after agents, with elapsed time and the
  command or short description. It stays alive after the Fabric program returns.
  Completion hints expire after 30 seconds; retained jobs remain inspectable by ID.
- The rounded, theme-aware detail shows one task. Live tasks use Fabric's
  activity spinner; completed tasks have fixed status icons. There is no
  secondary task-list overlay or global task-list shortcut.
- Arrows/PageUp/PageDown scroll the bounded output tail; G follows the tail;
  x twice within three seconds stops; Esc closes the detail in one step.
- Elapsed time and time since last output are separate. A quiet shell is not
  automatically classified as stuck. Opening/closing the inspector doesn't stop it.
- `ui.enabled` and `ui.widget` retain their existing meaning. Rendering is TUI-only;
  task tools and notifications do not require a terminal.

Tasks are a discoverable provider, **not a new sandbox global**:

```ts
return await tools.call({ref: "tasks.list", args: {}});
return await tools.call({ref: "tasks.get", args: {id: taskId}});
return await tools.call({ref: "tasks.stop", args: {id: taskId}});
```

`get` returns metadata and an 8KB output tail and acknowledges pending agent delivery.
`stop` targets a stored job's abort controller, never an arbitrary or recycled PID.
Stopping a task does not wake the agent. Tasks are local to this runtime; IDs and
live processes are not restored across Pi restarts, except
[durable tasks](#durable-tasks-through-jev-fabric). Up to 256 completed handles
are retained for at most 24 hours. Logs use Fabric's private scratch retention.
The 1MiB in-memory tail and 8MiB disk log limits remain unchanged: a log is **not a
full-output archive**, and truncation is disclosed.

## Programmatic wait and watch

For a bounded controller such as `jev.run`/`spawn`, use event-driven task calls:

```ts
const receipt = await tools.call({ref:"tasks.wait",args:{id:taskId,timeoutMs:30000}});
// For tasks started with monitor (prefer delivery:"ui" for code-owned supervision):
const batch = await tools.call({ref:"tasks.watch",args:{id:taskId,after:0,timeoutMs:5000}});
return {receipt,batch};
```

- `wait` returns `{task,output,timedOut}`. It waits for terminal metadata, then reads the bounded tail; inspect `task.status` and `task.exitCode`. A successful terminal read acknowledges pending delivery like `get`. A timeout returns the current snapshot, not a failed-process verdict.
- `watch` requires an opt-in monitor. The launch-time `monitor.match` is the case-sensitive literal filter. It returns `{task,reason,lines,losses,omitted,more,nextCursor}` when a new batch exists, the task finishes, or the observation ceiling expires. `reason` is `event`, `finished`, or `timeout`; a final event may precede `finished` on the next call.
- Every accepted monitor line has a monotonic cursor, after jev-fabric's retained events. Start `after` at 0 and pass the returned `nextCursor` on later calls. The newest 256 lines are replayable from any cursor, at most 64 per call; while `more` is true, call again immediately. A cursor from the future is rejected.
- Missing positions are disclosed, never joined: `losses` lists `(after, next]` cursor ranges with reason `burst` (more than 256 lines within one delivery interval, oldest coalesced) or `evicted` (aged out of the ring before this cursor read them), and `omitted` is their total. Truncation markers and monitor filtering/deduplication still apply: this is not a lossless stdout/RPC channel.
- Agent-facing `wake` events still carry only the eight newest previews per batch; replay is for code-owned controllers.
- Defaults: wait 30 seconds, watch 5 seconds; each accepts `timeoutMs` from 1 to 300000. Ready evidence returns immediately. Neither timeout nor cancellation stops or renews the task. Store shutdown rejects pending observations and removes their subscriptions.
- No polling, inference, or extra wakeups are performed by wait/watch. Ordinary background tasks and wake-enabled monitors retain their existing notification behavior. Main usually yields for those notifications; a controller can use UI-only monitors and wait/watch without a model turn per event.
- A detached task belongs to the Pi session, not the observing Jev program. Stopping that program cancels its pending wait/watch, not the task. Preserve IDs, set finite process deadlines, and explicitly call `tasks.stop` when required.

## Durable tasks through jev-fabric

`pi.bash({cmd, durable: true})` hands the process to an external
[jev-fabric](https://github.com/fabric-runtime/jev-fabric) store, outside this Pi
process. It is for dev servers, watchers and long builds that must outlive the
session. macOS and Linux only. Fabric uses your own compatible `jev-fabric`
outside the workspace, else the bundled npm package (see
[which jev-fabric](shell-composition.md#which-jev-fabric)). It never downloads
one: without a suitable binary the call fails with install/update guidance for
the user, never a silent fallback to a local process.

```ts
return await pi.bash({cmd: "bun run dev", durable: true, description: "Dev server"});
```

- `durable` implies background; `background: false` is rejected, and the call is
  bash-only. Approvals, extension hooks, cooperative
  [bash middleware](shell-middleware.md) (environment and output filters) and
  the explicit `timeout` still apply: middleware wraps the jev-fabric operations
  exactly as it wraps the local backend. Opaque shell overrides and managed hosts
  cannot use it.
- The command runs from a private `0600` script with the call's cwd and
  (spawn-hooked) environment, so argv limits and quoting never apply. The
  description becomes the jev-fabric job label.
- Output reaches the task through `jev-fabric follow`, a live stream of the
  job's retained events: no Node-side polling, and no model turn. jev-fabric
  retains bounded previews, so dropped bytes and aged-out events are written
  into the task output as disclosures, never silently joined.
- Completion notifies the owning session like any background task. `tasks.stop`
  (or `x` twice in the inspector) stops the job through `jev-fabric stop`,
  never by PID. Monitors work while the session is attached.
- **Session shutdown, reload or Pi exit detaches, never kills.** The job keeps
  running in its store. Fabric records the session binding in
  `<agentDir>/fabric/durable-tasks/` (one private file per task) and, on the owning session's next model
  request, `tasks.*` call or inspector open, reattaches the same task ID from
  the start of the job's retained events. A job that finished while Pi was away
  delivers its completion then. Another session never reattaches it
  automatically, and monitors are not restored.
- Reattached output passes through the currently active middleware. If a task
  was filtered at launch and no middleware is active now, its output is withheld.

### Completion notify through the mesh

```ts
return await pi.bash({cmd: "bun run build", durable: true, description: "Build", notify: {topic: "builds"}});
```

`notify: {topic, kind?}` (durable only) publishes one event when the command exits:
`{kind: kind ?? "task.completed", data: {taskId, exitCode, description?}}` on that
[mesh topic](agents.md#scheduled-events), even when no Pi session is attached.
Subscribed actors, including durable actors on the resident host, wake on it.

- At launch, Fabric mints a single-use [external grant](agents.md#external-grants)
  for the topic and kind, valid for 7 days (the longest durable job is 24 hours). The
  private `0600` launch script runs the command in a subshell, then runs
  `pi-fabric mesh post` with the token in its environment and re-exits with the
  command's own status. A failed or impossible post never changes the task result.
- The event is posted by the job's own shell, so it carries `origin: "external"` and
  `untrusted: true` like any grant post. `exitCode` is the subshell status, so a
  signal-terminated command reports `128 + signal`.
- Delivery happens when the shell reaches its trailer. A task stopped through
  `tasks.stop` or killed at its timeout usually does not reach it and publishes
  nothing; its session still records the terminal state. The mesh must be enabled,
  and the topic must not be host-reserved. An unused grant expires on its own.

### Jobs from other harnesses

The default store is `<cwd>/.jev-fabric-native`, the same one Claude Code,
Codex or a shell uses for `jev-fabric` in that project, so it doubles as a
process registry across harnesses. Before a durable job or session uses the
default store, Fabric writes a `.gitignore` containing `*` into it, so the store
does not show as untracked files in a Git checkout. A configured `home` is left
as it is. `tasks.external` lists jobs there that no task of this session tracks
(id, state, label, start time). `tasks.adopt({jobId, description?})` attaches
one as a durable task of this session: output,
completion notification, wait/watch/stop and an inspector row. Adoption never
restarts or signals the process; stopping it afterwards does.

```ts
const {jobs} = await tools.call({ref: "tasks.external", args: {}});
return await tools.call({ref: "tasks.adopt", args: {jobId: jobs[0].id}});
```

Boundaries are jev-fabric's: trusted native execution, not a sandbox; no restart
of the machine is survived; no exactly-once execution or rollback.

## Reading output and watching without a monitor

Any background task, including durable and adopted ones, can be read and filtered after launch, with jev-fabric's records:

```ts
const page = await tools.call({ref: "tasks.read", args: {id, offset: 0, waitMs: 5000}});
// {id, stream:"output", offset, bytes, omittedBytes, text, next, eof, state}
const seen = await tools.call({ref: "tasks.watch", args: {id, match: "listening on", after: 0, timeoutMs: 30000}});
// {reason, lines, omittedBytes, more, nextCursor}: nextCursor is a byte offset
```

- `tasks.read` offsets count every byte of combined output since launch and never reset. The live window is the 1 MiB tail; after exit 32 KiB stays readable. Older bytes are disclosed in `omittedBytes`. Text pages never split a UTF-8 character; `encoding:"base64"` is byte-exact. `waitMs` long-polls for new bytes or exit.
- `tasks.watch` with `match` scans complete lines after a byte cursor for a case-sensitive literal chosen at watch time, like `jev-fabric watch <id> <literal>`. The cursor stops at line boundaries, so an unfinished line is matched once it ends or the task exits. Up to 64 lines per call; call again while `more` is true.
- Neither consumes, acknowledges, wakes the agent, or stops the task. Without `match`, `tasks.watch` keeps reading a launch-time monitor as below.

## Attached task and participant monitors

`tasks.observe` and `agents.observe` observe work that already exists. There is no separate `monitors` provider. It does not start another shell,
restart an agent, or invoke a model. It is available beside `tasks` in native
full-code / Schema enforce sessions, not closed-world managed hosts.

```ts
const {task: watch} = await tools.call({ref: "tasks.observe", args: {
  id: taskId,
  delivery: "wake", match: "BUILD:", timeoutMs: 600000,
}});
return {monitorId: watch.id};
```

For a local agent run ID or a local `provider:...` participant ref:

```ts
return await tools.call({ref: "agents.observe", args: {
  id: agentId, delivery: "ui",
  events: ["progress", "blocked", "quiet", "terminal"],
  quietAfterMs: 120000, timeoutMs: 600000,
}});
```

- `delivery` is required. `ui` never wakes the owner; `wake` uses the existing
  bounded, batched task inbox. There is at most one attached wake observer per
  target and eight active monitors total, shared with shell launch monitors.
- Task events default to `output, terminal`; participant events default to
  `progress, blocked, terminal`. Task output is **new combined stdout/stderr**
  after attachment, filtered with the optional literal `match`. Retained earlier
  output remains in `tasks.read`. Participant observation exposes only operational
  metadata (status, tool/turn counters, current tool/milestone, waiting state, or
  provider phase/message), not transcripts, thinking, or tool results.
- Output and progress are bounded and batched with `intervalMs`. Terminal outcomes
  always bypass filters and cannot be disabled. Terminal replay is a JSON line
  identifying the target and status; output lines otherwise retain their text.
- `quiet` requires `quietAfterMs` and fires once per quiet period. Real output or
  changed operational metadata re-arms it; heartbeat timestamps do not. Quiet is
  **not evidence of a hang or failure**, and never triggers a stop or restart.
- A participant replacement or disappearance ends observation with an unavailable
  outcome; it is not silently followed or classified as successful completion.
  Remote peers, resident actors and hosted/project-only participants are not
  supported by this first local adapter.
- `timeoutMs` defaults to five minutes, maximum thirty minutes. **Expiration,
  `tasks.stop({id: watch.id})`, interruption and session teardown stop only the observer**, not
  its target. This deliberately differs from a launch-time shell `monitor`, whose
  deadline owns and stops its watcher command. No automatic renewal.
- `tasks.list/get/watch/stop` inspect and control observation handles. In the
  footer, observations appear beneath their task or local participant, with separate
  work/observation counts, delivery and expiry. The inspector labels “stop watching”
  separately from stopping the target. `tasks.watch` returns the
  existing bounded line-cursor replay and loss records; an observation timeout or
  cancellation never stops the observer. Stopping an observer discards pending
  notifications. A wake observer replaces the target's ordinary completion wakeup,
  avoiding duplicates; retrieve a participant's full result with `agents.wait`.
  `tasks.watch` remains a bounded read/wait, not a persistent subscription.
  `agents.subscribe` remains the separate durable lifecycle-routing API.
  Neither observe action launches a supervisor agent or changes ordinary completion defaults.

The foreground shell/program shortcut is shown as a connected status line,
`╰─ (ctrl+b to run in background)`, joining existing output/timing arcs. The
existing confirmation chord remains: press Ctrl+B again within one second to
confirm. The hint disappears on completion or detachment; with editor text,
program backgrounding retains Ctrl+B as cursor-left.

## Opt-in monitors

```ts
return await pi.bash({
  cmd: "./scripts/watch-ci.sh", // emits a line only when something interesting changes
  description: "Watch CI",
  monitor: {
    delivery: "wake", // REQUIRED: "ui" or "wake"
    match: "CI:",     // optional case-sensitive literal substring, not regex
    timeoutMs: 300000,
    intervalMs: 5000,
  },
});
```

A monitor implies background execution; `background: false` is rejected. The
ordinary shell runner, extension hooks, middleware filters, approvals and explicit
shell timeout still apply. `delivery: "ui"` only updates task inspection, including
completion; it never wakes the model. `"wake"` additionally delivers coalesced line
events and completion to the owning agent. Main configures/starts/stops/renews the
watch, while the process does the polling or subscribes to an external source.
Unchanged polls require **zero LLM turns** when the script emits nothing.

Limits:

- Five-minute default lifetime; 1 second minimum, 30 minutes maximum. Expiration
  stops the command and produces one terminal outcome. Renewal is a new explicit
  call; there is no automatic restart or hidden supervisor LLM.
- At most eight concurrent monitors per session. Output batches are spaced by
  `intervalMs` (1–60 seconds, default 5 seconds). This is a **delivery** interval,
  not the script's polling interval.
- UTF-8 chunks are framed incrementally. Lines retain their first 2048 characters;
  matching applies to that bounded prefix. Empty lines and adjacent duplicate
  matching lines are suppressed. Events keep at most eight 500-character previews
  per batch; overflow is disclosed. A busy owner receives the newest batch per
  task, not every historical line. Retained raw output is available in the log.
- Main interruption cancels monitors and suppresses automatic wakeups. Ordinary
  detached commands retain their existing lifetime; their outcomes wait for input.
- Events and output are untrusted data. `wake` can incur model turns; use `ui` for
  human-only observation and emit only meaningful changes for agent-facing watches.

Opaque captured shell overrides do not gain Fabric monitors: Fabric must not bypass
an SSH backend or security gate. Compatible [bash middleware](shell-middleware.md)
keeps its filtering/protection. PowerShell monitors require the host's tracked shell
operations API. The tasks provider is installed with the native Pi provider in full
code mode (and schema enforce, whose authorization rules still apply), not in
orchestration-only mode or closed-world managed hosts.
