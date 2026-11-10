import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionContext, MessageUpdateEvent } from "@earendil-works/pi-coding-agent";

// Pi 1.5.2's read tool, reduced to the parts that matter: it checks for an
// abort, awaits more work, then streams through `operations.createReadStream`,
// whose default hands the abort signal to Node's file stream. `beforeStream`
// holds a read inside that window so the abort lands there deterministically.
const pi152 = vi.hoisted(() => ({
  beforeStream: undefined as undefined | (() => Promise<void>),
  reads: 0,
}));

vi.mock("../src/core/host-sdk-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent");
  // Verbatim shape of Pi 1.5.2's default `readLocalFileChunks`.
  async function* readLocalFileChunks(path: string, { signal }: { signal?: AbortSignal | undefined }) {
    const handle = await open(path, "r");
    try {
      const stats = await handle.stat();
      const end = stats.isFile() && stats.size > 0 ? stats.size - 1 : undefined;
      yield* handle.createReadStream({ ...(end === undefined ? {} : { end }), signal, autoClose: false });
    } finally {
      await handle.close();
    }
  }
  type Operations = { access(path: string): Promise<void>; createReadStream?: (path: string, options: { signal?: AbortSignal | undefined }) => AsyncIterable<Uint8Array> };
  const createReadToolDefinition = (cwd: string, options?: { operations?: Operations }) => {
    const base = actual.createReadToolDefinition(cwd);
    const ops = options?.operations ?? { access: async () => undefined, createReadStream: readLocalFileChunks };
    return {
      ...base,
      async execute(_id: string, { path }: { path: string }, signal?: AbortSignal) {
        return new Promise((resolveRead, reject) => {
          if (signal?.aborted) { reject(new Error("Operation aborted")); return; }
          let aborted = false;
          const onAbort = () => { aborted = true; reject(new Error("Operation aborted")); };
          signal?.addEventListener("abort", onAbort, { once: true });
          void (async () => {
            try {
              const absolute = resolve(cwd, path);
              await ops.access(absolute);
              if (aborted) return;
              pi152.reads++;
              await pi152.beforeStream?.();
              let text = "";
              const decoder = new TextDecoder();
              for await (const chunk of ops.createReadStream!(absolute, { signal })) {
                if (signal?.aborted) throw new Error("Operation aborted");
                text += decoder.decode(chunk, { stream: true });
              }
              if (aborted) return;
              signal?.removeEventListener("abort", onAbort);
              resolveRead({ content: [{ type: "text", text }], details: undefined });
            } catch (error) {
              signal?.removeEventListener("abort", onAbort);
              if (!aborted) reject(error);
            }
          })();
        });
      },
    };
  };
  return { PiCodingAgent: { ...actual, createReadToolDefinition } };
});

const { normalizeFabricConfig } = await import("../src/config.js");
const { ActionRegistry } = await import("../src/core/action-registry.js");
const { FabricExecutionService } = await import("../src/execution-service.js");
const { PiToolsProvider } = await import("../src/providers/pi-tools-provider.js");
const { RuntimeStateSpeculation } = await import("../src/runtime-state-speculation.js");
const { LiteralCallScanner } = await import("../src/speculation/scanner.js");

const cleanups: (() => void)[] = [];
afterEach(() => {
  pi152.beforeStream = undefined;
  pi152.reads = 0;
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

it("aborting speculative reads during parallel tool calls never crashes the process", async () => {
  const crashes: unknown[] = [];
  const crash = (error: unknown) => { crashes.push(error); };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  cleanups.push(() => {
    process.off("uncaughtException", crash);
    process.off("unhandledRejection", crash);
  });
  const cwd = mkdtempSync(join(tmpdir(), "fabric-spec-read-abort-"));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "big.txt"), Array.from({ length: 50_000 }, (_, line) => `line ${line}`).join("\n"));
  writeFileSync(join(cwd, "small.txt"), "kept");

  const config = normalizeFabricConfig({ approvals: { read: "allow", write: "allow", network: "allow" } });
  const registry = new ActionRegistry();
  registry.register(new PiToolsProvider(cwd));
  const service = new FabricExecutionService(registry, config);
  const speculation = new RuntimeStateSpeculation(registry, () => config.speculation, () => undefined, () => true);
  speculation.tap!.setScannerFactory(() => new LiteralCallScanner());
  cleanups.push(() => speculation.reset());
  const context = {
    cwd, hasUI: false, tools: [],
    sessionManager: { getBranch: () => [], getSessionId: () => "spec-read-abort", getLeafId: () => "root", getSessionFile: () => undefined, getCwd: () => cwd },
  } as unknown as ExtensionContext;
  // One assistant message carrying two parallel fabric_exec calls.
  const calls = [{ type: "toolCall", name: "fabric_exec", id: "parallel-a" }, { type: "toolCall", name: "fabric_exec", id: "parallel-b" }];
  const stream = (toolCallId: string, code: string) => {
    const contentIndex = calls.findIndex((call) => call.id === toolCallId);
    for (const type of ["toolcall_start", "toolcall_delta"] as const) {
      speculation.tap!.handleMessageUpdate({
        assistantMessageEvent: { type, contentIndex, delta: JSON.stringify({ code }).slice(0, -2), partial: { content: calls } },
      } as MessageUpdateEvent, context);
    }
    speculation.tap!.handleMessageUpdate({
      assistantMessageEvent: { type: "toolcall_end", contentIndex, toolCall: calls[contentIndex], partial: { content: calls } },
    } as unknown as MessageUpdateEvent, context);
  };

  // Hold both warm reads between their abort check and their stream.
  let release!: () => void;
  const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
  pi152.beforeStream = () => held;
  const wasted = `return await pi.read({path: "big.txt"});`;
  const served = `return await pi.read({path: "small.txt"});`;
  stream("parallel-a", wasted);
  stream("parallel-b", served);
  await vi.waitFor(() => expect(pi152.reads).toBe(2));

  // The model's first parallel call ends without using its warm read.
  await registry.endInvocation("parallel-a");
  release();
  pi152.beforeStream = undefined;
  await new Promise((settle) => setTimeout(settle, 100));

  const result = await service.execute({ code: served, context, signal: undefined, parentToolCallId: "parallel-b", onPartial() {} });
  expect(result.success, result.error).toBe(true);
  expect(result.value).toBe("kept");
  await new Promise((settle) => setTimeout(settle, 100));
  expect(crashes).toEqual([]);
});
