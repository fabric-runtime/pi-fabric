import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import fabricProviderBridge, {
  fabricExtensionEntries,
  orderProviderCandidates,
  parseModelKey,
  PROVIDER_BRIDGE_MODEL_ENV,
  resolveExtensionProviders,
} from "../src/agents/provider-bridge.js";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllEnvs());

/** An extension that records its own load and registers one config provider. */
const extensionSource = (marker: string, provider?: string) => `
import fs from "node:fs";
export default function (pi) {
  fs.appendFileSync(${JSON.stringify(marker)}, "loaded\\n");
  pi.registerTool({ name: "leaked_tool", label: "Leaked", description: "must not bind", parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "leaked" }], details: {} }; } });
  pi.registerCommand("leaked-command", { description: "must not bind", handler: async () => {} });
  pi.on("session_start", () => fs.appendFileSync(${JSON.stringify(marker)}, "session_start\\n"));
  ${provider ? `pi.registerProvider(${JSON.stringify(provider)}, {
    baseUrl: "https://${provider}.invalid/v1", apiKey: "$FIXTURE_PROVIDER_KEY", api: "openai-completions",
    models: [{ id: "m1", name: "M1", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
  });` : ""}
}
`;

function fixture(options: {
  extensions: Array<{ dir: string; provider?: string; project?: boolean }>;
  settings?: Record<string, unknown>;
  models?: Record<string, unknown>;
}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabric-provider-bridge-")));
  roots.push(root);
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const markers: Record<string, string> = {};
  const globalPaths: string[] = [];
  for (const extension of options.extensions) {
    const base = extension.project ? path.join(cwd, ".pi", "extensions") : path.join(root, "packages");
    const file = path.join(base, extension.dir, "index.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const marker = path.join(root, `${extension.dir}.marker`);
    markers[extension.dir] = marker;
    fs.writeFileSync(file, extensionSource(marker, extension.provider));
    if (!extension.project) globalPaths.push(file);
  }
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ extensions: globalPaths, ...options.settings }));
  if (options.models) fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(options.models));
  const loads = (dir: string) => fs.existsSync(markers[dir]!) ? fs.readFileSync(markers[dir]!, "utf8").trim().split("\n") : [];
  return { root, cwd, agentDir, markers, loads };
}

describe("extension provider bridge", () => {
  it("parses canonical model keys at the first slash", () => {
    expect(parseModelKey("coralbricks/glm-5.3-fast")).toEqual({ provider: "coralbricks", id: "glm-5.3-fast" });
    expect(parseModelKey("openrouter/anthropic/claude")).toEqual({ provider: "openrouter", id: "anthropic/claude" });
    expect(parseModelKey("bare")).toBeUndefined();
    expect(parseModelKey("/id")).toBeUndefined();
    expect(parseModelKey("provider/")).toBeUndefined();
  });

  it("probes extensions whose own path names the provider first", () => {
    const ordered = orderProviderCandidates([
      "/home/u/.pi/agent/npm/node_modules/pi-better-openai/index.ts",
      "/home/u/.pi/agent/npm/node_modules/pi-coralbricks-provider/index.ts",
      "/home/u/coralbricks-fan/work/node_modules/unrelated/dist/index.js",
      "/home/u/.pi/agent/extensions/CoralBricks.ts",
    ], "coralbricks");
    expect(ordered.named).toEqual([
      "/home/u/.pi/agent/npm/node_modules/pi-coralbricks-provider/index.ts",
      "/home/u/.pi/agent/extensions/CoralBricks.ts",
    ]);
    expect(ordered.rest).toHaveLength(2);
  });

  it("excludes Fabric's own manifest entries from probing", () => {
    expect(fabricExtensionEntries()).toEqual(expect.arrayContaining([
      path.resolve("dist/index.js"),
      path.resolve("dist/extension-bootstrap.js"),
    ]));
  });

  it("registers only the named extension's provider and runs no other extension", async () => {
    const { cwd, agentDir, loads } = fixture({ extensions: [
      { dir: "pi-unrelated" },
      { dir: "pi-acme-provider", provider: "acme" },
    ] });
    const found = await resolveExtensionProviders({ model: "acme/m1", cwd, agentDir });
    expect(found?.configs.map(({ name, config }) => [name, config.apiKey])).toEqual([["acme", "$FIXTURE_PROVIDER_KEY"]]);
    expect(found?.natives).toEqual([]);
    expect(loads("pi-acme-provider")).toEqual(["loaded"]);
    expect(loads("pi-unrelated")).toEqual([]);
  });

  it("falls back to the other installed extensions when no path names the provider", async () => {
    const { cwd, agentDir, loads } = fixture({ extensions: [
      { dir: "pi-unrelated" },
      { dir: "pi-misc-tools", provider: "zeta" },
    ] });
    const found = await resolveExtensionProviders({ model: "zeta/m1", cwd, agentDir });
    expect(found?.configs.map(({ name }) => name)).toEqual(["zeta"]);
    expect(loads("pi-misc-tools")).toEqual(["loaded"]);
  });

  it("leaves models Pi already knows untouched and loads no extension", async () => {
    const builtin = (await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false })).getModels()[0]!;
    const { cwd, agentDir, loads } = fixture({
      extensions: [{ dir: `pi-${builtin.provider}-override`, provider: builtin.provider }, { dir: "pi-local-provider", provider: "local" }],
      models: { providers: { local: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "none", api: "openai-completions",
        models: [{ id: "m1", name: "Local", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] } } },
    });
    await expect(resolveExtensionProviders({ model: `${builtin.provider}/${builtin.id}`, cwd, agentDir })).resolves.toBeUndefined();
    await expect(resolveExtensionProviders({ model: "local/m1", cwd, agentDir })).resolves.toBeUndefined();
    expect(loads(`pi-${builtin.provider}-override`)).toEqual([]);
    expect(loads("pi-local-provider")).toEqual([]);
  });

  it("fails closed with an actionable error when nothing registers the provider", async () => {
    const { cwd, agentDir } = fixture({ extensions: [{ dir: "pi-acme-provider", provider: "acme" }] });
    await expect(resolveExtensionProviders({ model: "absent/m1", cwd, agentDir }))
      .rejects.toThrow(/needs provider "absent"[\s\S]*extensions: true/);
    const excluded = path.join(path.dirname(agentDir), "packages", "pi-acme-provider", "index.ts");
    await expect(resolveExtensionProviders({ model: "acme/m1", cwd, agentDir, exclude: [excluded] }))
      .rejects.toThrow(/needs provider "acme"/);
  });

  it.each([
    ["ask", false],
    ["always", true],
  ] as const)("applies project trust %s to project-local provider extensions", async (defaultProjectTrust, trusted) => {
    const { cwd, agentDir, loads } = fixture({
      extensions: [{ dir: "pi-proj-provider", provider: "proj", project: true }],
      settings: { defaultProjectTrust },
    });
    const pending = resolveExtensionProviders({ model: "proj/m1", cwd, agentDir });
    if (trusted) await expect(pending).resolves.toMatchObject({ configs: [{ name: "proj" }] });
    else await expect(pending).rejects.toThrow(/needs provider "proj"/);
    expect(loads("pi-proj-provider")).toEqual(trusted ? ["loaded"] : []);
  });

  it("registers the provider through the bridge's own Pi API only when asked", async () => {
    const { cwd, agentDir } = fixture({ extensions: [{ dir: "pi-acme-provider", provider: "acme" }] });
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const registerProvider = vi.fn();
    const pi = { registerProvider } as unknown as Parameters<typeof fabricProviderBridge>[0];
    vi.stubEnv(PROVIDER_BRIDGE_MODEL_ENV, "");
    await fabricProviderBridge(pi);
    expect(registerProvider).not.toHaveBeenCalled();
    vi.stubEnv(PROVIDER_BRIDGE_MODEL_ENV, "acme/m1");
    await fabricProviderBridge(pi);
    expect(registerProvider).toHaveBeenCalledOnce();
    expect(registerProvider.mock.calls[0]![0]).toBe("acme");
    expect(registerProvider.mock.calls[0]![1]).toMatchObject({ api: "openai-completions", apiKey: "$FIXTURE_PROVIDER_KEY" });
  });
});
