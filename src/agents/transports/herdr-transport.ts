import type {
  AgentTransportAdapter,
  AgentTransportHandle,
  AgentTransportLaunch,
} from "../types.js";
import { EXTERNAL_TRANSPORT_LIVENESS_POLL_INTERVAL_MS } from "../constants.js";
import { environmentLaunchArgv, launchWrapped } from "./process-utils.js";
import { herdrSocketRequest, type HerdrSocketRequest } from "./herdr-socket.js";

interface HerdrLayoutApplyResponse {
  result?: {
    type?: string;
    layout?: {
      tab_id?: string;
      root?: { type?: string; pane_id?: string };
    };
  };
}

interface HerdrPaneResponse {
  result?: {
    type?: string;
    pane?: { pane_id?: string; terminal_id?: string };
  };
}

export class HerdrTransport implements AgentTransportAdapter {
  readonly kind = "herdr" as const;

  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async available(): Promise<boolean> {
    if (
      this.environment.HERDR_ENV !== "1" ||
      !this.environment.HERDR_SOCKET_PATH ||
      !this.environment.HERDR_WORKSPACE_ID
    ) {
      return false;
    }
    try {
      await this.#request({ method: "ping", params: {} });
      return true;
    } catch {
      return false;
    }
  }

  launch(request: AgentTransportLaunch): Promise<AgentTransportHandle> {
    return launchWrapped(this.kind, request, () => this.#launch(request));
  }

  async #launch(request: AgentTransportLaunch): Promise<AgentTransportHandle> {
    const workspaceId = this.environment.HERDR_WORKSPACE_ID;
    if (!workspaceId) throw new Error("Herdr transport requires HERDR_WORKSPACE_ID");
    const response = (await this.#request({
      method: "layout.apply",
      params: {
        workspace_id: workspaceId,
        tab_label: request.name,
        focus: false,
        root: {
          type: "pane",
          label: request.name,
          cwd: request.cwd,
          command: await environmentLaunchArgv(request),
        },
      },
    })) as HerdrLayoutApplyResponse;
    const paneId = response.result?.layout?.root?.pane_id;
    if (response.result?.type !== "layout_apply" || !paneId) {
      throw new Error("Herdr layout.apply did not return a pane id");
    }

    let terminalId: string | undefined;
    try {
      const pane = (await this.#request({
        method: "pane.get",
        params: { pane_id: paneId },
      })) as HerdrPaneResponse;
      terminalId = pane.result?.pane?.terminal_id;
    } catch {
      // Very short runs can exit before the optional attach metadata is read.
    }

    return {
      kind: this.kind,
      livenessPollIntervalMs: EXTERNAL_TRANSPORT_LIVENESS_POLL_INTERVAL_MS,
      sessionId: paneId,
      ...(terminalId ? { attachCommand: `herdr terminal attach ${terminalId}` } : {}),
      isAlive: async () => {
        try {
          await this.#request({ method: "pane.get", params: { pane_id: paneId } });
          return true;
        } catch {
          return false;
        }
      },
      stop: async () => {
        try {
          await this.#request({ method: "pane.close", params: { pane_id: paneId } });
        } catch {
          // Pane already exited or the owning Herdr server stopped.
        }
      },
    };
  }

  #request(request: HerdrSocketRequest): Promise<unknown> {
    return herdrSocketRequest(this.environment.HERDR_SOCKET_PATH, request, "Herdr transport");
  }
}
