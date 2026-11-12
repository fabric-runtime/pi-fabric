# Memory & Recall

Pi Fabric's `memory` provider searches Pi session JSONL files or explicit
host-backed session sources. The retained source records remain authoritative;
the memory index holds derived, disposable state.

Structural extraction is the only indexing method. Regexes never classify
goals, preferences, errors, or other prose concepts. Roles, tool names,
timestamps, entry IDs, operation addresses, exact `ref`/`provider`/`action`
identities, execution outcomes, tool errors, and tool argument paths all come
from typed session fields.

## Retrieval workflow

Treat recall as navigation and expansion as reading:

1. `memory.recall` locates ranked, bounded evidence.
2. Inspect entry snippets directly. Every hit has one copy-ready `follow` call.
3. Run `await tools.call(hit.follow)` to expand an entry or resolve a cold session.
4. Continue any paged result with `await tools.call(result.next)` until `next` is `null`.
5. Use guest-local `memory.walk` when TypeScript should scan, filter, reduce, join,
   or traverse complete normalized records.

These calls are the supported session-data API. Consumers should not open,
scan, or parse Pi session files themselves. Follow calls carry source hashes and
selected lineages without duplicating that integrity metadata on each hit;
single-session page continuations preserve the same bindings. Coverage explains
when indexed absence is not authoritative.

## Portable host sources

The lightweight `pi-fabric/memory` entry exports `PortableMemorySource`,
`MEMORY_SOURCE_INTERFACE_VERSION`, `defineMemorySource`,
`createMemorySourceRegistry`, `createMemorySourceClient`, and
`memoryActionSchemas`. It does not load the extension or UI runtime.

```ts
import {
  createMemorySourceClient,
  createMemorySourceRegistry,
  type PortableMemorySource,
} from "pi-fabric/memory";

function recallClient(authorizedSource: PortableMemorySource) {
  const sources = createMemorySourceRegistry();
  sources.register(authorizedSource);
  return createMemorySourceClient({ sources, config: { maxSessions: 32 } });
}
```

A source implements interface version `1`, has an opaque stable `id`, and
provides `listSessions({ limit, signal? })` and
`loadSession(sessionKey, { signal? })`. Session descriptors have an opaque
`sessionKey` and content-sensitive `revision`; snapshots add standard Pi
`records`. Optional `authorize(action, sessionKey, scope?)` is rechecked around
asynchronous reads. In a scoped session, `scope` is the caller's host-issued
[principal and grants](providers.md#principal-and-scope), so a source can refuse
before content enters context; client calls accept `{ scope }` too. Bind principals
and permissions in the host, never in model-supplied arguments. The host also owns sanitization and retention.

Lists may return a descriptor array or `{ sessions, coverage }`; snapshots
also support `coverage: { complete: false, reason }`. Report every partial
projection or enumeration cap; a truncated archive is never presented as
complete. The engine preserves these reasons alongside its own work budgets.

Client `recall`, `expand`, and `sessions` calls require `args.source` and accept
`{ signal }` as their second argument. They use only the registered source,
never implicit filesystem discovery. Provider actions accept the same optional
`source` argument; omitting it preserves the normal filesystem behavior.
Source-qualified follow pointers and guest `memory.walk` retain this binding.

Hosts that only need a local directory of session JSONL files (a synced
laptop archive, a copied agent tree) do not have to write an adapter:
declare it in `fabric.json` and the runtime registers a built-in `fs`
source before installing the provider.

```json
{
  "memory": {
    "sources": [{ "id": "laptop", "kind": "fs", "root": "/home/me/pi-archive" }]
  }
}
```

The root is walked recursively for `*.jsonl`, so native agent trees and flat
archive directories both work; session keys are root-relative paths. The
adapter satisfies the same interface as a hand-written source, including
content-hash revisions and coverage reporting, so everything below applies
to it unchanged. Key rules and validation errors are documented in
[configuration](configuration.md#memory-sources); with no `memory.sources`
entries the provider behaves exactly as before.

Host records reuse the normal branch, normalization, ranking, structural trace,
coverage, and lossless expansion paths. Revision/content hashes and lineage
fingerprints reject stale follow pointers. Host shards are rebuilt within
bounds for each call and are not persisted to the filesystem index.

These are explicit retrieval primitives. Fabric does not automatically recall
before a turn, inject historical context, choose bot/group permissions, or
require a hosted memory vendor. Such recipes belong to the embedding product.

## Active branches

`memory.recall`, `memory.sessions`, and `memory.expand` accept
`branches: "active" | "all"`. Every scope defaults to `"active"`, including
`project`, `global`, and explicit `session:<id-or-path>` scopes. Only records
carried on each session's active parent-linked path contribute to hot text,
cold vocabulary, structural addresses, hits, and entry counts, so an
abandoned sibling cannot match by default. `branches: "all"` asks explicitly
for every branch. Expansion results and session rows identify their branch
mode; recall follow calls preserve it.

For the current live session, every memory action calls the extension
context's live `SessionManager.getBranch()` and `getLeafId()` getters.
These live reads observe `/tree` navigation even when no new record has
been appended. For another persisted session, Fabric follows Pi 0.80.6's
persisted semantics. The last persisted non-header entry serves as the
leaf, duplicate IDs resolve to the last record in the ID map, and Fabric
walks `parentId` links from that leaf to a root. Append order never counts as one transcript. When a parent
cycle occurs, Fabric stops defensively and marks coverage incomplete with
`invalid_parent_graph`.

Each derived record carries `branches` and a SHA-256 `lineageFingerprint`
over the selected branch mode, leaf, and active path IDs. Active and all
caches use separate filenames. Branch mode, lineage fingerprint, and privacy
settings all feed cache policy, so navigation, an append, or a policy change
rebuilds the relevant derived record without contaminating the other mode.
`sourceHash` still covers the complete JSONL source, including off-lineage
records.

## Cache V6

Cache records carry `cacheVersion: 6`. Fabric removes older or malformed
records and rebuilds them from source. Rebuilding from source replaces any
migration of old records into V6. Refresh also clears orphan records,
records whose encoded cache path fails to match their source identity, and
records for deleted source sessions.

Every cache record stores the exact session file path, branch mode, lineage
fingerprint, privacy policy, and a SHA-256 `sourceHash`, along with source
mtime and size. A same-size rewrite that preserves mtime still invalidates
the record. Fabric creates cache directories with `0700` permissions and
cache files with `0600` permissions on a best-effort basis.

A hot shard holds bounded normalized entry text plus `indexCoverage`. Each
cold digest contains:

```ts
{
  cacheVersion: 6,
  kind: "digest",
  sessionId, file, cwd,
  mtime, size, sourceHash,
  branches, lineageFingerprint, policy,
  firstTs, lastTs, entryCount,
  filesTouched, toolHistogram, errorCount,
  vocabulary,   // sorted unique canonical strings, no posting lists
  addresses,    // structural identity + ref/provider/action/outcome postings
  indexCoverage,
  cacheBytes, cacheSourceRatio
}
```

Cold vocabulary maps each exact lexical term only to the session that
contains it. The digest keeps no per-term entry indices. Structural address
tuples separately keep exact entry identity, role/tool/time, and persisted
`ref`/`provider`/`action`/`outcome` fields. A cold lexical result remains a
compact session candidate whose `follow` call carries its exact source and
hash bindings. It never appears as an inferred lexical entry range. Exact
lexical entry matches come back only after following that call.

`maxColdVocabularyBytes` bounds vocabulary construction for each session.
`maxColdCacheBytes` is a hard per-session cap on the persisted cache.
Reaching either cap sets `indexCoverage.complete` to false with an explicit
reason. The cache-size cap can force structural addresses or vocabulary to
persist as exact prefixes only. Fabric always reports this state as
`max_cold_cache_bytes` and never treats it as complete. `cacheSourceRatio`
divides persisted cache bytes by source bytes.

## Capability heads and exact structural retrieval

Fabric separates capability navigation from memory evidence.
`tools.catalog()` returns a deterministic current tree:

```text
Fabric capabilities
└── provider head
    └── action head
```

Provider/action names, descriptions, and descriptor hashes describe the
currently registered catalog. Full schemas stay available through
`tools.search()` and `tools.describe()`. A caller can use this metadata to
choose an action ref. Fabric never copies it into session entries.
Historical evidence comes from session records alone. Catalog descriptor
changes can shift discovery ranking. Historical structural membership stays
intact.

`memory.recall` accepts exact structural filters:

- `ref`, for example `pi.grep`.
- `provider`, for example `pi`.
- `action`, for example `grep`.
- `outcome`: one of `succeeded | failed | aborted | timed_out`.
- the existing `role`, `tool`, `since`, and `until` filters.

With no `query` present, persisted typed fields alone decide membership. A
`query` value constrains lexical or explicit-regex search with the same exact
filters. The result does not echo request diagnostics; the call already records
them. Catalog description text never becomes a lexical match.

```ts
const heads = await tools.search({ query: "search source files" });
const history = await memory.recall({
  scope: "project",
  ref: heads[0]?.ref,
});
const failures = await memory.recall({
  scope: "project",
  query: "timeout",
  ref: "agents.run",
  outcome: "failed",
});
```

A complete cold structural posting proves that the selected session contains
a matching typed entry. The cold response remains an integrity-bound session
candidate. A combined cold lexical + structural candidate cannot prove that
both conditions occur on the same entry, because cold vocabulary has no
posting lists. Coverage reports
`cold_structural_filter_requires_hydration`; follow the candidate before
claiming entry-level co-location.

## Exact lexical queries

Callers choose `queryMode` explicitly:

- `"literal"` is the default token mode.
- `"phrase"` performs a case-insensitive contiguous text search after Unicode
  normalization.
- `"regex"` requires an explicit opt-in.

Literal mode does not inspect punctuation to guess whether input is a regular
expression. It never compiles input with `RegExp`; a path such as `src/foo.ts`
stays literal text. Quotes are punctuation only in literal mode; quoted words
still become independent canonical terms and never turn into regex syntax.

`tokenize.ts` is the single canonical tokenizer for literal queries, hot BM25
scoring, and cold vocabulary creation. It applies Unicode NFKC normalization,
extracts Unicode letters, numbers, and `_` characters, then lowercases them.
Literal terms match through exact canonical-token equality. Fabric applies no
stemming, synonym expansion, or semantic regex classification.

Multi-term literal queries default to `queryMatch: "any"` so recall does not
silently lose an answer whose wording differs from the query. BM25 relevance
is weighted by typed provenance: assistant and user prose ranks ahead of
tool-call plumbing unless structural filters explicitly request operations.
Every exact entry is ranked individually; context-segment grouping cannot give
thousands of neighbors one shared score.

The response is still hard-bounded, so broad discovery cannot flood model
context. Request `queryMatch: "all"` when every canonical term must occur in
one indexed entry:

```ts
memory.recall({
  query: '"Use CEF" "Stage 1" browser Heddlework',
  queryMatch: "all"
})
```

Use `queryMode: "phrase"` when word order and adjacency are material. The
request is not echoed in the compact result.

In a cold session with complete coverage, every unique canonical token of the
normalized source text occurs exactly once in the sorted vocabulary. An
`all` query requires every term in that vocabulary, but the vocabulary cannot
prove same-entry co-location. Phrase adjacency cannot be proved either. Both
cases return an explicit incomplete cold-coverage reason until the session is
resolved. Rare terms stay exactly discoverable as
long as the configured vocabulary and cache bounds hold. Exceeding a bound
makes an empty result explicitly non-authoritative.

Unicode scalar count sets the hot-text limit. Raw UTF-16 code units play no
part. A cut cannot split a surrogate pair, and the shard text remains valid
UTF-8. Hot shards retain no separate complete tail vocabulary, so truncating
any normalized entry sets shard `indexCoverage.complete: false` with reason
`max_entry_chars`. A token that occurs only after the cut cannot yield an
authoritative no-match. Recall returns no hit and reports that reason through
`coverage`. Expansion still re-reads the complete source record.

## Bounded regular expressions

Regex mode runs JavaScript regex inside a disposable worker thread. The host
never evaluates an untrusted pattern. Fabric terminates the worker forcibly
at the hard timeout, so catastrophic backtracking cannot continue on the
host thread. Four limits bound regex execution:

- UTF-8 pattern byte count.
- haystack item count.
- aggregate UTF-8 haystack bytes.
- wall-clock worker timeout.

A hot haystack is normalized entry text. A cold haystack is one bounded
canonical vocabulary term. Transcript prose never serves as a cold
haystack. Invalid patterns, oversized patterns, haystack truncation,
worker failures, and timeouts each return structured query coverage. A timeout, for example, returns `coverage.complete: false`, the
reason `regex_timeout`, and a structured `coverage.error`. An incomplete
regex result never counts as an authoritative no-match.

## Tiers, refresh, and work budgets

Pi's built-in filesystem memory provider runs recall, expansion, and session
listing in one lazy worker thread. Discovery, source hashing, JSON parsing,
cache maintenance, and ranking do not run on Pi's input/render thread. A
burst of calls shares a FIFO queue (at most 64 outstanding requests), rather
than spawning a CPU-heavy worker for every recall. Aborting an active call
terminates its worker; queued calls can be cancelled independently. Idle
workers are unreferenced and released after 30 seconds, and provider teardown
terminates outstanding work. A missing worker artifact is an error, not a
silent fallback to blocking execution.

Live-session branch snapshots carry entry IDs only, are taken when each
queued request starts, and are checked again before returning its result.
Navigation during retrieval rejects the request to avoid returning evidence
from a different live branch. Registered host-backed adapters remain in their
authorized owning host and keep their existing cancellation contracts.

`bun run benchmark:memory-recall` exercises a burst of 13 cold-session recalls
and reports both retrieval time and host event-loop heartbeat gaps. Pass
`--inline` directly to `node scripts/benchmark-memory-recall.mjs` to compare
with the synchronous engine used internally by the worker.

The `memory.hotSessions` most recently modified sessions stay hot. Every
older session is cold. Once a session crosses the boundary, Fabric drops
the old derived tier record after building the replacement. Explicit
hydration re-reads source without promoting a cold session.

Session count and aggregate source bytes bound cache synchronization.
Cache cleanup follows budgets on inspected cache files and aggregate
cache bytes. The cleanup byte budget is shared with
`maxSyncSourceBytes`. Reaching a work budget stops additional indexing
and sets `coverage.complete: false`. All eligible sessions remain
counted. Fabric bounds every background job, and the index needs no
database dependency.

Query mode and no-query browse mode both discover every eligible session.
`memory.maxSessions` limits session listing only. Search materialization
works under explicit deterministic per-call budgets: 50,000 filtered hot
entry candidates, 10,000 cold digest candidates, and 10,000 ranked result
candidates. Hitting one of these marks coverage incomplete with
`candidate_entry_budget`, `candidate_digest_budget`, or
`candidate_item_budget`. Public totals count the retained exact entry hits
and cold session candidates after filtering. Unknown omitted candidates stay
outside those totals.
Coverage reports:

```ts
coverage: {
  complete: boolean,
  indexedSessions: number,
  eligibleSessions: number,
  staleSessions: number,
  incompleteSessions: number,
  reasons: string[],
  error?: { code: string, message: string }
}
```

An empty `hits` array is authoritative only when cache/index coverage and
query execution coverage are both complete. Otherwise `coverage.reasons` names
causes such as source unavailability, `max_entry_chars`, duplicate identities,
vocabulary, file-metadata, or cache caps, candidate or synchronization budgets,
or regex limits.

## Scopes

| Scope | Meaning |
| --- | --- |
| `session` | The current session, or the newest session for the current cwd. |
| `project` | All sessions in the current cwd's Pi session directory. |
| `global` | Sessions under the agent directory. This scope requires an explicit request and can never be the default. |
| `session:<id-or-path>` | One source session, resolved explicitly without promotion. |

Duplicate session IDs are ambiguous. `session:<id>` and `memory.expand`
reject an ambiguous ID with `ambiguous_session` and list the candidate paths.
Normal recall navigation does not require extracting a path: copy the hit
`follow` call unchanged.
Duplicate normalized entry IDs and operation addresses also mark index
coverage incomplete, with `duplicate_entry_id` or
`duplicate_operation_address`. Stable-address expansion demands exactly one
record. Zero matches return `address_not_found`. More than one match
returns `ambiguous_address`. Fabric returns no source records in either case.

## Compact results and call tokens

`memory.recall` returns one flat, bounded hit stream:

```ts
type FabricCall = {
  ref: "memory.recall" | "memory.expand";
  args: Record<string, unknown>;
};

type RecallPage = {
  total: number;
  hits: MemoryHit[];
  next: FabricCall | null;
  coverage: MemoryCoverage;
  error?: MemoryError;
};
```

`total` is the retained pre-page count of exact entry hits plus cold session
candidates. `hits.length` is the returned count. The request already records
query semantics, so results do not echo query terms, modes, filters, offsets,
or redundant counts and prose.

A hot or explicitly resolved entry hit carries evidence plus one action:

```ts
{
  kind: "entry",
  sessionId,
  tier,
  index,
  entryId,
  parentId,
  operationAddress,
  type,
  role,
  tool,
  ref,
  provider,
  action,
  outcome,
  timestamp,
  isError,
  score,
  snippet,
  truncated,
  follow: { ref: "memory.expand", args: { /* integrity-bound selector */ } }
}
```

A cold candidate cannot claim an exact source entry. It carries only
session-level evidence and a recall action:

```ts
{
  kind: "session",
  sessionId,
  tier: "cold",
  cwd,
  lastTimestamp,
  score,
  matchedTerms,
  matchedStructuralEntries,
  follow: { ref: "memory.recall", args: { /* integrity-bound request */ } }
}
```

The integrity arguments live only inside `follow`; they are not duplicated in
separate source or action-specific pointer objects. Dispatch either hit without
branch-specific plumbing:

```ts
const detail = await tools.call(hit.follow);
```

When a statically typed result is useful, discriminate the hit and call the
known provider method:

```ts
const detail = hit.kind === "entry"
  ? await memory.expand(hit.follow.args)
  : await memory.recall(hit.follow.args);
```

Recall ranks one mixed stream and then paginates it. `pageSize` is a request
ceiling, not permission to exceed the hard 30,000-character JSON envelope.
If more retained items remain, `next` is another complete call token:

```ts
let page = await memory.recall({ query: "timeout", scope: "project" });
while (page.next !== null) {
  page = await memory.recall(page.next.args);
}
```

A single-session continuation includes exact source-hash and lineage bindings;
an append or branch change returns `stale_pointer`, preventing a silent page
shift. Each project or global call takes a fresh, nontransactional snapshot.
Every snippet is independently bounded and reports only whether it was
truncated.

An optional inclusive `entryRange` can bound explicit single-session recall.
Both endpoints must be valid normalized indices. Out-of-range or negative
addresses return `index_out_of_bounds`; Fabric never clamps them.

## Session outline

`memory.outline` maps one resolved session before reading it. It resolves the
session exactly like `memory.expand` — same `source`, `branches`, and pointer
arguments — and returns a deterministic skeleton: one bounded row per
normalized entry with `index`, `type`, `role`, `tool`, a whitespace-collapsed
single-line `preview` (at most 120 characters, never splitting a surrogate
pair), and `size`, the entry-text length a later `memory.expand` returns for
that index. No scores, no ranking, no continuation. `maxEntries` caps the rows
(default 200); `total` and `truncated` report the full skeleton size, and
`entryCount` always counts the resolved session before any filter.

An optional `role` argument filters the skeleton by exact normalized role, and
`memory.expand` accepts the same `role` argument: it filters the resolved
selection before chunking and rides the continuation in `next.args`. An empty
match returns a plain empty view with `next: null`.

```ts
const map = await memory.outline({ session });
const userRows = map.entries.filter((row) => row.role === "user");
const first = await memory.expand({ session, indices: [userRows[0]?.index ?? 0] });
```

## Expansion and guest-local computation

`memory.expand` re-reads full, untruncated normalized records. It accepts
indices, stable entry IDs, operation addresses, or an inclusive range.
`before` and `after` add adjacent entries around exactly one selected anchor:

```ts
const exact = await memory.expand(hit.follow.args);
const around = await memory.expand({
  ...hit.follow.args,
  before: 2,
  after: 3,
});
const operation = await memory.expand({
  session,
  operationAddresses: ["entry-uuid/7"],
});
```

Expansion results use `entries`. Recall and expansion both call the capability
field `tool`. Expanded records include Pi's `parentId`, so code can reconstruct
branch relationships under `branches: "all"`; `parentEntryId` remains the
separate carrier link for extracted Fabric child records.

Expansion never silently slices away a long record. Every returned chunk has
`textRange: { start, end, total, complete }`. A partial final entry returns a
non-null `next`; follow it to reconstruct the exact text:

```ts
let chunk = await memory.expand(args);
while (chunk.next !== null && chunk.next !== undefined) {
  chunk = await memory.expand(chunk.next.args);
}
```

The default aggregate text budget is 20,000 characters and `maxChars` can
request a smaller chunk. Valid typed operation and branch-fact payloads stay
available as bounded structured fields. Oversized structured payloads set
`structuredTruncated` and stay out of the envelope.

For arbitrary filtering, projection, aggregation, joins, and parent traversal,
the query language is the surrounding TypeScript. `memory.walk` is a
guest-only combinator, not a fourth host action and not a serialized callback:

```ts
const failedFiles = new Set<string>();
const parents = new Map<string, string | null>();

const walk = await memory.walk(
  { session, branches: "all" },
  async (entry) => {
    if (entry.entryId) parents.set(entry.entryId, entry.parentId);
    if (entry.outcome === "failed") {
      for (const file of entry.filesTouched ?? []) {
        if (file) failedFiles.add(file);
      }
    }
    return failedFiles.size < 20; // exactly false stops early
  },
);

return { files: [...failedFiles], visited: walk.visited };
```

With no selector, `memory.walk` obtains an integrity-bound session range and
visits the whole normalized session. With a selector, it visits only that
selection and optional context. Start it from an original selection, not a
continuation with a nonzero `textOffset`, because every callback receives a
complete entry. The helper follows all expansion pages, validates continuity,
and reassembles each `textRange` fully before invoking the visitor,
awaits async visitors and nested tool calls, and returns `{visited, stopped}`.
A provider error is returned as `walk.error`. Functions remain inside the guest
runtime, isolated by default; no predicate source or closure crosses the host
bridge.

This is the Python replacement boundary: the host supplies bounded search and
lossless normalized records; the fabric program supplies callbacks, maps,
sets, joins, reductions, and the small final `return`. Do not add JSONPath,
SQL, projection, grouping, or host-evaluated predicate fields, and do not open
Pi session JSONL directly.

During recall follow calls and expansion, Fabric compares the expected source
hash and lineage fingerprint with the selected live or persisted session. A
rewrite, append, or active-leaf navigation that changes a binding returns
`stale_pointer` and no source content. Under active mode, an off-lineage stable
address returns `address_not_found`; `branches: "all"` is the explicit way to
read it.

A valid `FabricExecutionTraceV1` on an outer `fabric_exec` result emits one
child record per operation, placed immediately after the outer normalized
entry. Each child keeps `parentEntryId`, `operationAddress`, the exact
`tool`, `ref`, `provider`, `action`, typed `filesTouched`, `outcome`, and a
bounded structured `operation` object. Expansion re-reads and
re-normalizes source. Fabric never reconstructs operations from output
prose.

Valid `FabricBranchSummaryDetailsV1` and V2 envelopes emit typed child
records for user, phase, and operation facts. Under V2, they also emit
children for named `fabricRun` facts. Run children keep the bounded declared
name and description, the paired aggregate outcome, and the original call
address. They index as `fabric_exec` and expand by that operation address.
Other children keep the original fact address, the
ref/provider/action/tool/outcome/arguments values, and the structurally
derived paths, plus `carrierEntryId`, `carrierParentId`, and
`carrierFromId`. Operation facts expand by their original operation address.
User and phase facts use that address as their stable entry ID. Fabric
deduplicates repeated nested summaries by exact fact address in source
order, which keeps the earliest carrier deterministic. Inside each consumed
details envelope, addresses must be unique. Fabric rejects an envelope with
a duplicate address and marks coverage incomplete. Unknown or malformed
details and all branch-summary prose remain non-semantic.

## Local-cache privacy and deletion

Treat the memory index as local derived state. It sets no encryption or
semantic-privacy boundary. Depending on configuration and tier, cache JSON
can retain plaintext lexical vocabulary, cwd and file paths, source
pointers and hashes, structural tool and capability metadata, selected
user/assistant/custom-message content, tool arguments, and selected tool
output when the default `indexToolOutput: true` applies. Cold vocabulary
holds no posting lists. The exact words still appear in it as plaintext.
Thinking text stays excluded by default. Enabling it explicitly stores it
as plaintext. Fabric runs no secret scanning. Privacy here comes from
structural inclusion or exclusion, and regex classification plays no
part.

Fabric requests `0700` for cache directories and `0600` for cache files.
These permissions are best effort and inherit the host filesystem, account,
backup, and administrative trust model. The cache stays unencrypted. Fabric
reads project configuration only for a project that Pi has marked trusted.
Otherwise, only global Fabric configuration applies. A `global` memory
search is an explicit scope, never the default. Under that explicit scope,
global indexing still creates local derived records for the sessions that
the call selects.

Deleting a Pi session removes the source of truth. A later memory refresh
removes the orphaned cache records on a best-effort basis. When immediate
cache removal is required, delete the configured `memory.indexDir` as
well.
Removing that directory is safe, because every record is disposable and
rebuilt from the remaining session JSONL. Cache deletion leaves source
sessions, filesystem backups, and copies outside the index directory
untouched.

## Benchmarking capability-head retrieval

After changes to discovery, structural postings, ranking, or cache layout,
run the deterministic synthetic benchmark:

```sh
bun run benchmark:memory-heads
```

The benchmark reports catalog head selection separately from source
retrieval, hot exact operation-address recall, cold session recall, combined
lexical + structural retrieval, negative controls, the cold digest/source
ratio, and p50/p95/p99 search latency. The command fails when catalog
description text leaks into lexical matches, structural provenance is lost,
cold combined candidates omit the hydration requirement, or a nonexistent
ref returns history. Repository tests cover source JSONL, branches, staleness, and cache generation.
The synthetic timing corpus covers the measured search paths.

## Configuration

```json
{
  "memory": {
    "enabled": true,
    "indexDir": "~/.pi/agent/fabric/memory-index",
    "maxSessions": 500,
    "maxEntryChars": 2000,
    "indexThinking": false,
    "indexToolOutput": true,
    "hotSessions": 50,
    "maxColdVocabularyBytes": 524288,
    "maxColdCacheBytes": 1048576,
    "maxSyncSessions": 10000,
    "maxSyncSourceBytes": 536870912,
    "maxCacheCleanupFiles": 100000,
    "regexMaxPatternBytes": 1024,
    "regexMaxHaystackTerms": 20000,
    "regexMaxHaystackBytes": 2097152,
    "regexTimeoutMs": 250
  }
}
```

- `maxSessions`: limits session-list discovery only. Candidate and indexing
  budgets control recall.
- `maxEntryChars`: Unicode-scalar limit for persisted hot entry text. Any
  cut marks lexical coverage incomplete, and expand still re-reads full
  source.
- `indexThinking`: when true, assistant thinking blocks enter normalized
  text and lexical vocabulary. Default: false.
- `indexToolOutput`: when true, tool-result bodies, bash output, and typed
  Fabric operation results enter derived text. Default: true. Coding recall then includes tool outputs. When false, typed tool name/ref/action,
  error/outcome, and structurally extracted path metadata stay searchable.
  Output bodies do not.
- `hotSessions`: count of globally newest sessions that keep hot shards.
- `maxColdVocabularyBytes`: per-session bound on the canonical vocabulary.
- `maxColdCacheBytes`: hard per-session bound on the cold cache file.
- `maxSyncSessions` / `maxSyncSourceBytes`: work budgets for synchronous
  indexing.
- `maxCacheCleanupFiles`: count budget for synchronous cache-file cleanup.
  Cleanup bytes draw on `maxSyncSourceBytes`.
- `regexMaxPatternBytes`, `regexMaxHaystackTerms`,
  `regexMaxHaystackBytes`, `regexTimeoutMs`: bounds on isolated regex
  execution.
