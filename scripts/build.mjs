#!/usr/bin/env node
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";

const primaryEntryPoints = [
  "src/index.ts",
  "src/extension-bootstrap.ts",
  "src/memory.ts",
  "src/mcp.ts",
  "src/agents.ts",
  // Runner adapter registration; never reachable from the extension entry.
  "src/runners.ts",
  // Opt-in durable Pi adapter; never reachable from the extension entry.
  "src/durable.ts",
  "src/jev.ts",
  "src/assessment.ts",
  // Public `pi-fabric/scope`; also the extension's first-use scope parser.
  "src/scope.ts",
  "src/protocol.ts",
  "src/worker.ts",
  // Full Pi-compatible durable process host; never in extension registration.
  "src/durable/worker.ts",
  "src/residency/host.ts",
  "src/residency/launcher.ts",
  "src/residency/pi-entry.ts",
  "src/residency/actor-client.ts",
  "src/compaction/hook.ts",
  "src/core/action-registry.ts",
  "src/entropy/index.ts",
  "src/memory/digest.ts",
  "src/memory/search.ts",
  "src/memory/discovery.ts",
  "src/memory/normalize.ts",
  "src/memory/file-worker.ts",
  "src/memory/worker-provider.ts",
  "src/providers/memory-provider.ts",
  // Standalone `pi-fabric` bin; never reachable from the extension entry.
  "src/cli/index.ts",
];

// Every package-local dynamic import is also an entry point. Its stable output
// path lets a session that loaded the previous index resolve delayed modules
// after the installed package is replaced, while preserving lazy evaluation.
const lazyEntryPoints = [
  "src/durable/worker-host.ts",
  "src/type-error-guidance.ts",
  "src/native-discovery.ts",
  "src/native-tool-catalog.ts",
  "src/native-image-artifacts.ts",
  "src/memory/extractive-history.ts",
  "src/cli/mesh.ts",
  "src/cli/decisions.ts",
  "src/thinking-control.ts",
  "src/compaction/owner.ts",
  "src/compaction/orphan-repair.ts",
  "src/decisions/command.ts",
  "src/programs/host.ts",
  "src/core/provider-operations.ts",
  "src/agents/claude-cli.ts",
  "src/agents/compact-control.ts",
  "src/agents/result.ts",
  "src/agents/veda-cli.ts",
  // Also loaded by the worker as a Pi extension (-e) for confined children.
  "src/agents/write-guard.ts",
  // Also loaded by the worker (-e) so extensions: false children keep
  // extension-registered model providers.
  "src/agents/provider-bridge.ts",
  "src/fabric-runtime-state.ts",
  "src/components/configuration.ts",
  "src/providers/jev-provider.ts",
  "src/jev/client.ts",
  "src/jev/observation.ts",
  "src/jev-fabric/client.ts",
  "src/jev-fabric/registry.ts",
  "src/jev-fabric/operations.ts",
  "src/jev-fabric/resolve.ts",
  "src/jev-fabric/serve.ts",
  "src/runtime/core-override-guest-types.ts",
  "src/runtime/dynamic-guest-types.ts",
  "src/runtime/guest-types.ts",
  "src/runtime/node-process-runtime.ts",
  "src/runtime/typescript-kernel.ts",
  "src/runtime/cpython-runtime.ts",
  "src/runtime/monty-runtime.ts",
  "src/runtime/quickjs-runtime.ts",
  "src/runtime/type-checker.ts",
  "src/speculation/scanner.ts",
  "src/speculation/python-scanner.ts",
  "src/ui/dashboard.ts",
  "src/ui/shell-tasks.ts",
  "src/ui/image-overlays.ts",
  "src/ui/languages/bend.ts",
  "src/ui/conversation.ts",
  "src/ui/conversation-host.ts",
  "src/ui/conversation-targets.ts",
  "src/ui/conversation-chrome.ts",
  "src/ui/conversation-native-reader.ts",
  "src/ui/model-picker.ts",
  "src/ui/settings.ts",
  "src/worker/event-projection.ts",
  "src/worker/model-control.ts",
  "src/worker/options.ts",
  "src/worker/questions.ts",
  "src/worker/recovery-watchdog.ts",
  "src/worker/result.ts",
  "src/worker/run-record.ts",
  "src/worker/session-export.ts",
];

const result = await build({
  entryPoints: [...primaryEntryPoints, ...lazyEntryPoints],
  outdir: "dist",
  outbase: "src",
  entryNames: "[dir]/[name]",
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node24",
  splitting: true,
  sourcemap: true,
  metafile: true,
  logLevel: "info",
});

// tsc does not copy input .d.ts files; ship the generated kernel ABI and receipt.
mkdirSync("dist/verified/generated", { recursive: true });
const receiptPath = "src/verified/generated/manifest.json";
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
for (const source of Object.keys(receipt.outputs)) {
  if (!/^src\/verified\/generated\/[a-z-]+\.(?:js|d\.ts)$/.test(source)) {
    throw new Error(`Unexpected verified artifact path: ${source}`);
  }
  copyFileSync(source, source.replace(/^src\//, "dist/"));
}
copyFileSync(receiptPath, "dist/verified/generated/manifest.json");

const bundledPackages = Object.keys(result.metafile.inputs).filter((input) =>
  input.includes("node_modules/"),
);
if (bundledPackages.length > 0) {
  throw new Error(`Package code was bundled unexpectedly:\n${bundledPackages.join("\n")}`);
}

// Only the standalone worker gets a private, stateless TypeBox validator.
// Pi deliberately omits physical host peers; the extension graph above must
// continue to use Pi's mapped TypeBox, never this isolated artifact.
const workerResult = await build({
  entryPoints: ["src/worker/result.ts"],
  outfile: "dist/worker/result.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  metafile: true,
  banner: { js: "// Worker-only TypeBox validator. MIT (c) 2017-2026 Haydn Paterson; see THIRD_PARTY_NOTICES.md." },
});
for (const input of Object.keys(workerResult.metafile.inputs)) {
  if (input.includes("node_modules/") && !input.includes("node_modules/typebox/")) {
    throw new Error(`Unexpected worker validator dependency: ${input}`);
  }
}
if (Object.values(workerResult.metafile.outputs).some(output => output.imports.length > 0)) {
  throw new Error("Worker validator must be self-contained");
}

const unstableLazyImports = Object.entries(result.metafile.outputs).flatMap(
  ([output, metadata]) =>
    metadata.imports
      .filter(
        (entry) =>
          entry.kind === "dynamic-import" &&
          !entry.external &&
          entry.path.includes("/chunks/"),
      )
      .map((entry) => `${output} -> ${entry.path}`),
);
if (unstableLazyImports.length > 0) {
  throw new Error(
    `Package-local dynamic imports must use stable entry paths:\n${unstableLazyImports.join("\n")}`,
  );
}
