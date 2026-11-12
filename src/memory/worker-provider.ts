import path from "node:path";
import { Worker } from "node:worker_threads";
import type { FabricInvocationContext } from "../protocol.js";
import { MemoryProvider, type MemoryProviderContext } from "../providers/memory-provider.js";
import type { LiveSessionBranch } from "./lineage.js";
import type { MemoryWorkerReply } from "./file-worker.js";

const MAX_PENDING_REQUESTS = 64;
const IDLE_TIMEOUT_MS = 30_000;

interface Request {
  id: number;
  action: string;
  args: Record<string, unknown>;
  invocation: FabricInvocationContext;
  branch?: LiveSessionBranch | undefined;
  abort(): void;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

const sameBranch = (left: LiveSessionBranch, right: LiveSessionBranch): boolean =>
  left.leafId === right.leafId && left.entries.length === right.entries.length &&
  left.entries.every((entry, index) =>
    (entry as { id?: string }).id === (right.entries[index] as { id?: string }).id);

/** Pi-facing file memory: one lazy worker, bounded FIFO, no transcript work on the UI thread. */
export class WorkerMemoryProvider extends MemoryProvider {
  private worker: Worker | undefined;
  private active: Request | undefined;
  private readonly pending: Request[] = [];
  private idleTimer: NodeJS.Timeout | undefined;
  private stopping: Promise<void> | undefined;
  private closed = false;
  private nextId = 0;

  constructor(
    private readonly workerContext: MemoryProviderContext,
    private readonly workerUrl = new URL("../memory/file-worker.js", import.meta.url),
  ) {
    super(workerContext);
  }

  override async invoke(action: string, args: Record<string, unknown>, invocation: FabricInvocationContext): Promise<unknown> {
    invocation.signal?.throwIfAborted();
    if (this.closed) throw new Error("Memory provider is closed");
    // Authorized host adapters contain callbacks and must stay in their owning host.
    if ((typeof args.source === "string" && args.source.length > 0) ||
        !["recall", "expand", "outline", "sessions"].includes(action)) {
      return super.invoke(action, args, invocation);
    }
    if (this.pending.length + (this.active ? 1 : 0) >= MAX_PENDING_REQUESTS) {
      throw new Error(`Memory request queue is full (${MAX_PENDING_REQUESTS} requests); await outstanding calls`);
    }
    return new Promise((resolve, reject) => {
      const request: Request = {
        id: ++this.nextId, action, args, invocation, resolve, reject,
        abort: () => {
          if (this.active === request) {
            this.active = undefined;
            void this.retire();
          } else {
            const index = this.pending.indexOf(request);
            if (index >= 0) this.pending.splice(index, 1);
          }
          this.finish(request, false, invocation.signal?.reason ?? new Error("Memory request aborted"));
          this.pump();
        },
      };
      invocation.signal?.addEventListener("abort", request.abort, { once: true });
      this.pending.push(request);
      this.pump();
    });
  }

  private snapshot(request: Request): LiveSessionBranch | undefined {
    const context = this.workerContext;
    if (request.args.branches === "all" || !context.sessionFile || !context.getLiveBranch) return undefined;
    const sessionLike = request.action === "expand" || request.action === "outline";
    const selector = sessionLike ? request.args.session : request.args.scope;
    const target = typeof selector === "string" && selector.trim().startsWith("session:")
      ? selector.trim().slice("session:".length).trim()
      : sessionLike && typeof selector === "string" ? selector.trim() : undefined;
    if (target !== undefined && target !== context.sessionId &&
        target !== path.basename(context.sessionFile, ".jsonl") &&
        path.resolve(target) !== path.resolve(context.sessionFile)) return undefined;
    const branch = context.getLiveBranch();
    // Lineage needs IDs only. Never clone tool output, images, or the full transcript to the worker.
    return {
      leafId: branch.leafId,
      entries: branch.entries.map(entry => {
        const id = entry !== null && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined;
        return typeof id === "string" ? { id } : {};
      }),
    };
  }

  private start(): Worker {
    const { agentDir, cwd, config, sessionId, sessionFile } = this.workerContext;
    const worker = new Worker(this.workerUrl, {
      workerData: { agentDir, cwd, config, sessionId, sessionFile },
      // Eval/stdin-only flags are invalid when Node starts this compiled module file.
      execArgv: process.execArgv.filter((value, index, args) =>
        value !== "--input-type" && args[index - 1] !== "--input-type" && !value.startsWith("--input-type=")),
    });
    this.worker = worker;
    worker.on("message", (message: MemoryWorkerReply) => {
      const request = this.active;
      if (this.worker !== worker || !request || message?.id !== request.id) return;
      try {
        if (message.type === "progress") {
          request.invocation.update(message.text);
          return;
        }
        if (message.type === "error") {
          const error = new Error(message.message);
          error.name = message.name;
          this.active = undefined;
          this.finish(request, false, error);
        } else if (message.type === "result") {
          const branch = this.snapshot(request);
          if (request.branch && (!branch || !sameBranch(request.branch, branch))) {
            throw new Error("Session branch changed during memory retrieval; retry the request");
          }
          this.active = undefined;
          this.finish(request, true, message.value);
        } else {
          throw new Error("Invalid memory worker response");
        }
        this.pump();
      } catch (error) {
        this.failWorker(worker, error);
      }
    });
    worker.once("error", error => this.failWorker(worker, error));
    worker.once("exit", code => this.failWorker(worker, new Error(`Memory worker exited before completing its request (code ${code})`)));
    return worker;
  }

  private finish(request: Request, success: boolean, value: unknown): void {
    request.invocation.signal?.removeEventListener("abort", request.abort);
    if (success) request.resolve(value);
    else request.reject(value);
  }

  private failWorker(worker: Worker, error: unknown): void {
    if (this.worker !== worker) return;
    const request = this.active;
    this.active = undefined;
    void this.retire();
    if (request) this.finish(request, false, error);
  }

  private pump(): void {
    if (this.closed || this.active || this.stopping) return;
    const request = this.pending.shift();
    if (!request) {
      this.worker?.unref();
      if (this.worker && !this.idleTimer) {
        this.idleTimer = setTimeout(() => { void this.retire(); }, IDLE_TIMEOUT_MS);
        this.idleTimer.unref();
      }
      return;
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.active = request;
    try {
      request.invocation.signal?.throwIfAborted();
      request.branch = this.snapshot(request);
      const worker = this.worker ?? this.start();
      worker.ref();
      worker.postMessage({ id: request.id, action: request.action, args: request.args, branch: request.branch,
        ...(request.invocation.scope ? { scope: request.invocation.scope } : {}) });
    } catch (error) {
      this.active = undefined;
      void this.retire();
      this.finish(request, false, error);
      this.pump();
    }
  }

  private retire(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return this.stopping ?? Promise.resolve();
    const stopping = worker.terminate().then(() => {}, () => {});
    this.stopping = stopping;
    void stopping.then(() => {
      if (this.stopping === stopping) this.stopping = undefined;
      this.pump();
    });
    return stopping;
  }

  async close(): Promise<void> {
    this.closed = true;
    const active = this.active;
    this.active = undefined;
    const requests = this.pending.splice(0);
    if (active) requests.unshift(active);
    for (const request of requests) this.finish(request, false, new Error("Memory provider is closed"));
    await this.retire();
  }
}
