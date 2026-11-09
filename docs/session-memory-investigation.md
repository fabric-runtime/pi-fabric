# Session memory investigation (2026-11-09)

## Finding

Pi core 1.5.0 retains the complete parsed session history after context compaction.
This behavior reproduces without importing Fabric. It is history-size-dependent
retention, not evidence of unreachable objects leaking. Starting a new session
releases the old history; V8/allocator RSS need not fall at the same time.

Fabric adds overhead, but the tested executor/session lifecycle did not exhibit
runaway retained-heap growth. These controls do **not** fully attribute a live
macOS process's footprint or exclude leaks in untested workloads/extensions.

## Reproducer

`scripts/benchmark-session-memory.mjs` generates synthetic histories only. It
never reads real conversations. SDK modes use a local deterministic provider,
disable model-network refresh, isolate configuration in a temporary directory,
and disable optional Fabric engines/services. No actual model requests are made.
Temporary histories are removed on normal completion or caught failure.

Modes:

- `manager`: core SessionManager only. Load, build context, compact, replace with
  an active-context-only control, start new, and reopen/release twice.
- `paged`: the manager control plus Fabric payload paging. It uses text-block
  arrays so it can assert with weak references that the retired payloads were
  collected, then checks an exact cold read and unchanged source file.
- `sdk`: real core AgentSessionRuntime, an offline turn, and repeated new sessions.
- `fabric`: the same SDK lifecycle with the compiled Fabric extension and one
  successful `fabric_exec` (`return 1`) per session.
- `checkpoint`: retain a synthetic full archive on disk but open a new, tiny
  checkpoint session referencing it via `parentSession`. Core does not eagerly
  load the parent archive.

`--mib` sets the approximate synthetic archive size (1–1024 MiB).
`--cycles` sets SDK replacement count (1–200; default 6).
All measurements force three garbage collections across event-loop turns.
The script asserts context counts, model-context equivalence for the synthetic
projection, successful Fabric calls, non-cancelled replacements and no extension
errors. Memory values are observations, not timing-sensitive test thresholds.

```sh
# Run the checked-in matrix on boat; results include logs and placement.json.
supercomputer run --jobs scripts/benchmark-session-memory.jobs.json \
  --out /tmp/pi-session-memory --class interactive --vm-type large --timing

# Equivalent single case, inside a prepared remote checkout:
bun install --frozen-lockfile
bun run build
node --expose-gc scripts/benchmark-session-memory.mjs --mode fabric --mib 256
```

## Measured results

Nine isolated jobs passed on boat, each alone on a `large` VM, AMD Ryzen 9 9950X,
two pinned vCPUs. Runtime: Node v24.22.1, Linux x64; core: 1.5.0;
Fabric source base: `5946b458`. Each scenario used a fresh process.

Raw measurements, batch tree identities and placements are in
[`benchmarks/session-memory-2026-11-09.json`](benchmarks/session-memory-2026-11-09.json).
The initial three manager jobs predate the projection-control step added to the
reproducer; the later manager job verifies that step separately.

### History retention without Fabric

| Synthetic JSONL | Loaded heap | After compaction | After new session |
| --- | ---: | ---: | ---: |
| 64 MiB | 96.20 MiB | 96.28 MiB | 32.12 MiB |
| 256 MiB | 288.95 MiB | 289.04 MiB | 32.14 MiB |
| 600 MiB | 634.54 MiB | 634.62 MiB | 32.13 MiB |

Compaction reduced model context to **one message** in all cases. Reopening the
compacted file restored approximately the same large heap. Releasing it again
returned to approximately 32 MiB, with no accumulating copies of the old history.

RSS differs from reachable heap: in the 600 MiB case, new-session heap dropped
from 635 to 32 MiB, but RSS stayed near 789 MiB. Peak RSS over the repeated reopen
experiment reached 951 MiB. GC alone cannot be treated as an RSS reset.

### Matched SDK/Fabric controls (256 MiB history)

| State | Core SDK heap | Core SDK + Fabric heap |
| --- | ---: | ---: |
| Session created | 289.84 MiB | 318.44 MiB |
| Compacted | 289.83 MiB | 318.43 MiB |
| First offline turn / Fabric execution | 290.00 MiB | 350.78 MiB |
| First new session and turn | 33.26 MiB | 94.81 MiB |
| Released after six replacements | 33.51 MiB | 94.84 MiB |

The approximately 257 MiB history component disappears in **both** cases.
Fabric's first-use overhead includes compiler/runtime/module allocations; it is
not a measurement of the activity store under large nested workloads.

A separate 120-replacement control (1 MiB initial fixture) ended at 34.92 MiB
core heap and 102.34 MiB with Fabric. The Fabric samples at replacements
30/60/90/120 were 100.78/102.52/107.84/102.34 MiB; there was no runaway growth.
After disposal they were 34.60/99.16 MiB. RSS still climbed and must not be
confused with continually retained session histories.

### Prevention control

Opening a tiny fresh checkpoint linked to an untouched 600 MiB archive used
31.98 MiB heap and 173 MiB RSS, including fixture-generation overhead. Opening
the whole archive used 634.54 MiB heap and 788 MiB RSS. Separately, replacing an
already-loaded 256 MiB history with its synthetic active projection reduced heap
from 289.04 to 32.10 MiB, but did not immediately reduce RSS.

These controls demonstrate the memory benefit of not loading/retaining the archive.
They are **not** a production session migration: real histories also carry
extension state, model/tool state, usage, labels and branches.

## Why core does this

In the installed core's `dist/core/session-manager.js`:

- `loadEntriesFromFile()` streams the file but retains every parsed entry.
- `SessionManager.fileEntries` and `byId` retain those entries. They share objects;
  the two indexes are not two deep copies of the payloads.
- `appendCompaction()` appends a summary; `buildContextEntries()` selects a shorter
  active projection. Neither removes the older entries from the history store.
- `newSession()` replaces `fileEntries` and clears the indexes.
- Core's AgentSessionRuntime replacement tears down the old session and recreates
  its services. The SDK controls exercised that path, including extension shutdown.

## Direct Fabric-side implementation

The follow-up implementation pages inactive message payloads through the existing
entry objects, preserving history APIs and cached entry references. It also keeps
archived history out of actor-event context construction and removes awaited
mesh publication from abort boundaries. See [history paging](history-paging.md)
for configuration, compatibility assumptions, storage behavior and tests. The
measurements above remain the **pre-fix baseline**, not post-fix measurements.

## Other prevention avenues

1. **Immediately usable: fresh sessions with a concise handoff.** Keep the old
   JSONL as the archive and carry only the necessary summary/state into a fresh
   session. Restart the process too when immediate physical-memory reclamation
   matters. Resuming the same huge file reloads its history. Ordinary compaction,
   `/clone`, or a fork carrying the full ancestral path is not an archive-eviction
   mechanism.
2. **Best upstream fix: disk-backed/paged history.** Keep entry IDs, parent links,
   offsets and needed metadata in memory; hydrate payloads with a bounded cache.
   Keep the active model projection hot. History navigation, extension state,
   usage accounting, branches, labels and exports must still work. Merely clearing
   `fileEntries`/`byId` from an extension is unsafe and violates those contracts.
3. **Lower-risk upstream feature: an explicit checkpoint/continuation operation.**
   Create a new session with the complete current prompt/tool/model state,
   compaction summary, retained recent messages and required extension state,
   linked to the unchanged archive. Require an explicit user decision; a plain
   compaction should not silently change history/navigation semantics.
4. **Fabric-side pressure reduction.** Add a total byte budget to retained activity
   payloads and move bulky audit detail to lazy disk-backed references. Currently
   `src/activity/store.ts` permits 24 runs × 1,000 calls, with 64,000-character
   individual argument/result/preview caps. `src/audit/details.ts` caps each
   persisted result envelope at 512 KiB, not the total session. Those bounds can
   still accumulate substantially. Lower model-output caps alone do not bound
   historical input, persisted details or the activity store.
5. **Guardrails, not cures.** A memory/session-size warning can offer a handoff
   before pressure becomes severe. V8 heap flags do not cap total RSS/native
   allocations and may turn legitimate large histories into OOM failures. Forced
   GC cannot collect history still reachable from SessionManager. Process
   isolation/recycling is the reliable physical-memory reset.

## Limits and next checks

The fixtures contain ASCII user text, not a replica of a production conversation.
The SDK controls have no terminal rendering, graphics/image allocations, real
provider streaming, MCP servers, or other installed extensions. They establish
core history retention and quantify minimal Fabric overhead, not ownership of
every byte in the reported 1.8–2.25 GB macOS processes. A profile of one affected
live process or a separately authorized representative workload is still needed
for complete attribution. No user session was rewritten or terminated.
