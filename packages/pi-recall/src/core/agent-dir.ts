import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Local mirror of `getAgentDir` from @earendil-works/pi-coding-agent (0.84.2).
// Kept identical so Fabric resolves the same config directory without
// importing the host package during extension load.

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
export const CONFIG_DIR_NAME = ".pi";

const expandEnvDir = (envDir: string): string => {
  if (/^file:\/\//.test(envDir)) return fileURLToPath(envDir);
  if (envDir === "~") return homedir();
  if (envDir.startsWith("~/") || (process.platform === "win32" && envDir.startsWith("~\\"))) {
    return path.join(homedir(), envDir.slice(2));
  }
  return envDir;
};

export const resolveAgentDir = (): string => {
  const envDir = process.env[ENV_AGENT_DIR];
  if (envDir) return expandEnvDir(envDir);
  return path.join(homedir(), CONFIG_DIR_NAME, "agent");
};
