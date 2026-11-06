import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { MontyRuntime } from "../src/runtime/monty-runtime.js";
type SkillHost = (ref: string, args: Record<string, unknown>) => Promise<unknown>;
import { AGENTS_ACTION_DESCRIPTORS } from "../src/providers/agents-actions.js";
import { validateCatalogArgs } from "../src/core/action-arguments.js";
import { availablePythonBackends } from "./fixtures/python-backends.js";

const completed = (value: unknown = "finding") => ({ id: "test-run-id", status: "completed", text: typeof value === "string" ? value : "", value });
const failed = { status: "failed", text: "", error: "worker unavailable" };
const model = (id: string) => ({ provider: "test", id, name: id, key: `test/${id}` });
const models = [model("one"), model("two"), model("three")];
const fusionPayloads = { task: "inspect", panel: JSON.stringify([{ model: "test/one" }, { model: "test/two" }]), mode: "compare", thinking: "", judge: "", tools: "", actor: "test/three", actorTools: "" };
const extractPythonPrograms = (source: string) => [...source.matchAll(/```python\r?\n([\s\S]*?)\r?\n```/g)].map((m) => m[1]!.replace(/\r\n?/g, "\n"));
const programs = (relative: string) => extractPythonPrograms(fs.readFileSync(`skillsets/python/${relative}`, "utf8"));
const execute = async (relative: string, payloads: Record<string, string>, host: SkillHost, index = 0) => {
  const extracted = programs(relative);
  expect(extracted[index], relative).toBeDefined();
  const result = await new MontyRuntime().execute(extracted[index]!, async (ref, args) => {
    if (ref.startsWith("agents.")) {
      const descriptor = AGENTS_ACTION_DESCRIPTORS.find((entry) => entry.name === ref.slice(7));
      expect(descriptor, ref).toBeDefined();
      expect(validateCatalogArgs(ref, descriptor!.inputSchema as Record<string, unknown>, args, undefined).invalid, ref).toBeUndefined();
    }
    return host(ref, args);
  }, { timeoutMs: 5000, memoryLimitBytes: 64 * 1024 * 1024, strings: payloads });
  expect(result.terminationReason, result.error).toBe("completed");
  return result.value as Record<string, any>;
};
const skill = (name: string, payloads: Record<string, string>, host: SkillHost) => execute(`${name}/SKILL.md`, payloads, host);

const catalog: SkillHost = async (ref) => {
  if (ref === "fabric.$models") return models;
  if (ref === "agents.models") return [];
  throw new Error(`Unexpected action ${ref}`);
};

it("extracts python fences from CRLF checkouts", () => {
  const lf = fs.readFileSync("skillsets/python/fabric-council/SKILL.md", "utf8").replace(/\r\n?/g, "\n");
  expect(extractPythonPrograms(lf.replace(/\n/g, "\r\n"))).toEqual(extractPythonPrograms(lf));
  expect(extractPythonPrograms(lf).length).toBeGreaterThan(0);
});

describe.skipIf(!availablePythonBackends.monty)("Python-native skill behavior in Monty", () => {
  it("runs every execution reference and its Python-only branches", async () => {
    const host: SkillHost = async (ref, args) => {
      if (ref === "pi.bash") return { ok: true, output: "clean" };
      if (ref === "fabric.$search") return [{ ref: "demo.status" }];
      if (ref === "fabric.$describe") return { inputSchema: { type: "object" } };
      if (ref === "agents.peers") return [{ id: "peer" }];
      if (ref === "agents.run") return completed();
      if (ref === "agents.spawn") return { id: "child" };
      if (ref === "mesh.put") return { key: args.key, version: 1 };
      return "example";
    };
    for (const file of ["fabric-exec/SKILL.md", "fabric-exec/references/agents.md", "fabric-exec/references/mesh.md", "fabric-exec/references/mcp.md"]) {
      expect(programs(file).length, file).toBeGreaterThan(0);
      for (let index = 0; index < programs(file).length; index++) await execute(file, {}, host, index);
    }
  });

  it.each(["parked", "unavailable", "collisions"])("council preserves long reports with %s storage before failed synthesis", async (storage) => {
    const reports = ["a", "b", "c"].map((role) => ({ role, report: `${role}:` + "x".repeat(1600) + `:${role}-tail` }));
    const puts: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    const storageError = storage === "collisions" ? "Mesh compare-and-swap failed: expected version 0" : "mesh unavailable";
    const result = await skill("fabric-council", { task: "decide", roles: '["a","b","c"]', synthesis: "" }, async (ref, args) => {
      if (ref === "mesh.put") {
        puts.push(args);
        events.push("put");
        if (storage !== "parked") throw new Error(storageError);
        return { key: args.key, version: 1 };
      }
      expect(ref).toBe("agents.run");
      if (args.name === "council synthesis") {
        events.push("synthesis");
        for (const report of reports) expect(args.task).toContain(report.report);
        return failed;
      }
      return completed(reports.find((report) => report.role === args.name)!.report);
    });
    expect(puts).toHaveLength(storage === "collisions" ? 4 : 1);
    expect(new Set(puts.map((put) => put.key)).size).toBe(puts.length);
    for (const put of puts) expect(put).toMatchObject({ ifVersion: 0, value: reports });
    expect(events.at(-1)).toBe("synthesis");
    expect(result).toMatchObject({ status: "partial", coverage: { requested: 3, completed: 3 }, result: null, synthesisError: "worker unavailable" });
    if (storage === "parked") expect(result.reports).toBe(puts[0]!.key);
    else expect(result.reports.error).toContain(storageError);
    expect(result.fallback).toEqual(reports.map(({ role, report }) => ({ role, status: "completed", report: storage === "parked" ? report.slice(0, 1200) : report })));
  });

  it.each([false, true])("council still synthesizes after a storage failure (collision=%s)", async (collision) => {
    const puts: Array<Record<string, unknown>> = [];
    let synthesisCalls = 0;
    const result = await skill("fabric-council", { task: "decide", roles: '["a","b","c"]', synthesis: "" }, async (ref, args) => {
      if (ref === "mesh.put") {
        puts.push(args);
        if (!collision) throw new Error("mesh unavailable");
        if (puts.length === 1) throw new Error("Mesh compare-and-swap failed: expected version 0, found 1");
        return { key: args.key, version: 1 };
      }
      expect(ref).toBe("agents.run");
      if (args.name === "council synthesis") { synthesisCalls++; return completed("decision"); }
      return completed(String(args.name) + " report");
    });
    expect(puts).toHaveLength(collision ? 2 : 1);
    expect(puts.every((put) => put.ifVersion === 0)).toBe(true);
    expect(synthesisCalls).toBe(1);
    expect(result).toMatchObject({ status: "success", result: "decision" });
    expect(result).not.toHaveProperty("fallback");
    if (collision) {
      expect(puts[1]!.key).toBe(String(puts[0]!.key).replace("/reports", "-2/reports"));
      expect(result.reports).toBe(puts[1]!.key);
    } else expect(result.reports.error).toContain("mesh unavailable");
  });

  it.each([false, true])("council preserves failed roles and synthesis fallback=%s", async (synthesisFails) => {
    let calls = 0;
    const result = await skill("fabric-council", { task: "decide", roles: JSON.stringify(["correctness", "security", "operations"]), synthesis: "" }, async (ref, args) => {
      if (ref === "mesh.put") return { key: args.key, version: 1 };
      expect(ref).toBe("agents.run");
      calls++;
      if (args.name === "security" || (args.name === "council synthesis" && synthesisFails)) return failed;
      return completed(args.name === "council synthesis" ? "decision" : "report");
    });
    expect(calls).toBe(4);
    expect(result).toMatchObject({ status: "partial", coverage: { requested: 3, completed: 2 }, failures: [{ role: "security" }] });
    if (synthesisFails) expect(result.fallback).toHaveLength(2);
    else { expect(result.result).toBe("decision"); expect(result.fallback).toBeUndefined(); }
  });

  it.each([0, 1])("council skips synthesis with %s surviving roles", async (survivors) => {
    let calls = 0;
    const puts: Array<Record<string, unknown>> = [];
    const report = "full survivor " + "x".repeat(1800);
    const result = await skill("fabric-council", { task: "decide", roles: '["a","b","c"]', synthesis: "" }, async (ref, args) => {
      if (ref === "mesh.put") {
        puts.push(args);
        return { key: args.key, version: 1 };
      }
      expect(ref).toBe("agents.run");
      return calls++ < survivors ? completed(report) : failed;
    });
    expect(calls).toBe(3);
    expect(result).toMatchObject({ status: survivors ? "partial" : "failed", coverage: { requested: 3, completed: survivors }, result: survivors ? report : null });
    expect(result.failures).toHaveLength(3 - survivors);
    expect(result).not.toHaveProperty("fallback");
    expect(puts).toHaveLength(survivors);
    if (survivors) {
      expect(puts[0]).toMatchObject({ ifVersion: 0, value: [{ role: "a", report }] });
      expect(result.reports).toBe(puts[0]!.key);
      expect(result.synthesisSkipped).toBeTruthy();
    } else expect(result).not.toHaveProperty("reports");
  });

  it("council pins seat and synthesis models to exact registry keys", async () => {
    const runs: Array<Record<string, unknown>> = [];
    const result = await skill("fabric-council", {
      task: "decide",
      roles: JSON.stringify([{ role: "architect", model: "TEST/One", thinking: "high" }, "researcher", { role: "adversary", model: "test/two" }]),
      synthesis: "test/three",
    }, async (ref, args) => {
      if (ref === "fabric.$models") return models;
      if (ref === "mesh.put") return { key: args.key, version: 1 };
      expect(ref).toBe("agents.run");
      runs.push({ name: args.name, model: args.model, thinking: args.thinking });
      return completed(args.name === "council synthesis" ? "decision" : "report");
    });
    expect(Object.fromEntries(runs.map((run) => [run.name, run]))).toEqual({
      architect: { name: "architect", model: "test/one", thinking: "high" },
      researcher: { name: "researcher" },
      adversary: { name: "adversary", model: "test/two" },
      "council synthesis": { name: "council synthesis", model: "test/three" },
    });
    expect(result).toMatchObject({
      status: "success",
      result: "decision",
      synthesisModel: "test/three",
      seats: [
        { role: "architect", model: "test/one", thinking: "high", status: "completed" },
        { role: "researcher", status: "completed" },
        { role: "adversary", model: "test/two", status: "completed" },
      ],
    });
    expect(result.seats[1]).not.toHaveProperty("model");
  });

  it("council rejects unknown models and malformed seats before any agent runs", async () => {
    const program = programs("fabric-council/SKILL.md")[0]!;
    let runs = 0;
    const host: SkillHost = async (ref) => {
      if (ref === "fabric.$models") return models;
      runs++;
      return completed();
    };
    const reject = async (roles: unknown[], synthesis = "") => {
      const result = await new MontyRuntime().execute(program, host, {
        timeoutMs: 5000, memoryLimitBytes: 64 * 1024 * 1024, strings: { task: "decide", roles: JSON.stringify(roles), synthesis },
      });
      expect(result.terminationReason).not.toBe("completed");
      return String(result.error);
    };
    expect(await reject([{ role: "a", model: "other/two" }, "b", "c"])).toContain("Council: model other/two for role a is not in the model registry. Did you mean: test/two?");
    expect(await reject(["a", "b", "c"], "test/none")).toContain("model test/none for synthesis is not in the model registry");
    expect(await reject([{ role: "a", thinking: "extreme" }, "b", "c"])).toContain("Council role a has unknown thinking extreme.");
    expect(await reject([{ model: "test/two" }, "b", "c"])).toContain("A council role object needs a non-empty role.");
    expect(await reject([{ role: "a", thinking: 3 }, "b", "c"])).toContain("Council role a has a non-string model or thinking.");
    expect(await reject([{ role: "a", model: "test/two" }, { role: "a" }, "b", "c"])).toContain("Council role a appears twice with different settings.");
    expect(await reject(["a", "b", "c", "d", "e", "f", "g", "h", "i"])).toContain("3–8 distinct");
    expect(runs).toBe(0);
  });

  it("council runs six seats", async () => {
    let calls = 0;
    const result = await skill("fabric-council", { task: "decide", roles: '["a","b","c","d","e","f"]', synthesis: "" }, async (ref, args) => {
      if (ref === "mesh.put") return { key: args.key, version: 1 };
      expect(ref).toBe("agents.run");
      calls++;
      return completed();
    });
    expect(calls).toBe(7);
    expect(result).toMatchObject({ status: "success", coverage: { requested: 6, completed: 6 } });
  });

  it("workflow stops after an all-failed batch and records unstarted items", async () => {
    let calls = 0;
    const result = await skill("fabric-workflow", { task: "inspect" }, async (_ref, args) => {
      calls++;
      return args.name === "inventory" ? completed({ items: Array.from({ length: 10 }, (_, i) => `item-${i}`) }) : failed;
    });
    expect(calls).toBe(9);
    expect(result.status).toBe("failed");
    expect(result.failures.filter((entry: any) => entry.status === "not_started")).toHaveLength(2);
  });

  it.each([false, true])("workflow verifies compact findings and preserves fallback=%s", async (verificationFails) => {
    const result = await skill("fabric-workflow", { task: "inspect" }, async (_ref, args) => {
      if (args.name === "inventory") return completed({ items: ["one", "one", "two"] });
      if (args.name === "verify synthesis") return verificationFails ? failed : completed("verified");
      return completed();
    });
    expect(result.coverage).toEqual({ requested: 2, completed: 2 });
    expect(result.status).toBe(verificationFails ? "partial" : "success");
    expect(Boolean(result.fallback)).toBe(verificationFails);
  });

  it.each(["compare", "act"])("fusion %s preserves bounded failure and one aggregation", async (mode) => {
    const names: string[] = [];
    const result = await skill("fabric-fusion", { ...fusionPayloads, mode }, async (ref, args) => {
      if (ref !== "agents.run") return catalog(ref, args);
      names.push(String(args.name));
      if (mode === "act" && args.model === "test/two") return failed;
      if (String(args.name).startsWith("reference")) {
        expect(args.tools).toEqual(["read", "grep", "find", "ls"]);
        return completed({ approach: "safe", material_risks: [], concrete_checks: [] });
      }
      if (args.name === "fusion actor") {
        expect(args.task).toContain("untrusted data");
        expect(args.tools).toContain("write");
        return completed("changed");
      }
      return completed(args.name === "fusion judge" ? { consensus: ["agree"], contradictions: [], partial_coverage: [], unique_insights: [], blind_spots: [] } : "report");
    });
    expect(names).toHaveLength(3);
    expect(result.status).toBe(mode === "act" ? "partial" : "success");
    expect(result.fallback).toBeUndefined();
  });

  it.each(["compare", "act"])("fusion %s keeps completed work when aggregation fails", async (mode) => {
    const result = await skill("fabric-fusion", { ...fusionPayloads, mode }, async (ref, args) => {
      if (ref !== "agents.run") return catalog(ref, args);
      return String(args.name).startsWith("fusion") ? failed : completed("report");
    });
    expect(result.status).toBe("partial");
    expect(result.fallback).toHaveLength(2);
  });

  it.each(["compare", "act"])("fusion %s does not aggregate all-failed references", async (mode) => {
    let calls = 0;
    const result = await skill("fabric-fusion", { ...fusionPayloads, mode }, async (ref, args) => {
      if (ref !== "agents.run") return catalog(ref, args);
      calls++;
      return failed;
    });
    expect(calls).toBe(2);
    expect(result.status).toBe("failed");
  });

  it("RLM normalizes overlaps, rejects path escapes and bounds recursive roots", async () => {
    const calls: Record<string, unknown>[] = [];
    const partitions = [
      { label: "parent", paths: ["./src//auth/"], recursive: false },
      { label: "nested", paths: ["src/auth/token.ts"], recursive: true },
      { label: "bad", paths: ["../outside"], recursive: false },
      ...["docs", "tests", "other"].map((p) => ({ label: p, paths: [p], recursive: true })),
    ];
    const result = await skill("fabric-rlm", { task: "audit" }, async (_ref, args) => {
      calls.push(args);
      return args.name === "scope" ? completed({ partitions }) : completed();
    });
    expect(calls.filter((entry) => entry.recursive)).toHaveLength(2);
    expect(result.normalization.mergedOverlaps).toHaveLength(1);
    expect(result.failures.filter((entry: any) => entry.status === "not_started")).toHaveLength(3);
    expect(result.status).toBe("partial");
  });

  it("RLM retains paths and stops after an all-failed batch", async () => {
    let calls = 0;
    const result = await skill("fabric-rlm", { task: "audit" }, async (_ref, args) => {
      calls++;
      return args.name === "scope" ? completed({ partitions: Array.from({ length: 6 }, (_, i) => ({ label: `p${i}`, paths: [`p${i}`], recursive: false })) }) : failed;
    });
    expect(calls).toBe(5);
    expect(result.failures).toHaveLength(6);
    expect(result.failures.every((item: any) => item.paths.length === 1)).toBe(true);
  });

  it.each([false, true])("ambient setup safely reuses idle actor=%s", async (reuse) => {
    const actions: string[] = [];
    const actor = { id: "actor", name: "advisor", status: "idle", runner: "pi", kernel: "python", responseMode: "directive", coalesce: true, topics: [], tools: [], events: [], delivery: "mailbox" };
    const result = await execute("fabric-ambient/references/setup.md", { name: "advisor", instructions: "review", events: '["agent_settled","tool_error"]', triggerTurn: "false", model: "" }, async (ref) => {
      actions.push(ref);
      if (ref === "agents.actors") return reuse ? [actor] : [];
      return actor;
    });
    expect(result[reuse ? "reused" : "started"]).toBe(true);
    expect(actions.includes("agents.create")).toBe(!reuse);
    if (reuse) expect(actions).toContain("agents.setDeliveryPolicy");
  });

  it("ambient setup refuses to recreate a busy or wrong-kernel actor", async () => {
    const actions: string[] = [];
    const result = await execute("fabric-ambient/references/setup.md", { name: "advisor", instructions: "review", events: '[]', triggerTurn: "false", model: "" }, async (ref) => {
      actions.push(ref);
      return [{ id: "a", name: "advisor", runner: "pi", kernel: "typescript", status: "running", responseMode: "directive", coalesce: true, topics: [] }];
    });
    expect(actions).toEqual(["agents.actors"]);
    expect(result.warnings).toHaveLength(2);
  });

  it("swarm returns partial setup identities without replaying successful effects", async () => {
    let creates = 0;
    const result = await skill("fabric-swarm", { run: "audit", tasks: '[{"id":"one","title":"One"}]', roles: '[{"name":"one","instructions":"work"},{"name":"two","instructions":"work"}]' }, async (ref, args) => {
      if (ref === "mesh.put") { expect(args.ifVersion).toBe(0); return { version: 1 }; }
      if (ref === "agents.create" && creates++ === 0) return { id: "a", name: "one" };
      throw new Error("creation failed");
    });
    expect(result).toMatchObject({ status: "partial", seeded: ["one"], actors: [{ id: "a" }], dispatched: [] });
  });

  it.each(["committed", "missing-sha", "unverified"])("schema preserves certificate boundary: %s", async (mode) => {
    const calls: string[] = [];
    const result = await skill("fabric-schema", {}, async (ref) => {
      calls.push(ref);
      if (ref === "schema.hypothesize") return { hypothesisId: "h" };
      if (ref === "schema.verify") return { verified: mode !== "unverified", certificate: "secret", results: [{ evidence: { path: "src/parser.ts" }, ...(mode !== "missing-sha" ? { observedSha256: "sha" } : {}) }] };
      if (ref === "schema.commit") return { outcome: "committed" };
      return null;
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(calls.includes("schema.commit")).toBe(mode === "committed");
    expect(calls.includes("schema.abort")).toBe(mode !== "committed");
  });
});
