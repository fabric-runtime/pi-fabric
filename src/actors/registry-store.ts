import { randomUUID } from "node:crypto";
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

const ACTOR_REGISTRY_LOCK_TIMEOUT_MS = 5_000;
const ACTOR_REGISTRY_STALE_LOCK_MS = 30_000;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;

/** Disk protocol shared by registry merges and fenced lineage adoption. */
export class ActorRegistryStore {
  readonly #registryPath: string;
  readonly #actorRoot: string;

  constructor(actorRoot: string) {
    this.#actorRoot = actorRoot;
    this.#registryPath = path.join(actorRoot, "actors.json");
  }

  records(): Array<Record<string, unknown> & { id: string }> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#registryPath, "utf8")) as {
        actors?: unknown;
      };
      if (!Array.isArray(parsed.actors)) return [];
      return parsed.actors.flatMap((record) =>
        typeof record === "object" &&
        record !== null &&
        !Array.isArray(record) &&
        typeof (record as { id?: unknown }).id === "string"
          ? [record as Record<string, unknown> & { id: string }]
          : [],
      );
    } catch {
      return [];
    }
  }

  /** The callback must be synchronous: release precedes promise assimilation. */
  async withLock<T>(operation: () => T): Promise<T> {
    const lockPath = `${this.#registryPath}.lock`;
    const ownerPath = path.join(lockPath, "owner");
    const deadline = Date.now() + ACTOR_REGISTRY_LOCK_TIMEOUT_MS;
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
    fs.mkdirSync(this.#actorRoot, { recursive: true, mode: 0o700 });
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
          const stale = Date.now() - Number(createdText) > ACTOR_REGISTRY_STALE_LOCK_MS;
          // A fresh lock is reaped only when its local owner is provably dead.
          const dead = stale
            ? lockOwnerLiveness(Number(pidText), Number(createdText), identityLine, {
              legacyAlive: processAlive,
              maxHoldMs: Math.max(SHORT_LOCK_MAX_HOLD_MS, ACTOR_REGISTRY_STALE_LOCK_MS),
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
          throw new Error("Timed out waiting for the Fabric actor registry lock");
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

  fingerprint(): string | undefined {
    try {
      const stat = fs.statSync(this.#registryPath);
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return undefined;
    }
  }

  read(): unknown {
    return JSON.parse(fs.readFileSync(this.#registryPath, "utf8"));
  }

  /** Call within withLock for read-modify-write operations. */
  write(actors: readonly Record<string, unknown>[]): void {
    writeJsonAtomic(this.#registryPath, { format: 1, actors }, { space: 2 });
  }
}
