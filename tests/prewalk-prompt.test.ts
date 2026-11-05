import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { normalizeFabricConfig } from "../src/config.js";
import { createFabricExecTool } from "../src/fabric-exec-tool.js";
import type { FabricState } from "../src/fabric-state.js";
import { defaultCodePreviewSettings } from "../src/ui/code-preview.js";

describe("prewalk prompt isolation", () => {
  it("does not add prewalk state or guidance to before_agent_start", () => {
    const extensionSource = fs.readFileSync(
      path.join(process.cwd(), "src", "extension.ts"),
      "utf8",
    );
    const source = ts.createSourceFile("extension.ts", extensionSource, ts.ScriptTarget.Latest, true);
    const handlers: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "pi.on" &&
          node.arguments[0] && ts.isStringLiteral(node.arguments[0]) &&
          node.arguments[0].text === "before_agent_start") {
        expect(node.arguments[1]).toBeDefined();
        handlers.push(node.arguments[1]!.getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(handlers.length).toBeGreaterThan(0);
    for (const handler of handlers) expect(handler.toLowerCase()).not.toContain("prewalk");

    // Assert actual model-facing guidance in both branches, not the source
    // spelling of the conditional promptGuidelines initializer.
    for (const managedHostOptions of [undefined, { providers: ["mcp"] }]) {
      const state = { bootstrapped: true, config: normalizeFabricConfig({}), managedHostOptions } as FabricState;
      const guidelines = createFabricExecTool(
        state, defaultCodePreviewSettings(), new Map(), (tool) => tool,
      ).promptGuidelines ?? [];
      expect(guidelines.length).toBeGreaterThan(0);
      const text = guidelines.join("\n").toLowerCase();
      expect(text).not.toContain("prewalk");
      expect(text).not.toContain("handoff");
    }
  });

  it("keeps coding guidance outcome-oriented and context-bounded", () => {
    const state = { bootstrapped: true, config: normalizeFabricConfig({}) } as FabricState;
    const visibleGuidelines = createFabricExecTool(
      state, defaultCodePreviewSettings(), new Map(), (tool) => tool,
    ).promptGuidelines ?? [];
    const guidelines = visibleGuidelines.join("\n");
    const visibleGuidelineChars = visibleGuidelines.reduce((total, line) => total + line.length, 0);

    expect(visibleGuidelines).toHaveLength(6);
    expect(visibleGuidelineChars).toBeLessThanOrEqual(1_700);
    expect(guidelines).toContain("Form a falsifiable hypothesis covering the reported failure and affected paths.");
    expect(guidelines).toContain("Let contrary evidence invalidate the plan.");
    expect(guidelines).toContain("Verify postconditions before declaring success.");
    expect(guidelines).toContain("Be ambitious and persistent");
    expect(guidelines).toContain("Treat new requests as additive, not replacements");
    expect(guidelines).toContain("unless explicitly reprioritized");
    expect(guidelines).toContain("one `pi.edit({path, edits:[...]})`");
    expect(guidelines).toContain("`all:true` only for intentional repeated exact anchors");
    expect(guidelines).toContain("`literal:true` for exact punctuated text");
    expect(guidelines).toContain("fan-out search limits small");
    expect(guidelines).toContain("Batch independent I/O");
    expect(guidelines).toContain("Inspect findings before choosing dependent reads or edits.");
    expect(guidelines).toContain("Background long-running work when independent tasks can proceed; collect its result before completion.");
    expect(guidelines).not.toContain("schema.hypothesize");
    expect(guidelines).toContain("pass named payloads through top-level `payloads`");
    expect(guidelines).toContain("prefer `pi.edit`/`pi.write`");
    expect(guidelines).toContain("`pi.bash`: no stdin");
    expect(guidelines).toContain("`display.name` and objective `display.description`");
    expect(guidelines).toContain("pairs them with verified outcomes");
    expect(guidelines).toContain("deterministic compaction");
  });

  it("runs handoff from finalized outer message_end without aborting nested calls", () => {
    const extensionSource = fs.readFileSync(
      path.join(process.cwd(), "src", "extension.ts"),
      "utf8",
    );
    const toolSource = fs.readFileSync(
      path.join(process.cwd(), "src", "fabric-exec-tool.ts"),
      "utf8",
    );
    const start = extensionSource.indexOf('pi.on("tool_result"');
    const end = extensionSource.indexOf('pi.on("tool_execution_end"', start);
    const boundaryHandlers = extensionSource.slice(start, end);

    expect(boundaryHandlers).toContain('pi.on("message_end"');
    expect(boundaryHandlers).toContain("state.runHandoffAtBoundary");
    expect(toolSource).toContain("state.claimHandoff");
  });

  it("disarms the captured task from the agent_settled lifecycle", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "extension.ts"), "utf8");
    const start = source.indexOf('pi.on("agent_settled"');
    const end = source.indexOf('pi.on("tool_call"', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain("state.prewalk.settleTask");
  });

  it("restores the borrowed Main model when a session starts", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "extension.ts"), "utf8");
    const start = source.indexOf('pi.on("session_start"');
    const end = source.indexOf('pi.on("session_tree"', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const handler = source.slice(start, end);
    expect(handler).toContain("restoreBorrowedInPlaceMain");
    // Recovery must precede the eager activation that may auto-arm: a restarted
    // process otherwise arms on the executor before Main can snap back.
    expect(handler.indexOf("restoreBorrowedInPlaceMain")).toBeLessThan(
      handler.indexOf("state.ensure(context)"),
    );
  });
});
