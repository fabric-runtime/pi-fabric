import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("runs the compiled supervisor in isolation and reproduces unexpanded-command fall-through", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/smoke-supervisor.mjs"], {
    cwd: process.cwd(), timeout: 100_000, maxBuffer: 2_000_000,
  });
  const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
  expect(result).toMatchObject({ compiledExtension: true, realWorkers: true, model: "scripted-localhost" });
  expect(result.scenarios).toEqual([
    ...["expanded", "expanded-default-runner"].map(scenario => expect.objectContaining({
      scenario, expanded: true, wokeMain: true, toolErrors: 0,
    })),
    ...["expansion-disabled", "missing-skill", "wrong-name"].map(scenario => ({
      scenario, expanded: false, mainRequests: 1, actorRequests: 0, wokeMain: false, toolErrors: 0,
    })),
  ]);
}, 110_000);
