import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { PEER_PRESENCE_MESSAGE_TYPE, PeerPresenceNotifier } from "../src/topology/peer-presence.js";
import type { FabricPeerInfo } from "../src/topology/types.js";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const peer = (label: string): FabricPeerInfo => ({
  id: `session:${label}`, name: label, label, kind: "peer", status: "running", runner: "pi", transport: "host",
  cwd: "/repo", sessionId: label, startedAt: 1, updatedAt: 2, pendingMessages: false, local: false,
});

describe("peer presence with the real Pi SDK", () => {
  it("appends a mid-run notice to the request already owed and keeps every earlier request a prefix", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "fabric-presence-sdk-"));
    let peers: FabricPeerInfo[] = [];
    let notifier: PeerPresenceNotifier | undefined;
    const requests: string[][] = [];
    const errors: unknown[] = [];
    const notify = vi.fn();
    const settingsManager = SettingsManager.inMemory({
      defaultProjectTrust: "never", compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      extensionFactories: [pi => {
        pi.on("session_start", (_event, ctx) => {
          notifier = new PeerPresenceNotifier(pi, ctx, { peers: () => peers, enabled: () => true, cwd: "/repo" });
        });
        pi.registerTool({
          name: "work", label: "Work", description: "Fixture work", parameters: Type.Object({}),
          async execute() {
            // Another session joins the project while this tool call runs.
            peers = [peer("FAB-2")];
            return { content: [{ type: "text", text: "worked" }], details: undefined };
          },
        });
        pi.registerProvider("offline-presence", {
          api: "offline-presence", apiKey: "offline", baseUrl: "http://invalid.local",
          models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
          streamSimple(model, context) {
            requests.push(context.messages.map(message => JSON.stringify(message)));
            const callsTool = requests.length === 1;
            const message: AssistantMessage = {
              role: "assistant",
              content: callsTool
                ? [{ type: "toolCall", id: "call-1", name: "work", arguments: {} }]
                : [{ type: "text", text: "Done." }],
              api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now(),
              stopReason: callsTool ? "toolUse" : "stop",
            };
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: callsTool ? "toolUse" : "stop", message });
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
        // A bound UI context is what makes hasUI true; print mode binds none.
        await session.bindExtensions({ uiContext: { notify } as never, onError: error => errors.push(error) });
        await session.setModel(modelRuntime.getModel("offline-presence", "fixture")!);
        await session.prompt("Do the work.");
        await session.waitForIdle();
        // The tool turn owed one more request; the notice rode it and forced none.
        expect(requests).toHaveLength(2);
        // The transcript carries the system prompt, so a prefix match covers it too.
        expect(JSON.parse(requests[0]![0]!)).toMatchObject({ role: "system" });
        expect(requests[0]!.join("\n")).not.toContain("fabric-peers");
        expect(requests[1]!.slice(0, requests[0]!.length)).toEqual(requests[0]);
        expect(requests[1]!.at(-1)).toContain("FAB-2 (id session:FAB-2)");
        expect(requests[1]!.at(-2)).toContain("worked");

        await session.prompt("Anything else?");
        await session.waitForIdle();
        expect(requests).toHaveLength(3);
        // Unchanged peers add nothing, and the earlier notice is replayed byte-for-byte.
        expect(requests[2]!.slice(0, requests[1]!.length)).toEqual(requests[1]);
        expect(requests[2]!.filter(message => message.includes("fabric-peers"))).toHaveLength(1);
        const notices = session.messages.filter(message => message.role === "custom" && message.customType === PEER_PRESENCE_MESSAGE_TYPE);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({ display: false });
        expect(notify).toHaveBeenCalledWith("Fabric peers: joined FAB-2; 1 active", "info");
        expect(notify).toHaveBeenCalledTimes(1);
        expect(errors).toEqual([]);
      } finally {
        notifier?.close();
        session.dispose();
      }
    } finally {
      notifier?.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15000);
});
