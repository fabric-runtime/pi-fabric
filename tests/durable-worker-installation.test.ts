import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import type { AgentRunRecord } from "../src/agents/types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";

// The Bun-parent probe cold-loads the private SDK and starts a second worker.
// Windows CI exceeded its old 25s process/30s test ceiling under the smoke load.
// Match the 90s Windows SDK budget used by the offline continuation probe, with
// nested exit/cleanup headroom; retain the existing 20s/25s/30s Unix limits.
const BUN_WORKER_TIMEOUT_MS = process.platform === "win32" ? 90_000 : 20_000;
const BUN_PROCESS_TIMEOUT_MS = BUN_WORKER_TIMEOUT_MS + 5_000;
const BUN_TEST_TIMEOUT_MS = BUN_PROCESS_TIMEOUT_MS + 5_000;

const roots: string[] = [];
const managers: AgentManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()));
  vi.unstubAllEnvs();
  // Windows can hold a handle on a just-closed worker's files for a moment.
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// A Pi-managed installation has production dependencies, but no physical host
// peers. Do not symlink the checkout's node_modules or leave fixtures inside it.
// Host peers only: pi-durable and chord are optional peers for pi-fabric/durable-extension hosts and also
// dependencies the bundled durable runner resolves from the package itself.
const hostPeers = (manifest: { dependencies: Record<string, string>; peerDependencies: Record<string, string> }) =>
  Object.keys(manifest.peerDependencies).filter((name) => !Object.hasOwn(manifest.dependencies, name));

function installation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-durable-install-"));
  roots.push(root);
  fs.cpSync(path.resolve("dist"), path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  for (const name of Object.keys(manifest.dependencies)) {
    const target = path.join(root, "node_modules", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(fs.realpathSync(path.join("node_modules", name)), target, process.platform === "win32" ? "junction" : "dir");
  }
  const require = createRequire(path.join(root, "package.json"));
  for (const name of hostPeers(manifest)) {
    expect(fs.existsSync(path.join(root, "node_modules", name))).toBe(false);
    expect(() => require.resolve(name)).toThrow();
  }
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir);
  fs.copyFileSync("tests/fixtures/durable-pi-extension.ts", path.join(root, "offline-extension.ts"));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    extensions: [path.join(root, "offline-extension.ts")],
    defaultProvider: "durable-offline", defaultModel: "test",
    compaction: { enabled: false }, retry: { enabled: false },
  }));
  for (const key of ["PI_FABRIC_DEPTH", "PI_FABRIC_BUDGET", "PI_FABRIC_BUDGET_FILE", "PI_FABRIC_BUDGET_ID",
    "PI_FABRIC_WRITE_POLICY", "PI_FABRIC_TOOL_ALLOWLIST", "PI_FABRIC_SCOPE", "PI_FABRIC_LINEAGE"]) vi.stubEnv(key, undefined);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("DURABLE_TEST_FAUX_MODULE", import.meta.resolve("@earendil-works/pi-ai/providers/faux"));
  vi.stubEnv("DURABLE_TEST_FILE", path.join(root, "fixture.txt"));
  fs.writeFileSync(path.join(root, "fixture.txt"), "installed durable worker works");
  const manager = new AgentManager(root, {
    ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi-durable", transport: "process", extensions: true,
    timeoutMs: 20000, maxConcurrent: 1, sessionExport: false,
  }, { workerPath: path.join(root, "dist/worker.js"), runRoot: path.join(root, "runs"), fullCodeMode: false,
    piBinary: path.join(root, "forbidden-legacy-fallback"),
  });
  managers.push(manager);
  return { root, manager };
}

const bunAvailable = spawnSync("bun", ["--version"], { timeout: 5000 }).status === 0;

describe("installed durable worker without host peers", () => {
  it.skipIf(!bunAvailable)("runs the parent and durable SDK worker under Bun without host peers", async () => {
    const { root } = installation();
    const taskFile = path.join(root, "task.txt");
    const statusFile = path.join(root, "bun-status.json");
    fs.writeFileSync(taskFile, "read fixture");
    const flags = {
      id: "bun-probe", name: "bun-probe", runner: "pi-durable", cwd: root,
      "task-file": taskFile, "status-file": statusFile,
      "lifecycle-file": path.join(root, "bun-lifecycle.jsonl"), "log-file": path.join(root, "bun-events.jsonl"),
      "pi-binary": "forbidden-legacy-fallback", "claude-binary": "unused", "veda-binary": "unused",
      "veda-backend": "agy", "veda-persona": "unused", "timeout-ms": String(BUN_WORKER_TIMEOUT_MS), depth: "1",
      "full-code-mode": "false", extensions: "true", tools: '["read"]', "granted-risks": "[]", transport: "process",
    };
    const child = await promisify(execFile)("bun", [path.join(root, "dist/worker.js"),
      ...Object.entries(flags).flatMap(([key, value]) => [`--${key}`, value])],
    { cwd: root, timeout: BUN_PROCESS_TIMEOUT_MS, maxBuffer: 100000 }).then(
      output => ({ ...output, exitCode: 0 }), error => ({ stderr: String(error.stderr), exitCode: error.code }),
    );
    expect(child, child.stderr).toMatchObject({ exitCode: 0 });
    const record = JSON.parse(fs.readFileSync(statusFile, "utf8")) as AgentRunRecord;
    expect(record.status, record.error).toBe("completed");
    expect(record.text).toContain("installed durable worker works");
    expect(record.toolCalls).toBe(1);
  }, BUN_TEST_TIMEOUT_MS);

  it("runs SDK RPC, a discovered extension, and a real tool outside the checkout", async () => {
    const { manager } = installation();
    const result = await manager.run({ task: "read fixture", tools: ["read"] });
    expect(result.status, result.error).toBe("completed");
    expect(result.text).toContain("installed durable worker works");
    expect(result.toolCalls).toBe(1);
  }, 30000);

  it("ignores conflicting ambient Pi peers instead of mixing SDK instances", async () => {
    const { root, manager } = installation();
    const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
    for (const name of hostPeers(manifest)) {
      const directory = path.join(root, "node_modules", name);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
        name, type: "module", exports: { ".": "./index.js", "./*": "./index.js" },
      }));
      fs.writeFileSync(path.join(directory, "index.js"), 'throw new Error("ambient Pi peer must not load");');
    }
    const result = await manager.run({ task: "read fixture", tools: ["read"] });
    expect(result.status, result.error).toBe("completed");
    expect(result.text).toContain("installed durable worker works");
  }, 30000);

  it("reports a missing private SDK without falling back to ambient Pi or the CLI", async () => {
    const { root, manager } = installation();
    const sdk = path.join(root, "node_modules/pi-fabric-worker-sdk");
    fs.symlinkSync(fs.realpathSync(sdk), path.join(root, "node_modules/@earendil-works/pi-coding-agent"), process.platform === "win32" ? "junction" : "dir");
    fs.rmSync(sdk, { recursive: true });
    const result = await manager.run({ task: "read fixture", tools: ["read"] });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Durable Pi worker failed");
    expect(result.error).toContain("pi-fabric-worker-sdk");
    expect(result.error).not.toContain("transport exited without a result");
  }, 30000);

  it("names the build and the remedy when the private SDK is not installed", async () => {
    const { root, manager } = installation();
    fs.rmSync(path.join(root, "node_modules/pi-fabric-worker-sdk"), { recursive: true });
    const result = await manager.run({ task: "read fixture", tools: ["read"] });
    expect(result.status).toBe("failed");
    expect(result.error).toContain(`Fabric build at ${fs.realpathSync(root)} cannot start a worker: its dependency "pi-fabric-worker-sdk" is not installed`);
    expect(result.error).not.toContain("(the build has no node_modules)");
    expect(result.error).toContain("restart Pi");
  }, 30000);
});
