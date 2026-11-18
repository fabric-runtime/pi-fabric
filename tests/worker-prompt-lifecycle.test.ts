import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActorManager } from "../src/actors/manager.js";
import { MeshStore } from "../src/mesh/store.js";

// Drives dist/worker.js, so it needs a build, like tests/worker-e2e.test.ts.
const hasWorker = fs.existsSync(path.resolve("dist/worker.js"));
const HANDLED = "Pi handled the task without starting a turn; terminating child";
const roots: string[] = [];
const managers: AgentManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()));
  vi.unstubAllEnvs();
  // Workers are closed above; Windows may briefly retain released file handles.
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
const setup = (scenario = "handled", accelerated = false, timeoutMs = 5_000) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-prompt-"));
  roots.push(root);
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));
  vi.stubEnv("FAKE_PROMPT_ROOT", root);
  fs.writeFileSync(path.join(root, "scenario"), scenario);
  let wake!: () => void;
  const awakened = new Promise<void>(resolve => { wake = resolve; });
  const completed = vi.fn(() => wake());
  const manager = new AgentManager(root, { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi", timeoutMs, maxConcurrent: 1 }, {
    workerPath: path.resolve(accelerated ? "tests/fixtures/prompt-worker-clock.mjs" : "dist/worker.js"),
    piBinary: path.resolve("tests/fixtures/fake-pi-prompt.mjs"),
    runRoot: path.join(root, "runs"), onBackgroundComplete: completed,
  });
  managers.push(manager);
  return { root, manager, completed, awakened };
};

describe.skipIf(!hasWorker)("real worker initial prompt lifecycle", () => {
  it.each(["handled", "handled-tail", "handled-stubborn"])("fails a %s zero-turn task, wakes the parent once and sends no provider request", async scenario => {
    // The handled-task grace period is accelerated; a child that exits
    // (handled-tail) is failed at once without waiting for it.
    const { root, manager, completed, awakened } = setup(scenario, true, 20_000);
    const handle = await manager.spawn({ task: "synthetic task", extensions: false, transport: "process" });
    manager.detachSignal(handle.id);
    await awakened;
    const result = await manager.wait(handle.id);
    expect(result.status).toBe("failed");
    expect(result.error).toBe(HANDLED);
    expect(result.turns).toBe(0);
    expect(result.toolCalls).toBe(0);
    expect(result.usage.input + result.usage.output).toBe(0);
    expect(completed).toHaveBeenCalledExactlyOnceWith(result);
    expect(manager.listForUi().some(run => run.status === "running")).toBe(false);
    expect(fs.readFileSync(path.join(root, "sends"), "utf8")).toBe("0");
    expect(fs.readFileSync(path.join(root, "prompts"), "utf8")).toBe("1");
    const child = Number(fs.readFileSync(path.join(root, "child-pid"), "utf8"));
    expect(() => process.kill(child, 0)).toThrow();
    // handled-stubborn ignores SIGTERM, so it waits out the kill grace period.
  }, 30_000);

  it("lets an extension command that handled the prompt start its own turn", async () => {
    const { root, manager } = setup("handled-then-turn", true);
    const result = await manager.run({ task: "synthetic task", extensions: false, transport: "process" });
    expect(result).toMatchObject({ status: "completed", text: "done", turns: 1 });
    expect(fs.readFileSync(path.join(root, "sends"), "utf8")).toBe("1");
  });

  it("carries the child's refusal notice into the handled-task failure", async () => {
    const { root, manager } = setup("handled-notice", true, 20_000);
    const result = await manager.run({ task: "synthetic task", extensions: false, transport: "process" });
    expect(result).toMatchObject({ status: "failed", turns: 0, error:
      "Pi handled the task without starting a turn; terminating child. Child notice: Synthetic refusal. Select in-group/model, then send again." });
    expect(fs.readFileSync(path.join(root, "sends"), "utf8")).toBe("0");
  });

  it("bounds a legacy ack through the real worker without replay", async () => {
    const { root, manager } = setup("legacy", true);
    const result = await manager.run({ task: "synthetic task", extensions: false, transport: "process" });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Pi acknowledged the task but did not start a turn within 300000ms; terminating child");
    expect(fs.readFileSync(path.join(root, "sends"), "utf8")).toBe("0");
    expect(fs.readFileSync(path.join(root, "prompts"), "utf8")).toBe("1");
    expect(manager.listForUi().some(run => run.status === "running")).toBe(false);
    const childPid = Number(fs.readFileSync(path.join(root, "child-pid"), "utf8"));
    // Terminal status can appear before the OS finishes reaping the child.
    await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow(), { timeout: 3_000 });
  });

  it.each(["started", "queued", "race", "started-handled"])("completes a %s task without false rejection", async scenario => {
    const { root, manager } = setup(scenario, true);
    const result = await manager.run({ task: "synthetic task", extensions: false, transport: "process" });
    expect(result).toMatchObject({ status: "completed", text: "done", turns: 1 });
    expect(fs.readFileSync(path.join(root, "sends"), "utf8")).toBe("1");
  });

  it.each(["steer", "followUp"] as const)("keeps an active task alive after handled %s and operator command receipts", async kind => {
    const { root, manager } = setup("control", true);
    const handle = await manager.spawn({ task: "synthetic task", extensions: false, transport: "process" });
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, "active"))).toBe(true), { timeout: 2_000, interval: 10 });
    manager[kind](handle.id, "synthetic control");
    const result = await manager.wait(handle.id);
    expect(result).toMatchObject({ status: "completed", text: "done", turns: 1 });
    expect(fs.readFileSync(path.join(root, "sends"), "utf8")).toBe("1");
  });

  it("cancels an acknowledged zero-turn task and leaves no child or active state", async () => {
    const { root, manager } = setup("cancel", true);
    const handle = await manager.spawn({ task: "synthetic task", extensions: false, transport: "process" });
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, "acknowledged"))).toBe(true), { timeout: 2_000, interval: 10 });
    await manager.stop(handle.id);
    const result = await manager.wait(handle.id);
    expect(result.status).toBe("stopped");
    expect(fs.readFileSync(path.join(root, "sends"), "utf8")).toBe("0");
    expect(manager.listForUi().some(run => run.status === "running")).toBe(false);
    const childPid = Number(fs.readFileSync(path.join(root, "child-pid"), "utf8"));
    // Terminal status can appear before the OS finishes reaping the child.
    await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow(), { timeout: 3_000 });
  });

  it.each(["text", "directive"] as const)("finishes a consumed %s actor activation without stopping the persistent mailbox", async responseMode => {
    const { root, manager } = setup("handled", true);
    const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 100);
    const actors = new ActorManager("prompt-test", {
      id: "session:prompt-test", name: "main", kind: "main", sessionId: "prompt-test",
    }, mesh, { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 }, manager, () => {}, {
      actorRoot: path.join(root, "actors"),
    });
    try {
      const actor = await actors.create({ name: "prompt-actor", instructions: "Synthetic role", extensions: false,
        responseMode, transport: "process" });
      if (responseMode === "text") {
        await expect(actors.ask(actor.id, "synthetic message")).rejects.toThrow(HANDLED);
      } else {
        await expect(actors.ask(actor.id, "synthetic message")).resolves.toMatchObject({ action: "silent",
          error: HANDLED });
      }
      await vi.waitFor(() => expect(actors.status(actor.id).status).toBe("idle"));
      expect(fs.readFileSync(path.join(root, "sends"), "utf8")).toBe("0");
      // Persistence belongs to the mailbox/session, not to a child RPC process.
      fs.writeFileSync(path.join(root, "scenario"), "started");
      if (responseMode === "text") {
        await expect(actors.ask(actor.id, "next accepted message")).resolves.toMatchObject({ text: "done" });
      }
    } finally {
      await actors.close();
    }
  });

  it("preserves native success-false prompt failure", async () => {
    const { root, manager } = setup("native-reject");
    const result = await manager.run({ task: "synthetic task", extensions: false, transport: "process" });
    expect(result).toMatchObject({ status: "failed", error: "native rejection" });
    expect(fs.readFileSync(path.join(root, "sends"), "utf8")).toBe("0");
  });
});
