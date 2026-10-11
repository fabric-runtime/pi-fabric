import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

// Deterministic offline model: delegate once, then implement only when the
// executor-local continuation arrives through the real Pi follow-up loop.
// Claim success only from a successful tool result: the assistant's own
// tool-call code also contains the verification string.
const verified = (messages: readonly unknown[]): boolean => messages.some(message => {
  const entry = message as { role?: unknown; isError?: unknown; content?: unknown };
  return entry.role === "toolResult" && entry.isError !== true &&
    JSON.stringify(entry.content).includes("verified direct continuation");
});

export default function (pi: ExtensionAPI) {
  let calls = 0;
  pi.registerProvider("handoff-probe", {
    baseUrl: "http://127.0.0.1:1",
    apiKey: "offline-probe",
    api: "handoff-probe-api",
    models: [{
      id: "executor", name: "Executor", reasoning: false, input: ["text"],
      contextWindow: 200000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, context) {
      calls++;
      const text = JSON.stringify(context.messages);
      let code: string | undefined;
      if (calls === 1) {
        code = 'await agents.handoff({ model: "handoff-probe/executor", task: "Nested delegation" }); return "scheduled";';
      } else if (calls === 2 && text.includes("Continue your original assigned task directly")) {
        code = [
          'const partial = await pi.read({ path: "partial.txt" });',
          'if (!partial.includes("already done")) throw new Error("lost completed work");',
          'await pi.write({ path: "continued.txt", text: "continued directly" });',
          'const written = await pi.read({ path: "continued.txt" });',
          'if (!written.includes("continued directly")) throw new Error("verification failed");',
          'return "verified direct continuation";',
        ].join("\n");
      }
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: code
          ? [{ type: "toolCall", id: `probe-${calls}`, name: "fabric_exec", arguments: { code } }]
          : [{ type: "text", text: verified(context.messages)
              ? "Finished original assignment directly after the failed handoff; verification passed."
              : "The handoff failed; stopping instead of finishing the assignment." }],
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
