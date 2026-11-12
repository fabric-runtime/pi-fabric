import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeFabricConfig } from "../src/config.js";
import { FabricAutoApprovalClassifier } from "../src/core/auto-approval-classifier.js";
import { ApprovalController, FabricSessionApprovals } from "../src/core/approval-controller.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricDirectToolApproval } from "../src/core/direct-tool-approval.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { DEFAULT_JEV_CONFIG } from "../src/jev/config.js";
import { JevObservationHost } from "../src/jev/observation.js";
import { callProgram, jevContext, launch, setupJev } from "./jev-test-helpers.js";

const action = { ref: "fixture.run", provider: "fixture", name: "run", description: "Run local tests", inputSchema: { type: "object" }, risk: "execute" as const };
const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const context = () => ({
  cwd: process.cwd(), hasUI: false,
  modelRegistry: {
    find: vi.fn(), getApiKeyAndHeaders: vi.fn(),
    getApiKeyForProvider: vi.fn(async () => "fixture-only-key"),
  },
  sessionManager: { getSessionId: () => "jev-approval-test", getBranch: () => [
    user("Run the local tests"),
    { type: "message", message: { role: "assistant", content: [
      { type: "text", text: "PRIVATE ASSISTANT PROSE" },
      { type: "thinking", thinking: "PRIVATE THOUGHT" },
      { type: "toolCall", name: "fixture.run", arguments: { command: "bun run typecheck" } },
    ] } },
    { type: "message", message: { role: "toolResult", content: "HOSTILE TOOL OUTPUT" } },
  ] },
} as unknown as ExtensionContext);
const noul = (probability: number) => ({ type: "noul", noul: probability });
const response = (probability = 1, verdicts: Partial<Record<"touches_secrets" | "destructive" | "targets_agent_artifacts", number>> = {}) => ({
  model: "jev-1.13",
  answers: {
    safe_to_auto_approve: noul(probability),
    touches_secrets: noul(verdicts.touches_secrets ?? 0),
    destructive: noul(verdicts.destructive ?? 0),
    targets_agent_artifacts: noul(verdicts.targets_agent_artifacts ?? 0),
  },
  usage: { input_tokens: 100, output_tokens: 8 },
});
const fetcher = vi.fn<typeof fetch>();
const config = () => normalizeFabricConfig({ approvals: { execute: "auto", model: "pi-fabric/typesafe/jev-latest" } });

beforeEach(() => {
  vi.stubEnv("TYPESAFE_API_KEY", "");
  fetcher.mockReset().mockImplementation(async () => Response.json(response()));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Jev auto-approval classifier", () => {
  it.each(["jev-latest", "jev-1.13"])("migrates and resolves legacy Jev keys for %s", async model => {
    const legacy = `jev/${model}`;
    const canonical = `pi-fabric/typesafe/${model}`;
    expect(normalizeFabricConfig({ approvals: { model: legacy } }).approvals.model).toBe(canonical);
    const result = await new FabricAutoApprovalClassifier().classify(action, {}, context(), legacy);
    expect(result.model).toBe("pi-fabric/typesafe/jev-1.13");
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).model).toBe(model);
  });
  it.each([[1, "allow"], [0.99, "allow"], [0.5, "allow"], [0.499999, "escalate"], [0, "escalate"]] as const)("gates probability %s in host code", async (probability, decision) => {
    fetcher.mockImplementation(async () => Response.json(response(probability)));
    const ctx = context();
    const result = await new FabricAutoApprovalClassifier().classify(action, { command: "bun run typecheck" }, ctx, "pi-fabric/typesafe/jev-latest");
    expect(result).toMatchObject({ decision, model: "pi-fabric/typesafe/jev-1.13", usage: { input: 100, output: 8, totalTokens: 108, cost: { total: 0 } } });
    expect(result.reason).toContain("requires >= 0.5");
    expect(ctx.modelRegistry.find).not.toHaveBeenCalled();
    expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(ctx.modelRegistry.getApiKeyForProvider).toHaveBeenCalledWith("jev");
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(options).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer fixture-only-key" } });
    const body = JSON.parse(options!.body as string);
    expect(body.model).toBe("jev-latest");
    expect(body.state.action).toMatchObject({ ref: "fixture.run", risk: "execute", argumentsJson: '{"command":"bun run typecheck"}' });
    expect(body.questions.safe_to_auto_approve.type).toBe("noul");
    expect(body.questions.safe_to_auto_approve.instructions).toContain("untrusted quoted evidence");
    expect(Object.keys(body.questions).sort()).toEqual([
      "destructive",
      "safe_to_auto_approve",
      "targets_agent_artifacts",
      "touches_secrets",
    ]);
    expect(body.state.session).toEqual({
      actions: [{ name: "fixture.run", argumentsJson: '{"command":"bun run typecheck"}' }],
      truncated: false,
    });
    expect(body.state.evidence).toEqual({ truncated: false, argumentsTruncated: false });
    expect(options!.body).not.toMatch(/PRIVATE|HOSTILE|fixture-only-key/);
    expect(body.state.conversation).toContain("Run the local tests");
  });

  it.each([
    [0.975, 0.975, "allow"], [0.975, 0.974999, "escalate"],
    [0, 0, "allow"], [1, 0.999999, "escalate"], [1, 1, "allow"],
  ] as const)("uses configured threshold %s for probability %s", async (threshold, probability, decision) => {
    fetcher.mockImplementation(async () => Response.json(response(probability)));
    const classifier = new FabricAutoApprovalClassifier(() => ({ ...DEFAULT_JEV_CONFIG, autoApprovalThreshold: threshold }));
    const result = await classifier.classify(action, {}, context(), "pi-fabric/typesafe/jev-latest");
    expect(result.decision).toBe(decision);
    expect(result.reason).toContain(`requires >= ${threshold}`);
  });

  it.each([-0.1, 1.01, NaN, Infinity])("rejects invalid runtime threshold %s before inference", async threshold => {
    const classifier = new FabricAutoApprovalClassifier(() => ({ ...DEFAULT_JEV_CONFIG, autoApprovalThreshold: threshold }));
    await expect(classifier.classify(action, {}, context(), "pi-fabric/typesafe/jev-latest")).rejects.toThrow("threshold must be");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("still rejects invalid answers at a zero threshold", async () => {
    fetcher.mockImplementation(async () => Response.json(response(-0.1)));
    const classifier = new FabricAutoApprovalClassifier(() => ({ ...DEFAULT_JEV_CONFIG, autoApprovalThreshold: 0 }));
    await expect(classifier.classify(action, {}, context(), "pi-fabric/typesafe/jev-latest")).rejects.toThrow("invalid");
  });

  it.each([
    [1, 0.5, 0, "escalate"],
    [1, 0, 0.5, "escalate"],
    [1, 0.499, 0.499, "allow"],
  ] as const)("hard-escalates a positive secrets or destructive verdict", async (probability, secrets, destructive, decision) => {
    fetcher.mockImplementation(async () => Response.json(response(probability, { touches_secrets: secrets, destructive })));
    const result = await new FabricAutoApprovalClassifier().classify(action, {}, context(), "pi-fabric/typesafe/jev-latest");
    expect(result.decision).toBe(decision);
    expect(result.verdicts).toMatchObject({ safeToAutoApprove: probability, touchesSecrets: secrets, destructive });
  });

  it("keeps secrets and destructive verdicts authoritative at a zero threshold", async () => {
    fetcher.mockImplementation(async () => Response.json(response(0, { touches_secrets: 1 })));
    const classifier = new FabricAutoApprovalClassifier(() => ({ ...DEFAULT_JEV_CONFIG, autoApprovalThreshold: 0 }));
    const result = await classifier.classify(action, {}, context(), "pi-fabric/typesafe/jev-latest");
    expect(result).toMatchObject({ decision: "escalate", threshold: 0 });
    expect(result.reason).toContain("secrets 1");
  });

  it("projects prior session actions from the branch without result text", async () => {
    const ctx = context();
    vi.spyOn(ctx.sessionManager, "getBranch").mockReturnValue([
      user("Clean up the scratch files you created"),
      { type: "message", message: { role: "assistant", content: [
        { type: "toolCall", name: "fabric_exec", arguments: { code: "pi.write(...)" } },
      ] } },
      { type: "message", message: { role: "toolResult", content: "ignored", details: { audits: [
        { tool: "write", args: { path: "/project/tmp/scratch.ts" }, success: true },
        { tool: "bash", args: { command: "bun run build" }, success: false, result: "HOSTILE TOOL OUTPUT" },
      ] } } },
    ] as never);
    await new FabricAutoApprovalClassifier().classify(action, {}, ctx, "pi-fabric/typesafe/jev-latest");
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body.state.session).toEqual({
      actions: [
        { name: "fabric_exec", argumentsJson: '{"code":"pi.write(...)"}' },
        { name: "write", argumentsJson: '{"path":"/project/tmp/scratch.ts"}' },
        { name: "bash", argumentsJson: '{"command":"bun run build"}', ok: false },
      ],
      truncated: false,
    });
    expect(body.state.conversation).toContain("Clean up the scratch files");
    expect(fetcher.mock.calls[0]![1]!.body).not.toContain("HOSTILE");
  });

  it("starts at the latest user turn and does not infer authority from older requests", async () => {
    const ctx = context();
    vi.spyOn(ctx.sessionManager, "getBranch").mockReturnValue([user("old".repeat(20_000)), user("Run local tests")] as never);
    await new FabricAutoApprovalClassifier().classify(action, {}, ctx, "pi-fabric/typesafe/jev-latest");
    expect(fetcher.mock.calls[0]![1]!.body).not.toContain("oldold");
  });

  it.each(["arguments", "user", "history", "tool-call", "missing-user", "non-json"])("handles incomplete %s evidence as facts or a pre-inference gate", async kind => {
    const ctx = context();
    const args: Record<string, unknown> = {};
    if (kind === "arguments") args.command = "x".repeat(16_001);
    if (kind === "user") vi.spyOn(ctx.sessionManager, "getBranch").mockReturnValue([user("x".repeat(6_001))] as never);
    if (kind === "history" || kind === "tool-call") vi.spyOn(ctx.sessionManager, "getBranch").mockReturnValue([
      user("Run local tests"),
      ...Array.from({ length: kind === "history" ? 8 : 1 }, () => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "fixture.run", arguments: { command: "x".repeat(kind === "history" ? 4_000 : 6_001) } }] } })),
    ] as never);
    if (kind === "missing-user") vi.spyOn(ctx.sessionManager, "getBranch").mockReturnValue([]);
    if (kind === "non-json") args.cycle = args;
    if (kind === "missing-user") {
      await expect(new FabricAutoApprovalClassifier().classify(action, args, ctx, "pi-fabric/typesafe/jev-latest")).rejects.toThrow("user evidence");
      expect(fetcher).not.toHaveBeenCalled();
      expect(ctx.modelRegistry.getApiKeyForProvider).not.toHaveBeenCalled();
      return;
    }
    const result = await new FabricAutoApprovalClassifier().classify(action, args, ctx, "pi-fabric/typesafe/jev-latest");
    expect(result.decision).toBe("allow");
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body.state.evidence.argumentsTruncated).toBe(kind === "arguments" || kind === "non-json");
    expect(body.state.evidence.truncated).toBe(kind === "user" || kind === "history" || kind === "tool-call");
  });

  it.each([undefined, { type: "noul", noul: 1.1 }, { type: "noul", noul: -1 }, { type: "noul", noul: "1" }, { type: "choice", choice: "allow" }])("rejects malformed typed answers", async answer => {
    fetcher.mockImplementation(async () => Response.json({ ...response(), answers: { ...response().answers, safe_to_auto_approve: answer } }));
    await expect(new FabricAutoApprovalClassifier().classify(action, {}, context(), "pi-fabric/typesafe/jev-latest")).rejects.toThrow("invalid");
  });

  it.each([401, 429, 529])("fails closed without retries or leaking the HTTP %s body", async status => {
    fetcher.mockImplementation(async () => new Response("SECRET RESPONSE BODY", { status }));
    await expect(new FabricAutoApprovalClassifier().classify(action, {}, context(), "pi-fabric/typesafe/jev-latest")).rejects.toThrow(`TypeSafe HTTP ${status}`);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("honors a pinned model and request-byte limits from trusted Jev config", async () => {
    const classifier = new FabricAutoApprovalClassifier(() => ({ ...DEFAULT_JEV_CONFIG, maxRequestBytes: 1024 }));
    await expect(classifier.classify(action, {}, context(), "pi-fabric/typesafe/jev-1.13")).rejects.toThrow("exceeds 1024 bytes");
    expect(fetcher).not.toHaveBeenCalled();
    await new FabricAutoApprovalClassifier().classify(action, {}, context(), "pi-fabric/typesafe/jev-1.13");
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).model).toBe("jev-1.13");
  });

  it("classifies through OpenRouter decisions with the openrouter credential", async () => {
    fetcher.mockImplementation(async () => Response.json({ ...response(), model: "typesafe/jev-1.13" }));
    const ctx = context();
    const result = await new FabricAutoApprovalClassifier().classify(action, { command: "bun run typecheck" }, ctx, "pi-fabric/openrouter/jev-latest");
    expect(result).toMatchObject({ decision: "allow", model: "pi-fabric/openrouter/typesafe/jev-1.13" });
    expect(ctx.modelRegistry.getApiKeyForProvider).toHaveBeenCalledWith("openrouter");
    expect(ctx.modelRegistry.find).not.toHaveBeenCalled();
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(options).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer fixture-only-key" } });
    expect(JSON.parse(options!.body as string).model).toBe("~typesafe/jev-latest");
    expect(options!.body).not.toMatch(/PRIVATE|HOSTILE|fixture-only-key/);
  });

  it("classifies through Vercel AI Gateway with the vercel-ai-gateway credential", async () => {
    fetcher.mockImplementation(async () => Response.json({ ...response(), model: "typesafe-ai/jev" }));
    const ctx = context();
    const result = await new FabricAutoApprovalClassifier().classify(action, { command: "bun run typecheck" }, ctx, "pi-fabric/vercel-ai-gateway/jev-latest");
    expect(result).toMatchObject({ decision: "allow", model: "pi-fabric/vercel-ai-gateway/typesafe-ai/jev" });
    expect(ctx.modelRegistry.getApiKeyForProvider).toHaveBeenCalledWith("vercel-ai-gateway");
    expect(ctx.modelRegistry.find).not.toHaveBeenCalled();
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    expect(options).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer fixture-only-key" } });
    expect(JSON.parse(options!.body as string).model).toBe("typesafe-ai/jev");
    expect(options!.body).not.toMatch(/PRIVATE|HOSTILE|fixture-only-key/);
    await expect(new FabricAutoApprovalClassifier().classify(action, {}, context(), "pi-fabric/vercel-ai-gateway/jev-preview")).rejects.toThrow("Vercel AI Gateway serves");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("classifies through SubQ Snap with the subq credential", async () => {
    fetcher.mockImplementation(async () => Response.json({ ...response(), model: "subq-snap-preview" }));
    const ctx = context();
    const result = await new FabricAutoApprovalClassifier().classify(action, { command: "bun run typecheck" }, ctx, "pi-fabric/subq/subq-snap-preview");
    expect(result).toMatchObject({ decision: "allow", model: "pi-fabric/subq/subq-snap-preview" });
    expect(ctx.modelRegistry.getApiKeyForProvider).toHaveBeenCalledWith("subq");
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.subq.ai/v1/systemone");
    expect(options).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer fixture-only-key" } });
    expect(JSON.parse(options!.body as string).model).toBe("subq-snap-preview");
    expect(options!.body).not.toMatch(/PRIVATE|HOSTILE|fixture-only-key/);
    await expect(new FabricAutoApprovalClassifier().classify(action, {}, context(), "pi-fabric/subq/jev-latest")).rejects.toThrow("SubQ serves");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects OpenRouter aliases the service does not expose before credentials or network", async () => {
    await expect(new FabricAutoApprovalClassifier().classify(action, {}, context(), "pi-fabric/openrouter/jev-preview")).rejects.toThrow("OpenRouter serves");
    await expect(new FabricAutoApprovalClassifier().classify(action, {}, context(), "pi-fabric/openrouter/../bad")).rejects.toThrow("not available");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses environment auth when Pi has no key and does not need a chat model", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "environment-fixture");
    const ctx = context();
    vi.mocked(ctx.modelRegistry.getApiKeyForProvider).mockResolvedValue(undefined);
    await new FabricAutoApprovalClassifier().classify(action, {}, ctx, "pi-fabric/typesafe/jev-latest");
    expect(fetcher.mock.calls[0]![1]!.headers).toMatchObject({ Authorization: "Bearer environment-fixture" });
  });

  it("sanitizes auth failures and never silently falls back to the active model", async () => {
    const ctx = context();
    vi.mocked(ctx.modelRegistry.getApiKeyForProvider).mockRejectedValue(new Error("SECRET AUTH DETAIL"));
    await expect(new FabricAutoApprovalClassifier().classify(action, {}, ctx, "pi-fabric/typesafe/jev-latest")).rejects.toThrow("Jev Pi credential resolution failed");
    expect(fetcher).not.toHaveBeenCalled();
    expect(ctx.modelRegistry.find).not.toHaveBeenCalled();
  });

  it("rejects invalid model keys before credentials or network", async () => {
    await expect(new FabricAutoApprovalClassifier().classify(action, {}, context(), "pi-fabric/typesafe/../bad")).rejects.toThrow("Invalid Jev");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not allow a stale response after cancellation, even if fetch ignores abort", async () => {
    fetcher.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const ctx = Object.assign(context(), { signal: controller.signal });
    const rejected = expect(new FabricAutoApprovalClassifier().classify(action, {}, ctx, "pi-fabric/typesafe/jev-latest")).rejects.toThrow(/cancel|abort/i);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    controller.abort();
    await rejected;
  });

  it("bounds an unresponsive transport by the configured request timeout", async () => {
    fetcher.mockImplementation(() => new Promise(() => {}));
    const classifier = new FabricAutoApprovalClassifier(() => ({ ...DEFAULT_JEV_CONFIG, requestTimeoutMs: 100 }));
    await expect(classifier.classify(action, {}, context(), "pi-fabric/typesafe/jev-latest")).rejects.toThrow("timed out");
  });
});

describe("Jev approval enforcement", () => {
  it("keeps deterministic deny authoritative and missing auth fail-closed", async () => {
    const ctx = context();
    vi.mocked(ctx.modelRegistry.getApiKeyForProvider).mockResolvedValue(undefined);
    await expect(new ApprovalController({ ...config().approvals, execute: "deny" }, ctx).approve(action)).rejects.toThrow("denied by");
    expect(ctx.modelRegistry.getApiKeyForProvider).not.toHaveBeenCalled();
    await expect(new ApprovalController(config().approvals, ctx).approve(action)).rejects.toThrow("no interactive UI");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("queues uncertainty for explicit one-use approval without widening permission", async () => {
    fetcher.mockImplementation(async () => Response.json(response(0.49)));
    const select = vi.fn(async () => "Allow once");
    const ctx = Object.assign(context(), { hasUI: true, mode: "rpc", ui: { select, notify: vi.fn() } }) as unknown as ExtensionContext;
    const session = new FabricSessionApprovals();
    const controller = new ApprovalController(config().approvals, ctx, session);
    await expect(controller.approve(action)).rejects.toThrow("pending");
    const queue = await session.permissions();
    expect(queue.list()).toHaveLength(1);
    queue.decide(queue.list()[0]!.id, "allowed");
    await expect(controller.approve(action)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(controller.approve(action)).rejects.toThrow("pending");
    expect(select).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(session.approvedRisks.size).toBe(0);
  });

  it("gates native tools and retains typed classifier usage, with live config", async () => {
    const cfg = config();
    const approval = new FabricDirectToolApproval({ getAllTools: () => [] }, () => cfg, new FabricSessionApprovals());
    const event = { type: "tool_call", toolCallId: "native", toolName: "fixture", input: {} } as ToolCallEvent;
    await approval.approve(event, context());
    expect(approval.takeUsage("native")).toMatchObject({ totalTokens: 108 });
    fetcher.mockImplementation(async () => Response.json(response(0.6)));
    await approval.approve(event, context());
    cfg.jev.autoApprovalThreshold = 0.75;
    await expect(approval.approve(event, context())).rejects.toThrow("no interactive UI");
    cfg.jev.maxRequestBytes = 1024;
    await expect(approval.approve(event, context())).rejects.toThrow("no interactive UI");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("uses configured Jev limits for observation read approval before subscribing", async () => {
    const ctx = context();
    const host = new JevObservationHost(ctx.sessionManager.getSessionId(), () => {});
    const { provider } = setupJev({ approvals: { execute: "allow", read: "auto", model: "pi-fabric/typesafe/jev-latest" }, jev: { maxRequestBytes: 1024 } }, undefined, undefined, host);
    const invocation = { ...jevContext(), extensionContext: ctx };
    const request = { ...launch("return null;"), observe: { events: ["turn_end" as const] } };
    try {
      await expect(callProgram(provider, "spawn", request, invocation)).rejects.toThrow("no interactive UI");
      expect(fetcher).not.toHaveBeenCalled();
      expect(host.size).toBe(0);
      provider.manager.options.config.jev.maxRequestBytes = DEFAULT_JEV_CONFIG.maxRequestBytes;
      const run = await callProgram(provider, "spawn", request, invocation);
      expect((await provider.manager.wait(run.id)).state).toBe("completed");
      expect(fetcher).toHaveBeenCalledOnce();
    } finally { host.close(); await provider.close(); }
  });

  it("gates actual Fabric invocation before the tool effect and records usage", async () => {
    const registry = new ActionRegistry();
    const invoke = vi.fn(async () => "executed");
    registry.register({ name: "fixture", description: "fixture", list: async () => [action], describe: async () => action, invoke });
    const cfg = config();
    cfg.fullCodeMode = false;
    const service = new FabricExecutionService(registry, cfg);
    const run = () => service.execute({ code: 'return await tools.call({ref:"fixture.run", args:{}});', signal: undefined, parentToolCallId: "jev-exec", context: context(), onPartial() {} });
    const allowed = await run();
    expect(allowed.success).toBe(true);
    expect(allowed.value).toBe("executed");
    expect(allowed.usage).toMatchObject({ input: 100, output: 8, totalTokens: 108 });
    expect(invoke).toHaveBeenCalledOnce();
    fetcher.mockImplementation(async () => Response.json(response(0.6)));
    cfg.jev.autoApprovalThreshold = 0.75;
    expect((await run()).success).toBe(false);
    expect(invoke).toHaveBeenCalledOnce();
    cfg.jev.maxRequestBytes = 1024;
    expect((await run()).success).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  }, 30_000);
});
