import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const serializableFeedbackData = (value: unknown): unknown => {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : JSON.parse(serialized) as unknown;
  } catch {
    return { fabricUnserializable: true };
  }
};

/** A UI projection only. Never use this shortened text for model context or audit. */
const preview = (text: string, limit: number): string => {
  const clean = stripVTControlCharacters(text)
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
};

/** Notifications are best-effort; an unavailable UI must never replay or drop feedback. */
export const notifyAgentFeedback = (
  context: Pick<ExtensionContext, "hasUI" | "ui"> | undefined,
  sender: string,
  message: string,
  level: "info" | "warning" = "info",
): void => {
  try {
    if (!context?.hasUI) return;
    context.ui.notify(`Agent ${preview(sender, 80) || "unknown"}: ${preview(message, 240)}`, level);
  } catch {
    // The authoritative hidden message/result is independent of its UI projection.
  }
};
