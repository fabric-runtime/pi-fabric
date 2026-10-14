import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveScriptRuntime } from "../agents/transports/process-utils.js";
import { learnedRulesPath } from "./learned.js";

// Capture for `pi-fabric tune suggest` (`tuner.capture`): the failed tool
// steps of real sessions, and the first call to the same target that succeeds
// after a failure. When one target fails again and again, a detached
// `tune suggest` asks the rule writer for a rule. A rule reaches learned.md only
// through `pi-fabric tune accept`.

/** Failures of one target before its first suggestion. Each suggestion doubles the number for that target. */
export const SUGGEST_AFTER = 2;
// ponytail: byte cap that drops the oldest half; rotate by age if a capture must live longer.
const MAX_CAPTURE_BYTES = 1_000_000;
const LOCK_STALE_MS = 10 * 60_000;

export interface CapturedStep {
  ts: number;
  session: string;
  /** The first `mcp.<server>.<tool>` or `pi.<tool>` of the call, else the tool name. */
  target: string;
  call: string;
  result: string;
  failed: boolean;
}

export const tunerFile = (name: string, agentDir?: string): string => path.join(path.dirname(learnedRulesPath(agentDir)), name);

export const findFabricRoot = (): string => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      if ((JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: unknown }).name === "pi-fabric") return dir;
    } catch { /* no package.json here */ }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Cannot find the pi-fabric package root");
    dir = parent;
  }
};

// ponytail: a text heuristic. An error that the agent catches inside its code does not count.
export const looksFailed = (text: string, isError = false): boolean =>
  isError || /^\W*(\w+\W+)?(ERR[_A-Z]*\b|error\b|runtime error)/i.test(text.slice(0, 80));

const oneLine = (text: string, max: number): string => text.replace(/\s+/g, " ").trim().slice(0, max);

// The calls inside each open fabric_exec that succeeded, with their exact arguments. Fabric reports no nested failure.
// ponytail: a fabric_exec that gives no result keeps its entry; clear on session end if that grows.
const nested = new Map<string, CapturedStep[]>();

/** Keep a nested call that succeeded until the result of its fabric_exec comes. */
export const holdNested = (parent: string, step: CapturedStep): void => {
  nested.set(parent, [...(nested.get(parent) ?? []), step].slice(-20));
};

export const takeNested = (toolCallId: string): CapturedStep[] => {
  const steps = nested.get(toolCallId) ?? [];
  nested.delete(toolCallId);
  return steps;
};

/** `passed` holds the targets that succeeded inside this call, so a failure goes to the first target that did not. */
export const stepOf = (session: string, toolName: string, input: Record<string, unknown>, text: string, isError = false, passed: readonly string[] = []): CapturedStep => {
  const code = typeof input.code === "string" ? input.code : JSON.stringify(input);
  const refs = [...code.matchAll(/\b(mcp\.\w+\.\w+|pi\.\w+)\b/g)].map((match) => match[1]!);
  const result = oneLine(text, 320);
  return {
    ts: Date.now(),
    session,
    target: refs.find((ref) => !passed.includes(ref)) ?? refs[0] ?? toolName,
    call: oneLine(code, 400),
    result,
    // Agents often catch an error and return it in an object, so its text is not at the start.
    failed: looksFailed(text, isError) || /\bError: /.test(result),
  };
};

/**
 * The steps of one top-level result, with the nested calls that succeeded inside it.
 * A fabric_exec that returns no error proves nothing, because its code can catch each error.
 * So for a call with a target in its code, only a nested call that succeeded is a fix.
 */
export const stepsOf = (session: string, toolName: string, input: Record<string, unknown>, text: string, isError: boolean, passed: CapturedStep[]): CapturedStep[] => {
  const step = stepOf(session, toolName, input, text, isError, passed.map((ok) => ok.target));
  return [...(step.failed || step.target === toolName ? [step] : []), ...passed.map((ok) => ({ ...ok, ts: Date.now() }))];
};

/** `need` holds the failure count that a target must reach before its next suggestion. */
export const loadCapture = (agentDir?: string): { rows: CapturedStep[]; need: Map<string, number> } => {
  const rows: CapturedStep[] = [];
  const need = new Map<string, number>();
  let text = "";
  try { text = fs.readFileSync(tunerFile("failures.jsonl", agentDir), "utf8"); } catch { /* no capture yet */ }
  for (const line of text.split("\n")) {
    try {
      const row = JSON.parse(line) as Partial<CapturedStep> & { need?: unknown };
      if (typeof row.target !== "string") continue;
      if (typeof row.need === "number") need.set(row.target, row.need);
      else rows.push(row as CapturedStep);
    } catch { /* an empty or torn line */ }
  }
  return { rows, need };
};

// ponytail: a rewrite can lose a step that a session appends at the same moment; lock the file if that matters.
export const saveCapture = (rows: CapturedStep[], need: Map<string, number>, agentDir?: string): void => {
  const file = tunerFile("failures.jsonl", agentDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [...[...need].map(([target, count]) => ({ target, need: count })), ...rows].map((row) => `${JSON.stringify(row)}\n`).join(""), { mode: 0o600 });
};

/** The targets with enough failures for a suggestion. */
export const dueTargets = (rows: CapturedStep[], need: Map<string, number>, min = SUGGEST_AFTER, factor = 1): string[] => {
  const counts = new Map<string, number>();
  for (const row of rows) if (row.failed) counts.set(row.target, (counts.get(row.target) ?? 0) + 1);
  return [...counts].filter(([target, count]) => count >= factor * (need.get(target) ?? min)).map(([target]) => target);
};

/** The call that shows the correct form: the newest step of the target, when that step succeeded. A success before the newest failure proves nothing, because the tool can change. */
export const fixOf = (rows: CapturedStep[], target: string): CapturedStep | undefined => {
  const last = rows.filter((row) => row.target === target).at(-1);
  return last && !last.failed ? last : undefined;
};

/** The rules that start with the tool name of one of the targets. A rule that only names the tool in its text stays. */
export const rulesFor = (entries: string[], targets: string[]): string[] => {
  const names = targets.map((target) => (target.startsWith("mcp.") ? target.split(".").at(-1)! : target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return entries.filter((entry) => names.some((name) => new RegExp(`^- \\W*(?:[\\w.]*\\.)?${name}\\b`).test(entry)));
};

/**
 * The edit for targets that only fail with their rules in the prompt. It removes those rules and puts facts in
 * their place: the calls that the tool rejected and what the tool said. Code writes it, so it holds no guess.
 */
export const staleEdit = (rows: CapturedStep[], targets: string[], wrong: string[]): string => {
  // Tool text goes into the prompt as a quotation: one line, cut, and with no edit markers or code marks.
  const quote = (text: string, max: number): string => oneLine(text.replace(/`|[<>=]{7}/g, " "), max);
  const last = (values: string[]): string[] => [...new Set(values)].slice(-3);
  const notes = targets.map((target) => {
    const failures = rows.filter((row) => row.failed && row.target === target);
    // ponytail: a long call is a program, and its start does not show the call that failed. Only short calls go in.
    const calls = last(failures.filter((row) => row.call.length <= 160).map((row) => quote(row.call, 160)));
    const errors = last(failures.map((row) => quote(row.result, 200)));
    return [
      `- ${target}: the correct form is not known. An earlier rule failed, and Fabric removed it.`,
      ...(calls.length > 0 ? [`The tool rejected: ${calls.map((call) => `\`${call}\``).join(", ")}.`] : []),
      `The tool said: ${errors.map((error) => `"${error}"`).join(" and ")}.`,
      "Read the error text and try a different form.",
    ].join(" ");
  });
  const block = (search: string, replace: string): string => `<<<<<<< SEARCH\n${search}${search ? "\n" : ""}=======\n${replace}${replace ? "\n" : ""}>>>>>>> REPLACE`;
  return [
    `DIAGNOSIS: Each call to ${targets.join(", ")} failed with its rule in the prompt, and no call succeeded. Fabric removed the rule and wrote what the tool said. It wrote no new form.`,
    ...wrong.map((entry) => block(entry, "")),
    ...notes.map((note) => block("", note)),
  ].join("\n");
};

/** The rule writer's report: for each target, its different failures and a call that succeeded afterward. */
export const buildEvidence = (rows: CapturedStep[], targets: string[], repeated: ReadonlySet<string> = new Set()): string => {
  const sections = targets.map((target) => {
    const failures = rows.filter((row) => row.failed && row.target === target);
    const examples = [...new Map(failures.map((row) => [row.result.replace(/\d+/g, "N").slice(0, 80), row])).values()].slice(-5);
    if (target === USER_TARGET) {
      return [
        `## ${failures.length} corrections from the user in ${new Set(failures.map((row) => row.session)).size} sessions`,
        "```",
        ...examples.flatMap((row) => [`AGENT DID: ${row.call}`, `USER SAID: ${row.result}`]),
        "```",
      ].join("\n");
    }
    const fix = fixOf(rows, target);
    return [
      `## ${target}: ${failures.length} failures in ${new Set(failures.map((row) => row.session)).size} sessions`,
      "```",
      ...examples.flatMap((row) => [`CALL ${row.call}`, `ERROR: ${row.result}`]),
      "```",
      ...(fix ? ["The newest call, which succeeded:", "```", `CALL ${fix.call}`, `RESULT: ${fix.result}`, "```"] : []),
      // A tool can change, and a rule can be wrong from the start. With no call that succeeded, a new format
      // is a guess: the agent finds the format faster with no rule than with a wrong one.
      ...(!fix && !repeated.has(target) ? ["No call to this target succeeded. Write only what an error says in clear words. Do not write a form that no call confirmed."] : []),
      ...(repeated.has(target) ? [`These failures occurred with the current learned.md in the prompt, so a rule for this target is wrong or old. ${fix
        ? "Correct that rule so that it agrees with the call that succeeded. Copy the form of its arguments and keep no part of the old form. Do not add a second rule that disagrees with it."
        : "No call succeeded, so the correct form is not known. Remove the rules for this target that the errors contradict. Do not write a format that no call confirmed, and do not join the old form with the words of an error."}`] : []),
    ].join("\n");
  });
  return `# Execution report: real sessions\n\n${sections.join("\n\n")}`.slice(0, 16_000);
};

export const suggestionWaits = (agentDir?: string): boolean => fs.existsSync(tunerFile("suggestion.json", agentDir));

export const lockHeld = (agentDir?: string): boolean => {
  try { return Date.now() - fs.statSync(tunerFile("suggest.lock", agentDir)).mtimeMs < LOCK_STALE_MS; } catch { return false; }
};

const startSuggest = async (args: string[]): Promise<void> => {
  spawn(await resolveScriptRuntime(), [path.join(findFabricRoot(), "dist", "cli", "index.js"), "tune", "suggest", ...args], { detached: true, stdio: "ignore" })
    .on("error", () => { /* no runtime: `pi-fabric tune suggest` still works by hand */ })
    .unref();
};

// `${session} ${target}` pairs with a failure and no success after it.
const open = new Set<string>();
// The last tool call of each session: the context of a correction from the user.
const lastCall = new Map<string, string>();

/** The target of a message in which the user corrects the agent. */
export const USER_TARGET = "user";
// ponytail: an English word list at the start of the message; use a classifier call if it misses too much.
const CORRECTION = /^\W*(no\b|nope\b|don'?t\b|do not\b|stop\b|wrong\b|that'?s (wrong|not)\b|that is (wrong|not)\b|not (like )?that\b|never\b|i (said|told you|asked)\b|why did you\b|you (should|must|need to|were supposed to)\b|instead\b|undo\b|revert\b)/i;

/** A correction from the user as a step, or undefined when the message is not one or the agent did nothing yet. */
export const correctionOf = (session: string, text: string): CapturedStep | undefined => {
  const call = lastCall.get(session);
  if (call === undefined || !CORRECTION.test(text)) return undefined;
  return { ts: Date.now(), session, target: USER_TARGET, call, result: oneLine(text, 320), failed: true };
};

let reviewNoticeShown = false;
/** The text for one session notice: an edit that Fabric accepted with no review, or a suggestion that waits. */
export const takeNotice = (agentDir?: string): string | undefined => {
  const file = tunerFile("notice.txt", agentDir);
  try {
    const text = fs.readFileSync(file, "utf8");
    fs.rmSync(file, { force: true });
    return text;
  } catch { /* no accepted edit to report */ }
  if (reviewNoticeShown || !suggestionWaits(agentDir)) return undefined;
  reviewNoticeShown = true;
  return 'The Fabric tuner has a rule suggestion. Run "pi-fabric tune review".';
};

/** Record one step. `suggestArgs` go to `pi-fabric tune suggest`. Returns true when it started a suggestion. */
export const captureStep = (step: CapturedStep, suggestArgs: string[] = [], agentDir?: string, start: (args: string[]) => unknown = startSuggest): boolean => {
  if (step.target !== USER_TARGET) lastCall.set(step.session, step.call);
  const pending = `${step.session} ${step.target}`;
  if (!step.failed && !open.delete(pending)) return false;
  if (step.failed) open.add(pending);
  const file = tunerFile("failures.jsonl", agentDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(step)}\n`, { mode: 0o600 });
  const { rows, need } = loadCapture(agentDir);
  if (fs.statSync(file).size > MAX_CAPTURE_BYTES) saveCapture(rows.slice(-Math.ceil(rows.length / 2)), need, agentDir);
  // A success after the failures shows the correct call, so it starts the suggestion. A target that
  // only fails starts one at two times the count. A correction needs no later success.
  // One suggestion at a time: the next waits for your decision.
  if (!dueTargets(rows, need, SUGGEST_AFTER, step.failed && step.target !== USER_TARGET ? 2 : 1).includes(step.target) || suggestionWaits(agentDir) || lockHeld(agentDir)) return false;
  void start(suggestArgs);
  return true;
};
