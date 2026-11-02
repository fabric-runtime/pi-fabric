import type { AgentRunRequest } from "./types.js";
import { isFabricThinking, normalizeThinkingBounds } from "../thinking.js";
import { aliasThinking, assertExactModelRequest, type FabricModelAliases } from "../core/model-resolution.js";
import { isFabricRunnerId } from "./runner-registry.js";

const stringArray = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("Agent tools must be an array of strings");
  }
  return [...value];
};
const checkedKernel = (value: unknown): AgentRunRequest["kernel"] => {
  if (value === undefined || value === "inherit" || value === "typescript" || value === "python") return value;
  throw new Error(`Invalid Fabric agent kernel: ${String(value)}`);
};

export const normalizeAgentRunRequest = (
  args: Record<string, unknown>,
  defaults: {runner: NonNullable<AgentRunRequest["runner"]>; model?: string; timeoutMs: number; inheritedModel?: {provider: string; id: string}; models?: {aliases?: FabricModelAliases}},
  options: {allowCwd?: boolean} = {},
): AgentRunRequest => {
  const transport =
    args.transport === "auto" ||
    args.transport === "process" ||
    args.transport === "tmux" ||
    args.transport === "screen" ||
    args.transport === "localterm" ||
    args.transport === "herdr" ||
    args.transport === "herdr-core"
      ? args.transport
      : undefined;
  // An explicit call or actor level always wins; otherwise an alias can carry
  // the intended effort for the model it selects (e.g. a "cheap" alias that is
  // both cheaper and shallower), and the global agents.thinking default applies
  // last, inside the manager.
  const requestedModel =
    typeof args.model === "string"
      ? args.model
      : typeof defaults.model === "string"
        ? defaults.model
        : undefined;
  // An exact-match request never consults aliases, so no alias level applies either.
  const thinking = isFabricThinking(args.thinking)
    ? args.thinking
    : args.modelMatch === undefined
      ? aliasThinking(defaults.models?.aliases, requestedModel ?? "")
      : undefined;
  const tools = stringArray(args.tools);
  const timeoutMs = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > defaults.timeoutMs ? args.timeoutMs : undefined;
  if (args.runner !== undefined && !isFabricRunnerId(args.runner)) {
    throw new Error(`Invalid Fabric agent runner: ${JSON.stringify(args.runner)}`);
  }
  const runner = args.runner ?? defaults.runner;
  assertExactModelRequest({ modelMatch: args.modelMatch, runner, model: args.model });
  const inheritedModel =
    (runner === "pi" || runner === "pi-durable") && !defaults.model && defaults.inheritedModel
      ? `${defaults.inheritedModel.provider}/${defaults.inheritedModel.id}`
      : undefined;
  const kernel = checkedKernel(args.kernel);
  const thinkingBounds = args.thinkingBounds === undefined
    ? undefined
    : normalizeThinkingBounds(args.thinkingBounds, "thinkingBounds");
  if (args.recursive === true && args.extensions === false) {
    throw new Error("Recursive Fabric requires extensions enabled; omit recursive or extensions: false");
  }
  return {
    task: String(args.task),
    runner,
    ...(kernel !== undefined ? { kernel } : {}),
    ...(typeof args.name === "string" ? { name: args.name } : {}),
    ...(transport ? { transport } : {}),
    ...(typeof args.model === "string"
      ? { model: args.model }
      : inheritedModel
        ? { model: inheritedModel }
        : {}),
    ...(args.modelMatch === "exact" ? { modelMatch: "exact" as const } : {}),
    // Shape is checked fail-closed by the manager; only a literal true holds.
    ...(args.holdQuestions !== undefined && args.holdQuestions !== false
      ? { holdQuestions: args.holdQuestions as true }
      : {}),
    ...(args.queue === true ? { queue: true as const } : {}),
    ...(typeof args.persona === "string" && args.persona.trim()
      ? { persona: args.persona.trim() }
      : {}),
    ...(thinking ? { thinking } : {}),
    ...(thinkingBounds ? { thinkingBounds } : {}),
    ...(tools ? { tools } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(typeof args.extensions === "boolean"
      ? { extensions: args.extensions }
      : args.recursive === true ? { extensions: true } : {}),
    ...(typeof args.recursive === "boolean" ? { recursive: args.recursive } : {}),
    ...(options.allowCwd !== false && typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
    ...(typeof args.worktree === "boolean" ? { worktree: args.worktree } : {}),
    ...(args.worktreeSetup !== undefined ? { worktreeSetup: args.worktreeSetup as string } : {}),
    // Shapes are checked fail-closed by the manager before launch.
    ...(args.readOnly !== undefined ? { readOnly: args.readOnly as boolean } : {}),
    ...(args.writableRoots !== undefined ? { writableRoots: args.writableRoots as string[] } : {}),
    ...(args.shell !== undefined ? { shell: args.shell as "deny" | "unconfined" } : {}),
    ...(args.scope !== undefined ? { scope: args.scope as NonNullable<AgentRunRequest["scope"]> } : {}),
    ...(args.residency === "session" || args.residency === "durable"
      ? { residency: args.residency }
      : {}),
    ...(typeof args.persistSession === "boolean"
      ? { persistSession: args.persistSession }
      : {}),
    ...(typeof args.schema === "object" && args.schema !== null && !Array.isArray(args.schema)
      ? { schema: args.schema as Record<string, unknown> }
      : {}),
    ...(typeof args.systemPrompt === "string" && args.systemPrompt.trim()
      ? { systemPrompt: args.systemPrompt }
      : {}),
  };
};
