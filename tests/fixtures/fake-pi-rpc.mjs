#!/usr/bin/env node

import readline from "node:readline";

const send = (event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const usage = { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 };

const successMessage = (text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "fake",
  model: "fake-model",
  usage,
  stopReason: "stop",
});

const providerFailure = () => ({
  role: "assistant",
  content: [],
  provider: "openai-codex",
  model: "gpt-test",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  stopReason: "error",
  errorMessage: "fetch failed",
  diagnostics: [
    {
      type: "provider_transport_failure",
      error: { name: "Error", message: "WebSocket error" },
      details: { configuredTransport: "auto", fallbackTransport: "sse" },
    },
  ],
});

const finishAttempt = (message, willRetry) => {
  send({ type: "message_end", message });
  send({ type: "turn_end", message, toolResults: [] });
  send({ type: "agent_end", messages: [message], willRetry });
  send({ type: "agent_settled" });
};

let started = false;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (started || !line.trim()) return;
  started = true;
  const command = JSON.parse(line);
  const task = typeof command.message === "string" ? command.message : "";

  send({ type: "response", command: "prompt", success: true });
  send({ type: "agent_start" });

  if (task.includes("RETRY_THEN_SUCCEED")) {
    finishAttempt(providerFailure(), true);
    setTimeout(() => {
      send({ type: "agent_start" });
      finishAttempt(successMessage("retry recovered"), false);
    }, 25);
    return;
  }

  // Each turn ends on a tool call, so Pi would start another model call; the
  // run answers only after TOOL_LOOP_TURNS such turns (a runaway child).
  if (task.includes("TOOL_LOOP")) {
    const turns = Number(/TOOL_LOOP_TURNS=(\d+)/.exec(task)?.[1] ?? 30);
    let turn = 0;
    const next = () => {
      turn += 1;
      if (turn > turns) {
        finishAttempt(successMessage("loop finished"), false);
        return;
      }
      const message = {
        ...successMessage(""),
        content: [{ type: "toolCall", id: `call-${turn}`, name: "read", arguments: { path: "same.png" } }],
        stopReason: "toolUse",
      };
      send({ type: "message_end", message });
      send({ type: "turn_end", message, toolResults: [] });
      setTimeout(next, 10);
    };
    next();
    return;
  }

  if (task.includes("FAIL_PROVIDER")) {
    finishAttempt(providerFailure(), false);
    return;
  }

  if (task.includes("REPORT_FABRIC_IDENTITY")) {
    finishAttempt(
      successMessage(
        JSON.stringify({
          mainAgentId: process.env.PI_FABRIC_MAIN_AGENT_ID,
          parentRun: process.env.PI_FABRIC_PARENT_RUN,
          agentName: process.env.PI_FABRIC_AGENT_NAME,
        }),
      ),
      false,
    );
    return;
  }

  const value = {
    action: "message",
    message: `validated actor response:${process.env.PI_FABRIC_FULL_CODE_MODE ?? "missing"}`,
  };
  finishAttempt(successMessage(JSON.stringify(value)), false);
});

process.stdin.on("end", () => {
  setTimeout(() => process.exit(0), 5);
});
process.stdin.resume();
