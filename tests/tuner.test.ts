import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG, normalizeFabricConfig } from "../src/config.js";
import { learnedRulesPath, MAX_LEARNED_CHARS, readLearnedGuidance } from "../src/tuner/learned.js";
import { buildEvidence, captureStep, correctionOf, dueTargets, loadCapture, saveCapture, stepOf, takeNotice, tunerFile } from "../src/tuner/capture.js";
import { applyEdits, beats, buildReport, diffEntries, entriesOf, proposeEdit, removeEntry, renderTranscript, splitTasks, summarize, type CellResult } from "../src/tuner/tuner.js";

const block = (search: string, replace: string) => `<<<<<<< SEARCH\n${search}${search ? "\n" : ""}=======\n${replace}${replace ? "\n" : ""}>>>>>>> REPLACE`;
const cell = (task: string, score: number, tokens: number, extra: Partial<CellResult> = {}): CellResult => ({
  task, rep: 0, pass: score === 1, score, checkOutput: "", tokens, cost: 0, wallS: 1, turns: 1, toolErrors: 0, transcript: "x", errors: "", ...extra,
});

describe("tuner", () => {
  it("is off by default and reads only bounded learned rules", () => {
    expect(DEFAULT_FABRIC_CONFIG.tuner).toEqual({ enabled: false, proposerModel: "", capture: false, autoAccept: false });
    expect(normalizeFabricConfig({ tuner: { enabled: true, proposerModel: " a/b ", capture: true, autoAccept: true } }).tuner).toEqual({ enabled: true, proposerModel: "a/b", capture: true, autoAccept: true });
    expect(normalizeFabricConfig({ tuner: { enabled: "yes" } }).tuner.enabled).toBe(false);
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "tuner-"));
    expect(readLearnedGuidance(agentDir)).toBeUndefined();
    fs.mkdirSync(path.dirname(learnedRulesPath(agentDir)), { recursive: true });
    fs.writeFileSync(learnedRulesPath(agentDir), `- rule one\n${"x".repeat(MAX_LEARNED_CHARS * 2)}`);
    const guidance = readLearnedGuidance(agentDir)!;
    expect(guidance).toContain("- rule one");
    expect(guidance.length).toBeLessThan(MAX_LEARNED_CHARS + 300);
  });

  it("applies add, edit, and remove edits and discards invalid ones", () => {
    const added = applyEdits("", `DIAGNOSIS: no date rule.\n${block("", "- Dates: use DD.MM.YYYY.")}`);
    expect(added).toEqual({ ok: true, learned: "- Dates: use DD.MM.YYYY.\n", diagnosis: "no date rule." });
    const parent = "- Dates: use DD.MM.YYYY.\n- Ids: use $1 form.\n";
    const edited = applyEdits(parent, block("- Ids: use $1 form.", "- Ids: use P#1001 form ($& stays literal)."));
    expect(edited.ok && edited.learned).toBe("- Dates: use DD.MM.YYYY.\n- Ids: use P#1001 form ($& stays literal).\n");
    const removed = applyEdits(parent, block("- Dates: use DD.MM.YYYY.", ""));
    expect(removed.ok && removed.learned).toBe("- Ids: use $1 form.\n");
    expect(applyEdits(parent, block("- not there", "- x"))).toMatchObject({ ok: false });
    expect(applyEdits(parent, "NO_CHANGE")).toMatchObject({ ok: false, reason: "proposer declared no change" });
    expect(applyEdits(parent, block("", "y".repeat(MAX_LEARNED_CHARS)))).toMatchObject({ ok: false });
    expect(applyEdits(parent, block("- Ids: use $1 form.", "- Ids: use $1 form."))).toMatchObject({ ok: false, reason: "edit changes nothing" });
  });

  it("splits entries and removes one", () => {
    const learned = "# Rules\n\n- one\n  more of one\n- two\n\n- three\n";
    expect(entriesOf(learned)).toEqual(["- one\n  more of one", "- two", "- three"]);
    expect(removeEntry(learned, "- two")).toBe("# Rules\n\n- one\n  more of one\n\n- three\n");
  });

  it("keeps the task sets disjoint", () => {
    expect(splitTasks(["a", "b", "c", "d"])).toEqual({ feedback: ["a", "d"], scoring: ["b"], heldout: ["c"] });
    expect(() => splitTasks(["a", "b", "c"], { feedback: ["a"], scoring: ["a"], heldout: ["c"] })).toThrow("disjoint");
    expect(() => splitTasks(["a", "b", "c"], { feedback: ["a"], scoring: ["b"], heldout: ["z"] })).toThrow("unknown");
  });

  it("selects on score first, then on tokens", () => {
    const parent = summarize([cell("a", 1, 1000), cell("b", 0, 1000)]);
    expect(parent).toMatchObject({ score: 0.5, passRate: 0.5, tokens: 1000, perTask: { a: 1, b: 0 } });
    expect(beats(summarize([cell("a", 1, 5000), cell("b", 1, 5000)]), parent)).toBe(true);
    expect(beats(summarize([cell("a", 1, 950), cell("b", 0, 950)]), parent)).toBe(false);
    expect(beats(summarize([cell("a", 1, 800), cell("b", 0, 800)]), parent)).toBe(true);
    expect(beats(summarize([cell("a", 0, 100), cell("b", 0, 100)]), parent)).toBe(false);
  });

  it("builds a bounded report with failures first", () => {
    const transcript = renderTranscript([
      { role: "assistant", content: [{ type: "toolCall", name: "fabric_exec", arguments: { code: "return 1" } }], usage: { totalTokens: 5 } },
      { role: "toolResult", content: [{ type: "text", text: "a: \"ERR: ERR_FORMAT [q]:\n bad\"" }], isError: false },
      { role: "toolResult", content: [{ type: "text", text: "[{\"name\":\"depot\",\"description\":\"returns ERR_FORMAT on error\"}]" }], isError: false },
    ]);
    expect(transcript).toMatchObject({ turns: 1, toolErrors: 1, errors: "CALL fabric_exec: return 1\nERROR: a: \"ERR: ERR_FORMAT [q]: bad\"" });
    expect(transcript.text.split("\n")).toHaveLength(3);
    const report = buildReport("v0", [
      cell("good", 1, 10),
      cell("wasteful", 1, 10, { toolErrors: 2 }),
      cell("bad", 0, 10, { transcript: "z".repeat(100_000), checkOutput: "wrong answer" }),
      cell("errors", 0.5, 10, { errors: "CALL x\nERROR: y", transcript: "CALL x\nERROR: y\nCALL z\nRESULT: stale" }),
    ], 6_000);
    expect(report.length).toBeLessThanOrEqual(6_000);
    expect(report.indexOf("## bad: FAIL")).toBeGreaterThan(0);
    expect(report.indexOf("## bad: FAIL")).toBeLessThan(report.indexOf("## wasteful: pass with 2 tool errors"));
    expect(report).toContain("Failed tool steps, in order:\n```\nCALL x\nERROR: y\n```\nTranscript excerpt:\n```\nCALL x\nERROR: y\nCALL z\nRESULT: stale\n```");
    expect(report.slice(report.indexOf("## wasteful"))).not.toContain("Transcript excerpt:");
    expect(report).not.toContain("## good");
  });

  it("captures a repeated failure with its fix and starts one suggestion", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "tuner-capture-"));
    let started = 0;
    const step = (session: string, code: string, text: string) => captureStep(stepOf(session, "fabric_exec", { code }, text), [], agentDir, () => { started += 1; });
    const bad = 'Runtime error: {"message":"ERR_FORMAT [q]: q must be wrapped as [[...]]"}';
    expect(step("s1", "return await mcp.depot.depot_search({q:'oak'})", "[]")).toBe(false); // a success with no failure before it
    expect(loadCapture(agentDir).rows).toHaveLength(0);
    expect(step("s1", "return await mcp.depot.depot_search({q:'oak 12'})", bad)).toBe(false);
    expect(step("s1", "return await mcp.depot.depot_search({q:'[[OAK]]'})", '[{"id":"P-1"}]')).toBe(false);
    expect(step("s1", "return await pi.bash({command:'npm test'})", "Error: 1 test failed")).toBe(false);
    expect(step("s2", "return await tools.call({ref:'mcp.depot.depot_search',args:{q:'oak 7'}})", `{ first: [], second: "Error: ERR_FORMAT [q]: upper case" }`)).toBe(false);
    expect(step("s3", "return await mcp.depot.depot_search({q:'pine'})", bad)).toBe(false); // no correct call yet
    expect(step("s3", "return await mcp.depot.depot_search({q:'[[PINE]]'})", "[]")).toBe(true);
    const { rows, need } = loadCapture(agentDir);
    const targets = dueTargets(rows, need);
    expect(targets).toEqual(["mcp.depot.depot_search"]);
    const evidence = buildEvidence(rows, targets);
    expect(evidence).toContain("## mcp.depot.depot_search: 3 failures in 3 sessions");
    expect(evidence).toContain("upper case");
    expect(evidence).toContain("CALL return await mcp.depot.depot_search({q:'[[PINE]]'})");
    expect(evidence).not.toContain("npm test");
    // A suggestion that waits blocks the next one, and a used target needs more failures.
    fs.writeFileSync(tunerFile("suggestion.json", agentDir), "{}");
    expect(step("s4", "return await mcp.depot.depot_search({q:'ash'})", bad)).toBe(false);
    fs.rmSync(tunerFile("suggestion.json", agentDir));
    saveCapture(rows, new Map([["mcp.depot.depot_search", 4]]), agentDir);
    expect(step("s5", "return await mcp.depot.depot_search({q:'elm'})", bad)).toBe(false);
    expect(step("s5", "return await mcp.depot.depot_search({q:'[[ELM]]'})", "[]")).toBe(true);
    // A target that only fails starts a suggestion at two times the count.
    expect([1, 2, 3, 4, 5, 6].map(() => step("s6", "return await mcp.x.y()", bad))).toEqual([false, false, false, false, false, true]);
    expect(started).toBe(3);
    // The user corrects the agent: three corrections start a suggestion, with the last call as context.
    expect(correctionOf("s9", "no, use bun")).toBeUndefined(); // the agent did nothing yet in this session
    expect(correctionOf("s6", "now add a test")).toBeUndefined(); // not a correction
    const corrections = ["No, use bun and not npm", "don't run the full suite", "I told you: bun only"].map((text) =>
      captureStep(correctionOf("s6", text)!, ["--auto"], agentDir, (args) => { started += args.length; }));
    expect(corrections).toEqual([false, false, true]);
    expect(started).toBe(4);
    const all = loadCapture(agentDir);
    expect(buildEvidence(all.rows, ["user"])).toContain("## 3 corrections from the user in 1 sessions\n```\nAGENT DID: return await mcp.x.y()\nUSER SAID: No, use bun and not npm");
    // One notice for an edit that Fabric accepted with no review, then one for a suggestion that waits.
    fs.writeFileSync(tunerFile("notice.txt", agentDir), "changed");
    fs.writeFileSync(tunerFile("suggestion.json", agentDir), "{}");
    expect([takeNotice(agentDir), takeNotice(agentDir), takeNotice(agentDir)]).toEqual(["changed", 'The Fabric tuner has a rule suggestion. Run "pi-fabric tune review".', undefined]);
  });

  it("asks the proposer one more time for an edit that does not apply", async () => {
    const good = `DIAGNOSIS: x.\n${block("", "- new rule")}`;
    const asked: string[] = [];
    const ask = (replies: string[]) => async (prompt: string) => { asked.push(prompt); return replies.shift()!; };
    expect(await proposeEdit("- a\n", "P", ask([block("- not there", "- b"), good]))).toBe(good);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain("Fabric discarded that reply: SEARCH text is not in the file");
    expect(await proposeEdit("- a\n", "P", ask(["NO_CHANGE"]))).toBe("NO_CHANGE");
    expect(await proposeEdit("- a\n", "P", ask([good]))).toBe(good);
    expect(asked).toHaveLength(4);
    expect(diffEntries("- a\n- b\n", "- a\n- c\n")).toBe("Remove:\n- b\n\nAdd:\n- c");
  });
});
