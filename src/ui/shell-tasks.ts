import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { FabricShellJobInfo, FabricShellJobStore } from "../core/shell-jobs.js";
import { formatDuration, padToWidth, safeText, wrapPlainText } from "./format.js";
import { spinnerFrame } from "./spinner.js";

export interface ShellTasksOptions {
  jobs: FabricShellJobStore;
  theme: Theme;
  done: () => void;
  requestRender: () => void;
  rows: () => number;
  keys?: KeybindingsManager;
  id: string;
}

const elapsed = (job: FabricShellJobInfo): string => formatDuration((job.finishedAt ?? Date.now()) - job.startedAt) || "0s";
const outputLine = (line: string): string => stripVTControlCharacters(line)
  .replace(/\t/g, "  ").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

/** Lazy single-task detail. Task selection belongs to the footer list. */
export class ShellTasksView implements Component {
  #pageSize = 1;
  #output = "";
  #scroll = 0;
  #stopArmed: number | undefined;
  #reading = false;
  #readAgain = false;
  #closed = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #unsubscribe: () => void;

  constructor(readonly options: ShellTasksOptions) {
    this.#refresh();
    this.#unsubscribe = options.jobs.subscribe(event => {
      if (event.job.id !== options.id) return;
      this.#refresh();
      void this.#read();
    });
    void this.#read();
  }

  #refresh(): void {
    if (this.#closed) return;
    const job = this.options.jobs.get(this.options.id)?.info();
    const active = job !== undefined && job.finishedAt === undefined;
    // Frames sample the selected task's live tail, never disk logs.
    if (active && !this.#timer) {
      this.#timer = setInterval(() => this.options.requestRender(), 250);
      this.#timer.unref?.();
    } else if (!active && this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.options.requestRender();
  }

  async #read(): Promise<void> {
    if (this.#closed) return;
    if (this.#reading) { this.#readAgain = true; return; }
    const job = this.options.jobs.get(this.options.id);
    if (!job) { this.#output = "Task no longer retained."; return; }
    this.#reading = true;
    try {
      const output = await job.outputText();
      if (!this.#closed) this.#output = output;
    } catch (error) {
      if (!this.#closed) this.#output = `Output unavailable: ${safeText(error instanceof Error ? error.message : error)}`;
    } finally {
      this.#reading = false;
      if (!this.#closed) {
        this.options.requestRender();
        if (this.#readAgain) { this.#readAgain = false; void this.#read(); }
      }
    }
  }

  handleInput(data: string): void {
    if (this.#closed) return;
    const keys = this.options.keys ?? getKeybindings();
    if (keys.matches(data, "tui.select.cancel")) { this.dispose(); this.options.done(); return; }
    if (data === "x") {
      const now = Date.now();
      const job = this.options.jobs.get(this.options.id);
      if (job && !job.finished) {
        if (this.#stopArmed !== undefined && now - this.#stopArmed < 3000) { job.stop(); this.#stopArmed = undefined; }
        else this.#stopArmed = now;
      }
    } else {
      this.#stopArmed = undefined;
      if (keys.matches(data, "tui.select.up")) this.#scroll++;
      if (keys.matches(data, "tui.select.down")) this.#scroll = Math.max(0, this.#scroll - 1);
      if (keys.matches(data, "tui.select.pageUp")) this.#scroll += this.#pageSize;
      if (keys.matches(data, "tui.select.pageDown")) this.#scroll = Math.max(0, this.#scroll - this.#pageSize);
      if (data === "G") this.#scroll = 0;
    }
    this.options.requestRender();
  }

  #status(job: FabricShellJobInfo): string {
    const failed = job.status === "failed" || job.status === "timed_out";
    const active = job.finishedAt === undefined;
    const color = job.stopping ? "warning" : active ? "accent" : failed ? "error" : job.status === "exited" ? "success" : "dim";
    const glyph = active ? spinnerFrame() : failed ? "✗" : job.status === "exited" ? "✓" : "■";
    const status = job.observes ? (job.stopping ? "stopping observation" : active ? "observing" : job.status === "timed_out" ? "observation expired" : job.status === "killed" ? "observation stopped" : "observation ended") : job.stopping ? "stopping" : job.status;
    return this.options.theme.fg(color, `${glyph} ${status}`);
  }

  #section(label: string, width: number): string {
    const title = truncateToWidth(` ${label} `, width);
    return this.options.theme.fg("borderMuted", title + "─".repeat(Math.max(0, width - visibleWidth(title))));
  }

  #detail(job: FabricShellJobInfo, width: number, height: number): string[] {
    const { theme } = this.options;
    const meta = [
      theme.fg("accent", safeText(job.description || job.command)),
      theme.fg("dim", `${job.lastOutputAt !== undefined ? `last output ${formatDuration(Date.now() - job.lastOutputAt) || "0s"} ago` : "no output yet"}${job.pid ? ` · pid ${job.pid}` : ""}`),
      theme.fg("muted", `cwd: ${safeText(job.cwd ?? "unknown")}`),
      theme.fg("dim", `Log: ${safeText(job.logPath ?? "available after backgrounding")}`),
    ];
    if (job.durable) meta.push(theme.fg("muted", `Durable: jev-fabric ${job.durable.jobId ? `job ${safeText(job.durable.jobId)}` : "job starting"}${job.durable.adopted ? " · reattached" : ""} · survives Pi exit`));
    if (job.monitor) {
      meta.push(theme.fg("muted", `Monitor: ${job.monitor.delivery === "wake" ? "wake owning agent" : "UI only"} · deadline ${formatDuration(job.monitor.timeoutMs)} · ${job.eventCount} events`));
      if (job.lastEvent) meta.push(theme.fg("dim", `Latest event: ${safeText(job.lastEvent.lines.at(-1))}`));
    }
    if (job.observes) {
      const target = job.observes.kind === "task" ? this.options.jobs.get(job.observes.id)?.info() : undefined;
      meta.splice(1, 0,
        theme.fg("muted", `Target: ${job.observes.kind} ${safeText(target?.description ?? job.observes.id)}${target ? ` · ${target.status}` : ""}`),
        theme.fg("dim", "Stopping observation leaves the target running."));
      if (job.finishedAt === undefined && job.monitor) meta.splice(3, 0,
        theme.fg("dim", `Observation expires in ${formatDuration(Math.max(0, job.startedAt + job.monitor.timeoutMs - Date.now())) || "0s"}`));
    }
    const rows = meta.slice(0, Math.max(0, height - 6));
    if (height >= 5) {
      rows.push(this.#section("Command", width));
      const commandSpace = Math.max(1, Math.min(3, height - rows.length - 4));
      const command = wrapPlainText(job.command.slice(0, 12000), width, commandSpace + 1);
      const clipped = command.length > commandSpace || job.command.length > 12000;
      rows.push(...command.slice(0, commandSpace).map(line => theme.fg("muted", line)));
      if (clipped) rows[rows.length - 1] = theme.fg("dim", truncateToWidth("… command clipped · tasks.get for full text", width));
    }
    const available = Math.max(1, height - rows.length - 1);
    // append() intentionally emits no store event for every output chunk.
    const text = job.finishedAt === undefined ? this.options.jobs.get(job.id)?.snapshotText(8000) ?? "" : this.#output;
    const output = text ? text.split("\n").flatMap(line => wrapTextWithAnsi(outputLine(line), width)) : [job.finishedAt === undefined ? "Waiting for output…" : "No output captured."];
    this.#scroll = Math.min(this.#scroll, Math.max(0, output.length - available));
    const end = output.length - this.#scroll;
    const start = Math.max(0, end - available);
    this.#pageSize = available;
    rows.push(this.#section(`Output · ${this.#scroll ? `${start + 1}–${end}/${output.length}` : "tail"} · bounded`, width));
    rows.push(...output.slice(start, end).map(line => theme.fg("toolOutput", line)));
    return rows.slice(0, height);
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const { theme } = this.options;
    const height = Math.max(1, Math.floor(this.options.rows() * 0.8));
    const job = this.options.jobs.get(this.options.id)?.info();
    const active = job !== undefined && job.finishedAt === undefined;
    const armed = active && this.#stopArmed !== undefined && Date.now() - this.#stopArmed < 3000;
    const stopLabel = job?.observes ? "stop watching" : "stop";
    const hint = armed ? `${job?.observes ? "Press x again to stop watching; target continues" : "Press x again to stop this task"} · esc close`
      : width < 70 ? `↑↓ · G tail${active ? ` · x×2 ${stopLabel}` : ""} · esc`
      : `↑↓/pg scroll · G tail${active ? ` · x twice ${stopLabel}` : ""} · esc close`;
    const title = `Fabric · ${job?.observes ? "observation" : "task"} ${this.options.id}`;
    if (width < 8 || height < 7) return [title, hint].slice(0, height).map(row => truncateToWidth(row, width));
    const inner = width - 4;
    const border = (text: string) => theme.fg("borderMuted", text);
    const row = (text: string) => `${border("│")} ${padToWidth(text, inner)} ${border("│")}`;
    const heading = truncateToWidth(title, width - 6);
    const top = border("╭─") + ` ${theme.fg("accent", heading)} ` + border("─".repeat(Math.max(0, width - visibleWidth(heading) - 6)) + "─╮");
    const summary = job ? `${this.#status(job)} · Elapsed ${elapsed(job)}${!job.observes && job.exitCode !== undefined ? ` · exit ${job.exitCode}` : ""}` : "Task no longer retained.";
    const bodyHeight = height - 6;
    const body = job ? this.#detail(job, inner, bodyHeight) : ["Task no longer retained."];
    while (body.length < bodyHeight) body.push("");
    const separator = border(`├${"─".repeat(width - 2)}┤`);
    return [top, row(summary), separator, ...body.map(row), separator, row(theme.fg(armed ? "warning" : "dim", hint)), border(`╰${"─".repeat(width - 2)}╯`)];
  }

  invalidate(): void { /* Theme and width are evaluated on every render. */ }
  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#unsubscribe();
  }
}
