import { describe, expect, it, vi } from "vitest";
import { normalizeFabricConfig } from "../src/config.js";
import type { FabricState } from "../src/fabric-state.js";
import { createFabricExecTool } from "../src/fabric-exec-tool.js";
import { defaultCodePreviewSettings } from "../src/ui/code-preview.js";
import type { FabricRenderAudit } from "../src/ui/fabric-render.js";
import { FabricTerminalTitle, TERMINAL_TITLE_ENTRY_TYPE } from "../src/ui/terminal-title.js";

const readAudit: FabricRenderAudit = {
  ref: "pi.read",
  startedAt: 0,
  endedAt: 4,
  success: true,
  tool: "read",
  provider: "pi",
  args: { path: "src/config.ts" },
};

const harness = (options: {
  ui?: Record<string, unknown>;
  audits?: FabricRenderAudit[];
} = {}) => {
  const applied: string[] = [];
  const appended: Array<{ customType: string; data: unknown }> = [];
  const audits = options.audits ?? [readAudit];
  const state = {
    bootstrapped: true,
    initialized: true,
    config: normalizeFabricConfig({ ui: { toolDisplay: "compact", ...options.ui } }),
    ensure: vi.fn(async () => {}),
    claimHandoff: vi.fn(async () => undefined),
    prewalk: { planRequired: () => false, status: () => ({ state: "idle" }) },
    execution: {
      execute: vi.fn(async (request: { onPartial(snapshot: unknown): void }) => {
        request.onPartial({ audits, phases: [], progress: "reading" });
        return {
          success: true,
          value: { ok: true },
          logs: [],
          audits,
          phases: [],
          trace: { outcome: "succeeded", operations: [] },
          elapsedMs: 4,
        };
      }),
    },
  } as unknown as FabricState;
  const terminalTitle = new FabricTerminalTitle(
    { appendEntry: (customType, data) => { appended.push({ customType, data }); } },
    () => Boolean(state.config.ui.enabled && state.config.ui.terminalTitle),
  );
  const tool = createFabricExecTool(
    state,
    defaultCodePreviewSettings(),
    new Map(),
    (value) => value,
    undefined,
    terminalTitle,
  );
  const context = {
    mode: "tui",
    hasUI: true,
    cwd: "/work/pi-fabric",
    ui: { setTitle: (title: string) => applied.push(title), setStatus: () => {}, notify: () => {} },
    sessionManager: {
      getEntries: () => [],
      getSessionId: () => "session-1",
      getSessionName: () => "titles",
    },
  };
  return { applied, appended, tool, context, terminalTitle };
};

const run = (
  probe: ReturnType<typeof harness>,
  params: Record<string, unknown> = {},
) => probe.tool.execute!(
  "fabric-call",
  { code: "return await pi.read({ path: 'src/config.ts' });", ...params } as never,
  undefined,
  undefined,
  probe.context as never,
);

describe("fabric_exec window title", () => {
  it("shows only the declared display title and records it once at shutdown", async () => {
    const probe = harness();
    await run(probe, { display: { name: "record release evidence" } });

    expect(probe.applied).toEqual(["record release evidence"]);
    expect(probe.appended).toEqual([]);
    probe.terminalTitle.flush();
    expect(probe.appended).toEqual([
      { customType: TERMINAL_TITLE_ENTRY_TYPE, data: { version: 1, title: "record release evidence" } },
    ]);
  });

  it("never shows nested call detail", async () => {
    const probe = harness({
      audits: [
        readAudit,
        { ...readAudit, ref: "pi.bash", tool: "bash", args: { command: "bun run build" } },
      ],
    });
    await run(probe, { display: { name: "record release evidence" } });

    expect(probe.applied).toEqual(["record release evidence"]);
  });

  it("holds the title after the run instead of reverting to Pi's", async () => {
    const probe = harness();
    await run(probe, { display: { name: "record release evidence" } });
    expect(probe.applied).toEqual(["record release evidence"]);
    expect(probe.applied.some((title) => title.startsWith("π"))).toBe(false);
  });

  it("leaves the title alone without a declared name or with the setting off", async () => {
    const unnamed = harness();
    await run(unnamed);
    expect(unnamed.applied).toEqual([]);
    expect(unnamed.appended).toEqual([]);

    const disabled = harness({ ui: { terminalTitle: false } });
    await run(disabled, { display: { name: "record release evidence" } });
    expect(disabled.applied).toEqual([]);
    expect(disabled.appended).toEqual([]);
  });
});
