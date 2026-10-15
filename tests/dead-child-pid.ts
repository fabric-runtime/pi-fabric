import { spawnSync } from "node:child_process";

/**
 * A pid whose process has exited and been reaped, so `kill(pid, 0)` answers
 * ESRCH. The OS may hand a freed pid to another process at once, so the pid is
 * checked after the child is reaped and a fresh child is tried when it is in
 * use again.
 */
export const deadChildPid = (): number => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore", timeout: 10_000 });
    if (child.status !== 0 || !child.pid) {
      throw new Error(`Test child did not exit cleanly: ${String(child.error ?? child.status)}`);
    }
    try {
      process.kill(child.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return child.pid;
    }
  }
  throw new Error("Every test child pid was reused before it could be used");
};
