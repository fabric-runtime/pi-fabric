import fs from "node:fs";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it } from "vitest";

type Context = Record<string, unknown>;
type AsyncCallable = (...values: unknown[]) => Promise<unknown>;
type AsyncFunctionConstructor = new (...args: string[]) => AsyncCallable;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as AsyncFunctionConstructor;

function extractMarkdownProgram(markdown: string, file: string): string {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const match = normalized.match(/```ts\n([\s\S]*?)\n```/);
  if (!match) throw new Error(`No TypeScript program in ${file}`);
  return match[1]!;
}

function markdownProgram(file: string): string {
  return extractMarkdownProgram(fs.readFileSync(file, "utf8"), file);
}

async function runProgram(file: string, context: Context): Promise<Record<string, unknown>> {
  const javascript = transpileModule(markdownProgram(file), {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None },
  }).outputText;
  const keys = Object.keys(context);
  const fn = new AsyncFunction(...keys, javascript);
  return await fn(...keys.map((key) => context[key])) as Record<string, unknown>;
}

function runSkill(name: string, context: Context): Promise<Record<string, unknown>> {
  return runProgram(`skillsets/typescript/${name}/SKILL.md`, context);
}

const workflow = {
  configure: async () => undefined,
  event: async () => undefined,
};
const phase = async () => undefined;
const parallel = async (thunks: Array<() => Promise<unknown>>) => Promise.all(
  thunks.map((thunk) => thunk()),
);

describe("expensive skill program behavior", () => {
  it("extracts TypeScript programs from CRLF Markdown", () => {
    expect(extractMarkdownProgram("before\r\n```ts\r\nreturn 42;\r\n```\r\n", "fixture.md"))
      .toBe("return 42;");
  });

  it("keeps successful council roles without returning raw reports after synthesis", async () => {
    const calls: string[] = [];
    const result = await runSkill("fabric-council", {
      π: { task: "decide", roles: JSON.stringify(["correctness", "security", "operations"]) },
      workflow,
      phase,
      parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        calls.push(options.label);
        if (options.label === "security") throw new Error("provider unavailable");
        if (options.label === "council synthesis") return "bounded decision";
        return `${options.label} report`;
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      coverage: { requested: 3, completed: 2 },
      result: "bounded decision",
    });
    expect(result).not.toHaveProperty("fallback");
    expect(result.failures).toEqual([
      { role: "security", status: "failed", error: "provider unavailable" },
    ]);
    expect(calls).toHaveLength(4);
  });

  it("returns compact council reports only when synthesis fails", async () => {
    const result = await runSkill("fabric-council", {
      π: { task: "decide", roles: JSON.stringify(["a", "b", "c"]) },
      workflow,
      phase,
      parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        if (options.label === "council synthesis") throw new Error("judge failed");
        return `${options.label} report`;
      },
    });

    expect(result).toMatchObject({ status: "partial", result: null, synthesisError: "judge failed" });
    expect(result.fallback).toEqual([
      { role: "a", status: "completed", report: "a report" },
      { role: "b", status: "completed", report: "b report" },
      { role: "c", status: "completed", report: "c report" },
    ]);
  });

  it("parks council reports create-only and moves to the next key on collision", async () => {
    const puts: Array<{ key: string; ifVersion?: number }> = [];
    const result = await runSkill("fabric-council", {
      π: { task: "decide", roles: JSON.stringify(["a", "b", "c"]) },
      workflow,
      phase,
      parallel,
      agent: async (_prompt: string, options: { label: string }) =>
        options.label === "council synthesis" ? "decision" : `${options.label} report`,
      mesh: {
        put: async (args: { key: string; ifVersion?: number }) => {
          puts.push({ key: args.key, ...(args.ifVersion === undefined ? {} : { ifVersion: args.ifVersion }) });
          if (puts.length === 1) {
            throw new Error(`Mesh compare-and-swap failed for ${args.key}: expected version 0, found 498938`);
          }
          return { key: args.key, version: 2 };
        },
      },
    });
    expect(puts).toHaveLength(2);
    expect(puts.every((put) => put.ifVersion === 0)).toBe(true);
    expect(puts[1]!.key).toMatch(/-2\/reports$/);
    expect(result.reports).toBe(puts[1]!.key);
    expect(result.status).toBe("success");
  });

  it("surfaces a real mesh failure without retry spin and still synthesizes", async () => {
    const puts: unknown[] = [];
    const result = await runSkill("fabric-council", {
      π: { task: "decide", roles: JSON.stringify(["a", "b", "c"]) },
      workflow,
      phase,
      parallel,
      agent: async (_prompt: string, options: { label: string }) =>
        options.label === "council synthesis" ? "decision" : `${options.label} report`,
      mesh: {
        put: async () => {
          puts.push(null);
          throw new Error("mesh unavailable");
        },
      },
    });
    expect(puts).toHaveLength(1);
    expect(result.reports).toEqual({ error: "mesh unavailable" });
    expect(result.status).toBe("success");
  });

  it("keeps RLM coverage compact and uses recursion only for oversized partitions", async () => {
    const recursive: string[] = [];
    const result = await runSkill("fabric-rlm", {
      π: { task: "map repository" },
      workflow,
      phase,
      parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        if (options.label === "scope") {
          return {
            partitions: [
              { label: "small", paths: ["a.ts"], recursive: false },
              { label: "broken", paths: ["b.ts"], recursive: false },
              { label: "large", paths: ["packages/large"], recursive: true },
            ],
          };
        }
        if (options.label === "analyze broken") throw new Error("leaf failed");
        if (options.label === "combine") return "compact map";
        return "small finding";
      },
      rlm: {
        query: async ({ name }: { name: string }) => {
          recursive.push(name);
          return { status: "completed", text: "large finding", usage: { input: 50, output: 10 } };
        },
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      coverage: { requested: 3, completed: 2 },
      result: "compact map",
    });
    expect(result).not.toHaveProperty("fallback");
    expect(JSON.stringify(result)).not.toContain("usage");
    expect(recursive).toEqual(["recurse large"]);
  });

  it("preserves compact RLM findings when combination fails", async () => {
    const result = await runSkill("fabric-rlm", {
      π: { task: "map repository" },
      workflow,
      phase,
      parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        if (options.label === "scope") {
          return { partitions: [
            { label: "a", paths: ["a.ts"], recursive: false },
            { label: "b", paths: ["b.ts"], recursive: false },
          ] };
        }
        if (options.label === "combine") throw new Error("combine failed");
        return `${options.label} finding`;
      },
      rlm: { query: async () => { throw new Error("unexpected recursion"); } },
    });

    expect(result).toMatchObject({ status: "partial", result: null, synthesisError: "combine failed" });
    expect(result.fallback).toEqual([
      { partition: "a", status: "completed", finding: "analyze a finding" },
      { partition: "b", status: "completed", finding: "analyze b finding" },
    ]);
  });

  it("judges available Fusion responses without returning them twice", async () => {
    const result = await runSkill("fabric-fusion", {
      π: {
        task: "compare",
        panel: JSON.stringify([{ model: "one" }, { model: "two" }, { model: "three" }]),
        judge: "",
        tools: "",
        thinking: "",
      },
      workflow,
      phase,
      parallel,
      tools: {
        models: async () => [
          { key: "p/one", id: "one", name: "One" },
          { key: "p/two", id: "two", name: "Two" },
          { key: "p/three", id: "three", name: "Three" },
        ],
      },
      agents: { models: async () => { throw new Error("no claude"); } },
      agent: async (_prompt: string, options: { label: string }) => {
        if (options.label === "panel · two") throw new Error("model failed");
        if (options.label === "fusion judge") {
          return {
            consensus: ["x"], contradictions: [], partial_coverage: ["2/3"],
            unique_insights: [], blind_spots: [],
          };
        }
        return `${options.label} response`;
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      coverage: { requested: 3, completed: 2 },
      analysis: { consensus: ["x"] },
    });
    expect(result).not.toHaveProperty("fallback");
  });

  it("preserves successful Workflow items and carries the objective through every phase", async () => {
    const prompts: string[] = [];
    const result = await runSkill("fabric-workflow", {
      π: { task: "audit authentication" },
      workflow,
      phase,
      parallel,
      agent: async (prompt: string, options: { label: string }) => {
        prompts.push(prompt);
        if (options.label === "inventory") return { items: ["a", "b", "c"] };
        if (options.label === "analyze b") throw new Error("worker failed");
        if (options.label === "verify synthesis") return "verified result";
        return `${options.label} finding`;
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      coverage: { requested: 3, completed: 2 },
      result: "verified result",
    });
    expect(result).not.toHaveProperty("fallback");
    expect(prompts.every((prompt) => prompt.includes("audit authentication"))).toBe(true);
  });

  it("verifies even a single Workflow finding", async () => {
    const calls: string[] = [];
    const result = await runSkill("fabric-workflow", {
      π: { task: "audit one module" }, workflow, phase, parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        calls.push(options.label);
        if (options.label === "inventory") return { items: ["one"] };
        if (options.label === "verify synthesis") return "verified one";
        return "one finding";
      },
    });
    expect(result).toMatchObject({ status: "success", result: "verified one" });
    expect(calls).toContain("verify synthesis");
  });

  it("normalizes RLM overlaps and caps recursive roots", async () => {
    const recursive: string[] = [];
    const result = await runSkill("fabric-rlm", {
      π: { task: "map" }, workflow, phase, parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        if (options.label === "scope") return { partitions: [
          { label: "parent", paths: ["src"], recursive: false },
          { label: "child", paths: ["src/a.ts"], recursive: true },
          { label: "lib", paths: ["lib"], recursive: true },
          { label: "app", paths: ["app"], recursive: true },
        ] };
        if (options.label === "combine") return "combined";
        throw new Error(`unexpected agent ${options.label}`);
      },
      rlm: { query: async ({ name }: { name: string }) => {
        recursive.push(name);
        return { status: "completed", text: `${name} finding` };
      } },
    });

    expect(result).toMatchObject({
      status: "partial",
      coverage: { requested: 4, dispatched: 2, completed: 2 },
      normalization: {
        proposed: 4,
        effective: 3,
        dispatched: 2,
        mergedOverlaps: [{ partition: "child", path: "src/a.ts", coveredBy: "src" }],
      },
      result: "combined",
    });
    expect(recursive).toHaveLength(2);
    expect(result.failures).toEqual([
      { partition: "app", paths: ["app"], status: "not_started", error: "recursive root limit reached" },
    ]);
  });

  it("returns one surviving Fusion response without spending a judge", async () => {
    const calls: string[] = [];
    const result = await runSkill("fabric-fusion", {
      π: {
        task: "compare", panel: JSON.stringify([{ model: "one" }, { model: "two" }]),
        judge: "", tools: "", thinking: "",
      },
      workflow, phase, parallel,
      tools: { models: async () => [
        { key: "p/one", id: "one", name: "One" },
        { key: "p/two", id: "two", name: "Two" },
      ] },
      agents: { models: async () => { throw new Error("no claude"); } },
      agent: async (_prompt: string, options: { label: string }) => {
        calls.push(options.label);
        if (options.label === "panel · two") throw new Error("failed");
        return "one response";
      },
    });
    expect(result).toMatchObject({ status: "partial", coverage: { requested: 2, completed: 1 } });
    expect(result).toHaveProperty("fallback");
    expect(calls).not.toContain("fusion judge");
  });

  it("rejects duplicate Fusion models before spending panel calls", async () => {
    let agentCalls = 0;
    await expect(runSkill("fabric-fusion", {
      π: {
        task: "compare", panel: JSON.stringify([{ model: "one" }, { model: "p/one" }]),
        judge: "", tools: "", thinking: "",
      },
      workflow, phase, parallel,
      tools: { models: async () => [{ key: "p/one", id: "one", name: "One" }] },
      agents: { models: async () => { throw new Error("no claude"); } },
      agent: async () => { agentCalls += 1; return "unexpected"; },
    })).rejects.toThrow("distinct resolved models");
    expect(agentCalls).toBe(0);
  });

  it("preflights Council roles and skips synthesis for one survivor", async () => {
    let calls = 0;
    await expect(runSkill("fabric-council", {
      π: { task: "decide", roles: JSON.stringify(["a", "b"]) }, workflow, phase, parallel,
      agent: async () => { calls += 1; return "unexpected"; },
    })).rejects.toThrow("3–8 distinct");
    expect(calls).toBe(0);

    const result = await runSkill("fabric-council", {
      π: { task: "decide", roles: JSON.stringify(["a", "b", "c"]) }, workflow, phase, parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        calls += 1;
        if (options.label !== "a") throw new Error("failed");
        return "a report";
      },
    });
    expect(result).toMatchObject({ status: "partial", result: "a report" });
    expect(result).not.toHaveProperty("fallback");
    expect(calls).toBe(3);
  });

  it("pins each Council seat and the synthesis to exact registry keys and reports them", async () => {
    const calls: Array<{ label: string; model: string | undefined; thinking: string | undefined }> = [];
    const result = await runSkill("fabric-council", {
      π: {
        task: "decide",
        roles: JSON.stringify([
          { role: "architect", model: "P/One", thinking: "high" },
          "researcher",
          { role: "adversary", model: "p/two" },
        ]),
        synthesis: "p/three",
      },
      workflow, phase, parallel,
      tools: { models: async () => [{ key: "p/one" }, { key: "p/two" }, { key: "p/three" }] },
      agent: async (_prompt: string, options: { label: string; model?: string; thinking?: string }) => {
        calls.push({ label: options.label, model: options.model, thinking: options.thinking });
        return options.label === "council synthesis" ? "decision" : `${options.label} report`;
      },
    });

    expect(calls).toEqual([
      { label: "architect", model: "p/one", thinking: "high" },
      { label: "researcher", model: undefined, thinking: undefined },
      { label: "adversary", model: "p/two", thinking: undefined },
      { label: "council synthesis", model: "p/three", thinking: undefined },
    ]);
    expect(result).toMatchObject({
      status: "success",
      result: "decision",
      synthesisModel: "p/three",
      seats: [
        { role: "architect", model: "p/one", thinking: "high", status: "completed" },
        { role: "researcher", status: "completed" },
        { role: "adversary", model: "p/two", status: "completed" },
      ],
    });
    expect((result.seats as Array<Record<string, unknown>>)[1]).not.toHaveProperty("model");
  });

  it("rejects unknown Council models and malformed seats before any agent runs", async () => {
    let calls = 0;
    const run = (roles: unknown[], synthesis = "") => runSkill("fabric-council", {
      π: { task: "decide", roles: JSON.stringify(roles), synthesis },
      workflow, phase, parallel,
      tools: { models: async () => [{ key: "p/two" }, { key: "q/two" }] },
      agent: async () => { calls += 1; return "unexpected"; },
    });

    await expect(run([{ role: "a", model: "x/two" }, "b", "c"]))
      .rejects.toThrow('model "x/two" for role "a" is not in the model registry. Did you mean: p/two, q/two?');
    await expect(run(["a", "b", "c"], "nope/model"))
      .rejects.toThrow('model "nope/model" for synthesis is not in the model registry.');
    await expect(run([{ role: "a", thinking: "extreme" }, "b", "c"]))
      .rejects.toThrow('Council role "a" has unknown thinking "extreme".');
    await expect(run([{ model: "p/two" }, "b", "c"]))
      .rejects.toThrow("A council role object needs a non-empty role.");
    await expect(run([{ role: "a", model: 42 }, "b", "c"]))
      .rejects.toThrow('Council role "a" has a non-string model or thinking.');
    await expect(run([{ role: "a", model: "p/two" }, { role: "a" }, "b", "c"]))
      .rejects.toThrow('Council role "a" appears twice with different settings.');
    await expect(run(["a", "b", "c", "d", "e", "f", "g", "h", "i"])).rejects.toThrow("3–8 distinct");
    expect(calls).toBe(0);
  });

  it("runs a six-seat Council", async () => {
    const labels: string[] = [];
    const result = await runSkill("fabric-council", {
      π: { task: "decide", roles: JSON.stringify(["a", "b", "c", "d", "e", "f"]), synthesis: "" },
      workflow, phase, parallel,
      agent: async (_prompt: string, options: { label: string }) => { labels.push(options.label); return "ok"; },
    });

    expect(result).toMatchObject({ status: "success", coverage: { requested: 6, completed: 6 } });
    expect(labels).toHaveLength(7);
  });

  it("returns Fusion responses only when judging fails", async () => {
    const result = await runSkill("fabric-fusion", {
      π: {
        task: "compare", panel: JSON.stringify([{ model: "one" }, { model: "two" }]),
        judge: "", tools: "", thinking: "",
      },
      workflow, phase, parallel,
      tools: { models: async () => [
        { key: "p/one", id: "one", name: "One" },
        { key: "p/two", id: "two", name: "Two" },
      ] },
      agents: { models: async () => { throw new Error("no claude"); } },
      agent: async (_prompt: string, options: { label: string }) => {
        if (options.label === "fusion judge") throw new Error("judge failed");
        return `${options.label} response`;
      },
    });
    expect(result).toMatchObject({ status: "partial", judgeError: "judge failed", analysis: null });
    expect(result.fallback).toHaveLength(2);
  });

  it("returns failed RLM coverage when no partition completes", async () => {
    const result = await runSkill("fabric-rlm", {
      π: { task: "map" }, workflow, phase, parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        if (options.label === "scope") return { partitions: [
          { label: "a", paths: ["a"], recursive: false },
          { label: "b", paths: ["b"], recursive: false },
        ] };
        throw new Error("provider down");
      },
      rlm: { query: async () => { throw new Error("unexpected"); } },
    });
    expect(result).toMatchObject({ status: "failed", coverage: { requested: 2, completed: 0 }, result: null });
    expect(result.failures).toHaveLength(2);
  });

  it("circuit-breaks Workflow after an all-failed batch", async () => {
    const called: string[] = [];
    const result = await runSkill("fabric-workflow", {
      π: { task: "audit" }, workflow, phase, parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        called.push(options.label);
        if (options.label === "inventory") {
          return { items: Array.from({ length: 9 }, (_, index) => `item-${index}`) };
        }
        throw new Error("provider down");
      },
    });
    expect(result).toMatchObject({ status: "failed", coverage: { requested: 9, completed: 0 } });
    expect(result.failures).toContainEqual({
      item: "item-8", status: "not_started", error: "not started after an all-failed batch",
    });
    expect(called).not.toContain("analyze item-8");
  });

  it("uses the first completed Fusion member as the implicit judge", async () => {
    let judgeModel: string | undefined;
    const result = await runSkill("fabric-fusion", {
      π: {
        task: "compare", panel: JSON.stringify([
          { model: "one", label: "first" },
          { model: "two", label: "second" },
          { model: "three", label: "third" },
        ]),
        judge: "", tools: "", thinking: "",
      },
      workflow, phase, parallel,
      tools: { models: async () => [
        { key: "p/one", id: "one", name: "One" },
        { key: "p/two", id: "two", name: "Two" },
        { key: "p/three", id: "three", name: "Three" },
      ] },
      agents: { models: async () => { throw new Error("no claude"); } },
      agent: async (_prompt: string, options: { label: string; model: string }) => {
        if (options.label === "panel · first") throw new Error("first provider failed");
        if (options.label === "fusion judge") {
          judgeModel = options.model;
          return { consensus: [], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [] };
        }
        return `${options.label} response`;
      },
    });
    expect(result).toMatchObject({ status: "partial", analysis: {} });
    expect(judgeModel).toBe("p/two");
    expect(result.failures).toContainEqual({
      label: "first", model: "p/one", runner: "pi", status: "failed",
      error: "first provider failed",
    });
  });

  it("acts with one read-only reference and an explicit actor, hiding advice on success", async () => {
    const referenceOptions: Array<Record<string, unknown>> = [];
    const actorOptions: Array<Record<string, unknown>> = [];
    const calls: string[] = [];
    const result = await runSkill("fabric-fusion", {
      π: {
        mode: "act",
        task: "fix the parser",
        panel: JSON.stringify([{ model: "one", label: "ref" }]),
        actor: "claude/sonnet",
        judge: "ignored-in-act",
        tools: "not-json",
        thinking: "",
      },
      workflow, phase, parallel,
      tools: { models: async () => [
        { key: "p/one", id: "one", name: "One" },
      ] },
      agents: { models: async () => [
        { key: "claude/sonnet", id: "sonnet", name: "Sonnet" },
      ] },
      agent: async (_prompt: string, options: { label: string }) => {
        calls.push(options.label);
        if (options.label === "reference · ref") {
          referenceOptions.push(options);
          return {
            approach: "rewrite the parser",
            material_risks: ["loses comments"],
            concrete_checks: ["run the fixture suite"],
          };
        }
        actorOptions.push(options);
        return "parser fixed and verified";
      },
    });

    expect(result).toMatchObject({
      status: "success",
      coverage: { requested: 1, completed: 1 },
      failures: [],
      result: "parser fixed and verified",
    });
    expect(result).not.toHaveProperty("fallback");
    expect(JSON.stringify(result)).not.toContain("approach");
    expect(JSON.stringify(result)).not.toContain("material_risks");
    expect(JSON.stringify(result)).not.toContain("concrete_checks");
    expect(referenceOptions[0]).toMatchObject({
      model: "p/one",
      tools: ["read", "grep", "find", "ls"],
    });
    const schema = (referenceOptions[0] as {
      schema: { required?: string[]; properties?: Record<string, { maxLength?: number }> };
    }).schema;
    expect(schema.required).toContain("approach");
    expect(schema.properties?.approach?.maxLength).toBe(600);
    expect(actorOptions[0]).toMatchObject({
      model: "claude/sonnet",
      runner: "claude",
      tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    });
    expect(calls).toEqual(["reference · ref", "fusion actor"]);
    expect(calls).not.toContain("fusion judge");
  });

  it("runs the actor after a partial act reference failure and honors strings.actorTools", async () => {
    const calls: string[] = [];
    let actorPrompt = "";
    let actorTools: string[] | undefined;
    const result = await runSkill("fabric-fusion", {
      π: {
        mode: "act",
        task: "harden the login flow",
        panel: JSON.stringify([{ model: "one" }, { model: "two" }]),
        actor: "three",
        actorTools: JSON.stringify(["read", "bash"]),
        tools: "",
        thinking: "",
      },
      workflow, phase, parallel,
      tools: { models: async () => [
        { key: "p/one", id: "one", name: "One" },
        { key: "p/two", id: "two", name: "Two" },
        { key: "p/three", id: "three", name: "Three" },
      ] },
      agents: { models: async () => { throw new Error("no claude"); } },
      agent: async (prompt: string, options: { label: string; tools?: string[] }) => {
        calls.push(options.label);
        if (options.label === "reference · two") throw new Error("reference unavailable");
        if (options.label === "fusion actor") {
          actorPrompt = prompt;
          actorTools = options.tools;
          return "fusion actor outcome";
        }
        return {
          approach: `${options.label} plan`,
          material_risks: [],
          concrete_checks: ["run focused tests"],
        };
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      coverage: { requested: 2, completed: 1 },
      result: "fusion actor outcome",
    });
    expect(result.failures).toEqual([
      { label: "two", model: "p/two", runner: "pi", status: "failed", error: "reference unavailable" },
    ]);
    expect(actorTools).toEqual(["read", "bash"]);
    expect(actorPrompt).toContain("reference · one plan");
    expect(actorPrompt).not.toContain("reference unavailable");
    expect(calls).toEqual(["reference · one", "reference · two", "fusion actor"]);
  });

  it("fails act mode without spending an actor when no reference completes", async () => {
    const calls: string[] = [];
    const result = await runSkill("fabric-fusion", {
      π: {
        mode: "act",
        task: "migrate the store",
        panel: JSON.stringify([{ model: "one" }, { model: "two" }]),
        actor: "three",
        tools: "",
        thinking: "",
      },
      workflow, phase, parallel,
      tools: { models: async () => [
        { key: "p/one", id: "one", name: "One" },
        { key: "p/two", id: "two", name: "Two" },
        { key: "p/three", id: "three", name: "Three" },
      ] },
      agents: { models: async () => { throw new Error("no claude"); } },
      agent: async (_prompt: string, options: { label: string }) => {
        calls.push(options.label);
        throw new Error("provider down");
      },
    });
    expect(result).toMatchObject({
      status: "failed",
      coverage: { requested: 2, completed: 0 },
      result: null,
    });
    expect(result.failures).toHaveLength(2);
    expect(calls).not.toContain("fusion actor");
  });

  it("returns compact reference advice when the act actor fails, without rerunning references", async () => {
    const calls: string[] = [];
    const result = await runSkill("fabric-fusion", {
      π: {
        mode: "act",
        task: "refactor auth",
        panel: JSON.stringify([{ model: "one" }]),
        actor: "two",
        tools: "",
        thinking: "",
      },
      workflow, phase, parallel,
      tools: { models: async () => [
        { key: "p/one", id: "one", name: "One" },
        { key: "p/two", id: "two", name: "Two" },
      ] },
      agents: { models: async () => { throw new Error("no claude"); } },
      agent: async (_prompt: string, options: { label: string }) => {
        calls.push(options.label);
        if (options.label === "fusion actor") throw new Error("actor crashed");
        return {
          approach: "extract middleware",
          material_risks: ["breaking change"],
          concrete_checks: ["typecheck"],
        };
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      coverage: { requested: 1, completed: 1 },
      result: null,
      actorError: "actor crashed",
    });
    expect(result.fallback).toEqual([
      {
        label: "one",
        model: "p/one",
        runner: "pi",
        status: "completed",
        advice: {
          approach: "extract middleware",
          material_risks: ["breaking change"],
          concrete_checks: ["typecheck"],
        },
      },
    ]);
    expect(calls).toEqual(["reference · one", "fusion actor"]);
  });

  it("preflights act mode before spending calls", async () => {
    let agentCalls = 0;
    await expect(runSkill("fabric-fusion", {
      π: {
        mode: "merge", task: "x", panel: JSON.stringify([{ model: "one" }]),
        actor: "one", tools: "", thinking: "",
      },
      workflow, phase, parallel,
      tools: { models: async () => [{ key: "p/one", id: "one", name: "One" }] },
      agents: { models: async () => { throw new Error("no claude"); } },
      agent: async () => { agentCalls += 1; return "unexpected"; },
    })).rejects.toThrow('"compare" or "act"');

    await expect(runSkill("fabric-fusion", {
      π: {
        mode: "act", task: "x", panel: JSON.stringify([{ model: "one" }]),
        actor: "", tools: "", thinking: "",
      },
      workflow, phase, parallel,
      tools: { models: async () => [{ key: "p/one", id: "one", name: "One" }] },
      agents: { models: async () => { throw new Error("no claude"); } },
      agent: async () => { agentCalls += 1; return "unexpected"; },
    })).rejects.toThrow("strings.actor");

    await expect(runSkill("fabric-fusion", {
      π: {
        mode: "act", task: "x",
        panel: JSON.stringify([
          { model: "one" }, { model: "two" }, { model: "three" },
          { model: "four" }, { model: "five" },
        ]),
        actor: "one", tools: "", thinking: "",
      },
      workflow, phase, parallel,
      tools: { models: async () => [
        { key: "p/one", id: "one", name: "One" }, { key: "p/two", id: "two", name: "Two" },
        { key: "p/three", id: "three", name: "Three" }, { key: "p/four", id: "four", name: "Four" },
        { key: "p/five", id: "five", name: "Five" },
      ] },
      agents: { models: async () => { throw new Error("no claude"); } },
      agent: async () => { agentCalls += 1; return "unexpected"; },
    })).rejects.toThrow("1–4");

    await expect(runSkill("fabric-fusion", {
      π: {
        mode: "act", task: "x", panel: JSON.stringify([{ model: "one" }]),
        actor: "two", actorTools: JSON.stringify({ read: true }), tools: "", thinking: "",
      },
      workflow, phase, parallel,
      tools: { models: async () => [
        { key: "p/one", id: "one", name: "One" },
        { key: "p/two", id: "two", name: "Two" },
      ] },
      agents: { models: async () => { throw new Error("no claude"); } },
      agent: async () => { agentCalls += 1; return "unexpected"; },
    })).rejects.toThrow("strings.actorTools");
    expect(agentCalls).toBe(0);
  });

  it("rejects unsafe RLM paths before delegation", async () => {
    let delegated = 0;
    const result = await runSkill("fabric-rlm", {
      π: { task: "map" }, workflow, phase, parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        if (options.label === "scope") {
          return { partitions: [{ label: "escape", paths: ["../secret"], recursive: false }] };
        }
        delegated += 1;
        return "unexpected";
      },
      rlm: { query: async () => { delegated += 1; return { status: "completed", text: "unexpected" }; } },
    });
    expect(result).toMatchObject({
      status: "failed",
      coverage: { requested: 1, dispatched: 0, completed: 0 },
      result: null,
    });
    expect(delegated).toBe(0);
  });

  it("continues valid RLM partitions while accounting for invalid ones", async () => {
    const result = await runSkill("fabric-rlm", {
      π: { task: "map" }, workflow, phase, parallel,
      agent: async (_prompt: string, options: { label: string }) => {
        if (options.label === "scope") return { partitions: [
          { label: "invalid", paths: [], recursive: false },
          { label: "valid", paths: ["././src"], recursive: false },
        ] };
        return "valid finding";
      },
      rlm: { query: async () => { throw new Error("unexpected"); } },
    });
    expect(result).toMatchObject({
      status: "partial",
      coverage: { requested: 2, dispatched: 1, completed: 1 },
      result: "valid finding",
    });
    expect(result.failures).toEqual([
      {
        partition: "invalid", paths: [], status: "not_started",
        error: "partition paths must be non-empty project-relative paths without '~' or '..'",
      },
    ]);
  });

  it("preserves an ambient actor's extension policy on reuse", async () => {
    const calls: string[] = [];
    const existing = {
      id: "actor-1", name: "advisor", status: "idle", runner: "pi",
      events: ["turn_end"], topics: [], delivery: "steer",
      responseMode: "directive", triggerTurn: false, coalesce: true,
      tools: [], extensions: false,
    };
    const result = await runProgram("skillsets/typescript/fabric-ambient/references/setup.md", {
      π: {
        name: "advisor", instructions: "observe", events: JSON.stringify(["turn_end"]),
        triggerTurn: "false", model: "",
      },
      tools: { models: async () => [] },
      agents: {
        actors: async () => [existing],
        setInstructions: async () => { calls.push("instructions"); },
        setTools: async () => { calls.push("tools"); },
        setEvents: async () => { calls.push("events"); },
        setDeliveryPolicy: async () => { calls.push("delivery"); },
        actorStatus: async () => ({ ...existing, tools: ["read", "grep", "find", "ls"] }),
      },
    });

    expect(result).toMatchObject({ reused: true, warnings: [] });
    expect(calls).toContain("tools");
  });

  it("omits an extension override when creating an ambient actor", async () => {
    let request: Record<string, unknown> | undefined;
    const actor = { id: "actor-2", name: "advisor", status: "idle" };
    const result = await runProgram("skillsets/typescript/fabric-ambient/references/setup.md", {
      π: {
        name: "advisor", instructions: "observe", events: JSON.stringify(["turn_end"]),
        triggerTurn: "false", model: "",
      },
      tools: { models: async () => [] },
      agents: {
        actors: async () => [],
        create: async (args: Record<string, unknown>) => { request = args; return actor; },
        actorStatus: async () => actor,
      },
    });

    expect(result).toMatchObject({ started: true, actor });
    expect(request).toBeDefined();
    expect(request).not.toHaveProperty("extensions");
  });


  it("does not mutate a running ambient actor", async () => {
    let setterCalls = 0;
    const existing = {
      id: "actor-running", name: "advisor", status: "running", runner: "pi",
      events: ["turn_end"], topics: [], delivery: "steer", responseMode: "directive",
      triggerTurn: false, coalesce: true, tools: ["read", "grep", "find", "ls"],
    };
    const result = await runProgram("skillsets/typescript/fabric-ambient/references/setup.md", {
      π: {
        name: "advisor", instructions: "observe", events: JSON.stringify(["turn_end"]),
        triggerTurn: "false", model: "",
      },
      tools: { models: async () => [] },
      agents: {
        actors: async () => [existing],
        setInstructions: async () => { setterCalls += 1; },
        setTools: async () => { setterCalls += 1; },
        setEvents: async () => { setterCalls += 1; },
        setDeliveryPolicy: async () => { setterCalls += 1; },
      },
    });
    expect(result).toMatchObject({ reused: false, actor: existing });
    expect((result.warnings as string[])[0]).toContain("wait until idle");
    expect(setterCalls).toBe(0);
  });

  it("normalizes Schema verification and rollback outcomes", async () => {
    const failedVerification = await runSkill("fabric-schema", {
      pi: { read: async () => "source" },
      schema: {
        hypothesize: async () => ({ hypothesisId: "h1" }),
        verify: async () => ({ verified: false, certificate: null, results: [] }),
      },
    });
    expect(failedVerification).toMatchObject({ status: "failed", verification: { verified: false } });
    expect(JSON.stringify(failedVerification)).not.toContain("certificate");

    let aborted = 0;
    const missingSha = await runSkill("fabric-schema", {
      pi: { read: async () => "source" },
      schema: {
        hypothesize: async () => ({ hypothesisId: "h-missing" }),
        verify: async () => ({ verified: true, certificate: "live-cert", results: [] }),
        abort: async ({ certificate }: { certificate: string }) => {
          expect(certificate).toBe("live-cert");
          aborted += 1;
          return { aborted: true };
        },
      },
    });
    expect(missingSha).toMatchObject({ status: "failed", reason: "missing observed SHA-256" });
    expect(JSON.stringify(missingSha)).not.toContain("live-cert");
    expect(aborted).toBe(1);

    const rolledBack = await runSkill("fabric-schema", {
      pi: { read: async () => "source" },
      schema: {
        hypothesize: async () => ({ hypothesisId: "h2" }),
        verify: async () => ({
          verified: true, certificate: "cert", results: [
            { evidence: { path: "src/parser.ts" }, observedSha256: "sha" },
          ],
        }),
        commit: async () => ({ outcome: "rolled_back", error: "postcondition failed" }),
      },
    });
    expect(rolledBack).toMatchObject({
      status: "failed",
      commit: { outcome: "rolled_back", error: "postcondition failed" },
    });
  });

});
