import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { hideKittyImages } from "./kitty-viewport.js";

type OverlayEntry = { component: Component; focusOrder: number };
type Compositor = {
  overlayStack: OverlayEntry[];
  isOverlayVisible(entry: OverlayEntry): boolean;
  compositeOverlays(lines: readonly string[], width: number, height: number): readonly string[];
  compositeLineAt(base: string, overlay: string, column: number, width: number, totalWidth: number): string;
};
const leases = new WeakMap<object, { count: number; restore(): void }>();

/** Pi 1.0's compositor returns a base image instead of the overlay, and pads
 * full-width image reservations into text. There is no public compositor hook.
 * Lease only these two host prototype methods while a Fabric overlay is open;
 * native layout, focus, visibility, image deletion and upload caches still own
 * the frame. Resolve through the supplied live proxy, never import another TUI.
 * Background layers deliberately hide images rather than trying to z-order
 * terminal graphics against text. The native diff restores them on close. */
export function retainImageSafeOverlays(tui: TUI): () => void {
  let prototype = Object.getPrototypeOf(tui) as object | null;
  while (prototype && !Object.hasOwn(prototype, "compositeOverlays")) prototype = Object.getPrototypeOf(prototype) as object | null;
  if (!prototype) return () => {};
  const host = prototype as Compositor;
  if (typeof host.compositeOverlays !== "function" || typeof host.compositeLineAt !== "function" ||
    typeof host.isOverlayVisible !== "function") return () => {};
  let lease = leases.get(prototype);
  if (!lease) {
    const original = host.compositeOverlays;
    const originalLine = host.compositeLineAt;
    const composite: Compositor["compositeOverlays"] = function (this: Compositor, lines, width, height) {
      const visible = this.overlayStack.filter((entry) => this.isOverlayVisible(entry))
        .sort((a, b) => a.focusOrder - b.focusOrder);
      if (!visible.length) return original.call(this, lines, width, height);
      const restore: (() => void)[] = [];
      try {
        for (const entry of visible.slice(0, -1)) {
          const component = entry.component;
          // Wrap the stack slot, not the component: third-party components may
          // be frozen or use private fields, and must keep their render receiver.
          entry.component = {
            render: (columns) => hideKittyImages(component.render(columns)),
            invalidate: () => component.invalidate(),
          };
          restore.push(() => { entry.component = component; });
        }
        return original.call(this, hideKittyImages(lines, height), width, height);
      } finally {
        for (const undo of restore.reverse()) undo();
      }
    };
    const compositeLine: Compositor["compositeLineAt"] = function (this: Compositor, base, overlay, column, width, totalWidth) {
      // Avoid padding image reservations or passing control payloads through
      // text slicing. A full-width overlay replaces the entire terminal row.
      if (column === 0 && width === totalWidth) return overlay;
      return originalLine.call(this, base, overlay, column, width, totalWidth);
    };
    host.compositeOverlays = composite;
    host.compositeLineAt = compositeLine;
    lease = { count: 0, restore: () => {
      if (host.compositeOverlays === composite) host.compositeOverlays = original;
      if (host.compositeLineAt === compositeLine) host.compositeLineAt = originalLine;
    } };
    leases.set(prototype, lease);
  }
  lease.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--lease.count === 0) {
      lease.restore();
      leases.delete(prototype);
    }
  };
}

type CustomComponent = Component & { dispose?(): void };
export async function imageSafeCustom<T>(
  ui: ExtensionContext["ui"],
  factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => CustomComponent | Promise<CustomComponent>,
  options?: Parameters<ExtensionContext["ui"]["custom"]>[1],
): Promise<T> {
  let release: (() => void) | undefined;
  try {
    return await ui.custom<T>((tui, theme, keys, done) => {
      release = retainImageSafeOverlays(tui);
      return factory(tui, theme, keys, done);
    }, options);
  } finally {
    release?.();
  }
}
