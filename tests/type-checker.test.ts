import ts from "typescript";
import { describe, expect, it } from "vitest";
import { GUEST_TYPE_DECLARATIONS, guestTypeDeclarations } from "../src/runtime/guest-types.js";
import {
  normalizeTypeScriptPath,
  typeCheckFabricCode,
} from "../src/runtime/type-checker.js";

describe("Fabric guest type checker", () => {
  it("types explicit opt-in shell monitors and generic task controls", () => {
    const result = typeCheckFabricCode(`
const result = await pi.bash({cmd: "watch", description: "Watch CI", monitor: {delivery: "ui", match: "CI:", intervalMs: 5000, timeoutMs: 300000}});
return tools.call({ref: "tasks.list", args: {}});
`, GUEST_TYPE_DECLARATIONS);
    expect(result.errors).toEqual([]);
    const missing = typeCheckFabricCode('return pi.bash({cmd: "watch", monitor: {}});', GUEST_TYPE_DECLARATIONS);
    expect(missing.errors.length).toBeGreaterThan(0);
  });
  it("normalizes Windows paths for TypeScript compiler host comparisons", () => {
    expect(normalizeTypeScriptPath("C:\\work\\__pi_fabric_guest_1.ts")).toBe(
      "C:/work/__pi_fabric_guest_1.ts",
    );
  });

  it("accepts typed Fabric code with top-level return", () => {
    const result = typeCheckFabricCode(
      'const text = await pi.read({ path: "README.md" });\nreturn text.length;',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
    expect(result.javascript).toContain("async function __piFabricMain()");
    expect(result.javascript).not.toContain("path: string");
  });

  it("accepts a Veda persona and backend model on agents.run", () => {
    const result = typeCheckFabricCode(
      `
const run = await agents.run({
  runner: "veda",
  persona: "frontend",
  model: "claude-opus-4-6-thinking",
  task: "Polish the landing page",
});
return run.status;
`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("types cwd through one-shot helpers but not handoff or actors", () => {
    const accepted = typeCheckFabricCode(
      `
await agents.run({ task: "run elsewhere", cwd: "../other", recursive: true });
await agents.spawn({ task: "spawn elsewhere", cwd: "/tmp/other", residency: "durable" });
await agents.create({ name: "durable actor", instructions: "watch", residency: "durable" });
await workflow.agent("workflow elsewhere", { cwd: "worktree" });
await council.run({ task: "council elsewhere", roles: ["reviewer"], cwd: "council" });
return rlm.query({ task: "recursive elsewhere", cwd: "../other", worktree: true });
`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(accepted.errors).toEqual([]);

    const rejected = typeCheckFabricCode(
      `
await agents.handoff({ model: "provider/model", cwd: "other" });
await agents.create({ name: "actor", instructions: "watch", cwd: "other" });
return "never";
`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(rejected.errors.length).toBeGreaterThan(0);
    expect(rejected.errors.map((error) => error.message).join(" ")).toMatch(/cwd|known properties/i);
  });

  it("accepts dynamic MCP namespaces and orchestration helpers", () => {
    const result = typeCheckFabricCode(
      `
const mcpResult = await mcp.context7.resolve_library_id({ libraryName: "react" });
const review = await agents.run({ task: "Review it", transport: "localterm" });
console.log(review.status);
return { mcpResult, review };
`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("accepts immediate and predicate-gated trajectory handoff", () => {
    const result = typeCheckFabricCode(
      `
await pi.edit({ path: "src/a.ts", old: "a", new: "b" });
const migrated = await agents.setModel({ id: "reviewer", model: "anthropic/executor" });
return agents.handoff({
  model: "anthropic/executor",
  task: migrated.name,
  when: ({ count, calls }) =>
    count(["pi.edit", "mcp.docs.lookup"]) >= 1 && calls[0]?.ref === "pi.edit",
});
`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("accepts scoped actor bindings and per-activation overrides", () => {
    const result = typeCheckFabricCode(
      `
const session = await agents.setModel({
  id: "reviewer",
  model: "anthropic/session-model",
});
await agents.setThinking({ id: session.id, thinking: "low", scope: "session" });
const answer = await agents.ask({
  id: session.id,
  message: "Review once",
  model: "anthropic/one-off",
  thinking: "high",
});
await agents.setModel({ id: session.id, model: "anthropic/project", scope: "project" });
return { answer, binding: session.binding, defaults: session.projectDefaults };
`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });
  it("rejects unknown memory arguments", () => {
    const result = typeCheckFabricCode(
      'return memory.expand({ session: "session-id", befroe: 2 });',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors.map((error) => error.message).join(" ")).toMatch(/befroe|known properties/i);
  });

  it("accepts typed first-class Fabric provider calls", () => {
    const result = typeCheckFabricCode(
      `
const recalled = await memory.recall({ query: "proxy", branches: "active" });
const visited: Array<string | null | undefined> = [];
const walked = await memory.walk({ session: "session-id" }, async (entry, index) => {
  visited.push(entry.tool);
  return index < 2;
});
const followed = recalled.hits[0] ? await tools.call(recalled.hits[0].follow) : null;
const authoritative = recalled.coverage.complete && recalled.coverage.reasons.length === 0;
const current = await state.get();
const status = await schema.status();
const hypothesis = await schema.hypothesize({
  label: "proxy-surface",
  summary: "The direct provider surface is available",
  evidence: [{ kind: "file_exists", path: "package.json" }],
});
const pending = await compact.status();
return { recalled, authoritative, walked, followed, visited, current, mode: status.mode, hypothesis: hypothesis.hypothesisId, pending };
`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("rejects misspelled first-class provider argument keys", () => {
    const result = typeCheckFabricCode(
      'await compact.request({ reasno: "context pressure" }); return "never";',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toMatch(/reasno|known properties/i);
  });

  it("keeps first-class Fabric providers typed in orchestration-only mode", () => {
    const declarations = guestTypeDeclarations(false);
    expect(declarations).not.toContain("declare const pi: PiToolsApi");
    expect(declarations).not.toContain("declare const extensions: FabricExtensionsApi");
    expect(declarations).toContain("declare const schema: FabricSchemaApi");

    const result = typeCheckFabricCode(
      'const mode = (await schema.status()).mode; const matches = await memory.recall({ query: "x" }); return { mode, matches };',
      declarations,
    );
    expect(result.errors).toEqual([]);
  });

  it("excludes globals for unavailable providers", () => {
    const declarations = guestTypeDeclarations(false, { excludeGlobals: ["memory", "state"] });
    expect(declarations).not.toContain("declare const memory: FabricMemoryApi;");
    expect(declarations).not.toContain("declare const state: FabricStateApi;");
    expect(declarations).toContain("declare const schema: FabricSchemaApi");

    const typed = typeCheckFabricCode(
      'return memory.recall({ query: "x" });',
      declarations,
    );
    expect(typed.errors.some((error) => /Cannot find name 'memory'/.test(error.message))).toBe(
      true,
    );

    const untouched = typeCheckFabricCode(
      'return (await schema.status()).mode;',
      declarations,
    );
    expect(untouched.errors).toEqual([]);
  });

  it("accepts workflow, actor, and mesh primitives", () => {
    const result = typeCheckFabricCode(
      `
const captured = await extensions.project_status({ verbose: true });
console.log(captured.text);
const main = await agents.main();
await agents.followUp({ id: main.id, message: "review the result" });
const watcher = await agents.create({
  name: "advisor",
  instructions: "Review each turn",
  events: ["turn_end"],
  responseMode: "directive",
});
await agents.setTools({ id: watcher.id, tools: ["read", "grep", "find", "ls"] });
await mesh.publish({ topic: "team.review", to: watcher.id, text: "start" });
await phase("Review");
const findings = await parallel([
  () => agent<{ issues: string[] }>("Find issues", {
    label: "issue scan",
    schema: {
      type: "object",
      properties: { issues: { type: "array", items: { type: "string" } } },
      required: ["issues"],
    },
  }),
]);
return findings;
`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("accepts parallel(items, mapper, concurrency) and infers item types", () => {
    const result = typeCheckFabricCode(
      `
const items = [{ q: "a", n: 3 }, { q: "b", n: 2 }];
const out = await parallel(items, ({ q, n }) => agent(q + ":" + n, { label: q }), 2);
return out;
`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("reports user-facing line numbers for functional errors", () => {
    // Wrong arg type (path: 42) is now deferred to runtime (functional-errors-only);
    // an undefined name is a genuine breakage still caught at type-check.
    const result = typeCheckFabricCode(
      'await pi.read({ path: missingFile });\nreturn "never";',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.line).toBe(1);
    expect(result.errors[0]?.message).toContain("Cannot find name");
  });

  // The checker reports diagnostics for the guest file only, so a syntax
  // error in the declarations stays hidden behind parser recovery.
  const declarationSyntaxErrors = (declarations: string): string[] => {
    const fileName = "/__pi_fabric_globals.d.ts";
    const sourceFile = ts.createSourceFile(fileName, declarations, ts.ScriptTarget.ES2022, true);
    const program = ts.createProgram({
      rootNames: [fileName],
      options: { noLib: true, noResolve: true },
      host: {
        ...ts.createCompilerHost({}),
        fileExists: (name) => name === fileName,
        readFile: (name) => (name === fileName ? declarations : undefined),
        getSourceFile: (name) => (name === fileName ? sourceFile : undefined),
      },
    });
    return program.getSyntacticDiagnostics(sourceFile).map((diagnostic) => {
      const { line } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      return `${line + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
    });
  };

  it("renders guest declarations without syntax errors in both modes", () => {
    expect(declarationSyntaxErrors(guestTypeDeclarations(true))).toEqual([]);
    expect(declarationSyntaxErrors(guestTypeDeclarations(false))).toEqual([]);
  });

  it("types tools.call and tools.list results", () => {
    for (const fullCodeMode of [true, false]) {
      const declarations = guestTypeDeclarations(fullCodeMode);
      const accepted = typeCheckFabricCode(
        `
const result: unknown = await tools.call({ ref: "tasks.list", args: {} });
const page = await tools.list({ provider: "pi", limit: 10, envelope: true });
if (Array.isArray(page)) return page.map((action) => action.ref);
const total: number = page.total;
const truncated: boolean = page.truncated;
const kind: "pi-fabric.action-list" = page.kind;
return { result, total, truncated, kind, refs: page.actions.map((action) => action.ref) };
`,
        declarations,
        true,
      );
      expect(accepted.errors).toEqual([]);

      const rejected = typeCheckFabricCode(
        `
await tools.call({ args: {} });
await tools.list({ envelope: "yes" });
const page = await tools.list({ envelope: true });
if (!Array.isArray(page)) { const total: string = page.total; }
`,
        declarations,
        true,
      );
      expect(rejected.errors.map((error) => error.line)).toEqual([2, 3, 5]);
    }
  });
});
