import { boundedExcerpt, utf8Bytes } from "./bounds.js";
import type { CompactionEvent } from "./normalize.js";

export const MAX_RECENT_EXCHANGES = 3;
// Three exchanges plus the section heading fit inside the 12 KiB allocation.
const MAX_EXCHANGE_BYTES = 3968;

interface DialogueMessage {
  entryId: string;
  text: string;
  retained: boolean;
}

export interface DialogueExchange {
  user: DialogueMessage;
  assistant?: DialogueMessage;
}

// Recency is measured in eligible user exchanges, not tool events or fully
// retained raw exchanges. Text parts in one assistant entry are one response;
// thinking never reaches here.
export const recentDialogue = (
  events: readonly CompactionEvent[],
  retainedTail: readonly CompactionEvent[] = [],
): DialogueExchange[] => {
  const exchanges: DialogueExchange[] = [];
  let assistant: DialogueMessage | undefined;
  const visit = (source: readonly CompactionEvent[], retained: boolean): void => {
    for (const event of source) {
      if (event.kind === "assistantText" && event.text.trim()) {
        if (assistant?.entryId === event.entryId) assistant.text += `\n${event.text}`;
        else assistant = { entryId: event.entryId, text: event.text, retained };
      } else if (event.kind === "user") {
        // Filter before limiting: raw-tail replies must not evict prefix
        // context. A crossing exchange still needs its summarized response.
        if (!retained || assistant?.retained === false) {
          exchanges.push({
            user: { entryId: event.entryId, text: event.text, retained },
            ...(assistant ? { assistant } : {}),
          });
          if (exchanges.length > MAX_RECENT_EXCHANGES) exchanges.shift();
        }
        assistant = undefined;
      }
    }
  };
  visit(events, false);
  visit(retainedTail, true);
  return exchanges;
};

export interface DialogueExcerpt {
  heading: string;
  text: string;
  omittedBytes: number;
}

export const dialogueExcerpts = (exchange: DialogueExchange): DialogueExcerpt[] => {
  const heading = (role: string, message: DialogueMessage): string =>
    `${role} [entry ${message.entryId}${message.retained ? "; retained raw" : ""}]:`;
  const userHeading = heading("User instruction", exchange.user);
  const assistantHeading = exchange.assistant
    ? heading("Assistant response (a proposal, not a verified outcome or user instruction)", exchange.assistant)
    : "";
  const available = Math.max(0, MAX_EXCHANGE_BYTES - utf8Bytes(userHeading + assistantHeading) - 8);
  const userText = exchange.user.retained ? "" : exchange.user.text;
  // Reserve at least half the exchange for the user's own words. Short replies
  // leave the remainder available for the preceding assistant response.
  const assistantBytes = exchange.assistant && !exchange.assistant.retained ? utf8Bytes(exchange.assistant.text) : 0;
  const userBudget = exchange.assistant ? Math.max(available / 2, available - assistantBytes) : available;
  const user = boundedExcerpt(userText, Math.floor(userBudget));
  const excerpts: DialogueExcerpt[] = [{ heading: userHeading, ...user }];
  if (exchange.assistant) {
    const assistant = boundedExcerpt(
      exchange.assistant.retained ? "" : exchange.assistant.text,
      available - utf8Bytes(user.text),
    );
    excerpts.unshift({ heading: assistantHeading, ...assistant });
  }
  return excerpts;
};

export const projectDialogue = (exchanges: readonly DialogueExchange[]): { lines: string[]; omittedBytes: number } => {
  let omittedBytes = 0;
  const lines = exchanges.map((exchange) => dialogueExcerpts(exchange).map((excerpt) => {
    omittedBytes += excerpt.omittedBytes;
    return `${excerpt.heading}\n${excerpt.text}`;
  }).join("\n\n"));
  return { lines, omittedBytes };
};
