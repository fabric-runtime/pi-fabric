import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveAgentDir } from "../core/agent-dir.js";
import { looksFailed } from "./capture.js";
import { MAX_LEARNED_CHARS, MAX_LEARNED_LINES } from "./learned.js";

// Harness tuner (after "Harness Learning Enables Generalizable Test-Time
// Adaptation", arXiv 2609.35738, without the trained writer). The harness is
// the learned rules file. A rule writer model (the rule writer of the paper) edits it from an execution report,
// and an edit stays only when the scoring tasks confirm it.
//
// ponytail: a cell is a fresh directory plus an isolated agent dir, not a
// container. Run only tasks you wrote; add a container when tasks replay real
// user prompts.

export interface TunerOptions {
  tasksDir: string;
  dir: string;
  /** Main model `provider/model`: the model that does the tasks with the harness. */
  model: string;
  /** Rule writer `provider/model`: the model that edits the harness. */
  writer: string;
  rounds: number;
  candidates: number;
  reps: number;
  concurrency: number;
  timeoutS: number;
  maxTokensPerTask: number;
  budgetTokens: number;
  budgetUsd: number;
  pi: string;
  fabricRoot: string;
  log: (line: string) => void;
}

export interface Harness {
  label: string;
  learned: string;
  /** `tuner.enabled` in the cell's fabric.json. */
  enabled: boolean;
}

export interface CellResult {
  task: string;
  rep: number;
  pass: boolean;
  score: number;
  checkOutput: string;
  tokens: number;
  cost: number;
  wallS: number;
  turns: number;
  toolErrors: number;
  stopped?: "timeout" | "tokens";
  transcript: string;
  /** Only the failed tool steps, each with its call. */
  errors: string;
}

export interface Score {
  score: number;
  passRate: number;
  /** Mean tokens for each cell. */
  tokens: number;
  perTask: Record<string, number>;
}

interface PiMessage {
  role: string;
  content?: unknown;
  isError?: boolean;
  usage?: { totalTokens?: number; cost?: { total?: number } };
  errorMessage?: string;
}

class BudgetStop extends Error {}

const EPS = 0.01;
/** The loop stops after this number of rounds in sequence with no kept edit. */
const NO_GAIN_ROUNDS = 2;
/** At this scoring score and above, a round uses half of its candidates. */
const FEW_CANDIDATES_SCORE = 0.8;
const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}… [+${text.length - max} chars]`;
const headTail = (text: string, max: number): string =>
  text.length <= max
    ? text
    : `${text.slice(0, Math.floor(max * 0.6))}\n… [${text.length - max} chars omitted] …\n${text.slice(text.length - Math.floor(max * 0.4))}`;
const mean = (values: number[]): number => values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
const readJson = (file: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
};

// --- task suite ---

export interface Suite {
  description: string;
  sets: Record<"feedback" | "scoring" | "heldout", string[]>;
}

export const splitTasks = (names: string[], splits?: Record<string, unknown>): Suite["sets"] => {
  const sets: Suite["sets"] = { feedback: [], scoring: [], heldout: [] };
  const keys = Object.keys(sets) as Array<keyof Suite["sets"]>;
  if (splits) {
    for (const key of keys) sets[key] = Array.isArray(splits[key]) ? (splits[key] as unknown[]).map(String) : [];
  } else {
    [...names].sort().forEach((name, index) => sets[keys[index % 3]!].push(name));
  }
  const all = keys.flatMap((key) => sets[key]);
  if (new Set(all).size !== all.length) throw new Error("The feedback, scoring, and heldout sets must be disjoint");
  const unknown = all.filter((name) => !names.includes(name));
  if (unknown.length > 0) throw new Error(`splits.json names unknown tasks: ${unknown.join(", ")}`);
  for (const key of keys) if (sets[key].length === 0) throw new Error(`The ${key} set is empty`);
  return sets;
};

const loadSuite = (tasksDir: string): Suite => {
  const names = fs.readdirSync(tasksDir).filter((name) => fs.existsSync(path.join(tasksDir, name, "task.md")));
  if (names.length < 3) throw new Error(`${tasksDir} needs at least 3 tasks (directories with task.md and check.sh)`);
  let description = `${names.length} tasks. Each task has a prompt and a check script.`;
  try { description = fs.readFileSync(path.join(tasksDir, "SUITE.md"), "utf8").trim(); } catch { /* optional */ }
  return { description, sets: splitTasks(names, readJson(path.join(tasksDir, "splits.json"))) };
};

// --- learned rules: bullets, edits, bounds ---

/** Each top-level `- ` bullet with its continuation lines is one entry. */
export const entriesOf = (learned: string): string[] => {
  const entries: string[] = [];
  let current: string[] | undefined;
  for (const line of learned.split("\n")) {
    if (line.startsWith("- ")) {
      if (current) entries.push(current.join("\n"));
      current = [line];
    } else if (current && line.trim() && !line.startsWith("#")) {
      current.push(line);
    } else if (current) {
      entries.push(current.join("\n"));
      current = undefined;
    }
  }
  if (current) entries.push(current.join("\n"));
  return entries;
};
const entryId = (entry: string): string => crypto.createHash("sha1").update(entry.trim()).digest("hex").slice(0, 8);
const normalizeLearned = (text: string): string => {
  const trimmed = text.replace(/\n{3,}/g, "\n\n").trim();
  return trimmed ? `${trimmed}\n` : "";
};
export const removeEntry = (learned: string, entry: string): string =>
  normalizeLearned(learned.replace(learned.includes(`${entry}\n`) ? `${entry}\n` : entry, () => ""));

const NO_CHANGE = "the rule writer declared no change";

export type EditResult =
  | { ok: true; learned: string; diagnosis: string }
  | { ok: false; reason: string; diagnosis: string };

const EDIT_BLOCK = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n?=======\r?\n([\s\S]*?)\r?\n?>>>>>>> REPLACE/g;

/** Apply the rule writer's SEARCH/REPLACE blocks. An empty SEARCH appends. */
export const applyEdits = (parent: string, response: string): EditResult => {
  const diagnosis = clip((/DIAGNOSIS:\s*([\s\S]*?)(?=<<<<<<< SEARCH|NO_CHANGE|$)/.exec(response)?.[1] ?? "").trim(), 600);
  const blocks = [...response.matchAll(EDIT_BLOCK)];
  if (blocks.length === 0) return { ok: false, reason: /NO_CHANGE/.test(response) ? NO_CHANGE : "no edit block", diagnosis };
  let learned = parent;
  for (const [, search = "", replace = ""] of blocks) {
    if (!search.trim()) learned = `${learned.trimEnd()}\n${replace}\n`;
    else if (!learned.includes(search)) return { ok: false, reason: `SEARCH text is not in the file: ${clip(search, 80)}`, diagnosis };
    else learned = learned.replace(search, () => replace);
  }
  learned = normalizeLearned(learned);
  // A reply that leaves out the end of a block puts the markers of the next block into the replacement text.
  if (/^(<<<<<<< SEARCH|=======|>>>>>>> REPLACE)\s*$/m.test(learned)) return { ok: false, reason: "an edit block has no end marker, so its markers are in the new text", diagnosis };
  if (learned === normalizeLearned(parent)) return { ok: false, reason: "edit changes nothing", diagnosis };
  if (learned.length > MAX_LEARNED_CHARS || learned.split("\n").length > MAX_LEARNED_LINES) {
    return { ok: false, reason: `file is above the limit of ${MAX_LEARNED_LINES} lines or ${MAX_LEARNED_CHARS} characters`, diagnosis };
  }
  return { ok: true, learned, diagnosis };
};

/** One more rule writer call for a reply that Fabric cannot apply. `ask` gets the prompt and returns the reply. */
export const proposeEdit = async (parent: string, prompt: string, ask: (prompt: string) => Promise<string>): Promise<string> => {
  const response = await ask(prompt);
  const edit = applyEdits(parent, response);
  if (edit.ok || edit.reason === NO_CHANGE || !response.trim()) return response;
  return ask(`${prompt}\n# Your earlier reply\n${clip(response, 4_000)}\n\nFabric discarded that reply: ${edit.reason}. Reply again in the output format. SEARCH must be exact text from the current learned.md.\n`);
};

// --- scores and selection ---

export const summarize = (results: CellResult[]): Score => {
  const byTask = new Map<string, number[]>();
  for (const result of results) byTask.set(result.task, [...(byTask.get(result.task) ?? []), result.score]);
  return {
    score: mean(results.map((result) => result.score)),
    passRate: mean(results.map((result) => result.pass ? 1 : 0)),
    tokens: Math.round(mean(results.map((result) => result.tokens))),
    perTask: Object.fromEntries([...byTask].map(([task, scores]) => [task, mean(scores)])),
  };
};

/** A candidate wins on a higher score, or on the same score with at least 10% fewer tokens. */
export const beats = (candidate: Score, parent: Score): boolean =>
  candidate.score > parent.score + EPS ||
  // At a score of 0, fewer tokens only shows that the agent stops earlier, so it is not a win.
  (candidate.score > EPS && Math.abs(candidate.score - parent.score) <= EPS && candidate.tokens < parent.tokens * 0.9);

// --- transcript and report ---

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((block) => (block as { type?: string; text?: string }).type === "text" ? (block as { text?: string }).text ?? "" : "").join("")
      : "";

/** One line for each step. A result is an error when Pi marks it or when it starts with an error word. */
export const renderTranscript = (messages: PiMessage[]): { text: string; errors: string; turns: number; toolErrors: number } => {
  const lines: string[] = [];
  const errors: string[] = [];
  const oneLine = (text: string, max: number) => clip(text.replace(/\s+/g, " ").trim(), max);
  let turns = 0;
  for (const message of messages) {
    if (message.role === "assistant") {
      turns += 1;
      for (const block of Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : []) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) lines.push(`AGENT: ${oneLine(block.text, 300)}`);
        if (block.type === "toolCall") {
          const args = (block.arguments ?? {}) as Record<string, unknown>;
          lines.push(`CALL ${String(block.name)}: ${oneLine(typeof args.code === "string" ? args.code : JSON.stringify(args), 400)}`);
        }
      }
    } else if (message.role === "toolResult") {
      const text = textOf(message.content);
      const failed = looksFailed(text, message.isError === true);
      lines.push(`${failed ? "ERROR" : "RESULT"}: ${oneLine(text, failed ? 320 : 240)}`);
      if (failed) errors.push(...lines.slice(lines.at(-2)?.startsWith("CALL") ? -2 : -1));
    }
  }
  return { text: headTail(lines.join("\n"), 12_000), errors: errors.join("\n"), turns, toolErrors: errors.filter((line) => line.startsWith("ERROR")).length };
};

/** The rules that an edit removes and adds. */
export const diffEntries = (before: string, after: string): string => {
  const [old, next] = [entriesOf(before), entriesOf(after)];
  return [
    ...old.filter((entry) => !next.includes(entry)).map((entry) => `Remove:\n${entry}`),
    ...next.filter((entry) => !old.includes(entry)).map((entry) => `Add:\n${entry}`),
  ].join("\n\n");
};

/** Markdown report for the writer, at most `maxChars` (about 6k tokens by default). */
export const buildReport = (label: string, results: CellResult[], maxChars = 24_000): string => {
  const total = summarize(results);
  const worst = new Map<string, CellResult>();
  for (const result of results) {
    const seen = worst.get(result.task);
    if (!seen || result.score < seen.score) worst.set(result.task, result);
  }
  const header = [
    `# Execution report: harness ${label}`,
    "",
    `Pass rate ${(total.passRate * 100).toFixed(0)}% (${results.filter((result) => result.pass).length} of ${results.length} runs). Mean score ${total.score.toFixed(2)}. Mean tokens for each run ${total.tokens}.`,
    "",
    "| Task | Result | Score | Tokens | Tool errors | Stopped |",
    "| --- | --- | --- | --- | --- | --- |",
    ...results.map((result) => `| ${result.task} | ${result.pass ? "pass" : "FAIL"} | ${result.score.toFixed(2)} | ${result.tokens} | ${result.toolErrors} | ${result.stopped ?? ""} |`),
    "",
  ].join("\n");
  // Failures first, then passes that wasted calls on errors.
  const shown = [...worst.values()]
    .filter((result) => !result.pass || result.toolErrors > 0)
    .sort((a, b) => a.score - b.score || b.toolErrors - a.toolErrors);
  const each = Math.min(5_000, Math.floor((maxChars - header.length) / Math.max(1, shown.length)) - 200);
  const block = (title: string, text: string, max: number) => [title, "```", headTail(text, Math.max(400, max)), "```"];
  const sections = shown.map((result) => [
    `## ${result.task}: ${result.pass ? `pass with ${result.toolErrors} tool errors` : "FAIL"}`,
    `Check output: ${clip(result.checkOutput.trim() || "(none)", 300)}`,
    // A failed run also shows its transcript: a call can succeed and still return
    // data that the task cannot use, and only the successful results show that.
    ...(result.errors ? block("Failed tool steps, in order:", result.errors, result.pass ? each : each / 2) : []),
    ...(result.pass ? [] : block("Transcript excerpt:", result.transcript, result.errors ? each / 2 : each)),
    "",
  ].join("\n"));
  return `${header}\n${sections.join("\n")}`.slice(0, maxChars);
};

// --- Pi process ---

interface PiRun {
  messages: PiMessage[];
  tokens: number;
  cost: number;
  stopped?: "timeout" | "tokens";
  stderrTail: string;
  /** The provider error of the last assistant message. */
  error?: string;
}

interface PiRunOptions { cwd: string; agentDir: string; timeoutMs: number; maxTokens: number; noReplyTries?: number }

// A run with no model reply is a failure of the provider and not a result of the harness.
// ponytail: at most 20 tries with a pause of 1 to 5 minutes (about 100 minutes); the run keeps 0 tokens after that.
const NO_REPLY_TRIES = 20;
const NO_REPLY_PAUSE_MS = Number(process.env.PI_FABRIC_TUNE_RETRY_MS ?? 60_000);

const runPi = async (pi: string, args: string[], input: string, options: PiRunOptions): Promise<PiRun> => {
  for (let attempt = 1; ; attempt += 1) {
    const run = await runPiOnce(pi, args, input, options);
    if (run.tokens > 0 || attempt >= (options.noReplyTries ?? NO_REPLY_TRIES)) return run;
    const reason = (run.error ?? run.stderrTail).trim();
    // A rate limit gives its own time ("Try again in 2572 seconds"). The time can be longer than the real stop, so wait at most 5 minutes for each try.
    const pause = Math.min(Math.max(300_000, NO_REPLY_PAUSE_MS), Math.max(NO_REPLY_PAUSE_MS, 1000 * Number(/try again in (\d+) seconds/i.exec(reason)?.[1] ?? 0)));
    process.stderr.write(`  no model reply (${clip(reason || "no error text", 200)}). Try ${attempt + 1} in ${Math.round(pause / 1000)} s.\n`);
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
};

// The live child processes, and each agent directory with copied credentials.
const children = new Set<ChildProcess>();
const agentDirs = new Set<string>();

/** Stop each live run and delete the copied credentials. For a signal handler: a `finally` block does not run after `process.exit`. */
export const stopRuns = (): void => {
  for (const child of children) {
    try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
  for (const agentDir of agentDirs) fs.rmSync(agentDir, { recursive: true, force: true });
};

const runPiOnce = (
  pi: string,
  args: string[],
  input: string,
  options: PiRunOptions,
): Promise<PiRun> => new Promise((resolve) => {
  const child = spawn(pi, ["--mode", "json", "--no-session", "--no-prompt-templates", "--no-context-files", "--no-themes", ...args], {
    cwd: options.cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: options.agentDir, PI_SKIP_VERSION_CHECK: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  children.add(child);
  const run: PiRun = { messages: [], tokens: 0, cost: 0, stderrTail: "" };
  const stop = (reason: "timeout" | "tokens") => {
    run.stopped ??= reason;
    try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  };
  const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
  let buffer = "";
  // The stream is LF-framed JSONL; readline would also split on Unicode separators.
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.includes('"message_end"')) continue;
      let event: { type?: string; message?: PiMessage };
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type !== "message_end" || !event.message) continue;
      run.messages.push(event.message);
      if (event.message.role === "assistant") {
        run.tokens += event.message.usage?.totalTokens ?? 0;
        run.cost += event.message.usage?.cost?.total ?? 0;
        if (event.message.errorMessage) run.error = event.message.errorMessage;
        if (run.tokens > options.maxTokens) stop("tokens");
      }
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { run.stderrTail = (run.stderrTail + chunk).slice(-600); });
  child.on("error", (error) => { run.stderrTail = String(error); });
  child.on("close", () => { clearTimeout(timer); children.delete(child); resolve(run); });
  child.stdin.on("error", () => { /* the child can exit before it reads stdin */ });
  child.stdin.end(input);
});

/** Isolated agent dir: only the model credentials, the cell's Fabric config, and the learned rules. */
const writeAgentDir = (agentDir: string, models: string[], fabric?: Record<string, unknown>, learned?: string): void => {
  const source = resolveAgentDir();
  const providers = new Set(models.map((model) => model.split("/")[0]!));
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  agentDirs.add(agentDir);
  const keep = (value: unknown): Record<string, unknown> =>
    Object.fromEntries(Object.entries((value ?? {}) as Record<string, unknown>).filter(([name]) => providers.has(name)));
  const modelsJson = readJson(path.join(source, "models.json"));
  if (modelsJson) fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: keep(modelsJson.providers) }), { mode: 0o600 });
  const authJson = readJson(path.join(source, "auth.json"));
  if (authJson) fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify(keep(authJson)), { mode: 0o600 });
  if (fabric) fs.writeFileSync(path.join(agentDir, "fabric.json"), JSON.stringify(fabric));
  if (learned?.trim()) {
    fs.mkdirSync(path.join(agentDir, "fabric", "tuner"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "fabric", "tuner", "learned.md"), learned);
  }
};

/** One rule writer call from an agent dir that holds only the rule writer's credentials. */
export const askWriter = async (pi: string, writer: string, agentDir: string, prompt: string, noReplyTries?: number): Promise<PiRun & { text: string }> => {
  writeAgentDir(agentDir, [writer]);
  try {
    const run = await runPi(pi, [
      "--no-tools", "--no-extensions", "--no-skills", "--model", writer,
      "--system-prompt", "You revise the instruction file of a coding agent. Reply in the exact format that the user requests.",
    ], prompt, { cwd: agentDir, agentDir, timeoutMs: 300_000, maxTokens: 200_000, ...(noReplyTries === undefined ? {} : { noReplyTries }) });
    return { ...run, text: textOf(run.messages.filter((message) => message.role === "assistant").at(-1)?.content) };
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
};

const mapPool = async <T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: unknown;
  // On a failure (a budget stop), start no new item and let the active ones finish.
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && failure === undefined) {
      const index = next++;
      try { results[index] = await work(items[index]!); } catch (error) { failure ??= error; }
    }
  }));
  if (failure !== undefined) throw failure;
  return results;
};

// --- the tuner ---

export class Tuner {
  readonly suite: Suite;
  spentTokens = 0;
  spentUsd = 0;
  private cellCount = 0;

  constructor(readonly options: TunerOptions) {
    this.suite = loadSuite(options.tasksDir);
    fs.mkdirSync(options.dir, { recursive: true });
  }

  private spend(run: PiRun): void {
    this.spentTokens += run.tokens;
    this.spentUsd += run.cost;
  }

  private checkBudget(): void {
    const { budgetTokens, budgetUsd } = this.options;
    if ((budgetTokens > 0 && this.spentTokens >= budgetTokens) || (budgetUsd > 0 && this.spentUsd >= budgetUsd)) {
      throw new BudgetStop(`Budget reached: ${this.spentTokens} tokens, $${this.spentUsd.toFixed(4)}`);
    }
  }

  private async runCell(task: string, harness: Harness, rep: number): Promise<CellResult> {
    this.checkBudget();
    const { options } = this;
    const taskDir = path.resolve(options.tasksDir, task);
    const cellId = `${harness.label}-${task}-r${rep}-${(this.cellCount++).toString(36)}${crypto.randomBytes(2).toString("hex")}`;
    const cellDir = path.join(options.dir, "cells", harness.label, task, `rep${rep}`);
    fs.rmSync(cellDir, { recursive: true, force: true });
    const work = path.join(cellDir, "work");
    const agentDir = path.join(cellDir, "agent");
    fs.mkdirSync(work, { recursive: true });
    if (fs.existsSync(path.join(taskDir, "fixture"))) fs.cpSync(path.join(taskDir, "fixture"), work, { recursive: true });
    const env = { ...process.env, TUNER_CELL: cellId, TUNER_CELL_DIR: cellDir };
    const started = Date.now();
    const result: CellResult = { task, rep, pass: false, score: 0, checkOutput: "", tokens: 0, cost: 0, wallS: 0, turns: 0, toolErrors: 0, transcript: "", errors: "" };
    const setup = path.join(taskDir, "setup.sh");
    const setupRun = fs.existsSync(setup) ? spawnSync("sh", [setup], { cwd: work, env, timeout: 120_000, encoding: "utf8" }) : undefined;
    const save = (): CellResult => {
      result.wallS = Math.round((Date.now() - started) / 100) / 10;
      fs.writeFileSync(path.join(cellDir, "transcript.md"), result.transcript);
      fs.writeFileSync(path.join(cellDir, "result.json"), JSON.stringify({ ...result, transcript: undefined, errors: undefined, cell: cellId }, null, 2));
      options.log(`  ${harness.label} ${task} rep${rep}: ${result.pass ? "pass" : "FAIL"} score ${result.score.toFixed(2)} tokens ${result.tokens} ${result.wallS}s${result.stopped ? ` (${result.stopped})` : ""}`);
      return result;
    };
    if (setupRun && setupRun.status !== 0) {
      result.checkOutput = `setup.sh failed: ${clip(`${setupRun.stdout}${setupRun.stderr}`, 400)}`;
      result.transcript = result.checkOutput;
      return save();
    }
    // Every cell gets its own MCP config, so a suite server can tell the cells apart.
    const mcporter = path.join(agentDir, "mcporter.json");
    let mcpConfig = '{"mcpServers":{}}';
    try { mcpConfig = fs.readFileSync(path.join(options.tasksDir, "mcporter.json"), "utf8").replaceAll("{{CELL}}", cellId); } catch { /* no suite servers */ }
    const suiteFabric = readJson(path.join(options.tasksDir, "fabric.json")) ?? {};
    writeAgentDir(agentDir, [options.model], {
      ...suiteFabric,
      mcp: { ...(suiteFabric.mcp as Record<string, unknown> | undefined), configPath: mcporter },
      // A cell only reads the candidate rules: no capture, so no suggestion starts inside a run.
      tuner: { enabled: harness.enabled, capture: false },
    }, harness.learned);
    fs.writeFileSync(mcporter, mcpConfig);
    try {
      const run = await runPi(options.pi, ["--model", options.model, "-e", options.fabricRoot], fs.readFileSync(path.join(taskDir, "task.md"), "utf8"), {
        cwd: work,
        agentDir,
        timeoutMs: options.timeoutS * 1000,
        maxTokens: options.maxTokensPerTask,
      });
      this.spend(run);
      const transcript = renderTranscript(run.messages);
      const check = spawnSync("sh", [path.join(taskDir, "check.sh")], { cwd: work, env, timeout: 120_000, encoding: "utf8" });
      const output = `${check.stdout ?? ""}${check.stderr ?? ""}`;
      const printed = [...output.matchAll(/score:\s*([0-9.]+)/g)].at(-1)?.[1];
      result.pass = check.status === 0;
      result.score = Math.max(0, Math.min(1, printed === undefined ? (result.pass ? 1 : 0) : Number(printed) || 0));
      result.checkOutput = clip(output.trim(), 600);
      result.tokens = run.tokens;
      result.cost = run.cost;
      result.turns = transcript.turns;
      result.toolErrors = transcript.toolErrors;
      result.transcript = transcript.text || `(no transcript) ${run.error ?? run.stderrTail}`;
      result.errors = transcript.errors;
      if (run.stopped) result.stopped = run.stopped;
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true }); // holds copied credentials
    }
    return save();
  }

  /** Run every task of the given sets with each harness; one flat pool for all cells. */
  async evaluate(harnesses: Harness[], tasks: string[]): Promise<CellResult[][]> {
    const jobs = harnesses.flatMap((harness, index) =>
      tasks.flatMap((task) => Array.from({ length: this.options.reps }, (_, rep) => ({ harness, index, task, rep }))));
    const results = await mapPool(jobs, this.options.concurrency, (job) => this.runCell(job.task, job.harness, job.rep));
    return harnesses.map((_, index) => results.filter((_result, jobIndex) => jobs[jobIndex]!.index === index));
  }

  private async propose(prompt: string, slot: number): Promise<string> {
    this.checkBudget();
    const run = await askWriter(this.options.pi, this.options.writer, path.join(this.options.dir, `writer-agent-${slot}`), prompt);
    this.spend(run);
    return run.text;
  }

  /** The loop: rounds of candidates, selection on the scoring set, held-out comparison at the end. */
  async run(initialLearned: string): Promise<void> {
    const { options, suite } = this;
    const { dir } = options;
    const harnessDir = path.join(dir, "harnesses");
    const csv = path.join(dir, "results.csv");
    fs.mkdirSync(path.join(dir, "diffs"), { recursive: true });
    fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
    // Rewritten on each change, so a stop at any point leaves a complete file.
    const rows: Array<Array<string | number | boolean>> = [["round", "version", "parent", "kind", "valid", "kept", "scoring_score", "scoring_pass_rate", "mean_tokens", "feedback_score", "spent_tokens", "spent_usd"]];
    const writeCsv = () => fs.writeFileSync(csv, `${rows.map((line) => line.join(",")).join("\n")}\n`);
    const row = (cells: Array<string | number | boolean>) => {
      rows.push(cells);
      writeCsv();
      return cells;
    };
    const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=pi-fabric tuner", "-c", "user.email=tuner@localhost", ...args], { cwd: harnessDir, encoding: "utf8" });
    const saveVersion = (version: string, learned: string, message: string) => {
      fs.mkdirSync(path.join(harnessDir, version), { recursive: true });
      fs.writeFileSync(path.join(harnessDir, version, "learned.md"), learned);
      if (!fs.existsSync(path.join(harnessDir, ".git"))) git("init", "-q");
      git("add", "-A");
      if (git("commit", "-q", "-m", message).status !== 0) options.log(`  (git commit of ${version} did not succeed)`);
    };
    const rules: Record<string, { text: string; addedIn: string; lastConfirmed: number; value?: number; tasksHelped?: string[]; removedIn?: string }> = {};
    const history: string[] = [];
    const kept: Array<{ version: string; parent: string; kind: string; diagnosis: string; from: number; to: number }> = [];
    let stopReason = "";
    let version = 0;
    let parent: Harness = { label: "v0", learned: normalizeLearned(initialLearned), enabled: true };
    const first = parent;
    let report = "";
    let parentScore: Score | undefined;

    try {
      options.log(`v0: feedback set (${suite.sets.feedback.length} tasks) and scoring set (${suite.sets.scoring.length} tasks)`);
      // The seed file exists before its runs, so `tune apply` works after a budget stop in round 0.
      fs.mkdirSync(path.join(harnessDir, "v0"), { recursive: true });
      fs.writeFileSync(path.join(harnessDir, "v0", "learned.md"), parent.learned);
      const [feedback] = await this.evaluate([parent], suite.sets.feedback);
      const [scoring] = await this.evaluate([parent], suite.sets.scoring);
      report = buildReport(parent.label, feedback!);
      parentScore = summarize(scoring!);
      fs.writeFileSync(path.join(dir, "reports", "v0.md"), report);
      saveVersion("v0", parent.learned, `v0: scoring ${parentScore.score.toFixed(2)}, feedback ${summarize(feedback!).score.toFixed(2)}`);
      row([0, "v0", "", "seed", true, true, parentScore.score.toFixed(3), parentScore.passRate.toFixed(3), parentScore.tokens, summarize(feedback!).score.toFixed(3), this.spentTokens, this.spentUsd.toFixed(4)]);

      let roundsWithNoGain = 0;
      for (let round = 1; round <= options.rounds; round += 1) {
        // Two stop conditions save the cost of rounds that cannot help.
        if (parentScore.score >= 1 - EPS) {
          options.log(`stop before round ${round}: the scoring score is 1.00`);
          break;
        }
        if (roundsWithNoGain >= NO_GAIN_ROUNDS) {
          options.log(`stop before round ${round}: ${NO_GAIN_ROUNDS} rounds with no kept edit`);
          break;
        }
        options.log(`round ${round}: parent ${parent.label} (scoring ${parentScore.score.toFixed(2)}, ${parentScore.tokens} tokens)`);
        const candidates: Array<{ kind: "writer" | "removal"; learned: string; diagnosis: string; edit: string; removed?: string }> = [];
        // One slot tests the file without its least recently confirmed entry.
        const entries = entriesOf(parent.learned);
        const oldest = [...entries].sort((a, b) => (rules[entryId(a)]?.lastConfirmed ?? 0) - (rules[entryId(b)]?.lastConfirmed ?? 0))[0];
        // Near the top, the candidates of one round get almost the same score, so half of them is sufficient.
        const count = parentScore.score >= FEW_CANDIDATES_SCORE ? Math.min(options.candidates, Math.max(2, Math.ceil(options.candidates / 2))) : options.candidates;
        if (oldest && count > 1) {
          candidates.push({ kind: "removal", learned: removeEntry(parent.learned, oldest), diagnosis: `Removal test of: ${clip(oldest, 120)}`, edit: `REMOVE ${oldest}`, removed: oldest });
        }
        const slots = count - candidates.length;
        const responses = await mapPool(Array.from({ length: slots }, (_, slot) => slot), options.concurrency, (slot) =>
          proposeEdit(parent.learned, writerPrompt(suite.description, parent, report, history, slot + 1, slots), (prompt) => this.propose(prompt, slot)));
        const tuples: Array<Record<string, unknown>> = [];
        let keptRow: Array<string | number | boolean> | undefined;
        for (const response of responses) {
          const edit = applyEdits(parent.learned, response);
          if (edit.ok && !candidates.some((candidate) => candidate.learned === edit.learned)) {
            candidates.push({ kind: "writer", learned: edit.learned, diagnosis: edit.diagnosis, edit: response });
          } else {
            const reason = edit.ok ? "same as another candidate" : edit.reason;
            options.log(`  discarded a candidate: ${reason}`);
            tuples.push({ round, parent: parent.label, report, harness: parent.learned, edit: response, valid: false, reason, reward: null });
            row([round, "-", parent.label, "writer", false, false, "", "", "", "", this.spentTokens, this.spentUsd.toFixed(4)]);
          }
        }
        const harnesses = candidates.map((candidate, index): Harness => ({ label: `r${round}c${index + 1}`, learned: candidate.learned, enabled: true }));
        const scored = (await this.evaluate(harnesses, suite.sets.scoring)).map((cells, index) => ({ ...candidates[index]!, harness: harnesses[index]!, score: summarize(cells) }));
        for (const candidate of scored) {
          tuples.push({ round, parent: parent.label, report, harness: parent.learned, edit: candidate.edit, candidate: candidate.learned, valid: true, kind: candidate.kind, reward: candidate.score.score, parentReward: parentScore.score, tokens: candidate.score.tokens });
        }
        fs.appendFileSync(path.join(dir, "tuples.jsonl"), tuples.map((tuple) => `${JSON.stringify(tuple)}\n`).join(""));
        const best = [...scored].sort((a, b) => b.score.score - a.score.score || a.score.tokens - b.score.tokens)[0];
        // A removal also wins a tie: the same score with a shorter file. At a score of 0 a tie shows nothing, so the file stays.
        const keep = best !== undefined && (beats(best.score, parentScore) || (best.kind === "removal" && best.score.score > EPS && best.score.score >= parentScore.score - EPS));
        for (const candidate of scored) {
          const isKept = keep && candidate === best;
          const cells = row([round, isKept ? `v${version + 1}` : candidate.harness.label, parent.label, candidate.kind, true, isKept, candidate.score.score.toFixed(3), candidate.score.passRate.toFixed(3), candidate.score.tokens, "", this.spentTokens, this.spentUsd.toFixed(4)]);
          if (isKept) keptRow = cells;
          const rule = candidate.removed ? rules[entryId(candidate.removed)] : undefined;
          if (rule && !isKept && candidate.score.score < parentScore.score - EPS) {
            rule.lastConfirmed = round;
            rule.value = parentScore.score - candidate.score.score;
            rule.tasksHelped = Object.keys(parentScore.perTask).filter((task) => parentScore!.perTask[task]! > (candidate.score.perTask[task] ?? 0) + EPS);
          }
          history.push(`- round ${round}, ${candidate.kind}, ${isKept ? "KEPT" : "rejected"} (scoring ${parentScore.score.toFixed(2)} -> ${candidate.score.score.toFixed(2)}, tokens ${parentScore.tokens} -> ${candidate.score.tokens}): ${clip(candidate.diagnosis.replace(/\s+/g, " "), 240)}`);
        }
        if (!keep || !best) {
          options.log(`  no candidate is better than ${parent.label}`);
          roundsWithNoGain += 1;
          continue;
        }
        roundsWithNoGain = 0;
        version += 1;
        const name = `v${version}`;
        const previous = parent;
        for (const entry of entriesOf(best.learned)) {
          rules[entryId(entry)] ??= { text: entry, addedIn: name, lastConfirmed: round, value: best.score.score - parentScore.score };
        }
        for (const entry of entriesOf(previous.learned)) {
          if (!best.learned.includes(entry) && rules[entryId(entry)]) rules[entryId(entry)]!.removedIn = name;
        }
        kept.push({ version: name, parent: previous.label, kind: best.kind, diagnosis: best.diagnosis, from: parentScore.score, to: best.score.score });
        saveVersion(name, best.learned, `${name}: scoring ${parentScore.score.toFixed(2)} -> ${best.score.score.toFixed(2)} (parent ${previous.label}, ${best.kind})`);
        fs.writeFileSync(path.join(dir, "diffs", `${name}.diff`), git("diff", "--no-index", "--", path.join(previous.label, "learned.md"), path.join(name, "learned.md")).stdout);
        options.log(`  kept ${name} (${best.kind}): scoring ${parentScore.score.toFixed(2)} -> ${best.score.score.toFixed(2)}`);
        parent = { label: name, learned: best.learned, enabled: true };
        parentScore = best.score;
        const [next] = await this.evaluate([parent], suite.sets.feedback);
        if (keptRow) keptRow[9] = summarize(next!).score.toFixed(3);
        writeCsv();
        report = buildReport(name, next!);
        fs.writeFileSync(path.join(dir, "reports", `${name}.md`), report);
      }
    } catch (error) {
      if (!(error instanceof BudgetStop)) throw error;
      stopReason = error.message;
      options.log(stopReason);
    }

    fs.writeFileSync(path.join(dir, "rules.json"), JSON.stringify(rules, null, 2));
    const lines = [
      "# Tuner summary",
      "",
      `Main model ${options.model}. Rule writer ${options.writer}. Final harness ${parent.label}. Spent ${this.spentTokens} tokens, $${this.spentUsd.toFixed(4)}.`,
      ...(stopReason ? ["", `Stopped early: ${stopReason}. The held-out comparison did not run.`] : []),
      "",
      "## Kept edits",
      "",
      ...(kept.length === 0 ? ["No edit was better than v0."] : kept.map((edit) => `- ${edit.version} (${edit.kind}, parent ${edit.parent}): scoring ${edit.from.toFixed(2)} -> ${edit.to.toFixed(2)}. ${edit.diagnosis.replace(/\s+/g, " ")}`)),
      "",
    ];
    if (!stopReason && parent !== first) {
      try {
        options.log(`held-out set (${suite.sets.heldout.length} tasks): v0 and ${parent.label}`);
        const [before, after] = (await this.evaluate([{ ...first, label: "heldout-v0" }, { ...parent, label: `heldout-${parent.label}` }], suite.sets.heldout)).map(summarize);
        lines.push("## Held-out comparison", "", "| Harness | Score | Pass rate | Mean tokens |", "| --- | --- | --- | --- |",
          `| v0 | ${before!.score.toFixed(2)} | ${(before!.passRate * 100).toFixed(0)}% | ${before!.tokens} |`,
          `| ${parent.label} | ${after!.score.toFixed(2)} | ${(after!.passRate * 100).toFixed(0)}% | ${after!.tokens} |`, "");
      } catch (error) {
        if (!(error instanceof BudgetStop)) throw error;
        lines.push(`Stopped in the held-out comparison: ${error.message}.`, "");
      }
    }
    fs.writeFileSync(path.join(dir, "summary.md"), lines.join("\n"));
    options.log(`\n${lines.join("\n")}`);
  }
}

export const writerPrompt = (suite: string, parent: Harness, report: string, history: string[], slot: number, slots: number): string => `A coding agent solves tasks. Before each task, the agent reads one file of learned rules, learned.md, in its system prompt. You improve learned.md. The model of the agent does not change.

# Task suite
${suite}

# Rules for your edit
- Make one targeted change that removes a cause of failure or of wasted calls that the report shows.
- Write general rules for this environment. Do not write the answer of a task, and do not name a task.
- The agent reads learned.md in all its sessions, also in sessions with other tools. Start each rule with the server, tool, or kind of task that it applies to.
- Each rule is one "- " bullet. Give exact formats and one short example when a format matters.
- Edit or merge a rule that is there before you add a new one. Remove a rule that is wrong.
- Keep learned.md below ${MAX_LEARNED_LINES} lines.
- You are proposer ${slot} of ${slots}. All proposers see this same input. Proposer 1 fixes the most important cause. A proposer with a higher number fixes the next cause or writes a different fix.

# Current learned.md (${parent.label})
${parent.learned.trim() ? `\`\`\`\n${parent.learned.trim()}\n\`\`\`` : "(empty)"}

${report}

# Earlier edits
${history.length > 0 ? history.slice(-12).join("\n") : "(none)"}

# Output format
DIAGNOSIS: two to four sentences about the cause.
Then one or more edit blocks. SEARCH must be exact text from learned.md. An empty SEARCH appends to the end of the file. An empty replacement deletes the text.
<<<<<<< SEARCH
text to replace
=======
new text
>>>>>>> REPLACE
If no edit can help, write NO_CHANGE and no block.
`;
