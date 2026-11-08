import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { normalizeFabricConfig } from "../src/config.js";
import { PROXY_CONTRACT_CUSTOM_TYPE } from "../src/core/proxy-contract.js";
import { FabricState } from "../src/fabric-state.js";

// Pi 1.2 fires before_agent_start for an idle pi.sendMessage(..., { triggerTurn: true })
// as { messageType: "custom", message } with no prompt. Pi 1.1 events carry only prompt.
type Handler = (event: unknown, context: unknown) => unknown;
type RunResult = { message?: { customType: string; content: string }; systemPrompt?: string } | undefined;

const SKILL_REFERENCE_CUSTOM_TYPE = "pi-fabric-skill-reference";
const BASE_SYSTEM_PROMPT = "You are a coding agent.\nCurrent working directory: /work";

const skills = [
  { name: "grill-me", description: "Interview wrapper.", filePath: "/skills/grill-me/SKILL.md", baseDir: "/skills/grill-me", disableModelInvocation: false },
  // The catalog itself names a hidden captured tool, so system-prompt proxy
  // guidance is needed even when a custom run has no user prompt.
  { name: "grilling", description: "Grill a plan; survey code with fovea_focus.", filePath: "/skills/grilling/SKILL.md", baseDir: "/skills/grilling", disableModelInvocation: false },
];

const expandedSkillPrompt = [
  '<skill name="grill-me" location="/skills/grill-me/SKILL.md">',
  "References are relative to /skills/grill-me.",
  "",
  "Run a `/grilling` session. Inside fabric_exec call fovea_focus before editing.",
  "</skill>",
  "",
  "my plan",
].join("\n");

const customTrigger = {
  messageType: "custom",
  message: { role: "custom", customType: "pi-callbacks", content: "Background job finished.", display: true, details: {}, timestamp: 1 },
};

const register = async (catalog = skills) => {
  vi.spyOn(FabricState.prototype, "bootstrapped", "get").mockReturnValue(true);
  vi.spyOn(FabricState.prototype, "cwd", "get").mockReturnValue(process.cwd());
  // Defaults: full code mode, capture enabled and hidden from the model.
  vi.spyOn(FabricState.prototype, "config", "get").mockReturnValue(normalizeFabricConfig({}));
  vi.spyOn(CapturedToolCatalog.prototype, "list").mockReturnValue([
    { name: "fovea_focus", definition: { name: "fovea_focus", label: "fovea_focus" } },
  ] as never);
  const handlers = new Map<string, Handler[]>();
  const pi = {
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
    on: vi.fn((name: string, handler: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }),
    getActiveTools: vi.fn(() => ["fabric_exec"]), getAllTools: vi.fn(() => []),
    registerCommand: vi.fn(), registerMessageRenderer: vi.fn(), registerTool: vi.fn(),
    setActiveTools: vi.fn(), sendMessage: vi.fn(), appendEntry: vi.fn(), getThinkingLevel: vi.fn(() => "off"),
  } as unknown as ExtensionAPI;
  const { default: piFabric } = await import("../src/index.js");
  await piFabric(pi);
  // Mirrors Pi 1.2 emitBeforeAgentStart: every handler sees the trigger fields,
  // the latest system prompt and the options; a throw is reported, not fatal.
  return async (trigger: Record<string, unknown>) => {
    let systemPrompt = BASE_SYSTEM_PROMPT;
    const messages: { customType: string; content: string }[] = [];
    const errors: string[] = [];
    for (const handler of handlers.get("before_agent_start") ?? []) {
      try {
        const result = await handler(
          { ...trigger, type: "before_agent_start", systemPrompt, systemPromptOptions: { skills: catalog } },
          { cwd: process.cwd(), hasUI: false },
        ) as RunResult;
        if (result?.message) messages.push(result.message);
        if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { systemPrompt, messages, errors };
  };
};

describe("before_agent_start runs started by a custom message", () => {
  it("preserves system-prompt proxy hints on custom turns without adding skill references", async () => {
    const startRun = await register();

    const custom = await startRun(customTrigger);
    expect(custom.errors).toEqual([]);
    expect(custom.messages.map((message) => message.customType)).toEqual([PROXY_CONTRACT_CUSTOM_TYPE]);
    expect(custom.messages[0]?.content).toContain("fovea_focus → extensions.fovea_focus");

    // The catalog hint is deduplicated, but user skill references still work.
    const user = await startRun({ messageType: "user", prompt: expandedSkillPrompt });
    expect(user.errors).toEqual([]);
    expect(user.messages.map((message) => message.customType)).toEqual([SKILL_REFERENCE_CUSTOM_TYPE]);
    // The turn-stable system prompt is the same for both kinds of run.
    expect(user.systemPrompt).not.toBe(BASE_SYSTEM_PROMPT);
    expect(custom.systemPrompt).toBe(user.systemPrompt);
  });

  it("does not interpret custom content or a stray custom prompt as skill instructions", async () => {
    const startRun = await register([]);
    const run = await startRun({
      ...customTrigger,
      prompt: expandedSkillPrompt,
      message: { ...customTrigger.message, content: expandedSkillPrompt },
    });
    expect(run.errors).toEqual([]);
    expect(run.messages).toEqual([]);
    expect(run.systemPrompt).not.toBe(BASE_SYSTEM_PROMPT);
  });

  it.each([
    ["Pi 1.1 (no messageType)", {}],
    ["Pi 1.2 (messageType user)", { messageType: "user" }],
  ])("still resolves skill references and the proxy contract for a %s prompt", async (_label, shape) => {
    const startRun = await register();
    const run = await startRun({ ...shape, prompt: expandedSkillPrompt });
    expect(run.errors).toEqual([]);
    const byType = new Map(run.messages.map((message) => [message.customType, message.content]));
    expect([...byType.keys()]).toEqual([SKILL_REFERENCE_CUSTOM_TYPE, PROXY_CONTRACT_CUSTOM_TYPE]);
    expect(byType.get(SKILL_REFERENCE_CUSTOM_TYPE)).toContain('- /grilling -> "/skills/grilling/SKILL.md"');
    expect(byType.get(PROXY_CONTRACT_CUSTOM_TYPE)).toContain("fovea_focus \u2192 extensions.fovea_focus");
  });
});
