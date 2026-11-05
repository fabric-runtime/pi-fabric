import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { FabricManagedHost, type FabricManagedHostOptions } from "../src/managed-host.js";
import { FABRIC_MANAGED_HOST_VERSION } from "../src/index.js";
import { resolveForegroundTools } from "../src/core/foreground-tools.js";
import { buildSkillReferenceGuidance } from "../src/core/skill-references.js";
import { FABRIC_TOOL_PLACEMENT_EVENT } from "../src/protocol.js";

beforeEach(() => {
  vi.stubEnv("PI_FABRIC_TOOL_ALLOWLIST", undefined);
  vi.stubEnv("PI_FABRIC_FULL_CODE_MODE", undefined);
});
afterEach(() => vi.unstubAllEnvs());

const boot = async (options: FabricManagedHostOptions) => {
  const handlers = new Map<string, Array<(event: any, context: ExtensionContext) => any>>();
  const listeners = new Map<string, (event: any) => any>();
  const definitions: ToolDefinition[] = [];
  const active = ["fabric_exec", "ask_user", "todo", "read"];
  const registered = active.map(name => ({ name, description: name, parameters: { type: "object", properties: {} },
    exposure: name === "ask_user" ? "model-only" : "direct", sourceInfo: { source: name === "read" ? "builtin" : "local" } }));
  const pi = {
    events: { emit: vi.fn(), on: (name: string, handler: (event: any) => any) => { listeners.set(name, handler); return () => listeners.delete(name); } },
    getActiveTools: () => active, getAllTools: () => registered,
    on: (name: string, handler: (event: any, context: ExtensionContext) => any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: ToolDefinition) => definitions.push(tool), registerCommand: vi.fn(), registerMessageRenderer: vi.fn(), setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
  const { default: fabric } = await import("../src/index.js");
  await fabric(pi, { managedHost: options });
  const getContextUsage = vi.fn(() => undefined);
  const context = { cwd: "/managed-host-no-files", hasUI: false, getContextUsage, sessionManager: { getSessionId: () => "managed-session", getLeafId: () => null, getBranch: () => [] }, ui: { setStatus: vi.fn() },
    isProjectTrusted: () => { throw new Error("ambient trust must not be read"); } } as unknown as ExtensionContext;
  const run = async (name: string, event: any) => {
    const results = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, context));
    return results;
  };
  const discovery = await run("resources_discover", {});
  const placement = () => { let result: any; listeners.get(FABRIC_TOOL_PLACEMENT_EVENT)!({ tools: active, reply: (value: any) => { result = value; } }); return result; };
  return { run, discovery, placement, active, getContextUsage, tool: definitions.at(-1)!,
    execute: (args: { code: string; maxOutputTokens?: number } = { code: "return 7;" }) => definitions.at(-1)!.execute("managed-probe", args, undefined, undefined, { ...context, tools: [], executeTool: vi.fn() } as never),
  };
};

describe("managed host v2", () => {
  it("versions the options, disables Jev and preserves compaction defaults", () => {
    expect(FABRIC_MANAGED_HOST_VERSION).toBe(2);
    const config = new FabricManagedHost({ providers: [] }).config();
    expect(config.jev.enabled).toBe(false);
    expect(config.executor.maxCpuSliceMs).toBe(1000);
    expect(config.compaction.engine).toBe("fabric");
    const host = new FabricManagedHost({ providers: [], compaction: "pi", executor: { maxCpuSliceMs: 250 } });
    expect(host.config().compaction.engine).toBe("pi");
    expect(host.config().executor.maxCpuSliceMs).toBe(250);
  });

  it("snapshots host options and rejects invalid readers, limits and foreground policy", () => {
    const options = { providers: ["mcp"], foreground: ["ask_user"], executor: { maxCpuSliceMs: 1000 } };
    const host = new FabricManagedHost(options);
    options.providers.push("memory"); options.foreground.push("todo"); options.executor.maxCpuSliceMs = 0;
    expect(host.options.providers).toEqual(["mcp"]);
    expect(host.config().foreground.tools.map(tool => tool.name)).toEqual(["ask_user"]);
    expect(host.config().executor.maxCpuSliceMs).toBe(1000);
    for (const value of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) expect(() => new FabricManagedHost({ providers: [], executor: { maxCpuSliceMs: value } })).toThrow(/maxCpuSliceMs/);
    expect(() => new FabricManagedHost({ providers: [], skillReader: "read();" })).toThrow(/skillReader/);
    expect(() => new FabricManagedHost({ providers: [], foreground: ["fabric_exec"] })).toThrow(/foreground/);
    expect(() => new FabricManagedHost({ providers: [], foreground: Array.from({ length: 9 }, (_, i) => `t${i}`) })).toThrow(/at most 8/);
  });

  it("retains inactive, allowlist, core, hidden and enforce refusals for host foreground tools", () => {
    const registered = ["ask", "idle", "hidden", "read"].map(name => ({ name, exposure: name === "hidden" ? "hidden" : "model-only" }));
    const input = { policy: { tools: [], maxTools: 4 }, mode: "full-code" as const, managedHost: true,
      managedForeground: ["ask", "idle", "hidden", "read"], registered, active: new Set(["ask", "hidden", "read"]) };
    expect(resolveForegroundTools(input)).toEqual({ tools: ["ask"], refused: [{ name: "idle", reason: "inactive" }, { name: "hidden", reason: "unknown" }, { name: "read", reason: "core" }] });
    expect(resolveForegroundTools({ ...input, allowlist: new Set() }).tools).toEqual([]);
    expect(resolveForegroundTools({ ...input, mode: "enforce" }).refused.every(item => item.reason === "enforce")).toBe(true);
  });

  it("declares explicit model-only tools and reports the same managed placement", async () => {
    const host = await boot({ providers: [], foreground: ["ask_user"] });
    try {
      expect(host.tool.prepareLoadout!({ registered: host.active.map(name => ({ name })), declared: host.active.map(name => ({ name })), callable: [] } as never)?.hiddenDeclarations).not.toContain("ask_user");
      expect(host.placement().tools.ask_user).toBe("model");
      expect(host.placement().tools.todo).not.toBe("model");
      const results = await host.run("context_with_system", { messages: [{ role: "system", content: "base", timestamp: 1 }] });
      const projection = results.find(result => result?.messages);
      expect(projection.messages[0].toolsAdded.map((tool: any) => tool.name)).toEqual(["fabric_exec", "ask_user"]);
    } finally { await host.run("session_shutdown", {}); }
  });

  it("uses only host namespaces in metadata and stable guidance, including after bootstrap", async () => {
    const host = await boot({ providers: ["mcp"], guidance: "Host-specific receipt reconciliation.", skillReader: "mcp.files.read" });
    try {
      expect(host.discovery).toContainEqual({ skillPaths: [] });
      const metadata = [host.tool.description, host.tool.promptSnippet, ...host.tool.promptGuidelines!, (host.tool.parameters as { properties: { code: { description: string } } }).properties.code.description].join("\n");
      expect(metadata).toContain("mcp");
      expect(metadata).not.toMatch(/pi\.bash|pi\.read|agents\.spawn|memory\.expand/);
      const event = { prompt: "hello", systemPrompt: "base", systemPromptOptions: { skills: [{ name: "host", description: "host skill", filePath: "/host/SKILL.md", disableModelInvocation: false }] } };
      const results = await host.run("before_agent_start", event);
      const prompt = results.find(result => result?.systemPrompt)?.systemPrompt;
      expect(prompt).toContain("Managed provider namespaces: mcp");
      expect(prompt).toContain("Host-specific receipt reconciliation.");
      expect(prompt).toContain("mcp.files.read");
      expect(prompt).not.toMatch(/pi\.read|pi\.bash|agents\.spawn|memory\.expand/);
      expect((await host.run("before_agent_start", event)).find(result => result?.systemPrompt)?.systemPrompt).toBe(prompt);
    } finally { await host.run("session_shutdown", {}); }
  });

  it.each(["fabric", "pi"] as const)("settles an activated managed runtime without native controllers (%s compaction)", async compaction => {
    const host = await boot({ providers: [], compaction });
    try {
      expect((await host.execute()).content).toContainEqual({ type: "text", text: "7" });
      await expect(host.run("agent_settled", {})).resolves.toBeDefined();
      expect(host.getContextUsage).toHaveBeenCalledTimes(compaction === "fabric" ? 1 : 0);
      if (compaction === "pi") {
        expect((await host.run("session_before_compact", {})).every(result => result === undefined)).toBe(true);
        expect((await host.run("session_before_tree", {})).every(result => result === undefined)).toBe(true);
      }
    } finally { await host.run("session_shutdown", {}); }
  });

  it("applies the host output ceiling end to end and lets per-call budgets lower it only", async () => {
    const host = await boot({ providers: [], compaction: "pi", executor: { maxOutputChars: 70_000 } });
    const artifacts: string[] = [];
    const output = async (args: { code: string; maxOutputTokens?: number }) => {
      const result = await host.execute(args);
      const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      const artifact = /Full output \(\d+ chars\) saved to: ([^\n]+)/.exec(text)?.[1];
      if (artifact) artifacts.push(artifact);
      expect(result.isError).not.toBe(true);
      return text;
    };
    try {
      expect(await output({ code: 'return "x ".repeat(30_000);' })).toBe("x ".repeat(30_000));
      expect((await output({ code: 'return "y ".repeat(30_000);', maxOutputTokens: 250 })).length).toBeLessThanOrEqual(1000);
      expect((await output({ code: 'return "z ".repeat(40_000);', maxOutputTokens: 100_000 })).length).toBeLessThanOrEqual(70_000);
      expect(artifacts).toHaveLength(2);
    } finally {
      await host.run("session_shutdown", {});
      for (const artifact of artifacts) fs.rmSync(path.dirname(artifact), { recursive: true, force: true });
    }
  }, 30_000);

  it("leaves skill loading to the host unless a reader is supplied", () => {
    const prompt = '<skill name="wrapper" location="/wrapper/SKILL.md">\n\nRun /reader\n</skill>';
    const skills = [{ name: "wrapper", filePath: "/wrapper/SKILL.md" }, { name: "reader", filePath: "/reader/SKILL.md" }];
    expect(buildSkillReferenceGuidance(prompt, skills, null)).toBeUndefined();
    expect(buildSkillReferenceGuidance(prompt, skills, "mcp.files.read")).toContain("through mcp.files.read");
  });
});
