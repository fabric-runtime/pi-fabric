import { randomUUID } from "node:crypto";
import fs from "node:fs";

// Standalone counterpart of pi-fabric's writeJsonAtomic (without durability
// barriers). The published pi-recall package cannot import the parent repo.
export const writeJsonAtomic = (filePath: string, value: unknown): void => {
  const contents = JSON.stringify(value);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  // The caller already created the index directory and holds the entry lock.
  // If this open fails, the temporary belongs to someone else.
  const fd = fs.openSync(temporary, "wx", 0o600);
  let published = false;
  try {
    try {
      fs.writeFileSync(fd, contents, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(temporary, filePath);
        published = true;
        return;
      } catch (error) {
        // Match the host's bounded retries for transient rename contention.
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt === 8 || !["EPERM", "EACCES", "EEXIST", "EBUSY"].includes(code ?? "")) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * attempt);
      }
    }
  } finally {
    if (!published) fs.rmSync(temporary, { force: true });
  }
};
