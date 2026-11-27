import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type CacheWarmingMode,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { FabricShellJobStore } from "../src/core/shell-jobs.js";
import { ShellEventInbox, SHELL_MESSAGE_TYPE } from "../src/core/shell-inbox.js";

type Options = { mode?: CacheWarmingMode; delivery?: "ui" | "wake" };
type Request = { warm: boolean; messages: unknown[]; maxRetries: number | undefined };
type Fixture = {
  session: AgentSession;
  sessionManager: SessionManager;
  job: ReturnType<FabricShellJobStore["begin"]>;
  requests: Request[];
};

// Exercise Pi's actual scheduler, request replay, extension dispatch and receipts.
// The provider is offline; only native timeouts and the clock are advanced.
const withWarmer = async (options: Options, check: (fixture: Fixture) => Promise<void>) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "fabric-shell-cache-sdk-"));
  const jobs = new FabricShellJobStore(cwd);
  let inbox: ShellEventInbox | undefined;
  const requests: Request[] = [], errors: unknown[] = [];
  const settingsManager = SettingsManager.inMemory({
    defaultProjectTrust: "never", compaction: { enabled: false }, retry: { enabled: false },
    ...(options.mode ? { cacheWarming: options.mode } : {}),
  });
  const sessionManager = SessionManager.inMemory(cwd);
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    extensionFactories: [pi => {
      pi.on("session_start", (_event, ctx) => { inbox = new ShellEventInbox(pi, ctx, jobs); });
      pi.registerProvider("offline-shell-cache", {
        api: "offline-shell-cache", apiKey: "offline", baseUrl: "http://invalid.local",
        models: [{
          id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
          cost: { input: 10, output: 10, cacheRead: 1, cacheWrite: 10 },
          promptCache: { short: 300 }, contextWindow: 128000, maxTokens: 4096,
        }],
        streamSimple(model, context, streamOptions) {
          requests.push({ warm: streamOptions?.maxTokens === 1, messages: context.messages, maxRetries: streamOptions?.maxRetries });
          const message: AssistantMessage = {
            role: "assistant", content: [{ type: "text", text: "Waiting for the background result." }],
            api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
            usage: {
              input: 0, output: 1, cacheRead: 50000, cacheWrite: 0, totalTokens: 50001,
              cost: { input: 0, output: 0.00001, cacheRead: 0.05, cacheWrite: 0, total: 0.05001 },
            },
          };
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
          stream.end(); return stream;
        },
      });
    }],
  });
  try {
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null, modelsStorePath: path.join(cwd, "models.json"), refreshOnCreate: false });
    const { session } = await createAgentSession({ cwd, agentDir: cwd, settingsManager, modelRuntime, resourceLoader: loader, sessionManager, tools: [] });
    try {
      await session.bindExtensions({ onError: error => errors.push(error) });
      await session.setModel(modelRuntime.getModel("offline-shell-cache", "fixture")!);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const job = jobs.begin("bash", "controlled background task", options.delivery ? { monitor: { delivery: options.delivery, intervalMs: 1000, timeoutMs: 1800000 } } : {});
      job.spill();
      await session.prompt("Wait for the detached result.");
      expect(session.isIdle).toBe(true);
      expect(requests).toHaveLength(1);
      await check({ session, sessionManager, job, requests });
      expect(errors).toEqual([]);
    } finally {
      inbox?.close(); await jobs.close(); session.dispose(); vi.useRealTimers();
    }
  } finally {
    inbox?.close(); await jobs.close(); vi.useRealTimers();
    await rm(cwd, { recursive: true, force: true });
  }
};

const refreshes = (requests: Request[]) => requests.filter(request => request.warm);

describe("spilled shell cache warming with the real Pi SDK", () => {
  it("replays the native request at 270s, records paid usage, then resumes the owner once", async () => {
    await withWarmer({ mode: "idle" }, async ({ session, sessionManager, job, requests }) => {
      expect(session.cacheWarmingStatus?.decision).toMatchObject({ phase: "idle", action: "stop", continuationProbability: 0.15 });
      await vi.advanceTimersByTimeAsync(269999);
      expect(refreshes(requests)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(refreshes(requests)).toHaveLength(1);
      expect(requests[1]).toMatchObject({ warm: true, messages: requests[0]!.messages, maxRetries: 0 });
      expect(sessionManager.getBranch().filter(entry => entry.type === "usage" && entry.kind === "cache_warm")).toHaveLength(1);
      expect(session.messages.filter(message => message.role === "assistant")).toHaveLength(1);
      await job.finish(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(session.isIdle).toBe(true);
      expect(requests.filter(request => !request.warm)).toHaveLength(2);
      expect(session.messages.filter(message => message.role === "custom" && message.customType === SHELL_MESSAGE_TYPE)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(270000);
      expect(refreshes(requests)).toHaveLength(1);
      expect(session.cacheWarmingStatus?.state).toBe("inactive");
      // Pi may fence the completed request before reaching the next economic
      // decision. Neither safe stop may send another paid refresh.
      expect(["expected savings below threshold", "conversation context changed"]).toContain(session.cacheWarmingStatus?.reason);
    });
  });

  it.each([
    { label: "the streaming policy", options: { mode: "streaming" } },
    { label: "warming disabled", options: { mode: "off" } },
    { label: "UI-only monitors", options: { mode: "idle", delivery: "ui" } },
  ] satisfies Array<{ label: string; options: Options }>)("does not send paid refreshes for $label", async ({ options }) => {
    await withWarmer(options, async ({ sessionManager, requests }) => {
      await vi.advanceTimersByTimeAsync(270000);
      expect(requests).toHaveLength(1);
      expect(sessionManager.getBranch().filter(entry => entry.type === "usage" && entry.kind === "cache_warm")).toHaveLength(0);
    });
  });

  it("cannot extend Pi's 30-minute safety window even while the shell stays live", async () => {
    await withWarmer({ mode: "idle" }, async ({ session, job, requests }) => {
      await vi.advanceTimersByTimeAsync(30 * 60000);
      expect(job.finished).toBe(false);
      expect(refreshes(requests)).toHaveLength(6);
      expect(session.cacheWarmingStatus).toMatchObject({ state: "inactive", reason: "30-minute idle safety limit reached" });
      await vi.advanceTimersByTimeAsync(60 * 60000);
      expect(refreshes(requests)).toHaveLength(6);
    });
  });
});
