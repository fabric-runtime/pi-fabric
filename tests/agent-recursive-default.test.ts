import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import type { AgentRunRecord, AgentRunRequest, AgentRunResult } from "../src/agents/types.js";
import { DEFAULT_FABRIC_CONFIG, type FabricAgentConfig } from "../src/config.js";
import { registerAgentRunner, type FabricRunnerCapabilities } from "../src/runners.js";

// agents.recursive: a Pi child that omits `recursive` is launched as recursive
// (fabric_exec + the delegated "agent" risk). The fake worker echoes the launch surface.
type Surface = AgentRunResult & { tools?: string[]; grantedRisks?: string[]; extensions?: string };

const managers: AgentManager[] = [];
const roots: string[] = [];
beforeEach(() => {
  for (const key of Object.keys(process.env).filter((key) => key.startsWith("PI_FABRIC_"))) vi.stubEnv(key, undefined);
});
afterEach(async () => {
  for (const manager of managers.splice(0).reverse()) await manager.close();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const tmp = (prefix: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
};
const make = (config: Partial<FabricAgentConfig> & { recursive?: boolean } = {}): AgentManager => {
  const manager = new AgentManager(process.cwd(), {
    ...DEFAULT_FABRIC_CONFIG.agents,
    runner: "pi",
    budgetUsd: 0,
    retainRuns: false,
    sessionExport: false,
    transport: "process",
    ...config,
  } as FabricAgentConfig, {
    workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
    runRoot: tmp("pi-fabric-recursive-default-"),
    fullCodeMode: false,
  });
  managers.push(manager);
  return manager;
};
const run = (manager: AgentManager, request: Partial<AgentRunRequest> = {}): Promise<Surface> =>
  manager.run({ task: "probe", transport: "process", tools: ["read"], ...request }) as Promise<Surface>;

const RECURSIVE = { tools: ["read", "fabric_exec"], grantedRisks: ["agent"] };
const LEAF = { tools: ["read"], grantedRisks: [] };

describe("agents.recursive default", () => {
  it("keeps upstream behaviour when the key is off (default false)", async () => {
    expect(DEFAULT_FABRIC_CONFIG.agents.recursive ?? false).toBe(false);
    const result = await run(make());
    expect(result).toMatchObject({ status: "completed", ...LEAF });
  });

  it("treats an omitted recursive as true for a Pi child when on", async () => {
    const result = await run(make({ recursive: true }));
    expect(result).toMatchObject({ status: "completed", extensions: "true", ...RECURSIVE });
  });

  it("also applies to the built-in pi-durable runner (a process worker with Pi capabilities)", async () => {
    const result = await run(make({ recursive: true, runner: "pi-durable" }));
    expect(result).toMatchObject({ status: "completed", runner: "pi-durable", ...RECURSIVE });
  });

  it("lets an explicit recursive:false win", async () => {
    const result = await run(make({ recursive: true }), { recursive: false });
    expect(result).toMatchObject({ status: "completed", ...LEAF });
  });

  it("lets an explicit extensions:false win without failing the request", async () => {
    const result = await run(make({ recursive: true }), { extensions: false });
    expect(result).toMatchObject({ status: "completed", extensions: "false", ...LEAF });
  });

  it("lets agents.extensions:false win", async () => {
    const result = await run(make({ recursive: true, extensions: false }));
    expect(result).toMatchObject({ status: "completed", extensions: "false", ...LEAF });
  });

  it("never fails a runner without the recursiveFabric capability", async () => {
    for (const runner of ["claude", "veda"] as const) {
      const result = await run(make({ recursive: true, runner }));
      expect(result, runner).toMatchObject({ status: "completed", runner, grantedRisks: [] });
      expect(result.tools, runner).not.toContain("fabric_exec");
    }
  });

  it("never fails a custom runner without recursiveFabric", async () => {
    const capabilities: FabricRunnerCapabilities = {
      recursiveFabric: false, steer: false, followUp: false, persistentSessions: false, kernels: false, handoff: false,
      modelDiscovery: false, imageInput: false, compaction: false, questions: false, sleep: false, writePolicy: false,
    };
    const unregister = registerAgentRunner({
      kind: "worker", id: "acme", label: "Acme", capabilities,
      launch: (context) => {
        const file = path.join(context.runDirectory, "acme-context.json");
        fs.writeFileSync(file, JSON.stringify(context));
        return { workerPath: path.resolve("tests/fixtures/fake-runner-worker.mjs"), workerArguments: [file] };
      },
    });
    try {
      const manager = make({ recursive: true, runner: "acme" });
      expect(manager.applyRecursiveDefault({ task: "x" }).recursive).toBe(false);
      expect(await run(manager)).toMatchObject({ status: "completed", runner: "acme" });
    } finally {
      unregister();
    }
  });

  it("still rejects an explicit recursive:true on such a runner", async () => {
    await expect(run(make({ recursive: true, runner: "claude" }), { recursive: true })).rejects.toThrow(/recursive/);
  });

  it("does not launch a child at maxDepth with recursion it cannot use", async () => {
    // Depth 0 with maxDepth 1: the child sits at depth 1 and cannot spawn.
    const atLimit = await run(make({ recursive: true, maxDepth: 1 }));
    expect(atLimit).toMatchObject({ status: "completed", ...LEAF });
    // maxDepth 2 leaves the child one level to spend.
    const room = await run(make({ recursive: true, maxDepth: 2 }));
    expect(room).toMatchObject({ status: "completed", ...RECURSIVE });
  });

  it("resolves the default against the caller's own depth", async () => {
    const nestedRoot = tmp("pi-fabric-recursive-nested-");
    vi.stubEnv("PI_FABRIC_RUN_ROOT", nestedRoot);
    vi.stubEnv("PI_FABRIC_DEPTH", "1");
    vi.stubEnv("PI_FABRIC_LINEAGE", JSON.stringify({ version: 1, rootSessionId: "root", runId: "parent", depth: 1, childIndex: 0, worker: true }));
    // A depth-1 caller under maxDepth 2 would launch its child at depth 2, the limit.
    const manager = make({ recursive: true, maxDepth: 2 });
    expect(manager.applyRecursiveDefault({ task: "x" }).recursive).toBe(false);
    const result = await run(manager);
    expect(result).toMatchObject({ status: "completed", ...LEAF });
  });

  it("does not widen a parent launched without fabric_exec", async () => {
    vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", JSON.stringify(["read"]));
    const result = await run(make({ recursive: true }));
    expect(result).toMatchObject({ status: "completed", ...LEAF });
  });

  it("does not override a request that removes fabric_exec", async () => {
    const result = await run(make({ recursive: true }), { tools: ["-fabric_exec"] });
    expect(result.grantedRisks).toEqual([]);
    expect(result.tools).not.toContain("fabric_exec");
  });

  it("applyRecursiveDefault leaves explicit values and the off state untouched", () => {
    expect(make().applyRecursiveDefault({ task: "x" })).toEqual({ task: "x" });
    const on = make({ recursive: true });
    expect(on.applyRecursiveDefault({ task: "x" }).recursive).toBe(true);
    expect(on.applyRecursiveDefault({ task: "x", recursive: false }).recursive).toBe(false);
    expect(on.applyRecursiveDefault({ task: "x", runner: "claude" }).recursive).toBe(false);
  });
});

describe("agents.recursive config", () => {
  it("is a boolean defaulting to false", async () => {
    const { normalizeFabricConfig } = await import("../src/config.js");
    expect(normalizeFabricConfig({}).agents.recursive).toBe(false);
    expect(normalizeFabricConfig({ agents: { recursive: true } }).agents.recursive).toBe(true);
    expect(normalizeFabricConfig({ agents: { recursive: "yes" } }).agents.recursive).toBe(false);
  });
});
