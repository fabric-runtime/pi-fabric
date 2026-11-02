import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// Offline provider with two models and a switch hook. Every entry into the
// provider's stream function is appended to MODEL_SWITCH_CALL_LOG, so a test can
// count the model calls each model received. MODEL_SWITCH_PHASE picks when the
// extension switches the session from `requested` to `other`:
//   before-start  at before_agent_start
//   between-turns at the end of the first turn (the first reply is a tool call)
//   context       inside a context handler, right before a model call
//   session-start at session_start, before Fabric's own set_model reaches the child
//   manual-compact switch when the task prompt arrives (an input handler, while the
//                 session is still idle), compact the session (the summary runs on
//                 the current model), then switch back before the run starts
//   rewrite       a before_provider_request handler rewrites the payload's model to `other`
//   none          never
// MODEL_SWITCH_TARGET names the model switched to (default `other`).
// MODEL_SWITCH_API names the provider's API (default: a custom one the guard cannot
// read a payload shape from). Every entry logs the model the PAYLOAD names, so a
// rewrite counts as a call to the model it names.
export default function (pi: ExtensionAPI) {
  const phase = process.env.MODEL_SWITCH_PHASE ?? "none";
  const target = process.env.MODEL_SWITCH_TARGET ?? "other";
  const log = (entry: Record<string, unknown>): void => {
    if (process.env.MODEL_SWITCH_CALL_LOG) fs.appendFileSync(process.env.MODEL_SWITCH_CALL_LOG, JSON.stringify(entry) + "\n");
  };
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  log({ loaded: process.pid });
  pi.registerProvider("switch-probe", {
    baseUrl: "http://127.0.0.1:1",
    apiKey: "offline-probe",
    api: (process.env.MODEL_SWITCH_API ?? "switch-probe-api") as "openai-completions",
    models: ["requested", "other", "missing credentials"].map(id => ({
      id, name: id, reasoning: true, input: ["text"] as ("text" | "image")[],
      contextWindow: 200000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
      let payload: { model: string } = { model: model.id };
      if (options?.onPayload) payload = ((await options.onPayload(payload, model)) as { model: string } | undefined) ?? payload;
      log({ provider: model.provider, id: payload.model });
      const toolTurn = phase === "between-turns" && !context.messages.some(message => message.role === "toolResult");
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: payload.model,
        content: toolTurn
          ? [{ type: "toolCall", id: "call-1", name: "switch_probe_noop", arguments: {} }]
          : [{ type: "text", text: model.provider + "/" + payload.model }],
        stopReason: toolTurn ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: zero },
      };
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end();
      })();
      return stream;
    },
  });
  pi.registerTool({
    name: "switch_probe_noop", label: "No-op", description: "Offline fixture", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "done" }], details: {} }; },
  });
  let switched = false;
  const switchToOther = async (ctx: { modelRegistry: { find(provider: string, id: string): unknown } }): Promise<void> => {
    if (switched) return;
    switched = true;
    // Logged first: an exact run ends the child inside setModel, before it returns.
    log({ switched: phase });
    await pi.setModel(ctx.modelRegistry.find("switch-probe", target) as Parameters<ExtensionAPI["setModel"]>[0]);
  };
  if (phase === "before-start") pi.on("before_agent_start", async (_event, ctx) => { await switchToOther(ctx); });
  if (phase === "between-turns") pi.on("turn_end", async (_event, ctx) => { await switchToOther(ctx); });
  if (phase === "context") pi.on("context", async (_event, ctx) => { await switchToOther(ctx); });
  if (phase === "session-start") pi.on("session_start", async (_event, ctx) => { await switchToOther(ctx); });
  if (phase === "manual-compact") {
    // Pi 1.2 marks the session busy before before_agent_start, and compact() waits for
    // the session to go idle, so compacting from that hook never finishes. The input
    // handler runs before the run starts.
    pi.on("input", async (_event, ctx) => {
      await switchToOther(ctx);
      // Only a default request gets here: an exact run has already ended.
      await new Promise<void>((resolve) => ctx.compact({ onComplete: () => resolve(), onError: () => resolve() }));
      await pi.setModel(ctx.modelRegistry.find("switch-probe", "requested") as Parameters<ExtensionAPI["setModel"]>[0]);
      return { action: "continue" as const };
    });
  }
  if (phase === "rewrite") {
    pi.on("before_provider_request", (event) => {
      log({ rewrite: true });
      return { ...(event.payload as object), model: "other" };
    });
  }
}
