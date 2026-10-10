import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";

const managers: AgentManager[] = [];
const roots: string[] = [];
const setup = (retainRuns = true, extra: ConstructorParameters<typeof AgentManager>[2] = {}) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "manager-close-test-"));
  roots.push(tempRoot);
  vi.spyOn(os, "tmpdir").mockReturnValue(tempRoot);
  vi.stubEnv("PI_FABRIC_RUN_ROOT", undefined);
  vi.stubEnv("PI_FABRIC_DEPTH", "0");
  for (const key of ["PI_FABRIC_BUDGET", "PI_FABRIC_BUDGET_FILE", "PI_FABRIC_BUDGET_ID"]) vi.stubEnv(key, undefined);
  const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, budgetUsd: 0, maxConcurrent: 1, retainRuns, transport: "process", sessionExport: false }, {
    workerPath: path.resolve("tests/fixtures/fake-worker.mjs"), ...extra,
  });
  managers.push(manager);
  const name = fs.readdirSync(tempRoot).find((name) => name.startsWith("pi-fabric-runs-"));
  return { manager, tempRoot, root: name ? path.join(tempRoot, name) : extra.runRoot! };
};
afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentManager close storage", () => {
  it("removes empty managed roots immediately, without recreating them on repeated close", async () => {
    const { manager, root } = setup();
    const first = manager.close();
    expect(manager.close()).toBe(first);
    await first;
    expect(fs.existsSync(root)).toBe(false);
    await manager.close();
    expect(fs.existsSync(root)).toBe(false);
    await expect(manager.spawn({ task: "late" })).rejects.toThrow("closing");
  });

  it("honors retainRuns:false for a managed root after stopping a running worker", async () => {
    const { manager, root } = setup(false);
    await manager.spawn({ task: "HANG", runner: "pi", extensions: false });
    expect(fs.readdirSync(root).length).toBeGreaterThan(1);
    await manager.close();
    expect(fs.existsSync(root)).toBe(false);
  });

  it("removes a managed root holding a finished run's pi-durable journal (#229)", async () => {
    const { manager, root } = setup(false);
    const result = await manager.run({ task: "hello", runner: "pi", extensions: false });
    // The pi-durable runner journals beside status.json in the run directory.
    const store = path.join(root, result.id, "durable", "initial", "store");
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, "..", "lease.sqlite"), "");
    fs.writeFileSync(path.join(store, "main.jsonl"), "{}\n");
    await manager.close();
    expect(fs.existsSync(root)).toBe(false);
  });

  it("retains closed managed run artifacts by default", async () => {
    const { manager, root } = setup(true);
    await manager.run({ task: "hello", runner: "pi", extensions: false });
    await manager.close();
    expect(fs.existsSync(root)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, ".fabric-owner.json"), "utf8"))).toMatchObject({ childrenStopped: true, closedAt: expect.any(Number) });
  });

  it("preserves unknown managed-root contents even when deletion was requested", async () => {
    const { manager, root } = setup(false);
    fs.writeFileSync(path.join(root, "unrelated"), "not an agent artifact");
    await manager.close();
    expect(fs.readFileSync(path.join(root, "unrelated"), "utf8")).toBe("not an agent artifact");
  });

  it("does not follow a replaced managed root or a malformed ownership marker", async () => {
    const { manager, root, tempRoot } = setup(false);
    fs.writeFileSync(path.join(root, ".fabric-owner.json"), "{}");
    await manager.close();
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.existsSync(tempRoot)).toBe(true);
  });

  it("does not perform retention scans merely by constructing a manager", async () => {
    const { manager, tempRoot } = setup();
    const sentinel = path.join(tempRoot, "pi-fabric-runs-sentinel");
    fs.mkdirSync(sentinel);
    const marker = { pid: 2147483647, startedAt: 1, heartbeatAt: 1, orphanedAt: 1 };
    fs.writeFileSync(path.join(sentinel, ".fabric-owner.json"), JSON.stringify(marker));
    const second = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, budgetUsd: 0 });
    managers.push(second);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fs.existsSync(sentinel)).toBe(true);
    await manager.close();
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it("preserves explicit caller roots with retainRuns:true", async () => {
    const caller = fs.mkdtempSync(path.join(os.tmpdir(), "caller-root-"));
    roots.push(caller);
    fs.writeFileSync(path.join(caller, "mine"), "caller data");
    const { manager } = setup(true, { runRoot: caller });
    await manager.close();
    expect(fs.readFileSync(path.join(caller, "mine"), "utf8")).toBe("caller data");
    expect(fs.existsSync(path.join(caller, ".fabric-owner.json"))).toBe(false);
  });

  it("cancels queued admissions on close instead of launching after shutdown", async () => {
    const { manager, root } = setup(false);
    await manager.spawn({ task: "HANG", extensions: false });
    const queued = manager.spawn({ task: "queued", extensions: false });
    const rejected = expect(queued).rejects.toThrow("Operation aborted");
    await Promise.all([rejected, manager.close()]);
    expect(fs.existsSync(root)).toBe(false);
  });

  it("waits for a pending spawn to observe close before deleting the root", async () => {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const { manager, root } = setup(false, { preparePiModel: async () => { await gate; } });
    const spawning = manager.spawn({ task: "hello" });
    const rejected = expect(spawning).rejects.toThrow("closing");
    await Promise.resolve();
    const closed = manager.close();
    resume();
    await Promise.all([rejected, closed]);
    expect(fs.existsSync(root)).toBe(false);
  });
});
