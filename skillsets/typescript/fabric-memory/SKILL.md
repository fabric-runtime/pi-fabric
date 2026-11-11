---
name: fabric-memory
description: >-
  Search and read old pi sessions via Pi Fabric's memory provider
  (memory.recall / memory.expand / memory.walk / memory.sessions) inside
  fabric_exec. Use for session archaeology — "что было в прошлой сессии",
  "find where we did X", cross-session history, past decisions and failures.
  Supersedes pi-session — never grep session JSONL by hand.
  RU: прежде чем начинать задачу — проверь в памяти, не делали ли мы это уже; что решали в прошлых сессиях.
---

# fabric-memory — session recall in Pi Fabric

Upstream truth: `memory-recall.md` in the installed pi-fabric package
(`~/.pi/agent/npm/node_modules/@e4779/pi-fabric/docs/memory-recall.md`).
Exact verb schemas on demand: `tools.describe({ ref: 'memory.recall' })`
(same for `memory.expand` / `memory.sessions`); `memory.walk` is a
guest-only combinator — describe rejects it. This skill is the
operational recipe layer on top.

## Mental model

- Session JSONL is the source of truth; the memory index is a derived,
  disposable cache (hot shards for recent sessions, cold digests for older —
  tiers by recency, `memory.hotSessions` boundary).
- `recall` = navigation (ranked snippets), `expand` = reading (full entries),
  `walk` = scan/filter/reduce/traverse, `sessions` = catalog.
- NEVER locate or parse `~/.pi/agent/sessions/*.jsonl` yourself: follow calls
  carry integrity bindings (SHA-256 source hashes, lineage fingerprints) and
  stale sources are refused.
- The store may be MULTI-MACHINE: with fs sources (`memory.sources` in
  fabric.json — e.g. a shared `~/pi-memory/native` kept in sync by rsync),
  other hosts' sessions are queryable via source-qualified calls (below).

## The #1 gotcha: scope

`memory.recall` defaults to `scope: "session"` — the CURRENT session only.
Old sessions need an explicit scope:

- `scope: "project"` — sessions under the current cwd
- `scope: "global"` — everything
- `scope: "session:<id-or-path>"` — one session

`branches` defaults to `"active"` (each session's parent-linked path);
pass `branches: "all"` to also search abandoned `/tree` siblings.

## Source-qualified recall (multi-machine stores)

`scope` selects among LOCAL sessions; `source` selects a registered fs source
(shared store). They do not mix:

```ts
// other machines' sessions via the shared store — NO scope here:
await memory.recall({ query: 'copyparty', source: 'thinkpad' });
// mixing fails: "scope must name the selected source, one of its sessions,
// or be omitted"
```

- `scope: 'global'` covers only locally indexed sessions — an empty local
  recall says NOTHING about other machines; query the source explicitly.
- Forked sessions duplicate entries across files (same text, different
  sessionId) — dedup by snippet/entryId when building chronologies.

## Cold sessions and index budgets (verified 2026-11-03, 193MB fs source)

- **Enumerate sources FIRST**: `rg -n 'sources' ~/.pi/agent/fabric.json`
  (or try `memory.sessions({ source })`). With `source` set there is NO
  filesystem fallback — a local-scope result says nothing about a source.
- **fs-source session keys are ROOT-RELATIVE paths.** `sessions()` rows
  carry `file: "memory-source:<id>/<root-relative-key>"`. Direct read
  without any hit: `memory.expand({ source, session: '<key>', entryRange:
  { first, last } })` (or `indices`). `entryRange` endpoints must be
  valid normalized indices — no clamping, out-of-range errors.
- `expand` **re-reads the source** — it works even for sessions the
  index never saw (cold digest capped, `entryCount: 0`, outside sync
  budget). A bare session id + source can SILENTLY return `entries: []`
  for such sessions — always prefer the root-relative key.
- **Discriminate `hit.kind`**: `'entry'` → `follow.args` go to
  `memory.expand`; `'session'` (cold candidate) → `follow.args` go to
  `memory.recall` (integrity-bound single-session page), whose entry
  hits then expand normally.
- **Cold digests cannot prove phrase adjacency or same-entry
  co-location** — `queryMode: 'phrase'` / `queryMatch: 'all'` return
  incomplete cold coverage, not hits. Probe a cold session with ONE rare
  literal term (tokenized exact match against the digest vocabulary).
- **Big archives index PARTIALLY per call.** Observed on a 193MB /
  252-session source: 149 indexed, 103 stale, `coverage.reasons:
  ['max_sync_source_bytes', 'max_entry_chars', 'max_files_touched']`.
  Empty recall on such a source is NEVER authoritative. Playbook:
  `memory.sessions({ source })` → pick by cwd/mtime → expand by key
  directly; walking the whole session works too (`walk` follows expansion
  pages and reassembles textRange).
- Catalog caps surface in the envelope: `coverage.reasons:
  ['source_coverage:fs_source_max_sessions']`, plus `staleSessions` /
  `incompleteSessions` counts. Budgets (`maxSyncSourceBytes`,
  `memory.maxSessions`, `memory.hotSessions`) live in host fabric.json —
  raising them is the host owner's call, not the agent's.

## Recipes

```ts
// Ranked discovery across all sessions (any-term OR by default):
const r = await memory.recall({
  query: 'memos 4779 deploy',
  scope: 'global',
  branches: 'all',
});
// r.hits[].snippet, r.total pre-page count.
// Full entry / cold-session resolution:  await tools.call(hit.follow)
// Hit fields: sessionId (NOT `session`), index, entryId, tier, score,
// follow:{ref,args}. Pass follow.args WHOLESALE into expand — it carries the
// integrity binding (expectedSourceHash); do not hand-roll {session, indices}.
// Continue pages while r.next !== null:  await tools.call(r.next)

// Strict matching:
await memory.recall({ query: '"Use CEF" Stage 1', queryMatch: 'all', scope: 'project' });
await memory.recall({ query: 'src/foo.ts', queryMode: 'phrase' });   // adjacency matters
await memory.recall({ query: 'timeout.*restart', queryMode: 'regex' }); // sandboxed worker

// Structural history — no lexical query needed:
await memory.recall({
  scope: 'global',
  ref: 'pi.edit',            // or provider / action / role / tool
  outcome: 'failed',          // succeeded | failed | aborted | timed_out
  since: Date.now() - 7 * 864e5,
});

// Full-entry reading with neighbors (session path comes from hit.follow args):
await memory.expand({ session, indices: [12], before: 2, after: 2 });
// before/after need EXACTLY ONE anchor: indices:[a,b] + before/after fails
// with "requires exactly one resolved anchor" — one index with neighbors,
// or many indices without them.
// Entries can arrive truncated in multi-entry calls: check textRange.complete;
// if false, re-expand that single index for the lossless full text.

// Map/reduce over whole sessions (visitor may await nested calls; false stops):
await memory.walk(args, async (entry, i) => { /* ... */ });
// walk args = same selector family as expand ({session, indices|entryRange,
// before, after}) — there is NO `from`. A cap-based early stop (`return
// rows.length < N`) silently truncates: the max seen index is where the
// visitor STOPPED, not the session end. Need the true end? Counting pass:
// let last = -1; await memory.walk({ session }, () => { last += 1; return true; });

// Catalog (returns an ENVELOPE, not a bare array):
const c = await memory.sessions({ scope: 'global' });
// c.sessions → [{id, file, cwd, mtime, entryCount, tier, branches}]
// ⚠️ provider surface is non-enumerable: Object.keys(memory) shows only
// `walk` — a missing key does NOT mean a missing verb.
// Cross-machine catalog: memory.sessions({ source: 'thinkpad' }) lists the
// shared-store sessions (mixed cwds; NO next page — the envelope carries
// coverage; a listing ceiling surfaces as source_coverage:fs_source_max_sessions).
// Source-session rows: file = "memory-source:<id>/<root-relative-key>"
// (use the key for expand, not the bare id).
```

## Offload hygiene

Keep recall projections small in-guest (few fields, snippets ~170 chars) so
the result stays under the CE auto-offload threshold. If a big result DID
offload, reading it back yields multiply-encoded envelopes (envelope → JSON
→ quoted content) — prefer re-running a narrower recall over unwrapping
handle ladders.

## Reading coverage: empty ≠ proof

`coverage.complete === false` lists reasons — verified in the wild:
`max_entry_chars` (hot-text cut), `max_cold_cache_bytes`,
`max_sync_source_bytes` (source indexed partially — 103 stale sessions
on one archive), `source_coverage:fs_source_max_sessions` (catalog
ceiling), `cold_structural_filter_requires_hydration`,
`duplicate_entry_id`, `regex_timeout`; counts in `staleSessions` /
`incompleteSessions`. An empty result under incomplete coverage is NOT
an authoritative no-match — narrow the query, hydrate via
`tools.call(hit.follow)`, or bypass the index entirely: expand by
root-relative session key.

## Why not pi-session

pi-session greps raw JSONL; fabric memory does the same job with BM25
ranking, structural filters, tiered cache, and integrity bindings — without
loading megabytes of transcripts into context. The pi-session skill is
hidden from the model (`disable-model-invocation: true`); `/skill:pi-session`
remains as a manual fallback.
