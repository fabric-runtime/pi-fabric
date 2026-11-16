import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { AgentManager } from "../src/agents/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";

const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-shutdown-build-"));
const workerPath = path.join(buildRoot, "build", "worker.js");
beforeAll(async () => {
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
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()));
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
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
  const manager = new AgentManager(root, {
    ...DEFAULT_FABRIC_CONFIG.agents, runner, extensions: true,
    durableWorkerRecovery: runner === "pi-durable", timeoutMs: 30_000, maxConcurrent: 1,
  }, {
    workerPath,
    piBinary: path.resolve("tests/fixtures/pi-rpc-shutdown.mjs"),
    runRoot: path.join(root, "runs"), fullCodeMode: false,
  });
  managers.push(manager);
  return { root, manager };
};

// Seam: AgentManager.stop -> real worker -> real Pi RPC extension lifecycle.
describe.each(["pi", "pi-durable"] as const)("%s child graceful stop", runner => {
  it("finishes session_shutdown handlers when stopped with an open question", async () => {
    const { root, manager } = setup(runner);
    const handle = await manager.spawn({ task: "wait", model: "shutdown/probe", transport: "process", residency: "durable" });
    await vi.waitFor(() => {
      const status = manager.status(handle.id);
      expect(status.status, JSON.stringify(status)).toBe("running");
      expect(fs.existsSync(path.join(root, "ready"))).toBe(true);
    }, { timeout: 15_000 });
    const pid = Number(fs.readFileSync(path.join(root, "ready"), "utf8"));
    const stopping = manager.stop(handle.id);
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, "shutdown-started"))).toBe(true), { timeout: 5_000 });
    fs.writeFileSync(path.join(root, "shutdown-release"), "release");
    const result = await stopping;
    expect(result.status).toBe("stopped");
    expect(fs.existsSync(path.join(root, "shutdown-finished"))).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 25_000);

  it("kills a child whose session_shutdown handler never returns within the stop bound", async () => {
    const { root, manager } = setup(runner);
    fs.writeFileSync(path.join(root, "hang"), "hang");
    const handle = await manager.spawn({ task: "wait", model: "shutdown/probe", transport: "process", residency: "durable" });
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, "ready"))).toBe(true), { timeout: 15_000 });
    const pid = Number(fs.readFileSync(path.join(root, "ready"), "utf8"));
    const started = performance.now();
    const result = await manager.stop(handle.id);
    expect(performance.now() - started).toBeLessThan(7_000);
    expect(result.status).toBe("stopped");
    expect(fs.existsSync(path.join(root, "shutdown-started"))).toBe(true);
    expect(fs.existsSync(path.join(root, "shutdown-finished"))).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 25_000);
});
