import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createSyntheticSourceInfo,
  defineTool,
  ExtensionRunner,
  type RegisteredTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import {
  bundleExtensionRunnerConstructors,
  installRegisteredToolCapture,
  type RegisteredToolCaptureController,
} from "../src/capture/interceptor.js";
import { DEFAULT_FABRIC_CONFIG, effectiveToolCaptureConfig } from "../src/config.js";

const controllers: RegisteredToolCaptureController[] = [];

const tool = (name: string) =>
  defineTool({
    name,
    label: name,
    description: `${name} description`,
    parameters: Type.Object({ value: Type.Optional(Type.String()) }),
    execute: vi.fn(async (_id, params) => ({
      content: [{ type: "text" as const, text: params.value ?? name }],
      details: {},
    })),
  });

const registered = (definition: ReturnType<typeof tool>, sourcePath: string): RegisteredTool => ({
  definition,
  sourceInfo: createSyntheticSourceInfo(sourcePath, { source: "test" }),
});

const runnerWith = (...entries: RegisteredTool[]): ExtensionRunner => {
  const runner = Object.create(ExtensionRunner.prototype) as ExtensionRunner;
  (runner as unknown as { extensions: Array<{ tools: Map<string, RegisteredTool> }> }).extensions =
    [{ tools: new Map(entries.map((entry) => [entry.definition.name, entry])) }];
  return runner;
};

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});

describe("registered extension tool capture", () => {
  it("captures every extension tool while keeping it in Pi's registry", async () => {
    // Captured tools must stay visible to pi.getAllTools() consumers (e.g.
    // permission systems validating tool_call events); hiding from the model is
    // handled through native prepareLoadout, not here.
    const fabricTool = tool("fabric_exec");
    const customTool = tool("deploy_release");
    const readOverride = tool("read");
    const runner = runnerWith(
      registered(fabricTool, "/extensions/pi-fabric/index.ts"),
      registered(customTool, "/extensions/pi-deploy/index.ts"),
      registered(readOverride, "/extensions/pi-preview/index.ts"),
    );
    const catalog = new CapturedToolCatalog();
    const controller = await installRegisteredToolCapture({
      anchorDefinition: fabricTool,
      catalog,
    });
    controllers.push(controller);

    expect(runner.getAllRegisteredTools().map((entry) => entry.definition.name)).toEqual([
      "fabric_exec",
      "deploy_release",
      "read",
    ]);
    expect(catalog.list().map((entry) => entry.name)).toEqual(["deploy_release", "read"]);
    expect(catalog.require("deploy_release").risk).toBe("execute");
    expect(catalog.require("read").risk).toBe("read");

    controller.dispose();
    expect(runner.getAllRegisteredTools().map((entry) => entry.definition.name)).toEqual([
      "fabric_exec",
      "deploy_release",
      "read",
    ]);
    expect(catalog.size).toBe(0);
  });

  it("shares one patch across controllers, restores the last lease, and reinstalls without recursion", async () => {
    const original = ExtensionRunner.prototype.getAllRegisteredTools;
    const anchorA = tool("fabric_exec"), anchorB = tool("fabric_exec");
    let refreshes = 0;
    const install = async (anchor: ReturnType<typeof tool>) => {
      const controller = await installRegisteredToolCapture({ anchorDefinition: anchor, catalog: new CapturedToolCatalog(), onCatalogRefresh: () => { refreshes++; } });
      controllers.push(controller);
      return controller;
    };
    const first = await install(anchorA);
    const patched = ExtensionRunner.prototype.getAllRegisteredTools;
    const second = await install(anchorB);
    expect(ExtensionRunner.prototype.getAllRegisteredTools).toBe(patched);
    runnerWith(registered(anchorA, "/fabric/a")).getAllRegisteredTools();
    expect(refreshes).toBe(1);
    first.dispose();
    expect(ExtensionRunner.prototype.getAllRegisteredTools).toBe(patched);
    second.dispose(); second.dispose();
    expect(ExtensionRunner.prototype.getAllRegisteredTools).toBe(original);
    const third = await install(tool("fabric_exec"));
    expect(ExtensionRunner.prototype.getAllRegisteredTools).not.toBe(patched);
    third.dispose();
    expect(ExtensionRunner.prototype.getAllRegisteredTools).toBe(original);
  });

  it("does not overwrite a subsequent extension wrapper on disposal", async () => {
    const original = ExtensionRunner.prototype.getAllRegisteredTools;
    const anchor = tool("fabric_exec");
    const controller = await installRegisteredToolCapture({ anchorDefinition: anchor, catalog: new CapturedToolCatalog() });
    controllers.push(controller);
    const patched = ExtensionRunner.prototype.getAllRegisteredTools;
    const outer = function (this: ExtensionRunner) { return patched.call(this); };
    ExtensionRunner.prototype.getAllRegisteredTools = outer;
    try {
      controller.dispose();
      expect(ExtensionRunner.prototype.getAllRegisteredTools).toBe(outer);
      const next = await installRegisteredToolCapture({ anchorDefinition: tool("fabric_exec"), catalog: new CapturedToolCatalog() });
      controllers.push(next);
      expect(ExtensionRunner.prototype.getAllRegisteredTools).toBe(outer);
      // Simulate the other extension releasing its own layer first.
      ExtensionRunner.prototype.getAllRegisteredTools = patched;
      next.dispose();
      expect(ExtensionRunner.prototype.getAllRegisteredTools).toBe(original);
    } finally { ExtensionRunner.prototype.getAllRegisteredTools = original; }
  });

  it("refresh() repopulates after a suspended-pass clear, as on /reload (#73)", async () => {
    const fabricTool = tool("fabric_exec");
    const customTool = tool("deploy_release");
    const runner = runnerWith(
      registered(fabricTool, "/extensions/pi-fabric/index.ts"),
      registered(customTool, "/extensions/pi-deploy/index.ts"),
    );
    const catalog = new CapturedToolCatalog();
    const controller = await installRegisteredToolCapture({
      anchorDefinition: fabricTool,
      catalog,
      initialPolicy: structuredClone(DEFAULT_FABRIC_CONFIG.capture),
    });
    controllers.push(controller);

    runner.getAllRegisteredTools();
    expect(catalog.get("deploy_release")).toBeDefined();

    // session_start suspends capture, then /reload re-registers extensions and
    // refreshes the tool registry while suspension is still active: the hub
    // listener runs with enabled:false and clears the catalog.
    controller.setPolicy({ ...structuredClone(DEFAULT_FABRIC_CONFIG.capture), enabled: false });
    runner.getAllRegisteredTools();
    expect(catalog.get("deploy_release")).toBeUndefined();

    // session_start re-enables capture, but setPolicy(enabled) fires nothing —
    // the catalog would stay empty until restart without a forced refresh.
    controller.setPolicy(structuredClone(DEFAULT_FABRIC_CONFIG.capture));
    expect(catalog.get("deploy_release")).toBeUndefined();

    catalog.refresh();
    expect(catalog.get("deploy_release")).toBeDefined();
    expect(catalog.get("fabric_exec")).toBeUndefined();
  });

  it("traces missing and matching anchors without arguments, with bounded opt-in logging", async () => {
    const previous = process.env.PI_FABRIC_DEBUG_TOOL_CAPTURE;
    process.env.PI_FABRIC_DEBUG_TOOL_CAPTURE = "1";
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const anchor = tool("fabric_exec");
      const catalog = new CapturedToolCatalog();
      const controller = await installRegisteredToolCapture({ anchorDefinition: anchor, catalog });
      controllers.push(controller);
      runnerWith(registered(tool("unrelated"), "/private/path")).getAllRegisteredTools();
      const runner = runnerWith(registered(anchor, "/private/fabric"));
      runner.getAllRegisteredTools();
      expect(output.mock.calls[0]?.[0]).toContain('"event":"install"');
      expect(output.mock.calls[1]?.[0]).toContain('"anchor":false');
      expect(output.mock.calls[2]?.[0]).toContain('"anchor":true');
      for (let i = 0; i < 40; i++) runner.getAllRegisteredTools();
      expect(output).toHaveBeenCalledTimes(33);
      expect(output.mock.calls.at(-1)?.[0]).toContain("diagnostic limit reached");
      expect(JSON.stringify(output.mock.calls)).not.toContain("/private/");
      expect(catalog.runner).toBe(runner);
      controller.dispose();
    } finally {
      output.mockRestore();
      if (previous === undefined) delete process.env.PI_FABRIC_DEBUG_TOOL_CAPTURE;
      else process.env.PI_FABRIC_DEBUG_TOOL_CAPTURE = previous;
    }
  });

  it("classifies Fovea's graph-navigation tools as read-only", () => {
    const definitions = [
      "fovea_sketch",
      "fovea_focus",
      "fovea_dwell",
      "fovea_impact",
    ].map((name) => tool(name));
    const entries = definitions.map((definition) =>
      registered(definition, "/extensions/pi-fovea/src/index.ts"),
    );
    const runner = runnerWith(...entries);
    const catalog = new CapturedToolCatalog();

    catalog.replace(
      entries,
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/pi-fabric/index.ts",
    );

    expect(
      Object.fromEntries(catalog.list().map((entry) => [entry.name, entry.risk])),
    ).toEqual({
      fovea_dwell: "read",
      fovea_focus: "read",
      fovea_impact: "read",
      fovea_sketch: "read",
    });
  });

  it("does not attach to an unrelated tool with the Fabric tool name", async () => {
    const fabricTool = tool("fabric_exec");
    const collidingTool = tool("fabric_exec");
    const customTool = tool("custom_tool");
    const runner = runnerWith(
      registered(collidingTool, "/extensions/collision/index.ts"),
      registered(customTool, "/extensions/custom/index.ts"),
    );
    const catalog = new CapturedToolCatalog();
    const controller = await installRegisteredToolCapture({
      anchorDefinition: fabricTool,
      catalog,
    });
    controllers.push(controller);

    expect(runner.getAllRegisteredTools().map((entry) => entry.definition.name)).toEqual([
      "fabric_exec",
      "custom_tool",
    ]);
    expect(catalog.size).toBe(0);
  });

  it("updates dynamically and clears the catalog when capture disables", async () => {
    const fabricTool = tool("fabric_exec");
    const first = registered(tool("first_tool"), "/extensions/one/index.ts");
    const runner = runnerWith(registered(fabricTool, "/extensions/pi-fabric/index.ts"), first);
    const catalog = new CapturedToolCatalog();
    const controller = await installRegisteredToolCapture({
      anchorDefinition: fabricTool,
      catalog,
    });
    controllers.push(controller);

    runner.getAllRegisteredTools();
    const extension = (
      runner as unknown as { extensions: Array<{ tools: Map<string, RegisteredTool> }> }
    ).extensions[0];
    const second = registered(tool("second_tool"), "/extensions/two/index.ts");
    extension?.tools.set(second.definition.name, second);
    expect(runner.getAllRegisteredTools().map((entry) => entry.definition.name)).toEqual([
      "fabric_exec",
      "first_tool",
      "second_tool",
    ]);
    expect(catalog.list().map((entry) => entry.name)).toEqual(["first_tool", "second_tool"]);

    controller.setPolicy(
      effectiveToolCaptureConfig({
        fullCodeMode: false,
        capture: DEFAULT_FABRIC_CONFIG.capture,
      }),
    );
    expect(catalog.size).toBe(0);
    expect(runner.getAllRegisteredTools().map((entry) => entry.definition.name)).toEqual([
      "fabric_exec",
      "first_tool",
      "second_tool",
    ]);
  });

  it("notifies on every catalog refresh so ownership can be re-asserted", async () => {
    const fabricTool = tool("fabric_exec");
    const runner = runnerWith(
      registered(fabricTool, "/extensions/pi-fabric/index.ts"),
      registered(tool("deploy_release"), "/extensions/pi-deploy/index.ts"),
    );
    const catalog = new CapturedToolCatalog();
    let refreshes = 0;
    const controller = await installRegisteredToolCapture({
      anchorDefinition: fabricTool,
      catalog,
      onCatalogRefresh: () => {
        refreshes += 1;
      },
    });
    controllers.push(controller);

    expect(refreshes).toBe(0);
    runner.getAllRegisteredTools();
    expect(refreshes).toBe(1);
    runner.getAllRegisteredTools();
    expect(refreshes).toBe(2);

    controller.dispose();
    runner.getAllRegisteredTools();
    expect(refreshes).toBe(2);
  });

  it("observes and restores the actual Pi 1.0 bundled runner, not only the native SDK identity", async () => {
    const hostRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
    const constructors = await bundleExtensionRunnerConstructors(path.join(hostRoot, "dist/bundle"));
    expect(constructors.length).toBeGreaterThan(0);
    expect(constructors.every(Runner => Runner !== ExtensionRunner)).toBe(true);
    const originals = constructors.map(Runner => Runner.prototype.getAllRegisteredTools);
    const savedRoot = process.env.PI_PACKAGE_DIR;
    process.env.PI_PACKAGE_DIR = hostRoot;
    try {
      const anchor = tool("fabric_exec");
      const catalog = new CapturedToolCatalog();
      const controller = await installRegisteredToolCapture({ anchorDefinition: anchor, catalog });
      controllers.push(controller);
      for (const [index, Runner] of constructors.entries()) {
        expect(Runner.prototype.getAllRegisteredTools).not.toBe(originals[index]);
        const runner = Object.create(Runner.prototype) as ExtensionRunner;
        (runner as unknown as { extensions: Array<{ tools: Map<string, RegisteredTool> }> }).extensions = [{ tools: new Map([
          ["fabric_exec", registered(anchor, "/fabric/compiled.js")],
          ["actual_bundle_tool", registered(tool("actual_bundle_tool"), "/fixture.js")],
        ]) }];
        expect(runner.getAllRegisteredTools()).toHaveLength(2);
        expect(catalog.require("actual_bundle_tool").runner).toBe(runner);
      }
      controller.dispose();
      for (const [index, Runner] of constructors.entries()) expect(Runner.prototype.getAllRegisteredTools).toBe(originals[index]);
    } finally {
      if (savedRoot === undefined) delete process.env.PI_PACKAGE_DIR;
      else process.env.PI_PACKAGE_DIR = savedRoot;
    }
  });

  it("discovers the bundled runtime's distinct ExtensionRunner identity (pi >= 0.84.3)", async () => {
    // The pi >= 0.84.3 CLI runs from dist/bundle chunks with their own
    // ExtensionRunner class identity; capture must patch that copy or the live
    // host runner's registrations are never observed.
    const bundleDir = await mkdtemp(path.join(tmpdir(), "fabric-bundle-"));
    try {
      const chunksDir = path.join(bundleDir, "chunks");
      await mkdir(chunksDir, { recursive: true });
      await writeFile(
        path.join(chunksDir, "chunk-fake.js"),
        "export class ExtensionRunner { getAllRegisteredTools() { return []; } }\n",
      );
      await writeFile(path.join(chunksDir, "stats.json"), "{}");
      const found = await bundleExtensionRunnerConstructors(bundleDir);
      expect(found).toHaveLength(1);
      const discovered = found[0]!;
      expect(discovered).not.toBe(ExtensionRunner);
      expect(typeof discovered.prototype.getAllRegisteredTools).toBe("function");
      // Modular-layout installs (no dist/bundle) yield nothing.
      const plainDir = await mkdtemp(path.join(tmpdir(), "fabric-nobundle-"));
      try {
        expect(await bundleExtensionRunnerConstructors(plainDir)).toEqual([]);
      } finally {
        await rm(plainDir, { recursive: true, force: true });
      }
    } finally {
      await rm(bundleDir, { recursive: true, force: true });
    }
  });

  it("captures the embedded host realm's ExtensionRunner (pi-web sessiond)", async () => {
    // Embedded hosts (pi-web sessiond) run sessions in-process against their
    // own node_modules copy of the pi package while this extension runs from a
    // separate package realm, so the live ExtensionRunner is a distinct class
    // identity that neither PI_PACKAGE_DIR, the argv[1] walk-up, nor the
    // in-realm fallback import can find. Without entry-realm resolution the
    // hub patches a dead class and the captured catalog stays empty —
    // extensions.* vanishes from the guest.
    const hostDir = await mkdtemp(path.join(tmpdir(), "fabric-embedded-"));
    const savedArgv1 = process.argv[1]!;
    try {
      const packageRoot = path.join(hostDir, "node_modules", "@earendil-works", "pi-coding-agent");
      await mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await mkdir(path.join(hostDir, "dist", "server"), { recursive: true });
      await writeFile(
        path.join(hostDir, "package.json"),
        JSON.stringify({ name: "@example/embedded-host" }),
      );
      await writeFile(path.join(hostDir, "dist", "server", "entry.js"), "");
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@earendil-works/pi-coding-agent",
          type: "module",
          main: "dist/index.js",
        }),
      );
      await writeFile(
        path.join(packageRoot, "dist", "index.js"),
        [
          "export class ExtensionRunner {",
          "  getAllRegisteredTools() {",
          "    const registered = [];",
          "    for (const extension of this.extensions ?? []) {",
          "      for (const tool of extension.tools.values()) registered.push(tool);",
          "    }",
          "    return registered;",
          "  }",
          "}",
        ].join("\n") + "\n",
      );

      process.argv[1] = path.join(hostDir, "dist", "server", "entry.js");
      const fabricTool = tool("fabric_exec");
      const catalog = new CapturedToolCatalog();
      const controller = await installRegisteredToolCapture({
        anchorDefinition: fabricTool,
        catalog,
      });
      controllers.push(controller);

      const hostModule = (await import(
        pathToFileURL(path.join(packageRoot, "dist", "index.js")).href
      )) as {
        ExtensionRunner: abstract new () => { getAllRegisteredTools(): RegisteredTool[] };
      };
      const HostRunner = hostModule.ExtensionRunner;
      expect(HostRunner).not.toBe(ExtensionRunner);

      const runner = Object.create(HostRunner.prototype) as unknown as ExtensionRunner;
      (runner as unknown as { extensions: Array<{ tools: Map<string, RegisteredTool> }> })
        .extensions = [{
        tools: new Map([
          ["fabric_exec", registered(fabricTool, "/extensions/pi-fabric/index.ts")],
          ["box_list", registered(tool("box_list"), "/extensions/pi-box/index.ts")],
        ]),
      }];

      expect(catalog.size).toBe(0);
      expect(runner.getAllRegisteredTools().map((entry) => entry.definition.name)).toEqual([
        "fabric_exec",
        "box_list",
      ]);
      expect(catalog.list().map((entry) => entry.name)).toEqual(["box_list"]);
    } finally {
      process.argv[1] = savedArgv1;
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("captures the runner a host advertises for its private SDK copy (pi-durable worker)", async () => {
    // The durable worker runs sessions on the aliased pi-fabric-worker-sdk. In
    // hoisted layouts that is a distinct class from the peer copy the entry
    // realm finds, so only the host's advertisement reaches the live runner.
    class PrivateSdkRunner {
      extensions: Array<{ tools: Map<string, RegisteredTool> }> = [];
      getAllRegisteredTools(): RegisteredTool[] {
        return this.extensions.flatMap((extension) => [...extension.tools.values()]);
      }
    }
    const key = Symbol.for("pi-fabric.host-extension-runners.v1");
    const holder = globalThis as typeof globalThis & { [key: symbol]: Set<unknown> | undefined };
    const saved = holder[key];
    holder[key] = new Set([PrivateSdkRunner]);
    const peerOriginal = ExtensionRunner.prototype.getAllRegisteredTools;
    try {
      const fabricTool = tool("fabric_exec");
      const catalog = new CapturedToolCatalog();
      controllers.push(await installRegisteredToolCapture({ anchorDefinition: fabricTool, catalog }));
      // The advertising host runs every session on its own copy: the peer SDK
      // the entry realm resolves is never imported or patched there.
      expect(ExtensionRunner.prototype.getAllRegisteredTools).toBe(peerOriginal);
      const runner = new PrivateSdkRunner();
      runner.extensions = [{ tools: new Map([
        ["fabric_exec", registered(fabricTool, "/extensions/pi-fabric/index.ts")],
      ]) }];
      expect(catalog.runner).toBeUndefined();
      runner.getAllRegisteredTools();
      expect(catalog.runner).toBe(runner);
    } finally {
      holder[key] = saved;
    }
  });

  it.each(["/$bunfs/root/pi", "B:/~BUN/root/pi.exe", "file:///B:/%7EBUN/root/pi.exe"])("patches the mapped SDK instead of PI_PACKAGE_DIR for compiled entry %s", async (entry) => {
    // A release binary runs its embedded SDK from Bun's virtual file system and
    // maps that SDK for the extensions it loads. A Pi package on disk is a dead
    // class there, even when PI_PACKAGE_DIR names it.
    const packageRoot = await mkdtemp(path.join(tmpdir(), "fabric-binary-pkg-"));
    const savedArgv1 = process.argv[1]!;
    const savedRoot = process.env.PI_PACKAGE_DIR;
    try {
      await mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module" }));
      await writeFile(path.join(packageRoot, "dist", "index.js"), "export class ExtensionRunner { getAllRegisteredTools() { return []; } }\n");
      const DiskRunner = ((await import(pathToFileURL(path.join(packageRoot, "dist", "index.js")).href)) as { ExtensionRunner: typeof ExtensionRunner }).ExtensionRunner;
      const diskOriginal = DiskRunner.prototype.getAllRegisteredTools;
      process.env.PI_PACKAGE_DIR = packageRoot;
      process.argv[1] = entry;
      const anchor = tool("fabric_exec");
      const catalog = new CapturedToolCatalog();
      controllers.push(await installRegisteredToolCapture({ anchorDefinition: anchor, catalog }));
      expect(DiskRunner.prototype.getAllRegisteredTools).toBe(diskOriginal);
      const runner = runnerWith(registered(anchor, "/fabric/compiled.js"), registered(tool("binary_tool"), "/fixture.js"));
      runner.getAllRegisteredTools();
      expect(catalog.runner).toBe(runner);
      expect(catalog.runnerUnavailable).toBe(false);
    } finally {
      process.argv[1] = savedArgv1;
      if (savedRoot === undefined) delete process.env.PI_PACKAGE_DIR;
      else process.env.PI_PACKAGE_DIR = savedRoot;
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it.each(["/$bunfs/root/pi", "B:/~BUN/root/pi.exe", "file:///B:/%7EBUN/root/pi.exe"])("uses the entry-mapped host SDK instead of a native peer for %s (#342)", async (entry) => {
    // The bootstrap is loaded by Pi's virtual-module realm. Capture can live
    // in a natively imported chunk, where a bare SDK import succeeds but
    // resolves a different (unused) class. Finding that class is not capture.
    class MappedRunner {
      extensions: Array<{ tools: Map<string, RegisteredTool> }> = [];
      getAllRegisteredTools(): RegisteredTool[] {
        return this.extensions.flatMap(extension => [...extension.tools.values()]);
      }
    }
    const key = Symbol.for("pi-fabric.hostSdkLoader");
    const registry = globalThis as Record<symbol, unknown>;
    const savedLoader = registry[key];
    const savedArgv1 = process.argv[1];
    const savedRoot = process.env.PI_PACKAGE_DIR;
    const nativeOriginal = ExtensionRunner.prototype.getAllRegisteredTools;
    const mappedOriginal = MappedRunner.prototype.getAllRegisteredTools;
    const loader = vi.fn(async () => ({ ExtensionRunner: MappedRunner }));
    registry[key] = loader;
    process.argv[1] = entry;
    delete process.env.PI_PACKAGE_DIR;
    try {
      const anchor = tool("fabric_exec");
      const catalog = new CapturedToolCatalog();
      const controller = await installRegisteredToolCapture({ anchorDefinition: anchor, catalog });
      controllers.push(controller);
      const runner = new MappedRunner();
      runner.extensions = [{ tools: new Map([
        ["fabric_exec", registered(anchor, "/fabric/compiled.js")],
        ["mapped_tool", registered(tool("mapped_tool"), "/fixture.js")],
      ]) }];
      runner.getAllRegisteredTools();
      expect(catalog.runner).toBe(runner);
      expect(catalog.require("mapped_tool").runner).toBe(runner);
      expect(catalog.runnerUnavailable).toBe(false);
      expect(loader).toHaveBeenCalledTimes(1);
      expect(ExtensionRunner.prototype.getAllRegisteredTools).toBe(nativeOriginal);
      controller.dispose();
      expect(MappedRunner.prototype.getAllRegisteredTools).toBe(mappedOriginal);
    } finally {
      if (savedLoader === undefined) delete registry[key];
      else registry[key] = savedLoader;
      process.argv[1] = savedArgv1!;
      if (savedRoot === undefined) delete process.env.PI_PACKAGE_DIR;
      else process.env.PI_PACKAGE_DIR = savedRoot;
    }
  });

  describe("in a running Pi CLI", () => {
    const hostRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
    const bundledRunner = async () => ((await import(
      pathToFileURL(path.join(hostRoot, "dist", "bundle", "index.js")).href
    )) as { ExtensionRunner: typeof ExtensionRunner }).ExtensionRunner;
    const asCli = async (cli: string, run: () => Promise<void>) => {
      const savedArgv1 = process.argv[1]!;
      const savedRoot = process.env.PI_PACKAGE_DIR;
      process.argv[1] = cli;
      delete process.env.PI_PACKAGE_DIR;
      try {
        await run();
      } finally {
        process.argv[1] = savedArgv1;
        if (savedRoot === undefined) delete process.env.PI_PACKAGE_DIR;
        else process.env.PI_PACKAGE_DIR = savedRoot;
      }
    };
    const install = async () => {
      const controller = await installRegisteredToolCapture({ anchorDefinition: tool("fabric_exec"), catalog: new CapturedToolCatalog() });
      controllers.push(controller);
      return controller;
    };

    it("patches only the bundle's runner in the bundled CLI, via its SDK entry", async () => {
      // Pi's published bin is dist/bundle/cli.js. Its live runner is the bundle
      // class; patching the unbundled dist/index.js copy as well meant
      // evaluating that whole second SDK (and compile-caching it on exit).
      const Bundled = await bundledRunner();
      expect(Bundled).not.toBe(ExtensionRunner);
      const bundledOriginal = Bundled.prototype.getAllRegisteredTools;
      const unbundledOriginal = ExtensionRunner.prototype.getAllRegisteredTools;
      await asCli(path.join(hostRoot, "dist", "bundle", "cli.js"), async () => {
        const controller = await install();
        expect(Bundled.prototype.getAllRegisteredTools).not.toBe(bundledOriginal);
        expect(ExtensionRunner.prototype.getAllRegisteredTools).toBe(unbundledOriginal);
        controller.dispose();
        expect(Bundled.prototype.getAllRegisteredTools).toBe(bundledOriginal);
      });
    });

    it("patches only the unbundled runner in the unbundled CLI", async () => {
      const Bundled = await bundledRunner();
      const bundledOriginal = Bundled.prototype.getAllRegisteredTools;
      const unbundledOriginal = ExtensionRunner.prototype.getAllRegisteredTools;
      await asCli(path.join(hostRoot, "dist", "cli.js"), async () => {
        const controller = await install();
        expect(ExtensionRunner.prototype.getAllRegisteredTools).not.toBe(unbundledOriginal);
        expect(Bundled.prototype.getAllRegisteredTools).toBe(bundledOriginal);
        controller.dispose();
        expect(ExtensionRunner.prototype.getAllRegisteredTools).toBe(unbundledOriginal);
      });
    });
  });
});
