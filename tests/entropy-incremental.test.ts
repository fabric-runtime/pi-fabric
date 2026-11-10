import v8 from "node:v8";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundEntropyCompiler, compileEntropySurface } from "../src/entropy/compiler.js";
import { SessionEntropyMeter, measureEntropy, type EntropyTraceWindow } from "../src/entropy/meter.js";
import { SessionObservationCache, mergeObservationWindow, type EntropyObservationPoolFile } from "../src/entropy/pool.js";
import { BackgroundSessionSelector } from "../src/entropy/sessions.js";
import * as normalForms from "../src/entropy/normal-form.js";
import type { EntropySurfaceSnapshot, EntropyTraceInput, EntropyValueObservation } from "../src/entropy/types.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const surface: EntropySurfaceSnapshot = { version: 1, actions: [{ ref: "demo.run", inputSchema: {
  type: "object", additionalProperties: false, properties: { mode: { type: "string", enum: ["fast", "safe"] } },
} }] };
const trace = (i: number): EntropyTraceInput => ({
  ...(i % 3 ? { model: `p/m${i % 2}` } : {}), taskKey: `task${i % 4}`,
  operations: [
    { ref: "fabric.discovery.list", args: {}, outcome: "succeeded" },
    { ref: "demo.run", args: { Mode: "fast" }, outcome: "failed", failureStage: "validate" },
    { ref: "demo.run", args: { mode: "fast", count: i }, outcome: "succeeded" },
    { ref: "demo.other", args: {}, outcome: i % 2 ? "timed_out" : "aborted" },
  ],
});

describe("incremental session entropy", () => {
  it("matches the pure meter across append, reorder, removal, rewrite, truncation and schema/repair changes", async () => {
    const meter = new SessionEntropyMeter();
    const a = [trace(0), trace(1)];
    const b = [trace(2), trace(3)];
    const grown = [...a, trace(4)];
    const versions: EntropyTraceWindow[][] = [
      [{ file: "a", traces: a }, { file: "b", traces: b }],
      [{ file: "a", traces: a }, { file: "b", traces: b }],
      [{ file: "a", traces: grown }, { file: "b", traces: b }],
      [{ file: "b", traces: b }, { file: "a", traces: grown }],
      [{ file: "a", traces: [trace(5), trace(6), trace(7)] }],
      [{ file: "a", traces: [trace(8)] }],
      [],
      [{ file: "b", traces: b }],
    ];
    for (const windows of versions) {
      for (const input of [{ surface }, { surface: { version: 1 as const, actions: [] }, repairs: [
        { kind: "keyAlias" as const, ref: "demo.run", from: "Mode", to: "mode" },
      ], catalogDigest: "changed" }]) {
        const expected = measureEntropy({ ...input, traces: windows.flatMap(window => [...window.traces]) });
        expect(await meter.measure(windows, input)).toEqual(expected);
      }
    }
  });

  it("matches mixed diagnostic distributions across many independently cached windows", async () => {
    const meter = new SessionEntropyMeter();
    const windows = Array.from({ length: 8 }, (_, file) => ({ file: String(file), traces:
      Array.from({ length: 90 }, (_, i): EntropyTraceInput => ({
        model: `p/model${i % 3}`, taskKey: `task${(i + file) % 7}`,
        operations: Array.from({ length: 8 }, (_, j) => ({ ref: `demo.r${j % 4}`,
          args: Object.fromEntries(Array.from({ length: (file + i + j) % 6 }, (_, k) => [`k${k}`, k % 2 ? i : "x"])),
          outcome: j < 4 ? "failed" : "succeeded", failureStage: j % 2 ? "validate" : "invoke",
        })),
      })),
    }));
    const expected = measureEntropy({ traces: windows.flatMap(window => window.traces), surface });
    expect(await meter.measure(windows, { surface })).toEqual(expected);
    expect(await meter.measure(windows, { surface })).toEqual(expected);
  });

  it("never re-reads old operation arguments on warm or appended windows and detaches reports", async () => {
    let reads = 0;
    const counted: EntropyTraceInput = { model: "p/model", operations: [
      { ref: "demo.run", get args() { reads++; return { mode: "fast" }; }, outcome: "succeeded" },
    ] };
    const meter = new SessionEntropyMeter();
    const traces = [counted];
    const first = await meter.measure([{ file: "a", traces }], { surface });
    const initialReads = reads;
    expect(initialReads).toBeGreaterThan(0);
    first.totals.operations = 999;
    expect((await meter.measure([{ file: "a", traces }], { surface })).totals.operations).toBe(1);
    await meter.measure([{ file: "a", traces: [...traces, trace(0)] }], { surface });
    expect(reads).toBe(initialReads);
    for (let i = 0; i < 16; i++) await meter.measure([{ file: `evict-${i}`, traces: [] }], {});
    await meter.measure([{ file: "a", traces }], {});
    expect(reads).toBeGreaterThan(initialReads);
  });

  it("matches full compilation while caching schema plans and keeping advisories on demand", async () => {
    const compiler = new BackgroundEntropyCompiler();
    const traces = [trace(1)];
    const windows = [{ file: "a", traces }];
    const expected = compileEntropySurface({ surface, traces });
    const derive = vi.spyOn(normalForms, "deriveNormalFormPlan");
    const first = await compiler.compile({ surface, windows });
    expect(first).toEqual(expected);
    expect(derive).toHaveBeenCalledTimes(surface.actions.length);
    const second = await compiler.compile({ surface: structuredClone(surface), windows, artifact: first.artifact! });
    expect(second.status).toBe("converged");
    expect(derive).toHaveBeenCalledTimes(surface.actions.length);
    const changed = structuredClone(surface);
    (changed.actions[0]!.inputSchema as { properties: { mode: { enum: string[] } } }).properties.mode.enum.push("other");
    const next = await compiler.compile({ surface: changed, windows, artifact: first.artifact! });
    expect(derive).toHaveBeenCalledTimes(2);
    expect(next).toEqual(compileEntropySurface({ surface: changed, traces, artifact: first.artifact! }));

    const advisoryTraces: EntropyTraceInput[] = Array.from({ length: 3 }, () => ({ operations:
      ["demo.a", "demo.b", "demo.c"].map(ref => ({ ref, args: {}, outcome: "succeeded" as const })),
    }));
    const full = compileEntropySurface({ surface, traces: advisoryTraces });
    expect(full.proposals.some(proposal => proposal.kind === "sequence-fuse")).toBe(true);
    const background = await compiler.compile({ surface, windows: [{ file: "advisory", traces: advisoryTraces }] });
    expect(background).toEqual({ ...full, proposals: full.proposals.filter(proposal => proposal.kind === "normal-form") });
  });
});

describe("incremental observation pool", () => {
  it("preserves weighted counts and legacy digests through unchanged, appended and rewritten windows", async () => {
    const cache = new SessionObservationCache();
    let pool: EntropyObservationPoolFile | undefined;
    const observation = (i: number): EntropyValueObservation => ({ ref: "demo.run", key: "mode", value: i % 3, count: i + 1 });
    const a = Array.from({ length: 1100 }, (_, i) => observation(i));
    for (const observations of [a, a, [...a, observation(1101)], [observation(3)], [], a]) {
      const windows = [{ file: "a", observations }];
      const expected = mergeObservationWindow(pool, windows);
      const actual = await cache.merge(pool, windows);
      expect(actual).toEqual(expected);
      pool = actual.file;
    }
  });

  it("does not revisit old observation values, isolates returned counts, and bounds retained windows", async () => {
    const cache = new SessionObservationCache();
    let reads = 0;
    const observations: EntropyValueObservation[] = [{ ref: "demo.run", key: "mode", get value() { reads++; return "fast"; } }];
    const windows = [{ file: "a", observations }];
    const first = await cache.merge(undefined, windows);
    const initialReads = reads;
    const expected = structuredClone(first);
    first.file.tracked[0]!.counts = {};
    expect(await cache.merge(undefined, windows)).toEqual(expected);
    await cache.merge(expected.file, [{ file: "a", observations: [...observations, { ref: "demo.run", key: "mode", value: "safe" }] }]);
    expect(reads).toBe(initialReads);
    for (let i = 0; i < 16; i++) await cache.merge(undefined, [{ file: `evict-${i}`, observations: [] }]);
    await cache.merge(undefined, windows);
    expect(reads).toBeGreaterThan(initialReads);
  });
});

describe("observation cache retention", () => {
  it("keeps summaries without pinning the session's observation arrays", async () => {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    const cache = new SessionObservationCache();
    let collected = false;
    const registry = new FinalizationRegistry<void>(() => { collected = true; });
    const before = await (async () => {
      const observations = Array.from({ length: 10_000 }, (_, i) => ({ ref: "demo.run", key: "mode", value: `v${i % 7}` }));
      registry.register(observations);
      return cache.summarize([{ file: "a", observations }]);
    })();
    for (let attempt = 0; attempt < 10 && !collected; attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      gc();
    }
    expect(collected).toBe(true);
    expect(before[0]!.summary.counts["demo.run\u0000mode\u0000string:v0"]).toBe(1_429);
  });
});

describe("background session discovery", () => {
  it("amortizes full scans for 30 seconds, always includes the current file, and isolates returned lists", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const files = Array.from({ length: 8 }, (_, i) => `session-${i}`);
    const scan = vi.fn(async () => files);
    const selector = new BackgroundSessionSelector(scan);
    const first = await selector.select("agent", "cwd", "active");
    expect(first).toEqual(["active", ...files.slice(0, 7)]);
    first.length = 0;
    vi.setSystemTime(29_999);
    expect(await selector.select("agent", "cwd", "fork")).toEqual(["fork", ...files.slice(0, 7)]);
    expect(scan).toHaveBeenCalledOnce();
    vi.setSystemTime(30_000);
    await selector.select("agent", "cwd", "fork");
    expect(scan).toHaveBeenCalledTimes(2);
    await selector.select("other-agent", "cwd");
    await selector.select("other-agent", "other-cwd");
    expect(scan).toHaveBeenCalledTimes(4);
  });

  it("does not cache an absent session directory", async () => {
    const scan = vi.fn(async () => [] as string[]);
    const selector = new BackgroundSessionSelector(scan);
    await selector.select("agent", "cwd"); await selector.select("agent", "cwd");
    expect(scan).toHaveBeenCalledTimes(2);
  });
});
