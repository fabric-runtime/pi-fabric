import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HANDOFF_COMPLETION_MESSAGE_TYPE, queueHandoffCompletion } from "../src/agents/handoff-completion.js";
import { registerHandoffCompletionRenderer } from "../src/ui/handoff-completion.js";

describe("handoff completion message", () => {
  const send = (implementation?: unknown) => {
    const sendMessage = vi.fn();
    queueHandoffCompletion({ sendMessage } as unknown as ExtensionAPI,
      { model: "provider/executor" },
      { completed: true, status: "completed", implementation });
    return sendMessage.mock.calls[0]![0];
  };

  it("preserves structured conclusions and handles missing output honestly", () => {
    expect(send({ checks: ["passed"], pr: "https://example.com/pull/42" }).content)
      .toContain('"pr":"https://example.com/pull/42"');
    expect(send().details.displayText).toContain("No conclusion returned");
    expect(send("").details.displayText).toContain("No conclusion returned");
  });

  it("bounds large reports without losing the continuation instruction", () => {
    const message = send("start " + "x".repeat(20000) + " end abc123");
    expect(message.content.length).toBeLessThan(10000);
    expect(message.details.displayText).toContain("Report truncated");
    expect(message.details.displayText).toContain("end abc123");
    expect(message.content).toContain("Do not redo the work");
  });

  it("registers a renderer that shows the conclusion but never its internal prompt", () => {
    const registerMessageRenderer = vi.fn<ExtensionAPI["registerMessageRenderer"]>();
    registerHandoffCompletionRenderer({ registerMessageRenderer } as unknown as ExtensionAPI);
    expect(registerMessageRenderer).toHaveBeenCalledTimes(1);
    const [type, render] = registerMessageRenderer.mock.calls[0]!;
    expect(type).toBe(HANDOFF_COMPLETION_MESSAGE_TYPE);
    const message = { ...send("Implemented guard; tests passed; commit abc123"), role: "custom", timestamp: 1 };
    for (const expanded of [false, true]) {
      const component = render(message, { expanded, outputPad: 1, keyText: () => "ctrl+o", keyHint: () => "ctrl+o to expand" }, {} as never)!;
      const lines = component.render(40);
      const text = lines.join("\n");
      expect(text).toContain("abc123");
      expect(text).not.toContain("Reply to the user");
      expect(text).not.toContain("Do not redo");
      expect(lines.every(line => visibleWidth(line) <= 40)).toBe(true);
    }
    const restored = render({ ...message, details: undefined }, { expanded: true, outputPad: 0, keyText: () => "ctrl+o", keyHint: () => "ctrl+o to expand" }, {} as never)!;
    expect(restored.render(80).join("\n")).toContain("See the handoff tool result");
  });
});
