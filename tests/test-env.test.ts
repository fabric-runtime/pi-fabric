import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const OPT_INS = new Set(["PI_FABRIC_JEV_LIVE", "PI_FABRIC_JEV_LOCALTERM", "PI_FABRIC_JEV_FABRIC_BIN", "PI_FABRIC_TEST_PI_BINARY"]);

describe("test environment isolation", () => {
  it("gives test workers no Fabric variables from the shell that started the suite", () => {
    const inherited = Object.keys(process.env).filter((name) => name.startsWith("PI_FABRIC_") && !OPT_INS.has(name));
    expect(inherited).toEqual([]);
  });

  it("clears a Fabric child's variables and keeps the documented test opt-ins", () => {
    const helper = new URL("../scripts/test-env.ts", import.meta.url).href;
    const result = spawnSync("bun", ["-e", `
      import { clearInheritedFabricEnv } from ${JSON.stringify(helper)};
      const removed = clearInheritedFabricEnv(process.env);
      const left = Object.keys(process.env).filter((name) => name.startsWith("PI_FABRIC")).sort();
      process.stdout.write(JSON.stringify({ removed: removed.sort(), left, path: process.env.PATH !== undefined }));
    `], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        PI_FABRIC_DEPTH: "1",
        PI_FABRIC_PARENT_RUN: "run-1",
        PI_FABRIC_FULL_CODE_MODE: "true",
        PI_FABRIC_KERNEL: "python",
        PI_FABRIC_JEV_LIVE: "1",
        PI_FABRIC_JEV_LOCALTERM: "1",
        PI_FABRIC_JEV_FABRIC_BIN: "/opt/jev-fabric",
        PI_FABRIC_TEST_PI_BINARY: "/opt/pi",
        PI_FABRICATED: "unrelated",
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      removed: ["PI_FABRIC_DEPTH", "PI_FABRIC_FULL_CODE_MODE", "PI_FABRIC_KERNEL", "PI_FABRIC_PARENT_RUN"],
      left: ["PI_FABRICATED", "PI_FABRIC_JEV_FABRIC_BIN", "PI_FABRIC_JEV_LIVE", "PI_FABRIC_JEV_LOCALTERM", "PI_FABRIC_TEST_PI_BINARY"],
      path: true,
    });
  });
});
