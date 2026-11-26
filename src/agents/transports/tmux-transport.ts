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
} from "./process-utils.js";

const sessionName = (id: string): string => `pi-fabric-${id.slice(0, 12)}`;

export class TmuxTransport implements AgentTransportAdapter {
  readonly kind = "tmux" as const;

  async available(): Promise<boolean> {
    return commandAvailable("tmux");
  }

  launch(request: AgentTransportLaunch): Promise<AgentTransportHandle> {
    return launchWrapped(this.kind, request, () => this.#launch(request));
  }

  async #launch(request: AgentTransportLaunch): Promise<AgentTransportHandle> {
    const session = sessionName(request.id);
    await executeFile("tmux", [
      "new-session",
      "-d",
      "-s",
      session,
      "-c",
      request.cwd,
      await launchCommand(request),
    ]);
    return {
      kind: this.kind,
      livenessPollIntervalMs: EXTERNAL_TRANSPORT_LIVENESS_POLL_INTERVAL_MS,
      sessionId: session,
      attachCommand: `tmux attach-session -t ${session}`,
      async isAlive() {
        try {
          await executeFile("tmux", ["has-session", "-t", session]);
          return true;
        } catch {
          return false;
        }
      },
      async stop() {
        try {
          await executeFile("tmux", ["kill-session", "-t", session]);
        } catch { /* session already exited */ }
      },
    };
  }
}
