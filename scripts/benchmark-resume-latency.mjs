// Offline phase-level resume attribution. No personal histories or credentials.
// Run in a prepared remote checkout: node scripts/benchmark-resume-latency.mjs --variant fabric --warm
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const variant = option("--variant", "core");
const cycles = Number(option("--cycles", "3"));
const messages = Number(option("--messages", "4"));
const warm = args.includes("--warm");
const crossCwd = args.includes("--cross-cwd");
assert(["core", "fabric", "fabric-default", "stack"].includes(variant));
assert(Number.isInteger(cycles) && cycles > 0 && cycles <= 20);
assert(Number.isInteger(messages) && messages > 0 && messages <= 1000);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resume-profile-"));
for (const key of Object.keys(process.env)) if (key.startsWith("PI_FABRIC_")) delete process.env[key];
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_FABRIC_AGENT_DIR = root;
process.env.PI_OFFLINE = "1";
process.env.PI_TIMING = "1";
let scope = "import";
const timings = [];
const round = value => Math.round(value * 100) / 100;
function record(name, started, cpu, extra = {}) {
  const used = process.cpuUsage(cpu);
  timings.push({ scope, name, wallMs: round(performance.now() - started), cpuMs: round((used.user + used.system) / 1000), ...extra });
}
function wrap(target, key, name = key) {
  const original = target?.[key];
  if (typeof original !== "function") return;
  target[key] = function (...values) {
    const started = performance.now(), cpu = process.cpuUsage();
    const finish = () => record(name, started, cpu);
    try {
      const value = original.apply(this, values);
      if (value && typeof value.then === "function") return value.then(result => { finish(); return result; }, error => { finish(); throw error; });
      finish(); return value;
    } catch (error) { finish(); throw error; }
  };
}
const sdkUrl = new URL(import.meta.resolve("@earendil-works/pi-coding-agent"));
const importStarted = performance.now(), importCpu = process.cpuUsage();
const core = await import("@earendil-works/pi-coding-agent");
const ai = await import("@earendil-works/pi-ai");
record("core.import", importStarted, importCpu);
const { DefaultPackageManager } = await import(new URL("./core/package-manager.js", sdkUrl));
const { printTimings, resetTimings } = await import(new URL("./core/timings.js", sdkUrl));
for (const key of ["create", "registerProvider"]) wrap(core.ModelRuntime, key, `model.${key}`);
for (const key of ["refresh", "registerProvider", "registerNativeProvider", "registerVirtualModel"]) wrap(core.ModelRuntime.prototype, key, `model.${key}`);
wrap(core.DefaultResourceLoader.prototype, "reload", "resources.reload");
wrap(DefaultPackageManager.prototype, "resolve", "packages.resolve");
wrap(DefaultPackageManager.prototype, "resolveExtensionSources", "packages.cliSources");
wrap(core.SessionManager, "open", "session.readFile");
for (const key of ["teardownCurrent", "finishSessionReplacement", "switchSession"]) wrap(core.AgentSessionRuntime.prototype, key, `runtime.${key}`);
const minimalConfig = { fullCodeMode: true, approvals: { read: "allow", write: "allow", execute: "allow" }, mcp: { enabled: false }, mesh: { enabled: false }, memory: { enabled: false }, agents: { enabled: false }, residency: { enabled: false }, entropy: { enabled: false, compile: false }, ui: { enabled: false } };
fs.writeFileSync(path.join(root, "fabric.json"), JSON.stringify(variant === "fabric-default" ? { fullCodeMode: true, approvals: minimalConfig.approvals, ui: { enabled: false } } : minimalConfig));
const extensionPaths = variant === "core" ? [] : variant === "stack"
  ? JSON.parse(fs.readFileSync(option("--extensions-file", ""), "utf8"))
  : [fileURLToPath(new URL("../dist/index.js", import.meta.url))];
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const makeFixture = index => {
  const file = path.join(root, `small-${index}.jsonl`);
  const cwd = crossCwd ? path.join(root, `project-${index}`) : root;
  fs.mkdirSync(cwd, { recursive: true });
  const rows = [{ type: "session", version: 3, id: `session-${index}`, timestamp: new Date(0).toISOString(), cwd }];
  let parentId = null;
  for (let i = 0; i < messages; i++) {
    const id = `message-${index}-${i}`;
    rows.push({ type: "message", id, parentId, timestamp: new Date(0).toISOString(), message: { role: "user", content: `Small synthetic message ${i}.`, timestamp: 0 } });
    parentId = id;
  }
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  return file;
};
const files = [makeFixture(0), makeFixture(1)];
let issueTool = false, calls = 0;
const errors = [];
const wrapped = new WeakSet();
const factory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
  const start = performance.now(), cpu = process.cpuUsage();
  const modelRuntime = await core.ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null, allowModelNetwork: false });
  resetTimings("extensions");
  const services = await core.createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager: core.SettingsManager.inMemory({ defaultProjectTrust: "never", compaction: { enabled: false }, retry: { enabled: false }, defaultTools: [] }), resourceLoaderOptions: {
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: extensionPaths,
    extensionFactories: [pi => pi.registerProvider("offline-resume", { api: "offline-resume", apiKey: "synthetic", baseUrl: "http://invalid.local", models: [{ id: "fixture", name: "Offline resume", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 4096 }], streamSimple(model) {
      const tool = issueTool; issueTool = false;
      const message = { role: "assistant", content: tool ? [{ type: "toolCall", id: `tool-${++calls}`, name: "fabric_exec", arguments: { code: "return 1;" } }] : [{ type: "text", text: "done" }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: tool ? "toolUse" : "stop", timestamp: Date.now() };
      const stream = ai.createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); return stream;
    } })],
  } });
  const loaded = services.resourceLoader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  for (const extension of loaded.extensions) {
    for (const [event, handlers] of extension.handlers) {
      extension.handlers.set(event, handlers.map(handler => {
        if (wrapped.has(handler)) return handler;
        const measured = function (...values) {
          const start = performance.now(), cpu = process.cpuUsage();
          const finish = () => record(`hook.${event}`, start, cpu, { extension: extension.path });
          try {
            const result = handler.apply(this, values);
            if (result && typeof result.then === "function") return result.then(value => { finish(); return value; }, error => { finish(); throw error; });
            finish(); return result;
          } catch (error) { finish(); throw error; }
        };
        wrapped.add(measured); return measured;
      }));
    }
  }
  printTimings();
  const model = modelRuntime.getModel("offline-resume", "fixture"); assert(model);
  const sessionStart = performance.now(), sessionCpu = process.cpuUsage();
  const result = await core.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: "off", noTools: true });
  record("session.create", sessionStart, sessionCpu);
  const bindStart = performance.now(), bindCpu = process.cpuUsage();
  await result.session.bindExtensions({ onError: error => errors.push(String(error)) });
  record("extensions.bind", bindStart, bindCpu);
  record("runtime.create", start, cpu, { extensions: loaded.extensions.length });
  return { ...result, services, diagnostics: services.diagnostics };
};
let runtime;
let completed = false;
try {
  scope = "initial";
  runtime = await core.createAgentSessionRuntime(factory, { cwd: root, agentDir: root, sessionManager: core.SessionManager.open(files[0]) });
  for (let cycle = 1; cycle <= cycles; cycle++) {
    if (warm) {
      scope = `warm-${cycle}`;
      issueTool = variant !== "core";
      await runtime.session.prompt("Synthetic offline warm-up.");
      if (variant !== "core") assert(runtime.session.messages.some(message => message.role === "toolResult" && message.toolName === "fabric_exec" && !message.isError));
    }
    scope = `resume-${cycle}`;
    assert.equal((await runtime.switchSession(files[cycle % files.length])).cancelled, false);
  }
  assert.deepEqual(errors, []);
  completed = true;
} finally {
  scope = "dispose";
  await runtime?.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({ type: "resume-profile", completed, variant, warm, crossCwd, messages, cycles, node: process.version, platform: process.platform, timings, errors }));
}
