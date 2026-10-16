import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActorBindingStore } from "../src/actors/binding-store.js";
import { ActorStoreReadError } from "../src/actors/store-read.js";

// Mode 000 does not stop the read on Windows or for root.
const unreadableFileSkip =
  process.platform === "win32"
    ? "Windows does not deny reads by POSIX mode bits"
    : process.getuid?.() === 0
      ? "root reads a mode-000 file"
      : undefined;

const roots: string[] = [];

const setup = (): { first: ActorBindingStore; second: ActorBindingStore } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-bindings-"));
  roots.push(root);
  return {
    first: new ActorBindingStore("session:shared", root),
    second: new ActorBindingStore("session:shared", root),
  };
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ActorBindingStore", () => {
  it("merges unrelated writes from stale stores under one session lock", async () => {
    const { first, second } = setup();

    await first.setModel("actor:a", "provider/model-a");
    await second.setThinking("actor:b", "high");

    expect(first.get("actor:a")).toMatchObject({ model: "provider/model-a" });
    expect(first.get("actor:b")).toMatchObject({ thinking: "high" });
    expect(second.get("actor:a")).toMatchObject({ model: "provider/model-a" });
  });

  it("deletes a binding from the latest file instead of a stale snapshot", async () => {
    const { first, second } = setup();
    await first.setModel("actor:a", "provider/model-a");
    await first.setModel("actor:b", "provider/model-b");

    await second.delete("actor:a");

    expect(first.get("actor:a")).toBeUndefined();
    expect(first.get("actor:b")).toMatchObject({ model: "provider/model-b" });
  });
});

describe("ActorBindingStore read failures", () => {
  const sessionId = "session:shared";
  const freshRoot = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-bindings-"));
    roots.push(root);
    return root;
  };
  /** The binding file path, learned from a store with no file yet. */
  const bindingFile = (root: string): string => new ActorBindingStore(sessionId, root).filePath!;
  const writeRaw = (root: string, raw: string): string => {
    const file = bindingFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, raw);
    return file;
  };
  const saved = (model: string) => ({ model, updatedAt: 1 });
  const expectMutationsRefused = async (store: ActorBindingStore): Promise<void> => {
    await expect(store.setModel("actor:b", "provider/model-b")).rejects.toThrow(ActorStoreReadError);
    await expect(store.setThinking("actor:b", "high")).rejects.toThrow(ActorStoreReadError);
    await expect(store.delete("actor:a")).rejects.toThrow(ActorStoreReadError);
  };

  it.each([
    ["truncated JSON", JSON.stringify({ format: 1, sessionId, bindings: { "actor:a": saved("m") } }).slice(0, -2)],
    ["a non-object document", "null"],
    ["another session's file", JSON.stringify({ format: 1, sessionId: "session:other", bindings: {} })],
    ["a non-object bindings field", JSON.stringify({ format: 1, sessionId, bindings: [] })],
  ])("refuses to save over %s", async (_label, raw) => {
    const root = freshRoot();
    const file = writeRaw(root, raw);
    const store = new ActorBindingStore(sessionId, root);
    expect(store.readError).toBeInstanceOf(ActorStoreReadError);
    expect(store.readError?.message).toContain(file);
    await expectMutationsRefused(store);
    expect(fs.readFileSync(file, "utf8")).toBe(raw);
  });

  it(
    "refuses to save over a binding file it has no permission to read",
    async ({ skip }) => {
      skip(unreadableFileSkip !== undefined, unreadableFileSkip);
      const root = freshRoot();
      const raw = JSON.stringify({ format: 1, sessionId, bindings: { "actor:a": saved("provider/model-a") } });
      const file = writeRaw(root, raw);
      const store = new ActorBindingStore(sessionId, root);
      fs.chmodSync(file, 0o000);
      try {
        await expectMutationsRefused(store);
      } finally {
        fs.chmodSync(file, 0o600);
      }
      expect(fs.readFileSync(file, "utf8")).toBe(raw);
    },
  );

  it("refuses to save when the binding path is a directory", async () => {
    const root = freshRoot();
    const file = bindingFile(root);
    fs.mkdirSync(path.join(file, "keep"), { recursive: true });
    const store = new ActorBindingStore(sessionId, root);
    expect((store.readError?.cause as NodeJS.ErrnoException | undefined)?.code).toBe("EISDIR");
    await expectMutationsRefused(store);
    expect(fs.readdirSync(file)).toEqual(["keep"]);
  });

  it("loads a missing binding file as empty", async () => {
    const root = freshRoot();
    const store = new ActorBindingStore(sessionId, root);
    expect(store.readError).toBeUndefined();
    expect(store.get("actor:a")).toBeUndefined();
    await store.setModel("actor:a", "provider/model-a");
    expect(new ActorBindingStore(sessionId, root).get("actor:a")).toMatchObject({ model: "provider/model-a" });
  });

  it("clears the read error once the file reads again", async () => {
    const root = freshRoot();
    const file = writeRaw(root, "{");
    const store = new ActorBindingStore(sessionId, root);
    expect(store.readError).toBeInstanceOf(ActorStoreReadError);
    fs.writeFileSync(file, JSON.stringify({ format: 1, sessionId, bindings: { "actor:a": saved("provider/model-a") } }));
    expect(store.get("actor:a")).toMatchObject({ model: "provider/model-a" });
    expect(store.readError).toBeUndefined();
  });

  it("keeps entries that fail validation when it rewrites the file", async () => {
    const root = freshRoot();
    const noTimestamp = { model: "provider/no-timestamp" };
    const empty = { updatedAt: 2 };
    const file = writeRaw(root, JSON.stringify({
      format: 1,
      sessionId,
      bindings: { "actor:a": saved("provider/model-a"), "actor:x": noTimestamp, "actor:y": empty, "actor:z": "legacy" },
    }));
    const store = new ActorBindingStore(sessionId, root);

    await store.setModel("actor:b", "provider/model-b");

    const written = JSON.parse(fs.readFileSync(file, "utf8")) as { bindings: Record<string, unknown> };
    expect(written.bindings).toMatchObject({
      "actor:a": saved("provider/model-a"),
      "actor:b": { model: "provider/model-b" },
      "actor:x": noTimestamp,
      "actor:y": empty,
      "actor:z": "legacy",
    });
  });

  it("replaces an invalid entry when that actor's binding is set", async () => {
    const root = freshRoot();
    const file = writeRaw(root, JSON.stringify({ format: 1, sessionId, bindings: { "actor:x": "legacy" } }));
    const store = new ActorBindingStore(sessionId, root);

    await store.setModel("actor:x", "provider/model-x");

    const written = JSON.parse(fs.readFileSync(file, "utf8")) as { bindings: Record<string, unknown> };
    expect(written.bindings["actor:x"]).toMatchObject({ model: "provider/model-x" });
  });
});
