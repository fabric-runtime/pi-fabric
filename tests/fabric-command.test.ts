import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CapturedToolCatalog } from "../src/capture/catalog.js";
import { registerFabricCommand } from "../src/commands/fabric.js";
import { FABRIC_PREWALK_REQUEST_EVENT } from "../src/protocol.js";
import {
  PREWALK_ARMED_MESSAGE_TYPE,
  prewalkArmedPrompt,
} from "../src/prewalk/messages.js";
import type { FabricState } from "../src/fabric-state.js";
import type { FabricUiController } from "../src/ui/controller.js";

describe("/fabric command", () => {
  it("does not register automatic queued-input notices", () => {
    const on = vi.fn(), waiting = vi.fn(() => 1), detachWaiting = vi.fn();
    const pi = { on, registerCommand: vi.fn() } as unknown as ExtensionAPI;
    registerFabricCommand(pi, {
      state: { programTasks: { waiting, detachWaiting } } as unknown as FabricState,
      fabricUi: {} as FabricUiController, capturedTools: {} as CapturedToolCatalog,
      applyFabricMode() {}, suspendToolCapture() {},
    });
    expect(on.mock.calls.some(([event]) => event === "input")).toBe(false);
    expect(waiting).not.toHaveBeenCalled();
    expect(detachWaiting).not.toHaveBeenCalled();
  });

  it("rejects background arguments and handles idle commands without booting the runtime", async () => {
    let command: any;
    const detachWaiting = vi.fn(() => 0), ensure = vi.fn(), notify = vi.fn();
    const pi = { registerCommand: (_name: string, value: any) => { command = value; } } as unknown as ExtensionAPI;
    registerFabricCommand(pi, { state: { programTasks: { detachWaiting }, ensure } as unknown as FabricState,
      fabricUi: {} as FabricUiController, capturedTools: {} as CapturedToolCatalog, applyFabricMode() {}, suspendToolCapture() {} });
    await command.handler("background extra", { ui: { notify } });
    expect(detachWaiting).not.toHaveBeenCalled();
    expect(notify).toHaveBeenLastCalledWith("Usage: /fabric background", "warning");
    await command.handler("background", { ui: { notify } });
    expect(detachWaiting).toHaveBeenCalledOnce(); expect(ensure).not.toHaveBeenCalled();
    expect(notify).toHaveBeenLastCalledWith("Fabric: no foreground workflow to background", "info");
  });

  it("opens the dashboard when invoked without arguments", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn(
        (
          _name: string,
          definition: {
            handler: (argumentsText: string, context: ExtensionContext) => Promise<void>;
          },
        ) => {
          handler = definition.handler;
        },
      ),
    } as unknown as ExtensionAPI;
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
    } as unknown as FabricState;
    const fabricUi = {
      openDashboard: vi.fn().mockResolvedValue(undefined),
    } as unknown as FabricUiController;
    const context = {} as ExtensionContext;

    registerFabricCommand(pi, {
      state,
      fabricUi,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
      autoArmPrewalk: vi.fn(async () => {}),
    });
    expect(handler).toBeDefined();

    await handler!("", context);

    expect(state.ensure).toHaveBeenCalledWith(context);
    expect(fabricUi.openDashboard).toHaveBeenCalledWith(context);
  });

  it("keeps the /fabric ui dashboard alias", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn((_name: string, definition: { handler: typeof handler }) => {
        handler = definition.handler;
      }),
    } as unknown as ExtensionAPI;
    const state = { ensure: vi.fn().mockResolvedValue(undefined) } as unknown as FabricState;
    const fabricUi = { openDashboard: vi.fn().mockResolvedValue(undefined) } as unknown as FabricUiController;
    const context = {} as ExtensionContext;

    registerFabricCommand(pi, {
      state,
      fabricUi,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
      autoArmPrewalk: vi.fn(async () => {}),
    });
    await handler!("ui", context);

    expect(fabricUi.openDashboard).toHaveBeenCalledWith(context);
  });

  it("escalates a pending kernel switch to Pi reload and returns from the old context", async () => {
    let handler: any;
    const pi = { registerCommand: (_name: string, definition: any) => { handler = definition.handler; } } as unknown as ExtensionAPI;
    const state = { ensure: vi.fn(async () => {}), initialize: vi.fn(async () => {}), kernelReloadRequired: true } as unknown as FabricState;
    const reload = vi.fn(async () => {});
    const notify = vi.fn();
    const refreshToolDisplay = vi.fn();
    registerFabricCommand(pi, { state, fabricUi: { stop: vi.fn() } as unknown as FabricUiController, capturedTools: {} as CapturedToolCatalog, applyFabricMode: vi.fn(), suspendToolCapture: vi.fn(), refreshToolDisplay });
    await handler("reload", { reload, ui: { notify } });
    expect(reload).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
    expect(refreshToolDisplay).not.toHaveBeenCalled();
  });

  it("lets the activation hook own reload setup and keeps failure suspended", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn((_name, command) => { handler = command.handler; }),
    } as unknown as ExtensionAPI;
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      initialize: vi.fn().mockRejectedValue(new Error("reload failed")),
    } as unknown as FabricState;
    const fabricUi = { stop: vi.fn(), start: vi.fn() } as unknown as FabricUiController;
    const applyFabricMode = vi.fn();
    const suspendToolCapture = vi.fn();
    const autoArmPrewalk = vi.fn(async () => {});
    const context = {} as ExtensionContext;

    registerFabricCommand(pi, {
      state,
      fabricUi,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode,
      suspendToolCapture,
      autoArmPrewalk,
    });

    await expect(handler!("reload", context)).rejects.toThrow("reload failed");
    expect(fabricUi.stop).toHaveBeenCalledTimes(2);
    expect(suspendToolCapture).toHaveBeenCalledTimes(2);
    expect(applyFabricMode).not.toHaveBeenCalled();
    expect(fabricUi.start).not.toHaveBeenCalled();
    expect(autoArmPrewalk).not.toHaveBeenCalled();
  });

  it("re-renders existing cards after a successful reload so external edits apply", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: vi.fn((_name, command) => { handler = command.handler; }),
    } as unknown as ExtensionAPI;
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      initialize: vi.fn().mockResolvedValue(undefined),
    } as unknown as FabricState;
    const fabricUi = { stop: vi.fn(), start: vi.fn() } as unknown as FabricUiController;
    const refreshToolDisplay = vi.fn();
    const notify = vi.fn();
    const context = {
      ui: { notify },
    } as unknown as ExtensionContext;

    registerFabricCommand(pi, {
      state,
      fabricUi,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
      refreshToolDisplay,
    });

    await handler!("reload", context);
    expect(state.initialize).toHaveBeenCalledWith(context);
    expect(notify).toHaveBeenCalledWith("Pi Fabric reloaded", "info");
    expect(refreshToolDisplay).toHaveBeenCalledOnce();
  });

  it("arms prewalk with the configured executor and submits an inline task", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const sendUserMessage = vi.fn();
    const sendMessage = vi.fn();
    const pi = {
      sendUserMessage,
      sendMessage,
      registerCommand: vi.fn((_name: string, definition: { handler: typeof handler }) => {
        handler = definition.handler;
      }),
    } as unknown as ExtensionAPI;
    const arm = vi.fn();
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      config: {
        fullCodeMode: true,
        schema: { mode: "off" },
        prewalk: { mode: "in-place", model: "anthropic/executor" },
        agents: { enabled: true },
      },
      prewalk: { arm, status: vi.fn(), cancel: vi.fn() },
    } as unknown as FabricState;
    const context = {
      sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;

    registerFabricCommand(pi, {
      state,
      fabricUi: {} as FabricUiController,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
      autoArmPrewalk: vi.fn(async () => {}),
    });
    await handler!("prewalk Implement the token guard", context);

    expect(arm).toHaveBeenCalledWith({
      model: "anthropic/executor",
      mode: "in-place",
      sessionId: "session-1",
      task: "Implement the token guard",
    });
    expect(sendUserMessage).toHaveBeenCalledWith("Implement the token guard");
    expect(sendMessage).toHaveBeenCalledWith(
      {
        customType: PREWALK_ARMED_MESSAGE_TYPE,
        content: prewalkArmedPrompt("in-place", "anthropic/executor"),
        display: false,
        details: { mode: "in-place", model: "anthropic/executor" },
      },
      { deliverAs: "nextTurn" },
    );
    // Advisory framing lands in the queue before the task submission.
    expect(sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
      sendUserMessage.mock.invocationCallOrder[0]!,
    );
  });

  // Shared harness for the interactive prewalk executor-model tests: one
  // /fabric registration with mockable picker surfaces.
  const registerPrewalkPicker = async ({
    custom,
    hasUI = true,
    models = [
      { provider: "openai", id: "executor" },
      { provider: "anthropic", id: "other" },
    ],
    prewalkModel,
    selectResult,
  }: {
    custom?: unknown;
    hasUI?: boolean;
    models?: Array<{ provider: string; id: string }>;
    prewalkModel?: string;
    selectResult?: string;
  }) => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const sendMessage = vi.fn();
    const sendUserMessage = vi.fn();
    const pi = {
      sendUserMessage,
      sendMessage,
      registerCommand: vi.fn((_name: string, definition: { handler: typeof handler }) => {
        handler = definition.handler;
      }),
    } as unknown as ExtensionAPI;
    vi.stubEnv("PI_CODING_AGENT_DIR", await mkdtemp(path.join(os.tmpdir(), "fabric-command-prewalk-")));
    const arm = vi.fn();
    const select = vi.fn().mockResolvedValue(selectResult);
    const notify = vi.fn();
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      config: {
        fullCodeMode: true,
        schema: { mode: "off" },
        prewalk: { mode: "in-place", model: prewalkModel },
        agents: { enabled: true },
      },
      prewalk: { arm, status: vi.fn(), cancel: vi.fn() },
    } as unknown as FabricState;
    const context = {
      hasUI,
      modelRegistry: { getAvailable: () => models },
      sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
      ui: { select, custom, setStatus: vi.fn(), notify },
    } as unknown as ExtensionContext;

    registerFabricCommand(pi, {
      state,
      fabricUi: {} as FabricUiController,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
      autoArmPrewalk: vi.fn(async () => {}),
    });
    return { handler: handler!, context, arm, select, custom, sendMessage, sendUserMessage, notify };
  };

  // Drives a FabricModelSelector custom dialog with a single keypress.
  const customPickerDriver = (input: string) =>
    vi.fn(
      (
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (result: unknown) => void,
        ) => { handleInput: (data: string) => void },
      ) =>
        new Promise((resolve) => {
          const theme = {
            fg: (_color: string, text: string) => text,
            bg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          };
          factory(undefined, theme, undefined, (result) => resolve(result)).handleInput(input);
        }),
    );

  it("falls back to the plain model picker when custom dialogs are unavailable", async () => {
    const { handler, context, arm, select, sendMessage } = await registerPrewalkPicker({
      selectResult: "openai/executor",
    });
    await handler("prewalk", context);

    expect(select).toHaveBeenCalledWith("Prewalk executor model", [
      "anthropic/other",
      "openai/executor",
    ]);
    expect(arm).toHaveBeenCalledWith({
      model: "openai/executor",
      mode: "in-place",
      sessionId: "session-1",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: PREWALK_ARMED_MESSAGE_TYPE,
        content: prewalkArmedPrompt("in-place", "openai/executor"),
        display: false,
      }),
      { deliverAs: "nextTurn" },
    );
    vi.unstubAllEnvs();
  });

  it("opens the searchable FabricModelSelector when custom dialogs are available", async () => {
    const { handler, context, arm, select, sendMessage, custom } = await registerPrewalkPicker({
      custom: customPickerDriver("\r"),
    });
    await handler("prewalk", context);

    expect(custom).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
    expect(arm).toHaveBeenCalledWith({
      model: "anthropic/other",
      mode: "in-place",
      sessionId: "session-1",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: PREWALK_ARMED_MESSAGE_TYPE,
        content: prewalkArmedPrompt("in-place", "anthropic/other"),
        display: false,
      }),
      { deliverAs: "nextTurn" },
    );
    vi.unstubAllEnvs();
  });

  it("arms nothing when the rich picker is cancelled", async () => {
    const { handler, context, arm, select, sendMessage, sendUserMessage } =
      await registerPrewalkPicker({ custom: customPickerDriver("\x1b") });
    await handler("prewalk", context);

    expect(arm).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("falls back to the plain picker when the custom dialog throws", async () => {
    const { handler, context, arm, select, sendMessage } = await registerPrewalkPicker({
      custom: vi.fn(() => Promise.reject(new Error("custom dialog failed"))),
    });
    await handler("prewalk", context);

    expect(select).toHaveBeenCalledWith("Prewalk executor model", [
      "anthropic/other",
      "openai/executor",
    ]);
    expect(arm).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("notifies instead of prompting when no models are available", async () => {
    const { handler, context, arm, select, notify } = await registerPrewalkPicker({ models: [] });
    await handler("prewalk", context);

    expect(notify).toHaveBeenCalledWith(
      "Prewalk needs an explicit Pi executor model. Configure prewalk.model in /fabric settings.",
      "error",
    );
    expect(select).not.toHaveBeenCalled();
    expect(arm).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("notifies instead of prompting when the host has no UI", async () => {
    const { handler, context, arm, select, notify } = await registerPrewalkPicker({ hasUI: false });
    await handler("prewalk", context);

    expect(notify).toHaveBeenCalledWith(
      "Prewalk needs prewalk.model in non-interactive mode.",
      "error",
    );
    expect(select).not.toHaveBeenCalled();
    expect(arm).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("rejects a configured model without provider/model form", async () => {
    const { handler, context, arm, select, notify } = await registerPrewalkPicker({
      prewalkModel: "executor-model",
    });
    await handler("prewalk", context);

    expect(notify).toHaveBeenCalledWith("prewalk.model must use provider/model form.", "error");
    expect(select).not.toHaveBeenCalled();
    expect(arm).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("acknowledges queued prewalk requests after the arm completes", async () => {
    let requestHandler: ((value: unknown) => void) | undefined;
    let shutdownHandler: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const respond = vi.fn();
    const sendMessage = vi.fn();
    const pi = {
      events: {
        on: vi.fn((channel: string, handler: (value: unknown) => void) => {
          if (channel === FABRIC_PREWALK_REQUEST_EVENT) requestHandler = handler;
          return unsubscribe;
        }),
      },
      on: vi.fn((name: string, handler: () => void) => {
        if (name === "session_shutdown") shutdownHandler = handler;
      }),
      registerCommand: vi.fn(),
      sendMessage,
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    const arm = vi.fn();
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      config: {
        fullCodeMode: true,
        schema: { mode: "off" },
        prewalk: { mode: "in-place", model: "anthropic/executor", alwaysRearm: false },
        agents: { enabled: true },
      },
      prewalk: { arm, status: vi.fn(), cancel: vi.fn() },
    } as unknown as FabricState;
    const context = {
      sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;

    registerFabricCommand(pi, {
      state,
      fabricUi: {} as FabricUiController,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
    });

    const claim = vi.fn(() => true);
    requestHandler?.({ version: 1, context, claim, respond });
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: true }));

    expect(claim).toHaveBeenCalledOnce();
    expect(state.ensure).toHaveBeenCalledWith(context);
    expect(arm).toHaveBeenCalledWith({
      model: "anthropic/executor",
      mode: "in-place",
      sessionId: "session-1",
      alwaysRearm: false,
    });
    expect(sendMessage).toHaveBeenCalled();
    shutdownHandler?.();
    // The mock keeps only the last session_shutdown handler: the peer
    // protocol block that unsubscribes the cards and await listeners.
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("skips the armed prompt when the identical one already persists", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const sendMessage = vi.fn();
    const pi = {
      sendUserMessage: vi.fn(),
      sendMessage,
      registerCommand: vi.fn((_name: string, definition: { handler: typeof handler }) => {
        handler = definition.handler;
      }),
    } as unknown as ExtensionAPI;
    const arm = vi.fn();
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      config: {
        fullCodeMode: true,
        schema: { mode: "off" },
        prewalk: { mode: "trajectory", model: "anthropic/executor" },
        agents: { enabled: true },
      },
      prewalk: { arm, status: vi.fn(), cancel: vi.fn() },
    } as unknown as FabricState;
    const context = {
      sessionManager: {
        getSessionId: () => "session-1",
        getBranch: () => [
          {
            type: "custom_message",
            customType: PREWALK_ARMED_MESSAGE_TYPE,
            content: prewalkArmedPrompt("trajectory", "anthropic/executor"),
          },
        ],
      },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;

    registerFabricCommand(pi, {
      state,
      fabricUi: {} as FabricUiController,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
      autoArmPrewalk: vi.fn(async () => {}),
    });
    await handler!("prewalk", context);

    expect(arm).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("registers no dedicated display subcommand or completion", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    let completions: ((prefix: string) => Array<{ value: string }> | null) | undefined;
    const pi = {
      registerCommand: vi.fn((_name: string, definition: {
        handler: typeof handler;
        getArgumentCompletions: typeof completions;
      }) => {
        handler = definition.handler;
        completions = definition.getArgumentCompletions;
      }),
    } as unknown as ExtensionAPI;
    const state = {
      initialized: true,
      ensure: vi.fn().mockResolvedValue(undefined),
      config: { ui: { toolDisplay: "full" } },
      reloadConfig: vi.fn(),
    } as unknown as FabricState;
    const refreshToolDisplay = vi.fn();
    const notify = vi.fn();
    const context = {
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: { notify },
    } as unknown as ExtensionContext;

    registerFabricCommand(pi, {
      state,
      fabricUi: {} as FabricUiController,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
      autoArmPrewalk: vi.fn(async () => {}),
      refreshToolDisplay,
    });

    expect(completions!("dis")).toBeNull();
    await handler!("display compact", context);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /fabric"),
      "warning",
    );
    expect(state.reloadConfig).not.toHaveBeenCalled();
    expect(refreshToolDisplay).not.toHaveBeenCalled();
  });

  it("persists --disable to project config, cancels the arm, and reloads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fabric-command-prewalk-"));
    try {
      let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
      const pi = {
        registerCommand: vi.fn((_name: string, definition: { handler: typeof handler }) => {
          handler = definition.handler;
        }),
      } as unknown as ExtensionAPI;
      const cancel = vi.fn();
      const drop = vi.fn();
      const reloadConfig = vi.fn();
      const notify = vi.fn();
      const setStatus = vi.fn();
      const state = {
        ensure: vi.fn().mockResolvedValue(undefined),
        config: {
          fullCodeMode: true,
          schema: { mode: "off" },
          prewalk: { mode: "in-place", model: "anthropic/executor" },
          agents: { enabled: true },
        },
        prewalk: { cancel, status: vi.fn(), arm: vi.fn() },
        prewalkDrift: { drop },
        reloadConfig,
      } as unknown as FabricState;
      const context = {
        cwd: root,
        isProjectTrusted: () => true,
        sessionManager: { getSessionId: () => "session-1" },
        ui: { notify, setStatus },
      } as unknown as ExtensionContext;

      registerFabricCommand(pi, {
        state,
        fabricUi: {} as FabricUiController,
        capturedTools: {} as CapturedToolCatalog,
        applyFabricMode: vi.fn(),
        suspendToolCapture: vi.fn(),
        autoArmPrewalk: vi.fn(async () => {}),
      });
      await handler!("prewalk --disable", context);

      const saved = JSON.parse(
        await readFile(path.join(root, ".pi", "fabric.json"), "utf8"),
      ) as { prewalk?: { enabled?: boolean } };
      expect(saved.prewalk?.enabled).toBe(false);
      expect(reloadConfig).toHaveBeenCalledWith(context);
      expect(cancel).toHaveBeenCalled();
      expect(drop).toHaveBeenCalledWith("session-1");
      expect(setStatus).toHaveBeenCalledWith("fabric-prewalk", undefined);
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("Fabric prewalk disabled"),
        "info",
      );

      // --enable flips the flag back without touching the live controller.
      await handler!("prewalk --enable", context);
      const enabled = JSON.parse(
        await readFile(path.join(root, ".pi", "fabric.json"), "utf8"),
      ) as { prewalk?: { enabled?: boolean } };
      expect(enabled.prewalk?.enabled).toBe(true);
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("Fabric prewalk enabled"),
        "info",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects arming while the prewalk master switch is disabled", async () => {
    let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
    const sendUserMessage = vi.fn();
    const pi = {
      sendUserMessage,
      registerCommand: vi.fn((_name: string, definition: { handler: typeof handler }) => {
        handler = definition.handler;
      }),
    } as unknown as ExtensionAPI;
    const arm = vi.fn();
    const notify = vi.fn();
    const state = {
      ensure: vi.fn().mockResolvedValue(undefined),
      config: {
        fullCodeMode: true,
        schema: { mode: "off" },
        prewalk: { enabled: false, mode: "in-place", model: "anthropic/executor" },
        agents: { enabled: true },
      },
      prewalk: { arm, status: vi.fn(), cancel: vi.fn() },
    } as unknown as FabricState;
    const context = {
      sessionManager: { getSessionId: () => "session-1" },
      ui: { notify },
    } as unknown as ExtensionContext;

    registerFabricCommand(pi, {
      state,
      fabricUi: {} as FabricUiController,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: vi.fn(),
      suspendToolCapture: vi.fn(),
      autoArmPrewalk: vi.fn(async () => {}),
    });
    await handler!("prewalk Implement the token guard", context);

    expect(arm).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("prewalk is disabled"), "error");
  });

  describe("actor targets", () => {
    const ALPHA = "abc12345-0000-4000-8000-000000000001";
    const BRAVO = "def67890-0000-4000-8000-000000000002";
    const ALPHA_TWIN = "abc99999-0000-4000-8000-000000000003";

    function setup(actors: Array<{ id: string; name: string }>) {
      let handler: ((argumentsText: string, context: ExtensionContext) => Promise<void>) | undefined;
      const pi = {
        registerCommand: vi.fn((_name: string, definition: { handler: typeof handler }) => {
          handler = definition.handler;
        }),
      } as unknown as ExtensionAPI;
      const remove = vi.fn(async () => ({ removed: true }));
      const stop = vi.fn(async () => ({}));
      const definition = vi.fn((id: string) => ({ name: id }));
      const agentStop = vi.fn(async () => {});
      const createTemplate = vi.fn((def: { name: string }) => ({ name: def.name }));
      const state = {
        ensure: vi.fn().mockResolvedValue(undefined),
        actors: { list: () => actors, remove, stop, definition },
        agents: { list: () => [], stop: agentStop, cleanup: vi.fn(async () => {}) },
        globalActors: { create: createTemplate },
      } as unknown as FabricState;
      const notify = vi.fn();
      const context = { ui: { notify } } as unknown as ExtensionContext;
      registerFabricCommand(pi, {
        state,
        fabricUi: {} as FabricUiController,
        capturedTools: {} as CapturedToolCatalog,
        applyFabricMode: vi.fn(),
        suspendToolCapture: vi.fn(),
        autoArmPrewalk: vi.fn(async () => {}),
      });
      return { run: (text: string) => handler!(text, context), remove, stop, definition, agentStop, notify };
    }

    // The actor named "abc" comes second in list order, after an actor whose
    // id starts with "abc": the exact name must still win.
    const nameVersusPrefix = [
      { id: ALPHA, name: "worker" },
      { id: BRAVO, name: "abc" },
    ];

    it("remove prefers an exact name over another actor's id prefix", async () => {
      const { run, remove } = setup(nameVersusPrefix);
      await run("remove abc");
      expect(remove).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledWith(BRAVO);
    });

    it("stop prefers an exact name over another actor's id prefix", async () => {
      const { run, stop } = setup(nameVersusPrefix);
      await run("stop abc");
      expect(stop).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledWith(BRAVO);
    });

    it("export prefers an exact name over another actor's id prefix", async () => {
      const { run, definition } = setup(nameVersusPrefix);
      await run("export abc");
      expect(definition).toHaveBeenCalledOnce();
      expect(definition).toHaveBeenCalledWith(BRAVO);
    });

    it("prefers an exact id over an exact name", async () => {
      const { run, remove } = setup([
        { id: BRAVO, name: ALPHA },
        { id: ALPHA, name: "worker" },
      ]);
      await run(`remove ${ALPHA}`);
      expect(remove).toHaveBeenCalledWith(ALPHA);
    });

    it("accepts a unique id prefix", async () => {
      const { run, remove } = setup(nameVersusPrefix);
      await run("remove def6");
      expect(remove).toHaveBeenCalledWith(BRAVO);
    });

    it("refuses an ambiguous id prefix, lists the candidates, and removes nothing", async () => {
      const { run, remove, agentStop, notify } = setup([
        { id: ALPHA, name: "worker" },
        { id: ALPHA_TWIN, name: "twin" },
      ]);
      await run("remove abc");
      expect(remove).not.toHaveBeenCalled();
      expect(agentStop).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledOnce();
      const [message, level] = notify.mock.calls[0]!;
      expect(level).toBe("error");
      expect(message).toContain("Ambiguous");
      expect(message).toContain("abc12345 (worker)");
      expect(message).toContain("abc99999 (twin)");
    });

    it("stop refuses an ambiguous id prefix", async () => {
      const { run, stop, notify } = setup([
        { id: ALPHA, name: "worker" },
        { id: ALPHA_TWIN, name: "twin" },
      ]);
      await run("stop abc");
      expect(stop).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Ambiguous"), "error");
    });
  });
});
