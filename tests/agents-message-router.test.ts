import { describe, expect, it, vi } from "vitest";
import { AgentMessageRouter } from "../src/providers/agents-message-router.js";
import type { FabricParticipantInfo } from "../src/topology/types.js";

type Ports = ConstructorParameters<typeof AgentMessageRouter>;
const remoteAgent = (overrides: Partial<FabricParticipantInfo> = {}): FabricParticipantInfo => ({
  format: 1, id: "remote-run", kind: "agent", rootId: "session:peer",
  ownerHostId: "runtime:owner", ownerIdentityId: "owner-agent",
  ownerIncarnation: "owner-generation", parentId: "owner-agent", name: "researcher",
  status: "running", runner: "pi", transport: "process",
  capabilities: ["steer", "followUp", "stop"], startedAt: 1, updatedAt: 2,
  controlProtocol: "v1", local: false, stale: false, ...overrides,
});
const setup = (participant: FabricParticipantInfo, withControl = true) => {
  const manager: Ports[0] = {
    status: vi.fn(() => { throw new Error("Unknown Fabric agent"); }),
    steer: vi.fn(), followUp: vi.fn(), stop: vi.fn(),
  };
  const actors: Ports[1] = {
    identity: { id: "caller", name: "caller", kind: "agent" },
    status: vi.fn(() => { throw new Error("Unknown Fabric actor"); }),
    validateDirectMessage: vi.fn(), tell: vi.fn(), ask: vi.fn(), stop: vi.fn(),
    steerRemote: vi.fn(), resolveBinding: vi.fn(),
  };
  const main: Ports[2] = {
    id: "session:main", local: false,
    matches: (id) => id === "main" || id === "session:main", deliverAgent: vi.fn(),
  };
  const participants: Ports[3] = {
    get: (id) => id === participant.id ? participant : undefined,
    scheduleRefresh: vi.fn(),
  };
  const request = vi.fn<NonNullable<Ports[4]>["request"]>().mockResolvedValue({
    queued: true, messageId: "receipt", routed: "mesh", acknowledged: true,
  });
  const router = new AgentMessageRouter(
    manager, actors, main, participants, withControl ? { request } : undefined,
    (binding) => binding,
  );
  return { router, request, actors };
};

describe("remote one-shot agent routing", () => {
  it.each(["steer", "followUp"] as const)("routes %s to the exact execution owner", async (kind) => {
    const participant = remoteAgent();
    const { router, request, actors } = setup(participant);
    await expect(router.routeMessage(participant.id, "protect the preview", { scope: "UX" }, kind,
      undefined, { triggerTurn: false })).resolves.toMatchObject({ routed: "mesh", acknowledged: true });
    expect(request).toHaveBeenCalledWith("runtime:owner", "remote-run", kind, {
      message: "protect the preview", data: { scope: "UX" }, triggerTurn: false,
      ownerIncarnation: "owner-generation",
    }, "owner-agent");
    expect(actors.tell).not.toHaveBeenCalled();
    expect(actors.steerRemote).not.toHaveBeenCalled();
  });

  it("also routes a sibling owned by the caller's Main peer", async () => {
    const participant = remoteAgent({ rootId: "session:main", ownerHostId: "session:main", ownerIdentityId: "session:main" });
    const { router, request } = setup(participant);
    await router.routeMessage(participant.id, "status please", undefined, "followUp");
    expect(request).toHaveBeenCalledWith("session:main", participant.id, "followUp", expect.any(Object), "session:main");
  });

  it("refuses a capability withdrawn by the owner", async () => {
    const participant = remoteAgent({ capabilities: [] });
    const { router, request } = setup(participant);
    await expect(router.routeMessage(participant.id, "too late", undefined, "steer"))
      .rejects.toThrow("does not support steer");
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["legacy", "missing"])("refuses a %s control channel instead of broadcasting", async (mode) => {
    const participant = remoteAgent(mode === "legacy" ? { controlProtocol: "legacy" } : {});
    const { router, request, actors } = setup(participant, mode !== "missing");
    await expect(router.routeMessage(participant.id, "hello", undefined, "steer"))
      .rejects.toThrow("has no control channel");
    expect(request).not.toHaveBeenCalled();
    expect(actors.steerRemote).not.toHaveBeenCalled();
  });

  it("does not reinterpret an unknown local run as remote", async () => {
    const participant = remoteAgent({ local: true });
    const { router, request } = setup(participant);
    await expect(router.routeMessage(participant.id, "hello", undefined, "steer"))
      .rejects.toThrow("Unknown Fabric participant");
    expect(request).not.toHaveBeenCalled();
  });
});
