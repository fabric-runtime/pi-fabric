import { describe, expect, it, vi } from "vitest";
import {
  createConversationQueue,
  QUEUE_STEER_CONVERSATION_QUEUE_REQUEST_EVENT,
  type ConversationQueueBridgeV1,
  type ConversationQueueOptions,
  type ConversationSnapshotEntry,
} from "../src/ui/conversation-queue.js";

type Handler = (value: unknown) => void;

const fakeBus = () => {
  const handlers = new Map<string, Set<Handler>>();
  return {
    emit(channel: string, value: unknown) {
      for (const handler of handlers.get(channel) ?? []) handler(value);
    },
    on(channel: string, handler: Handler) {
      const set = handlers.get(channel) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(channel, set);
      return () => set.delete(handler);
    },
  };
};

import type { Theme } from "@earendil-works/pi-coding-agent";

const theme = {
  fg: (color: string, text: string) => `[${color}]${text}`,
} as unknown as Theme;

const fakeEditor = () => {
  let text = "";
  return {
    getText: () => text,
    setText: (next: string) => {
      text = next;
    },
    handleInput: (data: string) => {
      text += data;
    },
  };
};

const keybindings = () => ({
  matches: (data: string, action: string) =>
    (data === "UP" && action === "app.message.dequeue")
    || (data === "ENTER" && action === "tui.input.submit")
    || (data === "ESC" && action === "app.interrupt"),
  getKeys: (action: string): string[] =>
    action === "app.message.dequeue" ? ["alt+up"] : ["enter"],
} as unknown as NonNullable<ConversationQueueOptions["keybindings"]>);

const baseOptions = (overrides: Partial<ConversationQueueOptions> = {}): ConversationQueueOptions => ({
  piEvents: fakeBus(),
  targetId: "agent-1",
  targetName: "Builder",
  send: vi.fn(async () => undefined),
  theme,
  editor: fakeEditor(),
  keybindings: keybindings(),
  onNotify: vi.fn(),
  ...overrides,
});

/** Stub bridge that hands out real isolated per-target queue state. */
const stubBridgeListener = (
  bus: ReturnType<typeof fakeBus>,
  renderer?: Pick<ConversationQueueBridgeV1, "buildTimelineItems" | "createTimelineWidget">,
) => {
  const retained = new Map<string, {
    rows: { id: string; lane: "steer" | "followUp"; text: string; images: unknown[]; sequence: number; paused?: boolean }[];
    seq: number;
  }>();
  return bus.on(QUEUE_STEER_CONVERSATION_QUEUE_REQUEST_EVENT, (value) => {
    const request = value as {
      version: number;
      action: "acquire" | "release";
      targetId: string;
      claim(): boolean;
      respond(result: { ok: boolean; bridge?: ConversationQueueBridgeV1; error?: string }): void;
    };
    if (request.version !== 1 || !request.claim()) return;
    if (request.action === "release") {
      retained.delete(request.targetId);
      request.respond({ ok: true });
      return;
    }
    let state = retained.get(request.targetId);
    if (!state) {
      state = { rows: [], seq: 0 };
      retained.set(request.targetId, state);
    }
    let idCounter = 0;
    const bridge: ConversationQueueBridgeV1 = {
      version: 1,
      targetId: request.targetId,
      createQueue: () => ({
        enqueue: (lane, text) => {
          const prefix = lane === "steer" ? "steer" : "follow-up";
          const row = {
            id: `${prefix}-${++idCounter}`,
            lane,
            text,
            images: [] as string[],
            sequence: ++state!.seq,
            paused: false,
          };
          state!.rows.push(row);
          return row;
        },
        enqueueSteer: (text) => {
          const queue = bridge.createQueue();
          const row = queue.enqueue("steer", text);
          const firstRoot = state!.rows.findIndex((candidate) => candidate.lane === "followUp");
          if (firstRoot !== -1) {
            const inserted = state!.rows.pop()!;
            state!.rows.splice(firstRoot, 0, inserted);
          }
          return row;
        },
        snapshot: () => state!.rows.map((row) => ({ ...row, images: [...row.images] })),
        peek: () => {
          const row = state!.rows[0];
          return row ? { ...row, images: [...row.images] } : undefined;
        },
        get: (id) => {
          const row = state!.rows.find((candidate) => candidate.id === id);
          return row ? { ...row, images: [...row.images] } : undefined;
        },
        remove: (id) => {
          const index = state!.rows.findIndex((candidate) => candidate.id === id);
          if (index === -1) return undefined;
          const [row] = state!.rows.splice(index, 1);
          return row!;
        },
        prepend: (item) => {
          state!.rows.unshift({ ...item, images: [...item.images] });
        },
        prependMany: (items) => {
          state!.rows.unshift(...items.map((item) => ({ ...item, images: [...item.images] })));
        },
        update: (id, text) => {
          const row = state!.rows.find((candidate) => candidate.id === id);
          if (!row) return false;
          row.text = text;
          return true;
        },
        setLane: (id, lane) => {
          const row = state!.rows.find((candidate) => candidate.id === id);
          if (!row || row.lane === lane) return false;
          row.lane = lane;
          return true;
        },
        setPaused: (id, paused) => {
          const row = state!.rows.find((candidate) => candidate.id === id);
          if (!row || row.paused === paused) return false;
          row.paused = paused;
          return true;
        },
        clear: () => {
          state!.rows = [];
        },
        get length() {
          return state!.rows.length;
        },
      }),
      createEditSession: (item, composerDraft) => {
        const drafts = new Map<string, { text: string; lane: "steer" | "followUp"; removed: boolean; paused: boolean }>();
        let selected = item.id;
        drafts.set(item.id, { text: item.text, lane: item.lane, removed: false, paused: item.paused ?? false });
        return {
          composerDraft,
          get selectedId() {
            return selected;
          },
          capture: (text) => {
            const draft = drafts.get(selected);
            if (draft) draft.text = text;
          },
          select: (next, currentText) => {
            const draft = drafts.get(selected);
            if (draft) draft.text = currentText;
            if (!drafts.has(next.id)) {
              drafts.set(next.id, { text: next.text, lane: next.lane, removed: false, paused: next.paused ?? false });
            }
            selected = next.id;
            return drafts.get(next.id)?.text ?? next.text;
          },
          toggleRemoved: (id) => {
            const draft = drafts.get(id);
            if (!draft) return undefined;
            draft.removed = !draft.removed;
            return draft.removed;
          },
          togglePaused: (id) => {
            const draft = drafts.get(id);
            if (!draft) return undefined;
            draft.paused = !draft.paused;
            return draft.paused;
          },
          setLane: (id, lane: "steer" | "followUp") => {
            const draft = drafts.get(id);
            if (!draft) return undefined;
            draft.lane = lane;
            return draft.lane;
          },
          commit: (queue, currentText) => {
            const draft = drafts.get(selected);
            if (draft) draft.text = currentText;
            let updated = 0;
            let removed = 0;
            let moved = 0;
            let held = 0;
            let released = 0;
            for (const [id, entry] of drafts.entries()) {
              if (entry.removed || !entry.text.trim()) {
                if (queue.remove(id)) removed += 1;
                continue;
              }
              if (queue.update(id, entry.text)) updated += 1;
              if (queue.setLane(id, entry.lane as "steer" | "followUp")) moved += 1;
              if (queue.setPaused(id, entry.paused)) {
                if (entry.paused) held += 1;
                else released += 1;
              }
            }
            return { updated, removed, moved, held, released };
          },
          rollbackPositions: () => {},
          laneFor: (id) => drafts.get(id)?.lane,
          textFor: (id) => drafts.get(id)?.text,
          pausedFor: (id) => drafts.get(id)?.paused,
          isRemoved: (id) => drafts.get(id)?.removed ?? false,
        };
      },
      isQueueableSubmission: (text: string) => !text.trim().startsWith("/") && !text.trim().startsWith("!") && text.trim() !== "",
      laneLabel: (lane) => (lane === "steer" ? "steer" : "follow-up"),
      laneColor: (lane) => (lane === "steer" ? "accent" : "warning"),
      ...renderer,
    };
    request.respond({ ok: true, bridge });
  });
};

const snapshotEntry = (id: string, text: string, historical?: boolean): ConversationSnapshotEntry =>
  historical ? { id, text, historical: true } : { id, text };

describe("conversation queue handshake", () => {
  it("falls back to native mode when no extension claims the request", () => {
    const queue = createConversationQueue(baseOptions());
    expect(queue.mode).toBe("native");
    expect(queue.active).toBe(false);
  });

  it("uses the extension bridge when a listener claims and responds", () => {
    const bus = fakeBus();
    const unsubscribe = stubBridgeListener(bus);
    try {
      const queue = createConversationQueue(baseOptions({ piEvents: bus }));
      expect(queue.mode).toBe("extension");
      queue.stage("mid-run nudge", "steer");
      queue.stage("run after this", "followUp");
      expect(queue.rows().map((row) => [row.lane, row.text])).toEqual([
        ["steer", "mid-run nudge"],
        ["followUp", "run after this"],
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("retains bridge queue state across dispose({retain:true}) and releases on default dispose", () => {
    const bus = fakeBus();
    const unsubscribe = stubBridgeListener(bus);
    try {
      const first = createConversationQueue(baseOptions({ piEvents: bus }));
      first.stage("parked work", "steer");
      first.dispose({ retain: true });
      const second = createConversationQueue(baseOptions({ piEvents: bus }));
      expect(second.pendingCount()).toBe(1);
      second.dispose();
      const third = createConversationQueue(baseOptions({ piEvents: bus }));
      expect(third.pendingCount()).toBe(0);
    } finally {
      unsubscribe();
    }
  });
});

describe("conversation queue staging restrictions", () => {
  it("rejects Main-only control input and empty text without enqueueing", () => {
    const bus = fakeBus();
    const unsubscribe = stubBridgeListener(bus);
    try {
      const queue = createConversationQueue(baseOptions({ piEvents: bus }));
      expect(queue.stage("/compact", "steer").ok).toBe(false);
      expect(queue.stage("!ls", "steer").ok).toBe(false);
      expect(queue.stage("   ", "steer").ok).toBe(false);
      expect(queue.pendingCount()).toBe(0);
    } finally {
      unsubscribe();
    }
  });
});

describe("conversation queue dispatch and restoration", () => {
  it("appends the delivery hint without modifying the bridge’s cached render rows", async () => {
    const cachedRows = Object.freeze(["cached timeline"]);
    const bus = fakeBus();
    const unsubscribe = stubBridgeListener(bus, {
      buildTimelineItems: () => [],
      createTimelineWidget: () => ({ render: () => cachedRows, invalidate() {} }),
    });
    const queue = createConversationQueue(baseOptions({ piEvents: bus }));
    try {
      queue.stage("queued work", "steer");
      expect(queue.render(90)).toBe(cachedRows);
      expect(await queue.submit("steer")).toBe(true);
      for (let frame = 0; frame < 2; frame++) {
        expect(queue.render(90)).toEqual([
          "cached timeline",
          "[dim]Sent rows await child delivery; they cannot be edited locally.",
        ]);
      }
      expect(cachedRows).toEqual(["cached timeline"]);
    } finally {
      queue.dispose();
      unsubscribe();
    }
  });
  it("dispatches the head lane batch, marks rows immutable dispatched, and keeps them visible", async () => {
    const send = vi.fn(async () => ({ messageId: "env-7" }));
    const bus = fakeBus();
    const unsubscribe = stubBridgeListener(bus);
    try {
      const queue = createConversationQueue(baseOptions({ piEvents: bus, send }));
      queue.stage("one", "steer");
      queue.stage("two", "steer");
      queue.stage("run next", "followUp");
      expect(await queue.submit("steer")).toBe(true);
      expect(send).toHaveBeenCalledTimes(2);
      const rows = queue.rows();
      expect(rows[0]).toMatchObject({ text: "one", state: "dispatched", selected: false });
      expect(rows[1]).toMatchObject({ text: "two", state: "dispatched" });
      expect(rows[2]).toMatchObject({ text: "run next", state: "queued" });
      expect(queue.pendingCount()).toBe(3);
    } finally {
      unsubscribe();
    }
  });

  it("interactive steering joins the current run ahead of queued follow-ups", async () => {
    const send = vi.fn(async () => undefined);
    const bus = fakeBus();
    const unsubscribe = stubBridgeListener(bus);
    try {
      const queue = createConversationQueue(baseOptions({ piEvents: bus, send }));
      queue.stage("run next", "followUp");
      queue.stage("nudge now", "steer");
      expect(queue.rows().map((row) => [row.lane, row.text])).toEqual([
        ["steer", "nudge now"],
        ["followUp", "run next"],
      ]);
      expect(await queue.submit("steer")).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith("nudge now", "steer");
      expect(queue.rows().map((row) => [row.state, row.text])).toEqual([
        ["dispatched", "nudge now"],
        ["queued", "run next"],
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("never crosses a lane boundary or a paused head row", async () => {
    const send = vi.fn(async () => undefined);
    const bus = fakeBus();
    const unsubscribe = stubBridgeListener(bus);
    try {
      const queue = createConversationQueue(baseOptions({ piEvents: bus, send }));
      queue.stage("run next", "followUp");
      expect(await queue.submit("steer")).toBe(false);
      expect(send).not.toHaveBeenCalled();
      expect(queue.pendingCount()).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  it("refuses dispatch while an editing session is active", async () => {
    const bus = fakeBus();
    const unsubscribe = stubBridgeListener(bus);
    try {
      const queue = createConversationQueue(baseOptions({ piEvents: bus }));
      queue.stage("editable", "steer");
      expect(queue.handleInput("UP")).toBe(true);
      expect(queue.editingActive).toBe(true);
      expect(await queue.submit("steer")).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it("restores the exact remaining rows to the head on a failed send", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("route down"))
      .mockRejectedValueOnce(new Error("route down"));
    const bus = fakeBus();
    const unsubscribe = stubBridgeListener(bus);
    try {
      const queue = createConversationQueue(baseOptions({ piEvents: bus, send }));
      queue.stage("first", "steer");
      queue.stage("second", "steer");
      queue.stage("third", "steer");
      expect(await queue.submit("steer")).toBe(false);
      expect(send).toHaveBeenCalledTimes(2);
      // "first" was route-accepted (stays dispatched); the failed row and
      // every row behind it are exactly where they were, "second" back at the
      // queue head in original order.
      expect(queue.rows().map((row) => [row.text, row.state])).toEqual([
        ["first", "dispatched"],
        ["second", "queued"],
        ["third", "queued"],
      ]);
    } finally {
      unsubscribe();
    }
  });
});

describe("snapshot reconciliation", () => {
  it("retires a dispatched row by expected native message identity", async () => {
    const send = vi.fn(async () => ({ messageId: "env-9" }));
    const bus = fakeBus();
    const unsubscribe = stubBridgeListener(bus);
    try {
      const queue = createConversationQueue(baseOptions({ piEvents: bus, send }));
      queue.stage("nudge", "steer");
      await queue.submit("steer");
      expect(queue.pendingCount()).toBe(1);
      expect(queue.syncSnapshot([snapshotEntry("older-1", "nudge", true)])).toBe(0);
      expect(queue.syncSnapshot([snapshotEntry("env-9", "nudge")])).toBe(1);
      expect(queue.pendingCount()).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  it("never retires from historical baseline text, older pages, or identical history", async () => {
    const send = vi.fn(async () => undefined);
    const bus = fakeBus();
    const unsubscribe = stubBridgeListener(bus);
    try {
      const queue = createConversationQueue(baseOptions({ piEvents: bus, send }));
      // Initial pre-dispatch snapshot: the same text is already in history.
      expect(queue.syncSnapshot([
        snapshotEntry("hist-1", "nudge", true),
        snapshotEntry("hist-2", "nudge", true),
      ])).toBe(0);
      queue.stage("nudge", "steer");
      await queue.submit("steer");
      // A later page load of the same old history must not fake consumption.
      expect(queue.syncSnapshot([snapshotEntry("hist-3", "nudge", true)])).toBe(0);
      expect(queue.pendingCount()).toBe(1);
      // A genuinely new live message with that text does.
      expect(queue.syncSnapshot([snapshotEntry("live-1", "nudge")])).toBe(1);
      expect(queue.pendingCount()).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  it("counts duplicates so identical queued rows retire one-for-one", async () => {
    const send = vi.fn(async () => undefined);
    const bus = fakeBus();
    const unsubscribe = stubBridgeListener(bus);
    try {
      const queue = createConversationQueue(baseOptions({ piEvents: bus, send }));
      queue.stage("same text", "steer");
      queue.stage("same text", "steer");
      await queue.submit("steer");
      expect(queue.syncSnapshot([snapshotEntry("live-1", "same text")])).toBe(1);
      expect(queue.pendingCount()).toBe(1);
      expect(queue.syncSnapshot([snapshotEntry("live-2", "same text")])).toBe(1);
      expect(queue.pendingCount()).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  it("preserves rows when a run merely ends; only retireAll drops them", async () => {
    const send = vi.fn(async () => undefined);
    const bus = fakeBus();
    const unsubscribe = stubBridgeListener(bus);
    try {
      const queue = createConversationQueue(baseOptions({ piEvents: bus, send }));
      queue.stage("next run work", "followUp");
      await queue.submit("followUp");
      // Run-ended lifecycle events are not retirement events: Main never
      // calls retireAll for them, and pendingCount is unchanged.
      expect(queue.pendingCount()).toBe(1);
      expect(queue.retireAll("target removed")).toBe(1);
      expect(queue.pendingCount()).toBe(0);
    } finally {
      unsubscribe();
    }
  });
});

describe("row editing", () => {
  it("commits an edited row in place and restores the composer draft", () => {
    const bus = fakeBus();
    const unsubscribe = stubBridgeListener(bus);
    try {
      const editor = fakeEditor();
      editor.setText("composer draft");
      const queue = createConversationQueue(baseOptions({ piEvents: bus, editor }));
      queue.stage("original", "steer");
      expect(queue.handleInput("UP")).toBe(true);
      expect(editor.getText()).toBe("original");
      editor.handleInput(" edited");
      expect(queue.handleInput("ENTER")).toBe(true);
      expect(queue.editingActive).toBe(false);
      expect(editor.getText()).toBe("composer draft");
      expect(queue.rows()[0]?.text).toBe("original edited");
    } finally {
      unsubscribe();
    }
  });

  it("rolls back the whole editing session on escape", () => {
    const bus = fakeBus();
    const unsubscribe = stubBridgeListener(bus);
    try {
      const editor = fakeEditor();
      editor.setText("composer draft");
      const queue = createConversationQueue(baseOptions({ piEvents: bus, editor }));
      queue.stage("original", "steer");
      queue.handleInput("UP");
      editor.handleInput(" drifted");
      expect(queue.handleInput("ESC")).toBe(true);
      expect(editor.getText()).toBe("composer draft");
      expect(queue.rows()[0]?.text).toBe("original");
    } finally {
      unsubscribe();
    }
  });

  it("leaves non-editing input unconsumed for Main", () => {
    const bus = fakeBus();
    const unsubscribe = stubBridgeListener(bus);
    try {
      const queue = createConversationQueue(baseOptions({ piEvents: bus }));
      expect(queue.handleInput("x")).toBe(false);
    } finally {
      unsubscribe();
    }
  });
});

describe("rendering", () => {
  it("shows rows during acknowledgement and restores a rejected direct draft without duplicates", async () => {
    let reject!: (error: Error) => void;
    const queue = createConversationQueue(baseOptions({ send: () => new Promise<void>((_resolve, fail) => { reject = fail; }) }));
    const sent = queue.dispatch("raw draft", "steer");
    expect(queue.render(80).join("\n")).toContain("Steering: raw draft");
    reject(new Error("owner offline"));
    await expect(sent).rejects.toThrow("owner offline");
    expect(queue.rows()).toEqual([]);
  });

  it("uses queue_update rows from other senders without duplicating owned rows", async () => {
    const queue = createConversationQueue(baseOptions());
    await queue.dispatch("mine", "steer");
    queue.stage("user next", "steer");
    queue.syncPending({ steering: ["mine", "from Main"], followUp: ["later"] });
    const lines = queue.render(80).join("\n");
    expect(lines.match(/Steering: mine/g)).toHaveLength(1);
    expect(lines).toContain("Steering: from Main");
    expect(lines).toContain("Follow-up: later");
    expect(queue.rows().map((row) => row.text)).toEqual(["mine", "user next", "from Main", "later"]);
    expect(queue.rows()).toHaveLength(4);
    queue.syncPending({ steering: [], followUp: [] });
    expect(queue.rows().map((row) => row.text)).toEqual(["mine", "user next"]);
  });

  it("uses native Pi labels and colors in native fallback mode", () => {
    const queue = createConversationQueue(baseOptions());
    queue.stage("nudge", "steer");
    const lines = queue.render(80).join("\n");
    expect(lines).toContain("[dim]Steering: nudge");
    expect(lines).toContain("edit queued messages");
  });

  it("uses the bridge lane colors in extension mode without claiming the shared widget", () => {
    const bus = fakeBus();
    const unsubscribe = stubBridgeListener(bus);
    try {
      const queue = createConversationQueue(baseOptions({ piEvents: bus }));
      queue.stage("nudge", "steer");
      const lines = queue.render(80).join("\n");
      expect(lines).toContain("[accent]steer: nudge");
    } finally {
      unsubscribe();
    }
  });

  it("renders native-shaped pending rows without claiming they are editable", async () => {
    const send = vi.fn(async () => undefined);
    const bus = fakeBus();
    const unsubscribe = stubBridgeListener(bus);
    try {
      const queue = createConversationQueue(baseOptions({ piEvents: bus, send }));
      queue.stage("nudge", "steer");
      await queue.submit("steer");
      const lines = queue.render(120).join("\n");
      expect(lines).toContain("steer: nudge");
      expect(lines).toContain("Waiting for child delivery");
      expect(lines).not.toContain("to edit queued messages");
    } finally {
      unsubscribe();
    }
  });
});
