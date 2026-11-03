# Jev: shell orchestration with explicit typed decisions

Fabric follows the shell-first model of `jev-fabric`: ordinary code launches and supervises processes, consumes bounded evidence, and calls Jev **explicitly** only for a fuzzy decision. Exact checks need no model. Jev returns Choice, Noul, or Score values, never generated shell commands or prose.

Programs run in persistent QuickJS contexts with exact granted capabilities. Use the existing `pi.bash` / `pi.powershell` and `tasks` provider, not a new process engine or browser/macOS bridge. No standalone `jev-fabric` installation is required. Fabric programs and ordinary tasks are session-owned, not restart-durable; `pi.bash({durable: true})` delegates one process to a jev-fabric store so it outlives Pi (see [durable tasks](background-tasks.md#durable-tasks-through-jev-fabric)).

For guided authoring, invoke `/skill:fabric-jev <task>`. It is user-opt-in and available in both kernel skill trees. Python callers use `tools.call` dictionaries; the Jev program artifact itself remains TypeScript in QuickJS, without changing the outer Fabric kernel. See [skills](skills.md).

For multi-provider model switching, inline images and exact provider evidence,
use the additive [lossless decisions API](jev-decisions.md): `jev.decide`,
`jev.resolveDecision`, `jev.models` and portable profiles. These require a
compatible native binary; `jev.evaluate` below keeps its legacy contract.

## Shell-first workflow

1. Launch an authorized command; code owns commands and arguments. Never execute model answers or untrusted output as shell source.
2. Inspect exit status and parse exact markers before considering inference.
3. For long work, use a tracked task and await `tasks.wait` or `tasks.watch` inside a bounded program, not repeated reasoning-model turns.
4. Only if a semantic question remains, call `jev.evaluate` with consented, minimized state and a finite call/token budget. Map its typed answer to a branch already written in code.
5. Verify the postcondition independently. A successful exit, match, or model answer is not proof the task succeeded.

This example runs the repository's build without inference (adapt the command to the authorized task):

```ts
const run = await jev.run({
  input: {command: "bun run build"},
  program: {
    name: "build-supervisor",
    inputSchema: {type:"object", properties:{command:{type:"string"}}, required:["command"], additionalProperties:false},
    outputSchema: {},
    requires: ["pi.bash", "tasks.wait"],
    limits: {timeoutMs:70000, maxEvaluations:0, maxToolCalls:10},
    code: `
      const started = await pi.bash({cmd:input.command, timeout:60, settle:true,
        monitor:{delivery:"ui",timeoutMs:60000}});
      const id = (started.details as {taskId?:string} | null)?.taskId;
      if (!id) return {ok:started.ok,output:started.output};
      await program.emit({taskId:id});
      return await tools.call({ref:"tasks.wait",args:{id,timeoutMs:60000}});
    `,
  },
});
return {id:run.id, state:run.state, result:run.result ?? null, error:run.error ?? null};
```

`maxEvaluations: 0` rejects program inference before dispatch, even if accidentally granted. Omit `jev.evaluate` entirely for deterministic programs; they need no credentials. This does not disable a separately configured host auto-approval classifier or inference in a shell command: do not change approval policy implicitly.

For filtered progress, launch with `monitor:{delivery:"ui",match:"BUILD:",intervalMs:1000,timeoutMs:60000}` and grant `tasks.watch`. Await `tools.call({ref:"tasks.watch",args:{id,after:cursor,timeoutMs:5000}})`, beginning with cursor 0. Consume `lines`, inspect `losses`/`omitted`, advance to `nextCursor`, and call again at once while `more` is true. `reason` is `event`, `finished`, or `timeout`. A match is evidence, not completion; an omitted batch is incomplete evidence. No automatic Jev calls or Main wakeups occur with UI-only delivery. See [task wait/watch](background-tasks.md#programmatic-wait-and-watch) for bounds and cancellation.

Timeouts are ceilings, not delays: ready evidence returns immediately. `tasks.wait`/`watch` timing out or being cancelled never stops the task. Detached tasks belong to the Pi session, **not the Jev run**: `jev.stop` stops the program, while `tasks.stop` stops its task. Keep task IDs in progress events and configure finite shell/monitor deadlines. A foreground shell still follows caller cancellation until it detaches. For work that must outlive Pi itself, use `durable: true` with an installed jev-fabric: the process survives, while the Jev program and its pending waits do not.

Shell execution retains Fabric approvals, compatible shell middleware, and capability checks. It requires full-code mode and cannot silently replace an opaque captured shell backend. `pi.bash` accepts shell source, not literal argv or an interactive stdin handle. For literal argv or persistent subprocess I/O, grant `sessions.open`/`sessions.write`/`sessions.read` (jev-fabric, macOS/Linux): the session child ends with the program. See [shell composition](shell-composition.md) for the verbs, records and a realtime loop.

## Authentication

On Pi 0.99.0 or newer, `/login jev` prompts privately for a TypeSafe API key and stores an ordinary API-key credential under `jev` in Pi's `auth.json`. `/logout` removes it. Jev registers an **auth-only provider with no chat models**; it does not appear as a selectable text-generating model.

Jev has four upstream routes. Bare aliases (`jev-latest`, `jev-1.13`, `jev-1.13.0`, `jev-1.14.0`, `jev-preview`) post to TypeSafe's `/v1/systemone`. OpenRouter decisions IDs (`typesafe/jev-1.13`, `typesafe/jev-1.14`, `~typesafe/jev-latest`) post to OpenRouter's `/api/alpha/decisions` and reuse the **existing `openrouter` credential** (the same `auth.json` entry as your chat models), so `/login openrouter` covers both. OpenRouter serves Jev on its Decisions API, not `/chat/completions`, and has no `jev-preview` alias. Vercel AI Gateway model IDs (`typesafe-ai/jev`, or the `jev-latest` alias) post to its TypeSafe-compatible `/typesafe/v1/systemone` endpoint and reuse the **existing `vercel-ai-gateway` credential** (`/login vercel-ai-gateway`, `AI_GATEWAY_API_KEY`); the request and response shapes stay TypeSafe's own, so only the base URL and key change. No second provider is registered.

TypeSafe route resolution order:

1. Pi's provider authentication (`auth.json`, then `TYPESAFE_API_KEY`, including supported Pi runtime overrides).
2. `TYPESAFE_API_KEY` directly when running without Pi's auth service.
3. An explicitly configured host-side command, if neither is available.

The Vercel AI Gateway route resolves Pi's `vercel-ai-gateway` provider authentication first (`auth.json`, then `AI_GATEWAY_API_KEY`), then `AI_GATEWAY_API_KEY`, then the same trusted `jev.credentialCommand`.

SubQ model IDs (`subq-snap-preview`) post to SubQ's own `/v1/systemone` at `api.subq.ai`: SubQ Snap is a System One model with TypeSafe's request and response shapes, and it reports no output tokens. The SubQ route resolves Pi's `subq` provider authentication first (`/login subq` in `auth.json`, then `SUBQ_API_KEY`), then `SUBQ_API_KEY`, then the same trusted `jev.credentialCommand`. A TypeSafe key is never sent to SubQ, nor a SubQ key to TypeSafe.

The OpenRouter route resolves Pi's `openrouter` provider authentication first (`auth.json`, then `OPENROUTER_API_KEY`), then `OPENROUTER_API_KEY` or `TYPESAFE_OPENROUTER_API_KEY`, then the same trusted `jev.credentialCommand`.

For Localterm, set this in your trusted `fabric.json` (never put the resolved secret into model-visible code):

```json
{
  "jev": {
    "credentialCommand": ["localterm", "secret", "get", "typesafe_api_key"]
  }
}
```

The command uses argv, not a shell. It runs only when inference needs a key, with a timeout and bounded private output. Successful command credentials are cached until provider reload. Pi credentials are resolved afresh, so login/logout changes are honored. The key is never placed in the guest, request body, browser, or returned diagnostics. HTTP errors expose status codes, not response bodies or headers. Requests use the fixed TypeSafe HTTPS endpoint and reject redirects.

`await jev.status()` reports configuration presence without running the command or making an authentication request. `verified: false` means this status operation did not verify a credential; presence does not prove validity. Missing auth does not prevent deterministic programs from running.

## Auto-mode tool safety

Jev can also serve as the host's auto-approval classifier, independently of programs and observers. Choose **Approvals → Auto model** in `/fabric settings`, or set `approvals.model` to `"pi-fabric/typesafe/jev-latest"` and the relevant risk policies to `"auto"`. The picker also offers the pinned `pi-fabric/typesafe/jev-1.13`, `pi-fabric/typesafe/jev-1.13.0` and `pi-fabric/typesafe/jev-1.14.0` aliases and `pi-fabric/typesafe/jev-preview` (Jev 1.14; `jev-latest` stays on 1.13 until TypeSafe moves it), plus OpenRouter-served `pi-fabric/openrouter/jev-latest`, `pi-fabric/openrouter/jev-1.13` and `pi-fabric/openrouter/jev-1.14`, Vercel AI Gateway-served `pi-fabric/vercel-ai-gateway/jev-latest`, and SubQ-served `pi-fabric/subq/subq-snap-preview` (`/login subq` or `SUBQ_API_KEY`). Authenticate with `/login jev` and `TYPESAFE_API_KEY` on the TypeSafe route, `/login openrouter` and `OPENROUTER_API_KEY` on the OpenRouter route, or `/login vercel-ai-gateway` and `AI_GATEWAY_API_KEY` on the Vercel AI Gateway route.

The host asks four typed Noul questions in one request - safety, secrets exposure, destructive effect, and whether the action targets only artifacts this session created - and never uses generated text or a chat-model adapter. Auto-allow requires the safety probability at or above `jev.autoApprovalThreshold` (default **0.50**) **and** the secrets and destructive probabilities below 0.5; lower scores, a positive secrets or destructive judgment, missing user text, and errors require explicit approval. When a Jev model is selected, **Approvals → Jev minimum probability** lets you enter any finite value from 0 to 1. Higher values are more conservative; 0 allows every judgment whose secrets and destructive verdicts are clean. This is a probabilistic advisor, not a hard security boundary or a correctness guarantee. Read [auto approval configuration](configuration.md#jev-as-the-auto-mode-classifier) for the current-turn evidence, session-action projection, outbound data disclosure, credential behavior, timeout and usage rules. Jev remains absent from ordinary chat-model pickers.

## Direct judgments

```ts
const result = await jev.evaluate({
  state: { message: "Please refund the duplicate charge." },
  questions: {
    route: {
      type: "choice",
      instructions: "Which team should handle the request in `message`?",
      criteria: {
        billing: "Invoices, charges, refunds",
        technical: "Broken software",
        other: "None of these teams fits",
      },
    },
    refund: {
      type: "noul",
      instructions: "Does `message` explicitly request a refund?",
    },
  },
});
return { team: result.answers.route.choice, refundProbability: result.answers.refund.noul };
```

- **Choice:** selects a supplied option; returns its distribution and concentration-based confidence. Include a no-match option where needed.
- **Noul:** probability of yes; no separate confidence value.
- **Score:** probability-weighted position on 2–10 ordered descriptive levels, not necessarily a 0–1 score.
- Questions are independent and share the same state. Batch independent/speculative questions; a later answer cannot be referenced inside that same request.
- IDs are for code, not model instructions. Put the full judgment in `instructions`.
- Keep exact rules, arithmetic, source extraction, action execution, and permissions in code. Confidence is neither truth nor authorization.
- State is sent to TypeSafe. Bound and minimize browser/application data; do not send secrets or unrelated private content.

Fabric accepts up to 128 questions and 255 Choice options per question, subject to the configured request byte cap and upstream limits. Structured JSON instructions/rubrics are supported. Service failures are not automatically retried: a controller must decide whether a retry is affordable and its observation is still fresh. A received transient HTTP status (408, 429, 500, 502, 503, 504 or 529) rejects with numeric `status` and, when the response sends `Retry-After-Ms` or `Retry-After`, `retryAfterMs` (whole milliseconds, at most one day) on the error object. For HTTP 429/529, back off; do not spin.

## Foreground and background

`wait` is canonical for both providers. `jev.join({id})` aliases `jev.wait({id})`, just as `agents.join({id})` aliases `agents.wait({id})`. Each alias preserves its provider's result, cancellation, and notification behavior.

Both entry points accept `{ program, input }`; only `spawn` additionally accepts `observe`. The program is an ordinary serializable artifact that you can save and reuse.

```ts
const specification = {
  name: "route-tickets",
  inputSchema: {
    type: "array",
    items: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  outputSchema: { type: "array", items: { enum: ["billing", "technical", "other"] } },
  requires: ["jev.evaluate"],
  limits: { timeoutMs: 60000, maxEvaluations: 20, maxToolCalls: 100, maxTokens: 20000 },
  code: `
    const routes = [];
    for (const ticket of input) {
      const judgment = await jev.evaluate({
        state: ticket,
        questions: {
          route: {
            type: "choice",
            instructions: "Which team handles the request in this ticket's text?",
            criteria: { billing: "Invoices and refunds", technical: "Broken software", other: "Neither" },
          },
        },
      });
      routes.push(judgment.answers.route.choice);
      await program.emit({ processed: routes.length });
    }
    return routes;
  `,
};
const run = await jev.run({ program: specification, input: [{ text: "I was billed twice" }] });
if (run.state !== "completed") throw new Error(run.error ?? run.state);
return run.result;
```

Use named Fabric payloads when large code strings are awkward to quote. In a Jev program:

- `input` contains the validated JSON input.
- `jev.evaluate(...)` makes typed judgments; it must be included in `requires`.
- `program.sleep(ms)` yields and is cancellable. Use it to pace polling or backoff.
- `program.emit(value)` records a bounded progress event.
- With `observe` on spawn, `program.nextEvent()` waits for Main lifecycle events without polling.
- `program.advise({eventId,message})` supplies the run ID to the policy-checked `jev.advise` action; declare that exact capability and opt into delivery.
- `tools.call({ ref, args })` and ordinary Fabric provider proxies call only exact `requires` refs. Discovery is not a way to acquire additional authority. A provider another extension registers is a typed global, such as `app.control(args)`, only when `requires` names one of its actions; see [program globals](providers.md#program-globals-and-types).
- The same QuickJS context persists for the whole run: local variables and data structures survive every iteration. No host imports, `process`, or direct `fetch` are available.

A reactive controller can use `while (true)` with these primitives. Observe fresh state, construct questions/candidate IDs, evaluate, verify applicability, act, and observe again. Revalidate target IDs/revisions before applying a decision. Define a no-match or escalation path. There is no mandatory model-generated planning step in the loop and no built-in 10 Hz guarantee: end-to-end rate includes observation, inference, and action latency.

```ts
const task = await jev.spawn({ program: specification, input: [{ text: "Settings crashes" }] });
// Main can do other work now.
const progress = await jev.status({ id: task.id, after: 0 });
const terminal = await jev.wait({ id: task.id });
// Or: await jev.stop({ id: task.id });
```

`run` and `wait` return a **run envelope**, not the bare output: `state`, `result` or `error`, usage, counts, logs, timestamps, and progress events. States are `running`, `completed`, `failed`, `cancelled`, or `timed_out`. Input/schema/typecheck/capability errors reject before launch; execution/output-validation failures become terminal envelopes.

Foreground cancellation cancels the run. Cancelling a `wait` only cancels that wait. A spawned run is independent of the spawning tool's cancellation once launch succeeds, but belongs to this session's Jev provider. Reload/unload/shutdown cancels it. It is **not durable across Pi restarts**, and stop is not rollback of already-issued effects.

Status retains the latest 64 events (4 KiB each); use `sequence` and `nextSequence` to detect gaps. Logs are capped at 4 KiB; program input and final JSON output are each capped at 32 KiB. Terminal runs are retained in a bounded in-memory history; old IDs eventually expire. There is no unlimited hidden transcript or per-tick reasoning agent.

## Realtime loops

A realtime controller is one program: observe, judge, act, pace, repeat. Two decision shapes cover the published realtime examples: [Jev Ultrafast](https://github.com/browser-use/jev-ultrafast) and [jev-doom-agent](https://github.com/lukaske/jev-doom-agent).

- **Operation plus speculative targets.** One request asks which operation to run and, separately, which target each operation would use. Code applies only the target head matching the chosen operation. This is the browser-agent shape: a dynamic element table, one network round trip, one executed action.
- **Factorized control axes.** One request asks several independent questions whose answers execute together, for example movement / view / trigger / interaction. This is the shape of the browser-native Doom example.

Both are ordinary `jev.evaluate` batches: keep independent questions in one request, and keep the mapping from answers to effects in code. A counterfactual head that is not executed is still a judgment; never let unused heads write state.

### Persistent children

When observation or control goes through a long-lived process (a game bridge, a harness `serve`, a REPL), open it with `sessions.open` and exchange lines with `sessions.write` and `sessions.read` (long-poll `waitMs`, byte `offset`/`next`). A write reaches the child's stdin at once; a session child ends when the program ends. [Shell composition](shell-composition.md#a-realtime-loop) has a complete controller.

### Observation stays structured state

Read the application's own state through its CLI or a task-specific script, and project it into a compact object with a revision. Include the facts the judgment needs and nothing else: player/entity/environment fields, the previous action, and bounded history are usually enough. Screenshots are not part of the typed request contract; keep pixels out of `state`, and never send secrets.

### Code owns the motor layer

Jev selects a tactic; code decides how to execute it. A timed pulse with an epoch guard is what survives a realtime loop: apply an input mask, hold it for a bounded interval, release it only while it is still the newest pulse, then re-observe.

```ts
let epoch = 0;
async function pulse(mask: string, durationMs: number) {
  const mine = ++epoch;
  await tools.call({ ref: "app.control", args: { mask, epoch: mine } });
  await program.sleep(durationMs);
  if (mine === epoch) await tools.call({ ref: "app.release", args: { epoch: mine } });
}
```

Revalidate the revision you decided from before applying anything. A rejected or stale action means re-observe and re-decide, not retry blindly.

### Degraded mode must be labeled

A realtime loop needs a deterministic fallback for every degraded decision: a failed request, an invalid response, or confidence below your threshold. Compute the fallback in code, replace the judgment, and record it, so the UI and telemetry never present it as a model decision.

```ts
let degraded = false;
try {
  const decision = await jev.evaluate({ state, questions });
  if (decision.answers.action.confidence < 0.5) degraded = true;
  else frame = decision.answers.action.choice;
} catch (error) {
  degraded = true;
  const { status, retryAfterMs } = error as { status?: number; retryAfterMs?: number };
  if (status === 429 || status === 529) backoffUntil = Date.now() + (retryAfterMs ?? 1000);
}
if (degraded) { frame = deterministicFallback(state); await program.emit({ fallback: true, frame }); }
```

Skip `jev.evaluate` until `backoffUntil` passes, and keep applying the deterministic fallback meanwhile.

Confidence is neither truth nor authorization; a low-confidence answer is a reason to fall back, not a reason to act. Fabric validates the response before it returns it. An invalid choice, probability set, or confidence rejects the evaluation without surfacing a partial answer, so `catch` is part of the loop. The response's well-formed reported usage still counts against the run's evaluation and token budgets, and later evaluations proceed within them. A transient HTTP error counts as one evaluation and bills the usage its body reports, or else a fixed cost of the request body's UTF-8 byte length as input tokens and 0 output tokens; later evaluations proceed within the budgets, so a guest that retries forever stops at `maxEvaluations` or `maxTokens`. This applies to the in-process transport; a failed request dispatched through jev-fabric has unknown usage. A failure whose usage is unknown (a network error, a timeout or cancellation, any other HTTP status, or a response without valid usage) closes inference for the rest of the run, because it may have been billed.

### Budget arithmetic for sustained loops

Default per-run limits are 60 seconds, 100 evaluations, 1,000 host calls, and 100,000 reported tokens. `program.sleep` and `program.emit` are host calls and count against `maxToolCalls`, so a paced loop spends budget even when it is not touching the world. At 10 Hz with observe, evaluate, control, release, and sleep, that is five host calls per tick: the default 1,000 host calls last about 20 seconds, and the default 100 evaluations about 10 seconds. A sustained run needs explicit limits and a raised host ceiling:

```json
{
  "jev": { "maxDurationMs": 3600000, "maxEvaluations": 100000, "maxToolCalls": 1000000, "maxTokens": 100000000 }
}
```

Per-program `limits` are clamped to these ceilings (24 hours, 100,000 evaluations, 1,000,000 host calls). Duration and evaluation count are the real liveness bounds; the wall-clock deadline and terminal state are always reported in the run envelope.

### Telemetry and shutdown

Spawn the loop with `jev.spawn` so Main stays responsive and can inspect it. The event ring holds the latest 64 events (4 KiB each), roughly six seconds at 10 Hz, so drain it with `jev.status({ id, after })` from the supervising turn or persist it host-side; terminal runs live only in a bounded history. At most one evaluation may be in flight per program, so batch independent questions, avoid hedging decisions, and run two engines as two programs (`jev.maxConcurrentRuns`).

Stop a loop with `jev.stop({ id })`, provider reload/unload, or a code-owned terminal rule such as death, goal reached, or a no-match judgment. Cancellation aborts in-flight inference and host calls, but it is not rollback of effects already issued.

`tests/jev-realtime-loop.test.ts` is the deterministic reference for both shapes, the pulse/epoch pattern, labeled degraded mode, a death stop, and status/stop on a paced run.

## Main-turn advisors and supervisors

For a ready-to-use coding-supervision policy, invoke `/skill:fabric-foreman <goal>`. It uses these same primitives with per-turn or settlement cadence, ten batched judgments, and bounded deterministic interventions. See [the Foreman capability comparison](foreman.md).

`jev.spawn({program,input,observe})` can subscribe to the owning Main session. This is an **event-driven sidecar**, not another reasoning agent or a polling loop. It works with mesh disabled. It is not a mesh participant, a cross-session subscription, or restart-durable storage; do not pass its run ID to `agents.subscribe`.

The program retains local state, awaits `program.nextEvent()`, asks typed questions, then records a judgment with `program.emit`. To intervene, explicitly configure `observe.delivery` and declare `jev.advise` in `requires`. `program.advise({eventId,message})` supplies the current run ID; the public equivalent is `jev.advise({id,eventId,message})`. Observer launch also requires read approval for future Main event access. Advice is an `agent`-risk emission and passes normal approvals, authorization, and pinned capability checks. Jev selects judgments; program code writes the message and policy.

The example deliberately opts into selected text and steering. The 0.9 threshold is illustrative and needs evaluation on representative tasks. For a record-only advisor, omit `delivery`, remove `jev.advise` from `requires`, and omit the `program.advise` call. Neither enabling Jev nor omitting `include` grants transcript access.

```ts
const observer = await jev.spawn({
  input: null,
  observe: {
    events: ["turn_end"], include: ["assistantText", "toolResults"],
    maxChars: 4096, queueSize: 8,
    delivery: "steer", triggerTurn: false, maxAdvice: 2,
  },
  program: {
    name: "verification-advisor",
    inputSchema: {type:"null"}, outputSchema: {type:"null"},
    requires: ["jev.evaluate", "jev.advise"],
    limits: {timeoutMs:600000, maxEvaluations:40, maxToolCalls:200, maxTokens:20000},
    code: `
  for (let i = 0; i < 40; i++) {
    const event = await program.nextEvent();
    if (event.truncated) {
      await program.emit({eventId:event.id, review:"truncated context"});
      continue;
    }
    const result = await jev.evaluate({
      state: {turn:event.payload},
      questions: {
        contradiction: {
          type: "noul",
          instructions: "Does assistantText claim completion while toolResults explicitly show an unresolved relevant failed check? Missing context alone is not evidence of failure.",
        },
      },
    });
    const probability = result.answers.contradiction.noul;
    const advice = probability >= 0.9
      ? await program.advise({eventId:event.id, message:"Check the reported failing verification before claiming completion."})
      : null;
    await program.emit({eventId:event.id, probability, advice});
  }
  return null;
`,
  },
});
return {id:observer.id, state:observer.state};
```

**Return the ID immediately. Do not wait/join an active observer inside Main's turn:** Main must finish turns to supply events. Foreground `jev.run` with `observe` is rejected. Inspect `jev.status({id})` occasionally or use `jev.stop({id})` to terminate it. Existing duration, inference, token, CPU, and host-call budgets still apply, including while waiting for an event. No automatic inference is performed by the event bridge.

### Observation and data-sharing contract

- `events`: a nonempty subset of `input`, `turn_end`, `tool_error`, `agent_end`, `agent_settled`. These are local host-event names, not mesh `pi.*` names. No replay of events before launch.
- `include`: defaults to `[]` (operational metadata only). `inputText` selects raw input-event text; `assistantText` selects the completed turn's visible text; `toolResults` selects bounded tool-result text and error metadata from `turn_end`/`tool_error`. Each applies only where that event carries it. Settlement events do not implicitly carry a transcript. Keep goals/history in bounded explicit input or the program's own prior observations.
- Never automatically includes thinking, system prompts, request headers, images, tool arguments, tool-result `details`, or session history. Common credential patterns are redacted as defense in depth, **not a guarantee that opted-in free text contains no secrets**. Obtain consent before sending selected text to TypeSafe and treat it as untrusted evidence.
- `maxChars`: 256–8,192, default 4,096, bounds the projected payload; `truncated` flags incomplete evidence. A truncated payload may be a string in place of an object. Extraction also caps content blocks and tool-result count. Do not infer success or safety from missing/truncated evidence.
- `queueSize`: 1–32, default 8; oldest queued events are dropped on overflow. `maxEventAgeMs`: 100–300,000, default 30,000; expired queued events are discarded. This is bounded best-effort observation, not a lossless audit stream. `nextEvent` allows only one pending consumer; consume/classify sequentially.
- Each event has `{id,sequence,event,source:"main",sessionId,revision,at,payload,truncated}`. `status.observation` reports subscribed events, received/consumed/dropped/queued counts, and delivered/suppressed advice; progress `status.events` remains the separate 64-entry `program.emit` ring.

### Delivery, freshness, and interruption

Delivery defaults to off. Opt into `"steer"` or legacy `"followUp"` (both deliver Main feedback as hidden steering); `triggerTurn` defaults to false and never wakes idle Main when false. UI hosts show a bounded notification naming the advisor and omit the chat bubble. The full advice remains in model context and session audit, with actual and requested delivery modes. `maxAdvice` bounds delivery attempts for the run (feedback/stale suppression does not consume a delivery attempt) (1–16, default 4). Advice must be sent before requesting the next event; it needs the last consumed event ID and must still match the latest completed-turn/task/context revision and age limit. A next turn may be in flight; a newer completed turn, real input, compaction, or cancellation invalidates old advice. The check is at enqueue time, not a guarantee that context cannot change before Main consumes a queued message.

There is at most **one delivery attempt across all Jev observers per external user input**. Automatic continuations and extension-injected input do not reset this feedback latch. Duplicate, stale, disabled, over-budget, feedback-gated, or failed deliveries return `{delivered:false,reason}`; failures are not replayed. This prevents an advisor from repeatedly waking/steering Main based on its own intervention. Additional turns may still be classified and recorded within budget. Broader separately granted tools retain their own authority; these safeguards specifically govern `jev.advise`.

Main abort (including RPC/SDK abort), Escape when `ui.haltOnEscape` is enabled, tree navigation, and provider reload/unload/shutdown cancel observing runs and discard their inboxes. Cancellation does not resurrect them on the next input; create a replacement only when requested. Ordinary non-observing spawned programs keep their existing detachment semantics. Cancelling only a wait does not stop a program. A separate Main abort also cancels its observers. These are asynchronous post-turn advisors, **not pre-execution safety gates** and not rollback of effects already issued.

## Schemas and limits

Input and output schemas are checked at runtime. The supported JSON Schema subset is `type` (one type), `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `anyOf`, `oneOf`, `allOf`, numeric/string/array/object min/max bounds, `description`, and `title`. References, regexes, unknown keywords, and excessive depth/size are rejected, never silently trusted. Use `anyOf` for unions. `{}` permits any finite JSON value. Return `null` explicitly for programs without a result; `undefined` is not JSON.

Program TypeScript gets semantic diagnostics before execution. Runtime validation remains authoritative; TypeScript annotations are not a security boundary. The guest has at most 64 MiB memory (or the lower configured executor limit), 128 pending timers, and a 100 ms uninterrupted CPU limit. Awaiting host work or timers yields a fresh CPU slice; an infinite synchronous loop is terminated without freezing Pi for the whole run deadline.

Default per-run limits: **60 seconds, 100 evaluations, 1,000 host calls, 100,000 reported tokens**. `program.limits` can request different values, clamped to trusted host ceilings:

```json
{
  "jev": {
    "enabled": true,
    "model": "jev-latest",
    "requestTimeoutMs": 15000,
    "maxRequestBytes": 131072,
    "maxConcurrentRuns": 4,
    "maxRetainedRuns": 64,
    "maxDurationMs": 900000,
    "maxEvaluations": 1000,
    "maxToolCalls": 10000,
    "maxTokens": 1000000
  }
}
```

`jev.transport` chooses where program decisions are dispatched. `"fabric"` (default) keeps them in this process. `"auto"` opts into one jev-fabric `serve` connection per program run when a compatible binary resolves (macOS/Linux; see [which jev-fabric](shell-composition.md#which-jev-fabric)), with the request, route, and a per-request credential passed over its private pipe and the answer validated by both; otherwise it stays in-process. `"jev-fabric"` requires the binary. Direct `jev.evaluate` calls and the auto-approval classifier always stay in-process, and this process's per-run budgets apply first either way.

Duration can be configured up to 24 hours. Evaluation slots are reserved before dispatch, including failed requests. One evaluation may be in flight per program; batch independent questions to avoid building an inference backlog. Other granted tool calls may run concurrently. Token usage is reported **after** inference: exceeding the token threshold stops the program before it can use that answer, but the final request can overshoot the threshold and still incurs charges. This is not a hard dollar-spend limit. Request-size and evaluation-count limits are the pre-dispatch bounds. Failed requests with no usage report may still have incurred upstream charges.

Every external action keeps Fabric argument validation, approvals, Schema policy, and a pinned capability generation. A restricted caller cannot widen its own capability view by spawning a program. Recursive Jev lifecycle calls are denied inside programs. Jev is unavailable in Schema enforce and managed-host modes. Other deliberately granted capabilities can be powerful: **granting `pi.bash` or an unrestricted evaluator is not a read-only sandbox** and can defeat data-isolation assumptions. Shell effects run with host privileges; QuickJS isolation does not sandbox a granted shell. Follow the harness-owned CLI/library contracts without adding a Fabric adapter.

## Browser and desktop tools

Use the existing harness CLIs through the shell, without Fabric-specific adapters, component configuration, or browser/macOS provider refs. Read [Harness CLI composition](harnesses.md) and the harness-owned skills first. Browser connections, native permissions, persistent controller state, and effect verification remain owned by the harness, not Jev.

## Verification

Offline targeted suites live in `tests/jev-*.test.ts`. Live tests are opt-in and operate only on synthetic text/observations:

```sh
PI_FABRIC_JEV_LIVE=1 bunx vitest run tests/jev-live.test.ts
# Explicitly opt into the private Localterm resolver:
PI_FABRIC_JEV_LIVE=1 PI_FABRIC_JEV_LOCALTERM=1 bunx vitest run tests/jev-live.test.ts
```

After `bun run build`, `bun run test:jev:dist` checks the compiled public entry point, auth-only registration, foreground generic capability dispatch, and background stop/wait, agent/Jev join aliases, and event-driven Main advice.

No real browser state or secrets are printed by these probes. Live tests exercise all three primitives, foreground/background inference loops, and a feedback controller using changing synthetic screen observations and source control IDs. `tests/jev-realtime-loop.test.ts` replays both realtime shapes offline: batched target heads with one request per tick, factorized control axes with pulse/epoch motor control, labeled degraded decisions, a death stop, and status/stop on a paced loop. `tests/jev-shell.test.ts` exercises actual local subprocesses, event-driven wait/watch, zero-inference programs, one explicit mocked decision, and unchanged capability/approval gates. No personal browser or native app is controlled.

Jev host APIs and types are exported from `pi-fabric/jev`. There are no browser/macOS adapter exports. Generic optional providers can still register through `pi-fabric/protocol`, but harness CLI composition requires no provider registration. Fabric lifecycle and trust semantics are detailed in [components.md](components.md). Current TypeSafe contracts: [API](https://docs.typesafe.ai/api), [Choice](https://docs.typesafe.ai/primitives/choice), [Noul](https://docs.typesafe.ai/primitives/noul), [Score](https://docs.typesafe.ai/primitives/score), and [confidence](https://docs.typesafe.ai/confidence).
