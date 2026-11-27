import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { availablePythonBackends, pythonBackends } from "./fixtures/python-backends.js";
import { rmTempSync } from "./fixtures/temp-cleanup.js";
import { FABRIC_COMPONENT_PROVIDER_NAMES } from "../src/components/provider-component.js";
import { normalizeFabricConfig, type FabricPythonRuntime } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import type { FabricActionDescriptor, FabricGuestTypeSources, FabricProvider } from "../src/protocol.js";
import {
  isProviderGlobalName,
  MAX_PROVIDER_GLOBALS,
  providerGlobalConflict,
  providerGlobalNames,
  warnProviderGlobalConflict,
} from "../src/provider-globals.js";
import { CPYTHON_CHILD_SOURCE } from "../src/runtime/cpython-child-source.js";
import { CPythonRuntime } from "../src/runtime/cpython-runtime.js";
import { buildDynamicGuestDeclarations } from "../src/runtime/dynamic-guest-types.js";
import { guestTypeDeclarations } from "../src/runtime/guest-types.js";
import type { FabricHostCall, FabricKernelRuntime, FabricSandboxOptions } from "../src/runtime/kernel.js";
import { MontyRuntime } from "../src/runtime/monty-runtime.js";
import { NodeProcessRuntime } from "../src/runtime/node-process-runtime.js";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";

// Sources are read from the repository root, not the process working directory.
const repoRoot = path.resolve(import.meta.dirname, "..");

// Every name a provider could register that would also be a valid global.
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const python = spawnSync("python3", ["-I", "-B", "-c", "import sys; print(sys.executable)"]);
const pythonBinary = python.status === 0 ? python.stdout.toString().trim() : undefined;
const options: FabricSandboxOptions = { timeoutMs: 10_000, memoryLimitBytes: 128 * 1024 * 1024 };
const eligible = (names: Iterable<string>): string[] =>
  [...new Set(names)].filter((name) => IDENTIFIER.test(name) && isProviderGlobalName(name)).sort();

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "generated" ? [] : sourceFiles(file);
    return entry.name.endsWith(".ts") ? [file] : [];
  });

describe("reserved provider-global names are derived from the code", () => {
  const enumerateGlobals = `
const names = new Set();
for (let scope = globalThis; scope; scope = Object.getPrototypeOf(scope)) {
  for (const name of Object.getOwnPropertyNames(scope)) names.add(name);
}
return [...names];`;
  const nativeHost: FabricHostCall = async (ref) =>
    ref === "fabric.$piAllTools" || ref === "fabric.$allTools" ? [] : ref === "native.load" ? {} : undefined;
  const typescriptRuntimes: Array<[string, () => FabricKernelRuntime]> = [
    ["quickjs", () => new QuickJsRuntime()],
    ["node-process", () => new NodeProcessRuntime("node")],
    ["bun-process", () => new NodeProcessRuntime("bun")],
  ];

  it.each(typescriptRuntimes)("reserves every global the %s sandbox defines", async (_name, create) => {
    for (const profile of ["additive", "native"] as const) {
      const result = await create().execute(enumerateGlobals, nativeHost, {
        ...options, codemodeProfile: profile, nativeToolsEnabled: true, nativeStoreEnabled: true,
      });
      expect(result.terminationReason, result.error).toBe("completed");
      expect(result.value).toEqual(expect.arrayContaining(["tools", "memory", "workflow", "escape"]));
      expect(eligible(result.value as string[]), profile).toEqual([]);
    }
  });

  it("reserves every global the TypeScript declarations declare", () => {
    const source = ts.createSourceFile("globals.d.ts", guestTypeDeclarations(true), ts.ScriptTarget.ES2022, false);
    const declared: string[] = [];
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) declared.push(declaration.name.text);
        }
      } else if (ts.isFunctionDeclaration(statement) && statement.name) {
        declared.push(statement.name.text);
      }
    }
    expect(declared).toEqual(expect.arrayContaining(["tools", "jev", "agent", "load", "models"]));
    expect(eligible(declared)).toEqual([]);
  });

  it("reserves every Python root, namespace name and prelude name", () => {
    const monty = fs.readFileSync(path.join(repoRoot, "src/runtime/monty-bridge.ts"), "utf8");
    const montyRoots = [.../const ROOTS = \[([^\]]*)\]/.exec(monty)![1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    const cpythonRoots = [...CPYTHON_CHILD_SOURCE.matchAll(/for name in \(([^)]*)\)/g)]
      .flatMap((match) => [...match[1]!.matchAll(/"([^"]+)"/g)].map((name) => name[1]!));
    const cpythonNamespace = [...CPYTHON_CHILD_SOURCE.matchAll(/namespace\.update\(\{([^}]*)\}/g)]
      .flatMap((match) => [...match[1]!.matchAll(/"([^"]+)":/g)].map((name) => name[1]!));
    const prelude = [
      ...fs.readFileSync(path.join(repoRoot, "src/programs/source.ts"), "utf8").matchAll(/const (\w+): any = /g),
      ...fs.readFileSync(path.join(repoRoot, "src/jev/manager.ts"), "utf8").matchAll(/const (\w+) = (?:JSON\.parse|Object\.freeze)/g),
    ].map((match) => match[1]!);
    expect(montyRoots).toContain("mesh");
    expect(cpythonRoots).toEqual(montyRoots);
    expect(cpythonNamespace).toEqual(expect.arrayContaining(["payloads", "asyncio"]));
    expect(prelude).toEqual(["input", "input", "program"]);
    expect(eligible([...montyRoots, ...cpythonRoots, ...cpythonNamespace, ...prelude])).toEqual([]);
  });

  it("reserves every lowercase TypeScript keyword", () => {
    const keywords: string[] = [];
    for (let kind = ts.SyntaxKind.FirstKeyword; kind <= ts.SyntaxKind.LastKeyword; kind++) {
      const text = ts.tokenToString(kind);
      if (text) keywords.push(text);
    }
    expect(keywords).toEqual(expect.arrayContaining(["delete", "new", "await", "type"]));
    expect(eligible(keywords)).toEqual([]);
  });

  it.skipIf(!pythonBinary)("reserves every Python keyword, soft keyword and builtin", () => {
    const listed = spawnSync(pythonBinary!, ["-c",
      "import builtins, json, keyword; print(json.dumps(keyword.kwlist + keyword.softkwlist + dir(builtins)))"]);
    expect(listed.status).toBe(0);
    const names = JSON.parse(listed.stdout.toString()) as string[];
    expect(names).toEqual(expect.arrayContaining(["lambda", "len", "match"]));
    expect(eligible(names)).toEqual([]);
  });

  it.skipIf(!pythonBinary)("reserves every name a CPython program sees", async () => {
    const result = await new CPythonRuntime(pythonBinary!).execute(
      "import builtins\nreturn sorted(set(globals()) | set(dir(builtins)))",
      async () => undefined,
      options,
    );
    expect(result.terminationReason, result.error).toBe("completed");
    expect(result.value).toEqual(expect.arrayContaining(["schema", "asyncio", "len"]));
    expect(eligible(result.value as string[])).toEqual([]);
  });

  // The two tests above only see the names of the Python they run on; pin the newest ones.
  it("reserves the names Python 3.15 adds", () => {
    expect(eligible(["lazy", "frozendict", "sentinel"])).toEqual([]);
  });

  it("reserves every built-in Fabric provider", () => {
    const builtins = new Set<string>(["fabric", "components", ...FABRIC_COMPONENT_PROVIDER_NAMES]);
    for (const file of sourceFiles(path.join(repoRoot, "src"))) {
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(/createProviderComponent\(\{\s*provider:\s*"([a-z][a-z0-9_-]*)"/g)) builtins.add(match[1]!);
      if (text.includes("implements FabricProvider")) {
        for (const match of text.matchAll(/readonly name = "([a-z][a-z0-9_-]*)"/g)) builtins.add(match[1]!);
      }
    }
    expect([...builtins]).toEqual(expect.arrayContaining(["tasks", "sessions", "native", "jev"]));
    expect(eligible(builtins)).toEqual([]);
  });

  it("accepts ordinary provider names and explains each refusal", () => {
    for (const name of ["context", "delegate", "my_tools", "a1"]) expect(providerGlobalConflict(name), name).toBeUndefined();
    expect(providerGlobalConflict("tools")).toBe('the Fabric program global "tools"');
    expect(providerGlobalConflict("tasks")).toBe('the built-in Fabric provider "tasks"');
    expect(providerGlobalConflict("delete")).toBe('the TypeScript keyword "delete"');
    expect(providerGlobalConflict("len")).toBe('the Python builtin "len"');
    for (const name of ["my-tools", "Context", "2fast", `a${"b".repeat(64)}`]) {
      expect(providerGlobalConflict(name), name).toMatch(/lowercase identifier/);
    }
  });

  it("deduplicates, sorts and caps the globals a program gets", () => {
    const many = Array.from({ length: MAX_PROVIDER_GLOBALS + 6 }, (_, index) => `p${String(index).padStart(3, "0")}`);
    expect(providerGlobalNames(["zeta", "tools", "alpha", "zeta", "my-tool"])).toEqual(["alpha", "zeta"]);
    expect(providerGlobalNames([...many].reverse())).toEqual(many.slice(0, MAX_PROVIDER_GLOBALS));
  });

  it("warns once per clashing name, naming the provider and the clash", () => {
    const warn = vi.fn();
    expect(warnProviderGlobalConflict("workflow", warn)).toBe(true);
    expect(warnProviderGlobalConflict("workflow", warn)).toBe(false);
    expect(warnProviderGlobalConflict("context", warn)).toBe(false);
    expect(warnProviderGlobalConflict("Not A Provider", warn)).toBe(false);
    expect(warnProviderGlobalConflict("my-delegate", warn)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toContain('Fabric provider "workflow" gets no program global');
    expect(warn.mock.calls[0]![0]).toContain('clashes with the Fabric program global "workflow"');
    expect(warn.mock.calls[0]![0]).toContain('tools.call({ ref: "workflow.<action>", args })');
    expect(warn.mock.calls[1]![0]).toContain('"my-delegate"');
  });
});

const taskAdd: FabricActionDescriptor = {
  name: "task_add", description: "Add a task", risk: "read",
  inputSchema: { type: "object", properties: { title: { type: "string" }, due: { type: "string" } }, required: ["title"], additionalProperties: false },
};
const taskList: FabricActionDescriptor = {
  name: "task_list", description: "List tasks", risk: "read",
  inputSchema: { type: "object", properties: { open: { type: "boolean" } }, additionalProperties: false },
};
const contextSources: FabricGuestTypeSources = {
  providers: [{ provider: "context", actions: [taskAdd, taskList].map(({ name, inputSchema }) => ({ name, inputSchema })) }],
};

describe("provider-global declarations", () => {
  const check = (code: string, sources: FabricGuestTypeSources = contextSources) =>
    typeCheckFabricCode(code, guestTypeDeclarations(true, { dynamic: buildDynamicGuestDeclarations(sources) }));

  it("types each declared action and rejects a wrong argument", () => {
    expect(check('return [await context.task_add({ title: "a", due: "today" }), await context.task_list()];').errors).toEqual([]);
    const misspelled = check('return await context.task_add({ titel: "a" });');
    expect(misspelled.errors.map((error) => error.message).join("\n")).toMatch(/'titel' does not exist/);
    const missing = check("return await context.task_add();");
    expect(missing.errors.map((error) => error.message).join("\n")).toMatch(/Expected 1 arguments/);
    const extra = check("return await context.task_list({ closed: true });");
    expect(extra.errors.map((error) => error.message).join("\n")).toMatch(/'closed' does not exist/);
  });

  it("declares nothing for a provider that is not in the sources", () => {
    expect(check("return await context.task_add({ title: 'a' });", {}).errors.map((error) => error.message))
      .toEqual(["Cannot find name 'context'."]);
  });

  it("gives a provider without action types a loose global", () => {
    const loose = { providers: [{ provider: "notes", actions: [] }] };
    expect(buildDynamicGuestDeclarations(loose).providers).toContain("declare const notes: FabricProviderGlobal;");
    expect(check("return await notes.anything({ any: 1 });", loose).errors).toEqual([]);
  });

  it("never declares a reserved or non-identifier provider name", () => {
    const hostile: FabricGuestTypeSources = {
      providers: [
        { provider: "tools", actions: [{ name: "call", inputSchema: { type: "object", properties: { only: { type: "number" } }, additionalProperties: false } }] },
        { provider: "my-tool", actions: [] },
        { provider: "print", actions: [] },
      ],
    };
    expect(buildDynamicGuestDeclarations(hostile).providers).toBeUndefined();
    expect(check('return await tools.call({ ref: "tools.call", args: {} });', hostile).errors).toEqual([]);
  });

  it("keeps every provider declared, loosely where its action types exceed the budget", () => {
    const wideActions = Array.from({ length: 400 }, (_, index) => ({
      name: `action_${index}`,
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(Array.from({ length: 20 }, (_, field) => [`field_${field}_with_a_long_name`, { type: "string" }])),
        additionalProperties: false,
      },
    }));
    const wide = { providers: [{ provider: "wide_a", actions: wideActions }, { provider: "wide_b", actions: wideActions }] };
    const declarations = buildDynamicGuestDeclarations(wide).providers!;
    expect(declarations.length).toBeLessThan(62_000);
    expect(declarations).toContain("declare const wide_a: FabricProviderGlobal_wide_a & FabricProviderGlobal;");
    expect(declarations).toContain("declare const wide_b: FabricProviderGlobal;");
    expect(check("await wide_a.action_399({ anything: 1 }); return await wide_b.action_0({ anything: 1 });", wide).errors).toEqual([]);
    expect(check("return await wide_a.action_0({ anything: 1 });", wide).errors.map((error) => error.message).join("\n"))
      .toMatch(/'anything' does not exist/);
  });
});

const provider = (name: string, invoke = vi.fn(async (action: string, args: Record<string, unknown>) => ({ action, args }))): FabricProvider & { invoke: typeof invoke } => ({
  name,
  description: `${name} fixture`,
  async list() { return [taskAdd, taskList]; },
  async describe(action) { return [taskAdd, taskList].find((descriptor) => descriptor.name === action); },
  invoke,
});

type KernelCase = { name: string; runtime: () => FabricKernelRuntime; python: boolean; skip?: boolean };
const kernels: KernelCase[] = [
  { name: "quickjs", runtime: () => new QuickJsRuntime(), python: false },
  { name: "node-process", runtime: () => new NodeProcessRuntime("node"), python: false },
  { name: "bun-process", runtime: () => new NodeProcessRuntime("bun"), python: false },
  { name: "monty", runtime: () => new MontyRuntime(), python: true, skip: !availablePythonBackends.monty },
  { name: "cpython", runtime: () => new CPythonRuntime(pythonBinary ?? "python3"), python: true, skip: !pythonBinary },
];

describe.each(kernels)("$name kernel provider globals", ({ runtime, python: isPython, skip }) => {
  const run = (typescript: string, pythonCode: string, providerGlobals?: string[], hostCall?: FabricHostCall) => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    return runtime().execute(isPython ? pythonCode : typescript, hostCall ?? (async (ref, args) => {
      calls.push([ref, args]);
      return { ok: true };
    }), { ...options, ...(providerGlobals ? { providerGlobals } : {}) }).then((result) => ({ result, calls }));
  };

  it.skipIf(skip)("calls a provider global through the tools.call host path", async () => {
    const { result, calls } = await run(
      'return await context.task_add({ title: "a" });',
      'return await context.task_add(title="a")',
      ["context"],
    );
    expect(result.terminationReason, result.error).toBe("completed");
    expect(calls).toEqual([["fabric.$call", { ref: "context.task_add", args: { title: "a" } }]]);
  });

  it.skipIf(skip)("has no global for a provider the host did not list", async () => {
    const { result, calls } = await run(
      'return typeof (globalThis as Record<string, unknown>)["context"];',
      'try:\n    context\n    return "defined"\nexcept NameError:\n    return "undefined"',
    );
    expect(result.terminationReason, result.error).toBe("completed");
    expect(result.value).toBe("undefined");
    expect(calls).toEqual([]);
  });

  it.skipIf(skip)("never lets a listed name replace a Fabric global", async () => {
    const { result, calls } = await run(
      "return await tools.providers();",
      "return await tools.providers()",
      ["tools", "context"],
    );
    expect(result.terminationReason, result.error).toBe("completed");
    expect(calls).toEqual([["fabric.$providers", {}]]);
  });
});

const roots: string[] = [];
const registries: ActionRegistry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  for (const root of roots.splice(0)) rmTempSync(root);
});

const service = (kernel: "typescript" | FabricPythonRuntime, overrides: Record<string, unknown> = {}) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-provider-globals-"));
  roots.push(cwd);
  const registry = new ActionRegistry();
  registries.push(registry);
  const config = normalizeFabricConfig({
    ...overrides,
    executor: {
      ...(overrides.executor as Record<string, unknown> | undefined),
      ...(kernel === "typescript"
        ? { kernel: "typescript" }
        : { kernel: "python", pythonRuntime: kernel, ...(pythonBinary ? { cpython: { binary: pythonBinary } } : {}) }),
    },
  });
  const execution = new FabricExecutionService(registry, config);
  let sequence = 0;
  const run = (code: string) => execution.execute({
    code, signal: undefined, parentToolCallId: `provider-global-${++sequence}`,
    context: { cwd, hasUI: false, sessionManager: { getSessionId: () => "provider-globals", getSessionFile: () => undefined } } as unknown as ExtensionContext,
    onPartial() {},
  });
  return { registry, config, run };
};

describe("provider globals through the execution service", () => {
  it("calls a registered provider through its typed global", async () => {
    const { registry, run } = service("typescript");
    const context = provider("context");
    registry.register(context);
    const result = await run('return await context.task_add({ title: "write tests" });');
    expect(result.success, result.error ?? JSON.stringify(result.typeErrors)).toBe(true);
    expect(result.value).toEqual({ action: "task_add", args: { title: "write tests" } });
    expect(result.audits.map((audit) => audit.ref)).toEqual(["context.task_add"]);
  });

  it("reads a provider's catalog only for a program that uses its global", async () => {
    const { registry, run } = service("typescript");
    const context = provider("context");
    const list = vi.spyOn(context, "list");
    registry.register(context);
    const unrelated = await run("return 1;");
    expect(unrelated.success, unrelated.error).toBe(true);
    expect(list).not.toHaveBeenCalled();
    const using = await run("return await context.task_list();");
    expect(using.success, using.error ?? JSON.stringify(using.typeErrors)).toBe(true);
    expect(list).toHaveBeenCalled();
  });

  it("fails type checking on a wrong argument before the provider runs", async () => {
    const { registry, run } = service("typescript");
    const context = provider("context");
    registry.register(context);
    const result = await run('return await context.task_add({ titel: "write tests" });');
    expect(result.success).toBe(false);
    expect(result.typeErrors?.map((error) => error.message).join("\n")).toMatch(/'titel' does not exist/);
    expect(context.invoke).not.toHaveBeenCalled();
  });

  it("types a destructured member and lets a local binding shadow the global", async () => {
    const { registry, run } = service("typescript");
    const context = provider("context");
    const list = vi.spyOn(context, "list");
    registry.register(context);
    const destructured = await run("const { task_list } = context; return await task_list();");
    expect(destructured.success, destructured.error ?? JSON.stringify(destructured.typeErrors)).toBe(true);
    expect(list).not.toHaveBeenCalled();
    expect(destructured.value).toEqual({ action: "task_list", args: {} });
    const shadowed = await run("const context = { task_list: () => 7 }; return context.task_list();");
    expect(shadowed.success, shadowed.error ?? JSON.stringify(shadowed.typeErrors)).toBe(true);
    expect(shadowed.value).toBe(7);
  });

  it("types the global under schema enforce", async () => {
    const { registry, run, config } = service("typescript", { schema: { mode: "enforce" } });
    expect(config.schema.mode).toBe("enforce");
    const context = provider("context");
    registry.register(context);
    const typed = await run('return await context.task_add({ title: "a" });');
    expect(typed.success, typed.error ?? JSON.stringify(typed.typeErrors)).toBe(true);
    const wrong = await run('return await context.task_add({ titel: "a" });');
    expect(wrong.success).toBe(false);
    expect(wrong.typeErrors?.map((error) => error.message).join("\n")).toMatch(/'titel' does not exist/);
    expect(context.invoke).toHaveBeenCalledTimes(1);
  });

  it("gives the native codemode profile the global, untyped like the rest of its JavaScript", async () => {
    const { registry, run, config } = service("typescript", { executor: { codemodeProfile: "native" } });
    expect(config.executor.codemodeProfile).toBe("native");
    const context = provider("context");
    registry.register(context);
    const result = await run('return await context.task_add({ title: "a" });');
    expect(result.success, result.error ?? JSON.stringify(result.typeErrors)).toBe(true);
    expect(result.value).toEqual({ action: "task_add", args: { title: "a" } });
    expect(result.audits.map((audit) => audit.ref)).toEqual(["context.task_add"]);
  });

  it("gives a clashing provider no global; tools.call still reaches it", async () => {
    const { registry, run } = service("typescript");
    const clashing = provider("workflow");
    registry.register(clashing);
    expect(registry.providerGlobals()).toEqual([]);
    const result = await run(`
      const viaTools = await tools.call({ ref: "workflow.task_list", args: {} });
      return { viaTools, builtIn: typeof workflow.phase, providerCalls: 0 };`);
    expect(result.success, result.error ?? JSON.stringify(result.typeErrors)).toBe(true);
    expect(result.value).toEqual({ viaTools: { action: "task_list", args: {} }, builtIn: "function", providerCalls: 0 });
    expect(clashing.invoke).toHaveBeenCalledTimes(1);
  });

  for (const kernel of ["typescript", ...pythonBackends] as const) {
    const unavailable = kernel !== "typescript" && !availablePythonBackends[kernel];
    it.skipIf(unavailable)(`denies the global exactly where policy denies tools.call (${kernel})`, async () => {
      const { registry, config, run } = service(kernel);
      const context = provider("context");
      registry.register(context);
      config.approvals.read = "deny";
      const python = kernel !== "typescript";
      const global = await run(python ? "return await context.task_list()" : "return await context.task_list();");
      const generic = await run(python
        ? 'return await tools.call(ref="context.task_list", args={})'
        : 'return await tools.call({ ref: "context.task_list", args: {} });');
      expect(global.success).toBe(false);
      expect(generic.success).toBe(false);
      expect(global.error).toContain("context.task_list");
      expect(global.trace.operations.map(({ ref, failureStage }) => ({ ref, failureStage })))
        .toEqual(generic.trace.operations.map(({ ref, failureStage }) => ({ ref, failureStage })));
      expect(global.trace.operations).toEqual([expect.objectContaining({ ref: "context.task_list", failureStage: "approve" })]);
      expect(context.invoke).not.toHaveBeenCalled();
      config.approvals.read = "allow";
      expect((await run(python ? "return await context.task_list()" : "return await context.task_list();")).success).toBe(true);
      expect(context.invoke).toHaveBeenCalledTimes(1);
    });

    it.skipIf(unavailable)(`removes the global for the next program after withdrawal (${kernel})`, async () => {
      const { registry, run } = service(kernel);
      const context = provider("context");
      registry.register(context);
      const python = kernel !== "typescript";
      const call = python ? "return await context.task_list()" : "return await context.task_list();";
      expect((await run(call)).success).toBe(true);
      registry.unregister("context", { keepProviderOpen: true });
      const after = await run(call);
      expect(after.success).toBe(false);
      if (python) expect(after.error).toMatch(/NameError|name 'context' is not defined/);
      else expect(after.typeErrors?.map((error) => error.message)).toEqual(["Cannot find name 'context'."]);
      if (!python) {
        const probe = await run('return Object.prototype.hasOwnProperty.call(globalThis, "context");');
        expect(probe.success, probe.error).toBe(true);
        expect(probe.value).toBe(false);
      }
      expect(context.invoke).toHaveBeenCalledTimes(1);
    });
  }
});
