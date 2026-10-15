// Stands in for the resident launcher: claims ownership like a real host, then
// exits shortly after, as a host that keeps crashing would. Each launch is
// appended to `launches.log` beside the config.
import fs from "node:fs";
import path from "node:path";

const index = process.argv.indexOf("--config");
const configPath = process.argv[index + 1];
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const { hostId } = JSON.parse(fs.readFileSync(path.join(config.residencyRoot, "fake-host.json"), "utf8"));
fs.appendFileSync(path.join(config.residencyRoot, "launches.log"), `${process.pid}\n`);
const now = Date.now();
fs.writeFileSync(path.join(config.residencyRoot, "owner.json"), JSON.stringify({
  format: config.format, hostId, pid: process.pid, token: `fake-${process.pid}`, startedAt: now, readyAt: now,
}));
setTimeout(() => process.exit(0), 300);
