import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { McpProvider } from "../src/providers/mcp-provider.js";

it("runs the documented Parallel program through Fabric over anonymous HTTP", async () => {
  const doc = fs.readFileSync("docs/parallel-search.md", "utf8");
  const example = JSON.parse(doc.match(/```json\n([\s\S]*?)```/)![1]!);
  const code = doc.match(/```ts\n([\s\S]*?)```/)![1]!;
  expect(example.mcpServers.parallel.baseUrl).toBe("https://search.parallel.ai/mcp");
  const requests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: any }> = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    requests.push({ url: req.url!, headers: req.headers, body });
    if (body.id === undefined) { res.writeHead(202).end(); return; }
    let result: unknown;
    if (body.method === "initialize") {
      result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "parallel-fixture", version: "1" } };
    } else if (body.method === "tools/list") {
      result = { tools: [
        { name: "web_search", description: "Search", inputSchema: { type: "object", properties: { objective: { type: "string" }, search_queries: { type: "array", items: { type: "string" } } }, required: ["objective", "search_queries"] } },
        { name: "web_fetch", description: "Fetch", inputSchema: { type: "object", properties: { urls: { type: "array", items: { type: "string" } }, objective: { type: "string" } }, required: ["urls"] } },
      ] };
    } else if (body.method === "tools/call") {
      result = { content: [{ type: "text", text: body.params.name === "web_search" ? "Pi Fabric MCP configuration: https://github.com/fabric-runtime/pi-fabric" : "MCP uses config/mcporter.json and mcp.callTimeoutMs." }] };
    } else { res.writeHead(400).end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-parallel-"));
  const config = structuredClone(DEFAULT_FABRIC_CONFIG);
  const defaults = structuredClone(config);
  // Only redirect the documented endpoint; mcporter loads the actual JSON shape.
  const port = (server.address() as import("node:net").AddressInfo).port;
  example.mcpServers.parallel.baseUrl = `http://127.0.0.1:${port}/mcp`;
  example.imports = [];
  const configPath = path.join(directory, "mcporter.json");
  fs.writeFileSync(configPath, JSON.stringify(example));
  const provider = new McpProvider(directory, { ...config.mcp, configPath });
  const registry = new ActionRegistry();
  registry.register(provider);
  try {
    const result = await new FabricExecutionService(registry, config).execute({
      code, parentToolCallId: "parallel-example", signal: undefined,
      context: { cwd: directory, hasUI: false } as ExtensionContext, onPartial() {},
    });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ search: "Pi Fabric MCP configuration: https://github.com/fabric-runtime/pi-fabric", page: "MCP uses config/mcporter.json and mcp.callTimeoutMs." });
    const calls = requests.filter(r => r.body.method === "tools/call");
    expect(calls.map(r => r.body.params.name)).toEqual(["web_search", "web_fetch"]);
    expect(calls[0]!.body.params.arguments.search_queries).toEqual(["pi-fabric MCP configuration"]);
    expect(calls[1]!.body.params.arguments.urls).toEqual(["https://raw.githubusercontent.com/fabric-runtime/pi-fabric/main/docs/configuration.md"]);
    expect(requests.some(r => r.body.method === "tools/list")).toBe(true);
    for (const request of requests) {
      expect(request.url).toBe("/mcp");
      expect(request.headers["user-agent"]).toBe("pi-fabric/parallel-search-example");
      expect(request.headers.authorization).toBeUndefined();
    }
    expect(config).toEqual(defaults);
  } finally {
    await provider.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
