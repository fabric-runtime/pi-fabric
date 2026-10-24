// Pi's registration entry excludes the public audit/entropy library barrels.
// Register the real tool and lifecycle hooks; never hide work in a background import.
import { createFabricExtension } from "./extension.js";
export { FABRIC_MANAGED_HOST_VERSION } from "./extension.js";
export type { FabricManagedHostOptions } from "./managed-host.js";
// Compiled Pi binaries expose the SDK only to modules Pi itself loads, so lazy
// chunks cannot import it by name. Register a loader from this entry for
// loadHostSdk (src/core/host-sdk.ts); nothing is imported until first use.
(globalThis as Record<symbol, unknown>)[Symbol.for("pi-fabric.hostSdkLoader")] ??= () =>
  import("@earendil-works/pi-coding-agent");
export default createFabricExtension(import.meta.url);
