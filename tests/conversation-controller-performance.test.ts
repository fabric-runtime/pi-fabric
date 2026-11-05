import "./fixtures/conversation-host.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FabricState } from "../src/fabric-state.js";
import { FabricUiController } from "../src/ui/controller.js";
import { FabricConversationView } from "../src/ui/conversation.js";
import { NativeConversationReader } from "../src/ui/conversation-native-reader.js";
import * as targetProjection from "../src/ui/conversation-targets.js";
import { assistantMessage, userMessage } from "./fixtures/native-conversation.js";

initTheme("dark", false);
const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t } as Theme;
const controllers: FabricUiController[] = [];
const directories: string[] = [];

const harness = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-controller-perf-"));
  directories.push(directory);
  const logFile = path.join(directory, "events.jsonl");
  fs.writeFileSync(logFile, JSON.stringify({ type: "message_end", message: userMessage("native first") }) + "\n");
  const records = ["a", "b"].map((id) => ({
    id, name: id, task: id, status: "completed", runner: "pi", transport: "process", cwd: directory,
    model: "test/model", startedAt: 1, updatedAt: 2, finishedAt: 3, turns: 1, toolCalls: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, logFile,
  }));
  const state = {
    initialized: true, cwd: directory, widgetDismissedAt: 0,
    config: { ui: { enabled: true, refreshMs: 1000, eventHistory: 80, widget: "hidden" }, mesh: { enabled: false } },
    activity: { revision: () => 0, runSummaries: vi.fn(() => []), subscribe: vi.fn(() => () => {}) },
    agents: { listForUi: vi.fn(() => records), subscribeUi: vi.fn(() => () => {}) },
    actors: {
      list: vi.fn(() => [{ id: "actor", name: "actor", status: "idle", runner: "pi", updatedAt: 1 }]),
      instructions: vi.fn(() => "instructions"), messages: vi.fn(() => []), subscribe: vi.fn(() => () => {}),
    },
    globalActors: { list: () => [] },
    participantInfos: vi.fn(() => []), peerInfos: vi.fn(() => []),
    mainAgentInfo: vi.fn(() => ({ id: "main", name: "Main", kind: "main", status: "idle", runner: "pi",
      transport: "host", cwd: directory, startedAt: 1, updatedAt: 1, pendingMessages: false, local: true })),
    componentGraph: () => ({ components: [], edges: [], cycles: [] }),
    queueUserMessage: vi.fn(async () => ({ queued: true })), stopParticipant: vi.fn(async () => ({ stopped: true })),
  } as unknown as FabricState;
  let view: FabricConversationView | undefined;
  let done: () => void = () => {};
  const requestRender = vi.fn();
  const tui = { mode: "fullscreen", requestRender, terminal: { rows: 30, columns: 100, write: vi.fn() } } as unknown as TUI;
  const findModel = vi.fn(() => ({ contextWindow: 100_000 }));
  const context = { mode: "tui", cwd: directory, modelRegistry: { find: findModel }, ui: {
    notify: vi.fn(), setWidget: vi.fn(),
    custom: (factory: (tui: TUI, theme: Theme, keys: unknown, done: () => void) => FabricConversationView) =>
      new Promise<void>((resolve) => { done = resolve; view = factory(tui, theme, { matches: () => false, getKeys: () => [] }, resolve); }),
  } } as unknown as ExtensionContext;
  const controller = new FabricUiController(state);
  controllers.push(controller);
  return { state, records, context, controller, logFile, requestRender, findModel,
    view: () => view!, done: () => done(),
    async open(id = "a") {
      view = undefined;
      const pending = controller.openConversation(context, id);
      await vi.waitFor(() => expect(view).toBeInstanceOf(FabricConversationView));
      view!.render(100);
      return { pending };
    },
  };
};

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("controller preview performance", () => {
  it.each([false, true])("fills a sparse byte-bounded tail without scrolling (partial=%s)", async (partial) => {
    vi.useFakeTimers();
    const h = harness();
    const history = Array.from({ length: 40 }, (_, i) => `older visible history ${i}`).join("\n");
    fs.writeFileSync(h.logFile, JSON.stringify({ type: "message_end", message: userMessage(history) }) + "\n");
    // Whole hidden records consume the initial byte page but contribute no
    // visible rows. Older visible messages should be fetched by the idle poll.
    for (let i = 0; i < 6; i++) fs.appendFileSync(h.logFile, JSON.stringify({ type: "message_end", message: {
      role: "custom", customType: "private-fixture", display: false,
      content: "private hidden data ".repeat(3_000), timestamp: 5 + i,
    } }) + "\n");
    if (partial) fs.appendFileSync(h.logFile, JSON.stringify({ type: "message_end", message: assistantMessage("visible tail") }) + "\n");
    await h.open();
    expect(h.view().render(100).join("\n")).not.toContain("older visible history");
    h.requestRender.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.requestRender).toHaveBeenCalled();
    const frame = h.view().render(100).join("\n");
    expect(frame).toContain("older visible history 39");
    expect(frame).not.toContain("private hidden data");
    // A filled viewport goes back to the ordinary idle no-repaint fast path.
    h.requestRender.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.requestRender).not.toHaveBeenCalled();
  });

  it("reuses hierarchy/model lookups across frames and skips unchanged idle poll projection/repaint", async () => {
    vi.useFakeTimers();
    const project = vi.spyOn(targetProjection, "conversationTargets");
    const reads = vi.spyOn(NativeConversationReader.prototype, "read");
    const h = harness();
    await h.open();
    project.mockClear();
    h.findModel.mockClear();
    for (let frame = 0; frame < 5; frame++) h.view().render(100);
    expect(project).not.toHaveBeenCalled();
    expect(h.findModel).not.toHaveBeenCalled();
    h.requestRender.mockClear();
    vi.mocked(h.state.actors.messages).mockClear();
    vi.mocked(h.state.actors.instructions).mockClear();
    reads.mockClear();
    await vi.advanceTimersByTimeAsync(3000);
    expect(reads).toHaveBeenCalledTimes(3);
    expect(project).not.toHaveBeenCalled();
    expect(h.findModel).toHaveBeenCalledTimes(3); // once per distinct model, not per target/frame
    expect(h.state.actors.messages).not.toHaveBeenCalled();
    expect(h.state.actors.instructions).not.toHaveBeenCalled();
    expect(h.requestRender).not.toHaveBeenCalled();
  });

  it("observes native log growth without any manager revision and continues live animation ticks", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.open();
    h.requestRender.mockClear();
    fs.appendFileSync(h.logFile, JSON.stringify({ type: "message_end", message: assistantMessage("native appended", 4) }) + "\n");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.requestRender).toHaveBeenCalledTimes(1);
    expect(h.view().render(100).join("\n")).toContain("native appended");
    h.requestRender.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.requestRender).not.toHaveBeenCalled();
    h.records[0]!.status = "running";
    await vi.advanceTimersByTimeAsync(1000);
    h.view().render(100);
    h.requestRender.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.requestRender.mock.calls.length).toBeGreaterThan(1); // native 80ms Working animation plus poll
  });

  it("suspends inactive readers without dropping loaded pinned history, scroll, drafts or unavailable fallback", async () => {
    vi.useFakeTimers();
    const reads = vi.spyOn(NativeConversationReader.prototype, "read");
    const h = harness();
    fs.writeFileSync(h.logFile, Array.from({ length: 40 }, (_, i) => JSON.stringify({
      type: "message_end", message: userMessage(`message-${i} ${"x".repeat(9000)}`, i + 1),
    })).join("\n") + "\n");
    const { pending } = await h.open();
    const a = reads.mock.contexts[0] as NativeConversationReader;
    h.view().handleInput("saved draft");
    h.view().handleInput("\x1b[1;5H");
    const pinned = h.view().render(100);
    expect(a.last?.messages).toHaveLength(40);
    expect(pinned.join("\n")).toContain("message-0");
    h.view().selectTarget("b");
    expect(a.suspended).toBe(true);
    h.view().render(100);
    const b = reads.mock.contexts.at(-1) as NativeConversationReader;
    expect(b).not.toBe(a);
    h.view().selectTarget("a");
    expect(b.suspended).toBe(true);
    expect(h.view().render(100)).toEqual(pinned);
    expect(a.suspended).toBe(false);
    h.done();
    await pending;
    expect(a.suspended).toBe(true);
    fs.unlinkSync(h.logFile);
    const reopened = await h.open();
    expect(a.last?.messages).toHaveLength(40);
    const text = h.view().render(100).join("\n");
    expect(text).toContain("message-0");
    expect(text).toContain("saved draft");
    h.done();
    await reopened.pending;
    expect(a.suspended).toBe(true);
    h.controller.stop();
    expect(a.suspended).toBe(false);
    expect(b.suspended).toBe(false);
  });

  it("refreshes registry windows, mutable model metadata, stale owner permissions and dashboard usage", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.open();
    h.findModel.mockReturnValue({ contextWindow: 200_000 });
    h.requestRender.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.requestRender).toHaveBeenCalledTimes(1);
    h.records[0]!.model = "test/replacement";
    h.records[0]!.status = "running";
    h.records[0]!.usage.output = 999;
    vi.mocked(h.state.participantInfos).mockReturnValue([{
      id: "a", name: "a", kind: "agent", ownerHostId: "new-owner", rootId: "main", local: false,
      stale: true, capabilities: ["steer", "followUp", "stop"],
    }] as never);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.findModel).toHaveBeenCalledWith("test", "replacement");
    expect(h.controller.snapshot().agents.find((agent) => agent.id === "a")).toMatchObject({
      model: "test/replacement", usage: { output: 999 }, stale: true, ownerHostId: "new-owner",
    });
    const output = h.view().render(100).join("\n");
    expect(output).toContain("read-only");
    h.view().handleInput("not delivered");
    h.view().handleInput("\r");
    await Promise.resolve();
    expect(h.state.queueUserMessage).not.toHaveBeenCalled();
  });
});
