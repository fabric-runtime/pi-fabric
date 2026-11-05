import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const boundaryLoaded = vi.hoisted(() => vi.fn());
const pastedImagesLoaded = vi.hoisted(() => vi.fn());
vi.mock("../src/core/pasted-images.js", async original => {
  pastedImagesLoaded();
  return original<typeof import("../src/core/pasted-images.js")>();
});
vi.mock("../src/prewalk/handoff.js", async original => {
  boundaryLoaded();
  return original<typeof import("../src/prewalk/handoff.js")>();
});

afterEach(() => vi.unstubAllEnvs());

describe("Prewalk startup boundary", () => {
  it("keeps the boundary engine out of cold registration and idle lifecycle", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-prewalk-startup-"));
    const agentDir = path.join(cwd, "agent");
    fs.mkdirSync(agentDir);
    fs.mkdirSync(path.join(cwd, ".pi"));
    fs.writeFileSync(path.join(cwd, ".pi", "fabric.json"), JSON.stringify({
      prewalk: { alwaysRearm: false }, mesh: { enabled: false }, components: [],
    }));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    for (const key of ["PI_FABRIC_PARENT_RUN", "PI_FABRIC_ACTOR_ID", "PI_FABRIC_DEPTH", "PI_FABRIC_CAPABILITY_REQUIREMENTS", "PI_FABRIC_CAPABILITY_DIGEST"]) {
      vi.stubEnv(key, undefined);
    }
    type Handler = (event: unknown, context: ExtensionContext) => unknown;
    const handlers = new Map<string, Handler[]>();
    const pi = {
      events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
      on: vi.fn((event: string, handler: Handler) => {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
      }),
      getActiveTools: vi.fn(() => []), getAllTools: vi.fn(() => []),
      registerCommand: vi.fn(), registerMessageRenderer: vi.fn(), registerTool: vi.fn(),
      setActiveTools: vi.fn(), sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    const context = {
      cwd, hasUI: false, isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => "startup-session", getBranch: () => [] },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    const emit = async (event: string) => {
      for (const handler of handlers.get(event) ?? []) await handler({}, context);
    };
    try {
      vi.resetModules();
      const { default: register } = await import("../src/index.js");
      expect(boundaryLoaded).not.toHaveBeenCalled();
      expect(pastedImagesLoaded).not.toHaveBeenCalled();
      await register(pi);
      expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "fabric_exec" }));
      expect(pi.registerCommand).toHaveBeenCalledWith("fabric", expect.anything());
      for (const event of ["resources_discover", "session_start"]) {
        expect(handlers.get(event)?.length).toBeGreaterThan(0);
        await emit(event);
        expect(boundaryLoaded).not.toHaveBeenCalled();
      }
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(boundaryLoaded).not.toHaveBeenCalled();
      for (const handler of handlers.get("input") ?? []) {
        await handler({ source: "interactive", text: "ordinary prompt" }, context);
      }
      expect(pastedImagesLoaded).not.toHaveBeenCalled();
      for (const handler of handlers.get("input") ?? []) {
        await handler({ source: "interactive", text: "pi-clipboard-first-use" }, context);
      }
      expect(pastedImagesLoaded).toHaveBeenCalledTimes(1);
    } finally {
      await emit("session_shutdown");
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
