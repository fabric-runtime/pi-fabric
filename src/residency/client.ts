import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  writeJsonAtomic,
  recordOwnerLiveness,
} from "../core/atomic-write.js";
import type { FabricActorInfo, FabricActorRequest } from "../actors/types.js";
import type { FabricAgentLog, AgentHandleInfo, AgentRunRecord, AgentRunRequest, AgentRunResult } from "../agents/types.js";
import { readChildToolAllowlist } from "../core/child-tool-allowlist.js";
import { resolveAgentCwd } from "../agents/manager.js";
import { BUILT_IN_RUNNER_IDS, requireAgentRunner } from "../agents/runner-registry.js";
import { isFabricWorktreePath } from "../agents/worktree-paths.js";
import { executeFile, processIsAlive, spawnDetached } from "../agents/transports/process-utils.js";
import { readJsonlPage } from "../log-tail.js";
import type { FabricOwnedModelGuidance } from "../components/model-guidance.js";
import type { FabricMainAgentTarget } from "../main-agent.js";
import { MeshStore, type MeshStateEntry } from "../mesh/store.js";
import type { FabricParticipantSource } from "../topology/types.js";
import {
  abandonResidentRequest,
  RESIDENT_HOST_FORMAT,
  residentDeliveryPrefix,
  residentHostId,
  sleepUnlessAborted,
  type ResidentAgentMetadata,
  type ResidentCommand,
  type ResidentCommandResponse,
  type ResidentDeliveryRecord,
  type ResidentHostConfig,
  type ResidentHostOwner,
  type ResidentPiModelState,
} from "./protocol.js";

// One-time cost per resident root: cold-starting the bundled pi binary plus
// extension loading can exceed 10s on slow runners (e.g. CI Windows), so give
// startup a generous budget. Idle exit still reclaims the processes.
const STARTUP_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 30_000;
const STATUS_POLL_MS = 100;
// One wait restarts a dead resident host at most this many times, so a host
// that keeps dying fails the wait instead of spinning launchers.
const MAX_WAIT_HOST_STARTS = 3;
const AGENT_ID_PATTERN = /^[a-f0-9]{32}$/;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const atomicWrite = (filePath: string, value: unknown): void => {
  writeJsonAtomic(filePath, value, { space: 2 });
};

const readJson = <T>(filePath: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
};

const untilAborted = <T>(promise: Promise<T>, signal: AbortSignal | undefined, aborted: () => Error): Promise<T> => {
  if (!signal) return promise;
  promise.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(aborted());
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
};

const terminal = (status: string): status is AgentRunResult["status"] =>
  status === "completed" || status === "failed" || status === "stopped" || status === "timed_out";

const samePath = (left: string, right: string): boolean => {
  try {
    return path.relative(fs.realpathSync.native(left), fs.realpathSync.native(right)) === "";
  } catch {
    return false;
  }
};

/** Refuse cleanup unless the selected repository still owns this worktree. */
const registeredWorktree = async (gitRoot: string, worktreePath: string): Promise<string> => {
  let output: string;
  try {
    output = (await executeFile("git", ["worktree", "list", "--porcelain"], {
      cwd: gitRoot,
      timeoutMs: 30_000,
    })).stdout;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot validate durable worktree ${JSON.stringify(worktreePath)}: ${reason}`);
  }
  const registered = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  const match = registered.find((candidate) => samePath(candidate, worktreePath));
  if (!match) {
    throw new Error(
      `Refusing durable worktree cleanup: ${JSON.stringify(worktreePath)} is not registered by ${JSON.stringify(gitRoot)}`,
    );
  }
  return match;
};

export interface ResidencyClientOptions {
  config: ResidentHostConfig;
  mesh: MeshStore;
  participants: FabricParticipantSource;
  mainAgent: FabricMainAgentTarget;
  piModelState?: () => ResidentPiModelState;
  onBackgroundComplete?: (result: AgentRunResult, delivered: () => void) => void;
  onResultConsumed?: (id: string) => void;
  hostPath?: string;
}

export class ResidencyClient {
  readonly hostId: string;
  readonly #configPath: string;
  readonly #ownerPath: string;
  readonly #errorPath: string;
  readonly #requestsPath: string;
  readonly #responsesPath: string;
  readonly #agentsPath: string;
  readonly #inheritedToolAllowlist = readChildToolAllowlist();
  readonly #deliveryPrefix: string;
  readonly #hostPath: string;
  #deliveryTimer: NodeJS.Timeout | undefined;
  #modelGuidanceJson: string | undefined;
  #drainingDeliveries = false;
  #closed = false;
  #hostStart: Promise<ResidentHostOwner> | undefined;

  constructor(readonly options: ResidencyClientOptions) {
    this.hostId = residentHostId(options.config.rootId);
    this.#configPath = path.join(options.config.residencyRoot, "config.json");
    this.#ownerPath = path.join(options.config.residencyRoot, "owner.json");
    this.#errorPath = path.join(options.config.residencyRoot, "error.json");
    this.#requestsPath = path.join(options.config.residencyRoot, "requests");
    this.#responsesPath = path.join(options.config.residencyRoot, "responses");
    this.#agentsPath = path.join(options.config.residencyRoot, "agents");
    this.#deliveryPrefix = residentDeliveryPrefix(options.config.rootId);
    this.#hostPath = options.hostPath ?? fileURLToPath(new URL("./launcher.js", import.meta.url));
  }

  start(): void {
    if (this.#deliveryTimer || this.#closed || !this.options.mainAgent.local) return;
    this.syncPiModels();
    this.#deliveryTimer = setInterval(
      () => void this.#drainDeliveries().catch(() => undefined),
      Math.max(20, this.options.config.mesh.actorPollMs),
    );
    this.#deliveryTimer.unref();
    void this.#drainDeliveries().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#deliveryTimer) clearInterval(this.#deliveryTimer);
    this.#deliveryTimer = undefined;
    while (this.#drainingDeliveries) await delay(10);
  }

  syncPiModels(): void {
    this.#refreshPiModels();
    if (fs.existsSync(this.options.config.residencyRoot)) {
      atomicWrite(this.#configPath, this.options.config);
    }
  }

  updateModelGuidance(guidance: readonly FabricOwnedModelGuidance[]): void {
    const snapshot: FabricOwnedModelGuidance[] = structuredClone([...guidance]);
    const serialized = JSON.stringify(snapshot);
    if (serialized === this.#modelGuidanceJson) return;
    this.#modelGuidanceJson = serialized;
    this.options.config.modelGuidance = snapshot;
    this.#refreshPiModels();
    if (fs.existsSync(this.options.config.residencyRoot)) {
      atomicWrite(this.#configPath, this.options.config);
    }
  }

  async ensureHost(): Promise<ResidentHostOwner> {
    if (this.#closed) throw new Error("Fabric residency client is closed");
    this.#refreshPiModels();
    atomicWrite(this.#configPath, this.options.config);
    const existing = this.#liveOwner();
    if (existing) return existing;
    // Concurrent callers in this process share one launch. Across processes the
    // host's start lock admits one owner; a losing launcher exits quietly.
    this.#hostStart ??= this.#startHost().finally(() => {
      this.#hostStart = undefined;
    });
    return this.#hostStart;
  }

  async #startHost(): Promise<ResidentHostOwner> {
    fs.rmSync(this.#errorPath, { force: true });
    await spawnDetached(
      this.#hostPath,
      ["--config", this.#configPath],
      this.options.config.cwd,
    );
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const owner = this.#liveOwner();
      if (owner) return owner;
      const failure = readJson<{ error?: unknown }>(this.#errorPath);
      if (typeof failure?.error === "string") {
        throw new Error(`Fabric resident host failed to start: ${failure.error}`);
      }
      await delay(STATUS_POLL_MS);
    }
    // Surface any launcher-recorded child output so a silent slow start (or a
    // quiet child crash) is diagnosable from the error alone.
    const readIfPresent = (name: string): string => {
      try { return fs.readFileSync(path.join(this.options.config.residencyRoot, name), "utf8").trim(); } catch { return ""; }
    };
    const childOutput = readIfPresent("child-stderr.log");
    const launcherLog = readIfPresent("launcher.log").split("\n").slice(-6).join("\n");
    const ownerState = readIfPresent("owner.json").slice(0, 300);
    const diagnostics = [
      childOutput ? `Child output: ${childOutput.slice(-500)}` : "",
      launcherLog ? `Launcher log: ${launcherLog}` : "",
      ownerState ? `Owner state: ${ownerState}` : "Owner state: absent",
    ].filter(Boolean).join(" | ");
    throw new Error(`Timed out starting Fabric resident host ${this.hostId}. ${diagnostics}`);
  }

  #refreshPiModels(): void {
    const state = this.options.piModelState?.();
    if (state) this.options.config.piModels = structuredClone(state);
  }

  async ensureActor(id: string): Promise<void> {
    await this.ensureHost();
    await this.#waitForParticipant(id, "actor");
  }

  async createActor(request: FabricActorRequest): Promise<FabricActorInfo> {
    await this.ensureHost();
    const response = await this.#command({
      format: RESIDENT_HOST_FORMAT,
      operation: "createActor",
      requestId: randomUUID(),
      rootId: this.options.config.rootId,
      request,
      createdAt: Date.now(),
    });
    if (!response.actor) throw new Error("Fabric resident host returned no actor");
    await this.#waitForParticipant(response.actor.id, "actor");
    return response.actor;
  }

  async spawnAgent(request: AgentRunRequest, signal?: AbortSignal): Promise<AgentHandleInfo> {
    const resolvedRequest = request.cwd === undefined
      ? request
      : { ...request, cwd: resolveAgentCwd(this.options.config.cwd, request.cwd) };
    // Registration is process-local: the resident host must import the runner too.
    const runner = request.runner ?? this.options.config.agents.runner;
    const runnerModule = BUILT_IN_RUNNER_IDS.has(runner) ? undefined : requireAgentRunner(runner).residentModule;
    if (!BUILT_IN_RUNNER_IDS.has(runner) && !runnerModule) {
      throw new Error(`Fabric runner ${runner} declares no residentModule; durable residency needs one`);
    }
    // Freeze inherited optional-tool authority before transferring to an existing host.
    const allowedTools = this.#inheritedToolAllowlist;
    const tools = allowedTools === undefined ? undefined
      : (request.tools ?? this.options.config.agents.defaultTools).filter((tool) => allowedTools.has(tool));
    await this.ensureHost();
    const response = await this.#command(
      {
        format: RESIDENT_HOST_FORMAT,
        operation: "spawn",
        requestId: randomUUID(),
        rootId: this.options.config.rootId,
        request: { ...resolvedRequest, ...(tools ? { tools } : {}), residency: "durable" },
        ...(runnerModule ? { runnerModule } : {}),
        createdAt: Date.now(),
      },
      signal,
    );
    if (!response.handle) throw new Error("Fabric resident host returned no agent handle");
    await this.#waitForParticipant(response.handle.id, "agent");
    return response.handle;
  }

  hasAgent(id: string): boolean {
    return AGENT_ID_PATTERN.test(id) && fs.existsSync(this.#metadataPath(id));
  }

  statusAgent(id: string): AgentRunRecord | AgentHandleInfo {
    const metadata = this.#metadata(id);
    if (!metadata) throw new Error(`Unknown durable Fabric agent: ${id}`);
    const record = readJson<AgentRunRecord>(path.join(metadata.runDirectory, "status.json"));
    if (!record || record.id !== metadata.id) return structuredClone(metadata.handle);
    return {
      ...record,
      cwd: metadata.handle.cwd,
      ...(metadata.handle.kernel ? { kernel: metadata.handle.kernel } : {}),
      ...(metadata.handle.recursive ? { recursive: true } : {}),
      residency: "durable",
      logFile: path.join(metadata.runDirectory, "events.jsonl"),
      ...(metadata.handle.sessionId ? { sessionId: metadata.handle.sessionId } : {}),
      ...(metadata.handle.attachCommand ? { attachCommand: metadata.handle.attachCommand } : {}),
    };
  }

  listAgents(): Array<AgentRunRecord | AgentHandleInfo> {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.#agentsPath);
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.endsWith(".json"))
      .flatMap((entry) => {
        try {
          return [this.statusAgent(entry.slice(0, -5))];
        } catch {
          return [];
        }
      });
  }

  acknowledgeCompletion(id: string): void {
    const metadata = this.#metadata(id);
    if (!metadata) return;
    if (!metadata.completionConsumedAt) {
      atomicWrite(this.#metadataPath(id), { ...metadata, completionConsumedAt: Date.now() });
    }
    this.options.onResultConsumed?.(id);
  }

  async waitAgent(id: string, signal?: AbortSignal): Promise<AgentRunResult> {
    const aborted = (): Error => new Error(`Waiting for durable Fabric agent ${id} was aborted`);
    let hostStarts = 0;
    while (true) {
      if (signal?.aborted) throw aborted();
      const status = this.statusAgent(id);
      if (terminal(status.status) && "startedAt" in status) {
        this.acknowledgeCompletion(id);
        return status as AgentRunResult;
      }
      // Only the resident host settles its runs. With no live owner nothing will,
      // so restart it: the new host re-attaches the run. Re-read the status first
      // in case the host settled the run and exited between the two reads.
      if (!this.#liveOwner()) {
        const current = this.statusAgent(id);
        if (terminal(current.status) && "startedAt" in current) continue;
        // A new host re-attaches only hosted runs (AgentManager.recoverHostedRuns).
        // Nothing settles any other run once its host is gone, so fail now.
        if (!("hosted" in current && current.hosted)) {
          throw new Error(
            `Durable Fabric agent ${id} (runner ${current.runner}) cannot finish: its resident host ${this.hostId} stopped, and a new host re-attaches only hosted runs`,
          );
        }
        if (hostStarts >= MAX_WAIT_HOST_STARTS) {
          throw new Error(
            `Fabric resident host ${this.hostId} stopped ${hostStarts} times while durable Fabric agent ${id} was unfinished`,
          );
        }
        hostStarts += 1;
        // A start failure rejects the wait. An aborted wait stops waiting; the
        // host start itself runs on and the next host idles out if unused.
        await untilAborted(this.ensureHost(), signal, aborted);
        continue;
      }
      await sleepUnlessAborted(STATUS_POLL_MS, signal).catch(() => undefined);
    }
  }

  readAgentLog(id: string, options: { lines?: number; before?: number } = {}): FabricAgentLog {
    const metadata = this.#metadata(id);
    if (!metadata) throw new Error(`Unknown durable Fabric agent: ${id}`);
    const logFile = path.join(metadata.runDirectory, "events.jsonl");
    const page = readJsonlPage(logFile, Math.max(1, Math.min(options.lines ?? 200, 5_000)), options.before);
    const status = readJson<AgentRunRecord>(path.join(metadata.runDirectory, "status.json"));
    return {
      id,
      runDirectory: metadata.runDirectory,
      logFile,
      ...(status ? { status: { ...status, cwd: metadata.handle.cwd, residency: "durable" } } : {}),
      events: page.lines,
      hasMore: page.hasMore,
      ...(page.before !== undefined ? { before: page.before } : {}),
    };
  }

  async removeActor(id: string): Promise<{ removed: boolean }> {
    await this.ensureHost();
    await this.#command({
      format: RESIDENT_HOST_FORMAT,
      operation: "removeActor",
      requestId: randomUUID(),
      rootId: this.options.config.rootId,
      id,
      createdAt: Date.now(),
    });
    return { removed: true };
  }

  async cleanupAgent(id: string, deleteBranch = false): Promise<{ cleaned: boolean }> {
    const metadata = this.#metadata(id);
    if (!metadata) throw new Error(`Unknown durable Fabric agent: ${id}`);
    if (!this.#liveOwner()) return this.#cleanupTerminalFiles(metadata, deleteBranch);
    let response: ResidentCommandResponse;
    try {
      response = await this.#command({
        format: RESIDENT_HOST_FORMAT,
        operation: "cleanup",
        requestId: randomUUID(),
        rootId: this.options.config.rootId,
        id,
        deleteBranch,
        createdAt: Date.now(),
      });
    } catch (error) {
      if (error instanceof Error && /Unknown Fabric agent/.test(error.message)) {
        return this.#cleanupTerminalFiles(metadata, deleteBranch);
      }
      throw error;
    }
    if (!response.ok) throw new Error(response.error ?? `Failed to clean durable Fabric agent ${id}`);
    this.options.onResultConsumed?.(id);
    return { cleaned: true };
  }

  async #cleanupTerminalFiles(
    metadata: ResidentAgentMetadata,
    deleteBranch: boolean,
  ): Promise<{ cleaned: boolean }> {
    const status = this.statusAgent(metadata.id);
    if (!("startedAt" in status) || !terminal(status.status)) {
      throw new Error(`Cannot clean up running durable Fabric agent ${metadata.id}`);
    }
    if (metadata.handle.worktree) {
      const gitRoot = metadata.worktreeGitRoot ?? this.options.config.projectRoot;
      const worktree = await registeredWorktree(gitRoot, metadata.handle.worktree);
      await executeFile(
        "git",
        ["worktree", "remove", "--force", worktree],
        { cwd: gitRoot, timeoutMs: 60_000 },
      );
      if (deleteBranch && metadata.handle.branch) {
        await executeFile(
          "git",
          ["branch", "-D", metadata.handle.branch],
          { cwd: gitRoot, timeoutMs: 30_000 },
        );
      }
    } else if (deleteBranch) {
      throw new Error(`Durable Fabric agent ${metadata.id} has no worktree branch to delete`);
    }
    fs.rmSync(metadata.runDirectory, { recursive: true, force: true });
    fs.rmSync(this.#metadataPath(metadata.id), { force: true });
    this.options.onResultConsumed?.(metadata.id);
    return { cleaned: true };
  }

  async #command(command: ResidentCommand, signal?: AbortSignal): Promise<ResidentCommandResponse> {
    const responsePath = path.join(this.#responsesPath, `${command.requestId}.json`);
    atomicWrite(path.join(this.#requestsPath, `${command.requestId}.json`), command);
    const deadline = Date.now() + COMMAND_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error("Fabric residency request was aborted");
        const response = readJson<ResidentCommandResponse>(responsePath);
        if (response?.format === RESIDENT_HOST_FORMAT && response.requestId === command.requestId) {
          fs.rmSync(responsePath, { force: true });
          if (!response.ok) throw new Error(response.error ?? "Fabric resident host rejected request");
          return response;
        }
        const owner = this.#liveOwner();
        if (!owner) throw new Error("Fabric resident host exited while processing a request");
        await sleepUnlessAborted(STATUS_POLL_MS, signal).catch(() => undefined);
      }
      throw new Error(`Timed out waiting for Fabric residency request ${command.requestId}`);
    } catch (error) {
      abandonResidentRequest(this.#requestsPath, this.#responsesPath, command.requestId);
      throw error;
    }
  }

  async #waitForParticipant(id: string, kind: "actor" | "agent"): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const participant = this.options.participants.get(id);
      if (
        participant?.kind === kind &&
        participant.ownerHostId === this.hostId &&
        participant.residency === "durable" &&
        !participant.stale
      ) {
        return;
      }
      await delay(STATUS_POLL_MS);
    }
    throw new Error(`Timed out publishing durable Fabric ${kind} ${id} from ${this.hostId}`);
  }

  #metadataPath(id: string): string {
    return path.join(this.#agentsPath, `${id}.json`);
  }

  #metadata(id: string): ResidentAgentMetadata | undefined {
    if (!AGENT_ID_PATTERN.test(id)) return undefined;
    const metadata = readJson<ResidentAgentMetadata>(this.#metadataPath(id));
    if (
      metadata?.format !== RESIDENT_HOST_FORMAT ||
      metadata.rootId !== this.options.config.rootId ||
      metadata.id !== id ||
      metadata.handle.id !== id ||
      (metadata.worktreeGitRoot !== undefined && typeof metadata.worktreeGitRoot !== "string") ||
      path.resolve(metadata.runDirectory) !==
        path.resolve(this.options.config.residencyRoot, "runs", id)
    ) {
      return undefined;
    }
    if (metadata.handle.worktree && !isFabricWorktreePath(metadata.handle.worktree, id)) {
      return undefined;
    }
    if (
      metadata.handle.branch &&
      (!metadata.handle.branch.startsWith("pi-fabric/") ||
        !metadata.handle.branch.endsWith(`-${id.slice(0, 8)}`))
    ) {
      return undefined;
    }
    return metadata;
  }

  #liveOwner(): ResidentHostOwner | undefined {
    const owner = readJson<ResidentHostOwner>(this.#ownerPath);
    if (
      owner?.format !== RESIDENT_HOST_FORMAT ||
      owner.hostId !== this.hostId ||
      !Number.isSafeInteger(owner.pid) ||
      // A host in another PID namespace is judged by its heartbeat.
      recordOwnerLiveness(owner, { legacyAlive: processIsAlive }) === "dead"
    ) {
      return undefined;
    }
    return owner;
  }

  async #drainDeliveries(): Promise<void> {
    if (this.#drainingDeliveries || this.#closed || !this.options.mainAgent.local) return;
    this.#drainingDeliveries = true;
    try {
      const entries = this.options.mesh.listAll(this.#deliveryPrefix);
      for (const entry of entries) await this.#deliver(entry);
    } finally {
      this.#drainingDeliveries = false;
    }
  }

  async #deliver(entry: MeshStateEntry): Promise<void> {
    if (typeof entry.value !== "object" || entry.value === null || Array.isArray(entry.value)) return;
    const value = entry.value as Partial<ResidentDeliveryRecord>;
    if (
      value.format !== RESIDENT_HOST_FORMAT ||
      value.rootId !== this.options.config.rootId ||
      typeof value.id !== "string" ||
      typeof value.message !== "string" ||
      (value.delivery !== "steer" && value.delivery !== "followUp") ||
      typeof value.triggerTurn !== "boolean" ||
      typeof value.from !== "object" ||
      value.from === null ||
      entry.updatedBy.id !== this.hostId
    ) {
      return;
    }
    const data = value.data as Partial<AgentRunResult> | undefined;
    // Also recognize envelopes written by an older resident host.
    const completionId = value.agentCompletionId ?? (data && typeof data.status === "string" &&
      terminal(data.status) && typeof data.startedAt === "number" ? data.id : undefined);
    if (value.from.kind === "agent" && typeof completionId === "string" && completionId === value.from.id) {
      const metadata = this.#metadata(completionId);
      if (!metadata || metadata.completionConsumedAt || !this.options.config.agents.notifyOnComplete) {
        await this.options.mesh.delete({ key: entry.key, ifVersion: entry.version });
        return;
      }
      if (this.options.onBackgroundComplete) {
        // Keep the durable envelope until Main actually consumes it, not merely
        // until the TUI copies it into its retractable in-memory inbox.
        const result = this.statusAgent(completionId);
        if (terminal(result.status) && "startedAt" in result) {
          this.options.onBackgroundComplete(result as AgentRunResult, () => this.acknowledgeCompletion(completionId));
        }
        return;
      }
    }
    this.options.mainAgent.deliverAgent({
      from: value.from,
      message: value.message,
      delivery: value.delivery,
      triggerTurn: value.triggerTurn,
      ...(value.data === undefined ? {} : { data: value.data }),
    });
    await this.options.mesh.delete({ key: entry.key, ifVersion: entry.version });
  }
}
