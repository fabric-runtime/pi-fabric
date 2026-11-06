import { StringDecoder } from "node:string_decoder";

export interface ShellMonitorOptions {
  delivery: "ui" | "wake";
  timeoutMs: number;
  intervalMs: number;
  match?: string;
}

export interface ShellMonitorBatch {
  lines: string[];
  omitted: number;
}

/** Lines retained per delivery interval for replay; older lines in a burst are coalesced. */
export const SHELL_MONITOR_INTERVAL_LINES = 256;
/** Newest previews carried by an agent-facing monitor event. */
export const SHELL_MONITOR_PREVIEWS = 8;

export const shellMonitorSchema = {
  type: "object", additionalProperties: false, required: ["delivery"],
  properties: {
    delivery: { type: "string", enum: ["ui", "wake"], description: "ui only updates task inspection; wake also delivers bounded events to the owning agent (may use LLM turns)." },
    timeoutMs: { type: "integer", minimum: 1000, maximum: 1800000, description: "Monitor lifetime, default 5 minutes, maximum 30 minutes. No automatic renewal." },
    intervalMs: { type: "integer", minimum: 1000, maximum: 60000, description: "Minimum event batch interval, default 5 seconds. Not a shell polling interval." },
    match: { type: "string", minLength: 1, maxLength: 256, description: "Optional case-sensitive literal substring filter on bounded output lines (not a regex)." },
  },
};

export function parseShellMonitor(value: unknown): ShellMonitorOptions | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("monitor must be an object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !Object.hasOwn(shellMonitorSchema.properties, key))) throw new Error("Unknown monitor option");
  if (input.delivery !== "ui" && input.delivery !== "wake") throw new Error('monitor.delivery must explicitly be "ui" or "wake"');
  const integer = (key: string, fallback: number, max: number): number => {
    const n = input[key] ?? fallback;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1000 || n > max) throw new Error(`monitor.${key} must be an integer from 1000 to ${max}`);
    return n;
  };
  if (input.match !== undefined && (typeof input.match !== "string" || !input.match.length || input.match.length > 256)) throw new Error("monitor.match must be a nonempty literal string of at most 256 characters");
  return { delivery: input.delivery, timeoutMs: integer("timeoutMs", 300000, 1800000), intervalMs: integer("intervalMs", 5000, 60000),
    ...(typeof input.match === "string" ? { match: input.match } : {}) };
}

/** Bounded, incremental line framing. No inference, regexes, or per-poll model calls. */
export class ShellMonitor {
  readonly #decoder = new StringDecoder("utf8");
  #line = "";
  #truncated = false;
  #previous: string | undefined;
  #lines: string[] = [];
  #omitted = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(readonly options: ShellMonitorOptions, readonly emit: (batch: ShellMonitorBatch) => void) {}

  append(data: Buffer): void {
    if (this.#closed) return;
    // Decode in bounded pieces even when an operations adapter hands us a huge buffer.
    for (let offset = 0; offset < data.length; offset += 4096) this.#accept(this.#decoder.write(data.subarray(offset, offset + 4096)));
  }

  #accept(text: string): void {
    const parts = text.split("\n");
    for (const [index, part] of parts.entries()) {
      const available = Math.max(0, 2048 - this.#line.length);
      if (part.length > available) this.#truncated = true;
      this.#line += part.slice(0, available);
      if (index < parts.length - 1) this.#endLine();
    }
  }

  #endLine(): void {
    const line = this.#line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
    const truncated = this.#truncated;
    this.#line = "";
    this.#truncated = false;
    if (!line || (this.options.match && !line.includes(this.options.match)) || line === this.#previous) return;
    this.#previous = line;
    const preview = line.slice(0, 480) + (truncated || line.length > 480 ? " [line truncated]" : "");
    if (this.#lines.length === SHELL_MONITOR_INTERVAL_LINES) { this.#lines.shift(); this.#omitted++; }
    this.#lines.push(preview);
    if (!this.#timer) {
      this.#timer = setTimeout(() => { this.#timer = undefined; this.#flush(); }, this.options.intervalMs);
      this.#timer.unref?.();
    }
  }

  #flush(): void {
    if (!this.#lines.length) return;
    const batch = { lines: this.#lines, omitted: this.#omitted };
    this.#lines = [];
    this.#omitted = 0;
    this.emit(batch);
  }

  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#flush();
  }

  close(flush = true): void {
    if (this.#closed) return;
    if (flush) {
      this.#accept(this.#decoder.end());
      this.#endLine();
    }
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (flush) this.#flush();
    this.#line = "";
    this.#lines = [];
  }
}
