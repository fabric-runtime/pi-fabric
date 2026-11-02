import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerFabricActorHostEventObservers } from "../src/actors/host-event-observer.js";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { normalizeFabricConfig } from "../src/config.js";
import { FabricRuntimeState } from "../src/fabric-runtime-state.js";
import type { JevRunInfo } from "../src/jev/types.js";

describe("Main lifecycle to Jev observer integration", () => {
  it.each([false, true])("delivers real host hooks and cleans up with mesh=%s", async (mesh) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-jev-observer-"));
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
    vi.stubEnv("PI_FABRIC_PROJECT_ROOT", cwd);
    const handlers = new Map<string, Array<(event: unknown, context: ExtensionContext) => void>>();
    const sendMessage = vi.fn();
    const pi = {
      events: { emit: vi.fn() }, getThinkingLevel: () => "off", sendMessage,
      on(event: string, handler: (event: unknown, context: ExtensionContext) => void) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        return () => {
          handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
        };
      },
    } as unknown as ExtensionAPI;
    const context = {
      cwd, hasUI: false, isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false,
      modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
      sessionManager: { getSessionId: () => "observer-integration", getSessionFile: () => undefined, getBranch: () => [], getLeafId: () => undefined },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    const config = normalizeFabricConfig({
      fullCodeMode: true, mcp: { enabled: false, cache: { enabled: false } }, mesh: { enabled: mesh },
      agents: { enabled: false }, memory: { enabled: false }, residency: { enabled: false },
      prewalk: { enabled: false, alwaysRearm: false }, approvals: { agent: "allow", execute: "allow", read: "allow", network: "deny" },
    });
    const fixture = path.join(cwd, "unused.mjs");
    fs.writeFileSync(fixture, "export default {};");
    const runtime = new FabricRuntimeState(pi, new CapturedToolCatalog(), {
      paths: { extension: fixture, worker: fixture, residentHost: fixture, skills: cwd },
    });
    registerFabricActorHostEventObservers(pi, (name, event, ctx) => { runtime.dispatchHostEvent(name, event, ctx); });
    const emit = (name: string, event: unknown) => handlers.get(name)?.forEach(handler => handler(event, context));
    const invocation = {
      cwd, signal: undefined, parentToolCallId: "observer", nestedToolCallId: "observer",
      extensionContext: context, update() {}, approve: async () => {}, audits: [], maxResultChars: 32_768,
    };
    const spawn = (code: string, requires = ["jev.advise"]) => runtime.registry.invoke("jev.spawn", {
      input: null, observe: { events: ["turn_end"], delivery: "followUp" },
      program: { name: "turn-advisor", code, requires, inputSchema: {}, outputSchema: {} },
    }, invocation) as Promise<JevRunInfo>;
    const wait = (id: string) => runtime.registry.invoke("jev.wait", { id }, invocation);
    try {
      await runtime.initialize(context, config);
      const run = await spawn('const event = await program.nextEvent(); return await program.advise({eventId:event.id,message:"Check <tests> before completion"});');
      emit("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [{ type: "text", text: "private unselected response" }] }, toolResults: [] });
      expect(await wait(run.id)).toMatchObject({ state: "completed", result: { delivered: true }, observation: { consumed: 1, adviceDelivered: 1 } });
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        customType: "pi-fabric-jev", display: false, content: expect.stringContaining("Check &lt;tests&gt;"),
        details: expect.objectContaining({ runId: run.id, delivery: { mode: "steer", requestedMode: "followUp", triggerTurn: false } }),
      }), { deliverAs: "steer", triggerTurn: false });
      expect(JSON.stringify(sendMessage.mock.calls)).not.toContain("private unselected");

      const interrupted = await spawn("while(true) await program.nextEvent();");
      const interruptedWait = wait(interrupted.id);
      expect(runtime.haltAdvisors()).toBeGreaterThanOrEqual(1);
      expect(runtime.advisorsHalted).toBe(true);
      expect(await interruptedWait).toMatchObject({ state: "cancelled" });
      emit("turn_end", { type: "turn_end", turnIndex: 1 });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      emit("input", { type: "input", source: "interactive", text: "continue" });
      expect(runtime.advisorsHalted).toBe(false);

      const pinned = await spawn("while(true) await program.nextEvent();", ["jev.evaluate", "jev.advise"]);
      const pinnedWait = wait(pinned.id);
      await runtime.registry.invoke("components.reload", { id: "fabric.provider.jev" }, invocation);
      expect(await pinnedWait).toMatchObject({ state: "cancelled", observation: { queued: 0 } });
      expect(runtime.componentGraph().components.find(c => c.id === "fabric.provider.jev")?.state).toBe("active");
      const shutdown = await spawn("while(true) await program.nextEvent();");
      const shutdownWait = wait(shutdown.id);
      await runtime.shutdown();
      expect(await shutdownWait).toMatchObject({ state: "cancelled" });
    } finally {
      await runtime.shutdown();
      vi.unstubAllEnvs();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 20000);
});
