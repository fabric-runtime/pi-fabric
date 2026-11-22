import {
  createSyntheticSourceInfo,
  defineTool,
  type ExtensionAPI,
  type ExtensionRunner,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { ANCHOR_READ_COMPATIBILITY_GUIDANCE, coreOverridePromptGuidance } from "../src/core/core-override-guidance.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { FabricState } from "../src/fabric-state.js";

const runner = {
  createContext: () => ({ cwd: process.cwd() }),
  getActiveTools: () => [],
} as unknown as ExtensionRunner;

const captured = (name: string, snippet?: string, guidelines?: string[]) => defineTool({
  name,
  label: name,
  description: `${name} override`,
  ...(snippet !== undefined ? { promptSnippet: snippet } : {}),
  ...(guidelines !== undefined ? { promptGuidelines: guidelines } : {}),
  parameters: Type.Object({ value: Type.Optional(Type.String()) }),
  async execute() {
    return { content: [{ type: "text" as const, text: "ok" }], details: {} };
  },
});

describe("core override prompt guidance", () => {
  it("keeps authored metadata under the pi identity and ignores other captured tools", () => {
    const catalog = new CapturedToolCatalog();
    catalog.replace(
      [
        {
          definition: captured("read", "structure-aware reads", ["Prefer symbol IDs when available."]),
          sourceInfo: createSyntheticSourceInfo("/extensions/organon/index.ts", { source: "test" }),
        },
        {
          definition: captured("deploy", "not a core slot", ["Do not advertise this here."]),
          sourceInfo: createSyntheticSourceInfo("/extensions/deploy/index.ts", { source: "test" }),
        },
      ],
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/pi-fabric/index.ts",
    );

    const guidance = coreOverridePromptGuidance(catalog);
    expect(guidance).toContain("pi.read");
    expect(guidance).toContain("structure-aware reads");
    expect(guidance).toContain("Prefer symbol IDs when available.");
    expect(guidance).not.toContain("deploy");
    expect(guidance).not.toContain("extensions.read");
  });

  it("tracks replacement and removal without persisted prompt state", () => {
    const catalog = new CapturedToolCatalog();
    const replace = (snippet: string) => catalog.replace(
      [{
        definition: captured("edit", snippet),
        sourceInfo: createSyntheticSourceInfo("/extensions/editor/index.ts", { source: "test" }),
      }],
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/pi-fabric/index.ts",
    );

    replace("first effective schema");
    expect(coreOverridePromptGuidance(catalog)).toContain("first effective schema");
    replace("replacement effective schema");
    expect(coreOverridePromptGuidance(catalog)).toContain("replacement effective schema");
    expect(coreOverridePromptGuidance(catalog)).not.toContain("first effective schema");
    catalog.clear();
    expect(coreOverridePromptGuidance(catalog)).toBe("");
  });


  it("adds the live override guidance to the full-code before-agent prompt", async () => {
    const handlers = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
    const pi = {
      events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
      getActiveTools: vi.fn(() => ["fabric_exec"]),
      getAllTools: vi.fn(() => []),
      on: vi.fn((event: string, handler: (event: unknown, context: unknown) => unknown) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      }),
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(),
      setActiveTools: vi.fn(),
    } as unknown as ExtensionAPI;
    const fakeEntry = {
      name: "read",
      definition: {
        promptSnippet: "structure-aware reads",
        promptGuidelines: ["Prefer symbol IDs when available."],
      },
    };
    const get = vi.spyOn(CapturedToolCatalog.prototype, "get")
      .mockImplementation((name) => name === "read" ? fakeEntry as never : undefined);
    try {
      const { default: piFabric } = await import("../src/index.js");
      await piFabric(pi);
      const handler = async (event: unknown, context: unknown) => {
        for (const callback of handlers.get("before_agent_start") ?? []) {
          const result = await callback(event, context);
          if (result && typeof result === "object" && "systemPrompt" in result) return result;
        }
        throw new Error("No before_agent_start handler returned prompt guidance");
      };
      const result = await handler({
        systemPrompt: "base system",
        prompt: "inspect source",
        systemPromptOptions: { skills: [] },
      }, {});
      const prompt = (result as { systemPrompt: string }).systemPrompt;
      expect(prompt).toContain("pi.read");
      expect(prompt).toContain("structure-aware reads");
      expect(prompt).toContain("Prefer symbol IDs when available.");
      expect(prompt).not.toContain("extensions.read");

      const modelGuidance = vi.spyOn(FabricState.prototype, "modelGuidance").mockReturnValue([
        {
          componentId: "deepseek-profile",
          component: "deepseek-profile",
          revision: 1,
          label: "profile",
          models: ["deepseek/*"],
          targets: ["main"],
          placement: "replace",
          slot: "fabric.execution",
          content: "Custom DeepSeek execution profile",
        },
        {
          componentId: "deepseek-extra",
          component: "deepseek-extra",
          revision: 1,
          label: "extra",
          models: ["deepseek/*"],
          targets: ["main"],
          placement: "append",
          content: "DeepSeek-specific final instruction",
        },
      ]);
      try {
        const skills = [
          { name: "active", description: "Active workflow", filePath: "/skills/active/SKILL.md" },
          {
            name: "dependency",
            description: "Required dependency",
            filePath: "/skills/dependency/SKILL.md",
          },
        ];
        const modelContext = { model: { provider: "deepseek", id: "deepseek-chat" } };
        const guidedEvent = {
          systemPrompt: "base system",
          prompt: "inspect source",
          systemPromptOptions: { skills },
        };
        const guidedResult = await handler(guidedEvent, modelContext);
        const repeatedResult = await handler(guidedEvent, modelContext);
        const guidedPrompt = (guidedResult as { systemPrompt: string }).systemPrompt;
        expect((repeatedResult as { systemPrompt: string }).systemPrompt).toBe(guidedPrompt);
        expect(guidedPrompt).toContain("Pi Fabric full code mode");
        expect(guidedPrompt).toContain("Custom DeepSeek execution profile");
        expect(guidedPrompt).toContain("DeepSeek-specific final instruction");
        expect(guidedPrompt).not.toContain("Examples and returns");

        const skillResult = await handler({
          ...guidedEvent,
          prompt: [
            '<skill name="active" location="/skills/active/SKILL.md">',
            "",
            "Always use /dependency.",
            "</skill>",
            "",
            "Inspect source",
          ].join("\n"),
        }, modelContext);
        // Turn-derived skill guidance must NOT touch the system prompt: the
        // system prompt stays byte-identical to a non-skill turn so provider
        // prefix caches never cold-prefill. It rides the message channel.
        const skillPrompt = (skillResult as { systemPrompt: string }).systemPrompt;
        expect(skillPrompt).toBe(guidedPrompt);
        expect(skillPrompt).not.toContain("The active skill");
        const skillMessage = (skillResult as { message?: { content: string } }).message;
        expect(skillMessage?.content).toContain('The active skill "active" is already expanded');
        expect(skillMessage?.content).toContain('- /dependency -> "/skills/dependency/SKILL.md"');
      } finally {
        modelGuidance.mockRestore();
      }

      const enforceConfig = structuredClone(DEFAULT_FABRIC_CONFIG);
      enforceConfig.fullCodeMode = false;
      enforceConfig.schema.mode = "enforce";
      const cwd = vi.spyOn(FabricState.prototype, "cwd", "get").mockReturnValue("/tmp");
      const config = vi.spyOn(FabricState.prototype, "config", "get").mockReturnValue(enforceConfig);
      try {
        const enforcedResult = await handler({
          systemPrompt: "base system",
          prompt: "inspect source",
          systemPromptOptions: { skills: [] },
        }, {});
        const enforcedPrompt = (enforcedResult as { systemPrompt: string }).systemPrompt;
        expect(enforcedPrompt).toContain("structure-aware reads");
        expect(enforcedPrompt).toContain("Prefer symbol IDs when available.");
        expect(enforcedPrompt).not.toContain("extensions.read");
      } finally {
        config.mockRestore();
        cwd.mockRestore();
      }
    } finally {
      get.mockRestore();
    }
  });

it("replaces an anchor-aware read override's codemode-script lines with the program contract", () => {
    const catalog = new CapturedToolCatalog();
    const anchored = (name: string, guidelines: string[]) => defineTool({
      name,
      label: name,
      description: `${name} override`,
      promptGuidelines: guidelines,
      parameters: Type.Object({ path: Type.String(), anchors: Type.Optional(Type.Boolean()) }),
      outputSchema: Type.Union([Type.String(), Type.Object({ text: Type.String() })]),
      async execute() {
        return { content: [{ type: "text" as const, text: "ok" }], details: {} };
      },
    });
    catalog.replace(
      [
        {
          definition: anchored("read", [
            "Remember to use the hashline tools.",
            "`read` in a codemode script resolves to the file's text; pass `anchors: true` to receive `{ text, lines, notices }`.",
            "read/grep: when called from a codemode script, failures resolve to `{ ok: false }`; branch on `ok`.",
          ]),
          sourceInfo: createSyntheticSourceInfo("/extensions/pi-hashline-edit-pro/index.ts", { source: "test" }),
        },
        {
          definition: anchored("grep", ["`grep`: a codemode script receives `{ text, results }`."]),
          sourceInfo: createSyntheticSourceInfo("/extensions/pi-hashline-edit-pro/index.ts", { source: "test" }),
        },
      ],
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/pi-fabric/index.ts",
    );

    const guidance = coreOverridePromptGuidance(catalog);
    expect(guidance).toContain("Remember to use the hashline tools.");
    expect(guidance).toContain(ANCHOR_READ_COMPATIBILITY_GUIDANCE);
    expect(guidance).not.toContain("codemode script");
    expect(guidance).not.toContain("{ text, lines, notices }");
    expect(guidance).not.toContain("branch on `ok`");
    expect(guidance).not.toContain("Guidelines for `pi.grep`");
  });

  it("keeps the compatibility block short and states the anchored read form", () => {
    expect(ANCHOR_READ_COMPATIBILITY_GUIDANCE.length).toBeLessThanOrEqual(700);
    expect(ANCHOR_READ_COMPATIBILITY_GUIDANCE).toContain("pi.read({path, anchors: true})");
    expect(ANCHOR_READ_COMPATIBILITY_GUIDANCE).toContain("plain file text");
    expect(ANCHOR_READ_COMPATIBILITY_GUIDANCE).toContain("`structuredContent.anchors[].anchor` holds fresh anchors for the next edit");
  });

  it("adds no anchor guidance for a read override that declares only an output schema", () => {
    const catalog = new CapturedToolCatalog();
    const plain = defineTool({
      name: "read",
      label: "read",
      description: "plain read override",
      promptSnippet: "plain reads",
      parameters: Type.Object({ path: Type.String() }),
      outputSchema: Type.String(),
      async execute() {
        return { content: [{ type: "text" as const, text: "ok" }], details: {} };
      },
    });
    catalog.replace(
      [{ definition: plain, sourceInfo: createSyntheticSourceInfo("/extensions/plain-read/index.ts", { source: "test" }) }],
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/pi-fabric/index.ts",
    );
    const guidance = coreOverridePromptGuidance(catalog);
    expect(guidance).toContain("plain reads");
    expect(guidance).not.toContain(ANCHOR_READ_COMPATIBILITY_GUIDANCE);
    expect(guidance).not.toContain("anchor│content");
  });

  it("adds the anchor guidance for a read override that declares the anchors parameter, with or without an output schema", () => {
    const withAnchors = (outputSchema: boolean) => {
      const catalog = new CapturedToolCatalog();
      const definition = defineTool({
        name: "read",
        label: "read",
        description: "anchored read override",
        parameters: Type.Object({ path: Type.String(), anchors: Type.Optional(Type.Boolean()) }),
        ...(outputSchema ? { outputSchema: Type.String() } : {}),
        async execute() {
          return { content: [{ type: "text" as const, text: "ok" }], details: {} };
        },
      });
      catalog.replace(
        [{ definition, sourceInfo: createSyntheticSourceInfo("/extensions/anchored-read/index.ts", { source: "test" }) }],
        runner,
        DEFAULT_FABRIC_CONFIG.capture,
        "/extensions/pi-fabric/index.ts",
      );
      return coreOverridePromptGuidance(catalog);
    };
    expect(withAnchors(true)).toContain(ANCHOR_READ_COMPATIBILITY_GUIDANCE);
    expect(withAnchors(false)).toContain(ANCHOR_READ_COMPATIBILITY_GUIDANCE);
  });

  it("adds no compatibility block for a read override without anchors or an output schema", () => {
    const catalog = new CapturedToolCatalog();
    catalog.replace(
      [{
        definition: captured("read", "structure-aware reads", ["Prefer symbol IDs when available."]),
        sourceInfo: createSyntheticSourceInfo("/extensions/organon/index.ts", { source: "test" }),
      }],
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/pi-fabric/index.ts",
    );
    expect(coreOverridePromptGuidance(catalog)).toBe(
      "\n\nEffective compatible core override guidance:\nAdditional guidance for `pi.read`: structure-aware reads\nGuidelines for `pi.read`:\n- Prefer symbol IDs when available.",
    );
  });

  it("adds no prose when an override has no prompt metadata", () => {
    const catalog = new CapturedToolCatalog();
    catalog.replace(
      [{
        definition: captured("read"),
        sourceInfo: createSyntheticSourceInfo("/extensions/reader/index.ts", { source: "test" }),
      }],
      runner,
      DEFAULT_FABRIC_CONFIG.capture,
      "/extensions/pi-fabric/index.ts",
    );
    expect(coreOverridePromptGuidance(catalog)).toBe("");
  });
});
