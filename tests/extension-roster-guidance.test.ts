import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extensionToolRosterGuidance } from "../src/core/system-guidance.js";

const entry = (name: string, sourceInfo?: { source?: string; path?: string }) => ({
  name,
  ...(sourceInfo === undefined ? {} : { sourceInfo }),
});

describe("extensionToolRosterGuidance", () => {
  it("lists tool names grouped by source namespace without descriptions", () => {
    const roster = extensionToolRosterGuidance(
      [
        entry("fovea_focus", { source: "pi-fovea" }),
        entry("fovea_dwell", { source: "pi-fovea" }),
        entry("openai_image", { source: "pi-better-openai" }),
      ],
      new Set(["read", "bash"]),
    );
    expect(roster).toContain("- pi-better-openai: openai_image");
    expect(roster).toContain("- pi-fovea: fovea_dwell, fovea_focus");
    expect(roster).toContain("tools.list");
  });

  it("falls back to path basenames, then a generic label", () => {
    const roster = extensionToolRosterGuidance(
      [
        entry("from_entry", { path: "/ext/pi-somewhere/index.js" }),
        entry("from_file", { path: "/ext/pi-other/cool.js" }),
        entry("bare"),
      ],
      new Set(),
    );
    expect(roster).toContain("- pi-somewhere: from_entry");
    expect(roster).toContain("- cool.js: from_file");
    expect(roster).toContain("- extensions: bare");
  });

  it("names local package tools by the nearest package.json manifest", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-roster-"));
    try {
      const pkgDir = path.join(root, "pi-manifest-ext");
      mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
      writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "pi-manifest-ext" }));
      const roster = extensionToolRosterGuidance(
        [
          entry("tool_one", {
            source: "../../somewhere/relative/pi-manifest-ext",
            path: path.join(pkgDir, "dist", "index.js"),
          }),
        ],
        new Set(),
      );
      expect(roster).toContain("- pi-manifest-ext: tool_one");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names tools from one package by its manifest when they live in different subfolders", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-roster-"));
    try {
      const pkgDir = path.join(root, "pi-split-ext");
      mkdirSync(path.join(pkgDir, "dist", "tools"), { recursive: true });
      writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "pi-split-ext" }));
      // alpha sorts first, so its walk passes through dist/ before beta's walk starts there.
      const tools = [
        entry("beta_tool", { path: path.join(pkgDir, "dist", "beta.js") }),
        entry("alpha_tool", { path: path.join(pkgDir, "dist", "tools", "alpha.js") }),
      ];
      const first = extensionToolRosterGuidance(tools, new Set());
      const second = extensionToolRosterGuidance(tools, new Set());
      expect(first).toContain("- pi-split-ext: alpha_tool, beta_tool");
      expect(second).toContain("- pi-split-ext: alpha_tool, beta_tool");
      expect(second).toBe(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("labels Pi's built-in and inline tools by source, not by the cwd's package.json", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-roster-"));
    const previousCwd = process.cwd();
    try {
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "cwd-project" }));
      process.chdir(root);
      const roster = extensionToolRosterGuidance(
        [
          entry("codemode", { source: "builtin", path: "builtin:codemode" }),
          entry("tool_search", { source: "builtin", path: "builtin:tool_search" }),
          entry("inline_tool", { source: "inline", path: "<inline:demo>" }),
        ],
        new Set(),
      );
      expect(roster).toContain("- builtin: codemode, tool_search");
      expect(roster).toContain("- inline: inline_tool");
      expect(roster).not.toContain("cwd-project");
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("strips npm: prefixes without touching the filesystem", () => {
    const roster = extensionToolRosterGuidance(
      [entry("tool_two", { source: "npm:@scope/pi-npm-ext", path: "/nonexistent/nowhere/index.js" })],
      new Set(),
    );
    expect(roster).toContain("- @scope/pi-npm-ext: tool_two");
  });

  it("excludes captured core overrides and empty catalogs", () => {
    expect(extensionToolRosterGuidance([entry("read")], new Set(["read"]))).toBeUndefined();
    expect(extensionToolRosterGuidance([], new Set())).toBeUndefined();
  });
});
