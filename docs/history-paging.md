# Historical payload paging and cancellation

Fabric can release Pi core's strong references to **inactive historical message
payloads** without deleting session history or creating a replacement session.
`memory.pageHistory` defaults to `true` and is independent of the memory-search
index's `enabled` setting. Set it to `false` in `fabric.json` to opt out before
loading a session.

## What changes

At a real turn boundary or committed compaction, Fabric consults core's
`buildContextEntries()` and leaves every active-context entry untouched. Inactive
message fields of at least 16 KiB (such as content, output and details) are
serialized to a private temporary archive. Only those bulky fields become
synchronous read-through accessors backed by weak references. Entry and message
objects, plus ordinary role/usage/timestamp metadata, stay resident and keep their
identities. TPS and accounting can inspect metadata without hydrating the body.
Once no reader retains a payload, GC can release it; a later field read hydrates
the same JSON value. Object-valued fields retain identity while a reader holds them.

Entry identities, IDs, parents, labels, custom extension records and the original
session JSONL are unchanged. Consumers which cache entry arrays (such as
`pi-tps`) still hold the very same entries. Tree navigation, copying a historical
message and serialization continue to read through the normal APIs. A consumer
which independently retains the **content array or another paged payload** can
still keep it alive; retaining just the entry/message metadata does not. Fabric
cannot revoke another extension's references.

The code is loaded lazily at actual first use, not at registration or idle boot.
Paging yields between groups of entries and stops on cancellation, navigation,
session replacement or shutdown. Existing historical accessors installed by
other extensions are not replaced. Unsupported host adapters are skipped.

## Compatibility and storage limits

- This relies on Pi's append-only historical-entry convention. **In-place nested
  mutation of an inactive historical message is unsupported**: after collection,
  hydration restores its archived JSON snapshot. Whole-message assignment remains
  supported. Extensions which edit old message objects should disable paging.
- Paged objects are JSON snapshots, not cross-GC identity guarantees. Non-JSON payloads
  which fail serialization stay in memory. Small payloads and custom entries also
  remain resident. Metadata and active context are not bounded by this feature.
- Archives use a private temporary directory and a mode-0600 file. They are kept
  until their entries are collected so a retained entry is still readable after
  a session switch or extension reload. Normal process exit removes archives;
  a crash may leave temporary files for the OS/user to clean up. They contain
  conversation data, like the original session logs.
- History browsing, export or other consumers can hydrate many messages again.
  Those payloads become collectible after readers let go. This does not promise
  low peak memory while opening an existing large session, nor immediate RSS
  reduction after collection.
- Actor observation now uses core's active-context projection, including
  compaction and branch summaries. It no longer reads the entire historical
  branch on each streaming event.

## Abort responsiveness

Aborted `agent_start`, `turn_end`, `agent_end` and `agent_settled` hooks no longer wait for mesh
lifecycle publication. The lifecycle broker still serializes those writes and
owns their shutdown drain. Errors from detached writes are handled. Completed
run boundaries retain their existing awaited publication order.

Actor observation and tool-error analysis are skipped for already-aborted
contexts. This removes two Fabric-side stalls: an awaited mesh lock (whose
configured timeout is 10 seconds), and scanning historical payloads when an abort
is already in progress. It does not change provider cancellation, child-process
termination grace periods, or other extensions' hooks; a live profile is still
needed to attribute any remaining lag.

## Verified results (2026-11-09)

A fresh Linux process on the remote fallback passed 104 targeted tests across
nine files, typechecking, the full build and the lazy-graph assertion.

| Scenario | After compaction | After paging / next Fabric turn |
| --- | ---: | ---: |
| Core manager, 600 MiB history | 635.93 MiB heap | 51.91 MiB heap |
| Real SDK + compiled Fabric, 256 MiB history | 318.43 MiB heap | 100.53 MiB heap |

The manager probe confirmed that all 19,090 retired content arrays were
collectible, verified an exact cold read, and verified the original session
file hash was unchanged. The SDK probe completed three Fabric executions across
the original session and two replacements without extension errors.

RSS remained high. The manager correctness probe also reads the complete source
file to hash it, so its peak RSS is not a pager-only measurement. See the
[raw measurements](benchmarks/session-memory-fix-2026-11-09.json) for full memory
columns and limitations. These tests do not measure live macOS abort latency.

## Verification

Targeted tests cover historical JSON and entry identity, active-context
protection, navigation, labels, custom state, unchanged source files,
cooperative cancellation, foreign accessors, and lifecycle publication ordering.
The isolated `scripts/benchmark-session-memory.mjs --mode paged` case additionally
forces GC and asserts that retired content arrays are gone, then reads a cold
payload back and verifies it. The `fabric` case exercises the compiled extension
through the real SDK with an offline provider. See
[the investigation](session-memory-investigation.md) for baseline measurements.
