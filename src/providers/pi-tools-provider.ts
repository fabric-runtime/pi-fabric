import { readFileSync } from "node:fs";
import { nativeToolResult } from "../core/native-tool-result.js";
import path from "node:path";
import type {
  AgentToolResult,
  ExtensionContext,
  ExtensionRunner,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { PiCodingAgent } from "../core/host-sdk-runtime.js";
import { parseGitWorktreeAdd, tryExecuteGitWorktreeAdd } from "../agents/bash-worktree-add.js";
import { runAbortable, throwIfAborted } from "../async-settlement.js";
import { CapturedToolCatalog } from "../capture/catalog.js";
import { readFabricBashMiddleware } from "../core/shell-middleware.js";
import {
  isPiShellToolName,
  PI_CORE_TOOL_NAMES,
  type PiCoreToolName,
} from "../core/pi-tools.js";
import { classifyPiBashError, classifyPiBashResult, piBashResultError } from "../core/pi-bash-error.js";
import {
  appendShellHangNotice,
  DEFAULT_SHELL_HANG_MS,
  FabricShellJobStore,
  formatShellHangNotice,
  raceShellHang,
  trackShellOperations,
} from "../core/shell-jobs.js";
import { parseShellMonitor, shellMonitorSchema } from "../core/shell-monitor.js";
import { expandSkillDirMarkersForRead } from "../core/skill-dir.js";
import type {
  FabricActionDescriptor,
  FabricBashMiddlewareV1,
  FabricInvocationContext,
  FabricMediaBlock,
  FabricProvider,
  FabricProviderListRequest,
  FabricRisk,
} from "../protocol.js";
import { countContentLines } from "../ui/preview-lines.js";
import { CapturedToolsProvider } from "./captured-tools-provider.js";
import { normalizePiArguments } from "../core/pi-arguments.js";
import { validationMessage } from "../core/action-arguments.js";
import {
  BashCwdDefinitions,
  PI_BASH_CWD_KEY,
  PowerShellCwdDefinitions,
  powerShellToolDefinitionFactory,
  resolveShellCwdArgument,
  type ShellDefinitionFactory,
  withShellCwdSchema,
} from "./pi-bash-cwd.js";
import { writeContentForPreview } from "./write-diff-limits.js";
import { createPreviewWriteToolDefinition } from "./write-preview.js";

import { readChildToolAllowlist } from "../core/child-tool-allowlist.js";
import { executionToolContext } from "../capture/tool-context.js";

const closedPiInputSchema = (name: PiCoreToolName, source: unknown): Record<string, unknown> => {
  const schema = source as Record<string, unknown>;
  const properties = { ...(schema.properties as Record<string, unknown>) };
  if (name === "bash" || name === "powershell") {
    properties.description = { type: "string", minLength: 1, maxLength: 120, description: "Short human-readable task purpose shown in the background task hint." };
    properties.monitor = shellMonitorSchema;
    properties.background = {
      type: "boolean",
      description:
        "Detach immediately: returns ok:true with taskId, pid and a bounded live log. Completion notifies the owning agent. Inspect/stop with tools.call tasks.get/tasks.stop; bounded controllers can await tasks.wait/tasks.watch without polling. monitor also detaches, requires explicit ui/wake delivery and has a finite deadline. Do not poll.",
    };
  }
  // jev-fabric is macOS/Linux only: Windows never advertises durable tasks.
  if (name === "bash" && process.platform !== "win32") {
    properties.durable = {
      type: "boolean",
      description:
        "Run as a durable background task owned by jev-fabric (the user's install or the bundled package). It keeps running if Pi exits and reattaches to this session on resume; other harnesses sharing the store can see it. Implies background. Use for dev servers and long jobs that must outlive the session; stop explicitly with tasks.stop.",
    };
    properties.notify = {
      type: "object",
      description:
        "With durable:true: when the command exits, publish {kind (default task.completed), data:{taskId, exitCode, description?}} to this mesh topic, even if no session is attached.",
      properties: {
        topic: { type: "string", minLength: 1, maxLength: 128 },
        kind: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["topic"],
      additionalProperties: false,
    };
  }
  if (name === "edit") {
    properties.all = { type: "boolean", description: "Apply every replacement to all matching occurrences." };
    const edits = properties.edits as Record<string, unknown> | undefined;
    const items = edits?.items as Record<string, unknown> | undefined;
    if (edits && items && !Array.isArray(items)) {
      properties.edits = { ...edits, items: { ...items, additionalProperties: false,
        properties: { ...(items.properties as Record<string, unknown>), all: { type: "boolean" } },
      } };
    }
  }
  return { ...schema, properties, additionalProperties: false };
};

const NOTIFY_FIELD_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;

/** `pi.bash` durable completion notify: `{ topic, kind? }`, validated fail-closed. */
const parseDurableNotify = (value: unknown): { topic: string; kind?: string } | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("notify must be an object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "topic" && key !== "kind")) throw new Error("Unknown notify option");
  if (typeof input.topic !== "string" || !NOTIFY_FIELD_PATTERN.test(input.topic)) throw new Error("notify.topic must be a valid mesh topic");
  if (input.kind !== undefined && (typeof input.kind !== "string" || !NOTIFY_FIELD_PATTERN.test(input.kind))) {
    throw new Error("notify.kind must be a mesh event kind of at most 128 characters");
  }
  return { topic: input.topic, ...(typeof input.kind === "string" ? { kind: input.kind } : {}) };
};

const MAX_RENDERER_ARGUMENT_CHARS = 200_000;
const MAX_REPLACE_ALL_FILE_CHARS = 2_000_000;

interface PiToolsProviderHostCapabilities {
  requireCapturedOverrides?: boolean;
  /** True when a host policy relies on Pi tool_call hooks; non-read tools then never run without them. */
  requireToolHooks?: () => boolean;
  powerShellToolDefinitionFactory: ShellDefinitionFactory | undefined;
  getShellHangMs?: () => number;
  shellJobs?: FabricShellJobStore;
}

const DEFAULT_HOST_CAPABILITIES: PiToolsProviderHostCapabilities = {
  powerShellToolDefinitionFactory,
};

const expandReplaceAllEdit = (
  cwd: string,
  args: Record<string, unknown>,
  allForEveryEdit: boolean,
): Record<string, unknown> => {
  const filePath = args.path;
  if (typeof filePath !== "string") {
    throw new Error("pi.edit all:true requires a path");
  }
  const edits = Array.isArray(args.edits)
    ? args.edits
    : [{ oldText: args.oldText, newText: args.newText }];
  if (edits.length === 0) throw new Error("pi.edit all:true requires at least one edit");
  const normalized = edits.map((edit, index) => {
    if (typeof edit !== "object" || edit === null || Array.isArray(edit)) {
      throw new Error(`pi.edit all:true edits[${index}] must be an object`);
    }
    const record = edit as Record<string, unknown>;
    const { oldText, newText } = record;
    if (typeof oldText !== "string" || typeof newText !== "string") {
      throw new Error(`pi.edit all:true edits[${index}] requires oldText and newText strings`);
    }
    if (oldText.length === 0) {
      throw new Error(`pi.edit all:true edits[${index}] oldText cannot be empty`);
    }
    return { oldText, newText, all: allForEveryEdit || record.all === true };
  });
  const resolvedPath = path.resolve(
    cwd,
    filePath.startsWith("@") ? filePath.slice(1) : filePath,
  );
  const current = readFileSync(resolvedPath, "utf8");
  if (current.length > MAX_REPLACE_ALL_FILE_CHARS) {
    throw new Error(
      `pi.edit all:true refuses files over ${MAX_REPLACE_ALL_FILE_CHARS} characters; use scoped unique edits`,
    );
  }
  let next = current;
  for (const [index, edit] of normalized.entries()) {
    const occurrences = next.split(edit.oldText).length - 1;
    if (occurrences === 0) {
      throw new Error(`pi.edit all:true edits[${index}] oldText was not found`);
    }
    if (!edit.all && occurrences !== 1) {
      throw new Error(
        `pi.edit edits[${index}] found ${occurrences} occurrences; add all:true or use a unique anchor`,
      );
    }
    next = edit.all
      ? next.replaceAll(edit.oldText, edit.newText)
      : next.replace(edit.oldText, edit.newText);
  }
  return { path: filePath, edits: [{ oldText: current, newText: next }] };
};

const readTools = new Set<PiCoreToolName>(["read", "grep", "find", "ls"]);
const writeTools = new Set<PiCoreToolName>(["edit", "write"]);

// The content array every pi core tool returns: text and/or image blocks.
type ToolContent = AgentToolResult<unknown>["content"];

const riskForTool = (name: PiCoreToolName): FabricRisk => {
  if (readTools.has(name)) return "read";
  if (writeTools.has(name)) return "write";
  return "execute";
};

const textContent = (content: ToolContent): string =>
  content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const imageBlocks = (content: unknown): FabricMediaBlock[] => {
  if (!Array.isArray(content)) return [];
  const blocks: FabricMediaBlock[] = [];
  for (const part of content) {
    if (
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "image" &&
      typeof (part as { data?: unknown }).data === "string" &&
      typeof (part as { mimeType?: unknown }).mimeType === "string"
    ) {
      blocks.push({
        type: "image",
        data: (part as { data: string }).data,
        mimeType: (part as { mimeType: string }).mimeType,
      });
    }
  }
  return blocks;
};

const normalizeResult = (
  name: PiCoreToolName,
  result: { content: ToolContent; details?: unknown; isError?: boolean },
): unknown => {
  const text = textContent(result.content);
  if (result.isError) throw new Error(text || `${name} failed`);
  if (name === "read" || name === "grep" || name === "find" || name === "ls") {
    return text;
  }
  let details = result.details;
  if (isPiShellToolName(name) && details && typeof details === "object" && !Array.isArray(details)) {
    const detailRecord = details as Record<string, unknown>;
    const truncation = detailRecord.truncation;
    if (truncation && typeof truncation === "object" && !Array.isArray(truncation)) {
      const { content, ...truncationMetadata } = truncation as Record<string, unknown>;
      if (typeof content === "string" && text.includes(content)) {
        details = { ...detailRecord, truncation: truncationMetadata };
      }
    }
  }
  if (name === "write" && details && typeof details === "object" && !Array.isArray(details)) {
    const { codePreviewBeforeWrite: _before, ...publicDetails } = details as Record<string, unknown>;
    details = Object.keys(publicDetails).length > 0 ? publicDetails : undefined;
  }
  return {
    ok: true,
    output: text,
    details: details ?? null,
  };
};

// Pi 0.99 reports ordinary shell exits through isError + structuredContent.
type PiToolResult = AgentToolResult<unknown>;

/**
 * Why a nested mutating call is refused while no ExtensionRunner can run the
 * other extensions' `tool_call` hooks. `unavailable` means capture found no
 * runner class in this host, so no refresh will ever supply one: a retry
 * cannot succeed, and the message says so instead.
 */
export function missingToolHooksMessage(subject: string, unavailable: boolean): string {
  return unavailable
    ? `${subject} is unavailable: Pi Fabric could not find this Pi host's ExtensionRunner, so other extensions' tool hooks cannot run for nested calls and retrying will not help. ` +
      "Read-only tools still work. Run Pi from its npm package or a release binary, or point PI_PACKAGE_DIR at the Pi package the host runs, then restart Pi."
    : `${subject} is unavailable until extension tool hooks initialize; retry once tools are ready`;
}

/**
 * Emit a `tool_call` event for a nested call and throw when a hook blocks it.
 * Hooks may mutate `input` in place. Shared by pi.* tools and by interactive
 * sessions, so a command guard sees both through one code path.
 */
export async function emitToolCallPreflight(
  runner: ExtensionRunner,
  name: string,
  input: Record<string, unknown>,
  context: Pick<FabricInvocationContext, "signal" | "nestedToolCallId" | "parentToolCallId" | "updateArguments">,
  blocked = `Pi tool ${name} was blocked`,
): Promise<void> {
  const preflight = await runAbortable(context.signal, () => runner.emitToolCall({
    type: "tool_call",
    toolName: name,
    toolCallId: context.nestedToolCallId,
    parentToolCallId: context.parentToolCallId,
    input,
  }));
  context.updateArguments?.(input);
  if (preflight?.block) {
    throw new Error(preflight.reason || blocked);
  }
}

export class PiToolsProvider implements FabricProvider {
  readonly name = "pi";
  readonly #allowedTools = readChildToolAllowlist();
  readonly description = "Pi's built-in coding tools";
  readonly #tools: Partial<Record<PiCoreToolName, ToolDefinition<any, any, any>>>;
  readonly #catalog: CapturedToolCatalog | undefined;
  readonly #capturedTools: CapturedToolsProvider | undefined;
  readonly #cwd: string;
  readonly #requireCapturedOverrides: boolean;
  readonly #bashDefinitions = new BashCwdDefinitions();
  readonly #powershellDefinitions: PowerShellCwdDefinitions | undefined;
  readonly #shellJobs: FabricShellJobStore;
  readonly #ownsShellJobs: boolean;
  readonly #getShellHangMs: (() => number) | undefined;
  readonly #requireToolHooks: (() => boolean) | undefined;

  constructor(
    cwd: string,
    catalog?: CapturedToolCatalog,
    capturedTools?: CapturedToolsProvider,
    hostCapabilities: PiToolsProviderHostCapabilities = DEFAULT_HOST_CAPABILITIES,
  ) {
    this.#cwd = cwd;
    this.#requireCapturedOverrides = hostCapabilities.requireCapturedOverrides === true;
    this.#requireToolHooks = hostCapabilities.requireToolHooks;
    const powerShellFactory = hostCapabilities.powerShellToolDefinitionFactory;
    this.#powershellDefinitions = powerShellFactory
      ? new PowerShellCwdDefinitions(powerShellFactory)
      : undefined;
    this.#tools = this.#requireCapturedOverrides ? {} : {
      read: PiCodingAgent.createReadToolDefinition(cwd),
      bash: PiCodingAgent.createBashToolDefinition(cwd),
      ...(powerShellFactory ? { powershell: powerShellFactory(cwd) } : {}),
      edit: PiCodingAgent.createEditToolDefinition(cwd),
      write: createPreviewWriteToolDefinition(cwd),
      grep: PiCodingAgent.createGrepToolDefinition(cwd),
      find: PiCodingAgent.createFindToolDefinition(cwd),
      ls: PiCodingAgent.createLsToolDefinition(cwd),
    };
    this.#catalog = catalog;
    this.#capturedTools = capturedTools;
    this.#ownsShellJobs = hostCapabilities.shellJobs === undefined;
    this.#shellJobs = hostCapabilities.shellJobs ?? new FabricShellJobStore();
    this.#getShellHangMs = hostCapabilities.getShellHangMs;
  }

  get shellJobs(): FabricShellJobStore {
    return this.#shellJobs;
  }

  async close(): Promise<void> {
    if (this.#ownsShellJobs) await this.#shellJobs.close();
  }

  async list(
    request: FabricProviderListRequest,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    const descriptors = await Promise.all(
      PI_CORE_TOOL_NAMES.map((name) => this.describe(name, _context)),
    );
    return descriptors
      .filter((descriptor): descriptor is FabricActionDescriptor => descriptor !== undefined)
      .filter((descriptor) =>
        query ? `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query) : true,
      );
  }

  async describe(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    const name = actionName as PiCoreToolName;
    if (this.#allowedTools && !this.#allowedTools.has(name)) return undefined;
    const override = await this.#capturedTools?.describe(name, _context);
    if (override) {
      if (this.#bashMiddleware(name)) {
        return {
          ...override,
          description: `${override.description} Shell execution and background jobs are managed by Fabric with the extension's middleware.`,
          inputSchema: this.#descriptor(name, this.#tools[name]!).inputSchema,
          namespace: "extension-middleware",
        };
      }
      return { ...override, namespace: "extension-override" };
    }
    const tool = this.#tools[name];
    if (!tool || this.#requireCapturedOverrides) return undefined;
    return this.#descriptor(name, tool);
  }

  prepareArguments(actionName: string, args: Record<string, unknown>): Record<string, unknown> {
    this.#assertAllowed(actionName);
    const middleware = this.#bashMiddleware(actionName);
    const definition = (middleware ? undefined : this.#catalog?.get(actionName)?.definition) ?? this.#tools[actionName as PiCoreToolName];
    const properties = (definition?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    // An override's declared properties are canonical, even when their spelling
    // is a built-in alias. Both kernels use this same preparation before validation.
    args = normalizePiArguments(actionName, args, Object.keys(properties)) as Record<string, unknown>;
    if (this.#catalog?.get(actionName) && !middleware) {
      return this.#capturedTools!.prepareArguments(actionName, args);
    }
    const tool = this.#tools[actionName as PiCoreToolName];
    if (!tool) return args;
    const input = actionName === "edit" && Object.hasOwn(args, "all")
      ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== "all"))
      : args;
    if (actionName === "edit") {
      const entries = [args, ...(Array.isArray(args.edits) ? args.edits : [])];
      for (const entry of entries) {
        if (entry && typeof entry === "object" && Object.hasOwn(entry, "all") && typeof entry.all !== "boolean") {
          throw new Error("pi.edit all must be a boolean; use True/False in Python or true/false in TypeScript.");
        }
      }
    }
    const prepare = tool.prepareArguments;
    const prepared = prepare ? prepare(input) : input;
    if (typeof prepared !== "object" || prepared === null || Array.isArray(prepared)) {
      throw new Error(`Pi tool ${actionName} prepared non-object arguments`);
    }
    const record = { ...prepared } as Record<string, unknown>;
    // Native Pi preparation can drop unknown keys. Without TypeScript's static
    // gate that would silently accept misspelled Python arguments. Keep them for
    // authoritative validation and the repair compiler's normal failure evidence.
    for (const [key, value] of Object.entries(input)) {
      if (!Object.hasOwn(properties, key)) Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
    }
    if (actionName === "edit" && Array.isArray(input.edits) && Array.isArray(record.edits)) {
      const originals = input.edits;
      record.edits = record.edits.map((entry, index) => {
        const original = originals[index];
        if (!original || typeof original !== "object" || Array.isArray(original)
          || !entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const retained = { ...entry };
        for (const [key, value] of Object.entries(original)) {
          if (!["oldText", "newText"].includes(key)) Object.defineProperty(retained, key, { value, enumerable: true, configurable: true, writable: true });
        }
        return retained;
      });
    }
    if (isPiShellToolName(actionName)) {
      // pi 0.85 preparation strips schema-external keys. Preserve Fabric's
      // advertised cwd before preparation, then validate and resolve it here.
      const shellArgs = Object.hasOwn(args, PI_BASH_CWD_KEY)
        ? { ...record, [PI_BASH_CWD_KEY]: args[PI_BASH_CWD_KEY] }
        : record;
      return resolveShellCwdArgument(actionName, this.#cwd, shellArgs);
    }
    const hasPerEditAll = actionName === "edit"
      && Array.isArray(record.edits)
      && record.edits.some(
        (edit) => typeof edit === "object" && edit !== null
          && !Array.isArray(edit) && (edit as Record<string, unknown>).all === true,
      );
    if (actionName === "edit" && (args.all === true || hasPerEditAll)) {
      // Rejected extras must reach registry validation, not disappear while the
      // replace-all helper expands the edit into a whole-file replacement.
      if (validationMessage(closedPiInputSchema("edit", tool.parameters), record)) return record;
      return expandReplaceAllEdit(this.#cwd, record, args.all === true);
    }
    return record;
  }

  /**
   * Why a tool the parent has (built in or captured) is unavailable to this
   * child, so the registry reports the allowlist instead of an unknown action.
   */
  notPermitted(name: string): string | undefined {
    if (!this.#allowedTools || this.#allowedTools.has(name)) return undefined;
    const known = (!this.#requireCapturedOverrides && this.#tools[name as PiCoreToolName] !== undefined)
      || this.#catalog?.get(name) !== undefined;
    return known ? `Pi tool ${name} is not permitted by this child's tool allowlist` : undefined;
  }

  #assertAllowed(name: string): void {
    if (this.#requireCapturedOverrides && (!PI_CORE_TOOL_NAMES.includes(name as PiCoreToolName) || !this.#catalog?.get(name))) {
      throw new Error(`Managed Pi tool requires an authorized captured override: ${name}`);
    }
    if (this.#allowedTools && !this.#allowedTools.has(name)) {
      throw new Error(`Pi tool ${name} is not permitted by this child's tool allowlist`);
    }
  }

  // Keep a cwd-bound definition for pi <=0.84, while pi 0.85+ receives the
  // same directory through ExtensionContext.cwd. `cwd` also stays in the
  // arguments so lifecycle events, approval, and previews see it.
  #definitionFor(
    name: PiCoreToolName,
    args: Record<string, unknown>,
  ): ToolDefinition<any, any, any> {
    const tool = this.#tools[name];
    if (!tool) throw new Error(`Unknown Pi tool: ${name}`);
    if (!isPiShellToolName(name)) return tool;
    const cwd = args[PI_BASH_CWD_KEY];
    if (typeof cwd !== "string") return tool;
    return name === "bash"
      ? this.#bashDefinitions.get(cwd)
      : this.#powershellDefinitions?.get(cwd) ?? tool;
  }

  #executionContextFor(
    name: PiCoreToolName,
    args: Record<string, unknown>,
    invocation: FabricInvocationContext,
  ): import("@earendil-works/pi-coding-agent").ExtensionToolContext {
    const context = executionToolContext(invocation.extensionContext, this.#catalog?.runner, invocation.nestedToolCallId, invocation.signal);
    const cwd = args[PI_BASH_CWD_KEY];
    return isPiShellToolName(name) && typeof cwd === "string"
      ? Object.defineProperty(Object.create(context), "cwd", { value: cwd, enumerable: true })
      : context;
  }

  #bashMiddleware(name: string) {
    if (name !== "bash" || this.#requireCapturedOverrides) return undefined;
    return readFabricBashMiddleware(this.#catalog?.get(name)?.definition);
  }

  #shellHangMs(): number {
    const value = this.#getShellHangMs?.() ?? DEFAULT_SHELL_HANG_MS;
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : DEFAULT_SHELL_HANG_MS;
  }

  async #trackedShellDefinition(
    name: "bash" | "powershell",
    args: Record<string, unknown>,
    job: ReturnType<FabricShellJobStore["begin"]>,
    middleware: FabricBashMiddlewareV1 | undefined,
    notify?: { topic: string; kind?: string },
  ): Promise<ToolDefinition<any, any, any>> {
    const cwd = typeof args[PI_BASH_CWD_KEY] === "string" ? args[PI_BASH_CWD_KEY] : this.#cwd;
    if (name === "bash") {
      const options = middleware?.options;
      const local = job.durable
        ? await this.#shellJobs.durable!.launch(job, {
            shellPath: options?.shellPath, label: job.options.description, filtered: middleware !== undefined,
            command: typeof args.command === "string" ? args.command : "", cwd, ownerId: job.options.ownerId,
            notify,
          })
        : PiCodingAgent.createLocalBashOperations(options?.shellPath !== undefined ? { shellPath: options.shellPath } : undefined);
      const operations = middleware ? middleware.wrapOperations(local) : local;
      if (!operations || typeof operations.exec !== "function") {
        throw new Error("Invalid Fabric bash middleware operations; refusing to bypass shell protection");
      }
      return PiCodingAgent.createBashToolDefinition(cwd, {
        ...options,
        operations: trackShellOperations(operations, job, "bash"),
      });
    }
    const create = Reflect.get(PiCodingAgent, "createPowerShellToolDefinition");
    const operationsFactory = Reflect.get(PiCodingAgent, "createLocalPowerShellOperations");
    if (typeof create !== "function" || typeof operationsFactory !== "function") {
      if (job.options.monitor) throw new Error("PowerShell monitors require host shell operations support");
      return this.#definitionFor(name, args);
    }
    return create(cwd, {
      operations: trackShellOperations(operationsFactory(), job, "powershell"),
    });
  }

  async #runExecute(
    name: PiCoreToolName,
    tool: ToolDefinition<any, any, any>,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
    onUpdate: (partialResult: PiToolResult) => void,
    middleware: FabricBashMiddlewareV1 | undefined,
  ): Promise<PiToolResult> {
    if (!isPiShellToolName(name) || this.#requireCapturedOverrides) {
      return await runAbortable(context.signal, () =>
        tool.execute(
          context.nestedToolCallId,
          args,
          context.signal,
          onUpdate,
          this.#executionContextFor(name, args, context),
        ),
      ) as PiToolResult;
    }
    return this.#executeHungShell(name, args, context, onUpdate, middleware);
  }

  async #executeHungShell(
    name: "bash" | "powershell",
    args: Record<string, unknown>,
    context: FabricInvocationContext,
    onUpdate: (partialResult: PiToolResult) => void,
    middleware: FabricBashMiddlewareV1 | undefined,
  ): Promise<PiToolResult> {
    const command = typeof args.command === "string" ? args.command : "";
    const monitor = parseShellMonitor(args.monitor);
    if (monitor && args.background === false) throw new Error("monitor runs in the background; omit background:false");
    if (monitor && this.#shellJobs.live().filter(job => job.options.monitor).length >= 8) throw new Error("At most 8 monitors may run per session; stop an existing task first");
    const durable = args.durable === true;
    if (durable) {
      if (name !== "bash") throw new Error("durable is available for pi.bash only");
      if (args.background === false) throw new Error("durable runs in the background; omit background:false");
      if (process.platform === "win32" || !this.#shellJobs.durable) throw new Error("Durable shell tasks need jev-fabric on macOS or Linux in a Fabric full-code session");
    }
    const notify = parseDurableNotify(args.notify);
    if (notify && !durable) throw new Error("notify requires durable:true");
    const background = args.background === true || monitor !== undefined || durable;
    const { background: _background, monitor: _monitor, description: _description, durable: _durable, notify: _notify, ...executeArgs } = args;
    const job = this.#shellJobs.begin(name, command, {
      ...(durable ? { durable: { home: this.#shellJobs.durable!.home } } : {}),
      cwd: typeof args[PI_BASH_CWD_KEY] === "string" ? args[PI_BASH_CWD_KEY] : this.#cwd,
      ownerId: context.extensionContext.sessionManager?.getSessionId?.(),
      ...(typeof args.description === "string" ? { description: args.description } : {}),
      ...(monitor ? { monitor } : {}),
    });
    let tool: ToolDefinition<any, any, any>;
    try {
      tool = await this.#trackedShellDefinition(name, executeArgs, job, middleware, notify);
    } catch (error) {
      await job.finish(null);
      throw error;
    }
    void job.readPid();
    if (!background && context.extensionContext.mode === "tui") {
      context.attachPreview?.({ shellBackgroundShortcut: true });
      context.update(`${name}: running`);
    }
    let spilled = false;
    const outcome = await raceShellHang({
      hangMs: background || context.nativeToolResult ? 0 : this.#shellHangMs(),
      immediate: background,
      parentSignal: context.signal,
      job,
      execute: (signal) =>
        tool.execute(
          context.nestedToolCallId,
          executeArgs,
          signal,
          (partialResult) => {
            if (spilled) return;
            onUpdate(partialResult as PiToolResult);
          },
          this.#executionContextFor(name, args, context),
        ),
    });
    if (outcome.status === "done") {
      await job.finish((outcome.value as PiToolResult & { isError?: boolean }).isError ? null : 0);
      return outcome.value as PiToolResult;
    }
    if (outcome.status === "error") {
      await job.finish(null);
      throw outcome.error;
    }
    spilled = true;
    const logPath = await job.persistLog();
    const pid = await job.readPid();
    const elapsedMs = Date.now() - job.startedAt;
    // A short command can end before this hand-off returns: say so.
    const exited = job.finished ? { exitCode: job.exitCode ?? null } : undefined;
    const notice = formatShellHangNotice({
      elapsedMs,
      logPath,
      ...(pid !== undefined ? { pid } : {}),
      ...exited,
    });
    // An auto hand-off ends only this wait. Say that the caller's timeout still
    // bounds the process, and name the call that keeps waiting for it.
    const timeoutSeconds = Number(executeArgs.timeout);
    const waitNotice = !background && !exited && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? ` Its timeout (${timeoutSeconds}s) bounds the process, not this wait; to wait for the result, call tasks.wait with {"id":"${job.id}","timeoutMs":300000} until it reports a terminal status.`
      : "";
    const durableNotice = job.durable ? ` Durable: owned by the jev-fabric store at ${job.durable.home}; it keeps running if Pi exits and reattaches to this session on resume. Stop it explicitly with tasks.stop when no longer needed.` : "";
    const output = appendShellHangNotice(job.snapshotText(), `${notice}\n[Task ${job.id}; /fabric tasks or tools.call({ref:"tasks.get",args:{id:"${job.id}"}}). ${monitor?.delivery === "ui" ? "UI-only monitor: will not wake the agent." : "Completion will notify this session; do not poll."}${waitNotice}${durableNotice}]`);
    context.update(exited
      ? `${name}: ${exited.exitCode === null ? "ended" : `exited with code ${exited.exitCode}`} in the background`
      : `${name}: still running after ${Math.max(1, Math.round(elapsedMs / 1000))}s`);
    return {
      content: [{ type: "text", text: output }],
      details: {
        running: !job.finished,
        taskId: job.id,
        elapsedMs,
        logPath,
        fullOutputPath: logPath,
        ...(pid !== undefined ? { pid } : {}),
      },
    };
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown> {
    const name = actionName as PiCoreToolName;
    this.#assertAllowed(name);
    if (process.env.PI_FABRIC_WRITE_POLICY) {
      // Confined child: also enforce on paths where no tool_call hook replays.
      const guard = await import("../agents/write-guard.js");
      const policy = guard.readWritePolicy();
      const denial = policy && guard.writePolicyDenial(policy, name, args, context.extensionContext?.cwd || this.#cwd);
      if (denial) throw new Error(denial);
    }
    if (!this.#requireCapturedOverrides && !this.#tools[name]) throw new Error(`Unknown Pi tool: ${actionName}`);
    // Pin the selected protection across awaited lifecycle hooks/catalog refreshes.
    const middleware = this.#bashMiddleware(name);
    const runner = this.#catalog?.runner;
    // Gap B: a catalog is installed but its runner — and the tool_call
    // preflight extensions rely on — is not yet available. This is the
    // transient window before the first tool refresh populates the runner.
    // Running a mutating tool here would silently skip that preflight, so fail
    // closed for non-read tools; the error says whether a retry can succeed.
    // The no-catalog path (tests, embeds) has no extension system to guard and
    // keeps the direct-execute fallback below unchanged, unless a host policy
    // relies on those hooks: then a non-read tool never runs without them.
    if ((this.#catalog || this.#requireToolHooks?.()) && !runner && !this.#requireCapturedOverrides && riskForTool(name) !== "read") {
      throw new Error(missingToolHooksMessage(`Pi tool ${name}`, this.#catalog?.runnerUnavailable === true));
    }
    let preflightEmitted = false;
    if (
      name === "bash" &&
      !this.#requireCapturedOverrides &&
      !this.#catalog?.get(name) &&
      typeof args.command === "string" &&
      parseGitWorktreeAdd(args.command) !== undefined
    ) {
      // Gap A: a well-formed `git worktree add` is intercepted below without a
      // tool_call event, so a command guard could not block it. Emit the same
      // preflight first (when a runner is available) so the intercept obeys the
      // same policy as every other nested bash call. Gate on the parse so an
      // ordinary bash command still emits its single preflight downstream.
      if (runner) {
        await this.#emitToolCallPreflight(name, args, context, runner);
        preflightEmitted = true;
      }
      const intercepted = await tryExecuteGitWorktreeAdd(args, this.#cwd);
      if (intercepted) {
        this.#attachPreview(name, intercepted, args, context);
        return this.#normalizeResult(name, intercepted, args, context);
      }
      // Parsed but not intercepted (e.g. outside a git repo): fall through to a
      // normal execution. The preflight already fired, so downstream must not
      // emit it again and re-apply any argument mutation.
    }
    // A captured extension override (e.g. an extension that registered a "read"
    // tool) already replays the full event lifecycle itself via
    // CapturedToolsProvider, so delegate to it unchanged.
    if (this.#catalog?.get(name) && !middleware) {
      if (isPiShellToolName(name) && args.monitor !== undefined) throw new Error("Shell monitors are unavailable for opaque shell overrides; a Fabric-compatible middleware adapter is required");
      if (isPiShellToolName(name) && args.durable === true) throw new Error("Durable shell tasks are unavailable for opaque shell overrides; a Fabric-compatible middleware adapter is required");
      if (isPiShellToolName(name) && args.notify !== undefined) throw new Error("notify requires durable:true");
      // `durable` is Fabric's own argument; an override never sees it.
      const { durable: _durable, ...overrideArgs } = args;
      const value = await this.#capturedTools!.invoke(name, overrideArgs, context);
      if (context.nativeToolResult) return value;
      const result = value as import("./captured-tools-provider.js").CapturedToolInvocationResult;
      this.#attachReadMedia(name, result, context);
      this.#attachReadNote(name, result, context);
      this.#attachPreview(name, result, args, context);
      return this.#normalizeResult(name, result, args, context);
    }
    const tool = this.#definitionFor(name, args);
    // Without a runner (e.g. before the first tool refresh populated the
    // catalog) fall back to a direct execute — no extension hooks fire, but
    // the call still works. Once tools are refreshed the runner is available.
    if (!runner) {
      const result = await this.#runExecute(
        name,
        tool,
        args,
        context,
        (partialResult) => this.#attachPartialPreview(name, partialResult, args, context),
        middleware,
      ).catch((error) => {
        throwIfAborted(context.signal);
        throw isPiShellToolName(name) ? classifyPiBashError(error) : error;
      });
      if (result.isError && isPiShellToolName(name) && !(context.nativeToolResult && tool.outputSchema && result.structuredContent !== undefined)) throw classifyPiBashResult(result);
      this.#attachReadMedia(name, result, context);
      this.#attachReadNote(name, result, context);
      this.#attachPreview(name, result, args, context);
      return this.#normalizeResult(name, result, args, context);
    }
    return this.#invokeWithEvents(name, tool, args, context, runner, middleware, preflightEmitted);
  }

  // Emit the tool_call preflight for a nested pi.* call and enforce a block.
  // Shared by #invokeWithEvents and the git-worktree-add intercept so both obey
  // the same extension policy through one code path (no duplicated enforcement).
  async #emitToolCallPreflight(
    name: PiCoreToolName,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
    runner: ExtensionRunner,
  ): Promise<void> {
    await emitToolCallPreflight(runner, name, args, context);
  }

  // Replay the agent-core tool-execution lifecycle for a nested pi.* call, so
  // extensions that hook tool_call / tool_result / tool_execution_* see pi
  // core tools invoked through fabric_exec in full-code mode — exactly as
  // they would for a top-level call in the normal (non-codemode) flow, and
  // exactly as CapturedToolsProvider already does for captured extension
  // tools. tool_result patches (content/details/isError) are applied, so
  // extensions like pi-vision-handoff can replace image blocks with text
  // descriptions before the result returns to the sandbox.
  async #invokeWithEvents(
    name: PiCoreToolName,
    tool: ToolDefinition<any, any, any>,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
    runner: ExtensionRunner,
    middleware: FabricBashMiddlewareV1 | undefined,
    preflightEmitted = false,
  ): Promise<unknown> {
    const toolCallId = context.nestedToolCallId;
    // Pi's own nested calls name their caller on every event; so do these replays,
    // so a listener can tell which of several open fabric_exec calls issued one.
    const parentToolCallId = context.parentToolCallId;
    await runAbortable(context.signal, () => runner.emit({
      type: "tool_execution_start",
      toolCallId,
      parentToolCallId,
      toolName: name,
      args,
    }));
    let result: PiToolResult;
    let isError = false;
    let thrown: unknown;
    let executionStarted = false;
    let updateTail: Promise<void> = Promise.resolve();
    try {
      if (!preflightEmitted) await this.#emitToolCallPreflight(name, args, context, runner);
      executionStarted = true;
      result = await this.#runExecute(
        name,
        tool,
        args,
        context,
        (partialResult) => {
          this.#attachPartialPreview(name, partialResult, args, context);
          updateTail = updateTail
            .then(() =>
              runAbortable(context.signal, () => runner.emit({
                type: "tool_execution_update",
                toolCallId,
                parentToolCallId,
                toolName: name,
                args,
                partialResult,
              })),
            )
            .catch(() => undefined);
        },
        middleware,
      );
      isError = result.isError === true;
      if (isError && isPiShellToolName(name)) thrown = classifyPiBashResult(result);
    } catch (error) {
      thrown = isPiShellToolName(name) && executionStarted ? classifyPiBashError(error) : error;
      isError = true;
      result = {
        content: [
          { type: "text", text: error instanceof Error ? error.message : String(error) },
        ],
        details: undefined,
      };
    }

    await updateTail;
    throwIfAborted(context.signal);

    // Capture the read's image blocks BEFORE any tool_result patch —
    // pi-vision-handoff swaps image→description here, which would leave
    // nothing to re-attach for the kitty preview.
    this.#attachReadMedia(name, result, context);

    const patch = await runAbortable(context.signal, () => runner.emitToolResult({
      type: "tool_result",
      toolName: name,
      toolCallId,
      parentToolCallId,
      input: args,
      content: result.content,
      details: result.details,
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      isError,
    }));
    if (patch) {
      result = {
        ...result,
        content: patch.content ?? result.content,
        ...(patch.details !== undefined ? { details: patch.details } : {}),
        ...((patch.content !== undefined || patch.structuredContent !== undefined)
          ? { structuredContent: patch.structuredContent } : {}),
      };
      isError = patch.isError ?? isError;
    }

    result = { ...result, isError };

    // Capture the read's clean text note AFTER the patch — the handoff strips
    // pi's non-vision note and swaps the image for a description, so the first
    // surviving text block is the short read note (not the verbose description).
    this.#attachReadNote(name, result, context);

    await runAbortable(context.signal, () => runner.emit({
      type: "tool_execution_end",
      toolCallId,
      parentToolCallId,
      toolName: name,
      result,
      isError,
    }));

    if (isError && !(context.nativeToolResult && tool.outputSchema && result.structuredContent !== undefined)) {
      if (isPiShellToolName(name)) {
        throw piBashResultError(thrown, textContent(result.content));
      }
      const text = textContent(result.content).trim();
      throw new Error(text || (thrown instanceof Error ? thrown.message : `Pi tool ${name} failed`));
    }
    this.#attachPreview(name, result, args, context);
    return this.#normalizeResult(name, result, args, context);
  }

  // Schema-enforce and early-startup calls may have no ExtensionRunner, so the
  // top-level tool_result marker middleware cannot run. Expand again at the
  // provider boundary; replacement is idempotent when middleware already ran.
  #normalizeResult(
    name: PiCoreToolName,
    result: { content: ToolContent; details?: unknown; isError?: boolean; structuredContent?: unknown },
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): unknown {
    if (context.nativeToolResult) return nativeToolResult(this.#definitionFor(name, args), result as PiToolResult);
    const normalized = normalizeResult(name, result);
    if (name !== "read" || typeof normalized !== "string") return normalized;
    return expandSkillDirMarkersForRead(normalized, args, this.#cwd);
  }

  #attachPartialPreview(
    name: PiCoreToolName,
    partialResult: { content: ToolContent; details?: unknown; isError?: boolean },
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): void {
    const progress = textContent(partialResult.content).trim();
    const boundedProgress = Array.from(progress).slice(-4_000).join("");
    const bashCommand =
      isPiShellToolName(name) &&
      typeof args.command === "string" &&
      args.command.length <= MAX_RENDERER_ARGUMENT_CHARS
        ? args.command
        : undefined;
    context.attachPreview?.({
      result: boundedProgress,
      ...(isPiShellToolName(name) && context.extensionContext.mode === "tui" &&
        args.background !== true && args.monitor === undefined && args.durable !== true
        ? { shellBackgroundShortcut: true } : {}),
      ...(bashCommand !== undefined ? { bashCommand } : {}),
    });
    context.update(`${name}: ${boundedProgress.slice(-500) || "running"}`);
  }

  #attachPreview(
    name: PiCoreToolName,
    result: { content: ToolContent; details?: unknown; isError?: boolean },
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): void {
    if (result.isError) return;
    const details = result.details;
    const detailRecord =
      typeof details === "object" && details !== null && !Array.isArray(details)
        ? (details as Record<string, unknown>)
        : undefined;
    const bashCommand =
      isPiShellToolName(name) &&
      typeof args.command === "string" &&
      args.command.length <= MAX_RENDERER_ARGUMENT_CHARS
        ? args.command
        : undefined;
    const writeInput =
      name === "write" && typeof args.content === "string" ? args.content : undefined;
    const writeContent =
      writeInput !== undefined ? writeContentForPreview(writeInput) : undefined;
    const writeByteLength =
      writeInput !== undefined ? Buffer.byteLength(writeInput, "utf8") : undefined;
    const writeLineCount =
      writeInput !== undefined ? countContentLines(writeInput) : undefined;
    const hasWriteBefore =
      name === "write" &&
      detailRecord !== undefined &&
      Object.prototype.hasOwnProperty.call(detailRecord, "codePreviewBeforeWrite");
    context.attachPreview?.({
      result: normalizeResult(name, result),
      ...(bashCommand !== undefined ? { bashCommand } : {}),
      ...(writeContent !== undefined ? { writeContent } : {}),
      ...(writeByteLength !== undefined ? { writeByteLength } : {}),
      ...(writeLineCount !== undefined ? { writeLineCount } : {}),
      ...(details !== undefined ? { details } : {}),
      ...(hasWriteBefore
        ? {
            codePreviewBeforeWrite: detailRecord?.codePreviewBeforeWrite,
            writeBeforeCaptured: true,
          }
        : {}),
    });
  }

  // `pi.read` of an image file returns `{ type: "image" }` content blocks.
  // normalizeResult strips them — the sandbox holds text only and the model
  // return is a string — but the single-call render wants them re-attached so
  // pi core's ToolExecutionComponent renders the kitty image preview, the same
  // path a native `read` takes. Hand them out-of-band via context.attachMedia,
  // which the ActionRegistry stashes on the call audit; this bypasses the
  // result char bound that would otherwise truncate the base64 payload.
  //
  // Must run BEFORE any tool_result patch: pi-vision-handoff SWAPS image blocks
  // for text descriptions here (so the description becomes the sandbox value),
  // which would leave no image to capture. Capturing the original blocks lets
  // the single-call render show the kitty image, and the handoff's `context`
  // hook supplies the description to the model — exactly how a native `read`
  // keeps its image for kitty and swaps it only on the LLM-bound clone.
  #attachReadMedia(
    name: PiCoreToolName,
    result: { content?: unknown },
    context: FabricInvocationContext,
  ): void {
    if (name !== "read" || context.nativeToolResult) return;
    const blocks = imageBlocks(result?.content);
    if (blocks.length > 0) context.attachMedia?.(blocks);
  }

  // The read tool's own text note (e.g. "Read image file [image/png]"), captured
  // AFTER any tool_result patch — pi-vision-handoff swaps image→description and
  // strips pi's "[Current model does not support images…]" note there, so the
  // first surviving text block is the clean note. Used as the single-call body
  // and content text so the preview shows the kitty image + the clean note
  // instead of the handoff's verbose description; the model still receives the
  // description via the handoff's `context` hook swapping the image block.
  #attachReadNote(
    name: PiCoreToolName,
    result: { content?: unknown },
    context: FabricInvocationContext,
  ): void {
    if (name !== "read" || context.nativeToolResult) return;
    const content = result?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        context.attachMedia?.([], (block as { text: string }).text);
        return;
      }
    }
  }

  #descriptor(
    name: PiCoreToolName,
    tool: ToolDefinition<any, any, any>,
  ): FabricActionDescriptor {
    const inputSchema = isPiShellToolName(name)
      ? withShellCwdSchema(tool.parameters)
      : tool.parameters;
    return {
      name,
      description: tool.description,
      inputSchema: closedPiInputSchema(name, inputSchema),
      ...(tool.outputSchema ? {outputSchema: tool.outputSchema as Record<string, unknown>} : {}),
      risk: riskForTool(name),
      namespace: "builtin",
    };
  }
}
