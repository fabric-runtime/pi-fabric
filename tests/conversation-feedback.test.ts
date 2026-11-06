import { describe, expect, it } from "vitest";
import { conversationFeedback } from "../src/ui/conversation-feedback.js";

const envelope = (text: string) => `<fabric-agent-message from_name="Reviewer" from_id="a" from_kind="agent">\n${text}\n</fabric-agent-message>`;

describe("participant feedback projection", () => {
  it("decodes only the message text once, not the structured data", () => {
    expect(conversationFeedback({
      customType: "pi-fabric-agent-message", details: { from: { name: "Reviewer", id: "a" } },
      content: envelope("&amp;lt;example&amp;gt; &lt;result&gt; &amp; done\n<data>PRIVATE PAYLOAD</data>"),
    })).toBe("Agent Reviewer: &lt;example&gt; <result> & done");
  });

  it("uses the sender id when a retained feedback record has no name", () => {
    expect(conversationFeedback({
      customType: "pi-fabric-agent-message", details: { from: { id: "a" } }, content: envelope("hello"),
    })).toBe("Agent a: hello");
  });

  it.each([
    { customType: "private", details: { from: { name: "a" } }, content: envelope("secret") },
    { customType: "pi-fabric-agent-message", content: envelope("secret") },
    { customType: "pi-fabric-agent-message", details: { from: { name: "a" } }, content: "unrecognized payload" },
    { customType: "pi-fabric-agent-message", details: { from: { name: "a" } }, content: "<fabric-agent-message no-text" },
    { customType: "pi-fabric-actor", details: { actor: { name: "a" }, message: { data: "secret" } }, content: "secret" },
  ])("does not reveal unknown, malformed, or data-only feedback: %j", (message) => {
    expect(conversationFeedback(message)).toBeUndefined();
  });
});
