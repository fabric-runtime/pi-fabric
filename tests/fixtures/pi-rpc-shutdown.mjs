#!/usr/bin/env node
import { fileURLToPath } from "node:url";
const cli = new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url);
process.argv.push("--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "-e", fileURLToPath(new URL("./pi-shutdown-extension.ts", import.meta.url)));
await import(cli.href);
