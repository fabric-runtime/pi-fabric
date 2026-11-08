import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HOST = "@earendil-works/pi-coding-agent";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const link = (target: string, file: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(fs.realpathSync(target), file, process.platform === "win32" ? "junction" : "dir");
};

// A Pi managed install (`pi install npm:pi-fabric`) outside the checkout. Pi
// installs with peers omitted, so the host SDK is never on disk beside Fabric;
// every other package Fabric imports is. Ancestor node_modules and development
// peers must not rescue the import.
const managedInstall = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabric-managed-install-")));
  roots.push(root);
  const modules = path.join(root, "agent", "npm", "node_modules");
  const fabric = path.join(modules, "pi-fabric");
  fs.mkdirSync(fabric, { recursive: true });
  fs.cpSync(path.resolve("dist"), path.join(fabric, "dist"), { recursive: true });
  fs.copyFileSync(path.resolve("package.json"), path.join(fabric, "package.json"));
  for (const name of fs.readdirSync(path.resolve("node_modules"))) {
    if (name.startsWith(".")) continue;
    const names = name.startsWith("@")
      ? fs.readdirSync(path.resolve("node_modules", name)).map(child => `${name}/${child}`)
      : [name];
    for (const dependency of names) {
      if (dependency !== HOST) link(path.resolve("node_modules", dependency), path.join(modules, dependency));
    }
  }
  fs.writeFileSync(path.join(root, "agent", "fabric.json"), JSON.stringify({
    configVersion: 4, components: [], fullCodeMode: true,
    agents: { enabled: false }, mcp: { enabled: false }, mesh: { enabled: false },
    memory: { enabled: false }, ui: { enabled: false, widget: "hidden" },
  }));
  for (const directory of ["home", "workspace"]) fs.mkdirSync(path.join(root, directory));
  return { root, fabric };
};

const run = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    // Print mode reads piped stdin to EOF; never leave it open.
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });

const isolatedEnv = (root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("PI_") || name === "NODE_PATH" || name === "NODE_OPTIONS") delete env[name];
  }
  return {
    ...env, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
    PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0", ...extra,
  };
};

describe("Pi managed install without a physical host SDK", () => {
  // The published bin, and the unbundled CLI that older launchers still use.
  it.each([
    "dist/bundle/cli.js", "dist/cli.js",
    ...(process.env.PI_FABRIC_TEST_PI_BINARY ? [process.env.PI_FABRIC_TEST_PI_BINARY] : []),
  ])("runs nested Pi tools through fabric_exec under %s", async (cli) => {
    const { root, fabric } = managedInstall();
    const file = path.join(root, "workspace", "fabric.txt");
    const binary = path.isAbsolute(cli);
    const { stdout, stderr } = await run(binary ? cli : process.execPath, [
      ...(!binary ? [path.join(fs.realpathSync(path.resolve("node_modules", HOST)), cli)] : []),
      "--offline", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
      "--no-context-files", "--no-approve", "--mode", "json", "--print",
      "--extension", path.resolve("tests/fixtures/managed-install-provider.ts"),
      "--extension", path.join(fabric, "dist", "extension-bootstrap.js"),
      "--model", "managed-install/probe", "Run the probe",
    ], { cwd: path.join(root, "workspace"), env: isolatedEnv(root, { FABRIC_PROBE_FILE: file, PI_FABRIC_DEBUG_TOOL_CAPTURE: "1" }) });
    const result = stdout.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, any>)
      .find(event => event.type === "tool_execution_end" && event.toolCallId === "probe-call");
    expect(result, stderr || stdout.slice(-2000)).toBeDefined();
    expect(result!.result.content[0].text).toBe("hello from probe\n");
    expect(result!.isError).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("hello from probe\n");
  }, 90_000);

  it("names the missing host SDK instead of a build chunk when no running Pi can supply it", async () => {
    const { root, fabric } = managedInstall();
    const probe = path.join(root, "probe.mjs");
    fs.writeFileSync(probe, [
      `const { loadHostSdk } = await import(${JSON.stringify(pathToFileURL(path.join(fabric, "dist", "core", "host-sdk.js")).href)});`,
      "await loadHostSdk().then(() => { process.exitCode = 2; }, error => { process.stderr.write(error.message); });",
    ].join("\n"));
    const { code, stderr } = await run(process.execPath, [probe], { cwd: root, env: isolatedEnv(root) });
    expect(code, stderr).toBe(0);
    expect(stderr).toContain("Pi Fabric could not load the Pi SDK");
    expect(stderr).toContain(HOST);
    expect(stderr).not.toContain("chunks");
  }, 30_000);
});
