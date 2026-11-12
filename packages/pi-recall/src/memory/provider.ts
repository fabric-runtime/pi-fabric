import type { FabricInvocationContext, FabricProvider } from "../protocol.js";
import { memoryActionDescriptors, normalizeMemoryArgs } from "../providers/memory-provider.js";

export type MemoryProviderAction = "recall" | "expand" | "sessions";
export type MemoryProviderDispatch = (
  action: MemoryProviderAction,
  args: Record<string, unknown>,
  context: FabricInvocationContext,
) => Promise<unknown>;

export interface MemoryProviderOptions {
  /** Trusted routing boundary; authorization remains the dispatcher's responsibility. */
  dispatch: MemoryProviderDispatch;
  /** Host lease/pause check, performed before and after asynchronous retrieval. */
  check?: () => void;
  /** Trusted current-session default, applied before canonical schema validation. */
  defaultSession?: (args: Record<string, unknown>) => string | undefined;
}

/** Canonical native memory contract over an explicit client or authorized dispatcher.
 * This factory never creates a filesystem source or inherits host sources. */
export function createMemoryProvider(options: MemoryProviderOptions): FabricProvider {
  return {
    name: "memory",
    description: "Retrieve explicitly authorized session memory.",
    async list(request) {
      const query = request.query?.toLowerCase();
      return memoryActionDescriptors.filter(item => !query ||
        `${item.name} ${item.description}`.toLowerCase().includes(query));
    },
    async describe(name) {
      return memoryActionDescriptors.find(item => item.name === name);
    },
    prepareArguments(name, args) {
      const normalized = normalizeMemoryArgs(name, args);
      if (name === "expand" && normalized.session === undefined) {
        const session = options.defaultSession?.(normalized);
        if (session !== undefined) return { ...normalized, session };
      }
      return normalized;
    },
    async invoke(name, args, context) {
      if (name !== "recall" && name !== "expand" && name !== "sessions") {
        throw new Error(`Unknown memory action: ${name}`);
      }
      context.signal?.throwIfAborted();
      options.check?.();
      const result = await options.dispatch(name, args, context);
      context.signal?.throwIfAborted();
      options.check?.();
      return result;
    },
  };
}
