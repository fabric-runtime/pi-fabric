import type {
  AgentTransportAdapter,
  AgentTransportHandle,
  AgentTransportLaunch,
} from "../types.js";
import { EXTERNAL_TRANSPORT_LIVENESS_POLL_INTERVAL_MS } from "../constants.js";
import {
  commandAvailable,
  executeFile,
  launchCommand,
  launchWrapped,
  processIsAlive,
} from "./process-utils.js";

interface LocaltermSession {
  id: string;
  pid: number;
}

export class LocaltermTransport implements AgentTransportAdapter {
  readonly kind = "localterm" as const;

  async available(): Promise<boolean> {
    if (!(await commandAvailable("localterm"))) return false;
    try {
      await executeFile("localterm", ["session", "ls", "--json"], { timeoutMs: 3_000 });
      return true;
    } catch {
      return false;
    }
  }

  launch(request: AgentTransportLaunch): Promise<AgentTransportHandle> {
    return launchWrapped(this.kind, request, () => this.#launch(request));
  }

  async #launch(request: AgentTransportLaunch): Promise<AgentTransportHandle> {
    const command = `${await launchCommand(request)}; exit $?`;
    const { stdout } = await executeFile("localterm", [
      "session",
      "new",
      "--cwd",
      request.cwd,
      "--cmd",
      command,
      "--name",
      request.name,
      "--json",
    ]);
    const session = JSON.parse(stdout) as LocaltermSession;
    if (!session.id || !Number.isSafeInteger(session.pid) || session.pid <= 0) {
      throw new Error("LocalTerm did not return a valid session");
    }
    return {
      kind: this.kind,
      livenessPollIntervalMs: EXTERNAL_TRANSPORT_LIVENESS_POLL_INTERVAL_MS,
      sessionId: session.id,
      attachCommand: `localterm session attach ${session.id}`,
      async isAlive() {
        return processIsAlive(session.pid);
      },
      async stop() {
        try {
          await executeFile("localterm", ["session", "kill", session.id]);
        } catch { /* session already exited */ }
      },
    };
  }
}
