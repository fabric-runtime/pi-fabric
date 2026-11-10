interface CardInvalidators {
  call?: () => void;
  result?: () => void;
}

/** The parts of Pi's tool render context the controller needs. */
export interface FabricToolDisplayObservation {
  invalidate: () => void;
  /** Pi's per-card renderer state: one object per transcript component. */
  state: object;
}

/**
 * Tracks rendered fabric_exec cards so a display preference switch redraws the
 * current transcript.
 *
 * A card's invalidate closure holds Pi's whole transcript component, with the
 * call's arguments and its result. Pi drops components when it rebuilds the
 * transcript (compaction, tree navigation, a new session), so the controller
 * must not be what keeps them alive. It holds each card's renderer state
 * weakly and keys the closures by that state in a WeakMap: once Pi lets go of
 * a component, its entry here is collectable too.
 */
export class FabricToolDisplayController {
  readonly #cards = new Map<string, WeakRef<object>>();
  readonly #invalidators = new WeakMap<object, CardInvalidators>();
  #sweepAt = SWEEP_MIN_CARDS;
  #pendingRefresh: Array<() => void> = [];
  #refreshDrainScheduled = false;

  observe(
    toolCallId: string,
    kind: "call" | "result",
    { invalidate, state }: FabricToolDisplayObservation,
  ): void {
    const invalidators = this.#invalidators.get(state);
    if (invalidators) invalidators[kind] = invalidate;
    else this.#invalidators.set(state, { [kind]: invalidate });
    // Renderers run on every update of a card; reuse its reference.
    if (this.#cards.get(toolCallId)?.deref() !== state) {
      this.#cards.set(toolCallId, new WeakRef(state));
      if (this.#cards.size >= this.#sweepAt) this.#sweep();
    }
  }

  refresh(): void {
    for (const [toolCallId, card] of this.#cards) {
      const state = card.deref();
      const invalidators = state && this.#invalidators.get(state);
      if (!invalidators) {
        this.#cards.delete(toolCallId);
        continue;
      }
      // A card's call and result invalidators resolve to the same host
      // component: its invalidate() re-renders both renderers together, so one
      // call covers the whole card and calling both would double the work.
      const invalidate = invalidators.result ?? invalidators.call;
      if (invalidate) this.#pendingRefresh.push(invalidate);
    }
    this.#scheduleRefreshDrain();
  }

  // Drop ids whose components Pi has released. Amortized: a sweep runs when
  // the id map has doubled since the last one.
  #sweep(): void {
    for (const [toolCallId, card] of this.#cards) {
      if (card.deref() === undefined) this.#cards.delete(toolCallId);
    }
    this.#sweepAt = Math.max(SWEEP_MIN_CARDS, this.#cards.size * 2);
  }

  // Drain a few cards per event-loop turn. invalidate() synchronously runs the
  // card's full renderer pair (updateDisplay in pi's ToolExecutionComponent),
  // so re-rendering a long transcript inside a single keypress froze the UI
  // until every card had been redrawn.
  #scheduleRefreshDrain(): void {
    if (this.#refreshDrainScheduled) return;
    this.#refreshDrainScheduled = true;
    setImmediate(() => {
      this.#refreshDrainScheduled = false;
      const batch = this.#pendingRefresh.splice(0, REFRESH_CARDS_PER_TICK);
      for (const invalidate of batch) {
        try {
          invalidate();
        } catch {
          // A transcript component may already have been disposed.
        }
      }
      if (this.#pendingRefresh.length > 0) this.#scheduleRefreshDrain();
    });
  }

  clear(): void {
    this.#pendingRefresh = [];
    this.#cards.clear();
    this.#sweepAt = SWEEP_MIN_CARDS;
  }
}

// Cards re-rendered per event-loop turn during refresh(): small enough that
// one drain tick stays well inside a frame, large enough that realistic
// transcripts finish repainting within a handful of turns.
const REFRESH_CARDS_PER_TICK = 3;

// Smallest id map that triggers a sweep of released cards.
const SWEEP_MIN_CARDS = 64;
