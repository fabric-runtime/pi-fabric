import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { withExclusiveFileLockAsync } from "../src/core/file-lock.js";
import { SessionObservationCache, type EntropyObservationWindow } from "../src/entropy/pool.js";
import { observationPoolDirectory, updateObservationPoolAsync } from "../src/entropy/pool-store.js";
import { ObservationPoolWriter } from "../src/entropy/pool-writer.js";

// The worker is a published build entry. Exercise the built writer and its
// default URL; CI runs affected tests before `bun run build`, so skip when
// dist/ is absent.
const distIndex = path.resolve("dist/entropy/index.js");
const dist = fs.existsSync(distIndex)
  ? await import(pathToFileURL(distIndex).href) as typeof import("../src/entropy/index.js")
  : undefined;

const roots: string[] = [];
const writers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(writers.splice(0).map((writer) => writer.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const agentDir = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-pool-writer-"));
  roots.push(root);
  return root;
};
const poolFile = (dir: string): string => path.join(observationPoolDirectory(dir), "observation-pool.json");
const windows = (sessions: number, refs: number, values: number): EntropyObservationWindow[] =>
  Array.from({ length: sessions }, (_, session) => ({
    file: `/sessions/session-${session}.jsonl`,
    observations: Array.from({ length: refs * values }, (_, index) => ({
      ref: `extensions.tool${index % refs}`,
      key: `path${index % 7}`,
      value: `src/module-${session}-${Math.floor(index / refs) % values}-${"x".repeat(24)}.ts`,
    })),
  }));

describe("observation pool writer", () => {
  it("falls back to this thread when the worker cannot start, with the same pool", async () => {
    const expectedDir = agentDir();
    const actualDir = agentDir();
    const input = windows(4, 40, 12);
    await updateObservationPoolAsync(expectedDir, input);
    const writer = new ObservationPoolWriter(pathToFileURL(path.join(actualDir, "missing-worker.js")));
    writers.push(writer);
    const cache = new SessionObservationCache();
    await expect(writer.update(actualDir, input, cache)).resolves.toEqual({ written: true });
    expect(writer.inProcess).toBe(true);
    expect(fs.readFileSync(poolFile(actualDir), "utf8")).toBe(fs.readFileSync(poolFile(expectedDir), "utf8"));
    await expect(writer.update(actualDir, input, cache)).resolves.toEqual({ written: false });
  });

  it.skipIf(!dist)("writes on a worker thread, byte-identical to the in-process update", async () => {
    const expectedDir = agentDir();
    const actualDir = agentDir();
    const input = windows(6, 60, 16);
    await updateObservationPoolAsync(expectedDir, input);
    const writer = new dist!.ObservationPoolWriter();
    writers.push(writer);
    const cache = new dist!.SessionObservationCache();
    await expect(writer.update(actualDir, input, cache)).resolves.toEqual({ written: true });
    expect(writer.inProcess).toBe(false);
    expect(fs.readFileSync(poolFile(actualDir), "utf8")).toBe(fs.readFileSync(poolFile(expectedDir), "utf8"));
    await expect(writer.update(actualDir, input, cache)).resolves.toEqual({ written: false });
  });

  it.skipIf(!dist)("keeps lock contention retryable across the thread boundary", async () => {
    const dir = agentDir();
    const writer = new dist!.ObservationPoolWriter();
    writers.push(writer);
    const cache = new dist!.SessionObservationCache();
    const input = windows(1, 4, 2);
    let release!: () => void;
    const held = withExclusiveFileLockAsync({
      directory: observationPoolDirectory(dir), lockName: "observation-pool.lock",
      timeoutMessage: "held by test", attempts: 1, delayMs: 1, staleMs: 60_000,
    }, () => new Promise<void>((resolve) => { release = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const error = await writer.update(dir, input, cache).catch((caught: unknown) => caught);
    release();
    await held;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("FileLockTimeoutError");
    // Rebuilt from the bundled class, so the extension's `instanceof` retry check holds.
    expect((error as Error).message).toContain("observation pool lock");
  });

  it.skipIf(!dist)("leaves the event loop free while a large pool is rewritten", async () => {
    const dir = agentDir();
    const input = windows(16, 512, 16);
    // Seed a pool of several megabytes, as long-lived machines accumulate.
    await updateObservationPoolAsync(dir, input);
    expect(fs.statSync(poolFile(dir)).size).toBeGreaterThan(2_000_000);
    const writer = new dist!.ObservationPoolWriter();
    writers.push(writer);
    const cache = new dist!.SessionObservationCache();
    const next = input.map((window) => ({ ...window, observations: [...window.observations, { ref: "extensions.tool0", key: "path0", value: "fresh.ts" }] }));
    await writer.update(dir, input, cache); // start the thread
    const delay = monitorEventLoopDelay({ resolution: 2 });
    delay.enable();
    const started = performance.now();
    await expect(writer.update(dir, next, cache)).resolves.toEqual({ written: true });
    const elapsed = performance.now() - started;
    delay.disable();
    // Structural, not a timing budget: the update takes far longer than any
    // single stall of this thread while it runs.
    expect(delay.max / 1e6).toBeLessThan(Math.max(50, elapsed / 2));
  });
});
