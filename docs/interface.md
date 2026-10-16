# Interface & commands

Fabric builds its UI on the public `pi-code-previews` cooperative shell and on a general-purpose, theme-aware activity surface. You do not need to install `pi-code-previews` separately.

## Code previews

`fabric_exec` inherits the user's border/background mode, collapsed-result behavior, error styling, and tool-call timing. It does not take ownership of Pi's built-in tool renderers. Its renderer adds a numbered TypeScript preview, live phase and call activity, and compact phase and nested-call summaries. Preview settings live in the unified Fabric configuration: the `codePreview` section of `~/.pi/agent/fabric.json` (global) or `.pi/fabric.json` (trusted project). You can edit them live under `/fabric settings` → **Code previews**. Fabric no longer reads the standalone `code-previews.json` file or the `codePreview` keys in Pi settings. `codePreview.shikiTheme` defaults to `"auto"`. That value tracks Pi's resolved light/dark variant (GitHub Light on light terminals, Dark+ on dark) as Pi auto-switches. A `"<light>/<dark>"` value pins both variants. Any other value fixes one shiki theme.

Nested `pi.read`, `pi.bash`, `pi.powershell`, `pi.grep`, `pi.find`, `pi.ls`, `pi.write`, and `pi.edit` calls share the preview settings and presentation vocabulary of `pi-code-previews`: offset-aware read gutters, syntax and secret warnings, grouped and highlighted grep matches, iconized path trees, bash warnings and output metadata, and proposed or applied edit and overwrite diffs with compact context, line gutters, full-row backgrounds, and word-level emphasis. Large inputs fall back to escaped plain text with an explicit notice. The same layer renders in-memory Activity call details. Fabric keeps rich call data only in current-session renderer and activity state. Durable traces keep their existing bounded confidentiality projection.

Fabric keeps its orchestration-specific behavior around those previews. Multi-call rows stay compact, and live write composition with phase/call progress stays visible during the run. Agent and actor audits can expose their current child tools directly in the parent card, with owner, runner, and run metadata. One execution-wide throttle coalesces parallel nested-call updates before they reach Pi, and continuous streams are not starved. Long ANSI rows are bounded without clearing the enclosing tool background. The widget lease plus result-to-source row transfer keep completion height stable. The highlighter initializes lazily and falls back to plain text until it is ready. When Pi switches between its light and dark variants, the highlighter swaps themes live. Collapsed previews use the configured expand keybinding, for example `Ctrl-O`.

## Background shell tasks

`/fabric tasks` or **Ctrl+Alt+T** opens a live task inspector without interrupting Main. The widget keeps detached commands visible with their ID, purpose/command, elapsed time and access hint. A single task opens directly; Enter inspects a selected task, arrows scroll its bounded output tail, **x twice** stops it, and Esc returns to the list or closes. The detail shows cwd, PID, exit status, output path, elapsed time separately from time since last output, and monitor delivery/deadline. Completion hints last 30 seconds; retained jobs remain inspectable.

See [Background tasks and monitors](background-tasks.md) for completion delivery, task controls, opt-in UI-only versus agent-waking monitors, limits, and cancellation.

## Widget activity

The bottom widget lists running agents and actors. Press **ctrl+shift+e**, run **`/fabric focus`**, or click a row to focus it. Then **↑↓** or **j/k** selects a row and **Enter** or **Space** expands it: the participant's live activity opens inside the widget, below the list, not in a floating window. It shows streamed thinking, each tool call with its arguments and status, replies, and errors, newest at the bottom. While a pane is open, **↑↓** switches participants, **PgUp/PgDn** or the mouse wheel scrolls, and **G** returns to the newest line. **Enter** or a second click collapses the pane. **Esc** collapses first, then returns focus to the editor; while the widget has focus, Esc does not halt background workers. Any other key returns focus to the editor and reaches it, so typing, Ctrl+C, and shortcuts keep working; only a click on a participant row takes focus. An expanded widget stays within half of the terminal height. With Pi's `hideThinkingBlock` setting, the pane shows the thinking marker without the reasoning text. The dashboard transcript does not show reasoning.

## Focused conversations

Press **ctrl+shift+a** or run **`/fabric chat`** to open a full-screen conversation without going through the dashboard. `/fabric chat <id-or-name>` opens a specific agent or actor; Tab completes exact participant IDs, including nested agents. Ambiguous names or ID prefixes are rejected; use an exact participant ID to select the intended target. In the dashboard, **Shift+C** opens the selected participant.

The first implicit open prefers a currently active child over stale history; later opens remember a valid selection. The view keeps a lossless native Pi transcript and a multiline Pi editor together, independently of the dashboard’s bounded transcript projection. It uses Pi’s real user, assistant, thinking, tool, skill, custom-message, and summary components, including registered tool renderers such as `fabric_exec`, with complete tool details and native expansion behavior. User backgrounds and editor rules span the terminal width, with Pi's configured output padding, editor padding, and code-block indentation inside them. Markdown and tool previews use the configured Shiki theme. A one-row gap belongs to the transcript's end, not the fixed input dock, so it scrolls away and leaves history unobstructed. While the selected participant is active, the native-style `Working` indicator stays in the editor border; the transcript uses a fallback only when that border is out of view. The directory/name footer row includes a compact `read-only` badge when needed; status, model, and thinking metadata are not repeated in a separate header. The footer below the editor shows the selected participant's directory, known branch, model, thinking level, and run-scoped token/cache/cost statistics. Unknown usage and context occupancy are marked explicitly; Main's statistics are never substituted. A themed, background-filled target badge sits on the upper-right editor border, replacing the standalone transcript breadcrumb. It preserves `Main > child > grandchild` lineage when space permits, prioritizes the active target on narrow terminals, and marks read-only targets. Native working and draft-scroll labels share the border without adding a row. Main and other participants keep running: opening, navigating, and closing the view never calls Pi's session-replacement API or starts another worker. Selecting Main restores the original Pi conversation, including its editor. Child drafts and scroll positions survive switching targets and reopening the view for the lifetime of this Pi session.

The transcript also follows Pi 1.0's fullscreen scrollbar setting (`auto`, `always`, or `hidden`), theme colors, hover/drag behavior, and auto-hide timing. Only an always-visible scrollbar reserves a transcript column; the editor and footer keep their full width. The thumb describes the loaded history window; existing wheel, page, and top commands continue to fetch older history. While scrolled away from the tail, or when newer history is not loaded, the native-style **↓ Jump to latest message · End** indicator appears at the transcript bottom. Its shortcut label follows Pi's configured binding. Click it or use the shortcut to load the latest history and resume following, without losing the draft or editor focus. Selection drags do not activate it.

The composer also uses Pi's native **up/down prompt history**, including configured `tui.editor.historyPrevious` / `tui.editor.historyNext` bindings. Up browses previous prompts from an empty editor or the start of its first visual line; multiline/wrapped arrows still move the cursor normally. Down returns toward newer prompts and restores the draft and cursor you had before browsing. Each target keeps its own newest 100 trimmed prompts, with consecutive duplicates suppressed, across switches and reopening. History is lazily seeded once from that target's currently loaded user text (direct actor envelopes are unwrapped), then remembers ordinary steering/follow-up submissions, parked follow-ups, and submitted slash commands (including failed attempts) in chronological order. Slash entries are ephemeral: they remain only in this target's bounded editor memory for the current Pi session, never in the agent transcript or sent to the model. History does not fetch additional pages or include shell commands, rejected read-only prose, assistant/tool output, or Main's history. Send attempts are remembered as in Pi; failures still preserve the draft. Pasted prompts are sent and recalled as full text, not paste markers. Completion lists retain arrow priority, and queue-row editing uses a separate history-free editor. Resetting the parent session clears local history.

Drag across transcript text to select it in either screen mode. Selection uses display-cell coordinates and keeps a stable history snapshot while output streams; it never selects hidden Main content. Releasing the mouse copies automatically when Pi's `fullscreenCopyOnSelect` setting is enabled (the default). Otherwise use the configured copy shortcut (`ctrl+shift+c` by default), `ctrl+c` with an active selection, or `/copy selection`. Escape clears selection first; a second Escape closes. Scrolling after release, resizing, switching targets, changing tool/thinking expansion, and `/latest` clear the selection. Dragging with the wheel can select across already loaded history; load older pages before starting a selection.

The preview has a small, local command allowlist with slash/Tab completion:

| Command | Preview action |
| --- | --- |
| `/copy` | Copy the selected participant's last assistant response as plain source text/Markdown, including for completed read-only runs. Thinking and tool results are excluded. If newer history is unloaded, use `/latest` first. |
| `/copy selection` | Copy selected transcript text, without terminal styling/control sequences. |
| `/latest` | Clear selection and follow the latest output. |
| `/help` | List preview commands. |
| `/agents` | Open the target picker. |
| `/back` | Return to Main. |
| `/stop` | Confirm stopping the selected live participant. |

These commands are not registered on Main and are never sent as agent messages. Other slash commands and shell-prefixed input remain blocked, including queued edits. Clipboard failures are reported in the preview without affecting Main or a newer draft.

Slash-command results use Pi's native-style conversation notifications: dim status text and themed `Error:` messages, with native padding and wrapping, inside the scrollable transcript, separate from the temporary header. The latest result stays visible while typing and replaces the previous command result; it is cleared when leaving the conversation, changing targets, or resetting the session. Results are revealed at the end of the currently loaded window without fetching newer history. `/copy` and `/copy selection` show `Copying…` immediately, reserving the wrapped result's space as autocomplete closes; clipboard completion replaces it in place, with no notification-less intermediate frame. Scrolling during the copy is respected, and a late result cannot overwrite a newer command notification. This is a bounded, preview-local result display, not a full notification log; mouse/shortcut and queue feedback are unchanged.

| Control | Action |
| --- | --- |
| Enter | Send a steering message to the selected live participant |
| Follow-up key (Alt+Enter by default; Ctrl+Q on Windows) | Queue a follow-up for the selected participant |
| Shift+Enter | Insert a newline |
| Ctrl+N or `/agents` | Open the searchable participant picker |
| Alt+Left / Alt+Right at an empty editor | Navigate to parent / first child |
| Ctrl+Tab / Ctrl+Shift+Tab | Cycle conversations |
| Mouse wheel / configured Pi scroll keys | Scroll locally and fetch older history; prompt, line, and page jumps work in both TUI modes |
| End | Follow the latest output |
| Pi's tool-expand key (Ctrl+O by default) | Toggle tool details |
| `/stop` | Explicitly stop the selected participant after confirmation |
| Esc or `/back` | Return to Main without interrupting any agent |

The participant picker groups **Active** targets (including Main, even when idle) above **Inactive** targets, newest activity first within each group. Stale owners are inactive. Grouping, ordering, and new arrivals are held until you leave and reopen the picker, so live activity cannot reshuffle rows while you browse or search; statuses and unread markers still update. Removed targets disappear immediately. Parent/child navigation remains available outside the picker.

Direct actor messages appear as normal user text, with paired RPC start/end events shown once. Session branches and compaction remain authoritative over overlapping RPC history. Native message errors remain visible. Use `/fabric log <id>` to inspect worker startup diagnostics. The widget advertises `ctrl+shift+a chat` only while an agent or actor is active, and removes the hint when work settles. The command and shortcut remain available for idle and historical conversations.

Pending messages use Pi’s native labels and spacing. When a compatible loaded `pi-queue-steer` provides `queue-steer:conversation-queue:request:v1`, the view uses its actual per-target queue, execution-outline widget, and inline editor. A stopped actor’s Alt+Enter input is parked for editing or explicit Enter release. Accepted sends remain visible until native delivery is observed; they cannot be retracted or edited locally. Queues stay isolated from Main and other targets, survive preview close/reopen within the session, and are cleared on session reset. Older queue-extension releases without the bridge use the native display.

Messages use the same ownership-aware route as `agents.steer` / `agents.followUp`. A failed delivery keeps the draft. Capability and lifecycle checks run again at dispatch, so a child that finishes while you type cannot silently receive a message in Main or be respawned. Persistent actors accept subsequent mailbox messages, including while idle. Finished one-shot runs remain readable but cannot continue; Veda one-shot runs do not support mid-run messaging. A remote participant without an accessible transcript shows an explicit transcript-unavailable notice.

This is a focused view over the existing worker, not a second native Pi runtime. Other Pi slash commands, shell shortcuts (`!`), and child extension dialogs are not routed through this view. Unsupported commands are rejected visibly, never forwarded to Main. Native image attachment and full command/extension parity require a separate worker attachment protocol. The existing dashboard retains model, actor-policy, and configuration controls.

### Conversation performance checks

Unchanged history reuses native component rows and transcript projections. Inactive readers offload their loaded history to private temporary checkpoints; restoring them preserves pinned pages and scroll state even when the original run files are unavailable. Checkpoints are removed after restoration or session cleanup. A checkpoint write failure leaves the existing in-memory history intact.

`bun run benchmark:conversation` builds the extension and runs local synthetic preview benchmarks. The JSON report covers unchanged and typing frames, history paging and append updates, native component update counts, queue synchronization, target lookup, and retained heap after cumulative tool-progress events. No model calls or real session data are used. Run benchmarks serially on the same machine for useful before/after comparisons; timings are diagnostic, not CI thresholds.

After a build, run an individual scenario with `node --expose-gc scripts/benchmark-conversation.mjs latency` (or `append` / `retention`). Correctness tests enforce operation counts and preserve native rendering, history, queues, and lifecycle behavior.

## Incremental activity reads

The activity controller owns a revisioned read view over the existing activity store.
Unchanged runs and rows retain identity; changing one call does not copy every retained
call's arguments, results, or previews. The poll snapshot cache shares these immutable
projections while continuing to copy and inspect externally mutable participant domains.
Run ordering and membership still follow the existing lifecycle and recency rules.

The internal `FabricActivityStore.createRunView()` returns an independent reader. Calling
it without an argument reads payload-free summaries; `read(true)` includes full detail.
The returned outer list is independently sortable, but runs, rows, metrics, and nested
payloads are frozen. Readers do not consume one another's changes. Revisions, not wall-clock
timestamps, invalidate same-millisecond changes. Switching detail mode drops the reader's
old cache, reset/pruning disappear on its next read, and stopping the controller releases
its reader. Weakly keyed row caches cannot keep removed source records alive.
`runs()`, `get()`, and `runSummaries()` retain their isolated, mutable-copy contracts.
This is an internal UI API, not another guest capability, registry, or event log.

Repeated normalized progress, entity, or metric values do not advance activity timestamps
or revisions and do not schedule another refresh. Real changes still use the configured
update debounce. Explicit workflow events, call completion, failures, cancellation, native
transcript polling, and live animation retain their existing behavior. Progress messages
are presentation state, not execution-owner heartbeats. No retention, authorization,
selection, layout, or durable-audit policy changes accompany this optimization.

Run `bun run benchmark:activity` for synthetic source-level projection latency, row
replacement counts, duplicate-progress notifications, and retained heap after repeated
reset/repopulation. `bun run benchmark:activity 1` probes a single live run; the default
includes 12 retained/live runs with 300 calls each. The script bundles the source subject
in memory and makes no model calls. Timings are diagnostic, not CI thresholds or whole-UI
speedups; the controller already skips activity reads at unchanged revisions. Tests pin
snapshot equivalence, sharing counts, independent readers, and lifecycle transitions.

## Activity surface

Fabric ships a general-purpose, theme-aware activity surface that works with any agent setup:

- A compact widget above the chat (like `pi-supervisor`) follows the current phase in its header. It lists active and completed one-shot agents plus active actor workers. Their recent or running child tools nest beneath the owner, with compact edit/write change lines and owner metadata. Extensions, custom items, and shared tasks/state stay summarized by the header or appear in the dashboard, so they never occupy widget rows. Finished agent rows remain for 30 seconds after each agent finishes, matching completed shell rows, then disappear individually even without new activity. Heartbeat/control refreshes do not renew that display lease. Expiry shrinks the natural widget height and updates the overflow count without blank padding; results, logs, dashboard entries, and historical chats remain available. Active agents and idle resident agents/actors are not aged out. The latest completed run summary retains its existing lifetime until a newer run replaces it. Snapshot bounds first preserve every active local agent, then local history, and only then admit remote project records. When a collapsed Fabric result becomes shorter at completion, the card reveals a bounded number of otherwise hidden TypeScript source lines. Those lines replace the removed rows without blank padding, and any residual deficit shrinks naturally.
- `/fabric` (or `/fabric dashboard`) opens a responsive interactive overlay with two views: **Activity** and a unified **Topology**. Press `1` for Activity and `2` for Topology.
  - **Activity** lays out the workflow phase sidebar on the left and the selected phase's activity on the right. The user-facing Pi agent is always present as **Main**, including when no Fabric child exists and regardless of the status filter. Main remains an actionable queue target. The right pane orders entities under type headings for agents, actors, tools, extensions, tasks, custom items, and shared state, with a blank row between groups. The selectable order matches the rendered group order. One-shot agents stay stable in creation order. Attention-priority work keeps the default focus, so Main does not steal it.
  - **Topology** merges the selected retained run with the live project mesh in one graph rooted at **Main**. It deduplicates agents observed through both run and participant data, and it separates execution membership from coordination infrastructure:

    ```text
    Main
    ├─ Participants
    │  ├─ Sessions       peers and remote root Pi sessions
    │  ├─ Agents         local, remote, and recursively owned agents
    │  └─ Actors         local and remote persistent actors
    └─ Mesh
       ├─ Topics
       │  ├─ Fabric      fabric.state, fabric.schema, and fabric.<family>.*
       │  └─ Project     arbitrary topics grouped by their first namespace
       └─ State
          ├─ World state
          │  ├─ current
          │  ├─ goal
          │  └─ Complexity
          │     └─ <project directories> → <file ledger>
          ├─ Schema
          │  ├─ workspace
          │  ├─ Hypotheses → <id>
          │  ├─ Certificates → <token hash>
          │  └─ <future schema namespaces>
          └─ Project state
             └─ <key directories> → <entry>
    ```

    Explicit ownership stays intact below those categories. Recursive agents nest under their parents. Actor workers remain under their actor, and remote descendants keep their place under the remote root. State ownership uses a mesh relationship. Owned state remains in the State tree. A state entry that identifies a project-relative file (including every `state/complexity/<file>` ledger) exposes a bounded, line-numbered Shiki source preview in both the topology inspector and full dashboard detail. The preview resolver rejects absolute paths, traversal, symlink escapes, non-files, and binary content. It caches by real path, mtime, and size. Internal membership and control keys (`topology/*`, legacy `sessions/*`, and actor registry `actors/*`) are filtered from shared state, because their canonical entities already appear under Participants. Global actor templates are absent because they are not running project nodes.
  - Topic names accept `.`, `:`, and `/`. A `fabric.*` topic uses the Fabric branch. Every other name uses Project topics, grouped by its first namespace. Built-in host traffic includes `fabric.actor.*`, `fabric.control.*`, `fabric.participant.lifecycle`, `fabric.steer`, and `fabric.compact`. System-only topics stay suppressed as standalone nodes unless someone explicitly subscribes to them, and their traffic can still appear in the bounded event feed. State keys preserve `/` hierarchy. The known durable families are `state/current`, `state/goal`, `state/complexity/<file>`, `schema/workspace`, `schema/hypothesis/<id>`, and `schema/certificate/<hash>`. Every other visible mesh key falls back to Project state without losing its directory structure.
  - The graph renders status-coloured node shapes, orthogonal connectors, animated traffic, an optional fixed-width selected-node inspector, and directional off-canvas summaries. Traffic follows the same structural branches through the source/target lowest common ancestor. It never draws direct lines through unrelated subtrees. A large or deeply recursive graph opens around the attention-priority node. When you move between nodes, a damped spring camera retargets smoothly and the viewport does not snap. Live and replay animation drives renders only while the dashboard is open. Narrow terminals keep the centred graph and drop the inspector.
  - Retained-run selection works as a lens over the same topology. Pressing `[` or `]` changes the highlighted run and its phase context, and live actors and remote project participants stay visible. Route records remain selectable, and they aggregate repeated traffic by source, target, topic, and kind. The recent event feed is a bounded live window. It does not replace audit history.
  - **Inspection and control** work the same way in both views. Agent detail includes Markdown-rendered tasks and results, highlighted YAML values, model, current tool, usage, worktree, and attach metadata. Tool-call details show highlighted command, file, and edit inputs, with Markdown or YAML outputs. Persisted bash calls keep their command text. Space peeks at an agent or actor transcript. `t` toggles between summary and transcript detail. The initial bounded tail is paged directly from Pi RPC, Pi session, and Claude stream-JSON logs. At the loaded top, `k` or Up fetches one older page, `g` loads and jumps to the true beginning, and `G` jumps to the growing tail and resumes follow mode. Assistant text uses native Markdown. Tool calls retain structured arguments and results, so they get the same read, bash, search, edit, and write previews as the parent card. Credential and token redaction applies before rendering. You can steer Main and active one-shot agents or queue them a follow-up, and one-shot agents can also be stopped safely. Persistent actors accept `s` mailbox messages. Where configured, they expose model (`m`), thinking (`e`), the complete session-bound Pi host-event catalog (`v`), instructions (`i`), mailbox clearing (`c`), and export (`x`). Remote participants expose only their advertised capabilities. Control resolves their owner and reports success after acknowledgement. From Activity, global templates stay available for import (`p`), instruction editing (`i`), and deletion (`d`).
- `/fabric settings` opens an inline settings view that mirrors Pi core's `/settings`, with top and bottom borders, fuzzy search, and section submenus, and it writes changes to `fabric.json`. Trusted projects default to `<project>/.pi/fabric.json`. Pressing **Ctrl+G** anywhere in the view switches both the displayed configuration layer and the save destination between project and global `~/.pi/agent/fabric.json`. The global view keeps global edits visible even when a project override remains effective, and its scope banner states that precedence explicitly. Untrusted sessions stay global-only. In RPC hosts, the same hierarchy is exposed through recursive select/input dialogs; a root save-scope action replaces the Ctrl+G shortcut, while Back returns one section at a time. Full code mode, capture, executor, approvals, and UI changes apply immediately when they change the effective configuration. Mesh, agent, retention, and MCP changes persist and take effect on the next `/fabric reload`. The UI section includes **Tool display** (`full` by default or `compact`), a default-on **Agent tool preview** toggle, and a global **Update debounce** (`0`/Off through `1000ms`, default `100ms`); all apply immediately. Compact display makes the declared Fabric display name/description the card header, hides outer TypeScript at every expansion level, and retains bounded nested tool details. The Agents section selects the default runner, keeps independent Pi and runtime-enumerated Claude model pickers, and exposes free-text Veda backend, persona, and model fields for the Veda runner. List editors for `agents.defaultTools` and `capture.keepVisible` toggle known tools on and off. The `keepVisible` candidates include `fabric_exec` plus every captured extension tool; this legacy preference cannot override full-code or Schema enforce mode's sole `fabric_exec` model declaration on Pi 0.99.

### Keybindings

- In `/fabric settings`, **Ctrl+G** switches the displayed values and the save destination between project overrides and global defaults. Untrusted sessions remain global-only.
- Press `1` for Activity and `2` for the unified Topology. In Topology, arrow keys move spatially between graph nodes, `h`/`l` mirror left and right, `j`/`k` follow deterministic entity order, and Tab advances to the next node. In Activity, arrows or Tab switch panes and select rows. `g` and `G` jump to the first and last selectable entity, Enter inspects, `f` cycles status filters, `[`/`]` change the retained-run lens, and `?` opens contextual help.
- On Main, `s` sends a user-authored message or steer, and `u` queues a user-authored follow-up through Pi's host queue.
- On agents and actors, Space peeks at the transcript and `t` toggles transcript/summary detail. Inside a transcript, `g` loads and jumps to the true top, and `G` jumps to the bottom and follows new output. On active one-shot agents, `s` opens a steer editor, `u` queues a follow-up, and pressing `x` twice stops the run. Remote participants expose capability-aware, owner-acknowledged `s`, `u`, and `x` controls.
- On actors, `s` queues a serial mailbox message. Lowercase `m` and `e` change this Pi session's model and thinking. Uppercase `M` and `E` change the shared project defaults and appear only on the owner. Actor detail shows both layers, the effective values, and the live owner.
- Owner views also expose `v` for host events, `i` for instructions, and other shared actor settings. Passive views hide those controls but keep session bindings, messaging, reads, and `x` export. `p` imports a global template, `d` deletes one, and Esc backs out or closes.

## Data-driven activity

The surface is data-driven. Fabric automatically instruments nested provider calls, agents, persistent actors, and task-shaped mesh entries. A workflow can add domain-specific labels and arbitrary progress, and it needs no extension UI code:

```ts
await workflow.configure({ name: "Release train", description: "Build, verify, and publish" });
await phase("Build", { total: packages.length });
await workflow.item({
  id: "docs",
  label: "Documentation",
  status: "running",
  completed: 2,
  total: 5,
});
await workflow.event({ message: "Canary passed", level: "success" });
```

External Fabric providers can emit structured `context.activity()` updates for an entity, a progress message, or metrics. The TUI stays generic, and a virtual provider can still expose richer live state.

```ts
async invoke(actionName, args, context) {
  context.activity?.({ type: "entity", id: job.id, kind: "custom", name: job.name });
  context.activity?.({ type: "progress", message: "Indexing package 3/12" });
  context.activity?.({ type: "metrics", tokens: 4200, toolCalls: 9 });
  return job.result;
}
```

## Commands

```text
/fabric status
/fabric dashboard
/fabric chat [participant-id-or-name]
/fabric tasks [task-id]
/fabric settings
/fabric reload
/fabric providers
/fabric captured [query]
/fabric agents
/fabric actors
/fabric messages <actor-id>
/fabric attach <agent-id>
/fabric stop <actor-or-agent-id>
/fabric repairs
/fabric entropy
/fabric decisions [id]
/fabric programs [promote <ref>|retire <ref>]
/fabric run <ref> [json input]
```

`/fabric decisions` lists open [durable decisions](decisions.md) and answers the picked one through native dialogs.

`/fabric programs` lists [saved programs](programs.md) with their status; `promote` and `retire` are the only way to change one. `/fabric run` executes a saved program without the model, with the same approval policy as a model call, and shows the result in the transcript.

Actor slash commands mirror the [global template API](agents.md#global-actor-templates). `/fabric global` lists templates. `/fabric import <name> [as <new>]` stamps one into the project. `/fabric export <id> [--overwrite]` promotes a project actor. `/fabric log <id>` previews an actor or run transcript, and `/fabric export-log <id> [path]` writes the raw `session.jsonl` plus retained `runs/` to disk.

## Headless focused agents

Pi already runs one-shot, non-interactive agents with `pi -p` (`--print`), and it reads piped stdin as part of the prompt. A focused agent composes with pipes, cron, git hooks, and CI like a Unix program, and it needs no wrapper:

```bash
git diff | pi -p --no-session -t read,grep "Review this diff for concrete defects."
pi -p --no-session --mode json -e <path-to-pi-fabric> "Map the persistence layer."
```

`--no-session` keeps the run ephemeral. `-t` restricts the tool allowlist. `--mode json` emits a structured event stream for scripting through `| jq`. `-e <pi-fabric>` loads Fabric so the agent can use `fabric_exec`. If your settings also install Fabric, the `-e` copy wins and the settings copy stays inactive. The process exits non-zero on failure. Run `pi --help` for the full flag list.
