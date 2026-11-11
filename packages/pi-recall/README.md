# pi-transcript-recall

BM25-ranked recall over raw session JSONL + full-entry expand + multi-machine
fs-sources + integrity/staleness refusal — the memory module of
[e4779/pi-fabric](https://github.com/e4779/pi-fabric) extracted as an
engine-free pi package (Phase-1 of the pi-fresh plan). MIT.

Full capability signature (ranked search over the raw session tree +
lossless full-entry expansion + portable source registries + stale-pointer
refusal) existed nowhere in the pi package catalog when the extraction was
planned; the code is ours.

## What it is

- **recall** — ranked BM25 search over every session timeline on the machine,
  hot shards in memory, cold sessions as structural digests.
- **expand** — the sanctioned digest→full-entry read: exact entries by index,
  entry id, or operation address, with bounded lossless chunking.
- **sessions** — scope-bounded session listing with tier/lineage metadata.
- **sources** — portable source registry; `fs` adapters walk any directory of
  session JSONL (multi-machine archives through rsync mounts).
- **integrity** — expected-source-hash / expected-lineage-fingerprint
  pointers: changed sources are refused, never silently re-ranked.

Index compatibility is exact: `MEMORY_CACHE_VERSION = 6` unchanged, the index
at `~/.pi/agent/fabric/memory-index` is read as-is (built lazily on read),
zero migration. The live index of the production contour stays authoritative
while both surfaces coexist.

## CLI

    pi-recall recall 'shell contour'            # ranked search (scope=global default)
    pi-recall recall --scope project --all foo bar
    pi-recall expand <8-hex-id>                 # full entry from a recall hit
    pi-recall expand session=<path|sid> idx=3,4 maxChars=20000
    pi-recall sessions --scope global

Run with bun from the repo: `bun run bin/pi-recall recall 'query'`.
Agent tree: `~/.pi/agent` (`PI_CODING_AGENT_DIR` honored). Index location:
`${agentDir}/fabric/memory-index` (`PI_RECALL_INDEX_DIR` honored — point
index **writes** at an isolated tree; never at a live index you don't own).

## pi extension

`pi.extensions: ["./extensions/memory.ts"]` registers tools
`memory_recall` / `memory_expand` / `memory_sessions` via `registerTool`
(exposure `deferred`: callable through `ctx.executeTool` — e.g. a shell contour bridge — but not declared to the model by default),
mirroring the fork's provider semantics (argument normalization, shared
request cache, ambiguous-session response mapping). The engine's live-branch
hook (unflushed live-session entries) is fork-side by design; here the
session file on disk is the truth.

## Extraction seams (vs e4779/pi-fabric)

`src/memory/*` is copied byte-identical. The engine coupling the plan claimed
as "3 one-liners + type-only imports" verified out as:

- **type-only** (config, protocol, audit trace shapes) → carried as local
  structural shims at the same relative paths (`src/config.ts`,
  `src/protocol.ts`, `src/audit/*`), so memory sources stay unmodified;
- **verified-policy one-liners** (`lineageSelected`, `pointerCurrent`,
  `coverageComplete`, `acceptMemoryChunk`) → plain predicates with the
  machines' truth tables pinned by tests (`src/verified/policy.ts`);
- **compaction readers** (`branch-details`, `trace-events` — pure JSON
  readers used by session normalization) → copied;
- **provider layer** (`providers/memory-provider.ts`, `arg-normalization.ts`)
  → copied; the FabricProvider adapter (`memory/provider.ts`) is included for
  programmatic hosts and superseded by the registerTool extension above.

Left fork-side, engine-only by nature: `extractive-history` /
`extractive-index` (live-prompt machinery wired into the engine's extension)
and the worker-thread offload (`worker-provider` / `file-worker`).

## Development

    bun test          # unit tests (all writes isolated in temp dirs)
    bun run typecheck # tsc --noEmit

Typecheck resolves the peers through local symlinks
(`node_modules/@earendil-works/pi-coding-agent` and `node_modules/typebox` →
the global bun install);
re-link after a fresh clone. At runtime `pi -e .` resolves them through pi's
own user-package store.
