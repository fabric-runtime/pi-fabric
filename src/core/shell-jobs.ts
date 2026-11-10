import fs from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { closeScratch, createScratch } from "../storage/scratch.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { PiShellToolName } from "./pi-tools.js";
import { SHELL_MONITOR_PREVIEWS, ShellMonitor, type ShellMonitorOptions, type ShellMonitorBatch } from "./shell-monitor.js";
import { ShellReplay, type ShellReplayPage } from "./shell-replay.js";
import type { DurableShellBridge } from "../jev-fabric/bridge.js";
import { fabricControlAbort } from "./control-abort.js";

export { DEFAULT_SHELL_HANG_MS, SHELL_HANG_MAX_MS } from "./shell-limits.js";
const SHELL_HANG_SNAPSHOT_BYTES = 8_000;
export const SHELL_TAIL_BYTES = 1024 * 1024;
export const SHELL_LOG_BYTES = 8 * 1024 * 1024;
export const SHELL_COMPLETED_HANDLES = 256;
/** Output kept readable by offset after a task finishes, like jev-fabric's 32 KiB receipt tails. */
export const SHELL_FINISHED_READ_BYTES = 32 * 1024;
/** Largest single tasks.read page. */
export const SHELL_READ_MAX_BYTES = 64 * 1024;

/**
 * One page of a task's combined output by byte offset, in jev-fabric's read
 * record shape. Offsets count every byte since launch and never reset; bytes
 * that left the retained window are disclosed in `omittedBytes`.
 */
export interface FabricShellReadRecord {
  id: string;
  stream: "output";
  offset: number;
  bytes: number;
  omittedBytes: number;
  text?: string;
  data?: string;
  next: number;
  eof: boolean;
  state: FabricShellJobStatus;
}

// Stop before an incomplete trailing UTF-8 sequence so text pages never split a character.
const utf8Boundary = (buffer: Buffer): number => {
  for (let back = 1; back <= Math.min(3, buffer.length); back++) {
    const byte = buffer[buffer.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? buffer.length - back : buffer.length;
  }
  return buffer.length;
};
const SHELL_COMPLETED_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const LOG_HEADER = "[Bounded shell log: starts with retained pre-spill tail; 8 MiB total cap, then further output is omitted. Not a full-output archive.]\n";
const LOG_TRUNCATED = "\n[Shell log truncated: disk limit reached; subsequent output omitted.]\n";

const posixQuote = (value: string): string =>
  "'" + value.replaceAll("'", "'\\''") + "'";

const powershellQuote = (value: string): string =>
  "'" + value.replaceAll("'", "''") + "'";

export const wrapShellCommandForPid = (
  command: string,
  pidPath: string,
  tool: PiShellToolName,
): string =>
  tool === "powershell"
    ? `Set-Content -LiteralPath ${powershellQuote(pidPath)} -Value $PID\n${command}`
    // Git Bash `$$` is an MSYS pid; Node and taskkill need /proc/$$/winpid.
    : `printf '%s\\n' "$(cat /proc/$$/winpid 2>/dev/null || printf '%s' "$$")" > ${posixQuote(pidPath)}\n${command}`;

export const formatShellHangNotice = (input: {
  elapsedMs: number;
  pid?: number;
  logPath: string;
  /** Set once the handed-off process has already ended; `null` when it left no exit code. */
  exitCode?: number | null;
}): string => {
  const seconds = Math.max(1, Math.round(input.elapsedMs / 1_000));
  const pid = input.pid !== undefined ? ` (pid ${input.pid})` : "";
  if (input.exitCode !== undefined) {
    const exit = input.exitCode === null ? "Ended without an exit code" : `Exited with code ${input.exitCode}`;
    return `[${exit} after ${seconds}s${pid}. Bounded output (may be truncated): ${input.logPath}]`;
  }
  return `[Still running after ${seconds}s${pid}. Bounded live output (may be truncated): ${input.logPath}]`;
};

export const appendShellHangNotice = (output: string, notice: string): string =>
  output ? `${output}\n\n${notice}` : notice;

export const parseShellPid = (text: string): number | undefined => {
  const pid = Number(text.trim());
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
};

/** Shell tools, plus `fabric_exec` programs moved to the background. */
export type FabricTaskTool = PiShellToolName | "fabric_exec" | "monitor";
/** Final output a detached program hands to its completion event. */
const PROGRAM_SUMMARY_BYTES = 8_000;

type FabricShellJobStatus = "running" | "spilled" | "exited" | "failed" | "killed" | "timed_out";

/** A task whose process is owned by a jev-fabric store, not this Pi process. */
export interface FabricDurableTaskInfo {
  home: string;
  /** jev-fabric job ID once `start` has returned. */
  jobId?: string;
  /** Reattached after a restart or from another harness, rather than launched here. */
  adopted?: boolean;
}

export interface FabricShellJobOptions {
  /** Stable task ID when reattaching a durable task; otherwise random. */
  id?: string;
  /** Original start time when reattaching a durable task. */
  startedAt?: number;
  durable?: FabricDurableTaskInfo;
  cwd?: string;
  ownerId?: string;
  description?: string;
  monitor?: ShellMonitorOptions;
  /** An observer task owns its subscription, never the target process or participant. */
  observes?: { kind: "task" | "participant"; id: string };
}

export interface FabricShellJobEvent {
  type: "started" | "spilled" | "monitor" | "finished" | "acknowledged" | "stopping";
  job: FabricShellJobInfo;
  output?: string;
}


export interface FabricShellJobInfo {
  id: string;
  tool: FabricTaskTool;
  command: string;
  pid?: number;
  logPath?: string;
  startedAt: number;
  spilledAt?: number;
  finishedAt?: number;
  status: FabricShellJobStatus;
  exitCode?: number | null;
  cwd?: string;
  ownerId?: string;
  description?: string;
  lastOutputAt?: number;
  monitor?: ShellMonitorOptions;
  observes?: { kind: "task" | "participant"; id: string };
  lastEvent?: ShellMonitorBatch & { at: number };
  durable?: FabricDurableTaskInfo;
  eventCount: number;
  unread: boolean;
  stopping: boolean;
}

export interface FabricShellJobHandle {
  readonly id: string;
  readonly tool: FabricTaskTool;
  readonly command: string;
  readonly abort: AbortController;
  readonly detached: AbortController;
  readonly durable: FabricDurableTaskInfo | undefined;
  readonly startedAt: number;
  readonly pidPath: string;
  pid?: number;
  logPath?: string;
  exitCode?: number | null;
  spilled: boolean;
  finished: boolean;
  append(data: Buffer): void;
  snapshotText(maxBytes?: number): string;
  persistLog(): Promise<string>;
  readPid(): Promise<number | undefined>;
  spill(): void;
  whenSpill(): Promise<void>;
  finish(exitCode?: number | null, footer?: string): Promise<void>;
}

class FabricShellJob implements FabricShellJobHandle {
  readonly id: string;
  readonly tool: FabricTaskTool;
  readonly command: string;
  readonly abort = new AbortController();
  /** Aborted when this session lets go of a durable process without stopping it. */
  readonly detached = new AbortController();
  readonly startedAt: number;
  readonly pidPath: string;
  readonly durable: FabricDurableTaskInfo | undefined;
  pid?: number;
  logPath?: string;
  spilled = false;
  finished = false;
  spilledAt?: number;
  finishedAt?: number;
  exitCode?: number | null;
  status: FabricShellJobStatus = "running";
  #tail = Buffer.alloc(0);
  #omitted = false;
  /** Total bytes appended since launch; the end offset of the read window. */
  #written = 0;
  /** After finish: a short copy of the tail, readable by offset only. */
  #finished = Buffer.alloc(0);
  readonly #outputWaiters = new Set<() => void>();
  readonly #outputObservers = new Set<(data: Buffer) => void>();
  readonly #directory: string;
  #descriptor: number | undefined;
  #logBytes = 0;
  #logTruncated = false;
  #spill = new AbortController();
  #pidRead: Promise<number | undefined> | undefined;
  #monitor: ShellMonitor | undefined;
  #deadline: ReturnType<typeof setTimeout> | undefined;
  #timedOut = false;
  lastOutputAt?: number;
  lastEvent?: ShellMonitorBatch & { at: number };
  readonly #replay = new ShellReplay();
  unread = false;

  get eventCount(): number { return this.#replay.cursor; }

  constructor(tool: FabricTaskTool, command: string, readonly onChange: (type: FabricShellJobEvent["type"], output?: string) => void, tempRoot: string, readonly options: FabricShellJobOptions = {}) {
    this.id = options.id ?? randomUUID();
    this.startedAt = options.startedAt ?? Date.now();
    this.durable = options.durable ? { ...options.durable } : undefined;
    this.tool = tool;
    this.command = command;
    this.#directory = createScratch("shell", tempRoot);
    this.pidPath = path.join(this.#directory, "child.pid");
    if (options.monitor) {
      this.#monitor = new ShellMonitor(options.monitor, batch => this.recordMonitorEvent(batch));
      this.#deadline = setTimeout(() => {
        this.#timedOut = true;
        this.stop("Monitor deadline reached");
      }, options.monitor.timeoutMs);
      this.#deadline.unref?.();
    }
  }

  /** Subscribe from now; retained output is available separately through read(). */
  observeOutput(observer: (data: Buffer) => void): () => void {
    if (!this.finished) this.#outputObservers.add(observer);
    return () => { this.#outputObservers.delete(observer); };
  }

  flushMonitor(final = false): void {
    if (final) this.#monitor?.close(!this.abort.signal.aborted);
    else this.#monitor?.flush();
  }

  /** Structured observer events bypass the optional stdout filter. */
  recordMonitorEvent(batch: ShellMonitorBatch, retain = false, notify = true): void {
    if (retain) this.#append(Buffer.from(`${batch.lines.join("\n")}\n`), false);
    const previews = batch.lines.slice(-SHELL_MONITOR_PREVIEWS);
    this.lastEvent = { lines: previews, omitted: batch.omitted + batch.lines.length - previews.length, at: Date.now() };
    this.#replay.record(batch.lines, batch.omitted);
    this.unread = true;
    if (notify && !this.finished) this.onChange("monitor");
  }

  stop(reason = "Stopped by user or agent"): boolean {
    if (this.finished || this.abort.signal.aborted) return false;
    if (this.#deadline) clearTimeout(this.#deadline);
    this.#deadline = undefined;
    this.#monitor?.close(false);
    this.abort.abort(fabricControlAbort(reason));
    this.onChange("stopping");
    return true;
  }

  /** Pages retained monitor lines after a cursor, disclosing lost positions. */
  replay(after: number): ShellReplayPage { return this.#replay.page(after); }

  /** Releases a durable process to its jev-fabric store; it keeps running. */
  detach(): void {
    if (this.finished || !this.durable) return;
    if (this.#deadline) clearTimeout(this.#deadline);
    this.#deadline = undefined;
    this.#monitor?.close(false);
    this.detached.abort(fabricControlAbort("Detached from the Pi session"));
  }

  acknowledge(): void {
    this.unread = false;
    this.onChange("acknowledged");
  }

  append(data: Buffer): void { this.#append(data, true); }

  #append(data: Buffer, frame: boolean): void {
    if (this.finished) return;
    if (data.length > 0) this.lastOutputAt = Date.now();
    if (frame) this.#monitor?.append(data);
    const keep = Math.max(0, SHELL_TAIL_BYTES - data.length);
    if (this.#tail.length + data.length > SHELL_TAIL_BYTES) this.#omitted = true;
    // Copy slices: a tiny view must not pin an arbitrarily large input buffer.
    this.#tail = Buffer.concat([
      this.#tail.subarray(Math.max(0, this.#tail.length - keep)),
      data.subarray(Math.max(0, data.length - SHELL_TAIL_BYTES)),
    ]);
    this.#writeLog(data);
    this.#written += data.length;
    if (data.length > 0) {
      this.#notifyOutput();
      for (const observer of this.#outputObservers) {
        try { observer(data); } catch { /* Observation cannot break the process. */ }
      }
    }
  }

  #notifyOutput(): void {
    for (const wake of [...this.#outputWaiters]) wake();
  }

  /** Bytes appended since launch: the cursor just past the newest output. */
  get written(): number { return this.#written; }

  /** Reads combined output from a byte offset; never blocks and never consumes. */
  read(offset: number, max = SHELL_READ_MAX_BYTES, encoding: "text" | "base64" = "text"): FabricShellReadRecord {
    const window = this.finished ? this.#finished : this.#tail;
    const start = this.#written - window.length;
    const from = Math.min(Math.max(offset, start), this.#written);
    const limit = Math.max(1, Math.min(SHELL_READ_MAX_BYTES, Math.floor(max)));
    let slice = window.subarray(from - start, Math.min(window.length, from - start + limit));
    if (encoding === "text" && !(this.finished && from + slice.length === this.#written)) slice = slice.subarray(0, utf8Boundary(slice));
    const next = from + slice.length;
    return {
      id: this.id, stream: "output", offset: from, bytes: slice.length,
      omittedBytes: Math.max(0, Math.min(from, start) - Math.min(offset, this.#written)),
      ...(encoding === "base64" ? { data: slice.toString("base64") } : { text: slice.toString("utf8") }),
      next, eof: this.finished && next >= this.#written, state: this.status,
    };
  }

  /** Resolves when output past `offset` exists or the task finishes; never stops the task. */
  whenOutput(offset: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.#written > offset || this.finished) return Promise.resolve();
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        this.#outputWaiters.delete(done);
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = (): void => { done(); reject(signal?.reason ?? new Error("Task observation cancelled")); };
      const timer = setTimeout(done, timeoutMs);
      this.#outputWaiters.add(done);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  #writeLog(data: Buffer): void {
    if (this.#descriptor === undefined || this.#logTruncated) return;
    const available = Math.max(0, SHELL_LOG_BYTES - Buffer.byteLength(LOG_TRUNCATED) - this.#logBytes);
    try {
      const chunk = data.subarray(0, available);
      // Bounded synchronous writes avoid an unbounded WriteStream backpressure queue.
      let offset = 0;
      while (offset < chunk.length) {
        const written = fs.writeSync(this.#descriptor, chunk, offset);
        if (written <= 0) throw new Error("Shell log write made no progress");
        offset += written;
      }
      this.#logBytes += chunk.length;
      if (chunk.length < data.length) {
        fs.writeSync(this.#descriptor, LOG_TRUNCATED);
        this.#logTruncated = true;
      }
    } catch {
      // Never crash the subprocess data handler on ENOSPC. The header already
      // disclaims completeness; close the descriptor and stop accepting output.
      try { fs.closeSync(this.#descriptor); } catch {}
      this.#descriptor = undefined;
      this.#logTruncated = true;
    }
  }

  snapshotText(maxBytes = SHELL_HANG_SNAPSHOT_BYTES): string {
    const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : SHELL_TAIL_BYTES;
    const slice = this.#tail.subarray(Math.max(0, this.#tail.length - limit));
    const truncated = this.#omitted || slice.length < this.#tail.length;
    return `${truncated ? "[Output truncated; retained tail follows]\n" : ""}${slice.toString("utf8")}`;
  }

  async persistLog(): Promise<string> {
    if (this.logPath) return this.logPath;
    if (this.finished) throw new Error("Shell job finished before a log was requested");
    const logPath = path.join(this.#directory, "output.log");
    try {
      this.#descriptor = fs.openSync(logPath, "wx", 0o600);
      fs.writeSync(this.#descriptor, LOG_HEADER);
      this.#logBytes = Buffer.byteLength(LOG_HEADER);
      if (this.#omitted) this.#writeLog(Buffer.from("[Pre-spill output truncated: only the last 1 MiB was retained.]\n"));
      this.#writeLog(this.#tail);
      this.logPath = logPath;
      return logPath;
    } catch (error) {
      if (this.#descriptor !== undefined) { try { fs.closeSync(this.#descriptor); } catch {} }
      this.#descriptor = undefined;
      try { fs.unlinkSync(logPath); } catch {}
      throw error;
    }
  }

  async readPid(): Promise<number | undefined> {
    if (this.pid !== undefined) return this.pid;
    this.#pidRead ??= (async () => {
      for (let attempt = 0; attempt < 25; attempt += 1) {
        try {
          const pid = parseShellPid(await readFile(this.pidPath, "utf8"));
          if (pid !== undefined) {
            this.pid = pid;
            return pid;
          }
        } catch {
          // Pid file is written by the child after spawn.
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return undefined;
    })();
    return this.#pidRead;
  }

  spill(): void {
    if (this.spilled || this.finished) return;
    this.spilled = true;
    this.spilledAt = Date.now();
    this.status = "spilled";
    this.onChange("spilled");
    if (!this.#spill.signal.aborted) this.#spill.abort();
  }

  whenSpill(): Promise<void> {
    if (this.spilled || this.#spill.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      this.#spill.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  async finish(exitCode?: number | null, footer?: string): Promise<void> {
    if (this.finished) return;
    // A fast exit can beat the provider's persistLog continuation after spill.
    const persistence = this.spilled && !this.logPath ? this.persistLog() : undefined;
    const output = this.snapshotText(this.tool === "fabric_exec" ? PROGRAM_SUMMARY_BYTES : 2000);
    this.finished = true;
    this.#outputObservers.clear();
    if (this.#deadline) clearTimeout(this.#deadline);
    this.#deadline = undefined;
    this.#monitor?.close(!this.abort.signal.aborted);
    await persistence?.catch(() => undefined);
    this.finishedAt = Date.now();
    if (this.exitCode === undefined && exitCode !== undefined) this.exitCode = exitCode;
    this.status = this.#timedOut ? "timed_out" : this.abort.signal.aborted ? "killed" : this.exitCode === 0 ? "exited" : "failed";
    this.unread = this.spilled;
    if (footer) this.#writeLog(Buffer.from(footer.endsWith("\n") ? footer : `${footer}\n`));
    if (this.#descriptor !== undefined) { try { fs.closeSync(this.#descriptor); } catch {} }
    this.#descriptor = undefined;
    // Release the live tail; keep a short window readable by offset (the bounded log holds the rest).
    this.#finished = Buffer.from(this.#tail.subarray(Math.max(0, this.#tail.length - SHELL_FINISHED_READ_BYTES)));
    this.#tail = Buffer.alloc(0);
    this.#omitted = false;
    if (!this.#spill.signal.aborted) this.#spill.abort();
    await unlink(this.pidPath).catch(() => undefined);
    if (this.logPath) closeScratch(this.#directory);
    else { try { fs.rmSync(this.#directory, { recursive: true, force: true }); } catch {} }
    this.#notifyOutput();
    this.onChange("finished", [output, footer?.slice(-1000)].filter(Boolean).join("\n"));
  }

  async outputText(maxBytes = 8000): Promise<string> {
    if (!this.finished) return this.snapshotText(maxBytes);
    if (!this.logPath) return "No retained output log.";
    const file = await fs.promises.open(this.logPath, "r");
    try {
      const size = (await file.stat()).size;
      const length = Math.min(size, Math.max(1, Math.min(32000, maxBytes)));
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, size - length);
      return `${size > length ? "[Bounded output tail]\n" : ""}${buffer.subarray(0, bytesRead).toString("utf8")}`;
    } finally { await file.close(); }
  }

  info(): FabricShellJobInfo {
    return {
      id: this.id,
      tool: this.tool,
      command: this.command,
      ...this.options,
      ...(this.durable ? { durable: { ...this.durable } } : {}),
      ...(this.options.monitor ? { monitor: { ...this.options.monitor } } : {}),
      ...(this.lastOutputAt !== undefined ? { lastOutputAt: this.lastOutputAt } : {}),
      ...(this.lastEvent ? { lastEvent: { ...this.lastEvent, lines: [...this.lastEvent.lines] } } : {}),
      eventCount: this.eventCount,
      unread: this.unread,
      stopping: !this.finished && this.abort.signal.aborted,
      ...(this.pid !== undefined ? { pid: this.pid } : {}),
      ...(this.logPath ? { logPath: this.logPath } : {}),
      startedAt: this.startedAt,
      ...(this.spilledAt !== undefined ? { spilledAt: this.spilledAt } : {}),
      ...(this.finishedAt !== undefined ? { finishedAt: this.finishedAt } : {}),
      status: this.status,
      ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
    };
  }
}

export const trackShellOperations = (
  inner: BashOperations,
  job: FabricShellJobHandle,
  tool: PiShellToolName,
): BashOperations => ({
  exec: (command, cwd, options) =>
    inner.exec(wrapShellCommandForPid(command, job.pidPath, tool), cwd, {
      ...options,
      onData: (data) => {
        job.append(data);
        options.onData(data);
      },
    }).then(result => { job.exitCode = result.exitCode; return result; }),
});

export class FabricShellJobStore {
  readonly #jobs = new Map<string, FabricShellJob>();
  readonly #listeners = new Set<(event: FabricShellJobEvent) => void>();
  #closed = false;
  readonly #closing = new AbortController();
  /** Optional jev-fabric backend for durable tasks; absent on Windows and managed hosts. */
  durable: DurableShellBridge | undefined;

  subscribe(listener: (event: FabricShellJobEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #emit(event: FabricShellJobEvent): void {
    if (this.#closed) return;
    for (const listener of this.#listeners) {
      try { listener(event); } catch { /* Observers cannot break shell execution. */ }
    }
  }

  constructor(readonly tempRoot = tmpdir()) {}

  #prune(): void {
    const completed = [...this.#jobs.values()].filter((job) => job.finishedAt !== undefined);
    completed.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const [index, job] of completed.entries()) {
      if (index < completed.length - SHELL_COMPLETED_HANDLES || Date.now() - (job.finishedAt ?? 0) >= SHELL_COMPLETED_MAX_AGE_MS) this.#jobs.delete(job.id);
    }
  }

  begin(tool: FabricTaskTool, command: string, options: FabricShellJobOptions = {}): FabricShellJob {
    if (this.#closed) throw new Error("Shell job store is closed");
    this.#prune();
    if (options.id !== undefined && this.#jobs.has(options.id)) throw new Error(`Shell task already tracked: ${options.id}`);
    const job = new FabricShellJob(tool, command, (type, output) => {
      this.#emit({ type, job: job.info(), ...(output ? { output } : {}) });
      if (type === "finished") this.#prune();
    }, this.tempRoot, options);
    this.#jobs.set(job.id, job);
    this.#emit({ type: "started", job: job.info() });
    return job;
  }

  /** Event-driven, bounded observation. Timeout/cancellation never stops the job. */
  waitFor(id: string, options: { after?: number; timeoutMs: number; signal?: AbortSignal | undefined }): Promise<{ task: FabricShellJobInfo; timedOut: boolean }> {
    options.signal?.throwIfAborted();
    this.#closing.signal.throwIfAborted();
    const job = this.get(id);
    if (!job) throw new Error(`Unknown shell task: ${id}`);
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 300_000)
      throw new Error("Task observation timeoutMs must be an integer from 1 to 300000");
    if (options.after !== undefined && (!Number.isSafeInteger(options.after) || options.after < 0 || options.after > job.eventCount))
      throw new Error("Task observation after must be an existing event cursor");
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe = () => {};
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        unsubscribe();
        options.signal?.removeEventListener("abort", abort);
        this.#closing.signal.removeEventListener("abort", closing);
      };
      const abort = () => { cleanup(); reject(options.signal?.reason ?? new Error("Task observation cancelled")); };
      const closing = () => { cleanup(); reject(new Error("Shell job store is closed")); };
      const complete = (timedOut: boolean) => { cleanup(); resolve({ task: job.info(), timedOut }); };
      const check = () => {
        if (job.info().finishedAt !== undefined || (options.after !== undefined && job.eventCount > options.after)) complete(false);
      };
      unsubscribe = this.subscribe(event => { if (event.job.id === id) check(); });
      options.signal?.addEventListener("abort", abort, { once: true });
      this.#closing.signal.addEventListener("abort", closing, { once: true });
      timer = setTimeout(() => complete(true), options.timeoutMs);
      // Subscribe before inspecting: an exit or monitor batch cannot fall into a gap.
      check();
    });
  }

  stop(id: string): boolean {
    const job = this.get(id);
    if (!job) throw new Error(`Unknown shell task: ${id}`);
    return job.stop();
  }

  acknowledge(id: string): void { this.get(id)?.acknowledge(); }

  get(id: string): FabricShellJob | undefined {
    this.#prune();
    return this.#jobs.get(id);
  }

  list(): FabricShellJobInfo[] {
    this.#prune();
    return [...this.#jobs.values()].map((job) => job.info());
  }

  waiting(): FabricShellJob[] {
    return [...this.#jobs.values()].filter((job) => !job.spilled && !job.finished);
  }

  live(): FabricShellJob[] {
    return [...this.#jobs.values()].filter((job) => !job.finished);
  }

  spillWaiting(): number {
    const jobs = this.waiting();
    for (const job of jobs) job.spill();
    return jobs.length;
  }

  killWaiting(): number {
    const jobs = this.waiting();
    for (const job of jobs) {
      if (!job.abort.signal.aborted) job.abort.abort(fabricControlAbort("Command aborted"));
    }
    return jobs.length;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#closing.abort(fabricControlAbort("Shell job store is closed"));
    this.#listeners.clear();
    const live = this.live();
    for (const job of live) {
      // A durable process belongs to its jev-fabric store and outlives this session.
      if (job.durable) job.detach();
      else if (!job.abort.signal.aborted) job.abort.abort(fabricControlAbort("Fabric session ended"));
    }
    await Promise.allSettled(live.map((job) => job.finish(null, job.durable
      ? `\n\n[Detached: jev-fabric job ${job.durable.jobId ?? "(starting)"} keeps running outside this session]\n`
      : "\n\n[Process ended: session closed]\n")));
    this.#jobs.clear();
  }
}

/** An active observer owns notifications; its terminal receipt also deduplicates a racing source completion. */
export function hasWakeObserver(jobs: FabricShellJobStore, kind: "task" | "participant", id: string): boolean {
  return jobs.list().some(job => job.observes?.kind === kind && job.observes.id === id &&
    job.monitor?.delivery === "wake" && (job.status === "exited" ||
      (job.finishedAt === undefined && !jobs.get(job.id)?.abort.signal.aborted)));
}

export const raceShellHang = async <T>(options: {
  execute: (signal: AbortSignal) => Promise<T>;
  parentSignal: AbortSignal | undefined;
  hangMs: number;
  immediate?: boolean;
  job: FabricShellJobHandle;
}): Promise<{ status: "done"; value: T } | { status: "error"; error: unknown } | { status: "spilled" }> => {
  const { job, parentSignal, hangMs } = options;
  const onParentAbort = (): void => {
    if (job.spilled || job.finished || job.abort.signal.aborted) return;
    job.abort.abort(parentSignal?.reason ?? new Error("Command aborted"));
  };
  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  const detachParent = (): void => {
    parentSignal?.removeEventListener("abort", onParentAbort);
  };

  let hangTimer: ReturnType<typeof setTimeout> | undefined;
  const hang = new Promise<"spill">((resolve) => {
    const finish = (): void => resolve("spill");
    if (hangMs > 0) {
      hangTimer = setTimeout(() => {
        job.spill();
        finish();
      }, hangMs);
      hangTimer.unref?.();
    }
    if (options.immediate) {
      void job.readPid().then(() => {
        if (!job.finished) job.spill();
      });
    }
    void job.whenSpill().then(finish);
  });

  const execute = options.execute(job.abort.signal).then(
    (value) => ({ status: "done" as const, value }),
    (error) => ({ status: "error" as const, error }),
  );

  try {
    const first = await Promise.race([execute, hang]);
    if (first === "spill") {
      if (job.finished) return execute;
      job.spill();
      detachParent();
      void execute.then(async (result) => {
        if (job.finished) return;
        if (result.status === "done") {
          await job.finish(0, `\n\n[Process exited with code ${job.exitCode ?? 0}]\n`);
          return;
        }
        const message = result.error instanceof Error ? result.error.message : String(result.error);
        await job.finish(null, "\n\n[" + message + "]\n");
      });
      return { status: "spilled" };
    }
    detachParent();
    // An immediate job is handed off however briefly it ran. On a loaded host a
    // short command exits before the pid poll's next tick, and the caller was
    // promised a task, not that command's foreground result or exit error. A
    // job that never started (an error) stays in the foreground.
    if (options.immediate && first.status === "done" && !job.finished) {
      job.spill();
      await job.finish(0, `\n\n[Process exited with code ${job.exitCode ?? 0}]\n`);
      return { status: "spilled" };
    }
    return first;
  } finally {
    if (hangTimer) clearTimeout(hangTimer);
  }
};
      }).catch((error: unknown) => {
        // A detached job's bookkeeping failure is a log line, never a process crash.
        console.warn(`[pi-fabric] background ${job.tool} task ${job.id} could not record its end: ${error instanceof Error ? error.message : String(error)}`);
