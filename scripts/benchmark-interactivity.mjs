// Measure Pi's interactivity while fabric_exec runs nested calls, in the real
// bundled CLI inside a Linux pseudo-terminal. A scripted offline model drives
// every turn, so no network, credentials or personal history are involved.
//
//   node scripts/benchmark-interactivity.mjs --variant core|fabric|stack \
//     --pi-cli <pi-coding-agent>/dist/bundle/cli.js --out <dir> \
//     [--turns 30] [--calls 24] [--extensions-file stack.json] [--fabric-config '{...}']
//
// Each turn records wall/CPU time, event-loop delay (the delay a keystroke
// would wait), GC time and heap, and the number of tool updates Pi received.
// The active and idle phases are each CPU-profiled in process and summarized
// by package and by function, so compiler work, nested tool work, update
// serialization, rendering and GC can be told apart.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const variant = option("variant", "fabric");
assert(["core", "fabric", "stack"].includes(variant), "--variant must be core, fabric or stack");
const piCli = path.resolve(option("pi-cli", fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")))));
const out = path.resolve(option("out", `interactivity-${variant}`));
const turns = Number(option("turns", "30"));
const calls = Number(option("calls", "24"));
const idleMs = Number(option("idle-ms", "6000"));
const fabricConfig = JSON.parse(option("fabric-config", "{}"));
// Long-lived machines accumulate a large project mesh state and a large
// machine-wide entropy observation pool; seed synthetic ones of that size.
const seedMeshKb = Number(option("seed-mesh-kb", "0"));
const seedPoolMb = Number(option("seed-pool-mb", "0"));
const repo = fileURLToPath(new URL("../", import.meta.url));
fs.mkdirSync(out, { recursive: true });

function entries(entry) {
  if (fs.statSync(entry).isFile()) return [entry];
  const manifest = path.join(entry, "package.json");
  if (fs.existsSync(manifest)) {
    const paths = JSON.parse(fs.readFileSync(manifest, "utf8")).pi?.extensions;
    if (paths?.length) return paths.flatMap((file) => entries(path.resolve(entry, file)));
  }
  for (const name of ["index.ts", "index.js"]) if (fs.existsSync(path.join(entry, name))) return [path.join(entry, name)];
  return [];
}
const stack = variant === "stack"
  ? JSON.parse(fs.readFileSync(option("extensions-file"), "utf8")).flatMap((entry) => entries(path.resolve(entry)))
  : [];
const fabric = variant === "core" ? [] : entries(repo);

const root = fs.mkdtempSync(path.join(repo, ".interactivity-"));
const work = path.join(root, "work");
const agentDir = path.join(root, "agent");
fs.mkdirSync(path.join(work, "src"), { recursive: true });
fs.mkdirSync(agentDir);
// A small source tree: realistic line lengths, no personal data.
const files = Array.from({ length: 40 }, (_, index) => {
  const file = `src/module-${index}.ts`;
  const body = Array.from({ length: 220 }, (_, line) =>
    `export const value${index}_${line} = (input: string): number => input.length * ${line} + ${index}; // fixture line ${line}`).join("\n");
  fs.writeFileSync(path.join(work, file), `${body}\n`);
  return file;
});

if (seedMeshKb > 0 || seedPoolMb > 0) {
  const { build } = await import("esbuild");
  const bundle = await build({ stdin: { resolveDir: repo, loader: "ts", contents:
    'export { MeshStore } from "./src/mesh/store.ts"; export { updateObservationPoolAsync } from "./src/entropy/pool-store.ts";' },
  bundle: true, platform: "node", format: "esm", packages: "external", write: false, logLevel: "silent" });
  const seedModule = path.join(root, "seed.mjs");
  fs.writeFileSync(seedModule, bundle.outputFiles[0].text);
  const seed = await import(pathToFileURL(seedModule).href);
  const started = Date.now();
  if (seedMeshKb > 0) {
    const mesh = new seed.MeshStore(path.join(work, ".pi/fabric/mesh"), 64 * 1024, 1_000);
    const identity = { id: "session:seed", name: "main", kind: "main", sessionId: "seed" };
    const body = "Synthetic actor instructions for a seeded mesh state. ".repeat(40);
    for (let index = 0; index * 2.4 < seedMeshKb; index++) {
      await mesh.put({ key: `actors/${String(index).padStart(8, "0")}-0000-7000-8000-000000000000/state`, value: { id: index, status: "idle", instructions: body, topics: ["seed"] }, identity });
    }
  }
  if (seedPoolMb > 0) {
    const perSession = Math.ceil((seedPoolMb * 1_000_000) / 16 / 110);
    const windows = Array.from({ length: 16 }, (_, session) => ({ file: `/seed/sessions/session-${session}.jsonl`,
      observations: Array.from({ length: perSession }, (_, index) => ({ ref: `extensions.tool${index % 97}`, key: `path${index % 5}`, value: `src/seed-${session}-${index}.ts` })) }));
    await seed.updateObservationPoolAsync(agentDir, windows);
  }
  const size = (file) => fs.existsSync(file) ? fs.statSync(file).size : 0;
  console.log(JSON.stringify({ type: "seeded", seconds: (Date.now() - started) / 1000,
    meshStateBytes: size(path.join(work, ".pi/fabric/mesh/state.json")),
    poolBytes: size(path.join(agentDir, "fabric/entropy/observation-pool.json")) }));
}

const config = { variant, turns, calls, idleMs, files, results: path.join(out, "turns.jsonl"), profiles: out };
fs.writeFileSync(path.join(root, "bench.json"), JSON.stringify(config));
const benchExtension = path.join(root, "bench-extension.mjs");
fs.writeFileSync(benchExtension, String.raw`
import fs from "node:fs";
import inspector from "node:inspector";
import { syncBuiltinESMExports } from "node:module";
import { monitorEventLoopDelay, PerformanceObserver, performance } from "node:perf_hooks";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

const cfg = JSON.parse(fs.readFileSync(process.env.PI_INTERACTIVITY_CONFIG, "utf8"));
const write = (row) => fs.appendFileSync(cfg.results, JSON.stringify(row) + "\n");
const filesFor = (turn) => Array.from({ length: Math.max(1, cfg.calls - 1) }, (_, index) => cfg.files[(turn * 7 + index) % cfg.files.length]);
const fabricCode = (turn) => [
  "const files = " + JSON.stringify(filesFor(turn)) + ";",
  "let lines = 0;",
  "for (const path of files) {",
  "  const text = await pi.read({ path });",
  "  lines += String(text).split('\\n').length;",
  "}",
  "const listing = await pi.bash({ command: 'seq 1 400' });",
  "console.log('turn " + turn + "', lines);",
  "return { turn: " + turn + ", files: files.length, lines, tail: String(listing).slice(-40) };",
].join("\n");
const response = (turn) => {
  if (turn >= cfg.turns) return fauxAssistantMessage("Synthetic run complete.");
  const text = fauxText("Turn " + turn + ": checking the fixture modules.");
  if (cfg.variant === "core") {
    return fauxAssistantMessage([text, ...filesFor(turn).map((path) => fauxToolCall("read", { path })), fauxToolCall("bash", { command: "seq 1 400" })], { stopReason: "toolUse" });
  }
  return fauxAssistantMessage([text, fauxToolCall("fabric_exec", { code: fabricCode(turn) })], { stopReason: "toolUse" });
};
const core = createFauxCore({ api: "interactivity-bench", provider: "interactivity-bench", models: [{ id: "fixture", contextWindow: 2000000, maxTokens: 4096, input: ["text"] }], tokensPerSecond: 2000 });
core.setResponses(Array.from({ length: cfg.turns + 1 }, (_, turn) => () => response(turn)));

const session = new inspector.Session();
session.connect();
const post = (method, params) => new Promise((resolve, reject) => session.post(method, params ?? {}, (error, value) => error ? reject(error) : resolve(value)));
const startProfile = async () => { await post("Profiler.enable"); await post("Profiler.setSamplingInterval", { interval: 250 }); await post("Profiler.start"); };
const stopProfile = async (name) => { const { profile } = await post("Profiler.stop"); fs.writeFileSync(cfg.profiles + "/" + name + ".cpuprofile", JSON.stringify(profile)); };

// Count synchronous writes by target, so a hot path shows up by name.
const writes = new Map();
for (const name of ["writeFileSync", "renameSync", "fsyncSync", "mkdirSync", "rmSync"]) {
  const original = fs[name];
  fs[name] = function (target, ...rest) {
    const label = name + ":" + String(target).replace(/.*\/(\.pi|sessions|agent)\//, "$1/").replace(/[0-9a-f-]{8,}/g, "*").replace(/\.\d+\.[^/]*\.tmp$/, ".tmp");
    writes.set(label, (writes.get(label) ?? 0) + 1);
    return original.call(this, target, ...rest);
  };
}
syncBuiltinESMExports();
const delay = monitorEventLoopDelay({ resolution: 5 });
delay.enable();
let gcMs = 0, gcCount = 0;
new PerformanceObserver((list) => { for (const entry of list.getEntries()) { gcMs += entry.duration; gcCount++; } }).observe({ entryTypes: ["gc"] });
let window;
const open = () => { delay.reset(); writes.clear(); window = { start: performance.now(), cpu: process.cpuUsage(), gcMs, gcCount, updates: 0, toolMs: 0 }; };
const close = (phase, extra) => {
  const cpu = process.cpuUsage(window.cpu);
  const memory = process.memoryUsage();
  write({ phase, ...extra, wallMs: +(performance.now() - window.start).toFixed(1), cpuMs: +((cpu.user + cpu.system) / 1000).toFixed(1),
    toolMs: +window.toolMs.toFixed(1), updates: window.updates,
    eldP50Ms: +(delay.percentile(50) / 1e6).toFixed(2), eldP99Ms: +(delay.percentile(99) / 1e6).toFixed(2), eldMaxMs: +(delay.max / 1e6).toFixed(2),
    gcMs: +(gcMs - window.gcMs).toFixed(1), gcCount: gcCount - window.gcCount,
    heapMB: +(memory.heapUsed / 1048576).toFixed(1), rssMB: +(memory.rss / 1048576).toFixed(1),
    writes: Object.fromEntries([...writes].sort((a, b) => b[1] - a[1]).slice(0, 12)) });
};

export default function (pi) {
  pi.registerProvider("interactivity-bench", { api: core.api, apiKey: "synthetic", baseUrl: "http://invalid.local",
    models: core.models.map((model) => ({ id: model.id, name: model.name, reasoning: false, input: model.input, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens })),
    streamSimple: core.streamSimple });
  let turn = -1, toolStart = 0, active = false;
  pi.on("agent_start", async () => { if (!active) { active = true; await startProfile(); } });
  pi.on("turn_start", () => { turn++; open(); });
  pi.on("tool_execution_start", () => { toolStart ||= performance.now(); });
  pi.on("tool_execution_update", () => { if (window) window.updates++; });
  pi.on("tool_execution_end", () => { if (toolStart) { window.toolMs += performance.now() - toolStart; toolStart = 0; } });
  pi.on("turn_end", () => { close("turn", { turn }); });
  pi.on("agent_end", async (_event, ctx) => {
    await stopProfile("active");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await startProfile();
    open();
    await new Promise((resolve) => setTimeout(resolve, cfg.idleMs));
    close("idle", {});
    await stopProfile("idle");
    write({ phase: "done" });
    ctx.shutdown();
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
`);

const extensions = [benchExtension, ...fabric, ...stack];
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
  defaultProvider: "interactivity-bench", defaultModel: "fixture", defaultProjectTrust: "never", lastChangelogVersion: "99.0.0",
  quietStartup: true, compaction: { enabled: false },
  extensions: ["-builtin:codemode", "-builtin:tool_search", "-builtin:mcp", ...extensions],
}));
// The user's interactive defaults, minus anything that reaches a network.
fs.writeFileSync(path.join(agentDir, "fabric.json"), JSON.stringify({
  configVersion: 4, fullCodeMode: true,
  ui: { widget: "auto", toolDisplay: "compact" },
  approvals: { read: "allow", write: "allow", execute: "allow", network: "allow", agent: "allow" },
  executor: { runtime: "quickjs", kernel: "typescript" },
  mcp: { enabled: false },
  ...fabricConfig,
}));

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", PI_CODING_AGENT_DIR: agentDir, PI_FABRIC_AGENT_DIR: agentDir,
  PI_OFFLINE: "1", PI_INTERACTIVITY_CONFIG: path.join(root, "bench.json") };
const terminal = path.join(out, "terminal.log");
const command = `stty cols 140 rows 45; exec ${[process.execPath, piCli, "Run the synthetic interactivity workload."].map(quote).join(" ")}`;
fs.rmSync(config.results, { force: true });
let error;
const started = Date.now();
try {
  execFileSync("script", ["-q", "-e", "-c", command, terminal], { cwd: work, env, timeout: 600_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
} catch (caught) { error = String(caught); }
const rows = fs.existsSync(config.results) ? fs.readFileSync(config.results, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
fs.rmSync(root, { recursive: true, force: true });

// Attribute self time to packages and functions.
function summarize(name) {
  const file = path.join(out, `${name}.cpuprofile`);
  if (!fs.existsSync(file)) return undefined;
  const profile = JSON.parse(fs.readFileSync(file, "utf8"));
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const self = new Map();
  const deltas = profile.timeDeltas;
  for (let index = 0; index < profile.samples.length; index++) {
    const ms = (deltas[index + 1] ?? 0) / 1000;
    self.set(profile.samples[index], (self.get(profile.samples[index]) ?? 0) + ms);
  }
  const category = (url, fn) => {
    if (!url) return fn.startsWith("(") ? fn : "(native)";
    if (/typescript\/lib/.test(url)) return "typescript-compiler";
    if (/pi-fabric\/(dist|src)\//.test(url)) return `fabric:${url.replace(/.*pi-fabric\/(dist|src)\//, "").replace(/\/[^/]*$/, "") || "."}`;
    if (/pi-tui/.test(url)) return "pi-tui";
    if (/pi-coding-agent/.test(url)) return "pi-coding-agent";
    if (/pi-agent-core/.test(url)) return "pi-agent-core";
    if (/quickjs/.test(url)) return "quickjs";
    const sibling = /open-source\/([^/]+)\//.exec(url) ?? /\/(pi-[^/]+)\//.exec(url);
    if (sibling) return `ext:${sibling[1]}`;
    if (url.startsWith("node:")) return "node-internal";
    return `other:${url.replace(/^.*node_modules\//, "").split("/").slice(0, 2).join("/")}`;
  };
  const byCategory = new Map();
  const byFunction = new Map();
  const inclusive = new Map();
  let total = 0;
  for (const [id, ms] of self) {
    const node = nodes.get(id);
    const { functionName, url, lineNumber } = node.callFrame;
    const fn = functionName || "(anonymous)";
    const key = category(url, fn);
    total += ms;
    byCategory.set(key, (byCategory.get(key) ?? 0) + ms);
    const label = `${fn} ${url ? url.replace(/^.*node_modules\//, "").replace(/^.*open-source\//, "") : ""}:${lineNumber + 1}`;
    byFunction.set(label, (byFunction.get(label) ?? 0) + ms);
    // Inclusive time per function label along the stack, counted once per sample path.
    const seen = new Set();
    for (let cursor = id; cursor !== undefined; cursor = parent.get(cursor)) {
      const frame = nodes.get(cursor).callFrame;
      const named = `${frame.functionName || "(anonymous)"} ${frame.url ? frame.url.replace(/^.*node_modules\//, "").replace(/^.*open-source\//, "") : ""}:${frame.lineNumber + 1}`;
      if (seen.has(named)) continue;
      seen.add(named);
      inclusive.set(named, (inclusive.get(named) ?? 0) + ms);
    }
  }
  const top = (map, count) => [...map].sort((left, right) => right[1] - left[1]).slice(0, count).map(([key, ms]) => ({ key, ms: +ms.toFixed(1), pct: +((ms / total) * 100).toFixed(1) }));
  return { totalMs: +total.toFixed(1), categories: top(byCategory, 30), selfTop: top(byFunction, 40), inclusiveTop: top(inclusive, 400) };
}
const summary = { variant, turns, calls, seconds: (Date.now() - started) / 1000, completed: rows.some((row) => row.phase === "done"), rows,
  active: summarize("active"), idle: summarize("idle"), ...(error ? { error, terminalTail: fs.existsSync(terminal) ? fs.readFileSync(terminal, "utf8").slice(-3000) : "" } : {}) };
fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`INTERACTIVITY_SUMMARY ${JSON.stringify(summary)}`);
// Remote runs return the raw profiles on stdout: gzip, base64, one line each.
if (args.includes("--emit-profiles")) for (const name of ["active", "idle"]) {
  const file = path.join(out, `${name}.cpuprofile`);
  if (fs.existsSync(file)) console.log(`INTERACTIVITY_PROFILE ${name} ${zlib.gzipSync(fs.readFileSync(file)).toString("base64")}`);
}
const turnRows = rows.filter((row) => row.phase === "turn");
const median = (key, list) => { const sorted = list.map((row) => row[key]).sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
const thirds = [turnRows.slice(1, Math.ceil(turnRows.length / 3)), turnRows.slice(-Math.ceil(turnRows.length / 3))];
console.log(JSON.stringify({ variant, completed: summary.completed, turns: turnRows.length,
  early: thirds[0].length ? Object.fromEntries(["wallMs", "cpuMs", "toolMs", "updates", "eldP99Ms", "eldMaxMs", "gcMs", "heapMB"].map((key) => [key, median(key, thirds[0])])) : null,
  late: thirds[1].length ? Object.fromEntries(["wallMs", "cpuMs", "toolMs", "updates", "eldP99Ms", "eldMaxMs", "gcMs", "heapMB"].map((key) => [key, median(key, thirds[1])])) : null,
  idle: rows.find((row) => row.phase === "idle"), activeCategories: summary.active?.categories.slice(0, 12), ...(error ? { error } : {}) }, null, 1));
assert(!error, error);
assert(summary.completed, "Synthetic workload did not finish");
