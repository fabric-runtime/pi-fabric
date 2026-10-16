import fs from "node:fs";
import type { FabricActorInfo, FabricActorRequest, FabricActorStorageScope } from "./types.js";
import { ActorManager } from "./manager.js";

export interface ActorDirectoryRoots {
  project: string;
  session: string;
}

export class ActorDirectory extends ActorManager {
  readonly #secondary: ActorManager;
  readonly #defaultScope: FabricActorStorageScope;

  constructor(
    base: ConstructorParameters<typeof ActorManager>,
    roots: ActorDirectoryRoots,
    defaultScope: FabricActorStorageScope,
  ) {
    const options = { ...(base[6] ?? {}) };
    const meshCursorPath = options.meshCursorPath;
    delete options.actorRoot;
    delete options.meshCursorPath;
    const cursorPaths = meshCursorPath
      ? { project: `${meshCursorPath}.project`, session: `${meshCursorPath}.session` }
      : undefined;
    if (meshCursorPath && fs.existsSync(meshCursorPath)) {
      for (const cursorPath of Object.values(cursorPaths!)) {
        try {
          if (!fs.existsSync(cursorPath)) fs.copyFileSync(meshCursorPath, cursorPath);
        } catch {
          // Cursor migration is best-effort; ActorManager safely starts at the mesh tail.
        }
      }
    }
    const persistent = options.persistent === true;
    super(base[0], base[1], base[2], base[3], base[4], base[5], {
      ...options,
      ...(persistent ? { actorRoot: roots[defaultScope] } : {}),
      ...(cursorPaths ? { meshCursorPath: cursorPaths[defaultScope] } : {}),
      actorScope: defaultScope,
    });
    const secondaryScope = defaultScope === "project" ? "session" : "project";
    this.#secondary = new ActorManager(base[0], base[1], base[2], base[3], base[4], base[5], {
      ...options,
      ...(persistent ? { actorRoot: roots[secondaryScope] } : {}),
      ...(cursorPaths ? { meshCursorPath: cursorPaths[secondaryScope] } : {}),
      relayParticipantSteering: false,
      actorScope: secondaryScope,
    });
    this.#defaultScope = defaultScope;
  }

  #isPrimary(id: string): boolean {
    const actors = this.list();
    const exact = actors.find((actor) => actor.id === id);
    if (exact) return exact.scope === this.#defaultScope;
    const matches = actors.filter((actor) => actor.id.startsWith(id) || actor.name === id);
    if (matches.length === 0) throw new Error(`Unknown Fabric actor: ${id}`);
    if (matches.length > 1) throw new Error(`Ambiguous Fabric actor: ${id}`);
    return matches[0]!.scope === this.#defaultScope;
  }

  override subscribe(listener: () => void): () => void {
    const first = super.subscribe(listener);
    const second = this.#secondary.subscribe(listener);
    return () => { first(); second(); };
  }

  override retryCapabilityWaiters(): void { super.retryCapabilityWaiters(); this.#secondary.retryCapabilityWaiters(); }
  override async create(request: FabricActorRequest, options: { asRegistryOwner?: boolean } = {}): Promise<FabricActorInfo> {
    const scope = request.scope ?? this.#defaultScope;
    if (scope !== "project" && scope !== "session") {
      throw new Error(`Invalid Fabric actor storage scope: ${String(scope)}`);
    }
    const name = request.name.trim();
    const sameName = this.list().filter((actor) => actor.name === name);
    const existing = sameName.find((actor) => actor.status !== "stopped");
    if (existing) throw new Error(`A Fabric actor named ${name} is already active (${existing.id})`);
    for (const actor of sameName) await this.remove(actor.id);
    return scope === this.#defaultScope
      ? super.create(request, options)
      : this.#secondary.create(request, options);
  }
  override list(): FabricActorInfo[] { return [...super.list(), ...this.#secondary.list()]; }
  override listOwned(): FabricActorInfo[] { return [...super.listOwned(), ...this.#secondary.listOwned()]; }
  override cede(...args: Parameters<ActorManager["cede"]>): ReturnType<ActorManager["cede"]> { return this.#isPrimary(args[0]) ? super.cede(...args) : this.#secondary.cede(...args); }
  override reclaim(...args: Parameters<ActorManager["reclaim"]>): ReturnType<ActorManager["reclaim"]> { return this.#isPrimary(args[0]) ? super.reclaim(...args) : this.#secondary.reclaim(...args); }
  override status(...args: Parameters<ActorManager["status"]>): ReturnType<ActorManager["status"]> { return this.#isPrimary(args[0]) ? super.status(...args) : this.#secondary.status(...args); }
  override owns(...args: Parameters<ActorManager["owns"]>): ReturnType<ActorManager["owns"]> { try { return this.#isPrimary(args[0]) ? super.owns(...args) : this.#secondary.owns(...args); } catch { return false; } }
  override resolveBinding(...args: Parameters<ActorManager["resolveBinding"]>): ReturnType<ActorManager["resolveBinding"]> { return this.#isPrimary(args[0]) ? super.resolveBinding(...args) : this.#secondary.resolveBinding(...args); }
  override setModel(...args: Parameters<ActorManager["setModel"]>): ReturnType<ActorManager["setModel"]> { return this.#isPrimary(args[0]) ? super.setModel(...args) : this.#secondary.setModel(...args); }
  override setThinking(...args: Parameters<ActorManager["setThinking"]>): ReturnType<ActorManager["setThinking"]> { return this.#isPrimary(args[0]) ? super.setThinking(...args) : this.#secondary.setThinking(...args); }
  override setTools(...args: Parameters<ActorManager["setTools"]>): ReturnType<ActorManager["setTools"]> { return this.#isPrimary(args[0]) ? super.setTools(...args) : this.#secondary.setTools(...args); }
  override setEvents(...args: Parameters<ActorManager["setEvents"]>): ReturnType<ActorManager["setEvents"]> { return this.#isPrimary(args[0]) ? super.setEvents(...args) : this.#secondary.setEvents(...args); }
  override setDeliveryPolicy(...args: Parameters<ActorManager["setDeliveryPolicy"]>): ReturnType<ActorManager["setDeliveryPolicy"]> { return this.#isPrimary(args[0]) ? super.setDeliveryPolicy(...args) : this.#secondary.setDeliveryPolicy(...args); }
  override clearMessages(...args: Parameters<ActorManager["clearMessages"]>): ReturnType<ActorManager["clearMessages"]> { return this.#isPrimary(args[0]) ? super.clearMessages(...args) : this.#secondary.clearMessages(...args); }
  override setInstructions(...args: Parameters<ActorManager["setInstructions"]>): ReturnType<ActorManager["setInstructions"]> { return this.#isPrimary(args[0]) ? super.setInstructions(...args) : this.#secondary.setInstructions(...args); }
  override tell(...args: Parameters<ActorManager["tell"]>): ReturnType<ActorManager["tell"]> { return this.#isPrimary(args[0]) ? super.tell(...args) : this.#secondary.tell(...args); }
  override ask(...args: Parameters<ActorManager["ask"]>): ReturnType<ActorManager["ask"]> { return this.#isPrimary(args[0]) ? super.ask(...args) : this.#secondary.ask(...args); }
  override messages(...args: Parameters<ActorManager["messages"]>): ReturnType<ActorManager["messages"]> { return this.#isPrimary(args[0]) ? super.messages(...args) : this.#secondary.messages(...args); }
  override instructions(...args: Parameters<ActorManager["instructions"]>): ReturnType<ActorManager["instructions"]> { return this.#isPrimary(args[0]) ? super.instructions(...args) : this.#secondary.instructions(...args); }
  override definition(...args: Parameters<ActorManager["definition"]>): ReturnType<ActorManager["definition"]> {
    const actor = this.status(args[0]);
    const definition = this.#isPrimary(actor.id)
      ? super.definition(actor.id)
      : this.#secondary.definition(actor.id);
    return { ...definition, ...(actor.scope ? { scope: actor.scope } : {}) };
  }
  override readLog(...args: Parameters<ActorManager["readLog"]>): ReturnType<ActorManager["readLog"]> { return this.#isPrimary(args[0]) ? super.readLog(...args) : this.#secondary.readLog(...args); }
  override noteMainActivity(...args: Parameters<ActorManager["noteMainActivity"]>): void { super.noteMainActivity(...args); this.#secondary.noteMainActivity(...args); }
  override observeHostEvent(...args: Parameters<ActorManager["observeHostEvent"]>): boolean {
    const first = super.observeHostEvent(...args);
    const second = this.#secondary.observeHostEvent(...args);
    return first || second;
  }
  override dispatchHostEvent(...args: Parameters<ActorManager["dispatchHostEvent"]>): number { return super.dispatchHostEvent(...args) + this.#secondary.dispatchHostEvent(...args); }
  override dispatchObservedHostEvent(...args: Parameters<ActorManager["dispatchObservedHostEvent"]>): number { return super.dispatchObservedHostEvent(...args) + this.#secondary.dispatchObservedHostEvent(...args); }
  override stop(...args: Parameters<ActorManager["stop"]>): ReturnType<ActorManager["stop"]> { return this.#isPrimary(args[0]) ? super.stop(...args) : this.#secondary.stop(...args); }
  override get halted(): boolean { return super.halted && this.#secondary.halted; }
  override haltAll(): { halted: number } { const first = super.haltAll(); const second = this.#secondary.haltAll(); return { halted: first.halted + second.halted }; }
  override remove(...args: Parameters<ActorManager["remove"]>): ReturnType<ActorManager["remove"]> { return this.#isPrimary(args[0]) ? super.remove(...args) : this.#secondary.remove(...args); }
  override async close(): Promise<void> {
    // Both scopes finish closing before a failure from either is reported.
    const [primary, secondary] = await Promise.allSettled([super.close(), this.#secondary.close()]);
    if (primary.status === "rejected") throw primary.reason;
    if (secondary.status === "rejected") throw secondary.reason;
  }
}
