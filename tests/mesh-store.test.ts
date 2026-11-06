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

type TracedIo =
  | { op: "fsync"; path: string; flags: string }
  | { op: "rename"; from: string; to: string };

/** Records fsync and rename calls in order, resolving each fsynced descriptor to its path and open flags. */
const traceDurableIo = (beforeFsync?: (target: string) => void): TracedIo[] => {
  const trace: TracedIo[] = [];
  const descriptors = new Map<number, { path: string; flags: string }>();
  const realOpen = fs.openSync;
  vi.spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, flags?: unknown, ...rest: unknown[]) => {
    const descriptor = (realOpen as (...args: unknown[]) => number)(target, flags, ...rest);
    descriptors.set(descriptor, { path: String(target), flags: String(flags ?? "r") });
    return descriptor;
  }) as typeof fs.openSync);
  const realFsync = fs.fsyncSync;
  vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor: number) => {
    const opened = descriptors.get(descriptor) ?? { path: "?", flags: "?" };
    trace.push({ op: "fsync", path: opened.path, flags: opened.flags });
    beforeFsync?.(opened.path);
    realFsync(descriptor);
  });
  const realRename = fs.renameSync;
  vi.spyOn(fs, "renameSync").mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
    trace.push({ op: "rename", from: String(from), to: String(to) });
    realRename(from, to);
  });
  return trace;
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

  it("flushes appends, state, sequence and schedules only when durability is fsync", async () => {
    const relaxed = createStore();
    const relaxedSpy = vi.spyOn(fs, "fsyncSync");
    await relaxed.publish({ topic: "team.auth", from: identity, text: "one" });
    await relaxed.put({ key: "claims/a", value: 1, identity });
    expect(relaxed.durable).toBe(false);
    expect(relaxedSpy).not.toHaveBeenCalled();
    relaxedSpy.mockRestore();

    const store = createStore({ durability: "fsync" });
    expect(store.durable).toBe(true);
    const flushed: string[] = [];
    const realOpen = fs.openSync;
    const descriptors = new Map<number, string>();
    vi.spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      const descriptor = (realOpen as (...args: unknown[]) => number)(target, ...rest);
      descriptors.set(descriptor, path.basename(String(target)));
      return descriptor;
    }) as typeof fs.openSync);
    const realFsync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor: number) => {
      flushed.push(descriptors.get(descriptor) ?? "?");
      realFsync(descriptor);
    });

    // Windows cannot open a directory for fsync, so Fabric skips the directory flush there.
    const flushesDirectories = process.platform !== "win32";
    await store.publish({ topic: "team.auth", from: identity, text: "one" });
    expect(flushed).toContain("events.jsonl");
    expect(flushed.some((name) => name.startsWith("sequence."))).toBe(true);
    if (flushesDirectories) expect(flushed).toContain(path.basename(store.root));

    flushed.length = 0;
    await store.put({ key: "claims/a", value: 1, identity });
    expect(flushed.some((name) => name.startsWith("state.json."))).toBe(true);
    if (flushesDirectories) expect(flushed).toContain(path.basename(store.root));

    flushed.length = 0;
    await store.schedule({ topic: "team.auth", from: identity, text: "later", dueAt: Date.now() + 60_000, key: "later" });
    expect(flushed.some((name) => name.startsWith("schedules.json."))).toBe(true);

    flushed.length = 0;
    await expect(store.unschedule("later")).resolves.toEqual({ removed: true });
    if (flushesDirectories) expect(flushed).toContain(path.basename(store.root));
  });

  it.skipIf(process.platform === "win32")("flushes the parents of a newly created durable mesh root", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-mesh-"));
    roots.push(base);
    const realOpen = fs.openSync;
    const descriptors = new Map<number, string>();
    vi.spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      const descriptor = (realOpen as (...args: unknown[]) => number)(target, ...rest);
      descriptors.set(descriptor, String(target));
      return descriptor;
    }) as typeof fs.openSync);
    const flushed: string[] = [];
    const realFsync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor: number) => {
      flushed.push(descriptors.get(descriptor) ?? "?");
      realFsync(descriptor);
    });

    new MeshStore(path.join(base, "relaxed", "mesh"), 64 * 1024, 100);
    expect(flushed).toEqual([]);

    const root = path.join(base, "fabric", "mesh");
    new MeshStore(root, 64 * 1024, 100, { durability: "fsync" });
    const expected: string[] = [];
    for (let parent = path.dirname(root); ; parent = path.dirname(parent)) {
      expected.push(parent);
      if (parent === path.dirname(parent)) break;
    }
    expect(flushed).toEqual(expected);

    flushed.length = 0;
    new MeshStore(root, 64 * 1024, 100, { durability: "fsync" });
    expect(flushed).toEqual(expected);
  });

  it.skipIf(process.platform === "win32")("makes a pre-created root durable and bounds later writes to its namespace", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-mesh-"));
    roots.push(base);
    const root = path.join(base, "a", "mesh");
    new MeshStore(root, 64 * 1024, 100); // Another writer did mkdir without barriers.
    const trace = traceDurableIo();
    const store = new MeshStore(root, 64 * 1024, 100, { durability: "fsync" });
    expect(trace).toContainEqual({ op: "fsync", path: base, flags: "r" });
    expect(trace).toContainEqual({ op: "fsync", path: path.dirname(base), flags: "r" });
    trace.length = 0;
    await store.put({ key: "acknowledged", value: 1, identity });
    expect(store.get("acknowledged")?.value).toBe(1);
    expect(trace).toContainEqual({ op: "fsync", path: root, flags: "r" });
    expect(trace).toContainEqual({ op: "fsync", path: path.dirname(root), flags: "r" });
    expect(trace.some((event) => event.op === "fsync" && event.path === base)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("retries the root's full chain after a constructor barrier fails", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-mesh-"));
    roots.push(base);
    const root = path.join(base, "a", "mesh");
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("injected EIO"), { code: "EIO" });
    });
    expect(() => new MeshStore(root, 64 * 1024, 100, { durability: "fsync" })).toThrow("injected EIO");
    vi.mocked(fs.fsyncSync).mockRestore();
    const trace = traceDurableIo();
    new MeshStore(root, 64 * 1024, 100, { durability: "fsync" });
    for (const directory of [path.dirname(root), base, path.dirname(base)]) {
      expect(trace).toContainEqual({ op: "fsync", path: directory, flags: "r" });
    }
  });

  it.skipIf(process.platform === "win32")("flushes an existing event-log entry after an earlier append barrier failed", async () => {
    const store = createStore({ durability: "fsync" });
    // Fail only the root barrier after writing the event, not the lock's parent barrier.
    let fail = true;
    const trace = traceDurableIo((target) => {
      if (fail && target === store.root) throw Object.assign(new Error("injected EIO"), { code: "EIO" });
    });
    await expect(store.publish({ topic: "team.auth", from: identity, text: "one" })).rejects.toThrow("injected EIO");
    expect(fs.existsSync(path.join(store.root, "events.jsonl"))).toBe(true);
    fail = false;
    trace.length = 0;
    await store.publish({ topic: "team.auth", from: identity, text: "two" });
    const eventSync = trace.findIndex((event) => event.op === "fsync" && event.path.endsWith("events.jsonl"));
    expect(eventSync).toBeGreaterThanOrEqual(0);
    expect(trace[eventSync + 1]).toEqual({ op: "fsync", path: store.root, flags: "r" });
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

  it("clones only the bounded, sorted result while isolating returned values", async () => {
    const store = createStore();
    for (const key of ["shared/z", "shared/a", "other/c"]) {
      await store.put({ key, value: { nested: { count: 1 } }, identity });
    }
    const stringify = vi.spyOn(JSON, "stringify");
    const result = store.list("shared/", 1);
    const copiedKeys = stringify.mock.calls.map(([value]) => value?.key);
    stringify.mockRestore();

    expect(result.map((entry) => entry.key)).toEqual(["shared/a"]);
    expect(copiedKeys).toEqual(["shared/a"]);
    (result[0]!.value as { nested: { count: number } }).nested.count = 99;
    expect(store.get("shared/a")?.value).toEqual({ nested: { count: 1 } });
    expect(store.listAll("shared/").map((entry) => entry.key)).toEqual(["shared/a", "shared/z"]);
  });

  it("evaluates delete guards against fresh detached entries while holding the mutation lock", async () => {
    const store = createStore();
    const target = await store.put({ key: "tasks/target", value: { nested: { count: 1 } }, identity });
    // Prime this instance's cache before another writer changes the owner.
    store.listAll();
    const other = new MeshStore(store.root, 64 * 1024, 100);
    const owner = await other.put({ key: "owners/live", value: { active: true }, identity });
    const guard = vi.fn((entries: readonly MeshStateEntry[]) => {
      expect(fs.existsSync(path.join(store.root, ".lock"))).toBe(true);
      expect(entries.find((entry) => entry.key === owner.key)).toEqual(owner);
      const copy = entries.find((entry) => entry.key === target.key)!;
      (copy.value as { nested: { count: number } }).nested.count = 99;
      copy.version = 99;
      return false;
    });
    expect(await store.delete({ key: target.key, ifVersion: target.version }, guard)).toEqual({ deleted: false });
    expect(guard).toHaveBeenCalledOnce();
    expect(store.get(target.key)).toEqual(target);
    expect(store.get(owner.key)).toEqual(owner);
    expect(other.get(target.key)).toEqual(target);
    // A denied delete consumes no revision. An allowed one still runs target CAS.
    await expect(store.delete({ key: target.key, ifVersion: target.version + 1 }, () => true))
      .rejects.toThrow("compare-and-swap failed");
    expect(await store.delete({ key: target.key, ifVersion: target.version }, () => true))
      .toEqual({ deleted: true, version: 2 });
  });

  it("releases the lock and leaves state unchanged when a delete guard throws", async () => {
    const store = createStore();
    const target = await store.put({ key: "tasks/target", value: { count: 1 }, identity });
    await expect(store.delete({ key: target.key }, () => { throw new Error("guard failed"); }))
      .rejects.toThrow("guard failed");
    expect(store.get(target.key)).toEqual(target);
    expect(fs.existsSync(path.join(store.root, ".lock"))).toBe(false);
    expect(await store.delete({ key: target.key, ifVersion: target.version })).toEqual({ deleted: true, version: 2 });
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

  // Windows cannot open a directory for fsync (fsyncDirectory ignores EPERM), so the
  // post-rename root flush this test requires is never observable there.
  it.skipIf(process.platform === "win32")("flushes durable compaction before and after rename", async () => {
    const meshRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-mesh-bounded-"));
    roots.push(meshRoot);
    const store = new MeshStore(meshRoot, 512, 100, {
      durability: "fsync",
      maxEventLogBytes: 2_000,
      retainedEventLogBytes: 800,
    });
    const eventsPath = path.join(meshRoot, "events.jsonl");
    const trace = traceDurableIo();
    for (let index = 0; index < 30; index += 1) {
      await store.publish({ topic: "team.auth", from: identity, text: `event-${index}` });
    }
    expect(fs.statSync(eventsPath).size).toBeLessThanOrEqual(2_000);

    const renameIndex = trace.findIndex((entry) => entry.op === "rename" && entry.to === eventsPath);
    expect(renameIndex).toBeGreaterThanOrEqual(0);
    const rename = trace[renameIndex] as Extract<TracedIo, { op: "rename" }>;
    expect(rename.from.startsWith(eventsPath + ".")).toBe(true);
    expect(rename.from.endsWith(".tmp")).toBe(true);
    // The compaction temp file is flushed before it replaces the log...
    expect(trace.slice(0, renameIndex)).toContainEqual({ op: "fsync", path: rename.from, flags: "wx" });
    // ...and the root directory is flushed right after, before any later write.
    expect(trace[renameIndex + 1]).toEqual({ op: "fsync", path: meshRoot, flags: "r" });
  });

  it("flushes the repaired event log in durable mode", async () => {
    const store = createStore({ durability: "fsync" });
    await store.publish({ topic: "team.auth", from: identity, text: "one" });
    const eventsPath = path.join(store.root, "events.jsonl");
    fs.appendFileSync(eventsPath, '{"sequence":999');

    const trace = traceDurableIo();
    await store.publish({ topic: "team.auth", from: identity, text: "two" });

    // The repair truncates through an "r+" descriptor; appends use "a", so this
    // entry is the repair flush and not the later append flush.
    expect(trace).toContainEqual({ op: "fsync", path: eventsPath, flags: "r+" });
    expect(store.read().map((event) => event.text)).toEqual(["one", "two"]);
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

  it("sweeps a lock whose owner file is corrupt once it is older than the stale window", async () => {
    const store = createStore();
    const lockPath = holdLock(store, "not-a-valid-owner");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, past, past);

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

describe("MeshStore short-lock leaks (#323)", () => {
  const holdLock = (store: MeshStore, owner: string): string => {
    const lockPath = path.join(store.root, ".lock");
    fs.mkdirSync(lockPath, { mode: 0o700 });
    fs.writeFileSync(path.join(lockPath, "owner"), owner);
    return lockPath;
  };
  const age = (target: string, ms: number): void => {
    const past = new Date(Date.now() - ms);
    fs.utimesSync(target, past, past);
  };

  it("partial owner: keeps a fresh lock with an empty owner file until the stale window passes", async () => {
    const store = createStore({ lockTimeoutMs: 300, staleLockMs: 30_000 });
    const lockPath = holdLock(store, "");
    await expect(
      store.publish({ topic: "team.auth", from: identity, text: "blocked" }),
    ).rejects.toThrow("Timed out waiting for the Fabric mesh lock");
    expect(fs.readFileSync(path.join(lockPath, "owner"), "utf8")).toBe("");

    age(lockPath, 60_000);
    const event = await store.publish({ topic: "team.auth", from: identity, text: "recovered" });
    expect(event.sequence).toBe(1);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("partial owner: publishes the owner file atomically, never empty at the lock path", async () => {
    const store = createStore();
    const ownerPath = path.join(store.root, ".lock", "owner");
    const writeFileSync = fs.writeFileSync;
    const targets: string[] = [];
    vi.spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, data: unknown, options?: unknown) => {
      targets.push(String(file));
      if (String(file).startsWith(`${ownerPath}.`)) expect(fs.existsSync(ownerPath)).toBe(false);
      return writeFileSync(file, data as string, options as fs.WriteFileOptions);
    }) as typeof fs.writeFileSync);
    await store.publish({ topic: "team.auth", from: identity, text: "hello" });
    expect(targets).not.toContain(ownerPath);
    expect(targets.some((target) => target.startsWith(`${ownerPath}.`))).toBe(true);
  });

  it("hold ceiling: reaps a live same-host owner's leaked lock and keeps a young one", async () => {
    const leaked = createStore({ lockTimeoutMs: 2_000, staleLockMs: 30_000 });
    const leakedPath = holdLock(leaked, `leaked\n${process.pid}\n${Date.now() - 3_600_000}\n${encodeOwnerIdentityLine()}\n`);
    const event = await leaked.publish({ topic: "team.auth", from: identity, text: "recovered" });
    expect(event.sequence).toBe(1);
    expect(fs.existsSync(leakedPath)).toBe(false);

    const young = createStore({ lockTimeoutMs: 300, staleLockMs: 30_000 });
    const owner = `held\n${process.pid}\n${Date.now() - 5_000}\n${encodeOwnerIdentityLine()}\n`;
    const youngPath = holdLock(young, owner);
    await expect(
      young.publish({ topic: "team.auth", from: identity, text: "blocked" }),
    ).rejects.toThrow("Timed out waiting for the Fabric mesh lock");
    expect(fs.readFileSync(path.join(youngPath, "owner"), "utf8")).toBe(owner);
  });

  it("rename-claim: sweeps stale claim dirs while recovering a lock", async () => {
    const store = createStore();
    const lockPath = holdLock(store, `crashed\n999999999\n${Date.now() - 60_000}\n`);
    const stale = `${lockPath}.reap-7-00000000-0000-4000-8000-000000000000`;
    fs.mkdirSync(stale);
    // Claim age alone no longer authorizes deletion. Make the owner exceed
    // the hold ceiling as well, independent of whether PID 7 exists on this OS.
    fs.writeFileSync(path.join(stale, "owner"), `old\n${process.pid}\n${Date.now() - 3_600_000}\n`);
    age(stale, 60_000);
    await store.publish({ topic: "team.auth", from: identity, text: "recovered" });
    expect(fs.readdirSync(store.root).filter((name) => name.startsWith(".lock"))).toEqual([]);
  });

  it("rename-claim: a release while a reaper holds the lock leaves no lock behind", async () => {
    const store = createStore();
    const lockPath = path.join(store.root, ".lock");
    const claim = `${lockPath}.reap-1-t${Date.now()}-00000000-0000-4000-8000-000000000000`;
    await store.publish({ topic: "team.auth", from: identity, text: "warm" });
    await store.transact(() => {
      // A reaper claims the live lock just before the critical section ends.
      fs.renameSync(lockPath, claim);
    });
    // The reaper's rename-back now finds nothing to restore.
    expect(() => fs.renameSync(claim, lockPath)).toThrow();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
