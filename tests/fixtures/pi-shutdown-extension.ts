import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// A real RPC UI dialog, without a provider request or credentials.
export default function (pi: ExtensionAPI) {
  const root = process.env.FABRIC_SHUTDOWN_ROOT!;
  pi.registerProvider("shutdown", {
    baseUrl: "http://127.0.0.1:1", apiKey: "synthetic", api: "shutdown-test",
    models: [{ id: "probe", name: "Probe", reasoning: false, input: ["text"],
      contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple() { throw new Error("Shutdown test must not request a model"); },
  });
  pi.on("input", async (_event, ctx) => {
    if (fs.existsSync(path.join(root, "helper"))) {
      // A helper in Pi's process group with ignored stdio: Pi's exit does not end it.
      const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      helper.unref();
      fs.writeFileSync(path.join(root, "helper-pid"), String(helper.pid));
    }
    fs.writeFileSync(path.join(root, "ready"), String(process.pid));
    await ctx.ui.confirm("Synthetic pending question", "Wait for stop");
    return { action: "handled" };
  });
  pi.on("session_shutdown", async () => {
    fs.writeFileSync(path.join(root, "shutdown-started"), "started");
    if (fs.existsSync(path.join(root, "hang"))) {
      // Keep the process alive even after EOF so only the worker deadline wins.
      setInterval(() => {}, 1_000);
      await new Promise(() => {});
    }
    // The parent releases the hook only after observing shutdown-started.
    // A filesystem watcher keeps the child alive without a timing-based sleep.
    await new Promise<void>(resolve => {
      const release = path.join(root, "shutdown-release");
      const check = () => {
        if (!fs.existsSync(release)) return;
        watcher.close();
        resolve();
      };
      const watcher = fs.watch(root, check);
      check();
    });
    fs.writeFileSync(path.join(root, "shutdown-finished"), "finished");
  });
}
