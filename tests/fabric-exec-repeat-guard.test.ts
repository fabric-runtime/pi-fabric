import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { ActionRegistry } from "../src/core/action-registry.js";
import { FabricExecutionService } from "../src/execution-service.js";
import { createFabricExecTool } from "../src/fabric-exec-tool.js";
import type { FabricState } from "../src/fabric-state.js";
import { PrewalkController } from "../src/prewalk/controller.js";
import { FABRIC_REPEAT_BLOCK } from "../src/repeat-guard.js";
import { defaultCodePreviewSettings } from "../src/ui/code-preview.js";

const makeTool = () => {
  const config = structuredClone(DEFAULT_FABRIC_CONFIG);
  const state = {
    config,
    ensure: async () => {},
    claimHandoff: async () => undefined,
    prewalk: new PrewalkController(),
    execution: new FabricExecutionService(new ActionRegistry(), config),
  } as unknown as FabricState;
  return createFabricExecTool(state, defaultCodePreviewSettings(), new Map(), (tool) => tool);
};

const toolContext = {
  cwd: process.cwd(),
  hasUI: false,
  sessionManager: { getSessionId: () => "fixture" },
  tools: [],
  executeTool: async () => {
    throw new Error("unexpected nested host call");
  },
} as unknown as ExtensionToolContext;

type Tool = ReturnType<typeof makeTool>;
const run = (tool: Tool, id: string, params: Record<string, unknown>) =>
  tool.execute(id, params, undefined, undefined, toolContext);
const textOf = (result: { content: { type: string; text?: string }[] }): string =>
  result.content.map((part) => part.text ?? "").join("\n");

const WRAPPER = "return π.value;";

describe("fabric_exec repeat guard and payloads", () => {
  it("runs the same wrapper code with different payloads six or more times without warning or blocking", async () => {
    const tool = makeTool();
    for (let i = 1; i <= FABRIC_REPEAT_BLOCK + 2; i += 1) {
      const result = await run(tool, `call-${i}`, { code: WRAPPER, payloads: { value: `script-${i}` } });
      expect(result).not.toMatchObject({ isError: true });
      expect(textOf(result)).toContain(`script-${i}`);
      expect(textOf(result)).not.toContain("circuit-breaker");
      expect(textOf(result)).not.toContain("Circuit breaker");
    }
  });

  it("still blocks identical code with identical payloads at the sixth run", async () => {
    const tool = makeTool();
    for (let i = 1; i < FABRIC_REPEAT_BLOCK; i += 1) {
      const result = await run(tool, `same-${i}`, { code: WRAPPER, payloads: { value: "noop" } });
      expect(result).not.toMatchObject({ isError: true });
    }
    const blocked = await run(tool, "same-final", { code: WRAPPER, payloads: { value: "noop" } });
    expect(blocked).toMatchObject({ isError: true });
    expect(textOf(blocked)).toContain(`executed ${FABRIC_REPEAT_BLOCK} times in a row and was blocked`);
  });

  it("blocks a loop that changes only display, only payload key order, or uses the legacy strings alias", async () => {
    const tool = makeTool();
    const variants: Record<string, unknown>[] = [
      { code: "return [π.a, π.b];", payloads: { a: "1", b: "2" }, display: { name: "run 1" } },
      { code: "return [π.a, π.b];", payloads: { b: "2", a: "1" }, display: { name: "run 2" } },
      { code: "return [π.a, π.b];", strings: { a: "1", b: "2" }, display: { name: "run 3", description: "x" } },
      { code: "return [π.a, π.b];", payloads: { a: "1", b: "2" } },
      { code: "return [π.a, π.b];", payloads: { b: "2", a: "1" }, display: { name: "run 5" } },
    ];
    for (const [i, params] of variants.entries()) {
      expect(await run(tool, `v-${i}`, params)).not.toMatchObject({ isError: true });
    }
    const blocked = await run(tool, "v-final", {
      code: "return [π.a, π.b];",
      payloads: { a: "1", b: "2" },
      display: { name: "run 6" },
    });
    expect(blocked).toMatchObject({ isError: true });
    expect(textOf(blocked)).toContain("Circuit breaker");
  });
});
