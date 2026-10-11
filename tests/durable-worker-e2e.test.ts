import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import type { AgentRunRecord } from "../src/agents/types.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";

// No dist dependency and no fake Pi binary: manager -> compiled parent worker
// -> compiled durable host -> native SDK RPC/tools, with only inference offline.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-durable-e2e-"));
const workerPath = path.join(root, "build", "worker.js");
const managers: AgentManager[] = [];
let sequence = 0;
beforeAll(async () => {
  fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  await build({
    entryPoints: ["src/worker.ts", "src/durable/worker.ts", "src/agents/write-guard.ts", "src/agents/provider-bridge.ts",
      "src/agents/compact-control.ts", "src/agents/claude-cli.ts", "src/agents/veda-cli.ts",
      ...fs.readdirSync("src/worker").filter(name => name.endsWith(".ts")).map(name => `src/worker/${name}`)],
    outdir: path.join(root, "build"), outbase: "src", bundle: true, packages: "external",
    platform: "node", format: "esm", splitting: true, target: "node24", logLevel: "silent",
  });
}, 30000);
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()));
  vi.unstubAllEnvs();
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// Additional adversarial RPC probes use the same compiled parent, in a separate
// tree. These supplement (never substitute for) the real native-host tests.
const faultWorkerPath = path.join(root, "fault-build", "worker.js");
beforeAll(() => {
  fs.cpSync(path.dirname(workerPath), path.dirname(faultWorkerPath), { recursive: true });
  fs.writeFileSync(path.join(root, "fault-build", "durable", "worker.js"), String.raw`
    import { createInterface } from 'node:readline';
    const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
    const mode = process.env.DURABLE_RPC_FAULT;
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      if (request.type === 'prompt') {
        if (mode === 'partial') emit({ type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 2, output: 1 } } });
        emit({ type: 'agent_settled' }); continue;
      }
      if (request.type !== 'get_messages') throw new Error('Unexpected RPC: ' + request.type);
      if (mode === 'exit') process.exit(0);
      if (mode === 'timeout') continue;
      const response = { type: 'response', command: 'get_messages', id: request.id, success: true };
      if (mode === 'reject') { emit({ ...response, success: false, error: 'storage unavailable' }); continue; }
      if (mode === 'wrong-command') { emit({ ...response, command: 'get_state' }); continue; }
      const assistant = { role: 'assistant', provider: 'durable-offline', model: 'test',
        content: [{ type: 'text', text: 'recorded answer' }], usage: { input: 7, output: 3, cost: { total: 0.1 } },
        stopReason: mode === 'error' ? 'error' : 'stop', errorMessage: 'recorded provider failure' };
      const messages = [
        { role: 'user', content: 'old actor turn' }, { ...assistant, usage: { input: 100000, output: 10000 } },
        { role: 'user', content: mode === 'stale' ? 'wrong task' : 'task' }, assistant,
      ];
      // A response for another request must not consume this retrieval.
      emit({ ...response, id: 'unrelated-request', data: { messages: [] } });
      emit({ ...response, data: { messages: mode === 'empty' ? [] : messages } });
    }
  `);
});

function setup(inherited = false, entry = workerPath) {
  const cwd = path.join(root, `case-${++sequence}`);
  const agentDir = path.join(cwd, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    extensions: [path.resolve("tests/fixtures/durable-pi-extension.ts")],
    defaultProvider: "durable-offline", defaultModel: "test",
    compaction: { enabled: false }, retry: { enabled: false },
  }));
  for (const key of ["PI_FABRIC_DEPTH", "PI_FABRIC_BUDGET", "PI_FABRIC_BUDGET_FILE", "PI_FABRIC_BUDGET_ID",
    "PI_FABRIC_WRITE_POLICY", "PI_FABRIC_TOOL_ALLOWLIST", "PI_FABRIC_SCOPE", "PI_FABRIC_LINEAGE"]) vi.stubEnv(key, undefined);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("DURABLE_TEST_FAUX_MODULE", import.meta.resolve("@earendil-works/pi-ai/providers/faux"));
  vi.stubEnv("DURABLE_TEST_FILE", path.join(cwd, "fixture.txt"));
  fs.writeFileSync(path.join(cwd, "fixture.txt"), "private fixture");
  const manager = new AgentManager(cwd, {
    ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi-durable", transport: "process", extensions: true,
    timeoutMs: 20000, maxConcurrent: 1,
  }, { workerPath: entry, runRoot: path.join(cwd, "runs"), fullCodeMode: false,
    // Must never fall back to the native CLI, even on startup/replay failures.
    piBinary: path.join(cwd, "forbidden-native-fallback"),
    ...(inherited ? { preparePiModel: async () => "durable-offline/test" } : {}),
  });
  managers.push(manager);
  return { manager, cwd };
}

async function restart(directory: string, first: Pick<AgentRunRecord, "id" | "name" | "cwd" | "requestedModel">, extra: Record<string, string> = {}, entry = workerPath) {
  const values: Record<string, string> = {
    id: first.id, name: first.name, runner: "pi-durable", "task-file": path.join(directory, "task.txt"),
    "status-file": path.join(directory, "status.json"), "lifecycle-file": path.join(directory, "replay-lifecycle.jsonl"),
    "log-file": path.join(directory, "replay.jsonl"), cwd: first.cwd,
    "pi-binary": "forbidden-native-fallback", "claude-binary": "unused", "veda-binary": "unused",
    "veda-backend": "unused", "veda-persona": "unused", "timeout-ms": "20000", depth: "1",
    "full-code-mode": "false", extensions: "true", tools: '["read"]', "granted-risks": "[]", transport: "process",
    ...(first.requestedModel ? { model: first.requestedModel } : {}), ...extra,
  };
  const child = spawn(process.execPath, [entry, ...Object.entries(values).flatMap(([key, value]) => [`--${key}`, value])],
    { cwd: first.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`Parent worker hung: ${output}`)); }, 30000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
  return JSON.parse(fs.readFileSync(values["status-file"]!, "utf8")) as AgentRunRecord;
}

const events = (file: string) => fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));

describe("AgentManager real durable parent worker", () => {
  it("recovers a completed journal after the parent dies before saving completion", async () => {
    const entry = path.join(path.dirname(workerPath), "completion-crash-worker.js");
    fs.writeFileSync(entry, String.raw`
      import fs from 'node:fs';
      import path from 'node:path';
      const status = process.argv[process.argv.indexOf('--status-file') + 1];
      const marker = path.join(path.dirname(status), 'completion-crash');
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (String(to) === status && !fs.existsSync(marker) &&
            JSON.parse(fs.readFileSync(from, 'utf8')).status === 'completed') {
          fs.writeFileSync(marker, 'interrupted before status commit');
          fs.writeFileSync(process.env.DURABLE_TEST_FILE, 'MUST NOT BE READ AGAIN');
          process.exit(71);
        }
        return rename(from, to);
      };
      await import('./worker.js');
    `);
    const { manager, cwd } = setup(false, entry);
    const sessionFile = path.join(cwd, "recovered-session.jsonl");
    const result = await manager.run({ task: "read fixture", tools: ["read"], sessionFile });
    expect(result.status, result.error).toBe("completed");
    expect(result.task).toBe("read fixture");
    expect(result.text).toBe("result:private fixture");
    expect(result.toolCalls).toBe(1);
    expect(fs.readFileSync(path.join(manager.runDirectory(result.id)!, "completion-crash"), "utf8"))
      .toBe("interrupted before status commit");
    const history = events(sessionFile).filter(event => event.type === "message");
    expect(history.filter(event => event.message.role === "user")).toHaveLength(1);
    expect(history.filter(event => event.message.role === "toolResult")).toHaveLength(1);
  }, 30000);

  it.each([false, true])("projects a real native read with inherited model=%s and restores its recorded result", async inherited => {
    const { manager, cwd } = setup(inherited);
    const sessionFile = path.join(cwd, "actor-session.jsonl");
    const session = SessionManager.open(sessionFile, undefined, cwd);
    session.appendMessage({ role: "user", content: "old actor turn", timestamp: 1 });
    session.appendMessage({ role: "assistant", content: [{ type: "text", text: "old expensive answer" }],
      api: "openai-completions", provider: "durable-offline", model: "test", stopReason: "stop", timestamp: 2,
      usage: { input: 100000, output: 10000, cacheRead: 0, cacheWrite: 0, totalTokens: 110000,
        cost: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, total: 11 } } });
    const result = await manager.run({ task: "read fixture", tools: ["read"], sessionFile });
    expect(result.status, result.error).toBe("completed");
    expect(result.model).toBe("durable-offline/test");
    expect(result.text).toBe("result:private fixture");
    expect(result.toolCalls).toBe(1);
    const directory = manager.runDirectory(result.id)!;
    const first = JSON.parse(fs.readFileSync(path.join(directory, "status.json"), "utf8")) as AgentRunRecord;
    expect(events(first.logFile!).some(event => event.type === "tool_execution_end")).toBe(true);
    // Changed source makes an accidental second read observable in the answer.
    fs.writeFileSync(path.join(cwd, "fixture.txt"), "MUST NOT BE READ AGAIN");
    const history = events(sessionFile).filter(event => event.type === "message");
    expect(first.usage.input).toBeLessThan(100000);
    const replay = await restart(directory, first, { "session-file": sessionFile });
    // Model admission can append model_change, but must not duplicate messages.
    expect(events(sessionFile).filter(event => event.type === "message")).toEqual(history);
    expect(replay.status, replay.error).toBe("completed");
    expect(replay.text).toBe(first.text);
    expect(replay.usage).toEqual(first.usage);
    expect(replay.turns).toBe(first.turns);
    expect(replay.toolCalls).toBe(first.toolCalls);
    const log = events(replay.logFile!);
    expect(log.filter(event => event.type === "message_end" || event.type === "tool_execution_start")).toHaveLength(0);
    expect(log.some(event => event.type === "response" && event.command === "get_messages" && event.id === `fabric-recorded-result:${first.id}`)).toBe(true);
    expect(events(path.join(directory, "replay-lifecycle.jsonl")).some(event => event.event === "tokens.usage")).toBe(false);
  }, 60000);

  it("resolves an extension-registered provider for extensions: false without loading that extension's tools", async () => {
    const { manager, cwd } = setup();
    const effect = path.join(cwd, "effect.txt");
    vi.stubEnv("DURABLE_TEST_EFFECT", effect);
    // With the fixture extension loaded, hold_effect would run and block.
    const result = await manager.run({
      task: "hold effect", tools: ["hold_effect"], extensions: false, model: "durable-offline/test",
    });
    expect(result.status, result.error).toBe("completed");
    expect(result.requestedModel).toBe("durable-offline/test");
    expect(result.model).toBe("durable-offline/test");
    expect(result.text).toMatch(/^result:.*hold_effect/s);
    expect(fs.existsSync(effect)).toBe(false);
  }, 30000);

  it("resolves the same provider through the legacy Pi CLI runner with --no-extensions", async () => {
    const { cwd } = setup();
    const effect = path.join(cwd, "effect.txt");
    vi.stubEnv("DURABLE_TEST_EFFECT", effect);
    const manager = new AgentManager(cwd, {
      ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi", transport: "process", timeoutMs: 20000, maxConcurrent: 1,
    }, { workerPath, runRoot: path.join(cwd, "runs"), fullCodeMode: false,
      piBinary: path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js") });
    managers.push(manager);
    const result = await manager.run({
      task: "hold effect", tools: ["hold_effect"], extensions: false, model: "durable-offline/test",
    });
    expect(result.status, result.error).toBe("completed");
    expect(result.model).toBe("durable-offline/test");
    expect(result.text).toMatch(/^result:.*hold_effect/s);
    expect(fs.existsSync(effect)).toBe(false);
  }, 30000);

  it("fails an extensions: false child closed when no installed extension registers the provider", async () => {
    const { manager } = setup();
    const result = await manager.run({ task: "never sent", extensions: false, model: "absent-provider/model" });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/task was not sent[\s\S]*needs provider \\*"absent-provider\\*"[\s\S]*extensions: true/);
  }, 30000);

  it("enforces write confinement through the real parent and durable host", async () => {
    const { manager, cwd } = setup();
    const result = await manager.run({ task: "write fixture", tools: ["write"], readOnly: true });
    expect(result.status, result.error).toBe("completed");
    expect(result.text).toMatch(/denied|read.only|confine/i);
    expect(fs.readFileSync(path.join(cwd, "fixture.txt"), "utf8")).toBe("private fixture");
  }, 30000);

  it("preserves image input and validates structured recorded output after process restart", async () => {
    const { manager } = setup(true);
    const schema = { type: "object", properties: { reply: { type: "string" }, images: { type: "integer" } }, required: ["reply", "images"], additionalProperties: false };
    const images = [{ type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==" }];
    const result = await manager.run({ task: "image probe", tools: [], schema, images });
    expect(result.status, result.error).toBe("completed");
    expect(result.value).toEqual({ reply: "image probe", images: 1 });
    const directory = manager.runDirectory(result.id)!;
    const first = JSON.parse(fs.readFileSync(path.join(directory, "status.json"), "utf8")) as AgentRunRecord;
    // Manager removes sensitive input images when consuming the first result.
    fs.writeFileSync(path.join(directory, "images.json"), JSON.stringify(images));
    const replay = await restart(directory, first, { "schema-file": path.join(directory, "schema.json"), "images-file": path.join(directory, "images.json"), tools: "[]" });
    expect(replay.status, replay.error).toBe("completed");
    expect(replay.value).toEqual(result.value);
    expect(replay.usage).toEqual(first.usage);
  }, 60000);
});

describe("compiled parent recorded-result RPC failure boundaries", () => {
  it.each([
    ["success", undefined],
    ["partial", undefined],
    ["error", "recorded provider failure"],
    ["reject", "storage unavailable"],
    ["wrong-command", "invalid or rejected RPC response"],
    ["empty", "recorded history"],
    ["stale", "submitted prompt"],
    ["exit", "exited before recorded result retrieval"],
    ["timeout", "retrieval timed out"],
  ] as const)("handles %s without falling back or accepting an unrelated response", async (mode, error) => {
    const { cwd } = setup();
    vi.stubEnv("DURABLE_RPC_FAULT", mode);
    fs.writeFileSync(path.join(cwd, "task.txt"), "task");
    const result = await restart(cwd, { id: "recorded-rpc", name: "Recorded RPC", cwd }, {}, faultWorkerPath);
    expect(result.status, result.error).toBe(error ? "failed" : "completed");
    if (error) expect(result.error).toContain(error);
    if (mode === "success" || mode === "partial" || mode === "error") {
      expect(result.text).toBe("recorded answer");
      expect(result.usage).toEqual({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.1 });
      expect(result.turns).toBe(1);
    }
  }, 15000);
});
