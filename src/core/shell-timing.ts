import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FABRIC_SHELL_TIMING_EVENT, type FabricShellTimingV1 } from "../protocol.js";
import type { FabricShellJobStore } from "./shell-jobs.js";

/** Timing is independent of output delivery, acknowledgements, and agent wakeups. */
export class FabricShellTimingBridge {
  readonly #active = new Map<string, "bash" | "powershell">();
  readonly #unsubscribe: () => void;

  constructor(
    readonly events: ExtensionAPI["events"],
    readonly sessionId: string,
    jobs: FabricShellJobStore,
  ) {
    this.#unsubscribe = jobs.subscribe(({ type, job }) => {
      // The v1 contract names shell tools only; detached programs are not metered here.
      if (job.tool !== "bash" && job.tool !== "powershell") return;
      if (type === "spilled" && !this.#active.has(job.id)) {
        this.#active.set(job.id, job.tool);
        this.#emit(job.id, job.tool, "started");
      } else if (type === "finished" && this.#active.delete(job.id)) {
        this.#emit(job.id, job.tool, "finished");
      }
    });
  }

  #emit(taskId: string, tool: "bash" | "powershell", phase: FabricShellTimingV1["phase"]): void {
    const payload: FabricShellTimingV1 = {
      version: 1, sessionId: this.sessionId, taskId, tool, phase, timestamp: Date.now(),
    };
    try { this.events.emit(FABRIC_SHELL_TIMING_EVENT, payload); } catch { /* Accounting cannot break shell execution or cleanup. */ }
  }

  close(): void {
    this.#unsubscribe();
    // The store suppresses notifications during close. End metering before it
    // aborts the remaining jobs, even on a Fabric-only reload.
    for (const [id, tool] of this.#active) this.#emit(id, tool, "finished");
    this.#active.clear();
  }
}
