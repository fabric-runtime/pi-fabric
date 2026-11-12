import type { SettingItem } from "@earendil-works/pi-tui";
import { isJevApprovalModel } from "../jev/model-key.js";
import { jevClassifierModels } from "../jev/routes.js";
import type { SettingsSectionContext } from "./settings-section-context.js";
import {
  setting,
  sectionSubmenu,
  numericSubmenu,
  probabilitySubmenu,
  stringInputSubmenu,
  modelPickerSubmenu,
  listSubmenu,
} from "./settings-submenus.js";
import {
  BOOLEANS,
  summaryFor,
  formatBlockedCount,
  EXECUTOR_KERNELS,
  PYTHON_RUNTIMES,
  EXECUTOR_RUNTIMES,
  formatMs,
  formatBytes,
  executorMemoryLimitOptions,
  RESULT_FORMATS,
  SCHEMA_MODES,
  APPROVAL_MODES,
} from "./settings-values.js";
import { maxExecutorMemoryLimitBytes } from "../config.js";
import { jevFabricStatus } from "../jev-fabric/status.js";
import { INHERIT_VALUE } from "./model-picker.js";

export const buildFullCodeModeSection = (
  { config }: Pick<SettingsSectionContext, "config">,
): SettingItem => {
  const envFullCode = process.env.PI_FABRIC_FULL_CODE_MODE;

  const fullCodeDescription = envFullCode
    ? "Fabric owns Pi core tools (read, bash, edit, write, grep, find, ls) via fabric_exec. Currently overridden by the PI_FABRIC_FULL_CODE_MODE environment variable."
    : "Fabric owns Pi core tools (read, bash, edit, write, grep, find, ls) via fabric_exec. Disable to keep native tools model-facing (orchestration-only mode).";

  return setting("fullCodeMode", "Full code mode", config.fullCodeMode ? "true" : "false", {
    description: fullCodeDescription,
    values: BOOLEANS,
  });
};

export const buildExecutorSection = (
  { config, theme, persist }: Pick<SettingsSectionContext, "config" | "theme" | "persist">,
): SettingItem => {
  const executorMemoryDescription = (): string =>
    config.executor.kernel === "python" && config.executor.pythonRuntime === "monty"
      ? "Monty VM allocation limit. Host bridge result/output limits apply separately. No filesystem or network access is granted to the VM."
      : config.executor.kernel === "python"
      ? "CPython process address-space limit via RLIMIT_AS where the OS supports it; not a portable hard memory cap. Process limits are not a security sandbox."
      : config.executor.runtime === "quickjs"
        ? "Maximum QuickJS heap size. WASM32 limits this to less than 4 GiB."
        : config.executor.runtime === "bun-process"
          ? "Heap target for the disposable Bun process. Bun ignores V8 heap flags, so this limit is not enforced."
          : "V8 old-generation heap limit for the disposable Node process. Large allocations may destabilize the system.";
  const kernelDescription = "Exclusive language for all fabric_exec calls; no per-call switching. Saving a kernel change reloads Pi after settings close so skill resources switch with execution. Python defaults to sandboxed Monty. CPython requires explicit selection and is trusted native code outside schema enforce.";
  const cpythonDescription = "CPython 3.10+ executable name or path (default python3), used only by the explicit CPython backend. No shell arguments.";
  const enforceTypeScript = config.schema.mode === "enforce" && config.executor.kernel === "typescript";

  return setting("executor", "Executor", summaryFor("executor", config), {
    description: "Kernel, Python/TypeScript backends, and resource limits. Node/Bun and CPython are unsafe trusted-code escape hatches.",
    submenu: sectionSubmenu(
      theme,
      "Executor",
      "Kernel, Python/TypeScript backends, and resource limits. Node/Bun and CPython are unsafe trusted-code escape hatches.",
      [
        setting("executor.kernel", "Kernel", config.executor.kernel, {
          description: kernelDescription,
          values: EXECUTOR_KERNELS,
        }),
        setting("executor.pythonRuntime", "Runtime (Python)", config.executor.pythonRuntime, {
          description: "Monty (default) is a sandboxed Python subset with no native filesystem, network, or environment access. CPython 3.10+ is an explicit trusted-native escape hatch. Schema enforce keeps the selected backend and never falls back.",
          values: PYTHON_RUNTIMES,
        }),
        setting("executor.cpython.binary", "CPython binary", config.executor.cpython.binary, {
          description: cpythonDescription,
          submenu: stringInputSubmenu(theme, "CPython binary", cpythonDescription),
        }),
        setting("executor.jevFabric.binary", "jev-fabric binary", config.executor.jevFabric.binary || "auto", {
          description: `Durable tasks and interactive sessions (macOS/Linux). auto uses your compatible install outside this workspace (PATH or ~/.local/bin), then the bundled package; an explicit path never falls back. ${jevFabricStatus() ? `In use: ${jevFabricStatus()}` : "Resolved at first durable or session use."}`,
          submenu: stringInputSubmenu(theme, "jev-fabric binary", "auto, or a trusted absolute path or executable name. No shell arguments."),
        }),
        setting("executor.runtime", "Runtime (TS)", config.executor.runtime, {
          description: enforceTypeScript
            ? "TypeScript only. Schema enforce mode requires the isolated QuickJS runtime; it does not change the configured kernel."
            : "TypeScript only; ignored by Python. QuickJS is isolated and limited by WASM32. Node/Bun processes support larger heaps but are an unsafe trusted-code escape hatch, not a security sandbox.",
          values: enforceTypeScript ? ["quickjs"] : EXECUTOR_RUNTIMES,
        }),
        setting("executor.codemodeProfile", "Codemode API (TS)", config.executor.codemodeProfile, {
          description: "Additive preserves Fabric's tools API and adds nativeTools plus nonconflicting tools aliases. Native gives tools and discovery helpers Pi semantics; Fabric discovery stays at fabric.tools. Policies and limits still apply. Ignored by Python.",
          values: ["additive", "native"],
        }),
        setting("executor.timeoutMs", "Timeout", formatMs(config.executor.timeoutMs), {
          description: `Default wall-clock time for a single fabric_exec program. A per-invocation timeoutMs or a matching executor.hostCallTimeouts ref can raise it up to the ${formatMs(config.executor.maxTimeoutMs)} policy maximum.`,
          submenu: numericSubmenu(
            theme,
            [15_000, 30_000, 60_000, 120_000, 300_000, 600_000],
            formatMs,
            "Executor timeout",
            `Default wall-clock time for a single fabric_exec program (policy max ${formatMs(config.executor.maxTimeoutMs)}).`,
          ),
        }),
        setting("executor.shellHangMs", "Shell hang", config.executor.shellHangMs === 0 ? "off" : formatMs(config.executor.shellHangMs), {
          description: "Wait budget for nested pi.bash / pi.powershell (default 2m, max 10m). When it elapses the await succeeds with a live output path and pid while the process keeps running. 0 disables auto-spill. background: true detaches immediately. Explicit shell timeout stays a hard cap. ctrl+b twice spills early; ctrl+k kills the waiting command.",
          submenu: numericSubmenu(
            theme,
            [0, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000],
            (ms) => ms === 0 ? "off" : formatMs(ms),
            "Shell hang",
            "Wait budget before a nested shell spills to a live log. 0 disables auto-spill. Max 10m.",
          ),
        }),
        setting(
          "executor.maxTimeoutMs",
          "Policy max",
          formatMs(config.executor.maxTimeoutMs),
          {
            description:
              "Ceiling for every executor deadline: per-invocation timeoutMs requests and executor.hostCallTimeouts ref floors are capped at this value. Values above it are normalized on load.",
            submenu: numericSubmenu(
              theme,
              [300_000, 600_000, 900_000, 1_800_000, 3_600_000],
              formatMs,
              "Executor policy maximum",
              "Ceiling for every executor deadline, including per-invocation requests and per-ref floors.",
            ),
          },
        ),
        setting(
          "executor.hostCallTimeouts",
          "Per-ref floors",
          Object.keys(config.executor.hostCallTimeouts).length > 0
            ? Object.keys(config.executor.hostCallTimeouts)
                .map((ref) => `${ref}=${formatMs(config.executor.hostCallTimeouts[ref] ?? 0)}`)
                .join(", ")
            : "none",
          {
            description:
              "Exact-ref deadline floors for known long-running host calls (configured in the Fabric config file), e.g. \"extensions.subagent\": 3600000.",
          },
        ),
        setting(
          "executor.humanWaitRefs",
          "Human-wait refs",
          config.executor.humanWaitRefs.length > 0 ? config.executor.humanWaitRefs.join(", ") : "none",
          {
            description:
              "Exact host-call refs that wait for a person (configured in the Fabric config file). While one is in flight the program deadline is paused, so a question can wait indefinitely; cancellation still stops it.",
          },
        ),
        setting(
          "executor.memoryLimitBytes",
          "Memory limit",
          formatBytes(config.executor.memoryLimitBytes),
          {
            description: executorMemoryDescription(),
            submenu: (currentValue, done) =>
              numericSubmenu(
                theme,
                executorMemoryLimitOptions(maxExecutorMemoryLimitBytes(config.executor.runtime, config.executor.kernel)),
                formatBytes,
                "Executor memory limit",
                executorMemoryDescription(),
              )(currentValue, done),
          },
        ),
        setting("executor.maxOutputChars", "Max output chars", config.executor.maxOutputChars.toLocaleString(), {
          description: "Character cap applied to the final fabric_exec return value shown to the model.",
          submenu: numericSubmenu(
            theme,
            [20_000, 50_000, 100_000, 200_000, 500_000],
            (n) => n.toLocaleString(),
            "Max output chars",
            "Character cap applied to the final fabric_exec return value shown to the model.",
          ),
        }),
        setting("executor.resultFormat", "Result format", config.executor.resultFormat, {
          description:
            "Default formatting for fabric_exec return values. Auto renders structured values as syntax-highlighted YAML; each call can override this.",
          values: RESULT_FORMATS,
        }),
        setting(
          "executor.maxNestedResultChars",
          "Max nested result chars",
          config.executor.maxNestedResultChars.toLocaleString(),
          {
            description: "Character cap applied to results returned by nested tool calls inside the sandbox.",
            submenu: numericSubmenu(
              theme,
              [500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000],
              (n) => n.toLocaleString(),
              "Max nested result chars",
              "Character cap applied to results returned by nested tool calls inside the sandbox.",
            ),
          },
        ),
      ],
      persist,
    ),
  });
};

export const buildSchemaSection = (
  { config, theme, persist }: Pick<SettingsSectionContext, "config" | "theme" | "persist">,
): SettingItem => {
  return setting("schema", "Schema", summaryFor("schema", config), {
    description: "Typed evidence loop and local-file transaction channel. Enforcement is locked per session; mode changes take effect in the next session.",
    submenu: sectionSubmenu(
      theme,
      "Schema",
      "Typed evidence loop and local-file transaction channel. In enforce mode, protected-workspace mutations require schema.hypothesize → schema.verify → schema.commit inside one fabric_exec call.",
      [
        setting("schema.mode", "Mode", config.schema.mode, {
          description:
            "off (default) leaves the control plane ungated. audit records would_block events for actions enforce would deny. enforce admits only schema transactions for protected-workspace changes and preserves the kernel: TypeScript uses QuickJS; Python defaults to sandboxed Monty. Explicit CPython requires macOS sandbox-exec or Linux bwrap and fails closed without isolation. Takes effect in the next session.",
          values: SCHEMA_MODES,
        }),
        setting("schema.certificateTtlMs", "Certificate TTL", formatMs(config.schema.certificateTtlMs), {
          description: "How long a schema.verify certificate stays valid. Clamped to 1s–10min.",
          submenu: numericSubmenu(
            theme,
            [1_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000],
            formatMs,
            "Certificate TTL",
            "How long a schema.verify certificate stays valid. Clamped to 1s–10min.",
          ),
        }),
        setting("schema.maxFiles", "Max files", String(config.schema.maxFiles), {
          description: "Maximum files in one schema.commit transaction. Clamped to 1–1000.",
          submenu: numericSubmenu(
            theme,
            [1, 5, 10, 25, 50, 100, 250, 500, 1000],
            (n) => String(n),
            "Max files",
            "Maximum files in one schema.commit transaction. Clamped to 1–1000.",
          ),
        }),
        setting("schema.maxBytes", "Max bytes", formatBytes(config.schema.maxBytes), {
          description: "Maximum total bytes written by one schema.commit transaction. Clamped to 1 KiB–100 MiB.",
          submenu: numericSubmenu(
            theme,
            [1_048_576, 5_242_880, 10_485_760, 52_428_800, 104_857_600],
            formatBytes,
            "Max bytes",
            "Maximum total bytes written by one schema.commit transaction. Clamped to 1 KiB–100 MiB.",
          ),
        }),
      ],
      persist,
    ),
  });
};

const APPROVAL_RISKS = ["read", "write", "execute", "network", "agent"] as const;

export const buildApprovalsSection = (
  { config, theme, options, persist }: Pick<SettingsSectionContext<"modelSource">, "config" | "theme" | "options" | "persist">,
): SettingItem => {
  return setting("approvals", "Approvals", summaryFor("approvals", config), {
    description: "Per-action approval policy for Fabric and model-requested native tool calls.",
    submenu: sectionSubmenu(
      theme,
      "Approvals",
      "Approval policy for Fabric and model-requested native tool calls. Auto routes each call through a dedicated safety classifier and escalates uncertain actions to you.",
      () => [
        setting("approvals.default", "Default policy", config.approvals.default ?? "allow", {
          description: "Applies to every action category without an override. Choose auto to classify all inherited calls; existing overrides are preserved.",
          values: APPROVAL_MODES,
        }),
        setting("approvals.overrides", "Category overrides", `${APPROVAL_RISKS.filter(risk => config.approvals[risk] !== undefined).length} overrides`, {
          description: "Optional exceptions to the default policy. Choose inherit to follow the default.",
          submenu: sectionSubmenu(theme, "Category overrides", "Inherit follows the default policy. Exact action and provider overrides still take precedence.", () => [
            ...APPROVAL_RISKS.map(risk => setting(
              `approvals.${risk}`, risk[0]!.toUpperCase() + risk.slice(1), config.approvals[risk] ?? "inherit", {
                description: `Effective policy: ${config.approvals[risk] ?? config.approvals.default ?? "allow"}. Inherit uses the default policy.`,
                values: ["inherit", ...APPROVAL_MODES],
              },
            )),
            setting("approvals.resetOverrides", "Reset all to default", "keep", {
              description: "Clear all five category overrides in this scope. Exact action and provider overrides are not changed.",
              values: ["keep", "reset"],
            }),
          ], persist),
        }),
        setting("approvals.model", "Auto model", config.approvals.model || INHERIT_VALUE, {
          description:
            "Pi or Jev model used as the auto-mode safety classifier. Inherit uses the active session model. Jev requires /login jev (TypeSafe), the existing openrouter credential (OpenRouter), the existing vercel-ai-gateway credential (Vercel AI Gateway), or /login subq (SubQ Snap) and the configured minimum safety probability (default 0.50); lower scores and errors require explicit approval. No executable classifier tools.",
          submenu: modelPickerSubmenu(
            theme,
            {
              ...options.modelSource,
              models: [
                ...options.modelSource.models.filter(model => !isJevApprovalModel(`${model.provider}/${model.id}`)),
                ...jevClassifierModels(config.jev.model),
              ],
            },
            {
              headerText:
                "Safety classifier for auto approval policies. Inherit uses the active Pi model. Jev uses typed judgments, not chat; authenticate with /login jev for TypeSafe, /login openrouter for OpenRouter, /login vercel-ai-gateway for Vercel AI Gateway, or /login subq for SubQ Snap.",
              inheritName: "Use the active Pi session model",
            },
          ),
        }),
        ...(isJevApprovalModel(config.approvals.model) ? [
          setting("jev.autoApprovalThreshold", "Jev minimum probability", String(config.jev.autoApprovalThreshold), {
            description: "Minimum safety probability for automatic approval (0–1, default 0.50). Lower values allow more actions; secrets and destructive verdicts still escalate. Errors still require approval.",
            submenu: probabilitySubmenu(theme, "Jev minimum probability",
              "Enter a probability from 0 to 1 (default 0.50). Higher values are more conservative. 0 allows every judgment whose secrets and destructive verdicts are clean; 1 requires a probability of 1. Errors and missing user text still require approval."),
          }),
        ] : []),
      ],
      persist,
    ),
  });
};

export const buildMcpSection = (
  { config, theme, persist, apply, options }: Pick<
    SettingsSectionContext,
    "config" | "theme" | "persist" | "apply" | "options"
  >,
): SettingItem => {
  const blockedItem = setting(
    "mcp.jev.blockedServers",
    "Block from Jev",
    formatBlockedCount(config.mcp.jev.blockedServers.length),
    {
      description:
        "Cached MCP servers. Toggle to block sending that server's tool metadata to Jev. Unlisted and future servers stay allowed.",
    },
  );
  blockedItem.submenu = listSubmenu(
    theme,
    "mcp.jev.blockedServers",
    "Block from Jev",
    "Cached MCP servers. Toggle to block sending that server's tool metadata to Jev. Unlisted and future servers stay allowed.",
    options.cachedMcpServers ?? [],
    config.mcp.jev.blockedServers,
    (selected) => {
      apply("mcp.jev.blockedServers", selected);
      blockedItem.currentValue = formatBlockedCount(selected.length);
    },
  );

  return setting("mcp", "MCP", summaryFor("mcp", config), {
    description: "Model Context Protocol provider discovery and invocation.",
    submenu: sectionSubmenu(
      theme,
      "MCP",
      "Model Context Protocol provider discovery and invocation.",
      [
        setting("mcp.enabled", "Enabled", config.mcp.enabled ? "true" : "false", {
          description: "Enable the MCP provider inside fabric_exec.",
          values: BOOLEANS,
        }),
        setting("mcp.nativeServers", "Pi-owned servers", (config.mcp.nativeServers ?? []).join(", "), {
          description: "Opt-in exact server names from Pi's /mcp, comma-separated. Others stay on mcporter; no automatic fallback. Reload Fabric to apply.",
          submenu: stringInputSubmenu(theme, "Pi-owned MCP servers",
            "Exact names, comma-separated; blank disables. Pi owns connections and OAuth. Configure servers with /mcp; reload Fabric after changing this list."),
        }),
        setting("mcp.disableOAuth", "Disable OAuth", config.mcp.disableOAuth ? "true" : "false", {
          description: "Skip mcporter OAuth flows. Pi-owned servers use Pi's authentication and /mcp login.",
          values: BOOLEANS,
        }),
        setting("mcp.allowDynamicServers", "Dynamic servers", config.mcp.allowDynamicServers ? "true" : "false", {
          description: "Allow servers to be added at runtime via the MCP protocol.",
          values: BOOLEANS,
        }),
        setting("mcp.callTimeoutMs", "Call timeout", formatMs(config.mcp.callTimeoutMs), {
          description: "Timeout for individual MCP tool calls.",
          submenu: numericSubmenu(
            theme,
            [15_000, 30_000, 60_000, 120_000, 300_000],
            formatMs,
            "MCP call timeout",
            "Timeout for individual MCP tool calls.",
          ),
        }),
        setting("mcp.cache.enabled", "Descriptor cache", config.mcp.cache.enabled ? "true" : "false", {
          description: "Cache MCP tool metadata across sessions keyed by mcporter config; discovery no longer spawns every server.",
          values: BOOLEANS,
        }),
        setting("mcp.cache.revalidate", "Revalidate on start", config.mcp.cache.revalidate, {
          description: "Background re-listing at session start: changed servers only, all servers, or off.",
          values: ["changed", "all", "off"],
        }),
        setting("mcp.cache.revalidateBudgetMs", "Revalidate budget", formatMs(config.mcp.cache.revalidateBudgetMs), {
          description: "Wall-clock budget for the session-start background MCP revalidation.",
          submenu: numericSubmenu(
            theme,
            [15_000, 30_000, 60_000, 120_000, 300_000],
            formatMs,
            "MCP revalidate budget",
            "Wall-clock budget for the session-start background MCP revalidation.",
          ),
        }),
        setting("mcp.jev.semanticSearch", "Jev semantic search", config.mcp.jev.semanticSearch ? "true" : "false", {
          description:
            'Opt-in: tools.search({ query, searchMode: "semantic" }) ranks actions with Jev. Default search stays lexical. Cached and future MCP servers are eligible unless blocked below.',
          values: BOOLEANS,
        }),
        blockedItem,
      ],
      persist,
    ),
  });
};
