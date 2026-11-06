import type { Theme } from "@earendil-works/pi-coding-agent";
import { compositeTuiLine, getKeybindings, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { truncateStyledText as truncateToWidth } from "./truncate.js";

/** Pi 1.0 tui-renderer.ts label and TuiAltScreen's transcript-bottom overlay. */
export class ConversationLatest {
  private rect: { row: number; column: number; width: number } | undefined;

  clear(): void { this.rect = undefined; }

  hit(event: TuiMouseEvent): boolean {
    const rect = this.rect;
    return !!rect && event.type === "press" && event.button === "left" &&
      event.y === rect.row && event.x >= rect.column && event.x < rect.column + rect.width;
  }

  paint(lines: string[], width: number, top: number, show: boolean, scrollbarVisible: boolean, theme: Theme): void {
    this.clear();
    if (!show || width <= 0 || lines.length === 0) return;
    const row = lines.length - 1;
    if (/\x1b(?:_G|\]1337;File=|P)/.test(lines[row] ?? "")) return;
    const shortcut = getKeybindings().getKeys("tui.altScreen.bottom").map((key) => key.split("+").map((part) => {
      const display = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
      return display.charAt(0).toUpperCase() + display.slice(1);
    }).join("+")).join("/");
    const label = truncateToWidth(theme.bg("selectedBg", theme.fg("text",
      ` ↓ Jump to latest message${shortcut ? ` · ${shortcut}` : ""} `)), width, "");
    const column = Math.floor((width - visibleWidth(label)) / 2);
    const text = truncateToWidth(label, Math.max(0, width - (scrollbarVisible ? 1 : 0) - column), "");
    const textWidth = visibleWidth(text);
    if (textWidth === 0) return;
    lines[row] = compositeTuiLine(lines[row] ?? "", text, column, textWidth, width);
    this.rect = { row: top + row, column, width: textWidth };
  }
}
