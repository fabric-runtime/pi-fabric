import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FabricActorInfo } from "../src/actors/types.js";
import type { CapturedToolCatalog } from "../src/capture/catalog.js";
import { registerFabricCommand } from "../src/commands/fabric.js";
import type { FabricState } from "../src/fabric-state.js";
import { FabricUiController } from "../src/ui/controller.js";
import { FabricWidget, type FabricWidgetInteraction } from "../src/ui/widget.js";
import "../src/ui/dashboard.js";
import "../src/ui/model-picker.js";
import { readConversationAppearance } from "../src/ui/conversation-chrome.js";
import { userMessage, assistantMessage } from "./fixtures/native-conversation.js";
import type { NativeConversationTranscript } from "../src/ui/conversation-native-reader.js";

vi.mock("../src/ui/conversation-chrome.js", () => ({
  readConversationAppearance: vi.fn(() => ({ editorPaddingX: 2, outputPad: 1, codeBlockIndent: "  " })),
}));

// Capture the view boundary while exercising real command/controller/target
// routing. Real TUI components and native appearance are tested separately.
const captures = vi.hoisted(() => ({
  views: [] as Array<{
    options: Record<string, unknown>;
    selectTarget: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  states: [] as Array<{ clear: ReturnType<typeof vi.fn> }>,
}));

vi.mock("../src/ui/conversation.js", () => {
  class FabricConversationState {
    clear = vi.fn();
    constructor() {
      captures.states.push(this as unknown as { clear: ReturnType<typeof vi.fn> });
    }
  }
  class FabricConversationView {
    selectTarget = vi.fn();
    dispose = vi.fn();
    render = () => [] as string[];
    invalidate = () => {};
    handleInput = () => {};
    constructor(
      public tui: unknown,
      public theme: unknown,
      public options: Record<string, unknown>,
    ) {
      captures.views.push({
        options: this.options,
        selectTarget: this.selectTarget,
        dispose: this.dispose,
      });
    }
  }
  return { FabricConversationState, FabricConversationView };
});

const theme = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
} as unknown as Theme;

const stubActor: FabricActorInfo = {
  id: "actor-1",
  scope: "project",
  name: "red queen",
  status: "idle",
  runner: "pi",
  events: ["turn_end"],
  topics: [],
  delivery: "mailbox",
  responseMode: "text",
  triggerTurn: false,
  coalesce: true,
  queued: 0,
  messages: 0,
  createdAt: 0,
  updatedAt: 0,
};

const agentRecord = (overrides: Record<string, unknown> = {}) => ({
  id: "agent-root-1",
  name: "scout",
  status: "running",
  runner: "pi",
  transport: "host",
  cwd: "/tmp/project",
  task: "scout the code",
  startedAt: 1,
  updatedAt: 2,
  turns: 1,
  toolCalls: 0,
  usage: { input: 1, output: 2 },
  ...overrides,
});

const stubParticipant = (overrides: Record<string, unknown> = {}) => ({
  format: 1,
  id: "agent-root-1",
  version: 1,
  kind: "agent",
  rootId: "session:test",
  ownerHostId: "host-remote",
  ownerIdentityId: "identity-remote",
  name: "scout",
  status: "running",
  runner: "pi",
  transport: "host",
  capabilities: ["steer", "followUp", "stop"],
  startedAt: 1,
  updatedAt: 2,
  controlProtocol: "v1",
  local: false,
  stale: true,
  ...overrides,
});

const stubState = () => {
  const nestedAgent = agentRecord({ id: "agent-nested-1", name: "scout junior", startedAt: 2, updatedAt: 3 });
  const rootAgent = { ...agentRecord(), nestedAgents: [nestedAgent] };
  return {
    initialized: true,
    ensure: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn(),
    cwd: "/tmp/project",
    widgetDismissedAt: 0,
    config: {
      ui: { enabled: true, refreshMs: 60_000, eventHistory: 80, widget: "hidden" },
      mesh: { enabled: false },
    },
    activity: { subscribe: vi.fn(() => () => {}), runs: vi.fn(() => []) },
    participantInfos: vi.fn(() => []),
    mainAgentInfo: vi.fn(() => ({
      id: "session:test",
      name: "Main",
      kind: "main",
      status: "idle",
      runner: "pi",
      transport: "host",
      cwd: "/tmp/project",
      sessionId: "test",
      startedAt: 1,
      updatedAt: 1,
      pendingMessages: false,
      local: true,
    })),
    queueUserMessage: vi.fn().mockResolvedValue({ queued: true, messageId: "message-1", routed: "actor-1" }),
    stopParticipant: vi.fn().mockResolvedValue({ stopped: true }),
    agents: {
      list: vi.fn(() => []),
      listForUi: vi.fn(() => [rootAgent]),
      subscribeUi: vi.fn(() => () => {}),
      stop: vi.fn(),
    },
    actors: {
      list: vi.fn(() => [{ ...stubActor }]),
      messages: vi.fn(() => []),
      instructions: vi.fn(() => "Advise only when useful."),
      subscribe: vi.fn(() => () => {}),
    },
    globalActors: {
      list: vi.fn(() => [
        { id: "global-helper-1", name: "global helper", runner: "pi", instructions: "", createdAt: 0, updatedAt: 0 },
      ]),
    },
    mesh: { read: vi.fn(() => []), latestOffset: vi.fn(() => 0), list: vi.fn(() => []) },
    componentGraph: vi.fn(() => ({ components: [], edges: [], cycles: [] })),
  } as unknown as FabricState;
};

interface Harness {
  state: FabricState;
  controller: FabricUiController;
  context: ExtensionContext;
  notify: ReturnType<typeof vi.fn>;
  custom: ReturnType<typeof vi.fn>;
  requestRender: ReturnType<typeof vi.fn>;
  overlayOptions: (call: number) => Record<string, unknown> | undefined;
  done: () => void;
  open: (query?: string) => Promise<void>;
  pending?: Promise<void>;
}

const harnesses: Harness[] = [];
const controllers: FabricUiController[] = [];
const tempDirs: string[] = [];

const createHarness = (state: FabricState): Harness => {
  const controller = new FabricUiController(state);
  controllers.push(controller);
  const requestRender = vi.fn();
  const tui = { requestRender } as unknown as TUI;
  const notify = vi.fn();
  const overlayOptionRecords: Array<Record<string, unknown> | undefined> = [];
  let closeOverlay: (() => void) | undefined;
  const custom = vi.fn((factory: (...args: unknown[]) => unknown, options?: unknown) => {
    let resolveOverlay!: () => void;
    const overlay = new Promise<void>((resolve) => {
      resolveOverlay = resolve;
    });
    closeOverlay = () => resolveOverlay();
    factory(tui, theme, {}, closeOverlay);
    overlayOptionRecords.push(options as Record<string, unknown> | undefined);
    return overlay;
  });
  const context = {
    mode: "tui",
    cwd: "/tmp/project",
    isProjectTrusted: () => false,
    ui: { custom, notify, setWidget: vi.fn() },
  } as unknown as ExtensionContext;
  const harness: Harness = {
    state,
    controller,
    context,
    notify,
    custom,
    requestRender,
    overlayOptions: (call) => overlayOptionRecords[call],
    done: () => closeOverlay?.(),
    open: (query?: string) => {
      const pending = controller.openConversation(context, query);
      harness.pending = pending;
      return pending;
    },
  };
  harnesses.push(harness);
  return harness;
};

const waitForView = async (count: number): Promise<void> => {
  await vi.waitFor(() => {
    expect(captures.views.length).toBeGreaterThanOrEqual(count);
  });
};

const lastOptions = (): Record<string, unknown> =>
  captures.views.at(-1)!.options;

const makeTranscriptLog = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fabric-conversation-test-"));
  tempDirs.push(dir);
  const logFile = path.join(dir, "events.jsonl");
  await writeFile(
    logFile,
    [
      JSON.stringify({ type: "message_end", message: userMessage("scout log hello") }),
      JSON.stringify({ type: "message_end", message: assistantMessage("scout log reply") }),
      "",
    ].join("\n"),
  );
  return logFile;
};

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

afterEach(() => {
  for (const controller of controllers) controller.stop();
  controllers.length = 0;
  harnesses.length = 0;
  captures.views.length = 0;
  captures.states.length = 0;
  const dirs = tempDirs.splice(0);
  return Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("/fabric chat command routing", () => {
  const registerWithMockUi = () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn(
        (
          _name: string,
          definition: { handler: (argumentsText: string, context: ExtensionContext) => Promise<void> },
        ) => {
          handler = definition.handler;
        },
      ),
    } as unknown as ExtensionAPI;
    const state = { ensure: vi.fn().mockResolvedValue(undefined) } as unknown as FabricState;
    const fabricUi = {
      openDashboard: vi.fn().mockResolvedValue(undefined),
      openConversation: vi.fn().mockResolvedValue(undefined),
    } as unknown as FabricUiController;
    registerFabricCommand(pi, {
      state,
      fabricUi,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
    });
    return { handler: handler!, fabricUi };
  };

  it("routes /fabric chat with a multiword name to openConversation without the dashboard", async () => {
    const { handler, fabricUi } = registerWithMockUi();
    const context = {} as ExtensionContext;

    await handler!("chat red queen", context);

    expect(fabricUi.openConversation).toHaveBeenCalledWith(context, "red queen");
    expect(fabricUi.openDashboard).not.toHaveBeenCalled();
  });

  it("passes bare /fabric chat through without a target query", async () => {
    const { handler, fabricUi } = registerWithMockUi();
    const context = {} as ExtensionContext;

    await handler!("chat", context);

    expect(fabricUi.openConversation).toHaveBeenCalledWith(context, undefined);
    expect(fabricUi.openDashboard).not.toHaveBeenCalled();
  });

  it("keeps no-argument /fabric on the dashboard", async () => {
    const { handler, fabricUi } = registerWithMockUi();
    const context = {} as ExtensionContext;

    await handler!("", context);

    expect(fabricUi.openDashboard).toHaveBeenCalledWith(context);
    expect(fabricUi.openConversation).not.toHaveBeenCalled();
  });

  it("registers no ctrl+shift+a conversation shortcut", () => {
    const state = stubState();
    const controller = new FabricUiController(state);
    controllers.push(controller);
    const pi = {
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(),
    } as unknown as ExtensionAPI;
    registerFabricCommand(pi, {
      state,
      fabricUi: controller,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
    });
    const shortcuts = vi.mocked(pi.registerShortcut).mock.calls.map(([shortcut]) => shortcut);
    // Other Fabric shortcuts still register; /fabric chat is the only way in.
    expect(shortcuts.length).toBeGreaterThan(0);
    expect(shortcuts).not.toContain("ctrl+shift+a");
  });

  it("chat completions include nested agent ids and exclude global actor templates", () => {
    const state = stubState();
    // Remote-only participant joins the list; the actor-id participant is a
    // duplicate that must be deduped against the local actor entry.
    vi.mocked(state.participantInfos).mockReturnValue([
      stubParticipant({ id: "agent-remote-1", name: "remote scout", stale: false }),
      stubParticipant({ id: "actor-1", kind: "actor", stale: false }),
    ] as never);
    const controller = new FabricUiController(state);
    controllers.push(controller);
    const context = {
      mode: "tui",
      ui: { setWidget: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    controller.start(context);

    let completions: ((prefix: string) => Array<{ value: string; label: string }> | null) | undefined;
    const pi = {
      registerCommand: vi.fn((_name: string, definition: {
        getArgumentCompletions: typeof completions;
      }) => {
        completions = definition.getArgumentCompletions;
      }),
    } as unknown as ExtensionAPI;
    registerFabricCommand(pi, {
      state,
      fabricUi: controller,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
    });

    const all = completions!("chat ")!.map((item) => item.value);
    expect(all).toContain("session:test");
    expect(all).toContain("agent-root-1");
    expect(all).toContain("agent-nested-1");
    expect(all).toContain("actor-1");
    // Remote-only participants surface without a local agent row.
    expect(all).toContain("agent-remote-1");
    // Same-id actor/participant entries dedupe to one completion.
    expect(all.filter((value) => value === "actor-1")).toHaveLength(1);
    expect(all.filter((value) => value === "agent-remote-1")).toHaveLength(1);
    // Global actor templates are not live participants.
    expect(all).not.toContain("global-helper-1");
    const actorEntry = completions!("chat ")!.find((item) => item.value === "actor-1");
    expect(actorEntry).toEqual({
      value: "actor-1",
      label: "red queen",
      description: "idle · actor-1",
    });

    expect(completions!("chat junior")!.map((item) => item.value)).toEqual(["agent-nested-1"]);
    expect(completions!("chat red q")!.map((item) => item.value)).toEqual(["actor-1"]);
    expect(completions!("chat ghost")).toBeNull();
  });
});

describe("FabricUiController.openConversation", () => {
  it("opens a full-size overlay wired to state, targets, transcript, send, stop, and close", async () => {
    const state = stubState();
    const harness = createHarness(state);
    harness.open();
    await waitForView(1);

    expect(harness.custom).toHaveBeenCalledTimes(1);
    expect(harness.overlayOptions(0)).toMatchObject({
      overlay: true,
      overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
    });
    const options = lastOptions();
    expect(options.initialTargetId).toBeUndefined();
    expect(options.appearance).toEqual({ editorPaddingX: 2, outputPad: 1, codeBlockIndent: "  " });
    expect(readConversationAppearance).toHaveBeenCalledWith("/tmp/project", expect.any(String), false);
    expect(options.state).toBe(captures.states[0]);
    const targets = (options.targets as () => Array<{ id: string; kind: string; parentId?: string }>)();
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "session:test", kind: "main" }),
        expect.objectContaining({ id: "agent-root-1", kind: "agent" }),
        expect.objectContaining({ id: "agent-nested-1", parentId: "agent-root-1" }),
        expect.objectContaining({ id: "actor-1", kind: "actor" }),
      ]),
    );
    expect(typeof options.send).toBe("function");
    expect(typeof options.stop).toBe("function");
    expect(typeof options.close).toBe("function");
    expect(typeof options.transcript).toBe("function");
    expect(typeof options.loadOlder).toBe("function");
    expect(typeof options.loadNewer).toBe("function");
    expect(typeof options.loadLatest).toBe("function");
    expect(harness.controller.ownsInput).toBe(true);
    expect(state.shutdown).not.toHaveBeenCalled();
    expect(state.agents.stop).not.toHaveBeenCalled();
  });

  it("preserves the footer page when closing and reopening a participant window", async () => {
    const state = stubState();
    state.config.ui.maxRows = 6;
    vi.mocked(state.actors.list).mockReturnValue([]);
    vi.mocked(state.agents.listForUi).mockReturnValue(Array.from({ length: 18 }, (_, i) =>
      agentRecord({ id: `agent-${i}`, name: `Agent ${i}`, startedAt: i + 1, nestedAgents: [] })) as never);
    const h = createHarness(state);
    h.open("agent-10");
    await waitForView(1);
    const interaction: FabricWidgetInteraction = { release() {}, requestRender() {}, mainId: "session:test" };
    const first = (lastOptions().participants as (interaction: FabricWidgetInteraction) => FabricWidget)(interaction);
    first.render(100);
    first.handleMouse({ type: "wheel", button: "none", x: 4, y: 2, screenX: 4, screenY: 2,
      width: 100, height: 6, shift: false, alt: false, ctrl: false, wheelDelta: 10 });
    const before = first.render(100);
    expect(before[2]).toContain("Agent 10");
    h.done();
    await h.pending;
    h.open("agent-11");
    await waitForView(2);
    const next = (lastOptions().participants as (interaction: FabricWidgetInteraction) => FabricWidget)(interaction);
    expect(next.render(100)).toEqual(before);
  });

  it("routes transcripts from the participant source and pages through the reader", async () => {
    const state = stubState();
    const logFile = await makeTranscriptLog();
    vi.mocked(state.agents.listForUi).mockReturnValue([
      { ...agentRecord(), nestedAgents: [], logFile },
    ] as never);
    const harness = createHarness(state);
    harness.open("scout");
    await waitForView(1);

    const options = lastOptions();
    expect(options.initialTargetId).toBe("agent-root-1");
    const transcript = (options.transcript as (id: string, followLatest?: boolean) => NativeConversationTranscript)("agent-root-1");
    expect(JSON.stringify(transcript.messages)).toContain("scout log hello");
    expect(JSON.stringify(transcript.messages)).toContain("scout log reply");

    const unavailable = (options.transcript as (id: string) => NativeConversationTranscript)("ghost-id");
    expect(unavailable.messages).toEqual([]);
    expect(unavailable.status).toBe("unavailable");

    await expect(
      Promise.resolve((options.loadOlder as (id: string) => boolean)("agent-root-1")),
    ).resolves.toEqual(expect.any(Boolean));
    await expect(
      Promise.resolve((options.loadNewer as (id: string) => boolean)("ghost-id")),
    ).resolves.toEqual(expect.any(Boolean));
  });

  it("sends and stops with the exact participant id", async () => {
    const state = stubState();
    const harness = createHarness(state);
    harness.open();
    await waitForView(1);

    const options = lastOptions();
    const sent = await (options.send as (id: string, message: string, delivery: string) => Promise<unknown>)(
      "actor-1",
      "focus on the failing test",
      "followUp",
    );
    expect(sent).toEqual({ queued: true, messageId: "message-1", routed: "actor-1" });
    expect(state.queueUserMessage).toHaveBeenCalledWith("actor-1", "focus on the failing test", "followUp");

    await (options.stop as (id: string) => Promise<unknown>)("agent-root-1");
    expect(state.stopParticipant).toHaveBeenCalledWith("agent-root-1");
  });

  it("revalidates on dispatch so terminal and stale participants cannot receive", async () => {
    const state = stubState();
    const harness = createHarness(state);
    harness.open();
    await waitForView(1);
    const options = lastOptions();
    const send = options.send as (id: string, message: string, delivery: string) => Promise<unknown>;

    vi.mocked(state.actors.list).mockReturnValue([{ ...stubActor, status: "stopped" }]);
    await expect(send("actor-1", "hello", "steer")).rejects.toThrow("Target is stopped");
    expect(state.queueUserMessage).not.toHaveBeenCalled();

    vi.mocked(state.participantInfos).mockReturnValue([stubParticipant()] as never);
    await expect(send("agent-root-1", "hello", "steer")).rejects.toThrow(
      "Owner is unavailable or stale",
    );
    expect(state.queueUserMessage).not.toHaveBeenCalled();

    vi.mocked(state.participantInfos).mockReturnValue([
      stubParticipant({ stale: false, local: true, capabilities: ["steer"] }),
    ] as never);
    // With steer still allowed the target has no readOnlyReason, so the
    // generic per-action denial applies to followUp.
    await expect(send("agent-root-1", "hello", "followUp")).rejects.toThrow(
      "Participant agent-root-1 cannot receive followUp",
    );
    await expect(send("agent-root-1", "hello", "steer")).resolves.toEqual(
      expect.objectContaining({ queued: true }),
    );
    expect(state.queueUserMessage).toHaveBeenCalledWith("agent-root-1", "hello", "steer");
  });

  it("returns to native Main without opening an overlay for the main target", async () => {
    const state = stubState();
    const harness = createHarness(state);
    const pending = harness.open("Main");
    await pending;

    expect(harness.custom).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
    expect(captures.views).toHaveLength(0);
    expect(harness.controller.ownsInput).toBe(false);
  });

  it("errors on unknown and ambiguous queries without opening or sending", async () => {
    const state = stubState();
    const harness = createHarness(state);

    await harness.open("ghost");
    expect(harness.notify).toHaveBeenCalledWith('Unknown conversation target: "ghost"', "error");
    expect(harness.custom).not.toHaveBeenCalled();
    expect(state.queueUserMessage).not.toHaveBeenCalled();
    expect(harness.controller.ownsInput).toBe(false);

    vi.mocked(state.actors.list).mockReturnValue([
      { ...stubActor, id: "twin-1", name: "twin" },
      { ...stubActor, id: "twin-2", name: "twin" },
    ]);
    await harness.open("twin");
    expect(harness.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Ambiguous conversation target"),
      "error",
    );
    expect(harness.custom).not.toHaveBeenCalled();
    expect(state.queueUserMessage).not.toHaveBeenCalled();
    expect(harness.controller.ownsInput).toBe(false);
  });

  it("surfaces a rejected send promise from the route into the UI layer", async () => {
    const state = stubState();
    vi.mocked(state.queueUserMessage).mockRejectedValue(new Error("mesh refused message"));
    const harness = createHarness(state);
    harness.open();
    await waitForView(1);

    const options = lastOptions();
    await expect(
      (options.send as (id: string, message: string, delivery: string) => Promise<unknown>)(
        "actor-1",
        "hello",
        "steer",
      ),
    ).rejects.toThrow("mesh refused message");
  });

  it("retargets in place on a second open and closes on a bare open", async () => {
    const state = stubState();
    const harness = createHarness(state);
    const first = harness.open("scout");
    await waitForView(1);

    const second = harness.open("red queen");
    await second;
    expect(harness.custom).toHaveBeenCalledTimes(1);
    expect(captures.views).toHaveLength(1);
    expect(captures.views[0]!.selectTarget).toHaveBeenCalledWith("actor-1");

    await harness.open();
    await first;
    expect(harness.controller.ownsInput).toBe(false);
    expect(captures.views[0]!.dispose).toHaveBeenCalled();
  });

  it("keeps conversation state across closes and clears it on controller stop", async () => {
    const state = stubState();
    const harness = createHarness(state);
    const first = harness.open();
    await waitForView(1);
    harness.done();
    await first;
    expect(captures.states[0]!.clear).not.toHaveBeenCalled();

    const second = harness.open();
    await waitForView(2);
    expect(captures.states).toHaveLength(1);
    expect(lastOptions().state).toBe(captures.states[0]);
    harness.done();
    await second;

    harness.controller.stop();
    expect(captures.states[0]!.clear).toHaveBeenCalledTimes(1);

    const third = harness.open();
    await waitForView(3);
    expect(captures.states).toHaveLength(2);
    expect(lastOptions().state).toBe(captures.states[1]);
    harness.done();
    await third;
  });

  it("drops a pending open and rejects stale send callbacks after stop without mutation", async () => {
    const state = stubState();
    const harness = createHarness(state);

    const pending = harness.open();
    harness.controller.stop();
    await pending;
    expect(harness.custom).not.toHaveBeenCalled();
    expect(captures.views).toHaveLength(0);
    expect(harness.notify).not.toHaveBeenCalled();
    expect(state.queueUserMessage).not.toHaveBeenCalled();

    const reopened = harness.open();
    await waitForView(1);
    const options = lastOptions();
    harness.controller.stop();
    await expect(
      (options.send as (id: string, message: string, delivery: string) => Promise<unknown>)(
        "actor-1",
        "hello",
        "steer",
      ),
    ).rejects.toThrow("no longer attached");
    expect(state.queueUserMessage).not.toHaveBeenCalled();
    harness.done();
    await reopened;
  });

  it("refreshes the open view on updates even when the session is idle", async () => {
    vi.useFakeTimers();
    try {
      const state = stubState();
      let onActivity = (): void => {};
      vi.mocked(state.activity.subscribe).mockImplementation((listener) => {
        onActivity = listener as () => void;
        return () => {};
      });
      const harness = createHarness(state);
      harness.open();
      await flushMicrotasks();
      expect(captures.views).toHaveLength(1);

      const before = harness.requestRender.mock.calls.length;
      onActivity();
      await vi.advanceTimersByTimeAsync(150);
      expect(harness.requestRender.mock.calls.length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not open for disabled ui or non-TUI modes", async () => {
    const disabledState = stubState();
    (disabledState.config as { ui: { enabled: boolean } }).ui.enabled = false;
    const disabledHarness = createHarness(disabledState);
    await disabledHarness.open();
    expect(disabledHarness.notify).toHaveBeenCalledWith(
      "The Fabric UI is disabled by ui.enabled",
      "warning",
    );
    expect(disabledHarness.custom).not.toHaveBeenCalled();
    expect(captures.views).toHaveLength(0);

    const nonTuiState = stubState();
    const nonTuiHarness = createHarness(nonTuiState);
    (nonTuiHarness.context as { mode: string }).mode = "sdk";
    await nonTuiHarness.open();
    expect(nonTuiHarness.notify).toHaveBeenCalledWith(
      "Fabric conversations are available in TUI mode",
      "warning",
    );
    expect(nonTuiHarness.custom).not.toHaveBeenCalled();
    expect(captures.views).toHaveLength(0);
  });

  it("never shuts down state or stops agents while navigating conversations", async () => {
    const state = stubState();
    const harness = createHarness(state);
    const first = harness.open();
    await waitForView(1);
    harness.done();
    await first;
    const second = harness.open("red queen");
    await waitForView(2);
    harness.done();
    await second;
    harness.controller.stop();

    expect(state.shutdown).not.toHaveBeenCalled();
    expect(state.agents.stop).not.toHaveBeenCalled();
    expect(state.stopParticipant).not.toHaveBeenCalled();
  });
});

describe("FabricUiController.openDashboard Shift+C drill-in", () => {
  it("opens the focused conversation for the exact selected participant", async () => {
    const state = stubState();
    const controller = new FabricUiController(state);
    controllers.push(controller);
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    let dashboard: { handleInput?: (data: string) => void; dispose?: () => void } | undefined;
    const custom = vi.fn((factory: (...args: unknown[]) => unknown) => {
      return new Promise<void>((resolve) => {
        const done = () => resolve();
        dashboard = factory(tui, theme, {}, done) as typeof dashboard;
      });
    });
    const context = {
      mode: "tui",
      modelRegistry: { getAvailable: () => [] },
      ui: { custom, notify: vi.fn(), setWidget: vi.fn() },
    } as unknown as ExtensionContext;

    const pending = controller.openDashboard(context);
    await vi.waitFor(() => expect(custom).toHaveBeenCalledTimes(1));
    dashboard!.handleInput!("l");
    dashboard!.handleInput!("\r");
    dashboard!.handleInput!("C");

    await vi.waitFor(() => expect(captures.views).toHaveLength(1));
    expect(lastOptions().initialTargetId).toBe("actor-1");

    controller.stop();
    dashboard?.dispose?.();
    await pending;
  });
});
