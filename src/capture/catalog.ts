import type { ExtensionRunner, RegisteredTool, SourceInfo, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { wrapRegisteredToolForCapture } from "./wrapper.js";
import type { FabricToolCaptureConfig } from "../config.js";
import type { FabricRisk } from "../protocol.js";

export interface CapturedToolEntry {
  name: string;
  definition: ToolDefinition<any, any, any>;
  registeredTool: RegisteredTool;
  sourceInfo: SourceInfo;
  runner: ExtensionRunner;
  wrappedTool: ReturnType<typeof wrapRegisteredToolForCapture>;
  risk: FabricRisk;
}

export class CapturedToolCatalog {
  readonly #tools = new Map<string, CapturedToolEntry>();
  #registered: RegisteredTool[] = [];
  readonly #listeners = new Set<() => void>();
  // The ExtensionRunner observed during the last tool refresh. Stored even
  // when capture is disabled so PiToolsProvider can replay the tool-execution
  // lifecycle (tool_call/tool_result/tool_execution_*) for nested pi.* calls
  // in full-code mode — without it, extensions that hook those events
  // (pi-vision-handoff, auditors, etc.) would never fire for pi core tools.
  #runner: ExtensionRunner | undefined;
  #suspended = false;
  // Set when capture found no ExtensionRunner class in this host: the runner
  // above can then never be set, so guards must not ask the caller to retry.
  #runnerUnavailable = false;

  get runner(): ExtensionRunner | undefined {
    return this.#runner;
  }

  get runnerUnavailable(): boolean {
    return this.#runnerUnavailable && !this.#runner;
  }

  markRunnerUnavailable(): void {
    this.#runnerUnavailable = true;
  }

  // True while capture is suspended between sessions/reloads. Derived
  // surfaces (the repair catalog digest) must freeze: the empty catalog is
  // transient and refills with the same tools on re-arm.
  get suspended(): boolean {
    return this.#suspended;
  }

  markSuspended(): void {
    this.#suspended = true;
  }

  markResumed(): void {
    this.#suspended = false;
  }

  replace(
    registeredTools: RegisteredTool[],
    runner: ExtensionRunner,
    config: FabricToolCaptureConfig,
    ownSourcePath: string,
  ): void {
    // Always remember the runner (see field comment) before the enabled gate.
    this.#runner = runner;
    // Metadata observation is independent of exposing extensions.*. Native MCP
    // opt-in also works when full code mode or extension capture is disabled.
    this.#registered = [...registeredTools];
    this.#tools.clear();
    if (!config.enabled) {
      // A replace under a disabled policy keeps the suspension flag: during
      // /reload the hub listener fires while capture is still suspended, and
      // that empty catalog is transient, not a stable catalog change.
      this.#emit();
      return;
    }
    this.#suspended = false;

    for (const registeredTool of registeredTools) {
      const { definition, sourceInfo } = registeredTool;
      if (sourceInfo.path === ownSourcePath || definition.exposure === "hidden") continue;
      this.#tools.set(definition.name, {
        name: definition.name,
        definition,
        registeredTool,
        sourceInfo,
        runner,
        wrappedTool: wrapRegisteredToolForCapture(registeredTool, runner, (names) => {
          this.remove(names);
        }),
        risk: config.risks[definition.name] ?? config.defaultRisk,
      });
    }
    this.#emit();
  }

  remove(names: Iterable<string>): void {
    let changed = false;
    for (const name of names) changed = this.#tools.delete(name) || changed;
    if (changed) this.#emit();
  }

  clear(): void {
    this.#registered = [];
    this.#tools.clear();
    this.#emit();
  }

  // Re-run the capture pass against the last observed runner. During /reload
  // the hub listener fires while capture is still suspended, so the catalog
  // replaces with enabled:false and ends up empty once session_start
  // re-enables it (#73). This forces a fresh replace with the active policy
  // without waiting for pi to call getAllRegisteredTools() again.
  refresh(): void {
    this.#runner?.getAllRegisteredTools();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  registeredTools(): readonly RegisteredTool[] {
    return this.#suspended ? [] : this.#registered;
  }

  get(name: string): CapturedToolEntry | undefined {
    return this.#tools.get(name);
  }

  require(name: string): CapturedToolEntry {
    const tool = this.#tools.get(name);
    if (!tool) throw new Error(`Unknown captured extension tool: ${name}`);
    return tool;
  }

  list(): CapturedToolEntry[] {
    return [...this.#tools.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  get size(): number {
    return this.#tools.size;
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch { /* Catalog observers cannot interrupt capture refresh. */ }
    }
  }
}
