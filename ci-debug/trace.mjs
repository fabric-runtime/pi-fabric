// Preload via NODE_OPTIONS=--import=<file URL>; appends lifecycle traces to $TRACE_FILE.
import fs from "node:fs";
const file = process.env.TRACE_FILE;
if (file && process.argv.some(a => /cli\.js$/.test(a))) {
  const t0 = Date.now();
  const log = (m) => { try { fs.appendFileSync(file, `[pid ${process.pid} +${Date.now() - t0}ms] ${m}\n`); } catch {} };
  log(`start argv=${process.argv.slice(2).join(" ")}`);
  const exit = process.exit.bind(process);
  process.exit = (code) => { log(`process.exit(${code}) resources=${JSON.stringify(process.getActiveResourcesInfo())}`); return exit(code); };
  process.on("exit", (c) => log(`exit event ${c}`));
  let ended = false;
  process.stdin.on("end", () => {
    if (ended) return; ended = true;
    log(`stdin end resources=${JSON.stringify(process.getActiveResourcesInfo())}`);
    const timer = setInterval(() => log(`still alive resources=${JSON.stringify(process.getActiveResourcesInfo())}\n${new Error("stack").stack}`), 1000);
    timer.unref();
  });
  const origOn = process.stdin.on;
  setTimeout(() => {}, 0);
}
