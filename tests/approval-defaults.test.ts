import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadFabricConfig, loadFabricConfigForScope, normalizeFabricConfig, saveFabricConfig } from "../src/config.js";
import { ApprovalController } from "../src/core/approval-controller.js";
import type { FabricAutoApprovalClassifier } from "../src/core/auto-approval-classifier.js";
import type { ResolvedFabricAction } from "../src/core/action-registry.js";
import { buildPartial } from "../src/ui/settings-values.js";

const risks = ["read", "write", "execute", "network", "agent"] as const;
const action = (risk: typeof risks[number]): ResolvedFabricAction => ({
  ref: `demo.${risk}`, provider: "demo", name: risk, description: risk, inputSchema: {}, risk,
});
const context = { hasUI: false } as ExtensionContext;

describe("default approval policy", () => {
  it("preserves legacy category policies and defaults to allow", () => {
    expect(normalizeFabricConfig({}).approvals).toEqual({ default: "allow" });
    expect(normalizeFabricConfig({ approvals: { write: "ask", execute: "deny" } }).approvals)
      .toEqual({ default: "allow", write: "ask", execute: "deny" });
    expect(normalizeFabricConfig({ approvals: { default: "invalid", read: "invalid" } }).approvals)
      .toEqual({ default: "allow", read: "allow" });
  });

  it.each(risks)("routes inherited %s access through the auto classifier", async risk => {
    const classify = vi.fn(async () => ({ decision: "allow", reason: "safe", model: "test/classifier" }));
    const controller = new ApprovalController(
      normalizeFabricConfig({ approvals: { default: "auto" } }).approvals,
      context, undefined, { classify } as unknown as FabricAutoApprovalClassifier,
    );
    expect(controller.decidesWithoutInteraction(action(risk))).toBe(false);
    await controller.approve(action(risk), { value: risk });
    expect(classify).toHaveBeenCalledOnce();
    expect(classify).toHaveBeenCalledWith(action(risk), { value: risk }, context, undefined);
  });

  it.each(risks)("honors inherited allow, ask, and deny for %s", async risk => {
    await expect(new ApprovalController({ default: "allow" }, context).approve(action(risk))).resolves.toBeUndefined();
    await expect(new ApprovalController({ default: "ask" }, context).approve(action(risk))).rejects.toThrow("no interactive UI");
    await expect(new ApprovalController({ default: "deny" }, context).approve(action(risk))).rejects.toThrow("policy");
  });

  it("preserves category and action overrides ahead of the default", async () => {
    const classify = vi.fn();
    const config = normalizeFabricConfig({ approvals: {
      default: "auto", write: "deny", read: "allow", actions: { "demo.execute": "deny" },
    } }).approvals;
    const controller = new ApprovalController(config, context, undefined, { classify } as unknown as FabricAutoApprovalClassifier);
    await expect(controller.approve(action("write"))).rejects.toThrow("write policy");
    await expect(controller.approve(action("execute"))).rejects.toThrow("approvals.actions");
    await expect(controller.approve(action("read"))).resolves.toBeUndefined();
    expect(classify).not.toHaveBeenCalled();
  });

  it("fails closed when an inherited auto classifier errors or escalates", async () => {
    for (const classify of [
      vi.fn(async () => { throw new Error("offline"); }),
      vi.fn(async () => ({ decision: "escalate", reason: "uncertain", model: "test/classifier" })),
    ]) {
      const controller = new ApprovalController({ default: "auto" }, context, undefined,
        { classify } as unknown as FabricAutoApprovalClassifier);
      await expect(controller.approve(action("execute"))).rejects.toThrow("no interactive UI");
    }
  });

  it("saves sparse defaults, inherits across scopes, and resets existing overrides atomically", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-default-policy-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const location = { cwd, agentDir, projectTrusted: true };
    try {
      fs.mkdirSync(cwd, { recursive: true });
      saveFabricConfig({ ...location, scope: "global" }, { approvals: { default: "auto", write: "deny", actions: { "demo.execute": "deny" } } });
      saveFabricConfig({ ...location, scope: "project" }, { approvals: { read: "ask" } });
      expect(loadFabricConfig(location).approvals).toEqual({ default: "auto", write: "deny", read: "ask", actions: { "demo.execute": "deny" } });
      saveFabricConfig({ ...location, scope: "project" }, buildPartial("approvals.resetOverrides", "reset"));
      expect(loadFabricConfig(location).approvals).toEqual({ default: "auto", actions: { "demo.execute": "deny" } });
      expect(loadFabricConfigForScope(location, "global").approvals.write).toBe("deny");
      expect(loadFabricConfig({ ...location, projectTrusted: false }).approvals.write).toBe("deny");
      expect(JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "fabric.json"), "utf8")).approvals)
        .toEqual(Object.fromEntries(risks.map(risk => [risk, "inherit"])));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
