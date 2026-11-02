import { expect, it } from "vitest";
import { Type } from "typebox";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as durable from "@earendil-works/pi-durable";
import { openDurableControls } from "../src/durable-controls.js";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it("reconciles a newly admitted, aborted follow-up before closing the completion boundary", async () => {
  const models = createModels();
  const faux = fauxProvider({ provider: "offline", models: [{ id: "test" }], tokensPerSecond: 100000 });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("initial answer"), fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" })]);
  const registry = durable.createRegistry();
  const entered = signal(); const completionQueued = signal(); const allowCompletion = signal();
  registry.install(durable.defineExtension({ name: "hold", tools: [durable.defineTool({
    name: "hold", description: "hold", parameters: Type.Object({}),
    execute: async (_args, _api, context) => {
      entered.resolve(); await awaitWithContext(new Promise<void>(() => {}), context); return {};
    },
  })] }));
  const context = BACKGROUND_CONTEXT;
  const storage = new durable.MemoryStorage();
  const harness = await durable.Harness.open(storage, { models, registry }, context);
  try {
    const conversation = await harness.root(context, { agent: { model: { provider: "offline", modelId: "test" } } });
    const initial = await conversation.submit({ type: "input", content: "hello", requestId: "run" }, context);
    const options = {
      durable, context, harness, storage, conversation, initial, runId: "run", closed: () => false,
      serialize: async <T>(operation: () => Promise<T>) => {
        // Delay the completion check while earlier serialized host operations admit
        // and abort a follow-up. The observer's snapshot contains only the original input.
        completionQueued.resolve(); await allowCompletion.promise; return operation();
      },
    };
    const controls = await openDurableControls(options);
    const pending = controls.wait(); void pending.catch(() => {});
    await completionQueued.promise;
    await controls.send("followUp", "more work", { requestId: "follow" }); await entered.promise;
    await controls.stop(); allowCompletion.resolve();
    const result = await pending;
    expect(result).toMatchObject({ status: "unanswered", reason: "aborted" });
    expect(await controls.liveness()).toBe("cancelled");
    const reattached = await openDurableControls(options);
    expect(await reattached.wait()).toEqual(result);
    expect(faux.state.callCount).toBe(2);
  } finally {
    allowCompletion.resolve();
    await harness.close(context);
  }
});
