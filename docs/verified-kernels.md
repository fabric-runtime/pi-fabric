# Verified policy kernels

Fabric runs JavaScript compiled from the registered
[gdp-wired](https://gdpwired.dev/) rules and functions in `proofs/*.ts`.
Production acceptance points and state transitions call those compiled
machines. No parallel reference implementation stands in for production.
TypeScript keeps host integration, source observation, optimized candidate
production, the string-interning codec and diagnostics. When a kernel rejects a
candidate, there is no handwritten fallback.

Each proof module states its laws apart from the rule body. A law restates the
requirement in its own terms (an `Open` predicate, a subset, a successor), and
never reads the implementation's flags. Review laws independently of
implementations. Never weaken a law, or delete a broken variant, to make an
implementation check. gdp-wired's kernel checks each proof tree. That check
does not replace independent review of the specification.

## Acceptance ledger

The kernels cover these areas through production bridges. The proof boundary is
a set of small policy kernels, **not a proof of every subsystem invariant**.

| Area | Proof module, shipped machine | Authoritative production path | Laws |
| --- | --- | --- | --- |
| Effect independence | `resources.ts`: `resourceScope`, `resourceConflict`, `resourceGroups` | `verified/resources.ts`, `components/effect-policy.ts`, `components/effect-scope.ts` | `resource_source_refinement`, `resource_source_valid`, `resource_source_complete`, `resource_refinement`, `resource_output_valid`, `resource_unknown`, `resource_precision`, `resource_recheck_idempotent`, `resource_pair_sound`, `resource_conflict_exact`, `resource_conflict_complete`, `resource_pair_complete`, `resource_groups_known`, `resource_groups_unshared`, `resource_groups_unknown_complete`, `resource_groups_shared_complete` |
| Component lifecycle | `policy.ts`: `transitionCurrent`, `cleanupState`, `consume` | `components/supervisor.ts`, `components/effect-scope.ts` | `transition_sound`, `transition_complete`, `cleanup_failure_quarantines`, `consume_once`, `consume_retires` |
| Capability authority | `authority.ts`: `capabilityAuthority` | `verified/authority.ts`, `core/action-registry.ts` | `authority_issue_exact`, `authority_use_safe`, `authority_use_complete`, `authority_derive_safe`, `authority_derive_complete`, `authority_child_use_safe`, `authority_released_cannot_derive`, `authority_released_not_live`, `authority_released_refused` |
| Binding lifecycle | `lifecycle.ts`: `bindingStep` | `verified/lifecycle.ts`, `core/provider-bindings.ts`, `core/provider-operations.ts` | 19 step laws: safety, `Open`-based completeness, exact counts, close reservation, quarantine |
| Compaction | `compaction.ts`: `compactionCut`; `policy.ts`: `summaryWithin`, `sampleWithin` | `compaction/hook.ts`, `compaction/bounds.ts` | `cut_sound`, `span_sound`, `refusal_final`, `header_once`, `cut_complete`, `summary_bounds`, `summary_complete`, `sample_accounting`, `sample_complete` |
| Memory | `policy.ts`: `lineageSelected`, `pointerCurrent`, `chunkAccepted`, `coverageComplete` | `memory/normalize.ts`, `memory/expand-service.ts`, `memory/digest.ts`, `memory/index.ts` | `active_lineage_only`, `explicit_all_lineages`, `pointer_sound`, `pointer_complete`, `chunk_sound`, `chunk_complete`, `coverage_sound`, `coverage_complete` |
| Entropy normal forms | `policy.ts`: `useNormalized` | `entropy/normal-form.ts` | `normalization_sound`, `normalization_complete`, `canonical_identity` |
| Storage CAS | `storage.ts`: `storageTransition` | `verified/storage.ts`, `mesh/store.ts` | `storage_safe` (three plan cases), `storage_put_complete`, `storage_delete_complete`, `storage_absent_delete_complete`, `storage_stale_refused`, `storage_put_overflow`, `storage_delete_overflow` |
| Provider dispatch | `provider.ts`: `providerTicket` | `verified/provider.ts`, `core/provider-operations.ts` | `provider_plan_safe`, `provider_ticket_consumed`, `provider_revocation_consumes`, `provider_revoked_refused`, `provider_canceled_refused`, `state_stale_refused`, `provider_admission_complete`, `provider_replay_refused` |
| State and Schema | `policy.ts`: `headReadable`, `certificateAccepted`, `consume` | `state/store.ts`, `schema/controller.ts` | `head_sound`, `pending_without_marker_hidden`, `committed_head_visible`, `pending_head_visible`, `certificate_sound`, `certificate_complete`, `consume_once`, `consume_retires` |
| External mesh grants | `grants.ts`: `meshGrantTake` | `verified/grants.ts`, `mesh/grants.ts` | Exact scoped admission, expiry/refusal precedence, exact decrement, refusal preservation and kind/topic forwarding |
| Speculation bookkeeping | `speculation.ts`: `speculationAdmission`, `speculationCheck`, `speculationAccounting`; `policy.ts`: `consume` | `verified/speculation.ts`, `speculation/store.ts` | Exact admission caps, checkpoint refusal precedence, one-use entry reservation, exact event counters and epoch successor |
| Portable prompt guidance | `prompt-guidance.ts`: `promptGuidance` | `core/guidance-delivery.ts`, `extension.ts` | Exactly one portable destination while active, no inactive injection, structured routing, forced/legacy fallback |
| Actor name decision | `actor-name.ts`: `actorName` | `actors/name-policy.ts`, `actors/manager.ts`, `actors/directory.ts` | Active dominates stopped, stopped is refused absent active, neither is available; host snapshot only, not a reservation |
| Agent budget admission | `budget.ts`: `budgetAdmission` | `verified/budget.ts`, `agents/manager.ts` | Strict threshold safety/completeness, equality refusal, invalid observations refused |
| Effect diagnostics | `policy.ts`: `unknownConflict`, `knownConflict` | `components/effect-policy.ts` | `unknown_conflict_exact`, `unknown_conflict_symmetric`, `known_conflict_exact` |

`src/verified/generated/manifest.json` lists every claim by module. Laws about
a rule hold for every state the laws beside them allow. The lifecycle and
provider step laws carry no invariant, so they hold for every life record and
every ticket, reachable or not.

### How a proof run works

`bun run proof:generate` (and `proof:check`) does the following for every
registered module:

1. Proves each law, step law, k-step law and decision. A claim counts only when
   the verdict is `proven && checked && !assumes`. `checked` is the kernel's
   verdict on the proof tree that the untrusted prover produced. The generator
   calls `proveSteps` with `{from: 'any'}`: the step laws must hold from every
   state the laws allow, including host-supplied states unreachable from `init`.
   Search still looks for breaking runs and state-independent lemmas. A verdict
   with `assumes` depends on reachability and counts as unproven.
2. Proves each registered deliberately broken variant (such as "a span may
   straddle the boundary", "stale writes pass", or "derivation checks one
   grant"). Every variant must be refuted with a counterexample (a run or a
   state), leaving at least one claim unproven. This replaces the old
   negative-mutation script.
3. Replays every claim on concrete runs with `crossCheck` and
   `crossCheckDecision`. The builders are untrusted, so this catches a builder
   whose expression differs from what its callback computed.
4. Runs each statechart's `check()`. Every state must be reachable from the
   start, no state other than a final one may lack a way out, and no event may
   enable two equally specific transitions at once.
5. Compiles each shipped machine with gdp-wired's `compileJs`. Each runtime
   helper a module's machines call is emitted once, and host access is refused.
   `fork` (a state copy for branching searches) is left out, because Fabric
   never branches; `init` and `step` ship unchanged.
   The step writes `src/verified/generated/<module>.js`, its declarations, and
   a SHA-256 receipt over the proof sources, the generator and the artifacts.

`proof:check` repeats the whole run and requires byte-for-byte equal output.
Independent whole kernels and mutation batches run in up to four isolated worker
threads (bounded by available CPU parallelism). Invariants, step laws and k-step
laws of one kernel stay together. Every worker result must name all expected
claims; a worker crash, premature exit, malformed response or deadline fails the
run and terminates its siblings. No proof verdict is reused from a cache.
Compilation and the receipt retain registry order regardless of completion order,
and the receipt hashes the worker and scheduler as well as the generator.
Use `bun run proof:check --jobs 1` for serial diagnostics; `--jobs 2` through
`--jobs 4` select an explicit cap. CI keeps proof reproduction as a required
pre-build gate, and combines the fixed ABI/diagnostic tests into one Vitest
invocation on each platform without dropping cases.

For a bounded before/after measurement on one same-sized Modal worker, use
`bun run benchmark:verification --proofs` (complete serial versus parallel proof
checks) or `bun run benchmark:verification --ci-tests` (the same fixed suites in
three launches versus one). Each comparison runs once, stops on failure and
checks that verification did not rewrite the receipt. These are targeted timings,
not a whole-suite speed claim or millisecond CI gate.

`proof:artifact` runs during every build. It compares only hashes and the
exact gdp-wired pin, and never loads the prover.

### Encoding

Kernels decide over naturals, flags, choices and sets of names. The bridges in
`src/verified/` are the trusted codecs:

- A Boolean is a 0/1 natural, and a constructor tag is its index (lifecycle
  phases, events, commands, storage plans).
- A string the law compares by identity is an **interned name**. That covers
  storage keys, values and identities, ticket keys, revisions and payload slots,
  authority grant tuples, and resource names. Each bridge interns into a fresh
  injective table: equal strings share an id, and distinct strings never do.
  The kernel's laws prove that ids are forwarded and compared exactly. Turning
  an id back into its string is the codec's job.
- A set of names is a map of 0/1 cells. Resource names reserve id 0 for the
  empty name (also used for non-string values) and id 1 for the wildcard `*`.
  The codec interns a proposal's names first, so they take ids 2..65.
  `Len` carries each name's complete UTF-16 length.
- Numbers are naturals below `2^53`. The compiled runtime refuses anything else
  with a `RangeError`, and each bridge fails closed before that point. It
  refuses a request that fails its rule's assumption the same way. Storage
  revisions are plain naturals, with no radix limbs.

### Complete-resource conflict preservation

The production path:

1. `src/verified/resources.ts` interns the **complete original** declaration
   and runs the compiled `source` step over it. Encoding applies no
   resource-count or name-length limit.
2. TypeScript proposes a small deduplicated list. This producer is untrusted for
   policy correctness: it may omit, shorten, reorder, duplicate or add names.
3. The compiled `normalize` step independently checks that the scope is exact,
   that the proposal is nonempty, and that every name in it is a valid identity
   with an id inside the 64-name window and at most 256 code units. It also
   checks that the proposal and the scope name the same set, **in both
   directions**.
4. An accepted scope keeps the checked set. A refused proposal becomes the
   unknown scope (`*`). An unknown source can never become exact
   (`resource_refinement`).
5. Component lifetime and registry call policy compare complete effect
   declarations through the compiled `resourceGroups` step, which decides
   every pair of effects at once. TypeScript summary maps and flags provide diagnostics only.
   They cannot turn a compiled conflict into an empty conflict list.

A proposer that silently drops resource 65 fails the coverage check. The laws
do not assume that TypeScript reported a correct count, overlap, validity or
unknown-scope flag. The 64-name bound counts **distinct** names: a proposal that
repeats one name 65 times is that one name. Precision assumes a valid, bounded,
set-equivalent proposal (`resource_precision`). A broken producer can still
cause a conservative false positive, but it cannot create false independence.

Rechecking an accepted normal form against itself keeps it
(`resource_recheck_idempotent`). This is a two-step law: a normalization is
accepted, then the next normalization's proposal is the current scope. Two spec
flags, `unchanged` and `short`, state that proposal apart from `fits`; the step
never reads them.

Conflict preservation is a composition of proven laws.
`resource_refinement` gives a normalized scope that is either unknown or names
exactly the original set. Unknown scopes of ordered effects conflict
(`resource_conflict_complete`). Two exact scopes conflict exactly when they
share a name: `resource_conflict_exact` and `resource_pair_complete` cover the
two directions. So normalization cannot erase a conflict.

Two components' effects are decided over every pair at once by
`resourceGroups`. Each side is a list of effect flags (`effect`, `ordered`,
`exact`) and a list of rows (`item`, `name`), one row per name in an exact
scope, where `item` is the effect's position in its list. A row reads its
effect at the position it names, so the request's own data pairs each name
with its effect; no loop does. The groups conflict unless no ordered
pair of effects has an unknown scope and no ordered pair of rows names one
resource. Four laws cover both directions: independent groups have neither kind
of pair (`resource_groups_known`, `resource_groups_unshared`), and a pair of
either kind makes them conflict (`resource_groups_unknown_complete`,
`resource_groups_shared_complete`). The broken variants that pair only the
diagonal, skip the last left effect, check only the first right effect, or
check one side against itself are each refused.

The codec stays trusted: it names both sides' rows from one shared table, and
writes each row's `item` as its effect's position. The rule assumes every row
names an effect of its own side. The codec meets that by construction, and the
compiled step throws a `RangeError` on a request that fails it, so such a
request never grants independence. The shared-name condition runs as a join on the name,
so its cost grows with the rows and their matches, not with every pair of rows.

### Multi-step claims

- `authority_child_use_safe` is a proven two-step law on the child's machine:
  after a derive, a granted use names a grant of the parent the derive read.
- The compaction cut is checked as a fold: one header step, then one step per
  call/result span. `cut_sound` is an invariant over every run. `span_sound`
  shows that a span keeps the cut open only if the cut was open and the span is
  allowed. Together they give the old `spans_sound` over any finite span list.
  The production check feeds every span to the compiled machine.

### Proof-backed testing

gdp-wired checks universal policy properties. JavaScript tests check the codecs
and host boundaries with fixed, distinguishing examples. Cartesian products of
already-proven conditions are unnecessary:

- Resource refinement and conflict use the universal laws, not a second
  handwritten conflict interpreter and a source/proposal cross-product.
- Authority derivation, provider tickets, storage CAS and lifecycle decisions
  keep positive and negative wire examples with unequal fields and counters.
- Certificate checks keep each host diagnostic position and a multiple-failure
  precedence case. Soundness and completeness laws replace the Boolean matrix.

Keep the encoding, interning, numeric-limit, mutation/aliasing,
artifact-provenance and packaged-runtime probes. The compiler and the codecs are
trusted boundaries, not proven implementations. Keep the real cancellation,
settlement, cleanup ordering, locking, corruption and migration regressions too.

Not every enumeration is redundant. The addressed-sampling sweep checks a
TypeScript producer and its omitted-entry identities, which proven accounting
alone does not cover. Component scheduling and diagnostic projections keep
their host-level tests as well. Before pruning a decision matrix, identify which
policy assertions the laws cover, including positive completeness, and keep
focused tests for the remaining host observables. A safety law alone can still
permit an implementation that denies valid requests.

### Additional admission and bookkeeping boundaries

Mesh grant decisions run over the record read inside the existing mesh lock.
The codec interns complete topic/kind identities in one table. At a nonnegative
clock, legacy negative deadlines and use counts encode as zero, preserving
expiry/exhaustion diagnostics; refused records are never rewritten. Token hashing,
constant-time matching, input validation, event serialization, locking and
cross-file crash consistency are not proved. Exact decrement is a decision law,
not a proof of exactly-once persistence.

Speculation admission reads the retained-entry count after the host expiry
sweep. Its concurrency observation is the number of retained nonfailed entries,
not all unsettled external work. TTL equality remains usable. Before settlement,
expiry precedes epoch and freshness; afterward, abort/epoch precedes expiry,
freshness and provider failure. Freshness callbacks stay lazy at both checkpoints.
Stale, expired or freshness-refused entries are aborted at either checkpoint;
an otherwise-current provider failure does not receive an extra abort.
The compiled shared `consume` decision reserves an entry before awaiting it.
Accounting laws prove exact per-event increments, not that the host observes and
emits each event correctly. Key construction, actual settlement, abort delivery,
callback order, map removal and reset behavior remain integration-tested.

The budget is an admission threshold: completed child costs are observed before
the next spawn, so existing concurrent admission and overshoot semantics remain.
The codec maps complete binary64 observations to lexicographically ordered
unsigned high/low words, normalizing signed zero without rounding to decimal
units. The laws prove strict ordered admission, not the float codec or a hard
spending ceiling. Nonfinite spend and invalid present budgets now fail closed
(previously a `NaN` aggregate could pass the JavaScript comparison). No active
budget remains distinct from an invalid observation of an active budget. Ledger
parsing, aggregation, file I/O and recursive environment propagation remain tested.

### Producer/checker boundaries

The compactor's optimized TypeScript selector still proposes cuts. `computeCut`
checks every successful result, including the legacy and compact-all paths,
before it can become `firstKeptEntryId`. Checks use the live entries and the
complete call/result span set. Candidate-selection optimality is still
test-backed, not formally proved. Token guarantees concern the structural
estimator and supplied calibration, not an undocumented provider tokenizer.

Memory checks the actual outgoing page **after** envelope trimming. The bridge
compares each text chunk with the selected normalized source slice, checks its
range through the compiled kernel, and checks the proposed continuation against
the resulting cursor. Source reads and hashes, parent-graph reconstruction,
normalization, Unicode slicing and page composition remain host
responsibilities. The exact claim concerns normalized text, not byte-for-byte
JSONL reconstruction. A source or lineage change fails closed, and old pointers
are never reinterpreted.

Entropy's schema validator and plan derivation remain TypeScript. Their results
feed the compiled acceptance decision, and the original object is returned on
refusal. Validated output plus the canonical-identity gate gives the operational
idempotence argument, under the validator assumption. This is not a proof of
TypeBox or of JavaScript numeric-string conversion.

Schema's eight evidence facts are a fixed-length tuple at the adapter boundary.
The compiled conjunction checks all eight before mutation. The consumed status
comes from the compiled token transition and is persisted with the existing
compare-and-swap. At-most-once use across processes depends on that CAS protocol
and the mesh store, not on an in-memory Boolean alone. Filesystem rollback and
postcondition commands are not formally verified.

### Lifecycle limits

Provider bindings run the compiled lifecycle reducer for admission, holds,
in-flight work, retirement, revocation and close reservation. The reducer is a
gdp-wired statechart: a table of transitions over the six phases, where Closed
and Failed are final and counter updates stay in their phase. Its `command` is
an output that reads Denied whenever no transition fires. The chart compiles to
the rule that ships, and its check proves every phase reachable, none stuck
and no event ambiguous. Independent laws
prove exact count updates and prevent close while ownership remains. The host
interprets commands, observes actual promise settlement and releases private
one-use leases. Those observations and interpreter effects remain trusted.

The component supervisor uses the compiled eligibility and cleanup predicates.
Its epoch allocation, publication sequencing, inverse-stack execution and
fairness remain TypeScript protocols checked by integration tests. Neither
reducer proves that provider promises account for every subprocess or remote
effect. Arbitrary inverses, ambient effects, liveness, schedule confluence and
author-defined observational equivalence are not claimed.

### Portable execution guidance

Fabric's execution rules have one authored source in `core/execution-guidelines.ts`.
The tool metadata exposes them to Pi, and the first-use prompt hook moves only
those exact rules into the named `fabric` section (or the explicit append when
a prompt is forced or the host has no sections). This keeps providers that
project custom sections but discard Pi's generated rules, such as
`pi-claude-bridge`, from losing batching and bounded-output instructions.
Unrelated tool rules remain in their original place. Preparation is pure: the
hook commits the relocation only after all renderers succeed, and removes exact
owned bullet lines from already-rendered forced/legacy prompts before appending
the current rules. Stale rules from a previous kernel selection are owned too.

The compiled `promptGuidance` decision proves an active render selects exactly
one portable destination and removes duplicate native ownership; an inactive
render keeps native ownership and injects nothing. Forced prompts always take
the append, even when a sections object exists. These are routing laws, not
proofs about prose semantics, provider compliance, or model token savings.
Exact string preservation, language variants, other extensions' rules, stable
re-renders, and Pi's actual named-section/forced-prompt pipeline are tested
offline. No model inference is needed.

## Reproducible bridge

`gdp-wired` is an exact devDependency. Installed Fabric needs neither the prover
nor its compiler: `dist/verified/generated/` holds plain JavaScript, and the
build refuses a bundle that loads `gdp-wired`. Proof runs need Bun.

```sh
bun run proof:generate    # prove, refuse broken variants, cross-check, compile, write the receipt
bun run proof:check       # all of the above, then require byte-for-byte equal artifacts
bun run proof:artifact    # prover-free source/generator/artifact freshness check
bunx vitest run tests/verified-kernels.test.ts tests/verified-resources.test.ts tests/verified-providers.test.ts tests/verified-artifact.test.ts
bunx vitest run tests/verified-authority.test.ts tests/verified-lifecycle.test.ts tests/verified-storage.test.ts
bunx vitest run tests/verified-grants.test.ts tests/verified-speculation.test.ts tests/verified-budget.test.ts
bun run typecheck
bun run build
bun run proof:dist        # probe the bundled registry, compactor and kernels
```

Every build checks artifact freshness before bundling. Linux CI and `prepack`
re-prove and reproduce the artifacts byte for byte, so editing the receipt is
no substitute for proving the code. The generated JavaScript, declarations and
receipt are copied into `dist/verified/generated/`. The proof modules and the
generator ship in the package for inspection. The receipt is a freshness
record, **not a standalone, independently verified proof certificate**.
Every gdp-wired proof can also be exported to Lean (`gdp-wired/lean`) for an
independent check. That export is not part of the build.

The trusted computing base is gdp-wired's kernel (`kernel/kernel.ts`,
`core/check.ts`), its machine compiler and runtime helpers, the small
generator, the bridges' codecs, and the JavaScript engine. The prover, the
builders and the searches are untrusted: the kernel rejects a wrong proof tree,
and `crossCheck` holds the builders to the interpreter.

## What changed from Bend

The kernels used to be Bend 2.0.37 programs with hand-written proofs. Moving to
gdp-wired changed these claims:

- Names were complete UTF-16 code-unit lists compared by structural recursion.
  They are now interned ids. Name equality, membership and both-direction
  coverage are proven over sets of ids, and the codec's injectivity is trusted.
  A resource name's length is the codec's `string.length`.
- The resource bound counted list entries. It now counts distinct names.
- Group conflict over every pair of effects is a proven rule, as described
  above. Recheck idempotence and the authority child-use theorem are proven
  two-step laws.
- Several laws no longer apply. `all_sound` and `all_complete` covered the old
  list conjunction; every predicate is now a direct conjunction with its own
  soundness and completeness laws. `footprint_*` and `close_*` covered
  functions Fabric no longer exports. `state_read_*` covered a read plan
  nothing executed. Active-only completeness examples (`inspect_complete`,
  `begin_complete`, `retain_complete`) are covered by the `Open`-based
  completeness laws.
- Revisions are naturals below `2^53`, not radix-`2^32` limbs. The successor
  laws are `+1`.

## What remains outside the claims

- Semantic remembering, arbitrary prose retention, retrieval ranking quality,
  secret detection, and recovery after source deletion.
- Full correctness of parsers, schemas, hashing, interning, source observations,
  graph reconstruction, or filesystem transactions.
- Full lifecycle confluence, eventual settling, or rollback correctness for
  arbitrary provider code.
- Validation of user intent, success of host operations, and security against a
  malicious trusted host or provider.

These boundaries are deliberate. Executed kernels and mandatory result checks
remove the parallel-model gap for the specified decisions. They do not turn
unverified host observations or adapters into proven facts.
