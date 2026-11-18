#!/usr/bin/env node
// A Pi RPC child that leaves a helper in its process group, then exits with a
// final message_end on an unterminated stdout line whose usage exceeds the
// worker's token limit. The worker sees that event only after the child exits.
import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.once("line", () => {
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  helper.unref();
  fs.writeFileSync(process.env.FAKE_PI_HELPER_PID_FILE, String(helper.pid));
  const usage = { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 };
  const message = { role: "assistant", content: [{ type: "text", text: "done" }], provider: "fake", model: "fake-model", usage, stopReason: "stop" };
  process.stdout.write(`${JSON.stringify({ type: "response", command: "prompt", success: true })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
  process.stdout.write(JSON.stringify({ type: "message_end", message }), () => process.exit(0));
});
