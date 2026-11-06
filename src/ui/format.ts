import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { truncateStyledText as truncateToWidth } from "./truncate.js";

export const safeText = (value: unknown): string =>
  String(value ?? "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();


export const formatActorDataPreview = (data: unknown, maxChars = 200): string | undefined => {
  if (data === undefined) return undefined;
  const clip = (value: string): string => {
    const safe = safeText(value);
    return safe.length > maxChars ? `${safe.slice(0, Math.max(1, maxChars - 1))}…` : safe;
  };
  if (typeof data === "string") return clip(data);
  if (
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    (data as { fabricTruncated?: unknown }).fabricTruncated === true
  ) {
    const wrapper = data as { preview?: unknown; originalBytes?: unknown };
    const preview = clip(String(wrapper.preview ?? ""));
    const suffix =
      typeof wrapper.originalBytes === "number"
        ? `[truncated from ${wrapper.originalBytes} bytes]`
        : "[truncated]";
    return preview ? `${preview} ${suffix}` : suffix;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(data) ?? String(data);
  } catch {
    serialized = String(data);
  }
  return clip(serialized);
};

/** Empty durations are omitted by UI metric/field renderers. */
export const formatDuration = (milliseconds: number): string => {
  if (!Number.isFinite(milliseconds) || milliseconds < 1_000) return "";
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
};

export const formatTokens = (tokens: number): string => {
  if (tokens < 1_000) return String(Math.max(0, Math.round(tokens)));
  if (tokens < 100_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000).toFixed(0)}k`;
};

export const formatCost = (usd: number): string =>
  usd <= 0 ? "$0" : usd < 0.01 ? `$${usd.toFixed(4)}` : usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;

export const formatClock = (timestamp: number): string =>
  new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const padToWidth = (value: string, width: number): string => {
  const clipped = truncateToWidth(value, Math.max(0, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
};

export const wrapPlainText = (value: string, width: number, maxLines = 100): string[] => {
  const safe = safeText(value);
  if (!safe || width <= 0 || maxLines <= 0) return [];
  const words = safe.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(truncateToWidth(current, width));
    current = word;
    while (visibleWidth(current) > width && lines.length < maxLines) {
      let chunk = "";
      let consumed = 0;
      const segments = [
        ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(current),
      ];
      for (const { segment } of segments) {
        const candidate = chunk + segment;
        if (visibleWidth(candidate) > width) {
          if (!chunk) {
            chunk = "…";
            consumed += segment.length;
          }
          break;
        }
        chunk = candidate;
        consumed += segment.length;
      }
      if (chunk) lines.push(chunk);
      current = current.slice(consumed);
    }
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(truncateToWidth(current, width));
  return lines;
};

type Rgb = readonly [number, number, number];

/** xterm's default 16-colour palette, for borders drawn with basic SGR colours. */
const BASIC: readonly Rgb[] = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

const xterm256 = (index: number): Rgb => {
  if (index < 16) return BASIC[index]!;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return [level, level, level];
  }
  const cube = index - 16;
  const step = (value: number): number => (value === 0 ? 0 : 55 + value * 40);
  return [step(Math.floor(cube / 36)), step(Math.floor(cube / 6) % 6), step(cube % 6)];
};

/** The foreground colour a styled sample is drawn in: its SGR background twin and its RGB. */
const foreground = (sample: string): { background: string; rgb: Rgb } | undefined => {
  for (const match of sample.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const params = (match[1] ?? "").split(";").map(Number);
    for (let index = 0; index < params.length; index++) {
      const code = params[index]!;
      if (code === 38 && params[index + 1] === 2 && params.length >= index + 5) {
        const rgb: Rgb = [params[index + 2]!, params[index + 3]!, params[index + 4]!];
        return { background: `48;2;${rgb.join(";")}`, rgb };
      }
      if (code === 38 && params[index + 1] === 5 && params[index + 2] !== undefined) {
        return { background: `48;5;${params[index + 2]}`, rgb: xterm256(params[index + 2]!) };
      }
      if (code >= 30 && code <= 37) return { background: String(code + 10), rgb: BASIC[code - 30]! };
      if (code >= 90 && code <= 97) return { background: String(code + 10), rgb: BASIC[code - 90 + 8]! };
    }
  }
  return undefined;
};

const luminance = ([red, green, blue]: Rgb): number => {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
};

/**
 * A Claude Code-style badge on the editor border: a block in the border's own
 * colour, which Pi sets from the thinking level, with black or white text,
 * whichever has the higher WCAG contrast. `sample` is any text styled in the
 * border colour; a border drawn without colour gets a plain label, unstyled like it.
 */
export const borderBadge = (sample: string, text: string): string => {
  const label = ` ${stripVTControlCharacters(text)} `;
  const colour = foreground(sample);
  if (!colour) return label;
  const light = luminance(colour.rgb);
  // Contrast ratio (L1 + 0.05) / (L2 + 0.05) against black (L = 0) and white (L = 1).
  const black = (light + 0.05) / 0.05;
  const white = 1.05 / (light + 0.05);
  const ink = black >= white ? "38;2;0;0;0" : "38;2;255;255;255";
  return `\x1b[${colour.background};${ink}m${label}\x1b[0m`;
};
