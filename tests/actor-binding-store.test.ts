import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorBindingStore } from "../src/actors/binding-store.js";
import { encodeOwnerIdentityLine } from "../src/core/atomic-write.js";
import { deadChildPid } from "./dead-child-pid.js";

const roots: string[] = [];

const setup = (): { first: ActorBindingStore; second: ActorBindingStore } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-bindings-"));
  roots.push(root);
  return {
    first: new ActorBindingStore("session:shared", root),
    second: new ActorBindingStore("session:shared", root),
  };
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

describe("ActorBindingStore", () => {
  it("recovers a fresh lock at once when its local owner is provably dead", async () => {
    const { first } = setup();
    const lockPath = `${first.filePath!}.lock`;
    const pid = deadChildPid();
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner"), `crashed\n${pid}\n${Date.now()}\n${encodeOwnerIdentityLine()}\n`);

    const started = performance.now();
    await first.setModel("actor:a", "provider/model-a");

    expect(performance.now() - started).toBeLessThan(2_000);
    expect(first.get("actor:a")).toMatchObject({ model: "provider/model-a" });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it.each([["fresh", 0], ["stale", 60_000]] as const)(
    "keeps a lock that a new owner takes between the %s dead-owner check and the removal",
    async (_age, ageMs) => {
      const { first } = setup();
      const lockPath = `${first.filePath!}.lock`;
      const ownerPath = path.join(lockPath, "owner");
      const pid = deadChildPid();
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
      const result = expect(first.setModel("actor:a", "provider/model-a")).rejects.toThrow(
        "Timed out waiting for the Fabric actor binding lock",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await result;

      expect(ownerReads).toBeGreaterThan(2);
      expect(readFileSync(ownerPath, "utf8")).toBe(successor);
      expect(fs.readdirSync(path.dirname(lockPath)).filter((name) => name.includes(".lock."))).toEqual([]);
    },
  );

  it("honours a fresh legacy or foreign lock with a dead pid until the timeout", async () => {
    const pid = deadChildPid();
    for (const identityLine of [undefined, foreignNamespaceLine()]) {
      const { first } = setup();
      const lockPath = `${first.filePath!}.lock`;
      vi.useFakeTimers();
      const owner = `previous\n${pid}\n${Date.now()}\n${identityLine ?? ""}`;
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(path.join(lockPath, "owner"), owner);
      const result = expect(first.setModel("actor:a", "provider/model-a")).rejects.toThrow(
        "Timed out waiting for the Fabric actor binding lock",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await result;
      expect(fs.readFileSync(path.join(lockPath, "owner"), "utf8")).toBe(owner);
      vi.useRealTimers();
      expect(first.get("actor:a")).toBeUndefined();
    }
  });

  it("merges unrelated writes from stale stores under one session lock", async () => {
    const { first, second } = setup();

    await first.setModel("actor:a", "provider/model-a");
    await second.setThinking("actor:b", "high");

    expect(first.get("actor:a")).toMatchObject({ model: "provider/model-a" });
    expect(first.get("actor:b")).toMatchObject({ thinking: "high" });
    expect(second.get("actor:a")).toMatchObject({ model: "provider/model-a" });
  });

  it("deletes a binding from the latest file instead of a stale snapshot", async () => {
    const { first, second } = setup();
    await first.setModel("actor:a", "provider/model-a");
    await first.setModel("actor:b", "provider/model-b");

    await second.delete("actor:a");

    expect(first.get("actor:a")).toBeUndefined();
    expect(first.get("actor:b")).toMatchObject({ model: "provider/model-b" });
  });
});
