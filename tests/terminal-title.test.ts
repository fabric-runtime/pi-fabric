import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  FabricTerminalTitle,
  installTerminalTitle,
  MAX_TERMINAL_TITLE_CHARS,
  TERMINAL_TITLE_ENTRY_TYPE,
  terminalTitleText,
} from "../src/ui/terminal-title.js";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const entry = (title: unknown) => ({
  type: "custom",
  customType: TERMINAL_TITLE_ENTRY_TYPE,
  data: { version: 1, title },
});

const harness = (options: {
  entries?: unknown[];
  enabled?: boolean;
  mode?: string;
  hasUI?: boolean;
} = {}) => {
  const applied: string[] = [];
  const appended: Array<{ customType: string; data: unknown }> = [];
  const enabled = options.enabled ?? true;
  const controller = new FabricTerminalTitle(
    { appendEntry: (customType, data) => { appended.push({ customType, data }); } },
    () => enabled,
  );
  const context = {
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    cwd: "/work/pi-fabric",
    sessionManager: {
      getEntries: () => options.entries ?? [],
      getSessionName: () => "titles",
    },
    ui: { setTitle: (title: string) => applied.push(title) },
  } as unknown as ExtensionContext;
  return { applied, appended, controller, context };
};

describe("terminalTitleText", () => {
  it("drops styling and control characters a raw OSC title cannot carry", () => {
    expect(terminalTitleText("\u001b[1;36mrecord release evidence\u001b[0m")).toBe("record release evidence");
    expect(terminalTitleText("  record\n\trelease  ")).toBe("record release");
    expect(terminalTitleText(undefined)).toBe("");
  });

  it("clips long titles to the window-chrome budget", () => {
    const clipped = terminalTitleText("x".repeat(MAX_TERMINAL_TITLE_CHARS + 40));
    expect(Array.from(clipped)).toHaveLength(MAX_TERMINAL_TITLE_CHARS);
    expect(clipped.endsWith("…")).toBe(true);
  });
});

describe("FabricTerminalTitle", () => {
  it("shows the declared title, coalesces repeats, and records nothing while it runs", () => {
    const { applied, appended, controller, context } = harness();

    controller.show(context, "record release evidence");
    controller.show(context, "record release evidence");
    controller.show(context, "  ");

    expect(applied).toEqual(["record release evidence"]);
    expect(appended).toEqual([]);
  });

  it("writes at most one entry for ten title changes, holding the last title", () => {
    const { applied, appended, controller, context } = harness();
    for (let index = 1; index <= 10; index += 1) controller.show(context, `milestone ${index}`);
    expect(applied).toHaveLength(10);
    expect(appended).toEqual([]);

    controller.flush();
    controller.flush();

    expect(appended).toEqual([
      { customType: TERMINAL_TITLE_ENTRY_TYPE, data: { version: 1, title: "milestone 10" } },
    ]);
  });

  it("does not record a resumed title again when nothing changed", () => {
    const { appended, controller, context } = harness({ entries: [entry("record release evidence")] });
    controller.resume(context);
    controller.flush();
    expect(appended).toEqual([]);
    controller.show(context, "next milestone");
    controller.flush();
    expect(appended).toEqual([
      { customType: TERMINAL_TITLE_ENTRY_TYPE, data: { version: 1, title: "next milestone" } },
    ]);
  });

  it("keeps an unrecorded title across a branch switch instead of reverting to an older entry", () => {
    const { applied, controller, context } = harness({ entries: [entry("older run")] });
    controller.show(context, "current milestone");
    controller.resume(context);
    expect(applied.at(-1)).toBe("current milestone");
    expect(controller.current()).toBe("current milestone");
  });

  it("holds the last title instead of reverting", () => {
    const { applied, controller, context } = harness();
    controller.show(context, "record release evidence");
    controller.reassert(context);
    expect(applied).toEqual(["record release evidence", "record release evidence"]);
    expect(controller.current()).toBe("record release evidence");
  });

  it("adopts the newest recorded title on resume without recording again", () => {
    const { applied, appended, controller, context } = harness({
      entries: [entry("older run"), entry("record release evidence"), { type: "session_info", name: "x" }],
    });

    controller.resume(context);

    expect(applied).toEqual(["record release evidence"]);
    expect(appended).toEqual([]);
    expect(controller.current()).toBe("record release evidence");
  });

  it("ignores an unreadable recorded title and an unrecorded session", () => {
    const missing = harness({ entries: [entry(42), entry("")] });
    missing.controller.resume(missing.context);
    expect(missing.applied).toEqual([]);

    const empty = harness();
    empty.controller.resume(empty.context);
    empty.controller.reassert(empty.context);
    expect(empty.applied).toEqual([]);
  });

  it("leaves headless hosts, disabled runs, and unnamed runs alone", () => {
    const rpc = harness({ mode: "rpc" });
    rpc.controller.show(rpc.context, "record release evidence");
    expect(rpc.applied).toEqual([]);

    const headless = harness({ hasUI: false });
    headless.controller.show(headless.context, "record release evidence");
    expect(headless.applied).toEqual([]);

    const disabled = harness({ enabled: false });
    disabled.controller.show(disabled.context, "record release evidence");
    disabled.controller.flush();
    expect(disabled.applied).toEqual([]);
    expect(disabled.appended).toEqual([]);

    const unnamed = harness();
    unnamed.controller.show(unnamed.context, undefined);
    expect(unnamed.applied).toEqual([]);
  });

  it("keeps the live title when the session refuses the entry", () => {
    const applied: string[] = [];
    const controller = new FabricTerminalTitle(
      { appendEntry: () => { throw new Error("read-only session"); } },
      () => true,
    );
    const context = {
      mode: "tui",
      hasUI: true,
      sessionManager: { getEntries: () => [], getSessionName: () => undefined },
      ui: { setTitle: (title: string) => applied.push(title) },
    } as unknown as ExtensionContext;

    controller.show(context, "record release evidence");
    expect(() => controller.flush()).not.toThrow();
    expect(applied).toEqual(["record release evidence"]);
  });
});

describe("installTerminalTitle", () => {
  const handlers = (appended: unknown[] = []) => {
    const registered = new Map<string, (event: unknown, context: unknown) => void>();
    const title = new FabricTerminalTitle({ appendEntry: (customType, data) => { appended.push({ customType, data }); } }, () => true);
    installTerminalTitle(
      {
        on: (event: string, handler: (event: unknown, context: unknown) => void) => {
          registered.set(event, handler);
          return () => {};
        },
      } as never,
      title,
    );
    return Object.assign(registered, { title });
  };

  it("adopts the title on start and branch switch, and reasserts after Pi retitles", async () => {
    const registered = handlers();
    expect([...registered.keys()].sort()).toEqual([
      "agent_settled",
      "session_info_changed",
      "session_shutdown",
      "session_start",
      "session_tree",
    ]);

    const applied: string[] = [];
    const context = {
      mode: "tui",
      hasUI: true,
      sessionManager: { getEntries: () => [entry("record release evidence")], getSessionName: () => undefined },
      ui: { setTitle: (title: string) => applied.push(title) },
    } as unknown as ExtensionContext;

    registered.get("session_start")!({}, context);
    expect(applied).toEqual([]);
    await tick();
    expect(applied).toEqual(["record release evidence"]);
  });

  it("records the held title once, synchronously, when the session shuts down", () => {
    const appended: unknown[] = [];
    const registered = handlers(appended);
    const context = {
      mode: "tui",
      hasUI: true,
      sessionManager: { getEntries: () => [], getSessionName: () => undefined },
      ui: { setTitle: () => undefined },
    } as unknown as ExtensionContext;
    registered.title.show(context, "first");
    registered.title.show(context, "second");
    expect(appended).toEqual([]);
    registered.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, context);
    expect(appended).toEqual([{ customType: TERMINAL_TITLE_ENTRY_TYPE, data: { version: 1, title: "second" } }]);
  });

  it("tolerates an event with no context", async () => {
    const registered = handlers();
    for (const handler of registered.values()) handler({}, undefined);
    await tick();
  });
});
