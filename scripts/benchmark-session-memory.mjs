// Synthetic, offline attribution against the installed Pi SDK, in a fresh process.
// node --expose-gc scripts/benchmark-session-memory.mjs --mode manager --mib 256
// Modes sdk/fabric also exercise the real AgentSessionRuntime replacement lifecycle.
// checkpoint opens only a small synthetic continuation while preserving the archive.
// See docs/session-memory-investigation.md for the matrix, receipts and limitations.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setImmediate as yieldTurn } from "node:timers/promises";

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const mode = option("--mode", "manager");
const mib = Number(option("--mib", "64"));
const cycles = Number(option("--cycles", "6"));
assert(["manager", "paged", "checkpoint", "sdk", "fabric"].includes(mode), "Unknown mode");
assert(Number.isInteger(cycles) && cycles >= 1 && cycles <= 200, "--cycles must be 1..200");
assert(Number.isInteger(mib) && mib >= 1 && mib <= 1024, "--mib must be 1..1024");
assert(global.gc, "Run with node --expose-gc");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-memory-"));
// Do not load personal configuration, credentials, extensions or project files.
for (const name of Object.keys(process.env)) if (name.startsWith("PI_FABRIC_")) delete process.env[name];
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_FABRIC_AGENT_DIR = root;
const toMiB = bytes => Math.round(bytes / 1048576 * 100) / 100;
async function sample(step, extra = {}) {
  for (let i = 0; i < 3; i++) { await yieldTurn(); global.gc(); }
  const memory = process.memoryUsage();
  console.log(JSON.stringify({ step, ...Object.fromEntries(Object.entries(memory).map(([key, value]) => [key + "MiB", toMiB(value)])), peakRssMiB: toMiB(process.resourceUsage().maxRSS * 1024), ...extra }));
}
function makeFixture() {
  const file = path.join(root, "history.jsonl");
  const fd = fs.openSync(file, "wx", 0o600);
  const timestamp = new Date(0).toISOString();
  let bytes = 0, count = 0, lastId = null;
  const append = entry => { const line = JSON.stringify(entry) + "\n"; bytes += Buffer.byteLength(line); fs.writeSync(fd, line); };
  try {
    append({ type: "session", version: 3, id: randomUUID(), timestamp, cwd: root });
    while (bytes < mib * 1048576) {
      const id = `entry-${++count}`;
      append({ type: "message", id, parentId: lastId, timestamp, message: { role: "user", content: mode === "paged" ? [{ type: "text", text: `${id}:` + "x".repeat(32 * 1024) }] : `${id}:` + "x".repeat(32 * 1024), timestamp: 0 } });
      lastId = id;
    }
  } finally { fs.closeSync(fd); }
  if (mode === "checkpoint") {
    const checkpoint = path.join(root, "checkpoint.jsonl");
    const entries = [
      { type: "session", version: 3, id: randomUUID(), timestamp, cwd: root, parentSession: file },
      { type: "compaction", id: "checkpoint", parentId: null, timestamp, summary: "Synthetic checkpoint: previous messages are summarized.", firstKeptEntryId: "checkpoint", tokensBefore: count * 8192 },
    ];
    fs.writeFileSync(checkpoint, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
    return { file: checkpoint, bytes: fs.statSync(checkpoint).size, count: 1, archiveBytes: bytes };
  }
  return { file, bytes, count };
}
async function runManager(core, fixture) {
  let manager = core.SessionManager.open(fixture.file, root);
  await sample("history-loaded", { entries: manager.getEntryCount() });
  let context = manager.buildSessionContext();
  assert.equal(context.messages.length, fixture.count);
  await sample("full-context-built", { contextMessages: context.messages.length });
  context = undefined;
  manager.appendCompaction("Synthetic checkpoint: previous messages are summarized.", undefined, fixture.count * 8192);
  context = manager.buildSessionContext();
  assert.equal(context.messages.length, 1, "Retain-none compaction should expose only its summary");
  await sample("compacted", { entries: manager.getEntryCount(), contextMessages: context.messages.length });
  if (mode === "paged") {
    const weakPayloads = manager.getEntries().filter(entry => entry.type === "message").map(entry => new WeakRef(entry.message.content));
    const fileHash = () => createHash("sha256").update(fs.readFileSync(fixture.file)).digest("hex");
    const beforeFile = fileHash();
    const expected = JSON.stringify(context.messages);
    const { pageSessionHistory } = await import("../src/memory/history-paging.ts");
    const paged = await pageSessionHistory(manager);
    assert.equal(paged.entries, fixture.count);
    assert.equal(fileHash(), beforeFile, "Paging must not rewrite the session file");
    await sample("history-paged", { pagedEntries: paged.entries, pagedMiB: toMiB(paged.bytes) });
    assert(weakPayloads.every(payload => payload.deref() === undefined), "Retired content payloads must be collectible");
    assert.equal(JSON.stringify(manager.buildSessionContext().messages), expected);
    const first = manager.getEntry("entry-1");
    assert.equal(first.type, "message");
    assert.deepEqual(first.message.content, [{ type: "text", text: "entry-1:" + "x".repeat(32 * 1024) }], "Cold payload must hydrate exactly");
  }
  // Experimental control, NOT a production migration: historical branches, labels,
  // extension state and accounting must be preserved by any real paging design.
  const expectedContext = JSON.stringify(context.messages);
  context = undefined;
  let projected = manager.buildContextEntries().map((entry, index, entries) => ({ ...entry, parentId: index ? entries[index - 1].id : null }));
  manager = core.SessionManager.inMemory(root, undefined, [{ ...manager.getHeader() }, ...projected]);
  projected = undefined;
  assert.equal(JSON.stringify(manager.buildSessionContext().messages), expectedContext);
  await sample("active-context-only-control", { entries: manager.getEntryCount() });
  manager.newSession();
  await sample("new-empty-session", { entries: manager.getEntryCount() });
  for (let cycle = 1; cycle <= 2; cycle++) {
    manager.setSessionFile(fixture.file);
    context = manager.buildSessionContext();
    assert.equal(context.messages.length, 1);
    await sample(`reopen-${cycle}`, { entries: manager.getEntryCount(), contextMessages: context.messages.length });
    context = undefined;
    manager.newSession();
    await sample(`release-${cycle}`, { entries: manager.getEntryCount() });
  }
  manager = undefined;
  await sample("manager-released");
}
async function runSdk(core, fixture) {
  const ai = await import("@earendil-works/pi-ai");
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  let pendingCode = false, requests = 0, completedFabricRuns = 0;
  const errors = [];
  const settings = { defaultProjectTrust: "never", compaction: { enabled: false }, retry: { enabled: false }, defaultTools: [] };
  fs.writeFileSync(path.join(root, "fabric.json"), JSON.stringify({ fullCodeMode: true, approvals: { read: "allow", write: "allow", execute: "allow" }, mcp: { enabled: false }, mesh: { enabled: false }, memory: { enabled: false }, agents: { enabled: false }, residency: { enabled: false }, entropy: { enabled: false, compile: false }, ui: { enabled: false } }));
  const create = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const modelRuntime = await core.ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null, modelsStorePath: path.join(root, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
    const services = await core.createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager: core.SettingsManager.inMemory(settings), resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: mode === "fabric" ? [fileURLToPath(new URL("../dist/index.js", import.meta.url))] : [],
      extensionFactories: [pi => pi.registerProvider("offline-memory", { api: "offline-memory", apiKey: "synthetic-not-a-credential", baseUrl: "http://invalid.local", models: [{ id: "fixture", name: "Offline memory fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000000, maxTokens: 4096 }], streamSimple(model) {
        const withCode = pendingCode; pendingCode = false; requests++;
        const message = { role: "assistant", content: withCode ? [{ type: "toolCall", id: `call-${requests}`, name: "fabric_exec", arguments: { code: "return 1;" } }] : [{ type: "text", text: "done" }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: withCode ? "toolUse" : "stop", timestamp: Date.now() };
        const stream = ai.createAssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); return stream;
      } })],
    } });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    const model = modelRuntime.getModel("offline-memory", "fixture"); assert(model);
    const result = await core.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: "off", noTools: true });
    await result.session.bindExtensions({ onError: error => errors.push(String(error)) });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  let runtime = await core.createAgentSessionRuntime(create, { cwd: root, agentDir: root, sessionManager: core.SessionManager.open(fixture.file, root) });
  try {
    await sample("sdk-created", { entries: runtime.session.sessionManager.getEntryCount(), contextMessages: runtime.session.messages.length });
    runtime.session.sessionManager.appendCompaction("Synthetic checkpoint: previous messages are summarized.", undefined, fixture.count * 8192);
    runtime.session.refreshContext();
    await sample("sdk-compacted", { entries: runtime.session.sessionManager.getEntryCount(), contextMessages: runtime.session.messages.length });
    const prompt = async () => {
      pendingCode = mode === "fabric";
      await runtime.session.prompt("Synthetic offline memory probe.");
      if (mode === "fabric") {
        const result = runtime.session.messages.findLast(message => message.role === "toolResult" && message.toolName === "fabric_exec");
        assert(result && !result.isError, JSON.stringify(result));
        completedFabricRuns++;
      }
    };
    await prompt();
    await sample("sdk-first-turn", { requests, completedFabricRuns });
    for (let cycle = 1; cycle <= cycles; cycle++) {
      assert.equal((await runtime.newSession()).cancelled, false);
      await prompt();
      if (cycle === 1 || cycle % Math.max(1, Math.floor(cycles / 4)) === 0 || cycle === cycles) await sample(`sdk-new-session-${cycle}`, { entries: runtime.session.sessionManager.getEntryCount(), requests, completedFabricRuns });
    }
    assert.deepEqual(errors, []);
  } finally { await runtime.dispose(); }
  runtime = undefined;
  await sample("sdk-released");
}
try {
  await sample("process-baseline", { node: process.version, platform: process.platform, arch: process.arch, mode, requestedMiB: mib });
  const core = await import("@earendil-works/pi-coding-agent");
  await sample("core-imported", { coreVersion: core.VERSION });
  const fixture = makeFixture();
  await sample("fixture-written", { fixtureBytes: fixture.bytes, fixtureMiB: toMiB(fixture.bytes), fixtureEntries: fixture.count, ...(fixture.archiveBytes ? { archiveMiB: toMiB(fixture.archiveBytes) } : {}) });
  if (mode === "manager" || mode === "paged" || mode === "checkpoint") await runManager(core, fixture); else await runSdk(core, fixture);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
