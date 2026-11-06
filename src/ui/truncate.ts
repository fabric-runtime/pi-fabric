import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";

/** Keep a truncation marker in the text's colour, not the terminal default. */
export const truncateStyledText = (text: string, width: number, ellipsis = "..."): string => {
  const truncated = truncateToWidth(text, width, ellipsis);
  if (!ellipsis || width <= 0 || truncated === text) return truncated;

  // pi-tui closes any hyperlink, resets SGR, then emits the marker and another
  // reset. Keep the hyperlink closed, but defer the first reset until after the
  // marker so it inherits the last visible text's style (as footer rows do).
  // Tiny widths can clip the marker itself; retain pi-tui's grapheme handling.
  const marker = visibleWidth(ellipsis) > width
    ? truncateToWidth(ellipsis, width, "").replace(/\x1b\[0m$/, "")
    : ellipsis;
  const suffix = `${RESET}${marker}${RESET}`;
  return truncated.endsWith(suffix)
    ? truncated.slice(0, -suffix.length) + marker + RESET
    : truncated;
};
