import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SelectList, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { FabricPermissionQueue, FabricPermissionRecord } from "../core/permission-queue.js";
import { imageSafeCustom } from "./image-overlays.js";

// Never interpret terminal escapes from a classifier reason or tool metadata.
const text = (value: string): string => value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const stateLabel = (record: FabricPermissionRecord): string => ({
  pending: "blocked", allowed: "approved", denied: "denied", used: "used", expired: "expired",
})[record.status];

/** No hover descriptions: a compact queue, then an explicit detail view before
 * any approval. Details scroll independently and never displace the footer. */
export class FabricPermissionsComponent {
  #list: SelectList;
  #records: FabricPermissionRecord[] = [];
  #detailId: string | undefined;
  #scroll = 0;
  #error = "";
  #listHeight = 0;
  readonly decisions: FabricPermissionRecord[] = [];

  constructor(
    readonly theme: Theme,
    readonly queue: FabricPermissionQueue,
    readonly done: () => void,
    readonly height: () => number = () => 24,
  ) {
    this.#list = this.#createList();
  }

  #createList(selectedId?: string): SelectList {
    this.#records = this.queue.list();
    this.#listHeight = this.height();
    const list = new SelectList(this.#records.map(record => ({
      value: record.id,
      label: `${stateLabel(record).padEnd(9)} ${text(record.ref)}  ·  ${record.risk}`,
    })), Math.max(1, Math.min(10, this.height() - 8)), {
      selectedPrefix: value => this.theme.fg("accent", value),
      selectedText: value => this.theme.fg("accent", value),
      description: value => value,
      scrollInfo: value => this.theme.fg("muted", value),
      noMatch: value => this.theme.fg("muted", value),
    });
    const selectedIndex = this.#records.findIndex(record => record.id === selectedId);
    if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
    list.onSelect = item => { this.#detailId = item.value; this.#scroll = 0; };
    list.onCancel = this.done;
    return list;
  }

  #refresh(): void { this.#list = this.#createList(this.#list.getSelectedItem()?.value); }
  invalidate(): void { this.#list.invalidate(); }

  handleInput(data: string): void {
    this.#error = "";
    if (matchesKey(data, "r")) { this.#refresh(); return; }
    if (!this.#detailId) { this.#list.handleInput(data); return; }
    if (matchesKey(data, Key.escape)) { this.#detailId = undefined; this.#refresh(); return; }
    if (matchesKey(data, Key.up)) { this.#scroll = Math.max(0, this.#scroll - 1); return; }
    if (matchesKey(data, Key.down)) { this.#scroll++; return; }
    if (matchesKey(data, "a") || matchesKey(data, "d")) {
      try {
        this.decisions.push(this.queue.decide(this.#detailId, matchesKey(data, "a") ? "allowed" : "denied"));
        this.#detailId = undefined;
        this.#refresh();
      } catch (error) { this.#error = error instanceof Error ? error.message : String(error); }
    }
  }

  render(width: number): string[] {
    const theme = this.theme;
    const rows = Math.max(8, this.height());
    if (this.#listHeight !== this.height()) this.#refresh();
    const bodyWidth = Math.max(1, width - 2);
    const line = "─".repeat(Math.max(0, width));
    const header = theme.bold(theme.fg("accent", "Permissions")) + theme.fg("muted", `  ${this.queue.pendingCount} blocked`);
    let body: string[];
    let hint: string;
    const record = this.#detailId ? this.queue.list().find(item => item.id === this.#detailId) : undefined;
    if (record) {
      const content = [
        `${text(record.ref)}  ·  ${record.risk}  ·  ${stateLabel(record)}`,
        record.id,
        `Directory: ${text(record.cwd)}`,
        "",
        ...wrapTextWithAnsi(text(record.reason), bodyWidth),
        "",
        "Arguments · preview",
        ...text(record.preview).split("\n").flatMap(value => wrapTextWithAnsi(value, bodyWidth)),
      ];
      const visible = Math.max(1, rows - 4);
      this.#scroll = Math.min(this.#scroll, Math.max(0, content.length - visible));
      body = content.slice(this.#scroll, this.#scroll + visible);
      while (body.length < visible) body.push("");
      hint = record.status === "pending" ? "a allow once · d deny · ↑↓ scroll · esc back" : "↑↓ scroll · esc back";
    } else {
      body = this.#records.length ? this.#list.render(bodyWidth) : ["No blocked calls."];
      hint = "↑↓ select · enter review · r refresh · esc close";
    }
    if (this.#error) body[body.length - 1] = theme.fg("error", text(this.#error));
    return [header, theme.fg("border", line), ...body.map(value => ` ${value}`), theme.fg("border", line), theme.fg("muted", hint)]
      .map(value => truncateToWidth(value, width));
  }
}

export async function openFabricPermissions(
  context: ExtensionContext,
  queue: FabricPermissionQueue,
): Promise<FabricPermissionRecord[]> {
  const decisions: FabricPermissionRecord[] = [];
  if (!context.hasUI) {
    context.ui.notify(`${queue.pendingCount} blocked calls; open /fabric permissions in an interactive session.`, "info");
    return decisions;
  }
  if (context.mode === "tui") {
    await imageSafeCustom<void>(context.ui, (tui, theme, _keys, done) => {
      const component = new FabricPermissionsComponent(theme, queue, () => { decisions.push(...component.decisions); done(); },
        () => Math.max(8, Math.floor(tui.terminal.rows * 0.85)));
      return { render: width => component.render(width), invalidate: () => component.invalidate(),
        handleInput: data => { component.handleInput(data); tui.requestRender(); } };
    }, { overlay: true, overlayOptions: { width: "94%", maxHeight: "90%", anchor: "bottom-center", margin: 1 } });
  } else {
    while (true) {
      const pending = queue.list().filter(record => record.status === "pending");
      if (!pending.length) break;
      const rows = pending.map(record => `${record.ref} · ${record.risk} · ${record.id.slice(-8)}`);
      const selected = await context.ui.select("Permissions", [...rows, "Done"]);
      const record = pending[rows.indexOf(selected ?? "")];
      if (!record) break;
      const answer = await context.ui.select(`${record.ref}\n${text(record.reason)}\n${text(record.preview)}`, ["Allow once", "Deny", "Back"]);
      if (answer !== "Allow once" && answer !== "Deny") continue;
      try { decisions.push(queue.decide(record.id, answer === "Allow once" ? "allowed" : "denied")); }
      catch (error) { context.ui.notify(error instanceof Error ? error.message : String(error), "warning"); }
    }
  }
  context.ui.setStatus("fabric-permissions", queue.pendingCount ? `${queue.pendingCount} blocked · /fabric permissions` : undefined);
  return decisions;
}
