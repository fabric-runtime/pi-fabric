import { describe, expect, it } from "vitest";
import { formatFabricValue } from "../src/ui/structured.js";

describe("formatFabricValue", () => {
  const value = { status: "completed", findings: [{ fixed: true }] };

  it("formats structured auto results as YAML", () => {
    const formatted = formatFabricValue(value, "auto");
    expect(formatted.language).toBe("yaml");
    expect(formatted.text).toContain("status: completed");
    expect(formatted.text).toContain("- fixed: true");
    expect(formatted.text).not.toContain("{\n");
  });

  it("preserves explicit JSON and text modes", () => {
    expect(formatFabricValue(value, "json")).toEqual({
      text: JSON.stringify(value, null, 2),
      language: "json",
    });
    expect(formatFabricValue({ text: "plain result", metadata: true }, "text")).toEqual({
      text: "plain result",
    });
  });

  it("keeps string values unchanged in auto mode", () => {
    expect(formatFabricValue("already textual", "auto")).toEqual({ text: "already textual" });
  });
});

describe("exact multiline deduplication", () => {
  const contract = "/** Preserve the original opaque identifier. */\nfunction lookup(id: string): Promise<unknown>;";
  it("renders one body and keeps every occurrence pointing to the first path", () => {
    const value = { tools: [{ description: contract }], contracts: [contract] };
    const original = structuredClone(value);
    const text = formatFabricValue(value, "yaml").text;
    expect(text.split(contract)).toHaveLength(2);
    expect(text.match(/<multi-line string, see section: tools\[0\]\.description>/g)).toHaveLength(2);
    expect(text).not.toContain("--- contracts[0]");
    expect(value).toEqual(original);
  });
  it("does not merge whitespace, line ending or identifier differences", () => {
    const first = "Case_A-ß\nrepository: 123";
    const value = { first, other: "Case_A-ß\nrepository: 124", padded: first + " ", crlf: first.replace("\n", "\r\n") };
    const text = formatFabricValue(value, "auto").text;
    for (const content of Object.values(value)) expect(text).toContain(content);
    expect(text.match(/^--- .+ \(\d+ chars\) ---$/gm)).toHaveLength(4);
  });
  it("keeps dictionaries per result and preserves a full body within the same budget", () => {
    const full = "required identifier semantics\n".repeat(100);
    const text = formatFabricValue({ first: full, second: full }, "yaml", 3400).text;
    expect(text).toContain(full);
    expect(text).not.toContain("chars omitted");
    expect(text.length).toBeLessThanOrEqual(3400);
    expect(formatFabricValue({ current: full }, "yaml").text).toContain("--- current");
    expect(formatFabricValue({ current: full }, "yaml").text).not.toContain("section: first");
  });
  it("leaves JSON, text and circular handling unchanged", () => {
    const value = { a: contract, b: contract };
    expect(JSON.parse(formatFabricValue(value, "json").text)).toEqual(value);
    expect(formatFabricValue({ text: contract }, "text").text).toBe(contract);
    expect(formatFabricValue(contract, "yaml").text).toBe(contract);
    const cycle: Record<string, unknown> = { description: contract };
    cycle.self = cycle;
    expect(formatFabricValue(cycle, "auto").text).toContain("[circular reference]");
  });
});

describe("multi-line string fidelity", () => {
  // A multi-line string nested in a returned object must reach the model with
  // its exact bytes. YAML literal block scalars indent every content line, so
  // text transcribed from the display (e.g. into pi.edit oldText) does not
  // match the file on disk.
  const file = "function x() {\n    stopLoader();\n        deep();\n}";

  it("hoists multi-line strings so content keeps its exact bytes", () => {
    const formatted = formatFabricValue({ content: file }, "auto");
    // content appears verbatim: 4-space and 8-space indents intact
    expect(formatted.text).toContain("\n    stopLoader();\n");
    expect(formatted.text).toContain("\n        deep();\n");
    // never as a re-indented YAML block scalar
    expect(formatted.text).not.toContain("      stopLoader();");
    expect(formatted.text).not.toMatch(/\|\d?-/);
  });

  it("labels hoisted sections with their value path", () => {
    const formatted = formatFabricValue(
      { results: ["one\ntwo", { note: "a\nb" }] },
      "auto",
    );
    expect(formatted.text).toContain("results[0]");
    expect(formatted.text).toContain("results[1].note");
    expect(formatted.text).toContain("one\ntwo");
    expect(formatted.text).toContain("a\nb");
  });

  it("shares an output budget across every multiline section", () => {
    const section = (name: string) => `${name}-start\n${name.repeat(4_000)}\n${name}-end`;
    const formatted = formatFabricValue(
      { first: section("a"), middle: section("b"), last: section("c") },
      "auto",
      4_000,
    );

    expect(formatted.text.length).toBeLessThanOrEqual(4_000);
    for (const [path, name] of [["first", "a"], ["middle", "b"], ["last", "c"]]) {
      expect(formatted.text).toContain(`--- ${path}`);
      expect(formatted.text).toContain(`${name}-start`);
      expect(formatted.text).toContain(`${name}-end`);
    }
    expect(formatted.text.match(/chars omitted/g)).toHaveLength(3);
  });

  it("keeps single-line strings inline in the YAML skeleton", () => {
    const formatted = formatFabricValue({ a: "x", b: 1 }, "auto");
    expect(formatted).toEqual({ text: "a: x\nb: 1", language: "yaml" });
  });

  it("bounds YAML highlighting to the skeleton when raw sections are appended", () => {
    const formatted = formatFabricValue({ content: file }, "auto");
    expect(formatted.language).toBe("yaml");
    expect(formatted.highlightedLineCount).toBe(1);
    expect(formatted.text.split("\n")[formatted.highlightedLineCount! + 1]).toMatch(
      /^--- content/,
    );
  });
});
