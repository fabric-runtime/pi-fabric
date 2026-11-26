import { describe, expect, it, vi } from "vitest";
import {
  createToolOwnershipReassertion,
  fabricToolLoadout,
  fabricModelContext,
  FabricToolOwnership,
} from "../src/core/tool-ownership.js";

const hostWith = (initial: string[]) => {
  let active = [...initial];
  const setActiveTools = vi.fn((names: string[]) => {
    active = [...names];
  });
  return {
    host: {
      getActiveTools: () => [...active],
      setActiveTools,
    },
    active: () => active,
    setActiveTools,
  };
};

describe("FabricToolOwnership", () => {
  it("keeps direct tools callable while ensuring the orchestrator stays active", () => {
    const state = hostWith(["read", "bash", "custom_tool"]);
    const ownership = new FabricToolOwnership(state.host);
    expect(ownership.apply(true)).toBe(true);
    expect(state.active()).toEqual(["read", "bash", "custom_tool", "fabric_exec"]);
    expect(ownership.apply(true)).toBe(false);
    expect(state.setActiveTools).toHaveBeenCalledOnce();
    expect(ownership.release()).toBe(false);
    expect(ownership.apply(false)).toBe(false);
    expect(state.active()).toContain("read");
  });

  it("re-activates Fabric without undoing another extension's selection", () => {
    const state = hostWith(["fabric_exec"]);
    const ownership = new FabricToolOwnership(state.host);
    state.host.setActiveTools(["read", "late_mcp"]);
    ownership.apply(true, new Set(["late_mcp"]));
    expect(state.active()).toEqual(["read", "late_mcp", "fabric_exec"]);
  });

  it("does not alter tools in orchestration-only mode", () => {
    const state = hostWith(["read"]);
    expect(new FabricToolOwnership(state.host).apply(false)).toBe(false);
    expect(state.setActiveTools).not.toHaveBeenCalled();
  });

  it("hides every other declaration, including historical, deferred and native orchestrators", () => {
    const names = ["fabric_exec", "read", "codemode", "tool_search", "late_mcp", "deferred", "withdrawn"];
    const registered = names.map((name) => ({ name }));
    const loadout = { registered, declared: registered.slice(0, 4), callable: registered.slice(1) } as unknown as Parameters<typeof fabricToolLoadout>[0];
    expect(fabricToolLoadout(loadout, true)?.hiddenDeclarations).toEqual(names.slice(1));
    expect(fabricToolLoadout(loadout, false)).toBeUndefined();
  });
});

describe("hidden-tool guidance", () => {
  it("carries only hidden callable guidelines without changing optional loadouts", () => {
    const names = ["fabric_exec", "read", "deferred", "foreground", "withdrawn"];
    const registered = names.map(name => ({ name, description: name }));
    const loadout = {
      registered, declared: registered, callable: registered.slice(1, 4),
      getPromptGuidelines: (name: string) => [`rule:${name}`],
    } as unknown as Parameters<typeof fabricToolLoadout>[0];
    const result = fabricToolLoadout(loadout, true, ["foreground"]);
    expect(result?.descriptions?.fabric_exec).toContain("rule:read");
    expect(result?.descriptions?.fabric_exec).toContain("rule:deferred");
    expect(result?.descriptions?.fabric_exec).not.toContain("rule:foreground");
    expect(result?.descriptions?.fabric_exec).not.toContain("rule:withdrawn");
    expect(fabricToolLoadout(loadout, false)).toBeUndefined();
  });

  it("labels codemode-script lines nativeTools-only in the additive profile and keeps them in native", () => {
    const script = "`read` in a codemode script resolves to the file's text; pass `anchors: true` to receive `{ text, lines, notices }`.";
    const other = "`read`: call again after an edit when you need anchors you lack.";
    const registered = ["fabric_exec", "read"].map(name => ({ name, description: name }));
    const loadout = {
      registered, declared: registered, callable: registered.slice(1),
      getPromptGuidelines: () => [script, other],
    } as unknown as Parameters<typeof fabricToolLoadout>[0];
    const additive = fabricToolLoadout(loadout, true)?.descriptions?.fabric_exec ?? "";
    expect(additive.split("\n")).toContain(`- nativeTools only: ${script}`);
    expect(additive.split("\n")).toContain(`- ${other}`);
    expect(additive).not.toContain(`nativeTools only: ${other}`);
    const native = fabricToolLoadout(loadout, true, [], { nativeProfile: true })?.descriptions?.fabric_exec ?? "";
    expect(native.split("\n")).toContain(`- ${script}`);
    expect(native).not.toContain("nativeTools only:");
  });
});

describe("fabricModelContext", () => {
  it("retains the latest native loadout description through authoritative projection", () => {
    const tool = { name: "fabric_exec", description: "base", parameters: {} };
    const messages = [
      { role: "system", content: "", toolsAdded: [{ ...tool, description: "old" }], timestamp: 1 },
      { role: "system", content: "", toolsAdded: [{ ...tool, description: "current guidelines" }], timestamp: 2 },
    ] as Parameters<typeof fabricModelContext>[0];
    expect(fabricModelContext(messages, tool)[0]).toMatchObject({ toolsAdded: [{ ...tool, description: "current guidelines" }] });
  });
  it("removes historical additions/removals without changing messages or prompt sections", () => {
    const tool = { name: "fabric_exec", description: "Fabric", parameters: { type: "object", properties: {} } };
    const messages = [
      { role: "system", content: "system", sections: { guidelines: "keep" }, toolsAdded: [{ ...tool, name: "read" }], timestamp: 1 },
      { role: "user", content: "request", timestamp: 2 },
      { role: "system", content: "delta", toolsAdded: [{ ...tool, name: "late" }], toolsRemoved: [{ name: "fabric_exec" }], timestamp: 3 },
    ] as Parameters<typeof fabricModelContext>[0];
    const result = fabricModelContext(messages, tool);
    expect(result[0]).toMatchObject({ content: "system", sections: { guidelines: "keep" }, toolsAdded: [tool] });
    expect(result[1]).toBe(messages[1]);
    expect(result[2]).toEqual({ role: "system", content: "delta", timestamp: 3 });
    expect(messages[2]).toHaveProperty("toolsRemoved");
  });
});

describe("createToolOwnershipReassertion", () => {
  it("no-ops scheduled reassertions that run before the host is ready", async () => {
    // Registry rebuilds fire during extension load, before session_start
    // initializes Fabric state; the deferred reassertion must not read config.
    let ready = false;
    const apply = vi.fn();
    const { schedule } = createToolOwnershipReassertion({
      ready: () => ready,
      active: () => true,
      hiddenNames: () => new Set(["ask_user_question"]),
      apply,
    });

    schedule();
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();

    ready = true;
    schedule();
    await Promise.resolve();
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(new Set(["ask_user_question"]));
  });

  it("dedupes simultaneous schedules and skips reassertion while inactive", async () => {
    let active = false;
    const apply = vi.fn();
    const { reassert, schedule } = createToolOwnershipReassertion({
      ready: () => true,
      active: () => active,
      hiddenNames: () => new Set(["deploy_release"]),
      apply,
    });

    schedule();
    schedule();
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();

    active = true;
    reassert();
    expect(apply).toHaveBeenCalledOnce();
  });
});
