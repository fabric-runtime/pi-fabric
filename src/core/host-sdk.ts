import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

type PiSdk = typeof import("@earendil-works/pi-coding-agent");

const PI_SDK = "@earendil-works/pi-coding-agent";

const isPiPackage = (root: string): boolean => {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { name?: unknown };
    return manifest.name === PI_SDK;
  } catch {
    return false;
  }
};

const realCliPath = (cliPath: string | undefined): string | undefined => {
  if (!cliPath) return undefined;
  try {
    return fs.realpathSync(cliPath);
  } catch {
    return undefined;
  }
};

/**
 * The SDK entry of the bundled Pi CLI running this process, if it is one. The
 * published `pi` bin is `dist/bundle/cli.js`; its `dist/bundle/index.js` SDK
 * entry is built from the same chunks the CLI has already evaluated.
 */
export function hostBundleSdkEntry(cliPath: string | undefined = process.argv[1]): string | undefined {
  const cli = realCliPath(cliPath);
  if (!cli) return undefined;
  const bundle = path.dirname(cli);
  if (path.basename(cli) !== "cli.js" || path.basename(bundle) !== "bundle") return undefined;
  const entry = path.join(bundle, "index.js");
  return isPiPackage(path.join(bundle, "..", "..")) && fs.existsSync(entry) ? entry : undefined;
}

/**
 * The SDK entry the Pi CLI running this process evaluated: the bundle's entry
 * under the published bin, `dist/index.js` beside an unbundled `dist/cli.js`.
 */
export function hostSdkEntry(cliPath: string | undefined = process.argv[1]): string | undefined {
  const bundled = hostBundleSdkEntry(cliPath);
  if (bundled) return bundled;
  const cli = realCliPath(cliPath);
  if (!cli) return undefined;
  const dist = path.dirname(cli);
  if (path.basename(cli) !== "cli.js" || path.basename(dist) !== "dist") return undefined;
  const entry = path.join(dist, "index.js");
  return isPiPackage(path.join(dist, "..")) && fs.existsSync(entry) ? entry : undefined;
}

// An embedding host (SDK embeds, pi-web) resolves the SDK from its own entry,
// not from Fabric's package. The exports map is ESM-only, so resolve() fails
// with ERR_PACKAGE_PATH_NOT_EXPORTED; resolve.paths() lists the node_modules
// directories Node would search regardless of exports.
const entryRealmSdkEntry = (cliPath: string | undefined): string | undefined => {
  const cli = realCliPath(cliPath);
  if (!cli) return undefined;
  const searchPaths = createRequire(path.join(path.dirname(cli), "probe.js")).resolve.paths(PI_SDK);
  for (const searchPath of searchPaths ?? []) {
    const root = path.join(searchPath, PI_SDK);
    const entry = path.join(root, "dist", "index.js");
    if (isPiPackage(root) && fs.existsSync(entry)) return entry;
  }
  return undefined;
};

/**
 * The host's own SDK. Pi's loader tries a native import first and maps host
 * packages only when that fails, so compiled ESM such as Fabric gets plain Node
 * resolution for every runtime import. Managed installs omit host peers: a bare
 * package import then has nothing on disk to resolve, and where a development
 * peer is on disk it evaluates the separate unbundled SDK inside the bundled
 * CLI: about 1,600 more modules. Besides the startup cost, that CLI enables
 * Node's compile cache, which serializes every one of those modules on exit;
 * with a cold cache that held a Windows child past the worker's exit grace
 * after it had settled. The running CLI's own entry is a module-cache hit
 * instead. The durable worker's resolution hook, mapped hosts (compiled
 * binaries), and embeds supply the package entry.
 */
export async function loadHostSdk(cliPath: string | undefined = process.argv[1]): Promise<PiSdk> {
  const running = hostSdkEntry(cliPath);
  if (running) {
    try {
      return await import(pathToFileURL(running).href) as PiSdk;
    } catch {
      // Unexpected layout: fall back to the package entry.
    }
  }
  // Compiled hosts (the `pi` binary) have no cli.js layout for hostSdkEntry to
  // find, and Pi maps the SDK only for modules it loads itself. The extension
  // entry registers a lazy loader from that mapped realm; use it before the
  // bare import, which a natively loaded lazy chunk cannot resolve.
  const mapped = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-fabric.hostSdkLoader")];
  if (typeof mapped === "function") {
    try {
      return await (mapped as () => Promise<PiSdk>)();
    } catch {
      // Not a mapped host after all: fall back to the package import.
    }
  }
  try {
    return await import("@earendil-works/pi-coding-agent");
  } catch (error) {
    const embedded = entryRealmSdkEntry(cliPath);
    if (embedded) {
      try {
        return await import(pathToFileURL(embedded).href) as PiSdk;
      } catch {
        // Not loadable from this realm either: report the package import.
      }
    }
    throw new Error(
      `Pi Fabric could not load the Pi SDK (${PI_SDK}) of the running host. ` +
      `Run Fabric from the pi CLI, or install ${PI_SDK} matching your Pi version beside the embedding application.`,
      { cause: error },
    );
  }
}
