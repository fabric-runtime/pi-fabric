import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunResult } from "../src/agents/types.js";
import { AgentManager } from "../src/agents/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { initBudgetLedger, readBudgetLedgerDetailed } from "../src/agents/budget-ledger.js";

// End-to-end coverage for the REAL worker (dist/worker.js) driven through
// AgentManager + #monitor, with a stub `pi` binary (tests/fixtures/fake-pi.mjs)
// whose behavior is selected by FAKE_PI_BEHAVIOR. This is the only place the
// real worker.ts spawn/exit path is exercised; the other suites use a fake
// worker that writes status directly. Skips when the package is not built.
const workerPath = path.resolve("dist/worker.js");
const piBinary = path.resolve("tests/fixtures/fake-pi.mjs");
const hasWorker = fs.existsSync(workerPath);

describe.skipIf(!hasWorker)("AgentManager real worker e2e", () => {
  const roots: string[] = [];
  const managers: AgentManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.close()));
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  const run = async (task = "do it", timeoutMs = 2_000): Promise<AgentRunResult> => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-e2e-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" as const, timeoutMs, maxConcurrent: 1 };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath,
      piBinary,
      runRoot: root,
    });
    managers.push(manager);
    return manager.run({ task, transport: "process" });
  };

  // Regression for the LocalTerm shim contract: when the manager resolves the
  // child pi binary to the shim (~/.localterm/shims/pi), the shim injects the
  // wired secret env vars into pi's own process.env, and the worker must pass
  // that environment through to the child it spawns ({ ...process.env }). This
  // test seeds synthetic sentinel vars in the owner process (the same channel
  // the shim uses — env presence, never values) and asserts the child sees
  // them, through the real dist/worker.js spawn path.
  it("inherits the owner environment (shim-injected secrets) in the child Pi process", async () => {
    const present = "FAKE_PI_SENTINEL_SHIM_KEY";
    const absent = "FAKE_PI_SENTINEL_MISSING_KEY";
    process.env.FAKE_PI_BEHAVIOR = "shim-env-inheritance";
    process.env.FAKE_PI_SENTINEL_VARS = `${present},${absent}`;
    process.env[present] = "sentinel";
    delete process.env[absent];
    try {
      const result = await run("report env presence booleans");
      expect(result.status).toBe("completed");
      expect(result.text).toBe(`${present}=present ${absent}=absent`);
    } finally {
      delete process.env.FAKE_PI_SENTINEL_VARS;
      delete process.env[present];
    }
  });

  it.skipIf(process.platform === "win32")("executes the configured Pi shim so it can inject a child-only sentinel", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-shim-"));
    roots.push(root);
    const key = "FAKE_PI_CHILD_ONLY_SHIM_SENTINEL";
    const shim = path.join(root, "pi-shim.mjs");
    fs.writeFileSync(shim, [
      "#!/usr/bin/env node",
      'process.env.FAKE_PI_BEHAVIOR = "shim-env-inheritance";',
      `process.env.FAKE_PI_SENTINEL_VARS = ${JSON.stringify(key)};`,
      `process.env[${JSON.stringify(key)}] = "synthetic-test-value";`,
      `await import(${JSON.stringify(pathToFileURL(piBinary).href)});`,
    ].join("\n"), { mode: 0o755 });
    const before = process.env[key];
    const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" }, { workerPath, piBinary: shim, runRoot: root });
    managers.push(manager);
    const result = await manager.run({ task: "probe shim execution", transport: "process" });
    expect(result.status).toBe("completed");
    expect(result.text).toBe(`${key}=present`);
    expect(process.env[key]).toBe(before);
  });

  it("propagates the root Fabric session identity through the worker", async () => {
    process.env.FAKE_PI_BEHAVIOR = "fabric-session-env";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-e2e-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" }, {
      workerPath,
      piBinary,
      runRoot: root,
      fabricSessionId: "root-session",
    });
    managers.push(manager);

    const result = await manager.run({ task: "report session", transport: "process" });
    expect(result.status).toBe("completed");
    expect(result.text).toBe("root-session");
  });

  const cases: Array<{
    behavior: string;
    timeoutMs?: number;
    check: (r: AgentRunResult) => void;
  }> = [
    {
      behavior: "success",
      check: (r) => {
        expect(r.status).toBe("completed");
        expect(r.text).toContain("hi");
      },
    },
    {
      behavior: "split-utf8",
      check: (r) => {
        expect(r.status).toBe("completed");
        expect(r.text).toBe("界面 🚀");
        expect(r.text).not.toContain("�");
      },
    },
    {
      behavior: "stderr-framing",
      check: (r) => {
        expect(r.status).toBe("completed");
        expect(r.text).toBe("trusted");
        const events = fs
          .readFileSync(r.logFile!, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(events.some((event) => event.type === "worker_stderr")).toBe(true);
        expect(
          events.some(
            (event) =>
              event.type === "message_end" &&
              (event.message as { content?: string } | undefined)?.content === "spoofed",
          ),
        ).toBe(false);
      },
    },
    {
      behavior: "exit-clean",
      check: (r) => {
        expect(r.status).toBe("completed");
      },
    },
    {
      behavior: "exit-error",
      check: (r) => {
        expect(r.status).toBe("failed");
        expect(r.error ?? "").toMatch(/Pi exited with code 1/);
      },
    },
    {
      behavior: "reject",
      check: (r) => {
        expect(r.status).toBe("failed");
        expect(r.error ?? "").toMatch(/provider rejected the prompt/);
      },
    },
    {
      behavior: "hang",
      check: (r) => {
        expect(r.status).toBe("timed_out");
        expect(r.error ?? "").toMatch(/timed out/);
      },
    },
    {
      behavior: "retry-exhausted",
      check: (r) => {
        expect(r.status).toBe("failed");
        expect(r.error).toContain("Error: Terminated (retries exhausted)");
      },
    },
    {
      behavior: "terminated-restart-exit",
      check: (r) => {
        expect(r.status).toBe("failed");
        expect(r.error).toContain("Error: Terminated");
      },
    },
    {
      behavior: "terminated-recover",
      check: (r) => {
        expect(r.status).toBe("completed");
        expect(r.error).toBeUndefined();
        expect(r.text).toBe("recovered");
      },
    },
    {
      behavior: "retry-exhausted-stubborn",
      timeoutMs: 30_000,
      check: (r) => {
        expect(r.status).toBe("failed");
        expect(r.error).toContain("Error: Terminated (retries exhausted)");
        expect(r.error).toContain("did not exit after stdin closed");
      },
    },
    {
      behavior: "kill-worker",
      // Room for attribution: on a slow CI box the spawned worker + fake-pi
      // chain plus the retry consult can brush a 2s wall, letting the generic
      // run deadline beat the transport-death verdict. 8s keeps "failed" vs
      // "timed_out" deterministic while still bounded.
      timeoutMs: 8_000,
      check: (r) => {
        // The worker was hard-killed mid-run: it died before writing a terminal
        // status, so #monitor records the generic failure (with the run-log tail
        // appended when the child logged anything before dying).
        expect(r.status).toBe("failed");
        expect(r.error ?? "").toMatch(/exited without a result/);
      },
    },
  ];

  it.each(cases)("maps child behavior $behavior to the correct run outcome", async ({ behavior, timeoutMs, check }) => {
    process.env.FAKE_PI_BEHAVIOR = behavior;
    const result = await run("do it", timeoutMs);
    try {
      check(result);
    } catch (error) {
      throw new Error(
        `${behavior}: ${(error as Error).message} (status=${result.status} error=${result.error ?? ""})`,
      );
    }
  }, 30_000);

  it.each(["terminated-hang", "retry-hang"])(
    "kills a stalled %s despite lifecycle chatter, EOF and SIGTERM refusal", async (behavior) => {
      process.env.FAKE_PI_BEHAVIOR = behavior;
      // Deliberately much longer than the recovery deadline: generic run timeout
      // must not be what releases wait() or the concurrency slot.
      const result = await run("recover or fail", 120_000);
      expect(result.status).toBe("failed");
      expect(result.error).toContain("Error: Terminated");
      expect(result.error).toContain("no recovery progress for 60000ms");
      expect(result.error).toContain(behavior === "retry-hang"
        ? "the retry turn never started"
        : "Recovery: Pi announced no retry.");
      const events = fs.readFileSync(result.logFile!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const pid = events.find((event) => event.type === "fake_child_pid").pid;
      expect(() => process.kill(pid, 0)).toThrow();
      expect(events.filter((event) => event.type === "fabric_recovery_error")).toHaveLength(1);
      process.env.FAKE_PI_BEHAVIOR = "success";
      expect((await managers.at(-1)!.run({ task: "slot released", transport: "process" })).status).toBe("completed");
    }, 90_000,
  );

  // Both run the source worker so the probe tracks src/worker.ts, not a stale build.
  const runSourceWorker = async (task: string): Promise<AgentRunResult> => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-source-worker-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" as const, timeoutMs: 30_000, maxConcurrent: 1 }, {
      workerPath: path.resolve("src/worker.ts"), piBinary, runRoot: root,
    });
    managers.push(manager);
    return manager.run({ task, transport: "process" });
  };

  it("keeps a run completed when the child answered but does not exit after stdin closes", async () => {
    process.env.FAKE_PI_BEHAVIOR = "answer-then-linger";
    const result = await runSourceWorker("answer then linger");
    expect(result.status, result.error).toBe("completed");
    expect(result.text).toBe("final answer");
    expect(result.error).toBeUndefined();
    const events = fs.readFileSync(result.logFile!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.filter((event) => event.type === "fabric_exit_warning")).toEqual([
      { type: "fabric_exit_warning", warning: "child did not exit after stdin closed for 5000ms; terminated it after its final answer" },
    ]);
    const pid = events.find((event) => event.type === "fake_child_pid").pid;
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);

  it("fails a lingering child whose last message was a tool call", async () => {
    process.env.FAKE_PI_BEHAVIOR = "tool-use-then-linger";
    const result = await runSourceWorker("tool call then linger");
    expect(result.status).toBe("failed");
    expect(result.error).toContain("did not exit after stdin closed");
    const events = fs.readFileSync(result.logFile!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.some((event) => event.type === "fabric_exit_warning")).toBe(false);
    const pid = events.find((event) => event.type === "fake_child_pid").pid;
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);

  it.each(["large-lifecycle", "large-lifecycle-retry"])(
    "preserves progress through oversized lifecycle history (%s)", async (behavior) => {
      process.env.FAKE_PI_BEHAVIOR = behavior;
      const result = await run("finish the image-heavy task", 10_000);
      expect(result.status).toBe("completed");
      expect(result.error).toBeUndefined();
      const retried = behavior.endsWith("retry");
      expect(result.text).toBe(retried ? "retry completed" : "progress preserved");
      expect(result.usage.input).toBe(retried ? 300 : 100);
      expect(result.usage.output).toBe(retried ? 125 : 50);
      expect(result.toolCalls).toBe(1);
      expect(result.turns).toBe(1);
      const log = fs.readFileSync(result.logFile!, "utf8");
      expect(log.length).toBeLessThan(10_000);
      const events = log.trim().split("\n").map((line) => JSON.parse(line));
      expect(events.find((event) => event.type === "turn_end")).toMatchObject({ toolResults: [], turnIndex: 1 });
      expect(events.filter((event) => event.type === "agent_end")).toEqual(retried ? [
        { type: "agent_end", messages: [], willRetry: true },
        { type: "agent_end", messages: [], willRetry: false },
      ] : [{ type: "agent_end", messages: [], willRetry: false }]);
      expect(events.some((event) => event.type === "message_end" && event.message.content === result.text)).toBe(true);
      expect(fs.existsSync(path.join(path.dirname(result.logFile!), "oversized-event-prefix.txt"))).toBe(false);
    }, 30_000,
  );

  it("loads the history projector from a native source worker too", async () => {
    process.env.FAKE_PI_BEHAVIOR = "large-lifecycle";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-source-worker-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" as const, timeoutMs: 10_000 }, {
      workerPath: path.resolve("src/worker.ts"), piBinary, runRoot: root,
    });
    managers.push(manager);
    const result = await manager.run({ task: "preserve source-worker progress", transport: "process" });
    expect(result.status).toBe("completed");
    expect(result.text).toBe("progress preserved");
  }, 30_000);

  it("preserves a bounded prefix when an agent event exceeds the line limit", async () => {
    process.env.FAKE_PI_BEHAVIOR = "oversized-event";
    const result = await run("do it", 10_000);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Agent emitted an oversized event line");
    const artifactPath = result.error?.match(/saved to: (.+)$/)?.[1];
    expect(artifactPath).toBeDefined();
    expect(path.dirname(artifactPath!)).toBe(path.dirname(result.logFile!));

    const prefix = fs.readFileSync(artifactPath!, "utf8");
    expect(prefix).toHaveLength(4 * 1024 * 1024);
    expect(prefix).toMatch(/^\{"type":"message_end","message":\{"role":"assistant","content":"x+/);
    if (process.platform !== "win32") {
      expect(fs.statSync(artifactPath!).mode & 0o777).toBe(0o600);
    }
  }, 30_000);

  describe("agent session usage export", () => {
    const exportRoots: string[] = [];
    let savedExportEnv: string | undefined;

    afterEach(() => {
      if (savedExportEnv === undefined) delete process.env.PI_FABRIC_AGENT_DIR;
      else process.env.PI_FABRIC_AGENT_DIR = savedExportEnv;
      for (const root of exportRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    const runExported = (sessionExport: boolean): Promise<AgentRunResult> => {
      savedExportEnv = savedExportEnv ?? process.env.PI_FABRIC_AGENT_DIR;
      const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-export-e2e-"));
      exportRoots.push(exportRoot);
      process.env.PI_FABRIC_AGENT_DIR = exportRoot;
      process.env.FAKE_PI_BEHAVIOR = "usage-flow";
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-e2e-"));
      roots.push(root);
      const config = {
        ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" as const,
        timeoutMs: 4_000,
        maxConcurrent: 1,
        sessionExport,
      };
      const manager = new AgentManager(process.cwd(), config, {
        workerPath,
        piBinary,
        runRoot: root,
      });
      managers.push(manager);
      return manager.run({ task: "sum things", transport: "process" }).then((result) => ({
        ...result,
        exportRoot,
      })) as Promise<AgentRunResult>;
    };

    it("writes a pi-format usage session with fabricagent attribution", async () => {
      const result = (await runExported(true)) as AgentRunResult & { exportRoot: string };
      expect(result.status).toBe("completed");
      expect(result.usage?.cost).toBeCloseTo(0.03);

      const sessionsRoot = path.join(result.exportRoot, "sessions", ".fabric");
      const files = fs
        .readdirSync(sessionsRoot)
        .flatMap((dir) =>
          fs
            .readdirSync(path.join(sessionsRoot, dir))
            .filter((file) => file.endsWith(".jsonl"))
            .map((file) => path.join(sessionsRoot, dir, file)),
        );
      expect(files).toHaveLength(1);

      const lines = fs
        .readFileSync(files[0]!, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(lines[0]).toMatchObject({
        type: "session",
        version: 3,
        cwd: process.cwd(),
      });
      expect(lines[1]).toMatchObject({ type: "session_info" });
      expect(String(lines[1]!.name)).toBe("fabricagent-sum things");

      const messages = lines.filter((line) => line.type === "message");
      expect(messages).toHaveLength(2);
      const tokenSums = messages.map(
        (entry) => (entry.message as { usage: Record<string, number> }).usage,
      );
      expect(tokenSums[0]).toMatchObject({
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
        totalTokens: 165,
        cost: { total: 0.01 },
      });
      expect(tokenSums[1]).toMatchObject({ input: 200, output: 100, cost: { total: 0.02 } });
      // No transcript content is exported — counters and attribution only.
      for (const entry of messages) {
        expect(entry.message).not.toHaveProperty("content");
      }
    }, 30_000);

    it("leaves no export file when the export is disabled", async () => {
      const result = (await runExported(false)) as AgentRunResult & { exportRoot: string };
      expect(result.status).toBe("completed");
      const sessionsRoot = path.join(result.exportRoot, "sessions");
      expect(fs.existsSync(sessionsRoot)).toBe(false);
    }, 30_000);
  });

  const runVeda = async (
    behavior: string,
    task = "do it",
    timeoutMs = 4_000,
  ): Promise<AgentRunResult> => {
    process.env.FAKE_VEDA_BEHAVIOR = behavior;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-e2e-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" as const, timeoutMs, maxConcurrent: 1 };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath,
      piBinary,
      vedaBinary: path.resolve("tests/fixtures/fake-veda.mjs"),
      runRoot: root,
    });
    managers.push(manager);
    return manager.run({ task, transport: "process", runner: "veda" });
  };

  it.each([
    {
      behavior: "success",
      check: (r: AgentRunResult) => {
        expect(r.status).toBe("completed");
        expect(r.runner).toBe("veda");
        expect(r.text).toContain("echo:");
        expect(r.usage).toMatchObject({ input: 10, output: 5, cacheRead: 2, cacheWrite: 0 });
        expect(r.runnerSessionId).toBe("conv-1");
        expect(r.turns).toBe(1);
      },
    },
    {
      behavior: "error",
      check: (r: AgentRunResult) => {
        expect(r.status).toBe("failed");
        expect(r.error ?? "").toMatch(/quota exceeded/);
      },
    },
    {
      behavior: "design-fail",
      check: (r: AgentRunResult) => {
        expect(r.status).toBe("failed");
        expect(r.error ?? "").toMatch(/design failed/);
        expect(r.error ?? "").toMatch(/missing.*program/);
      },
    },
    {
      behavior: "no-json",
      check: (r: AgentRunResult) => {
        expect(r.status).toBe("failed");
        expect(r.error ?? "").toMatch(/Veda agent reported an error before exiting/);
      },
    },
    {
      behavior: "hang",
      timeoutMs: 2_000,
      check: (r: AgentRunResult) => {
        expect(r.status).toBe("timed_out");
      },
    },
  ])("maps veda child behavior $behavior to the correct run outcome", async ({ behavior, timeoutMs, check }) => {
    const result = await runVeda(behavior, "do it", timeoutMs);
    try {
      check(result);
    } catch (error) {
      throw new Error(
        `${behavior}: ${(error as Error).message} (status=${result.status} error=${result.error ?? ""})`,
      );
    }
  }, 30_000);

  it("rejects recursive Fabric for the Veda runner", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-e2e-"));
    roots.push(root);
    const manager = new AgentManager(
      process.cwd(),
      { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" as const, timeoutMs: 2_000, maxConcurrent: 1 },
      { workerPath, piBinary, runRoot: root },
    );
    managers.push(manager);
    await expect(
      manager.run({ task: "do it", transport: "process", runner: "veda", recursive: true }),
    ).rejects.toThrow(/does not support recursive Fabric/);
  });

  it("rejects steering and follow-ups for Veda children at call time", async () => {
    process.env.FAKE_VEDA_BEHAVIOR = "hang";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-e2e-"));
    roots.push(root);
    const manager = new AgentManager(
      process.cwd(),
      { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" as const, timeoutMs: 10_000, maxConcurrent: 1 },
      { workerPath, piBinary, vedaBinary: path.resolve("tests/fixtures/fake-veda.mjs"), runRoot: root },
    );
    managers.push(manager);
    const handle = await manager.spawn({ task: "do it", transport: "process", runner: "veda" });
    expect(() => manager.steer(handle.id, "redirect")).toThrow(/does not support steering/);
    expect(() => manager.followUp(handle.id, "one more pass")).toThrow(/does not support steering/);
    await manager.stop(handle.id);
  });

  it("rejects persona for non-Veda runners", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-e2e-"));
    roots.push(root);
    const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" as const, timeoutMs: 2_000, maxConcurrent: 1 }, {
      workerPath,
      piBinary,
      runRoot: root,
    });
    managers.push(manager);
    await expect(
      manager.run({ task: "do it", transport: "process", runner: "pi", persona: "frontend" }),
    ).rejects.toThrow(/persona option is only supported by the Veda runner/);
  });

  it.each([
    { behavior: "compact-success", outcome: "completed", error: undefined },
    { behavior: "compact-failure", outcome: "failed", error: "child summary failed" },
  ])("queues mid-turn compaction and records $behavior after child settlement", async ({ behavior, outcome, error }) => {
    process.env.FAKE_PI_BEHAVIOR = behavior;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-e2e-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" as const, timeoutMs: 4_000, maxConcurrent: 1 };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath,
      piBinary,
      runRoot: root,
    });
    managers.push(manager);
    const handle = await manager.spawn({ task: "compact it", transport: "process" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    manager.compact(handle.id, "first instructions");
    manager.compact(handle.id, "latest instructions");
    const result = await manager.wait(handle.id);

    expect(result.status).toBe("completed");
    expect(result.compaction).toMatchObject({
      status: outcome,
      coalescedRequests: 1,
      attempts: 1,
      ...(error ? { error } : {}),
    });
    const events = fs
      .readFileSync(result.logFile!, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const settledIndex = events.findIndex((event) => event.type === "agent_settled");
    const compactIndex = events.findIndex((event) => event.type === "fake_compact_received");
    expect(settledIndex).toBeGreaterThanOrEqual(0);
    expect(compactIndex).toBeGreaterThan(settledIndex);
    expect(events[compactIndex]).toMatchObject({
      afterSettled: true,
      customInstructions: "latest instructions",
    });
    expect(events.some((event) => event.type === "abort")).toBe(false);
  });

  it("aborts a hanging run as stopped, not exited-without-a-result", async () => {
    process.env.FAKE_PI_BEHAVIOR = "hang";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-e2e-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" as const, timeoutMs: 30_000, maxConcurrent: 1 };
    const manager = new AgentManager(process.cwd(), config, {
      workerPath,
      piBinary,
      runRoot: root,
    });
    managers.push(manager);
    const ac = new AbortController();
    const handle = await manager.spawn({ task: "hang", transport: "process" }, ac.signal);
    await new Promise((resolve) => setTimeout(resolve, 200));
    ac.abort();
    const result = await manager.wait(handle.id);
    expect(result.status).toBe("stopped");
  });

  it("reports a terminal failure (not exited-without-a-result) when the worker crashes mid-stream", async () => {
    process.env.FAKE_PI_BEHAVIOR = "success";
    process.env.PI_FABRIC_INJECT_CRASH = "stream";
    try {
      const result = await run();
      expect(result.status).toBe("failed");
      expect(result.error ?? "").toMatch(/simulated stream crash/);
    } finally {
      delete process.env.PI_FABRIC_INJECT_CRASH;
    }
  });

  it("reports a terminal failure when the worker crashes while finalizing", async () => {
    process.env.FAKE_PI_BEHAVIOR = "success";
    process.env.PI_FABRIC_INJECT_CRASH = "close";
    try {
      const result = await run();
      expect(result.status).toBe("failed");
      expect(result.error ?? "").toMatch(/simulated close crash/);
    } finally {
      delete process.env.PI_FABRIC_INJECT_CRASH;
    }
  });

  it("keeps the declared fabric_exec display name as the run's milestone", async () => {
    process.env.FAKE_PI_BEHAVIOR = "milestone";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-e2e-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" as const, timeoutMs: 5_000, maxConcurrent: 1 };
    const manager = new AgentManager(process.cwd(), config, { workerPath, piBinary, runRoot: root });
    managers.push(manager);
    const result = await manager.run({ task: "declare a milestone", transport: "process" });
    expect(result.status).toBe("completed");
    // Whitespace collapses, and later calls without a declaration leave it in place.
    expect(result.milestone).toBe("Trace token refresh");
  });

  it("emits attributed tokens.usage events live and lands them in the budget ledger", async () => {
    process.env.FAKE_PI_BEHAVIOR = "usage-flow";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-e2e-"));
    roots.push(root);
    const config = { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi" as const, timeoutMs: 5_000, maxConcurrent: 1 };
    const ledger = initBudgetLedger(1);
    roots.push(path.dirname(ledger.file));
    const lifecycleEvents: Array<{ event: string; data?: unknown }> = [];
    const manager = new AgentManager(process.cwd(), config, {
      workerPath,
      piBinary,
      runRoot: root,
      onLifecycle: (event) => {
        lifecycleEvents.push({ event: event.event, data: event.data });
      },
    });
    managers.push(manager);
    const result = await manager.run({ task: "emit usage", transport: "process" });
    expect(result.status).toBe("completed");

    const usageEvents = lifecycleEvents.filter((entry) => entry.event === "tokens.usage");
    expect(usageEvents.length).toBeGreaterThanOrEqual(2);

    const first = usageEvents[0]!.data as {
      cumulativeTokens: number; runner: string; depth: number; input: number; output: number;
    };
    expect(first.cumulativeTokens).toBe(165);
    expect(first.runner).toBe("pi");
    expect(first.depth).toBe(1);
    expect(first.input).toBe(100);
    expect(first.output).toBe(50);

    const second = usageEvents[1]!.data as { cumulativeTokens: number; input: number };
    expect(second.cumulativeTokens).toBe(495);
    expect(second.input).toBe(200);

    const detail = readBudgetLedgerDetailed(ledger.file);
    expect(detail.byRunner.pi).toEqual({ cost: expect.closeTo(0.03), tokens: 495 });
    expect(detail.entries.length).toBeGreaterThanOrEqual(2);
    expect(detail.entries.reduce((sum, entry) => sum + entry.tokens, 0)).toBe(495);
  });
});
