import { readFileSync } from "node:fs";
import path from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import { CapturedToolsProvider } from "../src/providers/captured-tools-provider.js";

// A host where every ExtensionRunner lookup fails: no advertised runner, no Pi
// package root (PI_PACKAGE_DIR unset, argv[1] not on disk) and a bare SDK
// import that throws. Capture then installs no hub, so no tool refresh can
// ever supply the runner that nested mutating calls need.
const savedArgv1 = process.argv[1];
const savedPackageDir = process.env.PI_PACKAGE_DIR;

afterEach(() => {
  process.argv[1] = savedArgv1!;
  if (savedPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
  else process.env.PI_PACKAGE_DIR = savedPackageDir;
  vi.doUnmock("@earendil-works/pi-coding-agent");
  vi.resetModules();
});

const context = {
  cwd: process.cwd(),
  signal: new AbortController().signal,
  parentToolCallId: "parent",
  nestedToolCallId: "fabric_test-nested",
  extensionContext: {
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
  },
  update: vi.fn(),
  approve: vi.fn(async () => {}),
  audits: [],
  maxResultChars: 100_000,
} as unknown as Parameters<PiToolsProvider["invoke"]>[2];

describe("a host whose ExtensionRunner cannot be found", () => {
  it("refuses nested mutating tools without asking the caller to retry", async () => {
    const anchor = defineTool({
      name: "fabric_exec", label: "fabric_exec", description: "anchor",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    });
    delete process.env.PI_PACKAGE_DIR;
    process.argv[1] = path.resolve("no-such-dir", "pi");
    vi.resetModules();
    vi.doMock("@earendil-works/pi-coding-agent", () => { throw new Error("Cannot find package '@earendil-works/pi-coding-agent'"); });
    const { installRegisteredToolCapture } = await import("../src/capture/interceptor.js");
    const catalog = new CapturedToolCatalog();
    const controller = await installRegisteredToolCapture({ anchorDefinition: anchor, catalog });
    try {
      expect(catalog.runner).toBeUndefined();
      const provider = new PiToolsProvider(process.cwd(), catalog, new CapturedToolsProvider(catalog));
      const target = path.resolve("standalone-hooks-scratch.txt");
      for (const [tool, args] of [
        ["write", { path: target, content: "x" }],
        ["edit", { path: target, oldText: "a", newText: "b" }],
        ["bash", { command: "echo hi" }],
      ] as const) {
        const message = await provider.invoke(tool, args, context).then(() => "resolved", (error: Error) => error.message);
        expect(message).toContain(`Pi tool ${tool} is unavailable`);
        expect(message).toContain("could not find this Pi host's ExtensionRunner");
        expect(message).toContain("retrying will not help");
        expect(message).not.toContain("retry once tools are ready");
      }
      expect(() => readFileSync(target)).toThrow();
      // Read tools have no hook to skip and still run.
      await expect(provider.invoke("ls", { path: process.cwd() }, context)).resolves.toEqual(expect.any(String));
    } finally {
      controller.dispose();
    }
  });
});
