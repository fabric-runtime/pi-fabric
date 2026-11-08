import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { ParticipantDirectory } from "../src/topology/participant-directory.js";
import type { FabricParticipantRecord } from "../src/topology/types.js";

const NOW = 1_000_000;
const RETENTION = 1_000;
const key = (prefix: string, id: string) =>
  `topology/${prefix}/${createHash("sha256").update(id).digest("hex")}`;
const identity = (id: string): MeshIdentity => ({ id, name: id, kind: "main" });
const directories: ParticipantDirectory[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => directory.close()));
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-reaper-"));
  roots.push(root);
  const mesh = new MeshStore(root, 64 * 1024, 1_000);
  const directory = new ParticipantDirectory(mesh, {
    enabled: true, hostId: "viewer", rootId: "viewer", identity: identity("viewer"),
    departedRetentionMs: RETENTION,
  });
  directories.push(directory);
  return { mesh, directory };
}

async function host(mesh: MeshStore, id: string, updatedAt = NOW - RETENTION - 10, expiresAt = updatedAt + 1) {
  return mesh.put({ key: key("hosts", id), identity: identity(id), value: {
    format: 1, id, rootId: id, identity: identity(id), startedAt: 1, updatedAt, expiresAt,
  } });
}

async function participant(mesh: MeshStore, id: string, owner = id, updatedAt = NOW - RETENTION - 10) {
  const value: FabricParticipantRecord = {
    format: 1, id, kind: "root", rootId: owner, ownerHostId: owner, ownerIdentityId: owner,
    name: id, status: "idle", runner: "pi", transport: "host", capabilities: [],
    startedAt: 1, updatedAt, controlProtocol: "v1",
  };
  return mesh.put({ key: key("participants", id), identity: identity(owner), value });
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("participant reaper", () => {
  it("retains boundary and recent-heartbeat roots, live owners, and malformed records", async () => {
    const { mesh, directory } = setup();
    await participant(mesh, "old");
    await host(mesh, "old");
    await participant(mesh, "boundary", "boundary", NOW - RETENTION);
    await host(mesh, "boundary");
    await participant(mesh, "heartbeat");
    await host(mesh, "heartbeat", NOW - RETENTION);
    await participant(mesh, "live");
    await host(mesh, "live", NOW - RETENTION - 10, NOW);
    await mesh.put({ key: key("participants", "malformed"), identity: identity("malformed"), value: { format: 1 } });
    await directory.refresh();
    await vi.waitFor(() => expect(mesh.get(key("hosts", "old"))).toBeUndefined());
    await directory.close();
    expect(mesh.get(key("participants", "old"))).toBeUndefined();
    expect(mesh.get(key("hosts", "old"))).toBeUndefined();
    for (const id of ["boundary", "heartbeat", "live", "malformed"]) {
      expect(mesh.get(key("participants", id)), id).toBeDefined();
    }
    for (const id of ["boundary", "heartbeat", "live"]) expect(mesh.get(key("hosts", id)), id).toBeDefined();
    expect(directory.departed({}, NOW).map((record) => record.id).sort()).toEqual(["boundary", "heartbeat"]);
  });

  it.each([
    { existing: false, expiresOffset: -1 },
    { existing: false, expiresOffset: 15_000 },
    { existing: true, expiresOffset: -1 },
    { existing: true, expiresOffset: 15_000 },
  ])("keeps an unchanged participant after an owner heartbeat (existing: $existing, expiry offset: $expiresOffset)", async ({ existing, expiresOffset }) => {
    const { mesh, directory } = setup();
    const record = await participant(mesh, "returning");
    if (existing) await host(mesh, "returning");
    const original = mesh.delete.bind(mesh);
    vi.spyOn(mesh, "delete").mockImplementation(async (input, guard) => {
      if (input.key === record.key) await host(mesh, "returning", NOW, NOW + expiresOffset);
      return original(input, guard);
    });
    await directory.refresh();
    await turn(); await turn();
    await directory.close();
    expect(mesh.get(record.key)?.version).toBe(record.version);
    expect(mesh.get(key("hosts", "returning"))?.value).toMatchObject({ expiresAt: NOW + expiresOffset });
  });

  it("keeps an expired host when a participant is added while its deletion waits", async () => {
    const { mesh, directory } = setup();
    const owner = await host(mesh, "returning");
    const original = mesh.delete.bind(mesh);
    vi.spyOn(mesh, "delete").mockImplementation(async (input, guard) => {
      if (input.key === owner.key) await participant(mesh, "new-child", "returning", NOW);
      return original(input, guard);
    });
    await directory.refresh();
    await turn(); await turn();
    await directory.close();
    expect(mesh.get(owner.key)?.version).toBe(owner.version);
    expect(mesh.get(key("participants", "new-child"))).toBeDefined();
  });

  it("bounds a sweep to 100 mutations and drains the backlog on the next refresh", async () => {
    const { mesh, directory } = setup();
    for (let i = 0; i < 103; i++) await participant(mesh, `old-${i}`);
    const remove = vi.spyOn(mesh, "delete");
    await directory.refresh();
    await vi.waitFor(() => expect(mesh.listAll("topology/participants/")).toHaveLength(3));
    await turn(); await turn();
    expect(remove).toHaveBeenCalledTimes(100);
    await directory.refresh();
    await vi.waitFor(() => expect(mesh.listAll("topology/participants/")).toHaveLength(0));
    expect(remove).toHaveBeenCalledTimes(103);
  });

  it("stops after a non-CAS failure and retries on a later heartbeat", async () => {
    const { mesh, directory } = setup();
    await participant(mesh, "one"); await participant(mesh, "two");
    const remove = vi.spyOn(mesh, "delete").mockRejectedValueOnce(new Error("lock timeout"));
    await directory.refresh();
    await turn(); await turn();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(mesh.listAll("topology/participants/")).toHaveLength(2);
    await directory.refresh();
    await vi.waitFor(() => expect(mesh.listAll("topology/participants/")).toHaveLength(0));
  });

  it("keeps a participant rewritten after the snapshot and continues after a lost CAS", async () => {
    const { mesh, directory } = setup();
    await participant(mesh, "one"); await participant(mesh, "two");
    const original = mesh.delete.bind(mesh);
    let changedKey: string | undefined;
    vi.spyOn(mesh, "delete").mockImplementation(async (input, guard) => {
      if (!changedKey && input.key.startsWith("topology/participants/")) {
        changedKey = input.key;
        const entry = mesh.get(input.key)!;
        await mesh.put({ key: entry.key, value: { ...(entry.value as object), updatedAt: NOW }, identity: entry.updatedBy });
      }
      return original(input, guard);
    });
    await directory.refresh();
    await vi.waitFor(() => expect(mesh.listAll("topology/participants/")).toHaveLength(1));
    await directory.close();
    expect(mesh.listAll("topology/participants/")).toHaveLength(1);
    expect(mesh.get(changedKey!)?.value).toMatchObject({ updatedAt: NOW });
  });

  it("does not reinstall a heartbeat when close races the initial publication", async () => {
    const { mesh, directory } = setup();
    const interval = vi.spyOn(globalThis, "setInterval");
    const original = mesh.put.bind(mesh);
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const publishing = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(mesh, "put").mockImplementation(async (input) => {
      entered();
      await barrier;
      return original(input);
    });
    const starting = directory.start();
    await publishing;
    const closing = directory.close();
    release();
    await Promise.all([starting, closing]);
    expect(interval).not.toHaveBeenCalled();
    expect(mesh.listAll("topology/hosts/")).toEqual([]);
  });

  it.each(["close", "quiesce"] as const)("stops a running sweep at %s without starting another deletion", async (operation) => {
    const { mesh, directory } = setup();
    await participant(mesh, "one"); await participant(mesh, "two");
    const original = mesh.delete.bind(mesh);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const attempts: string[] = [];
    vi.spyOn(mesh, "delete").mockImplementation(async (input, guard) => {
      if (input.key.startsWith("topology/participants/")) {
        attempts.push(input.key);
        await barrier;
      }
      return original(input, guard);
    });
    await directory.refresh();
    expect(attempts).toHaveLength(1);
    // A heartbeat must not join or duplicate the blocked maintenance pass.
    await directory.refresh();
    expect(attempts).toHaveLength(1);
    const stopping = directory[operation]();
    release();
    await stopping;
    await turn(); await turn();
    expect(attempts).toHaveLength(1);
    expect(mesh.listAll("topology/participants/")).toHaveLength(2);
    await directory.refresh();
    expect(attempts).toHaveLength(1);
  });
});
