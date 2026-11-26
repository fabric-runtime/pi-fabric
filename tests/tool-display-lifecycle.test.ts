import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import piFabric from "../src/index.js";

// Heavyweight runtime activations observed through the stub below: activation
// means the runtime's initialize() ran (mesh, lifecycle, residency workers).
const mockRuntimeActivations = vi.hoisted(() => ({ count: 0 }));

// The settings command handler calls state.ensure(), which lazily creates the
// heavyweight runtime (mesh, lifecycle, residency workers). Replace it with a
// stub so the handler can run in a unit test and so the resume test can prove
// that compact rendering never requests activation.
vi.mock("../src/fabric-runtime-state.js", () => ({
  FabricRuntimeState: class {
    initialized = true;
    widgetDismissedAt = 0;
    async initialize(): Promise<void> {
      mockRuntimeActivations.count++;
    }
    async shutdown(): Promise<void> {}
    registerExternal(): void {}
    mcpSlice(): never[] {
      return [];
    }
  },
}));

// The id the mocked settings dialog reports as just-saved; only display
// sections are gated through to refreshToolDisplay.
const settingsSaveId = vi.hoisted(() => ({ current: "ui.toolDisplay" }));

// Replace the settings modal with the real apply path: a successful save calls
// onConfigApplied, which is the display-mode switch that re-renders the
// transcript through refreshToolDisplay.
vi.mock("../src/ui/settings.js", () => ({
  openFabricSettings: vi.fn(async (
    _context: ExtensionContext,
    deps: { onConfigApplied?: (id: string) => void },
  ) => {
    deps.onConfigApplied?.(settingsSaveId.current);
  }),
}));

type ExtensionHandler = (event: unknown, context: unknown) => unknown;

// refresh() drains card invalidations across event-loop turns, so assertions
// must let the drain run before counting calls.
const flushDisplayRefresh = async (rounds = 3): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

interface FabricExecTool {
  renderCall?: (
    params: unknown,
    theme: Theme,
    context: Record<string, unknown>,
  ) => { render: (width: number) => string[] };
}

interface Harness {
  pi: ExtensionAPI;
  handlers: Map<string, ExtensionHandler[]>;
  registeredTools: unknown[];
}

type CommandHandler = (argumentsText: string, context: ExtensionContext) => Promise<void>;

const commandHandlerOf = (pi: ExtensionAPI): CommandHandler => {
  const registerCommand = (pi as unknown as { registerCommand: ReturnType<typeof vi.fn> }).registerCommand;
  const definition = registerCommand.mock.calls[0]?.[1] as { handler?: CommandHandler } | undefined;
  expect(definition?.handler).toBeTypeOf("function");
  return definition!.handler!;
};

const createHarness = (): Harness => {
  const handlers = new Map<string, ExtensionHandler[]>();
  const registeredTools: unknown[] = [];

  const pi = {
    events: {
      emit: vi.fn(),
      on: vi.fn(() => () => {}),
    },
    getActiveTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    on: vi.fn((event: string, handler: ExtensionHandler) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    }),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    // Auto-arm can run when the ambient agent dir enables prewalk; the arm path
    // sends a hidden armed advisory, so the stub must accept it.
    sendMessage: vi.fn(),
    registerTool: vi.fn((tool: unknown) => {
      registeredTools.push(tool);
    }),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;

  return { pi, handlers, registeredTools };
};

const fabricToolOf = (registeredTools: unknown[]): FabricExecTool => {
  const tool = registeredTools.find(
    (candidate) => (candidate as { name?: string }).name === "fabric_exec",
  ) as FabricExecTool | undefined;
  expect(tool).toBeDefined();
  expect(tool?.renderCall).toBeTypeOf("function");
  return tool!;
};

// The display controller holds each card's renderer state weakly, as Pi's
// transcript component owns it. Keep every rendered state reachable for the
// whole file, like a live component would, so a garbage collection between
// render and refresh cannot drop the card and make the refresh counts flaky.
const liveCardStates: object[] = [];
const liveCardState = (): object => {
  const state = {};
  liveCardStates.push(state);
  return state;
};

afterEach(() => {
  liveCardStates.length = 0;
});

const renderCard = (
  tool: FabricExecTool,
  toolCallId: string,
  params: Record<string, unknown>,
  invalidate: () => void,
  expanded = false,
): string =>
  tool.renderCall!(params, plainTheme, {
    args: params,
    toolCallId,
    invalidate,
    lastComponent: undefined,
    state: liveCardState(),
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded,
    showImages: true,
    isError: false,
  } as never).render(120).join("\n");

const emit = async (handlers: Map<string, ExtensionHandler[]>, event: string, context: unknown): Promise<void> => {
  for (const handler of handlers.get(event) ?? []) {
    await handler(undefined, context);
  }
};

describe("Fabric tool display lifecycle", () => {
  it("drops abandoned-branch invalidators when session_tree rebuilds the transcript", async () => {
    const harness = createHarness();
    await piFabric(harness.pi);
    const { handlers, registeredTools } = harness;
    const commandHandler = commandHandlerOf(harness.pi);

    const fabricTool = fabricToolOf(registeredTools);

    // The abandoned branch renders its card and registers an invalidator.
    const abandonedInvalidate = vi.fn();
    renderCard(fabricTool, "abandoned-branch-call", { code: "await pi.read('/tmp/leaf');" }, abandonedInvalidate);

    // Pi emits session_tree before it clears and rebuilds the transcript.
    await emit(handlers, "session_tree", {});

    // The rebuilt active branch renders its card and registers again.
    const activeInvalidate = vi.fn();
    renderCard(fabricTool, "active-branch-call", { code: "await pi.read('/tmp/leaf');" }, activeInvalidate);

    // A display-mode switch re-renders registered cards through the real
    // settings apply path (openFabricSettings -> onConfigApplied ->
    // refreshToolDisplay -> controller.refresh()).
    const context = {
      mode: "code",
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      hasUI: false,
      ui: { setStatus: vi.fn(), notify: vi.fn() },
      sessionManager: { getBranch: () => [], getSessionId: () => "test-session" },
    } as unknown as ExtensionContext;
    await commandHandler!("settings", context);
    await flushDisplayRefresh();

    expect(abandonedInvalidate).not.toHaveBeenCalled();
    expect(activeInvalidate).toHaveBeenCalledOnce();

    // Unrelated settings saves are gated off the transcript entirely: saving a
    // non-display id (even inside the ui section) must not re-render cards.
    settingsSaveId.current = "ui.refreshMs";
    await commandHandler!("settings", context);
    await flushDisplayRefresh();
    expect(activeInvalidate).toHaveBeenCalledOnce();
    settingsSaveId.current = "ui.toolDisplay";

    // Abandoned invalidators stay dropped for the rest of the session: a
    // second switch still refreshes only the active card.
    await commandHandler!("settings", context);
    await flushDisplayRefresh();
    expect(abandonedInvalidate).not.toHaveBeenCalled();
    expect(activeInvalidate).toHaveBeenCalledTimes(2);

    // Code preview preferences are card-affecting and still go through.
    settingsSaveId.current = "codePreview.toolCallBackground";
    await commandHandler!("settings", context);
    await flushDisplayRefresh();
    expect(activeInvalidate).toHaveBeenCalledTimes(3);
  });

  it("does not leak the previous session's preference when the next session's config is damaged", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-failed-rebootstrap-"));
    const cwdA = path.join(root, "session-a");
    const cwdB = path.join(root, "session-b");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
    fs.mkdirSync(path.join(cwdA, ".pi"), { recursive: true });
    fs.mkdirSync(path.join(cwdB, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(cwdA, ".pi", "fabric.json"),
      JSON.stringify({ ui: { toolDisplay: "full" }, mesh: { enabled: false } }),
    );
    // Malformed config: load repairs to defaults instead of taking down the extension.
    fs.writeFileSync(path.join(cwdB, ".pi", "fabric.json"), "{ not valid json ");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      mockRuntimeActivations.count = 0;
      const harness = createHarness();
      await piFabric(harness.pi);
      const { handlers, registeredTools } = harness;
      const fabricTool = fabricToolOf(registeredTools);
      const contextFor = (cwd: string, sessionId: string): ExtensionContext => ({
        mode: "code",
        cwd,
        isProjectTrusted: () => true,
        hasUI: false,
        ui: { setStatus: vi.fn(), notify: vi.fn() },
        sessionManager: { getBranch: () => [], getSessionId: () => sessionId },
      }) as unknown as ExtensionContext;

      // Session A bootstraps full display successfully.
      await emit(handlers, "session_start", contextFor(cwdA, "session-a"));
      const resumed = renderCard(
        fabricTool,
        "session-a-call",
        { code: "await pi.read('/tmp/leaf');", display: { name: "Resume history" } },
        vi.fn(),
      );
      expect(resumed).toContain("TypeScript");
      expect(resumed).toContain("await pi.read('/tmp/leaf');");
      expect(mockRuntimeActivations.count).toBe(0);

      // Session B's damaged config must boot with compact defaults, not session A's full view.
      await emit(handlers, "session_start", contextFor(cwdB, "session-b"));
      const afterDamagedRebootstrap = renderCard(
        fabricTool,
        "session-b-call",
        { code: "await pi.read('/tmp/leaf');", display: { name: "Resume history" } },
        vi.fn(),
      );
      expect(afterDamagedRebootstrap).toContain("Resume history");
      expect(afterDamagedRebootstrap).not.toContain("await pi.read('/tmp/leaf');");
      expect(mockRuntimeActivations.count).toBe(0);
      expect(fs.existsSync(path.join(cwdB, ".pi", "fabric.json"))).toBe(false);
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders resumed history compact from bootstrapped config without activating the runtime", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-resume-compact-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    // Resume state: effective ui.toolDisplay is compact and mesh is off, so
    // session_start bootstraps configuration without eager activation.
    fs.writeFileSync(
      path.join(cwd, ".pi", "fabric.json"),
      JSON.stringify({ ui: { toolDisplay: "compact" }, mesh: { enabled: false } }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      mockRuntimeActivations.count = 0;
      const harness = createHarness();
      await piFabric(harness.pi);
      const { handlers, registeredTools } = harness;
      const fabricTool = fabricToolOf(registeredTools);

      // Before configuration is bootstrapped the safe full default applies.
      const beforeBootstrap = renderCard(
        fabricTool,
        "pre-bootstrap",
        { code: "await pi.read('/tmp/leaf');", display: { name: "Resume history" } },
        vi.fn(),
      );
      expect(beforeBootstrap).toContain("await pi.read('/tmp/leaf');");
      expect(beforeBootstrap).toContain("TypeScript");
      expect(mockRuntimeActivations.count).toBe(0);

      // Resume: session_start bootstraps config but must not activate the
      // heavyweight runtime (mesh disabled by the project preference).
      const context = {
        mode: "code",
        cwd,
        isProjectTrusted: () => true,
        hasUI: false,
        ui: { setStatus: vi.fn(), notify: vi.fn() },
        sessionManager: { getBranch: () => [], getSessionId: () => "resumed-session" },
      } as unknown as ExtensionContext;
      await emit(handlers, "session_start", context);

      expect(mockRuntimeActivations.count).toBe(0);

      // The first normal transcript rebuild renders historical cards compact
      // from the bootstrapped preference alone.
      const resumed = renderCard(
        fabricTool,
        "resumed-history",
        { code: "await pi.read('/tmp/leaf');", display: { name: "Resume history" } },
        vi.fn(),
      );
      expect(resumed).toContain("Resume history");
      expect(resumed).not.toContain("await pi.read('/tmp/leaf');");
      expect(resumed).not.toContain("TypeScript");

      // ctrl+o expansion still promotes the resumed compact card to full.
      const resumedExpanded = renderCard(
        fabricTool,
        "resumed-history-expanded",
        { code: "await pi.read('/tmp/leaf');", display: { name: "Resume history" } },
        vi.fn(),
        true,
      );
      expect(resumedExpanded).toContain("await pi.read('/tmp/leaf');");
      expect(resumedExpanded).toContain("TypeScript");
    } finally {
      if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
