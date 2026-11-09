import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import piFabric from "../src/index.js";
import { MISSING_TOOL_RESULT_TEXT } from "../src/compaction/orphan-repair.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { CompactController } from "../src/core/compact-controller.js";
import { FabricState } from "../src/fabric-state.js";

type Handler = (...args: unknown[]) => unknown;

const loadExtension = async (): Promise<Map<string, Handler[]>> => {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    events: { emit: vi.fn(), on: vi.fn(() => () => undefined) },
    getActiveTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
  await piFabric(pi);
  return handlers;
};

const hostContext = (sessionId = "session-1") => ({
  hasUI: false,
  sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
});

describe("Fabric compaction extension hooks", () => {
  afterEach(() => vi.restoreAllMocks());

  it("repairs orphaned tool results in the outgoing context and keeps clean lists untouched", async () => {
    const handlers = await loadExtension();
    const [context] = handlers.get("context")!;
    const clean = [
      { role: "user", content: "go", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }], stopReason: "toolUse", timestamp: 1 },
      { role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1 },
    ];
    expect(await context!({ type: "context", messages: clean }, hostContext())).toBeUndefined();

    const broken = [
      { role: "user", content: "go", timestamp: 1 },
      { role: "toolResult", toolCallId: "ghost", toolName: "read", content: [{ type: "text", text: "x" }], isError: false, timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "b", name: "read", arguments: {} }], stopReason: "toolUse", timestamp: 1 },
      { role: "user", content: "again", timestamp: 1 },
    ];
    const repaired = await context!({ type: "context", messages: broken }, hostContext()) as {
      messages: Array<{ role: string; toolCallId?: string; content?: unknown }>;
    };
    expect(repaired.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
    expect(repaired.messages[2]).toMatchObject({
      toolCallId: "b",
      isError: true,
      content: [{ type: "text", text: MISSING_TOOL_RESULT_TEXT }],
    });
  });

  it.each(["inactive", "native", "managed"])("skips post-abort compaction in the %s host", async (mode) => {
    const handlers = await loadExtension();
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.compaction.thresholds["anthropic/sonnet"] = 0.8;
    config.compaction.engine = "fabric";
    vi.spyOn(FabricState.prototype, "config", "get").mockReturnValue(config);
    vi.spyOn(FabricState.prototype, "initialized", "get").mockReturnValue(mode !== "inactive");
    if (mode === "managed") vi.spyOn(FabricState.prototype, "managedHostOptions", "get").mockReturnValue({} as never);
    const compact = new CompactController();
    compact.request({ reason: "pending before Escape", seed: "do not run after Escape" });
    vi.spyOn(FabricState.prototype, "compact", "get").mockReturnValue(compact);
    const publish = vi.spyOn(FabricState.prototype, "publishHostLifecycle").mockResolvedValue();
    const context = { ...hostContext(), model: { provider: "anthropic", id: "sonnet" },
      getContextUsage: () => ({ tokens: 90_000, contextWindow: 100_000, percent: 90 }),
      compact: vi.fn(), ui: { setStatus: vi.fn(), notify: vi.fn() },
      // Pi has cleared the turn's signal by agent_settled; use the event flag.
      signal: undefined,
    };
    const event = { type: "agent_settled", aborted: true };
    for (const handler of handlers.get("agent_settled")!) await handler(event, context);
    expect(context.compact).not.toHaveBeenCalled();
    if (mode === "native") expect(compact.status().pending).toBeUndefined();
    if (mode !== "inactive") expect(publish).toHaveBeenCalledWith("pi.agent_settled", event);
  });

  it.each(["agent_start", "agent_end", "turn_end", "agent_settled"])("settles an aborted %s without waiting for the mesh lock or actor history", async (name) => {
    const handlers = await loadExtension();
    vi.spyOn(FabricState.prototype, "config", "get").mockReturnValue(structuredClone(DEFAULT_FABRIC_CONFIG));
    vi.spyOn(FabricState.prototype, "initialized", "get").mockReturnValue(true);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(FabricState.prototype, "compact", "get").mockReturnValue(new CompactController());
    const dispatch = vi.spyOn(FabricState.prototype, "dispatchHostEvent");
    let release!: () => void;
    const publish = vi.spyOn(FabricState.prototype, "publishHostLifecycle")
      .mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const controller = new AbortController();
    controller.abort();
    const context = { ...hostContext(), signal: controller.signal };
    const event = { type: name, aborted: true };
    const pending = Promise.all(handlers.get(name)!.map(handler => handler(event, context)));
    try {
      const outcome = await Promise.race([
        pending.then(() => "settled"),
        new Promise<string>(resolve => setImmediate(() => resolve("blocked"))),
      ]);
      expect(outcome).toBe("settled");
      expect(publish).toHaveBeenCalledWith(`pi.${name}`, event);
      expect(dispatch).not.toHaveBeenCalled();
    } finally { release?.(); await pending; }
  });
  it("still waits for threshold compaction after a completed run", async () => {
    const handlers = await loadExtension();
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.compaction.thresholds["anthropic/sonnet"] = 0.8;
    vi.spyOn(FabricState.prototype, "config", "get").mockReturnValue(config);
    let complete!: () => void;
    const context = { ...hostContext(), model: { provider: "anthropic", id: "sonnet" },
      getContextUsage: () => ({ tokens: 90_000, contextWindow: 100_000, percent: 90 }),
      compact: vi.fn((options: { onComplete: (result: unknown) => void }) => { complete = () => options.onComplete({}); }),
    };
    let settled = false;
    const wait = Promise.all(handlers.get("agent_settled")!.map((handler) => handler({ type: "agent_settled", aborted: false }, context)))
      .then(() => { settled = true; });
    expect(context.compact).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    complete();
    await wait;
  });

  it("warns once per session when another extension owns a compaction", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handlers = await loadExtension();
    const sessionCompact = handlers.get("session_compact")!;
    const event = {
      type: "session_compact",
      compactionEntry: { type: "compaction", details: { compactor: "other" }, fromHook: true },
      fromExtension: true,
      reason: "threshold",
      willRetry: false,
    };
    for (const handler of sessionCompact) await handler(event, hostContext());
    for (const handler of sessionCompact) await handler(event, hostContext());
    const ownership = warn.mock.calls.filter(([message]) => String(message).includes("load order"));
    expect(ownership).toHaveLength(1);
  });
});
