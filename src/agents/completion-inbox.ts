import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRunResult } from "./types.js";
import { notifyAgentFeedback } from "../feedback.js";

export const AGENT_COMPLETION_MESSAGE_TYPE = "pi-fabric-agent-complete";
const SUMMARY_CHARS = 4_000;
const BATCH_CHARS = 16_000;
const IDLE_BATCH_MS = 40;

type Completion = Pick<AgentRunResult, "id" | "name" | "status" | "text" | "error" | "startedAt" | "finishedAt">;
type PendingCompletion = { result: Completion; delivered: (() => void) | undefined };
type CompletionMessage = { customType: string; content: string; display: boolean; details: { ids: string[] } };

const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/g, " ");
const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}\n[truncated; use agents.wait({id}) for the full result]` : text;

/** Own notifications until the tool batch ends, so a late wait can still retract them. */
export class AgentCompletionInbox {
  readonly #pending = new Map<string, PendingCompletion>();
  readonly #acknowledged = new Set<string>();
  readonly #unsubscribe: Array<() => void> = [];
  #context: ExtensionContext;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #suspended = false;
  #failed = false;
  #closed = false;

  constructor(readonly pi: ExtensionAPI, context: ExtensionContext) {
    this.#context = context;
    const subscribe = (event: string, handler: (...handlerArgs: any[]) => unknown): void => {
      if (typeof pi.on !== "function") return;
      const unsubscribe = (pi.on as (name: string, fn: (...fnArgs: any[]) => unknown) => unknown)(event, handler);
      if (typeof unsubscribe === "function") this.#unsubscribe.push(unsubscribe as () => void);
    };
    subscribe("turn_end", (event, ctx) => {
        this.#context = ctx;
        const stopReason = event.message?.role === "assistant" ? event.message.stopReason : undefined;
        if (ctx.signal?.aborted || stopReason === "aborted") {
          this.#suspended = true;
          return;
        }
        // Automatic recovery does not emit input. Keep errors distinct from
        // explicit interruption so a successful retry can release the inbox.
        if (stopReason === "error") { this.#failed = true; return; }
        if (stopReason) this.#failed = false;
        this.#flush();
      });
    subscribe("before_agent_start", (_event, ctx) => {
        this.#context = ctx;
        let message: CompletionMessage | undefined;
        // Join the user's first inference; do not enqueue an extra turn behind it.
        this.#flush((value) => { message = value; });
        return message ? { message } : undefined;
      });
    subscribe("agent_settled", (event, ctx) => {
        if (event.aborted || this.#context.signal?.aborted || ctx.signal?.aborted) this.#suspended = true;
        this.#context = ctx;
        this.#schedule();
      });
    subscribe("input", (_event, ctx) => {
        this.#context = ctx;
        this.#suspended = false;
        this.#failed = false;
      });
    subscribe("session_tree", (_event, ctx) => {
        this.#context = ctx;
        // Navigation abandons this frontier, not the visible run history.
        for (const { result, delivered } of this.#pending.values()) {
          this.#acknowledged.add(result.id);
          this.#confirmDelivery(delivered);
        }
        this.#pending.clear();
      });
  }

  enqueue(result: Completion, delivered?: () => void): void {
    if (this.#closed) return;
    if (this.#acknowledged.has(result.id)) {
      this.#confirmDelivery(delivered);
      return;
    }
    if (this.#pending.has(result.id)) return;
    this.#pending.set(result.id, {
      result: {
        id: result.id, name: result.name, status: result.status, startedAt: result.startedAt,
        ...(result.finishedAt !== undefined ? { finishedAt: result.finishedAt } : {}),
        text: clip(result.text, SUMMARY_CHARS),
        ...(result.error !== undefined ? { error: clip(result.error, SUMMARY_CHARS) } : {}),
      },
      delivered,
    });
    if (this.#context.hasUI) {
      const failure = result.status !== "completed";
      const detail = failure && result.error ? `: ${oneLine(result.error).slice(0, 180)}` : "";
      notifyAgentFeedback(this.#context, result.name, `${result.status}${detail}`, failure ? "warning" : "info");
    }
    this.#schedule();
  }

  acknowledge(id: string): void {
    this.#acknowledged.add(id);
    this.#pending.delete(id);
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#pending.clear();
    this.#acknowledged.clear();
  }

  #confirmDelivery(delivered: (() => void) | undefined): void {
    try { delivered?.(); } catch {
      // The durable envelope remains queued and retries its receipt on the next poll.
    }
  }

  #schedule(delayMs = IDLE_BATCH_MS): void {
    if (this.#closed || this.#timer || this.#suspended || this.#failed || !this.#pending.size) return;
    // Never enqueue into Pi during an active tool batch. turn_end owns that path.
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#context.signal?.aborted) { this.#suspended = true; return; }
      if (this.#context.isIdle() && !this.#context.hasPendingMessages()) this.#flush();
      // Manual compaction has no subsequent agent_settled event. Retain a
      // low-frequency delivery retry only while unread results are queued.
      this.#schedule(250);
    }, delayMs);
    this.#timer.unref?.();
  }

  #flush(deliver: (message: CompletionMessage) => void = (message) =>
    this.pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true })): void {
    if (this.#closed || this.#suspended || this.#failed || this.#context.signal?.aborted || !this.#pending.size) return;
    const batch = [...this.#pending.values()].slice(0, 32);
    const perResult = Math.max(0, Math.min(SUMMARY_CHARS, Math.floor(BATCH_CHARS / batch.length) - 320));
    const content = [
      "Unread background agent results (batched). Incorporate relevant results into the current task. These are run outcomes, not new user requests. Do not restart completed work or reply merely to acknowledge stale/superseded results. A completed run does not necessarily mean its assignment is complete.",
      ...batch.map(({ result }) => {
        const seconds = Math.round(Math.max(0, (result.finishedAt ?? Date.now()) - result.startedAt) / 1_000);
        const summary = [result.error, result.text].filter(Boolean).join("\n");
        return `Agent ${oneLine(result.name).slice(0, 80)} (${result.id}) ${result.status} after ${seconds}s:\n${clip(summary || "no result", perResult)}`;
      }),
    ].join("\n\n");
    deliver({
      customType: AGENT_COMPLETION_MESSAGE_TYPE,
      content,
      display: false,
      details: { ids: batch.map(({ result }) => result.id) },
    });
    for (const { result, delivered } of batch) {
      this.#pending.delete(result.id);
      this.#acknowledged.add(result.id);
      this.#confirmDelivery(delivered);
    }
    if (!this.#pending.size && this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}
