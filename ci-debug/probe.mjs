// Usage: node probe.mjs <repo> <mode: bridge|ext|none>
import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { pathToFileURL } from "node:url";
const repo = path.resolve(process.argv[2]); const mode = process.argv[3] ?? "bridge";
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "probe-")); const agentDir = path.join(cwd, "agent");
fs.mkdirSync(agentDir);
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ extensions: [path.join(repo, "tests/fixtures/durable-pi-extension.ts")],
  defaultProvider: "durable-offline", defaultModel: "test", compaction: { enabled: false }, retry: { enabled: false } }));
const cli = path.join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const args = [cli, "--mode", "rpc", "--no-session"];
if (mode !== "ext") args.push("--no-extensions");
if (mode === "bridge") args.push("-e", path.join(repo, process.env.BRIDGE ?? "dist/agents/provider-bridge.js"));
args.push("--tools", "hold_effect", "--model", "durable-offline/test");
const t0 = Date.now(); const ts = () => `${Date.now() - t0}ms`;
const child = spawn(process.execPath, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_CODING_AGENT_DIR: agentDir,
  DURABLE_TEST_FAUX_MODULE: import.meta.resolve ? pathToFileURL(path.join(repo, "node_modules/@earendil-works/pi-ai/dist/providers/faux.js")).href : "",
  DURABLE_TEST_EFFECT: path.join(cwd, "effect"), PI_FABRIC_EXTENSION_MODEL: mode === "bridge" ? "durable-offline/test" : undefined } });
let buf = "";
child.stderr.on("data", d => process.stderr.write(`[stderr ${ts()}] ${d}`));
child.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);
  let e; try { e = JSON.parse(line); } catch { console.log("raw", line.slice(0, 200)); continue; }
  if (e.type === "agent_end") { console.log(ts(), "agent_end -> closing stdin"); child.stdin.end(); }
  else if (["response", "agent_start"].includes(e.type)) console.log(ts(), e.type, e.command ?? "", e.success ?? "", e.error ?? ""); } });
child.on("exit", (c, s) => console.log(ts(), "exit", c, s));
child.on("close", (c) => { console.log(ts(), "close", c); fs.rmSync(cwd, { recursive: true, force: true }); });
child.stdin.write(JSON.stringify({ type: "prompt", message: "hold effect" }) + "\n");
setTimeout(() => { console.log(ts(), "HUNG, killing"); child.kill("SIGKILL"); }, 30000).unref();
