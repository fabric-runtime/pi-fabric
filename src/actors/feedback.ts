import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notifyAgentFeedback, serializableFeedbackData } from "../feedback.js";
import { actorDeliveryNotice } from "./delivery-policy.js";
import type { FabricActorDeliveryRequest } from "./types.js";

const escapeXml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Actor output enters Main as feedback, not a visible chat message. */
export const deliverActorFeedback = (
  pi: ExtensionAPI,
  context: Pick<ExtensionContext, "hasUI" | "ui">,
  request: FabricActorDeliveryRequest,
): void => {
  const { actor, message, triggerTurn } = request;
  const text = message.text ?? "";
  if (!text) return;
  // Preserve intentional next-user-turn delivery; active feedback never waits
  // for the current run to settle, even from older followUp actor policies.
  const delivery = request.delivery === "nextTurn" ? "nextTurn" : "steer";
  const notice = actorDeliveryNotice(delivery, triggerTurn);
  const data = message.data === undefined ? undefined : serializableFeedbackData(message.data);
  pi.sendMessage({
    customType: "pi-fabric-actor",
    content: [
      `<fabric-actor name=${JSON.stringify(escapeXml(actor.name))} id=${JSON.stringify(escapeXml(actor.id))}>`,
      escapeXml(text),
      data === undefined ? undefined : `<data>${escapeXml(JSON.stringify(data))}</data>`,
      "</fabric-actor>",
      notice,
    ].filter((line): line is string => Boolean(line)).join("\n"),
    display: false,
    details: {
      actor,
      message: { ...message, ...(data === undefined ? {} : { data }) },
      delivery: { mode: delivery, requestedMode: request.delivery, triggerTurn, passive: Boolean(notice) },
    },
  }, { deliverAs: delivery, triggerTurn });
  notifyAgentFeedback(context, actor.name, text);
};
