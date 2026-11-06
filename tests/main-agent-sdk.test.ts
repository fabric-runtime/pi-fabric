import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { MainAgentController } from "../src/main-agent.js";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const text = "FEEDBACK_AT_TOOL_BOUNDARY_" + "x".repeat(20_000);
const data = { body: "FULL_STRUCTURED_DATA_" + "y".repeat(20_000) };

describe("Main feedback through the real Pi 1.5 host", () => {
  it.each(["active", "idle-passive", "idle-active", "peer-active", "peer-idle", "peer-wake"] as const)("delivers once in %s state without user impersonation", async scenario => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "fabric-feedback-sdk-"));
    let main: MainAgentController | undefined;
    const requests: unknown[][] = [], events: string[] = [], errors: unknown[] = [];
    let inputs = 0, sends = 0;
    const settingsManager = SettingsManager.inMemory({ defaultProjectTrust: "never", compaction: { enabled: false }, retry: { enabled: false } });
    const active = scenario === "active" || scenario === "peer-active";
    const peer = scenario.startsWith("peer-");
    const feedback = () => main!.deliverAgent({
      from: peer ? { id: "session:peer", name: "main", kind: "main" } : { id: "child", name: "Reviewer", kind: "agent" },
      message: text, data, delivery: "followUp",
      ...(!peer ? { triggerTurn: scenario !== "idle-passive" } : scenario === "peer-wake" ? { triggerTurn: true } : {}),
    });
    const loader = new DefaultResourceLoader({
      cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      extensionFactories: [pi => {
        pi.on("session_start", (_event, ctx) => {
          main = new MainAgentController({ ...pi, sendMessage(message, options) { sends++; pi.sendMessage(message, options); } }, "session:main", true, cwd, "main", ctx);
        });
        pi.on("input", () => { inputs++; });
        pi.on("agent_settled", () => { events.push("settled"); });
        pi.registerTool({ name: "receive_feedback", label: "Receive feedback", description: "Fixture tool", parameters: Type.Object({}), async execute() {
          events.push("tool"); feedback();
          return { content: [{ type: "text", text: "Tool finished" }], details: {} };
        } });
        pi.registerProvider("offline-feedback", {
          api: "offline-feedback", apiKey: "offline", baseUrl: "http://invalid.local",
          models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
          streamSimple(model, context) {
            requests.push(context.messages);
            events.push(`request-${requests.length}`);
            const tool = active && requests.length === 1;
            const message: AssistantMessage = {
              role: "assistant", content: tool ? [{ type: "toolCall", id: "tool-1", name: "receive_feedback", arguments: {} }] : [{ type: "text", text: "Finished." }],
              api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now(), stopReason: tool ? "toolUse" : "stop",
            };
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
            stream.end(); return stream;
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
        await session.bindExtensions({ onError: error => errors.push(error) });
        await session.setModel(modelRuntime.getModel("offline-feedback", "fixture")!);
        session.setActiveToolsByName(["receive_feedback"]);
        expect(session.getActiveToolNames()).toEqual(["receive_feedback"]);
        if (active) {
          await session.prompt("Run the fixture tool.");
          expect(events).toEqual(["request-1", "tool", "request-2", "settled"]);
          expect(requests).toHaveLength(2);
        } else {
          feedback();
          if (scenario === "idle-passive" || scenario === "peer-idle") {
            expect(session.isIdle).toBe(true);
            expect(requests).toHaveLength(0);
            await session.prompt("Read stored feedback.");
          } else {
            await vi.waitFor(() => expect(requests).toHaveLength(1));
            await session.waitForIdle();
          }
          expect(requests).toHaveLength(1);
        }
        // Only original human input traverses input hooks; no duplicate continuation.
        expect(inputs).toBe(scenario === "idle-active" || scenario === "peer-wake" ? 0 : 1);
        expect(sends).toBe(1);
        expect(JSON.stringify(requests.at(-1))).toContain(text);
        expect(JSON.stringify(requests.at(-1))).toContain(data.body);
        const messages = session.messages.filter(message => message.role === "custom" && message.customType === "pi-fabric-agent-message");
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ display: false, details: { delivery: "steer", requestedDelivery: "followUp", data } });
        const entries = session.sessionManager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === "pi-fabric-agent-message");
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ display: false, details: { data } });
        expect(errors).toEqual([]);
      } finally { session.dispose(); }
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }, 15000);
});
