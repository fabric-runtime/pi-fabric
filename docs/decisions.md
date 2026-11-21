# Durable decisions

A decision is a pending question that outlives the call that raised it: an approval, a question, or an escalation. Fabric stores each decision in the project mesh, so a headless session, a resident host, a child agent, and a person at another terminal all see the same record. A human answers through `/fabric decisions` or the `pi-fabric decisions` CLI. A program answers only decisions that are held by its participant.

Four sources raise decisions:

- programs, through `decisions.raise`;
- headless approvals, when `approvals.headless` is `"decision"`;
- routed child dialogs, when `agents.childQuestions` is `"route"` and the parent session has no interactive UI, the child is a durable run, or a [question renderer](#question-renderers) is active;
- other extensions, through the [extension question events](#extension-questions).

## Record

Decisions live under the reserved mesh key prefix `decisions/<id>`. `mesh.get` and `mesh.list` can read them, and `mesh.put` and `mesh.delete` refuse the prefix.

```ts
{
  id: "dec_…",
  kind: "approval" | "question" | "escalation",
  title,                       // 1..200 characters
  body?,                       // up to 4000 characters
  options?: [{ id, label }],   // up to 12; ids match [A-Za-z0-9][A-Za-z0-9._:-]{0,63}
  input: "text" | "confirm" | "select" | "editor",
  raisedBy: { participantId, runId?, sessionId? },
  holder: "root" | "user" | "supervisor:<participantId>",
  createdAt, deadline?,        // epoch ms
  onExpire: "cancel" | "default" | "escalate",
  defaultOptionId?,
  escalation?: { chain, hop, hopTimeoutMs, onFinal: "cancel" | "default" },
  history?: [{ holder, until, reason: "expired" | "escalated", text?, by? }],
  status: "open" | "answered" | "expired" | "cancelled",
  answer?: { optionId?, text?, answeredBy, via, answererKind?, at },
}
```

- `input` defaults to `"select"` when `options` are given and to `"text"` otherwise. `"confirm"` without options gets `yes` and `no`. `"text"` and `"editor"` take no options.
- `deadline` is an epoch-ms time at most 30 days ahead. `timeoutMs` (1 s to 30 days) is the relative form. Pass one of them.
- `onExpire: "default"` needs `defaultOptionId` and a deadline. An expired decision then carries `answer: { optionId: defaultOptionId, answeredBy: "deadline", via: "expiry" }`. With `"cancel"` (the default) it expires with no answer.
- Every transition leaves `open` through a mesh compare-and-swap, so two answerers cannot both win. The loser gets `Decision <id> is answered, not open`.
- Expiry is lazy: the first reader after the deadline (`get`, `list`, `wait`, an answer attempt, the CLI) writes the `expired` record. A decision with a passed deadline is never answered.
- Each transition also publishes a wake hint on the `fabric.decisions` mesh topic (`decision.raised`, `decision.escalated`, `decision.answered`, `decision.expired`, `decision.cancelled`, data `{ id, kind, holder, status, title, hop? }`). The record stays authoritative.
- A mesh root keeps at most 200 open decisions. Resolved decisions stay for 7 days and are pruned first when the store reaches 500 records.

## Guest API

```ts
const { id } = await decisions.raise({
  kind: "escalation",
  title: "Deploy to production?",
  body: "Migration 42 drops a column.",
  options: [{ id: "go", label: "Deploy" }, { id: "hold", label: "Hold" }],
  timeoutMs: 30 * 60_000,
  onExpire: "default",
  defaultOptionId: "hold",
});
const decision = await decisions.wait({ id });          // resolves on answer, expiry, or cancel
if (decision.answer?.optionId === "go") { /* … */ }
```

Python uses the same calls, for example `await decisions.raise(title="Deploy?", input="confirm")`.

| Action | Risk | Result |
| --- | --- | --- |
| `decisions.raise({kind?, title, body?, options?, input?, holder?, deadline? \| timeoutMs?, onExpire?, defaultOptionId?, escalation?})` | agent | `{ id }` |
| `decisions.wait({id, timeoutMs?})` | read | the record once it leaves `open`; the still-open record when `timeoutMs` passes |
| `decisions.list({status?, holder?, limit?})` | read, no effect, speculation-eligible | records, newest first (limit 1..200, default 50); `holder` matches the current holder |
| `decisions.answer({id, optionId?, text?})` | agent | the answered record |
| `decisions.escalate({id, reason?})` | agent | the record, now held by the next holder in its chain |
| `decisions.cancel({id})` | agent | the cancelled record |

`wait` polls the mesh and stops when the calling program is aborted. It is a default [human-wait ref](configuration.md#executor-timeouts-and-ceilings), so the program deadline is paused while it waits. The wait ends when the decision is answered, expired, or cancelled, or when the call's `timeoutMs` passes. A decision raised without `timeoutMs` or `deadline`, waited on without `timeoutMs`, returns the still-open record after `executor.maxTimeoutMs` (default 15 minutes), so a wait that nobody answers still ends. Pass `timeoutMs`, or raise with a deadline, to wait longer. Set `executor.humanWaitRefs` to `["extensions.ask"]` to bound `wait` by the program deadline again. `holder` defaults to `"user"`.

## Who may answer

| Holder | `decisions.answer` from a program | `/fabric decisions`, `pi-fabric decisions` |
| --- | --- | --- |
| `user` | refused | allowed |
| `root` | a root session participant (`mesh.self().kind === "main"`) | allowed |
| `supervisor:<participantId>` | that participant only | allowed |

A program also cannot answer a decision that it raised in the same `fabric_exec` call, whatever the holder. This keeps a model from approving its own request. `decisions.escalate` follows the same rules. `decisions.cancel` is open to the raiser and to an authorized holder. Fabric checks the holder against the exact record that the compare-and-swap replaces, so a holder that lost a decision to an escalation cannot still answer it.

## Escalation chains

`onExpire: "escalate"` hands an unanswered decision to the next holder when a deadline passes, and the decision stays `open`:

```ts
const { id } = await decisions.raise({
  title: "Retry the flaky migration?",
  options: [{ id: "retry", label: "Retry" }, { id: "skip", label: "Skip" }],
  holder: "supervisor:run-lead",
  onExpire: "escalate",
  escalation: { hopTimeoutMs: 15 * 60_000, onFinal: "default" },
  defaultOptionId: "skip",
});
```

- `escalation.chain` lists holders in order with the holder grammar above: at most 8 entries, no duplicates, and the first entry equals `holder`. Without it the chain climbs from the holder: `supervisor:<id>` then `root` then `user`, `root` then `user`, and `user` alone. Fabric freezes the chain on the record at raise time.
- `escalation.hopTimeoutMs` (1 s to 7 days, default 10 minutes) is each hop's time. The first hop ends at `deadline` or `timeoutMs` when given, else one hop after the raise. Each later hop ends one `hopTimeoutMs` after the previous deadline, so a reader that arrives late applies every elapsed hop in one compare-and-swap.
- `escalation.onFinal` (`"cancel"` by default, or `"default"`, which needs `defaultOptionId`) resolves the decision when the last holder's deadline passes, exactly like a plain `onExpire`.
- A move sets `holder` to the next chain entry, advances `escalation.hop`, appends `{ holder, until, reason: "expired" }` to `history` for the previous holder, and publishes `decision.escalated`. Expiry stays lazy: `get`, `list`, `wait`, an answer attempt, the TUI, and the CLI all apply it. Two racing readers cannot both move the decision.
- `decisions.escalate({ id, reason? })` lets the current holder pass the decision up now. The next holder gets a fresh `hopTimeoutMs`, and `history` records `reason: "escalated"`, the `text` (up to 500 characters), and `by`. Fabric refuses it for a decision without a further holder, which includes every decision without `onExpire: "escalate"`.
- Authority follows the holder. After a move the previous holder can no longer answer or escalate, and a decision that reaches `user` is answered only by a person.
- `/fabric decisions` and `pi-fabric decisions list` show the hop and chain, for example `hop 2/3 chain=supervisor:run-lead>root>user`.

Records from before escalation chains carry neither `escalation` nor `history` and expire as before.

Authority for the human surfaces is local file access to the mesh root. Until principals and scopes land, anyone who can write the mesh root as the same OS user can answer or cancel any decision. A cancel needs no more authority than an answer.

## Headless approvals

`approvals.headless` controls what happens when an action needs approval (`ask`, or an `auto` escalation) and the session has no interactive UI:

- `"deny"` (default) fails the call, as before.
- `"decision"` raises a `kind: "approval"` decision held by `"user"` with options `approve` and `deny`, and waits for it inside the calling program's abort signal. The deadline is `approvals.headlessTimeoutMs` (default 5 minutes) with `onExpire: "cancel"`. Only an `approve` answer runs the action, once. A deny, a cancellation, an expiry, or an aborted program denies it. Fabric never approves automatically. The program deadline is paused while the decision is open, so each approval waits up to `approvals.headlessTimeoutMs` without spending it. A program that catches the denial and calls the action again raises a new decision and waits again. Such a retry loop ends only when the program is cancelled or reaches a `fabric_exec` `timeout_ms` hard deadline.

The decision path covers actions called through `fabric_exec`. Direct native tool approvals in a headless session still fail closed. Session-wide grants ("Allow write access for this session") stay a UI-only choice.

## Routed child questions

By default a child Pi run cancels every dialog (`select`, `confirm`, `input`, `editor`) that its extensions open. With `agents.childQuestions: "route"`, the child's worker forwards the dialog to the parent:

1. The worker writes a lifecycle record `{ event: "question", data: { requestId, method, title, message?, options?, placeholder?, prefill?, timeout, hold? } }` and sets `blockedOn: { since }` on the run record.
2. The parent AgentManager asks through its own interactive UI when it has one, with the child's name prefixed to the title. A parent that is itself an RPC child asks through its own UI channel, so questions climb to the first session with a person or a headless root.
3. Without an interactive UI, the parent raises a `kind: "question"` decision held by `"root"`. A `residency: "durable"` run's parent is the resident host, which has no UI, so its dialogs always become decisions. `select` options become `o1`, `o2`, … (the first 12), and `confirm` becomes `yes`/`no`. The run record then shows `blockedOn: { decisionId, since }`, in the run's status file too, so a session reading a durable run sees which decision blocks it. With several questions open, `decisionId` names the decision of the oldest question that has one, and moves on when that question is answered or cancelled.
4. The parent names the decision to the worker with a steer line `{ type: "ui_decision", requestId, decisionId }`; a worker that does not know this command ignores it and leaves `blockedOn.decisionId` out. The answer goes back through the same steer channel as `{ type: "ui_response", requestId, value? | confirmed? | cancelled? }`, and the worker forwards it to the child as `extension_ui_response`.

The deadline is the dialog's own timeout, or `agents.childQuestionTimeoutMs` (default 10 minutes). The worker owns that deadline and answers `cancelled` when it passes, so a child never waits on a parent that has gone away. A settled run, including a stopped one, cancels its open question decision. Runners that declare the `questions` capability route dialogs: the built-in `pi` and `pi-durable` runners, and hosted runners through `reporter.question`. Other runners cancel them.

Routing also gives a Pi child with extensions the tools listed in `agents.childQuestionTools` (default `["ask"]`), so a caller does not have to name a question tool in `tools`. The grant never widens an allowlist the child inherited, and it is skipped when `tools` is empty, uses `+name`/`-name` modifiers, or `extensions` is `false`. Set `childQuestionTools: []` to route dialogs without granting a tool; a caller then names the question tool in `tools`. A child's system prompt lists only the extension tools its allowlist permits, so a tool left out is not offered and cannot be called.

A durable run's decision lives in the project mesh, so it outlives the session that spawned the run. Any root session on the same mesh, `/fabric decisions`, or `pi-fabric decisions answer` can answer it until its deadline.

### Holding a question for a person

A run spawned with `holdQuestions: true` (`agents.run` or `agents.spawn`) holds its routed questions for a person, with the longest deadline the store allows. This is for a workflow that must wait for an operator who may be away, without stopping the rest of its work:

- Each question becomes a `kind: "question"` decision held by `"root"` whose `deadline` is 30 days after it was raised (`MAX_DECISION_DEADLINE_MS`). The deadline is a backstop: if the session that raised the decision dies without a clean shutdown, nothing else cancels it, and answering it would reach no one. When it passes, the decision expires and the child's question is cancelled. The parent raises a decision even when it has an interactive UI, and only notifies the UI that the decision is waiting, so a blocking dialog never stalls the session. A parent with a UI but no decision store asks through the UI dialog with no timeout.
- The worker sets no timer on the question and marks the lifecycle record `hold: true`. Only that run waits; other runs and the calling program continue.
- Answer it with `/fabric decisions`, `pi-fabric decisions answer`, or `decisions.answer({ id, optionId | text })` from a main-session program. The run's `blockedOn.decisionId` names it.
- A dialog that sets its own `timeout` keeps it. The run's own `timeoutMs` still applies, and a settled or stopped run cancels the decision as usual.
- Fabric refuses `holdQuestions` unless `agents.childQuestions` is `"route"` and the runner declares `questions`. A hosted run keeps the setting in its persisted state, so a re-attached run still holds.

Only the resident host that raised a decision can deliver its answer, so a decision does not outlive that host:

- When the resident host shuts down, it stops its durable worker runs, which cancels their decisions. It detaches its durable hosted runs instead and cancels their open decisions (`via: "abort"`, `answeredBy` the resident host id) before it exits. The run's `blockedOn` keeps `since` and drops `decisionId`.
- When a resident host dies without shutting down, its decisions stay open, and an answer reaches nothing. The next resident host for the same root cancels every open question decision that an earlier generation raised (`via: "restart"`) before it re-attaches any run.
- A re-attached hosted run starts without `blockedOn`. A runner that still waits on its question asks again through the new host's reporter, which raises a new decision and names it in `blockedOn.decisionId`. Fabric does not answer a detached run's question: the old reporter's `question` never settles, so the runner never takes the cancellation as an answer.

A parent waiting on the old decision sees it settle `cancelled`, with `via: "abort"` after a clean shutdown. `via: "restart"` means the host died. If the run still needs an answer, it reads the run's `blockedOn.decisionId` or lists open decisions once the next resident host re-attaches the run. Until then, no decision is open for that question.

## Extension questions

Another extension in the same session can hand a question to a person through two host-local, versioned events on `pi.events`. A question tool uses them when it has no screen to ask on.

- `pi-fabric:decisions:capability:v1` claims and resolves with `{ ok: true, available: true, inputs, maxOptions, maxTitleChars, maxBodyChars, maxTextChars, minTimeoutMs, maxTimeoutMs }`, or `{ ok: true, available: false, reason }` when the mesh is disabled or the host is managed. An unclaimed request means no compatible Fabric runtime is loaded.
- `pi-fabric:decisions:request:v1` takes `question: { title, body?, input?, options?, timeoutMs? }`, an optional `source`, an optional `AbortSignal`, and an optional `onRaised(id)` callback. It raises a `kind: "question"` decision and resolves once it settles: `{ ok: true, id, status: "answered", answer }`, `{ ok: true, id, status: "cancelled" | "expired" }`, or `{ ok: false, error, id? }`.

Fabric copies only those question fields. The decision is always held by `"user"` with `onExpire: "cancel"`, so a caller cannot route it to a program, add an escalation chain, or set a default that settles without a person. Only `answered` carries an answer. Omit `timeoutMs` to wait until a person answers or cancels; aborting the signal cancels the stored decision. At session shutdown Fabric aborts every request still waiting: it resolves `{ ok: false, id, error: "Decision request aborted: the session shut down" }` and its stored decision is cancelled.

`source` names the asking extension, for example its package name. The record stores it as `raisedBy.participantId: "extension:<source>"` next to the session id, so a person can see who asked. It must match `[A-Za-z0-9@][A-Za-z0-9@._/-]{0,63}`; any other value is refused before a decision is raised. Without `source`, the session is the raiser.

## Following and answering decisions from an extension

Two more host-local events let an extension in the same Pi process follow the decision store and answer from its own interface. Fabric's store stays the record of every decision.

- `pi-fabric:decisions:changed:v1` (`FABRIC_DECISIONS_CHANGED_EVENT`) is emitted once for each lifecycle change on the session's mesh: `{ version: 1, change, decision }`, where `change` is `raised`, `answered`, `expired`, `cancelled` or `escalated` and `decision` is the full stored record after the change, deeply frozen. A change made in this process arrives right after it is written. A change made by another process on the mesh (the `pi-fabric decisions` CLI, a child agent, another session) arrives after Fabric reads its `fabric.decisions` wake hint, with the record as stored at that moment; when several such changes land between two reads, only the latest state arrives. Fabric tracks the mesh version of each record and emits a version only once, so a subscriber never sees one change twice. Managed hosts and sessions without the mesh emit nothing.
- `pi-fabric:decisions:answer:v1` (`FABRIC_DECISION_ANSWER_EVENT`) answers or cancels one open decision. It takes `source`, `id`, `action: "answer" | "cancel"`, `answer: { optionId?, text? }` for an answer, `answeredBy` (who answered, matching `[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}`) and `answerer: "person" | "agent"`, with `claim` and `respond`. It responds `{ ok: true, decision }` with the stored record, or `{ ok: false, id, error }`.

The answer goes through the same compare-and-swap as every other answer, so the first answer wins against a dialog, the CLI, a program or a deadline, and the loser gets `Decision <id> is answered, not open`. Fabric records `via: "extension:<source>"`, `answeredBy` and `answererKind` on the answer and copies only `optionId` and `text`. It refuses an unknown option and a closed decision like any other answer, an agent answering or cancelling a decision held by `"user"`, and an extension answering a decision it raised itself (`raisedBy.participantId` is `"extension:<source>"`); it may cancel one. `source` follows the pattern in [Extension questions](#extension-questions).

Both events carry functions or a live context, so only code in the Pi process can use them: bash, the CLI and a program's tool calls cannot. Without a subscriber or a caller, decisions behave exactly as before.

## Question renderers

By default Fabric shows a routed child question and the decision picked in `/fabric decisions` with its own `ctx.ui` dialogs. An extension with a richer question interface can show them in its own interface. Fabric consults renderers only when `ui.questionRenderers` is `true`; any other value leaves both surfaces exactly as they are.

```json
{
  "ui": {
    "questionRenderers": true
  }
}
```

Register a renderer over `pi.events`. Registration is accepted whether or not the setting is on. A second registration under the same `name` replaces the first and keeps its place in registration order:

```ts
import { FABRIC_QUESTION_RENDERER_REGISTER_EVENT } from "pi-fabric/protocol";

let unregister: (() => void) | undefined;
pi.events.emit(FABRIC_QUESTION_RENDERER_REGISTER_EVENT, {
  version: 1,
  name: "my-question-ui",
  render: async ({ surface, ui, decision, signal }) => {
    const optionId = await showMyQuestionUi(ui, decision, signal);
    return optionId
      ? { status: "answered", decisionId: decision.id, answer: { optionId } }
      : { status: "dismissed", decisionId: decision.id };
  },
  respond: (result) => { if (result.ok) unregister = result.unregister; },
});
```

The renderer receives `surface` (`"child-question"` or `"decisions-command"`), the session `ui`, a private copy of the `decision` (`id`, `kind`, `title`, `body?`, `input`, `options?`, `holder`, `raisedBy`, `createdAt`, `deadline?`), and a `signal`. It returns one of:

| Result | Effect |
|---|---|
| `{ status: "answered", decisionId, answer: { optionId?, text? } }` | Fabric records the answer. |
| `{ status: "cancelled", decisionId }` | Fabric cancels the decision. |
| `{ status: "dismissed", decisionId }` | The person closed the renderer without deciding. A child question is cancelled; a decision picked in `/fabric decisions` stays open. |
| `undefined` | The renderer declines; Fabric asks the next renderer, then shows its own dialog. |

Fabric asks renderers one at a time in registration order. It writes the result to the store itself, with `via: "tui"` and the OS user as `answeredBy`, and copies only `optionId` and `text`, so a renderer cannot change the holder, the raiser, the deadline, or who is recorded as answering. A result whose `decisionId` names another decision, a malformed result, an answer the store refuses (an unknown option, text over the limit), a throw, or a rejection falls back to Fabric's own dialog. `signal` aborts when the decision is answered, cancelled, or expires elsewhere, or when the asking child run settles; Fabric then uses what the record says.

With an active renderer and a decision store, a routed child question that would use the parent's UI is recorded first as a root-held `kind: "question"` decision with the question's own deadline, so the renderer and Fabric's fallback dialog show the same record. `/fabric decisions` and `pi-fabric decisions answer` can answer it too; the first answer wins and the child gets what the record says. A `select` with more than 12 options keeps Fabric's direct dialog and is not recorded. A [held question](#holding-a-question-for-a-person) keeps the hold path and is not offered to renderers. Only the main session consults renderers; a child session's UI forwards to its parent.

## Human surfaces

- `/fabric decisions [id]` lists open decisions, then answers the picked one through native dialogs (`select` for options, and `input` or `editor` for text). Both kinds offer a "Cancel this decision" entry. A text or editor decision first asks "Answer this question" or "Cancel this decision", so an empty answer and a cancel never look the same. Answers and cancels record `via: "tui"`. With an active [question renderer](#question-renderers), the picked decision goes to the renderer first.
- `pi-fabric decisions list --root <meshRoot> [--status open|answered|expired|cancelled|all] [--holder h] [--limit n] [--json]` prints decisions from outside any Pi session. `--root` defaults to `$PI_FABRIC_MESH_ROOT`. The project mesh root is `.pi/fabric/mesh` unless `mesh.root` says otherwise.
- `pi-fabric decisions answer --root <meshRoot> <id> (--option <id> | --text <t>) [--json]` answers one decision with `via: "cli"` and the OS user name as `answeredBy`. Exit code 1 reports a refused answer (not open, unknown option), and 2 reports a usage error.
- `pi-fabric decisions cancel --root <meshRoot> <id> [--json]` cancels one open decision with `via: "cli"` and the OS user name as `answeredBy`. Use it to clear a decision whose asker has gone away, such as a `pi -p` run stopped with Ctrl+C. Cancelling a decision that is not open exits 1, like answering one twice.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `approvals.headless` | `"deny"` | `"decision"` turns no-UI approvals into user-held decisions |
| `approvals.headlessTimeoutMs` | `300000` | headless approval deadline (1 s to 24 h) |
| `approvals.policyHooks` | off | consult [extension action policy hooks](configuration.md#extension-action-policy-hooks); a `hold` uses the headless path above |
| `agents.childQuestions` | `"cancel"` | `"route"` forwards child dialogs to the parent |
| `ui.questionRenderers` | off | offer decisions shown at this terminal to [question renderers](#question-renderers) |
| `agents.childQuestionTimeoutMs` | `600000` | default routed dialog deadline (1 s to 24 h) |
| `agents.childQuestionTools` | `["ask"]` | tools a routed Pi child gets for asking; `[]` grants none |

Decisions need `mesh.enabled`. Managed hosts do not expose `decisions.*`. Schema enforce mode allows `decisions.list` and blocks the other actions.
