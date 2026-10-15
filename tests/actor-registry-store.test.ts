import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorRegistryStore } from "../src/actors/registry-store.js";
import { encodeOwnerIdentityLine } from "../src/core/atomic-write.js";
import { deadChildPid } from "./dead-child-pid.js";

const roots: string[] = [];
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

const foreignNamespaceLine = (): string => {
  const own = JSON.parse(encodeOwnerIdentityLine()) as Record<string, unknown>;
  return JSON.stringify({
    hostname: own.hostname,
    pidNamespace: "pid:[1]",
    bootId: own.bootId,
    startedAt: own.startedAt,
  });
};

afterEach(() => {
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
      expect(store.records()).toEqual([]);
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

  it("recovers a fresh lock at once when its local owner is provably dead", async () => {
    const { store, lockPath } = setup();
    const pid = deadChildPid();
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner"), `crashed\n${pid}\n${Date.now()}\n${encodeOwnerIdentityLine()}\n`);

    const started = performance.now();
    await expect(store.withLock(() => "recovered")).resolves.toBe("recovered");

    expect(performance.now() - started).toBeLessThan(2_000);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it.each([["fresh", 0], ["stale", 60_000]] as const)(
    "keeps a lock that a new owner takes between the %s dead-owner check and the removal",
    async (_age, ageMs) => {
      const { store, lockPath } = setup();
      const pid = deadChildPid();
      const ownerPath = path.join(lockPath, "owner");
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(ownerPath, `crashed\n${pid}\n${Date.now() - ageMs}\n${encodeOwnerIdentityLine()}\n`);
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
      vi.useFakeTimers();
      const operation = vi.fn();
      const result = expect(store.withLock(operation)).rejects.toThrow(
        "Timed out waiting for the Fabric actor registry lock",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await result;

      expect(operation).not.toHaveBeenCalled();
      expect(ownerReads).toBeGreaterThan(2);
      expect(readFileSync(ownerPath, "utf8")).toBe(successor);
      expect(fs.readdirSync(path.dirname(lockPath)).filter((name) => name.includes(".lock."))).toEqual([]);
    },
  );

  it("honours a fresh legacy or foreign lock with a dead pid until the timeout", async () => {
    const pid = deadChildPid();
    for (const identityLine of [undefined, foreignNamespaceLine()]) {
      vi.useFakeTimers();
      const { store, lockPath } = setup();
      const owner = `previous\n${pid}\n${Date.now()}\n${identityLine ?? ""}`;
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(path.join(lockPath, "owner"), owner);
      const operation = vi.fn();
      const result = expect(store.withLock(operation)).rejects.toThrow(
        "Timed out waiting for the Fabric actor registry lock",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await result;
      expect(operation).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(lockPath, "owner"), "utf8")).toBe(owner);
      vi.useRealTimers();
    }
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
