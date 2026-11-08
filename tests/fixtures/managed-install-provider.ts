import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

// Deterministic offline model: nested tools must reach the live runner and
// its tool_call hooks, including on a compiled host with no physical SDK.
export default function (pi: ExtensionAPI) {
  let calls = 0;
  const seen = new Set<string>();
  pi.on("tool_call", event => {
    if (!event.parentToolCallId) return;
    seen.add(event.toolName);
    if (JSON.stringify(event.input).includes("capture-probe-denied")) {
      return { block: true, reason: "capture-probe-denied" };
    }
  });
  pi.registerTool({
    name: "capture_probe", label: "Capture probe", description: "Check nested tool hooks",
    parameters: Type.Object({}),
    execute: async () => {
      for (const name of ["write", "edit", "bash"]) {
        if (!seen.has(name)) throw new Error(`Missing nested ${name} hook`);
      }
      return { content: [{ type: "text", text: "captured" }], details: {} };
    },
  });
  pi.registerProvider("managed-install", {
    baseUrl: "http://127.0.0.1:1",
    apiKey: "offline-probe",
    api: "managed-install-api",
    models: [{
      id: "probe", name: "Probe", reasoning: false, input: ["text"],
      contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model) {
      const file = JSON.stringify(process.env.FABRIC_PROBE_FILE);
      const code = calls++ === 0
        ? `
          await pi.write({ path: ${file}, content: "hello from scratch\\n" });
          await pi.edit({ path: ${file}, oldText: "scratch", newText: "probe" });
          await pi.bash({ command: "echo capture-hook-probe" });
          for (const [name, args] of [
            ["write", { path: ${file} + ".capture-probe-denied", content: "blocked" }],
            ["edit", { path: ${file}, oldText: "probe", newText: "capture-probe-denied" }],
            ["bash", { command: "echo capture-probe-denied" }],
          ] as const) {
            let blocked = false;
            try { await tools.call({ ref: "pi." + name, args }); }
            catch (error) { blocked = String(error).includes("capture-probe-denied"); }
            if (!blocked) throw new Error(name + " skipped its blocking hook");
          }
          await extensions.capture_probe({});
          return await pi.read({ path: ${file} });`
        : undefined;
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: code
          ? [{ type: "toolCall", id: "probe-call", name: "fabric_exec", arguments: { code } }]
          : [{ type: "text", text: "Probe finished." }],
        stopReason: code ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: code ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    },
  });
}
