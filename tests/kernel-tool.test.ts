import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { normalizeFabricConfig } from "../src/config.js";
import type { FabricState } from "../src/fabric-state.js";
import { createFabricExecTool } from "../src/fabric-exec-tool.js";
import { prepareFabricExecArguments } from "../src/fabric-exec-arguments.js";
import { defaultFabricExecutionGuidance, fabricExecutionKernelGuidance } from "../src/core/system-guidance.js";
import { defaultCodePreviewSettings } from "../src/ui/code-preview.js";

const toolFor = (kernel: "typescript" | "python", pythonRuntime: "cpython" | "monty" = "cpython") => {
  const state = {
    bootstrapped: true,
    config: normalizeFabricConfig({ executor: { kernel, pythonRuntime }, ui: { toolDisplay: "full" } }),
  } as FabricState;
  return createFabricExecTool(state, defaultCodePreviewSettings(), new Map(), (tool) => tool);
};

describe("exclusive kernel tool surface", () => {
  it("publishes only the configured language with no per-call selector", () => {
    const ts = toolFor("typescript");
    const python = toolFor("python");
    expect(ts.description).toContain("type-checked TypeScript");
    expect(ts.parameters.properties.code.description).toContain("TypeScript function body");
    expect(python.description).toContain("CPython");
    expect(python.description).not.toContain("TypeScript");
    expect(python.parameters.properties.code.description).toContain("Python async function body");
    expect(python.parameters.properties.code.description).not.toContain("TypeScript");
    expect(python.promptGuidelines?.join("\n")).toContain("asyncio.gather");
    expect(python.promptGuidelines?.join("\n")).not.toContain("Promise.all");
    expect(ts.parameters.properties).not.toHaveProperty("kernel");
    expect(python.parameters.properties).not.toHaveProperty("kernel");
    expect(python.parameters.properties).not.toHaveProperty("tokenBudget");
    expect(ts.parameters.properties).toHaveProperty("tokenBudget");
    expect(python.parameters.required).toEqual(["code"]);
  });

  it("describes Monty's subset without advertising native Python", () => {
    const tool = toolFor("python", "monty");
    expect(tool.description).toContain("Monty");
    expect(tool.parameters.properties.code.description).toContain("sandboxed Python subset");
    expect(tool.parameters.properties.code.description).not.toContain("standard-library imports are available");
    expect(defaultFabricExecutionGuidance(true, "python", "monty")).toContain("arbitrary imports are unavailable");
    expect(fabricExecutionKernelGuidance(true, "python", "monty")).toContain("Monty sandboxed subset");
  });

  it("keeps Python source untouched while applying language-neutral argument normalization", () => {
    const code = "return await pi.read(/tmp/unquoted)";
    const input = { code: [code], strings: '{"body":"π😀\\ntext"}', display: "Probe" };
    expect(prepareFabricExecArguments(input, "python")).toEqual({
      code, payloads: { body: "π😀\ntext" }, display: { name: "Probe" },
    });
    expect(toolFor("python").prepareArguments!(code)).toEqual({ code });
    expect(prepareFabricExecArguments(code)).toEqual({ code: 'return await pi.read("/tmp/unquoted")' });
  });

  it("renders a Python label rather than parsing Python as TypeScript", () => {
    const tool = toolFor("python");
    const args = { code: 'import json\nreturn json.loads(π.body)' };
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
    const rendered = tool.renderCall!(args, theme, {
      args, state: {}, invalidate: vi.fn(), toolCallId: "python", cwd: process.cwd(),
      executionStarted: false, argsComplete: true, isPartial: false, expanded: true,
      showImages: false, isError: false,
    } as never).render(120).join("\n");
    expect(rendered).toContain("Python · 2 lines");
    expect(rendered).not.toContain("TypeScript");
  });

  it("registers safely before configuration is bootstrapped", () => {
    const state = { bootstrapped: false, get config(): never { throw new Error("not bootstrapped"); } } as unknown as FabricState;
    const tool = createFabricExecTool(state, defaultCodePreviewSettings(), new Map(), (value) => value);
    expect(tool.description).toContain("TypeScript");
    expect(tool.prepareArguments!("return 1")).toEqual({ code: "return 1" });
  });

  it.each(["typescript", "python"] as const)("retains historical %s labels after a language switch", (kernel) => {
    const currentKernel = kernel === "python" ? "typescript" : "python";
    const tool = toolFor(currentKernel);
    const args = { code: "return 1" };
    const context = {
      args, state: {}, invalidate: vi.fn(), toolCallId: "history", cwd: process.cwd(),
      executionStarted: false, argsComplete: true, isPartial: false, expanded: true,
      showImages: false, isError: false,
    };
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
    tool.renderResult!(
      { content: [], details: { kernel, success: true, audits: [], phases: [] } } as never,
      { expanded: false, isPartial: false }, theme, context as never,
    );
    const rendered = tool.renderCall!(args, theme, context as never).render(120).join("\n");
    expect(rendered).toContain(kernel === "python" ? "Python · 1 line" : "TypeScript · 1 line");
    expect(context.invalidate).toHaveBeenCalledOnce();
  });

  it("says a shell timeout bounds the process, not the hang hand-off", () => {
    expect(defaultFabricExecutionGuidance(true, "typescript")).toContain("shell `timeout` bounds the process, not this wait");
    expect(defaultFabricExecutionGuidance(true, "python")).toContain("shell timeout bounds the process, not this wait");
  });

  it("advertises native models without replacing legacy model listing", () => {
    const guidance = defaultFabricExecutionGuidance(true, "typescript");
    expect(guidance).toContain("models === tools.models");
    expect(guidance).toContain("tools.models()");
    expect(guidance).toContain("models.getAvailableOfType('classifier')");
    expect(guidance).toContain("models.classify(model,{state,questions})");
    expect(guidance).toContain("stopReason");
    expect(defaultFabricExecutionGuidance(true, "python")).not.toContain("models === tools.models");
  });

  it("describes the native profile without shadowing Fabric discovery", () => {
    const guidance = defaultFabricExecutionGuidance(true, "typescript", "monty", "native");
    expect(guidance).toContain("Native Pi codemode profile");
    expect(guidance).toContain("fabric.tools.call");
    expect(guidance).toContain("models === fabric.tools.models");
    expect(fabricExecutionKernelGuidance(true, "typescript", "monty", "native")).toContain("Write JavaScript");
    expect(defaultFabricExecutionGuidance(true, "python", "monty", "native")).not.toContain("Native Pi codemode profile");
  });

  it("uses Python syntax in turn-stable guidance", () => {
    const guidance = defaultFabricExecutionGuidance(true, "python");
    expect(guidance).toContain('r["output"]');
    expect(guidance).toContain("settle=True");
    expect(guidance).not.toContain("Promise.all");
    expect(fabricExecutionKernelGuidance(true, "python")).toContain("Python (Monty sandboxed subset)");
    expect(fabricExecutionKernelGuidance(true, "python", "cpython")).toContain("Python (CPython)");
    expect(fabricExecutionKernelGuidance(true)).toContain("kernel: TypeScript");
    expect(defaultFabricExecutionGuidance(false, "python")).toContain("unavailable inside fabric_exec");
  });
});
