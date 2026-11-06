import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExtensionRuntime, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { normalizeFabricConfig } from "../src/config.js";
import { FabricState } from "../src/fabric-state.js";

type Handler = (event: unknown, context: unknown) => unknown;
const files: string[] = [];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";
const makeFile = async () => {
  const file = path.join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  files.push(file);
  await writeFile(file, Buffer.from(PNG, "base64"));
  return file;
};

async function inputRunner() {
  vi.spyOn(FabricState.prototype, "bootstrapped", "get").mockReturnValue(true);
  vi.spyOn(FabricState.prototype, "cwd", "get").mockReturnValue(process.cwd());
  vi.spyOn(FabricState.prototype, "config", "get").mockReturnValue(normalizeFabricConfig({}));
  vi.spyOn(CapturedToolCatalog.prototype, "list").mockReturnValue([]);
  const handlers = new Map<string, Handler[]>();
  const pi = {
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
    on: vi.fn((name: string, handler: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }),
    getActiveTools: vi.fn(() => ["fabric_exec"]), getAllTools: vi.fn(() => []),
    registerCommand: vi.fn(), registerMessageRenderer: vi.fn(), registerTool: vi.fn(),
    setActiveTools: vi.fn(), sendMessage: vi.fn(), appendEntry: vi.fn(), getThinkingLevel: vi.fn(() => "off"),
  } as unknown as ExtensionAPI;
  const { default: fabric } = await import("../src/index.js");
  await fabric(pi);
  const ext = {
    path: "pi-fabric", resolvedPath: "pi-fabric", sourceInfo: {}, handlers: new Map([["input", handlers.get("input") ?? []]]),
    tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
  };
  const runner = new ExtensionRunner([ext] as never, createExtensionRuntime(), process.cwd(), {} as never, {} as never);
  const errors: string[] = [];
  runner.onError(error => { errors.push(error.error); });
  return { runner, errors };
}

beforeAll(() => import("../src/index.js"), 60_000);
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(files.splice(0).map(file => rm(file, { force: true })));
});

describe("native Pi input transform", () => {
  it.each([undefined, "steer", "followUp"] as const)("attaches before the first request, including %s inputs", async behavior => {
    const file = await makeFile();
    const { runner, errors } = await inputRunner();
    const image = { type: "image" as const, mimeType: "image/jpeg", data: "existing" };
    const result = await runner.emitInput(`Inspect ${file}`, [image], "interactive", behavior);
    expect(errors).toEqual([]);
    expect(result).toMatchObject({ action: "transform", text: `Inspect [Attached image: ${file}]` });
    if (result.action !== "transform") throw new Error("not transformed");
    expect(result.images).toEqual([image, { type: "image", mimeType: "image/png", data: PNG }]);
  });

  it.each(["rpc", "extension"] as const)("does not discover files in %s text", async source => {
    const file = await makeFile();
    const { runner, errors } = await inputRunner();
    const result = await runner.emitInput(file, undefined, source);
    expect(result.action).toBe("continue");
    expect(errors).toEqual([]);
  });

  it("does no attachment work for ordinary prompts", async () => {
    const { runner, errors } = await inputRunner();
    expect((await runner.emitInput("inspect src/index.ts", undefined, "interactive")).action).toBe("continue");
    expect(errors).toEqual([]);
  });
});
