# Decision test coverage: proof versus bridge

## Reduction decision

Review scope: `tests/jev-decision-profiles.test.ts`, `tests/jev-decisions.test.ts`,
`tests/decision-profile-settings.test.ts`, and the preexisting
`tests/verified-kernels.test.ts` (read-only).

**No whole-test removals are justified.** The only reduction is one redundant
`toMatchObject({ providerOptions: { sort: "latency" } })` assertion in
`projects a registered Pi-only profile to custom while retaining its original login owner`.
The immediately following `providerOptions.toEqual({ sort: "latency" })` checks
the same sent request more strongly: it also rejects retention of the profile's
`allow_fallbacks` option. No input scenario or boundary check is removed.

Validation: `bunx vitest run tests/jev-decisions.test.ts`: **25 passed**.
Reduction: **1 assertion, 0 test cases** (25 → 25 in the modified suite).
The other reviewed suites were unchanged and were not rerun for this review.
Build/artifact checks and native bridge smoke tests remain separate release gates.

## Native proof obligations

The sibling `jev-fabric/native/tests/decision-proofs.bend` contains the following
laws over production Bend functions. The native safety audit compiler-checks
these laws and their transitive pure closure; see the native proof-coverage
ledger for their scope and the independent-kernel verification limitation.

| Laws | Exact obligation and boundary |
| --- | --- |
| `explicit_profile_wins`, `explicit_provider_suppresses_profiles`, `ambient_profile_wins_over_default`, `absent_selectors_use_document_default` | `choose_profile` precedence: nonempty explicit profile; otherwise a present provider suppresses profile selection; otherwise nonempty ambient selector; otherwise document default. Parsing and name validity are upstream assumptions. |
| `explicit_provider_bypasses_document` | `apply_document` leaves a singleton explicit-provider request unchanged and selects no profile, for arbitrary document entries/default/ambient selector. This is not a theorem about every possible request shape. |
| `explicit_provider_discards_ambient_target` | `configure_explicit` with a present provider is unchanged when both ambient model and endpoint change, including success/error results, for arbitrary request/settings/account/provider values. |
| `provider_options_replaced_whole` | Merging singleton `providerOptions` objects yields exactly the replacement value, for arbitrary old/replacement JSON, including nested and empty objects. |
| `shadowed_provider_options_are_irrelevant` | With `providerOptions` at the head of both objects and arbitrary remaining fields, changing only the shadowed old option value cannot change the merge result. |

These laws do **not** prove JavaScript/Python JSON codecs, TypeScript profile
normalization or overlay, environment conversion, credentials, native budget
transport, async lifecycle, guest typing, or UI/persistence behavior. A native
law does not remove the need to test a separate host implementation of the same
policy. See [the decision contract](jev-decisions.md) and
[the existing kernel proof boundary](verified-kernels.md).

## Retained host obligations

| Witness | Obligation retained |
| --- | --- |
| `jev-decision-profiles.test.ts`: cloning/selectors, names, forbidden options, bounds | Clone, never alias; reject unknown/nonstring selectors, unsafe/reserved names, secrets/evidence in nested options, wrong version, inherited defaults, >128 profiles, >64 KiB UTF-8 documents and unknown target fields. |
| Same suite: portable API/model/temperature/endpoint constraints | Validate even unused profiles; API whitelist; 256 Unicode-scalar model boundary and lone-surrogate refusal; finite [0,2] temperature; raw URL userinfo/query/fragment/backslash/non-ASCII refusal and exact loopback shapes. Structural loopback acceptance is not native permission to use it. |
| Same suite: strict JSON copying | Do not execute getters or `toJSON`; reject cycles, non-JSON values, sparse/extra array properties, symbol/nonenumerable fields; preserve nested values without aliasing. |
| Same suite: layered configuration | Replace entire profile documents across global/project layers; project `null` resets the inherited selector without retaining stale route fields. |
| `jev-decisions.test.ts`: offline resolution and registered/custom routes | Snapshot configuration; explicit-provider bypass; reject profile/provider disagreement; preflight before auth; project only public resolution fields; require exact trusted endpoint equality; retain the declared login owner when projecting Pi-only providers to `custom`; never infer auth ownership from endpoint/model similarity. |
| Same suite: auth and discovery | Only selected-provider auth/aliases; no unrelated-key or legacy-command fallback; refresh credentials per call; preserve image/options fields and whole-field replacement; intersect catalog/native capabilities without credential execution; missing native features fail without legacy inference fallback; sanitize ambient target/key/command/profile inheritance. |
| Same suite: direct/program lifecycle and budgets | Direct target changes and invocation end retain one session/budget; direct legacy evaluation remains separate; program legacy/lossless calls share accounting; unknown usage closes inference while evidence remains inspectable; zero evaluations blocks before native open/auth; selector updates retain direct budgets and do not retarget an existing program. Native transport is mocked here, so real native-budget probes remain necessary. |
| Same suite: evidence and guest grants | Preserve error/refusal/provenance/raw numeric text; allow full guest evidence inspection but enforce the separate 32 KiB final-output cap; read-only guest discovery needs its exact grants and works with zero inference. |
| `decision-profile-settings.test.ts`: section and selection | Separate Decisions from Approvals; no model discovery; built-in terminal selection refreshes rows; literal `default` differs from the reset sentinel; cancellation is inert; malformed selectors/documents fail closed; absent configuration is not fabricated; bounded ASCII names/dots remain literal; probability/image hints do not claim verified availability/calibration. |
| Same suite: scopes and persistence | Terminal scope switching rebuilds the section; project reset masks an inherited global selector without copying the document; RPC saves/resets each scope without changing live approval policy/chat configuration, resolving credentials, or reloading resources/policy. Terminal and RPC are distinct entry paths, not duplicate persistence scenarios. |

## Other coverage must not be traded for proof counts

- Keep `tests/jev-decision-serve.test.ts`: exact 16 MiB UTF-8 frame limits,
  fragmented Unicode, out-of-order replies, backpressure, cancellation/listener
  cleanup, partial/malformed frames, peer exit/stdin closure and idempotent close.
- Keep `tests/action-registry-decisions.test.ts`: complete decision envelopes,
  JSON-escaping/UTF-8 byte accounting, bounded previews and real guest delivery.
- Keep public exports/descriptors (`tests/jev-public-api.test.ts`,
  `tests/jev-programs.test.ts`), guest typechecks, first-use/auth boundaries,
  standalone JS/Python interoperability and real native-budget tests. This
  focused review neither changes nor substitutes for those checks.
- Leave `tests/verified-kernels.test.ts` intact: distinguishing ABI argument/tag
  vectors, diagnostic precedence, JS numbers/BigInt and backend arithmetic
  bounds, late span/resource batches, UTF-16 source slices and actual continuation
  checks are bridge evidence. Its 31 × 13 addressed-sample sweep tests the
  unproved TypeScript `sampleAddressed` producer and omitted-entry identities;
  proved accounting alone cannot replace it.

No production source, laws, generated artifacts, package/version or release
configuration was changed by this reduction.
