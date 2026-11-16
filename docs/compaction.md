# Deterministic compaction

Pi Fabric provides an LLM-free compactor through `session_before_compact`. This compactor is the default engine. Set `compaction.engine` to `"pi"` to defer to Pi's compactor. Another extension can take compaction alone, keeping Fabric's `/tree` summaries, through a [compaction owner claim](programmatic-compaction.md#compaction-owner-claim).

Fabric keeps a bounded recent raw continuity tail after compaction. The tail uses Pi's active `keepRecentTokens` setting, which defaults to 20,000 tokens. Fabric rebuilds the older state into its deterministic summary. Pi's native cut and Codex-style checkpoint compaction use the same fresh-window principle. The summary carries durable state, and a small raw suffix keeps the recent conversation coherent for the model.

`compaction.targetContextRatio` sets a hard occupancy ceiling that applies after compaction. Fabric never treats the ceiling as space to fill. The value defaults to 65%, and you can change it from `/fabric-settings` (shown as **Max occupancy**) or in JSON. Allowed values are bounded to `0.25`–`0.85`:

```json
{
  "compaction": {
    "engine": "fabric",
    "targetContextRatio": 0.65
  }
}
```

Configure Pi's continuity tail in Pi's `settings.json`:

```json
{
  "compaction": {
    "keepRecentTokens": 20000
  }
}
```

Use `{ "compaction": { "engine": "pi" } }` to disable the Fabric engine.

`/fabric settings` also exposes a **Threshold** for the active model. It
supports two modes: a window-occupancy percent or an exact token count
("Custom tokens…"). Fabric stores thresholds by canonical `provider/model`
key, so switching models selects that model's own value. `Pi default` clears
both maps and leaves Pi's built-in threshold unchanged.

```json
{
  "compaction": {
    "thresholds": {
      "anthropic/claude-sonnet-4-5": 0.8,
      "openai/gpt-5.4": 0.9
    },
    "tokenThresholds": {
      "google/gemini-3-pro": 400000
    }
  }
}
```

Fabric bounds percent thresholds to `0.25`–`0.95` and rounds token thresholds
to integers bounded to `1,000`–`100,000,000`. When a hand-written config sets
both for one model, the token threshold wins. A configured threshold lower
than Pi's built-in threshold makes Fabric trigger compaction at a safe settled
boundary. When Pi's built-in threshold is lower, Fabric defers that automatic
compaction until the model reaches its model-specific threshold. Fabric never
defers overflow and manual compactions. Under a compaction owner claim,
Fabric neither triggers nor defers: the owner runs its own thresholds.

## Headroom trigger

`compaction.outputReserveTokens` (default `0`, disabled) keeps room for the
next response. When it is positive, Fabric also compacts at the settled
boundary once `contextWindow - tokens < outputReserveTokens`, independent of
any model threshold, and it never defers Pi's own threshold compaction while
the reserve is breached. `compact.status().lastAuto` records the last host
compaction attempt with `trigger: "headroom" | "tokens" | "ratio"`.
`compaction.pressureBands` (default `{ "warn": 0.6, "urgent": 0.8 }`) only
labels `compact.pressure()`; it never triggers compaction. Both values must
satisfy `0 < warn < urgent < 1`, or Fabric uses the defaults.

```json
{
  "compaction": {
    "outputReserveTokens": 16000,
    "pressureBands": { "warn": 0.6, "urgent": 0.8 }
  }
}
```

See [programmatic compaction](programmatic-compaction.md#pressure) for the
pressure reading and the persistent [carry-forward focus](programmatic-compaction.md#carry-forward-focus)
rendered under `[Carry Forward]`.

## Invariants

1. **The session log is ground truth.** The summary is a bounded continuation view with stable entry-id and file addresses.
2. **Live cut and cumulative truth are separate.** The cut comes from the window made live by the last compaction. Fabric rebuilds the summary from every typed, content-bearing entry on the supplied active branch prefix before the new kept boundary, after applying branch-relative `context_edit` omissions and content replacements. Abandoned recovery attempts remain addressable in raw history but never reappear in later summaries. System prompt/tool checkpoints are replayed by Pi, not selected as continuity content.
3. **Rendered summaries are never semantic input.** `compaction` entries, branch-summary prose, custom summary prose, and unknown roles produce no normalized events. A valid Fabric branch-summary details envelope may contribute its typed facts. Its `summary` string never contributes. Top-level Pi `custom_message` entries work differently: Pi puts them in model context, so Fabric preserves their typed `customType`, text content, visibility, and bounded JSON details. A visible custom message whose typed `details.source` is exactly `"user"` carries the user's own words from an input extension, such as a steering queue, and counts as a user message. `custom` state entries that bear no context remain excluded.
4. **Structure drives projection.** The core uses entry/message types, roles, content-part types, custom-message fields, tool names, typed `fabric_exec` display fields, JSON arguments, call ids, `isError`, aggregate trace outcomes, exit codes, entry ids, ordering, valid Fabric execution traces, and valid Fabric branch-summary facts. It applies no semantic regex over prose, code, shell commands, or tool output. Whitespace normalization, bounded truncation, exact identity comparisons, and path segmentation stay mechanical.
5. **Serialization is deterministic and bounded.** Identical branch entries and instructions produce byte-identical output. The rendered result is at most 32 KiB in UTF-8.
6. **The nominal model window is the safety boundary.** Fabric never treats it as a target to fill. Fabric calibrates Pi's structural token estimate against `preparation.tokensBefore`, retains the largest closure-safe suffix within Pi's bounded `keepRecentTokens` continuity budget, and treats the configured occupancy ratio, Pi response reserve, estimator-error margin, and pre-compaction size as hard ceilings. Undocumented provider headroom never enters the budget.

These invariants prevent compounding summary-chain drift, not all semantic
forgetting. Pi replaces the previous rendered summary on each compaction.
Fabric re-derives recent dialogue, earlier user messages, cumulative successful
file addresses, and error state from raw branch history every time. The
protected dialogue window is bounded continuity, not permanent decision memory.

## Loss model and memory

Fabric compaction is **source-lossless and addressably lossless**. The model's bounded continuation view does not stay byte-for-byte lossless:

- Compaction appends a marker. It never deletes or rewrites raw session JSONL. The active parent-linked session branch remains ground truth.
- The model receives a bounded deterministic projection plus the recent raw continuity tail. Fabric preserves the user's messages verbatim, role-labelled recent dialogue, declared Fabric run intent paired with aggregate outcomes, file operations, failures, status, and stable addresses through mechanical rules. Arbitrary old prose, tool-output bodies, and thinking may fall out of the inline view.
- Every sampled omission records a count and source entry-id range. `memory.expand` can re-read exact untruncated source by stable entry ID or operation address with source-hash and lineage checks.
- The memory index remains derived and disposable. Compaction works without successful indexing, and it never treats an incomplete index as ground truth. Exact expansion reads session JSONL.

Near-lossless continuation comes from three layers: dense typed projection for
normal work, a bounded raw tail for immediate local coherence, and
integrity-bound source recall for exact old detail. Deleting the source
session removes the final exact-recall layer.

## Pipeline

```text
active branch entries ─┬─► live window ─► calibrated token budget ─► closure-safe cut ─► firstKeptEntryId
                       └─► raw cumulative prefix ─► normalize ─► project ─► bound/render
```

- `normalize.ts` converts raw message and top-level `custom_message` entries to typed events. It selects custom content only from typed string or text parts, keeps JSON details depth/node/collection/string/byte bounded, and omits malformed details while otherwise valid content stays. Assistant thinking parts count as deliberation, so normalization never turns them into events. Summaries carry side effects and state, and truncated scratchpad text that could read as fact stays out. The compactor records how many thinking blocks it erased, so the omission stays auditable. Only `toolCallId` pairs each tool call with its result. A completed `fabric_exec` with a non-empty typed `display.name` contributes a bounded declared-intent event that carries its optional `display.description`, aggregate outcome, and call address. A `fabric_exec` result contributes nested events only through a valid `details.trace` V1 guard, or through the separate strict legacy `details.audits` adapter when no `trace` field exists.
- `dialogue.ts` selects the last three eligible user exchanges and their preceding text-bearing assistant responses, independent of tool-event volume. Fully raw exchanges are excluded before the three-exchange limit; summarized and crossing exchanges remain eligible. It joins text parts from the same assistant entry, excludes thinking, and bounds complete multiline excerpts with explicit omitted-byte markers. It never infers acceptance or supersession from prose.
- `projections.ts` computes protected dialogue, historical request, file, operation-state, turn, status, and transcript views.
- `enrichers.ts` permits deterministic optional annotations. Fabric ships no built-in enrichers.
- `render.ts` independently bounds every rendered block and enforces the global UTF-8 limit.
- `hook.ts` computes the live cut, selects cumulative source, emits v2 details, and implements Pi/pi-vcc precedence.

## Live cut and closure

The last compaction marker identifies the live window:

- a valid `firstKeptEntryId` starts the window at that entry.
- a compact-all marker or missing/orphan kept id starts it after the marker.
- without a marker, the whole supplied active path is live.

When Pi supplies the active model metadata, Fabric chooses the live cut from a calibrated bounded continuity budget:

1. Sum Pi's public structural message estimates for the current context.
2. Calibrate that estimate with `preparation.tokensBefore`, which compensates for provider tokenization, system prompts, tool schemas, and other fixed context that a character heuristic cannot observe directly.
3. Set the continuity target to calibrated fixed overhead plus Pi's `keepRecentTokens` and the maximum 32 KiB summary reservation. The absolute recent-tail budget does not grow with a 200K, 1M, or proxy-inflated advertised window.
4. Clamp that target to all independent safety ceilings: `contextWindow × targetContextRatio`, 90% of `contextWindow - reserveTokens`, and 95% of `tokensBefore`. The last ceiling prevents a low-usage manual compaction from expanding context. The advertised window is authoritative for threshold and manual compaction. Overflow recovery treats the failed request as stronger evidence: an API rejection proves the effective window is below `tokensBefore`, so Fabric first clamps the working window to 90% of the observed failed size.
5. Select the earliest eligible boundary whose retained suffix fits the resulting raw-tail budget. Suffix size decreases monotonically, so this boundary gives the largest legal raw suffix. User/custom boundaries and assistant boundaries are both eligible, which lets Fabric split a single enormous autonomous turn during compaction. On repeated compaction, the kept boundary must follow the previous compaction marker in raw log order. Pi replays entries contiguously from `firstKeptEntryId`, so a boundary before that marker would replay the old rendered summary beside the new one.

Fabric computes structural spans for every call id across the supplied branch
and rejects every candidate cut that separates an actual call/result pair.
This enforces both directions:

- a summarized tool call never has a kept result.
- a kept tool call never has a summarized result.

This pairing check handles parallel calls, delayed results, reverse or
malformed ordering, and malformed prior boundaries. When no non-crossing
boundary fits, Fabric uses compact-all (`firstKeptEntryId: ""`), and no kept
side remains to orphan either half. If the rendered deterministic summary
itself would push the calibrated projection over the target, Fabric cancels
the compaction to avoid persisting an expanding or over-budget result. If
model metadata is unavailable, Fabric keeps the legacy closure-safe whole-turn
cut only when that tail fits `keepRecentTokens` (20,000 by default). Oversized
turns use the same bounded suffix selector, including assistant boundaries;
if no legal suffix fits, Fabric compacts everything. Preparation settings
still apply without a model window. This fallback emits no fabricated model
window or calibrated budget metadata. Its bound is on structural raw-tail
estimates plus the bounded summary, not unknown fixed provider overhead.

When Fabric cancels a manual or overflow compaction because it cannot produce
a summary (nothing to cut, no raw source, or no summary that fits the target),
a UI context receives a bounded warning naming the reason. A cancelled
threshold compaction stays quiet: Pi rechecks the threshold before every
assistant response, so a warning there would repeat on each call.

The live cut determines only what Pi keeps. The summary source is the raw
active-branch prefix before that new boundary. Normalization skips earlier
compaction and branch-summary prose within that prefix. For dialogue selection
only, Fabric also reads user/assistant text in the kept tail. If an exchange
crosses the cut, its summarized assistant response stays inline and its user
reply is addressed as `retained raw`, without duplicating the reply. Fully raw
exchanges need no summary copy and do not consume protected-window slots.
Newer raw instructions still take precedence over earlier summarized context.
This does not change cut selection.

Compacted trajectory handoffs use the resolved destination model window,
Fabric occupancy ceiling, and Pi's destination-specific compaction settings
when available. Settings are read at handoff use, respecting project trust.
Source-model usage does not calibrate a new executor; its budget uses structural
estimates until target usage exists. The finalized outer tool result and any
thinking-transfer digest enter the child log before compaction, so neither
escapes the cut and the outer call/result pair remains closure-safe. A failed
requested handoff compaction rejects the handoff and prevents the
uncompacted fork from launching. Without destination metadata, the bounded fallback applies.

## Context salience

A summary is what the model reads in place of the work it no longer sees, so
its byte budget follows the user's words, not the volume of activity. A long
autonomous stretch produces thousands of tool events and only a few user
messages. A summary sized by activity lets the user's objective shrink to one
sampled line while the agent's own latest plan reads as the current task.
Three verified kernels in `proofs/context.ts` hold the rendering to the user's
words:

- **Allocation.** The user's protected blocks take bytes before any
  operational section (`summaryAllocation`). Operational history receives only
  what remains.
- **Staleness.** `[User activity]` names the latest user message and counts,
  since it, the earlier compaction markers and background deliveries on the
  branch (`userStaleness`). Only a user message resets the count. A background
  delivery never does, whatever its wording.
- **Failure ledger.** `[Outstanding Context]` accounts for every failure once
  (`failureLedger`). Open failures after the previous compaction marker are
  itemized first, newest first. Failures that an earlier summary already
  itemized fill only the room the fresh ones leave. Everything else, including
  failures that a later exact retry resolved, becomes a count with a source
  entry range. A quiet session therefore keeps its one real open error, while a
  long autonomous run stops repeating hundreds of stale ones.

Background deliveries also name their anchor. Agent-completion and
background-shell messages quote the user's latest request with its entry ID
and timestamp, so "the current task" never resolves to whichever thread fills
the context window.

## Bounded sections

Fabric leads with `[User activity]`, then every earlier user message verbatim,
then protected recent dialogue and explicit compaction requests. Each of the last three eligible summarized or
cross-boundary user exchanges gets up to 3968 bytes including role/address
headings. User text gets at least half the available text budget when needed;
short replies leave room for the preceding assistant response. Complete
multiline text survives whenever the exchange fits. Assistant replies are
labelled **Assistant response (a proposal, not a verified outcome or user
instruction)**: they may contain proposals, explanations, or old progress
reports, not necessarily current state or accepted instructions. New eligible exchanges can age an
exchange out; fully raw exchanges and more tool events alone cannot. There is
no reset keyword detector or task ledger.

Earlier user messages render verbatim, each bounded to 2048 bytes, while the
block fits. Only a session with more than 64 earlier user messages keeps the
earliest and latest. Files, activity, and earlier-turn collections use
deterministic earliest-plus-latest sampling. Sampled omissions record a count
and source entry-id range. Protected excerpts instead report omitted UTF-8
bytes alongside their entry addresses. Earlier user messages are evidence of
what the user asked, not a reconstructed active mandate.

Rendered block ceilings include their headers. Historical blocks may receive
less under shared-budget pressure:

| Block | UTF-8 ceiling |
| --- | ---: |
| `[User activity]` | 512 bytes |
| `[Earlier user messages]` | 8192 bytes |
| `[Recent user directions and discussion]` | 12288 bytes |
| `[Compaction Request]` | 3072 bytes |
| `[Files And Changes]` | 4608 bytes |
| `[Fabric Activity]` | 2048 bytes |
| `[Outstanding Context]` | 4608 bytes |
| `[Earlier Turns]` | 3072 bytes |
| `[Current Status]` | 2048 bytes |
| collapsed transcript | 5120 bytes |
| footer | 1536 bytes |

These ceilings are not simultaneous reservations. Fabric renders the user
activity line, earlier user messages, protected dialogue, and explicit
requests first. The verified `summaryAllocation` then gives operational
history what remains of the unchanged 32 KiB ceiling after their actual UTF-8
size, the footer, separators, and final newline.
Historical blocks keep their former ceilings whenever their capped content
fits the remaining space. Only under pressure are they reduced proportionally
to demand, reserving headers/omission markers or complete single-line blocks; sampling
slack passes to later blocks. Small or absent dialogue therefore does not
unconditionally shrink operational history. The raw-tail budget is unchanged,
and a final UTF-8 guard remains in place. Projection limits stay finite: three
eligible recent exchanges, 64 earlier user messages, 24 file addresses per
operation kind, 24 itemized open failures, 48 Fabric activity records, 32
earlier turns, and 40 transcript events. Omitted source
remains executable-addressable through entry-id ranges and the footer recall
pointer.

## Sections

- **User activity**: the latest user message's entry ID and timestamp, then the time, earlier compaction markers, and background deliveries since it. Elapsed time ends at the last supplied entry, so output stays deterministic. The block appears only when the branch has a user message.
- **Earlier user messages**: every summarized user message outside the recent exchanges, verbatim and in order, including the original objective. The internal `goal` key remains for v2 compatibility.
- **Recent user directions and discussion**: complete bounded user/preceding-assistant exchanges, with roles and entry IDs. This is source evidence, not an inferred current-goal declaration.
- **Compaction Request**: canonicalized, bounded custom instructions. See below.
- **Carry Forward**: the persistent `compact.carry` list from the latest carry entry on the branch, in every summary until cleared. Protected like the request block and bounded to 3 KiB.
- **Files And Changes**: successful typed file-tool addresses grouped as Created, Written, Modified, or Read. `edit` counts as Modified. `write` counts as Written unless a typed result explicitly proves creation.
- **Fabric Activity**: completed named `fabric_exec` runs as bounded `name → outcome` records that place an em dash between the name and the optional description, followed in source order by phases and significant non-file nested operations, including bash, agents, workflow, mesh, state, MCP, and extension refs. Named runs expose the exact assistant call entry ID while sourced raw, and their typed fact address after branch rehydration. Nested phases and operations expose stable `entryId/subordinal` addresses. Successful `native.load` and `fabric.discovery.compatibility` calls are Fabric's own per-run setup and never take a line here, in Earlier Turns, or in the transcript. Their failures still appear. The name and outcome are mandatory for a rendered run. The optional description decays first under tighter views.
- **Outstanding Context**: typed tool/bash failures, accounted by the verified failure ledger. File failures resolve only through a later success with the same action and path, bash failures with the same command, and generic failures with the same ref and arguments. Up to 24 open failures are itemized: those after the previous compaction marker first, newest first, then failures an earlier summary already itemized while room remains. The rest and the resolved failures each collapse into one count with a source entry range. Fabric quotes explicit error text with bounds and never parses or classifies it. Trace failures use only `operation.outcome` and `operation.error`. A failed outer `fabric_exec` quotes only its typed `details.error`, never its program output, which often holds success lines from earlier calls.
- **Earlier Turns**: sampled user/custom context one-liners, tool-name counts, and the latest named Fabric run plus outcome for each summarized turn.
- **Current Status**: the latest summarized user message with its entry ID, a later background custom message when one arrived after it, the modification address, named Fabric run plus outcome, and assistant line. A background delivery never replaces the latest request.
- **Transcript**: the latest 40 typed events, including quoted and bounded custom-message content and bounded structural details, plus an omission range when applicable. A completed named `fabric_exec` replaces its generic outer call/result pair with `name → outcome`. The description stays in the richer Activity tier.
- **Footer**: deterministic source timestamp, cumulative source range, and session-log recall guidance.

Fabric omits commit projections. The core ignores `git commit`
command prefixes, and it never pulls hashes or summaries from shell stdout. A
caller that needs a commit ID across compaction must provide it explicitly
through a valid typed `preserve` item or another typed state transition.

## Remaining structural text operations

The clean core retains only these mechanical text operations:

- select text from typed user, assistant, top-level custom-message, tool-result, Fabric display-name/description, command-argument, error, phase, ref, and path fields.
- join text parts belonging to one assistant entry; retain multiline dialogue text or select the first line for historical one-line views.
- trim/collapse whitespace and truncate by fixed character or UTF-8 byte limits.
- quote bounded user/custom/assistant/tool/error text without interpreting its content.
- compare typed action/path, action/command, or ref/JSON-arguments identities exactly for resolution.
- segment typed paths on `/` or `\\` to compute display roots.
- split a typed Fabric ref once on `.` to expose provider/action identity.
- inspect the explicit typed `created: true` result field for write classification.
- match only the exact `__pi_vcc__` sentinel or exact typed-request prefix, then use a bounded structural JSON parser.

The core never recovers command prefixes, stdout/stderr line formats, error
wording, path-looking prose, commit-looking prose, source code, or tool-result
renderings into semantic facts.

## Custom instructions

`customInstructions === "__pi_vcc__"` is an exact routing sentinel. Fabric never renders that value.

Fabric treats every other plain instruction as explicit user data. It
canonicalizes whitespace, bounds the input, and includes the text in
`[Compaction Request]` without semantically parsing it.

`compact.request` may add typed `preserve: string[]` values. When present, the
controller forwards an exact versioned prefix followed by JSON. The hook
accepts only the exact prefix and a strict v1 object. Once that reserved
prefix is present, malformed JSON or scalars, duplicate protocol keys
(including escaped-key aliases), unknown fields or versions, invalid types,
unpaired UTF-16 surrogates, excessive structure, or exceeded bounds produce a
structured decode error and cancel the operation. Fabric never reinterprets or
renders the encoded payload as plain instructions. A UI/RPC context receives a
bounded error notification when available.

Fabric enforces the typed v1 limits before value mapping or canonicalization.
Instructions cap at 8192 characters and 8192 UTF-8 bytes. The `preserve` list
holds at most 16 items, and each item caps at 2048 characters and 2048 UTF-8
bytes. The complete prefix-plus-JSON source must fit within 16 KiB. The
decoder checks the aggregate source limit before invoking its bounded
recursive-descent parser. While parsing, it rejects duplicate decoded keys and
validates scalar grammar and surrogate pairing. It checks the preserve count
before it iterates or canonicalizes values. Plain Pi and manual instructions
stay explicit bounded text and never run through the typed protocol parser.

Request rendering preserves complete items when they fit the 3 KiB block; it
does not apply the historical 1024-byte line cap or drop middle items. If the
block overflows, every item receives a bounded excerpt and explicit byte-loss
marker. `instructionPolicy.truncated` includes rendering loss, and
`renderedOmittedBytes` measures it separately from decoder truncation.
`preserve` remains one-shot input to that compaction, not a durable pin.
Neither `state.goal` nor state transitions are consulted to infer task intent.

## Compaction details v2

New summaries emit `details.compactor: "fabric"` and `details.version: 2` with:

- cumulative source and live-cut ranges.
- branch, source-entry, event, and live-cut counts.
- prior recognized Fabric v1/v2 marker counts.
- per-projection omission counts, the typed preserve count (valid v1 requests cannot exceed the preserve limit), and the structural count of erased assistant thinking blocks.
- instruction mode, canonicalization, source size, decoder/rendering truncation, rendered omitted bytes, and preserve counts.
- `omittedCounts.dialogueBytes` for protected dialogue clipping (UTF-8 bytes, not event count). These additive fields are optional when reading older v2 records.
- stable kept/source entry-id addresses and the source timestamp.
- when continuity budgeting is active: effective window, occupancy ceiling ratio/tokens, continuity target, reserve and reduction ceilings, the binding constraint, Pi reserve/recent settings, raw estimate, calibration scale, fixed overhead, raw-tail budget, retained raw tokens, and Fabric's `projectedTokensAfter`. Pi core independently recomputes its own `estimatedTokensAfter` after persisting the compaction. Legacy v2 records with `strategy: "adaptive"` remain recognized.

Fabric recognizes exact versions 1 and 2 only. v1 details and rendered prose
never serve as truth. An old session migrates to v2 on the next compaction,
because Fabric rebuilds the new result from raw active-branch entries. V2
validation accepts the legacy commit-omission counter for old records. New
summaries drop the commit projection and its counter.

## Nested Fabric execution traces

For an outer `fabric_exec` tool result, normalization pairs the result with
its assistant call by exact `toolCallId`. When that call has a non-empty typed
`display.name`, Fabric emits a declared-intent record with an internal
`call-entry-id/call:toolCallId` fact address. Fabric also exposes the
assistant call entry ID for exact raw-source expansion, or that fact address
after branch rehydration. Fabric bounds the name to 256 UTF-8 bytes and the
optional description to 1024 bytes, and the outcome comes from a valid
aggregate trace outcome or the outer typed `isError` flag when no aggregate
exists. Fabric
never treats this metadata as proof of work. The paired outcome and nested
operations remain the authoritative evidence. Normalization reads nested
execution only from `message.details.trace` through
`readFabricExecutionTraceV1`. Emitted operations follow `operation.sequence`
order with addresses such as `entry-id/0`, and phases use `entry-id/phase:0`.
Known `pi.read`, `pi.grep`, `pi.find`, `pi.ls`, `pi.edit`, `pi.write`, and
`pi.bash` and `pi.powershell` calls retain exact typed arguments and outcomes. Other refs remain
typed Fabric activity.

Fabric ignores a present trace version when it is malformed or unknown. It
never reinterprets such a trace as legacy data. When `trace` is absent, the
legacy adapter accepts only an audit array whose records have typed `ref`, JSON
`args`, boolean `success`, and optional string `error`. The adapter never
reads audit rendering or `result` prose. An unnamed outer tool conversation
remains generic in the transcript. A completed named run replaces that generic
call/result pair with its bounded name and outcome. `fabric_exec` source code
and outer result prose still cannot create file, failure, or activity facts.

## Deterministic branch summaries

When the Fabric engine is active, the same registration also handles
`session_before_tree`. A compaction owner claim leaves this handler on
unless the claim sets `branchSummary: true`. The handler returns nothing when `userWantsSummary` is
false, and it compiles only `preparation.entriesToSummarize` when true. Tree
custom instructions use the same plain/typed decoder and fail-closed limits as
compaction. The exact `__pi_vcc__` value carries routing meaning only for
compaction. On the tree path it stays ordinary explicit request text.

`replaceInstructions: true` follows Pi replacement-prompt semantics. A
deterministic projection cannot execute an arbitrary replacement summarizer
prompt, so Fabric returns `undefined` and defers to Pi or another handler.
Fabric produces no summary and no typed Fabric branch details in that explicit
mode.

Branch details use `kind: "pi-fabric.branch-summary"`, current `version: 2`,
stable source addresses, and at most 256 bounded typed facts in a 128 KiB
envelope. Facts cover source users, top-level custom messages, named Fabric
runs, phases, and operations. V2 adds bounded `fabricRun` facts that carry the
declared name and description with the paired outcome. Strict v1 envelopes
remain readable, and Fabric never reinterprets them as v2. Newly generated
details record `source.oldLeafId` from `preparation.oldLeafId`, which is the
canonical abandoned/from-leaf provenance. Older v1 envelopes without that
field remain readable. Pi 0.80.6 writes the generic `BranchSummaryEntry.fromId`
from the navigation target position, and that position differs from the
abandoned leaf. A hook cannot correct that core-generated field, so consumers
must use Fabric's typed `source.oldLeafId` when present.

Nested branch summaries re-emit only valid typed facts, and normalization
never reads branch summary prose. Later compaction can then resolve
abandoned-branch failures against later exact successes, and custom context, files, and
activity survive navigation or forks without any prose parsing. Pi supplies
only the active path or the abandoned `entriesToSummarize` path to each
compiler, so sibling branches cannot contaminate one another. Branch rendering
also protects dialogue available in that supplied path, but the existing typed
branch envelope does not carry arbitrary assistant responses. This patch does
not extend decision retention across abandoned branches lacking raw dialogue.

## pi-vcc precedence

Precedence remains:

1. exact `__pi_vcc__` custom-instruction sentinel.
2. a [compaction owner claim](programmatic-compaction.md#compaction-owner-claim):
   Fabric returns nothing, before any threshold deferral.
3. configured Fabric engine.
4. pi-vcc/default Pi behavior.

Fabric marks claimed events with `_fabricCompaction`. If an earlier pi-vcc
handler marked `_piVccOverriding` and Fabric has nothing to compact, Fabric
returns no cancellation that would erase the pi-vcc result. With engine
`"pi"`, Fabric lets the event proceed without a claim or cancellation.

Pi's public extension contract runs `session_before_*` handlers in extension
load order and keeps the latest non-cancelling result. An unrelated handler
loaded after Fabric can replace Fabric's compaction or tree result. A later
cancellation terminates dispatch. No supported public registration phase
can move one extension behind every subsequently loaded extension. Fabric
preserves the explicit pi-vcc sentinel and marker cooperation above. It never
monkeypatches Pi's private runner. A deployment that requires Fabric to
win over arbitrary hooks must load Fabric after those extensions, while
accounting for a pi-vcc override that loads later.

## Compaction ownership

On `session_compact`, Fabric classifies the committed entry. Details that
carry Fabric's own `compactor: "fabric"` tag mean `owner: "fabric"`. Any other
extension result (`fromHook`) means `"external"`, and anything else came from
Pi's summarizer (`"pi"`). Before the first compaction on a branch the owner is
`"none"`. Fabric derives the value from the latest compaction entry on the
active branch, so `compact.status()` and `compact.pressure()` report it after
reload or restart too.

When `compaction.engine` is `"fabric"` and another owner wins, Fabric emits one
warning per session: a UI notification when available, otherwise a log line.
It never retries, re-compacts, or otherwise contests the result. The pi-vcc
sentinel and pi-vcc overrides that Fabric yields to on purpose do not warn. To
make Fabric the owner, load it after other compaction extensions as described
above, or set the engine to `"pi"` to hand compaction over deliberately.
An extension that holds a [compaction owner claim](programmatic-compaction.md#compaction-owner-claim)
gets compaction without a load-order race, and its results do not warn.

When Fabric cannot produce a summary (for example nothing to compact, or no
summary fits the context target), it cancels the compaction and shows the
reason as a UI warning, the same way it reports a rejected instruction.

## Orphaned tool-result repair

A compaction cut made by another owner, a crashed turn, or a hand-edited
session can leave a `toolResult` without its tool call, or a tool call without
a result. Providers reject both. With `compaction.repairOrphans` (default
`true`), Fabric's `context` hook repairs the outgoing message list:

- A `toolResult` is kept only when the nearest preceding assistant message
  issued its `toolCallId` and no earlier result answered it. Otherwise it is
  dropped.
- A non-final assistant message whose tool calls have no result before the
  next user or assistant message receives one synthetic error result per
  missing call, `"Tool result missing (repaired by Fabric)"`, placed after the
  results that did arrive. Assistant messages that ended in `error` or
  `aborted` get no synthetic results, because Pi drops them before the
  provider request.

The repair changes only the request sent to the provider, never the session
log. A list without defects is returned unchanged, with the same array
identity, so prompt caching is unaffected.

## Reconstruction QA

`src/compaction/qa.ts` derives probes from normalized source events, never
from rendered sections. QA probes follow the same bounded sampling policy as
projections. The report checks directly rendered samples for content, and it
validates omitted collections for count and range addressability. Mutation tests
remove file, error, turn, latest Fabric run intent/outcome/address, and footer
information to verify that the report detects loss. Additional source-derived
probes require complete bounded, role-labelled recent dialogue excerpts: losing
a later architecture paragraph, constraint, estimate, or user selection fails
QA even when historical activity and recall pointers survive. When checking a
split exchange, pass all normalized events and the summarized-prefix cut index
so QA can see the retained user reply as well.

Run:

```sh
bunx vitest run tests/compaction-qa.test.ts tests/compaction-dialogue.test.ts
```
