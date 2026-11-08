import fs from "node:fs";
import path from "node:path";
import { addCloneFirstWorktree, removeWorktree, worktreeRollbackError } from "./clone-first-worktree.js";
import { executeFile } from "./transports/process-utils.js";
import { assertWorktreePathSafe, fabricWorktreePath } from "./worktree-paths.js";

export interface WorktreeLease {
  gitRoot: string;
  path: string;
  /** Effective child cwd inside the generated worktree. */
  cwd: string;
  branch: string;
  /** Commit the worktree branch started from. */
  baseRef?: string;
}

/** Settlement snapshot of a generated worktree. */
export interface AgentWorktreeResult {
  path: string;
  branch?: string;
  baseRef?: string;
  /** Sorted repository-relative paths, at most MAX_CHANGED_FILES. */
  changedFiles: string[];
  diffstat: { files: number; insertions: number; deletions: number };
  kept: boolean;
  diffError?: string;
}

const MAX_CHANGED_FILES = 500;
const GIT_SUMMARY_TIMEOUT_MS = 15_000;
const MAX_COUNTED_BYTES = 1024 * 1024;
const SETUP_TIMEOUT_MS = 10 * 60_000;
const SETUP_OUTPUT_TAIL_CHARS = 2_000;

// Untracked text files count as insertions; binary or large files count as 0.
const countLines = (file: string): number => {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_COUNTED_BYTES) return 0;
    const content = fs.readFileSync(file);
    if (content.length === 0 || content.includes(0)) return 0;
    let lines = 0;
    for (const byte of content) if (byte === 0x0a) lines++;
    return content[content.length - 1] === 0x0a ? lines : lines + 1;
  } catch {
    return 0;
  }
};

const safeLabel = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30) || "agent";

const isInside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

const worktreePrefixParts = (prefix: string): string[] | undefined => {
  const parts = prefix.split(/[\\/]+/).filter(Boolean);
  return parts.every((part) => part !== "." && part !== "..") ? parts : undefined;
};

export class WorktreeManager {
  readonly #leases = new Map<string, WorktreeLease>();

  async create(
    id: string,
    cwd: string,
    name: string,
    preserveSourceSubdirectory = false,
    options: { root?: string; branch?: string } = {},
  ): Promise<WorktreeLease> {
    let gitRoot: string;
    let sourcePrefix = "";
    try {
      const [root, prefix] = await Promise.all([
        executeFile("git", ["rev-parse", "--show-toplevel"], { cwd }),
        preserveSourceSubdirectory
          ? executeFile("git", ["rev-parse", "--show-prefix"], { cwd })
          : Promise.resolve({ stdout: "" }),
      ]);
      const output = root.stdout.trim();
      if (!output) throw new Error("Git did not return a worktree root");
      gitRoot = fs.realpathSync(output);
      sourcePrefix = prefix.stdout.trim();
    } catch (error) {
      const failure = error as Error & { stderr?: string };
      const detail = (failure.stderr?.trim() || failure.message || String(error)).split("\n", 1)[0]!.slice(0, 500);
      throw new Error(`Worktree isolation requires a Git repository: ${detail}`, { cause: error });
    }
    const template = options.branch ?? "pi-fabric/{name}-{id8}";
    const values: Record<string, string> = { name: safeLabel(name), id, id8: id.slice(0, 8) };
    const branch = template.replace(/\{([^{}]+)\}/g, (token, key: string) => Object.hasOwn(values, key) ? values[key]! : token);
    if (/[{}]/.test(branch) || !branch || branch.startsWith("-")) {
      throw new Error("Invalid agents.worktree.branch template (use {name}, {id}, {id8})");
    }
    await executeFile("git", ["check-ref-format", "--branch", branch], { cwd: gitRoot });
    const worktreePath = fabricWorktreePath(gitRoot, id, options.root);
    assertWorktreePathSafe(gitRoot, worktreePath);
    await addCloneFirstWorktree({
      gitRoot,
      dest: worktreePath,
      ...(options.root !== undefined ? { worktreeRoot: options.root } : {}),
      branch: { flag: "-b", name: branch },
      startPoint: "HEAD",
    });
    let canonicalWorktreePath: string;
    try {
      canonicalWorktreePath = fs.realpathSync(worktreePath);
    } catch (error) {
      try { await removeWorktree(gitRoot, worktreePath, branch); }
      catch (cleanupError) { throw worktreeRollbackError(gitRoot, worktreePath, branch, error, cleanupError); }
      throw error;
    }
    const baseRef = await executeFile("git", ["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: GIT_SUMMARY_TIMEOUT_MS })
      .then((result) => result.stdout.trim() || undefined, () => undefined);
    const prefix = preserveSourceSubdirectory ? worktreePrefixParts(sourcePrefix) : undefined;
    let effectiveCwd = canonicalWorktreePath;
    if (prefix && prefix.length > 0) {
      // Git reports its own worktree-relative prefix with `/` on every platform.
      // This avoids comparing independently canonicalized Windows paths, whose
      // volume/casing representation can differ even for the same directory.
      const candidate = path.resolve(canonicalWorktreePath, ...prefix);
      try {
        const canonicalCandidate = fs.realpathSync(candidate);
        if (fs.statSync(canonicalCandidate).isDirectory() && isInside(canonicalWorktreePath, canonicalCandidate)) {
          effectiveCwd = canonicalCandidate;
        }
      } catch {
        // The selected subdirectory may be untracked or absent from HEAD;
        // use the valid worktree root in that case.
      }
    }
    const lease = { gitRoot, path: worktreePath, cwd: effectiveCwd, branch, ...(baseRef ? { baseRef } : {}) };
    this.#leases.set(id, lease);
    return lease;
  }

  get(id: string): WorktreeLease | undefined {
    return this.#leases.get(id);
  }

  /** Run a setup command in the worktree root; failure throws with the output tail. */
  async setup(id: string, command: string): Promise<void> {
    const lease = this.#leases.get(id);
    if (!lease) throw new Error(`Unknown Fabric worktree: ${id}`);
    const [file, args] = process.platform === "win32"
      ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command]]
      : ["/bin/sh", ["-c", command]];
    try {
      await executeFile(file, args, { cwd: lease.path, timeoutMs: SETUP_TIMEOUT_MS });
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string; code?: unknown; killed?: boolean };
      const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim();
      const tail = output.length > SETUP_OUTPUT_TAIL_CHARS ? `…${output.slice(-SETUP_OUTPUT_TAIL_CHARS)}` : output;
      const status = failure.killed ? "timed out" : `exited with ${String(failure.code ?? "an error")}`;
      throw new Error(`Worktree setup command ${status}${tail ? `:\n${tail}` : ""}`);
    }
  }

  /** Bounded diff against the base commit, including untracked files; git failures become diffError. */
  async summarize(id: string): Promise<AgentWorktreeResult | undefined> {
    const lease = this.#leases.get(id);
    if (!lease) return undefined;
    const result: AgentWorktreeResult = {
      path: lease.path,
      branch: lease.branch,
      ...(lease.baseRef ? { baseRef: lease.baseRef } : {}),
      changedFiles: [],
      diffstat: { files: 0, insertions: 0, deletions: 0 },
      kept: fs.existsSync(lease.path),
    };
    if (!result.kept) return result;
    try {
      const options = { cwd: lease.path, timeoutMs: GIT_SUMMARY_TIMEOUT_MS };
      const [tracked, untracked] = await Promise.all([
        executeFile("git", ["-c", "core.quotepath=off", "diff", "--numstat", "--no-renames", lease.baseRef ?? "HEAD", "--"], options),
        executeFile("git", ["-c", "core.quotepath=off", "ls-files", "--others", "--exclude-standard"], options),
      ]);
      const files = new Set<string>();
      for (const line of tracked.stdout.split("\n")) {
        const match = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line);
        if (!match) continue;
        files.add(match[3]!);
        if (match[1] !== "-") result.diffstat.insertions += Number(match[1]);
        if (match[2] !== "-") result.diffstat.deletions += Number(match[2]);
      }
      for (const file of untracked.stdout.split("\n")) {
        if (!file || files.has(file)) continue;
        files.add(file);
        if (files.size <= MAX_CHANGED_FILES) result.diffstat.insertions += countLines(path.join(lease.path, file));
      }
      result.diffstat.files = files.size;
      result.changedFiles = [...files].sort().slice(0, MAX_CHANGED_FILES);
    } catch (error) {
      result.diffError = (error instanceof Error ? error.message : String(error)).split("\n", 1)[0]!.slice(0, 500);
    }
    return result;
  }

  async cleanup(id: string, deleteBranch = false): Promise<boolean> {
    const lease = this.#leases.get(id);
    if (!lease) return false;
    assertWorktreePathSafe(lease.gitRoot, lease.path);
    if (deleteBranch && fs.existsSync(path.join(lease.path, ".git"))) {
      const actualBranch = (await executeFile("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: lease.path, timeoutMs: GIT_SUMMARY_TIMEOUT_MS })).stdout.trim();
      if (actualBranch !== lease.branch) throw new Error("Refusing cleanup: worktree branch ownership changed");
    }
    await removeWorktree(lease.gitRoot, lease.path, deleteBranch ? lease.branch : undefined);
    if (this.#leases.get(id) === lease) this.#leases.delete(id);
    return true;
  }
}
