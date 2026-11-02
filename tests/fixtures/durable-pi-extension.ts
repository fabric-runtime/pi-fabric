import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default async function (pi: ExtensionAPI) {
  // Pi's jiti maps the package root to its compat facade; resolve this test-only
  // native subpath explicitly rather than extending that root alias.
  const { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } = await import(process.env.DURABLE_TEST_FAUX_MODULE!) as typeof import("@earendil-works/pi-ai/providers/faux");
  const faux = fauxProvider({ provider: "durable-offline", models: [{ id: "test", reasoning: true, input: ["text", "image"] }], tokensPerSecond: 100000 });
  pi.registerProvider({ ...faux.provider, auth: { apiKey: { name: "Offline", resolve: async () => ({ auth: { apiKey: "offline" } }) } } });
  faux.setResponses(Array.from({ length: 30 }, () => context => {
    const last = context.messages.filter(message => message.role === "user" || message.role === "toolResult").at(-1);
    const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
    if (last?.role === "toolResult") return fauxAssistantMessage(`result:${text}`);
    if (text === "read fixture") return fauxAssistantMessage([fauxToolCall("read", { path: process.env.DURABLE_TEST_FILE! })]);
    if (text === "write fixture") return fauxAssistantMessage([fauxToolCall("write", { path: process.env.DURABLE_TEST_FILE!, content: "overwritten" })]);
    if (text === "fabric fixture") return fauxAssistantMessage([fauxToolCall("fabric_exec", { code: process.env.DURABLE_TEST_FABRIC_CODE! })]);
    if (text === "hold effect") return fauxAssistantMessage([fauxToolCall("hold_effect", {})]);
    // A preamble, then a tool that ends the run, like a compaction tool.
    if (text === "terminate fixture") return fauxAssistantMessage([fauxText("Compacting first."), fauxToolCall("terminate_probe", {})], { stopReason: "toolUse" });
    if (text === "fetch fixture") return fauxAssistantMessage([fauxToolCall("fetch_probe", {})]);
    return fauxAssistantMessage(JSON.stringify({ reply: text, images: typeof last?.content === "string" ? 0 : last?.content.filter(part => part.type === "image").length ?? 0 }));
  }));
  pi.registerTool({ name: "fetch_probe", label: "Fetch probe", description: "Offline HTTP proxy fixture", parameters: Type.Object({}),
    async execute() {
      const urls = JSON.parse(process.env.DURABLE_TEST_FETCH_URLS!) as string[];
      const bodies = await Promise.all(urls.map(async url => (await fetch(url, { signal: AbortSignal.timeout(5000) })).text()));
      return { content: [{ type: "text", text: bodies.join(",") }], details: {} };
    },
  });
  pi.registerTool({ name: "terminate_probe", label: "Terminate probe", description: "Offline tool that ends the run", parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "compacted" }], details: {}, terminate: true };
    },
  });
  // An input hook that consumes the task, like a quota or account gate.
  if (process.env.DURABLE_TEST_HANDLE_INPUT) pi.on("input", () => ({ action: "handled" }));
  pi.registerTool({ name: "hold_effect", label: "Hold effect", description: "Offline crash-safety fixture", parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      // With DURABLE_TEST_ENTRIES, record this extension's own session entry before the effect is visible.
      if (process.env.DURABLE_TEST_ENTRIES) pi.appendEntry("durable-test.turn", { turn: true });
      fs.appendFileSync(process.env.DURABLE_TEST_EFFECT!, "effect\n");
      await new Promise<void>((resolve) => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return { content: [{ type: "text", text: "stopped" }], details: {} };
    },
  });
  // Opt-in: count this extension's own session entries at startup and add one per turn.
  const report = process.env.DURABLE_TEST_ENTRIES;
  if (report) {
    pi.on("session_start", (_event, ctx) => {
      const entries = ctx.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "durable-test.turn");
      fs.appendFileSync(report, `${entries.length}\n`);
    });
    pi.on("turn_end", () => { pi.appendEntry("durable-test.turn", { turn: true }); });
  }
}
