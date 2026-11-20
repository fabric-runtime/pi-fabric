import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  arcItem,
  arcItemStyled,
  continueArcGroup,
  pushArcItem,
} from "../src/ui/arc-group.js";

const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

describe("pushArcItem", () => {
  it("keeps a lone arc as the closing corner", () => {
    const lines = ["body"];
    pushArcItem(lines, arcItem(theme, "one item"));
    expect(lines).toEqual(["body", "╰─ one item"]);
  });

  it("converts preceding arcs into continuation items", () => {
    const lines: string[] = [];
    pushArcItem(lines, arcItem(theme, "first"));
    pushArcItem(lines, arcItem(theme, "second"));
    pushArcItem(lines, arcItem(theme, "third"));
    expect(lines).toEqual(["├─ first", "├─ second", "╰─ third"]);
  });

  it("starts a new group after non-arc rows", () => {
    const lines = ["├─ first", "╰─ second", "… 3 lines · ctrl+o to expand"];
    pushArcItem(lines, arcItem(theme, "later"));
    expect(lines).toEqual([
      "├─ first",
      "╰─ second",
      "… 3 lines · ctrl+o to expand",
      "╰─ later",
    ]);
  });
});

describe("continueArcGroup", () => {
  it("downgrades only the trailing run so a footer arc can close the group", () => {
    // Mirrors TimingFooter appending `╰─ Took …` below a body's arcs.
    const base = ["out", arcItem(theme, "truncated"), arcItem(theme, "full output")];
    const grouped = [...continueArcGroup(base), arcItem(theme, "Took 4ms")];
    expect(grouped).toEqual(["out", "├─ truncated", "├─ full output", "╰─ Took 4ms"]);
    expect(base[1]).toBe("╰─ truncated");
  });

  it("returns the same array when no arc trails the block", () => {
    const base = ["only body", "plain row"];
    expect(continueArcGroup(base)).toBe(base);
  });

  it("recognizes arc glyphs behind ANSI styling", () => {
    const styled = ["\x1b[2m╰─ Output truncated\x1b[22m"];
    const grouped = continueArcGroup(styled);
    expect(grouped[0]).toBe("\x1b[2m├─ Output truncated\x1b[22m");
  });
});

describe("arcItemStyled", () => {
  it("emits a closing glyph before a pre-styled label", () => {
    expect(arcItemStyled(theme, "hint")).toBe("╰─ hint");
  });
});
