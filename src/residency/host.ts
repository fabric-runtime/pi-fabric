#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  writeJsonAtomic,
  ownerHeartbeatFields,
  recordOwnerLiveness,
  startOwnerHeartbeat,
} from "../core/atomic-write.js";
import {
  normalizeModelAliases,
  resolvePiModelSelector,
  type FabricModelCandidate,
  type FabricModelMatch,
} from "../core/model-resolution.js";
import { loadModelUsage } from "../core/model-usage.js";
import {
  parseFabricOwnedModelGuidance,
  resolveFabricModelGuidance,
} from "../components/model-guidance.js";
import { ActorDirectory } from "../actors/directory.js";
import type { FabricActorInfo } from "../actors/types.js";
import { AgentManager } from "../agents/manager.js";
import { cancelOrphanedChildQuestions, routeChildQuestion } from "../decisions/host.js";
import { DecisionStore } from "../decisions/store.js";
import { launchScope } from "../scope.js";
import { useBudgetLedger } from "../agents/budget-ledger.js";
import { LifecycleBroker } from "../lifecycle/broker.js";
import { lifecycleSourceIdentity, type FabricLifecycleEvent, type FabricLifecycleSubscription } from "../lifecycle/types.js";
import { MeshStore, type MeshIdentity } from "../mesh/store.js";
import { FabricControlPlane, type FabricControlAcceptance, type FabricControlCommand } from "../topology/control-plane.js";
import { ParticipantDirectory } from "../topology/participant-directory.js";
import { actorParticipantRecord, agentParticipantRecords } from "../topology/records.js";
import {
  RESIDENT_HOST_FORMAT,
  residentDeliveryPrefix,
  residentHostId,
  type ResidentAgentMetadata,
  type ResidentCommand,
  type ResidentCommandResponse,
  type ResidentDeliveryRecord,
  type ResidentHostConfig,
  type ResidentHostOwner,
} from "./protocol.js";

const REQUEST_POLL_MS = 50;
const IDLE_EXIT_MS = 30_000;
const COMPLETION_MAX_CHARS = 8_000;

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

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const processAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // On Windows, EPERM means the process exists but cannot be opened for
    // signaling; only ESRCH (or other errors) mean it is gone.
    return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

// Identity-less (pre-heartbeat) owners keep the plain signal probe; an owner
// in another PID namespace is judged by its heartbeat, and "unknown" is not death.
const ownerAlive = (record: unknown): boolean =>
  recordOwnerLiveness(record, { legacyAlive: processAlive }) !== "dead";

// The resident host runs Pi with --no-extensions, so a custom runner is only
// registered here when its residentModule is imported (once per process).
const runnerModules = new Map<string, Promise<void>>();
const loadRunnerModule = (specifier: string): Promise<void> => {
  if (!/^(?:\/|[A-Za-z]:[\\/]|file:)/.test(specifier)) {
    return Promise.reject(new Error(`Fabric runner module must be absolute: ${specifier}`));
  }
  const url = specifier.startsWith("file:") ? specifier : pathToFileURL(specifier).href;
  let pending = runnerModules.get(url);
  if (!pending) {
    pending = import(url).then(() => undefined);
    runnerModules.set(url, pending);
    pending.catch(() => runnerModules.delete(url));
  }
  return pending;
};

class ResidentHostAlreadyRunning extends Error {}

const parseResidentHostConfigPath = (argv: readonly string[]): string => {
  const index = argv.indexOf("--config");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) throw new Error("Missing resident host argument: --config");
  return path.resolve(value);
};

const validateResidentHostConfig = (value: unknown, configPath: string): ResidentHostConfig => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid Fabric resident host config");
  }
  const config = value as Partial<ResidentHostConfig>;
  if (
    config.format !== RESIDENT_HOST_FORMAT ||
    typeof config.rootId !== "string" ||
    typeof config.sessionId !== "string" ||
    typeof config.cwd !== "string" ||
    typeof config.projectRoot !== "string" ||
    typeof config.meshRoot !== "string" ||
    typeof config.actorRoot !== "string" ||
    (config.sessionActorRoot !== undefined && typeof config.sessionActorRoot !== "string") ||
    typeof config.residencyRoot !== "string" ||
    typeof config.fullCodeMode !== "boolean" ||
    (config.kernel !== undefined && config.kernel !== "typescript" && config.kernel !== "python") ||
    (config.pythonRuntime !== undefined && config.pythonRuntime !== "cpython" && config.pythonRuntime !== "monty") ||
    typeof config.agents !== "object" ||
    config.agents === null ||
    typeof config.mesh !== "object" ||
    config.mesh === null ||
    typeof config.retention !== "object" ||
    config.retention === null ||
    typeof config.workerPath !== "string" ||
    typeof config.fabricExtensionPath !== "string" ||
    typeof config.piBinary !== "string" ||
    typeof config.claudeBinary !== "string" ||
    typeof config.vedaBinary !== "string"
  ) {
    throw new Error("Fabric resident host config is incomplete");
  }
  if (path.resolve(config.residencyRoot) !== path.dirname(configPath)) {
    throw new Error("Fabric resident host config is outside its residency root");
  }
  if (!config.mesh.enabled) throw new Error("Durable residency requires the Fabric mesh");
  return config as ResidentHostConfig;
};

/**
 * The resident host's idle rule. Live durable participants, queued work or a
 * pending request keep it alive; pending mesh schedules do too while at least
 * one durable participant could receive them, and `wakeAt` names the next due
 * time so the host releases it on time. Without durable participants a
 * schedule waits for the next Fabric process that touches the mesh.
 */
export const residentIdleDecision = (input: {
  now: number;
  idleSince: number;
  activeActor: boolean;
  activeAgent: boolean;
  pendingRequest: boolean;
  durableParticipants: boolean;
  nextScheduleDueAt: number | undefined;
  idleExitMs?: number;
}): { busy: boolean; exit: boolean; wakeAt?: number } => {
  const holdsSchedules = input.nextScheduleDueAt !== undefined && input.durableParticipants;
  const wakeAt = holdsSchedules ? input.nextScheduleDueAt : undefined;
  const busy = input.activeActor || input.activeAgent || input.pendingRequest || holdsSchedules;
  const exit = !busy && input.now - input.idleSince >= (input.idleExitMs ?? IDLE_EXIT_MS);
  return { busy, exit, ...(wakeAt !== undefined ? { wakeAt } : {}) };
};

class ResidentHost {
  readonly hostId: string;
  readonly identity: MeshIdentity;
  readonly mesh: MeshStore;
  readonly participants: ParticipantDirectory;
  readonly control: FabricControlPlane;
  readonly agents: AgentManager;
  readonly actors: ActorDirectory;
  readonly lifecycle: LifecycleBroker;
  readonly #decisions: DecisionStore;
  readonly #ownerPath: string;
  readonly #lockPath: string;
  readonly #errorPath: string;
  readonly #requestsPath: string;
  readonly #processingPath: string;
  readonly #responsesPath: string;
  readonly #agentsPath: string;
  readonly #deliveryPrefix: string;
  readonly #token = randomUUID();
  #requestTimer: NodeJS.Timeout | undefined;
  #scheduleTimer: NodeJS.Timeout | undefined;
  #scheduleWakeAt: number | undefined;
  #stopHeartbeat: (() => void) | undefined;
  #pollingRequests = false;
  #closed = false;
  #started = false;
  #idleSince = Date.now();

  constructor(
    readonly config: ResidentHostConfig,
    readonly onIdle: () => void = () => {},
  ) {
    this.hostId = residentHostId(config.rootId);
    this.identity = { id: this.hostId, name: "Fabric resident host", kind: "agent" };
    this.#ownerPath = path.join(config.residencyRoot, "owner.json");
    this.#lockPath = path.join(config.residencyRoot, "host.lock");
    this.#errorPath = path.join(config.residencyRoot, "error.json");
    this.#requestsPath = path.join(config.residencyRoot, "requests");
    this.#processingPath = path.join(config.residencyRoot, "processing");
    this.#responsesPath = path.join(config.residencyRoot, "responses");
    this.#agentsPath = path.join(config.residencyRoot, "agents");
    this.#deliveryPrefix = residentDeliveryPrefix(config.rootId);
    this.mesh = new MeshStore(config.meshRoot, config.mesh.maxEventBytes, config.mesh.maxReadEvents, {
      durability: config.mesh.durability,
    });
    this.control = new FabricControlPlane(this.mesh, this.identity, {
      enabled: true,
      hostId: this.hostId,
      pollMs: config.mesh.actorPollMs,
    });
    this.participants = new ParticipantDirectory(this.mesh, {
      enabled: true,
      hostId: this.hostId,
      rootId: config.rootId,
      identity: this.identity,
      ownerIncarnation: this.control.incarnation,
      departedRetentionMs: config.mesh.departedRetentionMs,
    });
    if (config.agents.budgetUsd > 0) {
      const budgetFile = path.join(config.residencyRoot, "budget.jsonl");
      fs.mkdirSync(path.dirname(budgetFile), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(budgetFile)) fs.writeFileSync(budgetFile, "", { mode: 0o600 });
      useBudgetLedger({
        budget: config.agents.budgetUsd,
        file: budgetFile,
        id: this.hostId,
      });
    }
    const guidanceConfigPath = path.join(config.residencyRoot, "config.json");
    const currentConfig = (): Partial<ResidentHostConfig> =>
      readJson<Partial<ResidentHostConfig>>(guidanceConfigPath) ?? config;
    const currentModelGuidance = () =>
      parseFabricOwnedModelGuidance(currentConfig().modelGuidance ?? config.modelGuidance);
    const resolveResidentPiModel = (selector?: string, modelMatch?: FabricModelMatch): string => {
      const state = currentConfig().piModels ?? config.piModels;
      const available: FabricModelCandidate[] = Array.isArray(state?.available)
        ? state.available.flatMap((candidate) =>
            typeof candidate?.provider === "string" && typeof candidate.id === "string"
              ? [{
                  provider: candidate.provider,
                  id: candidate.id,
                  ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
                }]
              : [],
          )
        : [];
      const query = selector?.trim() || state?.defaultModel?.trim() || "";
      const resolved = resolvePiModelSelector(query, {
        aliases: normalizeModelAliases(state?.aliases),
        available,
        lastUsed: loadModelUsage(),
      }, modelMatch);
      return `${resolved.provider}/${resolved.id}`;
    };
    // agents.childQuestions "route": this host has no UI, so a durable child's
    // dialog always becomes a root-held decision in the project mesh, answered
    // by a root session or the decisions CLI. The run's settlement cancels it, and
    // so does detaching a durable hosted run at shutdown (see #startOwned for a
    // host that died instead).
    this.#decisions = new DecisionStore(this.mesh, {
      id: this.identity.id,
      name: this.identity.name,
      kind: this.identity.kind,
      sessionId: config.sessionId,
    });
    this.agents = new AgentManager(config.cwd, config.agents, {
      workerPath: config.workerPath,
      fabricExtensionPath: config.fabricExtensionPath,
      piBinary: config.piBinary,
      claudeBinary: config.claudeBinary,
      vedaBinary: config.vedaBinary,
      runRoot: path.join(config.residencyRoot, "runs"),
      fullCodeMode: config.fullCodeMode,
      kernel: () => currentConfig().kernel ?? config.kernel ?? "typescript",
      pythonRuntime: () => currentConfig().pythonRuntime ?? config.pythonRuntime ?? "monty",
      mainAgentId: config.rootId,
      fabricSessionId: config.sessionId,
      meshRoot: config.meshRoot,
      projectRoot: config.projectRoot,
      hostId: this.hostId,
      identityId: this.identity.id,
      retention: config.retention,
      preparePiModel: async (model, options) => resolveResidentPiModel(model, options?.modelMatch),
      resolveParticipantGuidance: ({ model }) => {
        if (!model) return undefined;
        return resolveFabricModelGuidance(currentModelGuidance(), {
          model,
          target: "participant",
          includeSlots: false,
        }).appendText || undefined;
      },
      onLifecycle: (event) => void this.lifecycle?.publish(event).catch(() => undefined),
      onChildQuestion: (request) => routeChildQuestion(request, { store: this.#decisions }),
      onBackgroundComplete: (result) => {
        if (!config.agents.notifyOnComplete) return;
        const durationMs = Math.max(0, (result.finishedAt ?? Date.now()) - result.startedAt);
        const summary = (result.text || result.error || "no result").slice(0, COMPLETION_MAX_CHARS);
        void this.#queueDelivery(
          { id: result.id, name: result.name, kind: "agent" },
          `Fabric agent ${result.id.slice(0, 8)} ${result.status} after ${Math.round(durationMs / 1_000)}s: ${summary}`,
          "steer",
          true,
          result,
          result.id,
        ).catch(() => undefined);
      },
    });
    const canManageActor = (id: string): boolean | undefined => {
      const participant = this.participants.get(id);
      return participant ? participant.ownerHostId === this.hostId : undefined;
    };
    const lineageAlive = (rootId: string): boolean =>
      this.participants.get(rootId) !== undefined;
    const actorRoots = config.sessionActorRoot
      ? { project: config.actorRoot, session: config.sessionActorRoot }
      : config.mesh.actorScope === "session"
        ? { project: path.dirname(config.actorRoot), session: config.actorRoot }
        : { project: config.actorRoot, session: path.join(config.actorRoot, config.sessionId) };
    this.actors = new ActorDirectory([
      config.sessionId,
      this.identity,
      this.mesh,
      config.mesh,
      this.agents,
      ({ actor, message, delivery, triggerTurn }) => {
        if (!message.text) return;
        const mode = delivery === "steer" ? "steer" : "followUp";
        const triggers = delivery === "nextTurn" ? false : triggerTurn;
        void this.#queueDelivery(
          { id: actor.id, name: actor.name, kind: "actor" },
          message.text,
          mode,
          triggers,
          message.data,
        ).catch(() => undefined);
      },
      {
        persistent: true,
        canManageActor,
        lineageAlive,
        claimResidency: "durable",
        rootId: config.rootId,
        meshCursorPath: path.join(config.residencyRoot, "actor-mesh-cursor.json"),
        retention: config.retention,
        resolvePiModel: resolveResidentPiModel,
      },
    ], actorRoots, config.mesh.actorScope);
    this.lifecycle = new LifecycleBroker(
      this.mesh,
      this.identity,
      this.participants,
      {
        enabled: true,
        pollMs: config.mesh.actorPollMs,
        maxReadEvents: config.mesh.maxReadEvents,
      },
      (subscription, event) => this.#deliverLifecycle(subscription, event),
    );
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#acquireLock();
    this.#started = true;
    this.#stopHeartbeat = startOwnerHeartbeat((heartbeatAt) => this.#refreshHeartbeat(heartbeatAt));
    try {
      await this.#startOwned();
    } catch (error) {
      this.#stopHeartbeat();
      this.#stopHeartbeat = undefined;
      throw error;
    }
  }

  async #startOwned(): Promise<void> {
    fs.mkdirSync(this.#requestsPath, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.#processingPath, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.#responsesPath, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.#agentsPath, { recursive: true, mode: 0o700 });
    this.#recoverInterruptedRequests();
    // An earlier host that died left its routed questions open, and their answers
    // would reach nothing. Cancel them before re-attaching runs, whose runners ask
    // again through this host. A failure must not stop startup, but it leaves those
    // decisions open, so report it on stderr; the launcher keeps it in child-stderr.log.
    await cancelOrphanedChildQuestions(this.#decisions).catch((error: unknown) => {
      process.stderr.write(
        `[pi-fabric] resident host ${this.hostId} could not cancel orphaned child questions at startup: ${errorMessage(error)}\n`,
      );
      return [];
    });
    await this.#recoverHostedRuns();
    const firstSeenAgents = new Map<string, number>();
    this.participants.registerSource(() =>
      agentParticipantRecords(
        this.agents.listForUi(),
        this.config.rootId,
        this.hostId,
        this.identity.id,
        this.config.rootId,
        firstSeenAgents,
      ),
    );
    this.participants.registerSource(() =>
      this.actors.listOwned().map((actor) =>
        actorParticipantRecord(
          actor,
          this.config.rootId,
          this.hostId,
          this.identity.id,
          this.config.rootId,
        ),
      ),
    );
    this.agents.subscribeUi(() => this.participants.scheduleRefresh());
    this.actors.subscribe(() => this.participants.scheduleRefresh());
    this.control.start((command, from, signal) =>
      this.#acceptControl(command, from, signal));
    await this.participants.start().catch(() => undefined);
    this.lifecycle.start();
    this.#requestTimer = setInterval(
      () => void this.#pollRequests().catch(() => undefined),
      REQUEST_POLL_MS,
    );
    const now = Date.now();
    const owner: ResidentHostOwner = {
      format: RESIDENT_HOST_FORMAT,
      hostId: this.hostId,
      pid: process.pid,
      token: this.#token,
      startedAt: now,
      readyAt: now,
      ...ownerHeartbeatFields(now),
    };
    atomicWrite(this.#ownerPath, owner);
    fs.rmSync(this.#errorPath, { force: true });
    await this.#pollRequests();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#requestTimer) clearInterval(this.#requestTimer);
    this.#requestTimer = undefined;
    if (this.#scheduleTimer) clearTimeout(this.#scheduleTimer);
    this.#scheduleTimer = undefined;
    this.#stopHeartbeat?.();
    this.#stopHeartbeat = undefined;
    while (this.#pollingRequests) await delay(10);
    await this.participants.quiesce().catch(() => undefined);
    await this.lifecycle.close().catch(() => undefined);
    await this.control.close().catch(() => undefined);
    try {
      await this.actors.close();
    } finally {
      await this.agents.close();
      await this.participants.close().catch(() => undefined);
      this.#releaseLock();
    }
  }

  async #acceptControl(
    command: FabricControlCommand,
    _from: MeshIdentity,
    signal?: AbortSignal,
  ): Promise<FabricControlAcceptance> {
    if (command.operation === "cancel") {
      return { accepted: false, error: "Cancel commands are handled by the control plane" };
    }
    if (command.operation === "stop") {
      try {
        await this.agents.stop(command.targetId);
        this.participants.scheduleRefresh();
        return { accepted: true, messageId: command.commandId };
      } catch (error) {
        if (!(error instanceof Error && /Unknown Fabric agent/.test(error.message))) {
          return { accepted: false, error: errorMessage(error) };
        }
      }
      try {
        if (!this.actors.owns(command.targetId)) {
          return { accepted: false, error: `Resident host does not own ${command.targetId}` };
        }
        await this.actors.stop(command.targetId);
        this.participants.scheduleRefresh();
        return { accepted: true, messageId: command.commandId };
      } catch (error) {
        return { accepted: false, error: errorMessage(error) };
      }
    }
    const message = command.message?.trim();
    if (!message) return { accepted: false, error: "Fabric control message must not be empty" };
    if (command.operation === "ask") {
      try {
        if (!this.actors.owns(command.targetId)) {
          return { accepted: false, error: `Resident host does not own ${command.targetId}` };
        }
        const result = await this.actors.ask(
          command.targetId,
          message,
          command.data,
          signal,
          { ...(command.binding !== undefined ? { binding: command.binding } : {}), sender: command.sender ?? null },
        );
        return { accepted: true, messageId: result.id, result };
      } catch (error) {
        return { accepted: false, error: errorMessage(error) };
      }
    }
    try {
      this.agents.status(command.targetId);
      const result = command.operation === "steer"
        ? this.agents.steer(command.targetId, message, command.data)
        : this.agents.followUp(command.targetId, message, command.data);
      return { accepted: true, messageId: result.messageId };
    } catch (error) {
      if (!(error instanceof Error && /Unknown Fabric agent/.test(error.message))) {
        return { accepted: false, error: errorMessage(error) };
      }
    }
    try {
      if (!this.actors.owns(command.targetId)) {
        return { accepted: false, error: `Resident host does not own ${command.targetId}` };
      }
      const result = this.actors.tell(
        command.targetId,
        message,
        command.data,
        { ...(command.binding !== undefined ? { binding: command.binding } : {}), sender: command.sender ?? null },
      );
      return { accepted: true, messageId: result.messageId };
    } catch (error) {
      return { accepted: false, error: errorMessage(error) };
    }
  }

  async #deliverLifecycle(
    subscription: FabricLifecycleSubscription,
    event: FabricLifecycleEvent,
  ): Promise<void> {
    const message = `Fabric lifecycle ${event.event} from ${event.source.name} (${event.source.id})${event.status ? ` with status ${event.status}` : ""}.`;
    if (subscription.to === this.config.rootId) {
      await this.#queueDelivery(
        lifecycleSourceIdentity(event.source),
        message,
        subscription.delivery,
        subscription.triggerTurn,
        event,
      );
      return;
    }
    try {
      this.agents.status(subscription.to);
      if (subscription.delivery === "steer") this.agents.steer(subscription.to, message, event);
      else this.agents.followUp(subscription.to, message, event);
      return;
    } catch (error) {
      if (!(error instanceof Error && /Unknown Fabric agent/.test(error.message))) throw error;
    }
    try {
      if (this.actors.owns(subscription.to)) {
        this.actors.tell(subscription.to, message, event);
        return;
      }
    } catch {
      // Route through the current remote owner below.
    }
    const target = this.participants.get(subscription.to);
    if (!target) throw new Error(`Unknown Fabric lifecycle target: ${subscription.to}`);
    await this.control.request(
      target.ownerHostId,
      target.id,
      subscription.delivery,
      {
        message,
        data: event,
        triggerTurn: subscription.triggerTurn,
        ...(target.ownerIncarnation ? { ownerIncarnation: target.ownerIncarnation } : {}),
      },
      target.ownerIdentityId,
    );
  }

  async #queueDelivery(
    from: MeshIdentity,
    message: string,
    delivery: "steer" | "followUp",
    triggerTurn: boolean,
    data?: unknown,
    agentCompletionId?: string,
  ): Promise<void> {
    const id = randomUUID();
    const record: ResidentDeliveryRecord = {
      format: RESIDENT_HOST_FORMAT,
      id,
      rootId: this.config.rootId,
      from,
      delivery,
      triggerTurn,
      message,
      ...(data === undefined ? {} : { data }),
      ...(agentCompletionId ? { agentCompletionId } : {}),
      createdAt: Date.now(),
    };
    try {
      await this.mesh.put({
        key: `${this.#deliveryPrefix}${id}`,
        value: record,
        identity: this.identity,
        ifVersion: 0,
      });
    } catch {
      await this.mesh.put({
        key: `${this.#deliveryPrefix}${id}`,
        value: {
          ...record,
          message: message.slice(0, Math.max(1, this.config.mesh.eventContextChars)),
          data: { fabricTruncated: true },
        },
        identity: this.identity,
        ifVersion: 0,
      });
    }
  }

  async #pollRequests(): Promise<void> {
    if (this.#pollingRequests || this.#closed) return;
    this.#pollingRequests = true;
    try {
      let entries: string[];
      try {
        entries = fs.readdirSync(this.#requestsPath).filter((entry) => entry.endsWith(".json"));
      } catch {
        return;
      }
      for (const entry of entries.slice(0, 32)) {
        const source = path.join(this.#requestsPath, entry);
        const processing = path.join(this.#processingPath, entry);
        try {
          fs.renameSync(source, processing);
        } catch {
          continue;
        }
        await this.#processRequest(processing);
      }
    } finally {
      this.#pollingRequests = false;
      this.#checkIdle();
    }
  }

  #checkIdle(): void {
    const activeActor = this.actors
      .listOwned()
      .some((actor) => actor.residency === "durable" && actor.status !== "stopped");
    const activeAgent = this.agents
      .listForUi()
      .some((agent) => agent.status === "queued" || agent.status === "running");
    let pendingRequest = false;
    try {
      pendingRequest = fs.readdirSync(this.#requestsPath).some((entry) => entry.endsWith(".json"));
    } catch {
      // Missing request directory is empty.
    }
    let nextScheduleDueAt: number | undefined;
    try {
      nextScheduleDueAt = this.mesh.nextScheduleDueAt();
    } catch {
      // Unreadable schedules neither keep the host alive nor stop it.
    }
    const now = Date.now();
    const decision = residentIdleDecision({
      now,
      idleSince: this.#idleSince,
      activeActor,
      activeAgent,
      pendingRequest,
      durableParticipants: activeActor || activeAgent,
      nextScheduleDueAt,
    });
    this.#armScheduleWake(decision.wakeAt);
    if (decision.busy) {
      this.#idleSince = now;
      return;
    }
    if (decision.exit) this.onIdle();
  }

  // Re-armed on every idle check: the due time of the earliest pending
  // schedule, released here even if no actor monitor polls in time.
  #armScheduleWake(wakeAt: number | undefined): void {
    if (wakeAt === this.#scheduleWakeAt) return;
    if (this.#scheduleTimer) clearTimeout(this.#scheduleTimer);
    this.#scheduleTimer = undefined;
    this.#scheduleWakeAt = wakeAt;
    if (wakeAt === undefined || this.#closed) return;
    this.#scheduleTimer = setTimeout(() => {
      this.#scheduleTimer = undefined;
      this.#scheduleWakeAt = undefined;
      void this.mesh.releaseDueSchedules().catch(() => undefined).finally(() => {
        if (!this.#closed) this.#checkIdle();
      });
    }, Math.min(Math.max(0, wakeAt - Date.now()), 2_147_000_000));
    this.#scheduleTimer.unref();
  }

  async #processRequest(filePath: string): Promise<void> {
    const command = readJson<ResidentCommand>(filePath);
    const requestId = command?.requestId ?? path.basename(filePath, ".json");
    let response: ResidentCommandResponse;
    try {
      if (
        command?.format !== RESIDENT_HOST_FORMAT ||
        command.rootId !== this.config.rootId ||
        command.requestId !== requestId
      ) {
        throw new Error("Invalid Fabric residency request");
      }
      if (command.operation === "spawn") {
        if (
          command.request.sessionSeed ||
          command.request.forkSeed ||
          command.request.sessionFile ||
          command.request.actorId ||
          command.request.actorName ||
          command.request.meshRoot ||
          command.request.runnerSessionId ||
          command.request.systemPrompt ||
          command.request.images
        ) {
          throw new Error("Durable agents.spawn accepts only its public task and run settings");
        }
        if (command.runnerModule) await loadRunnerModule(command.runnerModule);
        const handle = await this.agents.spawn({ ...command.request, residency: "durable" });
        // spawn already validated the forwarded scope; record what the child received.
        const scope = launchScope(command.request.scope, command.request.inheritedScope);
        const runDirectory = this.agents.runDirectory(handle.id);
        if (!runDirectory) throw new Error(`Resident agent ${handle.id} has no run directory`);
        const worktreeGitRoot = this.agents.worktreeGitRoot(handle.id);
        const metadata: ResidentAgentMetadata = {
          format: RESIDENT_HOST_FORMAT,
          rootId: this.config.rootId,
          id: handle.id,
          runDirectory,
          handle: { ...handle, residency: "durable" },
          ...(worktreeGitRoot ? { worktreeGitRoot } : {}),
          ...(command.runnerModule ? { runnerModule: command.runnerModule } : {}),
          ...(scope ? { scope } : {}),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        atomicWrite(path.join(this.#agentsPath, `${handle.id}.json`), metadata);
        // Publish ownership before a fast, already-settled spawn can notify Main.
        this.agents.detachSignal(handle.id);
        response = {
          format: RESIDENT_HOST_FORMAT,
          requestId,
          ok: true,
          handle: metadata.handle,
          completedAt: Date.now(),
        };
      } else if (command.operation === "foreground") {
        this.agents.markForeground(command.id);
        response = {
          format: RESIDENT_HOST_FORMAT,
          requestId,
          ok: true,
          completedAt: Date.now(),
        };
      } else if (command.operation === "cleanup") {
        await this.agents.wait(command.id);
        await this.agents.cleanup(command.id, command.deleteBranch);
        fs.rmSync(path.join(this.#agentsPath, `${command.id}.json`), { force: true });
        response = {
          format: RESIDENT_HOST_FORMAT,
          requestId,
          ok: true,
          completedAt: Date.now(),
        };
      } else if (command.operation === "createActor") {
        if (command.request.residency !== "durable") {
          throw new Error("Resident host createActor only supports durable residency");
        }
        // This handler already runs inside the authoritative durable host.
        // Keep the new actor locally owned; ceding it here created a needless
        // self-transfer window that blocked the next recruitment request.
        const actor = await this.actors.create(command.request, { asRegistryOwner: true });
        response = {
          format: RESIDENT_HOST_FORMAT,
          requestId,
          ok: true,
          actor: actor as FabricActorInfo,
          completedAt: Date.now(),
        };
      } else {
        if (!this.actors.owns(command.id)) {
          throw new Error(`Resident host does not own ${command.id}`);
        }
        await this.actors.remove(command.id);
        response = {
          format: RESIDENT_HOST_FORMAT,
          requestId,
          ok: true,
          completedAt: Date.now(),
        };
      }
    } catch (error) {
      response = {
        format: RESIDENT_HOST_FORMAT,
        requestId,
        ok: false,
        error: errorMessage(error),
        completedAt: Date.now(),
      };
    }
    atomicWrite(path.join(this.#responsesPath, `${requestId}.json`), response);
    fs.rmSync(filePath, { force: true });
    this.participants.scheduleRefresh();
  }

  /**
   * Re-import the runner modules recorded for this host's durable runs, then
   * re-attach their hosted runs from the persisted locators. A run whose
   * runner cannot be loaded settles indeterminate; nothing is re-submitted.
   */
  async #recoverHostedRuns(): Promise<void> {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.#agentsPath).filter((entry) => entry.endsWith(".json"));
    } catch {
      entries = [];
    }
    const modules = new Set<string>();
    for (const entry of entries) {
      const metadata = readJson<ResidentAgentMetadata>(path.join(this.#agentsPath, entry));
      if (metadata?.rootId === this.config.rootId && typeof metadata.runnerModule === "string") {
        modules.add(metadata.runnerModule);
      }
    }
    for (const module of modules) await loadRunnerModule(module).catch(() => undefined);
    await this.agents.recoverHostedRuns().catch(() => []);
    // Opted-in pi-durable worker runs (agents.durableWorkerRecovery at launch).
    await this.agents.recoverWorkerRuns().catch(() => []);
  }

  #recoverInterruptedRequests(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.#processingPath).filter((entry) => entry.endsWith(".json"));
    } catch {
      return;
    }
    for (const entry of entries) {
      const requestId = path.basename(entry, ".json");
      const response: ResidentCommandResponse = {
        format: RESIDENT_HOST_FORMAT,
        requestId,
        ok: false,
        error: "Fabric residency outcome is indeterminate after resident host restart",
        outcome: "indeterminate",
        completedAt: Date.now(),
      };
      atomicWrite(path.join(this.#responsesPath, entry), response);
      fs.rmSync(path.join(this.#processingPath, entry), { force: true });
    }
  }

  #acquireLock(): void {
    fs.mkdirSync(this.config.residencyRoot, { recursive: true, mode: 0o700 });
    const existing = readJson<ResidentHostOwner>(this.#ownerPath);
    if (existing && ownerAlive(existing)) {
      throw new ResidentHostAlreadyRunning(`Fabric resident host is already running (${existing.pid})`);
    }
    try {
      const descriptor = fs.openSync(this.#lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ token: this.#token, pid: process.pid, ...ownerHeartbeatFields() }));
      fs.closeSync(descriptor);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        const locked = readJson<{ pid?: unknown }>(this.#lockPath);
        if (typeof locked?.pid === "number" && ownerAlive(locked)) {
          throw new ResidentHostAlreadyRunning(`Fabric resident host is starting (${locked.pid})`);
        }
        fs.rmSync(this.#lockPath, { force: true });
        const descriptor = fs.openSync(this.#lockPath, "wx", 0o600);
        fs.writeFileSync(descriptor, JSON.stringify({ token: this.#token, pid: process.pid, ...ownerHeartbeatFields() }));
        fs.closeSync(descriptor);
      } else {
        throw error;
      }
    }
  }

  // Long-lived ownership: refresh both the start lock and owner.json while
  // they are still ours, so readers in other PID namespaces can judge us.
  #refreshHeartbeat(heartbeatAt: number): void {
    const lock = readJson<Record<string, unknown>>(this.#lockPath);
    if (lock?.token === this.#token) atomicWrite(this.#lockPath, { ...lock, heartbeatAt });
    const owner = readJson<ResidentHostOwner>(this.#ownerPath);
    if (owner?.token === this.#token) atomicWrite(this.#ownerPath, { ...owner, heartbeatAt });
  }

  #releaseLock(): void {
    const lock = readJson<{ token?: unknown }>(this.#lockPath);
    if (lock?.token === this.#token) fs.rmSync(this.#lockPath, { force: true });
    const owner = readJson<ResidentHostOwner>(this.#ownerPath);
    if (owner?.token === this.#token) fs.rmSync(this.#ownerPath, { force: true });
  }
}

const runResidentHost = async (
  config: ResidentHostConfig,
  signal?: AbortSignal,
): Promise<void> => {
  let finishIdle: (() => void) | undefined;
  const idle = new Promise<void>((resolve) => {
    finishIdle = resolve;
  });
  const host = new ResidentHost(config, () => finishIdle?.());
  await host.start();
  if (signal?.aborted) {
    await host.close();
    return;
  }
  await Promise.race([
    idle,
    new Promise<void>((resolve) => {
      const finish = (): void => resolve();
      signal?.addEventListener("abort", finish, { once: true });
      process.once("SIGTERM", finish);
      process.once("SIGINT", finish);
    }),
  ]);
  await host.close();
};

export const runResidentHostFromConfigPath = async (
  configPath: string,
  signal?: AbortSignal,
): Promise<void> => {
  let config: ResidentHostConfig | undefined;
  try {
    config = validateResidentHostConfig(readJson<unknown>(configPath), configPath);
    await runResidentHost(config, signal);
  } catch (error) {
    if (error instanceof ResidentHostAlreadyRunning) return;
    const residencyRoot = config?.residencyRoot ?? path.dirname(configPath);
    try {
      atomicWrite(path.join(residencyRoot, "error.json"), {
        error: errorMessage(error),
        occurredAt: Date.now(),
      });
    } catch {
      // Startup diagnostics are best-effort.
    }
    throw error;
  }
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const configPath = parseResidentHostConfigPath(process.argv);
  try {
    await runResidentHostFromConfigPath(configPath);
  } catch {
    process.exitCode = 1;
  }
}
