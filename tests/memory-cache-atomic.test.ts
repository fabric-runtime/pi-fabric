import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as recall from "../packages/pi-recall/src/memory/index.js";
import * as fabric from "../src/memory/index.js";
import { messageEntry, sessionHeader, userMessage, writeSessionFile } from "./fixtures/memory.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const cases = [
  { name: "Fabric shard", kind: "shard", load: fabric.loadShard, cachePath: fabric.shardPathForSession },
  { name: "Fabric digest", kind: "digest", load: fabric.loadDigest, cachePath: fabric.digestPathForSession },
  { name: "Recall shard", kind: "shard", load: recall.loadShard, cachePath: recall.shardPathForSession },
  { name: "Recall digest", kind: "digest", load: recall.loadDigest, cachePath: recall.digestPathForSession },
] as const;

const fixture = (cachePath: typeof fabric.shardPathForSession) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-cache-atomic-"));
  roots.push(root);
  const writeSource = (text: string) => writeSessionFile(root, "source.jsonl", [
    sessionHeader("atomic-test", root),
    messageEntry("first", null, "2024-12-03T14:00:01.000Z", userMessage(text)),
  ]);
  const file = writeSource("old token");
  const ref = { id: "atomic-test", file, cwd: root, mtime: 0 };
  const indexDir = path.join(root, "index");
  const options = { indexDir, maxEntryChars: 2_000 };
  return { root, ref, options, cache: cachePath(file, indexDir), writeSource };
};

// Run the actual Bun consumer while Fabric is stopped at a synchronous FS
// boundary. No sleep or PID coordination is needed to pick the interleaving.
const runRecall = (ref: ReturnType<typeof fixture>["ref"], options: ReturnType<typeof fixture>["options"], kind: string) => {
  const result = spawnSync("bun", ["-e", `
    import { loadShard, loadDigest } from './packages/pi-recall/src/memory/index.ts';
    const { ref, options, kind } = JSON.parse(process.env.PI_TEST_MEMORY_INPUT);
    console.log(JSON.stringify((kind === 'shard' ? loadShard : loadDigest)(ref, options)));
  `], {
    env: { ...process.env, PI_TEST_MEMORY_INPUT: JSON.stringify({ ref, options, kind }) },
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) throw new Error(`pi-recall child failed: ${result.error ?? result.stderr}`);
  return JSON.parse(result.stdout) as { sourceHash: string };
};

describe.each(cases)("$name cache publication", ({ load, cachePath, kind }) => {
  it("leaves the old JSON visible through a failed rename and cleans only its own temp", () => {
    const { ref, options, cache, writeSource } = fixture(cachePath);
    const before = load(ref, options);
    const oldBytes = fs.readFileSync(cache, "utf8");
    const foreign = path.join(options.indexDir, "foreign.tmp");
    fs.writeFileSync(foreign, "not ours");
    writeSource("new and longer source text");
    const rename = fs.renameSync;
    let observed: { oldBytes: string; tempBytes: string; temp: string } | undefined;
    const intercepted = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to !== cache) return rename(from, to);
      observed = { oldBytes: fs.readFileSync(cache, "utf8"), tempBytes: fs.readFileSync(from, "utf8"), temp: String(from) };
      throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
    });
    const rebuilt = load(ref, options);
    expect(observed?.oldBytes).toBe(oldBytes);
    expect(path.dirname(observed!.temp)).toBe(options.indexDir);
    expect(JSON.parse(observed!.tempBytes)).toEqual(rebuilt);
    expect(rebuilt.sourceHash).not.toBe(before.sourceHash);
    expect(fs.readFileSync(cache, "utf8")).toBe(oldBytes);
    expect(fs.readFileSync(foreign, "utf8")).toBe("not ours");
    expect(fs.readdirSync(options.indexDir).sort()).toEqual([path.basename(cache), "foreign.tmp"].sort());
    intercepted.mockRestore();
    expect(JSON.parse(fs.readFileSync(cache, "utf8")).sourceHash).toBe(before.sourceHash);
    expect(load(ref, options)).toEqual(rebuilt);
    expect(JSON.parse(fs.readFileSync(cache, "utf8"))).toEqual(rebuilt);
  });

  it("never truncates or removes a temp whose exclusive create failed", () => {
    const { ref, options, cache } = fixture(cachePath);
    const open = fs.openSync;
    let occupied: string | undefined;
    vi.spyOn(fs, "openSync").mockImplementation((name, flags, mode) => {
      if (typeof name === "string" && name.endsWith(".tmp") && flags === "wx") {
        occupied = name;
        const fd = open(name, "wx");
        try { fs.writeFileSync(fd, "other owner's bytes"); } finally { fs.closeSync(fd); }
      }
      return open(name, flags, mode);
    });
    expect(load(ref, options).kind).toBe(kind);
    expect(occupied).toBeDefined();
    expect(fs.readFileSync(occupied!, "utf8")).toBe("other owner's bytes");
    expect(fs.existsSync(cache)).toBe(false);
    expect(fs.readdirSync(options.indexDir)).toEqual([path.basename(occupied!)]);
  });

  it("validates the file opened even if a different-size inode becomes visible", () => {
    const { root, ref, options, cache } = fixture(cachePath);
    // Seed a record with stable byte metadata so this tests the fd read,
    // independently of how the writer rounds cacheSourceRatio.
    const cached = { ...load(ref, options), cacheSourceRatio: 1, cacheBytes: 0 };
    cached.cacheBytes = Buffer.byteLength(JSON.stringify(cached));
    cached.cacheBytes = Buffer.byteLength(JSON.stringify(cached));
    fs.writeFileSync(cache, JSON.stringify(cached));
    expect(load(ref, options)).toEqual(cached);
    const next = path.join(root, "next");
    const opened = path.join(root, "opened");
    fs.writeFileSync(next, "{invalid replacement");
    const open = fs.openSync;
    let swapped = false;
    vi.spyOn(fs, "openSync").mockImplementation((name, flags, mode) => {
      if (swapped || name !== cache) return open(name, flags, mode);
      swapped = true;
      // Model the same situation at the open boundary: the fd names the old
      // file while the pathname names new bytes. Windows cannot reliably
      // rename over an already-open destination, so park the original first.
      fs.renameSync(cache, opened);
      const fd = open(opened, flags, mode);
      try { fs.renameSync(next, cache); }
      catch (error) { fs.closeSync(fd); throw error; }
      return fd;
    });
    expect(load(ref, options)).toEqual(cached);
    expect(swapped).toBe(true);
    expect(fs.readFileSync(cache, "utf8")).toBe("{invalid replacement");
  });

  it.skipIf(process.platform === "win32")("honors a directory link but replaces rather than follows a cache-file link", () => {
    const { root, ref, options, cache } = fixture(cachePath);
    const actualIndex = path.join(root, "actual-index");
    const outside = path.join(root, "outside");
    fs.mkdirSync(actualIndex);
    fs.symlinkSync(actualIndex, options.indexDir, "dir");
    fs.writeFileSync(outside, "untouched");
    fs.symlinkSync(outside, cache, "file");
    expect(load(ref, options).kind).toBe(kind);
    expect(fs.lstatSync(options.indexDir).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(cache).isFile()).toBe(true);
    expect(fs.statSync(cache).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(outside, "utf8")).toBe("untouched");
  });
});

it("keeps the repair a real Bun process publishes between Fabric's scan and eviction lock", () => {
  const { ref, options, cache } = fixture(fabric.digestPathForSession);
  fs.mkdirSync(options.indexDir);
  fs.writeFileSync(cache, "{malformed cache");
  const mkdir = fs.mkdirSync;
  let repaired: { sourceHash: string } | undefined;
  let failed: unknown;
  vi.spyOn(fs, "mkdirSync").mockImplementation(((name: fs.PathLike, mode?: fs.MakeDirectoryOptions) => {
    if (name === `${cache}.lock`) {
      try { repaired = runRecall(ref, options, "digest"); } catch (error) { failed = error; }
    }
    return mkdir(name, mode);
  }) as typeof fs.mkdirSync);
  fabric.loadTieredIndex([], [], options);
  expect(failed).toBeUndefined();
  expect(repaired?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.parse(fs.readFileSync(cache, "utf8"))).toEqual(repaired);
  expect(fs.readdirSync(options.indexDir)).toEqual([path.basename(cache)]);
});

it("returns a usable uncached result under cross-process contention without stealing an old lock", () => {
  const { ref, options, cache, writeSource } = fixture(fabric.shardPathForSession);
  const first = fabric.loadShard(ref, options);
  writeSource("other process can still find this new token");
  const rename = fs.renameSync;
  let during: { sourceHash: string; loaded: { sourceHash: string }; names: string[] } | undefined;
  let failed: unknown;
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === cache) {
      try {
        fs.utimesSync(`${cache}.lock`, 1, 1);
        const loaded = runRecall(ref, options, "shard");
        const { sourceHash } = JSON.parse(fs.readFileSync(cache, "utf8")) as { sourceHash: string };
        during = { sourceHash, loaded, names: fs.readdirSync(options.indexDir).sort() };
      } catch (error) { failed = error; }
    }
    return rename(from, to);
  });
  const updated = fabric.loadShard(ref, options);
  expect(failed).toBeUndefined();
  expect(updated.sourceHash).not.toBe(first.sourceHash);
  expect(during?.sourceHash).toBe(first.sourceHash);
  expect(during?.loaded).toEqual(updated);
  expect(during?.names).toHaveLength(3);
  expect(during?.names).toEqual(expect.arrayContaining([
    path.basename(cache), `${path.basename(cache)}.lock`, expect.stringMatching(/\.tmp$/),
  ]));
  expect(fs.readdirSync(options.indexDir)).toEqual([path.basename(cache)]);
  expect(JSON.parse(fs.readFileSync(cache, "utf8"))).toEqual(updated);
});
