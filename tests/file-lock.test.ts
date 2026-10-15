import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeOwnerIdentityLine } from "../src/core/atomic-write.js";
import {
  FileLockTimeoutError, withExclusiveFileLock, withExclusiveFileLockAsync,
  type ExclusiveLockOptions,
} from "../src/core/file-lock.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const setup = (owner?: string, old = true) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-file-lock-"));
  roots.push(directory);
  const lock = path.join(directory, "test.lock");
  fs.mkdirSync(lock);
  if (owner !== undefined) fs.writeFileSync(path.join(lock, "owner"), owner);
  if (old) {
    const age = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, age, age);
  }
  const options: ExclusiveLockOptions = {
    directory, lockName: "test.lock", timeoutMessage: "busy", attempts: 3, delayMs: 1,
  };
  return { lock, options };
};

describe.each(["sync", "async"] as const)("%s file-lock recovery", (mode) => {
  const run = async (options: ExclusiveLockOptions, operation: () => string) =>
    mode === "sync" ? withExclusiveFileLock(options, operation) : withExclusiveFileLockAsync(options, operation);

  it.each([undefined, "garbled", "token\nnot-a-pid\nnot-a-date\n", "token\nnot-a-pid\n99999999999999\n"])(
    "recovers old incomplete or malformed metadata: %s", async (owner) => {
      const { lock, options } = setup(owner);
      await expect(run(options, () => "recovered")).resolves.toBe("recovered");
      expect(fs.existsSync(lock)).toBe(false);
    },
  );

  it("recovers a dead owner's stale lock", async () => {
    const { lock, options } = setup(`token\n123456\n${Date.now() - 60_000}\n`);
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    await expect(run(options, () => "recovered")).resolves.toBe("recovered");
    expect(fs.existsSync(lock)).toBe(false);
  });

  const deadSignal = () => {
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
  };

  it("recovers a fresh lock at once when its local owner is provably dead", async () => {
    const { lock, options } = setup(`token\n123456\n${Date.now()}\n${encodeOwnerIdentityLine()}\n`, false);
    deadSignal();
    await expect(run(options, () => "recovered")).resolves.toBe("recovered");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it.each(["legacy", "foreign namespace"])("keeps a fresh %s lock with a dead pid", async (kind) => {
    const own = JSON.parse(encodeOwnerIdentityLine()) as Record<string, unknown>;
    const identityLine = kind === "legacy" ? "" : `${JSON.stringify({ ...own, pidNamespace: "pid:[1]" })}\n`;
    const owner = `token\n123456\n${Date.now()}\n${identityLine}`;
    const { lock, options } = setup(owner, false);
    deadSignal();
    const operation = vi.fn(() => "wrong");
    await expect(run(options, operation)).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect(operation).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(lock, "owner"), "utf8")).toBe(owner);
  });

  it.each([`${Date.now() - 60_000}`, "invalid"])("protects a live owner with timestamp %s", async (timestamp) => {
    const owner = `token\n${process.pid}\n${timestamp}\n`;
    const { lock, options } = setup(owner);
    const operation = vi.fn(() => "wrong");
    await expect(run(options, operation)).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect(operation).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(lock, "owner"), "utf8")).toBe(owner);
  });

  it("does not treat a permission-denied owner probe as a dead process", async () => {
    const owner = `token\n123456\n${Date.now() - 60_000}\n`;
    const { lock, options } = setup(owner);
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    await expect(run(options, () => "wrong")).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect(fs.readFileSync(path.join(lock, "owner"), "utf8")).toBe(owner);
  });

  it.each([undefined, "garbled"])("gives fresh incomplete locks a grace period: %s", async (owner) => {
    const { lock, options } = setup(owner, false);
    await expect(run(options, () => "wrong")).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it("releases on operation failure without misclassifying the error", async () => {
    const { lock, options } = setup();
    fs.rmSync(lock, { recursive: true });
    const failure = new Error("disk failure");
    await expect(run(options, () => { throw failure; })).rejects.toBe(failure);
    expect(fs.existsSync(lock)).toBe(false);
    await expect(run(options, () => "next")).resolves.toBe("next");
  });

  it("does not remove a replacement owner's lock on release", async () => {
    const { lock, options } = setup();
    fs.rmSync(lock, { recursive: true });
    const owner = `replacement\n${process.pid}\n${Date.now()}\n`;
    await run(options, () => {
      fs.writeFileSync(path.join(lock, "owner"), owner);
      return "done";
    });
    expect(fs.readFileSync(path.join(lock, "owner"), "utf8")).toBe(owner);
  });
});

it("keeps the event loop responsive during contention and succeeds after release", async () => {
  const { lock, options } = setup(`token\n${process.pid}\n${Date.now()}\n`);
  let pulsed = false;
  const pulse = setTimeout(() => {
    pulsed = true;
    fs.rmSync(lock, { recursive: true });
  }, 10);
  try {
    await expect(withExclusiveFileLockAsync({ ...options, attempts: 100, delayMs: 2 }, () => "ok")).resolves.toBe("ok");
    expect(pulsed).toBe(true);
  } finally {
    clearTimeout(pulse);
  }
});
