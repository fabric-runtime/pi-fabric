// Worker thread for the machine-wide observation pool. The pool is shared by
// every Pi session under one agent directory and grows to tens of megabytes;
// parsing, merging and rewriting it after each fabric_exec turn held Pi's
// interactive thread for hundreds of milliseconds. Only per-window summaries
// cross into this thread, and only a written flag comes back.
//
// The thread runs the existing lazy entropy entry (entropy/index.js) rather
// than an entry of its own: a separate entry sharing the atomic-write and
// lock modules split a new chunk into the eager startup graph. The listener
// starts only in a worker that carries this role.
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { updateObservationPoolFromSummariesAsync } from "./pool-store.js";
import type { SummarizedObservationWindow } from "./pool.js";

export const OBSERVATION_POOL_WORKER_ROLE = "pi-fabric:observation-pool";

export interface ObservationPoolWorkerRequest {
  id: number;
  agentDir: string;
  summaries: SummarizedObservationWindow[];
}

export type ObservationPoolWorkerReply =
  | { id: number; written: boolean }
  | { id: number; error: { name: string; message: string } };

const port = parentPort;
if (!isMainThread && port &&
  (workerData as { role?: unknown } | null | undefined)?.role === OBSERVATION_POOL_WORKER_ROLE) {
  // Requests arrive one at a time: the writer awaits each reply first.
  port.on("message", (request: ObservationPoolWorkerRequest) => {
    void updateObservationPoolFromSummariesAsync(request.agentDir, request.summaries).then(
      (saved) => port.postMessage({ id: request.id, written: saved.written } satisfies ObservationPoolWorkerReply),
      (error: unknown) => port.postMessage({
        id: request.id,
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      } satisfies ObservationPoolWorkerReply),
    );
  });
}
