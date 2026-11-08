import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeFabricConfig } from "../src/config.js";
import { WorktreeManager } from "../src/agents/worktree-manager.js";
import { fabricWorktreePath, isFabricWorktreePath, normalizeWorktreeRoot } from "../src/agents/worktree-paths.js";

const roots: string[] = [];
const id = "aaaaaaaa1234567890bbbbbbbbbbbbbbbb";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const repository = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabric-worktree-config-")));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(root, "file.txt"), "initial\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("configured worktrees", () => {
  it("preserves root, branch and setup configuration together", () => {
    expect(normalizeFabricConfig({ agents: { worktree: { root: ".worktrees", branch: "issue/{name}-{id}", setup: " bun install " } } }).agents.worktree)
      .toEqual({ root: ".worktrees", branch: "issue/{name}-{id}", setup: "bun install" });
    expect(normalizeFabricConfig({}).agents.worktree).toBeUndefined();
  });

  it.each(["", ".", "..", "../outside", "a/../b", "a/./b", "/tmp/worktrees", "C:\\worktrees", "C:relative", "\\\\server\\share", ".git/worktrees", "a/.GiT/b", ".git./trees", ".git /trees", "a:b", "a\nb", "a//b"])("rejects unsafe root %j", (root) => {
    expect(() => normalizeWorktreeRoot(root)).toThrow(/worktree.root/);
  });

  it("keeps the default branch and placement unchanged", async () => {
    const root = repository();
    const manager = new WorktreeManager();
    const lease = await manager.create(id, root, "Review This!");
    expect(lease.path).toBe(path.join(root, ".pi", "fabric", "worktrees", id));
    expect(lease.branch).toBe(`pi-fabric/review-this-${id.slice(0, 8)}`);
    await manager.cleanup(id, true);
  });

  it("matches only the configured repository, root and exact id", () => {
    const root = path.resolve("repository");
    const target = fabricWorktreePath(root, id, ".worktrees");
    expect(isFabricWorktreePath(target, id, root, ".worktrees")).toBe(true);
    expect(isFabricWorktreePath(target, id, path.resolve("other"), ".worktrees")).toBe(false);
    expect(isFabricWorktreePath(target, id, root)).toBe(false);
    expect(isFabricWorktreePath(target + "-other", id, root, ".worktrees")).toBe(false);
  });

  it("creates, summarizes and cleans a custom root/branch without copying sibling worktrees", async () => {
    const root = repository();
    const options = { root: ".worktrees", branch: "issue/{name}-{id}-{id8}" };
    const sibling = path.join(root, options.root, "sibling");
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, "marker"), "do not copy\n");
    const manager = new WorktreeManager();
    const lease = await manager.create(id, root, "Fix A Thing!", false, options);
    expect(lease.path).toBe(path.join(root, ".worktrees", id));
    expect(lease.branch).toBe(`issue/fix-a-thing-${id}-${id.slice(0, 8)}`);
    expect(fs.existsSync(path.join(lease.path, ".worktrees"))).toBe(false);
    expect(git(root, "status", "--porcelain")).toBe("");
    fs.writeFileSync(path.join(lease.path, "file.txt"), "changed\n");
    expect(await manager.summarize(id)).toMatchObject({ path: lease.path, branch: lease.branch, changedFiles: ["file.txt"], kept: true });
    options.root = "changed-after-creation";
    options.branch = "changed";
    expect(await manager.cleanup(id, true)).toBe(true);
    expect(fs.existsSync(lease.path)).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
    expect(git(root, "branch", "--list", lease.branch)).toBe("");
  });

  it("escapes and anchors custom roots in info/exclude without duplicate entries", async () => {
    const root = repository();
    const manager = new WorktreeManager();
    const options = { root: "trees [local]", branch: "custom-{id8}" };
    for (const value of [id, "bbbbbbbb1234567890aaaaaaaaaaaaaaaa"]) {
      await manager.create(value, root, "test", false, options);
      expect(git(root, "status", "--porcelain")).toBe("");
      await manager.cleanup(value, true);
    }
    const exclude = fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((line) => line.startsWith("/trees"))).toHaveLength(1);
    fs.mkdirSync(path.join(root, "trees l"));
    fs.writeFileSync(path.join(root, "trees l", "unrelated"), "visible");
    expect(git(root, "status", "--porcelain")).toContain("trees l/");
  });

  it.each(["bad/{unknown}", "bad..branch", "-branch", "", "refs/heads/{name}:bad"])("rejects invalid branch %j without creating worktrees", async (branch) => {
    const root = repository();
    await expect(new WorktreeManager().create(id, root, "test", false, { root: ".worktrees", branch })).rejects.toThrow();
    expect(fs.existsSync(path.join(root, ".worktrees"))).toBe(false);
  });

  it("refuses symlink ancestors and leaves their target untouched", async () => {
    const root = repository();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-outside-"));
    roots.push(outside);
    fs.symlinkSync(outside, path.join(root, ".worktrees"), process.platform === "win32" ? "junction" : "dir");
    await expect(new WorktreeManager().create(id, root, "test", false, { root: ".worktrees" })).rejects.toThrow(/symlink/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("does not reset an existing branch or delete a changed worktree branch", async () => {
    const root = repository();
    git(root, "branch", "existing");
    const manager = new WorktreeManager();
    await expect(manager.create(id, root, "test", false, { branch: "existing" })).rejects.toThrow();
    const lease = await manager.create(id, root, "test", false, { root: ".worktrees", branch: "mine-{id8}" });
    git(lease.path, "checkout", "-qb", "someone-else");
    await expect(manager.cleanup(id, true)).rejects.toThrow(/ownership changed/);
    expect(fs.existsSync(lease.path)).toBe(true);
    expect(git(root, "branch", "--list", lease.branch)).toContain(lease.branch);
  });
});
