import type { SettingItem } from "@earendil-works/pi-tui";
import type { SettingsSectionContext } from "./settings-section-context.js";
import {
  setting,
  sectionSubmenu,
  thinkingSubmenu,
  modelPickerSubmenu,
  listSubmenu,
  stringInputSubmenu,
  numericSubmenu,
  nonNegativeIntegerSubmenu,
} from "./settings-submenus.js";
import {
  summaryFor,
  BOOLEANS,
  PREWALK_MODES,
  PREWALK_THINKING_INHERIT_LABEL,
  PREWALK_MODEL_UNSET_LABEL,
  formatToolCount,
  CORE_DEFAULT_TOOL_CANDIDATES,
  RUNNERS,
  TRANSPORTS,
  formatUsd,
  BUDGET_VALUES,
  formatTokens,
  TOKEN_VALUES,
  formatMs,
} from "./settings-values.js";
import { thinkingLabel } from "../thinking.js";
import { INHERIT_VALUE } from "./model-picker.js";

export const buildTunerSection = (
  { config, theme, options, persist }: Pick<SettingsSectionContext<"modelSource">, "config" | "theme" | "options" | "persist">,
): SettingItem => {
  return setting("tuner", "Tuner", summaryFor("tuner", config), {
    description: "Learned rules in the system prompt, and rule suggestions from the tool failures of your sessions.",
    submenu: sectionSubmenu(
      theme,
      "Tuner",
      "Learned rules for this environment. See docs/tuner.md.",
      // A factory: the model source is discovered only when the section opens.
      () => [
        setting("tuner.enabled", "Use learned rules", config.tuner.enabled ? "true" : "false", {
          description: "Add <agent-dir>/fabric/tuner/learned.md to the system prompt. Fabric reads the file one time for each session.",
          values: BOOLEANS,
        }),
        setting("tuner.capture", "Suggest rules from sessions", config.tuner.capture ? "true" : "false", {
          description: "Record repeated tool failures and your corrections, and let the proposer write a rule suggestion. Decide with pi-fabric tune review, accept, and reject.",
          values: BOOLEANS,
        }),
        setting("tuner.autoAccept", "Accept with no review", config.tuner.autoAccept ? "true" : "false", {
          description: "Write each suggestion to learned.md with no review. A suggestion has no score and can be wrong. pi-fabric tune undo removes the last edit.",
          values: BOOLEANS,
        }),
        setting("tuner.proposerModel", "Proposer model", config.tuner.proposerModel || INHERIT_VALUE, {
          description: "Pi provider/model that writes the rule edits. Inherit uses the default model of Pi.",
          submenu: modelPickerSubmenu(theme, options.modelSource, {
            headerText: "Proposer model for pi-fabric tune and for rule suggestions.",
          }),
        }),
      ],
      persist,
    ),
  });
};

export const buildPrewalkSection = (
  { config, theme, options, persist }: Pick<SettingsSectionContext<"modelSource">, "config" | "theme" | "options" | "persist">,
): SettingItem => {
  return setting("prewalk", "Prewalk", summaryFor("prewalk", config), {
    description: "Continue Main in place or opt into a child trajectory handoff at the completed fabric_exec boundary.",
    submenu: sectionSubmenu(
      theme,
      "Prewalk",
      "Automatic continuation at the completed outer fabric_exec boundary.",
      () => [
        setting("prewalk.enabled", "Enabled", config.prewalk.enabled === false ? "false" : "true", {
          description:
            "Master switch for prewalk. When off, manual arming, session auto-arm, and boundary claims are all inert until re-enabled. Same effect as /fabric prewalk --disable and --enable; a live arm is cancelled on disable.",
          values: BOOLEANS,
        }),
        setting("prewalk.mode", "Mode", config.prewalk.mode, {
          description:
            "In-place temporarily switches Main to the executor, queues a hidden continuation, then returns to Main's previous model when that continuation settles, when a new session is still on the executor, or when prewalk is cancelled. Trajectory moves the session snapshot to a visible child executor, then queues a hidden verify-and-summarize continuation for Main when it finishes.",
          values: PREWALK_MODES,
        }),
        setting(
          "prewalk.alwaysRearm",
          "Always re-arm",
          config.prewalk.alwaysRearm ? "true" : "false",
          {
            description:
              "Arm prewalk automatically at every session start and again after each completed handoff until /fabric prewalk --off cancels it for the session. Auto-arm needs prewalk.model (provider/model). Read-only turns never disarm prewalk.",
            values: BOOLEANS,
          },
        ),
        setting(
          "prewalk.requirePlan",
          "Plan checkpoint first",
          config.prewalk.requirePlan ? "true" : "false",
          {
            description:
              "Frontier-first planning: on the mutation boundary that would hand off, ask Main to write the plan (outcome, remaining steps, exact files, verification) and keep working on the frontier model. The handoff then fires at the next successful mutation, and Fabric delivers the recorded plan directly in the executor continuation or task. After two reminders without a plan it hands off unplanned with a warning. Disable to hand off on the first mutation, as before.",
            values: BOOLEANS,
          },
        ),
        setting(
          "prewalk.detectShellWrites",
          "Detect shell writes",
          config.prewalk.detectShellWrites ? "true" : "false",
          {
            description:
              "Filesystem fallback trigger: when an armed task ran a successful pi.bash or pi.powershell in fabric_exec without an audited pi.edit / pi.write / schema.commit, claim the handoff if file stats drifted from baseline, so shell heredocs, sed -i, or formatter-binary writes also reach the executor.",
            values: BOOLEANS,
          },
        ),
        setting(
          "prewalk.compactOnReturn",
          "Compact on return",
          config.prewalk.compactOnReturn ? "true" : "false",
          {
            description:
              "After an in-place continuation settles, compact the session with the configured compaction engine just before Main's boundary model is restored, so Main re-ingests a compacted transcript rather than the executor's full scratch work.",
            values: BOOLEANS,
          },
        ),
        setting(
          "prewalk.thinking",
          "Thinking",
          config.prewalk.thinking
            ? thinkingLabel(config.prewalk.thinking)
            : PREWALK_THINKING_INHERIT_LABEL,
          {
            description:
              "Reasoning effort for the trajectory child executor. Agents default inherits Agents › Default thinking; in-place keeps Main's session level. The level is clamped to each model's supported levels.",
            submenu: thinkingSubmenu(theme, {
              title: "Prewalk thinking",
              description:
                "Reasoning effort for the trajectory child executor. Agents default uses the Agents section's Default thinking; in-place keeps Main's session level. Clamped to each model's supported levels (next highest if unsupported).",
              inheritLabel: PREWALK_THINKING_INHERIT_LABEL,
            }),
          },
        ),
        setting(
          "prewalk.model",
          "Executor model",
          config.prewalk.model || PREWALK_MODEL_UNSET_LABEL,
          {
            description:
              "Pi provider/model used by /fabric prewalk. In-place selects it for Main; trajectory uses it for the child executor. Ask each time is interactive only.",
            submenu: modelPickerSubmenu(
              theme,
              options.modelSource,
              {
                headerText:
                  "Executor model for automatic /fabric prewalk continuation. Pick Ask each time to open the model picker for every prewalk.",
                inheritLabel: PREWALK_MODEL_UNSET_LABEL,
                inheritName: "Open the model picker whenever prewalk is armed",
              },
            ),
          },
        ),
      ],
      persist,
      { refreshOnChange: false },
    ),
  });
};

export const buildAgentsSection = (
  { config, theme, apply, options, persist }: Pick<SettingsSectionContext<"modelSource" | "claudeModelSource">, "config" | "theme" | "apply" | "options" | "persist">,
): SettingItem => {
  const defaultToolsItem = setting(
    "agents.defaultTools",
    "Default tools",
    formatToolCount(config.agents.defaultTools.length),
    { description: "Pi core tools exposed to spawned agents by default." },
  );

  defaultToolsItem.submenu = listSubmenu(
    theme,
    "agents.defaultTools",
    "Default tools",
    "Pi core tools exposed to spawned agents by default.",
    CORE_DEFAULT_TOOL_CANDIDATES,
    config.agents.defaultTools,
    (selected) => {
      apply("agents.defaultTools", selected);
      defaultToolsItem.currentValue = formatToolCount(selected.length);
    },
  );

  return setting("agents", "Agents", summaryFor("agents", config), {
    description: "One-shot child agents spawned from inside fabric_exec.",
    submenu: sectionSubmenu(
      theme,
      "Agents",
      "One-shot child agents spawned from inside fabric_exec.",
      () => [
        setting("agents.enabled", "Enabled", config.agents.enabled ? "true" : "false", {
          description: "Enable agent spawning via workflow.agent() and agents.run().",
          values: BOOLEANS,
        }),
        setting("agents.runner", "Default runner", config.agents.runner, {
          description: "Execution harness used when agents.run/create does not specify runner.",
          values: RUNNERS,
        }),
        setting("agents.transport", "Transport", config.agents.transport, {
          description: "Preferred transport for spawned agents.",
          values: TRANSPORTS,
        }),
        setting("agents.model", "Default model", config.agents.model || INHERIT_VALUE, {
          description:
            "Model forwarded to Pi-backed agents and actors when a call does not specify one. Pick Inherit to use the host session's default. Order matches pi-model-sort (most recently used first).",
          submenu: modelPickerSubmenu(
            theme,
            options.modelSource,
          ),
        }),
        setting(
          "agents.claude.model",
          "Claude model",
          config.agents.claude.model || INHERIT_VALUE,
          {
            description:
              "Claude Code model used by Claude-backed agents and actors. Models are enumerated from the installed claude runtime; Inherit uses Claude Code's default.",
            submenu: modelPickerSubmenu(
              theme,
              options.claudeModelSource ?? { models: [], lastUsed: {} },
              {
                headerText:
                  "Default model for Claude-backed Fabric agents and actors. Pick Inherit to use Claude Code's runtime default.",
                inheritName: "Use Claude Code's runtime default model",
              },
            ),
          },
        ),
        setting("agents.veda.backend", "Veda backend", config.agents.veda.backend, {
          description:
            "External backend driven by the Veda CLI: agy, codex, claude-code, droid, pi, or a backend registered by the installed Veda build.",
          submenu: stringInputSubmenu(
            theme,
            "Veda backend",
            "External CLI backend the Veda runner drives for agent runs.",
          ),
        }),
        setting("agents.veda.persona", "Veda persona", config.agents.veda.persona, {
          description:
            "Veda persona: navigator-plan, navigator-chat, reviewer, worker, or a custom persona under ~/.config/veda/personas/<name>/AGENTS.md.",
          submenu: stringInputSubmenu(
            theme,
            "Veda persona",
            "Persona controlling the Veda agent's behavior. Leave as navigator-chat for the default.",
          ),
        }),
        setting("agents.veda.model", "Veda model", config.agents.veda.model || INHERIT_VALUE, {
          description:
            "Default model forwarded to the Veda backend when a call does not specify one. Leave empty for the backend default.",
          submenu: stringInputSubmenu(
            theme,
            "Veda model",
            "Model or alias forwarded to the Veda backend. Empty uses the backend default.",
          ),
        }),
        setting("agents.thinking", "Default thinking", thinkingLabel(config.agents.thinking), {
          description:
            "Reasoning effort forwarded to spawned agents and actors when a call does not specify one. Clamped to each model's supported levels (next highest if unsupported).",
          submenu: thinkingSubmenu(theme),
        }),
        setting("agents.maxConcurrent", "Max concurrent", String(config.agents.maxConcurrent), {
          description: "Maximum number of agents that may run at the same time.",
          submenu: numericSubmenu(
            theme,
            [1, 2, 4, 8, 16, 32],
            String,
            "Agent concurrency",
            "Maximum number of agents that may run at the same time.",
          ),
        }),
        setting("agents.maxPerExecution", "Max per execution", String(config.agents.maxPerExecution), {
          description: "Maximum number of agent calls allowed within a single fabric_exec program.",
          submenu: numericSubmenu(
            theme,
            [10, 25, 50, 100, 200, 500],
            String,
            "Agents per execution",
            "Maximum number of agent calls allowed within a single fabric_exec program.",
          ),
        }),
        setting("agents.maxDepth", "Max depth", String(config.agents.maxDepth), {
          description:
            "Maximum nesting depth for child agent calls. Enter any non-negative integer; 0 disables child spawning.",
          submenu: nonNegativeIntegerSubmenu(
            theme,
            "Agent depth",
            "Maximum nesting depth for child agent calls. Enter any non-negative integer; 0 disables child spawning.",
          ),
        }),
        setting("agents.budgetUsd", "Recursion budget", formatUsd(config.agents.budgetUsd), {
          description:
            "Maximum USD spend for agent work across the whole recursion tree. 0 disables the budget.",
          submenu: numericSubmenu(
            theme,
            BUDGET_VALUES,
            formatUsd,
            "Recursion budget",
            "Maximum USD spend for agent work across the whole recursion tree. 0 disables the budget.",
          ),
        }),
        setting("agents.sessionExport", "Usage export", config.agents.sessionExport ? "true" : "false", {
          description:
            "Write usage-only pi-format session files (tokens/cost, never transcript content) for every agent run so tokscale and ccusage can track Fabric subagents.",
          values: BOOLEANS,
        }),
        setting("agents.sessionExportDir", "Usage export dir", config.agents.sessionExportDir || "~/.pi/agent (co-hosted, hidden .fabric namespace)", {
          description:
            "Root of the export store; sessions land under <dir>/sessions/.fabric/. Default reuses pi's own agent dir (tokscale/ccusage count it with zero setup; pi's resume picker never sees the hidden namespace). PI_FABRIC_AGENT_DIR overrides.",
          submenu: stringInputSubmenu(
            theme,
            "Usage export dir",
            "Root of the export store; PI_FABRIC_AGENT_DIR overrides this value.",
          ),
        }),
        setting("agents.maxTokensPerChild", "Token limit", formatTokens(config.agents.maxTokensPerChild), {
          description:
            "Maximum cumulative tokens a single agent may use before it is terminated (0 disables). Caps a runaway child before the host session compacts.",
          submenu: numericSubmenu(
            theme,
            TOKEN_VALUES,
            formatTokens,
            "Agent token limit",
            "Maximum cumulative tokens a single agent may use before it is terminated (0 disables).",
          ),
        }),
        setting("agents.timeoutMs", "Timeout", formatMs(config.agents.timeoutMs), {
          description: "Default wall-clock timeout and minimum for per-call agent timeouts.",
          submenu: numericSubmenu(
            theme,
            [
              60_000,
              120_000,
              300_000,
              600_000,
              1_800_000,
              3_600_000,
              7_200_000,
              14_400_000,
              28_800_000,
              86_400_000,
            ],
            formatMs,
            "Agent timeout",
            "Default wall-clock timeout and minimum for per-call agent timeouts.",
          ),
        }),
        setting("agents.extensions", "Extensions", config.agents.extensions ? "true" : "false", {
          description: "Allow agents to load registered extensions.",
          values: BOOLEANS,
        }),
        defaultToolsItem,
        setting("agents.retainRuns", "Retain runs", config.agents.retainRuns ? "true" : "false", {
          description: "Keep completed agent run artifacts for later inspection.",
          values: BOOLEANS,
        }),
        setting("agents.notifyOnComplete", "Notify on complete", config.agents.notifyOnComplete ? "true" : "false", {
          description: "Show background completion notices and deliver unread results to Main at a safe boundary. Results already received through wait or terminal status do not wake Main again.",
          values: BOOLEANS,
        }),
      ],
      persist,
      { refreshOnChange: false },
    ),
  });
};
