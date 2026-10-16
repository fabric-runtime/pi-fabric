import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";
import { DecisionStore } from "../src/decisions/store.js";
import {
  answerFabricDecisionRequest,
  answerFabricDecisionsCapability,
  type ResolveFabricDecisions,
} from "../src/decisions/events.js";
import {
  FABRIC_DECISION_REQUEST_EVENT,
  readFabricDecisionRequestV1,
  readFabricDecisionsCapabilityRequestV1,
  type FabricDecisionQuestionV1,
  type FabricDecisionResultV1,
  type FabricDecisionsCapabilityResultV1,
} from "../src/protocol.js";
import { registerFabricCommand } from "../src/commands/fabric.js";
import type { CapturedToolCatalog } from "../src/capture/catalog.js";
import type { FabricState } from "../src/fabric-state.js";
import type { FabricUiController } from "../src/ui/controller.js";

const roots: string[] = [];
const main: MeshIdentity = { id: "session:main", name: "main", kind: "main", sessionId: "main" };
const human = { answeredBy: "alice", via: "cli" };
const context = {} as ExtensionContext;

const decisionStore = (): DecisionStore => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-decision-events-"));
  roots.push(root);
  return new DecisionStore(new MeshStore(root, 64 * 1024, 500), main);
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Asked {
  result: Promise<FabricDecisionResultV1>;
  /** Resolves with the decision id once the store holds it (the onRaised handshake). */
  raised: Promise<string>;
}

const ask = (
  question: FabricDecisionQuestionV1,
  resolve: ResolveFabricDecisions,
  extra: { signal?: AbortSignal; source?: string; onRaised?: (id: string) => void } = {},
): Asked => {
  let markRaised!: (id: string) => void;
  const raised = new Promise<string>((settle) => { markRaised = settle; });
  const result = new Promise<FabricDecisionResultV1>((settle) => {
    void answerFabricDecisionRequest(
      {
        version: 1,
        context,
        question,
        claim: () => true,
        respond: settle,
        ...extra,
        onRaised: (id) => {
          extra.onRaised?.(id);
          markRaised(id);
        },
      },
      resolve,
    );
  });
  return { result, raised };
};

const stored = async (store: DecisionStore, id: string) => {
  const record = await store.get(id);
  if (!record) throw new Error(`decision ${id} is not stored`);
  return record;
};

const capability = (resolve: ResolveFabricDecisions): Promise<FabricDecisionsCapabilityResultV1> =>
  new Promise((settle) => {
    void answerFabricDecisionsCapability({ version: 1, context, claim: () => true, respond: settle }, resolve);
  });

describe("decisions event channel", () => {
  it("reports the store limits when decisions are available", async () => {
    const store = decisionStore();
    const result = await capability(async () => ({ store }));
    expect(result).toMatchObject({ ok: true, available: true, maxOptions: 12, maxTitleChars: 200, minTimeoutMs: 1_000 });
    expect(result.ok && result.available && result.inputs).toEqual(["text", "confirm", "select", "editor"]);
  });

  it("reports the reason when decisions are unavailable", async () => {
    await expect(capability(async () => ({ reason: "mesh disabled" }))).resolves.toEqual({
      ok: true,
      available: false,
      reason: "mesh disabled",
    });
    await expect(ask({ title: "Pick" }, async () => ({ reason: "mesh disabled" })).result).resolves.toEqual({
      ok: false,
      error: "mesh disabled",
    });
  });

  it("returns a person's answer and reports the raised id first", async () => {
    const store = decisionStore();
    const raised: string[] = [];
    const pending = ask(
      { title: "Pick a colour", options: [{ id: "red", label: "Red" }, { id: "blue", label: "Blue" }] },
      async () => ({ store }),
      { onRaised: (id) => raised.push(id) },
    );
    const id = await pending.raised;
    expect(raised).toEqual([id]);
    expect((await store.list({ status: "open" })).map((record) => record.id)).toEqual([id]);
    await store.answer(id, { optionId: "blue" }, human);
    await expect(pending.result).resolves.toMatchObject({
      ok: true,
      id,
      status: "answered",
      answer: { optionId: "blue", answeredBy: "alice", via: "cli" },
    });
  });

  it("always holds the question for the user with no default, escalation, or program holder", async () => {
    const store = decisionStore();
    const hostile = {
      title: "Approve?",
      options: [{ id: "yes", label: "Yes", extra: "dropped" }],
      holder: "program",
      onExpire: "default",
      defaultOptionId: "yes",
      escalation: { chain: ["program"], hopTimeoutMs: 1, onFinal: "default" },
      kind: "approval",
    } as unknown as FabricDecisionQuestionV1;
    const controller = new AbortController();
    const pending = ask(hostile, async () => ({ store }), { signal: controller.signal });
    const open = await stored(store, await pending.raised);
    expect(open).toMatchObject({ kind: "question", holder: "user", onExpire: "cancel" });
    expect(open.defaultOptionId).toBeUndefined();
    expect(open.escalation).toBeUndefined();
    expect(open.options).toEqual([{ id: "yes", label: "Yes" }]);
    controller.abort();
    await pending.result;
  });

  it("names the asking extension as the raiser and keeps the session", async () => {
    const store = decisionStore();
    const controller = new AbortController();
    const pending = ask({ title: "Name?" }, async () => ({ store }), { signal: controller.signal, source: "@acme/ask-tool" });
    const open = await stored(store, await pending.raised);
    expect(open.raisedBy).toEqual({ participantId: "extension:@acme/ask-tool", sessionId: "main" });
    controller.abort();
    await pending.result;
  });

  it("records the session as the raiser when no source is given", async () => {
    const store = decisionStore();
    const controller = new AbortController();
    const pending = ask({ title: "Name?" }, async () => ({ store }), { signal: controller.signal });
    const open = await stored(store, await pending.raised);
    expect(open.raisedBy).toEqual({ participantId: "session:main", sessionId: "main" });
    controller.abort();
    await pending.result;
  });

  it("refuses a source that could pose as a participant, without raising a decision", async () => {
    const store = decisionStore();
    for (const source of ["session:main", "", "a\nb", "x".repeat(65), " ask"]) {
      const result = await ask({ title: "Name?" }, async () => ({ store }), { source }).result;
      expect(result).toEqual({ ok: false, error: "Decision source must match [A-Za-z0-9@][A-Za-z0-9@._/-]{0,63}" });
    }
    expect(await store.list()).toEqual([]);
  });

  it("returns cancelled with no answer when a person cancels", async () => {
    const store = decisionStore();
    const pending = ask({ title: "Name?" }, async () => ({ store }));
    const id = await pending.raised;
    await store.cancel(id, human);
    const result = await pending.result;
    expect(result).toEqual({ ok: true, id, status: "cancelled" });
  });

  it("returns expired with no answer when the timeout passes", async () => {
    let now = 1_000_000;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-decision-events-"));
    roots.push(root);
    const store = new DecisionStore(new MeshStore(root, 64 * 1024, 500), main, () => now);
    const pending = ask({ title: "Name?", timeoutMs: 1_000 }, async () => ({ store }));
    await pending.raised;
    now += 2_000;
    const result = await pending.result;
    expect(result).toMatchObject({ ok: true, status: "expired" });
    expect("answer" in result).toBe(false);
  });

  it("cancels the stored decision when the caller aborts", async () => {
    const store = decisionStore();
    const controller = new AbortController();
    const pending = ask({ title: "Name?" }, async () => ({ store }), { signal: controller.signal });
    const id = await pending.raised;
    controller.abort();
    await expect(pending.result).resolves.toEqual({ ok: false, id, error: "Decision request aborted" });
    expect((await store.get(id))?.status).toBe("cancelled");
  });

  it("aborts a waiting request and cancels its decision when the session shuts down", async () => {
    const store = decisionStore();
    const listeners = new Map<string, (value: unknown) => void>();
    const shutdown: Array<() => void> = [];
    const pi = {
      events: {
        on: (channel: string, handler: (value: unknown) => void) => {
          listeners.set(channel, handler);
          return () => listeners.delete(channel);
        },
      },
      on: (name: string, handler: () => void) => {
        if (name === "session_shutdown") shutdown.push(handler);
      },
      registerCommand: () => undefined,
    } as unknown as ExtensionAPI;
    const state = {
      ensure: async () => undefined,
      config: { mesh: { enabled: true } },
      decisionStore: () => store,
    } as unknown as FabricState;
    registerFabricCommand(pi, {
      state,
      fabricUi: {} as FabricUiController,
      capturedTools: {} as CapturedToolCatalog,
      applyFabricMode: () => undefined,
      suspendToolCapture: () => undefined,
    });
    const request = listeners.get(FABRIC_DECISION_REQUEST_EVENT);
    expect(request).toBeDefined();
    let markRaised!: (id: string) => void;
    const raised = new Promise<string>((settle) => { markRaised = settle; });
    const result = new Promise<FabricDecisionResultV1>((settle) => {
      request?.({ version: 1, context, question: { title: "Name?" }, claim: () => true, respond: settle, onRaised: markRaised });
    });
    const id = await raised;
    for (const handler of shutdown) handler();
    await expect(result).resolves.toEqual({ ok: false, id, error: "Decision request aborted: the session shut down" });
    expect((await stored(store, id)).status).toBe("cancelled");
  });

  it("rejects invalid questions without raising a decision", async () => {
    const store = decisionStore();
    const result = await ask({ title: "" }, async () => ({ store })).result;
    expect(result.ok).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it("ignores malformed requests", () => {
    const base = { version: 1, context, claim: () => true, respond: () => undefined };
    expect(readFabricDecisionsCapabilityRequestV1(base)).toBeDefined();
    expect(readFabricDecisionsCapabilityRequestV1({ ...base, version: 2 })).toBeUndefined();
    expect(readFabricDecisionRequestV1({ ...base, question: { title: "x" } })).toBeDefined();
    expect(readFabricDecisionRequestV1(base)).toBeUndefined();
    expect(readFabricDecisionRequestV1({ ...base, question: [] })).toBeUndefined();
    expect(readFabricDecisionRequestV1({ ...base, question: { title: "x" }, signal: {} })).toBeUndefined();
    expect(readFabricDecisionRequestV1({ ...base, question: { title: "x" }, onRaised: "no" })).toBeUndefined();
    expect(readFabricDecisionRequestV1({ ...base, question: { title: "x" }, source: 42 })).toBeUndefined();
    expect(readFabricDecisionRequestV1({ ...base, question: { title: "x" }, source: "ask" })).toBeDefined();
  });
});
