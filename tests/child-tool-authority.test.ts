import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { normalizeAgentRunRequest } from "../src/agents/request.js";
import type { AgentRunRequest } from "../src/agents/types.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ResidencyClient } from "../src/residency/client.js";

// Convert the review counterexamples to real worker/CLI/SDK activation checks.
// Only the resident daemon's transport/liveness is stubbed, not serialization,
// the receiving manager, worker launch, native selection, or model/tool registry.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabric-authority-")));
const workerPath = path.join(root, "build", "worker.js");
const fixture = path.resolve("tests/fixtures/authority-pi-extension.ts");
const managers: AgentManager[] = [];
let sequence = 0;
// Each case boots a real Pi child (durable cases also a resident host) from a cold
// bundle. A Windows runner under full-suite load needs more than 15 s for that, so
// keep the child budget inside a wider test ceiling: a slow child then fails
// with its own error instead of an untimed kill, and close() has time to stop it.
const CHILD_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 45_000;
beforeAll(async () => {
  fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  await build({
    entryPoints: ["src/worker.ts", "src/durable/worker.ts", "src/agents/compact-control.ts", "src/agents/claude-cli.ts", "src/agents/veda-cli.ts",
      ...fs.readdirSync("src/worker").filter(name => name.endsWith(".ts")).map(name => `src/worker/${name}`)],
    outdir: path.join(root, "build"), outbase: "src", bundle: true, packages: "external",
    platform: "node", format: "esm", splitting: true, target: "node24", logLevel: "silent",
  });
}, 30000);
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.close())); vi.unstubAllEnvs(); vi.restoreAllMocks(); }, 30_000);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function setup() {
  const cwd = path.join(root, String(++sequence));
  const agentDir = path.join(cwd, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(cwd, "other"));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "authority-offline", defaultModel: "test", extensions: [fixture],
    // Deliberately dangerous target defaults: relative selectors must not widen.
    defaultTools: ["read", "bash", "fabric_exec"], compaction: { enabled: false }, retry: { enabled: false },
  }));
  for (const key of ["PI_FABRIC_DEPTH", "PI_FABRIC_BUDGET", "PI_FABRIC_BUDGET_FILE", "PI_FABRIC_BUDGET_ID", "PI_FABRIC_WRITE_POLICY", "PI_FABRIC_TOOL_ALLOWLIST", "PI_FABRIC_SCOPE", "PI_FABRIC_LINEAGE", "PI_FABRIC_FULL_CODE_MODE"]) vi.stubEnv(key, undefined);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("DURABLE_TEST_FAUX_MODULE", import.meta.resolve("@earendil-works/pi-ai/providers/faux"));
  return cwd;
}

async function forward(cwd: string, request: AgentRunRequest): Promise<AgentRunRequest> {
  const client = new ResidencyClient({ config: {
    format: 1, rootId: "main:authority", sessionId: "authority", cwd, projectRoot: cwd,
    meshRoot: path.join(cwd, "mesh"), actorRoot: path.join(cwd, "actors"), residencyRoot: path.join(cwd, "resident"),
    fullCodeMode: false, agents: DEFAULT_FABRIC_CONFIG.agents, mesh: DEFAULT_FABRIC_CONFIG.mesh, retention: DEFAULT_FABRIC_CONFIG.retention,
    workerPath, fabricExtensionPath: fixture, piBinary: "unused", claudeBinary: "unused", vedaBinary: "unused",
  },
    // Outbound serialization does not use delivery/discovery dependencies.
    // Fail explicitly if that boundary changes rather than silently omitting them.
    get mesh(): never { throw new Error("Unexpected mesh access in forwarding probe"); },
    get participants(): never { throw new Error("Unexpected participant access in forwarding probe"); },
    get mainAgent(): never { throw new Error("Unexpected Main access in forwarding probe"); },
  });
  vi.spyOn(client, "ensureHost").mockResolvedValue({} as never);
  let forwarded: AgentRunRequest | undefined;
  const original = fs.writeFileSync;
  const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
    if (typeof args[1] === "string") {
      try { const command = JSON.parse(args[1]); if (command.operation === "spawn") forwarded = command.request; } catch { /* not JSON */ }
    }
    return original(...args);
  });
  try { await expect(client.spawnAgent(request)).rejects.toThrow("resident host exited"); }
  finally { spy.mockRestore(); await client.close(); }
  expect(forwarded).toBeDefined();
  return forwarded!;
}

async function active(cwd: string, runner: "pi" | "pi-durable", request: AgentRunRequest, fullCodeMode = false, routeQuestions = false) {
  const manager = new AgentManager(cwd, { ...DEFAULT_FABRIC_CONFIG.agents, runner, transport: "process", timeoutMs: CHILD_TIMEOUT_MS, ...(routeQuestions ? { childQuestions: "route" as const } : {}) }, {
    workerPath, runRoot: path.join(cwd, `runs-${sequence++}`), fullCodeMode, fabricExtensionPath: fixture,
    piBinary: path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
  });
  managers.push(manager);
  const result = await manager.run({ ...request, runner, model: "authority-offline/test" });
  expect(result.status, result.error).toBe("completed");
  return (JSON.parse(result.text) as { active: string[] }).active;
}

describe("origin authority through serialized resident dispatch", () => {
  it.each([
    ["absent", undefined, true], ["malformed", "{", false], ["empty", "[]", false],
    ["read", '["read"]', false], ["wildcard", '["*"]', false],
    ["exact", '["read","fabric_exec"]', true], ["signed", '["+read","+fabric_exec"]', false],
  ] as const)("preserves %s origin at real durable activation", async (_name, inherited, permitted) => {
    const cwd = setup();
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", inherited);
    const request = await forward(cwd, { task: "report", recursive: true, tools: ["read", "*"], cwd: "other", residency: "durable" });
    // An already-running resident belongs to unrestricted Main, not this parent.
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", undefined);
    expect(request.cwd).toBe(path.join(cwd, "other"));
    const tools = await active(cwd, "pi-durable", request);
    expect(tools.includes("fabric_exec")).toBe(permitted);
  }, TEST_TIMEOUT_MS);

  it("cannot self-grant authority in provider arguments or at the manager boundary", async () => {
    const cwd = setup();
    const args = { task: "report", recursive: true, tools: ["*"], recursiveToolAuthority: "allow" };
    const normalized = normalizeAgentRunRequest(args, { runner: "pi", timeoutMs: 0 });
    expect(normalized).not.toHaveProperty("recursiveToolAuthority");
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", '["*"]');
    const request = await forward(cwd, args as unknown as AgentRunRequest);
    expect(request.recursiveToolAuthority).toBe("deny");
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", undefined);
    expect(await active(cwd, "pi", request)).not.toContain("fabric_exec");
  }, TEST_TIMEOUT_MS);
});

describe("other authority entry points", () => {
  it("rejects malformed public tool lists instead of falling back to defaults", () => {
    for (const tools of [null, "*", ["read", 3]]) {
      expect(() => normalizeAgentRunRequest({ task: "report", tools }, { runner: "pi", timeoutMs: 0 })).toThrow(/array of strings/);
    }
  });

  it.each(["pi", "pi-durable"] as const)("%s keeps the deny cap through routed full-code/kernel run paths", async runner => {
    const cwd = setup();
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", '["read"]');
    const request = await forward(cwd, { task: "report", tools: ["read"], residency: "durable", kernel: "typescript" });
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", undefined);
    // Simulate a malformed attempt to turn the wire cap into a grant.
    const tools = await active(cwd, runner, { ...request, recursiveToolAuthority: "allow" as "deny" }, true, true);
    expect(tools).toContain("read");
    expect(tools).not.toContain("fabric_exec");
  }, TEST_TIMEOUT_MS);
});

describe("effective native selection", () => {
  it.each(["pi", "pi-durable"] as const)("%s excludes wildcard recursion without an exact originating grant", async runner => {
    const cwd = setup();
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", '["*"]');
    const tools = await active(cwd, runner, { task: "report", tools: ["*"], recursive: true });
    expect(tools).toContain("read");
    expect(tools).not.toContain("fabric_exec");
  }, TEST_TIMEOUT_MS);

  it.each(["pi", "pi-durable"] as const)("%s constrains relative selectors instead of restoring target defaults", async runner => {
    const cwd = setup();
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", '["read"]');
    const tools = await active(cwd, runner, { task: "report", tools: ["+read", "+fabric_exec"], recursive: true });
    expect(tools).toEqual(["read"]);
  }, TEST_TIMEOUT_MS);

  it.each(["pi", "pi-durable"] as const)("%s respects explicit exclusion under full-code inheritance", async runner => {
    const cwd = setup();
    const tools = await active(cwd, runner, { task: "report", tools: ["-fabric_exec", "+read"], extensions: true }, true);
    expect(tools).toContain("read");
    expect(tools).not.toContain("fabric_exec");
  }, TEST_TIMEOUT_MS);
});
