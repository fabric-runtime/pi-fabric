<div align="center">

<p>
  <img src="https://raw.githubusercontent.com/fabric-runtime/pi-fabric/main/media/opencollective/fabric-runtime/fa-avatar.png" alt="Pi Fabric logo" width="96" height="96">
</p>

# pi-fabric

**A programmable tool and agent runtime for [Pi](https://github.com/earendil-works/pi-coding-agent)**

_One program for tools, MCP, agents, workflows, actors, mesh, councils, and recursion._

<p>
  <img src="https://raw.githubusercontent.com/fabric-runtime/pi-fabric/main/media/banner.svg" alt="Animated banner: one checked TypeScript program weaving pi core tools, MCP servers, agents, and mesh into a single result" width="100%">
</p>

[![npm version](https://img.shields.io/npm/v/pi-fabric?style=for-the-badge&logo=npm&color=cb3837)](https://www.npmjs.com/package/pi-fabric)
[![ARC-AGI-3 scorecard](https://img.shields.io/badge/ARC--AGI--3-100%25%20across%2025%20envs-16a34a?style=for-the-badge)](https://arcprize.org/scorecards/d4c56c67-136b-4643-b648-62ae28fe2a54)
[![checks](https://img.shields.io/github/actions/workflow/status/fabric-runtime/pi-fabric/test.yml?branch=main&style=for-the-badge&label=checks)](https://github.com/fabric-runtime/pi-fabric/actions/workflows/test.yml)
[![pi extension](https://img.shields.io/badge/pi-extension-8b5cf6?style=for-the-badge)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-f4c430?style=for-the-badge)](LICENSE)
[![Open Collective](https://img.shields.io/badge/Open_Collective-support-151515?style=for-the-badge&logo=opencollective&logoColor=white)](https://opencollective.com/pi-fabric)

<p align="center">
  🏆 <strong><a href="https://arcprize.org/scorecards/d4c56c67-136b-4643-b648-62ae28fe2a54">100% on ARC-AGI-3</a></strong>. A Fabric-powered agent won <strong>all 25 environments</strong> in one 22.4-hour session with 4 minutes of human time ($1,349 in model spend).
</p>

</div>

---

Fabric gives Pi one programmable tool called `fabric_exec`, which composes core tools and MCP servers with captured extension tools. The default kernel runs checked TypeScript in isolated QuickJS; select sandboxed **Python (Monty)** with `executor.kernel: "python"`. CPython is an explicit native escape hatch via `executor.pythonRuntime: "cpython"`. The configured kernel is exclusive: there is no per-call language selector. Trusted TypeScript workloads can also use unsafe Node/Bun processes. Programs call host providers for agents, actors, and durable coordination, then return the result of their branches, loops, fan-out, and data flow. See [execution kernels](docs/kernels.md) for Python usage, security boundaries, and guest-helper limitations.

## Why Fabric?

|     | Capability | What it unlocks |
| :-: | ---------- | --------------- |
| ⚡ | **Code mode** | One flat tool schema; branching, loops, fan-out, and data flow live in TypeScript or configured Python. |
| 🧰 | **Capability routing** | Call Pi core tools, MCP servers, captured extension tools, or Fabric providers through one runtime. |
| 🧑‍🤝‍🧑 | **Agent runtime** | One-shot workers, durable resident agents, persistent event-driven actors, councils, and bounded recursive queries. |
| 🕸️ | **Workflows + mesh** | Phased progress plus durable topics, shared tasks, and compare-and-swap state. |
| 🛡️ | **Guardrails** | Approvals, isolation, timeouts, concurrency, recursion depth, and shared cost budgets. |
| 🎛️ | **Native TUI** | Live activity, an interactive dashboard, and settings without leaving Pi. |

## How it works

1. **You ask** in plain language.
2. **Pi writes one program** that calls the required tools and agents.
3. **TypeScript is statically checked** before execution; both kernels use the same authoritative host-call schema validation.
4. **The result returns** to your conversation. Intermediate work stays in the sandbox and appears in the activity panel and dashboard.

With the default TypeScript kernel, the model can write this program (TypeScript only):

```ts
const [manifest, sources] = await Promise.all([
  pi.read({ path: "package.json" }),
  pi.find({ pattern: "**/*.ts", path: "src" }),
]);
return {
  package: JSON.parse(manifest).name,
  sourceCount: sources.split("\n").filter(Boolean).length,
};
```

Independent calls run in parallel, and the returned object enters the model context. Known providers support concise direct calls such as `mcp.fal_ai.get_model_schema(...)`, `memory.recall(...)`, `state.get()`, `schema.status()`, and `compact.status()`. Refs found or computed at runtime use `tools.call({ ref, args })` (TypeScript notation). Python uses `await tools.call({"ref": ref, "args": args})`, native dictionary results, and `asyncio.gather` for independent calls.

To select Python, put this in `~/.pi/agent/fabric.json` or a trusted project's `.pi/fabric.json`, or use `/fabric settings` → **Executor** → **Kernel**:

```json
{ "executor": { "kernel": "python" } }
```

Python defaults to [Monty](https://github.com/pydantic/monty), a sandboxed Python subset with VM resource limits and no ambient filesystem, network, or process access. It is **not CPython**: arbitrary imports, third-party packages, and some Python features are unavailable. Full **CPython 3.10+** requires explicit `executor.pythonRuntime: "cpython"` and runs trusted native code with full OS privileges outside schema enforce, like TypeScript's Node/Bun escape hatches. CPython enforcement additionally requires macOS `sandbox-exec` or Linux `bwrap`, failing closed without isolation. Missing Monty dependencies never trigger a native fallback. `executor.runtime` only affects TypeScript. See [the kernel guide](docs/kernels.md).

Pi's native MCP can optionally supply selected servers beneath the same Fabric API: set `mcp.nativeServers` to exact server names already configured in Pi. Other servers stay on mcporter; failed native calls never switch transports. See [MCP ownership and compatibility](docs/configuration.md#opt-in-pi-owned-servers).

## Install

Requires Node.js 24+ and Pi 1.0.0+. Monty's optional native package installs on supported platforms; only the explicit CPython escape hatch requires CPython 3.10+. Fabric warns when a detectable host is older than the required native loadout and nested-execution contracts.

**0.103.1: Pi 1.0 compatibility.** Full-code and Schema enforce loadouts own declarations through native `prepareLoadout`, including built-in codemode, tool search, MCP, late activation, and reload. Captured dispatch and core overrides retain native middleware; capture patches restore on the final shutdown lease without recursive wrapping. Run `bun run test:pi1` for public-contract, compiled SDK, and bundled-CLI regressions. Optional/audit mode retains the host loadout.

**0.103.0: daemon primitives.** Headless, restart-safe sessions get small composable building blocks: a [runner contract](docs/agents.md#custom-runners) with hosted runs that persist a locator before start and never relaunch (`pi-fabric/runners`); durable [decisions](docs/decisions.md) with escalation chains, headless approvals, and routed child dialogs; mesh timers, scoped external grants, and the `pi-fabric` CLI; [saved programs](docs/programs.md) with host-invoked runs; host-issued principal and scope (`pi-fabric/scope`) that children only narrow; write confinement, context-inheriting spawn, and worktree results; provider participants, a foreground-tool policy, compaction pressure and carry-forward focus, [thinking control](docs/thinking.md), heartbeat liveness across PID namespaces, and incarnation-fenced control commands. New behavior is opt-in or additive. A configured `agents.runner` id that no extension registers is kept and warned about once per session, without falling back to `pi`.

**0.102.0: opt-in Pi-owned MCP.** Select native servers with `mcp.nativeServers` while keeping Fabric's API, policy pipeline, names/descriptions, and result normalization. Existing defaults remain unchanged. Native identities are indexed by registration snapshot, with live exposure and schema checks; SDK reload and settings-save guards are included.

**0.101.1: Pi 0.99 compatibility.** Full-code and Schema enforce modes declare only `fabric_exec`, including with native codemode, tool search, MCP, late registrations, and active-tool changes. Captured tools remain available as `extensions.<name>(...)` inside Fabric, with host middleware applied. Pi packages and TypeBox are host-supplied peers, never bundled. The same compiled package also passes an isolated Pi 0.99.1 SDK/CLI gate; development pins at that release were 0.99.0.

```bash
pi install npm:pi-fabric
```

<details>
<summary>Other install methods</summary>

From GitHub:

```bash
pi install git:github.com/fabric-runtime/pi-fabric
```

From a local checkout:

```bash
bun install
bun run build
pi install /absolute/path/to/pi-fabric
```

For one development run:

```bash
pi -e /absolute/path/to/pi-fabric
```

</details>

## What you can ask for

Pi loads advanced patterns after direct user invocation. Run `/skill:fabric-guide` for one recommendation, or invoke the exact `/skill:<name>` yourself. The same skill names work in both kernels: Fabric loads one complete TypeScript or Python skill/reference tree. An ordinary coding task uses the core `fabric-exec` reference.

| You want | Run |
| -------- | --- |
| Help choosing the smallest advanced mechanism | `/skill:fabric-guide Choose a mechanism to audit every auth file and verify the findings.` |
| Parallel audits, migrations, or research with verification | `/skill:fabric-workflow Audit every auth file and synthesize verified findings.` |
| Work too big for one context window | `/skill:fabric-rlm Produce a compact architecture map of this repo.` |
| A Jev foreman above coding work, per turn or at settlement | `/skill:fabric-foreman Watch this migration, request verification, and flag blockers.` |
| A persistent watcher for one measurable goal | `/skill:fabric-supervisor Watch this migration until it is complete and tested.` |
| A strict auditor for one feature design spec | `/skill:fabric-spec Implement docs/specs/checkout.md to the tee; nothing missing, nothing extra.` |
| A quiet decision-point reviewer | `/skill:fabric-advisor Focus on migration correctness.` |
| Same-model independent reviewers and one decision | `/skill:fabric-council Review this design for correctness, security, and operability.` |
| Multi-model compare-not-merge deliberation or act mode | `/skill:fabric-fusion Deliberate this design across models.` |
| One command that chooses advisor or supervisor | `/skill:fabric-ambient advisor Focus on migration correctness.` |
| A durable team coordinating through versioned tasks | `/skill:fabric-swarm Coordinate this migration across owned task partitions.` |
| A step graph that survives restarts, with human approval nodes | `/skill:fabric-graph Run fetch, test, and an approval gate before release as a resumable graph.` |
| Evidence-gated edits with postconditions | `/skill:fabric-schema Make this parser change only if focused tests stay green.` |
| Typed semantic judgments or bounded reactive loops | `/skill:fabric-jev Build a ticket triage loop with an explicit review path and evaluation budget.` |

Execution references stay progressive: the model loads the selected kernel's skill after argument-shape errors or when exact advanced contracts are needed. Kernel changes reload Pi so execution and the selected physical skill tree switch together; see [kernel-specific skills](docs/kernels.md#kernel-specific-skills-and-guidance).

## Agent conversations

Press **ctrl+shift+a** or run **`/fabric chat <agent-id-or-name>`** to open a live, full-screen child conversation with a multiline editor. Send steering or follow-ups directly, switch between nested agents, and return to Main without stopping its work. Drafts and scroll positions stay with each conversation. Completed one-shot agents are read-only; persistent actors accept further messages. Drag to select transcript text, use `/copy` or `/copy selection`, and type `/help` for the small set of preview-local commands with slash completion. See [focused conversations](docs/interface.md#focused-conversations) for controls and current limitations.

## The dashboard

Fabric includes a live activity surface in Pi:

- A compact widget above the chat (like `pi-supervisor`) whose header follows the current phase while its rows show active/completed agents, active actors, and their recent nested tool or code-change activity.
- `/fabric` (or `/fabric dashboard`): opens the **Activity** and **Topology** views. The user-facing Pi session appears as **Main**. You can queue or steer participants and inspect the project topology.
- `/fabric settings`: mirrors Pi's `/settings` and writes changes to `fabric.json`. TUI hosts get the searchable settings component; RPC hosts get the same nested sections, value/input/model pickers, list editors, and project/global save scopes through native dialog primitives.
- Code previews automatically highlight `.bend` files using Bend 2 syntax, including laws and proof terms. The grammar loads only when needed, with no Bend installation required.
- `Tool display` (`compact` by default, or `full`) is configured under `/fabric settings` → **UI**; compact elevates the declared display intent, hides the outer program, and applies to the current transcript immediately. Pi's tool-expand keybinding (`ctrl+o` by default) expands a compact card to the full transcript.

See the [interface & commands reference](docs/interface.md) for every view, keybinding, and slash command.

## Reference

- [Configuration](docs/configuration.md): `fabric.json`, code modes, tool capture, approvals, budgets, and [third-party model providers](docs/configuration.md#third-party-model-providers).
- [Execution kernels](docs/kernels.md): exclusive TypeScript/Python selection, Monty sandboxing, CPython escape hatch, agent inheritance, and examples.
- [Native codemode APIs](docs/codemode-parity.md): additive native tool aliases or opt-in Pi-compatible scripts, collision-safe Fabric discovery, native models/images, branch-local state, and sPTC.
- [Prompt cache](docs/prompt-cache.md): honest cache observations and optional, time-bounded native warming leases.
- [Thinking control](docs/thinking.md): scoped host-session reasoning effort with configured bounds that children inherit and never widen.
- [Durable Pi runner](docs/durable-pi.md): the default isolated Pi/Fabric host, checkpoint recovery, replay boundaries, and the explicit legacy `pi` option.
- [Durable decisions](docs/decisions.md): pending approvals and questions in the project mesh, headless approvals, routed child dialogs, `/fabric decisions`, and the `pi-fabric decisions` CLI.
- [Saved programs](docs/programs.md): content-addressed programs, nested `programs.run` with the caller's capabilities, `/fabric programs`, and host runs through `/fabric run` or an event.
- [Memory & recall](docs/memory-recall.md): compact ranked hits, uniform follow calls, lossless expansion, and guest-local `memory.walk` computation.
- [Extractive history](docs/extractive-history.md): opt-in native-classifier salience, source-preserving selection, bounded context, and deterministic fallback; configure it through JSON or the TUI.
- [Interface & commands](docs/interface.md): dashboard, settings, keybindings, slash commands, and headless runs.
- [Agents, actors & mesh](docs/agents.md): model handoff, `/fabric prewalk`, runners, transports, actors, councils, recursive queries, and durable coordination.
- [Durable residency through Pi](docs/residency-runtime.md): background host lifecycle and the Pi-runtime launcher boundary.
- [Harness CLI composition](docs/harnesses.md): use browser/macOS tools through their existing CLIs, without Fabric-specific bridges or component configuration.
- [Jev shell orchestration](docs/jev.md): bounded process supervision, event-driven task wait/watch, optional explicit typed judgments, and foreground/background budgets.
- [Components & committed capabilities](docs/components.md): supervised effects, exact requirements, external per-model guidance and execution-profile replacement, rolling provider generations, actor commitments, and both formal calculi.
- [External providers](docs/providers.md): the versioned provider protocol for extensions.
- [Architecture & security](docs/architecture.md): the host bridge, sandboxing, tool-call robustness, and limits.
- [Verified policy kernels](docs/verified-kernels.md): executable Bend proofs, production acceptance gates, regeneration, and the trusted boundary.
- [Provider capabilities](docs/provider-capabilities.md): proved dispatch, authority attenuation, lifecycle transitions, cancellation/cleanup contracts, and trust boundaries.
- [Catalog repairs](docs/repairs.md): unique extra keys and unknown actions promoted into silent schema maps.
- [Tool entropy](docs/entropy.md): static capability-preserving normal forms, deterministic invocation-friction metrics, bounded repair witnesses, and offline `certify:entropy` proof checks.
- [Speculative PTC](docs/speculation.md): pre-launching literal read calls while the program streams, with epoch + freshness guarantees.
- [Skills](docs/skills.md): the core-first invocation policy and user-invoked advanced patterns.

## Development

```bash
bun install
bun run check:fast
bun run test:smoke
bun run build
```

The test suite covers:

- configuration and schema validation
- provider dispatch, registered-tool execution, QuickJS isolation, and Pi built-in calls
- agent fixtures for Claude and Veda
- workflows, durable mesh state, actor mailboxes, subscriptions, and actor restoration

Claude and Veda fixtures use local test processes with zero billable requests.

## Support Pi Fabric

If Fabric helps you build or run agent workflows, consider [supporting the project on Open Collective](https://opencollective.com/pi-fabric). Contributions help fund maintenance, bug fixes, documentation, testing infrastructure, and model/API costs for integration testing and reproducible evaluations.

| Contribution | Monthly support | Helps sustain |
| --- | --- | --- |
| Backer | From $5 USD | Everyday maintenance and documentation |
| Supporter | $25 USD | Integration tests and reproducible evaluations |
| Sponsor | From $100 USD | Long-term development and project infrastructure |
| Custom donation | Any amount, one-time or recurring | The work that needs it most |

[Contribute →](https://opencollective.com/pi-fabric/contribute) · [View finances and contributors](https://opencollective.com/pi-fabric)

Contributions are voluntary support, not a purchase of priority support, feature delivery, or influence over the roadmap. The collective page shows current fiscal-host status, available contribution options, and financial contributors.

Code, documentation, bug reports, and examples are just as welcome. Thank you to everyone helping keep Fabric open and sustainable.

## Acknowledgments

- Thanks to [@hazrid93](https://github.com/hazrid93), whose request for a token-efficient LLM advisor pattern led to Fabric's advisor.
- Thanks to Chad Gibson at [Neuralwatt](https://neuralwatt.com), who supported extended tests of long MCR sessions and the related debugging work.

## License

MIT
