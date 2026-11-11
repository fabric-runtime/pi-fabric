import fs from "node:fs";
import path from "node:path";
import { readSessionHeader } from "./normalize.js";

export interface SessionRef {
  id: string;
  file: string;
  cwd: string;
  mtime: number;
}

export interface ResolveScopeInput {
  agentDir: string;
  cwd: string;
  scope: string;
  sessionId?: string;
  sessionFile?: string;
  maxSessions: number;
}

const SESSIONS_SUBDIR = "sessions";

const isJsonlFile = (name: string): boolean => name.endsWith(".jsonl");

/** Encode a cwd into the safe directory name pi stores session files under. */
export const encodeCwdDir = (cwd: string): string =>
  `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

/** Directory pi stores this project's session JSONL files under. */
export const sessionDirForCwd = (cwd: string, agentDir: string): string =>
  path.join(agentDir, SESSIONS_SUBDIR, encodeCwdDir(cwd));

const listJsonlInDir = (dir: string): string[] => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isJsonlFile(entry.name))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
};

const statMtime = (file: string): number => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

const refFromFile = (file: string): SessionRef => {
  const header = readSessionHeader(file);
  return {
    id: header?.sessionId ?? path.basename(file, ".jsonl"),
    file,
    cwd: header?.cwd ?? "",
    mtime: statMtime(file),
  };
};

export const sessionsDirRoot = (agentDir: string): string => path.join(agentDir, SESSIONS_SUBDIR);

const compareRefsByRecency = (left: SessionRef, right: SessionRef): number => {
  if (right.mtime !== left.mtime) return right.mtime - left.mtime;
  return left.file < right.file ? -1 : left.file > right.file ? 1 : 0;
};

/**
 * Enumerate every session JSONL file under the agent dir, newest first by
 * file mtime. Bounded by `maxSessions`. Returns refs with resolved cwd and
 * sessionId from each file header (falling back to the file stem).
 */
export const enumerateAllSessions = (agentDir: string, maxSessions: number): SessionRef[] => {
  const root = sessionsDirRoot(agentDir);
  let projectDirs: string[] = [];
  try {
    projectDirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const dir of projectDirs) {
    for (const file of listJsonlInDir(dir)) files.push(file);
  }
  return files
    .map(refFromFile)
    .sort(compareRefsByRecency)
    .slice(0, Math.max(1, maxSessions));
};

const newestSessionInDir = (dir: string): SessionRef | null => {
  const files = listJsonlInDir(dir);
  if (files.length === 0) return null;
  return files
    .map(refFromFile)
    .sort(compareRefsByRecency)[0]!;
};

export class AmbiguousSessionError extends Error {
  readonly code = "ambiguous_session";

  constructor(
    readonly session: string,
    readonly candidates: string[],
  ) {
    super(`Session id ${JSON.stringify(session)} is ambiguous; use an exact session file path.`);
    this.name = "AmbiguousSessionError";
  }
}

export const resolveSessionTarget = (
  agentDir: string,
  target: string,
): SessionRef | null => {
  if (target.endsWith(".jsonl") && fs.existsSync(target)) {
    return refFromFile(path.resolve(target));
  }
  const all = enumerateAllSessions(agentDir, Number.MAX_SAFE_INTEGER);
  const byId = all.filter((ref) => ref.id === target);
  if (byId.length > 1) throw new AmbiguousSessionError(target, byId.map((ref) => ref.file));
  if (byId.length === 1) return byId[0]!;
  const byStem = all.filter((ref) => path.basename(ref.file, ".jsonl") === target);
  if (byStem.length > 1) throw new AmbiguousSessionError(target, byStem.map((ref) => ref.file));
  return byStem[0] ?? null;
};

/**
 * Resolve a scope string into the concrete set of session files to search.
 *
 * - `session` (default): the current session file (from invocation context
 *   if available, else the newest session for the current cwd).
 * - `project`: all sessions stored under the current cwd's default session dir.
 * - `global`: all sessions under the agent dir, bounded by `maxSessions`.
 * - `session:<id-or-path>`: one specific session by id or file path.
 */
export const resolveScope = (input: ResolveScopeInput): SessionRef[] => {
  const scope = input.scope?.trim();
  if (scope.startsWith("session:")) {
    const target = scope.slice("session:".length).trim();
    const ref = resolveSessionTarget(input.agentDir, target);
    return ref ? [ref] : [];
  }
  if (scope === "global") {
    return enumerateAllSessions(input.agentDir, input.maxSessions);
  }
  if (scope === "project") {
    const dir = sessionDirForCwd(input.cwd, input.agentDir);
    return listJsonlInDir(dir)
      .map(refFromFile)
      .sort(compareRefsByRecency)
      .slice(0, Math.max(1, input.maxSessions));
  }
  // default: session
  if (input.sessionFile) {
    const ref = refFromFile(input.sessionFile);
    return [ref];
  }
  const dir = sessionDirForCwd(input.cwd, input.agentDir);
  const newest = newestSessionInDir(dir);
  return newest ? [newest] : [];
};
