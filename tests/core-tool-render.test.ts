import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CodePreviewSettings } from "../src/ui/code-preview.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureHighlighting,
  highlightCode,
  highlightFileLines,
  initHighlighting,
} from "../src/ui/highlight.js";
import {
  coreToolPreviewEnabled,
  coreToolRendererEnabled,
  coreToolTitle,
  loadWordEmphasis,
  renderCoreToolBody,
  type CoreToolRenderOptions,
} from "../src/ui/core-tool-render.js";
import {
  inheritComponentBackground,
  renderBoundedLines,
  type FabricRenderAudit,
} from "../src/ui/fabric-render.js";

const settings: CodePreviewSettings = {
  shikiTheme: "dark-plus",
  diffIntensity: "subtle",
  wordEmphasis: "all",
  toolCallBackground: "on",
  toolCallTiming: true,
  readCollapsedLines: 10,
  readContentPreview: true,
  writeContentPreview: true,
  writeCollapsedLines: 10,
  editDiffPreview: true,
  editCollapsedLines: 160,
  grepCollapsedLines: 15,
  grepResultPreview: true,
  findResultPreview: true,
  lsResultPreview: true,
  pathListCollapsedLines: 20,
  readLineNumbers: true,
  bashResultPreview: true,
  bashWarnings: true,
  syntaxHighlighting: true,
  secretWarnings: true,
  pathIcons: "unicode",
  tools: ["bash", "read", "write", "edit", "grep", "find", "ls"],
};

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  getFgAnsi: (color: string) =>
    color === "toolDiffAdded" ? "\x1b[38;2;80;200;120m" : "\x1b[38;2;220;90;100m",
  getBgAnsi: () => "\x1b[48;2;0;0;0m",
} as unknown as Theme;

const options = (
  overrides: Partial<CoreToolRenderOptions> = {},
): CoreToolRenderOptions => ({
  cwd: process.cwd(),
  settings,
  expanded: false,
  maxLines: 200,
  ...overrides,
});

const audit = (
  tool: string,
  values: Omit<FabricRenderAudit, "ref" | "provider" | "tool">,
): FabricRenderAudit => ({ ref: `pi.${tool}`, provider: "pi", tool, ...values });

const wordChangeWrite = (): FabricRenderAudit => audit("write", {
  args: {
    path: "src/example.ts",
    content: `const value = "${"new".repeat(40)}";`,
  },
  preview: {
    details: {
      codePreviewBeforeWrite: {
        kind: "content",
        content: `const value = "${"old".repeat(40)}";`,
      },
    },
    writeBeforeCaptured: true,
  },
  success: true,
});

describe("Fabric core tool parity rendering", () => {
  // Load the word matcher before any render starts the highlighter.
  beforeAll(() => loadWordEmphasis());

  it("repaints a diff with word emphasis once the matcher loads", async () => {
    vi.resetModules();
    const fresh = await import("../src/ui/core-tool-render.js");
    const invalidate = vi.fn();
    const quiet = options({ invalidate, settings: { ...settings, syntaxHighlighting: false } });

    const first = fresh.renderCoreToolBody(wordChangeWrite(), theme, quiet)!.lines.join("\n");
    expect(first).toContain("Write applied");
    expect(first).not.toContain("\x1b[48;2;148;62;70m");

    await fresh.loadWordEmphasis();
    expect(invalidate).toHaveBeenCalledOnce();
    const repainted = fresh.renderCoreToolBody(wordChangeWrite(), theme, quiet)!.lines.join("\n");
    expect(repainted).toContain("\x1b[48;2;148;62;70m");
    expect(repainted).toContain("\x1b[48;2;64;132;82m");
  });

  it.each([false, true])("renders oversized read-line warnings as metadata (expanded=%s)", (expanded) => {
    const notice = "[Line 1 is 54.3KB, exceeds 50.0KB limit. Use bash: sed -n '1p' /tmp/queue.json | head -c 51200]";
    const metadataTheme = {
      ...theme,
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    } as unknown as Theme;
    const rendered = renderCoreToolBody(
      audit("read", {
        args: { path: "/tmp/queue.json", offset: 1, limit: 130 },
        result: { content: [{ type: "text", text: notice }], details: { truncation: { truncated: true } } },
        success: true,
      }),
      metadataTheme,
      options({ expanded }),
    );
    expect(rendered!.lines).toHaveLength(1);
    expect(rendered!.lines[0]).toBe(`<muted>╰─ ${notice.slice(1, -1)}</muted>`);
    expect(rendered!.lines[0]).not.toContain("1 │");
    expect(rendered!.lines[0]).not.toContain("\x1b[");
    expect(rendered!.lines[0]).not.toContain("Empty file");
  });

  it("does not mistake literal file text for an oversized-read diagnostic", () => {
    const notice = "[Line 1 is 54.3KB, exceeds 50.0KB limit. Use bash: sed -n '1p' /tmp/queue.json | head -c 51200]";
    const rendered = renderCoreToolBody(
      audit("read", { args: { path: "/tmp/notes.txt" }, result: notice, success: true }),
      theme,
      options({ settings: { ...settings, syntaxHighlighting: false } }),
    );
    expect(rendered!.lines[0]).toContain("1 │");
    expect(rendered!.lines[0]).toContain(notice);
  });

  it("renders offset-aware read gutters and secret warnings", () => {
    const rendered = renderCoreToolBody(
      audit("read", {
        args: { path: "src/example.ts", offset: 20 },
        result: "const value = 1;\nOPENAI_API_KEY=abcdefghijklmnop",
        success: true,
      }),
      theme,
      options(),
    );

    expect(rendered).not.toBeNull();
    expect(rendered!.lines[0]).toContain("possible API key");
    expect(rendered!.lines.join("\n")).toContain("20 │");
    expect(rendered!.lines.join("\n")).toContain("21 │");
  });

  it.each([
    {
      tool: "read",
      args: { path: "src/transcript.ts" },
      output: "export const transcriptBody = true;",
      expected: "transcriptBody",
    },
    {
      tool: "grep",
      args: { pattern: "transcriptBody", path: "src", literal: true },
      output: "src/transcript.ts:1: export const transcriptBody = true;",
      expected: "transcriptBody",
    },
    {
      tool: "find",
      args: { pattern: "*.ts", path: "src" },
      output: "src/transcript.ts",
      expected: "transcript.ts",
    },
    {
      tool: "ls",
      args: { path: "src" },
      output: "transcript.ts",
      expected: "transcript.ts",
    },
    {
      tool: "bash",
      args: { command: "printf transcript-body" },
      output: "transcript-body",
      expected: "transcript-body",
    },
  ])("renders $tool transcript content blocks through the regular core UI", ({
    tool,
    args,
    output,
    expected,
  }) => {
    const rendered = renderCoreToolBody(
      audit(tool, {
        args,
        result: {
          content: [
            { type: "text", text: output },
            { type: "image", data: "ignored" },
          ],
          details: {},
        },
        success: true,
      }),
      theme,
      options({ expanded: true }),
    );

    expect(rendered).not.toBeNull();
    expect(rendered!.lines.join("\n")).toContain(expected);
    expect(rendered!.lines.join("\n")).not.toContain("No matches found");
  });

  it("joins multiple transcript text blocks in their original order", () => {
    const rendered = renderCoreToolBody(
      audit("read", {
        args: { path: "src/blocks.ts" },
        result: {
          content: [
            { type: "text", text: "const firstBlock = 1;" },
            { type: "text", text: "const secondBlock = 2;" },
          ],
        },
        success: true,
      }),
      theme,
      options({ expanded: true }),
    );

    const text = rendered!.lines.join("\n");
    expect(text.indexOf("firstBlock")).toBeLessThan(text.indexOf("secondBlock"));
  });

  it("renders write result diffs with summaries, gutters, word emphasis, and full-row backgrounds", () => {
    const rendered = renderCoreToolBody(
      audit("write", {
        args: {
          path: "src/example.ts",
          content: `const value = "${"new".repeat(40)}";`,
        },
        preview: {
          details: {
            codePreviewBeforeWrite: {
              kind: "content",
              content: `const value = "${"old".repeat(40)}";`,
            },
          },
          writeBeforeCaptured: true,
        },
        success: true,
      }),
      theme,
      options(),
    );

    expect(rendered).not.toBeNull();
    expect(rendered!.lines[0]).toContain("Write applied");
    expect(rendered!.lines.join("\n")).toContain("replacement");
    expect(rendered!.lines.join("\n")).toContain("│");
    expect(rendered!.lines.join("\n")).toContain("\x1b[48;2;148;62;70m");
    expect(rendered!.lines.join("\n")).toContain("\x1b[48;2;64;132;82m");

    const component = renderBoundedLines(rendered!.lines, theme, settings.diffIntensity);
    const rows = component.render(32);
    expect(inheritComponentBackground(component).render(32)).toEqual(rows);
    const changedRows = rows.filter((line) => line.includes("\x1b[48;2;"));
    expect(changedRows).toHaveLength(6);
    expect(changedRows.every((line) => visibleWidth(line) === 32)).toBe(true);
    const plainRows = changedRows.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
    expect(plainRows.filter((line) => line.startsWith("     ")).length).toBe(4);
  });

  it.each([
    "[Showing last 50.0KB of line 1 (line is 60.0KB). Full output: /tmp/pi-bash.log]",
    "[Showing lines 51-100 of 100. Full output: /tmp/pi-bash.log]",
    "[Showing lines 5-6 of 6 (50.0KB limit). Full output: /tmp/pi-bash.log]",
  ])("renders bash truncation notices in write diffs as muted metadata", (notice) => {
    const noticeTheme = {
      ...theme,
      fg: (color: string, text: string) =>
        color === "muted" ? `<muted>${text}</muted>` : text,
    } as unknown as Theme;
    const rendered = renderCoreToolBody(
      audit("write", {
        args: { path: "result.json", content: `{"ok":true}\n\n${notice}` },
        preview: {
          details: { codePreviewBeforeWrite: { kind: "content", content: "" } },
          writeBeforeCaptured: true,
        },
        success: true,
      }),
      noticeTheme,
      options(),
    );

    const noticeLine = rendered!.lines.find((line) => line.includes("[Showing"));
    expect(noticeLine).toContain(`<muted>${notice}</muted>`);
  });

  it("groups grep matches by file, distinguishes context, and emphasizes literal matches", () => {
    const rendered = renderCoreToolBody(
      audit("grep", {
        args: { pattern: "value", path: "src", literal: true },
        result: [
          "src/a.ts:3: const value = 1;",
          "src/a.ts-4- return value;",
          "src/b.ts:9: const value = 2;",
        ].join("\n"),
        success: true,
      }),
      theme,
      options(),
    );

    const text = rendered!.lines.join("\n");
    expect(text.match(/src\/a\.ts/g)).toHaveLength(1);
    expect(text.match(/src\/b\.ts/g)).toHaveLength(1);
    expect(text).toContain("│");
    expect(text).toContain("┆");
    expect(text).toContain("\x1b[48;2;90;74;28m");
  });

  it.each([
    ["find", "src/a.ts\nsrc/lib/b.ts"],
    ["ls", "src/\nREADME.md"],
  ])("renders %s output as an iconized path tree", (tool, result) => {
    const rendered = renderCoreToolBody(
      audit(tool, { args: { path: ".", pattern: "*.ts" }, result, success: true }),
      theme,
      options(),
    );

    expect(rendered!.lines.join("\n")).toMatch(/[▸•]/);
    expect(rendered!.lines.join("\n")).toContain("src/");
  });

  it("lets Pi's no-output sentinel inherit the enclosing tool background", () => {
    const rendered = renderCoreToolBody(
      audit("bash", {
        args: { command: "git status --short" },
        result: { ok: true, output: "(no output)", details: {} },
        success: true,
      }),
      theme,
      options(),
    );

    expect(rendered!.lines).toEqual(["(no output)"]);
  });

  it("leaves nested bash output background ownership to the enclosing tool", () => {
    const rendered = renderCoreToolBody(
      audit("bash", {
        args: { command: "printf output" },
        result: { ok: true, output: "output", details: {} },
        success: true,
      }),
      theme,
      options(),
    );

    expect(rendered!.lines.join("\n")).not.toContain("\x1b[48;2;0;0;0m");
  });

  it("renders bash warnings, timeout metadata, output limits, and full output details", () => {
    const call = audit("bash", {
      args: { command: "sudo rm -rf build", timeout: 30 },
      preview: { bashCommand: "sudo rm -rf build\necho complete" },
      result: {
        ok: true,
        output: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"),
        details: { fullOutputPath: "/tmp/bash.log", truncation: { truncated: true } },
      },
      success: true,
      startedAt: 1_000,
      endedAt: 2_250,
    });
    const title = coreToolTitle(call, theme, {
      cwd: process.cwd(),
      settings,
    });
    const rendered = renderCoreToolBody(call, theme, options());

    expect(title).toContain("timeout 30s");
    expect(title).toContain("1.3s");
    expect(title).toContain("recursive delete");
    expect(title).toContain("elevated privileges");
    expect(rendered!.hidden).toBe(5);
    expect(rendered!.lines.join("\n")).toContain("echo complete");
    expect(rendered!.lines.join("\n")).toContain("Output truncated by bash");
    expect(rendered!.lines.join("\n")).toContain("Full output: /tmp/bash.log");
    expect(rendered!.lines).toContain("├─ Output truncated by bash");
    expect(rendered!.lines).toContain("╰─ Full output: /tmp/bash.log");
  });

  it("keeps bash command rows aligned when the command embeds raw carriage returns", async () => {
    const command = [
      "sleep 15",
      "pid=$(adb shell pidof com.example.app | tr -d '\r')",
      "echo faults",
      "adb logcat -d | grep -E 'playback|drops'",
      "echo faults",
    ].join("\n");
    const call = audit("bash", {
      args: { command: "ignored" },
      preview: { bashCommand: command },
      result: { ok: true, output: "", details: {} },
      success: true,
    });
    const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
    const expected = [
      "  pid=$(adb shell pidof com.example.app | tr -d '␍')",
      "  echo faults",
      "  adb logcat -d | grep -E 'playback|drops'",
      "  echo faults",
      "No output",
    ];

    const plain = renderCoreToolBody(call, theme, options());
    expect(plain).not.toBeNull();
    expect(plain!.lines.map(strip)).toEqual(expected);

    configureHighlighting("dark-plus", true);
    const invalidate = vi.fn();
    await vi.waitFor(
      () => expect(highlightCode("echo ready", "bash", invalidate)).not.toBeNull(),
      { timeout: 15_000 },
    );
    const highlighted = renderCoreToolBody(call, theme, options());
    expect(highlighted!.lines.map(strip)).toEqual(expected);
    expect(
      highlighted!.lines.slice(0, 4).every((row) => row.includes("\x1b[38;2;")),
    ).toBe(true);
  }, 20_000);

  it("honors collapsed preview visibility while allowing expanded output", () => {
    const read = audit("read", { args: { path: "a.txt" }, result: "hidden", success: true });
    const hiddenSettings = { ...settings, readContentPreview: false };
    expect(coreToolPreviewEnabled(read, hiddenSettings)).toBe(false);
    expect(renderCoreToolBody(read, theme, options({ settings: hiddenSettings }))).toBeNull();
    expect(
      renderCoreToolBody(
        read,
        theme,
        options({ settings: hiddenSettings, expanded: true }),
      )?.lines.join("\n"),
    ).toContain("hidden");
  });

  it("falls back when a tool is excluded from the configured renderer list", () => {
    const read = audit("read", { args: { path: "a.txt" }, result: "generic", success: true });
    const disabled = { ...settings, tools: settings.tools.filter((tool) => tool !== "read") };
    expect(coreToolRendererEnabled(read, disabled)).toBe(false);
    expect(coreToolPreviewEnabled(read, disabled)).toBe(true);
    expect(renderCoreToolBody(read, theme, options({ settings: disabled }))).toBeNull();
    expect(coreToolTitle(read, theme, { cwd: process.cwd(), settings: disabled })).toBeNull();
  });

  it("renders standard unnumbered edit diffs without treating file headers as code", () => {
    const rendered = renderCoreToolBody(
      audit("edit", {
        args: { path: "src/example.ts" },
        result: {
          ok: true,
          output: "edited",
          details: { diff: "--- a/src/example.ts\n+++ b/src/example.ts\n-old\n+new" },
        },
        success: true,
      }),
      theme,
      options(),
    );

    const text = rendered!.lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toContain("- │ old");
    expect(text).toContain("+ │ new");
    expect(text).toContain("--- a/src/example.ts");

    const component = renderBoundedLines(rendered!.lines, theme, settings.diffIntensity);
    const rows = component.render(32);
    expect(inheritComponentBackground(component).render(32)).toEqual(rows);
    expect(rows.filter((line) => line.startsWith("\x1b[48;2;"))).toHaveLength(2);
  });

  it("separates bounded-read continuation metadata from file content", () => {
    const rendered = renderCoreToolBody(
      audit("read", {
        args: { path: "notes.txt", limit: 2 },
        result: "alpha\nbeta\n\n[Showing lines 1-2 of 8. Use offset=3 to continue.]",
        success: true,
      }),
      theme,
      options(),
    );

    const text = rendered!.lines.join("\n");
    expect(text).toContain("1 │ alpha");
    expect(text).toContain("2 │ beta");
    expect(text).toContain("Showing lines 1-2 of 8. Use offset=3 to continue.");
    expect(text).not.toContain("3 │ [Showing");
  });

  it("renders blank-only files and escapes C1 controls", () => {
    const blank = renderCoreToolBody(
      audit("read", { args: { path: "blank.txt" }, result: "\n\n", success: true }),
      theme,
      options(),
    );
    const controlled = renderCoreToolBody(
      audit("read", { args: { path: "control.txt" }, result: "safe\x80text", success: true }),
      theme,
      options(),
    );

    expect(blank!.lines.join("\n")).not.toContain("Empty file");
    expect(controlled!.lines.join("\n")).toContain("safe�text");
    expect(controlled!.lines.join("\n")).not.toContain("\x80");
  });

  it("skips complex write rewrites before invoking the quadratic diff", () => {
    const before = Array.from({ length: 1_001 }, (_, index) => `before ${index}`).join("\n");
    const content = Array.from({ length: 1_001 }, (_, index) => `after ${index}`).join("\n");
    const rendered = renderCoreToolBody(
      audit("write", {
        args: { path: "rewrite.txt", content },
        preview: {
          details: { codePreviewBeforeWrite: { kind: "content", content: before } },
          writeBeforeCaptured: true,
        },
        success: true,
      }),
      theme,
      options(),
    );

    expect(rendered!.lines.join("\n")).toContain("diff skipped for complex rewrite");
  });

  it("reports a redacted prior write snapshot without calling it a new file", () => {
    const rendered = renderCoreToolBody(
      audit("write", {
        args: { path: "existing.txt", content: "after" },
        preview: {
          details: { codePreviewBeforeWrite: { kind: "content", byteLength: 6 } },
          writeBeforeCaptured: true,
        },
        success: true,
      }),
      theme,
      options(),
    );

    expect(rendered!.lines.join("\n")).toContain("previous content unavailable");
  });

  it("lazily invalidates and highlights every syntax-aware core preview", async () => {
    configureHighlighting("dark-plus", false);
    configureHighlighting("dark-plus", true);
    const invalidate = vi.fn();
    const previews = [
      () => renderCoreToolBody(
        audit("read", {
          args: { path: "src/lazy-read.ts" },
          result: "export const lazyRead = true;",
          success: true,
        }),
        theme,
        options({ invalidate }),
      )!.lines.join("\n"),
      () => renderCoreToolBody(
        audit("write", {
          args: { path: "src/lazy-write.ts", content: "export const lazyWrite = true;" },
          preview: { writeBeforeCaptured: true },
          success: true,
        }),
        theme,
        options({ invalidate }),
      )!.lines.join("\n"),
      () => renderCoreToolBody(
        audit("edit", {
          args: { path: "src/lazy-edit.ts" },
          result: { details: { diff: "-1 const lazyEdit = false;\n+1 const lazyEdit = true;" } },
          success: true,
        }),
        theme,
        options({ invalidate }),
      )!.lines.join("\n"),
      () => renderCoreToolBody(
        audit("grep", {
          args: { path: "src", pattern: "lazyGrep", literal: true },
          result: "src/lazy-grep.ts:1: export const lazyGrep = true;",
          success: true,
        }),
        theme,
        options({ invalidate }),
      )!.lines.join("\n"),
      () => {
        const call = audit("bash", {
          args: { command: "printf '%s\n' lazy-bash" },
          result: "lazy-bash",
          success: true,
        });
        return [
          coreToolTitle(call, theme, { cwd: process.cwd(), settings, invalidate }),
          ...renderCoreToolBody(call, theme, options({ invalidate }))!.lines,
        ].join("\n");
      },
    ];

    expect(previews.map((render) => render()).every((text) => !text.includes("\x1b[38;2;"))).toBe(true);
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled(), { timeout: 15_000 });
    expect(previews.map((render) => render()).every((text) => text.includes("\x1b[38;2;"))).toBe(true);
  }, 20_000);

  it("highlights Bend read, write, edit, and grep previews on demand", async () => {
    configureHighlighting("dark-plus", false);
    await initHighlighting("dark-plus", true);
    const invalidate = vi.fn();
    const code = "law add_zero: # Bend proof";
    const previews = [
      audit("read", { args: { path: "missing/LAWS.bend" }, result: code, success: true }),
      audit("write", {
        args: { path: "missing/new.bend", content: code },
        preview: { writeBeforeCaptured: true }, success: true,
      }),
      audit("edit", {
        args: { path: "missing/PROOF.bend" },
        result: { details: { diff: "-1 law old:\n+1 law add_zero:" } }, success: true,
      }),
      audit("grep", {
        args: { path: "missing", pattern: "law", literal: true },
        result: `missing/LAWS.bend:1: ${code}`, success: true,
      }),
    ];
    const render = () => previews.map(call => renderCoreToolBody(call, theme, options({ invalidate }))!.lines.join("\n"));
    expect(render().every(text => !text.includes("\x1b[38;2;"))).toBe(true);
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled(), { timeout: 15_000 });
    expect(render().every(text => text.includes("\x1b[38;2;"))).toBe(true);
  }, 20_000);

  it("does not apply core rendering to another provider with a colliding action name", () => {
    const other = {
      ref: "mcp.files.read",
      provider: "mcp",
      tool: "read",
      args: { path: "remote.txt" },
      result: "remote",
    };
    expect(renderCoreToolBody(other, theme, options())).toBeNull();
    expect(coreToolTitle(other, theme, { cwd: process.cwd(), settings })).toBeNull();
  });
});

describe("Fabric core tool stateful highlighting", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    dir = mkdtempSync((await import("node:path")).join(tmpdir(), "pi-fabric-render-"));
    file = (await import("node:path")).join(dir, "audio.cpp");
    writeFileSync(
      file,
      [
        "/**",
        " * @brief Shared queue carrying captured PCM sample buffers.",
        " */",
        "using sample_queue_t = int;",
        "static int start_audio_control(int ctx);",
      ].join("\n"),
      "utf8",
    );
    await initHighlighting("dark-plus", true);
    await vi.waitFor(
      () => expect(highlightCode(`int warm${Math.random()};`, "cpp")).not.toBeNull(),
      { timeout: 15_000 },
    );
  });

  afterEach(async () => {
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  });

  it("colors doc-comment rows in grep output with full-file grammar state", async () => {
    const source = [
      "/**",
      " * @brief Shared queue carrying captured PCM sample buffers.",
      " */",
      "using sample_queue_t = int;",
      "static int start_audio_control(int ctx);",
    ].join("\n");
    const output = [
      `${file}:2:  * @brief Shared queue carrying captured PCM sample buffers.`,
      `${file}-3-  */`,
      `${file}:4: using sample_queue_t = int;`,
    ].join("\n");
    const call = audit("grep", {
      args: { pattern: "sample_queue|@brief", path: dir },
      result: output,
      success: true,
    });

    // Drive the on-disk coverage to completion.
    const coverage = vi.fn();
    highlightFileLines(file, "cpp", 0, 5, coverage);
    await vi.waitFor(() => expect(coverage).toHaveBeenCalled(), { timeout: 15_000 });

    const rendered = renderCoreToolBody(call, theme, options({ expanded: true }));
    expect(rendered).not.toBeNull();
    const full = highlightCode(source, "cpp")!;
    const commentColor = full[0]!.match(/\x1b\[38;2;[0-9;]+m/)?.[0];
    expect(commentColor).toBeTruthy();
    // Every doc-comment row, including the interior lines that used to be
    // tokenized in isolation, now carries the comment color of the opener.
    const body = rendered!.lines.find((line) => line.includes("@brief"));
    const closer = rendered!.lines.find((line) => line.includes("*/"));
    expect(body).toContain(commentColor);
    expect(body).toContain(full[1]!);
    expect(closer).toContain(commentColor);
  }, 20_000);

  it("keeps compact multi-hunk edits on full-file grammar state", async () => {
    const { writeFileSync } = await import("node:fs");
    const path = (await import("node:path")).join(dir, "declarations.ts");
    const source = [
      "export const declarations = `",
      "type Root = string;",
      "interface Added {",
      "  kind: string;",
      "}",
      "interface First {",
      "  effect?: Added;",
      "  keep?: boolean;",
      "}",
      "const spacer = true;",
      "interface Second {",
      "  requirements?: string[];",
      "  valid?: boolean;",
      "}",
      "`;",
    ].join("\n");
    writeFileSync(path, source, "utf8");
    const diff = [
      "    2 type Root = string;",
      "+   3 interface Added {",
      "+   4   kind: string;",
      "+   5 }",
      "    3 interface First {",
      "+   7   effect?: Added;",
      "    4   keep?: boolean;",
      "    5 }",
      "      ...",
      "    7 interface Second {",
      "+  12   requirements?: string[];",
      "    8   valid?: boolean;",
      "    9 }",
    ].join("\n");

    const coverage = vi.fn();
    highlightFileLines(path, "typescript", 0, 15, coverage);
    await vi.waitFor(() => expect(coverage).toHaveBeenCalled(), { timeout: 15_000 });

    const rendered = renderCoreToolBody(
      audit("edit", {
        args: { path },
        success: true,
        result: { details: { diff } },
      }),
      theme,
      options({ expanded: true }),
    );
    expect(rendered).not.toBeNull();
    const stripAnsi = (line: string) =>
      line.replace(/\u0000PI_DIFF_[A-Z]+\u0000/g, "").replace(/\x1b\[[0-9;]*m/g, "");
    const foregrounds = (line: string): string[] =>
      [...line.matchAll(/\x1b\[38;2;([0-9;]+)m/g)].map((match) => match[1]!);
    const stringForeground = foregrounds(highlightCode(source, "typescript")![2]!)[0];
    expect(stringForeground).toBeTruthy();
    expect(new Set(foregrounds(highlightCode("interface First {", "typescript")![0]!)).size)
      .toBeGreaterThan(1);

    for (const content of ["interface Added {", "interface First {", "interface Second {"]) {
      const row = rendered!.lines.find((line) => stripAnsi(line).includes(content));
      expect(row, content).toBeDefined();
      expect(new Set(foregrounds(row!))).toEqual(new Set([stringForeground!]));
    }
  }, 20_000);

  it("tokenizes proposed edit diff sides as separate streams", async () => {
    const call = audit("edit", {
      args: {
        path: (await import("node:path")).join(dir, "missing.ts"),
        edits: [{ oldText: "const b = 2;\n/* dangling", newText: "const b = 3;" }],
      },
      success: false,
    });
    const rendered = renderCoreToolBody(call, theme, options({ expanded: true }));
    expect(rendered).not.toBeNull();
    const stripAnsi = (line: string) =>
      line.replace(/\u0000PI_DIFF_[A-Z]+\u0000/g, "").replace(/\x1b\[[0-9;]*m/g, "");
    const added = rendered!.lines.find((line) => stripAnsi(line).includes("const b = 3;"));
    const removed = rendered!.lines.find((line) => stripAnsi(line).includes("/* dangling"));
    expect(added).toBeDefined();
    expect(removed).toBeDefined();
    const newlineFirst = highlightCode("const b = 3;", "typescript")![0]!;
    const keywordSpan = newlineFirst.match(/^(\x1b\[[0-9;]+m)const/)?.[1];
    expect(keywordSpan).toBeTruthy();
    // The removed `/* dangling` must not bleed comment state into the added
    // line: it is tokenized as the new-side stream, so `const` keeps its
    // keyword color (word-emphasis backgrounds only touch the changed `3`).
    expect(added).toContain(`${keywordSpan}const`);
    const commentSpan = removed!.match(/(\x1b\[[0-9;]+m)\/\*/)?.[1];
    expect(commentSpan).toBeTruthy();
    expect(added).not.toContain(`${commentSpan}const`);
  }, 20_000);

  it("colors removed lines with pre-edit grammar state instead of a flat fragment", async () => {
    // JS embedded in an HTML <script>: a standalone removed fragment has no
    // embedded-language scope, so without the virtual pre-edit document the
    // keyword gets no foreground color.
    const { writeFileSync } = await import("node:fs");
    const path = (await import("node:path")).join(dir, "motion.html");
    const post = [
      "<!doctype html>",
      "<html>",
      "<head><script>",
      "const state = { frame: 0 };",
      "function draw() {",
      "  const markerCells = 24;",
      "}",
      "</" + "script></head>",
      "</html>",
    ].join("\n");
    writeFileSync(path, post, "utf8");
    await vi.waitFor(
      () => expect(highlightCode(`<p>${Math.random()}</p>`, "html")).not.toBeNull(),
      { timeout: 15_000 },
    );

    const removedLine = "  for(let bit=0;bit<16;bit++){";
    const diff = [
      "@@ 5 @@",
      " 5 function draw() {",
      `-6 ${removedLine}`,
      "+6   const markerCells = 24;",
      " 7 }",
    ].join("\n");
    const call = audit("edit", {
      args: { path },
      success: true,
      result: { details: { diff } },
    });

    const stripAnsi = (line: string) =>
      line.replace(/\u0000PI_DIFF_[A-Z]+\u0000/g, "").replace(/\x1b\[[0-9;]*m/g, "");
    // Drive the shared pump (file + virtual document) until the removed line
    // picks up state-correct foreground color. The invalidate callback is the
    // scheduling hook; readiness is the keyword actually being colored.
    const keywordColor = hl_dark_plus_keyword();
    const removedColored = (): string | undefined => {
      const rendered = renderCoreToolBody(call, theme, options({ expanded: true, invalidate: vi.fn() }));
      const row = rendered!.lines.find((line) => stripAnsi(line).includes("bit<16"));
      if (!row) return undefined;
      const deEmphasized = row.replace(/\x1b\[48;2;148;62;70m/g, "").replace(/\x1b\[49m/g, "");
      return deEmphasized.includes(`${keywordColor}for`) ? deEmphasized : undefined;
    };
    await vi.waitFor(() => expect(removedColored()).toBeDefined(), { timeout: 15_000 });

    const deEmphasized = removedColored()!;
    // Full token coverage: the number literal and variable are colored too.
    expect(deEmphasized).toMatch(/\x1b\[38;2;[0-9;]+m16/);
    expect(deEmphasized).toMatch(/\x1b\[38;2;[0-9;]+mbit/);
  }, 20_000);

  it("weaves removed lines past separators and in-hunk scope openers", async () => {
    // Compact hunks arrive wrapped in "..." separator rows, and the removed
    // run is often preceded by context lines that open a scope (here the
    // block-comment opener at line 17). Both must not defeat the virtual
    // pre-edit document: the separators carry no position and the context
    // lines belong to the woven document, otherwise removed comment lines
    // fall out of comment state and render as code.
    const { writeFileSync } = await import("node:fs");
    const path = (await import("node:path")).join(dir, "invariant.ts");
    const filler = Array.from({ length: 13 }, (_, index) => `const filler${index + 1} = ${index + 1};`);
    const post = [
      ...filler,
      "/** Service required before the companion can reserve package ownership. */",
      "export const inject = ['invariants']",
      "",
      "/**",
      " * No runtime invariant: the Host contribution is a schema-validated settings",
      " * namespace whose registration/update relations are owned by dsh-settings;",
      " * the Client contribution derives presentation from typed Session, Workspace,",
      " * job, settings, and slot stores without emitting a package-owned event.",
      " */",
      "const install = () => {};",
      "const tail = true;",
    ].join("\n");
    writeFileSync(path, post, "utf8");
    await vi.waitFor(
      () => expect(highlightCode(`const w${Math.random()} = 1;`, "typescript")).not.toBeNull(),
      { timeout: 15_000 },
    );
    // Settle into the regime the screenshot came from: the renderer's own
    // slice request resolves, so context and added rows take file-verified
    // tokens and the removed rows stand alone.
    await vi.waitFor(
      () => expect(highlightFileLines(path, "typescript", 13, 24, vi.fn())).not.toBeNull(),
      { timeout: 15_000 },
    );

    const diff = [
      "     ...",
      "    14 /** Service required before the companion can reserve package ownership. */",
      "    15 export const inject = ['invariants']",
      "    16 ",
      "    17 /**",
      "-   18  * No runtime invariant: a pure-consumer plugin registering presentational",
      "-   19  * components into two host-declared slots plus its locale dictionaries; its",
      "-   20  * inject face is stateless RPC wrappers plus a create-and-open call; it",
      "-   21  * emits no cordis events and owns no cross-plugin mutable state.",
      "+   18  * No runtime invariant: the Host contribution is a schema-validated settings",
      "+   19  * namespace whose registration/update relations are owned by dsh-settings;",
      "+   20  * the Client contribution derives presentation from typed Session, Workspace,",
      "+   21  * job, settings, and slot stores without emitting a package-owned event.",
      "    22  */",
      "    23 const install = () => {};",
      "     ...",
    ].join("\n");
    const call = audit("edit", {
      args: { path },
      success: true,
      result: { details: { diff } },
    });

    const stripAnsi = (line: string) =>
      line.replace(/\u0000PI_DIFF_[A-Z]+\u0000/g, "").replace(/\x1b\[[0-9;]*m/g, "");
    const commentColor = highlightCode(post, "typescript")![17]!.match(/\x1b\[38;2;[0-9;]+m/)?.[0];
    expect(commentColor).toBeTruthy();
    const removedCommentColored = (): string | undefined => {
      const rendered = renderCoreToolBody(call, theme, options({ expanded: true, invalidate: vi.fn() }));
      const row = rendered!.lines.find((line) => stripAnsi(line).includes("a pure-consumer plugin"));
      if (!row) return undefined;
      const deEmphasized = row
        .replace(/\x1b\[48;2;148;62;70m/g, "")
        .replace(/\x1b\[48;2;64;132;82m/g, "")
        .replace(/\x1b\[49m/g, "");
      return deEmphasized.includes(`${commentColor} * No runtime invariant: a `) ? deEmphasized : undefined;
    };
    await vi.waitFor(() => expect(removedCommentColored()).toBeDefined(), { timeout: 15_000 });
    // The whole removed line is one comment span; fragment tokenization would
    // split it into code tokens (plain/default and identifier colors).
    expect(removedCommentColored()!).not.toContain("\x1b[38;2;156;220;254m");
    // The added sibling is the reference rendering of the very same state.
    const addedRow = renderCoreToolBody(call, theme, options({ expanded: true, invalidate: vi.fn() }))!
      .lines.find((line) => stripAnsi(line).includes("the Host contribution"))!;
    expect(
      addedRow
        .replace(/\x1b\[48;2;148;62;70m/g, "")
        .replace(/\x1b\[48;2;64;132;82m/g, "")
        .replace(/\x1b\[49m/g, ""),
    ).toContain(`${commentColor} * No runtime invariant: the Host contribution`);
  }, 20_000);
});

// Resolve the exact keyword color shiki assigns under dark-plus by tokenizing
// a known-good snippet through the whole-document path.
function hl_dark_plus_keyword(): string {
  const snippet = highlightCode("for(;;){}", "javascript")![0]!;
  const match = snippet.match(/(\x1b\[38;2;[0-9;]+m)for/);
  expect(match).toBeTruthy();
  return match![1]!;
}