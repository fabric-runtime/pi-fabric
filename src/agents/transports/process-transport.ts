import type {
  AgentTransportAdapter,
  AgentTransportHandle,
  AgentTransportLaunch,
} from "../types.js";
import { launchWrapped, spawnLaunch } from "./process-utils.js";

export class ProcessTransport implements AgentTransportAdapter {
  readonly kind = "process" as const;

  async available(): Promise<boolean> {
    return true;
  }

  launch(request: AgentTransportLaunch): Promise<AgentTransportHandle> {
    return launchWrapped(this.kind, request, () => this.#launch(request));
  }

  async #launch(request: AgentTransportLaunch): Promise<AgentTransportHandle> {
    const processHandle = await spawnLaunch(request, { captureStderr: true });
    return {
      kind: this.kind,
      sessionId: String(processHandle.pid),
      isAlive: processHandle.isAlive,
      stop: processHandle.stop,
      readStderr: processHandle.readStderr,
    };
  }
}
