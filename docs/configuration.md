# Configuration

Pi Fabric reads configuration from two JSON files. Project values override global values.

1. `~/.pi/agent/fabric.json`: global defaults.
2. `<project>/.pi/fabric.json`: project overrides, only for **trusted** projects.

`/fabric settings` opens at project scope in trusted projects and at global scope in untrusted sessions. In a trusted project, press **Ctrl+G** anywhere in the settings view to move both the displayed values and the save destination between `<project>/.pi/fabric.json` and the global `~/.pi/agent/fabric.json`. The global view shows global defaults even when a project override stays effective in the current session, and the scope banner marks that precedence. Both views show persisted values. The affected setting notes when a runtime-only environment override still controls the live session. Untrusted sessions remain global-only. RPC hosts expose the same nested settings through standard select/input dialogs and provide a root save-scope action, so no terminal keybinding is required.

`configVersion` versions each configuration document. Fabric migrates each applicable file independently before it applies global/project precedence, then rewrites migrated files atomically. Version 0, the historical unversioned format, renames `subagents` to `agents`. Versions 2 and 3 rename legacy UI settings. Version 4 repairs `prewalk.enabled` string booleans emitted by the settings UI in affected builds. When both legacy and canonical sections exist, canonical values win conflicts and non-conflicting values survive. Fabric migrates trusted project files, and it never reads or rewrites untrusted project files. Add future schema changes as sequential migrations. Avoid runtime aliases.

## Execution kernels

`executor.kernel` selects the exclusive language for every `fabric_exec` call: `"typescript"` (default) or `"python"`. There is no per-call kernel selector or automatic language switching. Selecting Python is explicit opt-in; no additional enabled flag is required. `executor.pythonRuntime` defaults to `"monty"`, a sandboxed Python subset with VM-enforced resource limits and no ambient OS access. Monty is not CPython and cannot import arbitrary libraries; use the host bridge for I/O. Missing or invalid backend values choose Monty, and missing native Monty dependencies fail loudly without falling back. Set `executor.pythonRuntime: "cpython"` explicitly for the trusted native escape hatch, analogous to TypeScript's Node/Bun backends. `executor.cpython.binary` defaults to `"python3"` and accepts a CPython **3.10+** executable name or path, not shell arguments. Invalid kernel values fall back to TypeScript; absent, blank, or non-string binaries fall back to `python3`.

Set Python globally in `~/.pi/agent/fabric.json` or for one trusted project in `<project>/.pi/fabric.json`:

```json
{
  "executor": {
    "kernel": "python",
    "pythonRuntime": "monty"
  }
}
```

The same controls are under `/fabric settings` → **Executor** → **Kernel** / **Python runtime** / **CPython binary**. Python programs are async function bodies with `await` and `return`; host calls use the same namespaces and authoritative schema validation, without the static TypeScript check. See [execution kernels](kernels.md) for Python syntax, native dictionary results, payloads, parallel calls, and current guest-helper limitations. All `ts` code blocks and JavaScript-style call examples below are **TypeScript-only**.

`executor.runtime` affects **TypeScript only** (the **Runtime (TS)** setting); Python ignores it. It selects `"quickjs"` (the default isolated WASM runtime), `"node-process"` (a disposable native V8 process), or `"bun-process"` (a disposable native Bun/JavaScriptCore process). QuickJS memory limits stop at `4294967295` bytes, because its WASM32 `size_t` cannot represent 4 GiB. Fabric rejects larger values. It never wraps them. Node process limits can reach the detected physical memory, and Fabric passes them to V8 as `--max-old-space-size`. Bun process limits reach the same ceiling, but Bun ignores V8 heap flags, so the value is advisory, never an enforced cap.

Treat `node-process` and `bun-process` as an explicit escape hatch for trusted code. It offers no security sandbox. The runtime keeps Fabric's IPC host bridge, approvals, audit records, timeout, and cancellation in place. Node's and Bun's `vm` APIs provide no security boundary. Enable it only for workloads and projects whose generated code you accept running with the local user account's authority. Each invocation starts a fresh child process, and Fabric forcibly terminates that process when it settles, times out, or is cancelled. For TypeScript, schema enforce mode forces `quickjs`. Large limits in native runtimes can exhaust system memory or destabilize the machine.

Monty is always sandboxed, including under schema enforce, and does not require an installed CPython interpreter. Full CPython is an explicit trusted-native escape hatch with full local-user OS privileges outside schema enforce. Host approvals and audit cover bridge calls, not direct Python OS access. **Schema enforce preserves Python**; explicit CPython requires macOS `sandbox-exec` or Linux `bwrap` isolation; execution fails closed when isolation is unavailable, without falling back to unrestricted Python or TypeScript. `executor.memoryLimitBytes` uses `RLIMIT_AS` where the OS supports it, with a configuration ceiling of detected physical memory, not WASM32. This is an address-space limit, not a portable hard resident-memory cap. Process limits, timeouts, and cancellation are not a security sandbox; see [kernel isolation](kernels.md#isolation-and-resource-limits).

### Native Pi codemode API

`executor.codemodeProfile` is `"additive"` by default: existing Fabric APIs stay unchanged, while `nativeTools` and nonconflicting `tools.<name>` methods provide native Pi tool results. Set `"native"` for unmodified Pi JavaScript examples: `tools` and the discovery globals use native semantics, while `fabric.tools` retains Fabric discovery. Both profiles preserve `pi.*`, `mcp.*`, `extensions.*`, approvals and sPTC safety. The setting is TypeScript-kernel-only; Python ignores it. See [native codemode compatibility](codemode-parity.md) for collisions, result contracts, images and state interoperability. The UI setting is **Executor → Codemode API (TS)**.

### Executor timeouts and ceilings

`executor.timeoutMs` (default `120000`) bounds a whole `fabric_exec` program. Two mechanisms can raise it:

- **Per-invocation request**: `fabric_exec({ timeoutMs: 600000, code: ... })` asks for a longer whole-program deadline for that one call. It can never reduce the default: the effective timeout is `max(executor.timeoutMs, requested)`.
- **Per-ref floor**: `executor.hostCallTimeouts` maps exact host-call refs (no wildcards) to a minimum deadline in ms. A matching ref raises the enclosing deadline to at least the configured value without any tool-side timeout argument:

```json
{
  "executor": {
    "timeoutMs": 120000,
    "maxTimeoutMs": 3600000,
    "hostCallTimeouts": {
      "extensions.subagent": 3600000
    }
  }
}
```

Every raised deadline is capped by `executor.maxTimeoutMs` (default `900000`, i.e. 15 minutes: the former undocumented clamp, now explicit), which itself can be raised up to the hard implementation maximum of 24 hours. Values above a cap are visibly normalized down to the cap during config load and the effective values are shown in `/fabric` settings, never silently surprising. A per-invocation request or ref floor takes effect even when the ref is unknown to Fabric, so captured tools, MCP calls, and future host calls all run within an intentionally longer deadline without Fabric knowing their argument semantics. Existing `pi.bash` behavior (extending the deadline from an explicit `timeout` argument) is unchanged, and deadline expiry still cancels the active host call and any child process it owns.

`executor.humanWaitRefs` (default `["extensions.ask"]`) lists exact host-call refs (no wildcards) that wait for a person. While at least one such call is in flight, the program deadline is **paused**: a foreground question can wait as long as the person needs. When the last one settles, the program continues with the budget it had left, so guest work before and after the wait still counts. A host-call floor that arrives during the pause raises that remaining budget. Cancelling `fabric_exec` (Esc or an aborted signal) still stops the program and the pending call at once, and CPU-slice and memory limits are unchanged. Set `[]` to bound human waits by the normal deadline again:

```json
{
  "executor": {
    "humanWaitRefs": ["extensions.ask"]
  }
}
```

`executor.shellHangMs` (default `120000` / 2 minutes, max `600000` / 10 minutes, `0` disables) is a nested-shell wait budget, not a program deadline. When a `pi.bash` / `pi.powershell` await exceeds it, Fabric **settles the await successfully** (`ok: true`) with a still-running notice, pid, and live output path while the process keeps writing that file. `background: true` (alias `run_in_background`) detaches immediately with the same envelope. Inspect with `pi.read(logPath)` and stop by running `kill <pid>` through `pi.bash`. Do not poll. An explicit shell `timeout` remains a hard cap. **ctrl+b twice** spills early (tmux-safe); **ctrl+k** kills the waiting command. Session shutdown aborts leftover processes, except `durable: true` tasks, which detach to their jev-fabric store. Captured shell overrides normally keep their own execution semantics; an extension can opt into [Fabric-owned bash execution with middleware](shell-middleware.md) to preserve its environment/output filters while gaining the same background handling.

`executor.jevFabric` configures the optional jev-fabric backend for [durable tasks](background-tasks.md#durable-tasks-through-jev-fabric) and [interactive sessions](shell-composition.md). `binary` (default `""`, also `"auto"`) picks your compatible install outside the workspace, then the bundled package; an explicit executable name or trusted absolute path (no shell arguments) is used or the call fails, never falling back. See [which jev-fabric](shell-composition.md#which-jev-fabric). `home` empty uses `JEV_FABRIC_HOME`, else `<cwd>/.jev-fabric-native`: the store other harnesses in the same project share by default. `timeoutMs` (default one hour, up to 24 hours) is a durable job's lifetime when the call gives no explicit `timeout`. Nothing runs or loads until the first `durable: true` call.

The precedence across all sources is:

```text
effective timeout = min(
  maxTimeoutMs,
  max(executor.timeoutMs, matching hostCallTimeouts[ref], fabric_exec.timeoutMs)
)
```

where absent values do not participate, and time spent inside a `humanWaitRefs` call is not counted. Orchestration programs (`agents.run` / `agents.wait` / `agents.ask`, `workflow.agent`, ...) keep their separate `agents.timeoutMs` floor, which is unaffected by `executor.maxTimeoutMs`.

## Full reference

```json
{
  "configVersion": 4,
  "fullCodeMode": true,
  "executor": {
    "kernel": "typescript",
    "cpython": { "binary": "python3" },
    "jevFabric": { "binary": "jev-fabric", "home": "", "timeoutMs": 3600000 },
    "runtime": "quickjs",
    "timeoutMs": 120000,
    "maxTimeoutMs": 900000,
    "hostCallTimeouts": {},
    "humanWaitRefs": ["extensions.ask"],
    "shellHangMs": 120000,
    "memoryLimitBytes": 67108864,
    "maxOutputChars": 100000,
    "maxNestedResultChars": 2000000,
    "resultFormat": "auto"
  },
  "approvals": {
    "read": "allow",
    "write": "allow",
    "execute": "allow",
    "network": "allow",
    "agent": "allow",
    "headless": "deny",
    "headlessTimeoutMs": 300000
  },
  "capture": {
    "enabled": true,
    "hideFromModel": true,
    "keepVisible": ["fabric_exec"],
    "defaultRisk": "execute",
    "risks": {
      "read": "read",
      "grep": "read",
      "find": "read",
      "ls": "read",
      "edit": "write",
      "write": "write",
      "bash": "execute",
      "fovea_sketch": "read",
      "fovea_focus": "read",
      "fovea_dwell": "read",
      "fovea_impact": "read"
    }
  },
  "foreground": {
    "tools": [],
    "maxTools": 4
  },
  "mcp": {
    "enabled": true,
    "disableOAuth": true,
    "allowDynamicServers": true,
    "callTimeoutMs": 120000,
    "cache": {
      "enabled": true,
      "revalidate": "changed",
      "revalidateBudgetMs": 60000
    }
  },
  "prewalk": {
    "enabled": true,
    "mode": "in-place",
    "alwaysRearm": false,
    "detectShellWrites": true
  },
  "models": {
    "aliases": {
      "cheap": "google/gemini-2.5-flash",
      "budget": ["openai/gpt-5-mini", "google/gemini-2.5-flash"]
    }
  },
  "agents": {
    "enabled": true,
    "runner": "pi-durable",
    "transport": "process",
    "claude": {
      "binary": "claude"
    },
    "veda": {
      "binary": "veda",
      "backend": "agy",
      "persona": "navigator-chat"
    },
    "thinking": "medium",
    "maxConcurrent": 4,
    "maxPerExecution": 100,
    "maxDepth": 2,
    "timeoutMs": 86400000,
    "extensions": true,
    "defaultTools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
    "retainRuns": false,
    "notifyOnComplete": true,
    "budgetUsd": 0,
    "maxTokensPerChild": 0,
    "sessionExport": true,
    "sessionExportDir": "",
    "childQuestions": "cancel",
    "childQuestionTimeoutMs": 600000
  },
  "components": [
    {
      "id": "project-service",
      "component": "registered-definition",
      "config": {},
      "disabled": false
    }
  ],
  "ui": {
    "enabled": true,
    "widget": "auto",
    "maxRows": 6,
    "refreshMs": 500,
    "eventHistory": 80,
    "haltOnEscape": true,
    "showAgentToolPreview": true,
    "toolDisplay": "compact",
    "updateDebounceMs": 100
  },
  "compaction": {
    "engine": "fabric",
    "outputReserveTokens": 0,
    "pressureBands": { "warn": 0.6, "urgent": 0.8 },
    "repairOrphans": true
  },
  "retention": {
    "orphanedTempRunMs": 21600000,
    "oneShotRunMs": 86400000,
    "actorRunArchiveMs": 604800000
  },
  "mesh": {
    "enabled": true,
    "actorScope": "project",
    "maxEventBytes": 262144,
    "maxReadEvents": 500,
    "actorPollMs": 250,
    "actorQueueLimit": 32,
    "eventContextChars": 40000
  },
  "memory": {
    "enabled": true,
    "sources": [
      { "id": "laptop", "kind": "fs", "root": "/home/me/pi-archive" }
    ]
  },
  "trace": {
    "assessment": false
  }
}
```

## Jev System One

`jev` configures TypeSafe typed judgments and session-owned foreground/background programs. It is enabled by default but makes no inference requests until called. `/login jev` stores API-key credentials through Pi; `TYPESAFE_API_KEY` and an explicitly configured `jev.credentialCommand` argv are also supported. Bare `jev.model` aliases use TypeSafe; `typesafe/...` or `~typesafe/...` model IDs use OpenRouter's decisions endpoint with the existing `openrouter` credential (`/login openrouter`, `OPENROUTER_API_KEY`, or `TYPESAFE_OPENROUTER_API_KEY`); `typesafe-ai/...` model IDs use Vercel AI Gateway's TypeSafe-compatible endpoint with the existing `vercel-ai-gateway` credential (`/login vercel-ai-gateway` or `AI_GATEWAY_API_KEY`). Never store the resolved secret in `fabric.json`.

Host ceilings include `maxDurationMs`, `maxEvaluations`, `maxToolCalls`, `maxTokens`, `maxConcurrentRuns`, and `maxRetainedRuns`. Request controls are `model`, `requestTimeoutMs`, and `maxRequestBytes`. Per-program limits cannot raise these ceilings. Per-program `maxEvaluations: 0` disables program inference for deterministic shell orchestration. See [Jev programs](jev.md) for typed decisions, shell/task composition, and cancellation; harness CLIs need no component configuration. Jev is unavailable in Schema enforce and managed-host modes.

## Lossless decision profiles

`jev.decisionProfiles` is a portable `{version:1, defaultProfile?, profiles}`
document; global/project precedence replaces it atomically and never merges
fields from different providers. `jev.decisionProfile` optionally selects one
of its names. `null` restores the document default and can clear an inherited
global selector; an empty or unknown name is invalid.

In `/fabric settings` → **Decisions**, select a configured profile or
**Document default**. This updates defaults for future direct calls/new programs
without reloading approval policy. Already-running programs retain their
captured selection and all calls retain their existing budgets. This setting
never changes Main's chat model or `approvals.model`.

See [lossless decision models](jev-decisions.md) for configuration examples,
capability discovery, native binary requirements and credential boundaries.

## Components

`components` is a root array of declarative supervised instances. Each `id` gives one instance a stable identity, and `component` names its definition in the versioned protocol. Fabric passes `config` to `activate(context, config)`. The `disabled` field removes an instance from the active graph and preserves its declaration. An empty array is the default, with a limit of 256 valid entries. The runtime installs enabled first-party providers as pinned `fabric.provider.*` components whose reserved IDs sit outside this array.

Unknown definitions stay visible as waiting. They do not fail the Fabric runtime. Late discovery activates them. Once the runtime is active, trusted file edits reconcile automatically without `/fabric reload`; idle bootstrap remains lazy and first use rereads the component configuration. Invalid live edits keep the last working state and are never repaired or renamed by the watcher. `components.describe`, `components.plan`, `components.apply`, and `components.reconcile` provide the same control plane to programs. Changes default to session scope; global/project persistence is explicit, and untrusted project writes are rejected, never redirected. Project component arrays replace global arrays; session overrides apply by ID on top. Definitions may declare `configSchema` for pre-activation validation. When a definition re-registers with `overwrite: true`, Fabric uses the same rollback-capable replacement path. See [components, effects, and committed capabilities](components.md#live-configuration-control).

## Speculation

`speculation` configures opportunistic pre-launch of read-class calls while the model streams a `fabric_exec` program; see [speculative PTC](speculation.md) for the correctness contract. `speculation.enabled` (default `true`) masters the feature. `speculation.maxConcurrent` (1-32, default 4) caps in-flight speculative calls. `speculation.maxEntries` (1-1024, default 64) bounds retained unserved entries per turn. `speculation.maxBufferBytes` (64 KiB-64 MiB, default 2 MiB) caps the per-stream partial-argument buffer. `speculation.entryTtlMs` (5 s-30 min, default 180000) expires unserved entries. `speculation.mcpAllowlist` (default empty) enables Tier-B speculation of read-only MCP tools with `server.tool` or `server.*` patterns.

## Thinking bounds

`thinking.bounds` (`{"min"?: level, "max"?: level}`, default `{}`) bounds every thinking level Fabric selects: [`thinking.set`](thinking.md), each child run's `thinking`, and the bounds a child inherits. Levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. An omitted end leaves that side to the active model's supported levels. Unknown keys, unknown level names, and `min` above `max` fail configuration loading. A Fabric child intersects this value with its parent's `PI_FABRIC_THINKING_BOUNDS` and never widens it.

```json
{ "thinking": { "bounds": { "min": "low", "max": "high" } } }
```

## Prewalk executor

`prewalk.enabled` defaults to `true` and is the persistent master switch. Turn it off under **Prewalk → Enabled** in `/fabric settings`, or run `/fabric prewalk --disable`; both save to project scope in a trusted project and global scope otherwise. Disabling also cancels any live arm. `/fabric prewalk --enable` turns it back on. `/fabric prewalk --off` only cancels the current arm for this session and does not change the saved master switch.

`prewalk.model` is the optional Pi `provider/model` that `/fabric prewalk` selects. `prewalk.mode` chooses how execution continues:

- `"in-place"` (default) switches Main to the executor model, queues a hidden follow-up in the same session, and restores Main's boundary model when the continuation settles, when a new session inherited the executor, or when prewalk is cancelled.
- `"trajectory"` forks the finalized outer Fabric call and result to a visible Pi child, then waits for it. After the child finishes, a hidden continuation asks Main to verify the work and report its findings.

```json
{
  "prewalk": {
    "enabled": true,
    "mode": "in-place",
    "model": "anthropic/claude-haiku-4-5",
    "thinking": "high",
    "alwaysRearm": true,
    "compactOnReturn": true
  }
}
```

`prewalk.thinking` sets the optional reasoning effort for the trajectory child executor. Its values are `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`, clamped to each model's supported levels. When you leave it unset, the executor inherits `agents.thinking`. In-place mode keeps Main's session level.

`prewalk.alwaysRearm` defaults to `false`. When enabled, prewalk returns to an armed, taskless state after each completed handoff (in-place return or trajectory completion); a failed in-place return drops the arm without completing it. Every Main session then starts armed automatically, non-interactively from `prewalk.model`, and `/fabric reload` re-arms Main as well. Child agents and actors never auto-arm from inherited settings; explicit arming is unaffected. `/fabric prewalk --off` cancels the armed state until the next session start or reload. Turns that settle without a handoff never disarm prewalk, regardless of this setting. The settings UI labels an unset model **Ask each time**. Non-interactive sessions must configure a model. In-place mode does not require child agents. Trajectory mode requires `agents.enabled`. It shows child spawn, progress, nested tools, metrics, and completion in Main's Fabric activity UI.

`prewalk.detectShellWrites` defaults to `true`. When armed, a `fabric_exec` boundary that ran a successful `pi.bash` or `pi.powershell` without an audited `pi.edit` / `pi.write` / `schema.commit` claims the handoff if file size or mtime stats drifted from the arm-time baseline. This routes shell heredocs and formatter binaries to the executor as well. The report's `trigger.files` lists the bounded drifted paths. An audited mutation consumes the shell-write drift window, so earlier edits cannot re-fire on a later read-only shell boundary. Fabric's own state directory never registers and does not consume the tracked-file cap. Other tool directories follow the project's ignore rules, so a Git work tree excludes them through `.gitignore`. Set this option to `false` to accept audited mutations only.

`prewalk.requirePlan` defaults to `true`. An armed task owes a recorded plan before its mutation boundary can hand off, whether the trigger is an audited `pi.edit` / `pi.write` / `schema.commit` or shell drift under `detectShellWrites`. A boundary reached without a plan is withheld: Fabric delivers a hidden plan checkpoint to Main that asks for `prewalk.plan({ outcome, steps, verification, risks })` inside `fabric_exec`. That recorded plan is the readiness signal: Fabric snapshots it at claim time and delivers it in the executor's hidden continuation or child task, so delivery does not depend on the outer tool result surviving. The arm stays armed across the checkpoint and the frontier model keeps working. Fabric asks at most twice per task, then hands off unplanned with a visible warning so an armed session cannot stall. A recorded plan survives a failed handoff that returns to armed, and Fabric drops it when the captured task changes; cancelling, re-arming, or reloading Fabric resets readiness so the next task plans again. Checkpoint delivery is a hidden custom message, never a system prompt. Set this option to `false` to hand off on the first mutation. `prewalk.status` inside `fabric_exec` reports `planRequired`, `planReady`, and the reminder count for the current session.

`prewalk.plan` is an executor handoff checkpoint, not a general task planner, checklist, or acceptance-ledger store. Maintain ordinary acceptance checks in reasoning or concise progress notes without a tool call. Submit a handoff plan only when Fabric's armed advisory or checkpoint requests it; no preliminary `prewalk.status` call is needed. Discovery (`tools.list`, `tools.search`, `tools.catalog`, and `tools.describe`) exposes `prewalk.plan` only while the current session owes one. Once recorded, the action and planning directives retire until the next arm/task needs a plan; host validation still rejects stale calls. `prewalk.status` remains available for diagnostics.

`prewalk.compactOnReturn` defaults to `true`. When an in-place continuation settles, Fabric requests a compaction with the configured `compaction.engine` and commits it while the executor is still the active model. Main's restored model receives the compacted transcript. Set this option to `false` when Main must receive the complete transcript.

Each in-place handoff captures Main's active model at the boundary and restores it when the continuation settles, when a new session is still on the executor, and when prewalk is cancelled (`/fabric prewalk --off` / `--disable`) or reloaded. A process that restarts while a continuation is still pending restores that captured model from the persisted continuation at the next session start, before the session auto-arms. Pi's public `setModel` extension API may also update the session model that a later session inherits, so restoring the captured Main model repairs that too. When the return itself fails, the arm is dropped, not re-armed and the failure is reported: the captured Main model is preserved so a later session start or `/fabric reload` retries the return, auto-arm is skipped while Main is still on the executor, and an explicit `/fabric prewalk` arm overrides.

## Models

`models.aliases` names model selectors for `agents.switchModel` and for Pi-runner `model` arguments on `agents.run`, `agents.spawn`, `agents.create`, and `agents.handoff` (see [Agents](agents.md#switching-mains-session-model)). Each alias is either one `provider/model` target, an ordered fallback chain, or an object `{"model": <target or chain>, "thinking": <level>}`. Resolution walks the chain and uses the first authenticated target. Alias names match case-insensitively and take priority over bare model ids and fuzzy matching. Aliases live in normal Fabric configuration, so a project `.pi/fabric.json` can extend the agent-level `fabric.json`; entries with malformed names or targets are ignored at load, and an unrecognized `thinking` level is dropped while the alias survives. An alias `thinking` level is the default effort for every run that selects it: an explicit `thinking` on the call or actor wins, and `agents.thinking` applies only when the alias sets none. `agents.switchModel` changes only the session model, so an alias thinking level does not apply there.

```json
{
  "models": {
    "aliases": {
      "cheap": "google/gemini-2.5-flash",
      "budget": ["openai/gpt-5-mini", "google/gemini-2.5-flash"],
      "shallow": { "model": "google/gemini-2.5-flash", "thinking": "low" }
    }
  }
}
```

## Result formatting

`executor.resultFormat` sets the default for `fabric_exec` return values. Find it under `/fabric settings` → **Executor**. `"auto"` keeps strings as text and renders structured values as syntax-highlighted YAML. `"yaml"`, `"json"`, and `"text"` each force their named behavior. A call-level `resultFormat` parameter overrides the configured default.

Configure the compaction engine under `/fabric settings` → **Compaction**. Select `"fabric"` for deterministic compaction, or `"pi"` to hand compaction to Pi core.

## Code modes

In the default full code mode, `fabric_exec` owns Pi core tool execution. The parent model sees one programmable tool. The direct `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls` schemas stay hidden. Fabric programs reach those capabilities through `pi.*`:

```ts
const files = await pi.find({ pattern: "**/*.ts", path: "src" });
const matches = await pi.grep({ pattern: "TODO", path: "src" });
return { files, matches };
```

Run independent calls in parallel:

```ts
const [packageJson, readme] = await Promise.all([
  pi.read({ path: "package.json" }),
  pi.read({ path: "README.md" }),
]);
return {
  package: JSON.parse(packageJson).name,
  readmeLines: readme.split("\n").length,
};
```

Pi core calls reject when the native tool reports an error. Successful `bash`, `powershell`, `edit`, and `write` calls return the `{ ok: true, output, details }` shape. Catch a rejection when recovery is local. Shell tools reject on an ordinary nonzero exit. Pass `settle: true` (for example `pi.bash({ command, settle: true })` or the Windows-only `pi.powershell({ command, settle: true })`) to receive `{ ok: false, output, details: null, exitCode, error }` on a nonzero exit. Timeout, cancellation, approval, security, and spawn failures still reject.

### Full code mode (default)

`fullCodeMode: true` is the default. Fabric removes the active Pi core tools from the parent model and exposes their implementations only inside `fabric_exec` through `pi.*`. Fabric also captures registered overrides such as security gates and code previews, so `pi.read()` keeps routing through the override.

Fabric records which native core tools were active before it takes ownership. Switching to orchestration-only mode or unloading Fabric restores that selection. Fabric applies full-mode ownership only when the session initializes or the mode changes. It never resets an explicitly selected active tool set from input, agent-start, turn-end, or settled lifecycle hooks. The system prompt carries the full-mode execution rule.

Pi core shows its model-visible skill catalog only while the native `read` tool is active. Full code mode restores the same catalog from Pi's structured skill registry and changes only the loader instruction, so `pi.read` runs inside `fabric_exec`. Native core tools stay hidden. Packaged skills mark cross-document paths with `<skill-dir>`. Fabric replaces that marker inline from Pi's expanded skill `location` or the actual `SKILL.md` read path. It never matches skill names or enumerates directories. Ordinary document reads stay unchanged. When an expanded skill invokes another installed skill, Fabric adds an exact name-to-path resolution hint for that turn, and the delegated `SKILL.md` loads before task work.

### Orchestration-only mode

Some users want Fabric for MCP, agents, ambient actors, parallel workflows, councils, and recursive delegation while Pi's core tools remain fully native. Those users can opt out of full code mode:

```json
{
  "fullCodeMode": false
}
```

In orchestration-only mode:

- Pi's `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls` tools stay on Pi's normal model-facing and execution paths. Fabric applies the configured risk approval policy through Pi's native `tool_call` preflight, and it leaves their execution and rendering untouched.
- Registered extension tools also remain in Pi's native registry. Fabric does not hide, wrap, or expose them through `extensions.*`. Model-requested direct calls use exact `capture.risks` overrides or the conservative `capture.defaultRisk` approval class.
- `pi.*`, `extensions.*`, and equivalent `tools.call()` references are unavailable inside `fabric_exec`, regardless of the configured kernel or whether TypeScript checks run.
- MCP and stable Fabric providers remain available through `mcp.*`, `memory.*`, `state.*`, `schema.*`, `components.*`, and `compact.*`. Generic discovery and computed refs still work through `tools.*`. One-shot and recursive agents, persistent ambient actors, dynamic workflows, mesh coordination, councils, explicit Fabric providers, and the Fabric TUI keep their full behavior.
- Child agents continue using their allowed Pi tools directly, so parallel and ambient setups never route their coding operations back through Fabric code mode.

### Where to set `fullCodeMode`

`fullCodeMode` defaults to `true`. Set the flag in `.pi/fabric.json` for one project, or globally in `~/.pi/agent/fabric.json` for every project. `/fabric settings` toggles it as well.

## Captured extension tools

When `fullCodeMode` is enabled, Fabric intercepts Pi's `ExtensionRunner.getAllRegisteredTools()` registry chokepoint. This captures tools that other extensions register at startup or later through `pi.registerTool()`. Whether an extension loads before or after Fabric makes no difference.

Captured custom tools leave the model's active tool set by default. Their schemas, snippets, and guidelines stop consuming the parent model context, and the model reaches them only through `fabric_exec`. The tools stay **registered** in Pi's runtime, so `pi.getAllTools()` keeps listing them. Host extensions that gate or audit tool calls by name (for example `@gotgenes/pi-permission-system`, which blocks names missing from that list before its own rules run) still see them as registered, and they evaluate nested captured calls through their normal policy and prompts. The owning extension remains loaded: its commands, event handlers, state, and UI continue to work. Only model-facing exposure and invocation become lazy.

```ts
const matches = await tools.search({ query: "deployment status" });
const schema = await tools.describe({ ref: matches[0].ref });
const result = await tools.call({
  ref: schema.ref,
  args: { environment: "staging" },
});
return result;
```

For tool names valid as JavaScript properties, use the shorter proxy:

```ts
const result = await extensions.project_status({ verbose: true });
return result.text;
```

The result keeps `content`, exposes text content as `text`, and carries `details`, `structuredContent` when supplied, `isError`, `terminate`, and source provenance. On Pi 1.0, callable captures use native `ctx.executeTool()` with nested IDs, validation, middleware, and usage accounting. Shells and tools with `prepareArguments()` retain Fabric's adapted execution boundary to preserve scoped cwd, nonzero-exit settlement before redaction, and exactly-once preparation. Both paths use the owning extension's tool context and apply `tool_call`, `tool_result`, and `tool_execution_*` handlers. Tools withdrawn with native `exposure: "hidden"` are not captured.

In full code mode and Schema enforce mode, `fabric_exec` is the only model-declared tool unless a [foreground policy](#foreground-tools) names others in full code mode. Pi 1.0 native `prepareLoadout` and per-request transcript projection hide all other declarations without removing tools from the native callable set. This includes native `codemode`, `tool_search`, MCP tools, and late registrations; `setActiveTools()` cannot open a second model-facing path. Inside Fabric, `pi.read`, `pi.bash`, and other built-ins still route through captured overrides when present. `extensions.read` exposes the override's native result shape. Native MCP tools are also callable by their captured names, for example `extensions.mcp__server__tool(...)`.

### Foreground tools

Some extension tools only work as a direct model turn: a question to the human, a turn-steering control, a context or skill loader. `foreground` keeps a short list of them declared beside `fabric_exec` in full code mode:

```json
{
  "foreground": {
    "tools": [
      { "name": "ask_user_question", "owner": "pi-ask", "reason": "human-input" }
    ],
    "maxTools": 4
  }
}
```

- Each entry needs `name`, `owner` (free text naming the extension that registers the tool), and `reason`: `turn-steering`, `human-input`, `context-control`, or `skill-loading`. At most 64 entries; `maxTools` is an integer from 0 to 8 (default 4). A malformed entry or `fabric_exec` as a name fails config loading.
- Fabric resolves the list in order against the live registry. It refuses Pi core tools (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`), other Pi built-ins such as native `codemode`, unregistered or `hidden` tools, inactive tools, tools outside an inherited child tool allowlist, duplicates, and entries beyond `maxTools`.
- Schema enforce mode and managed hosts refuse the whole policy: only `fabric_exec` stays declared. Orchestration-only mode already declares Pi's active set, so the policy has no effect there.
- Refusals are never silent. Fabric shows one warning per session (or logs it without a UI), and `/fabric status` lists the declared and refused foreground tools with each reason.
- A foreground tool keeps its program path: it stays callable as `extensions.<name>`. A direct model call runs Pi's `tool_call` hooks and Fabric's approval policy with the same ref (`extensions.<name>`), the same `capture.risks` class, and the same `approvals.actions` override as the program call.
- The declared foreground set is part of the prompt-cache fence beside active tool names, and the [tool placement query](providers.md#tool-placement-query) reports these tools as `model` and lists them in `programCallable`.

A compatible exact-name core override is an additive extension of its existing `pi.<name>` slot. In effective full-code execution (including Schema enforce mode, which treats execution as full-code even when `fullCodeMode` is false), the current override schema contributes a bounded, schema-derived object overload without replacing Fabric's built-in positional, bare-string, shorthand, or alias forms. Fabric keeps each slot's established normalized result contract (`string` for read-like tools and `{ ok, output, details }` for bash/edit/write). The registry still validates the normalized arguments authoritatively; Fabric does not prove that an override schema is a superset of the built-in schema. Schema enforce mode still applies its host gate: read-like core refs remain available, while protected mutations and external effects are blocked or must use the schema transaction path. An override's `promptSnippet` and `promptGuidelines`, when present, are appended as guidance for the corresponding `pi.<name>` identity and are not advertised as a second extension tool. Registration, replacement, reload, and removal are observed on the next execution and prompt build; no generated declaration or prompt state is persisted. Generated overloads widen the known numeric fields (`offset`, `limit`, `timeout`, `context`) to `number | string`, matching built-in runtime normalization; an override with a stricter numeric schema still rejects the string form at registry validation, so read the error and retry. Each generated overload takes a single object argument; the built-in two-argument signature such as `pi.read(args, options?)` remains available from the base slot unchanged.

## Approvals and risk

Fabric risk classes are `read`, `write`, `execute`, `network`, and `agent`. Approval policy values are `allow`, `ask`, `auto`, or `deny`. Policies cover actions invoked inside `fabric_exec` and top-level model-requested tools left on Pi's native path. Native calls keep Pi's original implementation, result shape, and renderer. Fabric adds only the supported interception hook that runs before execution. The native-path check starts with the session, before Fabric's runtime activates on first use, so the same direct call gets the same answer before and after the first `fabric_exec`. `/fabric settings` and `/fabric reload` are commands, not tool calls, so a restrictive policy can always be changed in-session.

- Captured and directly registered tools default to the conservative `execute` risk because Pi tool definitions do not declare effects. Add exact tool-name overrides under `capture.risks`. Fovea's verified graph-navigation tools (`fovea_sketch`, `fovea_focus`, `fovea_dwell`, and `fovea_impact`) are read-only exceptions that default to `read`.
- `capture.hideFromModel` and `capture.keepVisible` remain accepted legacy preferences, but cannot override exclusive full-code or Schema enforce mode. Native active tools stay registered/callable while their declarations are hidden.
- In orchestration-only mode, Pi's active set and each tool's native exposure govern model visibility.
- Extension tool names appear in the prompt as a names-only roster; descriptions and schemas are resolved on demand via `tools.list` / `tools.search` / `tools.describe` before first use.
- An `ask` policy emits a warning notification and opens an explicit **Allow once** / **Allow for this session** / **Deny** permission prompt. These options match Claude-style approval scopes. **Allow once** authorizes only the requested action. **Allow for this session** keeps that risk class authorized until the current Pi session ends. The TUI uses an inline wizard. RPC clients receive the equivalent `select` dialog.
- Fabric serializes concurrent requests so a one-time approval never silently widens to sibling calls. Session-wide grants apply to native calls and to `fabric_exec`. Escape, dismissal, unavailable interactive UI, and session restart all fail closed.
- `approvals.headless` (default `"deny"`) chooses what an approval does without an interactive UI. `"decision"` raises a durable user-held approval decision for `fabric_exec` actions and waits up to `approvals.headlessTimeoutMs` (default `300000`, bounded to 1 s..24 h). Only an explicit approve answer from `/fabric decisions` or `pi-fabric decisions answer` runs the action once; deny, cancel, expiry, and abort deny it. Any other value keeps `"deny"`. See [durable decisions](decisions.md#headless-approvals).

### Per-action approval overrides

`approvals.actions` overrides the risk-class mode for individual actions (default: none):

```json
{
  "approvals": {
    "write": "allow",
    "actions": {
      "delegate.*": "ask",
      "delegate.status": "allow",
      "pi.bash": "deny"
    }
  }
}
```

Keys are an exact ref (`provider.action`, including multi-segment refs such as `mcp.github.search`) or a provider wildcard (`provider.*`). Values are `allow`, `ask`, or `deny`. An exact key beats a wildcard, which beats the risk-class mode. Other wildcard forms, unknown values, and more than 256 entries are configuration errors; Fabric never drops them silently. Overrides apply to every approval path keyed by a ref: actions inside `fabric_exec`, top-level native tools (`pi.<tool>` for Pi built-ins, `extensions.<tool>` otherwise), and Jev program observation. `deny` is absolute: inherited child risk grants and **Allow for this session** cannot lift it. `allow` and `ask` replace the risk-class mode and otherwise keep its semantics, including session grants for `ask`. Speculative prefetch only considers refs whose effective mode is `allow`. Overrides do not bypass Schema enforce or other host gates.

### Auto approval mode

An `auto` policy sends each validated call and its prepared arguments to a separate Pi model or Jev classifier before invocation. Configure **Auto model** under `/fabric settings` → **Approvals**, or set the optional canonical `provider/model` key in `fabric.json`:

```json
{
  "approvals": {
    "model": "anthropic/claude-opus-4-6",
    "write": "auto",
    "execute": "auto",
    "network": "auto",
    "agent": "auto"
  }
}
```

Choose **Inherit** in the model picker to omit `approvals.model` and use the active Pi session model. Built-in and custom models dispatch through Pi's effective provider runtime, including providers with custom API identifiers. Older supported Pi versions fall back to their compatibility provider registry. Read access stays independently configurable, and most setups leave it at `allow`.

The classifier receives the exact action, bounded prepared arguments, cwd, user-message text, and assistant tool calls. Fabric excludes assistant prose and tool outputs, so model-authored reasoning and retrieved hostile content cannot directly instruct the classifier. The classifier has no executable tools and must return a structured `allow` or `escalate` verdict. An `allow` verdict applies only to that call. `escalate`, malformed output, missing authentication, timeout, cancellation, or any classifier error falls back to the explicit **Allow once** / **Allow for this session** / **Deny** prompt. Headless runs fail closed when that prompt cannot be shown. Fabric attaches classifier token usage and cost to the resulting `fabric_exec` or native tool result, and execution traces record each nested verdict as `fabric.approval.auto`.

`deny` stays deterministic and runs before the classifier. Schema enforcement, project trust, budgets, and other host gates remain authoritative. Auto mode is a model-based policy advisor and provides no stronger sandbox boundary. Its initial conservative policy escalates destructive or irreversible actions, shared/external/production changes, credential or sensitive-data exposure, safety bypasses, actions beyond explicit user intent, and actions whose safety is uncertain. Fabric adapts the policy architecture described in Claude Code's [permission modes](https://code.claude.com/docs/en/permission-modes), [auto-mode configuration](https://code.claude.com/docs/en/auto-mode-config), and Anthropic's [auto-mode engineering write-up](https://www.anthropic.com/engineering/claude-code-auto-mode), adapted to Pi's model registry and Fabric's existing per-risk policy gate.

### Jev as the auto-mode classifier

Select a Jev entry in **Approvals → Auto model** after `/login jev` (TypeSafe route), `/login openrouter` (OpenRouter route), or `/login vercel-ai-gateway` (Vercel AI Gateway route), or configure:

```json
{
  "approvals": {
    "model": "pi-fabric/typesafe/jev-latest",
    "write": "auto",
    "execute": "auto",
    "network": "auto",
    "agent": "auto"
  }
}
```

Jev is an auth-only provider, not a chat model. This picker offers `pi-fabric/typesafe/jev-latest`, `pi-fabric/typesafe/jev-1.13`, `pi-fabric/typesafe/jev-1.13.0`, and `pi-fabric/typesafe/jev-preview` only in the approvals list, plus the configured `jev.model` if different. It also offers OpenRouter-served `pi-fabric/openrouter/jev-latest` and `pi-fabric/openrouter/jev-1.13`, which reuse the existing `openrouter` credential (`/login openrouter`, `OPENROUTER_API_KEY`, or `TYPESAFE_OPENROUTER_API_KEY`); OpenRouter has no `jev-preview` alias and serves Jev on its Decisions API, not `/chat/completions`. Vercel AI Gateway-served `pi-fabric/vercel-ai-gateway/jev-latest` reuses the existing `vercel-ai-gateway` credential (`/login vercel-ai-gateway` or `AI_GATEWAY_API_KEY`) and resolves to `typesafe-ai/jev` on the gateway's TypeSafe-compatible endpoint. Legacy `jev/<model-id>` overrides normalize to `pi-fabric/typesafe/<model-id>` when loaded. `/login jev` credentials and raw TypeSafe request IDs (`jev-latest`, `jev-1.13`) are unchanged. **Inherit** still means the active Pi chat model, never Jev. Selecting Jev for approvals is independent of `jev.enabled`, which controls Fabric's Jev tool provider.

The host asks four typed Noul questions in one request: whether the exact action is safe to run without human approval, whether it touches secrets or sensitive data, whether it is destructive or irreversible without a user-named target, and whether it targets only artifacts this session created. Auto-allow requires the safety probability to be **at least `jev.autoApprovalThreshold` (default 0.50)** **and** the secrets and destructive probabilities to stay below 0.5; all four verdicts and the effective threshold are recorded with the decision. Selecting a Jev model reveals **Approvals → Jev minimum probability**, an editable number from 0 to 1 in both terminal and RPC settings. The setting persists in the selected global/project scope, remains saved when switching models, and applies only to Jev classification. For example, `"jev": { "autoApprovalThreshold": 0.95 }` requires a probability of at least 0.95. Missing, non-numeric, non-finite, or out-of-range configuration values use the 0.50 default; valid decimals and zero are preserved. Upgrading from the former fixed 0.99 cutoff uses 0.50 unless you explicitly configure another value.

Lower thresholds permit more actions. **0 allows every valid judgment whose secrets and destructive verdicts are clean**, while 1 requires a safety probability of 1; a secrets or destructive probability at or above 0.5 escalates regardless of threshold, and so do missing user text, malformed answers, and errors. Reasons report the four numeric judgments and the effective threshold, not generated explanations. This is a policy cutoff, **not a calibrated security guarantee**. Use `ask` or `deny` when a probabilistic advisor is inappropriate.

Jev receives the exact bounded arguments, the **latest user message and subsequent assistant tool calls**, and a bounded projection of earlier session actions - direct tool calls and nested Fabric actions with their arguments, host-recorded failures marked `"ok":false`. Earlier turns' prose, thinking, images, and tool outputs are excluded, so vague follow-ups cannot borrow authority from omitted history and retrieved content cannot instruct the classifier. Missing user text still requires explicit approval without inference. Oversized arguments, transcript clipping, and projection limits are disclosed to Jev as `evidence`/`session.truncated` facts without aborting classification (16,000 argument characters, 6,000 per user message/tool-call batch, 24,000 total evidence characters, 12,000 session-projection characters). Starting a new explicit user turn resets the conversational evidence window; the session-action projection spans the session.

Selecting this remote classifier authorizes sending that evidence to TypeSafe; it can contain private paths, code, or values from tool arguments. Do not select it for data that must stay local. Classification is a host-side request, not a recursive `jev.evaluate` tool call, so it does not recursively invoke the network approval policy. Normal tool permissions still apply after classification. Missing auth, malformed answers, HTTP errors, cancellation and timeouts never fall back to another model or auto-allow. They use the existing explicit approval flow (or deny in headless mode).

Authentication uses `/login jev`/`TYPESAFE_API_KEY` on the TypeSafe route, the existing `openrouter` credential (`/login openrouter`, `OPENROUTER_API_KEY`, or `TYPESAFE_OPENROUTER_API_KEY`) on the OpenRouter route, and the existing `vercel-ai-gateway` credential (`/login vercel-ai-gateway` or `AI_GATEWAY_API_KEY`) on the Vercel AI Gateway route, then trusted `jev.credentialCommand`; the command is resolved per classification and not cached across decisions. `jev.maxRequestBytes` and `jev.requestTimeoutMs` apply, with a 30-second classifier timeout ceiling and no automatic retries. Typed token usage is included in approval accounting. TypeSafe does not return prices: cost fields are zero/unpriced, **not evidence that inference is free**.

## Temporal retention

Fabric clears inactive run artifacts by age. It never truncates active JSONL files. The defaults are:

- `retention.orphanedTempRunMs`: reclaim a managed temporary run root six hours after a sweep **first notices** its owner is dead, provided its contents and descendant liveness can be verified. Live owners/descendants are preserved. Closed, shutdown-confirmed incomplete runs use the same grace from close.
- `retention.oneShotRunMs`: retain terminal one-shot agent run artifacts for 24 hours. An explicit `agents.cleanup()` may remove them sooner. Graceful shutdown with `agents.retainRuns: true` marks managed roots closed; empty roots are removed immediately. `retainRuns: false` requests deletion after child transports stop, including for managed temporary roots. Inherited nested roots belong to the enclosing agent run: a child manager stops its session children but leaves their terminal status and transcripts for that run's cleanup/retention or the root-session shutdown.
- `retention.actorRunArchiveMs`: retain terminal actor run archives for seven days. Fabric always preserves the latest run for each actor.

Run housekeeping begins on actual agent storage use (not manager startup), continues during use, and runs best-effort on close. It never applies cache pressure to agent runs or truncates their JSONL/actor `session.jsonl` files. A `pi-durable` run's own `durable/` journal is a known run artifact and expires with its run. Caller-owned run roots retain their existing explicit-cleanup semantics. Symlink roots/markers, wrong-uid files, malformed ownership, unknown contents, and unverifiable incomplete descendants are preserved. `/fabric settings` exposes all three values under **Retention**. Changing them requires `/fabric reload`.

### Temporary output and reader scratch

New model-output spills and shell logs use private directories with a versioned `.fabric-scratch.json` ownership marker. They expire 24 hours after completion; oldest eligible caches may be removed sooner above **128 MiB or 256 items**, pooled across these two classes. Completed output is protected for its first hour. These aggregate limits are **soft** while files are active/recent or cannot be safely attributed. Model-output artifacts remain complete (not truncated). Their links are temporary.

Shell hang tracking keeps a **1 MiB RAM tail per running command**, then releases it on finish. Completed handles are capped at **256** and expire after 24 hours on subsequent store access. Each shell log is capped at **8 MiB including notices**; it starts with the retained pre-spill tail, not necessarily the command's beginning. The returned notice and log header explicitly say this is bounded, **not a full-output archive**; reaching the disk cap appends a truncation notice. Further output continues to the normal shell consumer but not the log. PID files are retired on finish; logs remain subject to the cache policy. A disk write error also stops logging without interrupting command execution; bounded logs never promise completeness.

Reader checkpoints are lossless live state: they are **never pressure-evicted**. Dispose/finalization removes them normally. New marked scratch left by a killed host can be recovered only six hours after housekeeping first observes a dead owner; shell scratch additionally preserves a live recorded child PID. PID reuse and permission uncertainty preserve data. Sweeps are asynchronous, coalesced and throttled to once per minute on actual scratch allocation/close, with no idle startup scan. Nothing expires until a later storage use triggers housekeeping. Directory identity, file metadata and owner/child liveness are rechecked before removal; hardlinked files are excluded. `sweepScratch({ tempRoot, dryRun: true })` reports `eligible` and first-observed `orphaned` directories without deleting or updating markers.

**Conservative recovery limits:** legacy unmarked output/shell/checkpoint artifacts are not automatically deleted. Shared recursion budget ledgers lack descendant ownership leases, and temporary actor roots may contain shared/adopted work; crash orphans of those two classes are deliberately left alone, not deleted merely because a parent PID is dead or old. Normal owned-budget/ephemeral-actor close cleanup remains in place (budget initialization failures now remove their partial allocation). Persistent/caller-owned actor roots are not cache sweep targets. Unverifiable legacy incomplete runs, unknown files, malformed markers, and symlinks likewise require an operator's ownership/liveness review; do not use a broad prefix deletion.

## Agents

`agents.runner` selects the default harness: `"pi-durable"` (default, [isolated durable Pi host](durable-pi.md)), `"pi"` (legacy Pi CLI), `"claude"`, `"veda"`, or the id of a runner registered through `pi-fabric/runners` ([custom runners](agents.md#custom-runners)). A well-formed id that no extension registers is kept, and launches fail closed until the runner is registered. Before the first turn of each session, Fabric warns once when the configured runner is still unregistered, suggests a close built-in or registered id for likely typos, and lists the registered runners. Malformed ids fall back to `"pi-durable"`. Explicit existing runner settings are preserved. `agents.model` is the optional Pi `provider/id` override. `agents.claude.model` is the optional canonical Claude runtime key. `agents.claude.binary` defaults to `claude`. You can supply an absolute path or a wrapper. `PI_FABRIC_CLAUDE_BINARY` overrides it for the current process. `/fabric settings` enumerates Claude models from that binary in the background and stores the two runner defaults independently. `agents.modelAdmission` defaults to `strict`: a Pi child run fails when the model it reports after selection differs from the requested key. Set it to `permissive` when a virtual provider key (for example a `pi-multiprovider` entry) resolves to a concrete backend at stream time; Fabric then records the reported attribution and continues, including when a later assistant frame names that backend. Permissive admission still fails a child that reports no model or starts work before admission.

The `veda` runner drives the [Veda CLI](https://github.com/kennyfrc/veda) as the child harness. `agents.veda.binary` defaults to `veda`. An absolute path or wrapper works, and `PI_FABRIC_VEDA_BINARY` overrides it for the current process. `agents.veda.backend` selects which backend Veda wraps: `agy` (Antigravity CLI, the default), `codex`, `claude-code`, `droid`, `pi`, or another backend registered by the installed Veda build. Fabric passes this value through unchanged and never hardcodes AGY. `agents.veda.model` is an optional backend-specific model or Veda alias. When you omit it, Veda selects its own backend default. `agents.veda.persona` picks the global Veda persona: `navigator-plan`, `navigator-chat` (default), `reviewer`, `worker`, or a custom persona under `~/.config/veda/personas/<name>/AGENTS.md`. Per-run selection overrides it through `agents.run({ persona })`. You can also edit the Veda backend, persona, and model in the Fabric settings panel under Agents. Each child runs one headless `veda --json` prompt with an isolated `fabric-<run-id>` session, so parallel children never share Veda selection or conversation state. Veda sessions lack persistence, and steering is unsupported. Veda children are **not** recursively Fabric-equipped (`recursive: true` is rejected), and they cannot back persistent actors.

A JS runtime launches each Fabric worker module. Fabric reuses the current runtime when `process.execPath` names `node` or `bun`. For a Bun-compiled Pi binary, `process.execPath` names the `pi` executable. Fabric then uses `PI_FABRIC_NODE_BINARY` or the first `node` or `bun` on `PATH`. The resolved runtime launches the workers. `PI_FABRIC_NODE_BINARY` overrides this choice for the current process. The Node-process executor (`executor.runtime: "node-process"`) requires Node.js because it uses `--eval` and `--input-type=module`; the Bun-process executor (`executor.runtime: "bun-process"`) requires Bun because it uses `--eval`.

Workers require Node.js 24+ (or Bun) and report an explicit startup failure on older Node versions. Pi-managed installs intentionally omit physical host peers such as `typebox`; do not repair this by installing all Pi peers. Fabric ships a private, self-contained worker validator while keeping the extension's TypeBox host-mapped. Missing worker dependencies or bootstrap modules are reported in the run status before any model call. The process transport also retains a bounded stderr tail for failures that cannot write a status record.

Other agent settings:

- `thinking`: default reasoning effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), default `medium`.
- `maxConcurrent`: global child concurrency semaphore.
- `maxPerExecution`: hard cap on children per `fabric_exec` invocation.
- `maxDepth`: nesting bound for child agent calls, including `rlm.query()`. It accepts any non-negative safe integer. A value of `0` disables child spawning. `/fabric settings` provides free-form numeric entry.
- `timeoutMs`: default wall-clock budget per child and the floor for per-call overrides (24 hours by default, which is also the policy ceiling). Fabric ignores lower per-call values. The default matches the ceiling on purpose: an orchestration program inherits this value as its own whole-program deadline floor, so a lower default would cut a long participant short well inside the allowed maximum. Lower it to bound a class of runs, and raise a single run with a per-call value.
- `extensions`: whether Claude children keep their normal Claude Code customizations.
- `defaultTools`: the default tool allowlist for children.
- `budgetUsd`: shared append-only cost ledger across a recursion tree (0 disables).
- `maxTokensPerChild`: cumulative token bound per child (0 disables).
- `notifyOnComplete`: show concise detached `agents.spawn()` completion notices and batch unread results for Main at a safe tool-turn boundary (or wake idle Main). `wait`/`join` and terminal `status` retract pending notifications; running/UI status does not. Escape/error parks results until new input.
- `sessionExport`: export each agent run's usage as an attributed pi-format session file (on by default).
- `sessionExportDir`: override the export store root (default `~/.pi-fabric/agent`, with `PI_FABRIC_AGENT_DIR` taking precedence).
- `worktree.setup`: optional shell command (`/bin/sh`, or `cmd.exe` on Windows) run in each new `worktree: true` checkout before the child starts (unset by default; blank values are ignored). A per-request `worktreeSetup` overrides it, and a non-zero exit fails the launch. See [worktree results and setup](agents.md#transports).
- `childQuestions`: `"cancel"` (default) cancels every dialog a Pi child opens; `"route"` forwards it to the parent's UI, or to a root-held [decision](decisions.md#routed-child-questions) when the parent has no UI.
- `childQuestionTimeoutMs`: default deadline for a routed child dialog (default `600000`, bounded to 1 s..24 h); a dialog's own timeout wins.

### Usage tracking with external tools

Fabric children run with `--no-session`, so token trackers that scrape session files (tokscale, ccusage, …) cannot see subagent token usage or cost. With `sessionExport` enabled (the default), every child writes one usage-only session file (tokens and cost, never transcript content) to:

```text
~/.pi/agent/sessions/.fabric/<encoded-cwd>/<run>.jsonl
```

Fabric attributes each file through a `session_info` marker (`fabricagent-<name>`). This placement works because tokscale and ccusage walk pi's session store recursively, and pi's own resume picker reads only its immediate `<encoded-cwd>` directory. **Both trackers count Fabric subagents with zero configuration, and pi's session UI never lists these files**. The exported sessions behave like a co-hosted namespace inside pi's store.

- **tokscale**: counted under the Pi client automatically. A small dedicated-client patch (senpi-style, pointing at `~/.pi/agent/sessions/.fabric`) turns it into a separate "Pi Fabric" row with per-`fabricagent-*` attribution.
- **ccusage**: counted in the default pi footprint automatically (`ccusage daily`, `ccusage pi …`). For an ad-hoc Fabric-only view, run `ccusage pi daily --pi-path ~/.pi/agent/sessions/.fabric`.
- **Isolated store**: to keep usage files fully outside pi's store, set `agents.sessionExportDir` (or `PI_FABRIC_AGENT_DIR`) to `~/.pi-fabric/agent`, then register a ccusage named store for a dedicated `fabric` agent section:

  ```json
  { "pi": { "stores": [ { "name": "fabric", "path": "~/.pi-fabric/agent/sessions/.fabric" } ] } }
  ```

  ccusage's double-count guard rejects a named store that overlaps the default pi store, so the isolated-row form requires the separate directory.

See [agents, actors & mesh](agents.md) for the runner and transport details.

## MCP

### Opt-in Pi-owned servers

By default Fabric still uses mcporter. To borrow specific servers already configured in Pi's `mcp.json`, set exact server names in Fabric configuration, or use **/fabric settings → MCP → Pi-owned servers**:

```json
{ "mcp": { "nativeServers": ["github", "project-docs"] } }
```

Run `/fabric reload` after changing this selection. Configuring or enabling a native server itself remains Pi's job (`/mcp`, `pi mcp`, and `/reload`). SDK hosts must supply Pi's `createMcpExtension()` and bind extensions; Fabric does not install it or start another native client. No existing MCP configuration or credentials are migrated. An empty list restores the default ownership.

Selected servers keep Fabric's `mcp.<server>.<tool>` names, sanitizer aliases, discovery, static argument checking, normalized `{ text, content, structuredContent }` results, and `display: { name, description }` execution metadata. Raw MCP identity comes from Pi's namespace/label metadata, not its potentially hashed tool identifier. Tool descriptions and input schemas come from the live native registration; Pi's `CallToolResult` output-schema envelope is unwrapped. Schema differences invalidate old normal-form plans; Fabric does not conceal them. Other servers keep the existing mcporter behavior. Selected tools are advertised once under `mcp.*`; existing `extensions.mcp__...` references remain callable when extension capture is enabled, but are not repeated in discovery or the extension roster.

Both Fabric policy and Pi's tool middleware apply. Native redactions, progress, nested usage and cancellation remain authoritative; one Fabric invocation emits one Fabric trace operation. Read-only MCP annotations do not change Fabric's conservative network risk. Pi-owned tools remain subject to hidden/deferred exposure and child tool allowlists. A missing, withdrawn, blocked or failed native tool never falls back to mcporter, even if mcporter has a server with the same name. Fabric does not connect or revalidate that duplicate. Ambiguous sanitized names require exact names via `mcp.call` (an exact legacy server name retains precedence over a native alias). Resolving a native server alias may load mcporter's configuration names to check ambiguity, but does not connect those servers.

Fabric still owns its call deadline. Reload/shutdown cancels its borrowed calls without disconnecting Pi's shared servers. `mcp.servers()` includes selected native servers with `transport: "pi"` (an ownership marker, not a wire protocol), tool counts, and `stale: true` when no callable tools are currently registered. `mcp.reload()` only reloads mcporter; it does not reconnect Pi servers. `mcp.register()` cannot replace a Pi-owned name. Native resource tools remain on Pi's existing captured surface; they are not renamed into per-server tool namespaces.

Pi owns native startup connections and OAuth; this option does not make Pi's own session-start connections lazy. Fabric adds no connection work to registration or idle hooks. Use `/mcp login` for native authentication. To prevent *Pi itself* from also connecting a legacy-owned server, disable/remove its entry in Pi's MCP configuration; Fabric never changes that user setting.

### mcporter and shared options

- `mcp.nativeServers`: exact Pi-owned server names, default `[]`. Invalid selections fail without changing ownership.
- `mcp.disableOAuth`: for mcporter, calls may use cached credentials but cannot launch new interactive OAuth flows. Pi-owned servers use Pi's authentication settings instead.
- `mcp.callTimeoutMs`: per-call timeout bound.
- `mcp.allowDynamicServers`: permit `mcp.register()` of ephemeral servers.
- `mcp.enabled`: set to `false` to disable the MCP surface.

Fabric keeps a per-project MCP descriptor cache at `.pi/fabric/mcp-cache.json`. The cache uses the same config layers as [mcporter](https://github.com/openclaw/mcporter): global settings from `~/.mcporter/mcporter.json` and project settings from `config/mcporter.json`. Tool discovery (`tools.list`/`search`/`catalog`) reads these cached descriptors. Sessions reuse them while the config stays equal. Config state alone controls validity. Per-server definition hashes preserve entries when another server changes. Whitespace-only edits also keep the entries valid.

Fabric handles staleness in stale-while-revalidate style. Sessions adopt the cache instantly and re-list servers in the background per policy. When a server fails, its last-known tools stay available, marked `stale` in `mcp.$servers`. Fabric always re-lists a server the first time a call connects to it.

- `mcp.cache.enabled`: turn the descriptor cache on (default: true). When false, discovery lists tools live with a 60s in-memory TTL, matching the pre-cache behavior.
- `mcp.cache.revalidate`: background re-listing scope at session start, one of `"changed"` (only added or reconfigured servers, the default), `"all"`, or `"off"` (explicit `tools.list({ provider: "mcp", namespace })` probes still fetch exactly that server).
- `mcp.cache.revalidateBudgetMs`: wall-clock budget for one background revalidation pass (default 60000). A leftover queue tail restarts with a fresh budget.
- `mcp.jev.semanticSearch`: opt-in Jev ranking for `tools.search({ query, searchMode: "semantic" })` (default false). Default `tools.search` stays local and lexical. Enable it under **/fabric settings → MCP → Jev semantic search**.
- `mcp.jev.blockedServers`: MCP servers whose tool metadata must not be sent to Jev. Empty (the default) allows every server, including ones that are not cached yet. **/fabric settings → MCP → Block from Jev** lists cached servers so you can opt individual ones out.
- `mcp.jev.semanticCandidateLimit`: max tools sent to Jev (2–127, default 127). Half the slots are lexical hits; the rest recover tools the query would not name.
- `mcp.jev.semanticMinProbability`: minimum head probability to accept a match (0–1, default 0.2). Below that, or if Jev chooses `none`, search abstains. Timeout, rate-limit, and 5xx responses fall back to lexical ranking and mark `backend.degraded`.

See the [TypeScript MCP reference](../skillsets/typescript/fabric-exec/references/mcp.md) or [Python MCP reference](../skillsets/python/fabric-exec/references/mcp.md) for the selected call surface.

## UI

- `ui.widget` is `auto`, `always`, or `hidden`. `auto` shows active or retained Fabric runs and worker activity. Rows list agents from this session's lineage (agents owned by other sessions of the same project stay out of the widget) plus actor workers. Completed agents remain listed after their run ends, newest first, until the row budget or an explicit dismissal retires them. Their recent nested tools appear beneath them when enabled.
- `ui.maxRows` defaults to `6` and clamps the widget to `1..20` rows. The effective budget is also bounded by half the live terminal height, so a short pane or a tmux split cannot let the animated box fill the viewport and keep pi's scroll region moving under the editor. Rows beyond the budget collapse into a dim `+N` marker on the last line.
- `ui.showAgentToolPreview` defaults to `true` and controls the child-agent and actor tool rows in both the parent `fabric_exec` card and the widget. Recursive agents render their full descendant tree, bounded by the preview depth/node budget. The version 2 config migration renamed this key from `ui.showNestedToolCalls`.
- `ui.toolDisplay` is `"compact"` (default) or `"full"`. Compact elevates the declared display name and description and keeps bounded nested tool detail visible; full retains the outer Fabric program transcript. Pi's tool-expand keybinding (`ctrl+o` by default) expands a compact card to the full transcript and collapses it again. Invalid values fall back to `"compact"`. If configuration fails to load, rendering falls back to full so a degraded startup never hides the transcript. Change it under `/fabric settings` → **UI**; successful changes apply immediately to live and completed cards.
- `ui.updateDebounceMs` defaults to `100`. It applies one execution-wide coalescing interval to every live `fabric_exec` card update: nested calls, progress text, and agent tool previews. Continuous streams emit at most once per interval, so a long call no longer postpones every render until completion. Set it to `0` to emit every update. Accepted values clamp to `0..2000`. The version 3 config migration renamed this key from `ui.nestedToolDebounceMs`.
- The widget renders above the chat, like `pi-supervisor`. Set `ui.enabled` to `false` to disable both the widget and the dashboard controller.

See the [interface reference](interface.md).

## Mesh

Mesh data lives at `<project>/.pi/fabric/mesh` by default. Set `mesh.root` to a relative or absolute path to relocate durable topics, shared state, and actor sessions. Add `.pi/fabric/mesh/` to the project's ignore file unless you version the coordination log on purpose. Set `mesh.enabled` to `false` to disable both mesh actions and ambient actor restoration.

`mesh.actorScope` is the default storage scope for `agents.create`; each actor can override it with `scope: "project"` or `scope: "session"`. Both scopes run concurrently:

- `"project"` (default) uses `.pi/fabric/mesh/actors/`. Actors survive `/new` and appear in every trusted Pi session for the project.
- `"session"` uses `.pi/fabric/mesh/actors/<sessionId>/`. Actors are isolated to the root Pi session and remain available to participant agents in that lineage. Use this for task-specific supervisors and private history.

In project scope, one host owns each actor runtime. Only that host drains host events and mesh subscriptions. Other sessions can read the shared definition, mailbox, and logs; set their own model and thinking binding; and route `ask`, `tell`, `steer`, `followUp`, and `stop` through the owner. They do not start another actor runtime.

If the owner lease and lineage root both disappear, a matching trusted host can adopt the actor. Main adopts session-resident actors. The resident host adopts durable actors. Adoption stores a new `rootId` and an `adoptedAt` fence under the registry lock. Concurrent starters converge on one owner. The 30-second fence gives that owner time to publish its participant record. Until every registry row has a matching owner, create or import can fail with `registry is owned by another host`.

Registry writes take a stale-safe lock and merge only actors owned by the writer. A local save preserves newer records from another owner.

`agents.setModel` and `agents.setThinking` change the current Pi session by default. In project scope, their binding files are separate from `actors.json`. Pass `scope: "project"` to change the shared default; only the owner can do so. Values passed to `ask` or `tell` affect one activation. Fabric resolves values in this order:

```text
call override → session binding → project default → Fabric default
```

`mesh.eventContextChars` bounds the sanitized JSON context attached to each host-event activation. Fabric extracts images first. It stores redacted image descriptors in the mailbox and registry, then sends the raw images to the actor out of band. The character limit never truncates image base64 because base64 is not part of that JSON context.

Mesh topics, shared state, and the participant directory remain project-scoped. Every runtime publishes one short-lived host lease and records for the roots, agents, and actors it owns. `agents.members()` and `mesh.members()` read those records. `agents.main()` and `agents.peers()` project roots. When a lease expires, its records leave normal discovery together. `mesh.actorPollMs` controls fallback polling for actor events and owner-addressed commands when filesystem notifications are unavailable.

## Memory sources

`memory.enabled` (default: true) toggles the `memory.*` provider. `memory.sources` registers portable host sources so remote or archived session trees answer source-qualified calls such as `memory.recall({ source: "laptop", ... })`; `memory.sessions` and `memory.expand` accept the same `source` argument. Without `sources`, memory behavior is unchanged: source-less calls keep their filesystem scopes and source-qualified calls fail with `source_not_found`.

Each entry has three keys:

- `id`: the `args.source` label. Lowercase letters, digits, dot, `_`, or dash; must start with a letter or digit and be unique across entries.
- `kind`: the adapter kind. Only `"fs"` exists today; anything else is a configuration error at load time.
- `root`: absolute path the `fs` adapter walks recursively for `*.jsonl` files. Native agent trees (`sessions/<encoded-cwd>/*.jsonl`) and flat archive directories both work; keys are root-relative paths, and traversal outside `root` is refused.

The `fs` adapter derives each session's `revision` from the SHA-256 of the file bytes, so mtime-only touches keep follow pointers valid while content changes invalidate them. Enumeration is bounded by `memory.maxSessions` and reported through coverage reasons (`fs_source_max_sessions`, `fs_source_scan_capped`); a capped archive is never presented as complete. Ranking, branches, and expansion follow the normal engine paths described in [memory recall](memory-recall.md#portable-host-sources).

## Extractive history (opt-in)

In `/fabric settings`, open **Extractive history**. Choose **Consent / mode** and a **Native classifier** from Pi core's registry. Model selection alone does not enable inference. This uses Pi core's `classify()` API, not Fabric's Jev connector.

```json
{
  "memory": {
    "extractive": {
      "enabled": false,
      "provider": "typesafe",
      "model": "jev-latest",
      "maxViewBytes": 8192,
      "maxCandidates": 128,
      "maxSourceChars": 24000,
      "maxEvaluationsPerTurn": 1,
      "timeoutMs": 3000
    }
  }
}
```

Set `enabled: true` to opt in. With `maxEvaluationsPerTurn: 1`, bounded active-branch user/assistant text is sent to the selected classifier and may incur API charges; there is no secret scanner. Set the budget to `0` for local deterministic extraction with no classifier calls. `memory.enabled: false` disables the feature too.

The bounded view preserves complete source quotes, attribution and omission notices. Scores indicate salience, **not truth**. Missing credentials, invalid answers and timeouts fall back deterministically; stale branch/session responses are discarded. It supplements request context without deleting history or replacing Pi compaction, and introduces no generative summarizer. See [Extractive history](extractive-history.md) for bounds and source navigation.

## Principal and scope

Scope is host-issued and has no config key. A project or global setting cannot grant or widen a principal.

- `PI_FABRIC_SCOPE`: JSON `{ version?: 1, principal: { id, issuer?: "host" }, grants: [{ resource, actions }], digest?, parentDigest? }`. At most 64 grants; `actions` from `read`, `write`, `execute`.
- `PI_FABRIC_SCOPE_FILE`: path to the same JSON, at most 64 KiB. Set only one of the two.

Fabric reads both once when the extension initializes. An embedding process can call `issueRootScope()` from `pi-fabric/scope` before `session_start`. Malformed JSON, an unreadable file, a digest mismatch, or conflicting issuance makes every provider call fail with a clear error. Fabric never falls back to an unscoped session. Fabric children receive their derived scope through `PI_FABRIC_SCOPE`. See [principal and scope](providers.md#principal-and-scope).

## Compaction

The deterministic, LLM-free compaction engine is on by default. It keeps Pi's bounded `keepRecentTokens` continuity tail. `compaction.targetContextRatio` sets a hard occupancy ceiling. Set `compaction.engine` to `"pi"` to restore pi-core compaction. When pi-vcc is also installed, Fabric takes precedence for automatic compaction. An explicit `/pi-vcc` command always uses pi-vcc's engine. See [compaction](compaction.md) for invariants, loss guarantees, sections, and limits.

`compaction.outputReserveTokens` (default `0`, disabled; integer up to 100,000,000) compacts at the settled boundary once the window headroom falls below the reserve. `compaction.pressureBands` (default `{ "warn": 0.6, "urgent": 0.8 }`, requires `0 < warn < urgent < 1`, otherwise defaults) labels `compact.pressure()` readings. `compaction.repairOrphans` (default `true`) drops orphaned tool results and fills missing ones in the outgoing context. See [headroom trigger](compaction.md#headroom-trigger) and [orphaned tool-result repair](compaction.md#orphaned-tool-result-repair).

## Execution trace

`trace.assessment` (default `false`) adds a redacted `FabricAssessmentTraceV1` beside each `fabric_exec` execution trace: per-operation durations, model/Jev/classifier attribution, and token usage and cost where an operation reports them, plus program totals. It never stores arguments, results, code, or error prose, and the deterministic trace is unchanged. See [assessment projection](audit-trace.md#assessment-projection).

## Catalog repairs

Silent invocation repairs are on by default. `repairs.enabled` controls the catalog-scoped table at `~/.pi/agent/fabric/repairs/current.json`. Inspect it with `/fabric repairs`. See [catalog repairs](repairs.md).

Static compatibility compilation is on by default. `entropy.compile` enables proof-checked normal forms behind the existing tool interface; canonical schemas, enum domains, and action availability never change. Rules are available on the first call without a corpus, and the background loop persists schema-bound plans to `<agent dir>/fabric/entropy/compiled.json`. Version 1 restriction artifacts are inert and migrate automatically. Set `entropy.compile: false` to disable the normal-form path; `repairs.enabled` independently controls the learned catalog alias table. No extra model tools, arguments, or repair confirmations are introduced. Inspect witnesses and the observed invocation rejection rate with `/fabric entropy`. See [tool entropy](entropy.md).
