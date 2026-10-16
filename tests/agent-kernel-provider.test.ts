import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { AgentManager } from "../src/agents/manager.js";
import type { AgentHandleInfo, AgentRunRequest, AgentRunResult, AgentSessionSeed } from "../src/agents/types.js";
import type { FabricActorRequest } from "../src/actors/types.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import { AGENTS_ACTION_DESCRIPTORS } from "../src/providers/agents-actions.js";
import { AgentsProvider } from "../src/providers/agents-provider.js";
import { ResidentActorClient } from "../src/residency/actor-client.js";
import { guestTypeDeclarations } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";

const roots: string[] = [];
const managers: AgentManager[] = [];
const context = {
  cwd: process.cwd(), signal: undefined, parentToolCallId: "outer", nestedToolCallId: "nested",
  extensionContext: { modelRegistry: { getAvailable: () => [{ provider: "test", id: "model" }], find: () => undefined } },
  update() {}, activity() {},
} as unknown as FabricInvocationContext;
const handle: AgentHandleInfo = {
  id: "probe", name: "probe", status: "running", runner: "pi", transport: "process", cwd: process.cwd(), kernel: "python",
};
const completed: AgentRunResult = {
  ...handle, status: "completed", task: "probe", text: "done", turns: 1, toolCalls: 0, startedAt: 1, updatedAt: 2,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
};
type ProviderArgs = ConstructorParameters<typeof AgentsProvider>;
const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-agent-kernel-provider-"));
  roots.push(root);
  const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
    runRoot: root, kernel: () => "python", pythonRuntime: () => "monty",
  });
  managers.push(manager);
  const spawn = vi.spyOn(manager, "spawn").mockResolvedValue(handle);
  vi.spyOn(manager, "wait").mockResolvedValue(completed);
  vi.spyOn(manager, "status").mockReturnValue(completed);
  const actors = {
    create: vi.fn(async (request: FabricActorRequest) => ({ ...request, id: "actor" })),
    cede: vi.fn(async () => {}),
  };
  const templates = {
    create: vi.fn((request: FabricActorRequest) => request),
    resolve: vi.fn(() => ({ name: "template" })),
    toRequest: vi.fn((): FabricActorRequest => ({ name: "template", instructions: "task", kernel: "inherit", residency: "durable" })),
  };
  const residency = {
    spawnAgent: vi.fn(async (_request: AgentRunRequest) => handle),
    ensureHost: vi.fn(async () => {}),
    ensureActor: vi.fn(async () => {}),
  };
  const provider = new AgentsProvider(
    manager, actors as unknown as ProviderArgs[1], templates as unknown as ProviderArgs[2],
    {} as ProviderArgs[3], { scheduleRefresh() {}, async refresh() {} } as unknown as ProviderArgs[4],
    undefined, {} as ProviderArgs[6], () => false, residency as unknown as ProviderArgs[8], false,
  );
  return { root, manager, provider, spawn, actors, templates, residency };
};
beforeEach(() => {
  vi.stubEnv("PI_FABRIC_DEPTH", undefined);
  vi.stubEnv("PI_FABRIC_BUDGET_FILE", undefined);
  vi.stubEnv("PI_FABRIC_BUDGET", undefined);
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("agent kernel public contracts", () => {
  it.each(["run", "spawn", "create", "handoff"])("registers strict kernel choices for agents.%s", (name) => {
    const schema = AGENTS_ACTION_DESCRIPTORS.find((action) => action.name === name)!.inputSchema;
    const required = name === "create" ? { name: "actor", instructions: "task" } : name === "handoff" ? { model: "test/model" } : { task: "task" };
    for (const kernel of [undefined, "inherit", "typescript", "python"]) {
      expect(Value.Check(schema, { ...required, ...(kernel ? { kernel } : {}) })).toBe(true);
    }
    for (const kernel of [null, "", "PYTHON", "ruby", false, 1, {}, []]) {
      expect(Value.Check(schema, { ...required, kernel })).toBe(false);
    }
    expect(Value.Check(schema, { ...required, kernel: "python", pythonRuntime: "monty" })).toBe(false);
    expect(Value.Check(schema, { ...required, kernel: "python", pythonRuntime: "monty" })).toBe(false);
    expect(Value.Check(schema, { ...required, unknown: true })).toBe(false);
  });

  it.each(["run", "spawn"])("accepts optional systemPrompt string on agents.%s", (name) => {
    const schema = AGENTS_ACTION_DESCRIPTORS.find((action) => action.name === name)!.inputSchema;
    expect(Value.Check(schema, { task: "task" })).toBe(true);
    expect(Value.Check(schema, { task: "task", systemPrompt: "Be terse." })).toBe(true);
    for (const bad of [null, 42, true, {}, []]) {
      expect(Value.Check(schema, { task: "task", systemPrompt: bad })).toBe(false);
    }
  });

  // The manager joins systemPrompt ahead of component guidance (see the
  // agent-manager guidance test); the help must not say it goes below.
  it.each(["run", "spawn"])("describes where agents.%s places systemPrompt", (name) => {
    const schema = AGENTS_ACTION_DESCRIPTORS.find((action) => action.name === name)!.inputSchema as {
      properties: { systemPrompt: { description: string } };
    };
    const description = schema.properties.systemPrompt.description;
    expect(description).toContain("ahead of any component guidance");
    expect(description).not.toContain("below component guidance");
    expect(description).toContain("<system_instructions>");
  });

  it.each(["ask", "tell"])("does not expose an activation-time language switch on %s", (name) => {
    const schema = AGENTS_ACTION_DESCRIPTORS.find((action) => action.name === name)!.inputSchema;
    expect(Value.Check(schema, { id: "actor", message: "task", kernel: "python" })).toBe(false);
  });

  it("types agent, actor, handoff, workflow, council and recursive kernel requests", () => {
    const result = typeCheckFabricCode(`
      const run = await agents.run({ task: "a", kernel: "python" });
      const language: FabricKernel | undefined = run.kernel;
      await agents.spawn({ task: "b", kernel: "inherit" });
      await agents.create({ name: "actor", instructions: "task", kernel: "typescript" });
      await agents.handoff({ model: "test/model", kernel: "python" });
      await workflow.agent("task", { kernel: "python" });
      await council.run({ task: "task", roles: ["reviewer"], kernel: "inherit" });
      return rlm.query({ task: "task", kernel: "typescript" });
    `, guestTypeDeclarations(true));
    expect(result.errors).toEqual([]);
    for (const code of [
      // Enum mismatches are intentionally left to host validation by Fabric's loose checker.
      'return council.run({ task: "a", roles: [], kernell: "python" });',
      'return agents.ask({ id: "a", message: "b", kernel: "python" });',
      'return agents.run({ task: "a", pythonRuntime: "monty" });',
    ]) expect(typeCheckFabricCode(code, guestTypeDeclarations(true)).errors.length).toBeGreaterThan(0);
  });
});

describe("provider kernel forwarding", () => {
  it.each(["typescript", "python", "inherit"] as const)("copies %s into local run requests", async (kernel) => {
    const { provider, spawn } = setup();
    await provider.invoke("run", { task: "task", kernel }, context);
    expect(spawn.mock.calls[0]![0].kernel).toBe(kernel);
    expect(spawn.mock.calls[0]![0].kernel).toBe(kernel);
  });

  it("copies systemPrompt into local run requests and drops blank strings", async () => {
    const { provider, spawn } = setup();
    await provider.invoke("run", { task: "task", systemPrompt: "  Be honest.  " }, context);
    expect(spawn.mock.calls[0]![0].systemPrompt).toBe("  Be honest.  ");
    await provider.invoke("run", { task: "task", systemPrompt: "   " }, context);
    expect(spawn.mock.calls.at(-1)![0].systemPrompt).toBeUndefined();
  });
  it.each([undefined, "inherit", "typescript"] as const)("freezes %s before durable one-shot forwarding", async (kernel) => {
    const { provider, residency, root, spawn } = setup();
    await provider.invoke("spawn", { task: "task", residency: "durable", cwd: root, ...(kernel ? { kernel } : {}) }, context);
    expect(residency.spawnAgent).toHaveBeenCalledWith(expect.objectContaining({
      kernel: kernel === "typescript" ? "typescript" : "python", pythonRuntime: "monty", runner: "pi-durable", extensions: true, cwd: fs.realpathSync(root),
    }), undefined);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([{ runner: "claude" }, { runner: "veda" }, { extensions: false }])("rejects concrete incompatible durable kernel before contacting resident: %j", async (request) => {
    const { provider, residency } = setup();
    await expect(provider.invoke("spawn", { task: "task", residency: "durable", kernel: "python", ...request }, context)).rejects.toThrow("Fabric extensions");
    expect(residency.spawnAgent).not.toHaveBeenCalled();
    await provider.invoke("spawn", { task: "task", residency: "durable", kernel: "inherit", ...request }, context);
    expect(residency.spawnAgent.mock.calls[0]![0]).not.toHaveProperty("kernel");
    expect(residency.spawnAgent.mock.calls[0]![0]).not.toHaveProperty("pythonRuntime");
  });

  it.each(["run", "spawn", "create", "handoff"])("rejects invalid direct provider %s calls instead of dropping the selector", async (action) => {
    const { provider } = setup();
    await expect(provider.invoke(action, { task: "task", name: "actor", instructions: "task", model: "test/model", kernel: "ruby" }, {
      ...context, deferHandoff: () => ({ scheduled: true, status: "deferred", boundary: "fabric_exec_end" }),
    })).rejects.toThrow("Invalid Fabric agent kernel");
  });

  it.each(["session", "durable"])("freezes actor language at %s creation before routing", async (residency) => {
    const { provider, actors } = setup();
    await provider.invoke("create", { name: "actor", instructions: "task", residency, kernel: "inherit" }, context);
    expect(actors.create).toHaveBeenCalledWith(expect.objectContaining({ kernel: "python", runner: "pi-durable", extensions: true }));
  });

  it("freezes actor requests before the child-side resident client handoff", async () => {
    const { provider, actors } = setup();
    const createActor = vi.fn(async (request: FabricActorRequest) => ({ ...request, id: "resident-actor" }));
    vi.spyOn(ResidentActorClient, "fromEnv").mockReturnValue({ createActor } as unknown as ResidentActorClient);
    const childProvider = new AgentsProvider(provider.manager, provider.actorManager, provider.globalActors, provider.mainAgent, provider.participants, undefined, provider.lifecycle, () => false, undefined, false);
    await childProvider.invoke("create", { name: "actor", instructions: "task", residency: "durable" }, context);
    expect(createActor).toHaveBeenCalledWith(expect.objectContaining({ kernel: "python", pythonRuntime: "monty" }));
    expect(actors.create).not.toHaveBeenCalled();
  });

  it.each([undefined, "inherit"] as const)("preserves %s on global templates, then resolves on import", async (kernel) => {
    const { provider, templates, actors } = setup();
    await provider.invoke("create", { scope: "global", name: "actor", instructions: "task", ...(kernel ? { kernel } : {}) }, context);
    expect(templates.create.mock.calls[0]![0].kernel).toBe(kernel);
    expect(actors.create).not.toHaveBeenCalled();
    await provider.invoke("import", { name: "template" }, context);
    expect(actors.create).toHaveBeenCalledWith(expect.objectContaining({ kernel: "python" }));
  });

  it("retains actor extensions:true defaults when ordinary agents disable extensions", async () => {
    const { provider, manager, actors } = setup();
    vi.spyOn(manager, "resolveKernel");
    const original = manager.config.extensions;
    try {
      manager.config.extensions = false;
      await provider.invoke("create", { name: "actor", instructions: "task", kernel: "python" }, context);
      expect(actors.create).toHaveBeenCalledWith(expect.objectContaining({ kernel: "python", extensions: true }));
    } finally { manager.config.extensions = original; }
  });

  it("freezes deferred handoff kernel/backend and copies them with a session seed", async () => {
    const { provider, spawn, manager } = setup();
    let deferred: Record<string, unknown> = {};
    await provider.handoff({ model: "test/model", kernel: "inherit" }, {
      ...context, deferHandoff: (request) => {
        deferred = request;
        return { scheduled: true, status: "deferred", boundary: "fabric_exec_end" };
      },
    });
    expect(deferred).toMatchObject({ kernel: "python", pythonRuntime: "monty", extensions: true });
    vi.spyOn(manager, "resolvePythonRuntime").mockImplementation((inherited) => inherited ?? "cpython");
    const seed = { sourceSessionId: "source", sourceBranchLeafId: "leaf" } as AgentSessionSeed;
    const result = await provider.executeHandoff(deferred, context, seed);
    expect(spawn.mock.calls[0]![0]).toMatchObject({ kernel: "python", pythonRuntime: "monty", sessionSeed: seed });
    expect(result.agent).toMatchObject({ kernel: "python" });
  });
});
