import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { normalizeFabricConfig } from "../src/config.js";
import { FabricRuntimeState } from "../src/fabric-runtime-state.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Every file under a directory, or none when it does not exist. */
const filesUnder = (root: string): string[] =>
  fs.existsSync(root) ? fs.readdirSync(root, { recursive: true, encoding: "utf8" }) : [];

/**
 * The error a call rejects with, or a marker when it resolves or is still
 * waiting (on a resident host it should never have started) after a bound.
 */
const outcome = (call: Promise<unknown>, boundMs = 3_000): Promise<unknown> =>
  Promise.race([
    call.then(() => "resolved", (error: unknown) => error),
    new Promise(resolve => setTimeout(resolve, boundMs, "still pending")).then(value => value),
  ]);

/** A trusted main session that owns a durable residency client. */
const durableRuntime = () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-wrapper-reload-")));
  roots.push(cwd);
  // A test run inside a Fabric child agent inherits its identity; start as a main session.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PI_FABRIC_")) vi.stubEnv(key, undefined);
  }
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
  vi.stubEnv("PI_FABRIC_PROJECT_ROOT", cwd);
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
    modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn(), getAvailable: () => [] },
    sessionManager: {
      getSessionId: () => "wrapper-reload-session",
      getSessionFile: () => undefined,
      getBranch: () => [],
      getLeafId: () => undefined,
    },
    ui: { setStatus: vi.fn(), notify: vi.fn(), setWidget: vi.fn(), setFooter: vi.fn() },
  } as unknown as ExtensionContext;
  const config = (launchWrapper?: string[]) => normalizeFabricConfig({
    schema: { mode: "off" },
    capture: { enabled: false },
    mcp: { enabled: false, cache: { enabled: false } },
    mesh: { enabled: true, actorScope: "project" },
    memory: { enabled: false },
    prewalk: { enabled: false, alwaysRearm: false },
    ui: { enabled: false },
    ...(launchWrapper ? { agents: { launchWrapper } } : {}),
  });
  const fixture = path.join(cwd, "unused.mjs");
  fs.writeFileSync(fixture, "export default {};");
  const runtime = new FabricRuntimeState(pi, new CapturedToolCatalog(), {
    paths: { extension: fixture, worker: fixture, residentHost: fixture, skills: cwd },
  });
  const invocation = {
    cwd, signal: undefined, parentToolCallId: "test", nestedToolCallId: "nested", extensionContext: context,
    update() {}, approve: async () => {}, audits: [], maxResultChars: 10_000,
  };
  return { runtime, context, config, invocation, residencyRoot: path.join(cwd, ".pi", "fabric", "mesh", "residency") };
};

describe("agents.launchWrapper added by a config reload", () => {
  it("refuses durable spawns and durable actors without writing anything for the resident host", async () => {
    const { runtime, context, config, invocation, residencyRoot } = durableRuntime();
    await runtime.initialize(context, config());
    try {
      expect(runtime.agents.config.launchWrapper).toBeUndefined();

      // The path /fabric reload takes once it has read the edited configuration.
      runtime.reloadConfig(context, config(["/opt/sandbox/wrap", "--"]));
      expect(runtime.agents.config.launchWrapper).toEqual(["/opt/sandbox/wrap", "--"]);

      const spawned = await outcome(runtime.registry.invoke(
        "agents.spawn", { task: "durable", residency: "durable" }, invocation));
      const created = await outcome(runtime.registry.invoke(
        "agents.create", { name: "durable-actor", instructions: "Observe.", residency: "durable" }, invocation));
      // Nothing was written for the resident host, so it was never asked to start.
      expect(filesUnder(residencyRoot)).toEqual([]);
      expect(spawned).toBeInstanceOf(Error);
      expect((spawned as Error).message).toMatch(/agents\.launchWrapper/);
      expect(created).toBeInstanceOf(Error);
      expect((created as Error).message).toMatch(/agents\.launchWrapper/);
    } finally {
      await runtime.shutdown();
    }
  });
});
