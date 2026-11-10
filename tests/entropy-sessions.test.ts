import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  entropyTracesFromSessionJsonl,
  machineSessionFiles,
  machineSessionFilesAsync,
  measureSessionCorpus,
  measureSessionCorpusAsync,
  projectSessionFiles,
  projectSessionFilesAsync,
  sessionWindowEvidence,
  sessionEvidenceCacheUsage,
  sessionWindowEvidenceAsync,
  trendFromScores,
  type EntropySurfaceSnapshot,
} from "../src/entropy/index.js";
import { encodeCwdDir } from "../src/memory/discovery.js";

const tmpRoots: string[] = [];
const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-entropy-sessions-"));
  tmpRoots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const sessionLine = () =>
  JSON.stringify({
    id: "e1",
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "fabric_exec",
      content: [{ type: "text", text: "ok" }],
      details: {
        success: true,
        trace: {
          kind: "pi-fabric.execution",
          version: 1,
          outcome: "succeeded",
          phases: ["build"],
          operations: [
            {
              type: "call",
              sequence: 0,
              ref: "pi.read",
              args: { path: "src/a.ts", limit: 10 },
              outcome: "succeeded",
            },
          ],
          counts: {
            droppedValues: 0,
            truncatedValues: 0,
            redactedValues: 0,
            droppedOperations: 0,
          },
        },
        audits: [{ ref: "pi.read", args: { path: "src/a.ts", limit: 10 } }],
        phases: ["build"],
      },
    },
  });

const writeSession = (agentDir: string, cwd: string, name: string, mtime: Date): string => {
  const dir = path.join(agentDir, "sessions", encodeCwdDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${sessionLine()}\n`);
  fs.utimesSync(file, mtime, mtime);
  return file;
};

describe("projectSessionFiles", () => {
  it("lists the newest project sessions first", () => {
    const agentDir = makeTempDir();
    const older = writeSession(agentDir, "/repo", "a.jsonl", new Date(2020, 0, 1));
    const newer = writeSession(agentDir, "/repo", "b.jsonl", new Date(2021, 0, 1));
    expect(projectSessionFiles(agentDir, "/repo")).toEqual([newer, older]);
    expect(projectSessionFiles(agentDir, "/repo", 1)).toEqual([newer]);
    expect(projectSessionFiles(agentDir, "/missing")).toEqual([]);
  });
});

describe("machineSessionFiles", () => {
  it("merges the newest sessions across projects, bounded in total", () => {
    const agentDir = makeTempDir();
    const repoA = writeSession(agentDir, "/repo", "a.jsonl", new Date(2020, 0, 1));
    const repoB = writeSession(agentDir, "/repo", "b.jsonl", new Date(2021, 0, 1));
    const otherA = writeSession(agentDir, "/other", "a.jsonl", new Date(2022, 0, 1));
    const otherB = writeSession(agentDir, "/other", "b.jsonl", new Date(2019, 0, 1));
    expect(machineSessionFiles(agentDir, "/repo")).toEqual([
      otherA,
      repoB,
      repoA,
      otherB,
    ]);
    expect(machineSessionFiles(agentDir, "/repo", 2)).toEqual([otherA, repoB]);
  });

  it("guarantees the current project's newest session even when crowded out", () => {
    const agentDir = makeTempDir();
    const quiet = writeSession(agentDir, "/repo", "quiet.jsonl", new Date(2020, 0, 1));
    writeSession(agentDir, "/busy", "busy.jsonl", new Date(2021, 0, 1));
    expect(machineSessionFiles(agentDir, "/repo", 1)).toEqual([quiet]);
  });

  it("returns no files when the sessions root is absent", () => {
    expect(machineSessionFiles(makeTempDir(), "/repo")).toEqual([]);
  });

  it("breaks mtime ties by path for stable ordering", () => {
    const agentDir = makeTempDir();
    const same = new Date(2020, 0, 1);
    const b = writeSession(agentDir, "/b", "b.jsonl", same);
    const a = writeSession(agentDir, "/a", "a.jsonl", same);
    expect(machineSessionFiles(agentDir, undefined)).toEqual([a, b]);
  });
});

describe("async session pipeline", () => {
  it("exposes stable snapshots without flattening and invalidates them on truncation and replacement", async () => {
    const root = makeTempDir();
    const file = writeSession(root, "/repo", "live.jsonl", new Date(2021, 0, 1));
    const read = () => sessionWindowEvidenceAsync([file], { windowsOnly: true });
    const first = await read();
    expect(first.traces).toEqual([]);
    expect(first.valueObservations).toEqual([]);
    expect(first.auditCalls).toEqual([]);
    expect(first.traceWindows[0]!.traces).toHaveLength(1);
    expect((await read()).traceWindows[0]!.traces).toBe(first.traceWindows[0]!.traces);
    fs.appendFileSync(file, `${sessionLine()}\n`);
    const appended = await read();
    expect(appended.traceWindows[0]!.traces).toHaveLength(2);
    expect(appended.traceWindows[0]!.traces[0]).toBe(first.traceWindows[0]!.traces[0]);
    fs.writeFileSync(file, `${sessionLine()}\n`);
    const truncated = await read();
    expect(truncated.traceWindows[0]!.traces).toHaveLength(1);
    expect(truncated.traceWindows[0]!.traces[0]).not.toBe(first.traceWindows[0]!.traces[0]);
    const stat = fs.statSync(file);
    fs.writeFileSync(`${file}.replacement`, `${sessionLine()}\n`);
    fs.utimesSync(`${file}.replacement`, stat.atime, stat.mtime);
    fs.renameSync(`${file}.replacement`, file);
    expect((await read()).traceWindows[0]!.traces).not.toBe(truncated.traceWindows[0]!.traces);
  });

  it("matches synchronous selection, evidence, and measurement without blocking timers", async () => {
    const agentDir = makeTempDir();
    const older = writeSession(agentDir, "/repo", "old.jsonl", new Date(2020, 0, 1));
    const newer = writeSession(agentDir, "/repo", "new.jsonl", new Date(2021, 0, 1));
    writeSession(agentDir, "/other", "other.jsonl", new Date(2022, 0, 1));

    expect(await projectSessionFilesAsync(agentDir, "/repo")).toEqual([newer, older]);
    const files = machineSessionFiles(agentDir, "/repo");
    expect(await machineSessionFilesAsync(agentDir, "/repo")).toEqual(files);
    const expectedEvidence = sessionWindowEvidence(files);
    // setImmediate runs after the event loop's next poll phase, so it fires
    // exactly when the read yields to real I/O. A 0 ms timer has a 1 ms floor
    // and loses that race whenever the reads finish within a millisecond.
    let eventLoopAdvanced = false;
    const immediate = setImmediate(() => {
      eventLoopAdvanced = true;
    });
    const evidence = await sessionWindowEvidenceAsync(files);
    clearImmediate(immediate);
    expect(eventLoopAdvanced).toBe(true);
    expect(evidence).toEqual(expectedEvidence);
    expect(await measureSessionCorpusAsync({ files })).toEqual(measureSessionCorpus({ files }));
  });

  it("reads only the appended range when a cached session grows", async () => {
    const agentDir = makeTempDir();
    const file = writeSession(agentDir, "/repo", "live.jsonl", new Date(2021, 0, 1));
    const assistant = JSON.stringify({
      type: "message",
      message: { role: "assistant", provider: "provider-a", model: "model-a" },
    });
    fs.writeFileSync(file, `${assistant}\n${fs.readFileSync(file, "utf8")}`);
    const initialSize = fs.statSync(file).size;
    expect((await sessionWindowEvidenceAsync([file])).traces).toHaveLength(1);
    const stream = vi.spyOn(fs, "createReadStream");
    fs.appendFileSync(file, `${sessionLine()}\n`);
    const grownSize = fs.statSync(file).size;
    const evidence = await sessionWindowEvidenceAsync([file]);
    const options = stream.mock.calls.at(-1)?.[1] as { start?: number; end?: number } | undefined;
    stream.mockRestore();

    expect(evidence.traces).toHaveLength(2);
    expect(evidence.traces.map((trace) => trace.model)).toEqual([
      "provider-a/model-a",
      "provider-a/model-a",
    ]);
    expect(options).toMatchObject({ start: initialSize, end: grownSize - 1 });
  });

  it("falls back to a full scan after observing a partial appended line", async () => {
    const agentDir = makeTempDir();
    const file = writeSession(agentDir, "/repo", "partial.jsonl", new Date(2021, 0, 1));
    expect((await sessionWindowEvidenceAsync([file])).traces).toHaveLength(1);
    const line = sessionLine();
    const split = Math.floor(line.length / 2);
    fs.appendFileSync(file, line.slice(0, split));
    expect((await sessionWindowEvidenceAsync([file])).traces).toHaveLength(1);
    fs.appendFileSync(file, `${line.slice(split)}\n`);
    expect((await sessionWindowEvidenceAsync([file])).traces).toHaveLength(2);
  });

  it("bounds cached evidence by size but always keeps the active window", async () => {
    const agentDir = makeTempDir();
    // One audit with a 3 MB argument per session: eight sessions alone exceed
    // the cache's byte budget.
    const largeSession = (name: string): string => {
      const file = writeSession(agentDir, "/repo", name, new Date(2021, 0, 1));
      const record = JSON.parse(sessionLine());
      record.message.details.audits = [{ ref: "pi.write", args: { path: name, content: name.padEnd(3_000_000, "x") } }];
      fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
      return file;
    };
    const older = Array.from({ length: 6 }, (_, index) => largeSession(`older-${index}.jsonl`));
    const window = Array.from({ length: 8 }, (_, index) => largeSession(`window-${index}.jsonl`));
    await sessionWindowEvidenceAsync(older);
    const evidence = await sessionWindowEvidenceAsync(window);
    expect(evidence.observationWindows).toHaveLength(8);
    expect(sessionEvidenceCacheUsage().files).toBe(8);

    // The window is still cached: reading it again scans nothing.
    const stream = vi.spyOn(fs, "createReadStream");
    try {
      await sessionWindowEvidenceAsync(window);
      expect(stream).not.toHaveBeenCalled();
    } finally {
      stream.mockRestore();
    }
  });
});

describe("measureSessionCorpus", () => {
  it("measures sessions newest-first, skips trace-less files, and trends oldest to newest", () => {
    const agentDir = makeTempDir();
    writeSession(agentDir, "/repo", "old.jsonl", new Date(2020, 0, 1));
    writeSession(agentDir, "/repo", "new.jsonl", new Date(2021, 0, 1));
    const quietDir = path.join(agentDir, "sessions", encodeCwdDir("/repo"));
    fs.writeFileSync(path.join(quietDir, "quiet.jsonl"), "no fabric content here\n");
    fs.utimesSync(
      path.join(quietDir, "quiet.jsonl"),
      new Date(2022, 0, 1),
      new Date(2022, 0, 1),
    );
    const result = measureSessionCorpus({
      files: projectSessionFiles(agentDir, "/repo"),
    });
    expect(result.files).toHaveLength(3);
    expect(result.sessions.map((session) => path.basename(session.file))).toEqual([
      "new.jsonl",
      "old.jsonl",
    ]);
    expect(result.latest?.totals.operations).toBe(1);
    expect(result.trend.count).toBe(2);
    expect(result.trend.slopePerStep).toBe(0);
  });

  it("measures against the provided surface and carries the digest", () => {
    const agentDir = makeTempDir();
    const file = writeSession(agentDir, "/repo", "s.jsonl", new Date(2024, 0, 1));
    const surface: EntropySurfaceSnapshot = {
      version: 1,
      actions: [
        {
          ref: "pi.read",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["path", "limit"],
            properties: { path: { type: "string" }, limit: { type: "integer" } },
          },
        },
      ],
    };
    const result = measureSessionCorpus({ files: [file], surface, catalogDigest: "deadbeef" });
    expect(result.sessions).toHaveLength(1);
    expect(result.latest?.catalogDigest).toBe("deadbeef");
    expect(result.latest?.staticFreedom).toBe(1.5);
    expect(result.latest?.score).toBe(0);
    expect(result.latest?.staticScore).toBe(0.375);
    expect(result.latest?.behavioralScore).toBe(0);
  });

  it("handles an empty corpus", () => {
    const result = measureSessionCorpus({ files: [] });
    expect(result.sessions).toEqual([]);
    expect(result.latest).toBeUndefined();
    expect(result.trend).toEqual({ count: 0, slopePerStep: 0 });
  });
});

describe("trendFromScores", () => {
  it("computes the least-squares slope exactly", () => {
    expect(trendFromScores([0.6, 0.4, 0.2])).toMatchObject({
      count: 3,
      first: 0.6,
      last: 0.2,
      slopePerStep: -0.2,
    });
    expect(trendFromScores([])).toEqual({ count: 0, slopePerStep: 0 });
    expect(trendFromScores([5])).toEqual({ count: 1, first: 5, last: 5, slopePerStep: 0 });
  });
});

const traceEnvelope = (ref: string, args: Record<string, unknown>): unknown => ({
  kind: "pi-fabric.execution",
  version: 1,
  outcome: "succeeded",
  phases: ["build"],
  operations: [{ type: "call", sequence: 0, ref, args, outcome: "succeeded" }],
  counts: { droppedValues: 0, truncatedValues: 0, redactedValues: 0, droppedOperations: 0 },
});

const toolResultLine = (id: string, envelope: unknown): string =>
  JSON.stringify({
    id,
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: `c-${id}`,
      toolName: "fabric_exec",
      content: [{ type: "text", text: "ok" }],
      details: { success: true, trace: envelope, phases: ["build"] },
    },
  });

const assistantLine = (id: string, provider: string, model: string): string =>
  JSON.stringify({
    id,
    type: "message",
    message: { role: "assistant", provider, model, content: [] },
  });

const modelChangeLine = (id: string, provider: string, modelId: string): string =>
  JSON.stringify({ id, type: "model_change", provider, modelId });

const wobbleEnvelope = {
  kind: "pi-fabric.execution",
  version: 1,
  outcome: "succeeded",
  phases: ["build"],
  operations: [
    { type: "call", sequence: 0, ref: "pi.read", args: { path: "a" }, outcome: "succeeded" },
    { type: "call", sequence: 1, ref: "pi.read", args: { path: "a", limit: 5 }, outcome: "succeeded" },
  ],
  counts: { droppedValues: 0, truncatedValues: 0, redactedValues: 0, droppedOperations: 0 },
};

describe("per-model session attribution", () => {
  it("stamps traces with the producing model across a mid-session switch", () => {
    const content = [
      modelChangeLine("m1", "zro", "kimi-k3"),
      toolResultLine("t1", traceEnvelope("pi.read", { path: "a" })),
      assistantLine("a1", "coralbricks", "glm-5.3-fp4"),
      toolResultLine("t2", traceEnvelope("pi.read", { path: "b" })),
      // A user line quoting assistant-shaped text must not update the model.
      JSON.stringify({
        id: "u1",
        type: "message",
        message: {
          role: "user",
          content: 'quoted {"role":"assistant","provider":"evil","model":"poison"}',
        },
      }),
      toolResultLine("t3", traceEnvelope("pi.read", { path: "c" })),
    ].join("\n");
    const traces = entropyTracesFromSessionJsonl(content.split("\n"));
    expect(traces.map((trace) => trace.model)).toEqual([
      "zro/kimi-k3",
      "coralbricks/glm-5.3-fp4",
      "coralbricks/glm-5.3-fp4",
    ]);
  });

  it("aggregates per-model trends across the session window", () => {
    const agentDir = makeTempDir();
    const dir = path.join(agentDir, "sessions", encodeCwdDir("/repo"));
    fs.mkdirSync(dir, { recursive: true });
    const write = (name: string, mtime: Date, content: string): void => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `${content}\n`);
      fs.utimesSync(file, mtime, mtime);
    };
    write(
      "old.jsonl",
      new Date(2020, 0, 1),
      [assistantLine("a1", "p", "alpha"), toolResultLine("t1", traceEnvelope("pi.read", { path: "z" }))].join("\n"),
    );
    write(
      "new.jsonl",
      new Date(2021, 0, 1),
      [assistantLine("a2", "p", "alpha"), toolResultLine("t2", wobbleEnvelope)].join("\n"),
    );
    const result = measureSessionCorpus({ files: projectSessionFiles(agentDir, "/repo") });
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      model: "p/alpha",
      sessions: 2,
      latestBehavioralScore: 0,
      slopePerSession: 0,
      latestRejectionsPer1k: 0,
    });
  });

  it("merges window traces in one read, newest first", () => {
    const agentDir = makeTempDir();
    const dir = path.join(agentDir, "sessions", encodeCwdDir("/repo"));
    fs.mkdirSync(dir, { recursive: true });
    const write = (name: string, mtime: Date, content: string): void => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `${content}\n`);
      fs.utimesSync(file, mtime, mtime);
    };
    write(
      "old.jsonl",
      new Date(2020, 0, 1),
      [assistantLine("a1", "p", "alpha"), toolResultLine("t1", traceEnvelope("pi.read", { path: "a" }))].join("\n"),
    );
    write("new.jsonl", new Date(2021, 0, 1), [toolResultLine("t2", wobbleEnvelope)].join("\n"));
    const evidence = sessionWindowEvidence(projectSessionFiles(agentDir, "/repo"));
    expect(evidence.traces).toHaveLength(2);
    expect(evidence.traces.map((trace) => trace.model)).toEqual([undefined, "p/alpha"]);
    expect(evidence.traces.map((trace) => trace.operations[0]?.ref)).toEqual([
      "pi.read",
      "pi.read",
    ]);
  });

  it("sessionWindowEvidence collects verbatim audit calls", () => {
    const agentDir = makeTempDir();
    const dir = path.join(agentDir, "sessions", encodeCwdDir("/repo"));
    fs.mkdirSync(dir, { recursive: true });
    const write = (name: string, mtime: Date, content: string): void => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `${content}\n`);
      fs.utimesSync(file, mtime, mtime);
    };
    write(
      "audits.jsonl",
      new Date(2021, 0, 1),
      JSON.stringify({
        id: "t3",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "c-t3",
          toolName: "fabric_exec",
          content: [{ type: "text", text: "ok" }],
          details: {
            success: true,
            trace: traceEnvelope("pi.read", { path: "a" }),
            audits: [{ ref: "mcp.render", args: { format: "pdf" } }],
          },
        },
      }),
    );
    const evidence = sessionWindowEvidence(projectSessionFiles(agentDir, "/repo"));
    expect(evidence.auditCalls).toEqual([{ ref: "mcp.render", args: { format: "pdf" } }]);
  });
});
