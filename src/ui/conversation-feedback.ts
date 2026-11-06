import { stripVTControlCharacters } from "node:util";

// Keep this tiny projection in the lazy UI graph: importing feedback.ts here
// adds an eager shared chunk. The real delivery/notification integration tests
// assert exact parity with Main's formatter, including sanitization and limits.
const preview = (text: string, limit: number): string => {
  const clean = stripVTControlCharacters(text)
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
};
const formatAgentFeedback = (sender: string, text: string): string =>
  `Agent ${preview(sender, 80) || "unknown"}: ${preview(text, 240)}`;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Project only Fabric's known hidden feedback, never arbitrary hidden content
 * or structured audit data. This is a status row, not a second model message. */
export function conversationFeedback(message: { customType: string; content: string; details?: unknown }): string | undefined {
  const details = record(message.details);
  if (message.customType === "pi-fabric-actor") {
    const actor = record(details?.actor);
    const feedback = record(details?.message);
    return typeof actor?.name === "string" && typeof feedback?.text === "string"
      ? formatAgentFeedback(actor.name, feedback.text) : undefined;
  }
  if (message.customType !== "pi-fabric-agent-message") return undefined;
  const from = record(details?.from);
  const sender = typeof from?.name === "string" && from.name ? from.name : from?.id;
  if (typeof sender !== "string") return undefined;
  const content = message.content;
  const closing = "\n</fabric-agent-message>";
  if (!content.startsWith("<fabric-agent-message ") || !content.endsWith(closing)) return undefined;
  const start = content.indexOf("\n") + 1;
  if (start === 0) return undefined;
  const data = content.indexOf("\n<data>", start);
  const end = data < 0 ? content.length - closing.length : data;
  // The producer XML-escapes message text, so the literal data delimiter cannot
  // occur inside it. Decode once, after excluding the structured payload.
  const text = content.slice(start, end).replace(/&(amp|lt|gt);/g, (_entity, name: string) =>
    name === "amp" ? "&" : name === "lt" ? "<" : ">");
  return formatAgentFeedback(sender, text);
}
