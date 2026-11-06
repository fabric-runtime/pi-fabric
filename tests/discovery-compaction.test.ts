import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricHostPolicy } from "../src/core/host-policy.js";
import type { FabricActionDescriptor, FabricInvocationContext, FabricProvider } from "../src/protocol.js";

const context: FabricInvocationContext = {
  cwd: process.cwd(), parentToolCallId: "catalog", nestedToolCallId: "catalog",
  signal: undefined, extensionContext: {} as ExtensionContext, update() {},
};
const descriptor = (name: string, description: string): FabricActionDescriptor => ({
  name, description, risk: "read", inputSchema: {
    type: "object", properties: { project_id: { type: "integer", description: "FULL-SCHEMA-ONLY" } },
    required: ["project_id"], additionalProperties: false,
  }, outputSchema: { type: "array", items: { type: "string" } },
});
const provider = (actions: FabricActionDescriptor[]): FabricProvider => ({
  name: "demo", description: "Demo operations",
  async list() { return actions; },
  async describe(name) { return actions.find(action => action.name === name); },
  async invoke() { return "receipt"; },
});

describe("compact capability catalog", () => {
  it("keeps 125 complete heads compact without changing contracts or inputs", async () => {
    const actions = Array.from({ length: 125 }, (_, i) => descriptor(`lookup_${String(i).padStart(3, "0")}`,
      `Read scoped resource ${i}.\r\nDETAIL-GUIDANCE-ONLY: preserve original opaque identifiers.`));
    actions[0]!.description = "😀".repeat(400) + "\nDO-NOT-INCLUDE-DETAILS";
    const original = structuredClone(actions);
    const registry = new ActionRegistry();
    registry.register(provider(actions));
    try {
      const result = await registry.catalog(context);
      expect(result).toMatchObject({ complete: true, totalActions: 125, indexedActions: 125, reasons: [] });
      const heads = result.providers[0]!.actions;
      expect(heads.map(head => head.name)).toEqual(actions.map(action => action.name));
      expect(heads[0]!.description).toBe("😀".repeat(320));
      expect(heads[1]!.description).toBe("Read scoped resource 1.");
      expect(heads.every(head => Array.from(head.description).length <= 320)).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/DETAIL-GUIDANCE-ONLY|DO-NOT-INCLUDE-DETAILS|FULL-SCHEMA-ONLY/);
      const full = await registry.describe("demo.lookup_000", context);
      expect(full).toMatchObject(original[0]!);
      expect(full.inputSchema).toEqual(original[0]!.inputSchema);
      expect(full.outputSchema).toEqual(original[0]!.outputSchema);
      expect(actions).toEqual(original);
    } finally { await registry.close(); }
  });

  it("hashes the full contract even when only hidden detail or schema changes", async () => {
    const actions = [descriptor("lookup", "Stable headline\nOriginal details")];
    const registry = new ActionRegistry();
    registry.register(provider(actions));
    try {
      const first = await registry.catalog(context);
      actions[0]!.description = "Stable headline\nChanged details";
      const changed = await registry.catalog(context);
      expect(changed.providers[0]!.actions[0]!.description).toBe(first.providers[0]!.actions[0]!.description);
      expect(changed.providers[0]!.actions[0]!.descriptorHash).not.toBe(first.providers[0]!.actions[0]!.descriptorHash);
      expect(changed.root.descriptorHash).not.toBe(first.root.descriptorHash);
      actions[0]!.inputSchema = { type: "object", properties: { other: { type: "boolean" } } };
      const schemaChanged = await registry.catalog(context);
      expect(schemaChanged.root.descriptorHash).not.toBe(changed.root.descriptorHash);
    } finally { await registry.close(); }
  });

  it("keeps host filtering, invocation denial and page completeness intact", async () => {
    const registry = new ActionRegistry();
    registry.register(provider([descriptor("allowed", "Read.\nDetails"), descriptor("other", "Other."), descriptor("hidden", "Hidden.")]));
    const policy = new FabricHostPolicy();
    expect(policy.apply({ owner: "test", reason: "limited", allowedRefs: ["demo.allowed", "demo.other"] }).accepted).toBe(true);
    registry.setHostPolicy(policy);
    try {
      const result = await registry.catalog(context, { limit: 1 });
      expect(result).toMatchObject({ complete: false, totalActions: 2, indexedActions: 1 });
      expect(result.providers[0]!.actions.map(action => action.ref)).toEqual(["demo.allowed"]);
      await expect(registry.invoke("demo.hidden", { project_id: 42 }, {
        ...context, approve: async () => {}, audits: [], maxResultChars: 1000,
      })).rejects.toThrow(/host policy/);
    } finally { await registry.close(); }
  });

  it("handles empty and padded first lines consistently with trimmed descriptions", async () => {
    const registry = new ActionRegistry();
    registry.register(provider([descriptor("empty", " \r\n\t"), descriptor("padded", " \nPadded headline \t\r\nFull detail\n")]));
    try {
      const result = await registry.catalog(context);
      expect(result.providers[0]!.actions.map(action => action.description)).toEqual(["", "Padded headline \t"]);
    } finally { await registry.close(); }
  });
});

describe("compound operation search", () => {
  it("tokenizes query and identity underscores symmetrically while preserving exact matches", async () => {
    const registry = new ActionRegistry();
    registry.register(provider([descriptor("metadata", "Unrelated records"), descriptor("search_work_items", "Find records")]));
    try {
      for (const query of ["work items", "__work__items__", "search_work_items", "demo.search_work_items"]) {
        expect((await registry.search(query, context))[0]?.ref).toBe("demo.search_work_items");
      }
      expect(await registry.search("___", context)).toEqual([]);
    } finally { await registry.close(); }
  });
});
