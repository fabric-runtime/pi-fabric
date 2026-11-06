import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  MainAgentController,
  resolveFabricIdentity,
} from "../src/main-agent.js";

describe("MainAgentController", () => {
  it("resolves root, recursive-agent, and actor identities without losing the root Main target", () => {
    expect(resolveFabricIdentity("root", {})).toEqual({
      identity: {
        id: "session:root",
        name: "main",
        kind: "main",
        sessionId: "root",
      },
      mainAgentId: "session:root",
    });

    expect(
      resolveFabricIdentity("child", {
        PI_FABRIC_PARENT_RUN: "run-child",
        PI_FABRIC_AGENT_NAME: "Implementor",
        PI_FABRIC_MAIN_AGENT_ID: "session:root",
      }),
    ).toEqual({
      identity: {
        id: "run-child",
        name: "Implementor",
        kind: "agent",
        sessionId: "child",
      },
      mainAgentId: "session:root",
    });

    expect(
      resolveFabricIdentity("actor-session", {
        PI_FABRIC_ACTOR_ID: "actor-supervisor",
        PI_FABRIC_ACTOR_NAME: "Supervisor",
        PI_FABRIC_PARENT_RUN: "actor-worker-run",
        PI_FABRIC_MAIN_AGENT_ID: "session:root",
      }),
    ).toEqual({
      identity: {
        id: "actor-supervisor",
        name: "Supervisor",
        kind: "actor",
        sessionId: "actor-session",
      },
      mainAgentId: "session:root",
    });
  });

  it("reports live Main state and preserves user versus agent message semantics", () => {
    const sendMessage = vi.fn();
    const sendUserMessage = vi.fn();
    const pi = {
      sendMessage,
      sendUserMessage,
      getThinkingLevel: vi.fn(() => "high"),
    } as unknown as ExtensionAPI;
    const controller = new MainAgentController(
      pi,
      "session:root",
      true,
      "/tmp/project",
      "root",
    );
    const context = {
      model: { provider: "anthropic", id: "claude-test" },
      isIdle: () => false,
      hasPendingMessages: () => true,
    } as unknown as ExtensionContext;

    expect(controller.info(context)).toMatchObject({
      id: "session:root",
      name: "Main",
      kind: "main",
      status: "running",
      model: "anthropic/claude-test",
      thinking: "high",
      pendingMessages: true,
      local: true,
    });

    expect(controller.deliverUser("  user correction  ", "steer")).toMatchObject({
      queued: true,
      routed: "main",
    });
    expect(sendUserMessage).toHaveBeenCalledWith("user correction", {
      deliverAs: "steer",
    });

    expect(
      controller.deliverAgent({
        from: { id: "actor-1", name: "Supervisor", kind: "actor" },
        message: "inspect <unsafe> & continue",
        delivery: "followUp",
        data: { priority: 2 },
      }),
    ).toMatchObject({ queued: true, routed: "main" });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "pi-fabric-agent-message",
        content: expect.stringContaining("inspect &lt;unsafe&gt; &amp; continue"),
        details: expect.objectContaining({
          from: { id: "actor-1", name: "Supervisor", kind: "actor" },
          delivery: "steer",
          requestedDelivery: "followUp",
          data: { priority: 2 },
        }),
      }),
      { deliverAs: "steer", triggerTurn: true },
    );

    const longMessage = "x".repeat(20_000);
    const longData = { body: "y".repeat(20_000) };
    controller.deliverAgent({
      from: { id: "agent-1", name: "worker", kind: "agent" },
      message: longMessage,
      delivery: "steer",
      data: longData,
    });
    expect(sendMessage.mock.calls.at(-1)?.[0]).toMatchObject({
      content: expect.stringContaining(longMessage),
      details: { data: longData },
    });

    controller.deliverAgent({
      from: { id: "session:peer", name: "Peer", kind: "main" },
      message: "peer settled",
      delivery: "followUp",
      triggerTurn: false,
    });
    expect(sendMessage.mock.calls.at(-1)?.[1]).toEqual({
      deliverAs: "steer",
      triggerTurn: false,
    });
  });

  it.each(["steer", "followUp"] as const)("keeps peer %s passive by default and honors explicit wake choices", delivery => {
    const sendMessage = vi.fn();
    const controller = new MainAgentController({ sendMessage } as unknown as ExtensionAPI, "session:root", true, "/tmp/project");
    const from = { id: "session:peer", name: "main", kind: "main" as const };
    for (const triggerTurn of [undefined, false, true]) {
      controller.deliverAgent({ from, message: "Progress update", delivery, ...(triggerTurn === undefined ? {} : { triggerTurn }) });
      expect(sendMessage.mock.calls.at(-1)?.[1]).toEqual({ deliverAs: "steer", triggerTurn: triggerTurn ?? false });
      expect(sendMessage.mock.calls.at(-1)?.[0].details.triggerTurn).toBe(triggerTurn ?? false);
    }
    for (const source of [
      { id: "child", name: "worker", kind: "agent" as const },
      { id: "actor", name: "reviewer", kind: "actor" as const },
      { id: "session:root", name: "main", kind: "main" as const },
    ]) {
      controller.deliverAgent({ from: source, message: "Action needed", delivery });
      expect(sendMessage.mock.calls.at(-1)?.[1]).toEqual({ deliverAs: "steer", triggerTurn: true });
    }
  });

  it("rejects direct delivery from a process that does not own Main", () => {
    const controller = new MainAgentController(
      {
        getThinkingLevel: vi.fn(),
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as unknown as ExtensionAPI,
      "session:root",
      false,
      "/tmp/project",
    );

    expect(
      controller.info({
        model: { provider: "child", id: "private-model" },
        isIdle: () => false,
        hasPendingMessages: () => true,
      } as unknown as ExtensionContext),
    ).toEqual(
      expect.objectContaining({
        id: "session:root",
        status: "remote",
        local: false,
        pendingMessages: false,
      }),
    );
    expect(controller.info()).not.toHaveProperty("model");
    expect(controller.info()).not.toHaveProperty("cwd");
    expect(controller.info()).not.toHaveProperty("startedAt");

    expect(() => controller.deliverUser("message", "steer")).toThrow(/owned by another/);
    expect(() =>
      controller.deliverAgent({
        from: { id: "agent-1", name: "worker", kind: "agent" },
        message: "message",
        delivery: "steer",
      }),
    ).toThrow(/owned by another/);
  });
});

describe("MainAgentController.switchModel", () => {
  const buildContext = (found: unknown): ExtensionContext =>
    ({
      modelRegistry: { find: vi.fn(() => found) },
    }) as unknown as ExtensionContext;

  it("switches through pi.setModel with the registry model", async () => {
    const model = { provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" };
    const setModel = vi.fn(async () => true);
    const pi = { setModel } as unknown as ExtensionAPI;
    const controller = new MainAgentController(pi, "session:root", true, "/tmp/project", "root");
    const context = buildContext(model);

    await expect(
      controller.switchModel({ provider: "google", id: "gemini-2.5-flash" }, context),
    ).resolves.toEqual({ ok: true });
    expect(setModel).toHaveBeenCalledWith(model);
  });

  it("fails when the registry cannot resolve the model", async () => {
    const setModel = vi.fn(async () => true);
    const pi = { setModel } as unknown as ExtensionAPI;
    const controller = new MainAgentController(pi, "session:root", true, "/tmp/project", "root");

    await expect(
      controller.switchModel({ provider: "cohere", id: "command-r" }, buildContext(undefined)),
    ).resolves.toEqual({ ok: false, error: "Model is not available: cohere/command-r" });
    expect(setModel).not.toHaveBeenCalled();
  });

  it("fails when the host rejects the switch for missing authentication", async () => {
    const model = { provider: "google", id: "gemini-2.5-flash" };
    const setModel = vi.fn(async () => false);
    const pi = { setModel } as unknown as ExtensionAPI;
    const controller = new MainAgentController(pi, "session:root", true, "/tmp/project", "root");

    await expect(
      controller.switchModel({ provider: "google", id: "gemini-2.5-flash" }, buildContext(model)),
    ).resolves.toEqual({
      ok: false,
      error: "No authentication configured for model: google/gemini-2.5-flash",
    });
  });

  it("refuses remote Main targets", async () => {
    const pi = {} as unknown as ExtensionAPI;
    const controller = new MainAgentController(pi, "session:peer", false, "/tmp/project", "peer");

    await expect(
      controller.switchModel({ provider: "google", id: "gemini-2.5-flash" }, buildContext(undefined)),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("another Fabric process") });
  });
});

