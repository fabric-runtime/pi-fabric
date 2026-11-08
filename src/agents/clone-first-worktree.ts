import fs from "node:fs";
import path from "node:path";
import { cloneTree, CowUnavailableError, CLONE_SKIP_PREFIXES } from "./cow-clone.js";
import { executeFile } from "./transports/process-utils.js";
import { assertWorktreePathSafe, ensureWorktreeExclude, isFabricWorktreePath } from "./worktree-paths.js";

export interface CloneFirstWorktreeAdd {
  gitRoot: string;
  dest: string;
  /** Managed root relative to gitRoot; also excluded from the clone. */
  worktreeRoot?: string;
  branch?: { flag: "-b" | "-B"; name: string };
  detach?: boolean;
  quiet?: boolean;
  startPoint?: string;
}

export interface CloneFirstWorktreeResult {
  cloned: boolean;
  message: string;
}

export const worktreeRollbackError = (gitRoot: string, worktree: string, branch: string | undefined, error: unknown, cleanupError: unknown): Error => {
  const detail = (value: unknown): string => value instanceof Error ? `${value.message}${(value as Error & { stderr?: string }).stderr ? `: ${(value as Error & { stderr?: string }).stderr}` : ""}` : String(value);
  return new AggregateError([error, cleanupError], `Worktree operation failed: ${detail(error)}; rollback failed: ${detail(cleanupError)}. Manual cleanup required in repository ${JSON.stringify(gitRoot)}, worktree ${JSON.stringify(worktree)}${branch ? `, branch ${JSON.stringify(branch)}` : ""}.`);
};

export const addCloneFirstWorktree = async (
  options: CloneFirstWorktreeAdd,
): Promise<CloneFirstWorktreeResult> => {
  const dest = options.dest;
  const managed = isFabricWorktreePath(dest, path.basename(dest), options.gitRoot, options.worktreeRoot);
  if (managed) {
    assertWorktreePathSafe(options.gitRoot, dest);
    await ensureWorktreeExclude(options.gitRoot, options.worktreeRoot);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const args = ["worktree", "add", "--no-checkout"];
  if (options.quiet) args.push("-q");
  if (options.detach) args.push("--detach");
  if (options.branch) args.push(options.branch.flag, options.branch.name);
  args.push(dest);
  if (options.startPoint) args.push(options.startPoint);
  const added = await executeFile("git", args, { cwd: options.gitRoot, timeoutMs: 60_000 });
  try {
    let cloned = false;
    try {
      await cloneTree(options.gitRoot, dest, managed
        ? [...CLONE_SKIP_PREFIXES, path.relative(options.gitRoot, path.dirname(dest)).split(path.sep).join("/")]
        : CLONE_SKIP_PREFIXES);
      cloned = true;
    } catch (error) {
      // Only a filesystem without copy-on-write falls back to a plain checkout.
      if (!(error instanceof CowUnavailableError)) throw error;
    }
    await executeFile("git", ["reset", "--hard", "HEAD"], { cwd: dest, timeoutMs: 60_000 });
    await executeFile("git", ["clean", "-fd"], { cwd: dest, timeoutMs: 60_000 });
    return { cloned, message: added.stdout.trim() };
  } catch (error) {
    // `-B` may have reset a branch that existed before; only `-b` created it here.
    const branch = options.branch?.flag === "-b" ? options.branch.name : undefined;
    try { await removeWorktree(options.gitRoot, dest, branch); }
    catch (cleanupError) { throw worktreeRollbackError(options.gitRoot, dest, branch, error, cleanupError); }
    throw error;
  }
};

/**
 * Remove a worktree, then its branch when one is named. The branch is deleted
 * even when the worktree removal fails; the first failure is rethrown.
 */
export const removeWorktree = async (gitRoot: string, worktree: string, branch?: string): Promise<void> => {
  let failure: unknown;
  try {
    await executeFile("git", ["worktree", "remove", "--force", worktree], { cwd: gitRoot, timeoutMs: 60_000 });
  } catch (error) {
    if (fs.existsSync(worktree)) failure = error;
    else await executeFile("git", ["worktree", "prune"], { cwd: gitRoot, timeoutMs: 30_000 }).catch(() => undefined);
  }
  if (branch) {
    try {
      // A previous cleanup attempt may already have deleted the branch.
      const existing = await executeFile("git", ["branch", "--list", branch], { cwd: gitRoot, timeoutMs: 30_000 });
      if (existing.stdout.trim()) {
        await executeFile("git", ["branch", "-D", branch], { cwd: gitRoot, timeoutMs: 30_000 });
      }
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
};
