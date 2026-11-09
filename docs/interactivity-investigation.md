# Interactivity during fabric_exec

Pi stuttered during long sessions, most of all while `fabric_exec` ran nested
calls and at the end of each `fabric_exec` turn. This records what the
profiles showed, what changed, and how to measure it again.

## How it was measured

`scripts/benchmark-interactivity.mjs` runs the bundled Pi CLI in a Linux
pseudo-terminal with a scripted offline model, so no network, credentials or
personal history are involved. Each turn issues one `fabric_exec` with N
nested `pi.read` calls and one `pi.bash` call (or, in the `core` control, the
same calls as direct Pi tool calls). Per turn it records wall and CPU time,
event-loop delay (how long a keystroke would wait), GC time, heap, and a count
of synchronous file writes by target. The active and idle phases are
CPU-profiled in process and summarized by package and function.

```sh
node scripts/benchmark-interactivity.mjs --variant fabric \
  --pi-cli <pi-coding-agent>/dist/bundle/cli.js --out /tmp/out \
  --turns 30 --calls 24 --seed-mesh-kb 2000 --seed-pool-mb 30
```

`--seed-mesh-kb` and `--seed-pool-mb` create a synthetic project mesh state
and a machine-wide entropy observation pool of realistic size before Pi
starts. A long-lived machine had a 1.95 MB mesh `state.json` and a 33.6 MB
`observation-pool.json`. With the small files of a fresh fixture, both costs
below stay hidden.

## What the profiles showed

The TypeScript guest compiler was a small steady cost: about 13 ms per
`fabric_exec` once warm. Its first use still blocks for about 0.5 s while the
compiler and the first program load.

Two costs scaled with the machine's accumulated state.

1. **Mesh presence, once per nested call.** `PiToolsProvider` emits
   `tool_execution_end` for each nested call. Fabric's handler notes main
   activity, which schedules a participant refresh. Each refresh rewrote the
   root record (its `updatedAt` always differs), the legacy session record
   and the host lease: three locked, synchronous read-parse-serialize-rename
   cycles of the whole project mesh state, per nested call. A turn with 24
   nested calls made 75 such rewrites; 60 calls made 183. Every other Pi
   session in the project then re-read the changed file.
2. **Entropy observation pool, once per `fabric_exec` turn.** After a turn
   with `fabric_exec`, the entropy compile merged the session's observations
   into the machine-wide pool: parse the whole pool, merge, serialize it,
   read the old file back to compare, then serialize it again to write. With
   a 33.6 MB pool, the parse alone took 88 ms and each pretty-printed
   serialization 75 ms on an idle process, all on Pi's main thread, with
   about 170 MB of short-lived heap.

A third, smaller cost came from bounding the persisted `fabric_exec` details
to 512 KiB: the bound re-serialized the whole record after dropping each
audit, which is quadratic in the size of a large run's results.

## Changes

- `ParticipantDirectory` distinguishes a renewal (`refresh()`, the heartbeat
  and startup) from an event refresh (`scheduleRefresh()`). An event refresh
  writes only records whose content changed apart from `updatedAt`, and
  leaves the lease to the heartbeat. Any refresh renews once the last renewal
  is a heartbeat old, so timestamps and leases are never older than before.
  A status change (idle to running, queued messages) still publishes at once.
- The observation-pool update runs on a worker thread
  (`src/entropy/pool-writer.ts`). The main thread keeps the cooperative,
  identity-cached per-window summaries and sends only those. The worker takes
  the cross-process lock, rebases on the latest pool, and writes the bytes it
  compared, serializing once. If a worker cannot start, the update runs in
  process as before. The worker runs the existing lazy entropy entry, so the
  startup graph is unchanged.
- Presence reads list legacy actor states only under a live legacy root's
  `actors/<sessionId>/` prefix, with the same order and result. Listing all of
  `actors/` deep-cloned every actor state in the project on each refresh,
  which became the largest remaining cost once the writes were gone.
- The locked pool rewrite compares against the text it already read, so the
  pool is read once per update.
- `createFabricPersistedExecutionDetails` drops oversized members with a
  running byte estimate and confirms each stop with one real measurement. Its
  output is identical to measuring after every drop.

## Results

Linux pseudo-terminal, Pi 1.5.0, 30 turns of 24 nested calls, seeded with a
2.2 MB mesh state and a 21 MB pool. Before and after alternated in one batch
on the same exclusive VM; medians per turn of two runs each:

| | before | after |
|---|---|---|
| CPU per turn, all threads | 1,483 and 1,095 ms | 245 and 238 ms |
| wall time per turn | 1,399 and 1,046 ms | 189 and 177 ms |
| worst event-loop stall per turn | 270 and 203 ms | 18 and 17 ms |
| worst stall in the run | 459 and 244 ms | 33 and 26 ms |
| GC per turn | 43 and 30 ms | 3.5 and 3.9 ms |
| mesh state rewrites per turn | 78 and 75 | 0 |

The first `fabric_exec` stall (451 to 501 ms) is unchanged. Raw rows are in
`docs/benchmarks/interactivity-2026-11-09.json`.

## Remaining

- The first `fabric_exec` of a session still blocks for about 0.5 s while the
  TypeScript compiler loads.
- The heartbeat still renews every 5 s with three locked rewrites of the mesh
  state (root record, legacy session record, lease). Idle CPU is close to the
  core-only control.
- Each nested call still emits `tool_execution_end` to every extension, by
  design, so other extensions' handlers run per nested call.
