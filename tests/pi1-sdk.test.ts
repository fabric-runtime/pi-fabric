import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("loads the compiled extension in real Pi 1.4 SDK sessions with native codemode/MCP and captured proxies", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/smoke-pi1.mjs"], {
    cwd: process.cwd(), timeout: 90_000, maxBuffer: 2_000_000,
  });
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toMatchObject({
    version: "1.5.0", scenarios: 7, exclusive: true, proxy: true, reload: true, cli: true,
  });
}, 100_000);
