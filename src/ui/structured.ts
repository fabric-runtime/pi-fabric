import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { FabricResultFormat } from "../config.js";
import { countNewlines } from "../util.js";

const require = createRequire(import.meta.url);
let yaml: typeof import("yaml") | undefined;

const normalizeJsonValue = (value: unknown): unknown | undefined => {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : (JSON.parse(serialized) as unknown);
  } catch {
    return undefined;
  }
};

export const formatJsonAsYaml = (value: unknown): string | undefined => {
  const normalized = normalizeJsonValue(value);
  if (normalized === undefined) return undefined;
  // Compiled Bun hosts need the extension loader to resolve bare package names.
  return (yaml ??= require(fileURLToPath(import.meta.resolve("yaml"))) as typeof import("yaml")).stringify(normalized, { indent: 2, lineWidth: 0 }).trimEnd();
};

export interface FormattedFabricValue {
  text: string;
  language?: "yaml" | "json";
  highlightedLineCount?: number;
}

interface HoistedSection {
  path: string;
  text: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// YAML literal block scalars must indent their content, so every multi-line
// string serialized inside a structure is displayed with extra leading
// whitespace on each line. Agents transcribe that corrupted indentation into
// exact-match consumers (pi.edit oldText) and the match fails. Hoist
// multi-line strings out of the YAML skeleton into raw sections so the
// model-bound text preserves the original bytes.
const hoistMultilineStrings = (
  value: unknown,
  path: string,
  sections: HoistedSection[],
  seen: Set<unknown>,
  sectionByText: Map<string, string>,
): unknown => {
  if (typeof value === "string") {
    if (!value.includes("\n")) return value;
    const priorPath = sectionByText.get(value);
    if (priorPath !== undefined) return `<multi-line string, see section: ${priorPath}>`;
    sectionByText.set(value, path);
    sections.push({ path, text: value });
    return `<multi-line string, see section: ${path}>`;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular reference]";
    seen.add(value);
    const skeleton = value.map((item, index) =>
      hoistMultilineStrings(item, `${path}[${index}]`, sections, seen, sectionByText),
    );
    seen.delete(value);
    return skeleton;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return "[circular reference]";
    seen.add(value);
    const skeleton: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      skeleton[key] = hoistMultilineStrings(
        item,
        path ? `${path}.${key}` : key,
        sections,
        seen,
        sectionByText,
      );
    }
    seen.delete(value);
    return skeleton;
  }
  return value;
};

const boundedSection = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  if (maxChars <= 0) return "";
  let omitted = value.length - maxChars;
  let marker = `…[${omitted} chars omitted]…`;
  for (let pass = 0; pass < 2; pass++) {
    omitted = value.length - Math.max(0, maxChars - marker.length);
    marker = `…[${omitted} chars omitted]…`;
  }
  if (marker.length >= maxChars) return marker.slice(0, maxChars);
  const available = maxChars - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
};

const fairSectionBudgets = (lengths: number[], budget: number): number[] => {
  const budgets = Array.from({ length: lengths.length }, () => 0);
  const pending = lengths.map((length, index) => ({ length, index }))
    .sort((left, right) => left.length - right.length);
  let remaining = Math.max(0, budget);
  for (let position = 0; position < pending.length; position++) {
    const item = pending[position]!;
    const share = Math.floor(remaining / (pending.length - position));
    const allocated = Math.min(item.length, share);
    budgets[item.index] = allocated;
    remaining -= allocated;
  }
  return budgets;
};

const renderHoistedSections = (
  yaml: string,
  sections: HoistedSection[],
  maxChars?: number,
): string => {
  const headers = sections.map((section) => `--- ${section.path} (${section.text.length} chars) ---\n`);
  const separators = sections.length * 2;
  const fixedChars = yaml.length + separators + headers.reduce((sum, header) => sum + header.length, 0);
  const fullChars = fixedChars + sections.reduce((sum, section) => sum + section.text.length, 0);
  const budgets = maxChars !== undefined && fullChars > maxChars
    ? fairSectionBudgets(sections.map((section) => section.text.length), maxChars - fixedChars)
    : sections.map((section) => section.text.length);
  const raw = sections
    .map((section, index) => `${headers[index]}${boundedSection(section.text, budgets[index]!)}`)
    .join("\n\n");
  return `${yaml}\n\n${raw}`;
};

export const formatFabricValue = (
  value: unknown,
  format: FabricResultFormat,
  maxChars?: number,
): FormattedFabricValue => {
  if (value === undefined) return { text: "" };
  if (format === "text" && typeof value === "object" && value !== null && "text" in value) {
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string") return { text };
  }
  if (typeof value === "string") return { text: value };
  if (format === "auto" || format === "yaml") {
    const sections: HoistedSection[] = [];
    const skeleton = hoistMultilineStrings(value, "", sections, new Set(), new Map());
    const yaml = formatJsonAsYaml(skeleton);
    if (yaml !== undefined) {
      if (sections.length === 0) return { text: yaml, language: "yaml" };
      // Highlight only the YAML skeleton. Raw sections preserve exact bytes when
      // they fit; oversized batches share the model-visible budget across every
      // section instead of allowing middle sections to disappear globally.
      return {
        text: renderHoistedSections(yaml, sections, maxChars),
        language: "yaml",
        highlightedLineCount: countNewlines(yaml) + 1,
      };
    }
  }
  try {
    return {
      text: JSON.stringify(value, null, format === "json" ? 2 : 0),
      ...(format === "json" ? { language: "json" as const } : {}),
    };
  } catch {
    return { text: String(value) };
  }
};
