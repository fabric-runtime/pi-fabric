import { describe, expect, it, vi } from "vitest";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";
import { TypeScriptKernelRuntime } from "../src/runtime/typescript-kernel.js";
import { classifyPiBashError } from "../src/core/pi-bash-error.js";
import { transpileFabricCodeWithSourceMap } from "../src/runtime/type-checker.js";

const options = {
  timeoutMs: 5_000,
  memoryLimitBytes: 32 * 1024 * 1024,
};

describe("QuickJsRuntime", () => {
  it("copies only finite numeric opt-in guest fields onto a host error", async () => {
    const error = Object.assign(new Error("HTTP 429"), { secret: 1, guestFields: { status: 429, retryAfterMs: 1500, message: 7, stack: 1, note: "x", bad: Number.NaN, "x-y": 1 } });
    const result = await new QuickJsRuntime().execute(
      "try { await tools.call({ ref: 'fixture.fail' }); } catch (error) { const e = error as Record<string, unknown>; return [e.message, e.status, e.retryAfterMs, e.note, e.bad, e.secret, e['x-y']]; } return null;",
      async () => { throw error; },
      options,
    );

    expect(result.terminationReason, result.error).toBe("completed");
    expect(result.value).toEqual(["HTTP 429", 429, 1500, null, null, null, null]);
  });
  it("rejects memory limits that overflow the WASM32 size_t", async () => {
    const result = await new QuickJsRuntime().execute(
      "return 1;",
      async () => undefined,
      { ...options, memoryLimitBytes: 4 * 1024 ** 3 },
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("WASM32 maximum");
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -5])("rejects non-positive timeout %s like the Python kernels", async (timeoutMs) => {
    const result = await new QuickJsRuntime().execute(
      "return 1;",
      async () => undefined,
      { ...options, timeoutMs },
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toBe("QuickJS timeout must be positive");
  });

  it("rejects negative log limits like the Monty kernel", async () => {
    const result = await new QuickJsRuntime().execute(
      "return 1;",
      async () => undefined,
      { ...options, maxLogChars: -10 },
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toBe("QuickJS log limit must be a nonnegative safe integer");
  });


  it("runs parallel host calls and returns structured data", async () => {
    const hostCall = vi.fn(async (ref: string, args: Record<string, unknown>) => ({
      ref,
      value: args.value,
    }));
    const result = await new QuickJsRuntime().execute(
      `
const values = await Promise.all([
  tools.call({ ref: "demo.echo", args: { value: 1 } }),
  tools.call({ ref: "demo.echo", args: { value: 2 } }),
]);
print("calls", values.length);
return values;
`,
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.logs).toEqual(["calls 2"]);
    expect(result.value).toEqual([
      { ref: "fabric.$call", value: undefined },
      { ref: "fabric.$call", value: undefined },
    ]);
    expect(hostCall.mock.calls[0]?.[1]).toEqual({ ref: "demo.echo", args: { value: 1 } });
    expect(hostCall).toHaveBeenCalledTimes(2);
  });

  it("runs phased workflow fan-out and returns only worker values", async () => {
    const calls: string[] = [];
    const result = await new QuickJsRuntime().execute(
      `
await phase("Inspect");
const values = await parallel([
  () => agent("first", { label: "one" }),
  () => agent("second", { label: "two" }),
]);
return { values, spent: budget.spent() };
`,
      async (ref, args) => {
        if (ref === "fabric.$spanStart" || ref === "fabric.$spanEnd") return undefined;
        calls.push(ref);
        if (ref === "fabric.$phase") return { name: args.name, index: 0 };
        if (ref === "agents.run") {
          return {
            status: "completed",
            text: String(args.task).toUpperCase(),
            usage: { input: 2, output: 3 },
          };
        }
        throw new Error(`Unexpected call: ${ref}`);
      },
      { ...options, tokenBudget: 20 },
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ values: ["FIRST", "SECOND"], spent: 10 });
    expect(calls).toEqual(["fabric.$phase", "agents.run", "agents.run"]);
  });

  it("includes the workflow label and child cause in agent failures", async () => {
    const result = await new QuickJsRuntime().execute(
      'return agent("review", { label: "dashboard reviewer" });',
      async (ref) => {
        if (ref === "agents.run") {
          return {
            status: "failed",
            error: "openai-codex/gpt-test: fetch failed · WebSocket error",
            usage: { input: 0, output: 0 },
          };
        }
        throw new Error(`Unexpected call: ${ref}`);
      },
      options,
    );
    expect(result.error).toContain(
      "dashboard reviewer failed: openai-codex/gpt-test: fetch failed · WebSocket error",
    );
  });

  it("runs parallel(items, mapper, concurrency) fan-out", async () => {
    const calls: string[] = [];
    const result = await new QuickJsRuntime().execute(
      `
const items = [{ q: "first" }, { q: "second" }, { q: "third" }];
const out = await parallel(items, (item) => agent(item.q, { label: item.q }), 2);
return out;
`,
      async (ref, args) => {
        if (ref === "fabric.$spanStart" || ref === "fabric.$spanEnd") return undefined;
        if (ref === "agents.run") {
          calls.push(String(args.task));
          return { status: "completed", text: String(args.task).toUpperCase(), usage: { input: 1, output: 1 } };
        }
        throw new Error(`Unexpected call: ${ref}`);
      },
      { ...options, tokenBudget: 30 },
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(["FIRST", "SECOND", "THIRD"]);
    expect(calls.sort()).toEqual(["first", "second", "third"]);
  });

  it("emits deterministic internal workflow span start/end calls from guest combinators", async () => {
    const calls: Array<{ ref: string; args: Record<string, unknown> }> = [];
    const result = await new QuickJsRuntime().execute(
      `
await workflow.parallel([], { concurrency: 9 });
await workflow.pipeline([1], (value) => value);
return {
  globalBridge: typeof globalThis.__fabricHostCall,
  lexicalBridge: typeof __fabricBridge,
  internalCall: typeof __call,
};
`,
      async (ref, args) => {
        calls.push({ ref, args });
        return undefined;
      },
      options,
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      globalBridge: "undefined",
      lexicalBridge: "undefined",
      internalCall: "undefined",
    });
    expect(calls).toEqual([
      { ref: "fabric.$spanStart", args: { id: "span-0", kind: "parallel", itemCount: 0, concurrency: 0 } },
      { ref: "fabric.$spanEnd", args: { id: "span-0", outcome: "succeeded" } },
      { ref: "fabric.$spanStart", args: { id: "span-1", kind: "pipeline", itemCount: 1, stageCount: 1 } },
      { ref: "fabric.$spanStart", args: { id: "span-2", kind: "parallel", itemCount: 1, concurrency: 1 } },
      { ref: "fabric.$spanEnd", args: { id: "span-2", outcome: "succeeded" } },
      { ref: "fabric.$spanEnd", args: { id: "span-1", outcome: "succeeded" } },
    ]);
  });

  it("calls captured extension tools through the lazy proxy", async () => {
    const result = await new QuickJsRuntime().execute(
      'return extensions.deploy_release({ environment: "staging" });',
      async (ref, args) => {
        expect(ref).toBe("extensions.deploy_release");
        expect(args).toEqual({ environment: "staging" });
        return { text: "deployed", content: [], isError: false };
      },
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({ text: "deployed", isError: false });
  });

  it("normalizes the string shorthand for tools.search", async () => {
    const result = await new QuickJsRuntime().execute(
      'return tools.search("fovea");',
      async (ref, args) => {
        expect(ref).toBe("fabric.$search");
        expect(args).toEqual({ query: "fovea" });
        return [{ ref: "extensions.fovea_focus" }];
      },
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual([{ ref: "extensions.fovea_focus" }]);
  });

  it("routes stable Fabric providers through first-class proxies", async () => {
    const calls: Array<{ ref: string; args: Record<string, unknown> }> = [];
    const result = await new QuickJsRuntime().execute(
      `
return Promise.all([
  memory.recall({ query: "needle" }),
  state.history({ limit: 2 }),
  schema.status(),
  compact.request({ reason: "context pressure" }),
]);
`,
      async (ref, args) => {
        calls.push({ ref, args });
        return { ref };
      },
      options,
    );

    expect(result.error).toBeUndefined();
    expect(calls).toEqual([
      { ref: "memory.recall", args: { query: "needle" } },
      { ref: "state.history", args: { limit: 2 } },
      { ref: "schema.status", args: {} },
      { ref: "compact.request", args: { reason: "context pressure" } },
    ]);
  });


  it("walks normalized memory in guest code with chunk reassembly and early stop", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await new QuickJsRuntime().execute(
      `
const entries = [];
const walk = await memory.walk(
  { session: "session", branches: "all", maxChars: 3 },
  async (entry, index) => {
    const current = await state.get();
    entries.push({
      stateHead: current.head,
      index: entry.index,
      visitorIndex: index,
      parentId: entry.parentId,
      tool: entry.tool,
      text: entry.text,
      textRange: entry.textRange,
    });
    return index === 0;
  },
);
return { entries, walk };
`,
      async (ref, args) => {
        if (ref === "state.get") return { head: "nested" };
        expect(ref).toBe("memory.expand");
        calls.push(args);
        if (calls.length === 1) {
          return {
            session: "/tmp/session.jsonl",
            sourceHash: "source-1",
            lineageFingerprint: "lineage-1",
            branches: "all",
            entryCount: 3,
            entries: [],
            next: null,
          };
        }
        if (calls.length === 2) {
          expect(args).toEqual(expect.objectContaining({
            session: "/tmp/session.jsonl",
            expectedSourceHash: "source-1",
            expectedLineageFingerprint: "lineage-1",
            entryRange: { first: 0, last: 2 },
          }));
          return {
            entries: [{
              index: 0,
              entryId: "e0",
              parentId: null,
              type: "message",
              role: "assistant",
              timestamp: 1,
              isError: false,
              tool: "read",
              text: "hel",
              textRange: { start: 0, end: 3, total: 5, complete: false },
            }],
            next: {
              ref: "memory.expand",
              args: {
                session: "/tmp/session.jsonl",
                expectedSourceHash: "source-1",
                expectedLineageFingerprint: "lineage-1",
                branches: "all",
                entryRange: { first: 0, last: 2 },
                entryOffset: 0,
                textOffset: 3,
              },
            },
          };
        }
        if (calls.length === 3) {
          return {
            entries: [
              {
                index: 0,
                entryId: "e0",
                parentId: null,
                type: "message",
                role: "assistant",
                timestamp: 1,
                isError: false,
                tool: "read",
                text: "lo",
                textRange: { start: 3, end: 5, total: 5, complete: true },
              },
              {
                index: 1,
                entryId: "e1",
                parentId: "e0",
                type: "message",
                role: "toolResult",
                timestamp: 2,
                isError: false,
                tool: "read",
                text: "world",
                textRange: { start: 0, end: 5, total: 5, complete: true },
              },
            ],
            next: {
              ref: "memory.expand",
              args: { session: "/tmp/session.jsonl", entryRange: { first: 0, last: 2 }, entryOffset: 2 },
            },
          };
        }
        throw new Error("memory.walk ignored early termination");
      },
      options,
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      entries: [
        {
          stateHead: "nested",
          index: 0,
          visitorIndex: 0,
          parentId: null,
          tool: "read",
          text: "hello",
          textRange: { start: 0, end: 5, total: 5, complete: true },
        },
        {
          stateHead: "nested",
          index: 1,
          visitorIndex: 1,
          parentId: "e0",
          tool: "read",
          text: "world",
          textRange: { start: 0, end: 5, total: 5, complete: true },
        },
      ],
      walk: { visited: 2, stopped: true },
    });
    expect(calls).toHaveLength(3);
  });

  it("rejects a partial-entry memory.walk start", async () => {
    const result = await new QuickJsRuntime().execute(
      'return memory.walk({ session: "session", indices: [1], textOffset: 2 }, () => {});',
      async () => { throw new Error("host call should not run"); },
      options,
    );
    expect(result.error).toContain("must start at text offset 0");
  });

  it("routes JavaScript-safe MCP aliases through the direct MCP proxy", async () => {
    const result = await new QuickJsRuntime().execute(
      'return mcp.fal_ai.get_model_schema({ endpoint_id: "openai/gpt-image-2" });',
      async (ref, args) => ({ ref, args }),
      options,
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      ref: "mcp.fal_ai.get_model_schema",
      args: { endpoint_id: "openai/gpt-image-2" },
    });
  });

  it("exposes durable mesh operations through the host bridge", async () => {
    const result = await new QuickJsRuntime().execute(
      `
const self = await mesh.self();
await mesh.publish({ topic: "team.auth", text: "ready" });
return self.name;
`,
      async (ref) => {
        if (ref === "mesh.self") return { id: "actor-1", name: "reviewer", kind: "actor" };
        if (ref === "mesh.publish") return { sequence: 1 };
        throw new Error(`Unexpected call: ${ref}`);
      },
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toBe("reviewer");
  });

  it("does not expose Node globals", async () => {
    const result = await new QuickJsRuntime().execute(
      "return { process: typeof process, require: typeof require };",
      async () => undefined,
      options,
    );
    expect(result.value).toEqual({ process: "undefined", require: "undefined" });
  });

  it("waits for host calls without spinning the Node event loop", async () => {
    const immediate = vi.spyOn(globalThis, "setImmediate");
    try {
      const result = await new QuickJsRuntime().execute(
        'return tools.call({ ref: "demo.wait" });',
        async () => new Promise((resolve) => setTimeout(() => resolve("done"), 40)),
        options,
      );
      expect(result.value).toBe("done");
      expect(immediate).not.toHaveBeenCalled();
    } finally {
      immediate.mockRestore();
    }
  });

  it("resumes guest timers through event-driven job pumping", async () => {
    const result = await new QuickJsRuntime().execute(
      'return new Promise((resolve) => setTimeout(() => resolve("timer done"), 20));',
      async () => undefined,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toBe("timer done");
  });

  it("times out unresolved guest promises", async () => {
    const startedAt = Date.now();
    const result = await new QuickJsRuntime().execute(
      "await new Promise(() => {});",
      async () => undefined,
      { ...options, timeoutMs: 50 },
    );
    expect(result.error).toContain("timed out");
    expect(result.terminationReason).toBe("timed_out");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("classifies timeout and abort words in thrown runtime errors as runtime failures", async () => {
    for (const message of ["business timeout was rejected", "operation was aborted upstream"]) {
      const result = await new QuickJsRuntime().execute(
        `throw new Error(${JSON.stringify(message)});`,
        async () => undefined,
        options,
      );
      expect(result.error).toContain(message);
      expect(result.terminationReason).toBe("runtime_error");
    }
  });

  it("returns a typed aborted termination for an external signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const result = await new QuickJsRuntime().execute(
      "return 1;",
      async () => undefined,
      { ...options, signal: controller.signal },
    );
    expect(result.terminationReason).toBe("aborted");
  });

  it("extends the active deadline before a blocking host call runs", async () => {
    const result = await new QuickJsRuntime().execute(
      `
const ref = ["agents", "run"].join(".");
return tools.call({ ref, args: { task: "slow" } });
`,
      async () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ status: "completed", text: "ok" }), 150);
        }),
      {
        ...options,
        timeoutMs: 50,
        minimumTimeoutMsForHostCall(ref, args) {
          return ref === "fabric.$call" && args.ref === "agents.run" ? 1_000 : undefined;
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({ status: "completed", text: "ok" });
  });

  it("extends a late blocking host call from the call start", async () => {
    const result = await new QuickJsRuntime().execute(
      `
await tools.call({ ref: "demo.delay" });
return tools.call({ ref: "agents.run", args: { task: "late" } });
`,
      async () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ status: "completed" }), 70);
        }),
      {
        ...options,
        timeoutMs: 100,
        minimumTimeoutMsForHostCall(ref) {
          return ref === "fabric.$call" ? 100 : undefined;
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({ status: "completed" });
  });

  it("aborts sibling host calls when guest workflow code fails", async () => {
    let hostCallAborted = false;
    const result = await new QuickJsRuntime().execute(
      `
await Promise.all([
  tools.call({ ref: "demo.wait" }),
  Promise.reject(new Error("branch failed")),
]);
`,
      async (_ref, _args, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              hostCallAborted = true;
              reject(new Error("host call aborted"));
            },
            { once: true },
          );
        }),
      options,
    );
    expect(result.error).toContain("branch failed");
    expect(hostCallAborted).toBe(true);
  });

  it("does not wait for a non-cooperative sibling host call after guest failure", async () => {
    const startedAt = Date.now();
    const result = await new QuickJsRuntime().execute(
      `
await Promise.all([
  tools.call({ ref: "demo.never" }),
  Promise.reject(new Error("branch failed")),
]);
`,
      async () => new Promise(() => undefined),
      options,
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("branch failed");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("bounds non-cooperative fire-and-forget host calls", async () => {
    const startedAt = Date.now();
    const result = await new QuickJsRuntime().execute(
      'void tools.call({ ref: "demo.never" }); return "done";',
      async () => new Promise(() => undefined),
      options,
    );

    expect(result.terminationReason).toBe("completed");
    expect(result.value).toBe("done");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("aborts in-flight host calls when the sandbox deadline expires", async () => {
    let hostCallAborted = false;
    const result = await new QuickJsRuntime().execute(
      'await tools.call({ ref: "demo.wait" });',
      async (_ref, _args, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              hostCallAborted = true;
              reject(new Error("host call aborted"));
            },
            { once: true },
          );
        }),
      { ...options, timeoutMs: 50 },
    );
    expect(result.error).toContain("timed out");
    expect(hostCallAborted).toBe(true);
  });

  it("interrupts synchronous infinite loops", async () => {
    const result = await new QuickJsRuntime().execute("while (true) {}", async () => undefined, {
      ...options,
      timeoutMs: 50,
    });
    expect(result.error).toContain("Execution timed out after 50ms");
  });

  it("surfaces unbounded recursion as a guest runtime error, not a WASM abort", async () => {
    const result = await new QuickJsRuntime().execute(
      "function f() { return f() + 1; } f();",
      async () => undefined,
      options,
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("stack overflow");
  });

  it("makes stack overflow errors catchable inside the guest", async () => {
    const result = await new QuickJsRuntime().execute(
      "let depth = 0; function f() { depth += 1; return f() + 1; } try { f(); } catch (error) { return { depth, name: error.name }; }",
      async () => undefined,
      options,
    );

    expect(result.terminationReason).toBe("completed");
    const value = result.value as { depth: number; name: string };
    expect(value.name).toBe("InternalError");
    expect(value.depth).toBeGreaterThan(0);
  });

  it("keeps executing programs after a guest stack overflow", async () => {
    const runtime = new QuickJsRuntime();
    await runtime.execute("function f() { return f() + 1; } f();", async () => undefined, options);

    const result = await runtime.execute("return 1 + 1;", async () => undefined, options);

    expect(result.terminationReason).toBe("completed");
    expect(result.value).toBe(2);
  });

  it("exposes named strings via π and throws a clear error for unprovided keys", async () => {
    const content = [
      "multiline",
      "` ${value} { braces }",
      "quotes: \" '",
      "nul:" + String.fromCharCode(0) + " end",
    ].join("\n");
    const provided = await new QuickJsRuntime().execute(
      `return { value: π.content, keys: Object.keys(π).join(",") };`,
      async () => undefined,
      { ...options, strings: { content } },
    );
    expect(provided.error).toBeUndefined();
    expect(provided.value).toEqual({ value: content, keys: "content" });

    const failed = await new QuickJsRuntime().execute(
      `return π.previewFile;`,
      async () => undefined,
      { ...options, strings: { content: "hello" } },
    );
    expect(failed.error).toContain("Pre-execution check: π.previewFile is referenced");
    expect(failed.error).toContain("(provided: content)");

    const dynamic = await new QuickJsRuntime().execute(
      `const k = "previewFile"; return π[k];`,
      async () => undefined,
      { ...options, strings: { content: "hello" } },
    );
    expect(dynamic.error).toContain("π.previewFile is not defined");
    expect(dynamic.error).toContain("provided: content");
  });

  it("rejects π references to missing strings keys before execution (#68)", async () => {
    const failed = await new QuickJsRuntime().execute(
      'await pi.write({ path: "x.md", text: π.body });',
      async () => {
        throw new Error("host call must not run");
      },
      { ...options, strings: { other: "hello" } },
    );
    expect(failed.terminationReason).toBe("runtime_error");
    expect(failed.error).toContain("Pre-execution check: π.body is referenced");
    expect(failed.error).toContain("(provided: other)");
    expect(failed.error).toContain("Add payloads: { body: '...' }");

    const none = await new QuickJsRuntime().execute(
      'return π.summary;',
      async () => {
        throw new Error("host call must not run");
      },
      { ...options },
    );
    expect(none.error).toContain("(none provided)");

    const multiple = await new QuickJsRuntime().execute(
      'const a = π.alpha; const b = π.alpha; const c = π.beta;',
      async () => undefined,
      { ...options, strings: {} },
    );
    expect(multiple.error).toContain("π.alpha, π.beta are referenced");

    const provided = await new QuickJsRuntime().execute(
      'await pi.write({ path: "x.md", text: π.body }); return "ok";',
      async () => undefined,
      { ...options, strings: { body: "content" } },
    );
    expect(provided.terminationReason).toBe("completed");
  });

  it("reuses static payload keys from a type-checked program without weakening preflight", async () => {
    const runtime = new TypeScriptKernelRuntime("quickjs");
    const { code, checked } = runtime.prepare(String.raw`
      // π.inComment is not an access.
      const example: string = "π.inString";
      return await pi.read({ path: \u03c0.file }) + π.file + example;
    `, true, [], {}, [], true);
    expect(checked.errors).toEqual([]);
    expect(checked.payloadKeys).toEqual(["file"]);
    const compiled = {
      ...options,
      ...(checked.javascript ? { transpiledCode: checked.javascript } : {}),
      ...(checked.sourceMap ? { transpiledSourceMap: checked.sourceMap } : {}),
      ...(checked.payloadKeys ? { payloadKeys: checked.payloadKeys } : {}),
    };
    const host = vi.fn(async () => "result");
    const denied = await runtime.execute(code, host, compiled);
    expect(denied.error).toContain("Pre-execution check: π.file is referenced");
    expect(host).not.toHaveBeenCalled();
    const accepted = await runtime.execute(code, host, { ...compiled, strings: { file: "sample" } });
    expect(accepted.terminationReason).toBe("completed");
    expect(accepted.value).toBe("resultsampleπ.inString");
    expect(host.mock.calls).toHaveLength(1);
  });

  it("ignores π examples inside strings and comments during payload preflight", async () => {
    const code = [
      'const example = "use π.task only with a matching payload";',
      "// π.commentExample is documentation, not an access",
      "return example;",
    ].join("\n");
    const result = await new QuickJsRuntime().execute(
      code,
      async () => undefined,
      { ...options, strings: { contract: "content" } },
    );

    expect(result.terminationReason).toBe("completed");
    expect(result.error).toBeUndefined();
  });

  it("does not flag bracket access or bare π on dynamic keys", async () => {
    const result = await new QuickJsRuntime().execute(
      'const key = "k"; return Object.keys(π).length + (π[key] === undefined ? 0 : 1);',
      async () => undefined,
      { ...options, strings: { k: "v" } },
    );
    expect(result.terminationReason).toBe("completed");
  });

  it("bridges tools.models() to the fabric.$models host call", async () => {
    const result = await new QuickJsRuntime().execute(
      `const models = await tools.models(); return models;`,
      async (ref) => {
        if (ref === "fabric.$models") {
          return [
            { provider: "litellm", id: "glm-5.2", name: "GLM 5.2", key: "litellm/glm-5.2" },
          ];
        }
        throw new Error(`Unexpected call: ${ref}`);
      },
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual([
      { provider: "litellm", id: "glm-5.2", name: "GLM 5.2", key: "litellm/glm-5.2" },
    ]);
  });

  it("bridges agents.models() to the runner-aware provider action", async () => {
    let request: Record<string, unknown> | undefined;
    const result = await new QuickJsRuntime().execute(
      `return agents.models({ runner: "claude", refresh: true });`,
      async (ref, args) => {
        if (ref === "agents.models") {
          request = args;
          return [{ runner: "claude", provider: "claude", id: "haiku", name: "Haiku", key: "claude/haiku" }];
        }
        throw new Error(`Unexpected call: ${ref}`);
      },
      options,
    );
    expect(result.error).toBeUndefined();
    expect(request).toEqual({ runner: "claude", refresh: true });
    expect(result.value).toEqual([
      { runner: "claude", provider: "claude", id: "haiku", name: "Haiku", key: "claude/haiku" },
    ]);
  });

  it("forwards cwd and recursion through workflow and council helpers", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const result = await new QuickJsRuntime().execute(
      `
await workflow.agent("workflow task", { cwd: "workflow-target", recursive: true, worktree: true });
await council.run({ task: "council task", roles: ["reviewer"], synthesize: false, cwd: "council-target" });
return "done";
`,
      async (ref, args) => {
        if (ref === "agents.run") {
          requests.push(args);
          return { status: "completed", text: "done", usage: { input: 1, output: 1 } };
        }
        throw new Error(`Unexpected call: ${ref}`);
      },
      { ...options, tokenBudget: 100 },
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toBe("done");
    expect(requests).toEqual([
      expect.objectContaining({ task: "workflow task", cwd: "workflow-target", recursive: true, worktree: true }),
      expect.objectContaining({ task: expect.stringContaining("council task"), cwd: "council-target" }),
    ]);
  });

  it("counts council.run role usage toward budget.spent()", async () => {
    const result = await new QuickJsRuntime().execute(
      `await council.run({ task: "review", roles: ["a", "b"], synthesize: false }); return budget.spent();`,
      async (ref, args) => {
        if (ref === "agents.run") {
          return { status: "completed", text: String(args.name), usage: { input: 10, output: 5 } };
        }
        throw new Error(`Unexpected call: ${ref}`);
      },
      { ...options, tokenBudget: 100 },
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(30);
  });

  it("forwards a dynamic rlm cwd to the recursive host request", async () => {
    let request: Record<string, unknown> | undefined;
    const result = await new QuickJsRuntime().execute(
      `return rlm.query({ task: "map", cwd: "target", worktree: true });`,
      async (ref, args) => {
        if (ref === "agents.run") {
          request = args;
          return { status: "completed", text: "recursive target", usage: { input: 1, output: 1 } };
        }
        throw new Error(`Unexpected call: ${ref}`);
      },
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({ status: "completed", text: "recursive target" });
    expect(request).toMatchObject({ task: "map", cwd: "target", worktree: true, runner: "pi-durable", recursive: true });
  });

  it("counts rlm.query usage and defaults to the durable Pi runner", async () => {
    let request: Record<string, unknown> | undefined;
    const result = await new QuickJsRuntime().execute(
      `await rlm.query({ task: "map" }); return budget.spent();`,
      async (ref, args) => {
        if (ref === "agents.run") {
          request = args;
          return { status: "completed", text: "done", usage: { input: 7, output: 3 } };
        }
        throw new Error(`Unexpected call: ${ref}`);
      },
      { ...options, tokenBudget: 100 },
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(10);
    expect(request).toMatchObject({ task: "map", runner: "pi-durable", recursive: true });
  });

  it("keeps explicit legacy Pi selection and rejects non-recursive runners for RLM", async () => {
    const calls: Record<string, unknown>[] = [];
    const result = await new QuickJsRuntime().execute(
      `await rlm.query({ task: "map", runner: "pi" }); try { await rlm.query({ task: "map", runner: "claude" }); } catch (error) { return error.message; }`,
      async (_ref, args) => { calls.push(args); return { status: "completed", text: "done" }; }, options,
    );
    expect(result.value).toContain("requires a Pi runner");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ runner: "pi", recursive: true });
  });

  it("preempts the council synthesizer when roles exhaust the token budget", async () => {
    const calls: string[] = [];
    const result = await new QuickJsRuntime().execute(
      `await council.run({ task: "review", roles: ["a", "b"] }); return "done";`,
      async (ref, args) => {
        if (ref === "agents.run") {
          calls.push(String(args.name));
          return { status: "completed", text: "x", usage: { input: 100, output: 50 } };
        }
        throw new Error(`Unexpected call: ${ref}`);
      },
      { ...options, tokenBudget: 20 },
    );
    expect(result.error).toContain("token budget exhausted");
    expect(calls).toEqual(["a", "b"]);
  });


  it("gates handoff with a pure predicate over successful call facts", async () => {
    const calls: Array<{ ref: string; args: Record<string, unknown> }> = [];
    const result = await new QuickJsRuntime().execute(
      `
await pi.edit({ path: "src/guard.ts", old: "false", new: "true" });
return agents.handoff({
  model: "anthropic/executor",
  task: "Finish and verify the guard",
  when: ({ count, calls }) =>
    count("pi.edit") === 1 && calls[0]?.ref === "pi.edit",
});
`,
      async (ref, args) => {
        calls.push({ ref, args });
        if (ref === "pi.edit") return { ok: true };
        if (ref === "agents.handoff") {
          return {
            scheduled: true,
            status: "deferred",
            boundary: "fabric_exec_end",
          };
        }
        throw new Error(`Unexpected call: ${ref}`);
      },
      options,
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      scheduled: true,
      status: "deferred",
      boundary: "fabric_exec_end",
    });
    expect(calls.map((call) => call.ref)).toEqual(["pi.edit", "agents.handoff"]);
    expect(calls[1]?.args).toEqual({
      model: "anthropic/executor",
      task: "Finish and verify the guard",
    });
  });

  it("counts successful calls across Pi, extensions, MCP, and computed providers", async () => {
    const calls: string[] = [];
    const result = await new QuickJsRuntime().execute(
      `
await pi.read({ path: "a.txt" });
await extensions.format({ path: "a.txt" });
await mcp.docs.lookup({ query: "handoff" });
await tools.call({ ref: "external.inspect", args: { id: "a" } });
return agents.handoff({
  model: "anthropic/executor",
  when: ({ count, calls }) =>
    count() === 4 &&
    count(["pi.read", "extensions.format", "mcp.docs.lookup", "external.inspect"]) === 4 &&
    calls.map((call) => call.ref).join(",") ===
      "pi.read,extensions.format,mcp.docs.lookup,external.inspect",
});
`,
      async (ref) => {
        calls.push(ref);
        if (ref === "agents.handoff") {
          return { scheduled: true, status: "deferred", boundary: "fabric_exec_end" };
        }
        return { ok: true };
      },
      options,
    );

    expect(result.error).toBeUndefined();
    expect(calls).toEqual([
      "pi.read",
      "extensions.format",
      "mcp.docs.lookup",
      "fabric.$call",
      "agents.handoff",
    ]);
  });

  it("does not call the host when the handoff predicate returns false", async () => {
    const calls: string[] = [];
    const result = await new QuickJsRuntime().execute(
      `return agents.handoff({
  model: "anthropic/executor",
  when: ({ count }) => count("pi.edit") > 0,
});`,
      async (ref) => {
        calls.push(ref);
        return undefined;
      },
      options,
    );

    expect(result.error).toContain("predicate returned false");
    expect(calls).toEqual([]);
  });

  it("does not count failed mutation calls in handoff facts", async () => {
    const result = await new QuickJsRuntime().execute(
      `
try { await pi.edit({ path: "missing.ts", old: "a", new: "b" }); } catch {}
return agents.handoff({
  model: "anthropic/executor",
  when: ({ count }) => count("pi.edit") === 1,
});
`,
      async (ref) => {
        if (ref === "pi.edit") throw new Error("edit failed");
        throw new Error("handoff should not run");
      },
      options,
    );

    expect(result.error).toContain("predicate returned false");
  });

  it("rejects asynchronous handoff predicates", async () => {
    const result = await new QuickJsRuntime().execute(
      `return agents.handoff({
  model: "anthropic/executor",
  when: async () => true,
});`,
      async () => undefined,
      options,
    );

    expect(result.error).toContain("must return a boolean synchronously");
  });

  it("keeps immediate boundary scheduling available without a predicate", async () => {
    let args: Record<string, unknown> | undefined;
    const result = await new QuickJsRuntime().execute(
      'return agents.handoff({ model: "anthropic/executor", task: "Continue" });',
      async (ref, value) => {
        if (ref !== "agents.handoff") throw new Error(`Unexpected call: ${ref}`);
        args = value;
        return {
          scheduled: true,
          status: "deferred",
          boundary: "fabric_exec_end",
        };
      },
      options,
    );

    expect(result.error).toBeUndefined();
    expect(args).toEqual({ model: "anthropic/executor", task: "Continue" });
  });

  it("routes agents.main and Main steering through the agents provider", async () => {
    const calls: string[] = [];
    const result = await new QuickJsRuntime().execute(
      `
const main = await agents.main();
const queued = await agents.steer({ id: main.id, message: "focus" });
return { main, queued };
`,
      async (ref) => {
        calls.push(ref);
        if (ref === "agents.main") {
          return { id: "session:root", name: "Main", kind: "main", status: "idle" };
        }
        if (ref === "agents.steer") {
          return { queued: true, messageId: "m1", routed: "main" };
        }
        throw new Error(`Unexpected call: ${ref}`);
      },
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      main: { id: "session:root", name: "Main" },
      queued: { queued: true, routed: "main" },
    });
    expect(calls).toEqual(["agents.main", "agents.steer"]);
  });

  it("routes unified participant discovery through the agents provider", async () => {
    const calls: Array<{ ref: string; args: Record<string, unknown> }> = [];
    const result = await new QuickJsRuntime().execute(
      `
const self = await agents.self();
const members = await agents.members({ scope: "project", kinds: ["agent"] });
const lineage = await agents.list({ scope: "lineage" });
return { self, members, lineage };
`,
      async (ref, args) => {
        calls.push({ ref, args });
        if (ref === "agents.self") return { id: "agent:self", kind: "agent" };
        if (ref === "agents.members") return [{ id: "agent:peer", kind: "agent" }];
        if (ref === "agents.list") return [{ id: "agent:self", kind: "agent" }];
        throw new Error(`Unexpected call: ${ref}`);
      },
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      self: { id: "agent:self" },
      members: [{ id: "agent:peer" }],
      lineage: [{ id: "agent:self" }],
    });
    expect(calls).toEqual([
      { ref: "agents.self", args: {} },
      { ref: "agents.members", args: { scope: "project", kinds: ["agent"] } },
      { ref: "agents.list", args: { scope: "lineage" } },
    ]);
  });

  it("routes lifecycle subscriptions through the direct agents API", async () => {
    const calls: Array<{ ref: string; args: Record<string, unknown> }> = [];
    const result = await new QuickJsRuntime().execute(
      `
const created = await agents.subscribe({
  from: "session:peer",
  events: ["pi.agent_settled"],
  delivery: "followUp",
  triggerTurn: true,
  once: true,
});
const listed = await agents.subscriptions({ from: "session:peer" });
const removed = await agents.unsubscribe({ id: created.id });
return { created, listed, removed };
`,
      async (ref, args) => {
        calls.push({ ref, args });
        if (ref === "agents.subscribe") return { id: "subscription-1", ...args };
        if (ref === "agents.subscriptions") return [{ id: "subscription-1" }];
        if (ref === "agents.unsubscribe") return { removed: true };
        throw new Error(`Unexpected call: ${ref}`);
      },
      options,
    );

    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      created: { id: "subscription-1" },
      listed: [{ id: "subscription-1" }],
      removed: { removed: true },
    });
    expect(calls.map((call) => call.ref)).toEqual([
      "agents.subscribe",
      "agents.subscriptions",
      "agents.unsubscribe",
    ]);
  });

  it("routes agents.setEvents and agents.setInstructions to the actors provider", async () => {
    const calls: string[] = [];
    const result = await new QuickJsRuntime().execute(
      `
await agents.setEvents({ id: "a1", events: ["turn_end"] });
await agents.setInstructions({ id: "a1", instructions: "Be brief." });
return { done: true };
`,
      async (ref, args) => {
        calls.push(ref);
        if (ref === "agents.setEvents") return { id: args.id, status: "idle", name: "x" };
        if (ref === "agents.setInstructions") return { id: args.id, status: "idle", name: "x" };
        throw new Error(`Unexpected call: ${ref}`);
      },
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ done: true });
    expect(calls).toEqual(["agents.setEvents", "agents.setInstructions"]);
  });
});

describe("pi proxy silent repairs and envelope guard", () => {
  it("normalizes alias keys and numeric strings before the host call", async () => {
    const hostCall = vi.fn(async (ref: string, _args?: Record<string, unknown>) =>
      ref === "pi.bash" || ref === "pi.write" || ref === "pi.edit"
        ? { ok: true, output: "", details: null }
        : "",
    );
    const result = await new QuickJsRuntime().execute(
      `
await pi.find({ glob: "*.ts", path: "src", max: "50" });
await pi.find({ name: "a.ts" });
await pi.find({ filename: "b.ts" });
await pi.ls({ folder: "src" });
await pi.grep({ pattern: "x", limit: "20", ctx: "2" });
await pi.write({ path: "/tmp/x", data: "c" });
await pi.bash({ script: "ls src", timeout: "30" });
return "done";
`,
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toBe("done");
    const calls = hostCall.mock.calls.map(([ref, args]) => [ref, args]);
    expect(calls).toEqual([
      ["pi.find", { pattern: "*.ts", path: "src", limit: 50 }],
      ["pi.find", { pattern: "a.ts" }],
      ["pi.find", { pattern: "b.ts" }],
      ["pi.ls", { path: "src" }],
      ["pi.grep", { pattern: "x", limit: 20, context: 2 }],
      ["pi.write", { path: "/tmp/x", content: "c" }],
      ["pi.bash", { command: "ls src", timeout: 30 }],
    ]);
  });

  it("turns string-method access on an envelope into an actionable error", async () => {
    const hostCall = vi.fn(async () => ({ ok: true, output: "  hello  ", details: null }));
    const result = await new QuickJsRuntime().execute(
      `
const r = await pi.bash({ command: "echo hello" });
return r.trim();
`,
      hostCall,
      options,
    );
    expect(result.error).toContain("envelope");
    expect(result.error).toContain(".output");
    expect(result.error).toContain("pi.bash");
  });

  it("keeps ordinary envelope reads, destructuring, membership, and keys intact", async () => {
    const hostCall = vi.fn(async () => ({ ok: true, output: "  hello  ", details: null }));
    const result = await new QuickJsRuntime().execute(
      `
const r = await pi.bash({ command: "echo hello" });
const { ok, output } = r;
return {
  ok,
  text: output.trim(),
  hasOutput: "output" in r,
  keys: Object.keys(r).join(","),
  json: JSON.stringify({ wrapped: r }),
};
`,
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      ok: true,
      text: "hello",
      hasOutput: true,
      keys: "ok,output,details",
      json: '{"wrapped":{"ok":true,"output":"  hello  ","details":null}}',
    });
  });

  it("marshals an envelope returned as the program value", async () => {
    const hostCall = vi.fn(async () => ({ ok: true, output: "  hello  ", details: null }));
    const result = await new QuickJsRuntime().execute(
      `return await pi.bash({ command: "echo hello" });`,
      hostCall,
      options,
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ ok: true, output: "  hello  ", details: null });
  });

  it("throws an actionable error when iterating an envelope", async () => {
    const hostCall = vi.fn(async () => ({ ok: true, output: "a\nb", details: null }));
    const result = await new QuickJsRuntime().execute(
      `
const r = await pi.bash({ command: "x" });
for (const line of r) {
  void line;
}
return "never";
`,
      hostCall,
      options,
    );
    expect(result.error).toContain("not iterable");
    expect(result.error).toContain(".output");
  });

  it("guards settled bash envelopes and still exposes ok/exitCode/output reads", async () => {
    const hostCall = vi.fn(async () => {
      throw classifyPiBashError(new Error("sync-spawn\n\nCommand exited with code 3"));
    });
    const reads = await new QuickJsRuntime().execute(
      `
const r = await pi.bash({ command: "false", settle: true });
return { ok: r.ok, code: r.exitCode, text: r.output.trim() };
`,
      hostCall,
      options,
    );
    expect(reads.error).toBeUndefined();
    expect(reads.value).toEqual({ ok: false, code: 3, text: "sync-spawn" });

    const misuse = await new QuickJsRuntime().execute(
      `
const r = await pi.bash({ command: "false", settle: true });
return r.split("-");
`,
      hostCall,
      options,
    );
    expect(misuse.error).toContain("envelope");
    expect(misuse.error).toContain("settle");
  });

  it("does not guard objects returned by tools.call", async () => {
    const hostCall = vi.fn(async () => ({ ok: true, output: "a,b" }));
    const result = await new QuickJsRuntime().execute(
      `
const r = await tools.call({ ref: "demo.echo", args: {} });
return r.split(",");
`,
      hostCall,
      options,
    );
    expect(result.error).toBeDefined();
    expect(result.error).not.toContain("envelope");
  });
});

describe("QuickJsRuntime guest stack remapping", () => {
  const remapOptions = { timeoutMs: 5_000, memoryLimitBytes: 32 * 1024 * 1024 };

  it("remaps thrown error frames to user code lines", async () => {
    const result = await new QuickJsRuntime().execute(
      ["const before = 1;", "print(before);", 'throw new Error("boom");'].join("\n"),
      async () => undefined,
      remapOptions,
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("guest code:3:");
    expect(result.error).toContain("boom");
  });

  it("remaps native parse errors raised from user code", async () => {
    const result = await new QuickJsRuntime().execute(
      ['const payload = "    },";', "JSON.parse(payload);"].join("\n"),
      async () => undefined,
      remapOptions,
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("unexpected token");
    expect(result.error).toContain("guest code:2:");
    expect(result.error).toContain("at parse (native)");
  });

  it("remaps frames for pre-transpiled code when a source map is provided", async () => {
    const code = ["const a = 1;", 'throw new Error("pre");'].join("\n");
    const transpiled = transpileFabricCodeWithSourceMap(code);
    const result = await new QuickJsRuntime().execute(
      code,
      async () => undefined,
      {
        ...remapOptions,
        transpiledCode: transpiled.code,
        ...(transpiled.sourceMap ? { transpiledSourceMap: transpiled.sourceMap } : {}),
      },
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("guest code:2:");
  });

  it("keeps emitted frames when no source map accompanies pre-transpiled code", async () => {
    const transpiled = transpileFabricCodeWithSourceMap('throw new Error("pre");');
    const result = await new QuickJsRuntime().execute(
      'throw new Error("pre");',
      async () => undefined,
      { ...remapOptions, transpiledCode: transpiled.code },
    );

    expect(result.terminationReason).toBe("runtime_error");
    expect(result.error).toContain("pi-fabric-guest.js");
  });
});
