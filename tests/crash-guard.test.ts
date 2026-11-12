import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeFabricConfig } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { fabricControlAbort } from "../src/core/control-abort.js";
import {
  fabricOwnsFailure,
  installFabricCrashGuard,
  isFabricControlAbort,
  uninstallFabricCrashGuard,
} from "../src/core/crash-guard.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const cleanups: (() => void)[] = [];
afterEach(() => {
  uninstallFabricCrashGuard();
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

/** Hold the process's unhandled-rejection listeners aside, as in a Pi process with none. */
const withoutTestRunnerRejectionListeners = (): void => {
  const saved = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  cleanups.push(() => {
    process.removeAllListeners("unhandledRejection");
    for (const listener of saved) process.on("unhandledRejection", listener);
  });
};

describe("Fabric control aborts", () => {
  it("brands an abort and every Node error caused by it", async () => {
    const reason = fabricControlAbort("Fabric speculation ended with its invocation");
    expect(reason).toBeInstanceOf(Error);
    expect(reason.message).toBe("Fabric speculation ended with its invocation");
    expect(isFabricControlAbort(reason)).toBe(true);
    const controller = new AbortController();
    const waiting = delay(10_000, undefined, { signal: controller.signal });
    controller.abort(reason);
    const nodeAbort = await waiting.catch((error: unknown) => error);
    expect((nodeAbort as Error).name).toBe("AbortError");
    expect(isFabricControlAbort(nodeAbort)).toBe(true);
    expect(isFabricControlAbort(new Error("plain"))).toBe(false);
    expect(isFabricControlAbort(new DOMException("This operation was aborted", "AbortError"))).toBe(false);
  });

  it("owns failures raised from its package and nothing else", () => {
    const roots = new Set([root.replaceAll("\\", "/").replace(/\/+$/, "")]);
    const fromFabric = new Error("fabric bug");
    fromFabric.stack = `Error: fabric bug\n    at run (${root}dist/chunks/chunk-ABC.js:1:1)`;
    const foreign = new Error("host bug");
    foreign.stack = "Error: host bug\n    at run (/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/x.js:1:1)";
    expect(fabricOwnsFailure(fromFabric, roots)).toBe(true);
    expect(fabricOwnsFailure(foreign, roots)).toBe(false);
  });

  it("normalizes registered Windows package roots before comparing stack frames", () => {
    const packageRoot = String.raw`C:\workspace\pi-fabric`;
    installFabricCrashGuard(packageRoot);
    const failure = new Error("fabric bug");
    failure.stack = `Error: fabric bug\n    at run (${packageRoot}\\dist\\index.js:1:1)`;
    expect(fabricOwnsFailure(failure)).toBe(true);
    const foreign = new Error("host bug");
    foreign.stack = String.raw`Error: host bug at C:\workspace\host\dist\index.js:1:1`;
    expect(fabricOwnsFailure(foreign)).toBe(false);
  });
});

it("returns a program's missing-path failure as its result while abandoned work fails quietly", async () => {
  // Field crash: a program read a path that does not exist; the guest failure
  // aborted its other host calls, and a consumer nobody awaited rejected with
  // that abort reason. The rejection reached Pi's crash handler.
  withoutTestRunnerRejectionListeners();
  const logged: string[] = [];
  installFabricCrashGuard(root, (line) => logged.push(line));
  const crashes: unknown[] = [];
  const crash = (error: unknown) => { crashes.push(error); };
  process.on("uncaughtException", crash);
  cleanups.push(() => process.off("uncaughtException", crash));

  const cwd = mkdtempSync(join(tmpdir(), "fabric-crash-guard-"));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  const config = normalizeFabricConfig({ approvals: { read: "allow", write: "allow", network: "allow" } });
  const registry = new ActionRegistry();
  registry.register(new PiToolsProvider(cwd));
  const pending = { name: "pending", description: "Waits until the program ends", inputSchema: { type: "object" }, risk: "read" as const };
  registry.register({
    name: "probe", description: "Abandoned work",
    async list() { return [pending]; },
    async describe(name) { return name === pending.name ? pending : undefined; },
    async invoke(_name, _args, context) {
      const signal = context.signal!;
      // Observed: the action settles when its program stops.
      const observed = new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      // Not observed: a side wait nobody awaits, rejected with the same reason.
      void new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return observed;
    },
  });
  const service = new FabricExecutionService(registry, config);
  const context = {
    cwd, hasUI: false, tools: [],
    sessionManager: { getBranch: () => [], getSessionId: () => "crash-guard", getLeafId: () => "root", getSessionFile: () => undefined, getCwd: () => cwd },
  } as unknown as ExtensionContext;
  const missing = join(cwd, "inputs", "meta", "candidate.json");
  const result = await service.execute({
    code: `await Promise.all([probe.pending({}), pi.read({path: ${JSON.stringify(missing)}})]);`,
    context, signal: undefined, parentToolCallId: "missing-path", onPartial() {},
  });
  expect(result.success).toBe(false);
  expect(result.error).toContain("ENOENT");
  await vi.waitFor(() => expect(logged.some((line) => line.includes("ENOENT"))).toBe(true));
  expect(crashes).toEqual([]);
});

describe("crash guard process policy", () => {
  const guardUrl = pathToFileURL(join(root, "src/core/crash-guard.ts")).href;
  const abortUrl = pathToFileURL(join(root, "src/core/control-abort.ts")).href;
  // A Pi-like host: a prepended uncaught-exception handler that reports and exits.
  const host = (body: string) => [
    "--no-warnings",
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    `process.prependListener("uncaughtException", (error) => { console.log("host crash:" + error.message); process.exit(3); });
     const guard = await import(${JSON.stringify(guardUrl)});
     const { fabricControlAbort } = await import(${JSON.stringify(abortUrl)});
     guard.installFabricCrashGuard(${JSON.stringify(root)}, (line) => console.log("logged:" + line));
     ${body}
     setTimeout(() => { console.log("alive"); }, 200);`,
  ];
  const run = async (body: string) => {
    try {
      const { stdout } = await promisify(execFile)(process.execPath, host(body), { timeout: 20_000 });
      return { code: 0, stdout };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string };
      return { code: failed.code, stdout: failed.stdout ?? "" };
    }
  };

  it("logs a Fabric abort nobody awaited and keeps the process alive", async () => {
    const { code, stdout } = await run(`Promise.reject(fabricControlAbort("Fabric guest execution ended"));`);
    expect(code).toBe(0);
    expect(stdout).toContain("logged:detached work failed: Error: Fabric guest execution ended");
    expect(stdout).toContain("alive");
  });

  it("still hands any other unhandled rejection to the host's crash handler", async () => {
    const { code, stdout } = await run(`Promise.reject(new Error("host bug"));`);
    expect(code).toBe(3);
    expect(stdout).toContain("host crash:host bug");
    expect(stdout).not.toContain("alive");
  });
});
