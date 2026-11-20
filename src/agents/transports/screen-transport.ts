import type {
  AgentTransportAdapter,
  AgentTransportHandle,
  AgentTransportLaunch,
} from "../types.js";
import { EXTERNAL_TRANSPORT_LIVENESS_POLL_INTERVAL_MS } from "../constants.js";
import {
  commandAvailable,
  environmentLaunchArgv,
  executeFile,
  launchWrapped,
} from "./process-utils.js";

const sessionName = (id: string): string => `pi-fabric-${id.slice(0, 12)}`;

export class ScreenTransport implements AgentTransportAdapter {
  readonly kind = "screen" as const;

  async available(): Promise<boolean> {
    return commandAvailable("screen");
  }

  launch(request: AgentTransportLaunch): Promise<AgentTransportHandle> {
    return launchWrapped(this.kind, request, () => this.#launch(request));
  }

  async #launch(request: AgentTransportLaunch): Promise<AgentTransportHandle> {
    const session = sessionName(request.id);
    await executeFile(
      "screen",
      ["-DmS", session, ...(await environmentLaunchArgv(request))],
      { cwd: request.cwd },
    );
    return {
      kind: this.kind,
      livenessPollIntervalMs: EXTERNAL_TRANSPORT_LIVENESS_POLL_INTERVAL_MS,
      sessionId: session,
      attachCommand: `screen -r ${session}`,
      async isAlive() {
        try {
          const { stdout } = await executeFile("screen", ["-ls"]);
          return stdout.includes(`.${session}`) || stdout.includes(`\t${session}`);
        } catch {
          return false;
        }
      },
      async stop() {
        try {
          await executeFile("screen", ["-S", session, "-X", "quit"]);
        } catch { /* session already exited */ }
      },
    };
  }
}
