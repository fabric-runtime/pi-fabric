#!/usr/bin/env node
// Full bench for the harness tuner on the quirk depot. One command runs:
//   1. a tuner run for each seed (each seed is a different set of depot rules)
//   2. held-out arms for each seed: learned rules (more runs) and oracle rules
//   3. controls on the first seed: switch off, placebo rules, a full-size file,
//      a different solver model, and a removal test for each learned rule
//   4. a changed server: the rules of the first seed against a different seed
//   5. general tasks that do not use the depot, with the learned rules on and off
// and writes REPORT.md and results.json.
//
//   bun run build && node bench/tuner/bench.mjs --out bench/results/tuner/full
//
// Each step skips itself when its output is there, so a stopped bench continues.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : fallback; };
const out = path.resolve(arg("out", "bench/results/tuner/full"));
const seeds = arg("seeds", "1,2,7").split(",").map(Number);
const driftSeed = Number(arg("drift-seed", "5"));
const SOLVER = arg("model", "litellm/glm-5.3-flash");
const PROPOSER = arg("proposer", "litellm/deepseek-v4.1-flash");
const TRANSFER = arg("transfer-model", "litellm/deepseek-v4.1-flash");
const rounds = arg("rounds", "4");
const candidates = arg("candidates", "4");
const common = ["--concurrency", arg("concurrency", "3"), "--max-tokens", arg("max-tokens", "150000"), "--timeout", "300", "--budget", arg("budget", "15000000")];
const basePort = Number(arg("port", "4750"));
const server = path.join(here, "quirk-server.mjs");
const log = path.join(out, "bench.log");
fs.mkdirSync(out, { recursive: true });
const say = (line) => { fs.appendFileSync(log, `${new Date().toISOString().slice(11, 19)} ${line}\n`); console.log(line); };

// --- processes ---
const children = new Set();
process.on("exit", () => { for (const child of children) child.kill(); });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(1));
const run = (args, logFile) => new Promise((resolve) => {
  const fd = fs.openSync(logFile, "a");
  const child = spawn("node", args, { cwd: root, stdio: ["ignore", fd, fd] });
  children.add(child);
  child.on("close", (code) => { children.delete(child); fs.closeSync(fd); resolve(code); });
});
const tune = (args, logFile) => run([path.join(root, "dist/cli/index.js"), "tune", ...args, ...common], logFile);
const startServer = async (port, seed) => {
  const child = spawn("node", [server, "--port", String(port), "--seed", String(seed)], { stdio: "ignore" });
  children.add(child);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/admin/profile`)).ok) return; } catch { /* not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The quirk server did not start on port ${port}`);
};
const makeDepotTasks = (dir, port) => {
  fs.rmSync(dir, { recursive: true, force: true });
  spawnSync("node", [server, "--make-tasks", dir, "--port", String(port)], { stdio: "inherit" });
};

// --- results ---
const cellsOf = (dir, label) => {
  const base = path.join(dir, "cells", label);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { recursive: true }).filter((file) => path.basename(String(file)) === "result.json")
    .map((file) => JSON.parse(fs.readFileSync(path.join(base, String(file)), "utf8")));
};
const lastVersion = (runDir) => fs.readdirSync(path.join(runDir, "harnesses")).filter((name) => /^v\d+$/.test(name)).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))[0];
const entriesOf = (learned) => learned.split(/\n(?=- )/).map((entry) => entry.trim()).filter((entry) => entry.startsWith("- "));

/** One eval arm in its own directory. Returns the cells. */
const arm = async (dir, tasks, label, { learned = "", off = false, set = "heldout", reps = 2, model = SOLVER } = {}) => {
  const armDir = path.join(dir, "arms", label);
  if (!fs.existsSync(path.join(armDir, "reports", `${label}.md`))) {
    fs.mkdirSync(armDir, { recursive: true });
    fs.writeFileSync(path.join(armDir, "learned.md"), learned);
    say(`${path.basename(dir)}: arm ${label}`);
    await tune(["eval", "--tasks", tasks, "--dir", armDir, "--set", set, "--learned", path.join(armDir, "learned.md"), "--label", label, "--reps", String(reps), "--model", model, ...(off ? ["--off"] : [])], path.join(armDir, "eval.log"));
  }
  return cellsOf(armDir, label);
};

const tuneRun = async (dir, tasks, extra = []) => {
  const runDir = path.join(dir, "run");
  if (!fs.existsSync(path.join(runDir, "summary.md"))) {
    fs.rmSync(runDir, { recursive: true, force: true });
    say(`${path.basename(dir)}: tuner run`);
    await tune(["run", "--tasks", tasks, "--dir", runDir, "--model", SOLVER, "--proposer", PROPOSER, "--rounds", rounds, "--candidates", candidates, ...extra], path.join(dir, "run.log"));
  }
  const version = lastVersion(runDir);
  return { runDir, version, learned: fs.readFileSync(path.join(runDir, "harnesses", version, "learned.md"), "utf8") };
};

// --- control texts ---
const distractor = (index) => `- \`ledger_post_${index}\` field \`ref\`: the batch number, a colon, then the desk code in upper case. Example: batch ${300 + index} at desk qa becomes ${300 + index}:QA.`;
const placebo = `${Array.from({ length: 10 }, (_, index) => distractor(index)).join("\n")}\n`;
/** The learned rules in the middle of unrelated rules, near the 8,000 character limit. */
const bloat = (learned) => {
  const lines = [];
  while (lines.join("\n").length + learned.length + 200 < 7_900) lines.push(distractor(lines.length));
  const half = lines.length >> 1;
  return `${[...lines.slice(0, half), learned.trim(), ...lines.slice(half)].join("\n")}\n`;
};

// --- general tasks: small coding jobs with no depot ---
const nodeCheck = (code) => `node -e ${JSON.stringify(`try { process.exit((() => { ${code} })() ? 0 : 1); } catch { process.exit(1); }`)}`;
const GENERAL = {
  "g1-sum": ["The function in `sum.js` returns a wrong total. Correct it.", { "sum.js": "module.exports = (list) => {\n  let total = 0;\n  for (let i = 1; i < list.length; i++) total += list[i];\n  return total;\n};\n" },
    nodeCheck("const sum = require('./sum.js'); return sum([1, 2, 3]) === 6 && sum([]) === 0 && sum([5]) === 5;")],
  "g2-fizz": ["Create `fizz.js`. It must export one function with `module.exports`. The function gets a number and returns `Fizz` for a multiple of 3, `Buzz` for a multiple of 5, `FizzBuzz` for a multiple of 15, and the number as a string for all other numbers.", {},
    nodeCheck("const fizz = require('./fizz.js'); return fizz(9) === 'Fizz' && fizz(10) === 'Buzz' && fizz(30) === 'FizzBuzz' && fizz(7) === '7';")],
  "g3-log": ["How many lines of `app.log` contain the word `ERROR` in upper case? Write only the number to `answer.txt`.", { "app.log": Array.from({ length: 40 }, (_, i) => `2026-01-${10 + (i % 18)} ${i % 6 === 2 ? "ERROR" : i % 5 === 0 ? "error" : "INFO"} job ${i}`).join("\n") + "\n" },
    `[ "$(tr -d '[:space:]' < answer.txt)" = "7" ]`],
  "g4-config": ["In `config.json`, set `port` to 8080 and add the key `debug` with the value `false`. Do not change the other keys.", { "config.json": '{\n  "name": "depot-ui",\n  "port": 3000,\n  "hosts": ["a.local", "b.local"]\n}\n' },
    nodeCheck("const c = JSON.parse(require('fs').readFileSync('config.json', 'utf8')); return c.port === 8080 && c.debug === false && c.name === 'depot-ui' && c.hosts.length === 2;")],
  "g5-sort": ["Write the lines of `words.txt` to `sorted.txt` in ascending order with no duplicate lines.", { "words.txt": "pear\napple\nfig\npear\nkiwi\napple\nplum\nfig\n" },
    nodeCheck("return require('fs').readFileSync('sorted.txt', 'utf8').trim() === 'apple\\nfig\\nkiwi\\npear\\nplum';")],
  "g6-csv": ["`in.csv` has the columns name, qty, and price. What is the sum of qty times price for all rows? Write only the number with two decimals to `answer.txt`.", { "in.csv": "name,qty,price\nbolt,12,0.35\nnut,40,0.08\nwasher,7,1.20\nrod,3,14.50\n" },
    `[ "$(tr -d '[:space:]' < answer.txt)" = "59.30" ]`],
};
const makeGeneralTasks = (dir) => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [name, [task, files, check]] of Object.entries(GENERAL)) {
    fs.mkdirSync(path.join(dir, name, "fixture"), { recursive: true });
    fs.writeFileSync(path.join(dir, name, "task.md"), `${task}\n`);
    fs.writeFileSync(path.join(dir, name, "check.sh"), `#!/bin/sh\n${check}\n`, { mode: 0o755 });
    // Without this file, Node takes the module type from a package.json above the work directory.
    for (const [file, content] of Object.entries({ "package.json": '{ "type": "commonjs" }\n', ...files })) fs.writeFileSync(path.join(dir, name, "fixture", file), content);
  }
};

// --- statistics and report ---
const mean = (values) => values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
const wilson = (pass, n) => {
  if (n === 0) return [0, 0];
  const z = 1.96, p = pass / n, scale = 1 + z * z / n, center = p + z * z / (2 * n), half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(center - half) / scale, (center + half) / scale];
};
const stats = (cells) => {
  const pass = cells.filter((cell) => cell.pass).length;
  const [low, high] = wilson(pass, cells.length);
  return {
    n: cells.length, pass, rate: cells.length ? pass / cells.length : 0, low, high,
    score: mean(cells.map((cell) => cell.score)), tokens: Math.round(mean(cells.map((cell) => cell.tokens))), wallS: mean(cells.map((cell) => cell.wallS)),
    turns: mean(cells.map((cell) => cell.turns)), toolErrors: mean(cells.map((cell) => cell.toolErrors)),
    stopped: cells.filter((cell) => cell.stopped).length, noModel: cells.filter((cell) => cell.tokens === 0).length,
  };
};
const pct = (value) => `${Math.round(value * 100)}%`;
const HEAD = "| Arm | Runs | Pass | Pass rate (95% interval) | Score | Mean tokens | Mean time | Tool errors | Stopped at a limit |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
const line = (name, cells) => {
  const s = stats(cells);
  return `| ${name} | ${s.n} | ${s.pass} | ${pct(s.rate)} (${pct(s.low)} to ${pct(s.high)}) | ${s.score.toFixed(2)} | ${s.tokens} | ${s.wallS.toFixed(0)} s | ${s.toolErrors.toFixed(1)} | ${s.stopped} |`;
};
const kindOf = (cell) => cell.task.split("-")[1];
const clip = (text, max) => text.length <= max ? text : `${text.slice(0, max)}…`;

const report = (data) => {
  const all = (key) => data.seeds.flatMap((seed) => seed[key]);
  const kinds = [...new Set(all("none").map(kindOf))];
  const text = [
    "# Harness tuner: full bench on the quirk depot",
    "",
    `Solver ${SOLVER}. Proposer ${PROPOSER}. Seeds ${seeds.join(", ")}. ${rounds} rounds, ${candidates} candidates. Total ${(data.totalTokens / 1e6).toFixed(1)} million tokens (cached input included). Runs with no model reply: ${data.noModel}.`,
    "",
    "## 1. Tuner runs",
    "",
    "| Seed | Version | Kept edit | Scoring score | Scoring pass rate | Mean tokens | Rules | Characters |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...data.seeds.flatMap((seed) => seed.curve.map((step) => `| ${seed.seed} | ${step.version} | ${step.kind} (round ${step.round}) | ${step.score} | ${pct(Number(step.passRate))} | ${step.tokens} | ${step.rules} | ${step.chars} |`)),
    "",
    ...data.seeds.map((seed) => `Seed ${seed.seed}: ${seed.candidates} candidates, ${seed.invalid} discarded as invalid, ${(seed.spent / 1e6).toFixed(1)} million tokens.`),
    "",
    "## 2. Held-out tasks, all seeds",
    "",
    "The tuner did not use these tasks. `no rules` is the v0 harness. `oracle` is the complete rule set from the server profile.",
    "",
    HEAD,
    line("no rules", all("heldoutNone")),
    line("learned (tuner)", all("heldoutLearned")),
    line("oracle", all("oracle")),
    "",
    "For each seed:",
    "",
    HEAD,
    ...data.seeds.flatMap((seed) => [line(`seed ${seed.seed}: no rules`, seed.heldoutNone), line(`seed ${seed.seed}: learned`, seed.heldoutLearned), line(`seed ${seed.seed}: oracle`, seed.oracle)]),
    "",
    "## 3. Pass rate for each kind of task",
    "",
    "`no rules` uses the v0 runs on all three task sets. `learned` and `oracle` use the held-out runs.",
    "",
    "| Kind | Depot calls | no rules | learned | oracle |",
    "| --- | --- | --- | --- | --- |",
    ...kinds.map((kind) => {
      const cell = (cells) => { const s = stats(cells.filter((item) => kindOf(item) === kind)); return `${s.pass} of ${s.n}`; };
      return `| ${kind} | ${{ id: 1, stock: 2, price: 2, both: 3, order: 3, compare: 4, total: 4, list: 2 }[kind] ?? ""} | ${cell(all("none"))} | ${cell(all("heldoutLearned"))} | ${cell(all("oracle"))} |`;
    }),
    "",
  ];
  if (data.controls) {
    text.push(`## 4. Controls (seed ${data.seeds[0].seed}, held-out tasks)`, "", HEAD,
      ...Object.entries(data.controls).map(([name, cells]) => line(name, cells)), "");
  }
  if (data.loo) {
    const base = stats(data.seeds[0].heldoutLearned);
    text.push(`## 5. Value of each learned rule (seed ${data.seeds[0].seed}, held-out tasks)`, "",
      `Each row is the learned file without one rule. The full file has a pass rate of ${pct(base.rate)} and a score of ${base.score.toFixed(2)}.`, "",
      "| Removed rule | Runs | Pass rate | Score change | Token change | Kinds that failed |", "| --- | --- | --- | --- | --- | --- |",
      ...data.loo.map(({ rule, cells }) => {
        const s = stats(cells);
        const failed = [...new Set(cells.filter((cell) => !cell.pass).map(kindOf))].join(", ");
        return `| ${clip(rule.replace(/\|/g, "\\|").replace(/\s+/g, " "), 110)} | ${s.n} | ${pct(s.rate)} | ${(s.score - base.score).toFixed(2)} | ${s.tokens - base.tokens >= 0 ? "+" : ""}${s.tokens - base.tokens} | ${failed || "none"} |`;
      }), "");
  }
  if (data.drift) {
    text.push(`## 6. Changed server (rules of seed ${data.seeds[0].seed}, server on seed ${driftSeed})`, "", HEAD,
      line("old rules (stale)", data.drift.stale), line(`after the tuner (${data.drift.version})`, data.drift.repaired), "",
      ...data.drift.curve.map((step) => `- ${step.version}: ${step.kind} (round ${step.round}), scoring score ${step.score}, ${step.rules} rules.`), "");
  }
  if (data.general) {
    text.push("## 7. General tasks with no depot", "", `The learned file of seed ${data.seeds[0].seed} has ${data.seeds[0].learned.length} characters.`, "", HEAD,
      line("learned rules on", data.general.on), line("learned rules off", data.general.off), "",
      `Runs that used the shell: ${data.general.shellOn} of ${data.general.on.length} with the rules on, ${data.general.shellOff} of ${data.general.off.length} with the rules off.`, "");
  }
  text.push("## Learned rules", "", ...data.seeds.flatMap((seed) => [`### Seed ${seed.seed} (${seed.version})`, "", "```", seed.learned.trim(), "```", ""]));
  return text.join("\n");
};

/** Kept versions of one tuner run, from results.csv and the saved harness files. */
const curveOf = (runDir) => {
  const rows = fs.readFileSync(path.join(runDir, "results.csv"), "utf8").trim().split("\n").slice(1).map((row) => row.split(","));
  const curve = rows.filter((row) => row[5] === "true").map(([round, version, , kind, , , score, passRate, tokens]) => {
    const learned = fs.readFileSync(path.join(runDir, "harnesses", version, "learned.md"), "utf8");
    return { round, version, kind, score, passRate, tokens, rules: entriesOf(learned).length, chars: learned.length };
  });
  const spent = Number(/Spent (\d+) tokens/.exec(fs.readFileSync(path.join(runDir, "summary.md"), "utf8"))?.[1] ?? 0);
  return { curve, spent, candidates: rows.length - 1, invalid: rows.filter((row) => row[4] === "false").length };
};

// --- the bench ---
const seedRun = async (seed, index) => {
  const dir = path.join(out, `seed-${seed}`);
  const tasks = path.join(dir, "tasks");
  const port = basePort + index;
  makeDepotTasks(tasks, port);
  await startServer(port, seed);
  const tuned = await tuneRun(dir, tasks);
  const oracleText = spawnSync("node", [server, "--oracle", "--seed", String(seed)], { encoding: "utf8" }).stdout;
  const heldoutNone = cellsOf(tuned.runDir, "heldout-v0");
  const heldoutLearned = [...cellsOf(tuned.runDir, `heldout-${tuned.version}`), ...await arm(dir, tasks, "learned", { learned: tuned.learned })];
  const oracle = await arm(dir, tasks, "oracle", { learned: oracleText });
  return { seed, dir, tasks, ...tuned, ...curveOf(tuned.runDir), none: [...cellsOf(tuned.runDir, "v0"), ...heldoutNone], heldoutNone, heldoutLearned, oracle };
};

const controls = async (first) => ({
  "learned rules, `tuner.enabled` false": await arm(first.dir, first.tasks, "off", { learned: first.learned, off: true }),
  "placebo: 10 unrelated rules": await arm(first.dir, first.tasks, "placebo", { learned: placebo }),
  "learned rules in a full-size file": await arm(first.dir, first.tasks, "bloat", { learned: bloat(first.learned) }),
  [`solver ${TRANSFER}, no rules`]: await arm(first.dir, first.tasks, "transfer-none", { model: TRANSFER }),
  [`solver ${TRANSFER}, learned rules`]: await arm(first.dir, first.tasks, "transfer-learned", { learned: first.learned, model: TRANSFER }),
});

const leaveOneOut = async (first) => {
  const result = [];
  for (const [index, rule] of entriesOf(first.learned).slice(0, 14).entries()) {
    result.push({ rule, cells: await arm(first.dir, first.tasks, `without-${index + 1}`, { learned: first.learned.replace(rule, "") }) });
  }
  return result;
};

const drift = async (first) => {
  const dir = path.join(out, "drift");
  const tasks = path.join(dir, "tasks");
  const port = basePort + 10;
  makeDepotTasks(tasks, port);
  await startServer(port, driftSeed);
  const init = path.join(dir, "stale.md");
  fs.writeFileSync(init, first.learned);
  const tuned = await tuneRun(dir, tasks, ["--init", init]);
  return {
    version: tuned.version, ...curveOf(tuned.runDir),
    stale: [...cellsOf(tuned.runDir, "heldout-v0"), ...await arm(dir, tasks, "stale", { learned: first.learned })],
    repaired: [...cellsOf(tuned.runDir, `heldout-${tuned.version}`), ...await arm(dir, tasks, "repaired", { learned: tuned.learned })],
  };
};

const general = async (first) => {
  const dir = path.join(out, "general");
  const tasks = path.join(dir, "tasks");
  makeGeneralTasks(tasks);
  // A learned rule about one suite can change the habits of the agent in all sessions, so count the shell use.
  const shell = (label) => fs.readdirSync(path.join(dir, "arms", label, "cells"), { recursive: true })
    .filter((file) => path.basename(String(file)) === "transcript.md" && fs.readFileSync(path.join(dir, "arms", label, "cells", String(file)), "utf8").includes("pi.bash")).length;
  const on = await arm(dir, tasks, "general-on", { learned: first.learned, set: "all", reps: 3 });
  const off = await arm(dir, tasks, "general-off", { learned: first.learned, set: "all", reps: 3, off: true });
  return { on, off, shellOn: shell("general-on"), shellOff: shell("general-off") };
};

if (arg("make-general")) {
  makeGeneralTasks(path.resolve(arg("make-general")));
  process.exit(0);
}
const runs = seeds.map((seed, index) => seedRun(seed, index));
const skip = new Set(arg("skip", "").split(","));
// A failed extra step must not stop the tuner runs of the other chains.
const step = (name, work) => skip.has(name) ? undefined : work().catch((error) => { say(`step ${name} failed: ${error?.stack ?? error}`); return undefined; });
// Three chains at the same time: each seed run, then the extra arms of the first seed.
const [seedData, controlData, looData, tail] = await Promise.all([
  Promise.all(runs),
  runs[0].then((first) => step("controls", () => controls(first))),
  Promise.all(runs.slice(0, 2)).then(([first]) => step("loo", () => leaveOneOut(first))),
  Promise.all([runs[0], runs.at(-1)]).then(async ([first]) => ({ drift: await step("drift", () => drift(first)), general: await step("general", () => general(first)) })),
]);
const data = { seeds: seedData, controls: controlData, loo: looData, ...tail };
const everyCell = [];
JSON.stringify(data, (_key, value) => { if (value && typeof value === "object" && "task" in value && "tokens" in value) everyCell.push(value); return value; });
const armTokens = [...new Set(everyCell)].reduce((sum, cell) => sum + cell.tokens, 0);
// A tuner run counts its own cells and proposer calls up to the held-out step; the v0 cells are in both sums.
data.totalTokens = armTokens + [...seedData, ...(data.drift ? [data.drift] : [])].reduce((sum, item) => sum + item.spent, 0) - seedData.flatMap((seed) => cellsOf(seed.runDir, "v0")).reduce((sum, cell) => sum + cell.tokens, 0);
data.noModel = [...new Set(everyCell)].filter((cell) => cell.tokens === 0).length;
fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(data, (key, value) => key === "checkOutput" ? undefined : value, 1));
fs.writeFileSync(path.join(out, "REPORT.md"), report(data));
say(`Report: ${path.join(out, "REPORT.md")}`);
process.exit(0);
