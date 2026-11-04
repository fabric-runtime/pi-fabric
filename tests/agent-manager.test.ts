import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { AGENTS_ACTION_DESCRIPTORS } from "../src/providers/agents-actions.js";
import { EXACT_MODEL_FORM_ERROR, EXACT_MODEL_RUNNER_ERROR } from "../src/core/model-resolution.js";
import { modelPinFailure } from "../src/agents/model-pin.js";
import type { FabricLifecyclePublishRequest } from "../src/lifecycle/types.js";
import { snapshotHandoffSession } from "../src/agents/handoff.js";
import {
  effectiveAgentTimeoutMs,
  AgentManager,
} from "../src/agents/manager.js";
import {
  clearOwnedBudgetEnv,
  readBudgetLedgerDetailed,
} from "../src/agents/budget-ledger.js";
import type { AgentRunRecord, AgentRunResult } from "../src/agents/types.js";

const managers: AgentManager[] = [];
const roots: string[] = [];
type FabricSurfaceResult = AgentRunResult & {
  fullCodeMode?: string;
  tools?: string[];
  extensions?: string;
  mainAgentId?: string;
  fabricExtension?: string;
  grantedRisks?: string[];
};
const handoffSeed = (fact = "Rare handoff fact 43117") => {
  const source = SessionManager.inMemory();
  source.appendMessage({ role: "user", content: fact, timestamp: 1 });
  source.appendModelChange("anthropic", "frontier");
  source.appendThinkingLevelChange("high");
  source.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "Ready to continue from the fork." },
      {
        type: "toolCall",
        id: "outer-manager-handoff",
        name: "fabric_exec",
        arguments: { code: "return agents.handoff(...)" },
      },
    ],
    api: "anthropic",
    provider: "anthropic",
    model: "frontier",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  });
  return snapshotHandoffSession(
    source,
    { provider: "anthropic", id: "frontier" },
    {
      role: "toolResult",
      toolCallId: "outer-manager-handoff",
      toolName: "fabric_exec",
      content: [{ type: "text", text: "Manager boundary complete" }],
      details: { success: true },
      isError: false,
      timestamp: 3,
    },
    "outer-manager-handoff",
  );
};
const fabricEnvKeys = [
  "PI_FABRIC_DEPTH",
  "PI_FABRIC_BUDGET",
  "PI_FABRIC_BUDGET_FILE",
  "PI_FABRIC_BUDGET_ID",
] as const;
const inheritedFabricEnv = new Map(
  fabricEnvKeys.map((key) => [key, process.env[key]]),
);

beforeAll(() => {
  for (const key of fabricEnvKeys) delete process.env[key];
});

afterAll(() => {
  for (const [key, value] of inheritedFabricEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("effectiveAgentTimeoutMs", () => {
  it("ignores per-call timeouts below the configured default", () => {
    expect(effectiveAgentTimeoutMs(3_600_000, 240_000)).toBe(3_600_000);
  });

  it("accepts per-call timeouts above the configured default", () => {
    expect(effectiveAgentTimeoutMs(3_600_000, 7_200_000)).toBe(7_200_000);
  });

  it("respects a configured default below 60 minutes", () => {
    expect(effectiveAgentTimeoutMs(1_800_000, 900_000)).toBe(1_800_000);
    expect(effectiveAgentTimeoutMs(1_800_000, 2_400_000)).toBe(2_400_000);
  });
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentManager", () => {
  it("notifies and releases UI subscribers", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const listener = vi.fn();
    const unsubscribe = manager.subscribeUi(listener);

    const result = await manager.run({ task: "Observe state", transport: "process" });
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    const beforeCleanup = listener.mock.calls.length;
    await manager.cleanup(result.id);
    expect(listener).toHaveBeenCalledTimes(beforeCleanup);
  });

  it("lists unsettled runs as activity and notifies when one settles", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    expect(manager.activity()).toEqual([]);
    const done = await manager.run({ task: "Finish at once", transport: "process" });
    expect(done.status).toBe("completed");
    expect(manager.activity()).toEqual([]);
    const listener = vi.fn();
    manager.subscribeUi(listener);
    const handle = await manager.spawn({ name: "scout", task: "HANG", transport: "process" });
    expect(manager.activity()).toEqual([{ id: handle.id, name: "scout" }]);
    listener.mockClear();
    await manager.stop(handle.id);
    expect(listener).toHaveBeenCalled();
    expect(manager.activity()).toEqual([]);
  });

  it("runs a worker through the direct process transport", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Inspect this repository", transport: "process" });
    expect(result.status).toBe("completed");
    expect((result as AgentRunResult & { fullCodeMode?: string }).fullCodeMode).toBe("false");
    expect(result.text).toBe("fake worker complete");
    expect(result.transport).toBe("process");
    expect(manager.list()).toHaveLength(1);
    fs.rmSync(path.join(manager.runDirectory(result.id)!, "status.json"));
    expect(manager.status(result.id).status).toBe("completed");
  });

  it.each([{ extensions: true, recursive: false }, { extensions: true, recursive: true }, { extensions: false, recursive: false }])(
    "tells a participant its owning Main peer (%j)", async ({ extensions, recursive }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-identity-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"), runRoot: root,
      mainAgentId: "session:owning-peer", identityId: "launching-agent",
    });
    managers.push(manager);
    const result = await manager.run({ task: "Identify your coordinator", transport: "process", extensions, recursive,
      systemPrompt: "Keep the preview safe." }) as AgentRunResult & { systemPrompt?: string };
    expect(result.systemPrompt).toContain("Keep the preview safe.");
    expect(result.systemPrompt).toContain("Your owning Main peer (lineage root): session:owning-peer");
    expect(result.systemPrompt).not.toContain(result.id);
    if (extensions) {
      expect(result.systemPrompt).toContain("agents.self()");
      expect(result.systemPrompt).toContain("agents.main()");
      expect(result.systemPrompt).toContain('id: "main"');
      expect(result.systemPrompt).toContain("not another peer's Main");
    } else {
      expect(result.systemPrompt).not.toContain("agents.steer");
      expect(result.systemPrompt).toContain("host delivers");
    }
  });

  it("adds component guidance to direct participants without duplicating recursive guidance", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const resolveParticipantGuidance = vi.fn(({ model }: { model?: string }) =>
      model === "deepseek/deepseek-chat" ? "DeepSeek participant guidance" : undefined);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      resolveParticipantGuidance,
    });
    managers.push(manager);

    const direct = await manager.run({
      task: "Direct guided participant",
      transport: "process",
      model: "deepseek/deepseek-chat",
      systemPrompt: "Actor role prompt",
    });
    expect((direct as AgentRunResult & { systemPrompt?: string }).systemPrompt).toBe(
      "Actor role prompt\n\nDeepSeek participant guidance",
    );
    expect(resolveParticipantGuidance).toHaveBeenCalledWith({
      model: "deepseek/deepseek-chat",
      runner: "pi-durable",
    });

    const secondDirect = await manager.run({
      task: "Different task, same guided participant",
      transport: "process",
      model: "deepseek/deepseek-chat",
      systemPrompt: "Actor role prompt",
    });
    expect((secondDirect as AgentRunResult & { systemPrompt?: string }).systemPrompt).toBe(
      (direct as AgentRunResult & { systemPrompt?: string }).systemPrompt,
    );

    resolveParticipantGuidance.mockClear();
    const recursive = await manager.run({
      task: "Recursive participant",
      transport: "process",
      model: "deepseek/deepseek-chat",
      recursive: true,
      systemPrompt: "Recursive role prompt",
    });
    expect((recursive as AgentRunResult & { systemPrompt?: string }).systemPrompt).toBe(
      "Recursive role prompt",
    );
    expect(resolveParticipantGuidance).not.toHaveBeenCalled();
  });

  it("relays child Pi lifecycle records and a normalized terminal event", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const lifecycle: FabricLifecyclePublishRequest[] = [];
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      mainAgentId: "session:root",
      hostId: "host:root",
      identityId: "session:root",
      onLifecycle: (event) => lifecycle.push(event),
    });
    managers.push(manager);

    const result = await manager.run({ task: "Observe lifecycle", transport: "process" });

    expect(lifecycle.map((event) => event.event)).toEqual([
      "pi.agent_start",
      "pi.turn_end",
      "pi.agent_end",
      "pi.agent_settled",
      "run.completed",
    ]);
    expect(lifecycle.at(-1)).toMatchObject({
      source: {
        id: result.id,
        kind: "agent",
        rootId: "session:root",
        ownerHostId: "host:root",
        ownerIdentityId: "session:root",
      },
      runId: result.id,
      status: "completed",
    });
    expect(lifecycle.find((event) => event.event === "pi.turn_end")?.data).toEqual({
      turnIndex: 0,
    });
  });

  it("materializes a private Pi session for a trajectory handoff seed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const handle = await manager.spawn({
      task: "HANG while the handoff session is inspected",
      runner: "pi",
      transport: "process",
      model: "anthropic/executor",
      sessionSeed: handoffSeed(),
    });
    const handoffDirectory = path.join(manager.runDirectory(handle.id)!, "handoff-session");
    const [sessionName] = fs.readdirSync(handoffDirectory);
    expect(sessionName).toBeDefined();
    const session = SessionManager.open(path.join(handoffDirectory, sessionName!));
    expect(session.buildSessionContext()).toMatchObject({
      messages: [
        { role: "user", content: "Rare handoff fact 43117" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Ready to continue from the fork." },
            { type: "toolCall", id: "outer-manager-handoff", name: "fabric_exec" },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "outer-manager-handoff",
          toolName: "fabric_exec",
          content: [{ type: "text", text: "Manager boundary complete" }],
        },
      ],
      model: { provider: "anthropic", modelId: "frontier" },
      thinkingLevel: "high",
    });
    await manager.stop(handle.id);
  });

  it("passes prepared destination settings only to compacted handoffs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-budget-"));
    roots.push(root);
    const resolveBudget = vi.fn(async () => ({ contextWindow: 50_000, targetContextRatio: 0.5, reserveTokens: 5000, keepRecentTokens: 1000 }));
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"), runRoot: root,
      preparePiModel: async () => "anthropic/resolved-target",
      resolveHandoffCompactionBudget: resolveBudget,
    });
    managers.push(manager);
    const handle = await manager.spawn({ task: "HANG", model: "alias", sessionSeed: handoffSeed(`Fact ${"x".repeat(60_000)}`), handoffCompact: {} });
    expect(resolveBudget).toHaveBeenCalledExactlyOnceWith("anthropic/resolved-target", process.cwd());
    const directory = path.join(manager.runDirectory(handle.id)!, "handoff-session");
    const child = SessionManager.open(path.join(directory, fs.readdirSync(directory)[0]!));
    expect(child.getBranch().find(e => e.type === "compaction")).toMatchObject({ details: { budget: { contextWindow: 50_000, keepRecentTokens: 1000 } } });
    await manager.stop(handle.id);
    const plain = await manager.spawn({ task: "HANG", model: "alias", sessionSeed: handoffSeed() });
    expect(resolveBudget).toHaveBeenCalledTimes(1);
    await manager.stop(plain.id);
  });

  it("rejects trajectory seeds for the Claude runner and conflicting session files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const sessionSeed = handoffSeed("Invalid seed");
    await expect(
      manager.spawn({ task: "invalid", runner: "claude", sessionSeed }),
    ).rejects.toThrow(/only supported by the Pi runner/);
    await expect(
      manager.spawn({
        task: "invalid",
        runner: "pi",
        sessionSeed,
        sessionFile: path.join(root, "existing.jsonl"),
      }),
    ).rejects.toThrow(/cannot combine sessionSeed with sessionFile/);
  });

  it("does not let same-provider preparation authorize a different model", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const preparePiModel = vi.fn(async (model: string | undefined) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (model === "openai-codex/gpt-hidden") {
        throw new Error(`Model ${JSON.stringify(model)} is not available to this Pi session`);
      }
      return model;
    });
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      preparePiModel,
    });
    managers.push(manager);

    const [visible, hidden] = await Promise.allSettled([
      manager.run({
        task: "Visible prepared child",
        model: "openai-codex/gpt-visible",
        transport: "process",
      }),
      manager.run({
        task: "Hidden prepared child",
        model: "openai-codex/gpt-hidden",
        transport: "process",
      }),
    ]);

    expect(visible).toMatchObject({ status: "fulfilled", value: { status: "completed" } });
    expect(hidden).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: expect.stringContaining("not available to this Pi session") }),
    });
    expect(preparePiModel).toHaveBeenCalledTimes(2);
    expect(preparePiModel.mock.calls.map(([model]) => model).sort()).toEqual([
      "openai-codex/gpt-hidden",
      "openai-codex/gpt-visible",
    ]);
  });

  it("prepares an exact-match model under the same mode and keeps it apart from a default preparation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const preparePiModel = vi.fn(async (model: string | undefined, options?: { modelMatch?: "exact" }) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return options?.modelMatch === "exact" ? model : "provider/alias-target";
    });
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      preparePiModel,
    });
    managers.push(manager);

    // Concurrent launches of one selector under different modes must not share a preparation.
    const [exact, loose] = await Promise.all([
      manager.run({ task: "Exact child", model: "provider/model-a", modelMatch: "exact", transport: "process" }),
      manager.run({ task: "Default child", model: "provider/model-a", transport: "process" }),
    ]);

    expect(exact).toMatchObject({ status: "completed", model: "provider/model-a" });
    expect(loose).toMatchObject({ status: "completed", model: "provider/alias-target" });
    expect(preparePiModel).toHaveBeenCalledTimes(2);
    expect(preparePiModel.mock.calls.map(([, options]) => options?.modelMatch).sort())
      .toEqual(["exact", undefined]);
  });

  it("refuses modelMatch exact before preparation or any run directory when the request cannot be exact", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const preparePiModel = vi.fn(async (model: string | undefined) => model);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      preparePiModel,
    });
    managers.push(manager);

    await expect(manager.spawn({ task: "t", modelMatch: "exact" })).rejects.toThrow(EXACT_MODEL_FORM_ERROR);
    await expect(manager.spawn({ task: "t", modelMatch: "exact", model: "fast" })).rejects.toThrow(EXACT_MODEL_FORM_ERROR);
    await expect(manager.spawn({ task: "t", modelMatch: "exact", runner: "claude", model: "claude/sonnet" }))
      .rejects.toThrow(EXACT_MODEL_RUNNER_ERROR);
    await expect(manager.spawn({ task: "t", model: "provider/model-a", modelMatch: "fuzzy" } as never))
      .rejects.toThrow(/Invalid Fabric agent modelMatch/);
    expect(preparePiModel).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("re-prepares an exact-match model under the same mode when a startup retry relaunches it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const preparePiModel = vi.fn(async (model: string | undefined, _options?: { modelMatch?: "exact" }) => model);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker-startup-retry.mjs"),
      runRoot: root,
      preparePiModel,
    });
    managers.push(manager);

    const result = await manager.run({
      task: "Recover startup", model: "provider/model-a", modelMatch: "exact", transport: "process",
    });

    expect(result.status).toBe("completed");
    expect(preparePiModel.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(preparePiModel.mock.calls.map(([, options]) => options?.modelMatch)).toEqual(
      preparePiModel.mock.calls.map(() => "exact"),
    );
  });

  const workerAttempts = (root: string): string[][] => {
    const files = fs.readdirSync(root).map((entry) => path.join(root, entry, "worker-args.jsonl")).filter((file) => fs.existsSync(file));
    expect(files).toHaveLength(1);
    return fs.readFileSync(files[0]!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  };
  const flag = (args: string[], name: string): string | undefined => args[args.indexOf(name) + 1];

  it("forces strict model admission and the pin flag for an exact request, on the first launch and on every retry, whatever agents.modelAdmission says", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, modelAdmission: "permissive" }, {
      workerPath: path.resolve("tests/fixtures/fake-worker-startup-retry.mjs"),
      runRoot: root,
      preparePiModel: async (model) => model,
    });
    managers.push(manager);

    const result = await manager.run({
      task: "Recover startup", model: "provider/model-a", modelMatch: "exact", transport: "process",
    });

    expect(result.status).toBe("completed");
    const attempts = workerAttempts(root);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    for (const args of attempts) {
      expect(flag(args, "--model-admission")).toBe("strict");
      expect(flag(args, "--model-match")).toBe("exact");
      expect(flag(args, "--model")).toBe("provider/model-a");
    }
  });

  it("keeps the configured admission and sends no pin flag for a default request", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, modelAdmission: "permissive" }, {
      workerPath: path.resolve("tests/fixtures/fake-worker-startup-retry.mjs"),
      runRoot: root,
      preparePiModel: async (model) => model,
    });
    managers.push(manager);

    await manager.run({ task: "Recover startup", model: "provider/model-a", transport: "process" });

    for (const args of workerAttempts(root)) {
      expect(flag(args, "--model-admission")).toBe("permissive");
      expect(args).not.toContain("--model-match");
    }
  });

  it("describes systemPrompt in the order the worker uses: the caller's text ahead of component guidance", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker-startup-retry.mjs"),
      runRoot: root,
      resolveParticipantGuidance: () => "COMPONENT GUIDANCE",
    });
    managers.push(manager);

    await manager.run({ task: "Recover startup", model: "provider/model-a", systemPrompt: "CALLER PROMPT", transport: "process" });

    const prompt = flag(workerAttempts(root)[0]!, "--system-prompt")!;
    expect(prompt.indexOf("CALLER PROMPT")).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf("CALLER PROMPT")).toBeLessThan(prompt.indexOf("COMPONENT GUIDANCE"));
    const run = AGENTS_ACTION_DESCRIPTORS.find((entry) => entry.name === "run")!;
    const help = (run.inputSchema as { properties: { systemPrompt: { description: string } } }).properties.systemPrompt.description;
    expect(help).toMatch(/ahead of any component guidance/);
    expect(help).not.toMatch(/below component guidance/);
  });

  it("validates the configured Pi model default before launching", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(
      process.cwd(),
      { ...DEFAULT_FABRIC_CONFIG.agents, model: "provider/hidden" },
      {
        workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
        runRoot: root,
        preparePiModel: async (model) => {
          throw new Error(`Model ${JSON.stringify(model)} is not available to this Pi session`);
        },
      },
    );
    managers.push(manager);

    await expect(manager.spawn({ task: "Do not launch", runner: "pi" })).rejects.toThrow(
      /not available to this Pi session/,
    );
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("retries a Pi child that fails before its first turn", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker-startup-retry.mjs"),
      runRoot: root,
    });
    managers.push(manager);

    const result = await manager.run({ task: "Recover startup", transport: "process" });

    expect(result.status).toBe("completed");
    expect(result.text).toBe("startup retry recovered");
    expect(
      fs.readFileSync(path.join(manager.runDirectory(result.id)!, "startup-attempts"), "utf8"),
    ).toBe("2");
  });

  it("does not retry deterministic failures before the first turn", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker-startup-retry.mjs"),
      runRoot: root,
    });
    managers.push(manager);

    const result = await manager.run({ task: "Reject startup", transport: "process" });

    expect(result.status).toBe("failed");
    expect(result.error).toBe("provider rejected the prompt");
    expect(
      fs.readFileSync(path.join(manager.runDirectory(result.id)!, "startup-attempts"), "utf8"),
    ).toBe("1");
  });

  it("launches an exact run once when its pin error spells a credential error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker-startup-retry.mjs"),
      runRoot: root,
      preparePiModel: async (model) => model,
    });
    managers.push(manager);

    const result = await manager.run({ task: "Pin violation", model: "lab/pinned", modelMatch: "exact", transport: "process" });

    expect(result.status).toBe("failed");
    expect(result.error).toBe(modelPinFailure({ pinned: "lab/pinned", actual: "lab/missing credentials" }));
    expect(fs.readFileSync(path.join(manager.runDirectory(result.id)!, "startup-attempts"), "utf8")).toBe("1");
  });

  it("still retries that credential-looking error when the run is not an exact one", async () => {
    // Control: the pin rule is what stops the retry, not the error text.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker-startup-retry.mjs"),
      runRoot: root,
      preparePiModel: async (model) => model,
    });
    managers.push(manager);

    const result = await manager.run({ task: "Pin violation", model: "lab/pinned", transport: "process" });

    expect(result.status).toBe("failed");
    expect(Number(fs.readFileSync(path.join(manager.runDirectory(result.id)!, "startup-attempts"), "utf8"))).toBeGreaterThan(1);
  }, 30_000);

  it("retries a child whose transport exits before producing a result", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker-transport-death.mjs"),
      runRoot: root,
    });
    managers.push(manager);

    const result = await manager.run({ task: "Recoverable boot death", transport: "process" });

    expect(result.status).toBe("completed");
    expect(result.text).toBe("transport death retry recovered");
    expect(
      fs.readFileSync(path.join(manager.runDirectory(result.id)!, "startup-attempts"), "utf8"),
    ).toBe("2");
  },
  30_000);

  it("gives up retrying a child whose transport always exits before producing a result", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker-transport-death.mjs"),
      runRoot: root,
    });
    managers.push(manager);

    const result = await manager.run({ task: "Terminal boot death", transport: "process" });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Agent transport exited without a result");
    // AGENT_STARTUP_MAX_ATTEMPTS counts the initial launch: exactly 3 total.
    expect(
      fs.readFileSync(path.join(manager.runDirectory(result.id)!, "startup-attempts"), "utf8"),
    ).toBe("3");
  },
  30_000);

  it.each(["pi", "pi-durable"])("resumes a stopped %s worker and carries its progress forward", async (runner) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);

    const result = await manager.run({ task: "RESUME_AFTER_STOP", runner, transport: "process" });

    expect(result.status).toBe("completed");
    expect(result.text).toBe("resumed attempt 2");
    // The resumed attempt kept the stopped attempt's counters and usage, so the
    // settled result reports the whole run instead of only its final slice.
    expect(result.turns).toBe(6);
    expect(result.toolCalls).toBe(4);
    expect(result.usage.input).toBe(110);
    expect(result.usage.cost).toBeCloseTo(0.011, 6);
    // Native retries need a continuation note; durable retries retain the
    // prompt identity of the journal they reopen.
    if (runner === "pi-durable") expect(result.task).toBe("RESUME_AFTER_STOP");
    else expect(result.task).toContain("[Fabric continuation]");
    const runDirectory = manager.runDirectory(result.id)!;
    expect(fs.readFileSync(path.join(runDirectory, "resume-attempts"), "utf8")).toBe("2");
  },
  30_000);

  it("resumes a run whose transport died after doing work", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);

    const result = await manager.run({ task: "RESUME_AFTER_CRASH", transport: "process" });

    expect(result.status).toBe("completed");
    expect(result.text).toBe("resumed attempt 2");
    expect(result.turns).toBe(1);
  },
  30_000);

  it("never resumes a run an operator stopped, and aborts only unused runs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);

    const handle = await manager.spawn({ task: "LIVE_WITH_PROGRESS", transport: "process" });
    const runDirectory = manager.runDirectory(handle.id)!;
    await vi.waitFor(
      () => expect((manager.status(handle.id) as AgentRunRecord).turns).toBe(4),
      { timeout: 10_000 },
    );
    const stopped = await manager.stop(handle.id);
    expect(stopped.status).toBe("stopped");
    // An explicit stop is terminal: no relaunch follows it.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(fs.readFileSync(path.join(runDirectory, "resume-attempts"), "utf8")).toBe("1");
  },
  30_000);

  it("detaches a run with work in flight when its caller aborts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);

    const controller = new AbortController();
    const handle = await manager.spawn(
      { task: "LIVE_WITH_PROGRESS", transport: "process" },
      controller.signal,
    );
    await vi.waitFor(
      () => expect((manager.status(handle.id) as AgentRunRecord).turns).toBe(4),
      { timeout: 10_000 },
    );
    controller.abort();

    // The caller is gone, but the run it started is not: it keeps working and
    // reports its own terminal state instead of being killed mid-flight.
    const result = await manager.wait(handle.id);
    expect(result.status).toBe("completed");
    expect(result.text).toBe("live attempt 1 complete");
  },
  30_000);

  it("keeps full results in the API and compact projections for the dashboard", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({ task: "LARGE_RESULT", transport: "process" });
    expect(result.text).toHaveLength(100_000);
    expect((result.value as { output: string }).output).toHaveLength(100_000);

    const records = manager.listForUi();
    const compact = records[0] as AgentRunRecord;
    expect(compact.text.length).toBeLessThanOrEqual(16_001);
    expect(compact.value).toMatchObject({ fabricTruncated: true });
    expect(manager.listForUi()).toBe(records);
    expect((manager.status(result.id) as AgentRunRecord).text).toHaveLength(100_000);
    expect((await manager.wait(result.id)).text).toHaveLength(100_000);
  });

  it("readLog returns the run's event stream and status", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Inspect this repository", transport: "process" });
    expect(manager.runDirectory(result.id)).toBeDefined();
    const log = manager.readLog(result.id);
    expect(log.id).toBe(result.id);
    expect(log.logFile).toContain("events.jsonl");
    expect(log.runDirectory).toContain(path.basename(root));
    expect(log.status?.status).toBe("completed");
    const types = log.events.map((line) => (line.parsed as { type?: string } | undefined)?.type);
    expect(types).toContain("agent_start");
    expect(types).toContain("message_end");
    expect(types).toContain("agent_settled");
  });

  it("derives trusted log paths and recursively discovers bounded nested runs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Inspect nesting", transport: "process" });
    const runDirectory = manager.runDirectory(result.id)!;
    const topStatus = JSON.parse(fs.readFileSync(path.join(runDirectory, "status.json"), "utf8"));
    fs.writeFileSync(
      path.join(runDirectory, "status.json"),
      JSON.stringify({ ...topStatus, logFile: "/tmp/untrusted-top.jsonl" }),
    );
    const childDirectory = path.join(runDirectory, "nested", "child");
    const grandchildDirectory = path.join(childDirectory, "nested", "grandchild");
    fs.mkdirSync(grandchildDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(childDirectory, "status.json"),
      JSON.stringify({ ...result, id: "child", name: "child", logFile: "/tmp/untrusted-child.jsonl" }),
    );
    fs.writeFileSync(
      path.join(grandchildDirectory, "status.json"),
      JSON.stringify({ ...result, id: "grandchild", name: "grandchild", logFile: "/tmp/untrusted-grandchild.jsonl" }),
    );

    const status = manager.status(result.id) as AgentRunRecord;
    expect(status.logFile).toBe(path.join(runDirectory, "events.jsonl"));
    expect(status.nestedAgents?.[0]?.logFile).toBe(path.join(childDirectory, "events.jsonl"));
    expect(status.nestedAgents?.[0]?.nestedAgents?.[0]?.logFile).toBe(
      path.join(grandchildDirectory, "events.jsonl"),
    );

    status.nestedAgents![0]!.name = "caller mutation";
    fs.rmSync(path.join(runDirectory, "nested"), { recursive: true, force: true });
    const retained = manager.status(result.id) as AgentRunRecord;
    expect(retained.nestedAgents?.[0]?.name).toBe("child");
    expect(retained.nestedAgents?.[0]?.nestedAgents?.[0]?.name).toBe("grandchild");
  });

  it("captures recursive leaves before the child process removes their directories", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const handle = await manager.spawn({
      task: "HANG while nested agents finish",
      transport: "process",
      recursive: true,
    });
    const runDirectory = manager.runDirectory(handle.id)!;
    const statusFile = path.join(runDirectory, "status.json");
    const deadline = Date.now() + 2_000;
    while (!fs.existsSync(statusFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const parentStatus = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    const leafDirectory = path.join(runDirectory, "nested", "finished-leaf");
    fs.mkdirSync(leafDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(leafDirectory, "status.json"),
      JSON.stringify({
        ...parentStatus,
        id: "finished-leaf",
        name: "finished leaf",
        status: "completed",
        finishedAt: Date.now(),
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    fs.rmSync(path.join(runDirectory, "nested"), { recursive: true, force: true });
    const retained = manager.status(handle.id) as AgentRunRecord;
    expect(retained.nestedAgents?.[0]).toMatchObject({
      id: "finished-leaf",
      name: "finished leaf",
      status: "completed",
    });
    await manager.stop(handle.id);
  });

  it("inherits full code mode for ordinary extension-enabled children", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: true,
      mainAgentId: "session:root-main",
    });
    managers.push(manager);
    const direct = (await manager.run({
      task: "Use Fabric tools",
      transport: "process",
      tools: ["read", "grep"],
    })) as FabricSurfaceResult;
    expect(direct.fullCodeMode).toBe("true");
    expect(direct.tools).toEqual(["read", "grep", "fabric_exec"]);
    expect(direct.extensions).toBe("true");
    expect(direct.mainAgentId).toBe("session:root-main");
    expect(direct.fabricExtension).toContain("index");
    expect(direct.grantedRisks).toEqual([]);

    const recursive = (await manager.run({
      task: "Delegate recursively",
      transport: "process",
      tools: ["read"],
      recursive: true,
    })) as FabricSurfaceResult;
    expect(recursive.fullCodeMode).toBe("true");
    expect(recursive.tools).toEqual(["read", "fabric_exec"]);
    expect(recursive.mainAgentId).toBe("session:root-main");
    expect(recursive.grantedRisks).toEqual(["agent"]);
  });

  it("keeps explicit extensions:false children native in a full-code parent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: true,
    });
    managers.push(manager);
    const native = (await manager.run({
      task: "Native opt-out",
      transport: "process",
      tools: ["read"],
      extensions: false,
    })) as FabricSurfaceResult;
    expect(native.fullCodeMode).toBe("false");
    expect(native.tools).toEqual(["read"]);
    expect(native.fabricExtension).toBeUndefined();
    expect(native.grantedRisks).toEqual([]);
  });

  it("keeps ordinary children native when the parent is not full-code", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const direct = (await manager.run({
      task: "Native child of native parent",
      transport: "process",
      tools: ["read"],
    })) as FabricSurfaceResult;
    expect(direct.fullCodeMode).toBe("false");
    expect(direct.tools).toEqual(["read"]);
    expect(direct.fabricExtension).toBeUndefined();

    // Recursive children keep their recursive surface even from a native parent.
    const recursive = (await manager.run({
      task: "Delegate recursively from a native parent",
      transport: "process",
      tools: ["read"],
      recursive: true,
    })) as FabricSurfaceResult;
    expect(recursive.fullCodeMode).toBe("false");
    expect(recursive.tools).toEqual(["read", "fabric_exec"]);
    expect(recursive.fabricExtension).toContain("index");
    expect(recursive.grantedRisks).toEqual(["agent"]);
  });

  it("allows a cwd leaf agent to inherit the Fabric surface", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const leafCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-leaf-cwd-"));
    roots.push(leafCwd);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: true,
    });
    managers.push(manager);
    const result = (await manager.run({
      task: "Leaf agent with a custom cwd",
      transport: "process",
      tools: ["read"],
      cwd: leafCwd,
    })) as FabricSurfaceResult;
    expect(result.status).toBe("completed");
    expect(result.cwd).toBe(fs.realpathSync(leafCwd));
    expect(result.fullCodeMode).toBe("true");
    expect(result.tools).toEqual(["read", "fabric_exec"]);
    expect(result.grantedRisks).toEqual([]);
  });

  it.each(['["read","fabric_exec"]', 'invalid'])('does not widen recursive alternate-cwd authority (%s)', async (allowlist) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-recursive-security-"));
    roots.push(root);
    const target = path.join(root, "target");
    fs.mkdirSync(target);
    const saved = process.env.PI_FABRIC_TOOL_ALLOWLIST;
    process.env.PI_FABRIC_TOOL_ALLOWLIST = allowlist;
    let manager: AgentManager;
    try {
      manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" }, {
        workerPath: path.resolve("src/worker.ts"),
        piBinary: path.resolve("tests/fixtures/fake-pi-launch-probe.mjs"),
        runRoot: path.join(root, "runs"), fullCodeMode: true,
        projectRoot: process.cwd(), meshRoot: path.join(root, "mesh"),
        mainAgentId: "root:security", kernel: () => "python", pythonRuntime: () => "monty",
      });
      managers.push(manager);
    } finally {
      if (saved === undefined) delete process.env.PI_FABRIC_TOOL_ALLOWLIST;
      else process.env.PI_FABRIC_TOOL_ALLOWLIST = saved;
    }
    const result = await manager.run({
      task: "REPORT_LAUNCH_SURFACE", cwd: target, recursive: true,
      tools: ["read", "bash", "write"], transport: "process",
      capabilityRequirements: ["pi.read"],
    });
    expect(result.status).toBe("completed");
    // Malformed inherited authority fails closed: no optional tools and no fabric_exec.
    const tools = allowlist === 'invalid' ? [] : ["read", "fabric_exec"];
    expect(JSON.parse(result.text)).toMatchObject({
      cwd: fs.realpathSync(target), trustFlags: [], tools, toolAllowlistEnv: tools,
      grantedRisksEnv: ["agent"], fullCodeModeEnv: "true", extensions: true,
      projectRoot: process.cwd(), meshRoot: path.join(root, "mesh"),
      kernel: "python", pythonRuntime: "monty", depth: "1", mainAgentId: "root:security",
      capabilityRequirements: ["pi.read"],
    });
  });

  it("launches inherited children with the full-code surface through the real worker", { timeout: 15_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const fakePi = path.resolve("tests/fixtures/fake-pi-launch-probe.mjs");
    fs.chmodSync(fakePi, 0o755);
    const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" }, {
      workerPath: path.resolve("src/worker.ts"),
      piBinary: fakePi,
      runRoot: root,
      fullCodeMode: true,
    });
    managers.push(manager);

    const inherited = await manager.run({
      task: "REPORT_LAUNCH_SURFACE",
      transport: "process",
      tools: ["read"],
      timeoutMs: 5_000,
    });
    expect(inherited.status).toBe("completed");
    expect(JSON.parse(inherited.text)).toMatchObject({
      extensions: true,
      extensionPath: expect.stringContaining("index"),
      tools: ["read", "fabric_exec"],
      fullCodeModeEnv: "true",
      toolAllowlistEnv: ["read", "fabric_exec"],
      grantedRisksEnv: [],
    });

    const native = await manager.run({
      task: "REPORT_LAUNCH_SURFACE",
      transport: "process",
      tools: ["read"],
      extensions: false,
      timeoutMs: 5_000,
    });
    expect(native.status).toBe("completed");
    expect(JSON.parse(native.text).extensionPath).toBeUndefined();
    expect(JSON.parse(native.text)).toMatchObject({
      extensions: false,
      tools: ["read"],
      fullCodeModeEnv: "false",
      toolAllowlistEnv: ["read"],
      grantedRisksEnv: [],
    });
  });

  it("validates structured output through the real Fabric worker", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const fakePi = path.resolve("tests/fixtures/fake-pi-rpc.mjs");
    fs.chmodSync(fakePi, 0o755);
    const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" }, {
      workerPath: path.resolve("src/worker.ts"),
      piBinary: fakePi,
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({
      task: "Return a directive",
      transport: "process",
      systemPrompt: "You are a test actor.",
      sessionFile: path.join(root, "actor-session.jsonl"),
      actorId: "actor-test",
      actorName: "test-actor",
      meshRoot: path.join(root, "mesh"),
      schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["message"] },
          message: { type: "string" },
        },
        required: ["action", "message"],
        additionalProperties: false,
      },
    });
    expect(result.status).toBe("completed");
    expect(result.value).toEqual({
      action: "message",
      message: "validated actor response:false",
    });
    expect(result.usage).toMatchObject({ input: 3, output: 4 });
  });

  it("propagates the exact root Main identity into recursive child Pi", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const fakePi = path.resolve("tests/fixtures/fake-pi-rpc.mjs");
    fs.chmodSync(fakePi, 0o755);
    const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" }, {
      workerPath: path.resolve("src/worker.ts"),
      piBinary: fakePi,
      runRoot: root,
      fullCodeMode: true,
      mainAgentId: "session:root-main",
    });
    managers.push(manager);

    const result = await manager.run({
      task: "REPORT_FABRIC_IDENTITY",
      name: "recursive implementor",
      transport: "process",
      recursive: true,
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("completed");
    expect(JSON.parse(result.text)).toEqual({
      mainAgentId: "session:root-main",
      parentRun: result.id,
      agentName: "recursive implementor",
    });
  });

  it("keeps the RPC worker alive when Pi announces a retry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const fakePi = path.resolve("tests/fixtures/fake-pi-rpc.mjs");
    fs.chmodSync(fakePi, 0o755);
    const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" }, {
      workerPath: path.resolve("src/worker.ts"),
      piBinary: fakePi,
      runRoot: root,
      fullCodeMode: true,
    });
    managers.push(manager);

    const result = await manager.run({
      task: "RETRY_THEN_SUCCEED",
      transport: "process",
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("completed");
    expect(result.text).toBe("retry recovered");
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });

  it("preserves provider diagnostics when the final agent attempt fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const fakePi = path.resolve("tests/fixtures/fake-pi-rpc.mjs");
    fs.chmodSync(fakePi, 0o755);
    const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" }, {
      workerPath: path.resolve("src/worker.ts"),
      piBinary: fakePi,
      runRoot: root,
      fullCodeMode: true,
    });
    managers.push(manager);

    const result = await manager.run({
      task: "FAIL_PROVIDER",
      transport: "process",
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(0);
    expect(result.error).toContain("openai-codex/gpt-test: fetch failed · WebSocket error");
    expect(result.error).not.toContain("exited with code 0");
  });

  it("forwards the configured default model when a call omits one", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, model: "claude-sonnet-4-5" };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Use the default model", transport: "process" });
    expect(result.status).toBe("completed");
    expect(result.model).toBe("claude-sonnet-4-5");
  });

  it("lets a per-call model override the configured default", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, model: "claude-sonnet-4-5" };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({
      task: "Override the model",
      transport: "process",
      model: "gpt-override",
    });
    expect(result.status).toBe("completed");
    expect(result.model).toBe("gpt-override");
  });

  it("forwards the configured default thinking when a call omits one", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, thinking: "high" as const };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Use the default thinking", transport: "process" });
    expect(result.status).toBe("completed");
    expect(result.thinking).toBe("high");
  });

  it("lets a per-call thinking override the configured default", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, thinking: "high" as const };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({
      task: "Override the thinking",
      transport: "process",
      thinking: "max",
    });
    expect(result.status).toBe("completed");
    expect(result.thinking).toBe("max");
  });

  it("forwards the medium default when neither config nor call set a thinking level", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Default medium thinking", transport: "process" });
    expect(result.status).toBe("completed");
    expect(result.thinking).toBe("medium");
  });

  it("inherits the host model when neither config nor call set one", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({ task: "Inherit the host model", transport: "process" });
    expect(result.status).toBe("completed");
    expect(result.model).toBeUndefined();
  });

  it("notifies when a detached background agent completes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    let resolveCompletion: ((text: string) => void) | undefined;
    const completion = new Promise<string>((resolve) => {
      resolveCompletion = resolve;
    });
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
      onBackgroundComplete: (result) => resolveCompletion?.(result.text),
    });
    managers.push(manager);
    const handle = await manager.spawn({ task: "Background task", transport: "process" });
    manager.detachSignal(handle.id);
    await expect(completion).resolves.toBe("fake worker complete");
  });

  it("surfaces the run-log tail when a worker exits without a terminal result", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker-crash.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    const result = await manager.run({ task: "crash test", transport: "process" });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("exited without a result");
    expect(result.error).toContain("model rate limit exceeded");
    expect(result.error).toContain("worker_stderr: provider authentication failed retry required");
  },
  30_000);

  it("rejects empty tasks", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-manager-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    await expect(manager.spawn({ task: "" })).rejects.toThrow("must not be empty");
  });

  it("enforces a cross-process cost budget across spawned agents", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-budget-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, budgetUsd: 0.1 };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath: path.resolve("tests/fixtures/fake-worker-budget.mjs"),
      runRoot: root,
    });
    managers.push(manager);

    const first = await manager.run({ task: "COST 0.06", transport: "process" });
    expect(first.status).toBe("completed");
    expect(first.usage.cost).toBeCloseTo(0.06);
    expect(first.budget).toBeDefined();
    expect(first.budget?.limit).toBe(0.1);
    expect(first.budget?.spent).toBeCloseTo(0.06);
    expect(first.budget?.remaining).toBeCloseTo(0.04);

    // The check runs before the child lands its cost, so a tree may slightly
    // overshoot (matching ypi's best-effort RLM_BUDGET semantics).
    const second = await manager.run({ task: "COST 0.06", transport: "process" });
    expect(second.status).toBe("completed");
    expect(second.budget?.spent).toBeCloseTo(0.12);
    expect(second.budget?.remaining).toBe(0);

    // A third call is rejected because the accumulated spend now meets the budget.
    await expect(manager.spawn({ task: "COST 0.06", transport: "process" })).rejects.toThrow(
      /budget exceeded/,
    );
  });

  it("rechecks the recursion budget after a queued run gets a slot", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-budget-queue-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, maxConcurrent: 1, budgetUsd: 0.1 }, {
      workerPath: path.resolve("tests/fixtures/fake-worker-budget.mjs"), runRoot: root,
    });
    managers.push(manager);
    const first = await manager.spawn({ task: "COST 0.1 DELAY 300", transport: "process" });
    const queued = await manager.spawn({ task: "COST 0.01", transport: "process", queue: true });
    expect(queued.status).toBe("queued");
    const next = await manager.spawn({ task: "COST 0.01", transport: "process", queue: true });
    expect((await manager.wait(first.id)).status).toBe("completed");
    const result = await manager.wait(queued.id);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/budget exceeded/);
    expect(fs.existsSync(path.join(root, queued.id))).toBe(false);
    const nextResult = await manager.wait(next.id);
    expect(nextResult.status).toBe("failed");
    expect(nextResult.error).toMatch(/budget exceeded/);
    expect(fs.existsSync(path.join(root, next.id))).toBe(false);
  });

  it("refuses a nonfinite accumulated budget observation before spawning a child", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-budget-invalid-"));
    roots.push(root);
    process.env.PI_FABRIC_BUDGET = "0.05";
    process.env.PI_FABRIC_BUDGET_FILE = path.join(root, "tree-cost.jsonl");
    process.env.PI_FABRIC_BUDGET_ID = "invalid-observation";
    fs.writeFileSync(process.env.PI_FABRIC_BUDGET_FILE, '{"cost":"Infinity"}\n{"cost":"-Infinity"}\n');
    try {
      const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, { workerPath: path.resolve("tests/fixtures/fake-worker-budget.mjs"), runRoot: root });
      managers.push(manager);
      await expect(manager.spawn({ task: "must not run", transport: "process" })).rejects.toThrow(/budget exceeded/);
    } finally { clearOwnedBudgetEnv(); }
  });

  it("inherits a budget ledger from the environment for recursive children", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-budget-"));
    roots.push(root);
    process.env.PI_FABRIC_BUDGET = "0.05";
    process.env.PI_FABRIC_BUDGET_FILE = path.join(root, "tree-cost.jsonl");
    process.env.PI_FABRIC_BUDGET_ID = "inherited-tree";
    fs.writeFileSync(process.env.PI_FABRIC_BUDGET_FILE, "", { mode: 0o600 });
    try {
      const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
        workerPath: path.resolve("tests/fixtures/fake-worker-budget.mjs"),
        runRoot: root,
      });
      managers.push(manager);

      const result = await manager.run({ task: "COST 0.02", transport: "process" });
      expect(result.budget?.limit).toBe(0.05);
      expect(result.budget?.spent).toBeCloseTo(0.02);
      expect(result.budget?.remaining).toBeCloseTo(0.03);

      const ledger = fs.readFileSync(process.env.PI_FABRIC_BUDGET_FILE, "utf8");
      expect(ledger).toContain("\"cost\":0.02");
    } finally {
      delete process.env.PI_FABRIC_BUDGET;
      delete process.env.PI_FABRIC_BUDGET_FILE;
      delete process.env.PI_FABRIC_BUDGET_ID;
    }
  });

  it("attributes token usage per tokens.usage events and closes the settle gap", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-budget-"));
    roots.push(root);
    process.env.PI_FABRIC_BUDGET = "0.05";
    process.env.PI_FABRIC_BUDGET_FILE = path.join(root, "tree-cost.jsonl");
    process.env.PI_FABRIC_BUDGET_ID = "attributed-tree";
    fs.writeFileSync(process.env.PI_FABRIC_BUDGET_FILE, "", { mode: 0o600 });
    try {
      const life: Array<{ event: string; data?: unknown }> = [];
      const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
        workerPath: path.resolve("tests/fixtures/fake-worker-usage.mjs"),
        runRoot: root,
        onLifecycle: (event) => life.push({ event: event.event, data: event.data }),
      });
      managers.push(manager);

      const result = await manager.run({
        task: "anything",
        transport: "process",
        actorId: "actor-test",
        actorName: "attr-test",
      });
      expect(result.status).toBe("completed");

      const usageEvents = life.filter((entry) => entry.event === "tokens.usage");
      expect(usageEvents).toHaveLength(1);
      const payload = usageEvents[0]!.data as {
        runId: string; runner: string; depth: number; actorId?: string; cumulativeTokens: number;
        input: number; output: number; cost: number;
      };
      expect(payload.runner).toBe("pi");
      expect(payload.depth).toBe(1);
      expect(payload.actorId).toBe("actor-test");
      expect(payload.cumulativeTokens).toBe(13);
      expect(payload.input).toBe(4);
      expect(payload.output).toBe(6);

      // Live-delta path recorded 13 tokens; settle closes the remaining 10
      // from the status file (input 8 + output 10 + cacheRead 3 + cacheWrite 2).
      const detail = readBudgetLedgerDetailed(process.env.PI_FABRIC_BUDGET_FILE);
      const totalCost = detail.entries.reduce((sum, entry) => sum + entry.cost, 0);
      const totalTokens = detail.entries.reduce((sum, entry) => sum + entry.tokens, 0);
      expect(totalTokens).toBe(23);
      expect(totalCost).toBeCloseTo(0.0015);
      expect(detail.byRunner["pi-durable"]?.tokens).toBe(23);
      expect(detail.byRunner["pi-durable"]?.cost).toBeCloseTo(0.0015);
      expect(detail.byActor["actor-test"]?.tokens).toBe(23);
    } finally {
      clearOwnedBudgetEnv();
    }
  });

  it("terminates a child that exceeds the per-child token limit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-tokens-"));
    roots.push(root);
    const fakePi = path.resolve("tests/fixtures/fake-pi-rpc.mjs");
    fs.chmodSync(fakePi, 0o755);
    // The fake pi emits one assistant turn with 7 tokens (input 3 + output 4);
    // a 5-token ceiling trips the guard after the first message_end.
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" as const, maxTokensPerChild: 5 };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath: path.resolve("src/worker.ts"),
      piBinary: fakePi,
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    const result = await manager.run({
      task: "burn tokens",
      transport: "process",
      timeoutMs: 5_000,
    });
    expect(result.status).toBe("timed_out");
    expect(result.error ?? "").toMatch(/token limit/i);
    expect(result.error ?? "").toMatch(/7 tokens/);
    // The parent model reads this error verbatim: it must name the config key
    // and remedy so the failure is actionable without reading worker.ts.
    expect(result.error ?? "").toContain("agents.maxTokensPerChild");
    expect(result.error ?? "").toContain("/fabric settings");
  });
});

describe("AgentManager multimodal prompts", () => {
  it("forwards image blocks to the Pi worker RPC prompt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-images-"));
    roots.push(root);
    const promptLog = path.join(root, "prompt.json");
    process.env.FAKE_PI_BEHAVIOR = "capture-prompt";
    process.env.FAKE_PI_PROMPT_LOG = promptLog;
    try {
      const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" }, {
        workerPath: path.resolve("src/worker.ts"),
        piBinary: path.resolve("tests/fixtures/fake-pi.mjs"),
        runRoot: path.join(root, "runs"),
      });
      managers.push(manager);
      const result = await manager.run({
        task: "Inspect the attached image",
        transport: "process",
        images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      });

      expect(result.status).toBe("completed");
      const frame = JSON.parse(fs.readFileSync(promptLog, "utf8")) as Record<string, unknown>;
      expect(frame).toEqual({
        type: "prompt",
        id: "fabric-task",
        message: "Inspect the attached image",
        images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      });
      expect(fs.existsSync(path.join(manager.runDirectory(result.id)!, "images.json"))).toBe(false);
    } finally {
      delete process.env.FAKE_PI_BEHAVIOR;
      delete process.env.FAKE_PI_PROMPT_LOG;
    }
  });
});

describe("AgentManager Claude runner", () => {
  const fakeClaude = path.resolve("tests/fixtures/fake-claude.mjs");

  it("uses the independent configured Claude runner and model defaults", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-claude-"));
    roots.push(root);
    const config = {
      ...DEFAULT_FABRIC_CONFIG.agents,
      runner: "claude" as const,
      model: "openai/pi-only",
      claude: { ...DEFAULT_FABRIC_CONFIG.agents.claude, model: "claude/haiku" },
    };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: root,
    });
    managers.push(manager);

    const result = await manager.run({ task: "Use Claude defaults", transport: "process" });
    expect(result).toMatchObject({
      status: "completed",
      runner: "claude",
      model: "claude/haiku",
    });
  });

  it("runs Claude stream-json with mapped tools, native schema output, and usage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-claude-"));
    roots.push(root);
    const invocationLog = path.join(root, "claude-args.jsonl");
    process.env.FAKE_CLAUDE_LOG = invocationLog;
    try {
      const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
        workerPath: path.resolve("src/worker.ts"),
        claudeBinary: fakeClaude,
        runRoot: root,
      });
      managers.push(manager);
      const result = await manager.run({
        task: "Return structured output",
        runner: "claude",
        transport: "process",
        model: "claude/haiku",
        thinking: "minimal",
        tools: ["read", "grep", "find", "ls"],
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      });

      expect(result).toMatchObject({
        status: "completed",
        runner: "claude",
        model: "claude/haiku",
        thinking: "minimal",
        turns: 2,
        toolCalls: 1,
        value: { ok: true },
        runnerSessionId: "11111111-1111-4111-8111-111111111111",
        usage: { input: 10, output: 7, cacheRead: 2, cacheWrite: 3, cost: 0.001 },
      });
      const invocation = JSON.parse(fs.readFileSync(invocationLog, "utf8").trim()) as {
        argv: string[];
      };
      expect(invocation.argv).toEqual(
        expect.arrayContaining([
          "--model",
          "haiku",
          "--effort",
          "low",
          "--tools",
          "Read,Grep,Glob",
          "--allowedTools",
          "Read,Grep,Glob",
          "--no-session-persistence",
        ]),
      );
      expect(invocation.argv).not.toContain("fabric_exec");
    } finally {
      delete process.env.FAKE_CLAUDE_LOG;
    }
  });

  it("preserves Claude result diagnostics on a failed run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-claude-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("src/worker.ts"),
      claudeBinary: fakeClaude,
      runRoot: root,
    });
    managers.push(manager);

    const result = await manager.run({
      task: "CLAUDE_FAIL",
      runner: "claude",
      transport: "process",
      tools: ["read"],
    });
    expect(result).toMatchObject({
      status: "failed",
      runner: "claude",
      error: "fake Claude failure",
      exitCode: 0,
    });
  });

  it("delivers Claude steering and follow-up messages on later turns", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-claude-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("src/worker.ts"),
      claudeBinary: fakeClaude,
      runRoot: root,
    });
    managers.push(manager);

    const handle = await manager.spawn({
      task: "Initial Claude task",
      runner: "claude",
      transport: "process",
      tools: ["read"],
    });
    manager.steer(handle.id, "Redirect the active analysis");
    manager.followUp(handle.id, "Check one final detail");
    const result = await manager.wait(handle.id);

    expect(result).toMatchObject({
      status: "completed",
      runner: "claude",
      turns: 6,
      toolCalls: 3,
      usage: { input: 30, output: 21, cacheRead: 6, cacheWrite: 9, cost: 0.003 },
      pendingMessages: { steering: [], followUp: [] },
    });
  });

  it("enumerates models from the Claude runtime control handshake", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-claude-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      claudeBinary: fakeClaude,
      runRoot: root,
    });
    managers.push(manager);

    const models = await manager.claudeModels();
    expect(models.map((model) => model.value)).toEqual(["default", "haiku"]);
    expect(models[1]).toMatchObject({
      value: "haiku",
      resolvedModel: "claude-haiku-test",
      displayName: "Haiku (test)",
    });
  });

  it("rejects recursive Fabric and unsupported tools before launching Claude", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-claude-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      claudeBinary: fakeClaude,
      runRoot: root,
    });
    managers.push(manager);

    await expect(
      manager.run({ task: "recurse", runner: "claude", recursive: true }),
    ).rejects.toThrow(/does not support recursive Fabric/);
    await expect(
      manager.run({ task: "unknown tool", runner: "claude", tools: ["custom"] }),
    ).rejects.toThrow(/does not support Fabric tool/);
    await expect(
      manager.run({ task: "prototype tool", runner: "claude", tools: ["__proto__"] }),
    ).rejects.toThrow(/does not support Fabric tool/);
    await expect(
      manager.run({ task: "blank model", runner: "claude", model: "claude/" }),
    ).rejects.toThrow(/must include a runtime model value/);
  });
});

describe("AgentManager steering", () => {
  const fakeWorker = path.resolve("tests/fixtures/fake-worker.mjs");
  const fakePiSteer = path.resolve("tests/fixtures/fake-pi-rpc-steer.mjs");

  const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for steer state");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const readSteerFile = (runDir: string): Array<Record<string, unknown>> => {
    const file = path.join(runDir, "steer.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  const hangManager = (root: string, workerPath = fakeWorker, piBinary?: string) => {
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath,
      ...(piBinary ? { piBinary } : {}),
      runRoot: root,
      fullCodeMode: false,
    });
    managers.push(manager);
    return manager;
  };

  it("steer appends a queued steer command for a running agent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-steer-"));
    roots.push(root);
    const manager = hangManager(root);
    const handle = await manager.spawn({ task: "HANG", transport: "process" });
    const result = manager.steer(handle.id, "drop the token branch");
    expect(result).toEqual({ queued: true, messageId: expect.any(String) });
    const entries = readSteerFile(manager.runDirectory(handle.id)!);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "steer", message: "drop the token branch" });
    await manager.stop(handle.id);
  });

  it("steer throws for a finished agent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-steer-"));
    roots.push(root);
    const manager = hangManager(root);
    const result = await manager.run({ task: "done", transport: "process" });
    expect(() => manager.steer(result.id, "too late")).toThrow(/already finished/);
  });

  it("followUp appends a follow_up command", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-steer-"));
    roots.push(root);
    const manager = hangManager(root);
    const handle = await manager.spawn({ task: "HANG", transport: "process" });
    manager.followUp(handle.id, "then summarize");
    const entries = readSteerFile(manager.runDirectory(handle.id)!);
    expect(entries[0]).toMatchObject({ type: "follow_up", message: "then summarize" });
    await manager.stop(handle.id);
  });

  it("setSteeringMode and setFollowUpMode append mode commands", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-steer-"));
    roots.push(root);
    const manager = hangManager(root);
    const handle = await manager.spawn({ task: "HANG", transport: "process" });
    manager.setSteeringMode(handle.id, "all");
    manager.setFollowUpMode(handle.id, "one-at-a-time");
    const entries = readSteerFile(manager.runDirectory(handle.id)!);
    expect(entries[0]).toMatchObject({ type: "set_steering_mode", mode: "all" });
    expect(entries[1]).toMatchObject({ type: "set_follow_up_mode", mode: "one-at-a-time" });
    await manager.stop(handle.id);
  });

  it("forwards a steer to the child pi over RPC and surfaces pendingMessages", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-steer-"));
    roots.push(root);
    fs.chmodSync(fakePiSteer, 0o755);
    const received = path.join(root, "received.jsonl");
    process.env.FAKE_PI_STEER_LOG = received;
    try {
      const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" }, {
        workerPath: path.resolve("src/worker.ts"),
        piBinary: fakePiSteer,
        runRoot: root,
        fullCodeMode: false,
      });
      managers.push(manager);
      const handle = await manager.spawn({ task: "STEER_ME", transport: "process" });
      await waitFor(() => manager.status(handle.id).status === "running");
      manager.steer(handle.id, "redirect to session expiry");
      await waitFor(
        () =>
          fs.existsSync(received) &&
          fs.readFileSync(received, "utf8").includes("redirect to session expiry"),
        3_000,
      );
      const forwarded = fs
        .readFileSync(received, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(
        forwarded.some((e) => e.type === "steer" && e.message === "redirect to session expiry"),
      ).toBe(true);
      await waitFor(() => {
        const status = manager.status(handle.id) as AgentRunRecord;
        return Boolean(status.pendingMessages?.steering.includes("redirect to session expiry"));
      }, 3_000);
      await manager.stop(handle.id);
    } finally {
      delete process.env.FAKE_PI_STEER_LOG;
    }
  });

  it("preserves a partial UTF-8 steering record across worker polls", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-steer-"));
    roots.push(root);
    fs.chmodSync(fakePiSteer, 0o755);
    const received = path.join(root, "received.jsonl");
    process.env.FAKE_PI_STEER_LOG = received;
    try {
      const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" }, {
        workerPath: path.resolve("src/worker.ts"),
        piBinary: fakePiSteer,
        runRoot: root,
      });
      managers.push(manager);
      const handle = await manager.spawn({ task: "STEER_ME", transport: "process" });
      await waitFor(() => manager.status(handle.id).status === "running");
      const steerFile = path.join(manager.runDirectory(handle.id)!, "steer.jsonl");
      const line = Buffer.from(`${JSON.stringify({ type: "steer", message: "转向界面 🚀" })}\n`);
      const split = line.indexOf(Buffer.from("界")) + 1;
      fs.appendFileSync(steerFile, line.subarray(0, split));
      await new Promise((resolve) => setTimeout(resolve, 300));
      fs.appendFileSync(steerFile, line.subarray(split));
      await waitFor(
        () => fs.existsSync(received) && fs.readFileSync(received, "utf8").includes("转向界面 🚀"),
        3_000,
      );
      await manager.stop(handle.id);
    } finally {
      delete process.env.FAKE_PI_STEER_LOG;
    }
  });

  it("forwards every steer command when one poll reads more than the per-poll limit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-steer-"));
    roots.push(root);
    fs.chmodSync(fakePiSteer, 0o755);
    const received = path.join(root, "received.jsonl");
    process.env.FAKE_PI_STEER_LOG = received;
    const readSteers = (): string[] =>
      fs.existsSync(received)
        ? fs
            .readFileSync(received, "utf8")
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .filter((entry) => entry.type === "steer")
            .map((entry) => String(entry.message))
        : [];
    try {
      const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" }, {
        workerPath: path.resolve("src/worker.ts"),
        piBinary: fakePiSteer,
        runRoot: root,
        fullCodeMode: false,
      });
      managers.push(manager);
      const handle = await manager.spawn({ task: "STEER_ME", transport: "process" });
      await waitFor(
        () => fs.existsSync(received) && fs.readFileSync(received, "utf8").includes('"type":"prompt"'),
        10_000,
      );
      // 300 small commands fit in one 256 KiB read but exceed the 256-command
      // per-poll bound, so the worker must carry the rest to a later poll.
      const expected = Array.from({ length: 300 }, (_, index) => `step-${index}`);
      const steerFile = path.join(manager.runDirectory(handle.id)!, "steer.jsonl");
      fs.appendFileSync(
        steerFile,
        expected.map((message) => JSON.stringify({ type: "steer", message }) + "\n").join(""),
      );
      await waitFor(() => readSteers().length >= expected.length, 5_000).catch(() => undefined);
      expect(readSteers()).toEqual(expected);
      await manager.stop(handle.id);
    } finally {
      delete process.env.FAKE_PI_STEER_LOG;
    }
  }, 20_000);

  it("forwards a follow_up and a queue mode to the child pi over RPC", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-steer-"));
    roots.push(root);
    fs.chmodSync(fakePiSteer, 0o755);
    const received = path.join(root, "received.jsonl");
    process.env.FAKE_PI_STEER_LOG = received;
    try {
      const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" }, {
        workerPath: path.resolve("src/worker.ts"),
        piBinary: fakePiSteer,
        runRoot: root,
        fullCodeMode: false,
      });
      managers.push(manager);
      const handle = await manager.spawn({ task: "STEER_ME", transport: "process" });
      await waitFor(() => manager.status(handle.id).status === "running");
      // The worker is running before its cold child process is RPC-ready.
      // Wait for that handshake separately; retain the forwarding deadline.
      await waitFor(
        () => fs.existsSync(received) && fs.readFileSync(received, "utf8").includes('"type":"prompt"'),
        10_000,
      );
      manager.setSteeringMode(handle.id, "all");
      manager.followUp(handle.id, "then run the tests");
      await waitFor(
        () => {
          if (!fs.existsSync(received)) return false;
          const text = fs.readFileSync(received, "utf8");
          return text.includes('"type":"set_steering_mode"') && text.includes("then run the tests");
        },
        3_000,
      );
      const forwarded = fs
        .readFileSync(received, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(forwarded.some((e) => e.type === "set_steering_mode" && e.mode === "all")).toBe(true);
      expect(
        forwarded.some((e) => e.type === "follow_up" && e.message === "then run the tests"),
      ).toBe(true);
      await manager.stop(handle.id);
    } finally {
      delete process.env.FAKE_PI_STEER_LOG;
    }
  }, 20_000);

  it("compact appends a compact entry to the steer channel for a running pi child", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-compact-"));
    roots.push(root);
    const manager = hangManager(root);
    const handle = await manager.spawn({ task: "HANG", transport: "process" });
    const result = manager.compact(handle.id, "Keep the file map");
    expect(result).toEqual({ queued: true, messageId: expect.any(String) });
    const entries = readSteerFile(manager.runDirectory(handle.id)!);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "compact", instructions: "Keep the file map" });
    await manager.stop(handle.id);
  });

  it("compact appends a compact entry without instructions when omitted", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-compact-"));
    roots.push(root);
    const manager = hangManager(root);
    const handle = await manager.spawn({ task: "HANG", transport: "process" });
    manager.compact(handle.id);
    const entries = readSteerFile(manager.runDirectory(handle.id)!);
    expect(entries[0]).toMatchObject({ type: "compact" });
    expect(entries[0]).not.toHaveProperty("instructions");
    await manager.stop(handle.id);
  });

  it("compact throws for a finished agent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-compact-"));
    roots.push(root);
    const manager = hangManager(root);
    const result = await manager.run({ task: "done", transport: "process" });
    expect(() => manager.compact(result.id)).toThrow(/already finished/);
  });

  it("compact rejects claude-runner children with a clear error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-compact-"));
    roots.push(root);
    const fakeClaude = path.resolve("tests/fixtures/fake-claude.mjs");
    const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("src/worker.ts"),
      claudeBinary: fakeClaude,
      runRoot: root,
    });
    managers.push(manager);
    const handle = await manager.spawn({
      task: "Initial Claude task",
      runner: "claude",
      transport: "process",
      tools: ["read"],
    });
    expect(() => manager.compact(handle.id)).toThrow(/only supported for Pi-runner children/);
    await manager.stop(handle.id);
  });

  it("forwards a correlated compact frame only after child agent_settled", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-compact-"));
    roots.push(root);
    fs.chmodSync(fakePiSteer, 0o755);
    const received = path.join(root, "received.jsonl");
    process.env.FAKE_PI_STEER_LOG = received;
    try {
      const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" }, {
        workerPath: path.resolve("src/worker.ts"),
        piBinary: fakePiSteer,
        runRoot: root,
        fullCodeMode: false,
      });
      managers.push(manager);
      const handle = await manager.spawn({ task: "STEER_ME", transport: "process" });
      await waitFor(() => manager.status(handle.id).status === "running");
      manager.compact(handle.id, "Preserve the test plan");
      await waitFor(
        () => fs.existsSync(received) && fs.readFileSync(received, "utf8").includes("compact"),
        // Includes two cold Node processes and Pi settlement, not just RPC latency.
        10_000,
      );
      const forwarded = fs
        .readFileSync(received, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(
        forwarded.some(
          (e) =>
            e.type === "compact" &&
            typeof e.id === "string" &&
            e.customInstructions === "Preserve the test plan",
        ),
      ).toBe(true);
      const result = await manager.wait(handle.id);
      expect(result.status).toBe("completed");
      expect(result.compaction?.status).toBe("completed");
    } finally {
      delete process.env.FAKE_PI_STEER_LOG;
    }
  }, 20_000);
});
