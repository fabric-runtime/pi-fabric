import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { runAbortable, settleWithin } from "../async-settlement.js";
import { piBashExitMetadata } from "../core/pi-bash-error.js";
import { isPiShellRef } from "../core/pi-tools.js";
import type { FabricHostCall, FabricKernelRuntime, FabricSandboxOptions, FabricSandboxResult } from "./kernel.js";
import { CPYTHON_CHILD_SOURCE } from "./cpython-child-source.js";
import { HumanWaitDeadlinePause } from "./deadline-pause.js";
import { linuxCPythonNetworkFilter } from "./cpython-linux-sandbox.js";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const HOST_SETTLE_MS = 250;
// No blanket mach* allowance: Mach services can broker effects outside the
// file/network policy. CPython's standard-library startup needs none here.
const MACOS_PROFILE = "(version 1) (deny default) (allow process-exec) (allow process-fork) (allow file-read*) (allow sysctl-read)";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

const executable = async (binary: string, cwd: string): Promise<string> => {
  // Windows stores executables with PATHEXT suffixes ("python3" -> "python3.exe");
  // probe the variants spawn would find instead of failing on the bare name.
  const extensions = process.platform === "win32"
    ? String(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [];
  const variants = (candidate: string): string[] =>
    extensions.length && !/\.[A-Za-z0-9]+$/.test(candidate)
      ? [candidate, ...extensions.map((extension) => candidate + extension)]
      : [candidate];
  const candidates = path.isAbsolute(binary) || binary.includes("/") || binary.includes("\\")
    ? [path.resolve(cwd, binary)]
    : (process.env.PATH ?? "").split(path.delimiter).map((directory) => path.resolve(cwd, directory || ".", binary));
  for (const candidate of candidates) {
    for (const variant of variants(candidate)) {
      try {
        await access(variant, constants.X_OK);
        return await realpath(variant);
      } catch {
        // Continue only during executable discovery, never after a failed spawn.
      }
    }
  }
  throw new Error(`CPython executable not found: ${binary}. Install Python 3 or set executor.cpython.binary to a trusted executable's absolute path.`);
};

// The isolation flags are exported so the sandbox tests can probe whether this
// kernel can actually start the same sandbox, instead of treating an installed
// bwrap as a usable one. The seccomp filter rides in on fd 4, so a probe can
// leave the seccomp arguments off.
export const LINUX_BWRAP_ISOLATION_ARGS = ["--ro-bind", "/", "/", "--unshare-all", "--die-with-parent", "--new-session", "--proc", "/proc", "--dev", "/dev"] as const;
export const LINUX_BWRAP_SECCOMP_ARGS = ["--seccomp", "4"] as const;

const launch = async (binary: string, enforce: boolean, cwd: string): Promise<{ command: string; args: string[]; seccomp?: Buffer }> => {
  const python = await executable(binary, cwd);
  const args = ["-I", "-B", "-u", "-c", CPYTHON_CHILD_SOURCE];
  if (!enforce) return { command: python, args };
  if (process.platform === "darwin") {
    try { await access("/usr/bin/sandbox-exec", constants.X_OK); }
    catch { throw new Error("Schema enforce CPython requires /usr/bin/sandbox-exec on macOS; no unsandboxed fallback is permitted."); }
    return { command: "/usr/bin/sandbox-exec", args: ["-p", MACOS_PROFILE, python, ...args] };
  }
  if (process.platform === "linux") {
    // Only system locations: a workspace/PATH shim must not masquerade as the
    // security boundary. The selected interpreter itself is trusted config.
    let bwrap: string | undefined;
    for (const candidate of ["/usr/bin/bwrap", "/bin/bwrap"]) {
      try { await access(candidate, constants.X_OK); bwrap = candidate; break; } catch { /* Try the other system path. */ }
    }
    if (!bwrap) throw new Error("Schema enforce CPython requires bubblewrap (/usr/bin/bwrap). Install bubblewrap and enable unprivileged user namespaces; no unsandboxed fallback is permitted.");
    return {
      command: bwrap,
      args: [...LINUX_BWRAP_ISOLATION_ARGS, ...LINUX_BWRAP_SECCOMP_ARGS, "--chdir", cwd, "--", python, ...args],
      seccomp: linuxCPythonNetworkFilter(process.arch),
    };
  }
  throw new Error(`Schema enforce CPython has no supported OS sandbox on ${process.platform}; no unsandboxed fallback is permitted.`);
};

// Windows stdio[3] is an anonymous pipe, not a socket, so the child dials a
// loopback listener instead; a one-time token proves the caller is our child.
const createIpcListener = (): Promise<{ server: net.Server; port: number; token: string }> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    const token = randomBytes(32).toString("hex");
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("Fabric CPython IPC listener failed to bind"));
      else resolve({ server, port: address.port, token });
    });
  });

/** A fresh CPython process per call. Only enforce=true adds an OS security boundary. */
export class CPythonRuntime implements FabricKernelRuntime {
  constructor(readonly binary = "python3", readonly enforce = false) {}

  async execute(code: string, hostCall: FabricHostCall, options: FabricSandboxOptions): Promise<FabricSandboxResult> {
    const failure = (terminationReason: FabricSandboxResult["terminationReason"], error: string): FabricSandboxResult =>
      ({ value: undefined, logs: [], terminationReason, error });
    if (options.signal?.aborted) return failure("aborted", "Execution cancelled");
    if (!Number.isSafeInteger(options.memoryLimitBytes) || options.memoryLimitBytes < 1) {
      return failure("runtime_error", "CPython memory limit must be a positive safe integer");
    }
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) return failure("runtime_error", "CPython timeout must be positive");
    const startedAt = Date.now();
    let command: Awaited<ReturnType<typeof launch>>;
    try { command = await launch(this.binary, this.enforce, options.cwd ?? process.cwd()); }
    catch (error) { return failure("runtime_error", errorText(error)); }
    // Resolve first, then check before spawn: no orphan on cancellation during discovery.
    if (options.signal?.aborted) return failure("aborted", "Execution cancelled");
    // Windows cannot inherit a socket through stdio; the child connects back instead.
    const ipc = process.platform === "win32" ? await createIpcListener() : undefined;

    return new Promise<FabricSandboxResult>((resolve) => {
      const hostAbort = new AbortController();
      const hostTasks = new Set<Promise<void>>();
      const callIds = new Set<number>();
      const logs: string[] = [];
      const partialLogs = ["", ""];
      const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
      const maxLogChars = Math.max(0, options.maxLogChars ?? 100_000);
      let logChars = 0;
      let truncated = false;
      let settled = false;
      let finishing = false;
      let deadline: NodeJS.Timeout | undefined;
      let deadlineAt = startedAt + options.timeoutMs;
      let buffer = Buffer.alloc(0);
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command.command, command.args, {
          cwd: options.cwd ?? process.cwd(),
          // -I ignores PYTHON* and user site packages; -B avoids bytecode writes.
          // Keep ordinary environment for trusted native code, not a false secrecy claim.
          env: ipc ? { ...process.env, FABRIC_IPC_PORT: String(ipc.port), FABRIC_IPC_TOKEN: ipc.token } : process.env,
          detached: process.platform !== "win32",
          stdio: command.seccomp ? ["ignore", "pipe", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe", "pipe"],
        });
      } catch (error) {
        ipc?.server.close();
        resolve(failure("runtime_error", `CPython process failed: ${errorText(error)}`));
        return;
      }
      let channel: Duplex | net.Socket | undefined;
      let expectedToken: string | undefined = ipc?.token;
      let childExited = child.pid === undefined;
      child.once("exit", () => { childExited = true; });
      const appendLog = (index: number, text: string): void => {
        if (settled || truncated) return;
        const available = Math.max(0, maxLogChars - logChars);
        const retained = text.slice(0, available);
        logChars += retained.length;
        const lines = ((partialLogs[index] ?? "") + retained).split("\n");
        partialLogs[index] = lines.pop() ?? "";
        for (const line of lines) logs.push(line.replace(/\r$/, ""));
        if (retained.length !== text.length) truncated = true;
      };
      const finish = async (result: Omit<FabricSandboxResult, "logs">): Promise<void> => {
        if (settled) return;
        for (let index = 0; index < decoders.length; index++) appendLog(index, decoders[index]!.end());
        settled = true;
        if (deadline) clearTimeout(deadline);
        options.signal?.removeEventListener("abort", abort);
        if (!hostAbort.signal.aborted) hostAbort.abort(new Error(result.error ?? "CPython execution ended"));
        channel?.destroy();
        ipc?.server.close();
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (child.pid && process.platform !== "win32") {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* The process group may already have exited. */ }
        }
        child.kill("SIGKILL");
        // Let the terminated child release its working directory before the
        // caller observes the result; Windows rmdir fails with EBUSY while held.
        if (!childExited) {
          await new Promise<void>((done) => {
            const timer = setTimeout(done, 250);
            timer.unref?.();
            child.once("exit", () => { clearTimeout(timer); done(); });
          });
        }
        for (const text of partialLogs) if (text) logs.push(text);
        if (truncated) logs.push("[Pi Fabric log output truncated]");
        resolve({ ...result, logs });
      };
      const abort = (): void => void finish({ value: undefined, terminationReason: "aborted", error: "Execution cancelled" });
      const fail = (message: string): void => void finish({ value: undefined, terminationReason: "runtime_error", error: message });
      const scheduleDeadline = (): void => {
        if (deadline) clearTimeout(deadline);
        if (settled || !Number.isFinite(deadlineAt)) return;
        deadline = setTimeout(() => void finish({
          value: undefined, terminationReason: "timed_out", error: `Execution timed out after ${deadlineAt - startedAt}ms`,
        }), Math.max(0, deadlineAt - Date.now()));
        deadline.unref?.();
      };
      const humanWait = new HumanWaitDeadlinePause({
        remainingMs: () => deadlineAt - Date.now(),
        suspend: () => {
          if (deadline) clearTimeout(deadline);
          deadlineAt = Infinity;
        },
        resume: (remainingMs) => {
          deadlineAt = Date.now() + remainingMs;
          scheduleDeadline();
        },
      });
      const send = (message: unknown): void => {
        // A terminal guest result closes its reply channel while issued host
        // work may still be settling. Its late replies are no longer consumed.
        if (settled || finishing || !channel || channel.destroyed) return;
        try {
          const frame = JSON.stringify(message) + "\n";
          const bytes = Buffer.byteLength(frame);
          if (bytes > MAX_FRAME_BYTES || channel.writableLength + bytes > MAX_FRAME_BYTES * 2) {
            fail("CPython IPC frame or write buffer exceeds its 16 MiB frame limit");
            return;
          }
          channel.write(frame, (error) => { if (error && !settled && !finishing) fail(`CPython IPC failed: ${error.message}`); });
        } catch (error) { fail(`CPython IPC serialization failed: ${errorText(error)}`); }
      };
      const handleMessage = (message: unknown): void => {
        if (settled || finishing) return;
        if (!record(message)) { fail("Invalid CPython IPC message"); return; }
        if (message.type === "result") {
          const result = message.result;
          if (!record(result) || !["completed", "runtime_error"].includes(String(result.terminationReason)) ||
              (result.error !== undefined && typeof result.error !== "string")) {
            fail("Invalid CPython terminal result"); return;
          }
          finishing = true;
          if (result.terminationReason !== "completed") hostAbort.abort(new Error(String(result.error ?? "Python guest failed")));
          void (async () => {
            const done = await settleWithin(hostTasks, HOST_SETTLE_MS);
            if (!done) {
              hostAbort.abort(new Error("Fabric guest execution ended before its host calls settled"));
              await settleWithin(hostTasks, HOST_SETTLE_MS);
            }
            // stdout/stderr are separate channels; allow their ready data to drain.
            await new Promise<void>((done) => setImmediate(done));
            finish({
              value: result.value,
              terminationReason: result.terminationReason as "completed" | "runtime_error",
              ...(typeof result.error === "string" ? { error: result.error } : {}),
            });
          })();
          return;
        }
        if (message.type !== "call" || !Number.isSafeInteger(message.id) || (message.id as number) < 1 ||
            typeof message.ref !== "string" || !message.ref || message.ref.length > 512 || !record(message.args) ||
            callIds.has(message.id as number) || hostTasks.size >= 256) {
          fail("Invalid or excessive CPython host call"); return;
        }
        const id = message.id as number;
        const ref = message.ref;
        const args = message.args;
        callIds.add(id);
        let waitsForHuman = false;
        try {
          const floor = options.minimumTimeoutMsForHostCall?.(ref, args);
          if (typeof floor === "number" && Number.isFinite(floor)) {
            if (humanWait.paused) humanWait.raise(floor);
            else if (Date.now() + floor > deadlineAt) {
              deadlineAt = Date.now() + Math.max(1, Math.floor(floor));
              scheduleDeadline();
            }
          }
          waitsForHuman = options.isHumanWaitHostCall?.(ref, args) === true;
        } catch (error) { fail(`CPython deadline policy failed: ${errorText(error)}`); return; }
        if (waitsForHuman) humanWait.enter();
        const task = runAbortable(hostAbort.signal, () => hostCall(ref, args, hostAbort.signal, (wait) => humanWait.run(wait))).finally(() => {
          if (waitsForHuman) humanWait.leave();
        }).then(
          (value) => send({ type: "response", id, ok: true, value }),
          (error) => send({ type: "response", id, ok: false, error: errorText(error), ...(isPiShellRef(ref) ? { bashExit: piBashExitMetadata(error) } : {}) }),
        ).finally(() => { hostTasks.delete(task); callIds.delete(id); });
        hostTasks.add(task);
      };
      const onData = (chunk: Buffer): void => {
        if (settled || finishing) return;
        buffer = Buffer.concat([buffer, chunk]);
        if (expectedToken !== undefined) {
          const handshake = buffer.indexOf(10);
          if (handshake === -1) {
            if (buffer.length > 4096) fail("Invalid CPython IPC handshake");
            return;
          }
          let verified = false;
          try {
            const hello = JSON.parse(buffer.subarray(0, handshake).toString("utf8"));
            verified = record(hello) && hello.type === "hello" && hello.token === expectedToken;
          } catch { /* Fail closed below. */ }
          if (!verified) { fail("Invalid CPython IPC handshake"); return; }
          buffer = buffer.subarray(handshake + 1);
          expectedToken = undefined;
          send({ type: "execute", code, strings: options.strings ?? {}, memoryLimitBytes: options.memoryLimitBytes });
          if (settled || finishing) return;
        }
        let newline: number;
        while ((newline = buffer.indexOf(10)) !== -1) {
          if (newline > MAX_FRAME_BYTES) { fail("CPython IPC frame exceeds 16 MiB"); return; }
          const frame = buffer.subarray(0, newline).toString("utf8");
          buffer = buffer.subarray(newline + 1);
          try { handleMessage(JSON.parse(frame)); }
          catch (error) { fail(`Invalid CPython IPC: ${errorText(error)}`); return; }
          if (settled || finishing) return;
        }
        if (buffer.length > MAX_FRAME_BYTES) fail("CPython IPC frame exceeds 16 MiB");
      };
      const attach = (socket: Duplex | net.Socket): void => {
        channel = socket;
        if (socket instanceof net.Socket) socket.setNoDelay(true);
        socket.on("data", onData);
        socket.on("error", (error) => { if (!settled && !finishing) fail(`CPython IPC failed: ${error.message}`); });
      };
      child.stdout?.on("data", (chunk: Buffer) => appendLog(0, decoders[0]!.write(chunk)));
      child.stderr?.on("data", (chunk: Buffer) => appendLog(1, decoders[1]!.write(chunk)));
      child.on("error", (error) => fail(`CPython process failed: ${error.message}${this.enforce ? "; OS sandbox is required (no native fallback)" : ""}`));
      child.on("close", (exitCode, signal) => {
        if (settled || finishing) return;
        const diagnostics = [...logs, ...partialLogs].join("\n").slice(-4000);
        fail(`CPython ${this.enforce ? "sandbox " : ""}process exited before returning a result (${signal ?? exitCode}).${this.enforce ? " Verify OS sandbox availability/user namespaces; no unsandboxed fallback is permitted." : ""}${diagnostics ? `\n${diagnostics}` : ""}`);
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      if (command.seccomp) {
        const filterPipe = child.stdio[4] as Duplex;
        filterPipe.on("error", (error) => { if (!settled) fail(`CPython sandbox filter failed: ${error.message}`); });
        filterPipe.end(command.seccomp);
      }
      scheduleDeadline();
      if (ipc) {
        // Windows: the child dials the loopback listener and proves the token first.
        ipc.server.on("connection", (socket) => {
          if (channel) { socket.destroy(); return; }
          ipc.server.close();
          attach(socket);
        });
      } else {
        attach(child.stdio[3] as Duplex);
        send({ type: "execute", code, strings: options.strings ?? {}, memoryLimitBytes: options.memoryLimitBytes });
      }
    });
  }
}
