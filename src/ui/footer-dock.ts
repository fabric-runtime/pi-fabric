import { stripVTControlCharacters } from "node:util";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { borderBadge } from "./format.js";

type LayoutNode = {
  children?: unknown;
  addChild?: (component: Component, options?: { shrink?: number; minSize?: number }) => void;
  removeChild?: (component: Component) => void;
};

const childrenOf = (node: unknown): readonly unknown[] => {
  const children = (node as LayoutNode | undefined)?.children;
  return Array.isArray(children) ? children : [];
};

/** The node among `nodes`, or `depth` levels below them, whose children include `target`. */
const parentOf = (owner: unknown, nodes: readonly unknown[], target: unknown, depth: number): LayoutNode | undefined => {
  if (nodes.includes(target)) return owner as LayoutNode;
  if (depth <= 0) return undefined;
  for (const node of nodes) {
    const found = parentOf(node, childrenOf(node), target, depth - 1);
    if (found) return found;
  }
  return undefined;
};

type Rendering = { render(width: number): readonly string[] };

/**
 * Put a `label` badge on the right of the editor's top border, before its last
 * two columns, as the conversation window badges its target. The badge takes
 * the border's own colour, so it follows Pi's thinking level. Only plain border
 * cells are replaced: Pi's scroll indicator or working label keep their place.
 */
export const withBorderBadge = (lines: readonly string[], label: string | undefined): readonly string[] => {
  if (!label) return lines;
  const index = lines.findIndex((line) => stripVTControlCharacters(line).startsWith("─"));
  const line = lines[index];
  if (line === undefined) return lines;
  const badge = borderBadge(line, label);
  const width = visibleWidth(line);
  const badgeWidth = visibleWidth(badge);
  const plain = stripVTControlCharacters(line);
  if (badgeWidth + 6 > width || !/^─+$/.test(plain.slice(-(badgeWidth + 4)))) return lines;
  const next = [...lines];
  next[index] = truncateToWidth(line, width - badgeWidth - 2, "") + badge + sliceByColumn(line, width - 2, 2);
  return next;
};

/**
 * Places a component after Pi's footer, where Claude Code keeps its agent
 * list. Pi has no extension slot there: widgets render above or below the
 * editor, both above the footer. So the component registers a zero-height
 * `anchor` as an ordinary below-editor widget, and the dock appends the real
 * component to the container that holds Pi's below-editor widgets and its
 * footer. That is the root in the regular renderer and the input dock in the
 * fullscreen one. The dock touches nothing unless the footer is the last node
 * after the widget container, so another layout leaves the caller to fall back.
 */
export class FooterDock {
  #parent: LayoutNode | undefined;
  #holder: unknown;
  /**
   * Pi's editor container while its render carries the badge: the render it
   * had, the wrapper installed over it, and whether that wrapper still badges.
   */
  #editor: { node: Rendering; render: Rendering["render"]; wrapper: Rendering["render"]; live: { on: boolean } } | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly anchor: Component,
    private readonly component: Component,
    /** Label for the editor's top border, read on every frame; undefined draws none. */
    private readonly badge?: () => string | undefined,
  ) {}

  /** Pi's editor drew the badge in its last frame; a border too narrow or busy for it did not. */
  #badgeDrawn = false;

  /**
   * True while the editor border shows the badge. Pi renders its editor before
   * the docked list in every frame, so the list reads this frame's outcome.
   */
  get badgeShown(): boolean {
    return this.#editor !== undefined && this.#badgeDrawn;
  }

  /**
   * Fullscreen stacks shrink every input-dock child when overfull, including
   * one-line status widgets. Give our list only the rows left after Pi's own
   * editor, widgets and footer, reserving the transcript's native minimum row.
   * Regular mode scrolls the transcript instead and needs no extra cap.
   */
  availableRows(width: number): number | undefined {
    const parent = this.#parent;
    const rows = this.tui.terminal?.rows;
    if (!parent || parent === (this.tui as unknown) || !this.#docked(this.#roots()) ||
      rows === undefined || !Number.isFinite(rows) || rows <= 0) return;
    const occupied = childrenOf(parent).reduce<number>((total, child) => {
      if (child === this.component) return total;
      const sibling = child as Partial<Component> | undefined;
      return total + (typeof sibling?.render === "function" ? sibling.render(width).length : 0);
    }, 0);
    return Math.max(0, Math.floor(rows) - 1 - occupied);
  }

  /**
   * Keep the component after the footer: `docked` when it already is, `moved`
   * when this call placed it, `unavailable` when the layout is not Pi's.
   */
  sync(): "docked" | "moved" | "unavailable" {
    const roots = this.#roots();
    if (this.#docked(roots)) {
      this.#decorateEditor();
      return "docked";
    }
    this.detach();
    // The anchor's container holds Pi's below-editor widgets.
    const holder = parentOf(this.tui, roots, this.anchor, 3);
    const parent = holder === undefined ? undefined : parentOf(this.tui, roots, holder, 2);
    if (!parent || typeof parent.addChild !== "function") return "unavailable";
    const siblings = childrenOf(parent);
    // Pi mounts its footer straight after that container, and last.
    if (siblings.indexOf(holder) !== siblings.length - 2) return "unavailable";
    parent.addChild(this.component, { shrink: 1, minSize: 0 });
    this.#parent = parent;
    this.#holder = holder;
    this.#decorateEditor();
    return "moved";
  }

  detach(): void {
    this.#restoreEditor();
    const parent = this.#parent;
    this.#parent = undefined;
    this.#holder = undefined;
    if (parent && childrenOf(parent).includes(this.component)) parent.removeChild?.(this.component);
  }

  /** Pi mounts its editor container straight before the below-editor widgets. */
  #decorateEditor(): void {
    if (!this.badge || !this.#parent) return;
    const siblings = childrenOf(this.#parent);
    const editor = siblings[siblings.indexOf(this.#holder) - 1] as Rendering | undefined;
    if (!editor || typeof editor.render !== "function") return this.#restoreEditor();
    if (this.#editor?.node === editor) return;
    this.#restoreEditor();
    const render = editor.render;
    const badge = this.badge;
    const live = { on: true };
    const wrapper = (width: number): readonly string[] => {
      const lines = render.call(editor, width);
      if (!live.on) return lines;
      const badged = withBorderBadge(lines, badge());
      this.#badgeDrawn = badged !== lines;
      return badged;
    };
    this.#editor = { node: editor, render, wrapper, live };
    editor.render = wrapper;
  }

  #restoreEditor(): void {
    const editor = this.#editor;
    this.#editor = undefined;
    this.#badgeDrawn = false;
    if (!editor) return;
    // Another extension may have wrapped the render after us: putting the
    // original back would drop its wrapper, so ours only stops badging then.
    editor.live.on = false;
    if (editor.node.render === editor.wrapper) editor.node.render = editor.render;
  }

  #roots(): readonly unknown[] {
    const tui = this.tui as unknown as { getMountedRoots?: () => readonly unknown[] };
    return typeof tui.getMountedRoots === "function" ? tui.getMountedRoots() : childrenOf(this.tui);
  }

  /** Still last after the footer, beside the anchor's container, in a mounted tree. */
  #docked(roots: readonly unknown[]): boolean {
    const parent = this.#parent;
    if (!parent) return false;
    const siblings = childrenOf(parent);
    if (siblings.at(-1) !== this.component || siblings.at(-3) !== this.#holder) return false;
    if (!childrenOf(this.#holder).includes(this.anchor)) return false;
    // A renderer switch remounts Pi's containers in another tree.
    return parent === (this.tui as unknown) || roots.some((root) => root === parent || childrenOf(root).includes(parent));
  }
}
