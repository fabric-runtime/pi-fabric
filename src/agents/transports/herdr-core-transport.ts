import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import type { AgentTransportAdapter, AgentTransportHandle, AgentTransportLaunch } from "../types.js";
import { EXTERNAL_TRANSPORT_LIVENESS_POLL_INTERVAL_MS } from "../constants.js";
import { environmentLaunchArgv, launchWrapped } from "./process-utils.js";
import { herdrCoreSocketRequest, HerdrCoreRpcError } from "./herdr-core-socket.js";

const missing = (error: unknown): boolean => error instanceof HerdrCoreRpcError && error.kind === "not_found";
const terminal = (value: unknown): { address: string; state: string } => {
  const result = value as { address?: unknown; state?: unknown } | null;
  // Only local canonical addresses are accepted: never interpolate arbitrary shell text.
  if (!result || typeof result.address !== "string" || !/^t[0-9a-z]+$/.test(result.address) ||
      (result.state !== "live" && result.state !== "finished")) {
    throw new Error("Herdr Core returned an invalid terminal");
  }
  return { address: result.address, state: result.state };
};

export class HerdrCoreTransport implements AgentTransportAdapter {
  readonly kind = "herdr-core" as const;
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async available(): Promise<boolean> {
    if (!this.environment.HC_TERMINAL_ID || !this.environment.HC_TERMINAL_SOCKET) return false;
    try {
      const hello = await this.#request("hello", { generation: 1, framed: false }) as {
        generation?: number; framed?: boolean; methods?: string[];
      };
      return hello?.generation === 1 && hello.framed === false && Array.isArray(hello.methods) &&
        ["terminal.run", "terminal.get", "terminal.kill"].every((method) => hello.methods!.includes(method));
    } catch { return false; }
  }

  launch(request: AgentTransportLaunch): Promise<AgentTransportHandle> {
    return launchWrapped(this.kind, request, () => this.#launch(request));
  }

  async #launch(request: AgentTransportLaunch): Promise<AgentTransportHandle> {
    const caller = this.environment.HC_TERMINAL_ID;
    if (!caller) throw new Error("Herdr Core transport requires HC_TERMINAL_ID");
    // The core has its own PATH and templates. Resolve a bare runtime on the host
    // so it cannot accidentally select a template or a different executable;
    // a launch wrapper's own first entry is already absolute.
    const argv = await environmentLaunchArgv(request, (runtime) => this.#absoluteRuntime(runtime));
    const prefix = request.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 7) || "agent";
    const child = terminal(await this.#request("terminal.run", {
      argv, cwd: request.cwd, name: `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      caller, parent: caller, no_notify: true, wait: false, keep: false, outlive_parent: false,
    }));
    const params = { terminal: child.address, caller };
    return {
      kind: this.kind,
      sessionId: child.address,
      attachCommand: `hc attach ${child.address}`,
      livenessPollIntervalMs: EXTERNAL_TRANSPORT_LIVENESS_POLL_INTERVAL_MS,
      isAlive: async () => {
        try {
          const current = terminal(await this.#request("terminal.get", params));
          if (current.address !== child.address) throw new Error("Herdr Core terminal address changed");
          return current.state === "live";
        } catch (error) {
          if (missing(error)) return false;
          throw error;
        }
      },
      stop: async () => {
        try { await this.#request("terminal.kill", params); }
        catch (error) { if (!missing(error)) throw error; }
      },
    };
  }

  async #absoluteRuntime(runtime: string): Promise<string> {
    if (path.isAbsolute(runtime)) return runtime;
    const names = process.platform === "win32" && !path.extname(runtime)
      ? [runtime, ...(this.environment.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((ext) => runtime + ext)]
      : [runtime];
    for (const directory of (this.environment.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      for (const name of names) {
        const candidate = path.resolve(directory.replace(/^"|"$/g, ""), name);
        try {
          if ((await fs.stat(candidate)).isFile()) {
            await fs.access(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
            return candidate;
          }
        } catch { /* Try the next PATH entry. */ }
      }
    }
    throw new Error("Herdr Core could not resolve an absolute worker runtime");
  }

  #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.environment.HC_TERMINAL_SOCKET;
    if (!socket) return Promise.reject(new Error("Herdr Core transport requires HC_TERMINAL_SOCKET"));
    return herdrCoreSocketRequest(socket, method, params);
  }
}
