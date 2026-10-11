#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const stable = [
  "index.js",
  "extension-bootstrap.js",
  "memory.js",
  "mcp.js",
  "agents.js",
  "jev.js",
  "protocol.js",
  "scope.js",
  "core/provider-operations.js",
  "worker.js",
  "durable/worker.js",
  "residency/host.js",
  "compaction/hook.js",
  "core/action-registry.js",
  "entropy/index.js",
  "memory/digest.js",
  "memory/search.js",
  "memory/discovery.js",
  "memory/normalize.js",
  "memory/file-worker.js",
  "memory/worker-provider.js",
  "providers/memory-provider.js",
  "cli/index.js",
];
const lazy = [
  "durable/worker-host.js",
  "native-discovery.js",
  "native-tool-catalog.js",
  "native-image-artifacts.js",
  "memory/extractive-history.js",
  "cli/mesh.js",
  "cli/decisions.js",
  "agents/claude-cli.js",
  "agents/compact-control.js",
  "agents/result.js",
  "agents/veda-cli.js",
  "agents/provider-bridge.js",
  "fabric-runtime-state.js",
  "components/configuration.js",
  "providers/jev-provider.js",
  "jev/client.js",
  "jev/observation.js",
  "runtime/core-override-guest-types.js",
  "runtime/dynamic-guest-types.js",
  "runtime/guest-types.js",
  "runtime/node-process-runtime.js",
  "runtime/typescript-kernel.js",
  "runtime/cpython-runtime.js",
  "runtime/monty-runtime.js",
  "runtime/quickjs-runtime.js",
  "runtime/type-checker.js",
  "speculation/scanner.js",
  "speculation/python-scanner.js",
  "ui/dashboard.js",
  "ui/shell-tasks.js",
  "ui/image-overlays.js",
  "ui/languages/bend.js",
  "ui/conversation.js",
  "ui/conversation-host.js",
  "ui/conversation-targets.js",
  "ui/conversation-chrome.js",
  "ui/conversation-native-reader.js",
  "ui/model-picker.js",
  "ui/settings.js",
  "worker/event-projection.js",
  "worker/options.js",
  "worker/recovery-watchdog.js",
  "worker/result.js",
  "worker/run-record.js",
  "worker/session-export.js",
];
const entries = [...stable, ...lazy];
const declarations = entries.map((file) => file.replace(/\.js$/, ".d.ts"));
const required = [
  ...entries,
  ...entries.map((file) => `${file}.map`),
  ...declarations,
  ...declarations.map((file) => `${file}.map`),
];
const missing = required.filter((file) => !existsSync(join(dist, file)));
if (missing.length > 0) throw new Error(`Missing build artifacts:\n${missing.join("\n")}`);

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const targets = (value) => typeof value === "string" ? [value]
  : value && typeof value === "object" ? Object.values(value).flatMap(targets) : [];
for (const target of targets([manifest.main, manifest.types, manifest.exports, manifest.pi?.extensions, manifest.bin])) {
  if (!target.startsWith("./dist/") || target.split("/").includes("..") || !existsSync(join(root, target))) {
    throw new Error(`Missing or unpackaged public entrypoint: ${target}`);
  }
}
const receiptPath = "verified/generated/manifest.json";
const sourceReceipt = readFileSync(join(root, "src", receiptPath));
if (!sourceReceipt.equals(readFileSync(join(dist, receiptPath)))) {
  throw new Error("Bundled verified artifact receipt differs from source");
}
for (const [source, expected] of Object.entries(JSON.parse(sourceReceipt).outputs)) {
  const artifact = source.replace(/^src\//, "dist/");
  const actual = createHash("sha256").update(readFileSync(join(root, artifact))).digest("hex");
  if (actual !== expected) throw new Error(`Bundled verified artifact differs: ${artifact}`);
}

const chunks = join(dist, "chunks");
const chunkFiles = existsSync(chunks)
  ? readdirSync(chunks).filter((file) => file.endsWith(".js"))
  : [];
if (chunkFiles.length === 0) throw new Error("Build did not produce dynamic chunks");
for (const chunk of chunkFiles) {
  if (!existsSync(join(chunks, `${chunk}.map`))) {
    throw new Error(`Missing source map for chunk ${chunk}`);
  }
}

const staticImport = /(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g;
const staticClosure = (roots) => {
  const visited = new Set();
  const stack = [...roots];
  while (stack.length > 0) {
    const file = stack.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(staticImport)) {
      const specifier = match[1];
      if (specifier?.startsWith(".")) stack.push(resolve(dirname(file), specifier));
    }
  }
  return visited;
};

// Bootstrap diagnostics must survive missing runtime dependencies.
for (const file of staticClosure([join(dist, "worker.js"), join(dist, "durable/worker.js")])) {
  for (const match of readFileSync(file, "utf8").matchAll(staticImport)) {
    if (!match[1].startsWith(".") && !match[1].startsWith("node:")) {
      throw new Error(`Worker bootstrap imports an external package: ${match[1]}`);
    }
  }
}
const validator = readFileSync(join(dist, "worker/result.js"), "utf8");
if ([...validator.matchAll(staticImport)].length || /\bimport\s*\(/.test(validator)) {
  throw new Error("Worker validator must be self-contained");
}
// Measure the entry Pi actually loads, including every shared static chunk.
const startupFiles = staticClosure(manifest.pi.extensions.map(file => resolve(root, file)));
const startupBytes = [...startupFiles].reduce((sum, file) => sum + Buffer.byteLength(readFileSync(file)), 0);
if (startupBytes > 1000 * 1024 || startupFiles.size > 41) {
  throw new Error(`Startup static graph grew beyond its budget: ${startupBytes} bytes in ${startupFiles.size} files`);
}
const optionalPackages = ["yaml", "@lezer/python", "shiki", "@shikijs/langs", "@shikijs/themes", "typescript", "mcporter", "jev-fabric", "@earendil-works/pi-durable", "@earendil-works/chord", "pi-fabric-worker-sdk"];
for (const file of startupFiles) {
  for (const match of readFileSync(file, "utf8").matchAll(staticImport)) {
    if (optionalPackages.some(name => match[1] === name || match[1]?.startsWith(`${name}/`))) {
      throw new Error(`Startup eagerly imports optional dependency ${match[1]} from ${file}`);
    }
  }
}
// The operation interpreter must load only when an action is dispatched.
if ([...startupFiles].some(file => /class ProviderOperations|Fabric provider operation denied/.test(readFileSync(file, "utf8")))) {
  throw new Error("Provider operation interpreter escaped into the startup graph");
}

const initialSource = [...startupFiles]
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
for (const forbidden of ["src/native-discovery.ts", "src/memory/extractive-history.ts", "src/memory/extractive-index.ts", "src/entropy/compiler.ts", "src/entropy/trial.ts", "src/fabric-runtime-state.ts", "src/prewalk/handoff.ts", "src/jev/client.ts", "src/ui/languages/bend.ts", "src/ui/settings.ts", "src/ui/conversation.ts", "src/ui/conversation-chrome.ts", "src/ui/image-overlays.ts", "src/ui/kitty-viewport.ts", 'from "mcporter"']) {
  if (initialSource.includes(forbidden)) {
    throw new Error(`Startup static graph contains lazy module marker: ${forbidden}`);
  }
}
// The `pi-fabric` bin is standalone: an executable entry that never loads the extension.
const cliEntry = join(dist, "cli/index.js");
if (!readFileSync(cliEntry, "utf8").startsWith("#!/usr/bin/env node\n")) {
  throw new Error("pi-fabric CLI entry lost its node shebang");
}
for (const file of [...staticClosure([cliEntry]), ...staticClosure([join(dist, "cli/mesh.js")]), ...staticClosure([join(dist, "cli/decisions.js")])]) {
  if (file === join(dist, "index.js") || readFileSync(file, "utf8").includes("src/fabric-runtime-state.ts")) {
    throw new Error(`pi-fabric CLI statically reaches the extension graph: ${file}`);
  }
}
const lazyFiles = staticClosure(lazy.map((file) => join(dist, file)));
const lazySource = [...lazyFiles].map((file) => readFileSync(file, "utf8")).join("\n");
const mandatoryPowerShellFactoryImport =
  /import\s*\{[^}]*\bcreatePowerShellToolDefinition\b[^}]*\}\s*from\s*["']@earendil-works\/pi-coding-agent["']/s;
if (mandatoryPowerShellFactoryImport.test(lazySource)) {
  throw new Error(
    "Optional Pi PowerShell factory must be accessed through the module namespace",
  );
}
for (const expected of ["src/fabric-runtime-state.ts", "src/ui/settings.ts", 'import("mcporter")']) {
  if (!lazySource.includes(expected)) {
    throw new Error(`Expected lazy entry marker not found: ${expected}`);
  }
}

for (const file of entries) {
  const checked = spawnSync(process.execPath, ["--check", join(dist, file)], { encoding: "utf8" });
  if (checked.status !== 0) throw new Error(checked.stderr || `Syntax check failed: ${file}`);
}
await Promise.all(
  stable.filter((file) => file !== "worker.js" && file !== "durable/worker.js").map((file) =>
    import(new URL(`../dist/${file}`, import.meta.url)),
  ),
);
console.log(
  `build artifacts and lazy startup graph verified (${startupFiles.size} startup files, ${startupBytes} startup bytes, ${lazy.length} stable lazy entries, ${chunkFiles.length} chunks)`,
);
