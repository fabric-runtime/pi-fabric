import fs from "node:fs";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agents/manager.js";
import { HerdrTransport } from "../src/agents/transports/herdr-transport.js";
import { LocaltermTransport } from "../src/agents/transports/localterm-transport.js";
import { TmuxTransport } from "../src/agents/transports/tmux-transport.js";
import { ScreenTransport } from "../src/agents/transports/screen-transport.js";
import { ProcessTransport } from "../src/agents/transports/process-transport.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { HerdrCoreTransport } from "../src/agents/transports/herdr-core-transport.js";
import { herdrCoreEndpoint, herdrCoreSocketRequest, HerdrCoreRpcError } from "../src/agents/transports/herdr-core-socket.js";
import { normalizeFabricConfig } from "../src/config.js";
import { normalizeAgentRunRequest } from "../src/agents/request.js";
import { TRANSPORTS } from "../src/ui/settings-values.js";
import { AGENTS_ACTION_DESCRIPTORS } from "../src/providers/agents-actions.js";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";

type Request = { id: string; jsonrpc: string; method: string; params: Record<string, unknown> };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const serve = async (respond: (request: Request, socket: Socket) => void) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-test-"));
  const socketPath = path.join(root, "core.sock");
  const sockets = new Set<Socket>();
  const requests: Request[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (data) => {
      input += data.toString();
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]!) as Request;
      requests.push(request);
      respond(request, socket);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { socketPath, requests };
};
const reply = (request: Request, socket: Socket, result: unknown) => socket.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
const rpcError = (request: Request, socket: Socket, kind: string) => socket.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: kind, data: { kind } } }) + "\n");
const launch = { id: "worker-id", name: " 🔥 Review '$(touch /bad)' ".repeat(4), cwd: "/repo with spaces;$(x)", workerPath: "/worker path/worker.js", workerArguments: ["--task", "quotes ' \" $(); &\nnew line"] };
const hello = { generation: 1, framed: false, methods: ["terminal.run", "terminal.get", "terminal.kill"] };

describe("Herdr Core public transport", () => {
  it("is accepted by config, per-call parser, settings, schema and guest types", () => {
    expect(normalizeFabricConfig({ agents: { transport: "herdr-core" } }).agents.transport).toBe("herdr-core");
    expect(normalizeAgentRunRequest({ task: "test", transport: "herdr-core" }, { runner: "pi", timeoutMs: 1 }).transport).toBe("herdr-core");
    expect(TRANSPORTS).toContain("herdr-core");
    expect(JSON.stringify(AGENTS_ACTION_DESCRIPTORS)).toContain('"herdr-core"');
    expect(GUEST_TYPE_DECLARATIONS).toContain('"herdr-core"');
  });
  it("preserves full native pipe endpoints", () => {
    expect(herdrCoreEndpoint("\\\\.\\pipe\\hc", "win32")).toBe("\\\\.\\pipe\\hc");
    expect(herdrCoreEndpoint("hc", "win32")).toBe("\\\\.\\pipe\\hc");
    expect(herdrCoreEndpoint("/run/hc.sock", "linux")).toBe("/run/hc.sock");
  });
});

describe.skipIf(process.platform === "win32")("Herdr Core socket and lifecycle", () => {
  it("requires injected Core context and a compatible reachable service", async () => {
    const { socketPath, requests } = await serve((r, s) => reply(r, s, hello));
    expect(await new HerdrCoreTransport({ HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: socketPath }).available()).toBe(true);
    expect(requests[0]).toMatchObject({ jsonrpc: "2.0", method: "hello", params: { generation: 1, framed: false } });
    expect(await new HerdrCoreTransport({ HC_TERMINAL_SOCKET: socketPath }).available()).toBe(false);
    expect(await new HerdrCoreTransport({ HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: socketPath + "missing" }).available()).toBe(false);
    expect(await new HerdrCoreTransport({ HERDR_ENV: "1" }).available()).toBe(false);
    const incompatible = await serve((r, s) => reply(r, s, { ...hello, generation: 2 }));
    expect(await new HerdrCoreTransport({ HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: incompatible.socketPath }).available()).toBe(false);
    const missingMethod = await serve((r, s) => reply(r, s, { ...hello, methods: ["terminal.run", "terminal.get"] }));
    expect(await new HerdrCoreTransport({ HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: missingMethod.socketPath }).available()).toBe(false);
  });
  it.each(["t42", "t1b", "t2z"])("preserves argv/cwd and child identity/lifecycle at %s", async (address) => {
    let state = "live";
    let error: string | undefined;
    const { socketPath, requests } = await serve((r, s) => {
      if (error) { rpcError(r, s, error); return; }
      if (r.method === "terminal.kill") state = "finished";
      reply(r, s, { address, state });
    });
    const transport = new HerdrCoreTransport({ HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: socketPath });
    const handle = await transport.launch(launch);
    await transport.launch(launch);
    expect(handle).toMatchObject({ kind: "herdr-core", sessionId: address, attachCommand: `hc attach ${address}` });
    expect(requests[0]!.params).toMatchObject({ argv: [process.execPath, launch.workerPath, ...launch.workerArguments], cwd: launch.cwd, caller: "t1", parent: "t1", no_notify: true, wait: false, keep: false, outlive_parent: false });
    expect(requests[0]!.params).not.toHaveProperty("env");
    expect(requests[0]!.params).not.toHaveProperty("line");
    expect(requests[0]!.params.name).toMatch(/^[a-z0-9_-]{1,32}$/);
    expect(requests[0]!.params.name).not.toBe(requests[1]!.params.name);
    expect(await handle.isAlive()).toBe(true);
    await handle.stop();
    expect(await handle.isAlive()).toBe(false);
    await handle.stop();
    error = "not_found";
    expect(await handle.isAlive()).toBe(false);
    await expect(handle.stop()).resolves.toBeUndefined();
    error = "permission_denied";
    await expect(handle.stop()).rejects.toBeInstanceOf(HerdrCoreRpcError);
    await expect(handle.isAlive()).rejects.toMatchObject({ kind: "permission_denied", code: -32000 });
    expect(requests.filter((r) => r.method === "terminal.kill").every((r) => r.params.terminal === address)).toBe(true);
    expect(requests.every((r) => ["terminal.run", "terminal.get", "terminal.kill"].includes(r.method))).toBe(true);
  });
  it.each(["core", "outside", "unreachable", "explicit", "explicit-unreachable"])("routes %s selection without starting a worker or service", async (mode) => {
    const { socketPath } = await serve((r, s) => reply(r, s, hello));
    vi.stubEnv("HC_TERMINAL_ID", mode === "outside" ? "" : "t1");
    vi.stubEnv("HC_TERMINAL_SOCKET", mode.includes("unreachable") ? `${socketPath}-absent` : socketPath);
    vi.spyOn(HerdrCoreTransport.prototype, "launch").mockRejectedValue(new Error("selected core"));
    vi.spyOn(HerdrTransport.prototype, "available").mockResolvedValue(mode === "outside" || mode === "core");
    const legacy = vi.spyOn(HerdrTransport.prototype, "launch").mockRejectedValue(new Error("selected legacy"));
    vi.spyOn(LocaltermTransport.prototype, "available").mockResolvedValue(false);
    vi.spyOn(TmuxTransport.prototype, "available").mockResolvedValue(false);
    vi.spyOn(ScreenTransport.prototype, "available").mockResolvedValue(false);
    vi.spyOn(ProcessTransport.prototype, "available").mockResolvedValue(true);
    vi.spyOn(ProcessTransport.prototype, "launch").mockRejectedValue(new Error("selected process"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-manager-"));
    const manager = new AgentManager(process.cwd(), { ...DEFAULT_FABRIC_CONFIG.agents, runner: "pi", transport: "auto" }, { runRoot: root, workerPath: path.resolve("tests/fixtures/fake-worker.mjs") });
    cleanups.push(async () => { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const expected = mode === "explicit-unreachable" ? "unavailable: herdr-core" :
      mode === "outside" ? "selected legacy" : mode === "unreachable" ? "selected process" : "selected core";
    await expect(manager.spawn({ task: "routing only", ...(mode.startsWith("explicit") ? { transport: "herdr-core" as const } : {}) })).rejects.toThrow(expected);
    if (mode === "core" || mode.startsWith("explicit")) expect(legacy).not.toHaveBeenCalled();
  });
  it("accepts split UTF-8 replies", async () => {
    const { socketPath } = await serve((r, s) => {
      const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: "🔥" }) + "\n");
      const split = bytes.indexOf(Buffer.from("🔥")) + 1;
      s.write(bytes.subarray(0, split));
      setTimeout(() => s.end(bytes.subarray(split)), 5);
    });
    await expect(herdrCoreSocketRequest(socketPath, "hello", {})).resolves.toBe("🔥");
  });
  it.each(["malformed", "wrong-id", "notification", "both", "bad-error", "oversized", "partial", "timeout"])("rejects %s responses boundedly", async (mode) => {
    const { socketPath } = await serve((r, s) => {
      if (mode === "timeout") return;
      if (mode === "malformed") s.end("{bad}\n");
      if (mode === "wrong-id") s.end(JSON.stringify({ jsonrpc: "2.0", id: "other", result: 1 }) + "\n");
      if (mode === "notification") s.end(JSON.stringify({ jsonrpc: "2.0", method: "notice" }) + "\n");
      if (mode === "both") s.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: 1, error: {} }) + "\n");
      if (mode === "bad-error") s.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, error: { code: "bad" } }) + "\n");
      if (mode === "oversized") s.end("x".repeat(300));
      if (mode === "partial") s.end('{"jsonrpc":');
    });
    await expect(herdrCoreSocketRequest(socketPath, "hello", {}, { timeoutMs: 50, maxResponseBytes: 256 })).rejects.toThrow(/Herdr Core/);
  });
  it("rejects unsafe returned addresses rather than constructing an attach injection", async () => {
    const { socketPath } = await serve((r, s) => reply(r, s, { address: "t1;rm -rf /", state: "live" }));
    await expect(new HerdrCoreTransport({ HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: socketPath }).launch(launch)).rejects.toThrow("invalid terminal");
  });
});
