import v8 from "node:v8";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { FabricToolDisplayController } from "../src/ui/tool-display.js";

// refresh() drains card invalidations in small batches across event-loop turns
// (one setImmediate per batch), so tests advance the loop explicitly.
const flushDrainTurns = async (turns: number): Promise<void> => {
  for (let index = 0; index < turns; index++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

// Pi gives each transcript component one renderer state object. The test
// keeps them alive, as Pi's transcript does for cards it still shows.
const cardStates = new Map<string, object>();
const observeCard = (
  controller: FabricToolDisplayController,
  id: string,
  kind: "call" | "result",
  invalidate: () => void,
): void => {
  let state = cardStates.get(id);
  if (!state) cardStates.set(id, state = {});
  controller.observe(id, kind, { invalidate, state });
};

const collectGarbage = (): (() => void) => {
  v8.setFlagsFromString("--expose-gc");
  return vm.runInNewContext("gc") as () => void;
};

describe("FabricToolDisplayController.refresh", () => {
  it("invalidates each card once even when call and result kinds are registered", async () => {
    const controller = new FabricToolDisplayController();
    const call = vi.fn();
    const result = vi.fn();
    observeCard(controller, "card-a", "call", call);
    observeCard(controller, "card-a", "result", result);

    controller.refresh();
    await flushDrainTurns(2);

    // Both kinds resolve to the same host component whose invalidate()
    // re-renders the whole card, so one call per card is the full refresh.
    expect(result).toHaveBeenCalledOnce();
    expect(call).not.toHaveBeenCalled();
  });

  it("falls back to the call invalidator for cards without a result yet", async () => {
    const controller = new FabricToolDisplayController();
    const call = vi.fn();
    observeCard(controller, "streaming-card", "call", call);

    controller.refresh();
    await flushDrainTurns(2);

    expect(call).toHaveBeenCalledOnce();
  });

  it("drains at most a few cards per event-loop turn so one save cannot block the UI", async () => {
    const controller = new FabricToolDisplayController();
    const counts = new Map<string, number>();
    for (let index = 0; index < 8; index++) {
      const id = `card-${index}`;
      observeCard(controller, id, "call", vi.fn(() => {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }));
    }

    controller.refresh();
    await flushDrainTurns(1);
    const afterFirstTurn = [...counts.values()].reduce((sum, count) => sum + count, 0);
    expect(afterFirstTurn).toBe(3);

    await flushDrainTurns(2);
    const afterAllTurns = [...counts.values()].reduce((sum, count) => sum + count, 0);
    expect(afterAllTurns).toBe(8);
  });

  it("swallows disposed-card invalidators and keeps draining the rest", async () => {
    const controller = new FabricToolDisplayController();
    const disposed = vi.fn(() => {
      throw new Error("component disposed");
    });
    const alive = vi.fn();
    observeCard(controller, "disposed-card", "call", disposed);
    observeCard(controller, "alive-card", "call", alive);

    controller.refresh();
    await flushDrainTurns(2);

    expect(disposed).toHaveBeenCalledOnce();
    expect(alive).toHaveBeenCalledOnce();
  });

  it("drops pending refresh work on clear so rebuilt transcripts are not touched", async () => {
    const controller = new FabricToolDisplayController();
    const invalidate = vi.fn();
    observeCard(controller, "card-a", "call", invalidate);

    controller.refresh();
    controller.clear();
    await flushDrainTurns(2);

    expect(invalidate).not.toHaveBeenCalled();

    // Cards re-observed after the clear refresh normally.
    observeCard(controller, "card-b", "call", invalidate);
    controller.refresh();
    await flushDrainTurns(2);
    expect(invalidate).toHaveBeenCalledOnce();
  });
});

describe("FabricToolDisplayController retention", () => {
  // Pi's ToolExecutionComponent: its invalidate closure holds the component,
  // and the component holds the arguments, the result and the renderer state.
  const renderCard = (controller: FabricToolDisplayController, id: string) => {
    const component = { payload: new Array(1_000).fill(id), rendererState: {}, invalidations: 0 };
    const invalidate = () => { component.invalidations += 1; };
    controller.observe(id, "call", { invalidate, state: component.rendererState });
    controller.observe(id, "result", { invalidate, state: component.rendererState });
    return component;
  };

  it("does not keep cards alive after Pi drops their components", async () => {
    const gc = collectGarbage();
    const controller = new FabricToolDisplayController();
    const collected: string[] = [];
    const registry = new FinalizationRegistry<string>((id) => collected.push(id));
    const kept = renderCard(controller, "kept");
    // Compaction: Pi clears the transcript and rebuilds only the kept cards.
    (() => {
      for (let index = 0; index < 100; index++) {
        registry.register(renderCard(controller, `dropped-${index}`), `dropped-${index}`);
      }
    })();
    for (let attempt = 0; attempt < 10 && collected.length < 100; attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      gc();
    }
    expect(collected).toHaveLength(100);

    controller.refresh();
    await flushDrainTurns(2);
    expect(kept.invalidations).toBe(1);
  });
});
