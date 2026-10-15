// A hosted runner whose run can only settle in a resident host that re-attaches
// it: `start` never finishes, `attach` finishes at once. Imported by the test
// process and, through `residentModule`, by every resident host.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerAgentRunner } from "../../dist/runners.js";

export const RESIDENT_HOSTED_RUNNER_ID = "test-resident-hosted";
export const HOSTED_EVENTS_FILE = "hosted-events.log";

const record = (locator, event) =>
  fs.appendFileSync(path.join(locator.runDirectory, HOSTED_EVENTS_FILE), `${event} ${process.pid}\n`);

export const unregister = registerAgentRunner({
  kind: "hosted",
  id: RESIDENT_HOSTED_RUNNER_ID,
  label: "Resident hosted test runner",
  residentModule: fileURLToPath(import.meta.url),
  capabilities: {
    recursiveFabric: false, steer: false, followUp: false, persistentSessions: false,
    kernels: false, handoff: false, modelDiscovery: false, imageInput: false,
    compaction: false, questions: false, sleep: false, writePolicy: false,
  },
  prepare: (context) => ({ runDirectory: context.runDirectory }),
  start: (locator) => record(locator, "start"),
  attach: (locator, _context, reporter) => {
    record(locator, "attach");
    reporter.finish({ status: "completed", output: "finished after re-attach" });
  },
  liveness: () => "running",
  stop: () => ({ confirmed: true }),
});
