import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION, type ExtensionAPI, type ToolCallEvent, type ToolLoadout } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { fabricToolLoadout } from "../src/core/tool-ownership.js";

// No compiled Fabric, capture patch, or context_with_system fallback: this
// witnesses the public 1.1 prepareLoadout/exposure/executeTool contract itself.
it("uses native prepareLoadout to hide historical and late declarations without removing callable tools", async () => {
  expect(VERSION).toBe("1.5.0");
  const cwd = await mkdtemp(path.join(os.tmpdir(), "fabric-pi1-public-"));
  const settingsManager = SettingsManager.inMemory({ defaultProjectTrust: "never", compaction: { enabled: false }, retry: { enabled: false } });
  let api!: ExtensionAPI;
  let exclusive = false, emitCall = false, executions = 0;
  const requests: string[][] = [], loadouts: ToolLoadout[] = [], events: ToolCallEvent[] = [];
  const fixture = (name: string, exposure: "direct" | "deferred" | "hidden" = "direct") => ({
    name, exposure, label: name, description: name, promptGuidelines: [`guideline:${name}`], parameters: Type.Object({ value: Type.String() }),
    outputSchema: Type.Object({ value: Type.String() }),
    async execute(_id: string, args: { value: string }) {
      executions++;
      return { content: [{ type: "text" as const, text: args.value }], structuredContent: { value: args.value }, details: {} };
    },
  });
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    extensionFactories: [(pi) => {
      api = pi;
      pi.registerTool(fixture("fixture_direct"));
      pi.registerTool(fixture("fixture_deferred", "deferred"));
      pi.registerTool(fixture("fixture_hidden", "hidden"));
      pi.registerTool({
        name: "fabric_exec", exposure: "model-only", label: "Public orchestrator", description: "Public orchestrator", parameters: Type.Object({}),
        prepareLoadout(loadout) { loadouts.push(loadout); return fabricToolLoadout(loadout, exclusive); },
        async execute(_id, _args, _signal, _onUpdate, ctx) {
          expect(ctx.tools.map(t => t.name)).toEqual(expect.arrayContaining(["fixture_direct", "fixture_deferred", "fixture_late"]));
          expect(ctx.tools.map(t => t.name)).not.toContain("fabric_exec");
          expect(ctx.tools.map(t => t.name)).not.toContain("fixture_hidden");
          const result = await ctx.executeTool("fixture_deferred", { value: "rewrite" });
          expect(result.result.structuredContent).toEqual({ value: "redacted" });
          expect(result.result.content).toEqual([{ type: "text", text: "redacted" }]);
          expect(result.isError).toBe(false);
          expect((await ctx.executeTool("fixture_hidden", { value: "x" })).isError).toBe(true);
          expect((await ctx.executeTool("fabric_exec", {})).isError).toBe(true);
          return { content: [{ type: "text", text: "nested-ok" }], details: {} };
        },
      });
      pi.on("tool_call", event => { events.push(event); if (event.toolName === "fixture_deferred") event.input.value = "rewritten"; });
      pi.on("tool_result", event => {
        if (event.toolName === "fixture_deferred") {
          expect(event.input.value).toBe("rewritten");
          return { content: [{ type: "text", text: "redacted" }], structuredContent: { value: "redacted" } };
        }
      });
      pi.registerProvider("offline-public", {
        api: "offline-public", apiKey: "offline", baseUrl: "http://invalid.local",
        models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2048 }],
        streamSimple(model, context) {
          const tools = getCurrentTools(context.messages);
          requests.push(tools.map(t => t.name));
          if (exclusive) {
            expect(tools.find(t => t.name === "fabric_exec")?.description).toContain("guideline:fixture_deferred");
            expect(tools.find(t => t.name === "fabric_exec")?.description).not.toContain("guideline:fixture_hidden");
          }
          const call = emitCall; emitCall = false;
          const message: AssistantMessage = {
            role: "assistant", content: call ? [{ type: "toolCall", id: "public-outer", name: "fabric_exec", arguments: {} }] : [{ type: "text", text: "done" }],
            api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: call ? "toolUse" : "stop",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: call ? "toolUse" : "stop", message }); stream.end(); return stream;
        },
      });
    }],
  });
  try {
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null, modelsStorePath: path.join(cwd, "models.json"), refreshOnCreate: false });
    const { session } = await createAgentSession({ cwd, agentDir: cwd, settingsManager, modelRuntime, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd) });
    try {
      await session.bindExtensions({});
      await session.setModel(modelRuntime.getModel("offline-public", "fixture")!);
      await session.prompt("Record a non-exclusive historical loadout.");
      expect(requests.at(-1)).toContain("fixture_direct");
      exclusive = true;
      api.registerTool(fixture("fixture_late"));
      api.setActiveTools(["fabric_exec", "fixture_direct", "fixture_late", "fixture_deferred"]);
      expect(api.getActiveTools()).toContain("fixture_direct");
      expect(api.getAllTools().find(t => t.name === "fixture_hidden")?.exposure).toBe("hidden");
      emitCall = true;
      await session.prompt("Hide declarations but retain native callable dispatch.");
      expect(requests.slice(1)).toEqual([["fabric_exec"], ["fabric_exec"]]);
      expect(loadouts.at(-1)?.registered.map(t => t.name)).toContain("fixture_late");
      expect(loadouts.at(-1)?.getPromptGuidelines("fixture_late")).toEqual(["guideline:fixture_late"]);
      expect(executions).toBe(1);
      expect(events.some(e => e.toolName === "fixture_deferred" && e.parentToolCallId === "public-outer")).toBe(true);
      expect([...session.messages].reverse().find(m => m.role === "toolResult" && m.toolName === "fabric_exec")).toMatchObject({ isError: false, nestedCalls: { calls: expect.arrayContaining([expect.objectContaining({ name: "fixture_deferred" })]) } });
      exclusive = false;
      api.setActiveTools(["fabric_exec", "fixture_direct", "fixture_late"]);
      await session.prompt("Restore the native optional loadout.");
      expect(requests.at(-1)?.slice().sort()).toEqual(["fabric_exec", "fixture_direct", "fixture_late"]);
    } finally { session.dispose(); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
}, 30_000);
