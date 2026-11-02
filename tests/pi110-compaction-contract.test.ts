import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { buildSessionContext as hostBuildSessionContext, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { compileFabricSummary, rawContextTokens, registerCompactionHook } from "../src/compaction/hook.js";
import { observedCompactionOwner } from "../src/compaction/owner.js";
import { buildSessionContext } from "../src/core/session-context.js";
import { fabricToolLoadout } from "../src/core/tool-ownership.js";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], api: "offline-compact", provider: "offline-compact", model: "fixture", stopReason: "stop", timestamp: 1, usage });

it("matches native edited projections/checkpoints and never resurrects omissions across repeated compaction", () => {
  expect(VERSION).toBe("1.5.0");
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "system", content: "", sections: { preamble: "initial" }, toolsAdded: [{ name: "read", description: "original", parameters: {} }], timestamp: 1 });
  manager.appendMessage({ role: "user", content: "Keep this task", timestamp: 1 });
  const attempt = manager.appendMessage(assistant("OMITTED_ATTEMPT ".repeat(4000)));
  const answer = manager.appendMessage(assistant("STALE_ANSWER"));
  const beforeEdits = manager.getLeafId()!;
  manager.appendContextEdit(attempt, null);
  manager.appendContextEdit(answer, { content: "CURRENT_ANSWER" });
  const compare = () => expect(buildSessionContext(manager.getEntries(), manager.getLeafId()!)).toEqual(manager.buildSessionContext());
  compare();
  expect(buildSessionContext(manager.getEntries(), beforeEdits)).toEqual(hostBuildSessionContext(manager.getEntries(), beforeEdits));
  const raw = JSON.stringify(manager.getEntries());
  const first = compileFabricSummary(manager.getBranch(), rawContextTokens(manager.getBranch()));
  if (!("compaction" in first)) throw new Error(first.reason);
  expect(first.compaction.summary).toContain("CURRENT_ANSWER");
  expect(first.compaction.summary).not.toMatch(/OMITTED_ATTEMPT|STALE_ANSWER/);
  expect(JSON.stringify(manager.getEntries())).toBe(raw);
  manager.appendCompaction(first.compaction.summary, first.compaction.firstKeptEntryId, first.compaction.tokensBefore, first.compaction.details, true);
  compare();
  expect(observedCompactionOwner(manager.getBranch())).toBe("fabric");
  manager.appendMessage({ role: "system", content: "", sections: { preamble: "updated" }, toolsAdded: [{ name: "fabric_exec", description: "current", parameters: {} }], timestamp: 2 });
  manager.appendMessage({ role: "user", content: "Continue", timestamp: 2 });
  manager.appendMessage(assistant("Later result"));
  const second = compileFabricSummary(manager.getBranch(), rawContextTokens(manager.getBranch()));
  if (!("compaction" in second)) throw new Error(second.reason);
  expect(second.compaction.summary).not.toMatch(/OMITTED_ATTEMPT|STALE_ANSWER/);
  manager.appendCompaction(second.compaction.summary, second.compaction.firstKeptEntryId, second.compaction.tokensBefore, second.compaction.details, true);
  compare();
  expect(manager.buildSessionContext().messages.filter(m => m.role === "compactionSummary")).toHaveLength(1);
  expect(manager.buildSessionContext().messages[0]).toMatchObject({ role: "system", sections: { preamble: "updated" } });
});

it.each(["fabric", "external"] as const)("uses native overflow recovery, replay and ownership (%s)", async owner => {
  expect(VERSION).toBe("1.5.0");
  const cwd = await mkdtemp(path.join(os.tmpdir(), "fabric-pi110-compact-"));
  const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
  const settingsManager = SettingsManager.inMemory({ defaultProjectTrust: "never", compaction: { enabled: true, keepRecentTokens: 1000, reserveTokens: 1000 }, retry: { enabled: false } });
  const requests: unknown[][] = [], reasons: string[] = [];
  let fail = false;
  let api!: ExtensionAPI;
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    extensionFactories: [pi => {
      api = pi;
      pi.registerTool({ name: "fabric_exec", exposure: "model-only", label: "Fixture", description: "Fixture", parameters: Type.Object({}), prepareLoadout: loadout => fabricToolLoadout(loadout, true), async execute() { return { content: [], details: undefined }; } });
      registerCompactionHook(pi, { getEngine: () => "fabric", getTargetContextRatio: () => 0.65 });
      pi.on("session_before_compact", event => {
        reasons.push(event.reason);
        if (owner === "external") return { compaction: { summary: "external-summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
      });
      pi.registerProvider("offline-compact", {
        api: "offline-compact", apiKey: "offline", baseUrl: "http://invalid.local",
        models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2048 }],
        streamSimple(model, context) {
          requests.push(context.messages);
          expect(getCurrentTools(context.messages).map(t => t.name)).toEqual(["fabric_exec"]);
          const input = Math.ceil(JSON.stringify(context.messages).length / 4);
          // Native cut selection retains the entry that crosses its token
          // budget. Use a large historical assistant (not one huge first user
          // with no summarizable prefix), so preparation reaches our hook.
          const text = fail ? "ABANDONED_ATTEMPT" : requests.length === 1 ? "Historical result " + "context ".repeat(10000) : "done";
          const output = Math.ceil(text.length / 4);
          const message = { ...assistant(text), api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: { ...usage, input, output, totalTokens: input + output } };
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "start", partial: message });
          if (fail) {
            fail = false;
            message.stopReason = "error";
            message.errorMessage = "This endpoint's maximum context length is 16384 tokens. However, you requested 20000 tokens.";
            stream.push({ type: "error", reason: "error", error: message });
          } else stream.push({ type: "done", reason: "stop", message });
          stream.end(); return stream;
        },
      });
    }],
  });
  try {
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null, modelsStorePath: path.join(cwd, "models.json"), refreshOnCreate: false });
    const options = { cwd, agentDir: cwd, settingsManager, modelRuntime, resourceLoader: loader, sessionManager: manager };
    const { session } = await createAgentSession(options);
    try {
      await session.bindExtensions({});
      await session.setModel(modelRuntime.getModel("offline-compact", "fixture")!);
      await session.prompt("Historical task with a large assistant response.");
      expect(settingsManager.getCompactionSettings(session.model!).enabled).toBe(true);
      fail = true;
      await session.prompt("Recover without resurrecting the abandoned provider attempt.");
      expect(reasons, JSON.stringify({ requests: requests.length, model: session.model?.provider, settings: settingsManager.getCompactionSettings(session.model!), types: manager.getBranch().map(e => e.type), assistants: manager.getBranch().filter(e => e.type === "message" && e.message.role === "assistant") })).toContain("overflow");
      expect(requests).toHaveLength(3);
      expect(JSON.stringify(requests.at(-1))).not.toContain("ABANDONED_ATTEMPT");
      expect(manager.getBranch().some(e => e.type === "context_edit" && e.replacement === null)).toBe(true);
      expect(JSON.stringify(manager.getEntries())).toContain("ABANDONED_ATTEMPT");
      expect(observedCompactionOwner(manager.getBranch())).toBe(owner);
      const compact = [...manager.getBranch()].reverse().find(e => e.type === "compaction");
      expect(compact).toMatchObject({ fromHook: true, systemMessage: { role: "system" } });
      expect(buildSessionContext(manager.getBranch())).toEqual(manager.buildSessionContext());
      api.setActiveTools(["fabric_exec", "read"]);
    } finally { session.dispose(); }
    const restored = SessionManager.open(manager.getSessionFile()!);
    expect(observedCompactionOwner(restored.getBranch())).toBe(owner);
    expect(restored.buildSessionContext()).toEqual(manager.buildSessionContext());
    const { session: resumed } = await createAgentSession({ ...options, sessionManager: restored });
    try {
      await resumed.bindExtensions({});
      await resumed.prompt("Resume from the persisted compacted branch.");
      expect(JSON.stringify(requests.at(-1))).not.toContain("ABANDONED_ATTEMPT");
      expect(observedCompactionOwner(restored.getBranch())).toBe(owner);
    } finally { resumed.dispose(); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
}, 30000);
