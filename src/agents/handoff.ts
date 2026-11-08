import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  SessionEntry,
  SessionManager,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { JsonObject } from "@earendil-works/pi-ai";
import { compileFabricSummary, rawContextTokens, type FabricCompactionBudget } from "../compaction/hook.js";
import {
  compactionRequestBoundsError,
  encodeCompactionRequest,
} from "../compaction/instructions.js";
import { PiCodingAgent } from "../core/host-sdk-runtime.js";
import type {
  AgentForkSeed,
  AgentSessionSeed,
  AgentToolResultMessage,
  HandoffCompactionRequest,
} from "./types.js";
import { freshEntryId, workerRoleEntry } from "../durable/worker-role-seed.js";
import {
  buildThinkingDigest,
  THINKING_DIGEST_CUSTOM_TYPE,
  thinkingTransferPolicy,
  translateThinkingForExecutor,
  type ThinkingTransferInput,
  type ThinkingTransferReport,
} from "./thinking-transfer.js";

interface HandoffSessionSource {
  getBranch(): SessionEntry[];
  getEntry(id: string): SessionEntry | undefined;
  getLeafId(): string | null;
  getSessionFile(): string | undefined;
  getSessionId(): string;
}

interface CurrentModel {
  provider: string;
  id: string;
}

type NativeAssistantMessage = Extract<
  SessionMessageEntry["message"],
  { role: "assistant" }
>;
type NativeAssistantEntry = SessionMessageEntry & {
  message: NativeAssistantMessage;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface HandoffCompactionOutcome {
  applied: true;
  sections: string[];
  tokensBefore: number;
  firstKeptEntryId: string;
}

// Validate the model-facing agents.handoff `compact` option against the same
// bounds as compact.request. Called both when the request is scheduled (inside
// the guest) and when the boundary runner replays it.
export const checkedHandoffCompaction = (
  value: unknown,
): HandoffCompactionRequest | undefined => {
  if (value === undefined || value === false) return undefined;
  const input = value === true ? {} : value;
  if (!isRecord(input)) {
    throw new Error(
      "Invalid agents.handoff compact arguments: compact must be true or an object with instructions/preserve",
    );
  }
  if (input.instructions !== undefined && typeof input.instructions !== "string") {
    throw new Error("Invalid agents.handoff compact arguments: instructions must be a string");
  }
  if (
    input.preserve !== undefined &&
    (!Array.isArray(input.preserve) || input.preserve.some((item) => typeof item !== "string"))
  ) {
    throw new Error(
      "Invalid agents.handoff compact arguments: preserve must be an array of strings",
    );
  }
  const request: HandoffCompactionRequest = {
    ...(typeof input.instructions === "string" ? { instructions: input.instructions } : {}),
    ...(input.preserve !== undefined ? { preserve: input.preserve as string[] } : {}),
  };
  const boundsError = compactionRequestBoundsError(request);
  if (boundsError) {
    throw new Error(`Invalid agents.handoff compact arguments: ${boundsError.message}`);
  }
  return request;
};

const isToolCall = (value: unknown): value is {
  type: "toolCall";
  id: string;
  name: string;
  arguments: JsonObject;
} =>
  isRecord(value) &&
  value.type === "toolCall" &&
  typeof value.id === "string" &&
  typeof value.name === "string" &&
  isRecord(value.arguments);

const activeFabricTurn = (
  source: HandoffSessionSource,
  outerToolCallId: string,
): NativeAssistantEntry => {
  const leafId = source.getLeafId();
  let entry = leafId ? source.getEntry(leafId) : undefined;
  // UI titles and other session metadata may be appended while the tool runs.
  // They do not close the active assistant turn. Never cross context-producing
  // entries (including custom messages, compactions, and context edits).
  const visited = new Set<string>();
  while (entry && (entry.type === "custom" || entry.type === "label" ||
    entry.type === "session_info" || entry.type === "model_change" ||
    entry.type === "thinking_level_change" || entry.type === "usage")) {
    if (visited.has(entry.id)) {
      throw new Error("Trajectory handoff encountered cyclic session metadata");
    }
    visited.add(entry.id);
    entry = entry.parentId ? source.getEntry(entry.parentId) : undefined;
  }
  if (entry?.type !== "message" || entry.message.role !== "assistant") {
    throw new Error(
      "Trajectory handoff requires the active fabric_exec assistant turn to be the latest session message",
    );
  }
  const content = Array.isArray(entry.message.content) ? entry.message.content : [];
  const toolCalls = content.filter(isToolCall);
  if (!toolCalls.some((call) => call.id === outerToolCallId)) {
    throw new Error(
      "Trajectory handoff could not find the active fabric_exec assistant turn in the Pi session",
    );
  }
  if (toolCalls.length !== 1 || toolCalls[0]?.name !== "fabric_exec") {
    throw new Error(
      "Trajectory handoff requires fabric_exec to be the only top-level tool call in its assistant turn",
    );
  }
  return entry as NativeAssistantEntry;
};

export const snapshotHandoffSession = (
  source: HandoffSessionSource,
  currentModel: CurrentModel | undefined,
  outerToolResult: AgentToolResultMessage,
  outerToolCallId: string,
): AgentSessionSeed => {
  if (
    outerToolResult.toolCallId !== outerToolCallId ||
    outerToolResult.toolName !== "fabric_exec"
  ) {
    throw new Error("Trajectory handoff requires the finalized outer fabric_exec result");
  }
  const active = activeFabricTurn(source, outerToolCallId);
  const sourceSessionFile = source.getSessionFile();
  const branch = source.getBranch();
  let model = currentModel
    ? { provider: currentModel.provider, modelId: currentModel.id }
    : undefined;
  let thinkingLevel: string | undefined;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (!thinkingLevel && entry?.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    }
    if (!model && entry?.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    }
    if (model && thinkingLevel) break;
  }
  return {
    sourceSessionId: source.getSessionId(),
    ...(sourceSessionFile ? { sourceSessionFile } : {}),
    // Preserve trailing metadata in persisted forks just as in-memory seeds do.
    sourceBranchLeafId: source.getLeafId() ?? active.id,
    ...(!sourceSessionFile ? { sourceBranch: structuredClone(branch) } : {}),
    ...(model ? { sourceModel: model } : {}),
    ...(thinkingLevel ? { sourceThinkingLevel: thinkingLevel } : {}),
    outerToolResult: structuredClone(outerToolResult),
  };
};

/**
 * Options shared by the seed writers. `workerRole` is set only for a pi-durable
 * child: the same write that creates the file then puts the worker-role entry
 * first (the tree root) and hangs the seed's former root under it. Every other
 * byte matches the output without the option; plain `pi` and other runners
 * never pass it.
 */
export interface SessionSeedWriteOptions {
  workerRole?: boolean;
}

/** The seed's entries with the worker-role entry as the new root; the old root (parentId null) is re-parented under it. */
const withWorkerRoot = (entries: readonly SessionEntry[]): SessionEntry[] => {
  const policy = workerRoleEntry(
    freshEntryId(new Set(entries.map((entry) => entry.id))),
    null,
    new Date().toISOString(),
  ) as unknown as SessionEntry;
  // Each entry is kept as it is, except a root, whose copy gets the policy as its parent (no object spread).
  return [policy, ...entries.map((entry) => {
    if (entry.parentId !== null) return entry;
    const root = structuredClone(entry);
    root.parentId = policy.id;
    return root;
  })];
};

const materializeBranch = (
  seed: Pick<AgentSessionSeed, "sourceBranch" | "sourceSessionFile">,
  cwd: string,
  directory: string,
  options: SessionSeedWriteOptions = {},
): SessionManager => {
  if (!seed.sourceBranch) {
    throw new Error("In-memory trajectory handoff is missing its source branch");
  }
  const id = randomUUID();
  const sessionFile = path.join(directory, `handoff-${id}.jsonl`);
  const header = {
    type: "session" as const,
    version: PiCodingAgent.CURRENT_SESSION_VERSION,
    id,
    timestamp: new Date().toISOString(),
    cwd,
    ...(seed.sourceSessionFile ? { parentSession: seed.sourceSessionFile } : {}),
  };
  const entries = options.workerRole ? withWorkerRoot(seed.sourceBranch) : seed.sourceBranch;
  fs.writeFileSync(
    sessionFile,
    `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return PiCodingAgent.SessionManager.open(sessionFile, directory, cwd);
};

/**
 * Pi's createBranchedSession writes the file itself, so it cannot take the
 * worker-role root in the same write. When the seed came through it, the writer
 * rewrites its own just-created file once, after its last append and before it
 * returns the path (no worker has seen the file yet): header, policy, then every
 * entry with the old root re-parented.
 */
const insertWorkerRoot = (sessionFile: string): void => {
  if (!fs.existsSync(sessionFile)) {
    throw new Error("Trajectory handoff session file was not written, so the worker role cannot be placed at its root");
  }
  const [headerLine, ...entryLines] = fs.readFileSync(sessionFile, "utf8").split("\n").filter((line) => line.length > 0);
  const entries = entryLines.map((line) => JSON.parse(line) as SessionEntry);
  const placed = withWorkerRoot(entries);
  fs.writeFileSync(
    sessionFile,
    `${[headerLine, ...placed.map((entry) => JSON.stringify(entry))].join("\n")}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
};

const forkBranch = (
  seed: AgentSessionSeed,
  cwd: string,
  directory: string,
  options: SessionSeedWriteOptions = {},
): SessionManager => {
  if (!seed.sourceSessionFile) return materializeBranch(seed, cwd, directory, options);
  const fork = PiCodingAgent.SessionManager.open(seed.sourceSessionFile, directory, cwd);
  if (!fork.getEntry(seed.sourceBranchLeafId)) {
    throw new Error(
      `Trajectory handoff branch point ${seed.sourceBranchLeafId} is missing from the persisted Pi session`,
    );
  }
  const sessionFile = fork.createBranchedSession(seed.sourceBranchLeafId);
  if (!sessionFile) {
    throw new Error("Trajectory handoff could not create a persisted Pi session branch");
  }
  return fork;
};

// File-backed read of the exact branch prefix, cloned so transfer translation
// never mutates the source session's live entries. Used instead of
// forkBranch when the executor's reasoning channel differs: createBranchedSession
// copies raw lines and cannot rewrite foreign thinking signatures.
const persistedBranch = (
  seed: AgentSessionSeed,
  cwd: string,
  directory: string,
): SessionEntry[] => {
  if (!seed.sourceSessionFile) {
    throw new Error("Persisted trajectory handoff is missing its source session file");
  }
  const source = PiCodingAgent.SessionManager.open(seed.sourceSessionFile, directory, cwd);
  if (!source.getEntry(seed.sourceBranchLeafId)) {
    throw new Error(
      `Trajectory handoff branch point ${seed.sourceBranchLeafId} is missing from the persisted Pi session`,
    );
  }
  return structuredClone(source.getBranch(seed.sourceBranchLeafId));
};

const synchronizeSourceSettings = (
  session: SessionManager,
  seed: AgentSessionSeed,
): void => {
  const context = session.buildSessionContext();
  if (
    seed.sourceModel &&
    (context.model?.provider !== seed.sourceModel.provider ||
      context.model.modelId !== seed.sourceModel.modelId)
  ) {
    session.appendModelChange(seed.sourceModel.provider, seed.sourceModel.modelId);
  }
  if (seed.sourceThinkingLevel && context.thinkingLevel !== seed.sourceThinkingLevel) {
    session.appendThinkingLevelChange(seed.sourceThinkingLevel);
  }
};

export const writeHandoffSession = (
  seed: AgentSessionSeed,
  cwd: string,
  directory: string,
  transfer?: ThinkingTransferInput,
  compaction?: HandoffCompactionRequest,
  compactionBudget?: FabricCompactionBudget,
  options: SessionSeedWriteOptions = {},
): string => {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const policy = transfer ? thinkingTransferPolicy(transfer) : "preserved";
  let session: SessionManager;
  // Pi wrote this file itself (createBranchedSession), so the root is placed afterwards.
  const viaPiBranch = Boolean(seed.sourceSessionFile) && (!transfer || policy === "preserved");
  let report: ThinkingTransferReport | undefined;
  let digest: { content: string; citedBlocks: number } | undefined;
  if (!transfer || policy === "preserved") {
    session = forkBranch(seed, cwd, directory, options);
  } else {
    const rawBranch = seed.sourceSessionFile
      ? persistedBranch(seed, cwd, directory)
      : structuredClone(seed.sourceBranch ?? (() => {
          throw new Error("Trajectory handoff transfer is missing its source branch");
        })());
    if (policy === "stripped") digest = buildThinkingDigest(rawBranch, transfer);
    const translated = translateThinkingForExecutor(rawBranch, policy);
    report = translated.report;
    session = materializeBranch({ ...seed, sourceBranch: translated.entries }, cwd, directory, options);
  }
  synchronizeSourceSettings(session, seed);
  session.appendMessage(seed.outerToolResult);
  if (digest) {
    session.appendCustomMessageEntry(THINKING_DIGEST_CUSTOM_TYPE, digest.content, false, {
      policy,
      citedBlocks: digest.citedBlocks,
    });
  }
  // Budget the complete inherited context, including the outer result and
  // digest. The cut must see both sides of the outer tool pair. Raw entries
  // remain in the append-only child file even when the pair is summarized.
  let compactionOutcome: HandoffCompactionOutcome | undefined;
  if (compaction) {
    const branchEntries = session.getBranch();
    const customInstructions = compaction.preserve
      ? encodeCompactionRequest({
          ...(compaction.instructions !== undefined
            ? { instructions: compaction.instructions }
            : {}),
          preserve: compaction.preserve,
        })
      : compaction.instructions;
    const tokensBefore = rawContextTokens(branchEntries);
    const compiled = compileFabricSummary(branchEntries, tokensBefore, undefined, customInstructions,
      compactionBudget ? { ...compactionBudget, calibrateUsage: false } : undefined);
    if ("cancel" in compiled) {
      // A requested bounded handoff must not silently launch the unbounded fork.
      throw new Error(`Handoff compaction cancelled: ${compiled.reason}`);
    } else {
      session.appendCompaction(
        compiled.compaction.summary,
        compiled.compaction.firstKeptEntryId,
        tokensBefore,
        compiled.compaction.details,
        true,
      );
      compactionOutcome = {
        applied: true,
        sections: compiled.compaction.details?.sections ?? [],
        tokensBefore,
        firstKeptEntryId: compiled.compaction.firstKeptEntryId,
      };
    }
  }
  session.appendCustomEntry("pi-fabric-handoff", {
    sourceSessionId: seed.sourceSessionId,
    boundary: "fabric_exec_end",
    ...(compactionOutcome
      ? {
          compaction: compactionOutcome,
        }
      : {}),
    ...(transfer && report
      ? {
          thinkingTransfer: {
            policy: report.policy,
            translated: report.translated,
            dropped: report.dropped,
            target: `${transfer.target.provider}/${transfer.target.modelId}`,
          },
        }
      : {}),
  });
  const sessionFile = session.getSessionFile();
  if (!sessionFile) throw new Error("Trajectory handoff did not produce a Pi session file");
  if (options.workerRole && viaPiBranch) insertWorkerRoot(sessionFile);
  fs.chmodSync(sessionFile, 0o600);
  return sessionFile;
};

/**
 * Materialize a non-blocking fork (agents.run/spawn seed: "branch"). The seed
 * already ends at the caller's last completed turn, so no tool call is left
 * dangling; the worker then sends the task as the next user turn.
 */
export const writeForkSession = (
  seed: AgentForkSeed,
  cwd: string,
  directory: string,
  transfer?: ThinkingTransferInput,
  options: SessionSeedWriteOptions = {},
): string => {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const policy = transfer ? thinkingTransferPolicy(transfer) : "preserved";
  const raw = structuredClone(seed.sourceBranch);
  const digest = policy === "stripped" && transfer ? buildThinkingDigest(raw, transfer) : undefined;
  const entries = policy === "preserved" ? raw : translateThinkingForExecutor(raw, policy).entries;
  const session = materializeBranch(
    { sourceBranch: entries, ...(seed.sourceSessionFile ? { sourceSessionFile: seed.sourceSessionFile } : {}) },
    cwd,
    directory,
    options,
  );
  if (digest) {
    session.appendCustomMessageEntry(THINKING_DIGEST_CUSTOM_TYPE, digest.content, false, {
      policy,
      citedBlocks: digest.citedBlocks,
    });
  }
  session.appendCustomEntry("pi-fabric-fork", {
    sourceSessionId: seed.sourceSessionId,
    boundary: "last_completed_turn",
    entries: seed.sourceBranch.length,
  });
  const sessionFile = session.getSessionFile();
  if (!sessionFile) throw new Error("Branch seed did not produce a Pi session file");
  fs.chmodSync(sessionFile, 0o600);
  return sessionFile;
};
