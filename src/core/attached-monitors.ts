import type { AgentManager } from "../agents/manager.js";
import type { ProviderParticipantRegistry } from "../topology/provider-participants.js";
import type { FabricShellJobStore } from "./shell-jobs.js";
import { ShellMonitor, type ShellMonitorOptions } from "./shell-monitor.js";

export interface MonitorTarget { kind: "task" | "participant"; id: string }
export type MonitorEvent = "output" | "progress" | "blocked" | "terminal" | "quiet";
export interface AttachedMonitorOptions extends ShellMonitorOptions {
  target: MonitorTarget;
  events: MonitorEvent[];
  quietAfterMs?: number;
  description?: string;
}
export interface MonitorParticipantSnapshot {
  id: string;
  generation: string;
  name: string;
  status: string;
  terminal: boolean;
  progress: Record<string, string | number | boolean | undefined>;
}
export interface MonitorParticipants {
  get(id: string): MonitorParticipantSnapshot | undefined;
  subscribe(listener: () => void): () => void;
}

/** Project operational metadata only: never copy participant transcripts or thinking. */
export function localMonitorParticipants(agents: AgentManager, providers: ProviderParticipantRegistry): MonitorParticipants {
  return {
    get(id) {
      const provider = providers.get(id);
      if (provider) return {
        id, generation: provider.generation, name: provider.label, status: provider.status,
        terminal: provider.status !== "running",
        progress: { phase: provider.phase, message: provider.message },
      };
      try {
        const agent = agents.status(id);
        return {
          id, generation: agent.id, name: agent.name, status: agent.status,
          terminal: ["completed", "failed", "stopped", "timed_out"].includes(agent.status),
          progress: "turns" in agent ? {
            turns: agent.turns, toolCalls: agent.toolCalls, currentTool: agent.currentTool,
            milestone: agent.milestone, blocked: !!agent.blockedOn, sleeping: !!agent.sleeping,
          } : {},
        };
      } catch { return undefined; }
    },
    subscribe(listener) {
      const offAgent = agents.subscribeUi(listener);
      const offProvider = providers.subscribe(listener);
      return () => { offAgent(); offProvider(); };
    },
  };
}

/** Attached observers own only their task, subscriptions and timers, never their target. */
export class AttachedMonitors {
  readonly #active = new Map<string, () => void>();
  #closed = false;
  constructor(readonly jobs: FabricShellJobStore, readonly participants?: MonitorParticipants) {}

  async start(options: AttachedMonitorOptions, ownerId?: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.#closed) throw new Error("Attached monitors are closed");
    if (this.jobs.live().filter(job => job.monitorActive).length >= 8)
      throw new Error("At most 8 monitors may run per session");
    if (options.delivery === "wake" && this.jobs.live().some(job => !job.abort.signal.aborted &&
      job.options.monitor?.delivery === "wake" && job.options.observes?.kind === options.target.kind && job.options.observes.id === options.target.id))
      throw new Error("A wake monitor already observes this target; stop it before attaching another");
    const sourceJob = options.target.kind === "task" ? this.jobs.get(options.target.id) : undefined;
    let previous = options.target.kind === "participant" ? this.participants?.get(options.target.id) : undefined;
    if (options.target.kind === "task" ? !sourceJob : !previous) throw new Error(`Unknown local ${options.target.kind}: ${options.target.id}`);
    if (sourceJob?.options.observes) throw new Error("Cannot monitor another attached monitor");
    const generation = previous?.generation;
    const { delivery, timeoutMs, intervalMs, match } = options;
    const monitor = this.jobs.begin("monitor", `Observe ${options.target.kind} ${options.target.id}`, {
      description: options.description ?? `Watch ${previous?.name ?? sourceJob?.options.description ?? options.target.id}`,
      ...(ownerId ? { ownerId } : {}), observes: { ...options.target },
      monitor: { delivery, timeoutMs, intervalMs, ...(match ? { match } : {}) },
    });
    let off = () => {};
    let offOutput = () => {};
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let ended = false;
    const metadata = new ShellMonitor({ delivery, timeoutMs, intervalMs }, batch => monitor.recordMonitorEvent(batch, true));
    const cleanup = () => {
      off(); offOutput();
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = undefined;
      monitor.abort.signal.removeEventListener("abort", abort);
      this.#active.delete(monitor.id);
    };
    const event = (type: string, data: unknown) => {
      const line = JSON.stringify({ event: type, target: options.target, at: Date.now(), data });
      if (!ended) { metadata.append(Buffer.from(`${line}\n`)); return; }
      monitor.flushMonitor(true);
      metadata.close();
      monitor.recordMonitorEvent({ lines: [line], omitted: 0 }, true, false);
    };
    const finish = (type: string, data: unknown, code = 0) => {
      if (ended) return;
      ended = true;
      cleanup();
      event(type, data);
      void monitor.finish(code, `[Monitor ${type}: ${JSON.stringify(data)}; target was not stopped]`).catch(() => undefined);
    };
    const abort = () => finish("stopped", { reason: String(monitor.abort.signal.reason ?? "Stopped") });
    const armQuiet = () => {
      if (quietTimer) clearTimeout(quietTimer);
      if (!options.events.includes("quiet") || !options.quietAfterMs || ended) return;
      quietTimer = setTimeout(() => {
        quietTimer = undefined;
        if (!ended) event("quiet", { quietForMs: options.quietAfterMs, meaning: "No observed progress; not proof of failure" });
      }, options.quietAfterMs);
      quietTimer.unref?.();
    };
    monitor.abort.signal.addEventListener("abort", abort, { once: true });
    this.#active.set(monitor.id, () => { monitor.stop("Monitor owner closed"); });
    try {
      await monitor.persistLog();
      signal?.throwIfAborted();
      if (ended || this.#closed) throw new Error("Monitor interrupted before attachment");
      monitor.spill();
      if (sourceJob) {
        const check = () => {
          if (sourceJob.finishedAt !== undefined) finish("terminal", { status: sourceJob.status, exitCode: sourceJob.exitCode });
        };
        offOutput = sourceJob.observeOutput(data => {
          armQuiet();
          if (options.events.includes("output")) monitor.append(data);
        });
        off = this.jobs.subscribe(change => { if (change.job.id === sourceJob.id && change.type === "finished") check(); });
        armQuiet();
        check();
      } else {
        const check = () => {
          if (ended) return;
          const next = this.participants!.get(options.target.id);
          if (!next || next.generation !== generation) { finish("unavailable", { reason: next ? "Participant replaced" : "Participant no longer available" }, 1); return; }
          if (next.terminal) { finish("terminal", { status: next.status }); return; }
          const changed = next.status !== previous!.status || JSON.stringify(next.progress) !== JSON.stringify(previous!.progress);
          if (changed) {
            armQuiet();
            if (options.events.includes("progress")) event("progress", { status: next.status, ...next.progress });
            if (options.events.includes("blocked") && next.progress.blocked && !previous!.progress.blocked) event("blocked", next.progress);
          }
          previous = next;
        };
        off = this.participants!.subscribe(check);
        armQuiet();
        check();
      }
      return monitor.info();
    } catch (error) {
      monitor.stop("Monitor attachment failed");
      cleanup();
      await monitor.finish(null);
      throw error;
    }
  }

  close(): void {
    this.#closed = true;
    for (const stop of [...this.#active.values()]) stop();
    this.#active.clear();
  }
}
