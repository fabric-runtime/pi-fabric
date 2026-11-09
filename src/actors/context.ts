interface ActorContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
  redacted?: boolean;
  mimeType?: string;
}

interface ActorMessage {
  role: string;
  content: unknown;
  toolName?: string;
  isError?: boolean;
  command?: string;
  output?: string;
  exitCode?: number;
}

interface ActorDigest {
  filesTouched: string[];
  openErrors: number;
  lastError: string;
  lastUserRequest: string;
}

export interface ActorContext {
  digest: ActorDigest;
  transcript: string[];
}

const FILE_EXT =
  "ts|tsx|js|jsx|mjs|cjs|json|md|markdown|css|scss|html|vue|svelte|py|rs|go|java|kt|swift|rb|php|sh|bash|yaml|yml|toml|sql|env|lock";
const PATH_RE = new RegExp('(["\'`])([\\w@./-]+\\.(?:' + FILE_EXT + '))\\1', "g");

const clip = (value: string, max: number): string => {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "\u2026" : text;
};

const firstLine = (value: string): string => {
  const i = value.indexOf("\n");
  return i === -1 ? value : value.slice(0, i);
};

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && (part as ActorContentBlock).type === "text"
          ? String((part as ActorContentBlock).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
};

const isMessage = (value: unknown): value is ActorMessage =>
  typeof value === "object" && value !== null && "role" in value;

const extractMessages = (branch: unknown[]): ActorMessage[] => {
  const messages: ActorMessage[] = [];
  let foundWrapped = false;
  for (const entry of branch) {
    if (entry && typeof entry === "object" && (entry as { type?: unknown }).type === "message") {
      const message = (entry as { message?: unknown }).message;
      if (isMessage(message)) {
        messages.push(message);
        foundWrapped = true;
      }
    } else if (entry && typeof entry === "object") {
      const summary = entry as { type?: unknown; summary?: unknown };
      if ((summary.type === "compaction" || summary.type === "branch_summary") && typeof summary.summary === "string") {
        messages.push({ role: "summary", content: summary.summary });
        foundWrapped = true;
      }
    }
  }
  if (foundWrapped) return messages;
  for (const entry of branch) if (isMessage(entry)) messages.push(entry);
  return messages;
};

const argHint = (args: unknown): string => {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const v = a.file ?? a.path ?? a.pattern ?? a.command ?? a.cmd ?? a.code;
  return typeof v === "string" && v ? clip(v, 80) : "";
};

const scanFiles = (messages: ActorMessage[], cap: number): string[] => {
  const seen = new Set<string>();
  for (const m of messages) {
    let hay = typeof m.content === "string" ? m.content : "";
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part || typeof part !== "object") continue;
        const block = part as ActorContentBlock;
        if (block.type === "text") hay += " " + (block.text ?? "");
        else if (block.type === "toolCall") hay += " " + JSON.stringify(block.arguments ?? {});
      }
    }
    hay += " " + (m.command ?? "") + " " + (m.output ?? "");
    PATH_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PATH_RE.exec(hay)) !== null) {
      if (match[2]) seen.add(match[2]);
      if (seen.size >= cap * 3) break;
    }
  }
  return [...seen].sort().slice(0, cap);
};

const buildDigest = (messages: ActorMessage[]): ActorDigest => {
  let openErrors = 0;
  let lastError = "";
  let lastUserRequest = "";
  for (const m of messages) {
    if (m.role === "user") {
      const t = textOf(m.content).trim();
      if (t) lastUserRequest = clip(t, 300);
    } else if (m.role === "toolResult" && m.isError) {
      openErrors++;
      lastError = clip(firstLine(textOf(m.content)), 200);
    } else if (m.role === "bashExecution" && typeof m.exitCode === "number" && m.exitCode !== 0) {
      openErrors++;
      lastError = clip(firstLine(m.output ?? m.command ?? ""), 200);
    }
  }
  return { filesTouched: scanFiles(messages, 30), openErrors, lastError, lastUserRequest };
};

const compactBlocks = (msg: ActorMessage): string[] => {
  const lines: string[] = [];
  if (msg.role === "user" || msg.role === "summary") {
    const t = textOf(msg.content).trim();
    if (t) lines.push(`${msg.role}: ${clip(t, 200)}`);
  } else if (msg.role === "assistant") {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (!part || typeof part !== "object") continue;
        const block = part as ActorContentBlock;
        if (block.type === "text") {
          const t = (block.text ?? "").trim();
          if (t) lines.push(`asst: ${clip(t, 200)}`);
        } else if (block.type === "toolCall") {
          lines.push(`call: ${block.name ?? "?"} ${argHint(block.arguments)}`);
        }
      }
    } else if (typeof msg.content === "string") {
      const t = msg.content.trim();
      if (t) lines.push(`asst: ${clip(t, 200)}`);
    }
  } else if (msg.role === "toolResult") {
    const t = textOf(msg.content).trim();
    lines.push(`result ${msg.toolName ?? ""}: ${clip(firstLine(t), 150)}${msg.isError ? " [ERR]" : ""}`);
  } else if (msg.role === "bashExecution") {
    lines.push(`bash: ${clip(msg.command ?? "", 120)} -> ${msg.exitCode ?? "?"}`);
  }
  return lines;
};

const boundLines = (lines: string[], maxChars: number): string[] => {
  let total = lines.join("\n").length;
  const out = [...lines];
  while (total > maxChars && out.length > 1) {
    out.shift();
    total = out.join("\n").length;
  }
  return out;
};

export const buildActorContext = (
  branch: unknown[],
  tailCount: number,
  maxChars: number,
): ActorContext => {
  const messages = extractMessages(branch);
  const digest = buildDigest(messages);
  const lines: string[] = [];
  for (const m of messages.slice(-tailCount)) {
    for (const line of compactBlocks(m)) lines.push(line);
  }
  return { digest, transcript: boundLines(lines, maxChars) };
};
