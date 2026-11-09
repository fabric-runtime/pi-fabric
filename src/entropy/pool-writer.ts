import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { FileLockTimeoutError } from "../core/file-lock.js";
import type { EntropyObservationWindow, SessionObservationCache } from "./pool.js";
import { updateObservationPoolAsync } from "./pool-store.js";
import {
  OBSERVATION_POOL_WORKER_ROLE,
  type ObservationPoolWorkerReply,
  type ObservationPoolWorkerRequest,
} from "./pool-worker.js";

const IDLE_MS = 30_000;

interface Pending {
  id: number;
  resolve(value: { written: boolean }): void;
  reject(error: Error): void;
}

const replyError = (error: { name: string; message: string }): Error => {
  // Contention stays retryable across the thread boundary.
  if (error.name === "FileLockTimeoutError") return new FileLockTimeoutError(error.message);
  const rebuilt = new Error(error.message);
  rebuilt.name = error.name;
  return rebuilt;
};

/**
 * Persists observation-pool updates on a worker thread, one at a time. This
 * thread summarizes the windows (cooperatively, reusing the cache); the
 * worker parses, merges and rewrites the pool. The thread starts at the
 * first update, is released after it, and exits once idle. Without a built
 * worker entry (source checkouts), or when a worker fails before replying,
 * the update runs in this thread instead: the pool is advisory evidence and
 * every update is an idempotent rebase under the cross-process lock.
 */
export class ObservationPoolWriter {
  #worker: Worker | undefined;
  #pending: Pending | undefined;
  #nextId = 0;
  #replies = 0;
  #inProcess = false;
  #idle: NodeJS.Timeout | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    // The built lazy entropy entry; see pool-worker.ts.
    readonly workerUrl: URL = new URL("../entropy/index.js", import.meta.url),
    readonly idleMs = IDLE_MS,
  ) {}

  /** True while updates run in this thread because the worker is unavailable. */
  get inProcess(): boolean {
    return this.#inProcess;
  }

  update(
    agentDir: string,
    windows: readonly EntropyObservationWindow[],
    cache: SessionObservationCache,
  ): Promise<{ written: boolean }> {
    const run = this.#queue.then(() => this.#update(agentDir, windows, cache));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = undefined;
    const worker = this.#worker;
    this.#worker = undefined;
    await worker?.terminate();
  }

  async #update(
    agentDir: string,
    windows: readonly EntropyObservationWindow[],
    cache: SessionObservationCache,
  ): Promise<{ written: boolean }> {
    const local = async () => ({ written: (await updateObservationPoolAsync(agentDir, windows, cache)).written });
    if (this.#inProcess) return local();
    let worker: Worker;
    try {
      if (!this.#worker && this.workerUrl.protocol === "file:" && !fs.existsSync(fileURLToPath(this.workerUrl))) {
        throw new Error("No built observation pool worker entry");
      }
      worker = this.#start();
    } catch {
      this.#inProcess = true;
      return local();
    }
    const summaries = await cache.summarize(windows);
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = undefined;
    worker.ref();
    try {
      return await new Promise<{ written: boolean }>((resolve, reject) => {
        const id = ++this.#nextId;
        this.#pending = { id, resolve, reject };
        worker.postMessage({ id, agentDir, summaries } satisfies ObservationPoolWorkerRequest);
      });
    } catch (error) {
      if (!(error instanceof WorkerFailure)) throw error;
      // A worker that never answered cannot run here (no built entry, or no
      // worker support); stay in this thread. A later failure only respawns.
      if (this.#replies === 0) this.#inProcess = true;
      return local();
    } finally {
      this.#pending = undefined;
      if (this.#worker === worker) {
        worker.unref();
        this.#idle = setTimeout(() => void this.close(), this.idleMs);
        this.#idle.unref();
      }
    }
  }

  #start(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(this.workerUrl, {
      workerData: { role: OBSERVATION_POOL_WORKER_ROLE },
      // Eval/stdin-only flags are invalid when Node starts this compiled module file.
      execArgv: process.execArgv.filter((value, index, args) =>
        value !== "--input-type" && args[index - 1] !== "--input-type" && !value.startsWith("--input-type=")),
    });
    worker.unref();
    this.#worker = worker;
    const fail = (error: Error): void => {
      if (this.#worker !== worker) return;
      this.#worker = undefined;
      void worker.terminate();
      this.#pending?.reject(new WorkerFailure(error.message));
    };
    worker.on("message", (reply: ObservationPoolWorkerReply) => {
      const pending = this.#pending;
      if (this.#worker !== worker || !pending || reply?.id !== pending.id) return;
      this.#replies++;
      if ("error" in reply) pending.reject(replyError(reply.error));
      else pending.resolve({ written: reply.written === true });
    });
    worker.once("error", fail);
    worker.once("exit", (code) => fail(new Error(`Observation pool worker exited (code ${code})`)));
    return worker;
  }
}

class WorkerFailure extends Error {
  override name = "ObservationPoolWorkerFailure";
}
