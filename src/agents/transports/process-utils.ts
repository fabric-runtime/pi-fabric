import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentTransportHandle, AgentTransportLaunch } from "../types.js";

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export const executeFile = (
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecFileResult> =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

/** Windows resolves bare names through PATHEXT; POSIX needs the execute bit. */
const executableNames = (command: string, env: NodeJS.ProcessEnv): string[] => {
  if (process.platform !== "win32" || path.extname(command) !== "") return [command];
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension !== "");
  return [command, ...extensions.map((extension) => command + extension)];
};

const unquotePathEntry = (entry: string): string => {
  const trimmed = entry.trim();
  return trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
};

const isExecutableFile = async (candidate: string): Promise<boolean> => {
  try {
    const stats = await fs.promises.stat(candidate);
    if (!stats.isFile()) return false;
    // Windows has no execute bit; PATHEXT already narrowed the candidate name.
    return process.platform === "win32" || (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

/**
 * PATH lookup that never shells out: Windows runners reach this code with no
 * `sh` on PATH, and a login shell may rewrite PATH behind the caller's back.
 */
export const commandAvailable = async (
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> => {
  const names = executableNames(command, env);
  for (const entry of (env.PATH ?? "").split(path.delimiter)) {
    const directory = unquotePathEntry(entry);
    if (directory === "") continue;
    for (const name of names) {
      if (await isExecutableFile(path.join(directory, name))) return true;
    }
  }
  return false;
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export const processIsAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // On Windows, EPERM means the process exists but cannot be opened for
    // signaling; only ESRCH (or other errors) mean it is gone.
    return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const GENERIC_RUNTIME = /^(node|bun)(\.exe)?$/;

export interface ScriptRuntimeOptions {
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Require Node.js specifically; used by the Node-process executor whose
   *  `--eval`/`--input-type=module` flags are Node-only. */
  requireNode?: boolean;
  /** Require Bun specifically; used by the Bun-process executor. */
  requireBun?: boolean;
}

const runtimeOverride = (env: NodeJS.ProcessEnv): string | undefined => {
  const value = env.PI_FABRIC_NODE_BINARY;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const isGenericRuntime = (execPath: string, requireNode: boolean, requireBun = false): boolean => {
  const name = path.basename(execPath).toLowerCase();
  return GENERIC_RUNTIME.test(name)
    && (!requireNode || name.startsWith("node"))
    && (!requireBun || name.startsWith("bun"));
};

const missingRuntimeError = (execPath: string, requireNode: boolean, requireBun = false): Error => {
  const required = requireNode
    ? "a Node.js runtime"
    : requireBun
      ? "a Bun runtime"
      : "a Node.js or Bun runtime";
  const shape = requireNode ? "(not node)" : requireBun ? "(not bun)" : "(not node/bun)";
  return new Error(
    `Fabric requires ${required} to launch a JavaScript worker, but ` +
      `process.execPath is ${execPath} ${shape} and PI_FABRIC_NODE_BINARY is unset. ` +
      "Install Node.js or Bun, or set PI_FABRIC_NODE_BINARY to the runtime binary.",
  );
};

// Transports launch the worker (a .js module) as `<runtime> worker.js args`.
// Under the new Bun-compiled pi binary, process.execPath is the pi executable,
// not node/bun, so it cannot run an arbitrary script. Resolve a real runtime
// before spawning: reuse process.execPath when it IS node/bun, else fall back
// to PI_FABRIC_NODE_BINARY, then the first node/bun on PATH.
const resolveScriptRuntimeUncached = async (options: ScriptRuntimeOptions = {}): Promise<string> => {
  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const requireNode = options.requireNode === true;
  const requireBun = options.requireBun === true;
  if (isGenericRuntime(execPath, requireNode, requireBun)) return execPath;
  const override = runtimeOverride(env);
  if (override) return override;
  for (const candidate of requireNode ? ["node"] : requireBun ? ["bun"] : ["node", "bun"]) {
    if (await commandAvailable(candidate)) return candidate;
  }
  throw missingRuntimeError(execPath, requireNode, requireBun);
};

let cachedDefaultRuntime: string | undefined;
export const resolveScriptRuntime = async (options?: ScriptRuntimeOptions): Promise<string> => {
  if (
    options &&
    (options.execPath !== undefined ||
      options.env !== undefined ||
      options.requireNode !== undefined ||
      options.requireBun !== undefined)
  ) {
    return resolveScriptRuntimeUncached(options);
  }
  if (cachedDefaultRuntime) return cachedDefaultRuntime;
  cachedDefaultRuntime = await resolveScriptRuntimeUncached();
  return cachedDefaultRuntime;
};

// Synchronous variant for callers that already run under a real runtime (e.g.
// the worker, which a transport always launches via the resolved runtime). No
// PATH lookup; throws if the current process is the bundled binary with no
// override set.
export const resolveScriptRuntimeSync = (options: ScriptRuntimeOptions = {}): string => {
  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const requireNode = options.requireNode === true;
  const requireBun = options.requireBun === true;
  if (isGenericRuntime(execPath, requireNode, requireBun)) return execPath;
  const override = runtimeOverride(env);
  if (override) return override;
  throw missingRuntimeError(execPath, requireNode, requireBun);
};

const typescriptWorker = (workerPath: string): boolean =>
  /.[cm]?tsx?$/i.test(path.extname(workerPath));

const runtimeOptionsForWorker = (
  workerPath: string,
  options?: ScriptRuntimeOptions,
): ScriptRuntimeOptions | undefined => {
  if (!typescriptWorker(workerPath) || options?.requireNode || options?.requireBun) return options;
  return { ...options, requireBun: true };
};

export const scriptSpawnArgs = async (
  workerPath: string,
  workerArguments: readonly string[],
  options?: ScriptRuntimeOptions,
): Promise<string[]> => {
  const runtime = await resolveScriptRuntime(runtimeOptionsForWorker(workerPath, options));
  return [runtime, workerPath, ...workerArguments];
};

export const workerCommand = async (
  workerPath: string,
  workerArguments: string[],
): Promise<string> =>
  (await scriptSpawnArgs(workerPath, workerArguments)).map(shellQuote).join(" ");

/**
 * Environment the `agents.launchWrapper` process receives, so it can choose
 * grants without parsing worker arguments. Empty without a wrapper.
 */
export const launchWrapperEnvironment = (request: AgentTransportLaunch): Record<string, string> => {
  const wrapper = request.launchWrapper;
  if (!wrapper) return {};
  return {
    PI_FABRIC_LAUNCH_RUN_ID: request.id,
    PI_FABRIC_LAUNCH_CWD: request.cwd,
    PI_FABRIC_LAUNCH_RUN_DIRECTORY: wrapper.runDirectory,
    ...(wrapper.writePolicy ? { PI_FABRIC_LAUNCH_WRITE_POLICY: JSON.stringify(wrapper.writePolicy) } : {}),
    PI_FABRIC_LAUNCH_DEPTH: String(wrapper.depth),
  };
};

/**
 * The argv a transport executes: `[...launchWrapper, runtime, workerPath,
 * ...workerArguments]`, or the plain worker argv without a wrapper.
 * `resolveRuntime` lets a transport whose service has its own PATH pin the
 * runtime before the wrapper prefix is added.
 */
export const launchArgv = async (
  request: AgentTransportLaunch,
  resolveRuntime?: (runtime: string) => Promise<string>,
): Promise<string[]> => {
  const argv = await scriptSpawnArgs(request.workerPath, request.workerArguments);
  if (resolveRuntime) argv[0] = await resolveRuntime(argv[0]!);
  return request.launchWrapper ? [...request.launchWrapper.argv, ...argv] : argv;
};

const ENV_EXECUTABLE = "/usr/bin/env";

/**
 * `launchArgv` for a transport that cannot set the child's environment
 * itself (a terminal session or service): with a wrapper, `/usr/bin/env` sets
 * the wrapper environment and execs the wrapper, so every value stays one argv
 * entry and nothing is interpolated into a shell.
 */
export const environmentLaunchArgv = async (
  request: AgentTransportLaunch,
  resolveRuntime?: (runtime: string) => Promise<string>,
): Promise<string[]> => {
  const argv = await launchArgv(request, resolveRuntime);
  if (!request.launchWrapper) return argv;
  if (process.platform === "win32") {
    throw new Error("agents.launchWrapper needs the process transport on Windows");
  }
  const assignments = Object.entries(launchWrapperEnvironment(request)).map(([name, value]) => `${name}=${value}`);
  return [ENV_EXECUTABLE, ...assignments, ...argv];
};

/** One quoted shell command line, for transports that take one (tmux, LocalTerm). */
export const launchCommand = async (request: AgentTransportLaunch): Promise<string> =>
  (await environmentLaunchArgv(request)).map(shellQuote).join(" ");

/**
 * Run a transport launch under `agents.launchWrapper`. A wrapper that is not
 * an executable file yields a handle that is already dead, so the run takes
 * the startup-failure path (bounded startup retries, then failed) with an
 * error naming the wrapper. A transport that captures no stderr reports the
 * wrapper instead, so a wrapper that exits early is named too.
 */
export const launchWrapped = async (
  kind: AgentTransportHandle["kind"],
  request: AgentTransportLaunch,
  launch: () => Promise<AgentTransportHandle>,
): Promise<AgentTransportHandle> => {
  const wrapper = request.launchWrapper?.argv[0];
  if (wrapper === undefined) return launch();
  if (!(await isExecutableFile(wrapper))) {
    return {
      kind,
      readStderr: () => `agents.launchWrapper ${wrapper} is not an executable file`,
      isAlive: async () => false,
      stop: async () => {},
    };
  }
  const handle = await launch();
  return handle.readStderr
    ? handle
    : { ...handle, readStderr: () => `no stderr captured; launched under agents.launchWrapper ${wrapper}` };
};

/** Start one Fabric worker launch as a detached process. */
export const spawnLaunch = async (
  request: AgentTransportLaunch,
  options: { captureStderr?: boolean } = {},
): Promise<DetachedProcess> => {
  const [command, ...args] = await launchArgv(request);
  if (!request.launchWrapper) return spawnArgv(command!, args, request.cwd, options);
  return spawnArgv(command!, args, request.cwd, {
    ...options,
    env: { ...process.env, ...launchWrapperEnvironment(request) },
    exitNote: `launched under agents.launchWrapper ${request.launchWrapper.argv[0]}`,
  });
};

export interface DetachedProcess {
  pid: number;
  stop(): Promise<void>;
  isAlive(): Promise<boolean>;
  readStderr(): string;
}

/**
 * Start a script directly under a resolved runtime, with no launch wrapper.
 * Only the resident durable host uses this; it refuses to start while
 * `agents.launchWrapper` is set (see ResidencyClient).
 */
export const spawnDetached = async (
  workerPath: string,
  workerArguments: string[],
  cwd: string,
  options: { captureStderr?: boolean } = {},
): Promise<DetachedProcess> => {
  const runtime = await resolveScriptRuntime(runtimeOptionsForWorker(workerPath));
  return spawnArgv(runtime, [workerPath, ...workerArguments], cwd, options);
};

const spawnArgv = async (
  command: string,
  args: string[],
  cwd: string,
  options: { captureStderr?: boolean; env?: NodeJS.ProcessEnv; exitNote?: string },
): Promise<DetachedProcess> => {
  const child = spawn(command, args, {
    cwd,
    detached: process.platform !== "win32",
    // Resident hosts must remain independent of the launching process's pipes.
    stdio: ["ignore", "ignore", options.captureStderr ? "pipe" : "ignore"],
    ...(options.env ? { env: options.env } : {}),
  });
  // A wrapped launch reports how its process ended, so a wrapper that fails
  // before the worker writes a record is named in the run's error.
  let exit: string | undefined;
  if (options.exitNote) {
    child.once("exit", (code, signal) => {
      exit = `${options.exitNote}, which exited with ${signal ? `signal ${signal}` : `code ${code}`}`;
    });
  }
  // Drain throughout the run, retaining only a bounded UTF-8 tail in memory.
  // No disk log can grow without bound or keep secrets after run cleanup.
  const decoder = new StringDecoder("utf8");
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + decoder.write(chunk)).slice(-20_000);
  });
  child.stderr?.on("end", () => { stderr = (stderr + decoder.end()).slice(-20_000); });
  child.stderr?.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const pid = child.pid!;
  child.unref();
  // A diagnostic pipe must not keep the owner process alive on its own.
  (child.stderr as (NodeJS.ReadableStream & { unref?: () => void }) | null)?.unref?.();
  return {
    pid,
    readStderr: () => (exit ? (stderr.trim() ? `${stderr.trim()}\n${exit}` : exit) : stderr),
    async stop() {
      try {
        process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
      } catch { /* process group already exited */ }
    },
    async isAlive() {
      return processIsAlive(pid);
    },
  };
};
