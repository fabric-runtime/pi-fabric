import { describe, expect, it, vi } from "vitest";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";
import { classifyPiBashError } from "../src/core/pi-bash-error.js";

const options = { timeoutMs: 5_000, memoryLimitBytes: 32 * 1024 * 1024 };

describe("pi bare-string shorthand", () => {
  it("type-checks bare-string calls for string-primary pi tools", () => {
    const result = typeCheckFabricCode(
      'const a = await pi.bash("echo hi"); const b = await pi.read("x"); const c = await pi.ls("y"); const d = await pi.grep("z"); const e = await pi.find("w"); return { a: a.output, b, c, d, e };',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("defers non-string scalars and bare strings to object-only tools to runtime", () => {
    // Functional-errors-only: wrong arg type and bare strings to object-only
    // tools are no longer type-check errors — they surface at runtime instead.
    const bad = typeCheckFabricCode('await pi.bash(123); return "never";', GUEST_TYPE_DECLARATIONS);
    expect(bad.errors).toEqual([]);

    const editBad = typeCheckFabricCode('await pi.edit("/x"); return "never";', GUEST_TYPE_DECLARATIONS);
    expect(editBad.errors).toEqual([]);
  });

  it("coerces bare-string calls at runtime and passes object form through", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "pi.bash") return { ok: true, output: String(args.command), details: null };
      if (ref === "pi.read") return String(args.path);
      throw new Error("Unexpected call: " + ref);
    });
    const result = await new QuickJsRuntime().execute(
      'const a = await pi.bash("echo hi"); const b = await pi.bash({ command: "ls", timeout: 5 }); const c = await pi.read("/x"); return { a: a.output, b: b.output, c };',
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[0]).toBe("pi.bash");
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ command: "echo hi" });
    expect(hostCall.mock.calls[1]?.[0]).toBe("pi.bash");
    expect(hostCall.mock.calls[1]?.[1]).toEqual({ command: "ls", timeout: 5 });
    expect(hostCall.mock.calls[2]?.[0]).toBe("pi.read");
    expect(hostCall.mock.calls[2]?.[1]).toEqual({ path: "/x" });
    expect(result.value).toEqual({ a: "echo hi", b: "ls", c: "/x" });
  });

  it("normalizes PowerShell shorthand and settles native nonzero exits", async () => {
    const calls: Array<{ ref: string; args: Record<string, unknown> }> = [];
    const success = await new QuickJsRuntime().execute(
      'const result = await pi.powershell("Write-Output hi", { timeoutMs: 2000, workdir: "." }); return result.output;',
      async (ref, args) => {
        calls.push({ ref, args });
        return { ok: true, output: "hi", details: null };
      },
      options,
    );
    expect(success.error).toBeUndefined();
    expect(success.value).toBe("hi");
    expect(calls).toEqual([{
      ref: "pi.powershell",
      args: { command: "Write-Output hi", timeout: 2, cwd: "." },
    }]);

    const settled = await new QuickJsRuntime().execute(
      'return await pi.powershell("exit 7", { settle: true });',
      async () => {
        throw classifyPiBashError(new Error("failed\n\n\nCommand exited with code 7"));
      },
      options,
    );
    expect(settled.error).toBeUndefined();
    expect(settled.value).toMatchObject({ ok: false, exitCode: 7, output: "failed\n" });
  });

  it("rejects a nonzero exit by default and settles only with settle:true", async () => {
    const checked = typeCheckFabricCode(
      `const result = await pi.bash({ command: "exit 7", settle: true });
       return result.ok ? result.output : result.exitCode;`,
      GUEST_TYPE_DECLARATIONS,
    );
    expect(checked.errors).toEqual([]);

    const hostCall = vi.fn(async (_ref: string, args: Record<string, unknown>) => {
      if (args.command === "exit 7") {
        throw classifyPiBashError(new Error("before\n\n\nCommand exited with code 7"));
      }
      throw new Error("Command timed out after 1000ms");
    });
    const result = await new QuickJsRuntime().execute(
      `let defaultRejected;
       try { await pi.bash({ command: "exit 7" }); }
       catch (error) { defaultRejected = error instanceof Error ? error.message : String(error); }
       const settled = await pi.bash({ command: "exit 7", settle: true });
       let timeoutError;
       try { await pi.bash({ command: "sleep 2", timeout: 1, settle: true }); }
       catch (error) { timeoutError = error instanceof Error ? error.message : String(error); }
       return { defaultRejected, settled, timeoutError };`,
      hostCall,
      options,
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      defaultRejected: "before\n\n\nCommand exited with code 7",
      settled: {
        ok: false,
        output: "before\n",
        details: null,
        exitCode: 7,
        error: "before\n\n\nCommand exited with code 7",
      },
      timeoutError: "Command timed out after 1000ms",
    });
    // settle is a guest-only directive; it never reaches the host.
    expect(hostCall.mock.calls[1]?.[1]).toEqual({ command: "exit 7" });
    expect(hostCall.mock.calls[2]?.[1]).toEqual({ command: "sleep 2", timeout: 1 });
    expect(hostCall.mock.calls.map((call) => call[0])).toEqual(["pi.bash", "pi.bash", "pi.bash"]);
  });
});

describe("pi argument alias flattening", () => {
  it("type-checks common alias keys and the flat edit shape", () => {
    const result = typeCheckFabricCode(
      'const a = await pi.bash({ cmd: "echo hi" });' +
        'const b = await pi.find({ query: "*.ts" });' +
        'const c = await pi.read({ file: "/x" });' +
        'const d = await pi.write({ file: "/y", content: "z" });' +
        'const e = await pi.edit({ file: "/x", oldText: "a", newText: "b", all: true });' +
        'const f = await pi.ls({ dir: "/s" });' +
        'return { a: a.output, b, c, d: d.output, e: e.output, f };',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });


  it("type-checks observed long-tail aliases", () => {
    const result = typeCheckFabricCode(
      'const a = await pi.read({ file_path: "/x" });' +
        'const b = await pi.grep({ q: "TODO" });' +
        'const c = await pi.write({ target_file: "/y", fileContent: "z" });' +
        'const d = await pi.edit({ absolutePath: "/x", from: "a", to: "b" });' +
        'const e = await pi.edit({ path: "/x", edits: [{ old_string: "a", new_content: "b" }] });' +
        'const f = await pi.ls({ directoryPath: "/s" });' +
        'const g = await pi.find({ include: "*.ts" });' +
        'const h = await pi.bash({ commandLine: "pwd" });' +
        'return { a, b, c: c.output, d: d.output, e: e.output, f, g, h: h.output };',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("normalizes aliases inside batched edits", async () => {
    const hostCall = vi.fn(async () => ({ ok: true, output: "edited", details: null }));
    const result = await new QuickJsRuntime().execute(
      'return pi.edit({ path: "/x", edits: [{ old: "a", replacement: "b", all: true }] });',
      hostCall,
      options,
    );

    expect(result.error).toBeUndefined();
    expect(hostCall).toHaveBeenCalledWith("pi.edit", {
      path: "/x",
      edits: [{ oldText: "a", newText: "b", all: true }],
    }, expect.any(AbortSignal), expect.any(Function));
  });

  it("normalizes alias keys and the flat edit shape at runtime", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "pi.bash") return { ok: true, output: String(args.command), details: null };
      if (ref === "pi.find") return "found";
      if (ref === "pi.read") return "read";
      if (ref === "pi.write") return { ok: true, output: "wrote", details: null };
      if (ref === "pi.edit") return { ok: true, output: "edited", details: null };
      if (ref === "pi.ls") return "listed";
      throw new Error("Unexpected call: " + ref);
    });
    const result = await new QuickJsRuntime().execute(
      'const a = await pi.bash({ cmd: "echo hi" });' +
        'const b = await pi.find({ query: "*.ts" });' +
        'const c = await pi.read({ file: "/x" });' +
        'const d = await pi.write({ file: "/y", content: "z" });' +
        'const e = await pi.edit({ file: "/x", oldText: "a", newText: "b" });' +
        'const f = await pi.ls({ dir: "/s" });' +
        'return { a: a.output, b, c, d: d.output, e: e.output, f };',
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ command: "echo hi" });
    expect(hostCall.mock.calls[1]?.[1]).toEqual({ pattern: "*.ts" });
    expect(hostCall.mock.calls[2]?.[1]).toEqual({ path: "/x" });
    expect(hostCall.mock.calls[3]?.[1]).toEqual({ path: "/y", content: "z" });
    expect(hostCall.mock.calls[4]?.[1]).toEqual({ path: "/x", edits: [{ oldText: "a", newText: "b" }] });
    expect(hostCall.mock.calls[5]?.[1]).toEqual({ path: "/s" });
    expect(result.value).toEqual({ a: "echo hi", b: "found", c: "read", d: "wrote", e: "edited", f: "listed" });
  });

  it("normalizes observed long-tail aliases before host validation", async () => {
    const calls: Array<{ ref: string; args: Record<string, unknown> }> = [];
    const result = await new QuickJsRuntime().execute(
      `
await pi.read({ file_path: "/x" });
await pi.grep({ q: "TODO" });
await pi.write({ target_file: "/y", fileContent: "z" });
await pi.edit({ absolutePath: "/x", from: "a", to: "b" });
await pi.edit({ path: "/x", edits: [{ old_string: "c", new_content: "d" }] });
await pi.ls({ directoryPath: "/s" });
await pi.find({ include: "*.ts" });
await pi.bash({ commandLine: "pwd" });
return "done";
`,
      async (ref, args) => {
        calls.push({ ref, args });
        return ref === "pi.bash" || ref === "pi.edit" || ref === "pi.write"
          ? { ok: true, output: "ok", details: null }
          : "ok";
      },
      options,
    );

    expect(result.error).toBeUndefined();
    expect(calls.map((call) => call.args)).toEqual([
      { path: "/x" },
      { pattern: "TODO" },
      { path: "/y", content: "z" },
      { path: "/x", edits: [{ oldText: "a", newText: "b" }] },
      { path: "/x", edits: [{ oldText: "c", newText: "d" }] },
      { path: "/s" },
      { pattern: "*.ts" },
      { command: "pwd" },
    ]);
  });

  it("omits only known optional nulls and lets canonical fields win", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await new QuickJsRuntime().execute(
      `
await pi.read({ path: "/canonical", file_path: "/alias", offset: null, limit: null });
await pi.bash({ command: "pwd", timeoutMs: null });
await pi.grep({ pattern: "TODO", path: null, glob: null, ignoreCase: null, literal: null, context: null, limit: null });
await pi.find({ pattern: "*.ts", path: null, limit: null });
await pi.ls({ path: null, limit: null });
await pi.read({ path: null, offset: null });
return "done";
`,
      async (ref, args) => {
        calls.push(args);
        return ref === "pi.bash" ? { ok: true, output: "ok", details: null } : "ok";
      },
      options,
    );

    expect(result.error).toBeUndefined();
    expect(calls).toEqual([
      { path: "/canonical" },
      { command: "pwd" },
      { pattern: "TODO" },
      { pattern: "*.ts" },
      {},
      { path: null },
    ]);
  });

});

describe("agents.status debug fields", () => {
  it("type-checks text/value/error/logFile on the status union without narrowing", () => {
    const result = typeCheckFabricCode(
      'const s = await agents.status({ id: "x" });' +
        'return { error: s.error, text: s.text, value: s.value, log: s.logFile };',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });
});

describe("pi positional args", () => {
  it("type-checks multi-arg positional calls", () => {
    const result = typeCheckFabricCode(
      'const a = await pi.grep("TODO", "src");' +
        'const b = await pi.find("*.ts", "src", 10);' +
        'const c = await pi.write("/x", "content");' +
        'const d = await pi.edit("/y", "old", "new");' +
        'return { a, b, c: c.output, d: d.output };',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("maps positional args to canonical object form at runtime", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "pi.grep") return "g";
      if (ref === "pi.find") return "f";
      if (ref === "pi.write") return { ok: true, output: "w", details: null };
      if (ref === "pi.edit") return { ok: true, output: "e", details: null };
      throw new Error("Unexpected call: " + ref);
    });
    const result = await new QuickJsRuntime().execute(
      'const a = await pi.grep("TODO", "src");' +
        'const b = await pi.find("*.ts", "src", 10);' +
        'const c = await pi.write("/x", "content");' +
        'const d = await pi.edit("/y", "old", "new");' +
        'return { a, b, c: c.output, d: d.output };',
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ pattern: "TODO", path: "src" });
    expect(hostCall.mock.calls[1]?.[1]).toEqual({ pattern: "*.ts", path: "src", limit: 10 });
    expect(hostCall.mock.calls[2]?.[1]).toEqual({ path: "/x", content: "content" });
    expect(hostCall.mock.calls[3]?.[1]).toEqual({ path: "/y", edits: [{ oldText: "old", newText: "new" }] });
    expect(result.value).toEqual({ a: "g", b: "f", c: "w", d: "e" });
  });

  it("type-check-rejects 2-arg calls with a non-object second arg so it is not silently dropped", () => {
    const result = typeCheckFabricCode('await pi.read("/x", 10); return "never";', GUEST_TYPE_DECLARATIONS);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => /properties in common|argument/i.test(e.message))).toBe(true);
  });

  it("type-checks two-arg (primary, options) calls for string-primary tools", () => {
    const result = typeCheckFabricCode(
      'const a = await pi.read("index.ts", { limit: 120 });' +
        'const b = await pi.bash("ls dist", { timeout: 30 });' +
        'const c = await pi.bash("pwd", { timeoutMs: 5000, settle: true });' +
        'const d = await pi.ls("src", { limit: 20 });' +
        'const e = await pi.grep("TODO", { path: "src", ignoreCase: true, ctx: 2 });' +
        'const f = await pi.find("*.ts", { path: "src", limit: 5 });' +
        'return { a, b: b.ok, c: c.ok, d, e, f };',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("merges two-arg (primary, options) calls into canonical object form at runtime", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "pi.bash") return { ok: true, output: "b", details: null };
      if (ref === "pi.read") return "r";
      if (ref === "pi.ls") return "l";
      if (ref === "pi.grep") return "g";
      if (ref === "pi.find") return "f";
      throw new Error("Unexpected call: " + ref);
    });
    const result = await new QuickJsRuntime().execute(
      'const a = await pi.read("index.ts", { limit: 120 });' +
        'const b = await pi.bash("ls", { timeoutMs: 2000 });' +
        'const c = await pi.ls("src", { max: 10 });' +
        'const d = await pi.grep("TODO", { path: "src", ctx: 2 });' +
        'const e = await pi.find("*.ts", { path: "src", limit: "5" });' +
        'const f = await pi.read("positional.ts", { path: "object.ts", limit: 1 });' +
        'return [a, b.output, c, d, e, f];',
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ path: "index.ts", limit: 120 });
    // timeoutMs unit conversion applies to the merged object.
    expect(hostCall.mock.calls[1]?.[1]).toEqual({ command: "ls", timeout: 2 });
    expect(hostCall.mock.calls[2]?.[1]).toEqual({ path: "src", limit: 10 });
    expect(hostCall.mock.calls[3]?.[1]).toEqual({ pattern: "TODO", path: "src", context: 2 });
    // Numeric strings still coerce to numbers after the merge.
    expect(hostCall.mock.calls[4]?.[1]).toEqual({ pattern: "*.ts", path: "src", limit: 5 });
    // The positional string wins the primary field on conflict.
    expect(hostCall.mock.calls[5]?.[1]).toEqual({ path: "positional.ts", limit: 1 });
    expect(result.value).toEqual(["r", "b", "l", "g", "f", "r"]);
  });

  it("settles a two-arg bash call when the merged options carry settle:true", async () => {
    const hostCall = vi.fn(async (_ref: string, _args: Record<string, unknown>): Promise<never> => {
      throw classifyPiBashError(new Error("oops\n\n\nCommand exited with code 7"));
    });
    const result = await new QuickJsRuntime().execute(
      'return await pi.bash("exit 7", { settle: true });',
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ command: "exit 7" });
    expect(result.value).toEqual({
      ok: false,
      output: "oops\n",
      details: null,
      exitCode: 7,
      error: "oops\n\n\nCommand exited with code 7",
    });
  });
});

describe("pi expanded argument aliases", () => {
  it("type-checks expanded alias keys", () => {
    const result = typeCheckFabricCode(
      'const a = await pi.bash({ shell: "ls", timeoutMs: 5 });' +
        'const b = await pi.grep({ regex: "TODO", ic: true, ctx: 2, max: 5, globPattern: "*.ts" });' +
        'const c = await pi.find({ search: "*.ts", max: 3 });' +
        'const d = await pi.read({ path: "/x", start: 0, max: 10 });' +
        'const e = await pi.write({ path: "/y", text: "z" });' +
        'const f = await pi.edit({ path: "/x", old: "a", new: "b" });' +
        'const g = await pi.ls({ file: "/s", max: 2 });' +
        'return { a: a.output, b, c, d, e: e.output, f: f.output, g };',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors).toEqual([]);
  });

  it("converts bash timeoutMs to timeout seconds", async () => {
    const hostCall = vi.fn(async (_ref: string, _args: Record<string, unknown>) => ({
      ok: true,
      output: "",
      details: null,
    }));
    const result = await new QuickJsRuntime().execute(
      'return await pi.bash({ command: "sleep 1", timeoutMs: 1000 });',
      hostCall,
      options,
    );

    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ command: "sleep 1", timeout: 1 });
  });

  it("normalizes expanded alias keys at runtime", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "pi.bash") return { ok: true, output: String(args.command), details: null };
      if (ref === "pi.grep") return "g";
      if (ref === "pi.find") return "f";
      if (ref === "pi.read") return "r";
      if (ref === "pi.write") return { ok: true, output: "w", details: null };
      if (ref === "pi.edit") return { ok: true, output: "e", details: null };
      if (ref === "pi.ls") return "l";
      throw new Error("Unexpected call: " + ref);
    });
    const result = await new QuickJsRuntime().execute(
      'const a = await pi.bash({ shell: "ls", timeoutMs: 5000 });' +
        'const b = await pi.grep({ regex: "TODO", ic: true, ctx: 2, max: 5, globPattern: "*.ts" });' +
        'const c = await pi.find({ search: "*.ts", max: 3 });' +
        'const d = await pi.read({ path: "/x", start: 0, max: 10 });' +
        'const e = await pi.write({ path: "/y", text: "z" });' +
        'const f = await pi.edit({ path: "/x", old: "a", new: "b" });' +
        'const g = await pi.ls({ file: "/s", max: 2 });' +
        'return { a: a.output, b, c, d, e: e.output, f: f.output, g };',
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ command: "ls", timeout: 5 });
    expect(hostCall.mock.calls[1]?.[1]).toEqual({ pattern: "TODO", ignoreCase: true, context: 2, limit: 5, glob: "*.ts" });
    expect(hostCall.mock.calls[2]?.[1]).toEqual({ pattern: "*.ts", limit: 3 });
    expect(hostCall.mock.calls[3]?.[1]).toEqual({ path: "/x", offset: 0, limit: 10 });
    expect(hostCall.mock.calls[4]?.[1]).toEqual({ path: "/y", content: "z" });
    expect(hostCall.mock.calls[5]?.[1]).toEqual({ path: "/x", edits: [{ oldText: "a", newText: "b" }] });
    expect(hostCall.mock.calls[6]?.[1]).toEqual({ path: "/s", limit: 2 });
    expect(result.value).toEqual({ a: "ls", b: "g", c: "f", d: "r", e: "w", f: "e", g: "l" });
  });
});

describe("tools discovery proxy", () => {
  it("routes discovery, normalizes search shorthand, and adds core-tool aliases", async () => {
    const checked = typeCheckFabricCode(
      'return tools.search("fovea");',
      GUEST_TYPE_DECLARATIONS,
    );
    expect(checked.errors).toEqual([]);

    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "fabric.$providers") return [{ name: "pi", description: "Pi core" }];
      if (ref === "fabric.$list") return [];
      if (ref === "fabric.$search") return [{ ref: `extensions.${String(args.query)}_focus` }];
      if (ref === "fabric.$nativeTool") return "native read";
      throw new Error("Unexpected call: " + ref);
    });
    const result = await new QuickJsRuntime().execute(
      'const p = await tools.providers();' +
        'const l = await tools.list({});' +
        'const s = await tools.search("fovea");' +
        'const err = await tools.read({ path: "/x" });' +
        'return { providers: p.length, list: l.length, search: s[0].ref, err };',
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[0]).toBe("fabric.$providers");
    expect(hostCall.mock.calls[1]?.[0]).toBe("fabric.$list");
    expect(hostCall.mock.calls[2]?.slice(0, 2)).toEqual(["fabric.$search", { query: "fovea" }]);
    const value = result.value as { providers: number; list: number; search: string; err: string };
    expect(value.providers).toBe(1);
    expect(value.list).toBe(0);
    expect(value.search).toBe("extensions.fovea_focus");
    expect(value.err).toBe("native read");
    expect(hostCall.mock.calls[3]?.slice(0, 2)).toEqual(["fabric.$nativeTool", {name: "read", args: {path: "/x"}}]);
  });
  it("passes list envelope requests through to the host verbatim", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => {
      if (ref === "fabric.$list") {
        return {
          kind: "pi-fabric.action-list",
          version: 1,
          actions: [{ ref: "demo.echo", name: "echo", description: "Echo a string", provider: "demo", namespace: "demo", risk: "read", inputSchema: {} }],
          total: 421,
          truncated: true,
          limit: 100,
        };
      }
      throw new Error("Unexpected call: " + ref);
    });
    const result = await new QuickJsRuntime().execute(
      'const page = await tools.list({ envelope: true });' +
        'return { kind: page.kind, truncated: page.truncated, total: page.total, first: page.actions[0].ref };',
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(hostCall.mock.calls[0]?.[0]).toBe("fabric.$list");
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ envelope: true });
    expect(result.value).toEqual({ kind: "pi-fabric.action-list", truncated: true, total: 421, first: "demo.echo" });
  });
});
