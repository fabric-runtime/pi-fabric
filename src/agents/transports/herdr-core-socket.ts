import net from "node:net";
import { randomUUID } from "node:crypto";

export class HerdrCoreRpcError extends Error {
  constructor(readonly code: number, message: string, readonly kind?: string) {
    super(`Herdr Core API: ${code}: ${message}`);
    this.name = "HerdrCoreRpcError";
  }
}

/** Accept native full pipe names as well as the short Windows endpoint form. */
export const herdrCoreEndpoint = (socket: string, platform = process.platform): string =>
  platform === "win32" && !socket.startsWith("\\\\.\\pipe\\") ? `\\\\.\\pipe\\${socket}` : socket;

/** One correlated, newline-delimited JSON-RPC 2.0 request. Never starts a service. */
export const herdrCoreSocketRequest = (
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  options: { timeoutMs?: number; maxResponseBytes?: number } = {},
): Promise<unknown> => new Promise((resolve, reject) => {
  const id = `pi-fabric:${randomUUID()}`;
  const socket = net.createConnection(herdrCoreEndpoint(socketPath));
  const chunks: Buffer[] = [];
  let bytes = 0;
  let settled = false;
  const finish = (error?: Error, result?: unknown): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    if (error) reject(error);
    else resolve(result);
  };
  const timer = setTimeout(() => finish(new Error("Herdr Core API request timed out")), options.timeoutMs ?? 5_000);
  timer.unref?.();
  socket.on("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`));
  socket.on("data", (chunk: Buffer) => {
    const newline = chunk.indexOf(10);
    const captured = newline < 0 ? chunk : chunk.subarray(0, newline);
    bytes += captured.length;
    if (bytes > (options.maxResponseBytes ?? 1024 * 1024)) {
      finish(new Error("Herdr Core API response exceeds byte limit"));
      return;
    }
    chunks.push(captured);
    if (newline < 0) return;
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || value.jsonrpc !== "2.0" || value.id !== id ||
          (Object.hasOwn(value, "result") === Object.hasOwn(value, "error"))) {
        throw new Error("uncorrelated or invalid JSON-RPC envelope");
      }
      if (Object.hasOwn(value, "error")) {
        const error = value.error;
        if (!error || !Number.isInteger(error.code) || typeof error.message !== "string") {
          throw new Error("invalid JSON-RPC error");
        }
        finish(new HerdrCoreRpcError(error.code, error.message,
          typeof error.data?.kind === "string" ? error.data.kind : undefined));
      } else finish(undefined, value.result);
    } catch (error) {
      finish(new Error(`Invalid Herdr Core API response: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
  socket.on("error", (error) => finish(error));
  socket.on("end", () => finish(new Error("Herdr Core API closed without a complete response")));
  socket.on("close", () => finish(new Error("Herdr Core API socket closed")));
});
