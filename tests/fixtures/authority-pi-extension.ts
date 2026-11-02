import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default async function (pi: ExtensionAPI) {
  const { fauxProvider, fauxAssistantMessage } = await import(process.env.DURABLE_TEST_FAUX_MODULE!) as typeof import("@earendil-works/pi-ai/providers/faux");
  const faux = fauxProvider({ provider: "authority-offline", models: [{ id: "test" }], tokensPerSecond: 100000 });
  pi.registerProvider({ ...faux.provider, auth: { apiKey: { name: "Offline", resolve: async () => ({ auth: { apiKey: "offline" } }) } } });
  pi.registerTool({ name: "fabric_exec", label: "Authority probe", description: "No-op recursive tool", parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "recursive probe" }], details: {} }),
  });
  pi.registerTool({ name: "ask", label: "Question probe", description: "No-op routed question", parameters: Type.Object({}),
    execute: async () => ({ content: [], details: {} }),
  });
  pi.on("session_start", () => {
    if (process.env.AUTHORITY_PROBE_FILE) fs.appendFileSync(process.env.AUTHORITY_PROBE_FILE, JSON.stringify(pi.getActiveTools()) + "\n");
  });
  faux.setResponses(Array.from({ length: 10 }, () => () => fauxAssistantMessage(JSON.stringify({ active: pi.getActiveTools() }))));
}
