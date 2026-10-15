import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  writeJsonAtomic,
  encodeOwnerIdentityLine,
  lockOwnerLiveness,
  lockOwnerProvablyDead,
  reapLockByRenameClaim,
  SHORT_LOCK_MAX_HOLD_MS,
} from "../core/atomic-write.js";
import { isFabricThinking, type FabricThinking } from "../thinking.js";

export interface ActorSessionBindingRecord {
  model?: string;
  thinking?: FabricThinking;
  updatedAt: number;
}

interface ActorSessionBindingFile {
  format: 1;
  sessionId: string;
  bindings: Record<string, ActorSessionBindingRecord>;
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

export class ActorBindingStore {
  readonly #bindings = new Map<string, ActorSessionBindingRecord>();
  #fingerprint: string | undefined;
  readonly filePath: string | undefined;

  constructor(
    readonly sessionId: string,
    root: string | undefined,
  ) {
    this.filePath = root ? path.join(root, "bindings", bindingFileName(sessionId)) : undefined;
    this.#sync(true);
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
    return this.#mutate((bindings) => bindings.delete(actorId));
  }

  async #update(
    actorId: string,
    mutate: (binding: ActorSessionBindingRecord) => void,
  ): Promise<ActorSessionBindingRecord | undefined> {
    return this.#mutate((bindings) => {
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

  async #mutate<T>(operation: (bindings: Map<string, ActorSessionBindingRecord>) => T): Promise<T> {
    if (!this.filePath) {
      const result = operation(this.#bindings);
      return result;
    }
    return this.#withLock(() => {
      const bindings = this.#read();
      const result = operation(bindings);
      this.#save(bindings);
      this.#replace(bindings);
      this.#fingerprint = this.#currentFingerprint();
      return result;
    });
  }

  #sync(force = false): void {
    if (!this.filePath) return;
    const fingerprint = this.#currentFingerprint();
    if (!force && fingerprint === this.#fingerprint) return;
    this.#replace(this.#read());
    this.#fingerprint = fingerprint;
  }

  #read(): Map<string, ActorSessionBindingRecord> {
    const bindings = new Map<string, ActorSessionBindingRecord>();
    if (!this.filePath) return bindings;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      return bindings;
    }
    if (!isObject(parsed) || parsed.format !== 1 || parsed.sessionId !== this.sessionId) {
      return bindings;
    }
    if (!isObject(parsed.bindings)) return bindings;
    for (const [actorId, value] of Object.entries(parsed.bindings)) {
      if (!isObject(value) || typeof value.updatedAt !== "number") continue;
      const model = typeof value.model === "string" ? value.model.trim() : "";
      const thinking = isFabricThinking(value.thinking) ? value.thinking : undefined;
      if (!model && !thinking) continue;
      bindings.set(actorId, {
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {}),
        updatedAt: value.updatedAt,
      });
    }
    return bindings;
  }

  #replace(bindings: Map<string, ActorSessionBindingRecord>): void {
    this.#bindings.clear();
    for (const [actorId, binding] of bindings) {
      this.#bindings.set(actorId, { ...binding });
    }
  }

  #save(bindings: Map<string, ActorSessionBindingRecord>): void {
    if (!this.filePath) return;
    const value: ActorSessionBindingFile = {
      format: 1,
      sessionId: this.sessionId,
      bindings: Object.fromEntries(
        [...bindings.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([actorId, binding]) => [actorId, { ...binding }]),
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
          // A fresh lock is reaped only when its local owner is provably dead.
          const dead = stale
            ? lockOwnerLiveness(Number(pidText), Number(createdText), identityLine, {
              legacyAlive: processAlive,
              maxHoldMs: Math.max(SHORT_LOCK_MAX_HOLD_MS, BINDING_STALE_LOCK_MS),
            }) === "dead"
            : lockOwnerProvablyDead(Number(pidText), identityLine);
          if (dead) {
            const secondOwner = fs.readFileSync(ownerPath, "utf8");
            // Claim by rename so a lock a new owner took after this check survives.
            if (
              secondOwner === firstOwner &&
              reapLockByRenameClaim(lockPath, (claimed) => {
                try {
                  return fs.readFileSync(path.join(claimed, "owner"), "utf8") === firstOwner;
                } catch {
                  return false;
                }
              })
            ) {
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
