import { fabricToolLoadout } from "./core/tool-ownership.js";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@earendil-works/pi-ai";
import { Container, Text, type Component } from "@earendil-works/pi-tui";

type AnyToolDefinition = ToolDefinition<any, any, any>;

// Local mirror of the host's defineTool declaration shape (pi 0.84.2):
// identity at runtime, inference-preserving in the type system.
const defineTool = <TParams extends TSchema, TDetails = unknown, TState = any>(
  tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition =>
  tool as ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
import { arcItemStyled } from "./ui/arc-group.js";
import type { CodePreviewSettings } from "./ui/code-preview.js";
import {
  type FabricToolShellDecorator,
  withCodePreviewShell,
} from "./ui/code-preview-shell.js";
import { fabricExecTitleHintCached } from "./ui/fabric-title-hint.js";
import { Type } from "typebox";
import {
  createFabricPersistedExecutionDetails,
  readFabricExecutionRenderDetails,
} from "./audit/index.js";
import { DEFAULT_FABRIC_CONFIG } from "./config.js";
import type { FabricState } from "./fabric-state.js";
import { formatFailureProgress } from "./failure-progress.js";
import {
  prepareFabricExecArguments,
  resolveFabricExecPayloads,
} from "./fabric-exec-arguments.js";
import { repairFabricGuestCode } from "./runtime/guest-code-repair.js";
import {
  FABRIC_REPEAT_BLOCK,
  FABRIC_REPEAT_WARN,
  FabricRepeatGuard,
  fabricRepeatBlockText,
  fabricRepeatWarnText,
} from "./repeat-guard.js";
import { normalizeRunDisplay } from "./run-display.js";
import type { PendingFabricHandoff } from "./prewalk/handoff.js";
import type { FabricMediaBlock } from "./protocol.js";
import {
  captureFabricAgentPreviews,
  captureFabricCallHeadlinePreviews,
  captureFabricCoreToolPreviews,
  captureFabricWritePreviews,
  expandHint,
  fabricMulticallCallLimit,
  fabricWriteBindings,
  inheritComponentBackground,
  modelReadHint,
  nestedCallBody,
  nestedCallTitle,
  renderBoundedLines,
  renderFabricMulticallPartial,
  renderFabricWriteArgumentPreview,
  renderAgentToolPreviewLines,
  restoreFabricAgentPreviews,
  restoreFabricCallHeadlinePreviews,
  restoreFabricCoreToolPreviews,
  restoreFabricWritePreviews,
  restoreLegacyBashCommands,
  safeTerminalText,
  singleCallProgressLine,
  type FabricAgentPreview,
  type FabricCallHeadlinePreview,
  type FabricCoreToolPreview,
  type FabricRenderAudit,
  type FabricWriteBinding,
  type FabricWritePreview,
} from "./ui/fabric-render.js";
import {
  coreToolPreviewEnabled,
  coreToolRendererEnabled,
  isCoreToolAudit,
  renderCoreToolBody,
} from "./ui/core-tool-render.js";
import { highlightCode, observePiTheme } from "./ui/highlight.js";
import {
  HiddenRowBorrowingComponent,
  observeResultRows,
  type ResultRowBalance,
} from "./ui/row-balance.js";
import { observeAnimationRows, type SpinnerTimerState, updateSpinner } from "./ui/spinner.js";
import type { FabricToolDisplayController } from "./ui/tool-display.js";
import { boundModelOutput, modelOutputBudget } from "./output-budget.js";
import { formatFabricValue } from "./ui/structured.js";
import { countNewlines } from "./util.js";

const RESULT_FORMATS = ["auto", "yaml", "json", "text"] as const;
const MAX_FABRIC_CODE_TRANSFER_LINES = 12;

type FabricRendererState = {
  fabricKernel?: "typescript" | "python";
  fabricWriteBindingsCode?: string;
  fabricWriteBindings?: FabricWriteBinding[];
  fabricWritePreviews?: FabricWritePreview[];
  fabricCoreToolPreviews?: FabricCoreToolPreview[];
  fabricCallHeadlinePreviews?: FabricCallHeadlinePreview[];
  fabricAgentPreviews?: FabricAgentPreview[];
  fabricResultRowBalance?: ResultRowBalance;
  fabricSpinner?: SpinnerTimerState;
};

type FabricToolDisplayMode = "full" | "compact";

// Bootstrap, not runtime activation, is the config-readiness seam: upstream's
// deferred startup loads configuration into FabricState without creating the
// heavyweight runtime, so a resumed session must honor the bootstrapped
// ui.toolDisplay even while state.initialized is still false. The explicit
// bootstrapped check also guards the failed-bootstrap window (config loaded
// unsuccessfully): compact is the configured default, but a broken or absent
// configuration falls back to full so a degraded startup never hides the
// underlying transcript.
const toolDisplayMode = (state: FabricState): FabricToolDisplayMode =>
  state.bootstrapped ? state.config.ui.toolDisplay : "full";

const toolKernel = (state: FabricState): "typescript" | "python" =>
  state.bootstrapped ? state.config.executor?.kernel ?? "typescript" : "typescript";

const compactResultHeader = (
  theme: Theme,
  audits: FabricRenderAudit[],
  failed: boolean,
): string => {
  const failedCalls = audits.filter((audit) => audit.success === false).length;
  const isFailed = failed || failedCalls > 0;
  return theme.fg(isFailed ? "error" : "success", `${isFailed ? "✗" : "✓"} Tools`) +
    theme.fg(
      "dim",
      ` · ${countLabel(audits.length, "call")}${failedCalls > 0 ? ` · ${failedCalls} failed` : ""}`,
    );
};

const countLabel = (count: number, singular: string): string =>
  `${count} ${count === 1 ? singular : `${singular}s`}`;

export const createFabricExecTool = (
  state: FabricState,
  codePreviewSettings: CodePreviewSettings,
  pendingHandoffs: Map<string, PendingFabricHandoff>,
  decorateShell: FabricToolShellDecorator = withCodePreviewShell,
  toolDisplay?: FabricToolDisplayController,
): ToolDefinition<any, any, any> => {
  const python = toolKernel(state) === "python";
  const monty = python && state.config.executor.pythonRuntime === "monty";
  const repeatGuard = new FabricRepeatGuard(FABRIC_REPEAT_WARN, FABRIC_REPEAT_BLOCK);
  return decorateShell(
  defineTool({
    name: "fabric_exec",
    // Native codemode-only hides direct tools. An orchestrator must stay model-only.
    exposure: "model-only",
    prepareLoadout: (loadout) => {
      // SDK/CLI reload rebuilds the registry before session_start bootstraps
      // the replacement extension. That transient loadout is not a request.
      if (!state.bootstrapped) return undefined;
      return fabricToolLoadout(
        loadout,
        state.config.fullCodeMode || state.config.schema.mode === "enforce",
        state.foregroundTools(loadout.declared.map((tool) => tool.name)).tools,
      );
    },
    label: "Fabric",
    description: python
      ? monty
        ? "Execute Python through Fabric's configured Monty sandbox. Monty runs a Python subset with VM resource limits, no native filesystem/network/environment access, and only host-mediated tools. Each invocation starts fresh. This is the exclusive model tool path in full code mode and Schema enforce mode."
        : "Execute Python through Fabric’s configured CPython kernel for Pi core tools, MCP, providers, discovery, and extensions. Each call uses a fresh process. Native execution is trusted code; Schema enforce requires OS isolation. This is the exclusive model tool path in full code mode and Schema enforce mode."
      : "Execute code through Fabric's TypeScript kernel: type-checked TypeScript by default, unmodified JavaScript with executor.codemodeProfile native. Both support nativeTools; native mode places Pi-compatible calls on tools and Fabric discovery on fabric.tools. Compose Pi core tools, MCP, Fabric providers, discovery, and extensions. QuickJS is isolated by default; the optional Node/Bun process is an unsafe trusted-code escape hatch. In full code mode, and always in Schema enforce mode, this is the exclusive model tool path.",
    promptSnippet:
      "Pi core tools, MCP, Fabric providers, discovery, and extensions",
    promptGuidelines: [
      python
        ? "Batch independent operations in one `fabric_exec` Python program with `asyncio.gather`; await dependent/conditional steps sequentially. Coalesce independent replacements into one `await pi.edit(path=..., edits=[...])`. Return only the compact final JSON-compatible value."
        : "Batch independent operations in one `fabric_exec` program (`Promise.all` for parallel, sequential `await` for ordered), not one call per tool; keep dependent/conditional steps sequential. Coalesce non-dependent replacements from one file snapshot into one `pi.edit({path, edits:[...]})`; use `all:true` only for intentional repeated exact anchors. Return only the compact final value; intermediate results stay in the sandbox.",
      python
        ? "Search before reading with `await pi.grep(pattern=..., path=...)` or `await pi.find(pattern=..., path=...)`, then `await pi.read(path=..., offset=..., limit=...)`. Use Python dict syntax, `True`/`False`/`None`, and bounded searches; unbounded reads cap at 2000 lines or 50KB. Read continuation notices when needed."
        : "Search before reading: use `pi.grep`/`pi.find` to locate relevant lines, then `pi.read({path, offset, limit})` that range. Escape regex metacharacters, or use `literal:true` for exact punctuated text. Keep fan-out search limits small and widen only on misses. An unbounded `pi.read` returns at most 2000 lines or 50KB and, when truncated, ends with a `Use offset=…` continuation notice; reserve whole-file reads for small files you will use in full.",
      "Keep the acceptance ledger in reasoning or concise progress notes (no tool call): define concrete checks, trace execution before editing, implement end to end, then run targeted tests and direct behavioral probes. Confirm requested public symbols, registrations, and configuration entries. Use the smallest checks that cover the ledger; escalate only for failures or cross-cutting risk. Inspect failures and iterate instead of rerunning unchanged passing checks. A build alone is not completion.",
      python
        ? "For test/probe nonzero exits, use `await pi.bash(command=..., settle=True)` and inspect the returned dict: `r['ok']`, `r['output']`, and `r.get('exitCode')`. Set shell `timeout` in seconds once for long suites. Return decisions and evidence rather than raw logs."
        : "Amortize round trips without inflating context: batch only independent, bounded work. Keep search→read and edit→verify sequential when an output determines the next action. Use `settle:true` for tests or probes whose nonzero result is evidence rather than an exceptional stop; for a known long suite, set `pi.bash` `timeout` in seconds once instead of retrying a timed-out call. Filter or summarize noisy command output inside the program and return decisions, failures, and evidence—not raw logs or unused intermediate results.",
      "For edits/writes, pass named payloads through top-level `payloads`; each `π.key` must exactly match a key there; prefer `pi.edit`/`pi.write`. `pi.bash`: no stdin.",
      "Use `display.name` and objective `display.description`; Fabric pairs them with verified outcomes in deterministic compaction.",
      ...(monty ? ["Monty requires acyclic JSON host arguments. For underscore-prefixed provider/tool names, use `await tools.call(ref=..., args={...})`, not direct attributes. Use `payloads['key']` for private/non-identifier payload keys."] : []),
    ],
    // The model-facing schema is intentionally flat: one large `code` string
    // plus scalar/optional params. Do not add nested arrays-of-objects with
    // escaped content here. SOTA models are post-trained on one dominant
    // harness's flat tool shapes and can invent trailing keys at the
    // highest-entropy point of a nested escaped-JSON field, which a strict
    // schema hard-rejects. Keep this surface string/scalar-heavy; the only
    // nested field (display) ignores unknown keys. See
    // lucumr.pocoo.org/2026/7/4/better-models-worse-tools/ and pi-tool-repair.
    // display also accepts a bare (or JSON-object) string, silently repaired
    // to { name } via normalizeRunDisplay: flash-tier models cold-start with
    // that near-miss, and repairing beats a zero-work rejection round trip.
    // payloads is the remaining nested map (legacy alias: strings). The old
    // name collides with the JSON string type, so models stringify it;
    // prepareArguments remaps `strings` and parses a JSON-object string
    // back to Record<string, string> before Pi validates.
    parameters: Type.Object({
      code: Type.String({
        description: python
          ? monty
            ? "Python async function body executed by Monty, a sandboxed Python subset (not CPython). Top-level await/return and asyncio.gather are supported. Use only Monty's supported syntax/modules; native imports, filesystem, network, and environment are unavailable. Host globals: tools, mcp, memory, state, schema, compact, cache, thinking, components, agents, mesh; full-code mode adds pi and extensions. Await dict/keyword calls; use native dict results r['output']. Payloads: π.key or payloads['key']. Return JSON-compatible data; each invocation starts fresh."
            : "Python async function body executed by CPython. Top-level await and return are supported; standard-library imports are available. Globals: tools, mcp, memory, state, schema, compact, cache, thinking, components, agents, mesh; full-code mode adds pi and extensions. Await host calls using a dict or keyword arguments. Results are native dicts/lists: r['output'], not r.output. Use asyncio.gather for concurrency. Named payloads are π.key or payloads['key']. Return a JSON-compatible value. Each call starts fresh."
          : "TypeScript function body. Top-level await and return are supported. Globals include `tools`, `mcp`, `memory`, `state`, `schema`, `compact`, `cache`, `thinking`, `agents`, `mesh`, `print`, and `π`; full-code mode adds `pi` and `extensions`. `π` contains only the exact keys supplied by this call's `payloads`. See session guidance / `fabric-exec` skill for exact signatures.",
      }),
      payloads: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description:
            "Named payloads exposed under the same exact name as π.key (for example, payloads.contract becomes π.contract). Never reference a π key absent from this map. Useful for content that is awkward to quote inside code. Prefer an object of string values; a JSON-object string is parsed.",
        }),
      ),
      resultFormat: Type.Optional(Type.Union(RESULT_FORMATS.map((value) => Type.Literal(value)))),
      ...(python ? {} : {
        tokenBudget: Type.Optional(
          Type.Number({
            minimum: 1,
            description: "Optional token budget observed by workflow.agent() calls",
          }),
        ),
      }),
      agentBudget: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "Optional agent-call cap, bounded by Fabric configuration",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          minimum: 1,
          description:
            "Optional whole-program deadline in ms for this invocation; raises (never lowers) the configured executor.timeoutMs, capped by executor.maxTimeoutMs",
        }),
      ),
      timeout_ms: Type.Optional(Type.Integer({ minimum: 1, description: "Hard whole-script deadline in milliseconds; cannot be extended or paused, capped by executor.maxTimeoutMs." })),
      maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1, description: "Per-call output token budget (estimated at four characters per token), capped by executor.maxOutputChars." })),
      max_output_tokens: Type.Optional(Type.Integer({ minimum: 1, description: "Alias of maxOutputTokens." })),
      display: Type.Optional(
        Type.Union([
          Type.Object(
            {
              name: Type.Optional(
                Type.String({
                  description: "Concise execution milestone used by the Fabric activity UI and deterministic compaction continuity",
                }),
              ),
              description: Type.Optional(
                Type.String({
                  description: "Compact declared objective or acceptance criterion shown in the dashboard and richer compaction activity",
                }),
              ),
            },
          ),
          Type.String({
            description:
              "Objective shorthand normalized to { name } (a JSON-object string is parsed). Prefer the object form when available.",
          }),
        ]),
      ),
    }, { additionalProperties: false }),
    // Pi validates custom-tool arguments before `tool_call` and `execute`, so
    // compatibility coercions for the model-facing boundary must live in the
    // official prepareArguments hook rather than execute-time fallbacks.
    prepareArguments(args) {
      return prepareFabricExecArguments(args, toolKernel(state)) as any;
    },
    renderCall(params, theme, context) {
      observePiTheme(theme);
      const code = Array.isArray(params.code) ? params.code.join("\n") : params.code;
      const mode = toolDisplayMode(state);
      const rendererState = context.state as FabricRendererState;
      const python = (rendererState.fabricKernel ?? toolKernel(state)) === "python";
      toolDisplay?.observe(context.toolCallId, "call", context.invalidate);
      const spinner = updateSpinner(
        rendererState.fabricSpinner ??= {},
        context.isPartial,
        context.invalidate,
      );
      const rowBalance = rendererState.fabricResultRowBalance ??= {};
      if (rendererState.fabricWriteBindingsCode !== code) {
        rendererState.fabricWriteBindingsCode = code;
        rendererState.fabricWriteBindings = python ? [] : fabricWriteBindings(code);
      }
      // The write argument preview is a streaming affordance: it previews
      // pending writes while args are still arriving. Pi only flips
      // executionStarted for live calls; resumed cards stay at its false
      // default and are always complete (isPartial false), so their previews
      // belong to the result side alone. Without the isPartial gate, a
      // collapsed resumed card shows the same write twice.
      const writePreview = context.executionStarted || !context.isPartial
        ? null
        : renderFabricWriteArgumentPreview(
            {
              bindings: rendererState.fabricWriteBindings ?? [],
              strings: resolveFabricExecPayloads(params),
              expanded: context.expanded,
              cwd: context.cwd,
              settings: codePreviewSettings,
              spinner,
            },
            theme,
            context.invalidate,
          );
      // Pi's app.tools.expand toggle (ctrl+o) flips context.expanded and
      // promotes a compact card to the full transcript below.
      if (mode === "compact" && !context.expanded) {
        const display = normalizeRunDisplay(params.display);
        // The kernel-aware memo serves the live card, activity and compaction.
        const title = display?.name?.trim()
          || (fabricExecTitleHintCached(code, python ? "python" : "typescript")
            ?? (python ? "Python program" : undefined));
        const header = renderBoundedLines(
          [
            theme.fg("toolTitle", theme.bold(safeTerminalText(title || "Fabric"))),
            ...(display?.description
              ? [theme.fg("dim", safeTerminalText(display.description))]
              : []),
          ],
          theme,
          codePreviewSettings.diffIntensity,
        );
        if (!writePreview) return header;
        const composite = new Container();
        composite.addChild(header);
        composite.addChild(new Text("\n", 0, 0));
        composite.addChild(writePreview);
        return observeAnimationRows(composite, rendererState.fabricSpinner ??= {});
      }

      const lines = safeTerminalText(code).split("\n");
      const runDisplay = normalizeRunDisplay(params.display);
      const displayName = runDisplay?.name ? safeTerminalText(runDisplay.name) : "";
      const title = `${theme.fg("toolTitle", theme.bold("fabric"))}${
        displayName ? ` ${theme.fg("accent", displayName)}` : ""
      } ${theme.fg("dim", `${python ? "Python" : "TypeScript"} · ${countLabel(lines.length, "line")}`)}`;
      // Match the compact header: the declared objective sits between the
      // title and the code preview.
      const description = runDisplay?.description
        ? theme.fg("dim", safeTerminalText(runDisplay.description))
        : "";
      const baseLimit = context.expanded ? lines.length : Math.min(lines.length, 8);
      const maxLimit = context.expanded
        ? lines.length
        : Math.min(lines.length, baseLimit + MAX_FABRIC_CODE_TRANSFER_LINES);
      const renderCodePreview = (limit: number, width: number): string[] => {
        const shown = lines.slice(0, limit);
        const lineNumberWidth = String(Math.max(1, shown.length)).length;
        const preview = shown
          .map(
            (line, index) =>
              `${theme.fg("dim", String(index + 1).padStart(lineNumberWidth, " "))} ${theme.fg("muted", line || " ")}`,
          )
          .join("\n");
        const hidden = lines.length - shown.length;
        const hiddenHint =
          hidden > 0
            ? `\n${theme.fg("dim", `… ${countLabel(hidden, "line")} hidden · `)}${expandHint(theme)}`
            : "";
        return new Text(
          `${title}${description ? `\n${description}` : ""}${preview ? `\n${preview}` : ""}${hiddenHint}`,
          0,
          0,
        ).render(width);
      };
      const codePreview = new HiddenRowBorrowingComponent(
        baseLimit,
        maxLimit,
        renderCodePreview,
        rowBalance,
      );
      if (!writePreview) return codePreview;
      const composite = new Container();
      composite.addChild(codePreview);
      composite.addChild(new Text("\n", 0, 0));
      composite.addChild(writePreview);
      return observeAnimationRows(composite, rendererState.fabricSpinner ??= {});
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      observePiTheme(theme);
      const details = readFabricExecutionRenderDetails(result.details);
      let audits = restoreLegacyBashCommands(
        details.audits as FabricRenderAudit[],
        context.args,
      );
      const rendererState = context.state as FabricRendererState;
      const recordedKernel = details.kernel ?? (isPartial ? undefined : "typescript");
      if (recordedKernel && rendererState.fabricKernel !== recordedKernel) {
        const renderedKernel = rendererState.fabricKernel ?? toolKernel(state);
        rendererState.fabricKernel = recordedKernel;
        delete rendererState.fabricWriteBindingsCode;
        if (renderedKernel !== recordedKernel) context.invalidate();
      }
      toolDisplay?.observe(context.toolCallId, "result", context.invalidate);
      const spinner = updateSpinner(
        rendererState.fabricSpinner ??= {},
        isPartial,
        context.invalidate,
      );
      const rowBalance = rendererState.fabricResultRowBalance ??= {};
      const trackRows = (component: Component): Component =>
        observeResultRows(
          observeAnimationRows(inheritComponentBackground(component), rendererState.fabricSpinner ??= {}),
          rowBalance,
          { expanded, isPartial },
        );
      if (isPartial) {
        rendererState.fabricCoreToolPreviews = captureFabricCoreToolPreviews(
          audits,
          rendererState.fabricCoreToolPreviews,
        );
        rendererState.fabricAgentPreviews = captureFabricAgentPreviews(
          audits,
          rendererState.fabricAgentPreviews,
        );
        const headlinePreviews = captureFabricCallHeadlinePreviews(audits);
        if (headlinePreviews.length > 0) {
          rendererState.fabricCallHeadlinePreviews = headlinePreviews;
        }
        const writePreviews = captureFabricWritePreviews(audits);
        if (writePreviews.length > 0) rendererState.fabricWritePreviews = writePreviews;
      } else {
        if (rendererState.fabricCoreToolPreviews) {
          audits = restoreFabricCoreToolPreviews(
            audits,
            rendererState.fabricCoreToolPreviews,
          );
        }
        if (rendererState.fabricAgentPreviews) {
          audits = restoreFabricAgentPreviews(audits, rendererState.fabricAgentPreviews);
        }
        if (rendererState.fabricCallHeadlinePreviews) {
          audits = restoreFabricCallHeadlinePreviews(
            audits,
            rendererState.fabricCallHeadlinePreviews,
          );
        }
        if (rendererState.fabricWritePreviews) {
          audits = restoreFabricWritePreviews(audits, rendererState.fabricWritePreviews);
        }
      }
      const phases = details.phases;
      const nl = "\n";
      const allRowIndexes = (lines: string[], enabled: boolean): ReadonlySet<number> | undefined =>
        enabled ? new Set(lines.map((_line, index) => index)) : undefined;
      // Expanded (app.tools.expand / ctrl+o) promotes compact cards to the
      // full rendering; compact only governs the collapsed presentation.
      const compact = !expanded && toolDisplayMode(state) === "compact";
      const corePreviewContext = { cwd: context.cwd, settings: codePreviewSettings };
      const showAgentToolPreview = state.initialized
        ? state.config.ui.showAgentToolPreview
        : DEFAULT_FABRIC_CONFIG.ui.showAgentToolPreview;

      const renderBody = (
        audit: FabricRenderAudit,
        limit: number,
      ): { body: string; hidden: number } | null => {
        const core = renderCoreToolBody(audit, theme, {
          cwd: context.cwd,
          settings: codePreviewSettings,
          expanded,
          maxLines: limit,
          ...(context?.invalidate ? { invalidate: context.invalidate } : {}),
        });
        if (core) return { body: core.lines.join(nl), hidden: core.hidden };
        if (coreToolRendererEnabled(audit, codePreviewSettings)) return null;

        const body = nestedCallBody(audit);
        if (!body) return null;
        const bodyLines = safeTerminalText(body).split(nl);
        while (bodyLines.length > 0) {
          const last = bodyLines[bodyLines.length - 1];
          if (last === undefined || last.trim() === "") bodyLines.pop();
          else break;
        }
        if (bodyLines.length === 0) return null;
        const shown = bodyLines.slice(0, limit);
        return {
          body: shown.map((line) => theme.fg("toolOutput", line || " ")).join(nl),
          hidden: bodyLines.length - shown.length,
        };
      };

      if (isPartial) {
        const progress = details.progress;
        if (audits.length === 0) {
          const label = compact ? "Running…" : progress ?? "Running Fabric program…";
          return trackRows(
            new Text(theme.fg("warning", `◆ ${safeTerminalText(label)}`), 0, 0),
          );
        }
        if (audits.length === 1) {
          const audit = audits[0]!;
          const glyph =
            audit.success === undefined
              ? theme.fg("warning", spinner)
              : audit.success === false
                ? theme.fg("error", "✗")
                : theme.fg("dim", "›");
          let text = `${glyph} ${nestedCallTitle(audit, theme, context?.invalidate, corePreviewContext)}`;
          const previewLines = renderAgentToolPreviewLines(audit, theme, {
            expanded,
            showTools: showAgentToolPreview,
            core: corePreviewContext,
            ...(context?.invalidate ? { invalidate: context.invalidate } : {}),
          });
          const progressLine = singleCallProgressLine(progress, previewLines);
          if (audit.success === false && audit.error) {
            text += nl + `  ${theme.fg("error", safeTerminalText(audit.error))}`;
          } else {
            const rendered = renderBody(
              audit,
              expanded || coreToolRendererEnabled(audit, codePreviewSettings) ? 200 : 10,
            );
            if (rendered) {
              text += nl + rendered.body;
              if (rendered.hidden > 0) {
                text += nl + theme.fg("dim", `… ${countLabel(rendered.hidden, "line")}`);
                if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
              }
            } else if (
              isCoreToolAudit(audit) &&
              !expanded &&
              !coreToolPreviewEnabled(audit, codePreviewSettings)
            ) {
              text += nl + arcItemStyled(theme, expandHint(theme));
            } else if (progressLine) {
              text += nl + theme.fg("dim", progressLine);
            }
          }
          if (audit.success !== false && previewLines[0]) {
            const firstBreak = text.indexOf(nl);
            if (firstBreak < 0) text += ` ${previewLines[0]}`;
            else text = `${text.slice(0, firstBreak)} ${previewLines[0]}${text.slice(firstBreak)}`;
            if (previewLines.length > 1) text += nl + previewLines.slice(1).join(nl);
          }
          const textLines = text.split(nl);
          return trackRows(
            renderBoundedLines(
              textLines,
              theme,
              codePreviewSettings.diffIntensity,
              allRowIndexes(textLines, previewLines.length > 0),
            ),
          );
        }
        let preview: { auditIndex: number; body: string; hidden: number } | undefined;
        for (let index = audits.length - 1; index >= 0; index--) {
          const audit = audits[index]!;
          if (
            (audit.tool !== "write" && audit.tool !== "edit") ||
            audit.success === false
          ) continue;
          const rendered = renderBody(audit, expanded ? 20 : 10);
          if (rendered) {
            preview = { auditIndex: index, ...rendered };
            break;
          }
        }
        return trackRows(
          renderFabricMulticallPartial(
            {
              audits,
              phases,
              progress,
              expanded,
              preview,
              core: corePreviewContext,
              showAgentToolPreview,
              spinner,
              ...(compact ? { activityLabel: "Tools" } : {}),
            },
            theme,
            context?.invalidate,
          ),
        );
      }

      const output = result.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join(nl);
      const styleOutputLines = (lines: string[]): string[] => {
        if (!details.outputFormat || lines.length === 0) {
          return lines.map((line) => theme.fg("toolOutput", line || " "));
        }
        const highlightedStart = Math.min(
          lines.length,
          details.outputFormatStartLine ?? 0,
        );
        const highlightedCount = Math.min(
          lines.length - highlightedStart,
          details.outputFormatLines ?? lines.length,
        );
        const highlightedSource = lines.slice(
          highlightedStart,
          highlightedStart + highlightedCount,
        );
        const highlighted = highlightedSource.length > 0
          ? highlightCode(
              highlightedSource.join(nl),
              details.outputFormat,
              context?.invalidate,
            )
          : [];
        const styledPrefix = highlighted?.map((line) => line || " ")
          ?? highlightedSource.map((line) => theme.fg("toolOutput", line || " "));
        return [
          ...lines.slice(0, highlightedStart).map((line) => theme.fg("toolOutput", line || " ")),
          ...styledPrefix,
          ...lines
            .slice(highlightedStart + highlightedCount)
            .map((line) => theme.fg("toolOutput", line || " ")),
        ];
      };
      const failed = details.success === false;

      if (audits.length === 0) {
        if (failed && details.error) {
          return trackRows(
            new Text(
              theme.fg("error", `✗ ${safeTerminalText(details.error)}`),
              0,
              0,
            ),
          );
        }
        if (!output) {
          return trackRows(new Text(
            compact
              ? theme.fg(failed ? "error" : "success", failed ? "✗ Failed" : "✓ Evaluated")
              : theme.fg("dim", "✓ Fabric"),
            0,
            0,
          ));
        }
        const lines = safeTerminalText(output).split(nl);
        const limit = expanded ? Math.min(lines.length, 200) : 12;
        const shown = lines.slice(0, limit);
        let text = styleOutputLines(shown).join(nl);
        if (compact) {
          text = theme.fg(failed ? "error" : "success", failed ? "✗ Failed" : "✓ Evaluated") + nl + text;
        }
        if (lines.length > shown.length) {
          text += nl + theme.fg("dim", `… ${countLabel(lines.length - shown.length, "line")}`);
          if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
        }
        return trackRows(
          renderBoundedLines(text.split(nl), theme, codePreviewSettings.diffIntensity),
        );
      }

      if (audits.length === 1) {
        const audit = audits[0]!;
        let text = compact
          ? `${compactResultHeader(theme, audits, failed)}${nl}${nestedCallTitle(
              audit,
              theme,
              context?.invalidate,
              corePreviewContext,
            )}`
          : nestedCallTitle(audit, theme, context?.invalidate, corePreviewContext);
        const previewLines = renderAgentToolPreviewLines(audit, theme, {
          expanded,
          showTools: showAgentToolPreview,
          core: corePreviewContext,
          ...(context?.invalidate ? { invalidate: context.invalidate } : {}),
        });
        if (audit.success === false) {
          if (audit.error) {
            text += nl + theme.fg("error", safeTerminalText(audit.error));
          }
          return trackRows(new Text(text, 0, 0));
        }
        if (previewLines[0]) {
          text += ` ${previewLines[0]}`;
          if (previewLines.length > 1) text += nl + previewLines.slice(1).join(nl);
        }
        const limit =
          expanded || coreToolRendererEnabled(audit, codePreviewSettings) ? 200 : 12;
        const rendered = previewLines.length > 0 ? null : renderBody(audit, limit);
        if (rendered) {
          text += nl + rendered.body;
          if (rendered.hidden > 0) {
            text += nl + theme.fg("dim", `… ${countLabel(rendered.hidden, "line")}`);
            if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
          }
          const readHint = modelReadHint(audits, output, theme);
          if (readHint) text += nl + readHint;
        } else if (
          isCoreToolAudit(audit) &&
          !expanded &&
          !coreToolPreviewEnabled(audit, codePreviewSettings)
        ) {
          text += nl + arcItemStyled(theme, expandHint(theme));
        } else if (
          previewLines.length === 0 &&
          output &&
          !isCoreToolAudit(audit) &&
          (!compact || failed || expanded)
        ) {
          const lines = safeTerminalText(output).split(nl);
          const outLimit = expanded ? Math.min(lines.length, 200) : 12;
          const outShown = lines.slice(0, outLimit);
          text += nl + styleOutputLines(outShown).join(nl);
          if (lines.length > outShown.length) {
            text += nl + theme.fg("dim", `… ${countLabel(lines.length - outShown.length, "line")}`);
            if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
          }
        }
        const textLines = text.split(nl);
        return trackRows(
          renderBoundedLines(
            textLines,
            theme,
            codePreviewSettings.diffIntensity,
            allRowIndexes(textLines, previewLines.length > 0),
          ),
        );
      }

      const failedCalls = audits.filter(
        (audit) => audit.success === false,
      ).length;
      const status = failed ? "failed" : "complete";
      const statusColor = failed ? "error" : "success";
      const metadata = [
        countLabel(audits.length, "nested call"),
        failedCalls > 0 ? `${failedCalls} failed` : undefined,
        phases.length > 0 ? countLabel(phases.length, "phase") : undefined,
      ].filter((value): value is string => Boolean(value));
      let text = compact
        ? compactResultHeader(theme, audits, failed)
        : theme.fg(
            statusColor,
            `${failed ? "✗" : "✓"} Fabric ${status}`,
          );
      if (!compact && metadata.length > 0) text += theme.fg("dim", ` · ${metadata.join(" · ")}`);
      if (phases.length > 0)
        text += nl + theme.fg("dim", phases.map((phase) => `◆ ${phase}`).join("  "));

      const callLimit = fabricMulticallCallLimit(expanded);
      const callsShown = audits.slice(0, callLimit);
      const callsHidden = audits.length - callsShown.length;
      let collapsedPreview:
        | { auditIndex: number; body: string; hidden: number }
        | undefined;
      if (!expanded) {
        for (let index = callsShown.length - 1; index >= 0; index--) {
          const audit = callsShown[index]!;
          if (
            (audit.tool !== "write" && audit.tool !== "edit") ||
            audit.success === false
          ) continue;
          const rendered = renderBody(audit, 10);
          if (rendered) {
            collapsedPreview = { auditIndex: index, ...rendered };
            break;
          }
        }
      }
      let firstNested = true;
      const textRows = text.split(nl);
      const agentWrapLineIndexes = new Set<number>();
      for (let index = 0; index < callsShown.length; index++) {
        const audit = callsShown[index]!;
        if (expanded && !firstNested) textRows.push("");
        firstNested = false;
        const glyph =
          audit.success === false ? theme.fg("error", "✗") : theme.fg("dim", "›");
        const previewLines = renderAgentToolPreviewLines(audit, theme, {
          expanded,
          compact: !expanded,
          showTools: showAgentToolPreview,
          core: corePreviewContext,
          ...(context?.invalidate ? { invalidate: context.invalidate } : {}),
        });
        let callRow = `${glyph} ${nestedCallTitle(audit, theme, context?.invalidate, corePreviewContext)}`;
        if (previewLines[0] && audit.success !== false) {
          callRow += ` ${previewLines[0]}`;
          if (expanded) agentWrapLineIndexes.add(textRows.length);
        }
        textRows.push(callRow);
        if (audit.success === false && audit.error) {
          textRows.push(`  ${theme.fg("error", safeTerminalText(audit.error))}`);
        } else {
          if (previewLines.length > 1) {
            for (const line of previewLines.slice(1)) {
              agentWrapLineIndexes.add(textRows.length);
              textRows.push(line);
            }
          }
          const rendered = previewLines.length === 0 && expanded ? renderBody(audit, 40) : null;
          if (rendered) {
            textRows.push(...rendered.body.split(nl));
            if (rendered.hidden > 0) {
              textRows.push(theme.fg("dim", `… ${countLabel(rendered.hidden, "line")}`));
            }
          } else if (previewLines.length === 0 && collapsedPreview?.auditIndex === index) {
            textRows.push(...collapsedPreview.body.split(nl).map((line) => `  ${line}`));
            if (collapsedPreview.hidden > 0) {
              textRows.push(theme.fg(
                "dim",
                `  … ${countLabel(collapsedPreview.hidden, "line")}`,
              ));
            }
          }
        }
      }
      text = textRows.join(nl);
      if (callsHidden > 0) {
        text += nl + theme.fg("dim", `… ${countLabel(callsHidden, "nested call")} hidden`);
        if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
      }
      const readHint = modelReadHint(audits, output, theme);
      if (readHint) text += nl + readHint;

      const showOutput = failed || expanded;
      if (showOutput && output) {
        const lines = safeTerminalText(output).split(nl);
        const limit = expanded ? Math.min(lines.length, 200) : 6;
        const shown = lines.slice(0, limit);
        if (shown.length > 0) {
          if (expanded) text += nl + theme.fg("dim", "↩ return");
          text += nl + styleOutputLines(shown).join(nl);
          if (lines.length > shown.length) {
            text += nl + theme.fg("dim", `… ${countLabel(lines.length - shown.length, "line")} hidden`);
            if (!expanded) text += theme.fg("dim", " · ") + expandHint(theme);
          }
        }
      }
      return trackRows(
        renderBoundedLines(
          text.split(nl),
          theme,
          codePreviewSettings.diffIntensity,
          agentWrapLineIndexes,
        ),
      );
    },
    async execute(toolCallId, params, signal, onUpdate, context) {
      await state.ensure(context);
      // prepareArguments joins code arrays / remaps `strings` → `payloads`
      // and quotes unquoted pi path arguments before Pi validates this call;
      // keep the same coercion here for direct internal invocations.
      const joined = Array.isArray(params.code) ? params.code.join("\n") : params.code;
      const code = state.config.executor.kernel === "python" ? joined : repairFabricGuestCode(joined);
      const strings = resolveFabricExecPayloads(params);
      const repeat = repeatGuard.observe(code, strings);
      if (repeat.blocked) {
        return {
          content: [{ type: "text", text: fabricRepeatBlockText(repeat.count) }],
          isError: true,
          details: undefined,
        };
      }
      const runDisplay = normalizeRunDisplay(params.display);
      const tokenBudget = "tokenBudget" in params && typeof params.tokenBudget === "number"
        ? params.tokenBudget : undefined;
      const result = await state.execution.execute({
        code,
        ...(strings ? { strings } : {}),
        signal,
        parentToolCallId: toolCallId,
        context,
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
        ...(params.agentBudget !== undefined ? { maxAgentCalls: params.agentBudget } : {}),
        ...(params.timeoutMs !== undefined ? { requestedTimeoutMs: params.timeoutMs } : {}),
        ...(params.timeout_ms !== undefined ? { hardTimeoutMs: params.timeout_ms } : {}),
        ...(runDisplay
          ? {
              display: {
                ...(runDisplay.name !== undefined && { name: runDisplay.name }),
                ...(runDisplay.description !== undefined && { description: runDisplay.description }),
              },
            }
          : {}),
        onPartial(snapshot) {
          onUpdate?.({
            content: [{ type: "text", text: snapshot.progress ?? "" }],
            details: {
              progress: snapshot.progress,
              audits: snapshot.audits,
              phases: snapshot.phases,
            },
          });
        },
      });

      const selectedResultFormat =
        params.resultFormat ?? state.config.executor.resultFormat;
      const boundarySessionId = context.sessionManager.getSessionId();
      const pendingHandoff = await state.claimHandoff(
        result,
        boundarySessionId,
        selectedResultFormat,
        toolCallId,
      );
      if (pendingHandoff) {
        pendingHandoffs.set(toolCallId, pendingHandoff);
        context.ui.setStatus(
          "fabric-prewalk",
          `waiting for fabric_exec boundary → ${String(pendingHandoff.args.model ?? "executor")}`,
        );
        // The nudge budget is spent and the arm still has no plan: the handoff
        // proceeds rather than stalling the session, and that is worth saying.
        if (pendingHandoff.readiness?.kind === "unplanned") {
          context.ui.notify(
            `Prewalk: handing off without a recorded plan after ${pendingHandoff.readiness.prompts} reminders.`,
            "warning",
          );
        }
      } else if (state.prewalk.planRequired(boundarySessionId)) {
        // This boundary was withheld because the plan is still owed. Reflect the
        // planning phase instead of leaving the footer reading "armed".
        const prewalkStatus = state.prewalk.status();
        context.ui.setStatus(
          "fabric-prewalk",
          prewalkStatus.state === "armed" ? `plan awaited → ${prewalkStatus.model}` : undefined,
        );
      }
      const fullFormattedValue = formatFabricValue(result.value, selectedResultFormat);
      const failureProgress = formatFailureProgress(result.trace);
      const fullSections = [...result.logs];
      if (fullFormattedValue.text) fullSections.push(fullFormattedValue.text);
      if (result.error) fullSections.push(`Runtime error: ${result.error}`);
      if (failureProgress) fullSections.push(failureProgress);
      if (repeat.warn) fullSections.push(fabricRepeatWarnText(repeat.count, FABRIC_REPEAT_BLOCK));
      const fullRawOutput = fullSections.join("\n\n");
      const outputBudget = modelOutputBudget(
        Math.min(state.config.executor.maxOutputChars, (params.maxOutputTokens ?? params.max_output_tokens ?? Infinity) * 4),
        result.success,
      );
      const outputWillTruncate = fullRawOutput.length > outputBudget;
      const formattedValue = outputWillTruncate
        ? formatFabricValue(
            result.value,
            selectedResultFormat,
            outputBudget,
          )
        : fullFormattedValue;
      const sections = [...result.logs];
      const logPrefix = result.logs.join("\n\n");
      if (formattedValue.text) sections.push(formattedValue.text);
      if (result.error) sections.push(`Runtime error: ${result.error}`);
      if (failureProgress) sections.push(failureProgress);
      if (repeat.warn) sections.push(fabricRepeatWarnText(repeat.count, FABRIC_REPEAT_BLOCK));
      const rawOutput = sections.join("\n\n");
      const outputFormat =
        formattedValue.language &&
        formattedValue.text &&
        (result.logs.length === 0 || !outputWillTruncate)
          ? formattedValue.language
          : undefined;
      const outputFormatStartLine = result.logs.length > 0
        ? countNewlines(logPrefix) + 2
        : 0;
      // Evaluated lazily at each return so the main path persists audits after
      // their in-memory image payloads are stripped below.
      const persistedRenderDetails = () =>
        createFabricPersistedExecutionDetails({
          ...result,
          ...(outputFormat ? { outputFormat, outputFormatStartLine } : {}),
          ...(outputFormat
            ? {
                outputFormatLines:
                  formattedValue.highlightedLineCount
                  ?? countNewlines(formattedValue.text) + 1,
              }
            : {}),
        });

      if (result.typeErrors) {
        const text = result.typeErrors
          .map((error) =>
            error.line > 0
              ? `Line ${error.line}:${error.column} — ${error.message}`
              : error.message,
          )
          .join("\n");
        // Guidance parses the guest declarations; load it only on a type error.
        const { typeErrorRecoveryHint } = await import("./type-error-guidance.js");
        const recoveryHint = typeErrorRecoveryHint(code, result.typeErrors);
        const bounded = await boundModelOutput(
          `Type errors; code was not executed:\n${text}${
            recoveryHint ? `\n\n${recoveryHint}` : ""
          }`,
          outputBudget,
        );
        return {
          content: [{ type: "text", text: bounded.text }],
          details: persistedRenderDetails(),
          isError: true,
        };
      }

      const output = (await boundModelOutput(
        rawOutput || "(no output)",
        outputBudget,
        fullRawOutput || "(no output)",
      )).text;
      // In-place prewalk continuation arrives as an in-band context message on
      // this boundary turn, so the loop must keep running: the executor's first
      // request follows naturally. Terminating here would strand the
      // continuation — no queued turn remains to carry it.
      const inPlaceContinuation = pendingHandoff?.kind === "prewalk-in-place";
      const terminate =
        !inPlaceContinuation &&
        (pendingHandoff !== undefined ||
          (result.success &&
            typeof result.value === "object" &&
            result.value !== null &&
            "terminate" in result.value &&
            result.value.terminate === true));
      // A nested `pi.read` of an image returns image content blocks that
      // normalizeResult stripped (the sandbox holds text only). The provider
      // handed them out-of-band to each call audit; re-attach them here so
      // pi core's ToolExecutionComponent renders a kitty image preview — the
      // same path a native `read` takes — for single-call AND multitool
      // reads. pi-vision-handoff keeps the image in the nested tool_result
      // (its `context` hook swaps image→description on the LLM-bound
      // fabric_exec clone), so every read audit carries its image here.
      const mediaBlocks: FabricMediaBlock[] = [];
      // Images the guest returned directly, hoisted out of the text channels by
      // the media sanitizer; their descriptors remain in the text.
      for (const block of result.media ?? []) mediaBlocks.push(block);
      for (const audit of result.audits) {
        if (audit.media) mediaBlocks.push(...audit.media);
      }
      const singleAudit = result.audits.length === 1 ? result.audits[0] : undefined;
      // The read tool's own text note (e.g. "Read image file [image/png]"),
      // captured after the handoff stripped pi's non-vision note. Used as
      // the single-call body + content text so the preview shows the kitty
      // image + the clean note (like pi core) instead of the handoff's
      // verbose description. Multitool renders each read's note as its own
      // call body, so the joined program return suffices as the content text
      // there.
      const mediaNote = singleAudit?.mediaNote;
      // The base64 payload now lives in the result content; discard the
      // duplicate in-memory audit copies before returning.
      for (const audit of result.audits) {
        delete audit.media;
        delete audit.mediaNote;
      }
      const content: Array<{ type: "text"; text: string } | FabricMediaBlock> = [];
      if (mediaBlocks.length > 0) {
        // Mirror a native `read`: keep the image block(s) for pi core's kitty
        // render alongside the short note. The handoff's `context` hook
        // swaps each image for its description on the LLM-bound clone, so the
        // text-only model still receives the description while the terminal
        // shows the kitty image.
        const textOutput =
          singleAudit && mediaNote
            ? mediaNote
            : (output === "(no output)" ? "" : output);
        if (textOutput) content.push({ type: "text", text: textOutput });
        for (const block of mediaBlocks) content.push(block);
        if (singleAudit && mediaNote) {
          singleAudit.result = mediaNote;
        }
      } else {
        content.push({ type: "text", text: output });
      }
      return {
        content,
        details: persistedRenderDetails(),
        ...(result.usage ? { usage: result.usage } : {}),
        ...(terminate ? { terminate: true } : {}),
        ...(result.success ? {} : { isError: true }),
      };
    },
  }),
  {
    mode: codePreviewSettings.toolCallBackground,
    toolCallTiming: codePreviewSettings.toolCallTiming,
  },
  );
};
