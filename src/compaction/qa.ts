import { clipUtf8, sampleAddressed } from "./bounds.js";
import { firstLine, type CompactionEvent, type ToolCallEvent } from "./normalize.js";
import { dialogueExcerpts, recentDialogue } from "./dialogue.js";
import {
  earlierUserItem,
  MAX_EARLIER_TURNS,
  MAX_FILES_PER_KIND,
  MAX_UNRESOLVED,
  type ProjectionOptions,
} from "./projections.js";

type ProbeClass = "content" | "address";

export interface Probe {
  id: string;
  class: ProbeClass;
  question: string;
  answer: string;
}

interface ProbeFailure {
  probe: Probe;
  reason: string;
}

export interface ProbeCheck {
  passed: Probe[];
  failed: ProbeFailure[];
}

export interface QaReport {
  score: number;
  contentScore: number;
  addressScore: number;
  failures: ProbeFailure[];
}

const MAX_EARLIER_USER = 80;
const MAX_ERROR_SIGNATURE = 140;
const MAX_FABRIC_RUN_STATUS_NAME = 96;
const TRANSCRIPT_WINDOW = 40;
const FILE_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const MODIFYING_TOOLS = new Set(["edit", "write"]);

const truncate = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const pathOf = (args: Record<string, unknown>): string | undefined => {
  const value = args.path ?? args.file ?? args.dir;
  return typeof value === "string" && value.trim() ? value : undefined;
};

const essentialPathToken = (path: string): string => {
  let end = path.length;
  while (end > 0 && (path[end - 1] === "/" || path[end - 1] === "\\")) end -= 1;
  const trimmed = path.slice(0, end);
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return trimmed.slice(separator + 1) || path;
};

const eventWindow = (events: CompactionEvent[], cutIndex: number): CompactionEvent[] => {
  if (!Number.isFinite(cutIndex)) return [];
  const end = Math.max(0, Math.min(events.length, Math.trunc(cutIndex)));
  return events.slice(0, end);
};

const unresolvedErrors = (events: CompactionEvent[]): (Extract<CompactionEvent, { kind: "toolResult" }> | Extract<CompactionEvent, { kind: "bash" }>)[] => {
  const callById = new Map<string, ToolCallEvent>();
  const resultError = new Map<string, boolean>();
  for (const event of events) {
    if (event.kind === "toolCall") callById.set(event.toolCallId, event);
    if (event.kind === "toolResult") resultError.set(event.toolCallId, event.isError);
  }

  const successfulPaths: { index: number; path: string }[] = [];
  for (const event of events) {
    if (event.kind !== "toolCall" || !FILE_TOOLS.has(event.name)) continue;
    if (resultError.get(event.toolCallId) !== false) continue;
    const path = pathOf(event.args);
    if (path) successfulPaths.push({ index: event.index, path });
  }

  const successfulBash = events.filter(
    (event): event is Extract<CompactionEvent, { kind: "bash" }> =>
      event.kind === "bash" && !event.isError && event.command.trim() !== "",
  );

  const unresolved: (Extract<CompactionEvent, { kind: "toolResult" }> | Extract<CompactionEvent, { kind: "bash" }>)[] = [];
  for (const event of events) {
    if (event.kind === "toolResult" && event.isError) {
      const call = event.toolCallId ? callById.get(event.toolCallId) : undefined;
      const path = call ? pathOf(call.args) : undefined;
      const resolved = path !== undefined && successfulPaths.some(
        (success) => success.path === path && success.index > event.index,
      );
      if (!resolved) unresolved.push(event);
    } else if (event.kind === "bash" && event.isError) {
      const resolved = event.command.trim() !== "" && successfulBash.some(
        (success) => success.command === event.command && success.index > event.index,
      );
      if (!resolved) unresolved.push(event);
    }
  }
  return unresolved;
};

const score = (probes: Probe[], failures: ProbeFailure[]): number =>
  probes.length === 0 ? 1 : (probes.length - failures.length) / probes.length;

// Generate reconstruction questions from ground-truth events only. cutIndex is
// the exclusive array boundary (and therefore matches the 1-based index of the
// final included normalized event). No projection or rendered section is read.
export const generateProbes = (events: CompactionEvent[], cutIndex: number, options: ProjectionOptions = {}): Probe[] => {
  const source = eventWindow(events, cutIndex);
  const probes: Probe[] = [];
  const users = source.filter(
    (event): event is Extract<CompactionEvent, { kind: "user" }> => event.kind === "user",
  );

  // Derive complete role-labelled excerpts from source dialogue, not the
  // rendered projection or first-line samples. Lost later paragraphs fail QA.
  const exchanges = recentDialogue(source, events.slice(source.length));
  for (const exchange of exchanges) {
    for (const excerpt of dialogueExcerpts(exchange)) {
      probes.push({
        id: `dialogue:${exchange.user.entryId}:${excerpt.heading}`,
        class: "content",
        question: "Which recent user direction or preceding assistant response must remain distinguishable?",
        answer: `${excerpt.heading}\n${excerpt.text}`,
      });
    }
  }
  const firstUser = users[0];
  if (firstUser && !exchanges.some(({ user }) => user.entryId === firstUser.entryId)) {
    probes.push({
      id: "historical-goal",
      class: "content",
      question: "What original request remains verbatim?",
      answer: earlierUserItem(firstUser),
    });
  }

  const resultError = new Map<string, boolean>();
  for (const event of source) {
    if (event.kind === "toolResult") resultError.set(event.toolCallId, event.isError);
  }
  const modifyingByKind = new Map<string, { entryId: string; event: ToolCallEvent; path: string }[]>();
  const seenPathsByKind = new Map<string, Set<string>>();
  for (const event of source) {
    if (event.kind !== "toolCall" || !MODIFYING_TOOLS.has(event.name)) continue;
    const path = pathOf(event.args);
    const seenPaths = seenPathsByKind.get(event.name) ?? new Set<string>();
    seenPathsByKind.set(event.name, seenPaths);
    if (!path || resultError.get(event.toolCallId) !== false || seenPaths.has(path)) continue;
    seenPaths.add(path);
    const values = modifyingByKind.get(event.name) ?? [];
    values.push({ entryId: event.entryId, event, path });
    modifyingByKind.set(event.name, values);
  }
  for (const values of modifyingByKind.values()) {
    const sampled = sampleAddressed(values, MAX_FILES_PER_KIND);
    for (const { event, path } of sampled.values) {
      probes.push({
        id: `modified-file:${event.index}:${path}`,
        class: "content",
        question: `Which file-modification address must remain available for ${path}?`,
        answer: essentialPathToken(path),
      });
    }
    if (sampled.omitted > 0) {
      probes.push({
        id: `modified-file-omission:${sampled.omittedFirstEntryId}`,
        class: "address",
        question: `Which source range addresses ${sampled.omitted} omitted file modifications?`,
        answer: `source entries ${sampled.omittedFirstEntryId} → ${sampled.omittedLastEntryId}`,
      });
    }
  }

  const calls = new Map<string, ToolCallEvent>();
  for (const event of source) {
    if (event.kind === "toolCall") calls.set(event.toolCallId, event);
  }
  // Mirrors the failure ledger independently: open failures after the previous
  // compaction are itemized newest first, aged ones fill the remaining room, and
  // the rest keep an address range. Tool results are addressed by their call entry.
  const addressOf = (event: Extract<CompactionEvent, { kind: "toolResult" | "bash" }>): string =>
    event.kind === "toolResult" ? (calls.get(event.toolCallId)?.entryId ?? event.entryId) : event.entryId;
  const fresh = options.freshEntryIds;
  const open = unresolvedErrors(source);
  const freshOpen = open.filter((event) => fresh === undefined || fresh.has(addressOf(event)));
  const agedOpen = open.filter((event) => fresh !== undefined && !fresh.has(addressOf(event)));
  const freshItemized = freshOpen.slice(-MAX_UNRESOLVED);
  const olderFresh = freshOpen.slice(0, Math.max(0, freshOpen.length - MAX_UNRESOLVED));
  const agedRoom = olderFresh.length > 0 ? 0 : MAX_UNRESOLVED - freshItemized.length;
  const agedItemized = agedRoom > 0 ? agedOpen.slice(-agedRoom) : [];
  const agedLeft = agedOpen.slice(0, agedOpen.length - agedItemized.length);
  for (const event of [...agedItemized, ...freshItemized]) {
    if (event.kind === "toolResult") {
      const call = event.toolCallId ? calls.get(event.toolCallId) : undefined;
      const path = call ? pathOf(call.args) : undefined;
      const error = event.toolName === "fabric_exec" ? event.error : event.text;
      const signature = error ? truncate(firstLine(error), MAX_ERROR_SIGNATURE) : "failed";
      probes.push({
        id: `unresolved-error:${event.index}`,
        class: "content",
        question: `What is the signature of unresolved ${event.toolName || "tool"} error #${event.index}?`,
        answer: path
          ? `${event.toolName} ${path}: ${signature}`
          : `${event.toolName}: ${signature}`,
      });
    } else {
      probes.push({
        id: `unresolved-error:${event.index}`,
        class: "content",
        question: `What command identifies unresolved bash error #${event.index}?`,
        answer: `bash: ${truncate(firstLine(event.command), MAX_ERROR_SIGNATURE)}`,
      });
    }
  }
  for (const [kind, group] of [["older", olderFresh], ["aged", agedLeft]] as const) {
    if (group.length === 0) continue;
    probes.push({
      id: `unresolved-error-${kind}:${addressOf(group[0]!)}`,
      class: "address",
      question: `Which source range addresses ${group.length} ${kind} open errors?`,
      answer: `source entries ${addressOf(group[0]!)} → ${addressOf(group.at(-1)!)}`,
    });
  }

  let lastModify: ToolCallEvent | undefined;
  for (const event of source) {
    if (event.kind === "toolCall" && MODIFYING_TOOLS.has(event.name) && pathOf(event.args)) {
      lastModify = event;
    }
  }
  if (lastModify) {
    const path = pathOf(lastModify.args)!;
    probes.push({
      id: `last-modification:${lastModify.index}`,
      class: "content",
      question: "What path was targeted by the last file-modifying tool call?",
      answer: path,
    });
  }

  const lastRun = [...source]
    .reverse()
    .find((event): event is Extract<CompactionEvent, { kind: "fabricRun" }> =>
      event.kind === "fabricRun");
  if (lastRun) {
    probes.push({
      id: `last-fabric-run:${lastRun.index}`,
      class: "content",
      question: "What was the latest declared Fabric execution intent and paired outcome?",
      answer: `${clipUtf8(truncate(lastRun.name, MAX_FABRIC_RUN_STATUS_NAME), 256)} → ${lastRun.outcome}`,
    });
    probes.push({
      id: `last-fabric-run-address:${lastRun.index}`,
      class: "address",
      question: "Which stable address expands the latest declared Fabric execution intent?",
      answer: `[entry ${lastRun.source === "branch" ? lastRun.address : lastRun.entryId}]`,
    });
  }

  const earlierUsers = users.slice(0, -1);
  const sampledEarlierUsers = sampleAddressed(earlierUsers, MAX_EARLIER_TURNS);
  for (let index = 0; index < sampledEarlierUsers.values.length; index++) {
    const user = sampledEarlierUsers.values[index]!;
    probes.push({
      id: `earlier-turn-count:${user.index}`,
      class: "content",
      question: `Which sampled one-liner accounts for earlier turn ${index + 1}?`,
      answer: `"${truncate(firstLine(user.text), MAX_EARLIER_USER)}"`,
    });
  }
  if (sampledEarlierUsers.omitted > 0) {
    probes.push({
      id: `earlier-turn-omission:${sampledEarlierUsers.omittedFirstEntryId}`,
      class: "address",
      question: `Which source range addresses ${sampledEarlierUsers.omitted} omitted earlier turns?`,
      answer: `source entries ${sampledEarlierUsers.omittedFirstEntryId} → ${sampledEarlierUsers.omittedLastEntryId}`,
    });
  }

  const transcriptStart = source.slice(-TRANSCRIPT_WINDOW)[0]?.index ?? Number.POSITIVE_INFINITY;
  for (const user of sampledEarlierUsers.values) {
    if (user.index >= transcriptStart) continue;
    probes.push({
      id: `earlier-turn-address:${user.index}`,
      class: "address",
      question: `What summary pointer keeps earlier turn #${user.index} addressable outside the brief transcript?`,
      answer: `"${truncate(firstLine(user.text), MAX_EARLIER_USER)}"`,
    });
  }

  probes.push({
    id: "footer-recall",
    class: "address",
    question: "What footer pointer enables expansion from the append-only session log?",
    answer: "memory.recall",
  });

  return probes;
};

export const checkProbes = (summaryText: string, probes: Probe[]): ProbeCheck => {
  const passed: Probe[] = [];
  const failed: ProbeFailure[] = [];
  for (const probe of probes) {
    if (summaryText.includes(probe.answer)) {
      passed.push(probe);
    } else {
      failed.push({
        probe,
        reason: `summary does not contain expected answer ${JSON.stringify(probe.answer)}`,
      });
    }
  }
  return { passed, failed };
};

export const qaReport = (
  events: CompactionEvent[],
  cutIndex: number,
  summaryText: string,
  options: ProjectionOptions = {},
): QaReport => {
  const probes = generateProbes(events, cutIndex, options);
  const { failed } = checkProbes(summaryText, probes);
  const content = probes.filter((probe) => probe.class === "content");
  const address = probes.filter((probe) => probe.class === "address");
  const contentFailures = failed.filter(({ probe }) => probe.class === "content");
  const addressFailures = failed.filter(({ probe }) => probe.class === "address");
  return {
    score: score(probes, failed),
    contentScore: score(content, contentFailures),
    addressScore: score(address, addressFailures),
    failures: failed,
  };
};
