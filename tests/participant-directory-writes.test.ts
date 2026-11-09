import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { ParticipantDirectory } from "../src/topology/participant-directory.js";
import type { FabricParticipantRecord } from "../src/topology/types.js";

// Nested fabric_exec calls each schedule a refresh. Those must not rewrite the
// project mesh state when nothing but timestamps changed: every put re-reads
// and rewrites the whole shared state file on the interactive thread.
const roots: string[] = [];
const directories: ParticipantDirectory[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => directory.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const identity: MeshIdentity = { id: "session:alpha", name: "main", kind: "main", sessionId: "alpha" };
const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve));
};

const setup = (heartbeatMs: number) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-presence-writes-"));
  roots.push(root);
  const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 1_000);
  const state = { status: "idle" as "idle" | "running", pendingMessages: false };
  const directory = new ParticipantDirectory(mesh, {
    enabled: true, hostId: identity.id, rootId: identity.id, identity, heartbeatMs, leaseMs: heartbeatMs * 3,
  });
  directory.registerSource((): FabricParticipantRecord[] => [{
    format: 1, id: identity.id, kind: "root", rootId: identity.id, ownerHostId: identity.id, ownerIdentityId: identity.id,
    name: "main", status: state.status, runner: "pi", transport: "host", capabilities: ["steer", "followUp", "fabric"],
    cwd: "/tmp/project", sessionId: "alpha", startedAt: 1,
    // The live root stamps every snapshot, as MainAgent.info() does.
    updatedAt: Date.now(), pendingMessages: state.pendingMessages, controlProtocol: "v1",
  }]);
  directories.push(directory);
  const puts = vi.spyOn(mesh, "put");
  const keys = () => new Set(puts.mock.calls.map(([input]) => input.key.replace(/\/[^/]*$/, "/*")));
  // Participant and host keys are hashed ids; each family holds one record here.
  const only = (prefix: string) => {
    const entries = mesh.listAll(prefix);
    expect(entries).toHaveLength(1);
    return entries[0]!;
  };
  return { mesh, state, directory, puts, keys, only };
};

describe("ParticipantDirectory writes", () => {
  it("publishes everything and renews the lease on refresh()", async () => {
    const { directory, keys } = setup(60_000);
    await directory.refresh();
    expect([...keys()]).toEqual(expect.arrayContaining(["sessions/*", "topology/hosts/*", "topology/participants/*"]));
  });

  it("writes nothing for event refreshes that only change timestamps", async () => {
    const { directory, puts } = setup(60_000);
    await directory.refresh();
    puts.mockClear();
    for (let index = 0; index < 25; index++) {
      directory.scheduleRefresh();
      await settle();
    }
    expect(puts).not.toHaveBeenCalled();
  });

  it("publishes a real change at once without renewing the lease", async () => {
    const { mesh, state, directory, puts, keys, only } = setup(60_000);
    await directory.refresh();
    const lease = only("topology/hosts/");
    puts.mockClear();
    state.status = "running";
    directory.scheduleRefresh();
    await settle();
    expect(keys()).toEqual(new Set(["sessions/*", "topology/participants/*"]));
    expect((only("topology/participants/").value as { status: string }).status).toBe("running");
    expect((mesh.get("sessions/alpha")!.value as { status: string }).status).toBe("running");
    expect(only("topology/hosts/").version).toBe(lease.version);
  });

  it("renews from an event refresh once the last renewal is a heartbeat old", async () => {
    const { directory, puts, keys, only } = setup(1_000);
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await directory.refresh();
    const before = (only("topology/hosts/").value as { expiresAt: number }).expiresAt;
    puts.mockClear();
    now += 999;
    directory.scheduleRefresh();
    await settle();
    expect(puts).not.toHaveBeenCalled();
    now += 1;
    directory.scheduleRefresh();
    await settle();
    expect([...keys()]).toEqual(expect.arrayContaining(["sessions/*", "topology/hosts/*", "topology/participants/*"]));
    expect((only("topology/hosts/").value as { expiresAt: number }).expiresAt).toBe(before + 1_000);
  });

  it("runs a requested renewal after an in-flight event refresh", async () => {
    const { directory, puts, keys } = setup(60_000);
    await directory.refresh();
    puts.mockClear();
    directory.scheduleRefresh();
    await Promise.resolve();
    await directory.refresh();
    expect(keys().has("topology/hosts/*")).toBe(true);
  });

  it("lists legacy actor states only under live legacy roots", async () => {
    const { mesh, directory } = setup(60_000);
    await mesh.put({ key: "actors/other-session/actor-1", value: { id: "actor-1", name: "a", runner: "pi", status: "idle" }, identity });
    await directory.refresh();
    const listAll = vi.spyOn(mesh, "listAll");
    directory.scheduleRefresh();
    await settle();
    directory.list();
    // This host's own legacy session is excluded, so no root can own an actor.
    expect(listAll.mock.calls.map(([prefix]) => prefix)).not.toContain("actors/");
    expect(listAll.mock.calls.some(([prefix]) => String(prefix).startsWith("actors/"))).toBe(false);
  });
});
