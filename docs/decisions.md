# Durable decisions

A decision is a pending question that outlives the call that raised it: an approval, a question, or an escalation. Fabric stores each decision in the project mesh, so a headless session, a resident host, a child agent, and a person at another terminal all see the same record. A human answers through `/fabric decisions` or the `pi-fabric decisions` CLI. A program answers only decisions that are held by its participant.

Three sources raise decisions:

- programs, through `decisions.raise`;
- headless approvals, when `approvals.headless` is `"decision"`;
- routed child dialogs, when `agents.childQuestions` is `"route"` and the parent session has no interactive UI.

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
  answer?: { optionId?, text?, answeredBy, via, at },
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

`wait` polls the mesh and stops when the calling program is aborted. It is a default [human-wait ref](configuration.md#executor-timeouts-and-ceilings), so the program deadline is paused while it waits. The wait ends when the decision is answered, expired, or cancelled, or when the call's `timeoutMs` passes. A decision raised without `timeoutMs` or `deadline`, waited on without `timeoutMs`, has no time bound: only an answer, a cancellation of the decision, or a cancelled program (Esc, an aborted signal, or a `fabric_exec` `timeout_ms` hard deadline) ends the wait. Set `executor.humanWaitRefs` to `["extensions.ask"]` to bound `wait` by the program deadline again. `holder` defaults to `"user"`.

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

Authority for the human surfaces is local file access to the mesh root. Until principals and scopes land, anyone who can write the mesh root as the same OS user can answer any decision.

## Headless approvals

`approvals.headless` controls what happens when an action needs approval (`ask`, or an `auto` escalation) and the session has no interactive UI:

- `"deny"` (default) fails the call, as before.
- `"decision"` raises a `kind: "approval"` decision held by `"user"` with options `approve` and `deny`, and waits for it inside the calling program's abort signal. The deadline is `approvals.headlessTimeoutMs` (default 5 minutes) with `onExpire: "cancel"`. Only an `approve` answer runs the action, once. A deny, a cancellation, an expiry, or an aborted program denies it. Fabric never approves automatically. The program deadline is paused while the decision is open, so each approval waits up to `approvals.headlessTimeoutMs` without spending it. A program that catches the denial and calls the action again raises a new decision and waits again. Such a retry loop ends only when the program is cancelled or reaches a `fabric_exec` `timeout_ms` hard deadline.

The decision path covers actions called through `fabric_exec`. Direct native tool approvals in a headless session still fail closed. Session-wide grants ("Allow write access for this session") stay a UI-only choice.

## Routed child questions

By default a child Pi run cancels every dialog (`select`, `confirm`, `input`, `editor`) that its extensions open. With `agents.childQuestions: "route"`, the child's worker forwards the dialog to the parent:

1. The worker writes a lifecycle record `{ event: "question", data: { requestId, method, title, message?, options?, placeholder?, prefill?, timeout } }` and sets `blockedOn: { since }` on the run record.
2. The parent AgentManager asks through its own interactive UI when it has one, with the child's name prefixed to the title. A parent that is itself an RPC child asks through its own UI channel, so questions climb to the first session with a person or a headless root.
3. Without an interactive UI, the parent raises a `kind: "question"` decision held by `"root"`. `select` options become `o1`, `o2`, … (the first 12), and `confirm` becomes `yes`/`no`. The run record then shows `blockedOn: { decisionId, since }`.
4. The answer goes back through the run's steer channel as `{ type: "ui_response", requestId, value? | confirmed? | cancelled? }`, and the worker forwards it to the child as `extension_ui_response`.

The deadline is the dialog's own timeout, or `agents.childQuestionTimeoutMs` (default 10 minutes). The worker owns that deadline and answers `cancelled` when it passes, so a child never waits on a parent that has gone away. A settled run cancels its open question decision. Only the `pi` runner routes dialogs.

## Human surfaces

- `/fabric decisions [id]` lists open decisions, then answers the picked one through native dialogs (`select` for options, with a "Cancel this decision" entry, and `input` or `editor` for text). Answers record `via: "tui"`.
- `pi-fabric decisions list --root <meshRoot> [--status open|answered|expired|cancelled|all] [--holder h] [--limit n] [--json]` prints decisions from outside any Pi session. `--root` defaults to `$PI_FABRIC_MESH_ROOT`. The project mesh root is `.pi/fabric/mesh` unless `mesh.root` says otherwise.
- `pi-fabric decisions answer --root <meshRoot> <id> (--option <id> | --text <t>) [--json]` answers one decision with `via: "cli"` and the OS user name as `answeredBy`. Exit code 1 reports a refused answer (not open, unknown option), and 2 reports a usage error.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `approvals.headless` | `"deny"` | `"decision"` turns no-UI approvals into user-held decisions |
| `approvals.headlessTimeoutMs` | `300000` | headless approval deadline (1 s to 24 h) |
| `agents.childQuestions` | `"cancel"` | `"route"` forwards child dialogs to the parent |
| `agents.childQuestionTimeoutMs` | `600000` | default routed dialog deadline (1 s to 24 h) |

Decisions need `mesh.enabled`. Managed hosts do not expose `decisions.*`. Schema enforce mode allows `decisions.list` and blocks the other actions.
