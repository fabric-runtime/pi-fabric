import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentOwnerIdentity,
  decodeOwnerIdentityLine,
  encodeOwnerIdentityLine,
  lockOwnerLiveness,
  lockOwnerProvablyDead,
  OWNER_HEARTBEAT_INTERVAL_MS,
  OWNER_HEARTBEAT_TTL_MS,
  ownerHeartbeatFields,
  ownerLiveness,
  parseProcStartedAt,
  recordOwnerLiveness,
  SHORT_LOCK_MAX_HOLD_MS,
  startOwnerHeartbeat,
  type LivenessProbes,
  type OwnerIdentity,
} from "../src/core/atomic-write.js";
import { FileLockTimeoutError, withExclusiveFileLock } from "../src/core/file-lock.js";
import { liveOwnerPid } from "../src/residency/launcher-owner.js";

const NOW = 1_700_000_000_000;
const self: OwnerIdentity = {
  pid: 1,
  hostname: "node-a",
  pidNamespace: "pid:[4026531836]",
  bootId: "boot-a",
  startedAt: NOW - 60_000,
};
const probes = (overrides: Partial<LivenessProbes> = {}): LivenessProbes => ({
  self: () => self,
  signal: vi.fn(() => "alive" as const),
  processStartedAt: () => undefined,
  now: () => NOW,
  ...overrides,
});
const local = { pid: 42, hostname: "node-a", pidNamespace: self.pidNamespace!, bootId: "boot-a", startedAt: NOW - 5_000 };

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const tempRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-liveness-"));
  roots.push(root);
  return root;
};

describe("ownerLiveness", () => {
  it("trusts the signal probe inside the same host, namespace and boot", () => {
    expect(ownerLiveness(local, { probes: probes() })).toBe("alive");
    expect(ownerLiveness(local, { probes: probes({ signal: () => "dead" }) })).toBe("dead");
    expect(ownerLiveness(local, { probes: probes({ signal: () => "unknown" }) })).toBe("unknown");
  });

  it("treats both-undefined namespace and boot as the same place", () => {
    const bare: OwnerIdentity = { pid: self.pid, hostname: self.hostname, startedAt: self.startedAt };
    const signal = vi.fn(() => "dead" as const);
    expect(ownerLiveness({ pid: 9, hostname: "node-a", startedAt: 0 }, { probes: probes({ self: () => bare, signal }) })).toBe("dead");
    expect(signal).toHaveBeenCalledWith(9);
  });

  it("detects PID reuse from a different process start time", () => {
    const reused = probes({ processStartedAt: () => local.startedAt + 30_000 });
    expect(ownerLiveness(local, { probes: reused })).toBe("dead");
    const jitter = probes({ processStartedAt: () => local.startedAt + 500 });
    expect(ownerLiveness(local, { probes: jitter })).toBe("alive");
    // Without a boot id the start time is not procfs-derived; never compare.
    const { bootId: _boot, ...noBoot } = local;
    const { bootId: _selfBoot, ...bootless } = self;
    expect(ownerLiveness(noBoot, {
      probes: probes({ self: () => bootless, processStartedAt: () => 0 }),
    })).toBe("alive");
  });

  it("relies on the heartbeat across PID namespaces and never probes the PID", () => {
    const signal = vi.fn(() => "dead" as const);
    const foreign = { ...local, pidNamespace: "pid:[4026532999]" };
    const options = { probes: probes({ signal }), heartbeatTtlMs: 45_000 };
    expect(ownerLiveness(foreign, { ...options, heartbeatAt: NOW - 10_000 })).toBe("alive");
    expect(ownerLiveness(foreign, { ...options, heartbeatAt: NOW - 46_000 })).toBe("dead");
    expect(ownerLiveness(foreign, options)).toBe("unknown");
    expect(signal).not.toHaveBeenCalled();
  });

  it("relies on the heartbeat across hosts, and a reboot without one is death", () => {
    const remote = { ...local, hostname: "node-b", bootId: "boot-b" };
    expect(ownerLiveness(remote, { probes: probes(), heartbeatAt: NOW })).toBe("alive");
    expect(ownerLiveness(remote, { probes: probes() })).toBe("unknown");
    const rebooted = { ...local, bootId: "boot-old" };
    expect(ownerLiveness(rebooted, { probes: probes() })).toBe("dead");
    expect(ownerLiveness(rebooted, { probes: probes(), heartbeatAt: NOW - 1_000 })).toBe("alive");
  });

  it("keeps the caller's exact behaviour for legacy records", () => {
    const signal = vi.fn(() => "alive" as const);
    expect(ownerLiveness({ pid: 7 }, { probes: probes({ signal }), legacyAlive: () => false })).toBe("dead");
    expect(signal).not.toHaveBeenCalled();
    expect(ownerLiveness({ pid: 7 }, { probes: probes({ signal }) })).toBe("alive");
    // Legacy records ignore heartbeats entirely.
    expect(ownerLiveness({ pid: 7 }, { legacyAlive: () => true, heartbeatAt: 0 })).toBe("alive");
  });

  it("probes real processes with the default signal mapping", () => {
    expect(ownerLiveness({ pid: process.pid })).toBe("alive");
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    expect(ownerLiveness({ pid: 123_456 })).toBe("dead");
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    expect(ownerLiveness({ pid: 123_456 })).toBe("alive");
    expect(ownerLiveness({ pid: -1 })).toBe("dead");
  });
});

describe("owner identity records", () => {
  it("describes this process and caches it", () => {
    const identity = currentOwnerIdentity();
    expect(identity.pid).toBe(process.pid);
    expect(identity.hostname).toBe(os.hostname());
    expect(Number.isFinite(identity.startedAt)).toBe(true);
    if (process.platform === "linux") expect(identity.pidNamespace).toMatch(/^pid:\[/);
    else expect(identity.pidNamespace).toBeUndefined();
    expect(currentOwnerIdentity()).toEqual(identity);
    // A record written by this process is alive to this process.
    expect(ownerLiveness(identity)).toBe("alive");
  });

  it("parses Linux procfs start time despite parentheses in the command", () => {
    const fields = Array.from({ length: 50 }, (_, index) => String(index + 3));
    fields[19] = "12345";
    const stat = `77 (we ird) (name) ${fields.join(" ")}`;
    expect(parseProcStartedAt(stat, 1_000)).toBe(1_000_000 + 123_450);
    expect(parseProcStartedAt("77 (x) S", 1_000)).toBeUndefined();
  });

  it("round-trips the lock identity line and rejects malformed lines as legacy", () => {
    const decoded = decodeOwnerIdentityLine(encodeOwnerIdentityLine());
    expect(decoded?.hostname).toBe(os.hostname());
    for (const line of [undefined, "", "not json", "{", '{"hostname":1,"startedAt":0}', `{"hostname":"${"x".repeat(2_000)}","startedAt":0}`, '{"hostname":"h"}']) {
      expect(decodeOwnerIdentityLine(line)).toBeUndefined();
    }
  });

  it("uses a short lock's creation time as its heartbeat across namespaces", () => {
    const line = JSON.stringify({ ...local, pid: undefined, pidNamespace: "pid:[foreign]" });
    const options = { probes: probes(), maxHoldMs: 60_000 };
    expect(lockOwnerLiveness(42, NOW - 30_000, line, options)).toBe("alive");
    expect(lockOwnerLiveness(42, NOW - 61_000, line, options)).toBe("dead");
    expect(lockOwnerLiveness(42, Number.NaN, line, options)).toBe("unknown");
    expect(lockOwnerLiveness(42, NOW - 61_000, undefined, { ...options, legacyAlive: () => true })).toBe("alive");
    expect(SHORT_LOCK_MAX_HOLD_MS).toBeGreaterThan(OWNER_HEARTBEAT_TTL_MS);
  });

  it("proves a lock owner dead only in this host, PID namespace and boot", () => {
    const line = (fields: Record<string, unknown>): string => JSON.stringify(fields);
    const sameLine = line({ hostname: "node-a", pidNamespace: self.pidNamespace, bootId: "boot-a", startedAt: NOW - 5_000 });
    const gone = probes({ signal: () => "dead" });
    expect(lockOwnerProvablyDead(42, sameLine, { probes: gone })).toBe(true);
    // The pid is alive but started at another time: it was reused.
    expect(lockOwnerProvablyDead(42, sameLine, { probes: probes({ processStartedAt: () => NOW + 25_000 }) })).toBe(true);
    expect(lockOwnerProvablyDead(42, sameLine, { probes: probes({ processStartedAt: () => NOW - 5_000 }) })).toBe(false);
    expect(lockOwnerProvablyDead(42, sameLine, { probes: probes() })).toBe(false);
    expect(lockOwnerProvablyDead(42, sameLine, { probes: probes({ signal: () => "unknown" }) })).toBe(false);
    // Legacy owners and other hosts, namespaces or boots are never provably dead.
    expect(lockOwnerProvablyDead(42, undefined, { probes: gone })).toBe(false);
    expect(lockOwnerProvablyDead(42, "not json", { probes: gone })).toBe(false);
    expect(lockOwnerProvablyDead(42, line({ hostname: "node-b", pidNamespace: self.pidNamespace, bootId: "boot-a", startedAt: 0 }), { probes: gone })).toBe(false);
    expect(lockOwnerProvablyDead(42, line({ hostname: "node-a", pidNamespace: "pid:[foreign]", bootId: "boot-a", startedAt: 0 }), { probes: gone })).toBe(false);
    expect(lockOwnerProvablyDead(42, line({ hostname: "node-a", startedAt: 0 }), { probes: gone })).toBe(false);
    expect(lockOwnerProvablyDead(42, line({ hostname: "node-a", pidNamespace: self.pidNamespace, bootId: "boot-b", startedAt: 0 }), { probes: gone })).toBe(false);
    // An unusable pid identifies no process, so it proves nothing.
    for (const pid of [Number.NaN, 0, -1, 1.5]) {
      expect(lockOwnerProvablyDead(pid, sameLine, { probes: gone })).toBe(false);
    }
  });

  it("reads nested identity and heartbeat from JSON owner records", () => {
    const { pid: _pid, ...identity } = { ...local, pidNamespace: "pid:[foreign]" };
    const record = { pid: 42, identity, heartbeatAt: NOW - 1_000 };
    expect(recordOwnerLiveness(record, { probes: probes() })).toBe("alive");
    expect(recordOwnerLiveness({ ...record, heartbeatAt: NOW - 50_000 }, { probes: probes() })).toBe("dead");
    expect(recordOwnerLiveness({ pid: 42, identity: { hostname: 3 } }, { legacyAlive: () => false })).toBe("dead");
    expect(recordOwnerLiveness({ pid: "42" })).toBe("dead");
    expect(recordOwnerLiveness(null)).toBe("dead");
    const fields = ownerHeartbeatFields(NOW);
    expect(fields.heartbeatAt).toBe(NOW);
    expect(fields.identity).not.toHaveProperty("pid");
  });

  it("refreshes heartbeats on an interval until stopped and survives refresh errors", () => {
    vi.useFakeTimers();
    const beats: number[] = [];
    let fail = true;
    const stop = startOwnerHeartbeat((at) => {
      if (fail) {
        fail = false;
        throw new Error("disk hiccup");
      }
      beats.push(at);
    });
    vi.advanceTimersByTime(OWNER_HEARTBEAT_INTERVAL_MS * 3);
    expect(beats).toHaveLength(2);
    stop();
    vi.advanceTimersByTime(OWNER_HEARTBEAT_INTERVAL_MS * 3);
    expect(beats).toHaveLength(2);
  });
});

describe("callers", () => {
  const foreignLine = (): string =>
    JSON.stringify({ ...decodeOwnerIdentityLine(encodeOwnerIdentityLine()), pidNamespace: "pid:[foreign-container]" });

  it("file-lock takes over a foreign lock whose implicit heartbeat is stale", () => {
    const directory = tempRoot();
    const lock = path.join(directory, "test.lock");
    fs.mkdirSync(lock);
    // Our own (live) PID: only the namespace mismatch makes the probe untrusted.
    const created = Date.now() - SHORT_LOCK_MAX_HOLD_MS - 60_000;
    fs.writeFileSync(path.join(lock, "owner"), `token\n${process.pid}\n${created}\n${foreignLine()}\n`);
    expect(withExclusiveFileLock({ directory, lockName: "test.lock", timeoutMessage: "busy", attempts: 3, delayMs: 1 }, () => "taken"))
      .toBe("taken");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("file-lock refuses a foreign lock whose heartbeat is still fresh, even if the PID looks dead", () => {
    const directory = tempRoot();
    const lock = path.join(directory, "test.lock");
    fs.mkdirSync(lock);
    const owner = `token\n123456\n${Date.now() - 120_000}\n${foreignLine()}\n`;
    fs.writeFileSync(path.join(lock, "owner"), owner);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    const operation = vi.fn(() => "wrong");
    expect(() => withExclusiveFileLock({
      directory, lockName: "test.lock", timeoutMessage: "busy", attempts: 3, delayMs: 1, staleMs: 1_000,
    }, operation)).toThrow(FileLockTimeoutError);
    expect(operation).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(lock, "owner"), "utf8")).toBe(owner);
  });

  it("file-lock writes an identity line that older readers ignore", () => {
    const directory = tempRoot();
    const text = withExclusiveFileLock({ directory, lockName: "test.lock", timeoutMessage: "busy" }, () =>
      fs.readFileSync(path.join(directory, "test.lock", "owner"), "utf8"));
    const [token, pid, created, identity] = text.split("\n");
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number(pid)).toBe(process.pid);
    expect(Number.isFinite(Number(created))).toBe(true);
    expect(decodeOwnerIdentityLine(identity)?.hostname).toBe(os.hostname());
  });

  it("the resident launcher follows a foreign owner's heartbeat", () => {
    const ownerPath = path.join(tempRoot(), "owner.json");
    const foreign = { ...self, pidNamespace: "pid:[foreign]" };
    const { pid: _pid, ...identity } = foreign;
    const write = (heartbeatAt?: number): void => fs.writeFileSync(ownerPath, JSON.stringify({
      format: 1, hostId: "h", pid: 4242, token: "t", startedAt: NOW, readyAt: NOW, identity,
      ...(heartbeatAt === undefined ? {} : { heartbeatAt }),
    }));
    const signal = vi.fn(() => "dead" as const);
    write(NOW - 5_000);
    expect(liveOwnerPid(ownerPath, probes({ signal }))).toBe(4242);
    write(NOW - OWNER_HEARTBEAT_TTL_MS - 1);
    expect(liveOwnerPid(ownerPath, probes({ signal }))).toBeUndefined();
    // No heartbeat from another namespace: unknown, which is not death.
    write();
    expect(liveOwnerPid(ownerPath, probes({ signal }))).toBe(4242);
    expect(signal).not.toHaveBeenCalled();
    // Legacy owner.json keeps the plain signal probe.
    fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid }));
    expect(liveOwnerPid(ownerPath)).toBe(process.pid);
  });
});
