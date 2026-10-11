# Lossless decision models

Use `jev.decide` for provider-aware typed judgments with exact `rawJson`,
refusals, optional distributions, provenance and nullable usage. It is additive:
legacy `jev.evaluate` and the auto-approval classifier retain their contracts.
There is no fallback through Pi's normalized `models.classify()` API.

## Native dependency and public calls

These operations require a native `jev-fabric` exposing both `decisions` and
`decision-targets`. Fabric checks capabilities, not a guessed version. An old or
incompatible binary fails with an explicit error; no model request is attempted through a
legacy fallback. Select a rebuilt executable using trusted
`executor.jevFabric.binary` when developing locally. Automatic resolution keeps
its existing rule of skipping workspace-supplied binaries.

| API | Effect |
| --- | --- |
| `jev.decisionProviders()` | Offline native adapter presets/capabilities |
| `jev.models()` | Registered Pi classifier handles intersected with adapter capabilities; unverified credential presence |
| `jev.resolveDecision({request})` | Offline routing and actual adapter preflight before key lookup |
| `jev.decide(request)` | Explicit authorized inference; inspect both result status and budget |

Discovery is not a live availability or authentication check. In particular,
OpenRouter's adapter rejects images even if a catalog entry advertises vision.
Generated estimates and token-logprob readouts are distinct from native
probabilities, and no threshold is assumed portable between models.

```ts
const candidates = await jev.models();
const selected = candidates.find(m => m.supported && m.model.provider === 'openai');
if (!selected?.target) throw new Error('No compatible registered target');
const request = {
  ...selected.target,
  state: { status: 'ready' },
  questions: { ready: { type: 'boolean' as const, instructions: 'Is the status ready?' } },
};
const plan = await jev.resolveDecision({ request }); // no key lookup or inference
// Only after authorization:
const result = await jev.decide(request);
if (result.status !== 'ok') throw new Error(result.error?.message ?? 'Decision failed');
return { target: plan.target, answers: result.answers, budget: result.budget };
```

The target is a routing tuple, not a model ID parsed for a guessed provider.
Per-call target changes do not reopen the connection or reset its budget.

## Portable profiles and the picker

Store routing data, never resolved keys, under trusted `fabric.json`:

```json
{
  "jev": {
    "decisionProfiles": {
      "version": 1,
      "defaultProfile": "fast",
      "profiles": {
        "fast": { "provider": "typesafe", "model": "jev-latest" },
        "vision": { "provider": "openai", "model": "gpt-6-luna" },
        "local": { "provider": "llama.cpp", "model": "local", "allowLocal": true }
      }
    },
    "decisionProfile": null
  }
}
```

This is the same [profile schema](decision-profiles.schema.json) as standalone
jev-fabric. The document is at most 64 KiB with at most 128 profiles. Names use
ASCII letters/digits, `_`, `.` and `-` (1–128 characters), excluding
`__proto__`, `prototype` and `constructor`. A target requires `provider`; its
optional fields are `api`, `model`, `endpoint`, `allowLocal`, `allowGenerated`,
`providerOptions` and `temperature`. Native preflight remains authoritative for
provider-specific constraints. Unknown fields, secret-bearing fields and bad
configuration fail closed.

Global/project profile documents replace atomically; they do not recursively
combine one provider's endpoint with another's model. A selector is separate:
`jev.decisionProfile: "vision"` overrides the document default;
`jev.decisionProfile: null` restores it, including in a project overriding a
global selection.

Open **`/fabric settings` → Decisions** to select a configured profile. The view
shows informational provider/model/probability/image details without retrieving
credentials or invoking a model. Selecting a profile does not enable inference,
change Main's chat model, or change the Approvals classifier/threshold.

The live selector applies to future direct calls and newly launched programs.
Existing programs retain a snapshot, and the existing native connection/budget
is retained. Replacing the whole profile document or explicitly reloading a
provider follows the ordinary provider-reload cancellation rules.

A request can explicitly choose `profile: 'vision'` or a provider/model target.
An explicit provider without a profile bypasses default-profile routing rather
than inheriting a different target's options. Within a profile, options replace
as a whole and a conflicting provider is rejected.

## Authentication and endpoint authority

Credentials are selected host-side for the resolved provider on each call.
TypeSafe can reuse `/login jev`; gateways and other providers reuse their own Pi
login/environment sources. The legacy `jev.credentialCommand` is bound to its
legacy route, not a wildcard fallback for unrelated providers. Keys never enter
guest arguments or the profile document.

Guest endpoint overrides must exactly match a trusted profile endpoint,
registered classifier route, or preset route. Sharing an origin alone is not
sufficient. Pi-only registered providers can project to the native `custom`
adapter while retaining their original credential owner. Choose endpoint
profiles carefully: these are trusted destinations for evidence and keys.

Cloudflare account templates can use `CLOUDFLARE_ACCOUNT_ID` without an auth
lookup. If an account ID is only available inside Pi auth storage, configure an
explicit trusted profile endpoint; discovery/preflight deliberately do not run
an auth resolver to obtain account details.

## Programs, budgets and evidence

Declare `jev.decide` in a program's exact `requires`; the offline methods also
require their exact refs when used. Legacy `jev.evaluate` and `jev.decide` share
the program's evaluation/token limits. Zero evaluations prohibit both. Usage is
accounted even for malformed/refused provider responses; unknown usage blocks
later inference and is never treated as free. The final lossless response
remains inspectable when its reported tokens exceed the limit. No automatic
HTTP retries occur.

Direct lossless calls share a session-owned connection and budget. Legacy direct
`jev.evaluate` remains in-process; it has not acquired a new session budget or
changed its route semantics. New lossless calls require native transport
regardless of the legacy `jev.transport` setting.

Decision JSONL frames and complete `jev.decide` results are bounded to **16 MiB
UTF-8**. Oversized/nonserializable results fail explicitly and never become
`fabricTruncated` objects; other actions retain their normal nested-result caps.
Audit/UI previews stay bounded. Program input/output, QuickJS memory and final
model-facing output limits still apply; return a compact projection and keep
full `rawJson` in explicitly authorized storage when needed.

JavaScript numbers in convenience fields can round. `rawJson` preserves the
provider's exact text; use an exact-number reader for decimal fidelity. Never
interpret absent distributions or confidence as zero, or missing usage as free
inference. Resolve checks format/capability constraints, not credentials or
model availability.
