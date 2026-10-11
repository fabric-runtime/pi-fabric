# Classifier-assisted extractive history (Jev supported)

This **off-by-default** supplement selects verbatim source evidence from the
**current session's active branch**. It neither replaces the current prompt/raw
work nor changes Fabric's deterministic compactor, summaries or typed truths.
The session remains authoritative; this disposable view is not a facts database.

## Opt in

Open `/fabric settings` → **Extractive history**.
**Consent / mode** offers:

- **Off**: no extractive module load or classifier calls at startup/idle/turns.
- **Deterministic only (no classifier)**: local selection without model access.
- **Enable classifier: send bounded user/assistant text; API charges**: explicit
  consent to send historical text to the selected native classifier provider.

The screen warns about API charges, bounded user/assistant text, and absence of
secret scanning. Text can contain private data or secrets; this is **not** a
sanitizer. Thinking, tool calls, tool output, generated/custom messages and
compaction/branch-summary prose are excluded from this feature's classifier
input. These exclusions do not change the independent memory provider's policy.
There is no automatic project/global/cross-session retrieval.

**Native classifier** lists the host's current `getModelsOfType("classifier")`
catalog and reports authenticated/available classifiers from
`getAvailableOfType("classifier")`. Any registered classifier is selectable,
including local/custom providers. This is not the chat model picker. Selection
alone does not enable inference. Missing models/credentials produce a clear
local fallback; there is no silent alternate-model or connector fallback.

Equivalent JSON in a trusted `.pi/fabric.json` or personal `fabric.json`:

```json
{
  "memory": {
    "enabled": true,
    "extractive": {
      "enabled": false,
      "provider": "typesafe",
      "model": "jev-latest",
      "maxViewBytes": 8192,
      "maxCandidates": 128,
      "maxSourceChars": 24000,
      "maxEvaluationsPerTurn": 1,
      "timeoutMs": 3000
    }
  }
}
```

Changing `enabled` to `true` is the JSON opt-in to classification; use
`maxEvaluationsPerTurn: 0` for deterministic-only mode. `memory.enabled: false`
also disables the view. Provider and model ID are stored separately (model IDs
may contain `/`). Settings reload the live config, invalidate the old view and
abort a pending request. Extension reload/shutdown and session/branch changes
also invalidate it.

| Setting | Bounds / meaning |
| --- | --- |
| `maxViewBytes` | 1,024–32,768 UTF-8 bytes, including JSON framing and navigation |
| `maxCandidates` | 1–256 complete candidate bundles considered locally |
| `maxSourceChars` | 256–100,000; classifier context is conservatively bounded in **UTF-8 bytes**, including questions, rubric, IDs and JSON escaping (therefore also bounded in characters) |
| `maxEvaluationsPerTurn` | 0 or 1 native batch; never per-tool/context replay |
| `timeoutMs` | 100–10,000 ms, including availability/auth and classification |

Native inference batches contain at most **128** questions even when the local
pool is larger. Whole bundles that cannot fit are omitted, not prefix-clipped.
Very small budgets can produce a navigation-only view and no inference.

## Evidence, not generated summaries

Each source is a role-labelled entry ID and its complete text parts. Paragraphs
and qualifiers are retained intact. A candidate contains one exchange plus its
preceding exchange, mechanically preserving local references such as “yes,
second one” without pretending to resolve arbitrary anaphora. Larger reference
chains may require raw expansion. Multimodal parts are not summarized.

A chronological binary range index retains the underlying candidate ranges.
Parent selection runs over those original candidates, **not** over the child
views' surviving selections. The local bounded pool samples temporal endpoints
and recursively bisected intervals, then uses TF-IDF cosine relevance, recency,
role-coverage preference and MMR diversity. MMR updates redundancy incrementally
with a quadratic bound in the capped candidate count. Role coverage is best
effort under whole-bundle byte limits, not permission to split a qualifier.

The optional native classifier sees only bounded original bundles, not parent
extracts or generated summaries. The current rubric asks native `bool` salience
questions and reads `probability`; it requires `stopReason: "stop"`, exactly the
requested keys, matching primitives, and finite values in [0,1]. A malformed
answer invalidates the whole batch. Internal primitive normalization supports
native score/confidence and choice/probabilities for future rubrics, but these
are **not** accepted as substitutes for the current bool questions.

Salience is just a small ranking contribution. False, high probability, or high
confidence never verifies a fact, accepts a command, or turns an assistant claim
into a successful tool outcome. Earlier corrections and conflicting claims can
coexist; there is no inferred authoritative supersession. No semantic regex
classifies facts, preferences, goals or commands.

## Lifecycle, caching and failures

The implementation imports lazily at an enabled `before_agent_start` boundary.
It issues at most one batch for the current source user-entry turn. A `context`
hook inserts one replay-safe ephemeral custom data message immediately before
the last user message in the first request (normally the initiating prompt),
after the existing history. That boundary and the view are frozen for the run:
tool steps and mid-turn steering cannot move the advisory. If the boundary or
its preceding messages are removed or rewritten, injection stops until the next
preparation and never falls back to the conversation head or tail.

The content is JSON-quoted, explicitly **untrusted historical evidence**, not
system instructions. Extraction never changes `systemPrompt`,
`systemPromptOptions`, tool declarations or `context_with_system`. It never
calls `sendMessage`/`appendEntry`, so its output cannot enter its own candidate
pool or become persisted compactor input. The raw outgoing prompt and work
remain intact. Quotation is provenance/framing, not a promise that a downstream
model is immune to prompt injection.

This protects the older raw-history prefix, not every byte across turns:
replacing the previous ephemeral advisory can still invalidate the previous
turn's suffix. It does not retain old advisories, persist a view or grow the
context budget. Diagnostic/count/range metadata follows the evidence, but
query-dependent selection itself is not prefix-stable. These are structural
cache safeguards, not a provider cache-hit or billing guarantee.

Successes **and failures** are cached against session, source-bundle content,
provider/model and rubric version. Caches are session-owned, in-memory,
disposable and bounded to 1,024 annotations. They are not restart-durable and
never delete source records. Config/session/branch changes, source hash or
lineage mismatch, and cancellation prevent stale injection; new tool output
does not trigger another classifier call. There is no ancestor inference.

Timeout, missing native API/model/auth, provider error, invalid keys/primitive,
nonfinite results, or exhausted per-turn budget use deterministic selection
with an explicit diagnostic. Aborted/stale work is discarded and never injected. The timeout races the request as well as signalling cancellation;
a provider that ignores abort may still finish or charge remotely.

Classifier calls go exclusively through `ctx.modelRegistry.getModelOfType`,
`getAvailableOfType`, and `classify`. No Fabric `JevClient`, Jev connector,
global store, source-file scanner or generated code is involved. Reported native
usage is attached as ephemeral `classifierUsage` metadata; this hook does **not**
claim to add it to Pi's durable billing/session totals.

## Recover omitted evidence

The view reports total/selected/omitted bundle counts and chronological entry-ID
range hints. Its copy-ready `follow` invokes
`memory.recall({ scope: "session:<current-session>", branches: "active" })`.
Page `next` until null, check `coverage`, then dispatch a hit's `follow` for raw
expansion. This browses the whole selected branch, including interiors omitted
from every displayed tree node. Range endpoints are **hints**, not numeric
`entryRange` values and not a claim that two endpoint IDs recover the interior.

For an individual displayed address:

```ts
await memory.expand({
  session: "<session path or id from the view>",
  branches: "active",
  entryIds: ["<entryId>"]
});
```

Follow expansion `next` for complete long entries. Raw retrieval remains an
independent API with its own coverage, authorization and integrity checks; it
can expose tool output according to its separately configured policy. An
unsaved/in-memory session without a memory-provider source may not resolve via
these pointers. Incomplete indexing is not proof that omitted evidence is
absent. See [memory recall](memory-recall.md) and [compaction](compaction.md).

## Checks and limitations

Targeted tests: `tests/extractive-history.test.ts`,
`tests/extractive-extension.test.ts`, and `tests/extractive-settings.test.ts`.
They cover real provider follows, exact quotes/provenance, local references,
whole-bundle omission, Unicode byte bounds, source-pool parent selection,
strict native answers, failure caching, cancellation/branch/config staleness,
first-use/disabled imports, ephemeral context replay, and JSON/TUI persistence.

V1 has no visual tree browser, cross-session automatic selection, persistent
annotation store, generative summarizer, truth verifier, authoritative
correction resolver, secret scanner, or automatic inferred-command execution.
The range index's reselection API is local; model navigation uses existing
memory retrieval. Building the index and checking source freshness still scale
with the host-supplied active branch; NLP/inference/display work is bounded.
