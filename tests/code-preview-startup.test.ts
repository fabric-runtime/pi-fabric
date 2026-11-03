import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultCodePreviewSettings } from "../src/ui/code-preview.js";
import { withCodePreviewShell } from "../src/ui/code-preview-shell.js";

describe("code preview startup", () => {
  it.each(["on", "border", "off"] as const)("hides zero shell timers while retaining refresh and nonzero labels (%s)", mode => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    try {
      const tool = {
        name: "sample", label: "Sample",
        renderCall: () => ({ render: () => ["call"], invalidate() {} }),
        renderResult: () => ({ render: () => ["result"], invalidate() {} }),
      } as any;
      const decorated = withCodePreviewShell(tool, { mode, toolCallTiming: true });
      const context = { state: {}, executionStarted: true, isPartial: true, isError: false, invalidate: vi.fn() } as any;
      const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
      const render = (partial: boolean) => {
        context.isPartial = partial;
        const call = decorated.renderCall({}, theme, context);
        const result = decorated.renderResult({ content: [] }, { expanded: false, isPartial: partial }, theme, context);
        return [...call.render(80), ...result.render(80)].join("\n");
      };
      expect(render(true)).not.toMatch(/Elapsed|Took|0ms/);
      expect(render(false)).not.toMatch(/Elapsed|Took|0ms/);
      expect(vi.getTimerCount()).toBe(0);
      context.state = {};
      render(true);
      vi.advanceTimersByTime(100);
      expect(context.invalidate).toHaveBeenCalled();
      expect(render(true)).toContain("Elapsed 100ms");
      expect(render(false)).toContain("Took 100ms");
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("connects the background shortcut to output/timing arcs and removes it on completion", () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    try {
      const theme = {fg: (_: string, text: string) => text} as any;
      const tool = withCodePreviewShell({name:"fabric_exec",label:"Fabric",renderResult:()=>({render:()=>["output", "╰─ details"]})} as any,
        {mode:"off",backgroundShortcut:true,toolCallTiming:true});
      const context = {args:{},state:{},executionStarted:true,isPartial:true,invalidate:vi.fn()} as any;
      const render = () => tool.renderResult!({content:[]} as any,{expanded:false,isPartial:context.isPartial},theme,context).render(100);
      expect(render()).toEqual(["output","├─ details","╰─ (ctrl+b to run in background)"]);
      vi.advanceTimersByTime(10700);
      expect(render()).toEqual(["output","├─ details","├─ (ctrl+b to run in background)","╰─ Elapsed 10.7s"]);
      context.isPartial=false;
      expect(render()).toEqual(["output","├─ details","╰─ Took 10.7s"]);
      context.isPartial=true;context.args={background:true};
      expect(render().join("\n")).not.toContain("ctrl+b");
      context.isPartial=false;render();
    } finally {vi.useRealTimers();}
  });

  it("keeps pi-code-previews out of the package and runtime graph", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const indexSource = fs.readFileSync(path.join(process.cwd(), "src", "extension.ts"), "utf8");
    const toolSource = fs.readFileSync(
      path.join(process.cwd(), "src", "fabric-exec-tool.ts"),
      "utf8",
    );
    expect(packageJson.dependencies).not.toHaveProperty("pi-code-previews");
    expect(indexSource).not.toMatch(/^import .* from ["']pi-code-previews["'];/m);
    expect(toolSource).not.toContain('from "pi-code-previews"');
    expect(indexSource).not.toContain("pi-code-previews");
  });

  it("uses environment-backed defaults without loading the preview package", () => {
    const previous = process.env.CODE_PREVIEW_TOOL_CALL_BACKGROUND;
    process.env.CODE_PREVIEW_TOOL_CALL_BACKGROUND = "off";
    try {
      expect(defaultCodePreviewSettings().toolCallBackground).toBe("off");
    } finally {
      if (previous === undefined) delete process.env.CODE_PREVIEW_TOOL_CALL_BACKGROUND;
      else process.env.CODE_PREVIEW_TOOL_CALL_BACKGROUND = previous;
    }
  });

  it("renders call and result inside a local border shell", () => {
    const tool = {
      name: "sample",
      label: "Sample",
      renderCall: () => ({ render: () => ["call"] }),
      renderResult: () => ({ render: () => ["result"] }),
    } as any;
    const decorated = withCodePreviewShell(tool, {
      mode: "border",
      toolCallTiming: false,
    });
    const state = {};
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as any;
    const context = {
      state,
      executionStarted: true,
      isPartial: true,
      isError: false,
      invalidate() {},
    } as any;
    const shell = decorated.renderCall({}, theme, context);
    decorated.renderResult(
      { content: [] },
      { expanded: false, isPartial: true },
      theme,
      context,
    );
    const rows = shell.render(20);
    expect(decorated.renderShell).toBe("self");
    expect(rows[0]).toBe("╭──────────────────╮");
    expect(rows.some((row: string) => row.includes("call"))).toBe(true);
    expect(rows.some((row: string) => row.includes("result"))).toBe(true);
    expect(rows.at(-1)).toBe("╰──────────────────╯");
  });

  it("preserves shell mode and timing preferences", () => {
    const tool = {
      name: "sample",
      label: "Sample",
      renderCall: () => ({ render: () => ["call"], invalidate() {} }),
      renderResult: () => ({ render: () => ["result"], invalidate() {} }),
    } as any;
    const decorated = withCodePreviewShell(tool, {
      mode: "off",
      toolCallTiming: false,
    });
    expect(decorated.renderShell).toBe("self");
    const context = {
      state: {},
      executionStarted: true,
      isPartial: false,
    } as any;
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
    decorated.renderCall({}, theme, context);
    const result = decorated.renderResult(
      { content: [] },
      { expanded: false, isPartial: false },
      theme,
      context,
    );
    expect(result.render(80)).toEqual(["result"]);
  });
});
