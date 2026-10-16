import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { normalizeFabricConfig } from "../src/config.js";
import { FabricRuntimeState } from "../src/fabric-runtime-state.js";
import { LifecycleBroker } from "../src/lifecycle/broker.js";
import type { FabricLifecyclePublishRequest } from "../src/lifecycle/types.js";
import type { MeshStore } from "../src/mesh/store.js";
import {
  FABRIC_COMPONENT_DISCOVER_EVENT,
  type FabricComponentDiscovery,
  type FabricProvider,
} from "../src/protocol.js";

// Best-effort mesh publications from the host runtime must never surface as
// unhandled rejections, and a failed component transition must not be
// remembered as published.

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const WAITING_COMPONENT = "needs-absent";

const startRuntime = async (): Promise<{
  runtime: FabricRuntimeState;
  context: ExtensionContext;
  config: ReturnType<typeof normalizeFabricConfig>;
}> => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-mesh-publish-"));
  roots.push(cwd);
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  let registered = false;
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
  vi.stubEnv("PI_FABRIC_PROJECT_ROOT", cwd);
  const pi = {
    events: {
      emit: vi.fn((event: string, payload: unknown) => {
        if (event !== FABRIC_COMPONENT_DISCOVER_EVENT) return;
        // The catalog keeps a definition across a re-initialize, so register once.
        if (registered) return;
        registered = true;
        // Requires a capability nobody provides, so it stays "waiting" and
        // re-reports the same state on every provider change.
        (payload as FabricComponentDiscovery).register({
          name: WAITING_COMPONENT,
          requires: ["alpha.cap", "absent.capability"],
          activate() {},
        });
      }),
    },
    getThinkingLevel: vi.fn(() => "off"),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  } as unknown as ExtensionAPI;
  const context = {
    cwd,
    hasUI: false,
    isProjectTrusted: () => true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
    sessionManager: {
      getSessionId: () => "mesh-publish-failures-session",
      getSessionFile: () => undefined,
      getBranch: () => [],
      getLeafId: () => undefined,
    },
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  } as unknown as ExtensionContext;
  const config = normalizeFabricConfig({
    capture: { enabled: false },
    components: [{ id: WAITING_COMPONENT, component: WAITING_COMPONENT }],
    mcp: { enabled: false, cache: { enabled: false } },
    mesh: { enabled: true },
    memory: { enabled: false },
    agents: { enabled: false },
    residency: { enabled: false },
    prewalk: { enabled: false, alwaysRearm: false },
    approvals: { read: "allow", write: "allow" },
  });
  const fixture = path.join(cwd, "unused.mjs");
  fs.writeFileSync(fixture, "export default {};");
  const runtime = new FabricRuntimeState(pi, new CapturedToolCatalog(), {
    paths: { extension: fixture, worker: fixture, residentHost: fixture, skills: cwd },
  });
  await runtime.initialize(context, config);
  return { runtime, context, config };
};

const provider = (name: string, actions: readonly string[] = []): FabricProvider => {
  const descriptors = actions.map((action) => ({
    name: action,
    description: `${name}.${action}`,
    inputSchema: { type: "object", additionalProperties: false },
    risk: "read" as const,
  }));
  return {
    name,
    description: `Test provider ${name}`,
    async list() { return descriptors; },
    async describe(action) { return descriptors.find((descriptor) => descriptor.name === action); },
    async invoke() { return undefined; },
  };
};

// One macrotask turn. Node runs every queued promise reaction, then its
// unhandled-rejection check, before any setImmediate callback, so this is a
// deterministic flush rather than a timed wait.
const flushPromiseReactions = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const warningsMatching = (warn: { mock: { calls: unknown[][] } }, ...parts: string[]): number =>
  warn.mock.calls.filter((args) =>
    args.some((arg) => typeof arg === "string" && parts.every((part) => arg.includes(part))),
  ).length;

describe("Fabric runtime best-effort mesh publications", () => {
  it("handles a rejected compaction publish without an unhandled rejection and reports it", async () => {
    const failure = new Error("mesh event log is full");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { runtime, context } = await startRuntime();
    // A per-instance stub rather than vi.spyOn: a spy observes the returned
    // promise, which would mark the rejection handled and hide the defect.
    // The stub lives on this runtime's store and goes away with it.
    const mesh = runtime.mesh;
    const publish = mesh.publish.bind(mesh);
    const topics: string[] = [];
    mesh.publish = (input: Parameters<MeshStore["publish"]>[0]) => {
      topics.push(input.topic);
      if (input.topic === "fabric.compact") return Promise.reject(failure);
      return publish(input);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await runtime.registry.invoke("compact.request", { reason: "test" }, {
        cwd: context.cwd,
        signal: undefined,
        parentToolCallId: "compact-request",
        nestedToolCallId: "compact-request",
        extensionContext: context,
        update() {},
        approve: async () => {},
        audits: [],
        maxResultChars: 32_768,
      });
      await flushPromiseReactions();
      expect(topics).toContain("fabric.compact");
      expect(unhandled).not.toContain(failure);
      expect(warningsMatching(warn, "fabric.compact", "mesh event log is full")).toBe(1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await runtime.shutdown();
    }
  });

  it("does not remember a failed component transition and republishes it on the next report", async () => {
    const original = LifecycleBroker.prototype.publish;
    let armed = false;
    let failing = false;
    const published: string[] = [];
    vi.spyOn(LifecycleBroker.prototype, "publish").mockImplementation(
      function (this: LifecycleBroker, request: FabricLifecyclePublishRequest) {
        const data = request.data as Record<string, unknown> | undefined;
        if (armed && request.event === "component.state" && data?.id === WAITING_COMPONENT) {
          published.push(String(data.state));
          if (failing) return Promise.reject(new Error("mesh lock timed out"));
        }
        return original.call(this, request);
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failureWarnings = (): number => warningsMatching(warn, WAITING_COMPONENT, "mesh lock timed out");
    const { runtime } = await startRuntime();
    // A provider change reconciles every component; the waiting component
    // re-reports its state synchronously, so settle() covers the publish call
    // and the flush covers its rejection handler.
    const changeProviders = async (name: string, actions: readonly string[] = []): Promise<void> => {
      runtime.registerExternal(provider(name, actions));
      await runtime.components.settle();
      await flushPromiseReactions();
    };
    try {
      await runtime.components.settle();
      expect(runtime.components.status(WAITING_COMPONENT)).toMatchObject({
        state: "waiting",
        missing: expect.arrayContaining(["alpha.cap", "absent.capability"]),
      });
      armed = true;
      failing = true;

      // A real transition: one requirement appears, the component stays
      // waiting on the other, and that publication fails.
      await changeProviders("alpha", ["cap"]);
      expect(runtime.components.status(WAITING_COMPONENT)).toMatchObject({
        state: "waiting",
        missing: ["absent.capability"],
      });
      expect(published).toEqual(["waiting"]);
      expect(failureWarnings()).toBe(1);

      // The next provider change re-reports the same state, so the failed
      // transition is retried. It fails again within the same streak and is
      // not logged a second time.
      await changeProviders("first-tick");
      expect(published).toEqual(["waiting", "waiting"]);
      expect(failureWarnings()).toBe(1);

      // The mesh recovers: the retry succeeds.
      failing = false;
      await changeProviders("second-tick");
      expect(published).toEqual(["waiting", "waiting", "waiting"]);

      // Once published, the unchanged state is not published again.
      await changeProviders("third-tick");
      expect(published).toEqual(["waiting", "waiting", "waiting"]);

      // The success ended the streak, so the next failure is logged again.
      failing = true;
      await changeProviders("absent", ["capability"]);
      expect(runtime.components.status(WAITING_COMPONENT).state).toBe("active");
      expect(published.length).toBeGreaterThan(3);
      expect(failureWarnings()).toBe(2);
    } finally {
      await runtime.shutdown();
    }
  });

  it("logs the first publish failure again after the runtime is re-initialized", async () => {
    const original = LifecycleBroker.prototype.publish;
    let failing = false;
    vi.spyOn(LifecycleBroker.prototype, "publish").mockImplementation(
      function (this: LifecycleBroker, request: FabricLifecyclePublishRequest) {
        // A fully broken mesh: every component publish fails, so no success
        // can end the streak between the two lifecycles.
        if (failing && request.event === "component.state") {
          return Promise.reject(new Error("mesh lock timed out"));
        }
        return original.call(this, request);
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The streak is runtime-wide, so count every component's publish warning.
    const failureWarnings = (): number => warningsMatching(warn, "state publish failed", "mesh lock timed out");
    const { runtime, context, config } = await startRuntime();
    try {
      await runtime.components.settle();
      failing = true;
      runtime.registerExternal(provider("alpha", ["cap"]));
      await runtime.components.settle();
      await flushPromiseReactions();
      expect(failureWarnings()).toBe(1);

      // A re-initialized runtime starts a new lifecycle: its first failure is
      // logged, not hidden by the streak of the runtime it replaced.
      await runtime.initialize(context, config);
      await runtime.components.settle();
      await flushPromiseReactions();
      expect(failureWarnings()).toBe(2);
    } finally {
      await runtime.shutdown();
    }
  });
});
