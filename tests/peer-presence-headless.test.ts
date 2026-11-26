import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PEER_PRESENCE_MESSAGE_TYPE, PeerPresenceNotifier } from "../src/topology/peer-presence.js";
import type { FabricPeerInfo } from "../src/topology/types.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

const peer: FabricPeerInfo = {
  id: "session:FAB-2",
  name: "FAB-2",
  label: "FAB-2",
  kind: "peer",
  status: "idle",
  runner: "pi",
  transport: "host",
  cwd: "/repo",
  sessionId: "FAB-2",
  startedAt: 1,
  updatedAt: 2,
  pendingMessages: false,
  local: false,
};

const harness = () => {
  const handlers = new Map<string, Handler>();
  const pi = { on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as ExtensionAPI;
  const sessionManager = { getBranch: () => [] };
  const contextFor = (hasUI: boolean) => ({ hasUI, sessionManager }) as unknown as ExtensionContext;
  new PeerPresenceNotifier(pi, contextFor(true), { peers: () => [peer], enabled: () => true, cwd: "/repo" });
  return {
    start: (ctx: ExtensionContext) =>
      handlers.get("before_agent_start")?.({ messageType: "user" }, ctx) as { message?: { customType: string } } | undefined,
    contextFor,
  };
};

describe("peer presence in a session without a UI", () => {
  it("sends no notice at the start of a prompt", () => {
    const h = harness();
    expect(h.start(h.contextFor(false))).toBeUndefined();
  });

  it("does not consume the change, so a later interactive prompt still gets the notice", () => {
    const h = harness();
    expect(h.start(h.contextFor(false))).toBeUndefined();
    expect(h.start(h.contextFor(true))?.message?.customType).toBe(PEER_PRESENCE_MESSAGE_TYPE);
  });
});
