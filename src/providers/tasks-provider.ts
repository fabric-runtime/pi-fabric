import type { FabricActionDescriptor, FabricInvocationContext, FabricProvider, FabricProviderListRequest } from "../protocol.js";
import { SHELL_READ_MAX_BYTES, type FabricShellJobStore } from "../core/shell-jobs.js";
import { validationMessage } from "../core/action-arguments.js";
import { observationAction, observeExisting, type ObservationSource } from "../core/observation-actions.js";

const idSchema = { type: "object", properties: { id: { type: "string", minLength: 1 } }, required: ["id"], additionalProperties: false };
const waitSchema = { ...idSchema, properties: { ...idSchema.properties,
  timeoutMs: { type: "integer", minimum: 1, maximum: 300000, description: "Observation ceiling in milliseconds, not a delay or process deadline. Timeout never cancels the task." },
} };
const watchSchema = { ...waitSchema, properties: { ...waitSchema.properties,
  after: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Previously returned nextCursor; default 0. With match it is a byte offset; otherwise a monitor line cursor. Lost positions are disclosed." },
  match: { type: "string", minLength: 1, maxLength: 256, description: "Case-sensitive literal chosen at watch time; works on any background task, like jev-fabric watch <id> <literal>. Omit to read a launch-time monitor." },
} };
const readSchema = { ...idSchema, properties: { ...idSchema.properties,
  offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Byte offset into the task's combined output since launch; default 0. Pass the returned next." },
  max: { type: "integer", minimum: 1, maximum: SHELL_READ_MAX_BYTES, description: "Largest page in bytes; default 65536." },
  waitMs: { type: "integer", minimum: 1, maximum: 300000, description: "Long-poll ceiling: return as soon as bytes past offset exist or the task ends. Never stops the task." },
  encoding: { type: "string", enum: ["text", "base64"], description: "text (default) never splits a UTF-8 character; base64 returns byte-exact data." },
} };
const WATCH_LINES = 64;
const WATCH_LINE_CHARS = 2048;
const clean = (line: string): string => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
const descriptors: FabricActionDescriptor[] = [
  observationAction("task"),
  { name: "list", description: "List this session's tracked shell tasks and monitors, with IDs, command, cwd, state, timestamps, and bounded monitor events. No output polling is needed: detached completions notify the owning agent.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "read", effect: { kind: "none", ordering: "commutative" } },
  { name: "get", description: "Inspect one shell task by ID, returning metadata and a bounded output tail. Acknowledges its pending notification after a successful read. Full retained output is at logPath (bounded, not an archive).", inputSchema: idSchema, risk: "read", effect: { kind: "emission", ordering: "ordered" } },
  { name: "wait", description: "Wait without polling for a session-owned shell task to finish, default 30 seconds. Returns task metadata, a bounded output tail and timedOut. Inspect status and exitCode; an exited task is not goal verification. Timeout or cancellation stops only this wait.", inputSchema: waitSchema, risk: "read", effect: { kind: "emission", ordering: "ordered" } },
  { name: "read", description: "Read a background task's combined output by byte offset, in jev-fabric's read record shape: offset, bytes, omittedBytes, text (or base64 data), next, eof, state. Optional waitMs long-polls for new bytes. The live window is 1 MiB; 32 KiB stays readable after exit. Never consumes or stops anything.", inputSchema: readSchema, risk: "read", effect: { kind: "none", ordering: "commutative" } },
  { name: "watch", description: "Wait without polling for matching lines, task exit, or timeout (default 5 seconds). With match (any background task, chosen now): returns complete output lines containing that literal after the byte cursor, omittedBytes, more and nextCursor. Without match: reads a launch-time monitor (pi.bash monitor with delivery ui). Returns reason, up to 64 lines after the cursor, losses (burst/evicted cursor ranges), omitted, more and nextCursor with task metadata; pass nextCursor as after, immediately again while more is true. The latest 256 positions are replayable. No inference, wakeup, renewal or cancellation of the task. Not a lossless RPC stream.", inputSchema: watchSchema, risk: "read", effect: { kind: "none", ordering: "commutative" } },
  { name: "stop", description: "Stop one session-owned shell task or monitor by ID using its existing abort controller, not an arbitrary PID. A durable task is stopped through jev-fabric. An attached observation stops only itself, never its target. Cancellation does not wake the owning agent.", inputSchema: idSchema, risk: "execute", effect: { kind: "emission", ordering: "ordered" } },
  { name: "external", description: "List jev-fabric jobs in this session's durable store that no task here tracks, for example dev servers started by another harness or an earlier session. Returns id, state, label and start time; read-only.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "read", effect: { kind: "none", ordering: "commutative" } },
  { name: "adopt", description: "Attach an existing jev-fabric job from tasks.external to this session as a durable task: its output, completion notification, wait/stop and inspector row. Adopting does not restart or signal the process.", inputSchema: { type: "object", properties: { jobId: { type: "string", minLength: 1, maxLength: 128 }, description: { type: "string", minLength: 1, maxLength: 120 } }, required: ["jobId"], additionalProperties: false }, risk: "read", effect: { kind: "emission", ordering: "ordered" } },
];
const durableOnly = new Set(["external", "adopt"]);

export class TasksProvider implements FabricProvider {
  readonly name = "tasks";
  readonly description = "Session-owned shell orchestration with bounded wait/watch and explicit stop";
  constructor(readonly jobs: FabricShellJobStore, readonly observations?: ObservationSource) {}
  async list(request: FabricProviderListRequest): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    const available = descriptors.filter(d => (this.jobs.durable || !durableOnly.has(d.name)) && (d.name !== "observe" || this.observations));
    return query ? available.filter(d => `${d.name} ${d.description}`.toLowerCase().includes(query)) : available;
  }
  async describe(name: string): Promise<FabricActionDescriptor | undefined> {
    return (this.jobs.durable || !durableOnly.has(name)) && (name !== "observe" || this.observations)
      ? descriptors.find(d => d.name === name) : undefined;
  }
  async invoke(name: string, args: Record<string, unknown>, context: FabricInvocationContext): Promise<unknown> {
    const descriptor = await this.describe(name);
    if (!descriptor) throw new Error(`Unknown tasks action: ${name}`);
    const invalid = validationMessage(descriptor.inputSchema, args);
    if (invalid) throw new Error(`Invalid tasks.${name} arguments: ${invalid}`);
    // Reattach this session's durable tasks before answering about them.
    await this.jobs.durable?.resume();
    if (name === "observe") return observeExisting(this.observations?.(), "task", args, context);
    if (name === "list") return this.jobs.list();
    if (name === "external") return await this.jobs.durable!.external();
    if (name === "adopt") return { task: await this.jobs.durable!.adopt(args.jobId as string, args.description as string | undefined) };
    const id = args.id as string;
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown shell task: ${id}`);
    if (name === "stop") return { stopped: this.jobs.stop(id), task: job.info() };
    if (name === "read") {
      const offset = (args.offset as number | undefined) ?? 0;
      if (offset > job.written) throw new Error("tasks.read offset must not be past the task's output");
      if (args.waitMs !== undefined) await job.whenOutput(offset, args.waitMs as number, context.signal);
      return job.read(offset, (args.max as number | undefined) ?? SHELL_READ_MAX_BYTES, (args.encoding as "text" | "base64" | undefined) ?? "text");
    }
    if (name === "watch" && typeof args.match === "string") {
      return this.#watchOutput(job, args.match, (args.after as number | undefined) ?? 0, (args.timeoutMs as number | undefined) ?? 5000, context.signal);
    }
    if (name === "watch") {
      if (!job.options.monitor) throw new Error("tasks.watch needs a match literal, or a task started with monitor");
      const after = (args.after as number | undefined) ?? 0;
      const { task, timedOut } = await this.jobs.waitFor(id, { after, timeoutMs: (args.timeoutMs as number | undefined) ?? 5000, signal: context.signal });
      const page = job.replay(after);
      return { task, reason: page.nextCursor > after ? "event" : timedOut ? "timeout" : "finished", ...page };
    }
    const waited = name === "wait"
      ? await this.jobs.waitFor(id, { timeoutMs: (args.timeoutMs as number | undefined) ?? 30000, signal: context.signal })
      : undefined;
    const before = job.info();
    const output = await job.outputText();
    const after = job.info();
    // A new event during the async read was not necessarily consumed.
    if (!waited?.timedOut && before.eventCount === after.eventCount && before.finishedAt === after.finishedAt) this.jobs.acknowledge(id);
    return { task: job.info(), output, ...(waited ? { timedOut: waited.timedOut } : {}) };
  }

  /** Literal line filter over the byte stream, like jev-fabric watch; the cursor stops at line boundaries. */
  async #watchOutput(job: NonNullable<ReturnType<FabricShellJobStore["get"]>>, match: string, after: number, timeoutMs: number, signal: AbortSignal | undefined) {
    if (after > job.written) throw new Error("tasks.watch after must not be past the task's output");
    const deadline = Date.now() + timeoutMs;
    const lines: string[] = [];
    let cursor = after;
    let omittedBytes = 0;
    for (;;) {
      const page = job.read(cursor);
      omittedBytes += page.omittedBytes;
      const text = page.text ?? "";
      let consumed = 0;
      for (let end = text.indexOf("\n"); end >= 0 && lines.length < WATCH_LINES; end = text.indexOf("\n", consumed)) {
        const line = text.slice(consumed, end);
        consumed = end + 1;
        if (line.includes(match)) lines.push(clean(line).slice(0, WATCH_LINE_CHARS));
      }
      // A final unterminated line counts once the task has ended.
      if (page.eof && consumed < text.length && lines.length < WATCH_LINES) {
        const line = text.slice(consumed);
        consumed = text.length;
        if (line.includes(match)) lines.push(clean(line).slice(0, WATCH_LINE_CHARS));
      }
      // A single line longer than a page would stall the cursor; consume it as clipped.
      if (consumed === 0 && page.bytes >= SHELL_READ_MAX_BYTES) consumed = text.length;
      cursor = page.offset + Buffer.byteLength(text.slice(0, consumed));
      const result = (reason: "event" | "finished" | "timeout") =>
        ({ task: job.info(), reason, lines, omittedBytes, more: cursor < job.written, nextCursor: cursor });
      if (lines.length) return result("event");
      if (page.eof) return result("finished");
      // Bytes already past this page (a full page, or output that raced the read).
      if (job.written > page.next) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return result("timeout");
      await job.whenOutput(page.next, remaining, signal);
    }
  }
}
