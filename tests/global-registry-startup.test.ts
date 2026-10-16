import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { normalizeFabricConfig } from "../src/config.js";
import { FabricRuntimeState } from "../src/fabric-runtime-state.js";

describe("global actor registry at runtime startup", () => {
  it("warns once when the global actor registry exists but cannot be read", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-global-startup-"));
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    const agentDir = path.join(cwd, "agent");
    const registryFile = path.join(agentDir, "fabric", "actors", "global-actors.json");
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    const raw = '{"format":1,"actors":[';
    fs.writeFileSync(registryFile, raw);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_FABRIC_PROJECT_ROOT", cwd);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const notify = vi.fn();

    const pi = {
      events: { emit: vi.fn() },
      getThinkingLevel: vi.fn(() => "off"),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    const context = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
      sessionManager: {
        getSessionId: () => "global-startup-session",
        getSessionFile: () => undefined,
        getBranch: () => [],
        getLeafId: () => undefined,
      },
      ui: { setStatus: vi.fn(), notify, setWidget: vi.fn(), setFooter: vi.fn() },
    } as unknown as ExtensionContext;
    const config = normalizeFabricConfig({
      schema: { mode: "enforce" },
      capture: { enabled: false },
      mcp: { enabled: false, cache: { enabled: false } },
      mesh: { enabled: false },
      memory: { enabled: false },
      agents: { enabled: false },
      residency: { enabled: false },
      prewalk: { enabled: false, alwaysRearm: false },
      ui: { enabled: false },
    });
    const fixture = path.join(cwd, "unused.mjs");
    fs.writeFileSync(fixture, "export default {};");
    const runtime = new FabricRuntimeState(pi, new CapturedToolCatalog(), {
      paths: { extension: fixture, worker: fixture, residentHost: fixture, skills: cwd },
    });

    try {
      await runtime.initialize(context, config);
      const warnings = notify.mock.calls.filter(
        ([message, level]) => level === "warning" && String(message).includes(registryFile),
      );
      expect(warnings).toHaveLength(1);
      expect(warn.mock.calls.filter(([message]) => String(message).includes(registryFile))).toHaveLength(1);
      expect(() => runtime.globalActors.list()).toThrow(registryFile);
      expect(fs.readFileSync(registryFile, "utf8")).toBe(raw);
    } finally {
      await runtime.shutdown();
      warn.mockRestore();
      vi.unstubAllEnvs();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
