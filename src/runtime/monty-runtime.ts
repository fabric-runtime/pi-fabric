import { createRequire } from "node:module";
import type * as MontyNative from "@pydantic/monty/node";
import { runAbortable, settleWithin } from "../async-settlement.js";
import { MAX_EXECUTOR_TIMEOUT_MS } from "../config.js";
import { piBashExitMetadata } from "../core/pi-bash-error.js";
import { isPiShellRef } from "../core/pi-tools.js";
import type { FabricHostCall, FabricKernelRuntime, FabricSandboxOptions, FabricSandboxResult } from "./kernel.js";
import { HumanWaitDeadlinePause } from "./deadline-pause.js";
import { montyBindings } from "./monty-bridge.js";
import { MONTY_BOOTSTRAP_SOURCE, montyErrorText, prepareMontySource } from "./monty-source.js";
import { montyInput, normalizeMontyValue } from "./monty-values.js";

const require = createRequire(import.meta.url);

async function loadNative(): Promise<{ native: typeof MontyNative; binaryPath: string }> {
  try {
    // Never select the browser/WASM condition, MONTY_BIN, PATH, or an embedded-CPython worker.
    const native = await import("@pydantic/monty/node");
    const triple = process.platform === "darwin" && ["arm64", "x64"].includes(process.arch) ? `darwin-${process.arch}`
      : process.platform === "linux" && ["arm64", "x64"].includes(process.arch) ? `linux-${process.arch}-gnu`
      : process.platform === "win32" && process.arch === "x64" ? "win32-x64-msvc" : undefined;
    if (!triple) throw new Error(`No Monty native package for ${process.platform}/${process.arch}`);
    const nativeRequire = createRequire(require.resolve("@pydantic/monty/node"));
    const binaryPath = nativeRequire.resolve(`@pydantic/monty-${triple}/${process.platform === "win32" ? "monty.exe" : "monty"}`);
    return { native, binaryPath };
  } catch (error) {
    throw new Error("Monty optional native package is unavailable or incompatible. Install @pydantic/monty@0.0.23 with its platform optional dependencies (bun add --optional --exact @pydantic/monty@0.0.23), or select executor.pythonRuntime='cpython'. " + montyErrorText(error));
  }
}

/** Opt-in Python subset, in fresh native Monty subprocesses; not CPython or WASM. */
export class MontyRuntime implements FabricKernelRuntime {
  async execute(code: string, hostCall: FabricHostCall, options: FabricSandboxOptions): Promise<FabricSandboxResult> {
    const failure = (terminationReason: FabricSandboxResult["terminationReason"], error: string): FabricSandboxResult =>
      ({ value: undefined, logs: [], terminationReason, error });
    if (options.signal?.aborted) return failure("aborted", "Execution cancelled");
    if (!Number.isSafeInteger(options.memoryLimitBytes) || options.memoryLimitBytes < 1) return failure("runtime_error", "Monty memory limit must be a positive safe integer");
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) return failure("runtime_error", "Monty timeout must be positive");
    if (options.maxLogChars !== undefined && (!Number.isSafeInteger(options.maxLogChars) || options.maxLogChars < 0)) return failure("runtime_error", "Monty log limit must be a nonnegative safe integer");
    let prepared: ReturnType<typeof prepareMontySource>;
    let strings: Record<string, string>;
    try {
      strings = normalizeMontyValue(options.strings ?? {}, true) as Record<string, string>;
      if (Object.values(strings).some((value) => typeof value !== "string")) throw new TypeError("Monty payloads must be strings");
      prepared = prepareMontySource(code, strings);
    } catch (error) { return failure("runtime_error", montyErrorText(error)); }

    const startedAt = Date.now();
    let deadlineAt = startedAt + options.timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    let pool: MontyNative.Monty | undefined;
    let session: MontyNative.MontySession | undefined;
    let workerPid: number | undefined;
    let feed: Promise<unknown> | undefined;
    let stopped: "aborted" | "timed_out" | undefined;
    const hostAbort = new AbortController();
    const tasks = new Set<Promise<unknown>>();
    const logs: string[] = [];
    const partial = { stdout: "", stderr: "" };
    let logChars = 0;
    let truncated = false;
    const maxLogChars = options.maxLogChars ?? 100_000;
    const printCallback = (stream: "stdout" | "stderr", text: string): void => {
      if (truncated || stopped) return;
      const retained = text.slice(0, Math.max(0, maxLogChars - logChars));
      logChars += retained.length;
      const lines = (partial[stream] + retained).split("\n");
      partial[stream] = lines.pop() ?? "";
      for (const line of lines) logs.push(line.replace(/\r$/, ""));
      if (retained.length !== text.length) truncated = true;
    };
    const kill = (): void => {
      if (workerPid !== undefined) {
        try { process.kill(workerPid, "SIGKILL"); }
        catch (error) {
          // Never throw out of an abort listener or watchdog timer. Cleanup retries
          // the native close path; missing PIDs mean the worker already exited.
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
        }
        workerPid = undefined;
      }
    };
    const stop = (reason: "aborted" | "timed_out"): void => {
      if (stopped) return;
      stopped = reason;
      hostAbort.abort(new Error(reason === "aborted" ? "Execution cancelled" : "Execution timed out"));
      kill();
    };
    const abort = (): void => stop("aborted");
    const scheduleDeadline = (): void => {
      if (timer) clearTimeout(timer);
      if (stopped || !Number.isFinite(deadlineAt)) return;
      timer = setTimeout(() => {
        if (Date.now() < deadlineAt) scheduleDeadline();
        else stop("timed_out");
      }, Math.min(2_147_483_647, Math.max(0, deadlineAt - Date.now())));
    };
    scheduleDeadline();
    const humanWait = new HumanWaitDeadlinePause({
      remainingMs: () => deadlineAt - Date.now(),
      suspend: () => {
        if (timer) clearTimeout(timer);
        deadlineAt = Infinity;
      },
      resume: (remainingMs) => {
        deadlineAt = Date.now() + remainingMs;
        scheduleDeadline();
      },
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let result: FabricSandboxResult;
    try {
      const { native, binaryPath } = await runAbortable(hostAbort.signal, loadNative);
      pool = await runAbortable(hostAbort.signal, async () => {
        const created = await native.Monty.create({
          binaryPath, minProcesses: 0, maxProcesses: 1, maxCheckoutsPerWorker: 1,
          // A fixed VM/per-turn limit would defeat a longer host-call floor. In that
          // mode the reschedulable host watchdog hard-kills the captured native PID.
          ...(options.minimumTimeoutMsForHostCall ? {
            durationLimitGrace: null, requestTimeout: MAX_EXECUTOR_TIMEOUT_MS / 1000 + 1,
          } : {
            requestTimeout: options.timeoutMs / 1000 + 1, durationLimitGrace: 1,
          }),
        });
        if (hostAbort.signal.aborted) { await created.close(); throw hostAbort.signal.reason; }
        return created;
      });
      const ownedPool = pool;
      session = await runAbortable(hostAbort.signal, async () => {
        const checkedOut = await ownedPool.checkout({
          scriptName: "fabric-exec.py", printFlushInterval: 0,
          limits: { maxMemory: options.memoryLimitBytes, maxRecursionDepth: 500, maxSuspensions: 10_000,
            ...(!options.minimumTimeoutMsForHostCall ? { maxDurationSecs: options.timeoutMs / 1000 } : {}),
          },
        });
        if (hostAbort.signal.aborted) { await checkedOut.close(); throw hostAbort.signal.reason; }
        return checkedOut;
      });
      workerPid = session.workerPid;
      if (!Number.isSafeInteger(workerPid) || workerPid! <= 0) throw new Error("Monty native worker PID unavailable; refusing execution without hard cancellation");
      const dispatch = async (ref: string, original: Record<string, unknown>): Promise<unknown> => {
        if (hostAbort.signal.aborted) throw hostAbort.signal.reason;
        if (tasks.size >= 256) throw new Error("Too many concurrent Monty host calls");
        const args = { ...original };
        if (isPiShellRef(ref) && Object.hasOwn(args, "settle") && typeof args.settle !== "boolean") {
          throw new TypeError("pi shell settle must be a boolean; use settle=True or settle=False");
        }
        if (isPiShellRef(ref) && Object.hasOwn(args, "background") && typeof args.background !== "boolean") {
          throw new TypeError("pi shell background must be a boolean; use background=True or background=False");
        }
        const settle = isPiShellRef(ref) && args.settle === true;
        if (isPiShellRef(ref)) delete args.settle;
        const floor = options.minimumTimeoutMsForHostCall?.(ref, args);
        if (typeof floor === "number" && Number.isFinite(floor)) {
          if (humanWait.paused) humanWait.raise(floor);
          else if (Date.now() + floor > deadlineAt) {
            deadlineAt = Date.now() + Math.max(1, Math.floor(floor));
            scheduleDeadline();
          }
        }
        const waitsForHuman = options.isHumanWaitHostCall?.(ref, args) === true;
        if (waitsForHuman) humanWait.enter();
        const task = runAbortable(hostAbort.signal, () => hostCall(ref, args, hostAbort.signal, (wait) => humanWait.run(wait)));
        tasks.add(task);
        try { return montyInput(normalizeMontyValue(await task, true)); }
        catch (error) {
          const exit = settle ? piBashExitMetadata(error) : undefined;
          if (exit) return montyInput({ ok: false, ...exit, details: null, error: montyErrorText(error) });
          throw error;
        } finally {
          tasks.delete(task);
          if (waitsForHuman) humanWait.leave();
        }
      };
      class PayloadValues {}
      const attributes = new PayloadValues();
      for (const [key, value] of Object.entries(strings)) Object.defineProperty(attributes, key, { value, enumerable: true });
      const bindings = montyBindings(native, dispatch);
      bindings.payloads = montyInput(strings);
      bindings.π = new native.ClassInstance(attributes, { name: "FabricPayloads", eagerAttrs: Object.keys(strings) });
      // Bootstrap separately so user traceback offsets remain exactly one wrapper line.
      feed = session.feedRun(MONTY_BOOTSTRAP_SOURCE, { inputs: bindings, printCallback });
      await runAbortable(hostAbort.signal, () => feed!);
      feed = session.feedRun(prepared.source, { printCallback });
      const value = normalizeMontyValue(await runAbortable(hostAbort.signal, () => feed!));
      result = { value, logs, terminationReason: "completed" };
    } catch (error) {
      const nativeError = error as { timedOut?: boolean; exception?: { typeName: string; message: string } } | null;
      const vmTimeout = nativeError?.exception?.typeName === "TimeoutError" && nativeError.exception.message.startsWith("time limit exceeded:");
      const reason = stopped ?? (nativeError?.timedOut || vmTimeout ? "timed_out" : "runtime_error");
      result = { value: undefined, logs, terminationReason: reason,
        error: reason === "aborted" ? "Execution cancelled" : reason === "timed_out" ? `Execution timed out after ${deadlineAt - startedAt}ms` : montyErrorText(error, prepared) };
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      hostAbort.abort(new Error("Monty execution ended"));
      // Initiate pool closure first to prevent worker replacement. Native cleanup
      // is best effort and bounded: its failures must not replace the guest result.
      let cleanupFailed = false;
      const closing = [pool, session].filter((resource) => resource !== undefined).map(async (resource) => {
        try { await resource.close(); } catch { cleanupFailed = true; }
      });
      if (stopped) kill();
      const closed = await settleWithin(closing, 250);
      if (!closed || cleanupFailed) {
        kill();
        await settleWithin(closing, 250);
      }
      workerPid = undefined;
      await settleWithin([...tasks, ...(feed ? [feed] : [])], 250);
    }
    for (const text of Object.values(partial)) if (text) logs.push(text);
    if (truncated) logs.push("[Pi Fabric log output truncated]");
    return result;
  }
}
