import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSyntheticSourceInfo,
  defineTool,
  type ExtensionContext,
  type ExtensionRunner,
  type RegisteredTool,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { availablePythonBackends } from "./fixtures/python-backends.js";
import { rmTempSync } from "./fixtures/temp-cleanup.js";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { CapturedToolsProvider } from "../src/providers/captured-tools-provider.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import { readPlainText } from "../src/core/read-plain-text.js";

// A read override modelled on pi-hashline-edit-pro's contract: the model sees
// anchored rows in content; scripts get the raw text in structuredContent (a
// string, or { text, lines, truncated, nextOffset, notices } with anchors:true
// or when its codemode flag is off). The anchor of line n is "a<n>".
const anchor = (line: number) => `a${line}`;
const hashlineRead = (calls: Array<Record<string, unknown>>, declareAnchors: boolean, cwd: string): RegisteredTool => ({
  definition: defineTool({
    name: "read",
    label: "read",
    description: "anchored read",
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.String()])),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
      ...(declareAnchors ? { anchors: Type.Optional(Type.Boolean()) } : {}),
    }, { additionalProperties: false }) as TSchema,
    outputSchema: Type.Any() as TSchema,
    async execute(_id, params) {
      const input = params as { path: string; offset?: number; limit?: number; anchors?: boolean };
      calls.push({ ...input });
      const lines = fs.readFileSync(path.resolve(cwd, input.path), "utf8").replace(/\n$/, "").split("\n");
      const start = input.offset ?? 1;
      const end = input.limit ? Math.min(lines.length, start - 1 + input.limit) : lines.length;
      const shown = lines.slice(start - 1, end);
      const text = shown.join("\n");
      let display = shown.map((line, index) => `${anchor(start + index)}│${line}`).join("\n");
      const nextOffset = end < lines.length ? end + 1 : null;
      if (nextOffset !== null) display += `\n\n[Showing lines ${start}-${end} of ${lines.length}. Use offset=${anchor(end)} to continue.]`;
      const structured = {
        ok: true, kind: "read", path: input.path, text,
        lines: shown.map((line, index) => ({ line: start + index, text: line, anchor: anchor(start + index) })),
        nextOffset, truncated: nextOffset !== null, notices: [],
      };
      return {
        content: [{ type: "text" as const, text: display }],
        details: {},
        structuredContent: declareAnchors && input.anchors !== true ? text : structured,
      };
    },
  }),
  sourceInfo: createSyntheticSourceInfo("/extensions/pi-hashline-edit-pro/index.ts", { source: "test" }),
});

const makeRunner = (emitToolResult: ExtensionRunner["emitToolResult"] = vi.fn(async () => undefined)): ExtensionRunner => ({
  createContext: () => ({ cwd: process.cwd() }),
  getActiveTools: () => [],
  emit: vi.fn(async () => {}),
  emitToolCall: vi.fn(async () => undefined),
  emitToolResult,
} as unknown as ExtensionRunner);

const makeContext = (cwd: string): ExtensionContext => ({
  cwd,
  hasUI: false,
  sessionManager: { getSessionId: () => "read-plain-text", getSessionFile: () => undefined },
} as unknown as ExtensionContext);

const setup = (cwd: string, tools: RegisteredTool[], runner = makeRunner()) => {
  const catalog = new CapturedToolCatalog();
  catalog.replace(tools, runner, DEFAULT_FABRIC_CONFIG.capture, "/extensions/pi-fabric/index.ts");
  const registry = new ActionRegistry();
  registry.register(new PiToolsProvider(cwd, catalog, new CapturedToolsProvider(catalog)));
  const config = structuredClone(DEFAULT_FABRIC_CONFIG);
  config.approvals.read = "allow";
  const service = new FabricExecutionService(registry, config, undefined, undefined, undefined, undefined, catalog);
  const run = async (code: string, id: string) => {
    const result = await service.execute({ code, signal: undefined, parentToolCallId: id, context: makeContext(cwd), onPartial() {} });
    expect(result.success, result.error).toBe(true);
    return result.value;
  };
  return { catalog, service, run };
};

const withFile = async (body: (cwd: string) => Promise<void>) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-read-plain-"));
  fs.writeFileSync(path.join(cwd, "data.json"), '{\n  "alpha": 1,\n  "beta": 2\n}\n');
  fs.writeFileSync(path.join(cwd, "long.txt"), "l1\nl2\nl3\nl4\nl5\n");
  try { await body(cwd); } finally { rmTempSync(cwd); }
};

describe("pi.read plain text under an anchor-aware read override", () => {
  it("returns the file text, not anchored rows, so programs can parse it", async () => {
    await withFile(async (cwd) => {
      const calls: Array<Record<string, unknown>> = [];
      const { catalog, run } = setup(cwd, [hashlineRead(calls, true, cwd)]);
      try {
        const value = await run('const text = await pi.read("data.json"); return { text, parsed: JSON.parse(text) };', "plain");
        expect(value).toEqual({ text: '{\n  "alpha": 1,\n  "beta": 2\n}', parsed: { alpha: 1, beta: 2 } });
        expect(calls).toEqual([{ path: "data.json" }]);
      } finally { catalog.clear(); }
    });
  });

  it.each(["quickjs", "monty"] as const)("anchors:true forwards the flag and returns the anchored rows (%s)", async (backend) => {
    if (backend === "monty" && !availablePythonBackends.monty) return;
    await withFile(async (cwd) => {
      const calls: Array<Record<string, unknown>> = [];
      const { catalog, service, run } = setup(cwd, [hashlineRead(calls, true, cwd)]);
      if (backend === "monty") { service.config.executor.kernel = "python"; service.config.executor.pythonRuntime = "monty"; }
      try {
        const value = await run(backend === "monty"
          ? 'return await pi.read(path="long.txt", limit=2, anchors=True)'
          : 'return await pi.read({ path: "long.txt", limit: 2, anchors: true });', `anchored-${backend}`);
        expect(value).toBe("a1│l1\na2│l2\n\n[Showing lines 1-2 of 5. Use offset=a2 to continue.]");
        expect(calls).toEqual([{ path: "long.txt", limit: 2, anchors: true }]);
      } finally { catalog.clear(); }
    });
  });

  it("keeps a numeric continuation notice on a truncated plain read", async () => {
    await withFile(async (cwd) => {
      const calls: Array<Record<string, unknown>> = [];
      const { catalog, run } = setup(cwd, [hashlineRead(calls, true, cwd)]);
      try {
        const value = await run('return pi.read("long.txt", { limit: 2 });', "truncated");
        expect(value).toBe("l1\nl2\n\n[Showing lines 1-2 of 5. Use offset=3 to continue.]");
      } finally { catalog.clear(); }
    });
  });

  it("uses structured text when the override's anchors switch is absent, and drops anchors:true", async () => {
    await withFile(async (cwd) => {
      const calls: Array<Record<string, unknown>> = [];
      const { catalog, run } = setup(cwd, [hashlineRead(calls, false, cwd)]);
      try {
        const value = await run(`
const plain = await pi.read("data.json");
const anchored = await pi.read({ path: "data.json", anchors: true });
return { plain, anchored };`, "no-switch");
        expect(value).toEqual({
          plain: '{\n  "alpha": 1,\n  "beta": 2\n}',
          anchored: 'a1│{\na2│  "alpha": 1,\na3│  "beta": 2\na4│}',
        });
        expect(calls).toEqual([{ path: "data.json" }, { path: "data.json" }]);
      } finally { catalog.clear(); }
    });
  });

  it("never resurrects structured text after a content-only redaction patch", async () => {
    await withFile(async (cwd) => {
      const calls: Array<Record<string, unknown>> = [];
      const runner = makeRunner(vi.fn(async () => ({ content: [{ type: "text" as const, text: "[redacted]" }] })) as never);
      const { catalog, run } = setup(cwd, [hashlineRead(calls, true, cwd)], runner);
      try {
        expect(await run('return pi.read("data.json");', "redacted")).toBe("[redacted]");
      } finally { catalog.clear(); }
    });
  });
});

describe("pi.read with the built-in read tool", () => {
  it("keeps text, the continuation notice and image handling, and drops anchors", async () => {
    await withFile(async (cwd) => {
      const { catalog, run } = setup(cwd, []);
      fs.copyFileSync(path.resolve("tests/fixtures/images/sample.jpg"), path.join(cwd, "sample.jpg"));
      try {
        const value = await run(`
const limited = await pi.read({ path: "long.txt", limit: 2 });
const anchored = await pi.read({ path: "long.txt", limit: 2, anchors: true });
const image = await pi.read("sample.jpg");
return { limited, anchored, image };`, "builtin");
        const { limited, anchored, image } = value as Record<string, string>;
        expect(limited).toBe("l1\nl2\n\n[4 more lines in file. Use offset=3 to continue.]");
        expect(anchored).toBe(limited);
        expect(image).toMatch(/^Read image file \[image\//);
      } finally { catalog.clear(); }
    });
  }, 15_000);
});

describe("readPlainText", () => {
  it("rewrites an anchor continuation offset to a line number, keeping the byte limit", () => {
    expect(readPlainText("a1│x\n\n[Showing lines 1-1 of 9 (50.0KB limit). Use offset=a1 to continue.]", "x"))
      .toBe("x\n\n[Showing lines 1-1 of 9 (50.0KB limit). Use offset=2 to continue.]");
  });

  it("marks a structured truncation the display did not describe", () => {
    expect(readPlainText("a1│x", { text: "x", truncated: true, nextOffset: 2 }))
      .toBe("x\n\n[Read truncated. Use offset=2 to continue.]");
  });

  it("leaves results without plain text to the caller", () => {
    expect(readPlainText("note", { type: "image", data: "", mimeType: "image/png", note: "note" })).toBeUndefined();
    expect(readPlainText("note", undefined)).toBeUndefined();
  });
});
