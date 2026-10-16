import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  writeJsonAtomic,
  encodeOwnerIdentityLine,
  lockOwnerLiveness,
  SHORT_LOCK_MAX_HOLD_MS,
} from "../core/atomic-write.js";
import { isFabricThinking, type FabricThinking } from "../thinking.js";
import { ActorStoreReadError, readStoreJson } from "./store-read.js";

export interface ActorSessionBindingRecord {
  model?: string;
  thinking?: FabricThinking;
  updatedAt: number;
}

interface ActorSessionBindingFile {
  format: 1;
  sessionId: string;
  /** Valid bindings plus entries this version could not load, kept as written. */
  bindings: Record<string, unknown>;
}

interface ActorBindingSnapshot {
  bindings: Map<string, ActorSessionBindingRecord>;
  /** Entries that failed validation, keyed by actor id, to write back unchanged. */
  unloaded: Map<string, unknown>;
}

const BINDING_LOCK_TIMEOUT_MS = 5_000;
const BINDING_STALE_LOCK_MS = 30_000;

const bindingFileName = (sessionId: string): string =>
  `${createHash("sha256").update(sessionId).digest("hex")}.json`;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Session-scoped model and thinking overrides for actors, shared on disk by
 * every store for the same session.
 *
 * Only a missing file reads as empty. When the file exists but cannot be read
 * or parsed, mutations throw ActorStoreReadError and leave the file alone,
 * get() keeps answering from the last good read, and readError reports the
 * failure until a later read succeeds. Entries that fail validation are kept
 * as written unless a mutation replaces that actor's binding.
 */
export class ActorBindingStore {
  readonly #bindings = new Map<string, ActorSessionBindingRecord>();
  #fingerprint: string | undefined;
  #readError: ActorStoreReadError | undefined;
  readonly filePath: string | undefined;

  constructor(
    readonly sessionId: string,
    root: string | undefined,
  ) {
    this.filePath = root ? path.join(root, "bindings", bindingFileName(sessionId)) : undefined;
    this.#sync(true);
  }

  /** The error from the latest failed read, or undefined after a good read. */
  get readError(): ActorStoreReadError | undefined {
    return this.#readError;
  }

  get(actorId: string): ActorSessionBindingRecord | undefined {
    this.#sync();
    const binding = this.#bindings.get(actorId);
    return binding ? { ...binding } : undefined;
  }

  async setModel(
    actorId: string,
    model: string | undefined,
  ): Promise<ActorSessionBindingRecord | undefined> {
    const next = model?.trim();
    return this.#update(actorId, (binding) => {
      if (next) binding.model = next;
      else delete binding.model;
    });
  }

  async setThinking(
    actorId: string,
    thinking: FabricThinking | undefined,
  ): Promise<ActorSessionBindingRecord | undefined> {
    return this.#update(actorId, (binding) => {
      if (thinking) binding.thinking = thinking;
      else delete binding.thinking;
    });
  }

  async delete(actorId: string): Promise<boolean> {
    return this.#mutate(actorId, (bindings) => bindings.delete(actorId));
  }

  async #update(
    actorId: string,
    mutate: (binding: ActorSessionBindingRecord) => void,
  ): Promise<ActorSessionBindingRecord | undefined> {
    return this.#mutate(actorId, (bindings) => {
      const binding = bindings.get(actorId) ?? { updatedAt: Date.now() };
      mutate(binding);
      if (!binding.model && !binding.thinking) {
        bindings.delete(actorId);
        return undefined;
      }
      binding.updatedAt = Date.now();
      bindings.set(actorId, binding);
      return { ...binding };
    });
  }

  async #mutate<T>(
    actorId: string,
    operation: (bindings: Map<string, ActorSessionBindingRecord>) => T,
  ): Promise<T> {
    if (!this.filePath) {
      const result = operation(this.#bindings);
      return result;
    }
    return this.#withLock(() => {
      // #read throws on any failure but a missing file, so a failed read
      // never writes an empty or partial map over the file.
      let snapshot: ActorBindingSnapshot;
      try {
        snapshot = this.#read();
      } catch (error) {
        if (error instanceof ActorStoreReadError) this.#readError = error;
        throw error;
      }
      this.#readError = undefined;
      const result = operation(snapshot.bindings);
      snapshot.unloaded.delete(actorId);
      this.#save(snapshot);
      this.#replace(snapshot.bindings);
      this.#fingerprint = this.#currentFingerprint();
      return result;
    });
  }

  #sync(force = false): void {
    if (!this.filePath) return;
    const fingerprint = this.#currentFingerprint();
    if (!force && !this.#readError && fingerprint === this.#fingerprint) return;
    try {
      this.#replace(this.#read().bindings);
    } catch (error) {
      if (!(error instanceof ActorStoreReadError)) throw error;
      // Keep the last good bindings and retry on the next access.
      this.#readError = error;
      return;
    }
    this.#readError = undefined;
    this.#fingerprint = fingerprint;
  }

  #read(): ActorBindingSnapshot {
    const snapshot: ActorBindingSnapshot = { bindings: new Map(), unloaded: new Map() };
    if (!this.filePath) return snapshot;
    const parsed = readStoreJson(this.filePath);
    if (parsed === undefined) return snapshot;
    if (!isObject(parsed) || parsed.format !== 1 || !isObject(parsed.bindings)) {
      throw new ActorStoreReadError(
        this.filePath,
        "expected a format 1 object with a bindings object",
      );
    }
    if (parsed.sessionId !== this.sessionId) {
      throw new ActorStoreReadError(this.filePath, "the file belongs to another session");
    }
    for (const [actorId, value] of Object.entries(parsed.bindings)) {
      const model = isObject(value) && typeof value.model === "string" ? value.model.trim() : "";
      const thinking = isObject(value) && isFabricThinking(value.thinking) ? value.thinking : undefined;
      if (!isObject(value) || typeof value.updatedAt !== "number" || (!model && !thinking)) {
        snapshot.unloaded.set(actorId, value);
        continue;
      }
      snapshot.bindings.set(actorId, {
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {}),
        updatedAt: value.updatedAt,
      });
    }
    return snapshot;
  }

  #replace(bindings: Map<string, ActorSessionBindingRecord>): void {
    this.#bindings.clear();
    for (const [actorId, binding] of bindings) {
      this.#bindings.set(actorId, { ...binding });
    }
  }

  #save({ bindings, unloaded }: ActorBindingSnapshot): void {
    if (!this.filePath) return;
    const value: ActorSessionBindingFile = {
      format: 1,
      sessionId: this.sessionId,
      bindings: Object.fromEntries(
        [
          ...[...bindings.entries()].map(([actorId, binding]): [string, unknown] => [actorId, { ...binding }]),
          ...unloaded.entries(),
        ].sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
    writeJsonAtomic(this.filePath, value, { space: 2, newline: true });
  }

  #currentFingerprint(): string | undefined {
    if (!this.filePath) return undefined;
    try {
      const stat = fs.statSync(this.filePath);
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return undefined;
    }
  }

  async #withLock<T>(operation: () => T): Promise<T> {
    if (!this.filePath) return operation();
    const lockPath = `${this.filePath}.lock`;
    const ownerPath = path.join(lockPath, "owner");
    const deadline = Date.now() + BINDING_LOCK_TIMEOUT_MS;
    const token = randomUUID();
    const processAlive = (pid: number): boolean => {
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    while (true) {
      try {
        fs.mkdirSync(lockPath, { mode: 0o700 });
        fs.writeFileSync(ownerPath, `${token}\n${process.pid}\n${Date.now()}\n${encodeOwnerIdentityLine()}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        break;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        try {
          const firstOwner = fs.readFileSync(ownerPath, "utf8");
          const [, pidText, createdText, identityLine] = firstOwner.trim().split("\n");
          const stale = Date.now() - Number(createdText) > BINDING_STALE_LOCK_MS;
          if (stale && lockOwnerLiveness(Number(pidText), Number(createdText), identityLine, {
            legacyAlive: processAlive,
            maxHoldMs: Math.max(SHORT_LOCK_MAX_HOLD_MS, BINDING_STALE_LOCK_MS),
          }) === "dead") {
            const secondOwner = fs.readFileSync(ownerPath, "utf8");
            if (secondOwner === firstOwner) {
              fs.rmSync(lockPath, { recursive: true, force: true });
              continue;
            }
          }
        } catch {
          // Lock creation or stale recovery raced; retry until the deadline.
        }
        if (Date.now() >= deadline) {
          throw new Error("Timed out waiting for the Fabric actor binding lock");
        }
        await delay(10);
      }
    }
    try {
      return operation();
    } finally {
      try {
        const owner = fs.readFileSync(ownerPath, "utf8");
        if (owner.startsWith(`${token}\n`)) {
          fs.rmSync(lockPath, { recursive: true, force: true });
        }
      } catch {
        // A recovering process already removed this lock.
      }
    }
  }
}
