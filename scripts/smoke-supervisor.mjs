// Credential-free end-to-end supervisor wiring check. Only the model is scripted:
// real SDK discovery, compiled Fabric, fabric_exec, child workers, and feedback.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = await mkdtemp(path.join(os.tmpdir(), "fabric-supervisor-isolation-"));
for (const name of Object.keys(process.env)) {
  if (name.startsWith("PI_FABRIC_") || /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(name)) delete process.env[name];
}
process.env.PI_CODING_AGENT_DIR = scratch;
const host = await import("@earendil-works/pi-coding-agent");
const goal = "Improve the fixture bot until its regression checks pass.";
const command = `/skill:fabric-supervisor ${goal}`;
const setupPath = path.join(root, "skillsets/typescript/fabric-ambient/references/setup.md");
const setupMarkdown = await readFile(setupPath, "utf8");
const setupCode = setupMarkdown.match(/```ts\r?\n([\s\S]*?)\r?\n```/)[1];
const results = [];
let active;
let requestId = 0;

function toolCall(code, payloads = {}) {
  return { role: "assistant", content: null, tool_calls: [{ id: `call_${++requestId}`, type: "function", function: {
    name: "fabric_exec", arguments: JSON.stringify({ code, payloads, display: { name: "Isolated supervisor check" } }),
  } }] };
}
function textMessage(content) { return { role: "assistant", content }; }
function contentText(message) {
  return typeof message.content === "string" ? message.content : (message.content ?? []).map(part => part.text ?? "").join("\n");
}
function answer(body) {
  assert.ok(active, "No active isolated scenario");
  const all = body.messages.map(contentText).join("\n");
  const lastUser = [...body.messages].reverse().find(message => message.role === "user");
  // Worker requests carry their actor role in the system prompt; the parent only
  // has the skill instructions in a user message.
  const isActor = body.messages.some(message => ["system", "developer"].includes(message.role) && /You are supervisor, a persistent Fabric actor/.test(contentText(message)));
  if (isActor) {
    active.actorRequests++;
    assert.match(all, /Fabric actor message from host:agent_settled/);
    assert.match(all, /Improve the fixture bot/);
    return textMessage(JSON.stringify(active.actorRequests === 1
      ? { action: "message", message: "ISOLATED_SUPERVISOR_WAKE: run the missing bot regression check." }
      : { action: "silent" }));
  }
  active.mainRequests++;
  active.prompts.push(contentText(lastUser ?? { content: "" }));
  if (all.includes("ISOLATION_INSPECT") && !all.includes("ISOLATION_STOP")) {
    if (!active.inspected) {
      active.inspected = true;
      return toolCall("const actors = await agents.actors(); const actor = actors.find(a => a.name === 'supervisor'); return { actors, messages: actor ? await agents.messages({ id: actor.id }) : [] };");
    }
    return textMessage("Inspection complete.");
  }
  if (all.includes("ISOLATION_STOP")) {
    if (!active.stopped) {
      active.stopped = true;
      return toolCall("const actors = await agents.actors(); for (const actor of actors) await agents.stop({ id: actor.id }); return { stopped: actors.length };");
    }
    return textMessage("Stopped.");
  }
  if (all.includes("ISOLATED_SUPERVISOR_WAKE")) {
    active.woken = true;
    return textMessage("Main resumed because the supervisor supplied a missing check.");
  }
  if (!active.expanded) {
    active.expanded = contentText(lastUser ?? {}).startsWith('<skill name="fabric-supervisor"');
    if (!active.expanded) return textMessage("Ordinary prompt: no expanded supervisor skill was supplied.");
    const skill = contentText(lastUser);
    assert.ok(!skill.includes("<skill-dir>"), "Compiled Fabric must expand the hard pointer");
    const pointer = skill.match(/Hard pointer: read `([^`]+)`/);
    assert.ok(pointer, "Supervisor must supply its setup hard pointer");
    assert.equal(path.resolve(pointer[1]), setupPath, "Supervisor hard pointer must select the TypeScript setup");
    active.instructions = skill.match(/```text\r?\n([\s\S]*?)\r?\n```/)[1].replace("GOAL", goal);
    return toolCall("return await pi.read({ path: π.path });", { path: setupPath });
  }
  if (!active.setupSent) {
    assert.ok(all.includes('const triggerTurn = π.triggerTurn === "true"'), "Setup must have reached the model through the real read tool");
    active.setupSent = true;
    return toolCall(setupCode, {
      name: "supervisor", instructions: active.instructions,
      events: JSON.stringify(["agent_settled", "tool_error"]), triggerTurn: "true", model: "",
    });
  }
  return textMessage("Supervisor armed.");
}
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    let raw = "";
    for await (const chunk of request) { raw += chunk; assert.ok(raw.length < 4_000_000); }
    const body = JSON.parse(raw);
    assert.ok(++active.totalRequests <= 20, "Unexpected model request loop");
    const message = answer(body);
    const finish = message.tool_calls ? "tool_calls" : "stop";
    const base = { id: `completion_${requestId}`, object: "chat.completion.chunk", created: 1, model: body.model };
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const delta = { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } : {}) };
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: finish }] }));
    }
  } catch (error) {
    if (active) active.errors.push(String(error));
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: String(error), type: "isolation_fixture" } }));
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await writeFile(path.join(scratch, "models.json"), JSON.stringify({ providers: {
  "offline-supervisor": { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "offline-dummy-not-a-secret", models: [{
    id: "fixture", name: "Offline supervisor fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false, supportsStore: false },
  }] },
} }));
await writeFile(path.join(scratch, "settings.json"), JSON.stringify({
  defaultProvider: "offline-supervisor", defaultModel: "fixture", defaultProjectTrust: "never",
  compaction: { enabled: false }, retry: { enabled: false },
}));
const fabricConfig = {
  fullCodeMode: true, approvals: { read: "allow", write: "allow", execute: "allow" },
  agents: { enabled: true, runner: "pi", transport: "process", timeoutMs: 20000 },
  mesh: { enabled: true, actorScope: "session" }, mcp: { enabled: false }, memory: { enabled: false },
  entropy: { enabled: false, compile: false }, ui: { enabled: false },
};

async function waitUntil(check, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    assert.ok(Date.now() < end, `Timed out: ${JSON.stringify(active)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
try {
  for (const scenario of ["expanded", "expanded-default-runner", "expansion-disabled", "missing-skill", "wrong-name"]) {
    const expectedRunner = scenario === "expanded-default-runner" ? "pi-durable" : "pi";
    await writeFile(path.join(scratch, "fabric.json"), JSON.stringify({
      ...fabricConfig, agents: { ...fabricConfig.agents, runner: expectedRunner },
    }));
    active = { scenario, expanded: false, mainRequests: 0, actorRequests: 0, totalRequests: 0, prompts: [], errors: [], toolResults: [] };
    const cwd = path.join(scratch, scenario);
    await mkdir(cwd);
    const settingsManager = host.SettingsManager.inMemory({ defaultProjectTrust: "never", compaction: { enabled: false }, retry: { enabled: false } });
    // The missing-skill control still loads Fabric, but deliberately withholds
    // its skill resources, as an embedding host with an incomplete catalog can.
    const loader = new host.DefaultResourceLoader({
      cwd, agentDir: scratch, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [path.join(root, "dist/index.js")], agentsFilesOverride: () => ({ agentsFiles: [] }),
      ...(scenario === "missing-skill" ? { skillsOverride: () => ({ skills: [], diagnostics: [] }) } : {}),
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const modelRuntime = await host.ModelRuntime.create({ authPath: path.join(scratch, "auth.json"), modelsPath: path.join(scratch, "models.json"), modelsStorePath: path.join(cwd, "model-cache.json"), refreshOnCreate: false });
    const { session } = await host.createAgentSession({ cwd, agentDir: scratch, settingsManager, modelRuntime, resourceLoader: loader, sessionManager: host.SessionManager.inMemory(cwd) });
    session.subscribe(event => {
      if (event.type === "tool_execution_end") active.toolResults.push({ name: event.toolName, isError: event.isError, result: event.result });
    });
    try {
      await session.bindExtensions({ onError: error => active.errors.push(error) });
      await session.setModel(modelRuntime.getModel("offline-supervisor", "fixture"));
      if (scenario === "missing-skill") assert.ok(!loader.getSkills().skills.some(skill => skill.name === "fabric-supervisor"));
      else assert.ok(loader.getSkills().skills.some(skill => skill.name === "fabric-supervisor"));
      await session.prompt(scenario === "wrong-name" ? `/skill:supervisor ${goal}` : command, { expandPromptTemplates: scenario !== "expansion-disabled" });
      if (scenario === "expanded" || scenario === "expanded-default-runner") {
        await waitUntil(() => active.woken || active.errors.length > 0);
        assert.deepEqual(active.errors, []);
        await session.waitForIdle();
        assert.ok(active.woken, "Actor feedback must start another Main request without another user prompt");
        assert.ok(active.actorRequests >= 1);
        const feedback = session.messages.filter(message => message.role === "custom" && message.customType === "pi-fabric-actor");
        assert.equal(feedback.length, 1);
        assert.equal(feedback[0].display, false);
        assert.equal(feedback[0].details.delivery.triggerTurn, true);
        assert.equal(feedback[0].details.actor.name, "supervisor");
        assert.equal(feedback[0].details.actor.runner, expectedRunner);
        await session.prompt("ISOLATION_INSPECT");
        const inspection = active.toolResults.at(-1);
        assert.equal(inspection.isError, false, JSON.stringify(inspection));
        assert.match(JSON.stringify(inspection.result), /agent_settled/);
        assert.match(JSON.stringify(inspection.result), /tool_error/);
        assert.match(JSON.stringify(inspection.result), /ISOLATED_SUPERVISOR_WAKE/);
        await session.prompt("ISOLATION_STOP");
        assert.equal(active.toolResults.at(-1).isError, false, JSON.stringify(active.toolResults.at(-1)));
      } else {
        assert.equal(active.expanded, false);
        assert.equal(active.mainRequests, 1);
        assert.equal(active.actorRequests, 0);
        assert.equal(active.toolResults.length, 0);
        assert.match(session.getLastAssistantText(), /Ordinary prompt/);
      }
      assert.deepEqual(active.errors, []);
      assert.ok(active.toolResults.every(result => !result.isError), JSON.stringify(active.toolResults));
      results.push({ scenario, expanded: active.expanded, mainRequests: active.mainRequests, actorRequests: active.actorRequests, wokeMain: Boolean(active.woken), toolErrors: active.toolResults.filter(result => result.isError).length });
    } finally {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
      session.dispose();
    }
  }
  console.log(JSON.stringify({ version: host.VERSION, model: "scripted-localhost", compiledExtension: true, realWorkers: true, scenarios: results }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
