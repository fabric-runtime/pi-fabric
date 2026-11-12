import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { FabricPermissionQueue } from "../src/core/permission-queue.js";
import { ApprovalController, FabricSessionApprovals } from "../src/core/approval-controller.js";
import type { FabricAutoApprovalClassifier } from "../src/core/auto-approval-classifier.js";
import type { ResolvedFabricAction } from "../src/core/action-registry.js";
import { FabricPermissionsComponent, openFabricPermissions } from "../src/ui/permissions.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { runFabricCommand } from "../src/commands/fabric-handler.js";

const action: ResolvedFabricAction = { ref: "pi.bash", provider: "pi", name: "bash", description: "Run shell", risk: "execute", inputSchema: {} };
const args = { cmd: "echo hello" };
const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as Theme;
const context = { cwd: "/project", hasUI: true, mode: "tui", ui: { custom: vi.fn(async () => new Promise(() => {})), setStatus: vi.fn(), notify: vi.fn() } } as unknown as ExtensionContext;
const escalate = () => ({ decision: "escalate" as const, reason: "Needs a person", model: "test/classifier" });

function fixture(classify = vi.fn(async () => escalate())) {
  const session = new FabricSessionApprovals();
  const config = { default: "auto" as "auto" | "deny" };
  const controller = new ApprovalController(config, context, session, { classify } as unknown as FabricAutoApprovalClassifier);
  return { session, config, controller, classify };
}

describe("permission queue", () => {
  it("deduplicates blocked calls and consumes one explicit grant exactly once", () => {
    const queue = new FabricPermissionQueue();
    const first = queue.block(action, args, "/project", "reason");
    expect(queue.block(action, args, "/project", "reason").id).toBe(first.id);
    expect(queue.take(action, args, "/project")).toMatchObject({ status: "pending" });
    queue.decide(first.id, "allowed");
    expect(queue.take(action, args, "/project")).toBe("allowed");
    expect(queue.take(action, args, "/project")).toBeUndefined();
    expect(queue.list()[0]?.status).toBe("used");
    expect(() => queue.decide(first.id, "allowed")).toThrow("no longer pending");
  });

  it("binds permission to the full arguments, action metadata, and directory", () => {
    const queue = new FabricPermissionQueue();
    const record = queue.block(action, args, "/project", "reason");
    queue.decide(record.id, "allowed");
    expect(queue.take(action, { cmd: "echo different" }, "/project")).toBeUndefined();
    expect(queue.take(action, args, "/elsewhere")).toBeUndefined();
    expect(queue.take({ ...action, description: "Replacement tool" }, args, "/project")).toBeUndefined();
    expect(queue.take(action, args, "/project")).toBe("allowed");
  });

  it("does not alias different complete arguments behind the same clipped preview", () => {
    const queue = new FabricPermissionQueue();
    const a = { cmd: "x".repeat(3000) + "a" }, b = { cmd: "x".repeat(3000) + "b" };
    const record = queue.block(action, a, "/project", "reason");
    queue.decide(record.id, "allowed");
    expect(queue.take(action, b, "/project")).toBeUndefined();
    expect(queue.take(action, a, "/project")).toBe("allowed");
    expect(() => queue.block(action, { bad: NaN }, "/project", "reason")).toThrow();
  });

  it("expires pending and granted requests and invalidates every ticket on clear", () => {
    let now = 0;
    const queue = new FabricPermissionQueue(() => now);
    const record = queue.block(action, args, "/project", "reason");
    queue.decide(record.id, "allowed");
    now = record.expiresAt;
    expect(queue.take(action, args, "/project")).toBeUndefined();
    expect(queue.list()[0]?.status).toBe("expired");
    const next = queue.block(action, args, "/project", "reason");
    queue.clear();
    expect(() => queue.decide(next.id, "allowed")).toThrow();
    expect(queue.list()).toEqual([]);
  });

  it("bounds retained requests without evicting pending human decisions", () => {
    const queue = new FabricPermissionQueue();
    for (let i = 0; i < 200; i++) queue.block(action, { cmd: `echo ${i}` }, "/project", "review");
    expect(queue.pendingCount).toBe(200);
    expect(() => queue.block(action, { cmd: "one more" }, "/project", "review")).toThrow("queue is full");
    expect(queue.pendingCount).toBe(200);
  });

  it("denials stay denied without granting execution or reviving the same request", () => {
    const queue = new FabricPermissionQueue();
    const record = queue.block(action, args, "/project", "reason");
    queue.decide(record.id, "denied");
    expect(queue.take(action, args, "/project")).toMatchObject({ status: "denied" });
    expect(() => queue.decide(record.id, "allowed")).toThrow();
  });

  it("returns immediately on auto escalation, then allows only an identical retry", async () => {
    const { controller, session, classify } = fixture();
    await expect(controller.approve(action, args)).rejects.toThrow("/fabric permissions");
    const queue = await session.permissions();
    expect(queue.list()).toHaveLength(1);
    await expect(controller.approve(action, args)).rejects.toThrow(queue.list()[0]!.id);
    expect(classify).toHaveBeenCalledOnce();
    queue.decide(queue.list()[0]!.id, "allowed");
    await expect(controller.approve(action, args)).resolves.toBeUndefined();
    expect(classify).toHaveBeenCalledOnce();
    await expect(controller.approve(action, args)).rejects.toThrow("pending");
    expect(classify).toHaveBeenCalledTimes(2);
    expect(context.ui.custom).not.toHaveBeenCalled();
  });

  it("does not let a queued grant lift a newly configured deny", async () => {
    const { controller, session, config } = fixture();
    await expect(controller.approve(action, args)).rejects.toThrow("pending");
    const queue = await session.permissions();
    queue.decide(queue.list()[0]!.id, "allowed");
    config.default = "deny";
    await expect(controller.approve(action, args)).rejects.toThrow("execute policy");
    expect(queue.list()[0]?.status).toBe("allowed");
  });

  it("keeps an explicit queue denial ahead of later session risk grants", async () => {
    const { controller, session } = fixture();
    await expect(controller.approve(action, args)).rejects.toThrow("pending");
    const queue = await session.permissions();
    queue.decide(queue.list()[0]!.id, "denied");
    session.approvedRisks.add("execute");
    await expect(controller.approve(action, args)).rejects.toThrow("denied");
  });

  it("queues an auto-mode hook hold without waiting and still honors later hook denies", async () => {
    const session = new FabricSessionApprovals();
    const evaluate = vi.fn(async () => ({ decision: "hold" as "hold" | "deny", hook: "review", reason: "review" }));
    const controller = new ApprovalController({ default: "auto" }, context, session, undefined, undefined, undefined, undefined,
      { active: true, evaluate });
    await expect(controller.approve(action, args)).rejects.toThrow("pending");
    const queue = await session.permissions();
    queue.decide(queue.list()[0]!.id, "allowed");
    evaluate.mockResolvedValue({ decision: "deny", hook: "review", reason: "new restriction" });
    await expect(controller.approve(action, args)).rejects.toThrow("policy hook");
    expect(queue.list()[0]?.status).toBe("allowed");
  });

  it("classifies unrelated calls concurrently instead of serializing human waits", async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const classify = vi.fn(async () => { await wait; return escalate(); });
    const { controller } = fixture(classify);
    const settled = Promise.allSettled([controller.approve(action, args), controller.approve(action, { cmd: "echo other" })]);
    await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(2));
    release();
    expect((await settled).map(result => result.status)).toEqual(["rejected", "rejected"]);
  });

  it("does not insert a classifier result after the session has changed", async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const classify = vi.fn(async () => { await wait; return escalate(); });
    const { controller, session } = fixture(classify);
    const pending = expect(controller.approve(action, args)).rejects.toThrow("session changed");
    await vi.waitFor(() => expect(classify).toHaveBeenCalledOnce());
    session.clear();
    release();
    await pending;
    expect((await session.permissions()).list()).toEqual([]);
  });
});

describe("permissions command", () => {
  it("delivers an invisible follow-up only after explicit user approval", async () => {
    const session = new FabricSessionApprovals();
    const queue = await session.permissions();
    const record = queue.block(action, args, "/project", "review");
    const sendMessage = vi.fn();
    const ensure = vi.fn(() => session.clear());
    const select = vi.fn().mockImplementationOnce(async (_title, rows) => rows[0]).mockResolvedValueOnce("Allow once");
    await runFabricCommand(
      { sendMessage } as unknown as Parameters<typeof runFabricCommand>[0],
      { state: { ensure, sessionApprovals: session } } as unknown as Parameters<typeof runFabricCommand>[1],
      {} as Parameters<typeof runFabricCommand>[2], "permissions",
      { hasUI: true, mode: "rpc", ui: { select, setStatus: vi.fn() } } as unknown as Parameters<typeof runFabricCommand>[4],
    );
    expect(ensure).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      display: false, customType: "fabric-permission-results", content: expect.stringContaining(record.id),
    }), { triggerTurn: true, deliverAs: "followUp" });
    expect(queue.list()[0]?.status).toBe("allowed");
  });

  it("does not deliver a stale approval after the session changes", async () => {
    const session = new FabricSessionApprovals();
    const queue = await session.permissions();
    queue.block(action, args, "/project", "review");
    const sendMessage = vi.fn();
    const select = vi.fn().mockImplementationOnce(async (_title, rows) => rows[0]).mockImplementationOnce(async () => {
      session.clear(); return "Allow once";
    });
    await runFabricCommand(
      { sendMessage } as unknown as Parameters<typeof runFabricCommand>[0],
      { state: { ensure: vi.fn(), sessionApprovals: session } } as unknown as Parameters<typeof runFabricCommand>[1],
      {} as Parameters<typeof runFabricCommand>[2], "permissions",
      { hasUI: true, mode: "rpc", ui: { select, setStatus: vi.fn(), notify: vi.fn() } } as unknown as Parameters<typeof runFabricCommand>[4],
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("permissions UI", () => {
  it.each([30, 40, 80, 120])("shows an explicit review screen and fits %s columns", width => {
    const queue = new FabricPermissionQueue();
    queue.block(action, args, "/project", "Needs review\x1b[31m");
    const done = vi.fn();
    const component = new FabricPermissionsComponent(theme, queue, done, () => 18);
    expect(component.render(width).join("\n")).toContain("Permissions");
    component.handleInput("a"); // No approval from the unreviewed list.
    expect(queue.list()[0]?.status).toBe("pending");
    component.handleInput("\r");
    const lines = component.render(width);
    expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
    expect(lines).toHaveLength(18);
    expect(lines.join("\n")).not.toContain("\x1b[31m");
    component.handleInput("a");
    expect(queue.list()[0]?.status).toBe("allowed");
    expect(component.decisions).toHaveLength(1);
    component.handleInput("\x1b");
    expect(done).toHaveBeenCalledOnce();
  });

  it("leaves the request pending when review is dismissed", () => {
    const queue = new FabricPermissionQueue();
    queue.block(action, args, "/project", "review");
    const component = new FabricPermissionsComponent(theme, queue, vi.fn());
    component.handleInput("\r"); component.handleInput("\x1b");
    expect(queue.list()[0]?.status).toBe("pending");
  });

  it("supports RPC triage without opening terminal components", async () => {
    const queue = new FabricPermissionQueue();
    queue.block(action, args, "/project", "review");
    const select = vi.fn().mockImplementationOnce(async (_title, rows) => rows[0]).mockResolvedValueOnce("Allow once");
    const result = await openFabricPermissions({ hasUI: true, mode: "rpc", ui: { select, setStatus: vi.fn() } } as unknown as ExtensionContext, queue);
    expect(result[0]?.status).toBe("allowed");
    expect(select).toHaveBeenCalledTimes(2);
  });
});
