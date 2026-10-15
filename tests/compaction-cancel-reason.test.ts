import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerCompactionHook } from "../src/compaction/hook.js";

type Handler = (event: SessionBeforeCompactEvent, context: ExtensionContext) => unknown;

const compactHandler = (): Handler => {
  let handler: Handler | undefined;
  registerCompactionHook({
    on(name: string, candidate: unknown) {
      if (name === "session_before_compact") handler = candidate as Handler;
    },
  } as unknown as ExtensionAPI, { getEngine: () => "fabric" });
  return handler!;
};

const uiContext = () => ({ hasUI: true, ui: { notify: vi.fn() } }) as unknown as ExtensionContext & {
  ui: { notify: ReturnType<typeof vi.fn> };
};

const emptyBranchEvent = (reason: SessionBeforeCompactEvent["reason"], extra: Record<string, unknown> = {}) => ({
  reason,
  preparation: { tokensBefore: 50_000 },
  branchEntries: [],
  ...extra,
}) as unknown as SessionBeforeCompactEvent;

describe("Fabric compaction cancel reason", () => {
  it.each(["manual", "overflow"] as const)(
    "surfaces why Fabric could not produce a summary when it cancels %s compaction",
    (reason) => {
      const context = uiContext();

      expect(compactHandler()(emptyBranchEvent(reason), context)).toEqual({ cancel: true });
      expect(context.ui.notify).toHaveBeenCalledOnce();
      expect(context.ui.notify).toHaveBeenCalledWith("Fabric compaction cancelled: nothing to compact", "warning");
    },
  );

  it("stays quiet when it cancels a threshold compaction, which Pi retries before every response", () => {
    const context = uiContext();

    expect(compactHandler()(emptyBranchEvent("threshold"), context)).toEqual({ cancel: true });
    expect(context.ui.notify).not.toHaveBeenCalled();
  });

  it("stays quiet when it yields to a pi-vcc override instead of cancelling", () => {
    const context = uiContext();

    expect(compactHandler()(emptyBranchEvent("manual", { _piVccOverriding: true }), context)).toBeUndefined();
    expect(context.ui.notify).not.toHaveBeenCalled();
  });
});
