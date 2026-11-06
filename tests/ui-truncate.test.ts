import { getOsc8LinkAtColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { truncateStyledText } from "../src/ui/truncate.js";
import { HiddenRowBorrowingComponent } from "../src/ui/row-balance.js";

const reset = "\x1b[0m";
const muted = "\x1b[38;2;140;145;150m";

describe("styled UI truncation", () => {
  it.each(["...", "…"])("keeps %s in the same colour as the preceding text", marker => {
    const row = truncateStyledText(`${muted}a long shell command${reset}`, 12, marker);
    expect(row).toBe(`${muted}${"a long shell command".slice(0, 12 - marker.length)}${marker}${reset}`);
    expect(visibleWidth(row)).toBe(12);
  });

  it("keeps the shared tool-result row clamp in the output text colour", () => {
    const component = new HiddenRowBorrowingComponent(1, 1,
      () => [`${muted}a long shell command${reset}`], {});
    expect(component.render(12)).toEqual([`${muted}a long sh...${reset}`]);
  });

  it("uses the style at the cut rather than the leading status colour", () => {
    const row = truncateStyledText(`\x1b[32m○${reset} ${muted}a long command${reset}`, 10, "…");
    expect(row).toBe(`\x1b[32m○${reset} ${muted}a long …${reset}`);
  });

  it("still closes hyperlinks before the marker and resets after it", () => {
    const open = "\x1b]8;;https://example.com\x1b\\";
    const close = "\x1b]8;;\x1b\\";
    const row = truncateStyledText(`${muted}${open}a long command${close}${reset}`, 8, "…");
    expect(row).toBe(`${muted}${open}a long ${close}…${reset}`);
    expect(getOsc8LinkAtColumn(row, 0)).toBe("https://example.com");
    expect(getOsc8LinkAtColumn(row, 7)).toBeUndefined();
  });

  it("leaves fitting text, existing ellipses and marker-free clipping alone", () => {
    const text = `${muted}text...${reset}`;
    expect(truncateStyledText(text, 7)).toBe(text);
    expect(truncateStyledText(text, 20)).toBe(text);
    expect(truncateStyledText(text, 4, "")).toBe(`${muted}text${reset}`);
    expect(truncateStyledText(text, 0)).toBe("");
  });

  it("preserves graphemes and bounds even when only the marker fits", () => {
    for (const text of ["a long command", "中文".repeat(10), "🏳️‍🌈".repeat(10), "é".repeat(20)]) {
      for (const width of [1, 2, 3, 4, 7, 12]) {
        for (const marker of ["...", "…"]) {
          const row = truncateStyledText(`${muted}${text}${reset}`, width, marker);
          expect(visibleWidth(row)).toBeLessThanOrEqual(width);
          expect(stripTerminalSequences(row)).toMatch(/(?:\.{1,3}|…)$/);
          expect(row.endsWith(reset)).toBe(true);
        }
      }
    }
  });
});
