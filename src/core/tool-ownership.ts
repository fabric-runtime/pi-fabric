import path from "node:path";
import type {
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFabricExecutionTraceV1 } from "../audit/trace-schema.js";
import { FABRIC_NESTED_TOOL_CALL_ID_PREFIX as NESTED_TOOL_CALL_ID_PREFIX } from "../protocol.js";
import type {
  FabricToolPlacement,
  FabricToolPlacementMode,
  FabricToolPlacementResultV1,
} from "../protocol.js";
import type { ToolLoadout, ToolLoadoutChanges } from "@earendil-works/pi-coding-agent";
import { isCodemodeScriptGuideline } from "./pi-tools.js";

// Hide every registered declaration, including historical transcript declarations,
// except resolved foreground tools (full code mode only; enforce resolves none).
// Keep tools active: Pi uses that set for native nested-call availability.
// Since 1.0.4, hidden declarations also lose their system-prompt guidelines.
// Carry callable tools' guidance on Fabric itself, using the pending loadout
// rather than capture metadata (which excludes built-ins and can lag refresh).
export const fabricToolLoadout = (
  loadout: ToolLoadout,
  exclusive: boolean,
  foreground: readonly string[] = [],
  options: { nativeProfile?: boolean } = {},
): ToolLoadoutChanges | undefined => {
  if (!exclusive) return undefined;
  const hiddenDeclarations = loadout.registered.map((tool) => tool.name)
    .filter((name) => name !== "fabric_exec" && !foreground.includes(name));
  const hidden = new Set(hiddenDeclarations);
  // "codemode script" lines describe nativeTools.* results (and tools.* in the
  // native profile), not pi.*/extensions.*, which resolve Fabric results and reject.
  const label = (rule: string): string =>
    !options.nativeProfile && isCodemodeScriptGuideline(rule) ? `nativeTools only: ${rule}` : rule;
  const guidelines = loadout.callable.flatMap((tool) => {
    // The capability was added in 1.0.4; older supported hosts still put these
    // rules in the system prompt and need no duplicate.
    const rules = typeof loadout.getPromptGuidelines === "function"
      ? loadout.getPromptGuidelines(tool.name) : [];
    return hidden.has(tool.name) && rules.length > 0
      ? [`${tool.name}:`, ...rules.map((rule) => `- ${label(rule)}`)] : [];
  });
  const fabric = loadout.declared.find((tool) => tool.name === "fabric_exec");
  return {
    hiddenDeclarations,
    ...(fabric && guidelines.length > 0 ? { descriptions: {
      fabric_exec: `${fabric.description}\n\nGuidelines for tools called inside fabric_exec:\n${guidelines.join("\n")}`,
    } } : {}),
  };
};

/**
 * Answer pi-fabric:tool-placement:v1. `model` mirrors fabricToolLoadout: an
 * exclusive mode declares only fabric_exec plus resolved foreground tools;
 * orchestration declares the active set. `program` is the caller's view of
 * pi.* / extensions.* reachability; `programCallable` lists `model` tools
 * that a program can also call.
 */
export const fabricToolPlacement = (input: {
  mode: FabricToolPlacementMode;
  registered: readonly string[];
  active: readonly string[];
  program: (name: string) => boolean;
  tools?: readonly string[];
  foreground?: readonly string[];
}): FabricToolPlacementResultV1 => {
  const active = new Set(input.active);
  const exclusive = input.mode !== "orchestration";
  const tools: Record<string, FabricToolPlacement> = {};
  const programCallable: string[] = [];
  for (const name of input.tools ?? input.registered) {
    if (Object.hasOwn(tools, name)) continue;
    const program = input.program(name);
    const model = active.has(name) &&
      (!exclusive || name === FABRIC_TOOL_NAME || input.foreground?.includes(name) === true);
    tools[name] = model ? "model" : program ? "program" : "unavailable";
    if (model && program) programCallable.push(name);
  }
  return { version: 1, mode: input.mode, tools, ...(programCallable.length > 0 ? { programCallable } : {}) };
};

// setActiveTools can run during a captured call or in a later extension handler,
// removing this tool (and thus its loadout hook). Reassert at the native request
// boundary and project the whole transcript, including historical removals.
// `tools` is fabric_exec, then any resolved foreground declarations.
export const fabricModelContext = (
  messages: import("@earendil-works/pi-agent-core").AgentMessage[],
  tools: Pick<import("@earendil-works/pi-ai").Tool, "name" | "description" | "parameters">
    | readonly Pick<import("@earendil-works/pi-ai").Tool, "name" | "description" | "parameters">[],
): import("@earendil-works/pi-agent-core").AgentMessage[] => {
  // Preserve prepareLoadout descriptions from the current native transcript.
  // Replacing them with the registration-time definition drops hidden-tool
  // guidelines and other native loadout transformations at this fallback seam.
  const effective = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    if ("replace" in message && message.replace === true) effective.clear();
    for (const tool of message.toolsAdded ?? []) effective.set(tool.name, tool.description);
  }
  const declared = (Array.isArray(tools) ? [...tools] : [tools]).map((tool) => ({
    ...tool, description: effective.get(tool.name) ?? tool.description,
  }));
  let first = true;
  return messages.map((message) => {
    if (message.role !== "system") return message;
    const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
    const declare = first || ("replace" in message && message.replace === true);
    first = false;
    return { ...rest, ...(declare ? { toolsAdded: declared } : {}) };
  });
};

export interface FabricToolOwnershipHost {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

export interface FabricTopLevelToolAuthorizer {
  authorize(ref: string, parentToolCallId: string): Promise<void>;
}

export interface FabricTopLevelToolApprover {
  approve(event: ToolCallEvent, context: ExtensionContext): Promise<void>;
}

const FABRIC_TOOL_NAME = "fabric_exec";
const TOP_LEVEL_SCHEMA_REF_PREFIX = "schema.top_level_tool.";

export const ownsFabricToolSource = (
  tools: Array<{ name: string; sourceInfo: { path: string } }>,
  extensionEntryPath: string,
): boolean => tools.some(
  (tool) =>
    tool.name === FABRIC_TOOL_NAME &&
    path.resolve(tool.sourceInfo.path) === path.resolve(extensionEntryPath),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finalFabricDetailsFailed = (details: unknown): boolean => {
  if (!isRecord(details)) return false;
  if (details.success === false) return true;
  const trace = readFabricExecutionTraceV1(details.trace);
  return trace !== undefined && trace.outcome !== "succeeded";
};

export class FabricToolLifecycle {
  readonly #outerCalls = new Set<string>();

  constructor(
    readonly ownsFabricTool: () => boolean,
    readonly authorizer: () => FabricTopLevelToolAuthorizer | undefined,
    readonly approver: () => FabricTopLevelToolApprover | undefined = () => undefined,
  ) {}

  async toolCall(
    event: ToolCallEvent,
    context?: ExtensionContext,
  ): Promise<ToolCallEventResult | undefined> {
    if (event.parentToolCallId && [...this.#outerCalls].some((id) =>
      event.parentToolCallId === id || event.parentToolCallId?.startsWith(`${id}/`))) return undefined;
    if (event.toolCallId.startsWith(NESTED_TOOL_CALL_ID_PREFIX)) {
      if (this.#outerCalls.size > 0) return undefined;
      await this.#authorizeTopLevel(event);
      return undefined;
    }
    if (event.toolName === FABRIC_TOOL_NAME && this.ownsFabricTool()) {
      this.#outerCalls.add(event.toolCallId);
      return undefined;
    }
    await this.#authorizeTopLevel(event);
    const approver = this.approver();
    if (approver) {
      if (!context) throw new Error("Fabric direct tool approval needs an extension context");
      await approver.approve(event, context);
    }
    return undefined;
  }

  toolResult(event: ToolResultEvent): { isError: true } | undefined {
    if (
      event.toolName !== FABRIC_TOOL_NAME ||
      event.toolCallId.startsWith(NESTED_TOOL_CALL_ID_PREFIX) ||
      !this.#outerCalls.delete(event.toolCallId)
    ) {
      return undefined;
    }
    return !event.isError && finalFabricDetailsFailed(event.details)
      ? { isError: true }
      : undefined;
  }

  clear(): void {
    this.#outerCalls.clear();
  }

  async #authorizeTopLevel(event: ToolCallEvent): Promise<void> {
    await this.authorizer()?.authorize(
      `${TOP_LEVEL_SCHEMA_REF_PREFIX}${event.toolName}`,
      event.toolCallId,
    );
  }
}

export interface ToolOwnershipReassertion {
  reassert(): void;
  schedule(): void;
}

// Re-asserts active-set ownership after registry refreshes and at turn
// boundaries. Refresh-driven microtasks can run before the host finished
// initializing (registry rebuilds happen before session_start), when neither
// the live config nor the active tool set is safe to touch — `ready` guards
// every entry point, including the deferred microtask.
export const createToolOwnershipReassertion = (options: {
  ready: () => boolean;
  active: () => boolean;
  hiddenNames: () => ReadonlySet<string>;
  apply: (hidden: ReadonlySet<string>) => boolean;
}): ToolOwnershipReassertion => {
  let queued = false;
  const reassert = (): void => {
    queued = false;
    if (!options.ready() || !options.active()) return;
    options.apply(options.hiddenNames());
  };
  return {
    reassert,
    schedule: () => {
      if (queued) return;
      queued = true;
      queueMicrotask(reassert);
    },
  };
};

export class FabricToolOwnership {
  constructor(readonly host: FabricToolOwnershipHost) {}

  apply(fullCodeMode: boolean, _hiddenExtensionTools?: ReadonlySet<string>): boolean {
    if (!fullCodeMode) return false;
    const active = this.host.getActiveTools();
    if (active.includes(FABRIC_TOOL_NAME)) return false;
    this.host.setActiveTools([...active, FABRIC_TOOL_NAME]);
    return true;
  }

  // Native prepareLoadout owns visibility. No active tools were removed, so
  // leaving full-code mode/shutting down has no saved selection to restore.
  release(): boolean { return false; }
}
