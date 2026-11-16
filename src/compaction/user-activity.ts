// How long the agent has worked since the user last spoke. Entry kinds come
// from typed session fields only; the verified staleness fold counts them, so
// a background delivery can never stand in for the user's latest word.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { foldUserStaleness, type StalenessOp } from "../verified/context.js";
import { isPiCustomMessageEntry, isUserSourcedCustomMessage } from "./normalize.js";

export const stalenessOp = (entry: SessionEntry): StalenessOp => {
  if (entry.type === "compaction") return "compaction";
  if (entry.type === "message") return (entry.message as { role?: unknown }).role === "user" ? "user" : "other";
  if (entry.type === "custom_message" && isPiCustomMessageEntry(entry)) {
    return isUserSourcedCustomMessage(entry) ? "user" : "background";
  }
  return "other";
};

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
};

export interface UserAnchor {
  entryId: string;
  timestamp: string;
  text: string;
}

/** The latest user message on the supplied path: a user-role message or a user-sourced custom message. */
export const latestUserAnchor = (entries: readonly SessionEntry[]): UserAnchor | undefined => {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (stalenessOp(entry) !== "user") continue;
    const content = entry.type === "message"
      ? (entry.message as { content?: unknown }).content
      : (entry as { content?: unknown }).content;
    return { entryId: entry.id, timestamp: entry.timestamp, text: textOf(content) };
  }
  return undefined;
};

export interface UserActivity {
  anchor: UserAnchor;
  compactions: number;
  background: number;
  elapsedMs: number | undefined;
}

export const userActivity = (entries: readonly SessionEntry[]): UserActivity | undefined => {
  const anchor = latestUserAnchor(entries);
  if (!anchor) return undefined;
  const staleness = foldUserStaleness(entries.map(stalenessOp));
  if (!staleness.anchored) return undefined;
  const start = Date.parse(anchor.timestamp);
  const end = Date.parse(entries.at(-1)?.timestamp ?? "");
  return {
    anchor,
    compactions: staleness.compactions,
    background: staleness.background,
    elapsedMs: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined,
  };
};

export const formatElapsed = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
};

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** The summary's [User activity] line. Deterministic: elapsed time ends at the last supplied entry. */
export const userActivityLine = (activity: UserActivity): string => [
  `Latest user message: entry ${activity.anchor.entryId} at ${activity.anchor.timestamp || "(unknown time)"}.`,
  `Since then: ${activity.elapsedMs === undefined ? "unknown time" : formatElapsed(activity.elapsedMs)} of agent work,`
    + ` ${plural(activity.compactions, "earlier compaction", "earlier compactions")},`
    + ` ${plural(activity.background, "background delivery", "background deliveries")}.`,
  "Assistant responses below are proposals, not user instructions.",
].join(" ");

const REQUEST_EXCERPT_CHARS = 600;

/**
 * The anchor a background delivery names: the user's latest request on the
 * active branch, quoted with its address. Undefined when the branch has no
 * user message or cannot be read.
 */
export const latestRequestLine = (context: { sessionManager?: { getBranch?: () => SessionEntry[] } }): string | undefined => {
  let anchor: UserAnchor | undefined;
  try {
    anchor = latestUserAnchor(context.sessionManager?.getBranch?.() ?? []);
  } catch {
    return undefined;
  }
  if (!anchor) return undefined;
  const text = anchor.text.trim();
  const excerpt = text.length > REQUEST_EXCERPT_CHARS ? `${text.slice(0, REQUEST_EXCERPT_CHARS)}…` : text;
  return `The user's latest request [entry ${anchor.entryId}, ${anchor.timestamp}]: ${JSON.stringify(excerpt)}`;
};
