import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { LocaltermTransport } from "../src/agents/transports/localterm-transport.js";
import { TmuxTransport } from "../src/agents/transports/tmux-transport.js";
import { launchWrapped, resolveScriptRuntimeSync, spawnLaunch } from "../src/agents/transports/process-utils.js";
import type { AgentTransportLaunch } from "../src/agents/types.js";
import { DEFAULT_FABRIC_CONFIG, loadFabricConfig, normalizeFabricConfig, saveFabricConfig } from "../src/config.js";
import { registerAgentRunner, type FabricRunnerCapabilities } from "../src/runners.js";
import { RESIDENT_HOST_FORMAT } from "../src/residency/protocol.js";
import { ResidencyClient } from "../src/residency/client.js";

const roots: string[] = [];
const managers: AgentManager[] = [];
const originalPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const directory = (prefix: string): string => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
};
const fakeWorker = path.resolve("tests/fixtures/fake-worker.mjs");

/** A wrapper that records its argv, cwd and launch environment, then runs what follows "--". */
const recordingWrapper = (root: string): { wrapper: string; record: string } => {
  const record = path.join(root, "wrapper-record.json");
  const wrapper = path.join(root, "wrapper.mjs");
  fs.writeFileSync(
    wrapper,
    `#!${resolveScriptRuntimeSync()}
import { spawnSync } from "node:child_process";
import fs from "node:fs";
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("PI_FABRIC_LAUNCH_")));
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env }));
const argv = process.argv.slice(2);
const [command, ...args] = argv.slice(argv.indexOf("--") + 1);
process.exit(spawnSync(command, args, { stdio: "inherit" }).status ?? 1);
`,
    { mode: 0o755 },
  );
  return { wrapper, record };
};

const manager = (root: string, launchWrapper?: string[]): AgentManager => {
  const created = new AgentManager(root, {
    ...DEFAULT_FABRIC_CONFIG.agents,
    timeoutMs: 20_000,
    sessionExport: false,
    ...(launchWrapper ? { launchWrapper } : {}),
  }, { workerPath: fakeWorker, runRoot: path.join(root, "runs"), fullCodeMode: false });
  managers.push(created);
  return created;
};

describe("agents.launchWrapper configuration", () => {
  it("is absent by default and keeps a valid argv prefix exactly", () => {
    expect(normalizeFabricConfig({}).agents.launchWrapper).toBeUndefined();
    expect(Object.hasOwn(normalizeFabricConfig({ agents: {} }).agents, "launchWrapper")).toBe(false);
    const launchWrapper = ["/opt/sandbox/bin/wrap", "--profile", "fabric worker", "--"];
    expect(normalizeFabricConfig({ agents: { launchWrapper } }).agents.launchWrapper).toEqual(launchWrapper);
    const longest = ["/bin/wrap", ...Array.from({ length: 31 }, (_, index) => `--flag-${index}`)];
    expect(normalizeFabricConfig({ agents: { launchWrapper: longest } }).agents.launchWrapper).toEqual(longest);
  });

  it("fails loudly on every invalid shape instead of running children unwrapped", () => {
    const invalid: unknown[] = [
      null,
      "/bin/wrap",
      {},
      [],
      ["relative/wrap"],
      ["wrap"],
      ["/bin/wrap", ""],
      ["/bin/wrap", 1],
      [""],
      ["/bin/wrap", "nul\0byte"],
      ["/bin/A=B"],
      ["/bin/wrap", ...Array.from({ length: 32 }, () => "x")],
    ];
    for (const launchWrapper of invalid) {
      expect(() => normalizeFabricConfig({ agents: { launchWrapper } }), JSON.stringify(launchWrapper))
        .toThrow("agents.launchWrapper");
    }
  });

  it("refuses to save an invalid value over a working configuration", () => {
    const root = directory("pi-fabric-wrapper-config-");
    const location = { cwd: root, agentDir: root, projectTrusted: false };
    const saved = saveFabricConfig(location, { agents: { launchWrapper: ["/bin/wrap"] } });
    const before = fs.readFileSync(saved.path, "utf8");
    expect(() => saveFabricConfig(location, { agents: { launchWrapper: ["wrap"] } })).toThrow("agents.launchWrapper");
    expect(fs.readFileSync(saved.path, "utf8")).toBe(before);
  });

  it("treats agents.launchWrapper as global-only so project .pi/fabric.json cannot set or disarm it", () => {
    const root = directory("pi-fabric-wrapper-scope-");
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "project");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });

    // Project config alone cannot inject launchWrapper, even when trusted.
    fs.writeFileSync(path.join(cwd, ".pi", "fabric.json"), JSON.stringify({
      agents: { launchWrapper: ["/bin/sh", "-c", "evil"] },
    }));
    expect(loadFabricConfig({ cwd, agentDir, projectTrusted: true }).agents.launchWrapper).toBeUndefined();

    // Project config cannot override or disarm a global launchWrapper either.
    fs.writeFileSync(path.join(agentDir, "fabric.json"), JSON.stringify({
      agents: { launchWrapper: ["/opt/sandbox/wrap", "--"] },
    }));
    expect(loadFabricConfig({ cwd, agentDir, projectTrusted: true }).agents.launchWrapper)
      .toEqual(["/opt/sandbox/wrap", "--"]);

    // Saving launchWrapper to project scope is refused.
    expect(() => saveFabricConfig(
      { cwd, agentDir, projectTrusted: true, scope: "project" },
      { agents: { launchWrapper: ["/bin/wrap"] } },
    )).toThrow(/global/);
  });

  it("refuses hosted runners while agents.launchWrapper is set", async () => {
    const root = directory("pi-fabric-wrapper-hosted-");
    const capabilities: FabricRunnerCapabilities = {
      recursiveFabric: false, steer: false, followUp: false, persistentSessions: false, kernels: false, handoff: false,
      modelDiscovery: false, imageInput: false, compaction: false, questions: false, sleep: false, writePolicy: false,
    };
    const unregister = registerAgentRunner({
      kind: "hosted", id: "hosted-probe", label: "Hosted Probe", capabilities,
      prepare: () => ({}),
      start: () => {},
      attach: () => {},
      liveness: () => "exited",
      stop: () => ({ confirmed: true }),
    });
    try {
      await expect(
        manager(root, ["/bin/wrap"]).run({ task: "probe", runner: "hosted-probe", transport: "process" }),
      ).rejects.toThrow(/hosted runner.*agents\.launchWrapper/);
    } finally {
      unregister();
    }
  });
});

describe.skipIf(process.platform === "win32")("agents.launchWrapper process transport", () => {
  it("runs the worker under the wrapper argv with the launch environment and an unchanged cwd", async () => {
    const root = directory("pi-fabric-wrapper-process-");
    const { wrapper, record } = recordingWrapper(root);
    const cwd = path.join(root, "agent cwd");
    fs.mkdirSync(cwd);
    const result = await manager(root, [wrapper, "--grant", "two words", "--"])
      .run({ task: "probe", transport: "process", extensions: false, cwd, readOnly: true });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
    const seen = JSON.parse(fs.readFileSync(record, "utf8")) as {
      argv: string[]; cwd: string; env: Record<string, string>;
    };
    expect(seen.argv.slice(0, 3)).toEqual(["--grant", "two words", "--"]);
    expect(path.basename(seen.argv[3]!)).toMatch(/^(node|bun)(\.exe)?$/);
    expect(seen.argv[4]).toBe(fakeWorker);
    expect(seen.argv.slice(5, 7)).toEqual(["--id", result.id]);
    expect(seen.cwd).toBe(cwd);
    expect(seen.env).toEqual({
      PI_FABRIC_LAUNCH_RUN_ID: result.id,
      PI_FABRIC_LAUNCH_CWD: cwd,
      PI_FABRIC_LAUNCH_RUN_DIRECTORY: path.join(root, "runs", result.id),
      PI_FABRIC_LAUNCH_WRITE_POLICY: JSON.stringify({ readOnly: true, writableRoots: [], shell: "deny" }),
      PI_FABRIC_LAUNCH_DEPTH: "1",
    });

    // Unconfined launches clear any inherited PI_FABRIC_LAUNCH_WRITE_POLICY.
    const prevPolicy = process.env.PI_FABRIC_LAUNCH_WRITE_POLICY;
    process.env.PI_FABRIC_LAUNCH_WRITE_POLICY = JSON.stringify({ readOnly: true, writableRoots: [], shell: "deny" });
    try {
      const unconfined = await manager(root, [wrapper, "--"]).run({ task: "probe", transport: "process", extensions: false, cwd });
      expect(unconfined.status).toBe("completed");
      const seenUnconfined = JSON.parse(fs.readFileSync(record, "utf8")) as { env: Record<string, string> };
      expect(seenUnconfined.env.PI_FABRIC_LAUNCH_WRITE_POLICY).toBeUndefined();
    } finally {
      if (prevPolicy === undefined) delete process.env.PI_FABRIC_LAUNCH_WRITE_POLICY;
      else process.env.PI_FABRIC_LAUNCH_WRITE_POLICY = prevPolicy;
    }
  });

  it("refuses a durable spawn on the manager itself before launching anything", async () => {
    const root = directory("pi-fabric-wrapper-durable-");
    const { wrapper, record } = recordingWrapper(root);
    await expect(manager(root, [wrapper, "--"]).spawn({ task: "probe", transport: "process", residency: "durable" }))
      .rejects.toThrow(/agents\.launchWrapper/);
    expect(fs.existsSync(record)).toBe(false);
    expect(fs.existsSync(path.join(root, "runs"))).toBe(false);
  });

  it("leaves the write policy out for an unconfined run", async () => {
    const root = directory("pi-fabric-wrapper-unconfined-");
    const { wrapper, record } = recordingWrapper(root);
    const result = await manager(root, [wrapper, "--"]).run({ task: "probe", transport: "process", extensions: false });
    expect(result.status).toBe("completed");
    const seen = JSON.parse(fs.readFileSync(record, "utf8")) as { env: Record<string, string> };
    expect(Object.keys(seen.env).sort()).toEqual([
      "PI_FABRIC_LAUNCH_CWD", "PI_FABRIC_LAUNCH_DEPTH", "PI_FABRIC_LAUNCH_RUN_DIRECTORY", "PI_FABRIC_LAUNCH_RUN_ID",
    ]);
  });

  it("fails the run, naming the wrapper, when the wrapper binary is missing", async () => {
    const root = directory("pi-fabric-wrapper-missing-");
    const missing = path.join(root, "no-such-wrapper");
    const started = Date.now();
    const result = await manager(root, [missing]).run({ task: "probe", transport: "process", extensions: false });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Agent transport exited without a result");
    expect(result.error).toContain(`agents.launchWrapper ${missing} is not an executable file`);
    // Bounded startup retries, not a retry loop until the run deadline.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("fails the run, naming the wrapper and its exit code, when the wrapper exits before the worker", async () => {
    const root = directory("pi-fabric-wrapper-exit-");
    const wrapper = path.join(root, "refuse.sh");
    fs.writeFileSync(wrapper, "#!/bin/sh\necho 'sandbox profile refused' >&2\nexit 7\n", { mode: 0o755 });
    const result = await manager(root, [wrapper]).run({ task: "probe", transport: "process", extensions: false });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("sandbox profile refused");
    expect(result.error).toContain(`agents.launchWrapper ${wrapper}, which exited with code 7`);
  });
});

describe("launchWrapped", () => {
  it("returns a dead handle naming the wrapper and the error code when the spawn itself fails", async () => {
    const root = directory("pi-fabric-wrapper-race-");
    const { wrapper } = recordingWrapper(root);
    const request = { ...shellLaunch(root, wrapper), cwd: root };
    // The wrapper passed the executable check, then disappeared before spawn.
    const failure = Object.assign(new Error(`spawn ${wrapper} ENOENT`), { code: "ENOENT", syscall: `spawn ${wrapper}`, path: wrapper });
    const handle = await launchWrapped("process", request, async () => { throw failure; });
    expect(await handle.isAlive()).toBe(false);
    expect(handle.readStderr?.()).toBe(`agents.launchWrapper ${wrapper} could not be started (ENOENT): spawn ${wrapper} ENOENT`);
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it("lets a launch error that is not the wrapper's spawn failure propagate", async () => {
    const root = directory("pi-fabric-wrapper-other-");
    const { wrapper } = recordingWrapper(root);
    const request = { ...shellLaunch(root, wrapper), cwd: root };
    const setting = new Error("Herdr transport requires HERDR_WORKSPACE_ID");
    await expect(launchWrapped("herdr", request, async () => { throw setting; })).rejects.toBe(setting);
    // An ENOENT for another executable (for example a missing tmux) is not the wrapper's either.
    const other = Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT", syscall: "spawn tmux", path: "tmux" });
    await expect(launchWrapped("tmux", request, async () => { throw other; })).rejects.toBe(other);
  });

  it.skipIf(process.platform === "win32")("turns a real spawn of a vanished wrapper into a dead handle", async () => {
    const root = directory("pi-fabric-wrapper-vanish-");
    const { wrapper } = recordingWrapper(root);
    const request = { ...shellLaunch(root, wrapper), cwd: root };
    const handle = await launchWrapped("process", request, async () => {
      fs.rmSync(wrapper);
      return { kind: "process", ...(await spawnLaunch(request)) };
    });
    expect(await handle.isAlive()).toBe(false);
    expect(handle.readStderr?.()).toMatch(new RegExp(`^agents\\.launchWrapper .* could not be started \\(ENOENT\\)`));
  });
});

const shellLaunch = (root: string, wrapper: string): AgentTransportLaunch => ({
  id: "0123456789abcdef0123456789abcdef",
  name: "quoted worker",
  cwd: path.join(root, "it's a \"cwd\" with $(touch x) spaces"),
  workerPath: "/fabric worker/worker.js",
  workerArguments: ["--task", "a 'quoted' \"arg\" $HOME ;"],
  launchWrapper: {
    argv: [wrapper, "--profile", "it's \"fine\""],
    runDirectory: path.join(root, "run dir 'one'"),
    writePolicy: { readOnly: false, writableRoots: [path.join(root, "root \"a\"")], shell: "deny" },
    depth: 2,
  },
});

/** Split a command line with sh itself, so the test sees what the shell would execute. */
const shellWords = (root: string, command: string): string[] => {
  const script = path.join(root, "words.sh");
  fs.writeFileSync(script, `#!/bin/sh\nfor word in "$@"; do printf '%s\\0' "$word"; done\n`, { mode: 0o755 });
  return execFileSync("/bin/sh", ["-c", `set -- ${command}; exec ${JSON.stringify(script)} "$@"`], { encoding: "utf8" })
    .split("\0").slice(0, -1);
};

describe.skipIf(process.platform === "win32")("agents.launchWrapper shell-command transports", () => {
  it("passes the tmux transport one quoted command with the launch environment as env arguments", async () => {
    const root = directory("pi-fabric-wrapper-tmux-");
    const wrapper = path.join(root, "wrap");
    fs.writeFileSync(wrapper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const log = path.join(root, "tmux-args");
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "tmux"), `#!/bin/sh\nfor word in "$@"; do printf '%s\\0' "$word"; done > ${JSON.stringify(log)}\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
    const launch = shellLaunch(root, wrapper);
    await new TmuxTransport().launch(launch);
    const args = fs.readFileSync(log, "utf8").split("\0").slice(0, -1);
    expect(args.slice(0, 6)).toEqual(["new-session", "-d", "-s", "pi-fabric-0123456789ab", "-c", launch.cwd]);
    expect(args).toHaveLength(7);
    const words = shellWords(root, args[6]!);
    expect(words).toEqual([
      "/usr/bin/env",
      `PI_FABRIC_LAUNCH_RUN_ID=${launch.id}`,
      `PI_FABRIC_LAUNCH_CWD=${launch.cwd}`,
      `PI_FABRIC_LAUNCH_RUN_DIRECTORY=${launch.launchWrapper!.runDirectory}`,
      `PI_FABRIC_LAUNCH_WRITE_POLICY=${JSON.stringify(launch.launchWrapper!.writePolicy)}`,
      "PI_FABRIC_LAUNCH_DEPTH=2",
      wrapper, "--profile", "it's \"fine\"",
      resolveScriptRuntimeSync(), "/fabric worker/worker.js", "--task", "a 'quoted' \"arg\" $HOME ;",
    ]);
  });

  it("runs the LocalTerm command through a real shell with exact values", async () => {
    const root = directory("pi-fabric-wrapper-localterm-");
    const record = path.join(root, "wrapper-record");
    const wrapper = path.join(root, "wrap");
    // Records what the wrapper actually received after the shell ran the command.
    fs.writeFileSync(wrapper, `#!/bin/sh
{ for word in "$@"; do printf '%s\\0' "$word"; done
  printf '%s\\0' "$PI_FABRIC_LAUNCH_CWD" "$PI_FABRIC_LAUNCH_RUN_DIRECTORY" "$PI_FABRIC_LAUNCH_WRITE_POLICY"; } > ${JSON.stringify(record)}
`, { mode: 0o755 });
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    // A fake LocalTerm that runs --cmd through sh, as the real daemon does.
    fs.writeFileSync(path.join(bin, "localterm"), `#!/bin/sh
while [ "$#" -gt 0 ]; do [ "$1" = "--cmd" ] && command="$2"; shift; done
/bin/sh -c "$command"
printf '{"id":"session-1","pid":%s}\\n' "$$"
`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
    const launch = shellLaunch(root, wrapper);
    await new LocaltermTransport().launch(launch);
    expect(fs.readFileSync(record, "utf8").split("\0").slice(0, -1)).toEqual([
      "--profile", "it's \"fine\"",
      resolveScriptRuntimeSync(), "/fabric worker/worker.js", "--task", "a 'quoted' \"arg\" $HOME ;",
      launch.cwd,
      launch.launchWrapper!.runDirectory,
      JSON.stringify(launch.launchWrapper!.writePolicy),
    ]);
    expect(fs.existsSync(path.join(process.cwd(), "x"))).toBe(false);
  });
});

describe("agents.launchWrapper durable residency", () => {
  it("refuses to start the resident host while a launch wrapper is set", async () => {
    const root = directory("pi-fabric-wrapper-durable-");
    const residencyRoot = path.join(root, "residency");
    const hostPath = path.join(root, "host-started.mjs");
    const client = new ResidencyClient({
      config: {
        format: RESIDENT_HOST_FORMAT,
        rootId: "session:wrapper",
        sessionId: "wrapper",
        cwd: root,
        projectRoot: root,
        meshRoot: path.join(root, "mesh"),
        actorRoot: path.join(root, "actors"),
        residencyRoot,
        fullCodeMode: false,
        agents: { ...DEFAULT_FABRIC_CONFIG.agents, launchWrapper: ["/opt/sandbox/wrap"] },
        mesh: DEFAULT_FABRIC_CONFIG.mesh,
        retention: DEFAULT_FABRIC_CONFIG.retention,
        workerPath: fakeWorker,
        fabricExtensionPath: path.join(root, "index.js"),
        piBinary: "pi",
        claudeBinary: "claude",
        vedaBinary: "veda",
      },
      mesh: {} as never,
      participants: {} as never,
      mainAgent: { local: false } as never,
      hostPath,
    });
    await expect(client.ensureHost()).rejects.toThrow(/agents\.launchWrapper/);
    await expect(client.spawnAgent({ task: "durable", residency: "durable" })).rejects.toThrow(/agents\.launchWrapper/);
    await expect(client.ensureActor("actor")).rejects.toThrow(/agents\.launchWrapper/);
    // Nothing was written or started for the host.
    expect(fs.existsSync(path.join(residencyRoot, "config.json"))).toBe(false);
    await client.close();
  });
});