# Small-session resume latency investigation

## What was reproduced

Measured on 2026-11-09 with the real Pi 1.5.0 SDK and compiled Fabric, on a
supercomputer `large` boat VM: AMD Ryzen 9 9950X, four pinned vCPUs of eight,
exclusive placement, no co-tenants. Each profile runs in a fresh Node 24.22.1
process. The two synthetic session files contain four short user messages each.
No personal histories, authentication files, or live model requests are used.
The full-stack replica contains the user's 25 other extension packages, their
public model catalogs, and Fabric in the configured order (27 file entrypoints;
28 loaded factories including the offline test provider).

| Scenario | Three subsequent session switches |
| --- | --- |
| Core plus offline test provider | 8.32 / 11.80 / 12.22 ms |
| Fabric, not yet activated by a tool call | 28.60 / 17.26 / 15.52 ms |
| Fabric after executing `fabric_exec` | 283.69 / 274.01 / 271.70 ms |
| Fabric defaults after executing `fabric_exec` | 313.94 / 288.09 / 312.03 ms |
| Full extension stack, same cwd | 83.78 / 74.63 / 78.50 ms |
| Full extension stack, alternating cwd | 386.53 / 329.04 / 276.46 ms |

Reading the small session files took 0.10–0.19 ms. This does not explain a
multi-second pause. The activated-Fabric cases spend 252–294 ms in the Fabric
`session_shutdown` hook; that is a real smaller contribution, not a reproduced
5–10 second delay. The individual closer responsible has not been isolated.

The first full-stack runtime creation took **3957.53 ms**, of which
**3721.43 ms** was resource/extension loading and **117.76 ms** was extension
binding. A following fresh-process profile on the same VM, with warmed disk and
transpile caches, created the initial full-stack runtime in **918.17 ms**.
These are separate cache conditions, not repeat samples of one distribution.
Core import precedes these runtime-creation measurements and is recorded
separately in the evidence. No millisecond threshold is used as a test gate.

### Where the first full-stack load spent time

Pi's loader timing deltas, including module import/compilation/transpilation:

| Entry | Import | Factory |
| --- | ---: | ---: |
| pi-better-openai | 640 ms | 2 ms |
| pi-multiprovider | 374 ms | 2 ms |
| Fabric | 25 ms | 301 ms |
| pi-queue-steer | 221 ms | 2 ms |
| pi-math | 214 ms | 8 ms |
| pi-better-grok | 191 ms | 1 ms |
| pi-neuralwatt-provider main entry | 181 ms | 1 ms |

These are observations of this ordered stack, not clean independent package
benchmarks: shared dependencies and loader cache state affect attribution.
They do show that the expensive work happens before most `session_start` hooks.

## Why session size can be irrelevant

`AgentSessionRuntime.switchSession()` does more than load JSONL: it tears down
the previous runtime and constructs/binds a replacement. Resource loading
therefore occurs even for a four-message session.

Pi's `loadExtensionsCached()` caches module factories, not initialized extension
instances. `useExtensionCacheCwd()` invalidates that module cache when cwd
changes. Same-cwd replacements still run factories; cross-cwd replacements
also import the modules again. In the full-stack profiles, resource reload was
7.95–8.86 ms within one cwd and 180.10–254.13 ms across cwd changes. This is a
verified extra cost, but still not a reproduced multi-second warm switch.

History paging begins at `agent_start` or after compaction, not while reading
these files. There was no large inactive payload to page in this experiment.
It is not the explanation for the measured initial extension-loading cost.

## What is not established

This was an isolated **SDK/headless** profile, not a recording of the user's
macOS TUI. It excludes terminal rendering, real provider credentials and network
behavior, real global/project settings, resource discovery over the user's
filesystem, and interaction with the resume picker. `hasUI`/TUI-only behavior is
not represented. The full-stack cases did not warm Fabric through a tool call;
those costs were measured separately and are not claimed to be additive.

A 5–10 second pause **after selecting a session in an already-running Pi** has
not been reproduced. Cold extension loading is a demonstrated seconds-scale
cost; it must not be presented as complete attribution of that warm pause.
Distinguish opening the picker, choosing an item, and waiting for the first
model response before optimizing the wrong phase.

## Follow-up: `pi --session …` and a visible startup screen

The user clarified that this is a fresh CLI launch with `--session`, rather
than an in-process session switch. The earlier warm-switch measurements are
not a reproduction of that path. In particular, multi-second extension imports
happen **before** the TUI is constructed, so that number alone cannot explain
a pause after a startup screen is already visible.

Reading the installed 1.5.0 bundled CLI and its corresponding sources shows:

1. The session is selected/opened and extensions imported before constructing
   `InteractiveMode`.
2. `init()` starts the terminal UI, waits for terminal colors (bounded by about
   100 ms), then ensures `fd`/`rg` and binds extensions in TUI mode.
3. Binding awaits `session_start` and resource-discovery handlers. It then adds
   loaded-resource information and startup notices.
4. The initial transcript is constructed and `renderNow()` paints it.
5. The normal background model-catalog refresh starts only after `init()`.
   `updateAvailableProviderCount()` itself reads an existing snapshot; it does
   not initiate a network refresh.

A real changelog is suppressed if `session.state.messages.length > 0`. A
visible **release-notes** screen for a populated session is therefore a useful
anomaly to investigate, not grounds for assuming a network timeout. The
startup header/resource list is a different visible milestone.

`scripts/benchmark-cli-resume.mjs` now tests the actual bundled CLI under a
Linux pseudo-terminal, with both four-message and empty-session controls.
The buffered-tracer run completed all three cases on the same exclusive boat VM:

| Bundled CLI case | Before TUI construction | `init()` duration | First restored transcript write |
| --- | ---: | ---: | ---: |
| Core, four messages | 269 ms | 127 ms | 396 ms from preload |
| Full stack, four messages | 6,106 ms | 387 ms | 6,491 ms from preload |
| Full stack, empty session | 1,012 ms | 534 ms | Not applicable |

These are individual samples with different cache states, not a latency
threshold or an isolated comparison of per-package costs. The full-stack
resumed case spent 245 ms binding TUI extensions and 1.11 ms constructing the
initial transcript. Both populated cases reported `coreChangelog: false` and
no extension changelogs; the empty control reported `coreChangelog: true`.
The seconds-scale pre-TUI time is real, but does not prove the cause of a
seconds-long pause **after a newly painted banner** on the user's Mac. A
terminal write is also not proof of when the terminal application painted it.
The successful trace and placement receipt are saved in
`docs/benchmarks/cli-resume-2026-11-09.json`. Per-hook disk writes were removed
before this final run to avoid perturbing the measured path.

It uses the same tracer that can be enabled for a user's real launch:

```sh
PI_RESUME_TRACE=/tmp/pi-resume-startup.json \
node --import /path/to/pi-fabric/scripts/trace-cli-startup.mjs \
  "$(command -v pi)" --session YOUR_EXISTING_SESSION_ARGUMENT
```

Run from the **same cwd** as the usual command, using the same session argument.
Node 24+ is required. No `PI_OFFLINE` or benchmark flag should be set for this
real-launch trace: the normal session should remain open and behave normally.

The opt-in tracer patches only the current process in memory. It does not
modify the installed package, global settings, or session history. It records
phase/hook names, extension paths, elapsed times, and loaded-message counts,
not conversation text or credentials. It buffers at most 2,000 records, writes
the trace at initialization completion (or process exit), then stops collecting.
The specified output file is replaced. This is diagnostic instrumentation, not
a production startup fix; it must not be enabled globally through NODE_OPTIONS.

## Next changes worth testing

1. Defer optional UI/renderer/controller dependency graphs in the heaviest
   extensions until the feature is used. Factory time alone is not the budget:
   import/compilation is the larger part here.
2. Investigate preserving cwd-independent module factories in Pi's loader while
   still creating fresh per-session extension state. Do not reuse mutable
   extension instances or blindly keep cwd-dependent modules.
3. Isolate the warmed Fabric shutdown closer before changing cleanup semantics.
4. If the reported problem is a warm in-TUI switch, collect that exact path with
   the user's settings/provider state. Do not infer a network timeout or blame
   the fast-resume picker from these headless measurements.

## Trace from the user's actual launch

The user ran the tracer against this session on macOS. The trace contained 140
loaded messages and 34 extensions, and finished initialization at 8,829 ms:

| Phase | Time |
| --- | ---: |
| Before constructing the TUI | 5,353 ms |
| Binding startup hooks and resources | 2,464 ms |
| Fabric's first `session_start` hook (inside binding) | 1,561 ms |
| multiprovider's `session_start` hook (inside binding) | 501 ms |
| Constructing transcript components | 463 ms |
| Initial terminal render | 410 ms |

The two startup model-refresh operations overlap other startup work; their
elapsed times must **not** be added to these totals. The session was loaded
correctly, and neither core nor extension changelogs were eligible. These are
one traced launch's observations, not a before/after benchmark.

### First-use MCP initialization

Actor recovery can activate the full Fabric runtime before the first tool call.
Registering its built-in MCP provider also called `warmup()`, which hydrates the
descriptor cache and, on a cache miss/configuration change, imports mcporter and
resolves configurations. Although not awaited directly, that module evaluation
competes on the main thread while startup hooks are awaited. Backgrounding an
import does not make its CPU work free.

Built-in registration no longer starts this work. MCP remains registered, and
its existing first `list`/`describe`/`invoke` path hydrates the cache and performs
normal discovery. An actor that requires MCP can still initialize it
through capability resolution. This does not postpone actor recovery, change
provider authorization, or disable MCP. The mount/first-use regression is in
`tests/mcp-lazy-import.test.ts`; existing cached/live/native-provider tests cover
the provider's subsequent behavior.

This change addresses one eager-startup path. It does **not** claim to fix the
5.35-second pre-TUI extension load, the other extensions' hooks, or Pi's initial
transcript rendering. A second real launch on the user's Mac is needed to
establish the end-to-end improvement there.

The CLI fixture's `--eager-actors` case now enables MCP as well as restoring an
idle actor. The original fixture disabled MCP and therefore missed this path.

The final exclusive-VM run passed all 78 tests in the eight selected suites,
whole-program typechecking, the host-free lazy-graph assertion, and the final
build. All 12 synthetic CLI launches completed. The two first-use warm launches
spent 316 and 393 ms in Fabric's startup hook; the final eager warm control took
377 ms. These overlap: this small run does **not** establish a consistent latency
improvement. In particular, the first eager launch (8.42 s total) must not be
compared with subsequent warmed first-use launches (1.76–1.84 s) as a claimed
speedup. The structural regression verifies removal of unwanted startup work;
end-to-end improvement on the user's Mac remains unmeasured. Full synthetic
records and placement are in
`docs/benchmarks/resume-startup-fix-2026-11-09.json`.

## Reproducing the controls

Run on a prepared remote checkout, never the laptop for timing claims:

```sh
bun install --frozen-lockfile
bun run build
node scripts/benchmark-resume-latency.mjs --variant core --cycles 3
node scripts/benchmark-resume-latency.mjs --variant fabric --cycles 3
node scripts/benchmark-resume-latency.mjs --variant fabric --warm --cycles 3
node scripts/benchmark-resume-latency.mjs --variant fabric-default --warm --cycles 3
```

For the full stack, supply a JSON array of absolute extension package/file
paths, with the correct order and installed dependencies:

```sh
node scripts/benchmark-resume-latency.mjs --variant stack --extensions-file paths.json --cycles 3
node scripts/benchmark-resume-latency.mjs --variant stack --extensions-file paths.json --cross-cwd --cycles 3
```

The benchmark asserts extension loading, completed switches, and successful
Fabric execution in warmed cases. `completed: true` marks successful current
probe runs. A failure's partial timing record is not a passed profile. Timings
are nested/inclusive; do not sum overlapping `model.refresh` and parent spans.
Raw successful phase records, loader timing groups, and placement receipts are
in `docs/benchmarks/resume-latency-2026-11-09.json`.
