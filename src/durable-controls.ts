import { createHash, randomUUID } from "node:crypto";
import type { Conversation, Cursor, Harness, Storage, Submission, SubmissionRecord } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";

export interface PiDurableMessageOptions {
  /** Stable caller-issued identity. Retrying the same message is a no-op, including after reattachment. */
  requestId?: string;
}

type SettledSubmission = Awaited<ReturnType<Submission["wait"]>>;
const MAX_CONTROLS = 128;
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

/** One completion boundary over the initial submission and every host-admitted steer/follow-up. */
export async function openDurableControls(options: {
  durable: typeof import("@earendil-works/pi-durable");
  context: Context;
  harness: Harness;
  storage: Storage;
  conversation: Conversation;
  initial: Submission;
  runId: string;
  serialize: <T>(operation: () => Promise<T>) => Promise<T>;
  closed: () => boolean;
}) {
  const { durable, context, harness, storage, conversation, initial, runId, serialize, closed } = options;
  const prefix = `${runId}:control:`;
  const Boundary = durable.defineDoc<{ closed: boolean }>({
    kind: "fabric.durable.completion", version: 1, scope: "conversation", history: "latest", fork: "initial",
    initial: () => ({ closed: false }),
    checkpointWhen: () => true,
  });
  await conversation.commit(async tx => { await tx.doc(Boundary, conversation.id); }, context);
  let stopping = false;

  async function submissions(): Promise<SubmissionRecord[]> {
    const controls: SubmissionRecord[] = [];
    let cursor: Cursor | undefined;
    let scanned = 0;
    do {
      const page = await storage.scanSubmissions({ conversationId: conversation.id }, 64, cursor, context);
      scanned += page.items.length;
      if (scanned > 4096) throw new Error("Pi durable submission scan exceeds 4096 records");
      for (const item of page.items) {
        if (item.type === "input" && item.requestId?.startsWith(prefix)) controls.push(item);
      }
      cursor = page.next;
    } while (cursor !== undefined);
    if (controls.length > MAX_CONTROLS) throw new Error("Pi durable control count exceeds 128 messages");
    return [await initial.status(context), ...controls];
  }

  async function send(kind: "steer" | "followUp", message: string, data?: unknown): Promise<void> {
    if (typeof message !== "string" || !message.trim() || message.length > 16_384) {
      throw new Error("Pi durable control message must contain 1–16384 characters");
    }
    if (data !== undefined && (!data || typeof data !== "object" || Array.isArray(data) ||
      Object.keys(data).some(key => key !== "requestId"))) {
      throw new Error("Pi durable message options support only requestId");
    }
    const requested = (data as PiDurableMessageOptions | undefined)?.requestId;
    if (requested !== undefined && (typeof requested !== "string" || !requested.trim() || requested.length > 256)) {
      throw new Error("Pi durable message requestId must contain 1–256 characters");
    }
    const identity = `${prefix}${digest(requested ?? randomUUID())}:`;
    const requestId = `${identity}${digest(JSON.stringify({ kind, message }))}`;
    const records = await submissions();
    const existing = records.find(item => item.requestId?.startsWith(identity));
    if (existing) {
      if (existing.requestId !== requestId) throw new Error("Pi durable message requestId already bound to different work");
      return;
    }
    const boundary = await harness.snapshot(Boundary, conversation.id, context);
    if (stopping || boundary?.closed || records[0]?.status === "unanswered") throw new Error("Pi durable run no longer accepts messages");
    if (records.length > MAX_CONTROLS) throw new Error("Pi durable control count exceeds 128 messages");
    // submit commits the input and its identity atomically. Recovery scans it even
    // if the process dies before this promise returns; no second intent log or replay is needed.
    await conversation.submit({ type: "input", content: message, requestId, whenBusy: kind }, context);
  }

  async function wait(): Promise<SettledSubmission | undefined> {
    while (!closed()) {
      const records = await submissions();
      let final: SettledSubmission | undefined;
      for (const record of records) {
        const submission = record.id === initial.id ? initial : await harness.submission(record.id, context);
        if (!submission) throw new Error("Pi durable admitted submission is missing");
        const result = await submission.wait(context);
        if (closed()) return;
        if (result.status === "unanswered") {
          stopping = true;
          // An unsuccessful generation leaves queued follow-ups in the inbox.
          // Withdraw them rather than hang forever or run them after reporting failure.
          await conversation.abort(context, { background: true });
          final = result;
          break;
        }
        if (result.type !== "input") throw new Error("Pi durable expected an input submission");
        // A steer admitted after a follow-up can be answered before it. Entry
        // IDs are session-global monotonic numbers; use answer order, not admission order.
        if (!final || final.type !== "input" || final.status !== "done" || result.answer > final.answer) final = result;
      }
      if (!final || closed()) return;
      const completed = await serialize(async () => {
        const current = await submissions();
        if (current.length !== records.length) return false;
        await conversation.commit(async tx => { (await tx.doc(Boundary, conversation.id)).closed = true; }, context);
        return true;
      });
      if (completed) return final;
    }
  }

  return {
    send,
    wait,
    async stop() {
      stopping = true;
      await conversation.abort(context, { background: true });
    },
    async liveness(): Promise<"running" | "settled" | "cancelled" | "interrupted"> {
      const boundary = await harness.snapshot(Boundary, conversation.id, context);
      if (!boundary?.closed) return "running";
      const records = await submissions();
      const failure = records.find(item => item.status === "unanswered");
      return failure?.status === "unanswered" ? failure.reason === "aborted" ? "cancelled" : "interrupted" : "settled";
    },
  };
}

export type PiDurableControls = Awaited<ReturnType<typeof openDurableControls>>;
