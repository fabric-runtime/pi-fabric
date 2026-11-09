import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { pageSessionHistory } from "../src/memory/history-paging.js";

const message = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });
const large = "λ漢字\\n\"".repeat(8000);

describe("inactive session payload paging", () => {
  it("preserves entry identities, JSON, branch navigation and current context", async () => {
    const manager = SessionManager.inMemory();
    const first = manager.appendMessage(message(large));
    manager.appendMessage(message("small old message"));
    const current = manager.appendMessage(message("current task"));
    manager.appendCompaction("Summary", current, 10000);
    const cachedEntries = manager.getEntries(); // pi-tps and other history consumers retain these.
    const before = JSON.stringify(manager.getEntries());
    const context = JSON.stringify(manager.buildSessionContext());
    const live = manager.getEntry(first)!;
    const cachedMessage = Object.getOwnPropertyDescriptor(live, "message")!.value as object;
    const result = await pageSessionHistory(manager);
    expect(result.entries).toBe(1);
    expect(result.bytes).toBeGreaterThan(16000);
    expect(manager.getEntry(first)).toBe(live);
    expect(cachedEntries[0]).toBe(live);
    expect(Object.getOwnPropertyDescriptor(live, "message")?.value).toBe(cachedMessage);
    expect(Object.getOwnPropertyDescriptor(cachedMessage, "content")?.get).toBeTypeOf("function");
    expect(JSON.stringify(manager.getEntries())).toBe(before);
    expect(JSON.stringify(manager.buildSessionContext())).toBe(context);
    expect(await pageSessionHistory(manager)).toEqual({ entries: 0, bytes: 0 });
    manager.branch(first);
    expect(manager.buildSessionContext().messages[0]).toEqual(message(large));
    expect((await pageSessionHistory(manager)).entries).toBe(0);
  });

  it("does not rewrite the source file and preserves labels, tree and extension state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-paging-test-"));
    try {
      const seed = SessionManager.inMemory();
      const old = seed.appendMessage(message(large));
      seed.appendLabelChange(old, "keep me");
      seed.appendCustomEntry("extension-state", { keep: true });
      seed.appendCompaction("summary", null, 10000);
      const file = path.join(root, "session.jsonl");
      const original = [seed.getHeader(), ...seed.getEntries()].map(row => JSON.stringify(row)).join("\n") + "\n";
      fs.writeFileSync(file, original);
      const manager = SessionManager.open(file, root);
      const tree = JSON.stringify(manager.getTree());
      expect((await pageSessionHistory(manager)).entries).toBe(1);
      expect(fs.readFileSync(file, "utf8")).toBe(original);
      expect(manager.getLabel(old)).toBe("keep me");
      expect(JSON.stringify(manager.getTree())).toBe(tree);
      expect(manager.getEntries().find(row => row.type === "custom")).toMatchObject({ data: { keep: true } });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("keeps cached message identity and metadata reads independent of the cold body", async () => {
    const manager = SessionManager.inMemory();
    const id = manager.appendMessage(message(large));
    manager.appendCompaction("summary", null, 10000);
    const cached = Object.getOwnPropertyDescriptor(manager.getEntry(id)!, "message")!.value as { role: string; content: unknown; timestamp: number };
    await pageSessionHistory(manager);
    const descriptor = Object.getOwnPropertyDescriptor(cached, "content")!;
    const readBody = vi.fn(descriptor.get);
    Object.defineProperty(cached, "content", { ...descriptor, get: readBody });
    expect(Object.getOwnPropertyDescriptor(manager.getEntry(id)!, "message")!.value).toBe(cached);
    expect(cached.role).toBe("user");
    expect(cached.timestamp).toBe(1);
    expect(readBody).not.toHaveBeenCalled();
    expect(cached.content).toBe(large);
    expect(readBody).toHaveBeenCalledOnce();
  });
  it("never pages active messages or changes custom extension state", async () => {
    const manager = SessionManager.inMemory();
    const id = manager.appendMessage(message(large));
    const custom = manager.appendCustomEntry("extension-state", { data: large });
    expect(await pageSessionHistory(manager)).toEqual({ entries: 0, bytes: 0 });
    expect(Object.getOwnPropertyDescriptor(manager.getEntry(id), "message")?.value).toEqual(message(large));
    expect(manager.getEntry(custom)).toMatchObject({ data: { data: large } });
  });

  it("supports whole-message replacement and does not replace foreign getters", async () => {
    const manager = SessionManager.inMemory();
    const id = manager.appendMessage(message(large));
    manager.appendCompaction("summary", null, 10000);
    await pageSessionHistory(manager);
    const entry = manager.getEntry(id)! as unknown as { message: unknown };
    entry.message = message("replacement");
    expect(entry.message).toEqual(message("replacement"));
    const getter = vi.fn(() => message(large));
    Object.defineProperty(entry, "message", { get: getter, configurable: true, enumerable: true });
    expect(await pageSessionHistory(manager)).toEqual({ entries: 0, bytes: 0 });
    expect(getter).not.toHaveBeenCalled();
  });

  it("aborts cooperatively without losing any history", async () => {
    const manager = SessionManager.inMemory();
    for (let i = 0; i < 96; i++) manager.appendMessage(message(`${i}: ${large}`));
    manager.appendCompaction("summary", null, 10000);
    const before = JSON.stringify(manager.getEntries());
    const controller = new AbortController();
    const pending = pageSessionHistory(manager, controller.signal);
    controller.abort();
    const result = await pending;
    expect(result.entries).toBeLessThanOrEqual(32);
    expect(JSON.stringify(manager.getEntries())).toBe(before);
    expect(await pageSessionHistory(manager, controller.signal)).toEqual({ entries: 0, bytes: 0 });
  });
});
