# Tool entropy and normal forms

Fabric measures invocation friction and statically compiles bounded argument
normalizations. It does **not** shrink tool capabilities to fit observed usage.
All declared actions, schemas, and canonical enum values remain available,
including rarely used values and actions whose recorded calls all failed.

Compilation and certification are deterministic and offline: no LLM calls,
confirmation loop, prompt edits, or new model tools or arguments. An unprovable
candidate does nothing. Static proof here means checking a small host-authored
compatibility language against the live schema; it does not prove actual model
comprehension, user intent, or successful execution.

## Metric v3

`measureEntropy({ traces, surface?, repairs?, catalogDigest? })` reports:

```text
score = behavioralScore = invocationRejections / actionOperations
```

An invocation rejection is a **failed** action operation at `resolve`,
`prepare`, or `validate`. Discovery (`fabric.discovery.*`) and workflow
(`fabric.workflow.*`) operations are excluded from the denominator. Other
failed operations, successes, aborts, and timeouts remain in the denominator.
No action operations means zero; an all-invocation-rejected corpus scores one,
not zero. An all-effect-failed corpus can score zero: this is not a task-success
metric. Values are rounded to six decimal places.

Repeating an identical corpus does not change its rate. Per-ref scores use
rejections divided by calls to that ref; `byModel` uses the same fraction over
traces attributed to each producing `provider/modelId`. Unstamped traces still
contribute globally. `invocationRejectionsPer1k` expresses the rate per 1,000
action operations.

Shape entropy, failure-stage entropy, retry churn, navigation, flow, repair
lexicon counts, and schema freedom are **diagnostics**, not objective terms.
`staticScore` is 0.25 times call-weighted mean schema freedom (zero without
action calls); it is not added to `score`. Diverse valid calls are not a defect,
and removing an enum member cannot improve this objective. Do not compare v3
scores numerically with earlier metric versions. A trend is observed rejection
rate across a selected window, not a guaranteed downward ratchet.

## Evidence and ingestion

- Typed trace V1 operations supply refs, projected arguments, outcomes, and
  failure stages. Guest code, exception prose, and assistant explanations are
  not evidence.
- Verbatim `details.audits` supply the actual recorded call arguments. Ingestion
  requires a guarded execution-trace envelope before accepting audit evidence.
  Projection can erase values or whole argument sets, so audits take precedence
  by ref for representation trials.
- Session model-change records and assistant provider/model metadata attribute
  traces, including model changes in appended records and standard JSON
  whitespace. This is model attribution, not guest-kernel attribution.
- Live surface snapshots are `{ version: 1, actions: [{ ref, inputSchema }] }`.
  Schema digests bind plans to exact declarations.
- Catalog repair rows are separate compatibility mappings and diagnostic input;
  they do not authorize schema restrictions.

Session scans reuse bounded evidence caches and appended-file cursors.
Background compilation also caches per-session trace aggregates and observation
summaries: unchanged snapshots do not reprocess old operations, appends only
accumulate new evidence, and replacement/truncation rebuilds the affected cache.
Schema-derived plans are cached by the declared surface digest; schema and repair
changes still update the report. These caches are session-owned, retain at most
16 windows, and are discarded on session start/shutdown. Cached snapshot inputs
must not be mutated by callers.

Persistence contention is advisory, not a compilation failure. Pool updates
reload and merge the latest evidence under the shared lock so sibling Pi
processes cannot overwrite each other's contributions. A busy pool does not
stop normal-form compilation; a busy artifact store does not prevent activation
of freshly proved plans. One coalesced background retry uses exponential backoff
with jitter (capped at 30 seconds), re-reading current evidence on each attempt.
Retry timers do not keep Pi alive and are canceled on session start/shutdown;
turn hooks never wait for them. Shutdown drains already queued compilation before
Pi invalidates the old extension context; no retry survives reload, new/resumed
sessions, or forks. Session-start epochs also discard late results from an older
session. Old locks from dead owners, incomplete writes,
or malformed metadata recover automatically after the 30-second grace period.
Live owners (including permission-denied process probes) are never evicted just
because a lock is old. Damaged pool/artifact data is still preserved and reported,
not silently rebuilt or treated as ordinary contention.

Background machine-wide discovery runs at most once per 30 seconds, with the
active session file included on every compile. Selected files are still checked
for changes each time. Explicit `/fabric entropy` inspection remains immediately
fresh. Advisory enum/overload/sequence analysis runs only on the inspection path,
not in background compilation. No normalizations or historical outcomes change.
`bun run benchmark:turn-cpu` compares cached/uncached source paths using synthetic
evidence and reports process CPU separately from wall time.
 The
machine-wide value observation pool retains per-session deltas and per-value
multiplicity, avoiding inflation when unchanged sessions are reread. Pooling is
**advisory only**: observations never authorize capability loss or new semantic
maps. Sparse usage may support `declare-enum` review when an author explicitly
marks an open property with `"x-fabric-enum-candidate": true`. It does not turn
observed values into an automatically enforced finite domain. Ordinary open
parameters are not an invitation to infer a closed vocabulary. Overload-split
and sequence-fuse signals also remain author review, not automatic rewrites.

## Static normal-form plans

`deriveNormalFormPlan(ref, schema)` derives rules without needing a corpus.
The bounded language supports closed, top-level object schemas; unsupported
combinators, open objects, unsafe names, and other unprovable shapes cannot
justify a plan. Plans contain a version, ref, base-schema digest, and bounded
ordered rules. The conventions are:

| Rule | Compatibility convention |
| --- | --- |
| `key-form` | Unique ASCII spelling form of a declared key: case and separators (`_`, `-`, spaces) |
| `enum-form` | Unique spelling form of a declared string enum member, never an invented value |
| `numeric-string` | Finite numeric encoding whose conversion round-trips exactly through `String(number)` and satisfies the property schema |
| `optional-null` | Omit a non-nullable optional field supplied as null/undefined; retain valid nullable fields |

These are host-defined representation conventions, not inferred semantics.
`"2"` can become `2`; `"02"`, lossy integers, and out-of-range numbers cannot.
Conflicting canonical keys or multiple aliases for one target refuse the
whole candidate. Colliding enum forms are not guessed. Unrelated spelling,
unknown fields, and partial repairs that still fail validation pass through
unchanged. Only a complete candidate accepted by the original schema is used.

### Preservation laws

`applyNormalFormPlan(ref, schema, args, plan)` is the same implementation used
at the registry's validation boundary, after provider-owned preparation, and
by offline trials. Provider compatibility adapters retain precedence over
these generic normal forms; preparation errors are never bypassed. Existing
catalog aliases still follow their established pre-prepare compatibility
contract and are validated again at the final boundary.

1. **Canonical identity:** if the declared schema already accepts the arguments,
   return the original arguments unchanged, with no witness. This protects every
   canonical enum value, nullable value, and declared capability, not just values
   seen in a retained session window.
2. **Exact proof:** a plan must match the ref and be exactly rederived from the
   current schema. A matching digest alone is insufficient.
3. **Validated output:** a changed result must satisfy the unchanged declared
   schema; otherwise return the original input for authoritative validation.
4. **Idempotence:** a normalized result is already canonical, so a second
   application is identity with no new witness.

Successful normalization emits a bounded witness containing the schema digest,
before/after shape digests, and applied rules. A witness records a representation
change, not an operation success. Normalization never bypasses validation,
authorization, approvals, or effect execution. Existing kernel registry paths
consume the same host call data; guest programs and runtimes are not rewritten.
See [catalog repairs](repairs.md) for the separate spelling-alias mechanism.

## Compiler and artifact contract

`compileEntropySurface` and its cooperative async counterpart measure the
historical corpus, then derive ordered plans from the declared surface. An
empty corpus is supported. Compilation deliberately does not transform failed
historical outcomes into imagined successes: a compiled result's `after` is
the same report as `report`, with equal gate scores and zero delta. Future
recorded rejections and normalization witnesses provide subsequent evidence.

Convergence means identical derived plans, not a better score or a minimum
observation count. An unchanged v2 artifact is reused; without an artifact and
without any derivable plans, compilation is already converged.

Compiled surface **v2** contains `normalizations`. Its `actions` and
`quarantined` arrays are empty. The ledger and evidence digest describe proven
plans; there are no enum overlays, hidden refs, or auto-quarantines. Artifact
bytes are clock-free and deterministic for identical inputs.

Legacy **v1** restriction artifacts still load for migration, but every overlay
and quarantine is inert. They cannot hide actions or restrict schemas. A fresh
compile replaces them with v2 plans. Import/merge drops and counts legacy
restrictions and rederives every v2 plan against the live schema. Forged rule
kinds, altered targets, partial plans, and schema drift are rejected, even when
an artifact claims a passing gate. Valid plans are deduplicated and ordered by
ref; local entries take precedence. Application rechecks proofs too, so later
schema drift cannot enforce an obsolete plan.

The artifact lives at `<agent dir>/fabric/entropy/compiled.json`. Background
compilation, activation, and persistence use the existing runtime lifecycle;
there is no confirmation interaction. The observation pool is derived advisory
evidence, not an enforcement artifact. Disabling entropy compilation disables
its normalizations. Damaged persisted artifacts surface as errors; they never
silently become authority.

## Inspection, export, and certification

```text
/fabric entropy
/fabric entropy export [path]
/fabric entropy export-artifact [path]
/fabric entropy import <path>
```

Surface export captures the declared registry schema, not a restricted view.
Artifact export/import shares only locally reprovable normal forms. Neither
command changes the model-facing call contract.

Repository-only offline checks (the package command builds `dist/` first):

```sh
bun run certify:entropy
bun run certify:entropy --sessions <dir> --surface <snapshot.json>
bun run certify:entropy --sessions <dir> --surface <snapshot.json> --trial --artifact <compiled.json> --json <report.json>
```

`--sessions` reads sorted `.jsonl` files directly in that directory. `--surface`
requires `--sessions`; `--trial` requires both. `--artifact` selects a trial
artifact, otherwise the agent directory's compiled artifact is loaded. `--json`
writes the report. No command calls a model. Invalid inputs or failed checks
exit nonzero. See [certification](certification.md) for coverage and limits.

## Representation trials

`runEntropyTrial` compares base-schema validation of recorded arguments with
validation after the same runtime normalizer, using only valid v2 plans.
For each ref with audits, all verbatim audit calls replace projected trace
arguments; other known action refs fall back to traces. Unknown refs and
workflow/discovery operations are not representation-test samples. The
historical metric still measures the original traces, not this audit-selected
sample set.

- `bothAccept`: already-valid arguments stay valid.
- `bothReject`: invalid arguments remain invalid; refusal earns no credit.
- `normalizationWin`: invalid representation becomes schema-valid with a witness.
  This **does not** assert the operation ran or would have succeeded.
- `canonicalIdentityChecks`, `canonicalIdentityCost`, and `idempotenceCost`
  expose replay checks of the preservation laws.
- Legacy `tighteningCost`, `typedFailureWin`, `quarantineWin`, and
  `quarantineCost` fields remain for compatibility. Restriction/quarantine wins
  are never emitted. Losing base acceptance would be a tightening cost.

Both report scores are the unchanged historical rejection rate and `delta` is
zero. `clean` means a valid plan was exercised without a preservation cost,
not that a normalization win occurred or a task succeeded. `no-evidence` means
no valid plan was exercised, including inert legacy artifacts and empty
corpora. `costly` flags an identity, idempotence, or acceptance regression.
Divergences are deterministically counted and sorted by ref/class.

Certification covers exact v3 rates, sample-count invariance, all-invocation-
failed nonzero scoring, static preservation, deterministic/empty compilation,
convergence, canonical identity/idempotence, ambiguity refusal, forged plans,
schema drift, legacy migration, store round trips, ingestion/model attribution,
and the shared-normalizer trial. These finite probes complement the bounded
rule construction; they do not prove arbitrary future task success, actual
comprehension, or the meaning of every schema author's nullable/optional field.
