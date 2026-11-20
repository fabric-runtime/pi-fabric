// Tree grouping for stacked footer arcs: every item but the last renders as a
// continuation (├─) so a block closes with exactly one corner (╰─).
import type { Theme } from "@earendil-works/pi-coding-agent";

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const ARC_CLOSING = "╰─ ";
const ARC_CONTINUATION = "├─ ";

const visibleText = (line: string): string => line.replace(ANSI_ESCAPE, "");

const isArcLine = (line: string): boolean => {
  const visible = visibleText(line);
  return visible.startsWith(ARC_CLOSING) || visible.startsWith(ARC_CONTINUATION);
};

const continueArc = (line: string): string =>
  visibleText(line).startsWith(ARC_CLOSING)
    ? line.replace(ARC_CLOSING, ARC_CONTINUATION)
    : line;

/**
 * Returns `lines` with the trailing run of arc items converted to continuation
 * items so a following arc can close the group. Returns the input untouched
 * when no arc item trails the block.
 */
export function continueArcGroup(lines: readonly string[]): readonly string[] {
  let start = lines.length;
  while (start > 0 && isArcLine(lines[start - 1]!)) start--;
  if (start === lines.length) return lines;
  const next = [...lines];
  for (let index = start; index < next.length; index++) {
    next[index] = continueArc(next[index]!);
  }
  return next;
}

/** Arc item line with a plain label; glyph and label are muted. */
export function arcItem(theme: Theme, label: string): string {
  return theme.fg("muted", `${ARC_CLOSING}${label}`);
}

/** Arc item line with a pre-styled label; only the glyph is muted. */
export function arcItemStyled(theme: Theme, label: string): string {
  return theme.fg("muted", ARC_CLOSING) + label;
}

/**
 * Appends an arc item to `lines`, converting the preceding arc run into
 * continuation items so the new item is the group's only closing corner.
 */
export function pushArcItem(lines: string[], item: string): void {
  for (let index = lines.length - 1; index >= 0 && isArcLine(lines[index]!); index--) {
    lines[index] = continueArc(lines[index]!);
  }
  lines.push(item);
}
