import { describe, expect, it, vi } from "vitest";
import { createProviderComponent, type FabricProviderComponentManifest } from "../src/components/provider-component.js";
import { normalizeFabricConfig } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricShellJobStore } from "../src/core/shell-jobs.js";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { AttachedMonitors } from "../src/core/attached-monitors.js";
import { TasksProvider } from "../src/providers/tasks-provider.js";
import { RuntimeStateBuiltins } from "../src/runtime-state-builtins.js";
import { WorkerMemoryProvider } from "../src/memory/worker-provider.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FabricComponentContext } from "../src/components/types.js";
import type { FabricProviderComponent } from "../src/components/provider-component.js";

const fixture = () => {
  const manifest = { install: vi.fn(async () => {}), assertActive: vi.fn() };
  const onInstalled = vi.fn();
  const registry = new ActionRegistry();
  const builtins = new RuntimeStateBuiltins(
    manifest as unknown as FabricProviderComponentManifest, registry, onInstalled,
  );
  return { manifest, onInstalled, registry, builtins };
};

describe("runtime built-in installation policy", () => {
  it("installs tasks over the same session-owned shell store as native tools", async () => {
    const { builtins, manifest } = fixture();
    const jobs = new FabricShellJobStore();
    const observations = new AttachedMonitors(jobs);
    try {
      await builtins.tools(process.cwd(), normalizeFabricConfig({ fullCodeMode: true }), new CapturedToolCatalog(), { jobs, getHangMs: () => 0, observations: () => observations });
      const entries = (manifest.install.mock.calls as unknown as Array<[FabricProviderComponent]>).map(([component]) => component);
      const component = entries.find(entry => entry.definition.name === "fabric.provider.tasks");
      expect(component).toBeDefined();
      const provide = vi.fn();
      await component!.definition.activate({ provide } as unknown as FabricComponentContext, undefined);
      const provider = provide.mock.calls[0]![0] as TasksProvider;
      expect(provider).toBeInstanceOf(TasksProvider);
      expect(provider.jobs).toBe(jobs);
      expect(await provider.describe("observe")).toBeDefined();
      expect(provider.observations?.()).toBe(observations);
    } finally { observations.close(); await jobs.close(); }
  });
  it("installs the worker-backed provider for Pi filesystem memory", async () => {
    const { builtins, manifest } = fixture();
    const context = {
      cwd: process.cwd(),
      sessionManager: { getSessionFile: () => undefined, getBranch: () => [], getLeafId: () => null },
    } as unknown as ExtensionContext;
    await builtins.memory(context, normalizeFabricConfig({ memory: { enabled: true } }), "session");
    const [component] = manifest.install.mock.calls[0] as unknown as [FabricProviderComponent];
    const provide = vi.fn();
    await component.definition.activate({ provide } as unknown as FabricComponentContext, undefined);
    const provider = provide.mock.calls[0]![0] as WorkerMemoryProvider;
    expect(provider).toBeInstanceOf(WorkerMemoryProvider);
    await provider.close();
  });

  it.each([
    { fullCodeMode: false, schema: { mode: "off" }, capture: { enabled: true }, expected: [] },
    { fullCodeMode: true, schema: { mode: "off" }, capture: { enabled: false }, expected: ["pi", "tasks"] },
    { fullCodeMode: true, schema: { mode: "off" }, capture: { enabled: true }, expected: ["pi", "tasks", "extensions"] },
    { fullCodeMode: false, schema: { mode: "enforce" }, capture: { enabled: false }, expected: ["pi", "tasks"] },
    { fullCodeMode: true, schema: { mode: "enforce" }, capture: { enabled: true }, expected: ["pi", "tasks"] },
  ])("asserts the protected provider surface for %j", ({ expected, ...options }) => {
    const { builtins, manifest, registry } = fixture();
    builtins.assertActive(normalizeFabricConfig({
      ...options, mesh: { enabled: false }, memory: { enabled: false },
    }));
    const [names, actualRegistry] = manifest.assertActive.mock.calls[0] as unknown as [Set<string>, ActionRegistry];
    expect([...names]).toEqual([...expected, "mcp", "schema", "compact", "cache", "thinking", "programs", "prewalk", "agents", ...(options.schema.mode !== "enforce" ? ["jev"] : [])]);
    expect(actualRegistry).toBe(registry);
  });

  it("records ownership only after successful activation", async () => {
    const { builtins, manifest, onInstalled } = fixture();
    const component = createProviderComponent({
      provider: "compact", description: "Fixture",
      create: () => ({
        name: "compact", description: "Fixture",
        async list() { return []; }, async describe() { return undefined; },
        async invoke() { return undefined; },
      }),
    });
    manifest.install.mockRejectedValueOnce(new Error("activation failed"));
    await expect(builtins.install(component)).rejects.toThrow("activation failed");
    expect(onInstalled).not.toHaveBeenCalled();
    await builtins.install(component);
    expect(onInstalled).toHaveBeenCalledExactlyOnceWith("fabric.provider.compact");
  });
});
