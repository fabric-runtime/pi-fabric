import fs from "node:fs";
import path from "node:path";
import type { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import type { FabricActionDescriptor, FabricInvocationContext, FabricProvider, FabricProviderListRequest } from "../protocol.js";
import { validationMessage } from "../core/action-arguments.js";
import type { DurableShellBridge } from "../jev-fabric/bridge.js";
import type { JevFabricServe } from "../jev-fabric/serve.js";
import { emitToolCallPreflight, missingToolHooksMessage } from "./pi-tools-provider.js";

const DAY_MS = 24 * 3_600_000;
const id = { type: "string", minLength: 1, maxLength: 128, description: "Session ID from sessions.open (`s-…` for session lifetime) or a durable jev-fabric job ID." };
const idOnly = { type: "object", properties: { id }, required: ["id"], additionalProperties: false };
const waitMs = { type: "integer", minimum: 1, maximum: 300000, description: "Long-poll ceiling; ready evidence returns at once. Never stops the child." };

const descriptors: FabricActionDescriptor[] = [
  {
    name: "open",
    description: "Start an interactive child with its stdin kept open, owned by jev-fabric (macOS/Linux). Lifetime session (default) ends with this Pi session, or with the Jev program that opened it; durable: true keeps it in the jev-fabric store after Pi exits. Give argv (literal, no shell) or cmd (run by bash -c). Returns id, lifetime and state. Drive it with write/read; stop it explicitly.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      argv: { type: "array", minItems: 1, maxItems: 57, items: { type: "string", minLength: 1, maxLength: 4096 }, description: "Literal argv; argv[0] is the executable." },
      cmd: { type: "string", minLength: 1, maxLength: 65536, description: "Shell source for bash -c, when shell syntax is needed." },
      cwd: { type: "string", minLength: 1, description: "Working directory; default this session's cwd." },
      timeoutMs: { type: "integer", minimum: 1000, maximum: DAY_MS, description: "Child lifetime ceiling; default 1 hour, at most 24 hours." },
      label: { type: "string", minLength: 1, maxLength: 120, description: "Short human-readable purpose." },
      durable: { type: "boolean", description: "Keep the child in the jev-fabric store beyond this session; input goes through its queue (about one 25 ms tick of latency)." },
    } },
    risk: "execute", effect: { kind: "emission", ordering: "ordered" },
  },
  {
    name: "write",
    description: "Append text to an interactive child's stdin, in order. Returns written bytes. A finished child or closed stdin is an error, never a silent drop.",
    inputSchema: { type: "object", properties: { id, text: { type: "string", maxLength: 65536 } }, required: ["id", "text"], additionalProperties: false },
    risk: "execute", effect: { kind: "emission", ordering: "ordered" },
  },
  { name: "closeInput", description: "Send EOF to an interactive child's stdin. Idempotent.", inputSchema: idOnly, risk: "execute", effect: { kind: "emission", ordering: "ordered" } },
  {
    name: "read",
    description: "Read stdout or stderr bytes from an offset: {offset, bytes, omittedBytes, text | data, next, eof, state}. Offsets never reset; at least the newest 1 MiB per stream stays readable and older bytes are disclosed as omittedBytes. With waitMs it returns as soon as bytes past offset exist. Pass next as the following offset.",
    inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: {
      id,
      stream: { type: "string", enum: ["stdout", "stderr"], description: "Default stdout." },
      offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      max: { type: "integer", minimum: 1, maximum: 65536 },
      waitMs,
      encoding: { type: "string", enum: ["text", "base64"] },
    } },
    risk: "read", effect: { kind: "none", ordering: "commutative" },
  },
  { name: "status", description: "Current state, or the final receipt.", inputSchema: idOnly, risk: "read", effect: { kind: "none", ordering: "commutative" } },
  {
    name: "wait",
    description: "Wait for the final receipt, or return the running state at the ceiling (default 30 s). Waiting never stops the child.",
    inputSchema: { type: "object", properties: { id, timeoutMs: { type: "integer", minimum: 1, maximum: 300000 } }, required: ["id"], additionalProperties: false },
    risk: "read", effect: { kind: "none", ordering: "commutative" },
  },
  {
    name: "events",
    description: "Retained jev-fabric events after a sequence cursor, optionally long-polled.",
    inputSchema: { type: "object", properties: { id, after: { type: "integer", minimum: 0 }, waitMs }, required: ["id"], additionalProperties: false },
    risk: "read", effect: { kind: "none", ordering: "commutative" },
  },
  { name: "stop", description: "Stop a child by ID (process group, then force), never by PID. Idempotent.", inputSchema: idOnly, risk: "execute", effect: { kind: "emission", ordering: "ordered" } },
  { name: "list", description: "Interactive children opened by this Pi session, with lifetime and state.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "read", effect: { kind: "none", ordering: "commutative" } },
];

type Opened = { id: string; lifetime: "session" | "durable"; label?: string; owner?: string; shell: boolean };

/** Runs the shell `tool_call` preflight for one command of `sessions.<action>`; throws when a hook blocks it. */
export type ShellPreflight = (input: Record<string, unknown>, context: Pick<FabricInvocationContext, "signal" | "nestedToolCallId" | "parentToolCallId">, action: "open" | "write") => Promise<void>;

/** The `bash` `tool_call` preflight `pi.bash` runs, through the captured catalog's runner. */
export const toolCallShellPreflight = (
  runner: () => ExtensionRunner | undefined,
  runnerUnavailable: () => boolean = () => false,
): ShellPreflight => async (input, context, action) => {
  const current = runner();
  // Like pi.bash: without a runner no tool_call hook can judge the command, so refuse it.
  if (!current) throw new Error(missingToolHooksMessage(`sessions.${action}`, runnerUnavailable()));
  await emitToolCallPreflight(current, "bash", input, context, `sessions.${action} was blocked by a bash tool_call hook`);
};

// A word naming a shell or a program that hosts one (`env bash`, `docker exec -it c sh`, `ssh host`).
// Extra matches only add preflights; a missed shell would let its commands skip the guard.
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "csh", "tcsh", "ssh", "su", "sudo", "doas", "script", "tmux", "screen", "login"]);
const isShellArgv = (argv: string[]): boolean => argv.some(word => SHELLS.has(path.basename(word).replace(/^-/, "")));
const shellQuote = (word: string): string => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

/**
 * Interactive children through jev-fabric's serve protocol: the same verbs,
 * records and lifetimes as the jev-fabric CLI and clients (docs/composition.md
 * in jev-fabric). One serve connection per Pi session owns every `session`
 * child; a Jev program's session children end with that program.
 */
export class SessionsProvider implements FabricProvider {
  readonly name = "sessions";
  readonly description = "Interactive jev-fabric children: open, write, read, wait and stop";
  #serve: Promise<JevFabricServe> | undefined;
  readonly #opened = new Map<string, Opened>();
  /** Text after the last newline written to each shell session, judged again with the next write. */
  readonly #partial = new Map<string, string>();
  #closed = false;

  constructor(
    readonly bridge: DurableShellBridge,
    readonly options: { cwd: string; shellOverride: () => boolean; preflight?: ShellPreflight },
  ) {}

  async list(request: FabricProviderListRequest): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    return query ? descriptors.filter(d => `${d.name} ${d.description}`.toLowerCase().includes(query)) : descriptors;
  }

  async describe(name: string): Promise<FabricActionDescriptor | undefined> { return descriptors.find(d => d.name === name); }

  #connect(): Promise<JevFabricServe> {
    if (this.#closed) return Promise.reject(new Error("Sessions provider is closed"));
    this.#serve ??= (async () => {
      const [resolution, { JevFabricServe }] = await Promise.all([this.bridge.resolve("sessions"), import("../jev-fabric/serve.js")]);
      const serve = await JevFabricServe.open(resolution.path, { home: this.bridge.home, cwd: this.options.cwd, timeoutMs: DAY_MS });
      // A lost connection took its session children with it; the next call reconnects.
      void serve.exited.then(() => {
        for (const [key, opened] of this.#opened) if (opened.lifetime === "session") this.#opened.delete(key);
        this.#serve = undefined;
      });
      return serve;
    })();
    this.#serve.catch(() => { this.#serve = undefined; });
    return this.#serve;
  }

  async invoke(name: string, args: Record<string, unknown>, context: FabricInvocationContext): Promise<unknown> {
    const descriptor = await this.describe(name);
    if (!descriptor) throw new Error(`Unknown sessions action: ${name}`);
    const invalid = validationMessage(descriptor.inputSchema, args);
    if (invalid) throw new Error(`Invalid sessions.${name} arguments: ${invalid}`);
    if (name === "list") return [...this.#opened.values()].map(opened => ({ ...opened }));
    if (name === "open") return this.#open(args, context);
    const serve = await this.#connect();
    const job = args.id as string;
    switch (name) {
      case "write": {
        // Text written to a shell is a command. A session this provider did not open is unknown: treat it as a shell.
        if (this.#opened.get(job)?.shell === false) return serve.request("write", { job, text: args.text }, context.signal);
        // A command split across writes is judged whole: the guard sees the unfinished line before this text.
        const line = (this.#partial.get(job) ?? "") + String(args.text);
        await this.#preflight("write", line.replace(/\r?\n$/, ""), undefined, "text written to a session", context);
        const result = await serve.request("write", { job, text: args.text }, context.signal);
        this.#partial.set(job, line.slice(line.lastIndexOf("\n") + 1));
        return result;
      }
      case "closeInput": return serve.request("closeInput", { job }, context.signal);
      case "read": return serve.request("read", { job, stream: args.stream ?? "stdout",
        ...pick(args, ["offset", "max", "waitMs", "encoding"]) }, context.signal);
      case "status": return serve.request("status", { job }, context.signal);
      case "wait": return serve.request("wait", { job, ...pick(args, ["timeoutMs"]) }, context.signal);
      case "events": return serve.request("events", { job, ...pick(args, ["after", "waitMs"]) }, context.signal);
      case "stop": return serve.request("stop", { job }, context.signal);
    }
    throw new Error(`Unknown sessions action: ${name}`);
  }

  /**
   * Show a hook-based shell guard the command, as `pi.bash` would, and return the command to run.
   * A hook may block it. It may rewrite it only when `rewritable`; otherwise a rewrite is refused,
   * because argv and stdin text cannot be replaced after the guard has judged them.
   */
  async #preflight(action: "open" | "write", command: string, cwd: string | undefined, what: string, context: FabricInvocationContext, rewritable = false): Promise<string> {
    if (process.env.PI_FABRIC_WRITE_POLICY) {
      // Confined child: enforce the shell policy here too, as pi.bash does, even where no tool_call hook replays.
      const guard = await import("../agents/write-guard.js");
      const policy = guard.readWritePolicy();
      const denial = policy && guard.writePolicyDenial(policy, "bash", { command }, cwd ?? this.options.cwd);
      if (denial) throw new Error(denial);
    }
    if (!this.options.preflight) return command;
    const input: Record<string, unknown> = { command, ...(cwd ? { cwd } : {}) };
    // Pass only the call identity: the hook input is not this call's arguments, so it must not replace them in the audit record.
    await this.options.preflight(input, { signal: context.signal, nestedToolCallId: context.nestedToolCallId, parentToolCallId: context.parentToolCallId }, action);
    if (input.cwd !== cwd) throw new Error(`A tool_call hook cannot change the working directory of sessions.${action}; block it or allow it unchanged`);
    if (input.command === command) return command;
    if (!rewritable || typeof input.command !== "string") throw new Error(`A tool_call hook cannot rewrite ${what}; block it or allow it unchanged`);
    return input.command;
  }

  async #open(args: Record<string, unknown>, context: FabricInvocationContext): Promise<unknown> {
    // Sessions run outside pi.bash: never let them bypass an extension's shell gate.
    if (this.options.shellOverride()) throw new Error("Interactive sessions are unavailable while an extension overrides bash; they would bypass its shell protection");
    if ((args.argv === undefined) === (args.cmd === undefined)) throw new Error("sessions.open needs exactly one of argv or cmd");
    const cwd = path.resolve(this.options.cwd, typeof args.cwd === "string" ? args.cwd : ".");
    if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Working directory does not exist: ${cwd}`);
    // A hook-based shell guard judges the command before the serve starts anything; `cmd` may be rewritten by it, argv may not.
    const bash = fs.existsSync("/bin/bash") ? "/bin/bash" : "bash";
    const argv = Array.isArray(args.argv)
      ? args.argv as string[]
      : [bash, "-c", await this.#preflight("open", args.cmd as string, cwd, "cmd", context, true)];
    if (Array.isArray(args.argv)) await this.#preflight("open", argv.map(shellQuote).join(" "), cwd, "argv", context);
    else if (argv[2] !== args.cmd) context.updateArguments?.({ ...args, cmd: argv[2] });
    // Text written later to a shell is itself a command; other children get their stdin as data.
    // `cmd` is shell source that can hand its stdin to any shell it starts (`echo ready; exec sh`), so it always counts.
    const shell = Array.isArray(args.argv) ? isShellArgv(argv) : true;
    const durable = args.durable === true;
    const serve = await this.#connect();
    const fields = { argv, cwd, ...pick(args, ["timeoutMs", "label"]) };
    const result = await serve.request<Record<string, unknown>>(durable ? "start" : "spawn", durable ? { ...fields, input: "pipe" } : fields, context.signal);
    const opened: Opened = {
      id: String(result.id), lifetime: durable ? "durable" : "session", shell,
      ...(typeof args.label === "string" ? { label: args.label } : {}),
      // A Jev program's session children end with the program; fabric_exec ones stay with Pi.
      ...(!durable && context.parentToolCallId.startsWith("jev:") ? { owner: context.parentToolCallId } : {}),
    };
    this.#opened.set(opened.id, opened);
    return { ...result, lifetime: opened.lifetime };
  }

  async invocationEnded(parentToolCallId: string): Promise<void> {
    if (!parentToolCallId.startsWith("jev:")) return;
    const owned = [...this.#opened.values()].filter(opened => opened.owner === parentToolCallId);
    if (!owned.length || !this.#serve) return;
    const serve = await this.#serve.catch(() => undefined);
    await Promise.allSettled(owned.map(async opened => {
      this.#opened.delete(opened.id);
      await serve?.request("stop", { job: opened.id });
    }));
  }

  async close(): Promise<void> {
    this.#closed = true;
    const serve = await this.#serve?.catch(() => undefined);
    this.#opened.clear();
    this.#partial.clear();
    // Ending the connection stops its session children; durable jobs stay in their store.
    await serve?.close();
  }
}

const pick = (args: Record<string, unknown>, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(keys.filter(key => args[key] !== undefined).map(key => [key, args[key]]));
