import { spawn, type ChildProcess } from "node:child_process";
import { runAbortable, settleWithin } from "../async-settlement.js";
import { piBashExitMetadata } from "../core/pi-bash-error.js";
import { isPiShellRef } from "../core/pi-tools.js";
import { HumanWaitDeadlinePause } from "./deadline-pause.js";
import { guestSetupSource } from "./quickjs-runtime.js";
import type { FabricHostCall, FabricSandboxOptions, FabricSandboxResult } from "./kernel.js";
import { NODE_PROCESS_CHILD_SOURCE } from "./node-process-child-source.js";
import { createGuestStackMap, remapGuestErrorText } from "./guest-stack-map.js";
import { transpileFabricCodeWithSourceMap } from "./type-checker.js";
import {
  resolveScriptRuntime,
  resolveScriptRuntimeSync,
} from "../agents/transports/process-utils.js";

interface ChildCallMessage {
  type: "call";
  id: number;
  ref: string;
  args: Record<string, unknown>;
}

interface ChildResultMessage {
  type: "result";
  result: FabricSandboxResult;
}

type ChildMessage = ChildCallMessage | ChildResultMessage | { type: "output"; text?: string; image?: unknown };

const HOST_TASK_SETTLE_GRACE_MS = 250;

const send = (child: ChildProcess, message: any): void => {
  if (!child.connected) return;
  child.send(message, () => undefined);
};

export class NodeProcessRuntime {
  readonly #interpreter: "node" | "bun";

  constructor(interpreter: "node" | "bun" = "node") {
    this.#interpreter = interpreter;
  }

  async execute(
    code: string,
    hostCall: FabricHostCall,
    options: FabricSandboxOptions,
  ): Promise<FabricSandboxResult> {
    if (options.signal?.aborted) {
      return {
        value: undefined,
        logs: [],
        terminationReason: "aborted",
        error: "Execution cancelled",
      };
    }
    if (!Number.isSafeInteger(options.memoryLimitBytes) || options.memoryLimitBytes < 1) {
      return {
        value: undefined,
        logs: [],
        terminationReason: "runtime_error",
        error: "Process memory limit must be a positive safe integer",
      };
    }
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) {
      return {
        value: undefined,
        logs: [],
        terminationReason: "runtime_error",
        error: "Process timeout must be positive",
      };
    }

    // Bun evaluates --eval input as ESM and ignores V8 heap flags, so the
    // Bun child gets the guest source bare; Node needs the module + heap flags.
    // Bun resolution stays async: Pi may legitimately run under Node while bun
    // is only available on PATH, and the sync variant does no PATH lookup.
    const runtimeOptions = this.#interpreter === "bun" ? { requireBun: true } : { requireNode: true };
    const interpreterPath = this.#interpreter === "bun"
      ? await resolveScriptRuntime(runtimeOptions)
      : resolveScriptRuntimeSync(runtimeOptions);
    const child = spawn(
      interpreterPath,
      this.#interpreter === "bun"
        ? ["--eval", NODE_PROCESS_CHILD_SOURCE]
        : [
            // Guest import() through importModuleDynamically needs the vm
            // modules flag; Bun's vm ignores the option (see __fabricImport).
            "--experimental-vm-modules",
            `--max-old-space-size=${Math.max(16, Math.floor(options.memoryLimitBytes / (1024 * 1024)))}`,
            "--input-type=module",
            "--eval",
            NODE_PROCESS_CHILD_SOURCE,
          ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    // Bun resolution is async, so the signal may have aborted while resolving.
    if (options.signal?.aborted) {
      return {
        value: undefined,
        logs: [],
        terminationReason: "aborted",
        error: "Execution cancelled",
      };
    }
    const hostAbortController = new AbortController();
    const startedAt = Date.now();
    let effectiveTimeoutMs = options.timeoutMs;
    let deadlineAt = startedAt + effectiveTimeoutMs;
    let deadline: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    let settled = false;
    let finishing = false;
    const hostTasks = new Set<Promise<void>>();
    const partialLogs: string[] = [];
    const partialImages: unknown[] = [];
    let partialChars = 0;

    const guestBundle = options.transpiledCode === undefined
      ? transpileFabricCodeWithSourceMap(code)
      : { code: options.transpiledCode, sourceMap: options.transpiledSourceMap };
    const guestStackMap = createGuestStackMap(guestBundle.sourceMap);
    const guestLineCount = guestBundle.code.split("\n").length;

    return new Promise<FabricSandboxResult>((resolve) => {
      const finish = (result: FabricSandboxResult): void => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
        if (!hostAbortController.signal.aborted && hostTasks.size > 0) {
          hostAbortController.abort(new Error(result.error ?? "Process execution stopped"));
        }
        child.removeAllListeners();
        if (child.connected) child.disconnect();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve(result.terminationReason === "completed" ? result : { ...result, logs: result.logs.length ? result.logs : partialLogs, emitted: result.emitted?.length ? result.emitted : partialImages });
      };
      const scheduleDeadline = (): void => {
        clearTimeout(deadline);
        if (settled || finishing || !Number.isFinite(deadlineAt)) return;
        deadline = setTimeout(() => {
          const error = `Execution timed out after ${effectiveTimeoutMs}ms`;
          finish({ value: undefined, logs: [], terminationReason: "timed_out", error });
        }, Math.min(2_147_483_647, Math.max(0, deadlineAt - Date.now())));
        deadline.unref?.();
      };
      const extendDeadline = (ref: string, args: Record<string, unknown>): void => {
        const requested = options.minimumTimeoutMsForHostCall?.(ref, args);
        if (typeof requested !== "number" || !Number.isFinite(requested)) return;
        if (humanWait.paused) {
          humanWait.raise(requested);
          return;
        }
        const nextDeadlineAt = Date.now() + Math.max(1, Math.floor(requested));
        if (nextDeadlineAt <= deadlineAt) return;
        deadlineAt = nextDeadlineAt;
        effectiveTimeoutMs = deadlineAt - startedAt;
        scheduleDeadline();
      };

      const humanWait = new HumanWaitDeadlinePause({
        remainingMs: () => deadlineAt - Date.now(),
        suspend: () => {
          clearTimeout(deadline);
          deadlineAt = Infinity;
        },
        resume: (remainingMs) => {
          deadlineAt = Date.now() + remainingMs;
          scheduleDeadline();
        },
      });

      abortHandler = () => {
        finish({
          value: undefined,
          logs: [],
          terminationReason: "aborted",
          error: "Execution cancelled",
        });
      };
      options.signal?.addEventListener("abort", abortHandler, { once: true });

      child.on("message", (raw: unknown) => {
        if (settled || finishing || typeof raw !== "object" || raw === null) return;
        const message = raw as ChildMessage;
        if (message.type === "output") {
          const chars = typeof message.text === "string" ? message.text.length : JSON.stringify(message.image ?? null).length;
          partialChars += chars;
          if (partialChars <= 16_777_216) {
            if (typeof message.text === "string") partialLogs.push(message.text);
            else if (message.image !== undefined) partialImages.push(message.image);
          }
          return;
        }
        if (message.type === "result") {
          finishing = true;
          if (deadline) clearTimeout(deadline);
          if (hostTasks.size > 0 && !hostAbortController.signal.aborted) {
            hostAbortController.abort(new Error(message.result.error ?? "Process execution stopped"));
          }
          void (async () => {
            const completed = await settleWithin(hostTasks, HOST_TASK_SETTLE_GRACE_MS);
            if (!completed && !hostAbortController.signal.aborted) {
              hostAbortController.abort(
                new Error("Fabric guest execution ended before its host calls settled"),
              );
              await settleWithin(hostTasks, HOST_TASK_SETTLE_GRACE_MS);
            }
            finish(
              message.result.error === undefined
                ? message.result
                : {
                    ...message.result,
                    error: remapGuestErrorText(message.result.error, guestStackMap, guestLineCount),
                  },
            );
          })();
          return;
        }
        if (message.type !== "call") return;
        extendDeadline(message.ref, message.args);
        if (message.ref === "fabric.$timer") {
          const ms = Math.max(0, Number(message.args?.ms ?? 0));
          let timer: NodeJS.Timeout | undefined;
          const timerTask = new Promise<void>((resolveTask) => {
            timer = setTimeout(() => {
              if (!settled && !finishing) {
                send(child, { type: "response", id: message.id, ok: true, value: undefined });
              }
              resolveTask();
            }, ms);
            timer!.unref?.();
          });
          hostTasks.add(timerTask);
          void timerTask.finally(() => {
            hostTasks.delete(timerTask);
            if (timer) clearTimeout(timer);
          });
          return;
        }
        const waitsForHuman = options.isHumanWaitHostCall?.(message.ref, message.args) === true;
        if (waitsForHuman) humanWait.enter();
        const task = runAbortable(hostAbortController.signal, () =>
          hostCall(message.ref, message.args, hostAbortController.signal, (wait) => humanWait.run(wait)),
        ).finally(() => {
          if (waitsForHuman) humanWait.leave();
        }).then(
          (value) => send(child, { type: "response", id: message.id, ok: true, value }),
          (error) =>
            send(child, {
              type: "response",
              id: message.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              bashExit: isPiShellRef(message.ref) ? piBashExitMetadata(error) : undefined,
            }),
        );
        hostTasks.add(task);
        void task.finally(() => hostTasks.delete(task));
      });
      child.once("error", (error) => {
        finish({
          value: undefined,
          logs: [],
          terminationReason: "runtime_error",
          error: `Process executor failed: ${error.message}`,
        });
      });
      child.once("exit", (exitCode, signal) => {
        if (settled) return;
        const detail = signal ? `signal ${signal}` : `exit code ${exitCode ?? "unknown"}`;
        finish({
          value: undefined,
          logs: [],
          terminationReason: "runtime_error",
          error: `Process executor exited before returning a result (${detail}); it may have exceeded its memory limit`,
        });
      });

      scheduleDeadline();
      send(child, {
        type: "execute",
        setup: guestSetupSource(options.piToolCanonicalFields, options.nativeStoreEnabled, options.codemodeProfile, options.nativeToolsEnabled),
        code: guestBundle.code,
        strings: options.strings ?? {},
        tokenBudget: options.tokenBudget,
        maxLogChars: options.maxLogChars ?? 100_000,
      });
    });
  }
}

export class BunProcessRuntime extends NodeProcessRuntime {
  constructor() {
    super("bun");
  }
}
