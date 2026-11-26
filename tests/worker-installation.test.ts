import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import type { AgentRunRecord } from "../src/agents/types.js";

const roots: string[] = [];
const managers: AgentManager[] = [];
// Every test here copies the whole dist (18 MB, ~1.5k files) and boots a cold
// Node child; on Windows the copy also pays for Defender scanning it. Keep the
// child budget inside the test ceiling so a loaded runner fails with the child
// output instead of an untimed kill that leaves handles behind.
// afterEach gets the same allowance: close() waits for a child that is still
// starting, which took longer than the default 10 s hook ceiling on Windows.
const CHILD_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 60_000;
// Three installations boot one child each under a single test.
const STRUCTURED_TEST_TIMEOUT_MS = 90_000;
const tmuxAvailable = process.platform !== "win32" && spawnSync("tmux", ["-V"], { timeout: 5000 }).status === 0;
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()));
  vi.unstubAllEnvs();
  // Windows can hold a handle on a just-killed child's files for a moment.
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 30_000);

// Outside the checkout: ancestor node_modules and development peers must not
// rescue imports. Pi managed installs deliberately omit host-provided peers.
const installation = (text = "hi") => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-worker-install-"));
  roots.push(root);
  fs.cpSync(path.resolve("dist"), path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.symlinkSync(fs.realpathSync("node_modules/cross-spawn"), path.join(root, "node_modules/cross-spawn"), process.platform === "win32" ? "junction" : "dir");
  const piBinary = path.join(root, "offline-pi.mjs");
  fs.writeFileSync(piBinary, [
    'process.stdin.resume();',
    `process.stdout.write(${JSON.stringify(JSON.stringify({ type: "message_end", message: { role: "assistant", content: text } }) + "\n" + JSON.stringify({ type: "agent_settled" }) + "\n")});`,
    'process.exit(0);',
  ].join("\n"));
  const worker = path.join(root, "dist/worker.js");
  fs.writeFileSync(path.join(root, "task.txt"), "offline installation probe");
  const flags: Record<string, string> = {
    id: "probe", name: "probe", runner: "pi", "task-file": path.join(root, "task.txt"),
    "status-file": path.join(root, "status.json"), "lifecycle-file": path.join(root, "lifecycle.jsonl"),
    "log-file": path.join(root, "events.jsonl"), cwd: root, "pi-binary": piBinary,
    "claude-binary": "unused", "veda-binary": "unused", "veda-backend": "agy", "veda-persona": "unused",
    "timeout-ms": "5000", depth: "1", "full-code-mode": "false", extensions: "false", tools: "[]",
    "granted-risks": "[]", transport: "process",
  };
  const run = async (extra: Record<string, string> = {}, runtimeArgs: string[] = []) => {
    const args = Object.entries({ ...flags, ...extra }).flatMap(([key, value]) => [`--${key}`, value]);
    const child = await promisify(execFile)(process.execPath, [...runtimeArgs, worker, ...args], { cwd: root, timeout: CHILD_TIMEOUT_MS, maxBuffer: 100000 })
      .then(output => ({ ...output, exitCode: 0 }), error => ({ stderr: String(error.stderr), exitCode: error.code }));
    const file = path.join(root, "status.json");
    const record = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as AgentRunRecord : undefined;
    return { child, record };
  };
  return { root, worker, piBinary, run };
};

describe("standalone worker without Pi host peers", () => {
  it("boots a published worker without typebox or Pi packages installed", async () => {
    const { run } = installation();
    const { child, record } = await run();
    expect(child, child.stderr).toMatchObject({ exitCode: 0 });
    expect(record).toMatchObject({ status: "completed", text: "hi" });
  }, TEST_TIMEOUT_MS);

  it.each([
    { text: '```json\n{"count":2}\n```', status: "completed", value: { count: 2 } },
    { text: '{"count":"wrong"}', status: "failed", value: undefined },
    { text: 'not JSON', status: "failed", value: undefined },
  ])("preserves structured validation: $text", async ({ text, status, value }) => {
    const { root, run } = installation(text);
    const schemaFile = path.join(root, "schema.json");
    fs.writeFileSync(schemaFile, JSON.stringify({ type: "object", properties: { count: { type: "number" } }, required: ["count"], additionalProperties: false }));
    const { child, record } = await run({ "schema-file": schemaFile });
    expect(record, child.stderr).toMatchObject({ status });
    expect(record?.value).toEqual(value);
    if (status === "failed") expect(record?.error).toContain("Structured agent output was invalid");
  }, STRUCTURED_TEST_TIMEOUT_MS);

  it("persists failures even before the worker's normal status context exists", async () => {
    const { root, run } = installation();
    fs.rmSync(path.join(root, "dist/worker/options.js"));
    const { child, record } = await run();
    expect(child.exitCode).toBe(1);
    expect(record, child.stderr).toMatchObject({ status: "failed", turns: 0, toolCalls: 0 });
    expect(record?.error).toContain("options.js");
  }, TEST_TIMEOUT_MS);

  it("reports unsupported Node before loading optional worker modules", async () => {
    const { root, run } = installation();
    const preload = path.join(root, "node22.cjs");
    fs.writeFileSync(preload, 'Object.defineProperty(process.versions, "node", { value: "22.22.2" });');
    const { child, record } = await run({}, ["--require", preload]);
    expect(child.exitCode).toBe(1);
    expect(record, child.stderr).toMatchObject({ status: "failed", turns: 0, toolCalls: 0 });
    expect(record?.error).toContain("Node.js 24+");
    expect(record?.error).toContain("22.22.2");
  }, TEST_TIMEOUT_MS);

  it("names the build and the remedy when the build has no installed dependencies", async () => {
    const { root, run } = installation();
    fs.rmSync(path.join(root, "node_modules"), { recursive: true });
    const { child, record } = await run();
    expect(child.exitCode).toBe(1);
    expect(record, child.stderr).toMatchObject({ status: "failed", turns: 0, toolCalls: 0 });
    expect(record?.error).toContain(`Fabric build at ${fs.realpathSync(root)} cannot start a worker: its dependency "cross-spawn" is not installed (the build has no node_modules)`);
    expect(record?.error).toContain("restart Pi");
    expect(record?.error).toContain("Cannot find package 'cross-spawn'");
  }, TEST_TIMEOUT_MS);

  it("reports a missing runtime dependency instead of losing stderr", async () => {
    const { root, run } = installation();
    fs.rmSync(path.join(root, "node_modules/cross-spawn"));
    const { child, record } = await run();
    expect(child.exitCode).toBe(1);
    expect(record, child.stderr).toMatchObject({ status: "failed" });
    expect(record?.error).toContain("cross-spawn");
  }, TEST_TIMEOUT_MS);

  it.skipIf(!tmuxAvailable)("boots and reports early failures through an isolated real tmux server", async () => {
    const { root, worker, piBinary } = installation();
    const binary = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
    const socket = `fabric-install-${process.pid}-${path.basename(root)}`;
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const quote = (text: string) => `'${text.replaceAll("'", "'\"'\"'")}'`;
    fs.writeFileSync(path.join(bin, "tmux"), `#!/bin/sh\nexec ${quote(binary)} -L ${quote(socket)} -f /dev/null "$@"\n`, { mode: 0o755 });
    vi.stubEnv("PATH", bin + path.delimiter + process.env.PATH);
    const manager = new AgentManager(root, { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" as const, timeoutMs: CHILD_TIMEOUT_MS, sessionExport: false }, {
      workerPath: worker, piBinary, runRoot: path.join(root, "runs"), fullCodeMode: false,
    });
    managers.push(manager);
    try {
      const good = await manager.run({ task: "offline tmux probe", transport: "tmux", extensions: false });
      expect(good, good.error).toMatchObject({ status: "completed", text: "hi" });
      fs.rmSync(path.join(root, "node_modules/cross-spawn"));
      const bad = await manager.run({ task: "offline failure probe", transport: "tmux", extensions: false });
      expect(bad.status).toBe("failed");
      expect(bad.error).toContain("cross-spawn");
    } finally {
      await manager.close();
      spawnSync(binary, ["-L", socket, "kill-server"], { timeout: 5000 });
    }
  }, TEST_TIMEOUT_MS);

  it("propagates bootstrap failure through the real process transport", async () => {
    const { root, worker, piBinary } = installation();
    fs.rmSync(path.join(root, "dist/worker/options.js"));
    const manager = new AgentManager(root, { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" as const, timeoutMs: CHILD_TIMEOUT_MS, sessionExport: false }, {
      workerPath: worker, piBinary, runRoot: path.join(root, "runs"), fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({ task: "offline probe", transport: "process", extensions: false });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("options.js");
    expect(result.error).not.toContain("transport exited without a result");
  }, TEST_TIMEOUT_MS);
});
