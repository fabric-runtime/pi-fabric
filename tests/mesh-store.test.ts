import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeOwnerIdentityLine } from "../src/core/atomic-write.js";
import { deadChildPid } from "./dead-child-pid.js";
import {
  MeshStore,
  type MeshIdentity,
  type MeshStateEntry,
  type MeshStoreOptions,
} from "../src/mesh/store.js";

const roots: string[] = [];
const identity: MeshIdentity = {
  id: "session:test",
  name: "main",
  kind: "main",
  sessionId: "test",
};

const createStore = (options?: MeshStoreOptions): MeshStore => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-mesh-"));
  roots.push(root);
  return new MeshStore(root, 64 * 1024, 100, options);
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("MeshStore", () => {
  it("publishes durable ordered events and reads from a cursor", async () => {
    const store = createStore();
    const initialOffset = store.latestOffset();
    const first = await store.publish({ topic: "team.auth", from: identity, text: "one" });
    const second = await store.publish({
      topic: "team.auth",
      from: identity,
      to: "reviewer",
      text: "two",
      data: { task: 2 },
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(store.read({ after: first.sequence })).toMatchObject([
      { sequence: 2, to: "reviewer", text: "two", data: { task: 2 } },
    ]);
    expect(store.read({ topic: "team.auth", to: "reviewer" })).toHaveLength(1);
    const firstTail = store.tail(initialOffset, 1);
    expect(firstTail.events).toMatchObject([{ sequence: 1, text: "one" }]);
    const secondTail = store.tail(firstTail.nextOffset, 10);
    expect(secondTail.events).toMatchObject([{ sequence: 2, text: "two" }]);
    expect(secondTail.nextOffset).toBe(store.latestOffset());
  });

  it("repairs an interrupted append without reusing sequence numbers", async () => {
    const store = createStore();
    await store.publish({ topic: "team.auth", from: identity, text: "one" });
    fs.writeFileSync(path.join(store.root, "sequence"), "0");
    fs.appendFileSync(path.join(store.root, "events.jsonl"), '{"sequence":999');

    const second = await store.publish({ topic: "team.auth", from: identity, text: "two" });
    expect(second.sequence).toBe(2);
    expect(store.read()).toMatchObject([
      { sequence: 1, text: "one" },
      { sequence: 2, text: "two" },
    ]);
  });

  it("invalidates cached state when another store replaces the file", async () => {
    const writer = createStore();
    const reader = new MeshStore(writer.root, 64 * 1024, 100);
    await writer.put({ key: "shared/value", value: { revision: 1 }, identity });
    expect(reader.get("shared/value")?.value).toEqual({ revision: 1 });

    await writer.put({ key: "shared/value", value: { revision: 2 }, identity });
    expect(reader.get("shared/value")?.value).toEqual({ revision: 2 });
  });

  it("recovers the newest complete state when snapshots are concatenated", async () => {
    const store = createStore();
    await store.put({ key: "shared/value", value: { revision: 1 }, identity });
    const statePath = path.join(store.root, "state.json");
    const first = fs.readFileSync(statePath, "utf8");
    await store.put({ key: "shared/value", value: { revision: 2 }, identity });
    const second = fs.readFileSync(statePath, "utf8");
    fs.writeFileSync(statePath, `${first}\n${second}`);

    expect(store.get("shared/value")?.value).toEqual({ revision: 2 });

    await store.put({ key: "shared/other", value: true, identity });
    const normalized = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      entries: Record<string, MeshStateEntry>;
    };
    expect(normalized.entries["shared/value"]?.value).toEqual({ revision: 2 });
    expect(normalized.entries["shared/other"]?.value).toBe(true);
  });

  it("recovers state with complete non-state JSON records appended", async () => {
    const store = createStore();
    await store.put({ key: "shared/value", value: { revision: 1 }, identity });
    const statePath = path.join(store.root, "state.json");
    fs.appendFileSync(statePath, '\n{"tick":1}\n{"tick":2}\n');

    expect(store.get("shared/value")?.value).toEqual({ revision: 1 });
  });

  it("treats an empty state file as a missing table", () => {
    const store = createStore();
    const statePath = path.join(store.root, "state.json");
    fs.mkdirSync(store.root, { recursive: true });
    fs.writeFileSync(statePath, "");

    expect(store.listAll()).toEqual([]);
    expect(store.get("shared/value")).toBeUndefined();
    expect(fs.readFileSync(statePath, "utf8")).toBe("");
  });

  it("keeps unreadable state as a write barrier while serving an empty table", async () => {
    const store = createStore();
    const statePath = path.join(store.root, "state.json");
    fs.mkdirSync(store.root, { recursive: true });
    fs.writeFileSync(statePath, "{");

    expect(store.listAll()).toEqual([]);
    expect(store.get("shared/value")).toBeUndefined();
    expect(fs.readFileSync(statePath, "utf8")).toBe("{");
    await expect(store.put({ key: "shared/value", value: { revision: 1 }, identity })).rejects.toThrow("invalid state format");
    expect(fs.readFileSync(statePath, "utf8")).toBe("{");
  });

  it("supports complete internal prefix scans independently of public read limits", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-mesh-scan-"));
    roots.push(root);
    const store = new MeshStore(root, 64 * 1024, 1);
    await store.put({ key: "topology/a", value: 1, identity });
    await store.put({ key: "topology/b", value: 2, identity });

    expect(store.list("topology/", 100)).toHaveLength(1);
    expect(store.listAll("topology/").map((entry) => entry.key)).toEqual([
      "topology/a",
      "topology/b",
    ]);
  });

  it("supports compare-and-swap shared state", async () => {
    const store = createStore();
    const created = await store.put({
      key: "tasks/task-1",
      value: { status: "ready" },
      identity,
      ifVersion: 0,
    });
    expect(created.version).toBe(1);

    await expect(
      store.put({
        key: "tasks/task-1",
        value: { status: "claimed" },
        identity,
        ifVersion: 0,
      }),
    ).rejects.toThrow("compare-and-swap failed");

    const claimed = await store.put({
      key: "tasks/task-1",
      value: { status: "claimed", owner: "worker" },
      identity,
      ifVersion: created.version,
    });
    expect(claimed.version).toBe(2);
    expect(store.get("tasks/task-1")?.value).toEqual({ status: "claimed", owner: "worker" });
    expect(store.list("tasks/")).toHaveLength(1);

    expect(await store.delete({ key: "tasks/task-1", ifVersion: claimed.version })).toEqual({
      deleted: true, version: 3,
    });
    const recreated = await store.put({
      key: "tasks/task-1",
      value: { status: "ready-again" },
      identity,
    });
    expect(recreated.version).toBe(4);
    await expect(
      store.put({
        key: "tasks/task-1",
        value: { status: "stale-owner" },
        identity,
        ifVersion: created.version,
      }),
    ).rejects.toThrow("compare-and-swap failed");
    expect(() => store.get("tasks/__proto__")).toThrow("Invalid Fabric mesh key");
  });

  it("compacts oversized event logs and resets stale tail cursors", async () => {
    const meshRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-mesh-bounded-"));
    roots.push(meshRoot);
    const maxEventLogBytes = 2_000;
    const store = new MeshStore(meshRoot, 512, 100, {
      maxEventLogBytes,
      retainedEventLogBytes: 800,
    });
    await store.publish({ topic: "team.auth", from: identity, text: "event-0" });
    await store.publish({ topic: "team.auth", from: identity, text: "event-1" });
    const staleCursor = store.latestOffset();
    for (let index = 2; index < 30; index += 1) {
      await store.publish({ topic: "team.auth", from: identity, text: `event-${index}` });
    }

    const tail = store.tail(staleCursor, 100);
    const recent = store.read({ limit: 3 });

    expect(fs.statSync(path.join(meshRoot, "events.jsonl")).size).toBeLessThanOrEqual(
      maxEventLogBytes,
    );
    expect(tail.events.length).toBeGreaterThan(0);
    expect(tail.events.at(-1)?.text).toBe("event-29");
    expect(recent.map((event) => event.text)).toEqual(["event-27", "event-28", "event-29"]);
    expect(tail.nextOffset).toBe(store.latestOffset());
  });

  it("caps deleted-key version tombstones", async () => {
    const meshRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-mesh-state-"));
    roots.push(meshRoot);
    const store = new MeshStore(meshRoot, 64 * 1024, 100, { maxStateTombstones: 2 });
    for (const key of ["state/a", "state/b", "state/c"]) {
      await store.put({ key, value: { ready: true }, identity });
      await store.delete({ key });
    }

    const state = JSON.parse(fs.readFileSync(path.join(meshRoot, "state.json"), "utf8")) as {
      versions: Record<string, number>;
      tombstoneOrder: string[];
    };
    const recreated = await store.put({ key: "state/a", value: { ready: false }, identity });

    expect(state.tombstoneOrder).toEqual(["state/b", "state/c"]);
    expect(state.versions["state/a"]).toBeUndefined();
    expect(recreated.version).toBe(7);
  });
});

describe("MeshStore lock recovery", () => {
  const holdLock = (store: MeshStore, owner?: string): string => {
    const lockPath = path.join(store.root, ".lock");
    fs.mkdirSync(lockPath, { mode: 0o700 });
    if (owner !== undefined) fs.writeFileSync(path.join(lockPath, "owner"), owner);
    return lockPath;
  };

  it("sweeps a stale lock whose owner process is dead", async () => {
    const store = createStore();
    const lockPath = holdLock(store, `crashed\n999999999\n${Date.now() - 60_000}\n`);

    const event = await store.publish({ topic: "team.auth", from: identity, text: "recovered" });

    expect(event.sequence).toBe(1);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("sweeps an ownerless lock left by a crash older than the stale window", async () => {
    const store = createStore();
    const lockPath = holdLock(store);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, past, past);

    const event = await store.publish({ topic: "team.auth", from: identity, text: "recovered" });

    expect(event.sequence).toBe(1);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("sweeps a lock whose owner file is corrupt", async () => {
    const store = createStore();
    const lockPath = holdLock(store, "not-a-valid-owner");

    const event = await store.publish({ topic: "team.auth", from: identity, text: "recovered" });

    expect(event.sequence).toBe(1);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("never sweeps a lock owned by a live process and times out instead", async () => {
    const store = createStore({ lockTimeoutMs: 300 });
    const lockPath = holdLock(store, `other\n${process.pid}\n${Date.now() - 60_000}\n`);

    await expect(
      store.publish({ topic: "team.auth", from: identity, text: "blocked" }),
    ).rejects.toThrow("Timed out waiting for the Fabric mesh lock");
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(path.join(lockPath, "owner"), "utf8")).toContain(`${process.pid}\n`);
  });

  // The identity line is the one the store writes, so the owner shares this
  // host, PID namespace and boot.
  const localIdentity = (): Record<string, unknown> =>
    JSON.parse(encodeOwnerIdentityLine()) as Record<string, unknown>;

  it("sweeps a fresh lock at once when its local owner process is provably dead", async () => {
    const store = createStore({ lockTimeoutMs: 10_000, staleLockMs: 30_000 });
    const pid = deadChildPid();
    const lockPath = holdLock(store, `crashed\n${pid}\n${Date.now()}\n${encodeOwnerIdentityLine()}\n`);

    const started = performance.now();
    const event = await store.publish({ topic: "team.auth", from: identity, text: "recovered" });

    expect(performance.now() - started).toBeLessThan(2_000);
    expect(event.sequence).toBe(1);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it.each([["fresh", 0], ["stale", 60_000]] as const)(
    "keeps a lock that a new owner takes between the %s dead-owner check and the removal",
    async (_age, ageMs) => {
      const store = createStore({ lockTimeoutMs: 300, staleLockMs: 30_000 });
      const pid = deadChildPid();
      const lockPath = holdLock(store, `crashed\n${pid}\n${Date.now() - ageMs}\n${encodeOwnerIdentityLine()}\n`);
      const ownerPath = path.join(lockPath, "owner");
      const successor = `successor\n${process.pid}\n${Date.now()}\n${encodeOwnerIdentityLine()}\n`;
      const readFileSync = fs.readFileSync;
      let ownerReads = 0;
      vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
        const content = readFileSync(file, options as BufferEncoding);
        // The re-read just before removal still sees the dead owner. A new
        // owner takes the lock right after it.
        if (file === ownerPath && ++ownerReads === 2) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          fs.mkdirSync(lockPath, { mode: 0o700 });
          fs.writeFileSync(ownerPath, successor);
        }
        return content;
      }) as typeof fs.readFileSync);

      await expect(
        store.publish({ topic: "team.auth", from: identity, text: "blocked" }),
      ).rejects.toThrow("Timed out waiting for the Fabric mesh lock");
      expect(ownerReads).toBeGreaterThan(2);
      expect(readFileSync(ownerPath, "utf8")).toBe(successor);
      expect(fs.readdirSync(store.root).filter((name) => name.startsWith(".lock."))).toEqual([]);
    },
  );

  it("sweeps a fresh lock whose local pid now belongs to a later process", async (context) => {
    const ownIdentity = localIdentity();
    // PID reuse is detectable only where the store records a boot id.
    if (typeof ownIdentity.bootId !== "string") context.skip();
    const store = createStore({ lockTimeoutMs: 10_000, staleLockMs: 30_000 });
    const reused = JSON.stringify({
      hostname: ownIdentity.hostname,
      pidNamespace: ownIdentity.pidNamespace,
      bootId: ownIdentity.bootId,
      startedAt: (ownIdentity.startedAt as number) - 60_000,
    });
    const lockPath = holdLock(store, `crashed\n${process.pid}\n${Date.now()}\n${reused}\n`);

    const started = performance.now();
    await store.publish({ topic: "team.auth", from: identity, text: "recovered" });

    expect(performance.now() - started).toBeLessThan(2_000);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("honours a fresh lock held by a live local owner until the timeout", async () => {
    const store = createStore({ lockTimeoutMs: 300 });
    const owner = `other\n${process.pid}\n${Date.now()}\n${encodeOwnerIdentityLine()}\n`;
    const lockPath = holdLock(store, owner);

    await expect(
      store.publish({ topic: "team.auth", from: identity, text: "blocked" }),
    ).rejects.toThrow("Timed out waiting for the Fabric mesh lock");
    expect(fs.readFileSync(path.join(lockPath, "owner"), "utf8")).toBe(owner);
  });

  it("honours a fresh lock with a dead pid until stale unless the owner is provably local", async () => {
    const pid = deadChildPid();
    const own = localIdentity();
    const line = (fields: Record<string, unknown>): string => JSON.stringify(fields);
    const identityLines: Record<string, string | undefined> = {
      legacy: undefined,
      otherHost: line({
        hostname: `${String(own.hostname)}-elsewhere`,
        pidNamespace: own.pidNamespace,
        bootId: own.bootId,
        startedAt: own.startedAt,
      }),
      otherNamespace: line({
        hostname: own.hostname,
        pidNamespace: "pid:[1]",
        bootId: own.bootId,
        startedAt: own.startedAt,
      }),
      otherBoot: line({
        hostname: own.hostname,
        pidNamespace: own.pidNamespace,
        bootId: "another-boot",
        startedAt: own.startedAt,
      }),
    };
    for (const [label, identityLine] of Object.entries(identityLines)) {
      const store = createStore({ lockTimeoutMs: 300, staleLockMs: 30_000 });
      const owner = identityLine === undefined
        ? `${label}\n${pid}\n${Date.now()}\n`
        : `${label}\n${pid}\n${Date.now()}\n${identityLine}\n`;
      const lockPath = holdLock(store, owner);

      await expect(
        store.publish({ topic: "team.auth", from: identity, text: "blocked" }),
        label,
      ).rejects.toThrow("Timed out waiting for the Fabric mesh lock");
      expect(fs.readFileSync(path.join(lockPath, "owner"), "utf8"), label).toBe(owner);
    }
  });

  it("waits out a fresh ownerless lock instead of sweeping an in-flight acquisition", async () => {
    const store = createStore({ lockTimeoutMs: 300 });
    const lockPath = holdLock(store);

    await expect(
      store.publish({ topic: "team.auth", from: identity, text: "blocked" }),
    ).rejects.toThrow("Timed out waiting for the Fabric mesh lock");
    expect(fs.existsSync(lockPath)).toBe(true);
  });
});
