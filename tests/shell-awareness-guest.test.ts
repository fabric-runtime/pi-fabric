import { convertToLlm, type ContextEvent, type ContextEventResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { normalizeFabricConfig } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricShellJobStore } from "../src/core/shell-jobs.js";
import { ShellEventInbox, SHELL_AWARENESS_MESSAGE_TYPE } from "../src/core/shell-inbox.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { PiToolsProvider } from "../src/providers/pi-tools-provider.js";
import { TasksProvider } from "../src/providers/tasks-provider.js";

describe("discarded background result awareness", () => {
  it("records a real sandbox-started task for the model even when the program returns unrelated data", async () => {
    const jobs = new FabricShellJobStore(); const registry = new ActionRegistry();
    registry.register(new PiToolsProvider(process.cwd(), undefined, undefined, { shellJobs: jobs, powerShellToolDefinitionFactory: undefined }));
    registry.register(new TasksProvider(jobs));
    const config = normalizeFabricConfig({ fullCodeMode: true, approvals: { read: "allow", execute: "allow" } });
    const service = new FabricExecutionService(registry, config);
    const context = { cwd: process.cwd(), hasUI: false, isIdle: () => false, hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "awareness-probe", getSessionFile: () => undefined },
    } as unknown as ExtensionContext;
    const handlers = new Map<string, (event: ContextEvent, ctx: ExtensionContext) => ContextEventResult | undefined>();
    const sendMessage = vi.fn();
    const pi = { sendMessage, on: (name: string, handler: any) => { handlers.set(name, handler); return () => handlers.delete(name); } } as unknown as ExtensionAPI;
    const inbox = new ShellEventInbox(pi, context, jobs);
    try {
      const result = await service.execute({
        code: 'await pi.bash({cmd: "printf ready; sleep 8", background: true, description: "Discarded build"}); return "unrelated value";',
        context, signal: undefined, parentToolCallId: "awareness-probe", onPartial() {},
      });
      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(result.value).toBe("unrelated value");
      const [job] = jobs.live(); expect(job?.spilled).toBe(true);
      // The note joins the outer tool result once; requests are never rewritten.
      expect(handlers.get("context")!({ type: "context", messages: [] }, context)).toBeUndefined();
      const outer = handlers.get("tool_result")! as unknown as (event: unknown, ctx: ExtensionContext) => { content: Array<{ type: string; text: string }> };
      const { content } = outer({ type: "tool_result", toolCallId: "awareness-probe", toolName: "fabric_exec", input: {}, content: [{ type: "text", text: "unrelated value" }], isError: false }, context);
      const modelInput = JSON.stringify(convertToLlm([{ role: "toolResult", toolCallId: "awareness-probe", toolName: "fabric_exec", content, isError: false, timestamp: 1 } as never]));
      expect(modelInput).toContain("unrelated value");
      expect(modelInput).toContain(SHELL_AWARENESS_MESSAGE_TYPE);
      expect(modelInput).toContain(job!.id);
      expect(modelInput).toContain("Discarded build");
      expect(modelInput).toContain("end this turn");
      expect(modelInput).toContain("will resume you");
      jobs.stop(job!.id);
      expect(sendMessage).not.toHaveBeenCalled();
    } finally { inbox.close(); await registry.close(); await jobs.close(); }
    expect(handlers.size).toBe(0);
  }, 15000);
});
