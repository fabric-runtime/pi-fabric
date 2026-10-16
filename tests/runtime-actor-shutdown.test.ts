import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorStoreReadError } from "../src/actors/store-read.js";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { normalizeFabricConfig } from "../src/config.js";
import { FabricRuntimeState } from "../src/fabric-runtime-state.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A trusted main session whose project-scoped actors persist to a shared registry. */
const persistentRuntime = () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-actor-shutdown-"));
  roots.push(cwd);
  // A test run inside a Fabric child agent inherits its identity; start as a main session.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PI_FABRIC_")) vi.stubEnv(key, undefined);
  }
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
  vi.stubEnv("PI_FABRIC_PROJECT_ROOT", cwd);
  const meshRoot = path.join(cwd, ".pi", "fabric", "mesh");
  const pi = {
    events: { emit: vi.fn() },
    getThinkingLevel: vi.fn(() => "off"),
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  const context = {
    cwd,
    hasUI: false,
    isProjectTrusted: () => true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
    sessionManager: {
      getSessionId: () => "actor-shutdown-session",
      getSessionFile: () => undefined,
      getBranch: () => [],
      getLeafId: () => undefined,
    },
    ui: { setStatus: vi.fn(), notify: vi.fn(), setWidget: vi.fn(), setFooter: vi.fn() },
  } as unknown as ExtensionContext;
  const config = normalizeFabricConfig({
    schema: { mode: "off" },
    capture: { enabled: false },
    mcp: { enabled: false, cache: { enabled: false } },
    mesh: { enabled: true, actorScope: "project" },
    memory: { enabled: false },
    residency: { enabled: false },
    prewalk: { enabled: false, alwaysRearm: false },
    ui: { enabled: false },
  });
  const fixture = path.join(cwd, "unused.mjs");
  fs.writeFileSync(fixture, "export default {};");
  const runtime = new FabricRuntimeState(pi, new CapturedToolCatalog(), {
    paths: { extension: fixture, worker: fixture, residentHost: fixture, skills: cwd },
  });
  return { runtime, context, config, registryFile: path.join(meshRoot, "actors", "actors.json") };
};

describe("runtime shutdown with an unreadable actor registry", () => {
  it("finishes teardown before reporting the refused actor save", async () => {
    const { runtime, context, config, registryFile } = persistentRuntime();
    await runtime.initialize(context, config);
    await runtime.actors.create({ name: "local", instructions: "Observe." });
    expect(fs.existsSync(registryFile)).toBe(true);
    const raw = '{"format":1,"actors":[';
    fs.writeFileSync(registryFile, raw);
    const agentsClose = vi.spyOn(runtime.agents, "close");
    const shellJobsClose = vi.spyOn(runtime.shellJobs, "close");
    const registryClose = vi.spyOn(runtime.registry, "close");

    await expect(runtime.shutdown()).rejects.toThrow(ActorStoreReadError);

    // Every step after the actors still ran.
    expect(agentsClose).toHaveBeenCalledOnce();
    expect(shellJobsClose).toHaveBeenCalledOnce();
    expect(registryClose).toHaveBeenCalledOnce();
    expect(() => runtime.actors).toThrow("Pi Fabric has not initialized");
    expect(() => runtime.registry).toThrow("Pi Fabric has not initialized");
    // The refused save left the registry as it was.
    expect(fs.readFileSync(registryFile, "utf8")).toBe(raw);
  });

  it("reinitializes after the previous generation's actor save is refused", async () => {
    const { runtime, context, config, registryFile } = persistentRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runtime.initialize(context, config);
    await runtime.actors.create({ name: "local", instructions: "Observe." });
    const raw = '{"format":1,"actors":[';
    fs.writeFileSync(registryFile, raw);
    const previousAgents = runtime.agents;
    const agentsClose = vi.spyOn(previousAgents, "close");

    try {
      await runtime.initialize(context, config);

      expect(agentsClose).toHaveBeenCalledOnce();
      expect(runtime.agents).not.toBe(previousAgents);
      expect(warn.mock.calls.filter(([message]) => String(message).includes(registryFile))).toHaveLength(1);
      expect(fs.readFileSync(registryFile, "utf8")).toBe(raw);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
