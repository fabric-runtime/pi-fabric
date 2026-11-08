import fs from "node:fs";
import path from "node:path";
import { executeFile } from "./transports/process-utils.js";

export const DEFAULT_WORKTREE_ROOT = ".pi/fabric/worktrees";
export const FABRIC_WORKTREE_EXCLUDE = `${DEFAULT_WORKTREE_ROOT}/`;

/** A nonempty repository-relative directory, never Git's administrative tree. */
export const normalizeWorktreeRoot = (root = DEFAULT_WORKTREE_ROOT): string => {
  const parts = root.split(/[\\/]/);
  if (!root.trim() || path.posix.isAbsolute(root) || path.win32.isAbsolute(root) ||
      /[:\x00-\x1f\x7f]/.test(root) ||
      parts.some((part) => {
        const portable = part.replace(/[. ]+$/g, "").toLowerCase();
        return !portable || /[. ]$/.test(part) || part === "." || part === ".." || portable === ".git";
      })) {
    throw new Error("agents.worktree.root must be a nonempty relative directory without traversal or .git components");
  }
  return parts.join("/");
};

export const fabricWorktreePath = (gitRoot: string, id: string, root?: string): string => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid worktree agent id");
  return path.resolve(gitRoot, normalizeWorktreeRoot(root), id);
};

/** Reject existing symlink ancestors, including the leaf, before creating/removing a managed tree. */
export const assertWorktreePathSafe = (gitRoot: string, worktree: string): void => {
  const relative = path.relative(gitRoot, worktree);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Worktree path must be inside its Git root");
  }
  let current = gitRoot;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Worktree path contains a symlink: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
};

export const isFabricWorktreePath = (worktree: string, id: string, gitRoot?: string, root?: string): boolean => {
  try {
    if (gitRoot) return path.resolve(worktree) === fabricWorktreePath(gitRoot, id, root);
    const suffix = `/${normalizeWorktreeRoot(root)}/${id}`;
    return worktree.replaceAll("\\", "/").endsWith(suffix);
  } catch { return false; }
};

export const ensureWorktreeExclude = async (gitRoot: string, root?: string): Promise<void> => {
  const normalized = normalizeWorktreeRoot(root);
  // Anchor custom paths at the repository root and quote gitignore metacharacters.
  const entry = normalized === DEFAULT_WORKTREE_ROOT ? FABRIC_WORKTREE_EXCLUDE
    : `/${normalized.replace(/[\\*?\[\]#! ]/g, "\\$&")}/`;
  const located = await executeFile("git", ["rev-parse", "--git-path", "info/exclude"], {
    cwd: gitRoot, timeoutMs: 10_000,
  });
  const excludePath = path.resolve(gitRoot, located.stdout.trim());
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  let current = "";
  try { current = fs.readFileSync(excludePath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (current.split(/\r?\n/).includes(entry)) return;
  const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(excludePath, `${prefix}${entry}\n`);
};
