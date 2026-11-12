import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  ApprovalController,
  FabricSessionApprovals,
} from "../src/core/approval-controller.js";
import type { FabricAutoApprovalClassifier } from "../src/core/auto-approval-classifier.js";
import type { ResolvedFabricAction } from "../src/core/action-registry.js";

const action: ResolvedFabricAction = {
  ref: "demo.write",
  provider: "demo",
  name: "write",
  description: "Write data",
  inputSchema: {},
  risk: "write",
};

const policies = {
  read: "allow" as const,
  write: "ask" as const,
  execute: "deny" as const,
  network: "ask" as const,
  agent: "ask" as const,
};

const tuiContext = (
  custom: (...args: unknown[]) => Promise<unknown>,
  notify = vi.fn(),
): ExtensionContext => ({
  hasUI: true,
  mode: "tui",
  ui: { custom, notify },
} as unknown as ExtensionContext);

describe("ApprovalController", () => {
  it("fails closed when approval is required without a UI", async () => {
    const controller = new ApprovalController(policies, { hasUI: false } as ExtensionContext);
    await expect(controller.approve(action)).rejects.toThrow("no interactive UI");
  });

  it("allows only the selected call when Allow once is chosen", async () => {
    const custom = vi.fn(async () => "allow-once");
    const notify = vi.fn();
    const controller = new ApprovalController(policies, tuiContext(custom, notify));

    await controller.approve(action);
    await controller.approve({ ...action, ref: "demo.writeAgain" });

    expect(custom).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith("Allowed once: demo.write", "info");
    expect(notify).toHaveBeenCalledWith("Allowed once: demo.writeAgain", "info");
  });

  it("shares an Always allow grant across the Pi session", async () => {
    const custom = vi.fn(async () => "allow-session");
    const notify = vi.fn();
    const session = new FabricSessionApprovals();
    const firstExecution = new ApprovalController(
      policies,
      tuiContext(custom, notify),
      session,
    );
    const laterExecution = new ApprovalController(
      policies,
      tuiContext(custom, notify),
      session,
    );

    await firstExecution.approve(action);
    await laterExecution.approve({ ...action, ref: "demo.writeLater" });

    expect(custom).toHaveBeenCalledOnce();
    expect(session.approvedRisks).toContain("write");
    expect(notify).toHaveBeenLastCalledWith(
      "Allowed write access for this Pi session",
      "info",
    );
  });

  it("uses an RPC-compatible three-choice dialog", async () => {
    const select = vi.fn(async () => "Allow write access for this session");
    const notify = vi.fn();
    const controller = new ApprovalController(policies, {
      hasUI: true,
      mode: "rpc",
      ui: { select, notify },
    } as unknown as ExtensionContext);

    await controller.approve(action);

    expect(select).toHaveBeenCalledWith(
      "Pi Fabric permission · demo.write requests write access. Write data",
      ["Allow once", "Allow write access for this session", "Deny"],
    );
  });

  it("auto-allows only the exact classified action", async () => {
    const classify = vi.fn(async () => ({
      decision: "allow" as const,
      reason: "Routine task-aligned local write",
      model: "anthropic/classifier",
      usage: {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 12,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }));
    const classifier = { classify } as unknown as FabricAutoApprovalClassifier;
    const controller = new ApprovalController(
      { ...policies, write: "auto", model: "anthropic/classifier" },
      { hasUI: false } as ExtensionContext,
      new FabricSessionApprovals(),
      classifier,
    );
    const args = { path: "src/index.ts", content: "safe" };

    await controller.approve(action, args);

    expect(classify).toHaveBeenCalledWith(
      action,
      args,
      expect.anything(),
      "anthropic/classifier",
    );
  });

  it("queues an unsafe auto decision without opening or waiting for a wizard", async () => {
    const classifier = {
      classify: vi.fn(async () => ({
        decision: "escalate" as const,
        reason: "Command modifies shared production state",
        model: "anthropic/classifier",
        usage: {
          input: 10,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 12,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      })),
    } as unknown as FabricAutoApprovalClassifier;
    const custom = vi.fn(async () => "allow-once");
    const notify = vi.fn();
    const controller = new ApprovalController(
      { ...policies, write: "auto" },
      tuiContext(custom, notify),
      new FabricSessionApprovals(),
      classifier,
    );

    await expect(controller.approve(action, { path: "production" })).rejects.toThrow("pending");
    expect(custom).not.toHaveBeenCalled();
    expect((await controller.sessionApprovals.permissions()).list()[0]).toMatchObject({
      ref: "demo.write", status: "pending", reason: expect.stringContaining("Auto mode escalated"),
    });
  });

  it("fails closed to explicit approval when the classifier is unavailable", async () => {
    const classifier = {
      classify: vi.fn(async () => { throw new Error("model unavailable"); }),
    } as unknown as FabricAutoApprovalClassifier;
    const custom = vi.fn(async () => "deny");
    const controller = new ApprovalController(
      { ...policies, write: "auto" },
      tuiContext(custom),
      new FabricSessionApprovals(),
      classifier,
    );

    await expect(controller.approve(action)).rejects.toThrow("pending");
    expect(custom).not.toHaveBeenCalled();
  });

  it("fails closed and notifies when the user denies or dismisses", async () => {
    const custom = vi.fn(async () => "deny");
    const notify = vi.fn();
    const controller = new ApprovalController(policies, tuiContext(custom, notify));

    await expect(controller.approve(action)).rejects.toThrow(
      "User denied write access for demo.write",
    );
    expect(notify).toHaveBeenLastCalledWith(
      "Denied write access for demo.write",
      "warning",
    );
  });

  it("serializes concurrent one-time requests instead of widening the grant", async () => {
    const custom = vi.fn(async () => "allow-once");
    const controller = new ApprovalController(policies, tuiContext(custom));

    await Promise.all([
      controller.approve(action),
      controller.approve({ ...action, ref: "demo.parallelWrite" }),
    ]);

    expect(custom).toHaveBeenCalledTimes(2);
  });

  it("lets a queued request inherit a session grant without a second prompt", async () => {
    const custom = vi.fn(async () => "allow-session");
    const controller = new ApprovalController(policies, tuiContext(custom));

    await Promise.all([
      controller.approve(action),
      controller.approve({ ...action, ref: "demo.parallelWrite" }),
    ]);

    expect(custom).toHaveBeenCalledOnce();
  });

  it("reports whether policy alone settles an approval, without prompting", () => {
    const custom = vi.fn(async () => "allow-once");
    const readAction: ResolvedFabricAction = { ...action, ref: "demo.read", name: "read", risk: "read" };
    const controller = new ApprovalController(policies, tuiContext(custom));
    expect(controller.decidesWithoutInteraction(readAction)).toBe(true);
    expect(controller.decidesWithoutInteraction({ ...action, risk: "execute" })).toBe(true);
    expect(controller.decidesWithoutInteraction(action)).toBe(false);
    expect(controller.decidesWithoutInteraction({ ...action, risk: "network" })).toBe(false);
    const asking = new ApprovalController({ ...policies, read: "auto" }, tuiContext(custom));
    expect(asking.decidesWithoutInteraction(readAction)).toBe(false);
    const overridden = new ApprovalController({ ...policies, actions: { "demo.write": "allow", "demo.read": "deny" } }, tuiContext(custom));
    expect(overridden.decidesWithoutInteraction(action)).toBe(true);
    expect(overridden.decidesWithoutInteraction(readAction)).toBe(true);
    expect(custom).not.toHaveBeenCalled();
  });

  it("denies actions blocked by policy without prompting", async () => {
    const custom = vi.fn(async () => "allow-once");
    const controller = new ApprovalController(policies, tuiContext(custom));
    await expect(controller.approve({ ...action, risk: "execute" })).rejects.toThrow(
      "denied by the Fabric execute policy",
    );
    expect(custom).not.toHaveBeenCalled();
  });
});
