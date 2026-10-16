import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FabricCapabilityRequirement } from "../components/types.js";
import { writeJsonAtomic } from "../core/atomic-write.js";
import type { FabricAgentTransport } from "../config.js";
import { isFabricThinking, type FabricThinking } from "../thinking.js";
import { resolveActorDeliveryPolicy } from "./delivery-policy.js";
import { ActorStoreReadError, readStoreJson } from "./store-read.js";
import { FABRIC_ACTOR_HOST_EVENTS } from "./types.js";
import type {
  FabricActorDelivery,
  FabricActorHostEvent,
  FabricActorRequest,
  FabricActorResponseMode,
  GlobalActorDefinition,
} from "./types.js";

const ACTOR_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,59}$/;
const TOPIC_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const HOST_EVENTS: ReadonlySet<FabricActorHostEvent> = new Set(FABRIC_ACTOR_HOST_EVENTS);
const DELIVERIES = new Set<FabricActorDelivery>(["mailbox", "steer", "followUp", "nextTurn"]);
const RESPONSE_MODES = new Set<FabricActorResponseMode>(["text", "directive"]);
const normalizeRequirements = (value: unknown): FabricCapabilityRequirement[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error("Invalid global actor capability requirements");
  }
  const normalized = new Map<string, boolean>();
  for (const item of value) {
    const ref = typeof item === "string"
      ? item.trim()
      : typeof item === "object" && item !== null && !Array.isArray(item) &&
          typeof (item as { ref?: unknown }).ref === "string"
        ? (item as { ref: string }).ref.trim()
        : "";
    if (ref.length > 256 || !ref.includes(".") || ref.startsWith(".") || ref.endsWith(".")) {
      throw new Error("Invalid global actor capability requirement");
    }
    const optional = typeof item === "object" && item !== null &&
      (item as { optional?: unknown }).optional === true;
    normalized.set(ref, (normalized.get(ref) ?? true) && optional);
  }
  return [...normalized]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ref, optional]) => ({ ref, ...(optional ? { optional: true } : {}) }));
};

const TRANSPORTS = new Set<FabricAgentTransport>([
  "auto",
  "process",
  "tmux",
  "screen",
  "localterm",
  "herdr",
]);

interface RegistryFile {
  format: 1;
  /** Valid definitions plus entries this version could not load, kept as written. */
  actors: unknown[];
}

const atomicWrite = (filePath: string, value: unknown): void => {
  writeJsonAtomic(filePath, value, { space: 2 });
};

const clone = <T>(value: T): T => structuredClone(value);

/**
 * Resolve a partial id (unique prefix) or an exact name to a definition.
 * Returns undefined when nothing matches, and throws on an ambiguous prefix.
 */
const resolveDefinition = (
  actors: Map<string, GlobalActorDefinition>,
  idOrName: string,
): GlobalActorDefinition | undefined => {
  const exact = actors.get(idOrName);
  if (exact) return exact;
  const matches = [...actors.values()].filter(
    (actor) => actor.id.startsWith(idOrName) || actor.name === idOrName,
  );
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length > 1) throw new Error(`Ambiguous global actor: ${idOrName}`);
  return undefined;
};

/**
 * A project-independent library of actor templates. Templates carry only an
 * actor definition (name, instructions, subscriptions, and run settings) plus
 * identity/timestamps — never any history. They are not live actors: importing
 * a template into a project creates a fresh live actor with no inherited
 * session, mailbox, or run logs.
 *
 * The registry lives in the user's agent dir (machine-global), independent of
 * any project or mesh, so the same templates are available across every
 * project. Operations are pure file I/O and do not require the mesh to be
 * enabled; only importing (which creates a live actor via ActorManager) does.
 * The registry is read into memory once at construction; run `/fabric reload`
 * to pick up templates added by other Pi sessions. Writes are atomic (write
 * to a temp file then rename) so concurrent sessions cannot corrupt the
 * store, though truly simultaneous edits are last-write-wins.
 *
 * Only a missing file loads as empty. If the file exists but cannot be read
 * or parsed, every operation retries the read and throws the read error
 * instead of acting on an empty library, so a save cannot erase the file.
 * Entries that fail validation are kept as written on every save.
 */
export class GlobalActorRegistry {
  readonly #actors = new Map<string, GlobalActorDefinition>();
  #unloaded: unknown[] = [];
  #loadError: ActorStoreReadError | undefined;
  readonly #path: string;
  readonly #maxBytes: number;

  constructor(agentDir: string, maxInstructionsBytes: number) {
    this.#path = path.join(agentDir, "fabric", "actors", "global-actors.json");
    this.#maxBytes = maxInstructionsBytes;
    this.#tryLoad();
  }

  /** The error from the latest failed read, or undefined after a good read. */
  get loadError(): ActorStoreReadError | undefined {
    return this.#loadError;
  }

  list(): GlobalActorDefinition[] {
    this.#requireLoaded();
    return [...this.#actors.values()].map(clone);
  }

  resolve(idOrName: string): GlobalActorDefinition | undefined {
    this.#requireLoaded();
    const found = resolveDefinition(this.#actors, idOrName);
    return found ? clone(found) : undefined;
  }

  /**
   * Save a definition to the global registry. If a template with the same name
   * already exists, throws unless `overwrite` is true (in which case the
   * existing template is updated in place, keeping its id). Returns the stored
   * definition.
   */
  create(def: FabricActorRequest, overwrite = false): GlobalActorDefinition {
    this.#requireLoaded();
    const validated = this.#validate(def);
    const existing = [...this.#actors.values()].find((actor) => actor.name === validated.name);
    if (existing) {
      if (!overwrite) {
        throw new Error(`A global actor named ${validated.name} already exists (${existing.id})`);
      }
      const updated: GlobalActorDefinition = {
        ...existing,
        ...validated,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: Date.now(),
      };
      this.#actors.set(existing.id, updated);
      this.#save();
      return clone(updated);
    }
    const created: GlobalActorDefinition = {
      ...validated,
      id: randomUUID().replaceAll("-", ""),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.#actors.set(created.id, created);
    this.#save();
    return clone(created);
  }

  /**
   * Apply a partial patch to a stored template (e.g. new instructions). Only
   * the supplied fields are replaced; the rest are preserved. Re-validates any
   * changed field.
   */
  update(idOrName: string, patch: Partial<FabricActorRequest>): GlobalActorDefinition {
    this.#requireLoaded();
    const existing = resolveDefinition(this.#actors, idOrName);
    if (!existing) throw new Error(`Unknown global actor: ${idOrName}`);
    const merged: FabricActorRequest = {
      name: patch.name ?? existing.name,
      instructions: patch.instructions ?? existing.instructions,
      events: patch.events ?? existing.events,
      topics: patch.topics ?? existing.topics,
      delivery: patch.delivery ?? existing.delivery,
      responseMode: patch.responseMode ?? existing.responseMode,
      triggerTurn: patch.triggerTurn ?? existing.triggerTurn,
      coalesce: patch.coalesce ?? existing.coalesce,
      ...(patch.residency !== undefined
        ? { residency: patch.residency }
        : existing.residency
          ? { residency: existing.residency }
          : {}),
      runner: patch.runner ?? existing.runner,
      ...(patch.kernel !== undefined ? { kernel: patch.kernel } : existing.kernel ? { kernel: existing.kernel } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : existing.model ? { model: existing.model } : {}),
      ...(patch.thinking !== undefined ? { thinking: patch.thinking } : existing.thinking ? { thinking: existing.thinking } : {}),
      ...(patch.tools !== undefined ? { tools: patch.tools } : existing.tools ? { tools: existing.tools } : {}),
      ...(patch.transport !== undefined ? { transport: patch.transport } : existing.transport ? { transport: existing.transport } : {}),
      ...(patch.timeoutMs !== undefined ? { timeoutMs: patch.timeoutMs } : existing.timeoutMs ? { timeoutMs: existing.timeoutMs } : {}),
      ...(patch.extensions !== undefined
        ? { extensions: patch.extensions }
        : typeof existing.extensions === "boolean"
          ? { extensions: existing.extensions }
          : {}),
      ...(patch.validWhile !== undefined
        ? { validWhile: patch.validWhile }
        : existing.validWhile
          ? { validWhile: existing.validWhile }
          : {}),
    };
    const validated = this.#validate(merged);
    if (validated.name !== existing.name) {
      const clash = [...this.#actors.values()].find(
        (actor) => actor.id !== existing.id && actor.name === validated.name,
      );
      if (clash) {
        throw new Error(`A global actor named ${validated.name} already exists (${clash.id})`);
      }
    }
    const updated: GlobalActorDefinition = {
      ...validated,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    };
    this.#actors.set(existing.id, updated);
    this.#save();
    return clone(updated);
  }

  remove(idOrName: string): { removed: boolean } {
    this.#requireLoaded();
    const existing = resolveDefinition(this.#actors, idOrName);
    if (!existing) return { removed: false };
    this.#actors.delete(existing.id);
    this.#save();
    return { removed: true };
  }

  /**
   * Strip identity/timestamps from a stored template to produce the request
   * shape ActorManager.create expects. Optionally rename the imported actor so
   * a template can be stamped into a project under a different name (e.g. to
   * avoid a collision with a live actor).
   */
  toRequest(def: GlobalActorDefinition, as?: string): FabricActorRequest {
    const name = as?.trim() || def.name;
    const request: FabricActorRequest = {
      name,
      instructions: def.instructions,
      events: [...def.events],
      topics: [...def.topics],
      delivery: def.delivery,
      responseMode: def.responseMode,
      triggerTurn: def.triggerTurn,
      coalesce: def.coalesce,
      ...(def.residency ? { residency: def.residency } : {}),
      runner: def.runner,
      ...(def.kernel ? { kernel: def.kernel } : {}),
      ...(def.model ? { model: def.model } : {}),
      ...(def.thinking ? { thinking: def.thinking } : {}),
      ...(def.tools ? { tools: [...def.tools] } : {}),
      ...(def.transport ? { transport: def.transport } : {}),
      ...(def.timeoutMs ? { timeoutMs: def.timeoutMs } : {}),
      ...(typeof def.extensions === "boolean" ? { extensions: def.extensions } : {}),
      ...(def.validWhile ? { validWhile: clone(def.validWhile) } : {}),
    };
    return request;
  }

  #validate(def: FabricActorRequest): Omit<GlobalActorDefinition, "id" | "createdAt" | "updatedAt"> {
    const name = def.name.trim();
    if (!ACTOR_NAME_PATTERN.test(name)) throw new Error(`Invalid global actor name: ${def.name}`);
    const instructions = def.instructions;
    if (!instructions.trim()) throw new Error("Global actor instructions must not be empty");
    if (Buffer.byteLength(instructions, "utf8") > this.#maxBytes) {
      throw new Error(`Global actor instructions exceed ${this.#maxBytes} bytes`);
    }
    const events = [...new Set(def.events ?? [])];
    for (const event of events) {
      if (!HOST_EVENTS.has(event)) throw new Error(`Unsupported global actor event: ${event}`);
    }
    const topics = [...new Set(def.topics ?? [])];
    for (const topic of topics) {
      if (!TOPIC_PATTERN.test(topic)) throw new Error(`Invalid global actor topic: ${topic}`);
    }
    const deliveryPolicy = resolveActorDeliveryPolicy(def.delivery, def.triggerTurn);
    const responseMode = def.responseMode ?? "text";
    if (!RESPONSE_MODES.has(responseMode)) {
      throw new Error(`Invalid global actor response mode: ${def.responseMode}`);
    }
    const coalesce = def.coalesce ?? true;
    const residency = def.residency ?? "session";
    if (residency !== "session" && residency !== "durable") {
      throw new Error(`Invalid global actor residency: ${String(def.residency)}`);
    }
    const runner = def.runner ?? "pi-durable";
    if (runner !== "pi" && runner !== "pi-durable" && runner !== "claude") {
      throw new Error(`Invalid global actor runner: ${String(def.runner)}`);
    }
    if (def.kernel !== undefined && def.kernel !== "inherit" && def.kernel !== "typescript" && def.kernel !== "python") {
      throw new Error(`Invalid Fabric actor kernel: ${String(def.kernel)}`);
    }
    if (def.kernel && def.kernel !== "inherit" && ((runner !== "pi" && runner !== "pi-durable") || def.extensions === false)) {
      throw new Error("An explicit Fabric kernel requires a Pi actor with extensions enabled");
    }
    const model = typeof def.model === "string" && def.model.trim() ? def.model.trim() : undefined;
    const thinking =
      def.thinking !== undefined && isFabricThinking(def.thinking) ? def.thinking : undefined;
    const tools = Array.isArray(def.tools)
      ? [...new Set(def.tools.filter((tool): tool is string => typeof tool === "string"))]
      : undefined;
    const transport =
      def.transport !== undefined && TRANSPORTS.has(def.transport) ? def.transport : undefined;
    const timeoutMs = typeof def.timeoutMs === "number" ? def.timeoutMs : undefined;
    const extensions = typeof def.extensions === "boolean" ? def.extensions : undefined;
    const requires = normalizeRequirements(def.requires);
    const validWhile = def.validWhile?.version === 1 &&
      typeof def.validWhile.source === "string" &&
      def.validWhile.source.trim() &&
      def.validWhile.source.length <= 16_000
      ? clone(def.validWhile)
      : undefined;
    if (def.validWhile && !validWhile) throw new Error("Invalid global actor validWhile predicate");
    return {
      name,
      instructions,
      events,
      topics,
      delivery: deliveryPolicy.delivery,
      responseMode,
      triggerTurn: deliveryPolicy.triggerTurn,
      coalesce,
      residency,
      runner,
      ...(def.kernel ? { kernel: def.kernel } : {}),
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
      ...(tools ? { tools } : {}),
      ...(transport ? { transport } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(extensions !== undefined ? { extensions } : {}),
      ...(requires && requires.length > 0 ? { requires } : {}),
      ...(validWhile ? { validWhile } : {}),
    };
  }

  /** Retry a failed read; throw if the file still cannot be read. */
  #requireLoaded(): void {
    if (!this.#loadError) return;
    this.#tryLoad();
    if (this.#loadError) throw this.#loadError;
  }

  #tryLoad(): void {
    this.#actors.clear();
    this.#unloaded = [];
    try {
      this.#load();
      this.#loadError = undefined;
    } catch (error) {
      if (!(error instanceof ActorStoreReadError)) throw error;
      this.#actors.clear();
      this.#unloaded = [];
      this.#loadError = error;
    }
  }

  #load(): void {
    const parsed = readStoreJson(this.#path);
    if (parsed === undefined) return;
    const records = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { actors?: unknown }).actors
      : undefined;
    if (!Array.isArray(records)) {
      throw new ActorStoreReadError(this.#path, "expected an object with an actors array");
    }
    for (const value of records) {
      if (!this.#loadRecord(value)) this.#unloaded.push(value);
    }
  }

  /** Load one entry; false when it fails validation and must be kept as written. */
  #loadRecord(value: unknown): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const record = value as Partial<GlobalActorDefinition>;
    if (
      typeof record.id !== "string" ||
      !/^[a-f0-9]{32}$/.test(record.id) ||
      typeof record.name !== "string" ||
      !ACTOR_NAME_PATTERN.test(record.name) ||
      typeof record.instructions !== "string" ||
      Buffer.byteLength(record.instructions, "utf8") > this.#maxBytes ||
      typeof record.createdAt !== "number"
    ) {
      return false;
    }
    const events = Array.isArray(record.events)
      ? record.events.filter((event): event is FabricActorHostEvent => HOST_EVENTS.has(event))
      : [];
    const topics = Array.isArray(record.topics)
      ? record.topics.filter(
          (topic): topic is string => typeof topic === "string" && TOPIC_PATTERN.test(topic),
        )
      : [];
    const delivery: FabricActorDelivery =
      record.delivery === "steer" || record.delivery === "followUp" || record.delivery === "nextTurn"
        ? record.delivery
        : "mailbox";
    const responseMode: FabricActorResponseMode =
      record.responseMode === "directive" ? "directive" : "text";
    const triggerTurn =
      (delivery === "steer" || delivery === "followUp") && record.triggerTurn === true;
    const coalesce = record.coalesce !== false;
    const residency = record.residency === "durable" ? "durable" : "session";
    const runner = record.runner === "claude" || record.runner === "pi-durable" ? record.runner : "pi";
    if (record.kernel !== undefined && record.kernel !== "inherit" && record.kernel !== "typescript" && record.kernel !== "python") return false;
    if (record.kernel && record.kernel !== "inherit" && ((runner !== "pi" && runner !== "pi-durable") || record.extensions === false)) return false;
    const thinking: FabricThinking | undefined = isFabricThinking(record.thinking)
      ? record.thinking
      : undefined;
    const tools = Array.isArray(record.tools)
      ? record.tools.filter((tool): tool is string => typeof tool === "string")
      : undefined;
    const transport: FabricAgentTransport | undefined =
      record.transport !== undefined && TRANSPORTS.has(record.transport) ? record.transport : undefined;
    const timeoutMs = typeof record.timeoutMs === "number" ? record.timeoutMs : undefined;
    const extensions = typeof record.extensions === "boolean" ? record.extensions : undefined;
    let requires: FabricCapabilityRequirement[] | undefined;
    try {
      requires = normalizeRequirements(record.requires);
    } catch {
      return false;
    }
    const validWhile = record.validWhile?.version === 1 &&
      typeof record.validWhile.source === "string" &&
      record.validWhile.source.length <= 16_000
      ? clone(record.validWhile)
      : undefined;
    const def: GlobalActorDefinition = {
      id: record.id,
      name: record.name,
      instructions: record.instructions,
      events,
      topics,
      delivery,
      responseMode,
      triggerTurn,
      coalesce,
      residency,
      runner,
      ...(record.kernel ? { kernel: record.kernel } : {}),
      createdAt: record.createdAt,
      updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : record.createdAt,
      ...(typeof record.model === "string" && record.model ? { model: record.model } : {}),
      ...(thinking ? { thinking } : {}),
      ...(tools ? { tools } : {}),
      ...(transport ? { transport } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(extensions !== undefined ? { extensions } : {}),
      ...(requires && requires.length > 0 ? { requires } : {}),
      ...(validWhile ? { validWhile } : {}),
    };
    this.#actors.set(def.id, def);
    return true;
  }

  #save(): void {
    if (this.#loadError) throw this.#loadError;
    const file: RegistryFile = { format: 1, actors: [...this.#actors.values(), ...this.#unloaded] };
    atomicWrite(this.#path, file);
  }
}
