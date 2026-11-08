import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { FabricAutoApprovalClassifier } from "../src/core/auto-approval-classifier.js";
import { FabricActivityStore } from "../src/activity/store.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import type { FabricActionDescriptor, FabricProvider } from "../src/protocol.js";

describe("FabricExecutionService", () => {
  it("enforces configured uninterrupted CPU slices without changing the unlimited default", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    const service = new FabricExecutionService(new ActionRegistry(), config);
    const run = (code: string) => service.execute({
      code, signal: undefined, parentToolCallId: "cpu-slice",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });
    const busy = 'const end = Date.now() + 100; while (Date.now() < end) {} return "done";';
    const unlimited = await run(busy);
    expect(unlimited.success, unlimited.error).toBe(true);
    expect(unlimited.value).toBe("done");
    config.executor.maxCpuSliceMs = 20;
    const bounded = await run(busy);
    expect(bounded.success).toBe(false);
    expect(bounded.error).toContain("uninterrupted CPU");
    const yielding = await run('await new Promise(resolve => setTimeout(resolve, 100)); return "done";');
    expect(yielding.success, yielding.error).toBe(true);
    expect(yielding.value).toBe("done");
  });
  it("defers explicit handoff and completes every later call in the same program", async () => {
    const registry = new ActionRegistry();
    const demoDescriptor = {
      name: "call",
      description: "demo call",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        additionalProperties: false,
      },
      risk: "read" as const,
    };
    registry.register({
      name: "demo",
      description: "demo",
      async list() { return [demoDescriptor]; },
      async describe(name) { return name === "call" ? demoDescriptor : undefined; },
      async invoke(_name, args) { return { echoed: args.value }; },
    });
    const handoffDescriptor = {
      name: "handoff",
      description: "defer handoff",
      inputSchema: {
        type: "object",
        properties: { model: { type: "string" }, task: { type: "string" } },
        required: ["model"],
        additionalProperties: false,
      },
      risk: "agent" as const,
    };
    registry.register({
      name: "agents",
      description: "agents",
      async list() { return [handoffDescriptor]; },
      async describe(name) { return name === "handoff" ? handoffDescriptor : undefined; },
      async invoke(_name, args, context) {
        if (!context.deferHandoff) throw new Error("missing deferred boundary");
        return context.deferHandoff(args);
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.read = "allow";
    config.approvals.agent = "allow";
    const service = new FabricExecutionService(registry, config);
    const result = await service.execute({
      code: `
await tools.call({ ref: "demo.call", args: { value: "before" } });
const scheduled = await agents.handoff({
  model: "provider/executor",
  task: "Finish after this complete Fabric program",
});
const after = await tools.call({ ref: "demo.call", args: { value: "after" } });
return { scheduled, after };
`,
      signal: undefined,
      parentToolCallId: "handoff-at-outer-boundary",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });

    expect(result.success).toBe(true);
    expect(result.audits.map((audit) => audit.ref)).toEqual([
      "demo.call",
      "agents.handoff",
      "demo.call",
    ]);
    expect(result.value).toMatchObject({
      scheduled: {
        scheduled: true,
        status: "deferred",
        boundary: "fabric_exec_end",
      },
      after: { echoed: "after" },
    });
    expect(result.handoffRequest).toEqual({
      model: "provider/executor",
      task: "Finish after this complete Fabric program",
    });
  });

  it("applies the same deferred boundary through generic tools.call", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "handoff",
      description: "defer handoff",
      inputSchema: {
        type: "object",
        properties: { model: { type: "string" } },
        required: ["model"],
        additionalProperties: false,
      },
      risk: "agent" as const,
    };
    registry.register({
      name: "agents",
      description: "agents",
      async list() { return [descriptor]; },
      async describe(name) { return name === "handoff" ? descriptor : undefined; },
      async invoke(_name, args, context) {
        return context.deferHandoff!(args);
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.agent = "allow";
    const result = await new FabricExecutionService(registry, config).execute({
      code: `
const scheduled = await tools.call({
  ref: "agents.handoff",
  args: { model: "provider/generic" },
});
return { scheduled, tail: "still ran" };
`,
      signal: undefined,
      parentToolCallId: "generic-handoff-boundary",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });

    expect(result.value).toMatchObject({
      scheduled: {
        scheduled: true,
        status: "deferred",
        boundary: "fabric_exec_end",
      },
      tail: "still ran",
    });
    expect(result.handoffRequest).toEqual({ model: "provider/generic" });
  });

  it.each(["quickjs", "node-process"] as const)(
    "finishes every nested call in the %s fabric_exec before handoff can be claimed",
    async (runtime) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-prewalk-"));
      try {
        const registry = new ActionRegistry();
        registry.register(new PiToolsProvider(cwd, undefined, undefined));
        const config = structuredClone(DEFAULT_FABRIC_CONFIG);
        config.executor.runtime = runtime;
        if (runtime === "node-process") {
          config.executor.memoryLimitBytes = 128 * 1024 * 1024;
        }
        config.approvals.write = "allow";
        const service = new FabricExecutionService(registry, config);
        const result = await service.execute({
          code: `
await pi.write({ path: "first.txt", content: "first" });
await Promise.all([
  pi.write({ path: "second.txt", content: "second" }),
  pi.write({ path: "third.txt", content: "third" }),
]);
return "complete outer result";
`,
          signal: undefined,
          parentToolCallId: "prewalk-complete-program",
          context: { cwd, hasUI: false } as ExtensionContext,
          onPartial() {},
        });

        expect(result.success).toBe(true);
        expect(result.value).toBe("complete outer result");
        expect(result.audits.map((audit) => audit.ref)).toEqual([
          "pi.write",
          "pi.write",
          "pi.write",
        ]);
        expect(fs.readdirSync(cwd).sort()).toEqual([
          "first.txt",
          "second.txt",
          "third.txt",
        ]);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it("calls a Pi built-in from sandboxed TypeScript", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-execution-"));
    try {
      fs.writeFileSync(path.join(cwd, "sample.txt"), "fabric works\n", "utf8");
      const registry = new ActionRegistry();
      registry.register(new PiToolsProvider(cwd, undefined, undefined));
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      config.approvals.read = "allow";
      const service = new FabricExecutionService(registry, config);
      const context = {
        cwd,
        hasUI: false,
      } as ExtensionContext;
      const result = await service.execute({
        code: 'const content = await pi.read({ path: "sample.txt" });\nreturn content.trim();',
        signal: undefined,
        parentToolCallId: "test",
        context,
        onPartial() {},
      });
      expect(result.success).toBe(true);
      expect(result.value).toBe("fabric works");
      expect(result.audits).toMatchObject([
        { ref: "pi.read", success: true, tool: "read", provider: "pi" },
      ]);
      expect(result.audits[0]?.args).toMatchObject({ path: "sample.txt" });
      expect(result.audits[0]?.result).toBe("fabric works\n");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("uses the configured disposable Node process executor", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.executor.runtime = "node-process";
    config.executor.memoryLimitBytes = 128 * 1024 * 1024;
    const service = new FabricExecutionService(new ActionRegistry(), config);
    const result = await service.execute({
      code: 'print("native"); return { answer: 42 };',
      signal: undefined,
      parentToolCallId: "native-test",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });

    expect(result.success).toBe(true);
    expect(result.logs).toEqual(["native"]);
    expect(result.value).toEqual({ answer: 42 });
  });

  it("coalesces all parallel nested calls through one global debounce and flushes on settle", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "ping",
      description: "emit rapid progress",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
        additionalProperties: false,
      },
      risk: "read" as const,
    };
    registry.register({
      name: "demo",
      description: "debounce fixture",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "ping" ? descriptor : undefined;
      },
      async invoke(_name, args, invocation) {
        invocation.update(`starting ${String(args.id)}`);
        invocation.update(`finishing ${String(args.id)}`);
        return args.id;
      },
    });
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const code = `return Promise.all([
      tools.call({ ref: "demo.ping", args: { id: 1 } }),
      tools.call({ ref: "demo.ping", args: { id: 2 } }),
      tools.call({ ref: "demo.ping", args: { id: 3 } }),
    ]);`;

    const debouncedConfig = structuredClone(DEFAULT_FABRIC_CONFIG);
    debouncedConfig.fullCodeMode = false;
    debouncedConfig.approvals.read = "allow";
    debouncedConfig.ui.updateDebounceMs = 10_000;
    const debouncedPartials: Array<{ audits: unknown[] }> = [];
    const debounced = await new FabricExecutionService(registry, debouncedConfig).execute({
      code,
      signal: undefined,
      parentToolCallId: "global-debounce",
      context,
      onPartial(snapshot) {
        debouncedPartials.push(snapshot);
      },
    });
    expect(debounced.success).toBe(true);
    expect(debouncedPartials).toHaveLength(1);
    expect(debouncedPartials[0]?.audits).toHaveLength(3);

    const immediateConfig = structuredClone(debouncedConfig);
    immediateConfig.ui.updateDebounceMs = 0;
    const immediatePartials: unknown[] = [];
    await new FabricExecutionService(registry, immediateConfig).execute({
      code,
      signal: undefined,
      parentToolCallId: "no-debounce",
      context,
      onPartial(snapshot) {
        immediatePartials.push(snapshot);
      },
    });
    expect(immediatePartials.length).toBeGreaterThan(1);
  });

  it("ignores late nested updates after activity resets during execution", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "stream",
      description: "emit progress on demand",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read" as const,
    };
    let emitUpdate!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    registry.register({
      name: "demo",
      description: "stream fixture",
      async list() { return [descriptor]; },
      async describe(name) { return name === "stream" ? descriptor : undefined; },
      async invoke(_name, _args, invocation) {
        emitUpdate = () => invocation.update("late output");
        markStarted();
        await released;
        return true;
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.read = "allow";
    const activity = new FabricActivityStore();
    const execution = new FabricExecutionService(registry, config, activity).execute({
      code: 'return tools.call({ ref: "demo.stream" });',
      signal: undefined,
      parentToolCallId: "reset-during-stream",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });

    await started;
    expect(activity.get("reset-during-stream")?.status).toBe("running");
    activity.reset();
    expect(() => emitUpdate()).not.toThrow();
    release();

    await expect(execution).resolves.toMatchObject({ success: true, value: true });
    expect(activity.get("reset-during-stream")).toBeUndefined();
  });

  it("marks a run cancelled from the abort signal, not from its error text", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    const activity = new FabricActivityStore();
    const service = new FabricExecutionService(new ActionRegistry(), config, activity);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;

    const failed = await service.execute({
      code: 'throw new Error("order was cancelled upstream");',
      signal: undefined,
      parentToolCallId: "error-mentions-cancel",
      context,
      onPartial() {},
    });
    expect(failed.success).toBe(false);
    expect(activity.get("error-mentions-cancel")?.status).toBe("failed");

    const controller = new AbortController();
    const aborted = service.execute({
      code: "await new Promise(() => {});",
      signal: controller.signal,
      parentToolCallId: "aborted-run",
      context,
      onPartial() {},
    });
    queueMicrotask(() => controller.abort());
    await aborted.catch(() => undefined);
    expect(activity.get("aborted-run")?.status).toBe("cancelled");
  });

  it("passes the cancelled program signal to provider finalization", async () => {
    const registry = new ActionRegistry();
    const controller = new AbortController();
    const descriptor = { name: "cancel", description: "Cancel the foreground run",
      inputSchema: { type: "object", properties: {} }, risk: "read" as const };
    registry.register({ name: "demo", description: "Cancellation fixture",
      async list() { return [descriptor]; }, async describe() { return descriptor; },
      async invoke() { controller.abort(); return null; },
    });
    const end = vi.spyOn(registry, "endInvocation");
    const result = await new FabricExecutionService(registry, structuredClone(DEFAULT_FABRIC_CONFIG)).execute({
      code: 'return await tools.call({ ref: "demo.cancel", args: {} });',
      signal: controller.signal, parentToolCallId: "cancel-finalization",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext, onPartial() {},
    });
    expect(controller.signal.aborted).toBe(true);
    expect(result.success).toBe(false);
    expect(result.error).toContain("cancelled");
    expect(end).toHaveBeenCalledExactlyOnceWith("cancel-finalization", undefined, controller.signal);
  });

  it("throttles continuous nested progress without starving intermediate snapshots", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "stream",
      description: "emit sustained progress",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read" as const,
    };
    registry.register({
      name: "demo",
      description: "stream fixture",
      async list() { return [descriptor]; },
      async describe(name) { return name === "stream" ? descriptor : undefined; },
      async invoke(_name, _args, invocation) {
        for (let index = 0; index < 8; index++) {
          invocation.update(`tick ${index}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return true;
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.read = "allow";
    config.ui.updateDebounceMs = 50;
    const partials: Array<{ progress?: string | undefined; audits: Array<{ success?: boolean }> }> = [];

    const result = await new FabricExecutionService(registry, config).execute({
      code: 'return tools.call({ ref: "demo.stream" });',
      signal: undefined,
      parentToolCallId: "continuous-progress",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial(snapshot) { partials.push(structuredClone(snapshot)); },
    });

    expect(result.success).toBe(true);
    expect(partials.some((snapshot) => snapshot.audits[0]?.success === undefined)).toBe(true);
    expect(partials.some((snapshot) => snapshot.progress?.startsWith("tick ") && snapshot.progress !== "tick 7")).toBe(true);
    expect(partials.length).toBeLessThan(8);
  });

  it("coalesces rapid workflow phase updates through the same debounce", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.ui.updateDebounceMs = 10_000;
    const partials: Array<{ phases: string[] }> = [];
    const result = await new FabricExecutionService(new ActionRegistry(), config).execute({
      code: `
for (let index = 0; index < 50; index++) {
  await phase("Phase " + index);
}
return "done";
`,
      signal: undefined,
      parentToolCallId: "phase-debounce",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial(snapshot) {
        partials.push(snapshot);
      },
    });

    expect(result.success).toBe(true);
    expect(result.phases).toHaveLength(50);
    expect(partials).toHaveLength(1);
    expect(partials[0]?.phases).toHaveLength(50);
  });

  it("attaches image blocks to the audit for a single nested image read", async () => {
    const cwd = process.cwd();
    const registry = new ActionRegistry();
    registry.register(new PiToolsProvider(cwd, undefined, undefined));
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.approvals.read = "allow";
    const service = new FabricExecutionService(registry, config);
    const context = { cwd, hasUI: false } as ExtensionContext;
    const result = await service.execute({
      code: 'return pi.read({ path: "tests/fixtures/images/sample.jpg" });',
      signal: undefined,
      parentToolCallId: "img-read",
      context,
      onPartial() {},
    });
    expect(result.success).toBe(true);
    expect(result.audits).toHaveLength(1);
    const media = result.audits[0]?.media;
    expect(media).toBeDefined();
    expect(media!.length).toBeGreaterThan(0);
    expect(media![0]?.type).toBe("image");
    expect(media![0]?.mimeType).toMatch(/^image\//);
    expect(typeof media![0]?.data).toBe("string");
    expect(media![0]?.data!.length).toBeGreaterThan(0);
  }, 15_000);

  it("keeps Pi core tools outside Fabric in orchestration-only mode", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-native-tools-"));
    try {
      fs.writeFileSync(path.join(cwd, "sample.txt"), "native\n", "utf8");
      const registry = new ActionRegistry();
      registry.register(new PiToolsProvider(cwd, undefined, undefined));
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      config.fullCodeMode = false;
      config.approvals.read = "allow";
      const service = new FabricExecutionService(registry, config);
      const context = { cwd, hasUI: false } as ExtensionContext;

      const metadata = await service.execute({
        code: `
return {
  providers: await tools.providers(),
  catalog: await tools.catalog(),
  search: await tools.search({ query: "read" }),
};
`,
        signal: undefined,
        parentToolCallId: "native-metadata",
        context,
        onPartial() {},
      });
      expect(metadata.success).toBe(true);
      expect(metadata.value).toMatchObject({
        providers: [{ name: "native" }],
        catalog: {
          kind: "pi-fabric.capability-catalog",
          complete: true,
          totalActions: 7,
          indexedActions: 7,
          providers: [{ name: "native" }],
          root: {
            key: "capability:fabric",
            description: expect.stringContaining("not historical session evidence"),
          },
        },
        search: [{ ref: "native.load" }],
      });

      const direct = await service.execute({
        code: 'return pi.read({ path: "sample.txt" });',
        signal: undefined,
        parentToolCallId: "native-direct",
        context,
        onPartial() {},
      });
      expect(direct.typeErrors?.map((error) => error.message).join(" ")).toContain(
        "Cannot find name 'pi'",
      );

      const indirect = await service.execute({
        code: 'return tools.call({ ref: "pi.read", args: { path: "sample.txt" } });',
        signal: undefined,
        parentToolCallId: "native-indirect",
        context,
        onPartial() {},
      });
      expect(indirect.success).toBe(false);
      expect(indirect.error).toContain("full code mode is disabled");
      expect(indirect.audits).toEqual([]);

      const extension = await service.execute({
        code: 'return tools.call({ ref: "extensions.project_status", args: {} });',
        signal: undefined,
        parentToolCallId: "native-extension",
        context,
        onPartial() {},
      });
      expect(extension.success).toBe(false);
      expect(extension.error).toContain("registered extension tools directly outside fabric_exec");
      expect(extension.audits).toEqual([]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("publishes declarative workflow activity for the dynamic TUI", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-activity-"));
    try {
      fs.writeFileSync(path.join(cwd, "sample.txt"), "dashboard\n", "utf8");
      const registry = new ActionRegistry();
      registry.register(new PiToolsProvider(cwd, undefined, undefined));
      const config = structuredClone(DEFAULT_FABRIC_CONFIG);
      config.approvals.read = "allow";
      const activity = new FabricActivityStore();
      const service = new FabricExecutionService(registry, config, activity);
      const context = { cwd, hasUI: false } as ExtensionContext;
      const partials: Array<{ phases: string[] }> = [];
      const result = await service.execute({
        code: `
await workflow.configure({ name: "File audit", description: "Read one fixture" });
await phase("Inspect", { id: "inspect", total: 1 });
await workflow.item({ id: "fixture", label: "Read fixture", status: "running" });
const text = await pi.read({ path: "sample.txt" });
await workflow.item({ id: "fixture", label: "Read fixture", status: "completed", completed: 1, total: 1 });
await workflow.event({ message: "Fixture inspected", level: "success" });
return text.trim();
`,
        signal: undefined,
        parentToolCallId: "activity-test",
        context,
        onPartial(snapshot) {
          partials.push(snapshot);
        },
      });

      expect(result.success).toBe(true);
      expect(partials.some((partial) => partial.phases.includes("Inspect"))).toBe(true);
      expect(activity.get("activity-test")).toMatchObject({
        name: "File audit",
        description: "Read one fixture",
        status: "completed",
        phases: [{ id: "inspect", name: "Inspect", status: "completed", total: 1 }],
        calls: [{ ref: "pi.read", status: "completed", phaseId: "inspect" }],
        items: [{ id: "fixture", status: "completed", completed: 1, total: 1 }],
        events: [{ message: "Fixture inspected", level: "success" }],
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("enforces the per-execution agent budget", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "run",
      description: "fake agent",
      inputSchema: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
        additionalProperties: true,
      },
      risk: "agent" as const,
    };
    registry.register({
      name: "agents",
      description: "fake agents",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "run" ? descriptor : undefined;
      },
      async invoke(_name, args) {
        return {
          status: "completed",
          text: String(args.task),
          usage: { input: 1, output: 1 },
        };
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.agent = "allow";
    const service = new FabricExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const result = await service.execute({
      code: `
await Promise.all([
  agents.run({ task: "one" }),
  agents.run({ task: "two" }),
]);
return "unreachable";
`,
      signal: undefined,
      parentToolCallId: "budget-test",
      context,
      maxAgentCalls: 1,
      onPartial() {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("agent budget exhausted (1 per execution)");
  });

  it("raises the executor deadline to the agent deadline for orchestration programs", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "run",
      description: "fake agent",
      inputSchema: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
        additionalProperties: true,
      },
      risk: "agent" as const,
    };
    registry.register({
      name: "agents",
      description: "fake agents",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "run" ? descriptor : undefined;
      },
      async invoke(_name, _args, context) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            clearTimeout(timer);
            resolve({ status: "completed", text: "ok", usage: { input: 0, output: 0 } });
          }, 250);
          context.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
        });
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.agent = "allow";
    config.executor.timeoutMs = 100;
    config.agents.timeoutMs = 30_000;
    const service = new FabricExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const result = await service.execute({
      code: 'await agents.run({ task: "slow" }); return "ok";',
      signal: undefined,
      parentToolCallId: "orchestration-floor",
      context,
      onPartial() {},
    });
    expect(result.success).toBe(true);
    expect(result.value).toBe("ok");
  });

  it("permits a captured-style slow call beyond executor.timeoutMs via per-invocation timeoutMs", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "slowext",
      description: "captured extension stub",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: true,
      },
      risk: "read" as const,
    };
    registry.register({
      name: "extensions",
      description: "fake extensions",
      async list() { return [descriptor]; },
      async describe(name) { return name === "slowext" ? descriptor : undefined; },
      async invoke(_name, _args, context) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ ok: true }), 250);
          context.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
        });
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = true;
    config.approvals.read = "allow";
    config.executor.timeoutMs = 100;
    const service = new FabricExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;

    // Without a raised deadline the 250ms call fails at the 100ms default.
    const timedOut = await service.execute({
      code: 'await extensions.slowext({ url: "x" }); return "ok";',
      signal: undefined,
      parentToolCallId: "default-timeout",
      context,
      onPartial() {},
    });
    expect(timedOut.success).toBe(false);
    expect(timedOut.error).toContain("timed out");

    // The per-invocation request raises the whole-program deadline.
    const raised = await service.execute({
      code: 'await extensions.slowext({ url: "x" }); return "ok";',
      requestedTimeoutMs: 30_000,
      signal: undefined,
      parentToolCallId: "raised-timeout",
      context,
      onPartial() {},
    });
    expect(raised.success).toBe(true);
    expect(raised.value).toBe("ok");

    // The request cannot exceed the configured policy maximum.
    const capped = await service.execute({
      code: 'await extensions.slowext({ url: "x" }); return "ok";',
      requestedTimeoutMs: 3_600_000,
      signal: undefined,
      parentToolCallId: "capped-timeout",
      context,
      onPartial() {},
    });
    expect(capped.success).toBe(true);
  });

  it("raises the deadline for a configured exact host-call ref", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "subagent",
      description: "captured extension stub",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: true,
      },
      risk: "read" as const,
    };
    registry.register({
      name: "extensions",
      description: "fake extensions",
      async list() { return [descriptor]; },
      async describe(name) {
        return name === "subagent" || name === "unfloored" ? { ...descriptor, name } : undefined;
      },
      async invoke(_name, _args, context) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ ok: true }), 250);
          context.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
        });
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = true;
    config.approvals.read = "allow";
    config.executor.timeoutMs = 100;
    config.executor.hostCallTimeouts = { "extensions.subagent": 30_000 };
    const service = new FabricExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;

    const result = await service.execute({
      code: 'await extensions.subagent({}); return "ok";',
      signal: undefined,
      parentToolCallId: "ref-floor",
      context,
      onPartial() {},
    });
    expect(result.success).toBe(true);
    expect(result.value).toBe("ok");

    // A ref without a configured floor still runs at the default deadline.
    const other = await service.execute({
      code: 'await extensions.unfloored({}); return "ok";',
      signal: undefined,
      parentToolCallId: "ref-floor-other",
      context,
      onPartial() {},
    });
    expect(other.success).toBe(false);
    expect(other.error).toContain("timed out");
  });

  it("extends the outer deadline from an explicit pi.bash timeout", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "bash",
      description: "fake slow bash",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout: { type: "number" },
        },
        required: ["command"],
        additionalProperties: true,
      },
      risk: "read" as const,
    };
    registry.register({
      name: "pi",
      description: "fake pi",
      async list() { return [descriptor]; },
      async describe(name) { return name === "bash" ? descriptor : undefined; },
      async invoke(_name, _args, context) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ ok: true, output: "ok", details: {} }), 250);
          context.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
        });
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = true;
    config.approvals.read = "allow";
    config.executor.timeoutMs = 100;
    const service = new FabricExecutionService(registry, config);
    const result = await service.execute({
      code: 'await pi.bash({ command: "slow", timeout: 1 }); return "ok";',
      signal: undefined,
      parentToolCallId: "bash-timeout-floor",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });
    expect(result.success).toBe(true);
    expect(result.value).toBe("ok");
  });

  it("raises the deadline for literal and computed generic agent refs", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "run",
      description: "fake agent",
      inputSchema: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
        additionalProperties: true,
      },
      risk: "agent" as const,
    };
    registry.register({
      name: "agents",
      description: "fake agents",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "run" ? descriptor : undefined;
      },
      async invoke(_name, args, context) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            resolve({
              status: "completed",
              text: String(args.task),
              usage: { input: 0, output: 0 },
            });
          }, 250);
          context.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
        });
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.agent = "allow";
    config.executor.timeoutMs = 100;
    config.agents.timeoutMs = 30_000;
    const service = new FabricExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const result = await service.execute({
      code: `
const computedRef = ["agents", "run"].join(".");
return Promise.all([
  tools.call({ ref: "agents.run", args: { task: "literal" } }),
  tools.call({ ref: computedRef, args: { task: "computed" } }),
]);
`,
      signal: undefined,
      parentToolCallId: "generic-orchestration-floor",
      context,
      onPartial() {},
    });
    expect(result.success).toBe(true);
    expect(result.value).toEqual([
      { status: "completed", text: "literal", usage: { input: 0, output: 0 } },
      { status: "completed", text: "computed", usage: { input: 0, output: 0 } },
    ]);
  });

  it("audits auto approvals and accounts for classifier usage", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "mutate",
      description: "mutate one value",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      risk: "write" as const,
    };
    const invoke = vi.fn(async (_name, args) => args);
    registry.register({
      name: "demo",
      description: "demo provider",
      async list() { return [descriptor]; },
      async describe(name) { return name === "mutate" ? descriptor : undefined; },
      invoke,
    });
    const usage = {
      input: 20,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 25,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    };
    const classify = vi.fn(async () => ({
      decision: "allow" as const,
      reason: "Bounded task-aligned mutation",
      model: "anthropic/classifier",
      usage,
    }));
    const classifier = { classify } as unknown as FabricAutoApprovalClassifier;
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.write = "auto";
    const service = new FabricExecutionService(
      registry,
      config,
      undefined,
      undefined,
      classifier,
    );

    const result = await service.execute({
      code: 'return tools.call({ ref: "demo.mutate", args: { value: "next" } });',
      signal: undefined,
      parentToolCallId: "auto-approval",
      context: { cwd: process.cwd(), hasUI: false } as ExtensionContext,
      onPartial() {},
    });

    expect(result.success).toBe(true);
    expect(classify).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "demo.mutate", risk: "write" }),
      { value: "next" },
      expect.anything(),
      undefined,
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(result.usage).toEqual(usage);
    expect(result.trace.operations).toContainEqual(
      expect.objectContaining({
        ref: "fabric.approval.auto",
        result: expect.objectContaining({
          decision: "allow",
          model: "anthropic/classifier",
        }),
      }),
    );
  });

  it("keeps the short executor deadline for non-orchestration programs", async () => {
    const registry = new ActionRegistry();
    const descriptor = {
      name: "slow",
      description: "slow call",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read" as const,
    };
    registry.register({
      name: "demo",
      description: "demo provider",
      async list() {
        return [descriptor];
      },
      async describe(name) {
        return name === "slow" ? descriptor : undefined;
      },
      async invoke(_name, _args, context) {
        return new Promise((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
    });
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.fullCodeMode = false;
    config.approvals.read = "allow";
    config.executor.timeoutMs = 100;
    config.agents.timeoutMs = 30_000;
    const service = new FabricExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const result = await service.execute({
      code: 'return tools.call({ ref: "demo.slow", args: {} });',
      signal: undefined,
      parentToolCallId: "no-floor",
      context,
      onPartial() {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  });
});

describe("FabricExecutionService dynamic guest typing", () => {
  const mcpDescriptor: FabricActionDescriptor = {
    name: "github.get_repo",
    description: "Get a GitHub repository",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
      },
      required: ["owner", "repo"],
      additionalProperties: false,
    },
    risk: "network",
    namespace: "github",
  };
  const mcpProvider = (cacheWarm: boolean): FabricProvider & {
    sliceDescriptors?: () => FabricActionDescriptor[];
  } => ({
    name: "mcp",
    description: "Mock MCP provider",
    async list() {
      return [mcpDescriptor];
    },
    async describe(name) {
      return name === mcpDescriptor.name ? mcpDescriptor : undefined;
    },
    async invoke(_name, args) {
      return { mirrored: args };
    },
    ...(cacheWarm
      ? { sliceDescriptors: () => [mcpDescriptor] }
      : {}),
  });
  const extensionDescriptor: FabricActionDescriptor = {
    name: "project_status",
    description: "Report project status",
    inputSchema: {
      type: "object",
      properties: { verbose: { type: "boolean" } },
      additionalProperties: false,
    },
    risk: "read",
  };
  const extensionsProvider = (): FabricProvider => ({
    name: "extensions",
    description: "Mock extensions provider",
    async list() {
      return [extensionDescriptor];
    },
    async describe(name) {
      return name === extensionDescriptor.name ? extensionDescriptor : undefined;
    },
    async invoke(_name, args) {
      return {
        content: [{ type: "text", text: JSON.stringify(args) }],
        text: JSON.stringify(args),
        isError: false,
      };
    },
  });
  const setup = (providers: FabricProvider[]) => {
    const registry = new ActionRegistry();
    for (const provider of providers) registry.register(provider);
    const service = new FabricExecutionService(registry, structuredClone(DEFAULT_FABRIC_CONFIG));
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;
    const run = (code: string, parentToolCallId: string) =>
      service.execute({ code, signal: undefined, parentToolCallId, context, onPartial() {} });
    return { service, context, run };
  };

  it("rejects argument-shape mistakes on mcp tools before executing", async () => {
    const { run } = setup([mcpProvider(true)]);
    const result = await run(
      'return mcp.github.get_repo({ owner: "octo", repo: "hello", branchs: "main" });',
      "dyn-mcp-typo",
    );
    expect(result.success).toBe(false);
    expect(result.audits).toEqual([]);
    expect(result.trace.outcome).toBe("failed");
    expect(result.trace.operations).toEqual([]);
    expect(result.typeErrors?.map((error) => error.message).join(" ")).toMatch(
      /branchs|known properties/,
    );
  });

  it("executes well-shaped calls against typed mcp surfaces", async () => {
    const { run } = setup([mcpProvider(true)]);
    const result = await run(
      'return mcp.github.get_repo({ owner: "octo", repo: "hello" });',
      "dyn-mcp-valid",
    );
    expect(result.typeErrors).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.audits[0]?.ref).toBe("mcp.github.get_repo");
    expect(result.value).toEqual({ mirrored: { owner: "octo", repo: "hello" } });
  });

  it("routes suppressed-property omissions to registry validation", async () => {
    const { run } = setup([mcpProvider(true)]);
    // Missing a required property is TS2345 (suppressed by design) and never
    // reaches the mcp.invoke path — the registry's validate stage rejects it.
    const result = await run(
      'return mcp.github.get_repo({ owner: "octo" });',
      "dyn-mcp-missing",
    );
    expect(result.typeErrors).toBeUndefined();
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid arguments for mcp.github.get_repo");
    expect(result.trace.operations[0]).toMatchObject({
      outcome: "failed",
      failureStage: "validate",
    });
  });

  it("fails unknown mcp servers at resolve even with a typed surface", async () => {
    const { run } = setup([mcpProvider(true)]);
    const result = await run(
      "return mcp.new_server.tool({ anything: true });",
      "dyn-mcp-unknown",
    );
    expect(result.typeErrors).toBeUndefined();
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown Fabric action: mcp.new_server.tool");
  });

  it("keeps cold-cache mcp surfaces loose and validated at dispatch", async () => {
    const { run } = setup([mcpProvider(false)]);
    const result = await run(
      'return mcp.github.get_repo({ owner: "octo", branchs: "main" });',
      "dyn-mcp-cold",
    );
    expect(result.typeErrors).toBeUndefined();
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid arguments for mcp.github.get_repo");
    expect(result.trace.operations[0]).toMatchObject({
      outcome: "failed",
      failureStage: "validate",
    });
  });

  it("rejects argument-shape mistakes on captured extension tools before executing", async () => {
    const { run } = setup([extensionsProvider()]);
    const result = await run(
      "return extensions.project_status({ verbise: true });",
      "dyn-ext-typo",
    );
    expect(result.success).toBe(false);
    expect(result.audits).toEqual([]);
    expect(result.typeErrors?.map((error) => error.message).join(" ")).toMatch(
      /verbise|known properties/,
    );
  });

  it("executes well-shaped captured extension tool calls", async () => {
    const { run } = setup([extensionsProvider()]);
    const result = await run(
      "return extensions.project_status({ verbose: true });",
      "dyn-ext-valid",
    );
    expect(result.typeErrors).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.audits[0]?.ref).toBe("extensions.project_status");
  });
});
