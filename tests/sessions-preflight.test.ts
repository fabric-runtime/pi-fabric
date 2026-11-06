import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DurableShellBridge } from "../src/jev-fabric/bridge.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import { SessionsProvider, toolCallShellPreflight } from "../src/providers/sessions-provider.js";

const fake = fileURLToPath(new URL("./fixtures/fake-jev-fabric.mjs", import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Hook = (event: { toolName: string; parentToolCallId: string; input: Record<string, unknown> }) => Promise<{ block: true; reason?: string } | undefined>;
const bridgeOf = (provider: SessionsProvider) => provider.bridge as unknown as { resolve: () => Promise<unknown> };

// The provider is wired the way the runtime wires it: through the shared preflight and a runner.
const setup = (hook: Hook, options: { runner?: boolean; runnerUnavailable?: boolean } = {}) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fabric-sessions-preflight-")));
  const binary = path.join(root, "jev-fabric");
  fs.writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  const bridge = { home: path.join(root, "home"), resolve: async () => ({ path: binary }) } as unknown as DurableShellBridge;
  const emitToolCall = vi.fn(hook);
  const runner = { emitToolCall } as unknown as ExtensionRunner;
  const provider = new SessionsProvider(bridge, {
    cwd: root,
    shellOverride: () => false,
    preflight: toolCallShellPreflight(() => options.runner === false ? undefined : runner, () => options.runnerUnavailable === true),
  });
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => provider.close());
  const updateArguments = vi.fn();
  const call = (name: string, args: Record<string, unknown>) =>
    provider.invoke(name, args, { parentToolCallId: "fabric_exec_7", nestedToolCallId: "nested_1", signal: new AbortController().signal, updateArguments } as unknown as FabricInvocationContext) as Promise<Record<string, any>>;
  return { root, provider, call, emitToolCall, updateArguments };
};

describe.skipIf(process.platform === "win32")("sessions run the shell tool_call preflight", () => {
  it("blocks sessions.open before the serve spawns anything, and the hook sees command, cwd and parent id", async () => {
    const { call, provider, root, emitToolCall } = setup(async () => ({ block: true, reason: "denied by shell guard" }));
    const marker = path.join(root, "ran");
    await expect(call("open", { cmd: `touch ${marker}` })).rejects.toThrow("denied by shell guard");
    expect(emitToolCall).toHaveBeenCalledOnce();
    expect(emitToolCall.mock.calls[0]![0]).toMatchObject({
      type: "tool_call", toolName: "bash", toolCallId: "nested_1", parentToolCallId: "fabric_exec_7",
      input: { command: `touch ${marker}`, cwd: root },
    });
    expect(await provider.invoke("list", {}, {} as FabricInvocationContext)).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("shows the hook an argv open as one shell-quoted command line", async () => {
    const { call, emitToolCall } = setup(async () => ({ block: true }));
    await expect(call("open", { argv: ["rm", "-rf", "a b"] })).rejects.toThrow();
    expect(emitToolCall.mock.calls[0]![0].input.command).toBe("rm -rf 'a b'");
  });

  it("still spawns when no hook blocks", async () => {
    const { call, root } = setup(async () => undefined);
    const marker = path.join(root, "ran");
    const opened = await call("open", { cmd: `touch '${marker}'` });
    expect(opened).toMatchObject({ lifetime: "session" });
    expect(await call("wait", { id: opened.id, timeoutMs: 5000 })).toMatchObject({ state: "exited", exitCode: 0 });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("uses the command a hook rewrote, and refuses to rewrite argv", async () => {
    const rewrite = setup(async event => { event.input.command = "echo guarded"; return undefined; });
    const opened = await rewrite.call("open", { cmd: "echo original" });
    await rewrite.call("wait", { id: opened.id, timeoutMs: 5000 });
    expect((await rewrite.call("read", { id: opened.id, offset: 0 })).text).toBe("guarded\n");
    const argvRewrite = setup(async event => { event.input.command = "echo guarded"; return undefined; });
    await expect(argvRewrite.call("open", { argv: ["echo", "original"] })).rejects.toThrow("cannot rewrite argv");
  });

  it("preflights text written to a shell session, and blocked text never reaches stdin", async () => {
    let block = false;
    const { call, emitToolCall } = setup(async event => (block && event.input.command === "echo blocked" ? { block: true, reason: "no" } : undefined));
    const shell = await call("open", { argv: ["sh"] });
    block = true;
    await expect(call("write", { id: shell.id, text: "echo blocked" })).rejects.toThrow("no");
    expect(emitToolCall.mock.calls.at(-1)![0]).toMatchObject({ toolName: "bash", parentToolCallId: "fabric_exec_7", input: { command: "echo blocked" } });
    block = false;
    await call("write", { id: shell.id, text: "echo fine\n" });
    expect((await call("read", { id: shell.id, offset: 0, waitMs: 5000 })).text).toBe("fine\n");
  });

  it("does not preflight writes to a session that is not a shell", async () => {
    const { call, emitToolCall } = setup(async () => undefined);
    const cat = await call("open", { argv: ["cat"] });
    emitToolCall.mockClear();
    await call("write", { id: cat.id, text: "data\n" });
    expect(emitToolCall).not.toHaveBeenCalled();
  });

  it("keeps the call's own arguments in the audit record, and records a command the hook rewrote", async () => {
    const plain = setup(async () => undefined);
    const shell = await plain.call("open", { argv: ["sh"] });
    await plain.call("write", { id: shell.id, text: "echo fine\n" });
    expect(plain.updateArguments).not.toHaveBeenCalled();
    const rewrite = setup(async event => { event.input.command = "echo guarded"; return undefined; });
    await rewrite.call("open", { cmd: "echo original", label: "job" });
    expect(rewrite.updateArguments).toHaveBeenCalledOnce();
    expect(rewrite.updateArguments).toHaveBeenCalledWith({ cmd: "echo guarded", label: "job" });
  });

  it("fails closed when a hook throws, blocks without a reason, or changes cwd", async () => {
    const throwing = setup(async () => { throw new Error("guard crashed"); });
    const resolve = vi.spyOn(bridgeOf(throwing.provider), "resolve");
    await expect(throwing.call("open", { cmd: "true" })).rejects.toThrow("guard crashed");
    expect(resolve).not.toHaveBeenCalled();
    const silent = setup(async () => ({ block: true }));
    await expect(silent.call("open", { cmd: "true" })).rejects.toThrow("sessions.open was blocked by a bash tool_call hook");
    const moved = setup(async event => { event.input.cwd = "/"; return undefined; });
    await expect(moved.call("open", { cmd: "true" })).rejects.toThrow("cannot change the working directory");
    const cmdTyped = setup(async event => { event.input.command = 7; return undefined; });
    await expect(cmdTyped.call("open", { cmd: "true" })).rejects.toThrow("cannot rewrite cmd");
  });

  it("refuses before spawning while no extension runner can run the hooks", async () => {
    const { call, provider, emitToolCall } = setup(async () => undefined, { runner: false });
    const resolve = vi.spyOn(bridgeOf(provider), "resolve");
    await expect(call("open", { argv: ["true"] })).rejects.toThrow("sessions.open is unavailable until extension tool hooks initialize");
    expect(resolve).not.toHaveBeenCalled();
    expect(emitToolCall).not.toHaveBeenCalled();
  });

  it("says a retry cannot help when the host's extension runner was never found", async () => {
    const { call, emitToolCall } = setup(async () => undefined, { runner: false, runnerUnavailable: true });
    const message = await call("open", { argv: ["true"] }).then(() => "opened", (error: Error) => error.message);
    expect(message).toContain("sessions.open is unavailable: Pi Fabric could not find this Pi host's ExtensionRunner");
    expect(message).not.toContain("retry once tools are ready");
    expect(emitToolCall).not.toHaveBeenCalled();
  });

  it("refuses sessions in a child whose write policy denies the shell", async () => {
    vi.stubEnv("PI_FABRIC_WRITE_POLICY", JSON.stringify({ readOnly: false, writableRoots: [os.tmpdir()], shell: "deny" }));
    cleanups.push(() => { vi.unstubAllEnvs(); });
    const { call, emitToolCall } = setup(async () => undefined);
    await expect(call("open", { argv: ["true"] })).rejects.toThrow("Fabric write policy refuses bash");
    expect(emitToolCall).not.toHaveBeenCalled();
  });

  it("treats cmd sessions and argv that starts a shell anywhere as shells", async () => {
    const { call, emitToolCall } = setup(async () => undefined);
    for (const open of [{ cmd: "echo ready; exec sh" }, { argv: ["env", "bash"] }]) {
      const opened = await call("open", open);
      emitToolCall.mockClear();
      await call("write", { id: opened.id, text: "exit\n" });
      expect(emitToolCall).toHaveBeenCalledOnce();
      expect(emitToolCall.mock.calls[0]![0].input).toEqual({ command: "exit" });
    }
  });

  it("judges a command split across writes as one line", async () => {
    const { call, emitToolCall } = setup(async event => (event.input.command === "rm -rf x" ? { block: true, reason: "no rm" } : undefined));
    const shell = await call("open", { argv: ["sh"] });
    await call("write", { id: shell.id, text: "rm -r" });
    await expect(call("write", { id: shell.id, text: "f x\n" })).rejects.toThrow("no rm");
    await call("write", { id: shell.id, text: "\n" });
    await call("write", { id: shell.id, text: "echo next" });
    expect(emitToolCall.mock.calls.map(([event]) => event.input.command)).toEqual(["sh", "rm -r", "rm -rf x", "rm -r", "echo next"]);
  });
});
