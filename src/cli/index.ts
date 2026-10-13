#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `pi-fabric` out-of-process CLI. A standalone entry: it never imports the
 * extension graph, and each subcommand module loads only when invoked.
 * Subcommands take their remaining argv and return a process exit code.
 */
type FabricCliCommand = (argv: string[]) => Promise<number>;

const commands: Record<string, () => Promise<FabricCliCommand>> = {
  mesh: async () => (await import("./mesh.js")).runMeshCli,
  decisions: async () => (await import("./decisions.js")).runDecisionsCli,
  tune: async () => (await import("./tune.js")).runTuneCli,
};

const usage = (): string => [
  "Usage: pi-fabric <command> [options]",
  "",
  "Commands:",
  ...Object.keys(commands).map((name) => `  ${name}`),
  "",
  "Run `pi-fabric <command> --help` for command options.",
].join("\n");

export async function runFabricCli(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h" || name === "help") {
    process.stdout.write(`${usage()}\n`);
    return name ? 0 : 2;
  }
  const load = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!load) {
    process.stderr.write(`pi-fabric: unknown command ${JSON.stringify(name)}\n${usage()}\n`);
    return 2;
  }
  return (await load())(rest);
}

const invokedPath = process.argv[1];
const isMain = (() => {
  if (!invokedPath) return false;
  try {
    // npm links bins through symlinks; compare canonical paths.
    return fs.realpathSync(path.resolve(invokedPath)) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  try {
    process.exitCode = await runFabricCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`pi-fabric: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
