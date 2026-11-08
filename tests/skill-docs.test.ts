import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { formatSkillsForPrompt, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { typeCheckFabricCode } from "../src/runtime/type-checker.js";

const stableProviderActions = {
  memory: ["recall", "expand", "sessions"],
  state: ["transition", "get", "history", "complexity", "verify", "goal", "checkGoal"],
  schema: ["status", "hypothesize", "verify", "commit", "abort"],
  compact: ["request", "status", "pressure", "carry", "cancel"],
  jev: ["evaluate", "run", "spawn", "status", "wait", "join", "advise", "stop"],
} as const;

describe("fabric-exec skill provider contracts", () => {
  it("documents a return shape for every stable first-class provider action", () => {
    const skill = fs.readFileSync("skillsets/typescript/fabric-exec/SKILL.md", "utf8");

    for (const [provider, actions] of Object.entries(stableProviderActions)) {
      for (const action of actions) {
        expect(skill, `missing return-shape row for ${provider}.${action}`).toContain(
          `| \`${provider}.${action}(`,
        );
      }
    }
  });

  it("documents dynamic MCP and captured-extension returns", () => {
    const skill = fs.readFileSync("skillsets/typescript/fabric-exec/SKILL.md", "utf8");

    expect(skill).toContain("mcp.<sanitized_server>.<sanitized_tool>(args)` resolves to");
    expect(skill).toContain("extensions.<tool>(args)` in full code mode resolves to");
  });

  it("keeps detailed execution caveats in the progressive skill", () => {
    const skill = fs.readFileSync("skillsets/typescript/fabric-exec/SKILL.md", "utf8");
    const extension = fs.readFileSync("src/extension.ts", "utf8");

    expect(skill).toContain("multiline or syntax-heavy payloads");
    expect(skill).toContain("Every `π.key` must exist in the same call's top-level `payloads` map");
    expect(skill).toContain("`pi.bash` and `pi.powershell` have no `stdin` option");
    expect(skill).toContain("Omit `timeoutMs` for agents and actors");
    expect(extension).not.toContain("Shorthands (all accepted)");
    expect(extension).not.toContain("mcp.fal_ai.get_model_schema");
    expect(extension).not.toContain("For agents and actors, omit timeoutMs");
    expect(extension).not.toContain("FABRIC_TEMPLATE_LITERAL_CAVEAT");
  });

  it("keeps the full execution reference progressive rather than mandatory", () => {
    const skill = fs.readFileSync("skillsets/typescript/fabric-exec/SKILL.md", "utf8");
    const frontmatter = skill.slice(0, skill.indexOf("---", 4));

    expect(frontmatter).toContain("Routine `pi.*`");
    expect(frontmatter).toContain("only after");
    expect(frontmatter).not.toContain("before the first Fabric call");
  });

  it("centralizes ambient actor setup outside the profile skills", () => {
    const setup = fs.readFileSync(
      "skillsets/typescript/fabric-ambient/references/setup.md",
      "utf8",
    );
    expect(setup).toContain("agents.create({");
    expect(setup).toContain("agents.setDeliveryPolicy({");
    expect(setup).toContain("agents.setTools({");
    expect(setup).toContain('existing.status !== "idle"');
    expect(setup).toContain("existing.topics.length !== 0");
    expect(setup).not.toContain("existing.extensions === false");
    expect(setup).not.toContain("extensions: false");
    expect(setup).toContain("follows the configured runner and actor extension policy");
    expect(setup).toContain("empty when unset");

    const profiles = {
      "fabric-advisor": "../fabric-ambient/references/setup.md",
      "fabric-spec": "../fabric-ambient/references/setup.md",
      "fabric-supervisor": "../fabric-ambient/references/setup.md",
      "fabric-ambient": "references/setup.md",
    } as const;
    for (const [name, reference] of Object.entries(profiles)) {
      const skillPath = `skillsets/typescript/${name}/SKILL.md`;
      const skill = fs.readFileSync(skillPath, "utf8");
      const referencePath = new URL(reference, `file://${process.cwd()}/skillsets/typescript/${name}/`);
      expect(fs.existsSync(referencePath)).toBe(true);
      expect(skill).toContain(reference);
      expect(skill).toContain("empty");
      expect(skill).not.toContain("agents.create({");
      expect(skill).not.toContain("agents.setDeliveryPolicy({");
    }

    expect(fs.readFileSync("skillsets/typescript/fabric-supervisor/SKILL.md", "utf8"))
      .toContain("request credentials");
    expect(fs.readFileSync("skillsets/typescript/fabric-ambient/SKILL.md", "utf8"))
      .toContain("request credentials");
  });

  it("type-checks every TypeScript-fenced skill program", () => {
    const skillFiles = fs.readdirSync("skillsets/typescript", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join("skillsets/typescript", entry.name, "SKILL.md"))
      .filter((file) => fs.existsSync(file));
    skillFiles.push(
      "skillsets/typescript/fabric-ambient/references/setup.md",
      "docs/schema-enforcement.md",
    );

    for (const file of skillFiles) {
      const markdown = fs.readFileSync(file, "utf8");
      const blocks = [...markdown.matchAll(/```ts\n([\s\S]*?)\n```/g)];
      for (const [index, match] of blocks.entries()) {
        const code = match[1]!;
        const result = typeCheckFabricCode(code, GUEST_TYPE_DECLARATIONS);
        expect(result.errors, `${file} TypeScript block ${index + 1}`).toEqual([]);
        for (const key of code.matchAll(/π\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
          expect(markdown, `${file} does not document strings.${key[1]}`)
            .toContain(`strings.${key[1]}`);
        }
      }
    }
  });

  it("marks and resolves every relative Markdown reference in a skill", () => {
    for (const entry of fs.readdirSync("skillsets/typescript", { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join("skillsets/typescript", entry.name, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      const markdown = fs.readFileSync(file, "utf8");
      expect(
        [...markdown.matchAll(/`((?:\.\.?\/|references\/)[^`]+\.md)`/g)],
        `${file} has an unmarked relative document reference`,
      ).toEqual([]);
      for (const match of markdown.matchAll(/`<skill-dir>\/([^`]+\.md)`/g)) {
        const resolved = path.resolve(path.dirname(file), match[1]!);
        expect(fs.existsSync(resolved), `${file} -> ${match[1]}`).toBe(true);
      }
    }
  });

  it("retains each specialized skill's execution invariants", () => {
    const required: Record<string, string[]> = {
      "fabric-advisor": ["agent_settled", "tool_error", "no recreation warning", "without recreating or retrying automatically"],
      "fabric-ambient": ["Choose and execute", "supervisor", "advisor", "never bounce the user", "without automatically rerunning setup"],
      "fabric-council": ["3–8 distinct", "CouncilOutcome", 'status: "partial"', "ifVersion: 0", "full untruncated reports", "automatic whole-council rerun"],
      "fabric-exec": ["read, describe, retry", "tools.describe", "timeoutMs", "multiline or syntax-heavy payloads", "shell heredocs", "never load them autonomously", "Peer is a reserved Fabric term", "query `agents.peers()` first", "Search before reading", "offset", "2000 lines or 50KB", "Use offset=n to continue"],
      "fabric-guide": ["smallest sufficient path", "No advanced skill", "preserves the user’s task as arguments", "Never load or execute"],
      "fabric-fusion": ["2–8 model panel", "PanelOutcome", "ambiguous", 'status: "partial"', "automatic full-panel rerun", "strings.actor", "1–4", "exactly one actor call", "never automatically rerun successful references"],
      "fabric-rlm": ["strings.task", "context-sized", "Context is an external variable", "QuickJS bindings end", "root-scoped `rlm/<rootId>/bindings/...`", "`state` is for claims", "recursive=true only", "all-failed batch", "full `FabricAgentResult` objects never return", "never rerun successful partitions"],
      "fabric-schema": ["one same-`fabric_exec`", "Evidence is not proof", 'status: commit.outcome === "committed"', "actually inspected"],
      "fabric-supervisor": ["agent_settled", "tool_error", "Goal verified complete", "without recreating or retrying automatically"],
      "fabric-swarm": ["ifVersion: 0", "observed version", "CAS-unblock dependents", "agents.tell"],
      "fabric-workflow": ["parallel(thunks", "WorkOutcome", 'status: "partial"', "fallback: completed", "automatic whole-workflow rerun"],
      "fabric-spec": ["agent_settled", "tool_error", "Spec verified complete", "never the approach", "without recreating or retrying automatically"],
    };

    for (const [name, signals] of Object.entries(required)) {
      const skill = fs.readFileSync(`skillsets/typescript/${name}/SKILL.md`, "utf8");
      for (const signal of signals) {
        expect(skill, `${name} lost signal: ${signal}`).toContain(signal);
      }
    }
  });

  it("preserves expensive partial work without bloating successful output", () => {
    const fanoutSkills = ["fabric-council", "fabric-fusion", "fabric-rlm", "fabric-workflow"];
    for (const name of fanoutSkills) {
      const skill = fs.readFileSync(`skillsets/typescript/${name}/SKILL.md`, "utf8");
      expect(skill, `${name} lacks partial status`).toContain('status: "partial"');
      expect(skill, `${name} lacks failed status`).toContain('status: "failed"');
      expect(skill, `${name} lacks compact fallback`).toContain("fallback: completed");
      expect(skill, `${name} retained binary completion pressure`).not.toContain("complete:");
      expect(skill, `${name} can trigger whole-flow retries`).toMatch(
        /not trigger an automatic|never rerun successful|must not trigger an automatic/,
      );
    }

    const rlm = fs.readFileSync("skillsets/typescript/fabric-rlm/SKILL.md", "utf8");
    expect(rlm).not.toContain("finding: FabricAgentResult");
    expect(rlm).not.toContain("findings: completed");
    expect(rlm).toContain("full `FabricAgentResult` objects never return");

    const swarm = fs.readFileSync("skillsets/typescript/fabric-swarm/SKILL.md", "utf8");
    expect(swarm).not.toContain("## Completion criterion");
  });

  it("packs every skill and required progressive reference", () => {
    const packed = execFileSync(
      process.platform === "win32" ? "bun.exe" : "bun",
      ["pm", "pack", "--ignore-scripts", "--dry-run"],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
    );
    const files = new Set([...packed.matchAll(/^packed\s+\S+\s+(.+)$/gm)].map((match) => match[1]!.trim()));
    expect(files).toContain("docs/skills.md");
    expect(files).toContain("skillsets/typescript/fabric-ambient/references/setup.md");
    for (const entry of fs.readdirSync("skillsets", { recursive: true }).map(String).filter((file) => file.endsWith(".md"))) {
      expect(files, `packed skill/reference missing: ${entry}`)
        .toContain(`skillsets/${entry.replaceAll("\\", "/")}`);
    }
  }, 120_000);

  it("keeps the skill hierarchy core-first and user-opt-in", () => {
    const skills = fs.readdirSync("skillsets/typescript", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        file: path.join("skillsets/typescript", entry.name, "SKILL.md"),
      }))
      .filter((entry) => fs.existsSync(entry.file));

    const loaded = loadSkillsFromDir({ dir: "skillsets/typescript", source: "test" });
    expect(loaded.diagnostics).toEqual([]);
    const fabricSkills = loaded.skills.filter((skill) => skill.name.startsWith("fabric-"));
    expect(fabricSkills.map((skill) => skill.name).sort()).toEqual(
      skills.map(({ name }) => name).sort(),
    );
    expect(fabricSkills.filter((skill) => !skill.disableModelInvocation)
      .map((skill) => skill.name)).toEqual(["fabric-exec"]);
    const prompt = formatSkillsForPrompt(fabricSkills);
    expect(prompt).toContain("fabric-exec");
    for (const skill of fabricSkills.filter((skill) => skill.disableModelInvocation)) {
      expect(prompt).not.toContain(`<name>${skill.name}</name>`);
    }

    const guide = fs.readFileSync("skillsets/typescript/fabric-guide/SKILL.md", "utf8");
    expect(guide).toContain("disable-model-invocation: true");
    for (const name of skills.map(({ name }) => name).filter((name) =>
      name !== "fabric-exec" && name !== "fabric-guide"
    )) {
      expect(guide, `router missing ${name}`).toContain(`/skill:${name}`);
    }

    const policy = fs.readFileSync("docs/skills.md", "utf8");
    expect(policy).toContain("core-first, user-opt-in");
    expect(policy).toContain("not a filesystem authorization boundary");
    expect(fs.readFileSync("README.md", "utf8")).toContain(
      "Pi loads advanced patterns after direct user invocation",
    );

    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      files: string[];
      pi: { skills: string[] };
    };
    expect(packageJson.files).toContain("docs/");
    expect(packageJson.pi.skills).toEqual([]);

    for (const reference of fs.readdirSync("skillsets/typescript/fabric-exec/references")) {
      const markdown = fs.readFileSync(
        path.join("skillsets/typescript/fabric-exec/references", reference),
        "utf8",
      );
      if (/\/skill:fabric-[a-z-]+/.test(markdown)) {
        expect(markdown, `${reference} crosses the user-only boundary`)
          .toMatch(/never load .* autonomously/i);
      }
    }

    for (const { name, file } of skills.filter(({ name }) => name !== "fabric-exec")) {
      const skill = fs.readFileSync(file, "utf8");
      const delegates = [...skill.matchAll(/\/skill:fabric-[a-z-]+/g)]
        .some((match) => match[0] !== `/skill:${name}`);
      if (delegates) {
        expect(skill, `${name} must recommend, not invoke, hidden skills`)
          .toMatch(/do not invoke|never invoke|never load or execute/i);
      }
    }
  });
});
