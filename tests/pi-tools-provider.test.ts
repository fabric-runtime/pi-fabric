import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createBashToolDefinition,
  createSyntheticSourceInfo,
  defineTool,
  type BashOperations,
  type ExtensionContext,
  type ExtensionRunner,
  type RegisteredTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FabricExecutionTraceRecorder } from "../src/audit/trace.js";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { FABRIC_BASH_MIDDLEWARE, type FabricBashMiddlewareV1 } from "../src/protocol.js";
import { CapturedToolsProvider } from "../src/providers/captured-tools-provider.js";
import { ActionRegistry, type FabricCallAudit } from "../src/core/action-registry.js";
import { NESTED_TOOL_CALL_ID_PREFIX } from "../src/core/action-registry.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";

const baseContext = {
  cwd: process.cwd(),
  signal: new AbortController().signal,
  parentToolCallId: "parent",
  nestedToolCallId: "fabric_test-nested",
  extensionContext: {
    cwd: process.cwd(),
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionFile: () => undefined,
    },
  } as unknown as ExtensionContext,
  update: vi.fn(),
  approve: vi.fn(async () => {}),
  audits: [],
  maxResultChars: 100_000,
};

const makeRunner = (overrides: Record<string, unknown> = {}): ExtensionRunner =>
  ({
    createContext: () => ({ cwd: process.cwd() }),
    getActiveTools: () => [],
    emit: vi.fn(async () => {}),
    emitToolCall: vi.fn(async () => undefined),
    emitToolResult: vi.fn(async () => undefined),
    ...overrides,
  }) as unknown as ExtensionRunner;

const registerWithRunner = (runner: ExtensionRunner, operations?: BashOperations) => {
  const catalog = new CapturedToolCatalog();
  const tools: RegisteredTool[] = operations ? [{
    definition: Object.assign(createBashToolDefinition(process.cwd()), {
      [FABRIC_BASH_MIDDLEWARE]: { version: 1, wrapOperations: () => operations } satisfies FabricBashMiddlewareV1,
    }),
    sourceInfo: { path: "/extensions/test-bash.ts", source: "test", scope: "user", origin: "package" },
  } as RegisteredTool] : [];
  catalog.replace(
    tools,
    runner,
    DEFAULT_FABRIC_CONFIG.capture,
    "/extensions/pi-fabric/index.ts",
  );
  const registry = new ActionRegistry();
  registry.register(new PiToolsProvider(process.cwd(), catalog, undefined));
  return registry;
};

describe("PiToolsProvider lifecycle", () => {
  it("fires the full tool-execution lifecycle for a pi core tool", async () => {
    const events: string[] = [];
    const runner = makeRunner({
      emit: vi.fn(async (event: { type: string }) => {
        events.push(event.type);
      }),
    });
    const registry = registerWithRunner(runner);

    await registry.invoke("pi.ls", { path: process.cwd() }, baseContext);

    expect(events).toEqual(["tool_execution_start", "tool_execution_end"]);
    expect(runner.emitToolCall).toHaveBeenCalledOnce();
    expect(runner.emitToolResult).toHaveBeenCalledOnce();
    const toolResult = (runner.emitToolResult as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { toolName: string; toolCallId: string; isError: boolean };
    expect(toolResult).toMatchObject({ toolName: "ls", isError: false });
    // ActionRegistry rewrites nestedToolCallId to fabric_<uuid>.
    expect(toolResult.toolCallId.startsWith(NESTED_TOOL_CALL_ID_PREFIX)).toBe(true);
  });

  it("marks a foreground TUI shell before and during streamed output, but not RPC", async () => {
    const operations: BashOperations = { exec: async (_command, _cwd, { onData }) => {
      onData(Buffer.from("streamed\n"));
      return { exitCode: 0 };
    } };
    const registry = registerWithRunner(makeRunner(), operations);
    for (const { mode, background } of [
      { mode: "tui", background: false },
      { mode: "rpc", background: false },
      { mode: "tui", background: true },
    ] as const) {
      const audits: FabricCallAudit[] = [];
      const previews: unknown[] = [];
      await registry.invoke("pi.bash", { command: "echo hello", ...(background ? { background: true } : {}) }, {
        ...baseContext, audits,
        update: () => previews.push(structuredClone(audits[0]?.preview)),
        extensionContext: { ...baseContext.extensionContext, mode } as ExtensionContext,
      });
      const marked = previews.filter((preview) =>
        (preview as { shellBackgroundShortcut?: boolean } | undefined)?.shellBackgroundShortcut === true);
      if (mode === "tui" && !background) {
        expect(marked).toContainEqual({ shellBackgroundShortcut: true });
        expect(marked).toContainEqual(expect.objectContaining({ result: "streamed" }));
      } else expect(marked).toHaveLength(0);
      expect(audits[0]?.success).toBe(true);
    }
  });

  it("names the calling tool call on every replayed event", async () => {
    const events: { type: string; toolCallId: string; parentToolCallId?: string }[] = [];
    const record = (result?: unknown) => vi.fn(async (event: (typeof events)[number]) => {
      events.push(event);
      return result;
    });
    const runner = makeRunner({ emit: record(), emitToolCall: record(), emitToolResult: record() });
    const operations: BashOperations = {
      exec: async (_command, _cwd, { onData }) => {
        onData(Buffer.from("streamed\n"));
        return { exitCode: 0 };
      },
    };

    await registerWithRunner(runner, operations).invoke("pi.bash", { command: "echo streamed" }, baseContext);

    expect(new Set(events.map(event => event.type))).toEqual(
      new Set(["tool_call", "tool_execution_start", "tool_execution_update", "tool_result", "tool_execution_end"]),
    );
    // Parallel fabric_exec calls are told apart by this id, not by which one is open.
    for (const event of events) {
      expect(event.parentToolCallId, event.type).toBe("parent");
      expect(event.toolCallId.startsWith(NESTED_TOOL_CALL_ID_PREFIX), event.type).toBe(true);
    }
  });

  it("stops waiting for a hanging lifecycle handler when the invocation is aborted", async () => {
    const controller = new AbortController();
    const runner = makeRunner({
      emitToolResult: vi.fn(async () => new Promise(() => undefined)),
    });
    const registry = registerWithRunner(runner);
    const invocation = registry.invoke(
      "pi.ls",
      { path: process.cwd() },
      { ...baseContext, signal: controller.signal },
    );

    await vi.waitFor(() => expect(runner.emitToolResult).toHaveBeenCalledOnce());
    controller.abort(new Error("cancel nested lifecycle"));

    await expect(invocation).rejects.toThrow("cancel nested lifecycle");
  });

  it("synchronizes tool_call argument mutations across audit surfaces", async () => {
    const runner = makeRunner({
      emitToolCall: vi.fn(async (event: { input: Record<string, unknown> }) => {
        event.input.command = `export EXAMPLE=true\n${String(event.input.command)}`;
      }),
    });
    // Test argument propagation, not the platform shell's initialization output.
    const exec = vi.fn<BashOperations["exec"]>(async (_command, _cwd, options) => {
      options.onData(Buffer.from("executed:true\n"));
      return { exitCode: 0 };
    });
    const registry = registerWithRunner(runner, { exec });
    const audits: FabricCallAudit[] = [];
    const events: unknown[] = [];
    const trace = new FabricExecutionTraceRecorder();

    const result = await registry.invoke(
      "pi.bash",
      { command: `printf "executed:$EXAMPLE\n"` },
      {
        ...baseContext,
        audits,
        trace,
        observeInvocation: (event) => events.push(event),
      },
    ) as { output: string };

    const executedCommand = `export EXAMPLE=true\nprintf "executed:$EXAMPLE\n"`;
    expect(result.output).toBe("executed:true\n");
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0]?.[0]).toContain(executedCommand);
    expect(audits[0]?.args).toEqual({ command: executedCommand });
    expect(audits[0]?.preview).toMatchObject({ bashCommand: executedCommand });
    expect(events).toContainEqual(expect.objectContaining({
      type: "call_args",
      args: { command: executedCommand },
    }));
    expect(trace.seal("succeeded", []).operations[0]?.args).toEqual({
      command: executedCommand,
    });
  });

  it("real bash nonzero-exit message matches the guest settle regex", async () => {
    const runner = makeRunner();
    const registry = registerWithRunner(runner);
    const error = await registry
      .invoke("pi.bash", { command: "exit 7" }, baseContext)
      .then(() => undefined, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // Mirrors the settle catch in src/runtime/quickjs-runtime.ts.
    const match = /(?:^|\n\n)Command exited with code (\d+)$/.exec(message);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(7);
  });

  it("applies a tool_result content patch to a core tool result", async () => {
    const runner = makeRunner({
      emitToolResult: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "[Image: a sample image, fully described.]" }],
      })),
    });
    const registry = registerWithRunner(runner);

    // A tool_result patch must flow through normalizeResult as the returned text.
    // Use a text file here because image decoding is covered by the media tests below.
    const result = await registry.invoke(
      "pi.read",
      { path: "package.json" },
      baseContext,
    );

    expect(result).toBe("[Image: a sample image, fully described.]");
  });


  it("honors a tool_call block by throwing without executing", async () => {
    const runner = makeRunner({
      emitToolCall: vi.fn(async () => ({ block: true, reason: "denied by gate" })),
    });
    const registry = registerWithRunner(runner);

    await expect(
      registry.invoke("pi.ls", { path: process.cwd() }, baseContext),
    ).rejects.toThrow("denied by gate");
  });

  it("forwards bounded partial previews without an extension runner", async () => {
    const provider = new PiToolsProvider(process.cwd(), undefined, undefined);
    const previews: Array<{ result?: unknown }> = [];
    const updates: string[] = [];

    await provider.invoke(
      "bash",
      { command: "printf first" },
      {
        ...baseContext,
        update(message) { updates.push(message); },
        attachPreview(preview) { previews.push(preview as { result?: unknown }); },
      },
    );

    expect(updates.some((message) => message.includes("first"))).toBe(true);
    expect(previews.some((preview) => JSON.stringify(preview.result).includes("first"))).toBe(true);
  });

  it("falls back to a direct execute (no events) when no runner is bound", async () => {
    const registry = new ActionRegistry();
    registry.register(new PiToolsProvider(process.cwd(), undefined, undefined));
    const result = await registry.invoke("pi.ls", { path: process.cwd() }, baseContext);
    expect(typeof result).toBe("string");
    expect((result as string).length).toBeGreaterThan(0);
  });

  it("preserves shell cwd through pi 0.85 argument preparation", async () => {
    const root = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-provider-cwd-")),
    );
    const nested = path.join(root, "nested");
    fs.mkdirSync(nested);
    try {
      const registry = new ActionRegistry();
      registry.register(new PiToolsProvider(root, undefined, undefined));
      await registry.invoke(
        "pi.bash",
        {
          command: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} -e "require('node:fs').writeFileSync('cwd.txt', process.cwd())"`,
          cwd: "nested",
        },
        {
          ...baseContext,
          cwd: root,
          extensionContext: { ...baseContext.extensionContext, cwd: root } as ExtensionContext,
          audits: [],
        },
      );
      expect(fs.realpathSync.native(fs.readFileSync(path.join(nested, "cwd.txt"), "utf8"))).toBe(
        fs.realpathSync.native(nested),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits PowerShell when the host factory is unavailable", async () => {
    const provider = new PiToolsProvider(
      process.cwd(),
      undefined,
      undefined,
      { powerShellToolDefinitionFactory: undefined },
    );

    expect(await provider.describe("powershell", baseContext)).toBeUndefined();
    expect((await provider.list({}, baseContext)).map((item) => item.name))
      .not.toContain("powershell");
    expect(await provider.describe("bash", baseContext)).toBeDefined();
    await expect(provider.invoke("powershell", { command: "Write-Output ok" }, baseContext))
      .rejects.toThrow("Unknown Pi tool: powershell");
  });

  it("registers PowerShell with shell schema and execution risk", async () => {
    const provider = new PiToolsProvider(process.cwd(), undefined, undefined);
    const descriptor = await provider.describe("powershell", baseContext);

    expect(descriptor).toMatchObject({
      name: "powershell",
      namespace: "builtin",
      risk: "execute",
    });
    expect(descriptor?.inputSchema.properties).toMatchObject({
      command: expect.any(Object),
      timeout: expect.any(Object),
      cwd: expect.any(Object),
    });
  });

  it("expands explicit skill-dir markers only for SKILL.md reads", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-skill-dir-"));
    const skillDir = path.join(cwd, "installed", "duplicate-name");
    const skillPath = path.join(skillDir, "SKILL.md");
    const referencePath = path.join(skillDir, "reference.md");
    const source = "Read `<skill-dir>/reference.md`.\n";
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(skillPath, source);
      fs.writeFileSync(referencePath, source);
      const registry = new ActionRegistry();
      registry.register(new PiToolsProvider(cwd, undefined, undefined));
      const context = {
        ...baseContext,
        cwd,
        extensionContext: { cwd } as ExtensionContext,
      };

      await expect(
        registry.invoke("pi.read", { path: skillPath }, context),
      ).resolves.toBe(`Read \`${skillDir}/reference.md\`.\n`);
      await expect(
        registry.invoke("pi.read", { path: referencePath }, context),
      ).resolves.toBe(source);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns truncated Bash output once while preserving recovery metadata", async () => {
    const registry = new ActionRegistry();
    registry.register(new PiToolsProvider(process.cwd(), undefined, undefined));
    const result = await registry.invoke(
      "pi.bash",
      {
        command:
          `node -e 'for (let i = 0; i < 5000; i++) console.log(i, "x".repeat(100))'`,
      },
      { ...baseContext, maxResultChars: 2_000_000 },
    );
    const bashResult = result as {
      ok: boolean;
      output: string;
      details: {
        fullOutputPath?: string;
        truncation?: Record<string, unknown>;
      };
    };

    try {
      expect(bashResult).toMatchObject({
        ok: true,
        output: expect.any(String),
        details: {
          fullOutputPath: expect.any(String),
          truncation: { truncated: true },
        },
      });
      expect("content" in (bashResult.details.truncation ?? {})).toBe(false);
    } finally {
      if (bashResult.details.fullOutputPath) {
        fs.rmSync(bashResult.details.fullOutputPath, { force: true });
      }
    }
  });

  it("applies all repeated edit anchors through one native mutation", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-edit-all-"));
    const filePath = path.join(cwd, "example.txt");
    try {
      fs.writeFileSync(filePath, "header\nneedle one\nneedle two\n");
      const registry = new ActionRegistry();
      registry.register(new PiToolsProvider(cwd, undefined, undefined));
      const result = await registry.invoke(
        "pi.edit",
        {
          path: "example.txt",
          edits: [
            { oldText: "header", newText: "title" },
            { oldText: "needle", newText: "updated", all: true },
          ],
        },
        {
          ...baseContext,
          cwd,
          extensionContext: { cwd } as ExtensionContext,
          audits: [],
        },
      ) as { ok: boolean; output: string };

      expect(result.ok).toBe(true);
      expect(fs.readFileSync(filePath, "utf8")).toBe("title\nupdated one\nupdated two\n");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("leaves the file unchanged when any replace-all anchor is missing", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-edit-all-atomic-"));
    const filePath = path.join(cwd, "example.txt");
    const before = "needle one\nneedle two\n";
    try {
      fs.writeFileSync(filePath, before);
      const registry = new ActionRegistry();
      registry.register(new PiToolsProvider(cwd, undefined, undefined));
      await expect(registry.invoke(
        "pi.edit",
        {
          path: "example.txt",
          edits: [
            { oldText: "needle", newText: "updated" },
            { oldText: "missing", newText: "never" },
          ],
          all: true,
        },
        {
          ...baseContext,
          cwd,
          extensionContext: { cwd } as ExtensionContext,
          audits: [],
        },
      )).rejects.toThrow("edits[1] oldText was not found");
      expect(fs.readFileSync(filePath, "utf8")).toBe(before);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("captures pre-write content out of band without changing the sandbox result", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-write-preview-"));
    const before = `const value = 1;
`;
    const after = `export const value = "é${"x".repeat(20_000)}";
`;
    try {
      fs.writeFileSync(path.join(cwd, "example.ts"), before);
      const registry = new ActionRegistry();
      registry.register(new PiToolsProvider(cwd, undefined, undefined));
      const audits: FabricCallAudit[] = [];
      const result = await registry.invoke(
        "pi.write",
        { path: "example.ts", content: after },
        {
          ...baseContext,
          cwd,
          extensionContext: { cwd } as ExtensionContext,
          audits,
        },
      ) as { ok: boolean; output: string; details: unknown };

      expect(result).toMatchObject({ ok: true, details: null });
      expect(result.output).toContain("Successfully wrote");
      expect(result.output).toContain(`${Buffer.byteLength(after, "utf8")} bytes`);
      expect(fs.readFileSync(path.join(cwd, "example.ts"), "utf8")).toBe(after);
      expect(String(audits[0]?.args?.content ?? "").length).toBeLessThan(after.length);
      expect(audits[0]?.preview).toMatchObject({
        writeBeforeCaptured: true,
        writeContent: after,
        writeByteLength: Buffer.byteLength(after, "utf8"),
        writeLineCount: 1,
        codePreviewBeforeWrite: { kind: "content", content: before },
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });


  it("attaches the pre-patch image and clean note when a tool_result patch replaces image blocks", async () => {
    // pi-vision-handoff keeps the read note and swaps the image for a
    // description. The provider captures the image BEFORE the patch (so the
    // single-call kitty preview still shows it) and the clean note AFTER.
    let rawContent: unknown;
    const runner = makeRunner({
      emitToolResult: vi.fn(async (event: { content: unknown }) => {
        rawContent = event.content;
        return {
          content: [
            { type: "text" as const, text: "Read image file [image/png]" },
            { type: "text" as const, text: "[Image: a described image.]" },
          ],
        };
      }),
    });
    const registry = registerWithRunner(runner);
    const audits: FabricCallAudit[] = [];

    await registry.invoke(
      "pi.read",
      { path: "tests/fixtures/images/sample.jpg" },
      { ...baseContext, audits },
    );

    expect((rawContent as Array<{ type: string }>).some((block) => block.type === "image")).toBe(true);
    expect(audits).toHaveLength(1);
    const media = audits[0]?.media;
    expect(media).toBeDefined();
    expect(media!.length).toBeGreaterThan(0);
    expect(media![0]?.type).toBe("image");
    expect(media![0]?.mimeType).toMatch(/^image\//);
    expect(typeof media![0]?.data).toBe("string");
    expect(media![0]?.data!.length).toBeGreaterThan(0);
    expect(audits[0]?.mediaNote).toBe("Read image file [image/png]");
  }, 15_000);

  it("attaches a captured read override's image once", async () => {
    // An extension that replaces read (e.g. a hashline read) runs through
    // CapturedToolsProvider, which already attaches the result's images to the
    // call audit. The provider must not attach them a second time, or
    // fabric_exec shows and sends every image twice.
    const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
    const definition = defineTool({
      name: "read", label: "Read", description: "Read override fixture",
      parameters: Type.Object({ path: Type.String() }),
      async execute() {
        return { content: [{ type: "text" as const, text: "Read image file [image/png]" }, image], details: undefined };
      },
    });
    const runner = makeRunner({ getActiveTools: () => ["read"] });
    const catalog = new CapturedToolCatalog();
    catalog.replace(
      [{ definition, sourceInfo: createSyntheticSourceInfo("/extensions/read-override.ts", { source: "test" }) } as RegisteredTool],
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/pi-fabric/index.ts",
    );
    const registry = new ActionRegistry();
    registry.register(new PiToolsProvider(process.cwd(), catalog, new CapturedToolsProvider(catalog)));
    const audits: FabricCallAudit[] = [];
    try {
      await registry.invoke("pi.read", { path: "shot.png" }, { ...baseContext, audits });
      expect(audits).toHaveLength(1);
      expect(audits[0]?.media).toEqual([image]);
      expect(audits[0]?.mediaNote).toBe("Read image file [image/png]");
    } finally {
      await registry.close();
    }
  });
});

describe("extension hijack contract for nested core tools", () => {
  // Generalized pi-vision-handoff pattern: any extension that expresses a
  // core-tool hijack as tool_call/tool_result handlers sees its behavior
  // inside fabric_exec pi.* calls, because the provider replays pi's
  // lifecycle event pipeline for nested executions.
  it("co-exists native grep lines with an extension-appended block via tool_result", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-grep-append-"));
    fs.writeFileSync(path.join(dir, "users.ts"), "export function GetUserHandler() {}\n");
    try {
      const runner = makeRunner({
        emitToolResult: vi.fn(
          async (event: { toolName: string; content: Array<{ type: string; text?: string }> }) =>
            event.toolName === "grep"
              ? {
                  content: [
                    ...event.content,
                    { type: "text", text: 'fovea graph "GetUserHandler" \u00b7 anchor context' },
                  ],
                }
              : undefined,
        ),
      });
      const registry = registerWithRunner(runner);

      const result = await registry.invoke(
        "pi.grep",
        { pattern: "GetUserHandler", path: dir },
        baseContext,
      );

      // Both surfaces co-exist: exact-match lines from core grep, plus the
      // extension's appended context block.
      expect(String(result)).toContain("GetUserHandler");
      expect(String(result)).toContain("fovea graph");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reroutes nested grep arguments mutated by a tool_call handler", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-grep-mutate-"));
    fs.writeFileSync(path.join(dir, "users.ts"), "export function GetUserHandler() {}\n");
    try {
      const runner = makeRunner({
        emitToolCall: vi.fn(async (event: { input: Record<string, unknown> }) => {
          event.input.pattern = "zzz-no-such-symbol";
        }),
      });
      const registry = registerWithRunner(runner);

      const result = await registry.invoke(
        "pi.grep",
        { pattern: "GetUserHandler", path: dir },
        baseContext,
      );

      expect(String(result)).not.toContain("users.ts");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks a nested core tool through the tool_call preflight", async () => {
    const runner = makeRunner({
      emitToolCall: vi.fn(async () => ({ block: true, reason: "grep requires an audit note" })),
    });
    const registry = registerWithRunner(runner);

    await expect(
      registry.invoke("pi.grep", { pattern: "anything" }, baseContext),
    ).rejects.toThrow("grep requires an audit note");
  });
});

describe("tool_call preflight coverage for nested bash", () => {
  const roots: string[] = [];
  const worktrees: Array<{ repository: string; path: string }> = [];
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const initRepository = (): string => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-preflight-wt-"));
    roots.push(repository);
    git(repository, "init", "-q");
    git(repository, "config", "user.email", "pi-fabric-tests@example.invalid");
    git(repository, "config", "user.name", "Pi Fabric tests");
    fs.writeFileSync(path.join(repository, "README.md"), "ok\n");
    git(repository, "add", ".");
    git(repository, "commit", "-qm", "initial");
    return fs.realpathSync(repository);
  };
  const blockBash = () =>
    vi.fn(async (event: { toolName: string }) =>
      event.toolName === "bash" ? { block: true, reason: "blocked" } : undefined,
    );

  afterEach(() => {
    for (const worktree of worktrees.splice(0)) {
      try {
        git(worktree.repository, "worktree", "remove", "--force", worktree.path);
      } catch {
        // The worktree may never have been created (the point of these tests).
      }
    }
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  // Case 1 (regression guard): a nested bash command routed through the normal
  // event lifecycle is blocked by the tool_call preflight, and the shell
  // operations never run.
  it("blocks a nested bash command through the preflight without running the shell", async () => {
    const execSpy = vi.fn(async () => ({ exitCode: 0 }));
    const wrapOperations = vi.fn(() => ({ exec: execSpy }));
    const middleware: FabricBashMiddlewareV1 = { version: 1, wrapOperations };
    const cwd = process.cwd();
    const runner = makeRunner({ emitToolCall: blockBash() });
    const definition = Object.assign(
      { ...createBashToolDefinition(cwd) },
      { [FABRIC_BASH_MIDDLEWARE]: middleware },
    );
    const catalog = new CapturedToolCatalog();
    catalog.replace(
      [{ definition, sourceInfo: { path: "/extensions/guard-bash.ts", source: "test", scope: "user", origin: "package" } } as RegisteredTool],
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/pi-fabric/index.ts",
    );
    const registry = new ActionRegistry();
    registry.register(new PiToolsProvider(cwd, catalog, new CapturedToolsProvider(catalog)));
    try {
      await expect(
        registry.invoke("pi.bash", { command: "rm -rf /tmp/x" }, baseContext),
      ).rejects.toThrow(/blocked/);
      expect(wrapOperations).not.toHaveBeenCalled();
      expect(execSpy).not.toHaveBeenCalled();
    } finally {
      await registry.close();
    }
  });

  // Case 2: a well-formed `git worktree add` is intercepted before the normal
  // lifecycle, so it must emit the same preflight first. A block stops it with
  // no worktree effect. Without the fix this executes and creates a worktree.
  it("blocks a git worktree add intercept before any worktree effect", async () => {
    const repository = initRepository();
    const dest = path.join(repository, "wt");
    worktrees.push({ repository, path: dest });
    const runner = makeRunner({ emitToolCall: blockBash() });
    const catalog = new CapturedToolCatalog();
    catalog.replace([], runner, DEFAULT_FABRIC_CONFIG.capture, "/extensions/pi-fabric/index.ts");
    const registry = new ActionRegistry();
    registry.register(new PiToolsProvider(repository, catalog, new CapturedToolsProvider(catalog)));
    const context = {
      ...baseContext,
      cwd: repository,
      extensionContext: { ...baseContext.extensionContext, cwd: repository } as ExtensionContext,
      audits: [],
    };
    try {
      await expect(
        registry.invoke("pi.bash", { command: "git worktree add -b topic wt HEAD" }, context),
      ).rejects.toThrow(/blocked/);
      expect(fs.existsSync(dest)).toBe(false);
      expect(git(repository, "worktree", "list", "--porcelain")).not.toContain("branch refs/heads/topic");
    } finally {
      await registry.close();
    }
  });

  // Case 3: a catalog is installed but its runner is not yet available (the
  // window before the first tool refresh). Mutating tools would otherwise run
  // with no tool_call preflight, so they fail closed; read tools still run.
  it("fails closed for mutating tools until the catalog runner is available", async () => {
    const cwd = process.cwd();
    const catalog = new CapturedToolCatalog(); // never replaced: runner is undefined
    const provider = new PiToolsProvider(cwd, catalog, new CapturedToolsProvider(catalog));
    for (const [tool, args] of [
      ["bash", { command: "echo hi" }],
      ["write", { path: "scratch.txt", content: "x" }],
      ["edit", { path: "scratch.txt", oldText: "a", newText: "b" }],
    ] as const) {
      await expect(provider.invoke(tool, args, baseContext)).rejects.toThrow(
        /until extension tool hooks initialize/,
      );
    }
    // A read tool has nothing to guard and still resolves through direct execute.
    await expect(provider.invoke("ls", { path: cwd }, baseContext)).resolves.toEqual(
      expect.any(String),
    );
  });

  // Case 4 (Gap C guard): the tool_call event's input already carries the
  // effective per-call cwd, so cwd-aware guards evaluate against the right base.
  it("exposes the effective per-call cwd on the tool_call event input", async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-preflight-cwd-")));
    roots.push(root);
    const nested = path.join(root, "nested");
    fs.mkdirSync(nested);
    let capturedCwd: unknown;
    const runner = makeRunner({
      emitToolCall: vi.fn(async (event: { toolName: string; input: Record<string, unknown> }) => {
        if (event.toolName === "bash") capturedCwd = event.input.cwd;
        return undefined;
      }),
    });
    const catalog = new CapturedToolCatalog();
    catalog.replace([], runner, DEFAULT_FABRIC_CONFIG.capture, "/extensions/pi-fabric/index.ts");
    const registry = new ActionRegistry();
    registry.register(new PiToolsProvider(root, catalog, new CapturedToolsProvider(catalog)));
    try {
      await registry.invoke(
        "pi.bash",
        {
          command: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} -e "require('node:fs').writeFileSync('cwd.txt', process.cwd())"`,
          cwd: "nested",
        },
        {
          ...baseContext,
          cwd: root,
          extensionContext: { ...baseContext.extensionContext, cwd: root } as ExtensionContext,
          audits: [],
        },
      );
      expect(fs.realpathSync.native(String(capturedCwd))).toBe(fs.realpathSync.native(nested));
      expect(fs.realpathSync.native(fs.readFileSync(path.join(nested, "cwd.txt"), "utf8"))).toBe(fs.realpathSync.native(nested));
    } finally {
      await registry.close();
    }
  });
});
