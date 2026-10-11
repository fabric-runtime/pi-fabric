import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ActorManager } from "../src/actors/manager.js";
import type { GlobalActorRegistry } from "../src/actors/global-registry.js";
import type { LifecycleBroker } from "../src/lifecycle/broker.js";
import type { FabricMainAgentTarget } from "../src/main-agent.js";
import type { FabricParticipantSource } from "../src/topology/types.js";
import type { AgentRunRequest } from "../src/agents/types.js";
import { AgentsProvider } from "../src/providers/agents-provider.js";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { AgentManager } from "../src/agents/manager.js";
import { checkedSeed, completedBranchPrefix, snippetTask } from "../src/agents/fork-seed.js";
import { writeForkSession } from "../src/agents/handoff.js";
import fabricWriteGuard, { readWritePolicy, writePolicyDenial } from "../src/agents/write-guard.js";
import { readAgentLineage, resolveChildWritePolicy } from "../src/agents/child-env.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import { parseWorkerOptions } from "../src/worker/options.js";
import type { FabricInvocationContext } from "../src/protocol.js";

const roots: string[] = [];
const managers: AgentManager[] = [];
const savedPolicy = process.env.PI_FABRIC_WRITE_POLICY;
const savedLineage = process.env.PI_FABRIC_LINEAGE;

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (savedPolicy === undefined) delete process.env.PI_FABRIC_WRITE_POLICY;
  else process.env.PI_FABRIC_WRITE_POLICY = savedPolicy;
  if (savedLineage === undefined) delete process.env.PI_FABRIC_LINEAGE;
  else process.env.PI_FABRIC_LINEAGE = savedLineage;
  delete process.env.FAKE_PI_BEHAVIOR;
  vi.unstubAllEnvs();
});

const tempRoot = (prefix: string): string => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const initRepository = (): string => {
  const repository = tempRoot("pi-fabric-wp7-repo-");
  git(repository, "init", "-q");
  git(repository, "config", "user.email", "pi-fabric-tests@example.invalid");
  git(repository, "config", "user.name", "Pi Fabric tests");
  fs.writeFileSync(path.join(repository, "README.md"), "one\ntwo\n");
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "initial");
  return repository;
};

let entryClock = 0;
const message = (id: string, parentId: string | null, value: Record<string, unknown>): SessionEntry =>
  ({
    type: "message",
    id,
    parentId,
    timestamp: new Date(1_700_000_000_000 + entryClock++).toISOString(),
    message: { timestamp: 1, ...value },
  }) as unknown as SessionEntry;

// A caller branch whose leaf is the in-flight fabric_exec turn, plus an older
// resolved tool round trip that must survive the cut.
const callerBranch = (): SessionEntry[] => [
  message("u1", null, { role: "user", content: "first question" }),
  message("a1", "u1", {
    role: "assistant",
    content: [
      { type: "text", text: "reading" },
      { type: "toolCall", id: "old", name: "read", arguments: { path: "x" } },
    ],
  }),
  message("r1", "a1", {
    role: "toolResult", toolCallId: "old", toolName: "read",
    content: [{ type: "text", text: "secret file contents" }], isError: false,
  }),
  message("a2", "r1", { role: "assistant", content: [{ type: "text", text: "done reading" }] }),
  message("u2", "a2", { role: "user", content: "fork this work" }),
  message("a3", "u2", {
    role: "assistant",
    content: [
      { type: "text", text: "spawning a fork" },
      { type: "toolCall", id: "outer", name: "fabric_exec", arguments: { code: "await agents.spawn()" } },
    ],
  }),
];

describe("agent seeds", () => {
  it("ends a branch seed at the last completed turn, before the in-flight fabric_exec call", () => {
    const prefix = completedBranchPrefix(callerBranch());
    expect(prefix.map((entry) => entry.id)).toEqual(["u1", "a1", "r1", "a2", "u2"]);
    const serialized = JSON.stringify(prefix);
    expect(serialized).not.toContain("\"outer\"");
  });

  it("keeps older orphaned calls that precede the latest user message", () => {
    const branch = [
      message("u1", null, { role: "user", content: "start" }),
      message("a1", "u1", { role: "assistant", content: [{ type: "toolCall", id: "orphan", name: "bash", arguments: {} }] }),
      message("u2", "a1", { role: "user", content: "continue" }),
      message("a2", "u2", { role: "assistant", content: [{ type: "text", text: "complete" }] }),
    ];
    expect(completedBranchPrefix(branch).map((entry) => entry.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("builds a deterministic text-only snippet from the last messages", () => {
    const task = snippetTask(callerBranch(), 2, "Implement the fix");
    expect(task).toBe([
      '<inherited-conversation messages="2">',
      "[assistant]\ndone reading\n\n[user]\nfork this work",
      "</inherited-conversation>",
      "",
      "Task:",
      "Implement the fix",
    ].join("\n"));
    expect(task).not.toContain("secret file contents");
    expect(task).not.toContain("spawning a fork");
    expect(snippetTask([], 12, "alone")).toBe("alone");
    const long = snippetTask([message("u", null, { role: "user", content: "x".repeat(5_000) })], 1, "t");
    expect(long).toContain(`${"x".repeat(4_000)}…`);
  });

  it("validates seed arguments fail-closed", () => {
    expect(checkedSeed(undefined, undefined)).toEqual({ seed: "task", seedMessages: 12 });
    expect(checkedSeed("snippet", 3)).toEqual({ seed: "snippet", seedMessages: 3 });
    expect(() => checkedSeed("everything", undefined)).toThrow(/seed must be/);
    expect(() => checkedSeed("branch", 3)).toThrow(/only to seed: "snippet"/);
    expect(() => checkedSeed("snippet", 51)).toThrow(/1 to 50/);
    expect(() => checkedSeed("snippet", 1.5)).toThrow(/1 to 50/);
  });

  it("materializes a fork session without the dangling outer call", () => {
    const root = tempRoot("pi-fabric-fork-");
    const sessionFile = writeForkSession(
      { sourceSessionId: "caller", sourceBranch: completedBranchPrefix(callerBranch()) },
      root,
      path.join(root, "fork"),
    );
    const entries = fs.readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries[0]).toMatchObject({ type: "session", cwd: root });
    expect(entries.filter((entry) => entry.type === "message").map((entry) => entry.id))
      .toEqual(["u1", "a1", "r1", "a2", "u2"]);
    expect(entries.at(-1)).toMatchObject({
      type: "custom",
      customType: "pi-fabric-fork",
      data: { sourceSessionId: "caller", boundary: "last_completed_turn", entries: 5 },
    });
    expect(JSON.stringify(entries)).not.toContain("fabric_exec");
  });
});

describe("write guard", () => {
  const policy = (root: string) => ({ readOnly: false, writableRoots: [root], shell: "deny" as const });

  it("allows writes inside roots and refuses outside, missing paths, and shells", () => {
    const root = tempRoot("pi-fabric-guard-");
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    const allowed = policy(work);
    expect(writePolicyDenial(allowed, "write", { path: "new/dir/file.ts" }, work)).toBeUndefined();
    expect(writePolicyDenial(allowed, "edit", { path: `@${path.join(work, "a.ts")}` }, root)).toBeUndefined();
    expect(writePolicyDenial(allowed, "write", { path: "../outside.ts" }, work)).toMatch(/outside writable roots/);
    expect(writePolicyDenial(allowed, "write", { path: "@../outside.ts" }, work)).toMatch(/outside writable roots/);
    expect(writePolicyDenial(allowed, "write", {}, work)).toMatch(/no path argument/);
    expect(writePolicyDenial(allowed, "read", { path: "/etc/hosts" }, work)).toBeUndefined();
    expect(writePolicyDenial(allowed, "bash", { command: "true" }, work)).toMatch(/shell: "unconfined"/);
    expect(writePolicyDenial(allowed, "powershell", { command: "true" }, work)).toMatch(/shell/);
    expect(writePolicyDenial({ ...allowed, shell: "unconfined" }, "bash", { command: "true" }, work)).toBeUndefined();
    expect(writePolicyDenial({ readOnly: true, writableRoots: [], shell: "deny" }, "write", { path: "a" }, work))
      .toMatch(/read-only/);
  });

  it("refuses symlink escapes through the nearest existing ancestor", () => {
    const root = tempRoot("pi-fabric-guard-link-");
    const work = path.join(root, "work");
    const outside = path.join(root, "outside");
    fs.mkdirSync(work);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(work, "escape"), "dir");
    fs.writeFileSync(path.join(outside, "target.txt"), "x");
    fs.symlinkSync(path.join(outside, "target.txt"), path.join(work, "file-link"));
    fs.symlinkSync(path.join(root, "missing"), path.join(work, "dangling"));
    const allowed = policy(work);
    expect(writePolicyDenial(allowed, "write", { path: "escape/new/file.ts" }, work)).toMatch(/outside/);
    expect(writePolicyDenial(allowed, "edit", { path: "file-link" }, work)).toMatch(/outside/);
    expect(writePolicyDenial(allowed, "write", { path: "dangling" }, work)).toMatch(/outside/);
  });

  it("parses the env policy and fails closed on malformed values", () => {
    expect(readWritePolicy(undefined)).toBeUndefined();
    expect(readWritePolicy("")).toBeUndefined();
    expect(readWritePolicy("{not json")).toEqual({ readOnly: true, writableRoots: [], shell: "deny" });
    expect(readWritePolicy(JSON.stringify({ readOnly: false, writableRoots: ["relative"], shell: "deny" })))
      .toEqual({ readOnly: true, writableRoots: [], shell: "deny" });
    expect(readWritePolicy(JSON.stringify({ readOnly: false, writableRoots: ["/r"], shell: "unconfined" })))
      .toEqual({ readOnly: false, writableRoots: ["/r"], shell: "unconfined" });
  });

  it("registers a blocking tool_call hook only when the env policy is present", () => {
    const handlers: Array<(event: unknown, context: unknown) => unknown> = [];
    const pi = { on: (_event: string, handler: (event: unknown, context: unknown) => unknown) => handlers.push(handler) };
    delete process.env.PI_FABRIC_WRITE_POLICY;
    fabricWriteGuard(pi as unknown as ExtensionAPI);
    expect(handlers).toHaveLength(0);
    const root = tempRoot("pi-fabric-guard-hook-");
    process.env.PI_FABRIC_WRITE_POLICY = JSON.stringify(policy(root));
    fabricWriteGuard(pi as unknown as ExtensionAPI);
    expect(handlers).toHaveLength(1);
    expect(handlers[0]!({ toolName: "write", input: { path: "ok.txt" } }, { cwd: root })).toBeUndefined();
    expect(handlers[0]!({ toolName: "bash", input: { command: "rm -rf /" } }, { cwd: root }))
      .toMatchObject({ block: true, reason: expect.stringMatching(/bash/) });
  });

  it("refuses nested pi.write through the provider even without hook replay", async () => {
    const root = tempRoot("pi-fabric-guard-provider-");
    process.env.PI_FABRIC_WRITE_POLICY = JSON.stringify(policy(path.join(root, "inside")));
    fs.mkdirSync(path.join(root, "inside"));
    const provider = new PiToolsProvider(root);
    const context = {
      cwd: root, signal: undefined, parentToolCallId: "outer", nestedToolCallId: "nested",
      extensionContext: { cwd: root }, update() {},
    } as unknown as FabricInvocationContext;
    await expect(provider.invoke("write", { path: "escape.txt", content: "x" }, context))
      .rejects.toThrow(/outside writable roots/);
    await expect(provider.invoke("bash", { command: "echo hi" }, context)).rejects.toThrow(/shell/);
    expect(fs.existsSync(path.join(root, "escape.txt"))).toBe(false);
    await provider.close();
  });
});

describe("child write policy resolution", () => {
  it("defaults to the child cwd and creates missing roots only inside it", () => {
    const root = tempRoot("pi-fabric-policy-");
    expect(resolveChildWritePolicy({ shell: "deny" }, undefined, root))
      .toEqual({ readOnly: false, writableRoots: [root], shell: "deny" });
    const created = resolveChildWritePolicy({ writableRoots: ["out/gen"] }, undefined, root);
    expect(created?.writableRoots).toEqual([path.join(root, "out", "gen")]);
    expect(fs.statSync(path.join(root, "out", "gen")).isDirectory()).toBe(true);
    expect(() => resolveChildWritePolicy({ writableRoots: ["../never-created"] }, undefined, root))
      .toThrow(/creatable inside the agent cwd/);
    expect(fs.existsSync(path.join(path.dirname(root), "never-created"))).toBe(false);
    expect(resolveChildWritePolicy({}, undefined, root)).toBeUndefined();
  });

  it("enforces the subset rule against the caller policy", () => {
    const root = tempRoot("pi-fabric-policy-subset-");
    const allowed = path.join(root, "allowed");
    const other = path.join(root, "other");
    fs.mkdirSync(path.join(allowed, "sub"), { recursive: true });
    fs.mkdirSync(other);
    const parent = { readOnly: false, writableRoots: [allowed], shell: "deny" as const };
    expect(resolveChildWritePolicy({}, parent, root)).toBe(parent);
    expect(resolveChildWritePolicy({ writableRoots: ["allowed/sub"] }, parent, root)?.writableRoots)
      .toEqual([path.join(allowed, "sub")]);
    expect(() => resolveChildWritePolicy({ writableRoots: ["other"] }, parent, root)).toThrow(/caller's writable roots/);
    expect(() => resolveChildWritePolicy({ shell: "unconfined" }, parent, root)).toThrow(/shell-confined/);
    const readOnlyParent = { readOnly: true, writableRoots: [], shell: "deny" as const };
    expect(() => resolveChildWritePolicy({ readOnly: false }, readOnlyParent, root)).toThrow(/read-only/);
    expect(() => resolveChildWritePolicy({ writableRoots: ["allowed"] }, readOnlyParent, root)).toThrow(/read-only/);
  });
});

// Records its argv beside the status file and optionally edits its cwd.
const workerSource = `
import fs from "node:fs";
import path from "node:path";
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].slice(2), process.argv[index + 1]);
}
const statusFile = args.get("status-file");
const task = fs.readFileSync(args.get("task-file"), "utf8");
fs.mkdirSync(path.dirname(statusFile), { recursive: true });
fs.writeFileSync(path.join(path.dirname(statusFile), "argv.json"), JSON.stringify(Object.fromEntries(args)));
let text = "done";
if (task.includes("EDIT")) {
  fs.appendFileSync("README.md", "three\\n");
  fs.writeFileSync("new.txt", "alpha\\nbeta\\n");
}
if (task.includes("SETUPCHECK")) text = fs.existsSync("setup.txt") ? "setup present" : "setup missing";
const now = Date.now();
fs.writeFileSync(statusFile, JSON.stringify({
  id: args.get("id"), name: args.get("name"), task, status: "completed",
  runner: args.get("runner"), transport: args.get("transport"), cwd: process.cwd(),
  startedAt: now, updatedAt: now, finishedAt: now, turns: 1, toolCalls: 0, text, exitCode: 0,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
}));
fs.writeFileSync(args.get("log-file"), JSON.stringify({ type: "agent_start" }) + "\\n");
`;

const createManager = (
  cwd: string,
  options: ConstructorParameters<typeof AgentManager>[2] = {},
  config: Partial<typeof DEFAULT_FABRIC_CONFIG.agents> = {},
): { manager: AgentManager; runRoot: string } => {
  const root = tempRoot("pi-fabric-wp7-runs-");
  const workerPath = path.join(root, "worker.mjs");
  fs.writeFileSync(workerPath, workerSource);
  const manager = new AgentManager(cwd, { ...DEFAULT_FABRIC_CONFIG.agents, timeoutMs: 10_000, ...config }, {
    workerPath,
    runRoot: path.join(root, "runs"),
    fullCodeMode: false,
    ...options,
  });
  managers.push(manager);
  return { manager, runRoot: path.join(root, "runs") };
};

const launchArgs = (runRoot: string, id: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(runRoot, id, "argv.json"), "utf8"));

describe("agent manager spawning primitives", () => {
  it("passes write policy and lineage to Pi children with a per-parent child index", async () => {
    const cwd = tempRoot("pi-fabric-wp7-lineage-");
    const { manager, runRoot } = createManager(cwd, {
      fabricSessionId: "root-session",
      sessionId: () => "caller-session",
    });
    const first = await manager.run({ task: "one", transport: "process", readOnly: true });
    const second = await manager.run({ task: "two", transport: "process" });
    const firstArgs = launchArgs(runRoot, first.id);
    expect(JSON.parse(firstArgs["write-policy"]!)).toEqual({ readOnly: true, writableRoots: [], shell: "deny" });
    expect(readAgentLineage(firstArgs.lineage)).toEqual({
      version: 1, rootSessionId: "root-session", parentSessionId: "caller-session",
      runId: first.id, depth: 1, childIndex: 0, worker: true,
    });
    const secondArgs = launchArgs(runRoot, second.id);
    expect(secondArgs["write-policy"]).toBeUndefined();
    expect(readAgentLineage(secondArgs.lineage)).toMatchObject({ runId: second.id, childIndex: 1 });
  });

  it("inherits lineage roots and the caller policy in nested managers", async () => {
    const cwd = tempRoot("pi-fabric-wp7-nested-");
    fs.mkdirSync(path.join(cwd, "inside"));
    process.env.PI_FABRIC_LINEAGE = JSON.stringify({
      version: 1, rootSessionId: "root", runId: "parent-run", depth: 1, childIndex: 3, worker: true,
    });
    process.env.PI_FABRIC_WRITE_POLICY = JSON.stringify({
      readOnly: false, writableRoots: [path.join(cwd, "inside")], shell: "deny",
    });
    const { manager, runRoot } = createManager(cwd);
    const result = await manager.run({ task: "nested", transport: "process" });
    const args = launchArgs(runRoot, result.id);
    expect(readAgentLineage(args.lineage)).toMatchObject({ rootSessionId: "root", parentRunId: "parent-run", childIndex: 0 });
    expect(JSON.parse(args["write-policy"]!)).toEqual({
      readOnly: false, writableRoots: [path.join(cwd, "inside")], shell: "deny",
    });
    await expect(manager.spawn({ task: "escape", transport: "process", writableRoots: ["."] }))
      .rejects.toThrow(/caller's writable roots/);
    await expect(manager.spawn({ task: "claude", transport: "process", runner: "claude" }))
      .rejects.toThrow(/only by the Pi runner/);
  });

  it("refuses write policies for non-Pi runners and native executors before launch", async () => {
    const cwd = tempRoot("pi-fabric-wp7-refuse-");
    const { manager, runRoot } = createManager(cwd, { executorRuntime: () => "node-process" });
    await expect(manager.spawn({ task: "x", runner: "claude", readOnly: true })).rejects.toThrow(/only by the Pi runner/);
    await expect(manager.spawn({ task: "x", runner: "veda", writableRoots: ["."] })).rejects.toThrow(/only by the Pi runner/);
    await expect(manager.spawn({ task: "x", kernel: "typescript", readOnly: true })).rejects.toThrow(/native Fabric executor/);
    await expect(manager.spawn({ task: "x", kernel: "python", pythonRuntime: "cpython", readOnly: true }))
      .rejects.toThrow(/native Fabric executor/);
    await expect(manager.spawn({ task: "x", writableRoots: "." as unknown as string[] })).rejects.toThrow(/writableRoots/);
    expect(fs.existsSync(runRoot) ? fs.readdirSync(runRoot) : []).toEqual([]);
    const allowed = await manager.run({ task: "x", kernel: "typescript", readOnly: true, shell: "unconfined", transport: "process" });
    expect(allowed.status).toBe("completed");
  });

  it("launches a branch seed from a materialized fork session", async () => {
    const cwd = tempRoot("pi-fabric-wp7-fork-");
    const { manager, runRoot } = createManager(cwd);
    const result = await manager.run({
      task: "continue from the fork",
      transport: "process",
      forkSeed: { sourceSessionId: "caller", sourceBranch: completedBranchPrefix(callerBranch()) },
    });
    const sessionFile = launchArgs(runRoot, result.id)["session-file"]!;
    expect(sessionFile.startsWith(path.join(runRoot, result.id, "fork-session"))).toBe(true);
    const content = fs.readFileSync(sessionFile, "utf8");
    expect(content).toContain("fork this work");
    expect(content).not.toContain("fabric_exec");
    await expect(manager.spawn({
      task: "x", runner: "claude",
      forkSeed: { sourceSessionId: "caller", sourceBranch: [] },
    })).rejects.toThrow(/requires the Pi runner/);
  });

  it("reports worktree diffs, base ref, and kept state at settlement", async () => {
    const repository = initRepository();
    const base = git(repository, "rev-parse", "HEAD").trim();
    const { manager } = createManager(repository);
    const result = await manager.run({ task: "EDIT files", transport: "process", worktree: true });
    expect(result.worktreeResult).toEqual({
      path: result.worktree,
      branch: result.branch,
      baseRef: base,
      changedFiles: ["README.md", "new.txt"],
      diffstat: { files: 2, insertions: 3, deletions: 0 },
      kept: true,
    });
    expect(manager.status(result.id)).toMatchObject({ worktreeResult: { changedFiles: ["README.md", "new.txt"] } });
    await manager.cleanup(result.id, true);
  });

  it("runs the worktree setup hook and fails the run on a non-zero exit", async () => {
    const repository = initRepository();
    const { manager } = createManager(repository, {}, { worktree: { setup: "echo ready > setup.txt" } });
    const ok = await manager.run({ task: "SETUPCHECK", transport: "process", worktree: true });
    expect(ok.text).toBe("setup present");
    expect(ok.worktreeResult?.changedFiles).toEqual(["setup.txt"]);
    await manager.cleanup(ok.id, true);
    const before = git(repository, "worktree", "list", "--porcelain");
    await expect(manager.spawn({
      task: "never launched", transport: "process", worktree: true,
      // Setup runs through cmd.exe on Windows and /bin/sh elsewhere.
      worktreeSetup: process.platform === "win32"
        ? "echo installing & echo broken 1>&2 & exit 3"
        : "echo installing; echo broken >&2; exit 3",
    })).rejects.toThrow(/Worktree setup command exited with 3:\n[\s\S]*broken/);
    expect(git(repository, "worktree", "list", "--porcelain")).toBe(before);
  });

  it("parses the new worker arguments", () => {
    const options = parseWorkerOptions([
      "node", "worker.js", "--id", "w", "--name", "n", "--runner", "pi", "--task-file", "t",
      "--status-file", "s", "--lifecycle-file", "l", "--log-file", "g", "--cwd", "/",
      "--pi-binary", "pi", "--claude-binary", "c", "--veda-binary", "v", "--veda-backend", "b",
      "--veda-persona", "p", "--timeout-ms", "1", "--depth", "1", "--full-code-mode", "false",
      "--extensions", "false", "--tools", "[]", "--granted-risks", "[]", "--transport", "process",
      "--write-policy", "{\"readOnly\":true}", "--lineage", "{\"version\":1}",
    ]);
    expect(options).toMatchObject({ writePolicy: "{\"readOnly\":true}", lineage: "{\"version\":1}" });
  });
});

describe("worker child environment contract", () => {
  // The source worker always runs; the built worker when dist exists.
  const workers = [["src/worker.ts", "src/agents/write-guard.ts"], ["dist/worker.js", "dist/agents/write-guard.js"]]
    .filter(([worker]) => worker!.startsWith("src/") || fs.existsSync(path.resolve(worker!)));
  it.each(workers)("exports lineage and write policy and loads the write guard with --no-extensions (%s)", async (worker, guardPath) => {
    process.env.FAKE_PI_BEHAVIOR = "child-contract";
    // No model means no provider bridge, and an inherited bridge target is dropped.
    vi.stubEnv("PI_FABRIC_EXTENSION_MODEL", "stale/model");
    const root = tempRoot("pi-fabric-wp7-worker-");
    const manager = new AgentManager(root, { ...DEFAULT_FABRIC_CONFIG.agents, timeoutMs: 20_000 }, {
      workerPath: path.resolve(worker!),
      piBinary: path.resolve("tests/fixtures/fake-pi.mjs"),
      runRoot: path.join(root, "runs"),
      fullCodeMode: false,
      fabricSessionId: "root-session",
    });
    managers.push(manager);
    const result = await manager.run({ task: "report", runner: "pi", transport: "process", extensions: false, writableRoots: ["."] });
    expect(result.status).toBe("completed");
    const report = JSON.parse(result.text) as { lineage: string; writePolicy: string; extensionModel: string | null; args: string[] };
    expect(report.extensionModel).toBeNull();
    expect(report.args.some((arg) => arg.includes("provider-bridge"))).toBe(false);
    expect(readAgentLineage(report.lineage)).toMatchObject({ rootSessionId: "root-session", runId: result.id, depth: 1 });
    expect(JSON.parse(report.writePolicy)).toEqual({ readOnly: false, writableRoots: [root], shell: "deny" });
    expect(report.args).toContain("--no-extensions");
    const guard = report.args[report.args.indexOf("-e") + 1];
    expect(guard).toBe(path.resolve(guardPath!));
    expect(fs.existsSync(guard!)).toBe(true);
  }, 30_000);
});

describe("agents provider seeds and confinement", () => {
  const createProvider = () => {
    const requests: AgentRunRequest[] = [];
    const manager = {
      config: DEFAULT_FABRIC_CONFIG.agents,
      resolveKernel: () => undefined,
      resolvePythonRuntime: () => "monty",
      resolveCwd: (cwd: string) => cwd,
      childThinkingBounds: () => ({}),
      detachSignal() {},
      spawn: async (request: AgentRunRequest) => {
        requests.push(request);
        return { id: "child", name: "child", status: "running", runner: "pi", transport: "process", cwd: "/" };
      },
    } as unknown as AgentManager;
    const participants = {
      scheduleRefresh() {},
      self: () => ({ id: "self-participant" }),
    } as unknown as FabricParticipantSource;
    const provider = new AgentsProvider(
      manager,
      {} as ActorManager,
      {} as GlobalActorRegistry,
      {} as FabricMainAgentTarget,
      participants,
      undefined,
      {} as LifecycleBroker,
    );
    return { provider, requests };
  };
  const context = (branch: SessionEntry[] | undefined): FabricInvocationContext => ({
    cwd: "/", signal: undefined, parentToolCallId: "outer", nestedToolCallId: "nested",
    extensionContext: {
      model: { provider: "anthropic", id: "caller" },
      ...(branch
        ? {
            sessionManager: {
              getBranch: () => branch,
              getEntries: () => branch,
              getSessionId: () => "caller-session",
              getSessionFile: () => undefined,
            },
          }
        : {}),
    } as unknown as ExtensionContext,
    update() {},
  });

  it.each(["pi", "pi-durable"])("prefixes snippets and forks branches with %s without blocking the caller", async (runner) => {
    const { provider, requests } = createProvider();
    await provider.invoke("spawn", { task: "Do X", runner, seed: "snippet", seedMessages: 1 }, context(callerBranch()));
    expect(requests[0]!.task).toBe('<inherited-conversation messages="1">\n[user]\nfork this work\n</inherited-conversation>\n\nTask:\nDo X');
    expect(requests[0]!.forkSeed).toBeUndefined();
    const handle = await provider.invoke("spawn", { task: "Do Y", runner, seed: "branch" }, context(callerBranch()));
    expect(handle).toMatchObject({ id: "child" });
    expect(requests[1]!.task).toBe("Do Y");
    expect(requests[1]!.forkSeed).toMatchObject({ sourceSessionId: "caller-session" });
    expect(requests[1]!.forkSeed!.sourceBranch.map((entry) => entry.id)).toEqual(["u1", "a1", "r1", "a2", "u2"]);
  });

  it("refuses seeds without Pi, without a session, or with durable branch forks", async () => {
    const { provider, requests } = createProvider();
    await expect(provider.invoke("spawn", { task: "x", seed: "branch", runner: "claude" }, context(callerBranch())))
      .rejects.toThrow(/requires the Pi runner/);
    await expect(provider.invoke("run", { task: "x", seed: "snippet" }, context(undefined)))
      .rejects.toThrow(/requires a Pi session/);
    await expect(provider.invoke("spawn", { task: "x", seed: "branch", residency: "durable" }, context(callerBranch())))
      .rejects.toThrow(/unavailable for durable agents/);
    expect(requests).toEqual([]);
  });

  it("refuses durable spawns from a confined agent and reports lineage from agents.self", async () => {
    const { provider } = createProvider();
    process.env.PI_FABRIC_WRITE_POLICY = JSON.stringify({ readOnly: true, writableRoots: [], shell: "deny" });
    await expect(provider.invoke("spawn", { task: "x", residency: "durable" }, context(callerBranch())))
      .rejects.toThrow(/write-confined agent cannot start durable/);
    process.env.PI_FABRIC_LINEAGE = JSON.stringify({
      version: 1, rootSessionId: "root", runId: "run", depth: 2, childIndex: 1, worker: true,
    });
    expect(await provider.invoke("self", {}, context(undefined))).toEqual({
      id: "self-participant",
      lineage: { version: 1, rootSessionId: "root", runId: "run", depth: 2, childIndex: 1, worker: true },
    });
  });
});

describe("guest declarations", () => {
  it("types the spawning primitives for guest TypeScript", () => {
    const result = typeCheckFabricCode(
      [
        'const r = await agents.run({ task: "t", seed: "branch", readOnly: true, writableRoots: ["src"], shell: "deny", worktree: true, worktreeSetup: "true" });',
        'const s = await agents.run({ task: "t", seed: "snippet", seedMessages: 4 });',
        "const files: string[] = r.worktreeResult?.changedFiles ?? [];",
        "const self = await agents.self();",
        "return { files, inserted: r.worktreeResult?.diffstat.insertions, index: self.lineage?.childIndex, s: s.status };",
      ].join("\n"),
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });
});
