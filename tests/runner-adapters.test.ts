import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FABRIC_CONFIG, type FabricAgentConfig } from "../src/config.js";
import { AgentManager } from "../src/agents/manager.js";
import {
  getAgentRunner,
  listAgentRunners,
  registerAgentRunner,
  type FabricHostedLiveness,
  type FabricHostedReporter,
  type FabricHostedRunContext,
  type FabricHostedRunner,
  type FabricRunnerCapabilities,
  type FabricWorkerLaunchContext,
  type FabricWorkerRunner,
} from "../src/runners.js";
import type { AgentChildQuestionRequest, AgentRunRecord } from "../src/agents/types.js";
import { issueRootScope, normalizeScope } from "../src/scope.js";

const NONE: FabricRunnerCapabilities = {
  recursiveFabric: false,
  steer: false,
  followUp: false,
  persistentSessions: false,
  kernels: false,
  handoff: false,
  modelDiscovery: false,
  imageInput: false,
  compaction: false,
  questions: false,
  sleep: false,
  writePolicy: false,
};

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const tempRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-runners-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

const register = (adapter: FabricWorkerRunner | FabricHostedRunner): void => {
  cleanups.push(registerAgentRunner(adapter));
};

const managerFor = (
  runRoot: string,
  config: Partial<FabricAgentConfig> = {},
  options: ConstructorParameters<typeof AgentManager>[2] = {},
): AgentManager => {
  const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, ...config }, {
    runRoot,
    fullCodeMode: false,
    ...options,
  });
  cleanups.push(() => manager.close());
  return manager;
};

const readStatus = (manager: AgentManager, id: string): AgentRunRecord =>
  JSON.parse(fs.readFileSync(path.join(manager.runDirectory(id)!, "status.json"), "utf8")) as AgentRunRecord;

const waitFor = async (check: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

interface FakeHosted {
  adapter: FabricHostedRunner;
  calls: string[];
  reporter(): FabricHostedReporter;
  liveness: { value: FabricHostedLiveness };
  /** Per-job liveness overrides keyed by run id. */
  jobs: Map<string, FabricHostedLiveness>;
  statusAtStart?: AgentRunRecord;
  contexts: FabricHostedRunContext[];
}

const fakeHosted = (
  id: string,
  options: {
    capabilities?: Partial<FabricRunnerCapabilities>;
    onStart?: (reporter: FabricHostedReporter, context: FabricHostedRunContext) => void | Promise<void>;
    onAttach?: (reporter: FabricHostedReporter, job: string) => void | Promise<void>;
    stopConfirmed?: boolean;
  } = {},
): FakeHosted => {
  let current: FabricHostedReporter | undefined;
  const fake: FakeHosted = {
    calls: [],
    contexts: [],
    liveness: { value: "running" },
    jobs: new Map(),
    reporter: () => current!,
    adapter: {
      kind: "hosted",
      id,
      label: `Daemon ${id}`,
      capabilities: { ...NONE, ...options.capabilities },
      prepare: (context) => {
        fake.calls.push("prepare");
        return { daemon: "local", job: context.idempotencyKey };
      },
      start: async (locator, context, reporter) => {
        fake.calls.push(`start:${JSON.stringify(locator)}`);
        fake.contexts.push(context);
        fake.statusAtStart = JSON.parse(
          fs.readFileSync(path.join(context.runDirectory, "status.json"), "utf8"),
        ) as AgentRunRecord;
        current = reporter;
        await options.onStart?.(reporter, context);
      },
      attach: async (locator, _context, reporter) => {
        fake.calls.push(`attach:${JSON.stringify(locator)}`);
        current = reporter;
        await options.onAttach?.(reporter, (locator as { job: string }).job);
      },
      liveness: (locator) => fake.jobs.get((locator as { job: string }).job) ?? fake.liveness.value,
      stop: (_locator, reason) => {
        fake.calls.push(`stop:${reason}`);
        return { confirmed: options.stopConfirmed ?? true };
      },
      steer: (_locator, message) => {
        fake.calls.push(`steer:${message}`);
      },
      sleep: () => {
        fake.calls.push("sleep");
      },
      wake: () => {
        fake.calls.push("wake");
      },
    },
  };
  return fake;
};

describe("runner registration", () => {
  it("lists built-ins with the uniform capability table", () => {
    expect(listAgentRunners().map((runner) => runner.id)).toEqual(expect.arrayContaining(["pi", "claude", "veda"]));
    expect(getAgentRunner("pi")?.capabilities.writePolicy).toBe(true);
    expect(getAgentRunner("claude")?.capabilities.recursiveFabric).toBe(false);
    expect(getAgentRunner("veda")?.capabilities.steer).toBe(false);
  });

  it("validates adapters fail closed", () => {
    const worker = {
      kind: "worker" as const,
      id: "acme",
      label: "Acme",
      capabilities: NONE,
      launch: () => ({ workerPath: "/bin/true", workerArguments: [] }),
    };
    expect(() => registerAgentRunner({ ...worker, id: "Bad Id" })).toThrow(/Invalid Fabric runner id/);
    expect(() => registerAgentRunner({ ...worker, id: "pi" })).toThrow(/Cannot replace built-in/);
    expect(() => registerAgentRunner({ ...worker, capabilities: { ...NONE, questions: undefined } as never }))
      .toThrow(/boolean capabilities: questions/);
    expect(() => registerAgentRunner({ ...worker, launch: undefined } as never)).toThrow(/launch\(\)/);
    expect(() => registerAgentRunner({ ...worker, capabilities: { ...NONE, steer: true }, kind: "hosted" } as never))
      .toThrow(/prepare\(\)/);
    expect(() => registerAgentRunner({ ...worker, residentModule: "relative/module.js" }))
      .toThrow(/residentModule/);
    const hosted = fakeHosted("daemon").adapter;
    expect(() => registerAgentRunner({ ...hosted, stop: undefined } as never)).toThrow(/stop\(\)/);
    expect(() => registerAgentRunner({ ...hosted, capabilities: { ...NONE, compaction: true } }))
      .toThrow(/cannot declare compaction/);
    expect(() => registerAgentRunner({ ...hosted, capabilities: { ...NONE, steer: true }, steer: undefined } as never))
      .toThrow(/steer\(\)/);
    const unregister = registerAgentRunner(worker);
    expect(() => registerAgentRunner(worker)).toThrow(/already registered/);
    expect(getAgentRunner("acme")?.label).toBe("Acme");
    unregister();
    expect(getAgentRunner("acme")).toBeUndefined();
  });
});

describe("custom worker runners", () => {
  it("launches through the process transport with the file protocol", async () => {
    const root = tempRoot();
    const launches: FabricWorkerLaunchContext[] = [];
    register({
      kind: "worker",
      id: "acme",
      label: "Acme",
      capabilities: NONE,
      defaultModel: () => "acme-large",
      launch: (context) => {
        launches.push(context);
        const contextFile = path.join(context.runDirectory, "acme-context.json");
        fs.writeFileSync(contextFile, JSON.stringify(context));
        return {
          workerPath: path.resolve("tests/fixtures/fake-runner-worker.mjs"),
          workerArguments: [contextFile],
        };
      },
    });
    const manager = managerFor(root);
    const result = await manager.run({ task: "Write docs", runner: "acme", transport: "process" });
    expect(result).toMatchObject({ status: "completed", runner: "acme", text: "acme finished: Write docs", model: "acme-large" });
    expect(result.usage.output).toBe(5);
    const [context] = launches;
    expect(context?.files.steerFile).toMatch(/steer\.jsonl$/);
    expect(context?.fabricWorker.workerArguments).toContain("--runner");
    expect(context?.writePolicy).toBeUndefined();
    expect(fs.readFileSync(path.join(manager.runDirectory(result.id)!, "events.jsonl"), "utf8")).toContain("acme says hi");
  });

  it("refuses requests needing undeclared capabilities before launch", async () => {
    const root = tempRoot();
    const launch = vi.fn(() => ({ workerPath: "/bin/true", workerArguments: [] }));
    register({ kind: "worker", id: "acme", label: "Acme", capabilities: NONE, launch });
    const manager = managerFor(root);
    await expect(manager.spawn({ task: "x", runner: "acme", recursive: true })).rejects.toThrow(/recursiveFabric/);
    await expect(manager.spawn({ task: "x", runner: "acme", readOnly: true })).rejects.toThrow(/Write confinement/);
    await expect(manager.spawn({ task: "x", runner: "acme", kernel: "python" })).rejects.toThrow(/kernels capability/);
    await expect(manager.spawn({
      task: "x",
      runner: "acme",
      images: [{ type: "image", data: "AA==", mimeType: "image/png" }],
    })).rejects.toThrow(/imageInput/);
    await expect(manager.spawn({ task: "x", runner: "unknown" })).rejects.toThrow(/Unsupported Fabric agent runner/);
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("hosted runners", () => {
  it("persists the locator before start, routes questions, and finishes", async () => {
    const root = tempRoot();
    const fake = fakeHosted("daemon", {
      capabilities: { questions: true, steer: true },
      onStart: (reporter) => {
        void (async () => {
          reporter.progress({ turns: 1, currentTool: "plan" });
          reporter.usage({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.5 });
          reporter.transcript({ type: "message_end", message: { role: "assistant", content: "thinking" } });
          const answer = await reporter.question({ method: "select", title: "Ship?", options: ["yes", "no"] });
          reporter.usage({ input: 150, output: 30, cacheRead: 0, cacheWrite: 0, cost: 0.75 });
          reporter.finish({ status: "completed", output: `answer=${"value" in answer ? answer.value : "none"}`, structured: { ok: true } });
        })();
      },
    });
    register(fake.adapter);
    const questions: AgentChildQuestionRequest[] = [];
    const manager = managerFor(root, { childQuestions: "route" }, {
      onChildQuestion: async (request) => {
        questions.push(request);
        return { value: "yes" };
      },
    });
    const result = await manager.run({ task: "Daemon task", runner: "daemon" });
    expect(fake.calls[0]).toBe("prepare");
    expect(fake.calls[1]).toMatch(/^start:/);
    // A1: the locator was durable before the adapter was asked to submit.
    expect(fake.statusAtStart?.hosted?.locator).toEqual({ daemon: "local", job: result.id });
    expect(fake.contexts[0]?.idempotencyKey).toBe(result.id);
    expect(result).toMatchObject({
      status: "completed",
      runner: "daemon",
      transport: "hosted",
      text: "answer=yes",
      value: { ok: true },
      turns: 1,
    });
    expect(result.usage).toMatchObject({ input: 150, output: 30, cost: 0.75 });
    expect(questions[0]?.question).toMatchObject({ method: "select", title: "Ship?", options: ["yes", "no"] });
    expect(fs.readFileSync(path.join(manager.runDirectory(result.id)!, "events.jsonl"), "utf8")).toContain("thinking");
  });

  describe("structured output against the run's schema", () => {
    const schema = {
      type: "object",
      properties: { item: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } },
      required: ["item"],
    };
    const finishing = (id: string, structured: unknown, output = "") => {
      const fake = fakeHosted(id, {
        onStart: (reporter) => reporter.finish({ status: "completed", output, structured }),
      });
      register(fake.adapter);
      return fake;
    };

    it("completes a valid structured value unchanged", async () => {
      finishing("valid-shape", { item: { n: 7 } }, "done");
      const manager = managerFor(tempRoot());
      const result = await manager.run({ task: "Valid", runner: "valid-shape", schema });
      expect(result).toMatchObject({ status: "completed", text: "done", value: { item: { n: 7 } } });
      expect(result.error).toBeUndefined();
      expect(readStatus(manager, result.id)).toMatchObject({ status: "completed", value: { item: { n: 7 } } });
    });

    it("fails a nested schema violation with the structured-output error", async () => {
      finishing("nested-violation", { item: { n: "not a number" } }, "done");
      const manager = managerFor(tempRoot());
      const result = await manager.run({ task: "Invalid", runner: "nested-violation", schema });
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/^Structured agent output was invalid: .*number.* \(output: done\)$/);
      expect(readStatus(manager, result.id)).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/^Structured agent output was invalid: /),
      });
    });

    it("leaves a run without a schema unchanged", async () => {
      finishing("no-schema", { item: { n: "not a number" } }, "plain prose, not JSON");
      const manager = managerFor(tempRoot());
      const result = await manager.run({ task: "Free", runner: "no-schema" });
      expect(result).toMatchObject({
        status: "completed",
        text: "plain prose, not JSON",
        value: { item: { n: "not a number" } },
      });
      expect(result.error).toBeUndefined();
    });

    it("names the size limit when an oversized value was truncated", async () => {
      // Valid for the schema, but its JSON is just over 1 MiB (1,048,576 bytes).
      finishing("oversized", { item: { n: 1 }, pad: "x".repeat(1024 * 1024) }, "done");
      const manager = managerFor(tempRoot());
      const result = await manager.run({ task: "Big", runner: "oversized", schema });
      expect(result.status).toBe("failed");
      expect(result.error).toBe(
        "Structured agent output was invalid: structured value was truncated at the 1048576-byte limit",
      );
      expect(result.value).toEqual({ fabricTruncated: true });
    });

    it("parses text-only output as the value when it is valid JSON for the schema", async () => {
      finishing("text-json", undefined, '{"item":{"n":3}}');
      const manager = managerFor(tempRoot());
      const result = await manager.run({ task: "Text", runner: "text-json", schema });
      expect(result).toMatchObject({ status: "completed", value: { item: { n: 3 } } });
      expect(result.error).toBeUndefined();
    });

    it("fails text-only prose when the run has a schema", async () => {
      finishing("text-prose", undefined, "the answer is three");
      const manager = managerFor(tempRoot());
      const result = await manager.run({ task: "Prose", runner: "text-prose", schema });
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/^Structured agent output was invalid: .* \(output: the answer is three\)$/);
    });

    it("bounds a value parsed from oversized text output", async () => {
      // Valid JSON for the schema, but just over 1 MiB (1,048,576 bytes).
      finishing("text-oversized", undefined, JSON.stringify({ item: { n: 1 }, pad: "x".repeat(1024 * 1024) }));
      const manager = managerFor(tempRoot());
      const result = await manager.run({ task: "Big text", runner: "text-oversized", schema });
      expect(result.status).toBe("failed");
      expect(result.error).toBe(
        "Structured agent output was invalid: value parsed from the output was truncated at the 1048576-byte limit",
      );
      expect(result.value).toEqual({ fabricTruncated: true });
      expect(readStatus(manager, result.id)).toMatchObject({ status: "failed", value: { fabricTruncated: true } });
    });

    it("keeps an explicit null structured value instead of parsing the text", async () => {
      finishing("null-structured", null, '{"item":{"n":3}}');
      const manager = managerFor(tempRoot());
      const result = await manager.run({
        task: "Null", runner: "null-structured", schema: { anyOf: [{ type: "null" }, schema] },
      });
      expect(result.status).toBe("completed");
      expect(result.value).toBeNull();
    });

    it.each(["failed", "stopped"] as const)("does not validate a %s report", async (status) => {
      const id = `reported-${status}`;
      register(fakeHosted(id, {
        onStart: (reporter) => reporter.finish({ status, output: "halted", structured: { item: { n: "bad" } } }),
      }).adapter);
      const manager = managerFor(tempRoot());
      const result = await manager.run({ task: "Halt", runner: id, schema });
      expect(result).toMatchObject({ status, error: "halted", value: { item: { n: "bad" } } });
    });
  });

  it("hands hosted runners the narrowed host scope", async () => {
    const scopeHolder = globalThis as unknown as Record<symbol, unknown>;
    const holderKey = Symbol.for("pi-fabric:scope:v1");
    cleanups.push(() => {
      delete scopeHolder[holderKey];
    });
    const parent = issueRootScope({
      principal: { id: "svc" },
      grants: [{ resource: "fs:/repo/**", actions: ["read", "write"] }],
    });
    const root = tempRoot();
    const fake = fakeHosted("scoped", {
      onStart: (reporter) => reporter.finish({ status: "completed", output: "ok" }),
    });
    register(fake.adapter);
    const manager = managerFor(root);
    await manager.run({
      task: "Scoped",
      runner: "scoped",
      scope: { grants: [{ resource: "fs:/repo/docs/**", actions: ["read"] }] },
    });
    expect(fake.contexts[0]?.scope).toMatchObject({
      principal: { id: "svc", issuer: "host" },
      grants: [{ resource: "fs:/repo/docs/**", actions: ["read"] }],
      parentDigest: parent.digest,
    });
  });

  it("delivers steer through the adapter and refuses undeclared controls", async () => {
    const root = tempRoot();
    const fake = fakeHosted("daemon", { capabilities: { steer: true } });
    register(fake.adapter);
    const manager = managerFor(root);
    const handle = await manager.spawn({ task: "Long task", runner: "daemon" });
    manager.steer(handle.id, "focus on tests");
    await waitFor(() => fake.calls.includes("steer:focus on tests"));
    expect(fs.existsSync(path.join(manager.runDirectory(handle.id)!, "steer.jsonl"))).toBe(false);
    expect(() => manager.followUp(handle.id, "later")).toThrow(/does not support follow-ups/);
    expect(() => manager.compact(handle.id)).toThrow(/compaction capability/);
    await expect(manager.sleep(handle.id)).rejects.toThrow(/does not support sleep/);
    await expect(fake.reporter().question({ method: "confirm", title: "Proceed?" }))
      .rejects.toThrow(/questions capability/);
    await expect(manager.spawn({ task: "q", runner: "daemon", readOnly: true })).rejects.toThrow(/Write confinement/);
    const stopped = await manager.stop(handle.id);
    expect(stopped).toMatchObject({ status: "stopped" });
    expect(stopped.outcome).toBeUndefined();
    expect(fake.calls).toContain("stop:requested");
  });

  it("stops session hosted runs with reason shutdown when the session closes", async () => {
    const root = tempRoot();
    const fake = fakeHosted("daemon");
    register(fake.adapter);
    const manager = managerFor(root);
    const handle = await manager.spawn({ task: "Session bound", runner: "daemon" });
    await manager.close();
    expect(fake.calls).toContain("stop:shutdown");
    expect(fs.existsSync(path.join(root, handle.id))).toBe(false);
  });

  it("marks an unconfirmed stop indeterminate", async () => {
    const root = tempRoot();
    const fake = fakeHosted("daemon", { stopConfirmed: false });
    register(fake.adapter);
    const manager = managerFor(root);
    const handle = await manager.spawn({ task: "Long task", runner: "daemon" });
    const stopped = await manager.stop(handle.id);
    expect(stopped).toMatchObject({ status: "stopped", outcome: "indeterminate" });
    expect(stopped.error).toMatch(/did not confirm the stop/);
  });

  it("keeps a sleeping run running with a sleeping detail", async () => {
    const root = tempRoot();
    const fake = fakeHosted("daemon", { capabilities: { sleep: true } });
    register(fake.adapter);
    const manager = managerFor(root);
    const handle = await manager.spawn({ task: "Nap", runner: "daemon" });
    await manager.sleep(handle.id);
    fake.liveness.value = "sleeping";
    await waitFor(() => readStatus(manager, handle.id).sleeping === true);
    // Several liveness polls past the dead-transport grace: still running.
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    expect(manager.status(handle.id).status).toBe("running");
    await manager.wake(handle.id);
    fake.liveness.value = "running";
    fake.reporter().finish({ status: "completed", output: "rested" });
    const result = await manager.wait(handle.id);
    expect(result).toMatchObject({ status: "completed", text: "rested" });
    expect(result.sleeping).toBeUndefined();
    expect(fake.calls).toEqual(expect.arrayContaining(["sleep", "wake"]));
  });

  it("settles an unknown run indeterminate and never re-starts it", async () => {
    const root = tempRoot();
    const fake = fakeHosted("daemon");
    register(fake.adapter);
    const manager = managerFor(root);
    const handle = await manager.spawn({ task: "Flaky", runner: "daemon" });
    fake.liveness.value = "unknown";
    const result = await manager.wait(handle.id);
    expect(result).toMatchObject({ status: "failed", outcome: "indeterminate" });
    expect(fake.calls.filter((call) => call.startsWith("start:"))).toHaveLength(1);
  });

  it("re-attaches a durable run after a restart, and settles interrupted ones indeterminate", async () => {
    const root = tempRoot();
    const fake = fakeHosted("daemon", {
      onAttach: (reporter, job) => {
        if (!fake.jobs.has(job)) reporter.finish({ status: "completed", output: "finished while away" });
      },
    });
    register(fake.adapter);
    const first = managerFor(root);
    const kept = await first.spawn({ task: "Survive restart", runner: "daemon", residency: "durable" });
    const lost = await first.spawn({ task: "Lost on restart", runner: "daemon", residency: "durable" });
    await first.close();
    // A durable hosted run is detached, not stopped, and its files survive.
    expect(fake.calls.some((call) => call.startsWith("stop:"))).toBe(false);
    expect(fs.existsSync(path.join(root, kept.id, "hosted.json"))).toBe(true);

    // The lost run's daemon forgot it: attach finds it interrupted.
    fake.jobs.set(lost.id, "interrupted");
    const second = managerFor(root);
    const recovered = await second.recoverHostedRuns();
    expect(new Set(recovered)).toEqual(new Set([kept.id, lost.id]));
    expect(await second.wait(kept.id)).toMatchObject({ status: "completed", text: "finished while away" });
    expect(await second.wait(lost.id)).toMatchObject({ status: "failed", outcome: "indeterminate" });
    expect(fake.calls.filter((call) => call.startsWith("start:"))).toHaveLength(2);
  });

  it("re-attaches a durable run with its forwarded scope and refuses a damaged one", async () => {
    const root = tempRoot();
    const attached: FabricHostedRunContext[] = [];
    const fake = fakeHosted("daemon");
    fake.adapter.attach = async (_locator, context, reporter) => {
      attached.push(context);
      reporter.finish({ status: "completed", output: "back" });
    };
    register(fake.adapter);
    const scope = normalizeScope({ principal: { id: "svc" }, grants: [{ resource: "fs:/repo/**", actions: ["read"] }] });
    const first = managerFor(root);
    const kept = await first.spawn({ task: "Keep", runner: "daemon", residency: "durable", inheritedScope: scope });
    const damaged = await first.spawn({ task: "Damage", runner: "daemon", residency: "durable", inheritedScope: scope });
    expect(fake.contexts.map((context) => context.scope?.digest)).toEqual([scope.digest, scope.digest]);
    await first.close();
    const stateFile = path.join(root, damaged.id, "hosted.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { context: { scope: { grants: unknown[] } } };
    state.context.scope.grants = [{ resource: "fs:*", actions: ["write"] }];
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const second = managerFor(root);
    expect(await second.recoverHostedRuns()).toEqual([kept.id]);
    expect(attached[0]?.scope).toEqual(scope);
    const record = JSON.parse(fs.readFileSync(path.join(root, damaged.id, "status.json"), "utf8")) as AgentRunRecord;
    expect(record).toMatchObject({ status: "failed", outcome: "indeterminate" });
    expect(record.error).toMatch(/scope is invalid/);
  });

  it("settles a run whose runner is not registered after restart as indeterminate", async () => {
    const root = tempRoot();
    const fake = fakeHosted("ghost");
    const unregister = registerAgentRunner(fake.adapter);
    const first = managerFor(root);
    const handle = await first.spawn({ task: "Orphan", runner: "ghost", residency: "durable" });
    await first.close();
    unregister();
    const second = managerFor(root);
    expect(await second.recoverHostedRuns()).toEqual([]);
    const record = JSON.parse(fs.readFileSync(path.join(root, handle.id, "status.json"), "utf8")) as AgentRunRecord;
    expect(record).toMatchObject({ status: "failed", outcome: "indeterminate" });
  });
});
