import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { MainAgentController } from "../src/main-agent.js";
import { deliverActorFeedback } from "../src/actors/feedback.js";
import type { FabricActorDeliveryRequest } from "../src/actors/types.js";
import { AgentMessageRouter } from "../src/providers/agents-message-router.js";

const setup = (hasUI = true) => {
  const sendMessage = vi.fn(), sendUserMessage = vi.fn(), notify = vi.fn();
  const pi = { sendMessage, sendUserMessage } as unknown as ExtensionAPI;
  const context = { hasUI, ui: { notify } } as unknown as ExtensionContext;
  const main = new MainAgentController(pi, "session:main", true, "/repo", "main", context);
  return { pi, context, main, sendMessage, sendUserMessage, notify };
};
const from = { id: "child-1", name: "Reviewer", kind: "agent" as const };

describe("Main feedback projection", () => {
  it.each(["agent", "actor", "main"] as const)("hides %s feedback, preserves its wake policy, and retains full content and audit data", kind => {
    const h = setup();
    const message = "First line\n" + "x".repeat(20_000);
    const data = { payload: "private-data".repeat(2000) };
    const triggerTurn = kind !== "main";
    const result = h.main.deliverAgent({ from: { ...from, kind }, message, data, delivery: "followUp" });
    expect(h.sendMessage).toHaveBeenCalledOnce();
    expect(h.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      customType: "pi-fabric-agent-message", display: false,
      content: expect.stringContaining(message),
      details: { id: result.messageId, from: { ...from, kind }, delivery: "steer", requestedDelivery: "followUp", triggerTurn, data },
    }), { deliverAs: "steer", triggerTurn });
    expect(h.sendMessage.mock.calls[0]![0].content).toContain(data.payload);
    expect(h.notify).toHaveBeenCalledOnce();
    const notice = h.notify.mock.calls[0]![0] as string;
    expect(notice).toContain("Reviewer");
    expect(notice).toContain("First line");
    expect(notice.length).toBeLessThanOrEqual(328);
    expect(notice).not.toContain("private-data");
    expect(notice).not.toContain("\n");
    expect(h.sendUserMessage).not.toHaveBeenCalled();
    data.payload = "changed";
    expect(h.sendMessage.mock.calls[0]![0].details.data.payload).not.toBe("changed");
  });

  it("sanitizes terminal sequences, control and bidi characters only in the notification", () => {
    const h = setup();
    const message = "\u001b[31mred\u001b[0m\nnew\u0007line\u202ereversed";
    h.main.deliverAgent({ from: { ...from, name: "\u001b]0;title\u0007Reviewer\nname" }, message, delivery: "followUp" });
    expect(h.notify).toHaveBeenCalledWith("Agent Reviewer name: red new line reversed", "info");
    expect(h.sendMessage.mock.calls[0]![0].content).toContain(message);
  });

  it.each([false, true])("preserves passive triggerTurn and is safe with hasUI=%s", hasUI => {
    const h = setup(hasUI);
    h.main.deliverAgent({ from, message: "passive", delivery: "followUp", triggerTurn: false });
    expect(h.sendMessage.mock.calls[0]![1]).toEqual({ deliverAs: "steer", triggerTurn: false });
    expect(h.notify).toHaveBeenCalledTimes(hasUI ? 1 : 0);
  });

  it("does not replay delivery on UI failure, and never notifies a failed send", () => {
    const h = setup();
    h.notify.mockImplementation(() => { throw new Error("UI closed"); });
    expect(() => h.main.deliverAgent({ from, message: "accepted", delivery: "followUp" })).not.toThrow();
    expect(h.sendMessage).toHaveBeenCalledOnce();
    h.notify.mockClear();
    h.sendMessage.mockImplementation(() => { throw new Error("host closed"); });
    expect(() => h.main.deliverAgent({ from, message: "rejected", delivery: "followUp" })).toThrow("host closed");
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("retains JSON serialization, rejects blank messages, and preserves direct human controls", () => {
    const h = setup(false);
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    for (const data of [cyclic, 1n]) {
      h.main.deliverAgent({ from, message: "data", data, delivery: "steer" });
      expect(h.sendMessage.mock.calls.at(-1)![0].details.data).toEqual({ fabricUnserializable: true });
    }
    expect(() => h.main.deliverAgent({ from, message: " \n ", delivery: "followUp" })).toThrow(/empty/);
    h.main.deliverUser("human follow-up", "followUp");
    h.main.deliverUser("human steering", "steer");
    expect(h.sendUserMessage.mock.calls).toEqual([
      ["human follow-up", { deliverAs: "followUp" }], ["human steering", { deliverAs: "steer" }],
    ]);
  });

  it("normalizes owner-addressed peer feedback without changing one-shot target controls", async () => {
    const h = setup();
    const manager = { status: vi.fn(() => ({ name: "Child" })), steer: vi.fn(() => ({ messageId: "s" })), followUp: vi.fn(() => ({ messageId: "f" })), stop: vi.fn() };
    const router = new AgentMessageRouter(manager as never, { identity: from } as never, h.main, { get: () => undefined, scheduleRefresh() {} }, undefined, binding => binding);
    await router.routeMessage("main", "local", { full: "data" }, "followUp");
    await router.acceptControl({ targetId: "session:main", operation: "followUp", message: "remote", triggerTurn: false, data: { peer: true } } as never, { id: "peer", name: "Peer", kind: "main" });
    expect(h.sendMessage.mock.calls.map(call => call[1])).toEqual([
      { deliverAs: "steer", triggerTurn: true }, { deliverAs: "steer", triggerTurn: false },
    ]);
    expect(h.notify.mock.calls[1]![0]).toContain("Peer");
    await router.routeMessage("child", "keep explicit queue", undefined, "followUp");
    expect(manager.followUp).toHaveBeenCalledWith("child", "keep explicit queue", undefined);
    expect(manager.steer).not.toHaveBeenCalled();
  });
});

describe("Actor feedback projection", () => {
  it.each(["steer", "followUp", "nextTurn"] as const)("projects %s with full structured data, preserving nextTurn", delivery => {
    const h = setup();
    const request = {
      actor: { id: "actor-1", name: "Supervisor" },
      message: { id: "out-1", text: "inspect <tests> " + "x".repeat(20_000), data: { body: "y".repeat(20_000) } },
      delivery, triggerTurn: false,
    } as FabricActorDeliveryRequest;
    deliverActorFeedback(h.pi, h.context, request);
    const [sent, options] = h.sendMessage.mock.calls[0]!;
    expect(options).toEqual({ deliverAs: delivery === "nextTurn" ? "nextTurn" : "steer", triggerTurn: false });
    expect(sent.display).toBe(false);
    expect(sent.details.delivery).toMatchObject({ mode: options.deliverAs, requestedMode: delivery });
    expect(sent.content).toContain("inspect &lt;tests&gt;");
    expect(sent.content).toContain(request.message.data && (request.message.data as { body: string }).body);
    expect(sent.details.message).toEqual(request.message);
    expect(h.notify).toHaveBeenCalledOnce();
    expect(h.notify.mock.calls[0]![0].length).toBeLessThan(328);
  });
});
