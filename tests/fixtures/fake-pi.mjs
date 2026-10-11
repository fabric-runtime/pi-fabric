#!/usr/bin/env node
import fs from "node:fs";
// A stub `pi` binary for the real-worker e2e. The Fabric worker spawns this as
// the child agent and talks to it over stdin/stdout JSON lines. Behavior is
// selected with the FAKE_PI_BEHAVIOR env var so the e2e can drive the real
// worker.ts + AgentManager.#monitor across child outcomes.
const behavior = process.env.FAKE_PI_BEHAVIOR || "success";
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");

// Drain the prompt the worker writes so its stdin write does not block.
process.stdin.resume();
process.stdin.on("data", () => {});

const capturePrompt = () => {
  process.stdin.removeAllListeners("data");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const frame = JSON.parse(buffer.slice(0, newline).replace(/\r$/, ""));
    if (process.env.FAKE_PI_PROMPT_LOG) {
      fs.writeFileSync(process.env.FAKE_PI_PROMPT_LOG, JSON.stringify(frame));
    }
    emit({ type: "message_end", message: { role: "assistant", content: "captured prompt" } });
    emit({ type: "agent_settled" });
    process.exit(0);
  });
};

const runCompactionLifecycle = (fail) => {
  process.stdin.removeAllListeners("data");
  let buffer = "";
  let settled = false;
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      let raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (raw.endsWith("\r")) raw = raw.slice(0, -1);
      if (!raw) continue;
      const frame = JSON.parse(raw);
      if (frame.type === "prompt") {
        emit({ type: "agent_start" });
        emit({ type: "message_end", message: { role: "assistant", content: "ready" } });
        setTimeout(() => {
          settled = true;
          emit({ type: "agent_settled" });
        }, 500);
      } else if (frame.type === "compact") {
        emit({
          type: "fake_compact_received",
          requestId: frame.id,
          customInstructions: frame.customInstructions,
          afterSettled: settled,
        });
        emit({ type: "compaction_start", reason: "manual" });
        emit({
          type: "compaction_end",
          reason: "manual",
          result: fail ? null : { summary: "child compacted", firstKeptEntryId: "entry-1", tokensBefore: 100 },
          aborted: false,
          willRetry: false,
          ...(fail ? { errorMessage: "child summary failed" } : {}),
        });
        emit({ type: "response", id: frame.id, command: "compact", success: true });
      }
    }
  });
};

const terminated = () => {
  emit({ type: "agent_start" });
  emit({ type: "message_end", message: {
    role: "assistant", content: [], stopReason: "error", errorMessage: "Error: Terminated",
  } });
};

switch (behavior) {
  case "terminated-hang":
  case "retry-hang": {
    terminated();
    if (behavior === "retry-hang") {
      emit({ type: "agent_end", willRetry: true });
      emit({ type: "agent_settled" });
    }
    // Ignore both EOF and SIGTERM so the real worker must escalate to SIGKILL.
    process.on("SIGTERM", () => {});
    emit({ type: "fake_child_pid", pid: process.pid });
    setInterval(() => {
      emit({ type: "queue_update", steering: [], followUp: [] });
      if (behavior === "retry-hang") emit({ type: "auto_retry_start", errorMessage: "Error: Terminated" });
    }, 1_000);
    break;
  }
  case "retry-exhausted":
  case "retry-exhausted-stubborn":
    terminated();
    emit({ type: "agent_end", willRetry: true });
    emit({ type: "auto_retry_start", errorMessage: "Error: Terminated" });
    emit({ type: "auto_retry_end", success: false, finalError: "Error: Terminated (retries exhausted)" });
    emit({ type: "agent_settled" });
    if (behavior === "retry-exhausted-stubborn") {
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 60_000);
    }
    break;
  case "terminated-restart-exit":
    terminated();
    emit({ type: "agent_start" });
    process.exit(0);
    break;
  case "terminated-recover":
    terminated();
    emit({ type: "agent_end", willRetry: true });
    emit({ type: "agent_settled" });
    emit({ type: "auto_retry_start", errorMessage: "Error: Terminated" });
    setTimeout(() => {
      emit({ type: "agent_start" });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "recovered" } });
      emit({ type: "message_end", message: { role: "assistant", content: "recovered", stopReason: "stop" } });
      emit({ type: "agent_end", willRetry: false });
      emit({ type: "auto_retry_end", success: true });
      emit({ type: "agent_settled" });
    }, 25);
    break;
  case "capture-prompt":
    capturePrompt();
    break;
  case "compact-success":
    runCompactionLifecycle(false);
    break;
  case "compact-failure":
    runCompactionLifecycle(true);
    break;
  case "exit-clean":
    process.exit(0);
  case "exit-error":
    process.exit(1);
  case "kill-worker":
    // Simulate the worker being hard-killed mid-run (OOM / external kill): it dies
    // before it can write a terminal status.
    try {
      process.kill(process.ppid, "SIGKILL");
    } catch {
      /* worker already gone */
    }
    process.exit(0);
  case "reject":
    emit({ type: "response", command: "prompt", success: false, error: "provider rejected the prompt" });
    process.exit(1);
  case "hang":
    // Never exit and never settle; the worker timeout should fire.
    setInterval(() => {}, 60_000);
    break;
  case "split-utf8": {
    const line = Buffer.from(
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: "界面 🚀" } }) + "\n",
    );
    const split = line.indexOf(Buffer.from("界")) + 1;
    process.stdout.write(line.subarray(0, split));
    setTimeout(() => {
      process.stdout.write(line.subarray(split));
      emit({ type: "agent_settled" });
      process.exit(0);
    }, 10);
    break;
  }
  case "large-lifecycle":
  case "large-lifecycle-retry": {
    // Each message is below the worker cap; aggregate history is well above it.
    // Include both images and ordinary text so this cannot pass via base64 regex
    // redaction. Write fragmented records with backpressure, including metadata
    // after the large field and a following event in the same write.
    const retry = behavior === "large-lifecycle-retry";
    const history = Array.from({ length: 8 }, (_, index) => ({
      role: "toolResult",
      content: [
        { type: "image", data: "a".repeat(512 * 1024), mimeType: "image/png" },
        { type: "text", text: `image ${index}: 界 🚀 \\ \" { }\n` + "ordinary text ".repeat(8192) },
      ],
    }));
    const write = (text) => new Promise((resolve, reject) => {
      process.stdout.write(text, (error) => error ? reject(error) : resolve());
    });
    const fragmented = async (event, following = "") => {
      const line = JSON.stringify(event) + "\r\n" + following;
      for (let i = 0; i < line.length; i += 8191) await write(line.slice(i, i + 8191));
    };
    emit({ type: "agent_start" });
    emit({ type: "tool_execution_start", toolName: "fabric_exec", toolCallId: "image-1" });
    emit({ type: "tool_execution_end", toolName: "fabric_exec", toolCallId: "image-1", result: { content: "saved screenshot" }, isError: false });
    const message = { role: "assistant", content: "progress preserved", usage: { input: 100, output: 50 } };
    emit({ type: "message_end", message });
    await fragmented({ type: "turn_end", message, toolResults: history, turnIndex: 1 });
    await fragmented({ type: "agent_end", messages: history, willRetry: retry }, '{"type":"agent_settled"}\n');
    if (retry) {
      // If willRetry after history was lost, the premature settled event closes
      // stdin and ends the run before the authoritative final response arrives.
      let ended = false;
      process.stdin.on("end", () => { ended = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!ended) {
        emit({ type: "agent_start" });
        emit({ type: "message_end", message: { role: "assistant", content: "retry completed", usage: { input: 200, output: 75 } } });
        await fragmented({ messages: history, type: "agent_end", willRetry: false }, '{"type":"agent_settled"}\n');
      }
    }
    process.stdin.pause();
    break;
  }
  case "oversized-event": {
    const event = {
      type: "message_end",
      message: { role: "assistant", content: "x".repeat(4 * 1024 * 1024 + 1_024) },
    };
    process.stdout.write(`${JSON.stringify(event)}\n`, () => process.exit(0));
    break;
  }
  case "fabric-session-env":
    emit({
      type: "message_end",
      message: { role: "assistant", content: process.env.PI_FABRIC_SESSION_ID || "missing" },
    });
    emit({ type: "agent_settled" });
    process.exit(0);
    break;
  case "child-contract":
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: JSON.stringify({
          lineage: process.env.PI_FABRIC_LINEAGE ?? null,
          writePolicy: process.env.PI_FABRIC_WRITE_POLICY ?? null,
          scope: process.env.PI_FABRIC_SCOPE ?? null,
          scopeFile: process.env.PI_FABRIC_SCOPE_FILE ?? null,
          extensionModel: process.env.PI_FABRIC_EXTENSION_MODEL ?? null,
          args: process.argv.slice(2),
        }),
      },
    });
    emit({ type: "agent_settled" });
    process.exit(0);
    break;
  case "stderr-framing":
    process.stderr.write(
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: "spoofed" } }),
    );
    emit({ type: "message_end", message: { role: "assistant", content: "trusted" } });
    emit({ type: "agent_settled" });
    process.exit(0);
    break;
  case "usage-flow":
    emit({ type: "agent_start" });
    emit({ type: "message_end", message: { role: "assistant", content: "first", usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.01 } } });
    setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: "second", usage: { input: 200, output: 100, cacheRead: 20, cacheWrite: 10, cost: 0.02 } } });
      emit({ type: "agent_settled" });
      process.exit(0);
    }, 50);
    break;
  case "shim-env-inheritance": {
    // Reports only presence booleans for the sentinel names listed in
    // FAKE_PI_SENTINEL_VARS — never values — so the e2e can assert that env
    // seeded in the owner process (what the LocalTerm shim injects into the
    // parent pi) reaches the child pi the worker spawns.
    const names = (process.env.FAKE_PI_SENTINEL_VARS || "").split(",").filter(Boolean);
    const report = names
      .map((name) => `${name}=${process.env[name] ? "present" : "absent"}`)
      .join(" ");
    emit({ type: "message_end", message: { role: "assistant", content: report } });
    emit({ type: "agent_settled" });
    process.exit(0);
  }
  case "success":
  default:
    emit({ type: "message_end", message: { role: "assistant", content: "hi" } });
    emit({ type: "agent_settled" });
    process.exit(0);
}
