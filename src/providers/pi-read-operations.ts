import { constants } from "node:fs";
import { access, open, readFile } from "node:fs/promises";
import type { ReadOperations } from "@earendil-works/pi-coding-agent";

/** Pi 1.5.2 added the optional streaming hook; older hosts ignore it. */
export type FabricReadOperations = ReadOperations & {
  createReadStream?: (absolutePath: string, options: { signal?: AbortSignal }) => AsyncIterable<Uint8Array>;
};

const aborted = (): Error => new Error("Operation aborted");

/**
 * Streams a file the way Pi's default read does, without handing the abort
 * signal to Node's stream. A signalled stream that aborts while Pi's reader is
 * between awaits is destroyed with an AbortError that no listener receives, and
 * that uncaught error ends the Pi process. Fabric aborts unserved speculative
 * reads as normal control flow, so cancellation here ends the stream without an
 * error event and surfaces as an ordinary rejection.
 */
export async function* readFileChunks(
  absolutePath: string,
  { signal }: { signal?: AbortSignal } = {},
): AsyncGenerator<Uint8Array> {
  if (signal?.aborted) throw aborted();
  const handle = await open(absolutePath, "r");
  try {
    const stats = await handle.stat();
    if (signal?.aborted) throw aborted();
    const end = stats.isFile() && stats.size > 0 ? stats.size - 1 : undefined;
    const stream = handle.createReadStream({ ...(end === undefined ? {} : { end }), autoClose: false });
    // destroy() without an error emits "close" only, never "error".
    const stop = (): void => { stream.destroy(); };
    signal?.addEventListener("abort", stop, { once: true });
    try {
      for await (const chunk of stream) {
        if (signal?.aborted) throw aborted();
        yield chunk as Uint8Array;
      }
    } catch (error) {
      if (signal?.aborted) throw aborted();
      throw error;
    } finally {
      signal?.removeEventListener("abort", stop);
      stream.destroy();
    }
    if (signal?.aborted) throw aborted();
  } finally {
    await handle.close();
  }
}

/**
 * Pi's local read operations with an abort-safe stream. Undefined when the host
 * does not export its image detector: Pi's own defaults then apply unchanged.
 */
export function abortSafeReadOperations(
  detectImageMimeType: ((absolutePath: string) => Promise<string | null | undefined>) | undefined,
): FabricReadOperations | undefined {
  if (typeof detectImageMimeType !== "function") return undefined;
  return {
    readFile: (absolutePath) => readFile(absolutePath),
    access: (absolutePath) => access(absolutePath, constants.R_OK),
    detectImageMimeType: (absolutePath) => detectImageMimeType(absolutePath),
    createReadStream: readFileChunks,
  };
}
