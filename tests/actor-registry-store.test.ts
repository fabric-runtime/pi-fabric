import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorManager } from "../src/actors/manager.js";
import { ActorRegistryStore } from "../src/actors/registry-store.js";
import { ActorStoreReadError } from "../src/actors/store-read.js";
import { AgentManager } from "../src/agents/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { MeshStore } from "../src/mesh/store.js";

// Mode 000 does not stop the read on Windows or for root.
const unreadableFileSkip =
  process.platform === "win32"
    ? "Windows does not deny reads by POSIX mode bits"
    : process.getuid?.() === 0
      ? "root reads a mode-000 file"
      : undefined;

const roots: string[] = [];
const closers: Array<() => Promise<unknown>> = [];
const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-registry-test-"));
  roots.push(root);
  const actorRoot = path.join(root, "actors");
  const registryPath = path.join(actorRoot, "actors.json");
  const lockPath = `${registryPath}.lock`;
  return { store: new ActorRegistryStore(actorRoot), actorRoot, registryPath, lockPath };
};

const installLock = (lockPath: string, pid: number, createdAt: number) => {
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, "owner"), `previous\n${pid}\n${createdAt}\n`);
};

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ActorRegistryStore", () => {
  it("round-trips format 1 records and fingerprints atomic replacements", async () => {
    const { store, lockPath } = setup();
    expect(store.fingerprint()).toBeUndefined();
    expect(store.records()).toEqual([]);
    const first = { id: "first", rootId: "remote", extra: { preserved: true } };
    await store.withLock(() => {
      expect(fs.existsSync(lockPath)).toBe(true);
      store.write([first]);
    });
    const before = store.fingerprint();
    expect(before).toBeTypeOf("string");
    await store.withLock(() => store.write([...store.records(), { id: "second" }]));
    expect(store.read()).toEqual({ format: 1, actors: [first, { id: "second" }] });
    expect(store.fingerprint()).not.toBe(before);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("preserves unknown record fields and filters only invalid record identities", () => {
    const { store, actorRoot, registryPath } = setup();
    fs.mkdirSync(actorRoot);
    for (const raw of ["bad json", "null", "[]", '{"actors":{}}']) {
      fs.writeFileSync(registryPath, raw);
      expect(() => store.records()).toThrow(ActorStoreReadError);
    }
    const record = { id: "", futureField: [1, 2] };
    fs.writeFileSync(registryPath, JSON.stringify({ actors: [null, [], 1, {}, { id: 1 }, record] }));
    expect(store.records()).toEqual([record]);
  });

  it("releases its lock on a throwing callback and propagates the original error", async () => {
    const { store, lockPath } = setup();
    const error = new Error("write failed");
    await expect(store.withLock(() => { throw error; })).rejects.toBe(error);
    expect(fs.existsSync(lockPath)).toBe(false);
    await expect(store.withLock(() => 42)).resolves.toBe(42);
  });

  it("never releases a replacement owner's lock", async () => {
    const { store, lockPath } = setup();
    await store.withLock(() => {
      fs.writeFileSync(path.join(lockPath, "owner"), "replacement\n1\n0\n");
    });
    expect(fs.readFileSync(path.join(lockPath, "owner"), "utf8")).toBe("replacement\n1\n0\n");
  });

  it("recovers a stale lock only when its owning process is gone", async () => {
    const { store, lockPath } = setup();
    installLock(lockPath, 123456, Date.now() - 30_001);
    vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("ESRCH"); });
    await expect(store.withLock(() => "recovered")).resolves.toBe("recovered");
    expect(process.kill).toHaveBeenCalledWith(123456, 0);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("waits for a live owner without stealing its stale lock", async () => {
    vi.useFakeTimers();
    const { store, lockPath } = setup();
    installLock(lockPath, process.pid, Date.now() - 30_001);
    const operation = vi.fn(() => "acquired");
    const pending = store.withLock(operation);
    await vi.advanceTimersByTimeAsync(20);
    expect(operation).not.toHaveBeenCalled();
    fs.rmSync(lockPath, { recursive: true });
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toBe("acquired");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("times out on incomplete locks without running the callback", async () => {
    vi.useFakeTimers();
    const { store, lockPath } = setup();
    fs.mkdirSync(lockPath, { recursive: true });
    const operation = vi.fn();
    const result = expect(store.withLock(operation)).rejects.toThrow(
      "Timed out waiting for the Fabric actor registry lock",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await result;
    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(true);
  });
});

describe("ActorRegistryStore read failures", () => {
  const remote = { id: "f".repeat(32), rootId: "remote-host", name: "remote", note: "another host" };

  it("loads a missing registry as empty and lists only valid entries", () => {
    const { store, registryPath } = setup();
    expect(store.entries()).toEqual([]);
    expect(store.records()).toEqual([]);
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify({ format: 1, actors: [remote, { name: "no id" }, null] }));
    expect(store.entries()).toEqual([remote, { name: "no id" }, null]);
    expect(store.records()).toEqual([remote]);
  });

  it("fails the read when the registry is a directory", () => {
    const { store, registryPath } = setup();
    fs.mkdirSync(registryPath, { recursive: true });
    const failure = (() => {
      try {
        store.records();
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(ActorStoreReadError);
    expect(((failure as Error).cause as NodeJS.ErrnoException).code).toBe("EISDIR");
  });

  /** A persistent host that owns one actor in a shared registry. */
  const ownerHost = async () => {
    const { actorRoot, registryPath, store } = setup();
    const root = path.dirname(actorRoot);
    const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 100);
    const agents = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
      workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
      runRoot: path.join(root, "runs"),
    });
    closers.push(() => agents.close());
    const actors = new ActorManager(
      "test",
      { id: "session:test", name: "main", kind: "main", sessionId: "test" },
      mesh,
      { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 },
      agents,
      () => {},
      { actorRoot, persistent: true },
    );
    closers.push(() => actors.close());
    const actor = await actors.create({ name: "local", instructions: "Observe." });
    return { actors, actor, registryPath, store };
  };

  it.each([
    ["truncated JSON", (owned: unknown) => JSON.stringify({ format: 1, actors: [remote, owned] }).slice(0, -3)],
    ["a non-array actors field", () => JSON.stringify({ format: 1, actors: { [remote.id]: remote } })],
  ])("refuses to save over %s and leaves other hosts' rows on disk", async (_label, corrupt) => {
    const { actors, actor, registryPath, store } = await ownerHost();
    const raw = corrupt(store.records().find((record) => record.id === actor.id));
    fs.writeFileSync(registryPath, raw);

    await expect(actors.setInstructions(actor.id, "Changed after a failed read.")).rejects.toThrow(
      ActorStoreReadError,
    );
    expect(fs.readFileSync(registryPath, "utf8")).toBe(raw);
    // Suspending owned actors on close is the other save path.
    await expect(actors.close()).rejects.toThrow(ActorStoreReadError);
    expect(fs.readFileSync(registryPath, "utf8")).toBe(raw);
  });

  it(
    "refuses to save over a registry it has no permission to read",
    async ({ skip }) => {
      skip(unreadableFileSkip !== undefined, unreadableFileSkip);
      const { actors, actor, registryPath, store } = await ownerHost();
      const raw = JSON.stringify({ format: 1, actors: [remote, ...store.records()] }, null, 2);
      fs.writeFileSync(registryPath, raw);
      fs.chmodSync(registryPath, 0o000);
      try {
        await expect(actors.setInstructions(actor.id, "Changed after a failed read.")).rejects.toThrow(
          ActorStoreReadError,
        );
      } finally {
        fs.chmodSync(registryPath, 0o600);
      }
      expect(fs.readFileSync(registryPath, "utf8")).toBe(raw);
    },
  );

  it("keeps entries that fail validation when a host rewrites the registry", async () => {
    const { actors, actor, registryPath, store } = await ownerHost();
    const noId = { name: "no id", note: "written by a future version" };
    fs.writeFileSync(
      registryPath,
      JSON.stringify({ format: 1, actors: [noId, remote, null, ...store.records()] }),
    );

    await actors.setInstructions(actor.id, "Changed after a good read.");

    const saved = store.entries();
    expect(saved).toEqual(expect.arrayContaining([noId, remote, null]));
    expect(saved).toHaveLength(4);
    expect(store.records().find((record) => record.id === actor.id)).toMatchObject({
      instructions: "Changed after a good read.",
    });
  });
});
