import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { AgentManager } from "../src/agents/manager.js";
import type { AgentChildQuestionRequest } from "../src/agents/types.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";

// Windows has no graceful stop to test: Node delivers agents.stop's SIGTERM to
// the worker as TerminateProcess, so the worker never closes Pi's stdin and no
// session_shutdown hook runs. This suite covers the POSIX signal path only.
const posix = process.platform !== "win32";
const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-shutdown-build-"));
const workerPath = path.join(buildRoot, "build", "worker.js");
beforeAll(async () => {
  if (!posix) return;
  fs.symlinkSync(path.resolve("node_modules"), path.join(buildRoot, "node_modules"), "junction");
  fs.writeFileSync(path.join(buildRoot, "package.json"), '{"type":"module"}');
  await build({
    entryPoints: ["src/worker.ts", "src/durable/worker.ts", "src/agents/write-guard.ts", "src/agents/provider-bridge.ts",
      "src/agents/compact-control.ts", "src/agents/claude-cli.ts", "src/agents/veda-cli.ts",
      ...fs.readdirSync("src/worker").filter(name => name.endsWith(".ts")).map(name => `src/worker/${name}`)],
    outdir: path.join(buildRoot, "build"), outbase: "src", bundle: true, packages: "external",
    platform: "node", format: "esm", splitting: true, target: "node24", logLevel: "silent",
  });
}, 30_000);
afterAll(() => fs.rmSync(buildRoot, { recursive: true, force: true }));
const managers: AgentManager[] = [];
const roots: string[] = [];
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()));
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    const helper = path.join(root, "helper-pid");
    if (fs.existsSync(helper)) try { process.kill(Number(fs.readFileSync(helper, "utf8")), "SIGKILL"); } catch { /* already gone */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const setup = (runner: "pi" | "pi-durable") => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-shutdown-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    extensions: [path.resolve("tests/fixtures/pi-shutdown-extension.ts")],
    compaction: { enabled: false }, retry: { enabled: false },
  }));
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("FABRIC_SHUTDOWN_ROOT", root);
  // Route the child's dialog to the parent and never answer it, so the
  // question is provably still open when the stop begins.
  const questions: AgentChildQuestionRequest[] = [];
  const manager = new AgentManager(root, {
    ...DEFAULT_FABRIC_CONFIG.agents, runner, extensions: true,
    durableWorkerRecovery: runner === "pi-durable", timeoutMs: 30_000, maxConcurrent: 1,
    childQuestions: "route", childQuestionTimeoutMs: 30_000,
  }, {
    workerPath,
    piBinary: path.resolve("tests/fixtures/pi-rpc-shutdown.mjs"),
    runRoot: path.join(root, "runs"), fullCodeMode: false,
    onChildQuestion: request => {
      questions.push(request);
      return new Promise(resolve => request.signal.addEventListener("abort", () => resolve({ cancelled: true })));
    },
  });
  managers.push(manager);
  return { root, manager, questions };
};
const spawnWithOpenQuestion = async (runner: "pi" | "pi-durable", before?: (root: string) => void) => {
  const context = setup(runner);
  before?.(context.root);
  const handle = await context.manager.spawn({ task: "wait", model: "shutdown/probe", transport: "process", residency: "durable" });
  await vi.waitFor(() => {
    const status = context.manager.status(handle.id);
    expect(status.status, JSON.stringify(status)).toBe("running");
    expect(context.questions.map(question => question.question.title)).toEqual(["Synthetic pending question"]);
    expect(context.manager.activity()).toEqual([{ id: handle.id, name: handle.name, question: "Synthetic pending question" }]);
  }, { timeout: 15_000 });
  const pid = Number(fs.readFileSync(path.join(context.root, "ready"), "utf8"));
  return { ...context, handle, pid };
};

// Seam: AgentManager.stop -> real worker -> real Pi RPC extension lifecycle.
describe.skipIf(!posix).each(["pi", "pi-durable"] as const)("%s child graceful stop", runner => {
  it("finishes session_shutdown handlers when stopped with an open question", async () => {
    const { root, manager, handle, pid } = await spawnWithOpenQuestion(runner);
    const stopping = manager.stop(handle.id);
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, "shutdown-started"))).toBe(true), { timeout: 5_000 });
    fs.writeFileSync(path.join(root, "shutdown-release"), "release");
    const result = await stopping;
    expect(result.status).toBe("stopped");
    expect(fs.existsSync(path.join(root, "shutdown-finished"))).toBe(true);
    expect(alive(pid)).toBe(false);
  }, 25_000);

  it("ends a helper left in the child's process group once the child has shut down", async () => {
    const { root, manager, handle, pid } = await spawnWithOpenQuestion(runner, dir => fs.writeFileSync(path.join(dir, "helper"), "helper"));
    const helper = Number(fs.readFileSync(path.join(root, "helper-pid"), "utf8"));
    expect(alive(helper)).toBe(true);
    fs.writeFileSync(path.join(root, "shutdown-release"), "release");
    const result = await manager.stop(handle.id);
    expect(result.status).toBe("stopped");
    expect(fs.existsSync(path.join(root, "shutdown-finished"))).toBe(true);
    expect(alive(pid)).toBe(false);
    await vi.waitFor(() => expect(alive(helper)).toBe(false), { timeout: 3_000 });
  }, 25_000);

  it("kills a child whose session_shutdown handler never returns within the stop bound", async () => {
    const { root, manager, handle, pid } = await spawnWithOpenQuestion(runner, dir => fs.writeFileSync(path.join(dir, "hang"), "hang"));
    const started = performance.now();
    const result = await manager.stop(handle.id);
    expect(performance.now() - started).toBeLessThan(7_000);
    expect(result.status).toBe("stopped");
    expect(fs.existsSync(path.join(root, "shutdown-started"))).toBe(true);
    expect(fs.existsSync(path.join(root, "shutdown-finished"))).toBe(false);
    expect(alive(pid)).toBe(false);
  }, 25_000);
});

// The tail of stdout is parsed after the child exits. A token limit it trips
// must still reach the deferred group cleanup (pi runner: the fixture speaks RPC).
describe.skipIf(!posix)("pi child stopped by its final output", () => {
  it("ends a helper in the child's group when a token limit trips on the child's final output", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-shutdown-tail-"));
    roots.push(root);
    const helperFile = path.join(root, "helper-pid");
    vi.stubEnv("FAKE_PI_HELPER_PID_FILE", helperFile);
    const manager = new AgentManager(root, {
      ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi", extensions: true,
      durableWorkerRecovery: false, timeoutMs: 30_000, maxConcurrent: 1, maxTokensPerChild: 5,
    }, {
      workerPath,
      piBinary: path.resolve("tests/fixtures/fake-pi-rpc-exit-helper.mjs"),
      runRoot: path.join(root, "runs"), fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({ task: "burn tokens", transport: "process" });
    expect(result.status, JSON.stringify(result)).toBe("timed_out");
    expect(result.error ?? "").toContain("agents.maxTokensPerChild");
    const helper = Number(fs.readFileSync(helperFile, "utf8"));
    await vi.waitFor(() => expect(alive(helper)).toBe(false), { timeout: 3_000 });
  }, 25_000);
});
