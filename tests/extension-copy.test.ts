import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandLineFabricCopy } from "../src/extension-copy.js";
import piFabric from "../src/index.js";

let root: string;

const makeCopy = (directory: string, options: { name?: string; entry?: string } = {}): string => {
  const entry = options.entry ?? "dist/extension-bootstrap.js";
  fs.mkdirSync(path.join(root, directory, path.dirname(entry)), { recursive: true });
  fs.writeFileSync(path.join(root, directory, "package.json"), JSON.stringify({ name: options.name ?? "pi-fabric" }));
  fs.writeFileSync(path.join(root, directory, entry), "export default () => {};\n");
  return path.join(root, directory, entry);
};

const cli = (...extensions: string[]) => ({
  argv: ["node", "pi", "--mode", "rpc", ...extensions.flatMap((value) => ["-e", value])],
  cwd: root,
});

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-copy-")));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("commandLineFabricCopy", () => {
  it("makes a settings copy defer to another build named with -e", () => {
    const parentBuild = makeCopy("build-1");
    const profileBuild = makeCopy("build-2");

    expect(commandLineFabricCopy(profileBuild, cli(parentBuild))).toBe(parentBuild);
    expect(commandLineFabricCopy(parentBuild, cli(parentBuild))).toBeUndefined();
  });

  it("stays active when the command line names no other Fabric copy", () => {
    const fabric = makeCopy("fabric");
    const other = makeCopy("other", { name: "pi-other", entry: "dist/index.js" });

    expect(commandLineFabricCopy(fabric, { argv: ["node", "pi"], cwd: root })).toBeUndefined();
    expect(commandLineFabricCopy(fabric, cli(other))).toBeUndefined();
    expect(commandLineFabricCopy(fabric, cli("npm:pi-fabric", path.join(root, "missing/dist/index.js")))).toBeUndefined();
    expect(commandLineFabricCopy(fabric, { argv: ["node", "pi", "-e"], cwd: root })).toBeUndefined();
  });

  it("resolves symlinks, relative paths, ~, --extension, and package directories", () => {
    const parentBuild = makeCopy("build-1");
    const profileBuild = makeCopy("build-2");
    fs.symlinkSync(path.join(root, "build-1"), path.join(root, "current"), process.platform === "win32" ? "junction" : "dir");
    vi.spyOn(os, "homedir").mockReturnValue(root);

    expect(commandLineFabricCopy(parentBuild, cli(path.join(root, "current/dist/extension-bootstrap.js")))).toBeUndefined();
    expect(commandLineFabricCopy(profileBuild, cli("current/dist/extension-bootstrap.js"))).toBe(parentBuild);
    expect(commandLineFabricCopy(profileBuild, cli("~/build-1/dist/extension-bootstrap.js"))).toBe(parentBuild);
    expect(commandLineFabricCopy(profileBuild, { argv: ["pi", "--extension", parentBuild], cwd: "/" })).toBe(parentBuild);
    expect(commandLineFabricCopy(profileBuild, cli("build-1"))).toBe(path.join(root, "build-1"));
    expect(commandLineFabricCopy(parentBuild, cli("build-1"))).toBeUndefined();
  });

  it("defers to a different entry module of the same build", () => {
    const bootstrap = makeCopy("build");
    const index = makeCopy("build", { entry: "dist/index.js" });

    expect(commandLineFabricCopy(bootstrap, cli(index))).toBe(index);
    expect(commandLineFabricCopy(index, cli(index))).toBeUndefined();
  });

  it("ignores Fabric helper modules that do not register Fabric", () => {
    const helperBuild = makeCopy("build-1");
    const guard = makeCopy("build-1", { entry: "dist/agents/write-guard.js" });
    const fabricBuild = makeCopy("build-2");

    expect(commandLineFabricCopy(fabricBuild, cli(guard, fabricBuild))).toBeUndefined();
    expect(commandLineFabricCopy(helperBuild, cli(guard, fabricBuild))).toBe(fabricBuild);
  });

  it("lets the first Fabric copy on the command line win", () => {
    const first = makeCopy("build-1");
    const second = makeCopy("build-2");
    const profile = makeCopy("build-3");

    expect(commandLineFabricCopy(first, cli(first, second))).toBeUndefined();
    expect(commandLineFabricCopy(second, cli(first, second))).toBe(first);
    expect(commandLineFabricCopy(profile, cli(first, second))).toBe(first);
  });
});

describe("Fabric registration with another copy on the command line", () => {
  const ownEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  let savedArgv: string[];

  const fakePi = () => {
    const handlers = new Map<string, ((...args: never[]) => unknown)[]>();
    const pi = {
      events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
      getActiveTools: vi.fn(() => []),
      getAllTools: vi.fn(() => []),
      on: vi.fn((event: string, handler: (...args: never[]) => unknown) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(),
      setActiveTools: vi.fn(),
    };
    const shutdown = async () => {
      for (const handler of handlers.get("session_shutdown") ?? []) await handler();
    };
    return { pi, api: pi as unknown as ExtensionAPI, shutdown };
  };

  beforeEach(() => {
    savedArgv = process.argv;
  });

  afterEach(() => {
    process.argv = savedArgv;
  });

  it("registers nothing and names the active copy", async () => {
    const parentBuild = makeCopy("parent-build", { entry: "dist/index.js" });
    process.argv = ["node", "pi", "--mode", "rpc", "-e", parentBuild];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pi, api } = fakePi();

    await piFabric(api);

    expect(pi.registerTool).not.toHaveBeenCalled();
    expect(pi.on).not.toHaveBeenCalled();
    expect(pi.events.on).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      `[pi-fabric] ${ownEntry} is inactive: the command line loads Fabric from ${parentBuild}`,
    );
  });

  it("registers fabric_exec when the command line names this copy", async () => {
    process.argv = ["node", "pi", "--mode", "rpc", "-e", ownEntry];
    const { pi, api, shutdown } = fakePi();

    await piFabric(api);
    try {
      expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "fabric_exec" }));
    } finally {
      await shutdown();
    }
  });
});
