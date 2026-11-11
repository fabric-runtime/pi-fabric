---
name: pi-recall
description: Cross-session memory over raw pi session transcripts — BM25-ranked recall, full-entry expand, session catalog — via the pi-recall CLI. Use before domain work on a known topic (past decisions, prior failures, "did we already try X", what other sessions concluded). Never for facts derivable from the repo or git history — read those directly.
---

# pi-recall — cross-session memory

## Two-step idiom — always this shape

    pi-recall recall 'contour guard vitest' --scope global --limit 5
    pi-recall expand id=<8-hex id from the chosen hit>

recall = navigation (ranked hits, each carrying id=); expand = reading
(lossless full entry — long texts page via the textOffset hint it prints).
Never grep session JSONL by hand — expand is the sanctioned full read.

## Scope intuition

- global — default for recall; run it before domain work on a known topic
  ("what did we already decide about X", prior failures, past tooling).
- project — this repo's chronology; session — own lineage (sessions default).
- `--branches all` — also abandoned off-lineage tree siblings.

## Query shape and paging

Default matches any term (OR); `--phrase` = adjacency, `--regex` = pattern,
`--all` = every term in one entry. Cold sessions cannot prove adjacency —
probe a cold session with one rare literal term first. Page with
`--limit`/`--offset` (the output names the next offset).

## Tool door

The package also registers deferred tools `memory_recall` / `memory_expand`
/ `memory_sessions`. How you reach them depends on the host contour (a
bridge, the model surface, a wrapper CLI); the CLI above always works
regardless.

## Hygiene

Raw recall/expand output over ~4KB → write to a file, keep a ≤1KB digest in
context (id + one-line gist per hit).

## Liveness and trust

The current session indexes on the fly. The index is a disposable cache;
session JSONL is truth — stale or corrupt index state is refused and rebuilt,
never silently served. Read the coverage header line: stale/incomplete counts
or listed reasons mean an empty page is NOT a no-match proof — narrow the
query, or browse `pi-recall sessions --scope global` by cwd/mtime and expand
the picked session directly. Refusals: `stale_continuation` (continuation
pointer no longer matches the source — re-recall), `source_unavailable`
(a configured fs source is missing/unreadable).

## Boundaries

Not for anything derivable from code or git — read the repo instead. Not for
one-off dialog details: recall is for durable cross-session decisions and
failures, not chit-chat retrieval.
