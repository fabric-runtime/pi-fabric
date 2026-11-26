#!/usr/bin/env node
import { spawn } from "node:child_process";
import module from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDurableWorkerOptions } from "./worker-options.js";
import { durableTypeScriptNodeArgs } from "./node-runtime-options.js";
import { explainMissingInstall } from "../worker/missing-install.js";

try {
  // This process-only entry is never imported by extension registration.
  const options = parseDurableWorkerOptions(process.argv.slice(2));
  if (process.versions.bun) {
    // Bun cannot install Node's peer-resolution hooks. Keep the pinned SDK in
    // the package's required Node 24+ runtime; never inject ambient NODE_PATH.
    const interpreterArgs = process.env.PI_FABRIC_PARENT_RUN && !options.noExtensions && options.extensions.length > 0
      ? durableTypeScriptNodeArgs(process.env.PI_FABRIC_KERNEL)
      : [];
    const child = spawn("node", [...interpreterArgs, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", error => reject(new Error(`Bun-launched durable workers require Node.js 24+ on PATH: ${error.message}`, { cause: error })));
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
    process.exitCode = code;
  } else {
    if (Number.parseInt(process.versions.node, 10) < 24) throw new Error("Durable Pi workers require Node.js 24+");
    // Managed Pi installs omit host peers. A subprocess cannot use Main's virtual
    // modules, so it owns a pinned SDK under a non-peer name. Resolve all Pi peers
    // through that SDK's dependency tree (also with non-hoisting installers), not
    // an ambient checkout or another extension's SDK. This hook is process-local
    // and must be installed before importing any durable host/engine modules.
    const sdkEntry = import.meta.resolve("pi-fabric-worker-sdk");
    const sdkName = "@earendil-works/pi-coding-agent";
    const peers = ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"];
    // The SDK's extension loader gives jiti an alias from "typebox" (and "@sinclair/typebox") to
    // the SDK's require.resolve("typebox") file, and jiti matches aliases as path prefixes. An
    // extension's "typebox/type" therefore arrives here as "<typebox entry file>/type". Resolve
    // exactly that form as "typebox/<subpath>" through the same install's exports map; anything
    // it does not export keeps its original resolution and error. This depends on that alias shape:
    // once the SDK resolves typebox subpaths itself, no specifier carries the prefix and this is inert.
    let typeboxEntry: string | null | undefined;
    const separators = (value: string) => process.platform === "win32" ? value.replaceAll("\\", "/") : value;
    const repairTypeboxAlias = (specifier: string): module.ResolveFnOutput | undefined => {
      if (typeboxEntry === undefined) {
        try { typeboxEntry = module.createRequire(sdkEntry).resolve("typebox"); } catch { typeboxEntry = null; }
      }
      if (!typeboxEntry) return undefined;
      const prefix = `${separators(typeboxEntry)}/`;
      const candidate = separators(specifier);
      if (!candidate.startsWith(prefix) || candidate.length === prefix.length) return undefined;
      try {
        // CommonJS resolution ignores a replaced parentURL, so resolve from a require rooted in the
        // typebox entry file: it self-resolves that install's own exports, never another copy.
        const file = module.createRequire(typeboxEntry).resolve(`typebox/${candidate.slice(prefix.length)}`);
        return { url: pathToFileURL(file).href, shortCircuit: true };
      } catch {
        return undefined;
      }
    };
    module.registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === sdkName || specifier.startsWith(`${sdkName}/`)) {
          return nextResolve(`pi-fabric-worker-sdk${specifier.slice(sdkName.length)}`, { ...context, parentURL: import.meta.url });
        }
        if (peers.some(name => specifier === name || specifier.startsWith(`${name}/`))) {
          return nextResolve(specifier, { ...context, parentURL: sdkEntry });
        }
        const repaired = repairTypeboxAlias(specifier);
        if (repaired) return repaired;
        return nextResolve(specifier, context);
      },
    });
    const { runDurableWorker } = await import("./worker-host.js");
    await runDurableWorker(options);
  }
} catch (caught) {
  const error = explainMissingInstall(caught, import.meta.url);
  process.stderr.write(`Durable Pi worker failed: ${error instanceof Error ? (error === caught ? error.stack ?? error.message : error.message) : String(error)}\n`);
  process.exitCode = 1;
}
