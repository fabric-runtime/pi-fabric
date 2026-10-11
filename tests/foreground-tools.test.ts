import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionRunner,
  ToolCallEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { DEFAULT_FABRIC_CONFIG, normalizeFabricConfig } from "../src/config.js";
import { ApprovalController, FabricSessionApprovals } from "../src/core/approval-controller.js";
import { FabricDirectToolApproval } from "../src/core/direct-tool-approval.js";
import {
  foregroundConfigValue,
  formatForeground,
  resolveForegroundTools,
  type FabricForegroundConfig,
} from "../src/core/foreground-tools.js";
import { fabricModelContext, fabricToolLoadout, fabricToolPlacement } from "../src/core/tool-ownership.js";
import { FabricState } from "../src/fabric-state.js";
import { CapturedToolsProvider } from "../src/providers/captured-tools-provider.js";

// These fixtures own their config/authority. A Fabric child running Vitest
// must not inherit its host's tool allowlist or full-code-mode override.
// Explicit inherited-authority behavior is tested by resolveForegroundTools.
beforeEach(() => {
  vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", undefined);
  vi.stubEnv("PI_FABRIC_FULL_CODE_MODE", undefined);
});
afterEach(() => vi.unstubAllEnvs());

const source = (kind: "builtin" | "extension") => ({
  path: kind === "builtin" ? "<builtin:x>" : "/extensions/ask.ts",
  source: kind === "builtin" ? "builtin" : "local",
  scope: "temporary" as const,
  origin: "top-level" as const,
});
const info = (name: string, kind: "builtin" | "extension" = "extension", exposure = "direct") => ({
  name,
  description: `Run ${name}`,
  parameters: { type: "object", properties: {} },
  exposure,
  sourceInfo: source(kind),
});
const entry = (name: string, reason = "human-input") => ({ name, owner: "pi-ask", reason });
const policy = (names: string[], maxTools = 4): FabricForegroundConfig =>
  foregroundConfigValue({ tools: names.map((name) => entry(name)), maxTools });

const registered = [
  info("fabric_exec"), info("read", "builtin"), info("bash", "builtin"), info("codemode", "builtin"),
  info("ask_user"), info("todo"), info("plan"), info("skill"), info("ghost", "extension", "hidden"), info("idle"),
];
const active = new Set(registered.map((tool) => tool.name).filter((name) => name !== "idle"));

describe("foreground config", () => {
  it("defaults to an empty policy capped at four", () => {
    expect(DEFAULT_FABRIC_CONFIG.foreground).toEqual({ tools: [], maxTools: 4 });
    expect(normalizeFabricConfig({}).foreground).toEqual({ tools: [], maxTools: 4 });
    expect(normalizeFabricConfig({ foreground: { tools: [entry("ask_user")], maxTools: 8 } }).foreground)
      .toEqual({ tools: [entry("ask_user")], maxTools: 8 });
  });

  it("fails closed on malformed entries", () => {
    for (const value of [
      { tools: "ask_user" },
      { tools: [{ name: "ask_user", owner: "x" }] },
      { tools: [{ name: "ask_user", reason: "human-input" }] },
      { tools: [{ name: "ask user", owner: "x", reason: "human-input" }] },
      { tools: [{ name: "ask_user", owner: "x", reason: "convenience" }] },
      { tools: [entry("fabric_exec")] },
      { tools: [null] },
      { tools: Array.from({ length: 65 }, (_, i) => entry(`t${i}`)) },
      { maxTools: 9 },
      { maxTools: -1 },
      { maxTools: 2.5 },
    ]) {
      expect(() => foregroundConfigValue(value), JSON.stringify(value).slice(0, 80)).toThrow(/foreground/);
    }
  });
});

describe("resolveForegroundTools", () => {
  const resolve = (config: FabricForegroundConfig, mode: "full-code" | "enforce" | "orchestration" = "full-code",
    extra: { managedHost?: boolean; allowlist?: ReadonlySet<string> } = {}) =>
    resolveForegroundTools({ policy: config, mode, registered, active, ...extra });

  it("keeps registered extension tools and refuses core, builtin, unknown, hidden and inactive tools", () => {
    const resolution = resolve(policy(["ask_user", "read", "codemode", "missing", "ghost", "idle", "ask_user", "todo"]));
    expect(resolution.tools).toEqual(["ask_user", "todo"]);
    expect(resolution.refused).toEqual([
      { name: "read", reason: "core" },
      { name: "codemode", reason: "builtin" },
      { name: "missing", reason: "unknown" },
      { name: "ghost", reason: "unknown" },
      { name: "idle", reason: "inactive" },
      { name: "ask_user", reason: "duplicate" },
    ]);
  });

  it("refuses entries beyond maxTools in policy order", () => {
    expect(resolve(policy(["ask_user", "todo", "plan", "skill"], 2))).toEqual({
      tools: ["ask_user", "todo"],
      refused: [{ name: "plan", reason: "cap" }, { name: "skill", reason: "cap" }],
    });
    expect(resolve(policy(["ask_user"], 0)).refused).toEqual([{ name: "ask_user", reason: "cap" }]);
  });

  it("refuses the whole policy in Schema enforce mode and managed hosts", () => {
    expect(resolve(policy(["ask_user", "todo"]), "enforce")).toEqual({
      tools: [],
      refused: [{ name: "ask_user", reason: "enforce" }, { name: "todo", reason: "enforce" }],
    });
    expect(resolve(policy(["ask_user"]), "full-code", { managedHost: true }).refused)
      .toEqual([{ name: "ask_user", reason: "managed-host" }]);
    expect(formatForeground(resolve(policy(["ask_user"]), "enforce")))
      .toBe("refused ask_user (enforce); declared fabric_exec only");
    expect(formatForeground(resolve(policy(["ask_user", "read"]))))
      .toBe("refused read (core); declared ask_user");
  });

  it("honours an inherited child tool allowlist and is inert in orchestration mode", () => {
    expect(resolve(policy(["ask_user", "todo"]), "full-code", { allowlist: new Set(["todo"]) })).toEqual({
      tools: ["todo"],
      refused: [{ name: "ask_user", reason: "not-allowed" }],
    });
    expect(resolve(policy(["ask_user"]), "orchestration")).toEqual({ tools: [], refused: [] });
  });
});

describe("foreground loadout and placement", () => {
  it("keeps foreground tools declared beside fabric_exec", () => {
    const tools = registered.map(({ name }) => ({ name }));
    const loadout = { registered: tools, declared: tools, callable: tools } as unknown as Parameters<typeof fabricToolLoadout>[0];
    const hidden = fabricToolLoadout(loadout, true, ["ask_user"])?.hiddenDeclarations ?? [];
    expect(hidden).not.toContain("ask_user");
    expect(hidden).not.toContain("fabric_exec");
    expect(hidden).toContain("todo");
    expect(hidden).toContain("read");
  });

  it("declares fabric_exec then foreground tools in the projected transcript", () => {
    const fabric = { name: "fabric_exec", description: "Fabric", parameters: {} };
    const ask = { name: "ask_user", description: "Ask", parameters: {} };
    const messages = [
      { role: "system", content: "s", toolsAdded: [{ ...ask, name: "todo" }], timestamp: 1 },
    ] as Parameters<typeof fabricModelContext>[0];
    expect(fabricModelContext(messages, [fabric, ask])[0]).toMatchObject({ toolsAdded: [fabric, ask] });
  });

  it("reports foreground tools as model and program-callable", () => {
    const result = fabricToolPlacement({
      mode: "full-code",
      registered: ["fabric_exec", "ask_user", "todo", "read"],
      active: ["fabric_exec", "ask_user", "todo", "read"],
      program: (name) => name !== "fabric_exec",
      foreground: ["ask_user"],
    });
    expect(result).toEqual({
      version: 1,
      mode: "full-code",
      tools: { fabric_exec: "model", ask_user: "model", todo: "program", read: "program" },
      programCallable: ["ask_user"],
    });
  });
});

describe("foreground approval parity", () => {
  const callEvent = (toolName: string): ToolCallEvent => ({
    type: "tool_call", toolCallId: `call-${toolName}`, toolName, input: { question: "ship?" },
  });
  const noUi = { cwd: process.cwd(), hasUI: false, mode: "print" } as ExtensionContext;

  const programAction = async (config: typeof DEFAULT_FABRIC_CONFIG, name: string) => {
    const catalog = new CapturedToolCatalog();
    catalog.replace(
      [{ definition: { ...info(name), label: name, execute: vi.fn() }, sourceInfo: source("extension") }] as never,
      {} as ExtensionRunner,
      config.capture,
      "/extensions/pi-fabric/index.ts",
    );
    const descriptor = await new CapturedToolsProvider(catalog).describe(name, {} as never);
    if (!descriptor) throw new Error("not captured");
    return { ref: `extensions.${name}`, provider: "extensions", name, description: descriptor.description,
      inputSchema: descriptor.inputSchema, risk: descriptor.risk };
  };

  it("applies the captured extensions.<name> risk and action override to the direct call", async () => {
    const config = structuredClone(DEFAULT_FABRIC_CONFIG);
    config.capture.risks.ask_user = "network";
    config.approvals.network = "deny";
    const direct = new FabricDirectToolApproval(
      { getAllTools: () => [info("ask_user")] } as never, () => config, new FabricSessionApprovals());
    const action = await programAction(config, "ask_user");
    expect(action.risk).toBe("network");
    const programError = await new ApprovalController(config.approvals, noUi, new FabricSessionApprovals())
      .approve(action, { question: "ship?" }).then(() => undefined, (error: Error) => error.message);
    const directError = await direct.approve(callEvent("ask_user"), noUi)
      .then(() => undefined, (error: Error) => error.message);
    expect(directError).toBe("extensions.ask_user is denied by the Fabric network policy");
    expect(directError).toBe(programError);

    config.approvals.network = "allow";
    config.approvals.actions = { "extensions.ask_user": "deny" };
    await expect(direct.approve(callEvent("ask_user"), noUi)).rejects.toThrow("extensions.ask_user");
    await expect(new ApprovalController(config.approvals, noUi, new FabricSessionApprovals())
      .approve(await programAction(config, "ask_user"), {})).rejects.toThrow("extensions.ask_user");
  });
});

describe("FabricState.foregroundTools", () => {
  const project = (config: Record<string, unknown>): string => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-foreground-"));
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "fabric.json"), JSON.stringify(config));
    return cwd;
  };
  const stateFor = async (config: Record<string, unknown>) => {
    const pi = {
      getAllTools: () => registered,
      getActiveTools: () => [...active],
    } as unknown as ExtensionAPI;
    const state = new FabricState(pi, new CapturedToolCatalog());
    await state.bootstrap({
      cwd: project(config),
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => "session" },
      ui: { setStatus: vi.fn() },
    } as unknown as ExtensionContext);
    return state;
  };

  it("resolves from config and the pending active set", async () => {
    const state = await stateFor({ fullCodeMode: true, foreground: { tools: [entry("ask_user"), entry("idle")] } });
    expect(state.foregroundTools()).toEqual({ tools: ["ask_user"], refused: [{ name: "idle", reason: "inactive" }] });
    expect(state.foregroundTools(["fabric_exec", "ask_user", "idle"]).tools).toEqual(["ask_user", "idle"]);
  });

  it("is empty before bootstrap and in orchestration mode", async () => {
    expect(new FabricState({} as ExtensionAPI, new CapturedToolCatalog()).foregroundTools())
      .toEqual({ tools: [], refused: [] });
    const state = await stateFor({ fullCodeMode: false, foreground: { tools: [entry("ask_user")] } });
    expect(state.foregroundTools()).toEqual({ tools: [], refused: [] });
  });
});

describe("foreground extension wiring", () => {
  const boot = async (config: Record<string, unknown>) => {
    const { default: piFabric } = await import("../src/index.js");
    const { FABRIC_TOOL_PLACEMENT_EVENT } = await import("../src/protocol.js");
    const listeners = new Map<string, (value: unknown) => unknown>();
    const handlers = new Map<string, Array<(...args: never[]) => unknown>>();
    const pi = {
      events: {
        emit: vi.fn(),
        on: vi.fn((channel: string, handler: (value: unknown) => unknown) => {
          listeners.set(channel, handler);
          return () => listeners.delete(channel);
        }),
      },
      // No fabric_exec: the prompt-building before_agent_start handlers stay idle.
      getActiveTools: vi.fn(() => ["ask_user", "todo", "read"]),
      getAllTools: vi.fn(() => registered),
      on: vi.fn((event: string, handler: (...args: never[]) => unknown) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(),
      setActiveTools: vi.fn(),
    } as unknown as ExtensionAPI;
    await piFabric(pi);
    const fabricTool = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls
      .map(([tool]) => tool as ToolDefinition).find((tool) => tool.name === "fabric_exec")!;
    const hidden = () => {
      const tools = registered.map(({ name }) => ({ name }));
      return fabricTool.prepareLoadout!({ registered: tools, declared: tools, callable: tools } as never)?.hiddenDeclarations;
    };
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-foreground-wiring-"));
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "fabric.json"), JSON.stringify(config));
    let sessionId = "session-1";
    const notify = vi.fn();
    const context = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => sessionId },
      ui: { setStatus: vi.fn(), notify },
    } as unknown as ExtensionContext;
    const run = async (event: string, payload: unknown) => {
      const results: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) {
        results.push(await (handler as (event: unknown, context: ExtensionContext) => unknown)(payload, context));
      }
      return results;
    };
    await run("resources_discover", { type: "resources_discover" });
    const placement = (tools: string[]) => {
      let result: unknown;
      listeners.get(FABRIC_TOOL_PLACEMENT_EVENT)!({ tools, reply: (value: unknown) => { result = value; } });
      return result;
    };
    const declared = async () => {
      const [projected] = (await run("context_with_system", {
        type: "context_with_system",
        messages: [{ role: "system", content: "s", timestamp: 1 }],
      })).filter(Boolean) as Array<{ messages: Array<{ toolsAdded?: Array<{ name: string }> }> }>;
      return projected!.messages[0]!.toolsAdded!.map((tool) => tool.name);
    };
    return {
      run, notify, placement, declared, hidden,
      setSession: (id: string) => { sessionId = id; },
      shutdown: () => run("session_shutdown", {}),
    };
  };
  const agentStart = { type: "before_agent_start", prompt: "hi", systemPrompt: "s", systemPromptOptions: {} };

  it("applies the approval policy to direct native tools before Fabric's lazy runtime activates (#216)", async () => {
    const host = await boot({ fullCodeMode: false, approvals: { execute: "deny" } });
    const call = (toolName: string) => host.run("tool_call", { type: "tool_call", toolCallId: `call-${toolName}`, toolName, input: {} });
    // No fabric_exec has run, so the runtime is still inactive: the policy must hold anyway.
    await expect(call("bash")).rejects.toThrow("pi.bash is denied by the Fabric execute policy");
    await host.shutdown();
    const allowed = await boot({ fullCodeMode: false });
    await expect(allowed.run("tool_call", { type: "tool_call", toolCallId: "call-bash", toolName: "bash", input: {} }))
      .resolves.toSatisfy((results: unknown[]) => results.every((result) => result === undefined));
    await allowed.shutdown();
  });

  it("declares foreground tools to the model and reports placement", async () => {
    const host = await boot({ fullCodeMode: true, foreground: { tools: [entry("ask_user")] } });
    expect(await host.declared()).toEqual(["fabric_exec", "ask_user"]);
    expect(host.hidden()).toEqual(registered.map(({ name }) => name).filter((name) => !["fabric_exec", "ask_user"].includes(name)));
    expect(host.placement(["ask_user", "todo"])).toMatchObject({
      mode: "full-code",
      tools: { ask_user: "model", todo: "unavailable" },
    });
    await host.run("before_agent_start", agentStart);
    expect(host.notify).not.toHaveBeenCalled();
    await host.shutdown();
  });

  it("refuses the whole policy under Schema enforce with one notice per session", async () => {
    const host = await boot({ schema: { mode: "enforce" }, foreground: { tools: [entry("ask_user")] } });
    expect(await host.declared()).toEqual(["fabric_exec"]);
    expect(host.hidden()).toContain("ask_user");
    expect(host.placement(["ask_user"])).toMatchObject({ mode: "enforce", tools: { ask_user: "unavailable" } });
    await host.run("before_agent_start", agentStart);
    await host.run("before_agent_start", agentStart);
    expect(host.notify).toHaveBeenCalledOnce();
    expect(host.notify).toHaveBeenCalledWith(
      "Fabric foreground policy refused ask_user (enforce); declared fabric_exec only", "warning");
    host.setSession("session-2");
    await host.run("before_agent_start", agentStart);
    expect(host.notify).toHaveBeenCalledTimes(2);
    await host.shutdown();
  });
});
