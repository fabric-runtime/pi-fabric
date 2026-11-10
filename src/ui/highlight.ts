import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { shikiLanguages, shikiThemeType } from "./shiki-catalog.js";
import type { GrammarState, Highlighter } from "shiki";
import { resolveShikiTheme, type ShikiThemeVariant } from "./code-preview.js";
import { resolveShikiThemeObject } from "./shiki-theme.js";
import { resolveShikiLanguageObjects } from "./shiki-language.js";

const configuredMaxHighlightChars = Number.parseInt(
  process.env.CODE_PREVIEW_MAX_HIGHLIGHT_CHARS ?? "",
  10,
);
const MAX_HIGHLIGHT_CHARS =
  Number.isFinite(configuredMaxHighlightChars) && configuredMaxHighlightChars > 0
    ? configuredMaxHighlightChars
    : 80_000;
const configuredFileHighlightMaxSourceChars = Number.parseInt(
  process.env.CODE_PREVIEW_FILE_HIGHLIGHT_MAX_CHARS ?? "",
  10,
);
// Files larger than this never enter full-file tokenization; their previews
// fall back to per-run tokenization. Bounds worst-case background work.
const FILE_HIGHLIGHT_MAX_SOURCE_CHARS =
  Number.isFinite(configuredFileHighlightMaxSourceChars) &&
  configuredFileHighlightMaxSourceChars > 0
    ? configuredFileHighlightMaxSourceChars
    : 200_000;
// One background slice covers ~5-10ms of shiki work on heavy grammars
// (measured ~106ms for a 1.3k-line TS file), keeping each event-loop tick
// well under one frame.
const FILE_HIGHLIGHT_TICK_LINE_BUDGET = 96;
const FILE_HIGHLIGHT_TICK_CHAR_BUDGET = 16_000;
const FILE_HIGHLIGHT_ENTRY_LIMIT = 24;
const FILE_HIGHLIGHT_CHAR_LIMIT = 4_000_000;
// Longer lines render plain. TextMate grammars can be quadratic in one line's
// length: a TypeScript string literal took 75 ms at 2k characters, 1.2 s at
// 8k and 100 s at 80k, in one regex search a time limit cannot interrupt.
const HIGHLIGHT_MAX_LINE_CHARS = 2_000;
const TOKENIZE_OPTIONS = { tokenizeMaxLineLength: HIGHLIGHT_MAX_LINE_CHARS } as const;
const CACHE_LIMIT = 192;
const CACHE_CHAR_LIMIT = 4_000_000;
const PRELOADED_LANGUAGES = [
  "bash",
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "markdown",
  "yaml",
  "toml",
  "css",
] as const;

const LANGUAGE_ALIASES = new Map<string, string>([
  ["sh", "bash"],
  ["shell", "bash"],
  ["zsh", "bash"],
  ["ts", "typescript"],
  ["js", "javascript"],
  ["md", "markdown"],
  ["yml", "yaml"],
  ["py", "python"],
  ["rs", "rust"],
  ["rb", "ruby"],
  ["cs", "csharp"],
  ["fs", "fsharp"],
  ["ps1", "powershell"],
]);

const EXACT_BASENAMES = new Map<string, string>([
  ["dockerfile", "dockerfile"],
  ["makefile", "makefile"],
  ["gnumakefile", "makefile"],
  ["justfile", "makefile"],
  ["procfile", "shellscript"],
  ["gemfile", "ruby"],
  ["rakefile", "ruby"],
  ["cargo.lock", "toml"],
  ["package-lock.json", "json"],
  ["composer.lock", "json"],
  ["pnpm-lock.yaml", "yaml"],
  ["pnpm-lock.yml", "yaml"],
  ["yarn.lock", "yaml"],
]);

const EXTENSION_ALIASES = new Map<string, string>([
  [".ts", "typescript"],
  [".tsx", "tsx"],
  [".js", "javascript"],
  [".jsx", "jsx"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".json", "json"],
  [".md", "markdown"],
  [".markdown", "markdown"],
  [".yml", "yaml"],
  [".yaml", "yaml"],
  [".toml", "toml"],
  [".sh", "bash"],
  [".bash", "bash"],
  [".zsh", "bash"],
  [".css", "css"],
  [".html", "html"],
  [".htm", "html"],
  [".py", "python"],
  [".bend", "bend"],
  [".rs", "rust"],
  [".go", "go"],
  [".rb", "ruby"],
  [".php", "php"],
  [".sql", "sql"],
  [".xml", "xml"],
  [".svg", "xml"],
  [".vue", "vue"],
  [".svelte", "svelte"],
  [".c", "c"],
  [".h", "c"],
  [".cpp", "cpp"],
  [".cc", "cpp"],
  [".hpp", "cpp"],
  [".java", "java"],
  [".kt", "kotlin"],
  [".swift", "swift"],
  [".lua", "lua"],
  [".r", "r"],
  [".scala", "scala"],
  [".clj", "clojure"],
  [".ex", "elixir"],
  [".exs", "elixir"],
  [".erl", "erlang"],
  [".hs", "haskell"],
  [".ml", "ocaml"],
  [".fs", "fsharp"],
  [".fsx", "fsharp"],
  [".cs", "csharp"],
  [".ps1", "powershell"],
  [".graphql", "graphql"],
  [".prisma", "prisma"],
  [".dockerfile", "dockerfile"],
]);

const LOW_CONTRAST_FALLBACK = "\x1b[38;2;139;148;158m";

let highlighter: Highlighter | undefined;
let readyTheme: string | undefined;
let initializingTheme: string | undefined;
let initVersion = 0;
let highlighterGeneration = 0;
let themePreference = "auto";
let observedVariant: ShikiThemeVariant = "dark";
let currentTheme = resolveShikiTheme(themePreference, observedVariant);
let enabled = true;
const loadedLanguages = new Set<string>();
const pendingLanguages = new Set<string>();
const languageLoadCallbacks = new Map<string, Set<() => void>>();
const highlighterReadyCallbacks = new Set<() => void>();
const renderCache = new Map<string, { value: string[]; size: number }>();
let renderCacheChars = 0;

const hashString = (value: string): number => {
  let hash = 5381;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return hash;
};

const escapeControlChars = (text: string): string =>
  text
    .replace(/\x1b/g, "␛")
    .replace(/\r/g, "␍")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "�");

const normalizeLanguage = (language: string): string => {
  const normalized = language.toLowerCase();
  return LANGUAGE_ALIASES.get(normalized) ?? normalized;
};

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const ANSI_16_RGB: readonly Rgb[] = [
  { r: 0, g: 0, b: 0 },
  { r: 205, g: 49, b: 49 },
  { r: 13, g: 161, b: 13 },
  { r: 229, g: 165, b: 10 },
  { r: 36, g: 114, b: 200 },
  { r: 188, g: 63, b: 188 },
  { r: 17, g: 168, b: 205 },
  { r: 229, g: 229, b: 229 },
  { r: 102, g: 102, b: 102 },
  { r: 241, g: 76, b: 76 },
  { r: 35, g: 209, b: 139 },
  { r: 245, g: 245, b: 67 },
  { r: 59, g: 142, b: 234 },
  { r: 214, g: 112, b: 214 },
  { r: 41, g: 184, b: 219 },
  { r: 255, g: 255, b: 255 },
];

export const ansi256ToRgb = (index: number): Rgb => {
  if (index < 16) return ANSI_16_RGB[Math.max(0, index)] ?? { r: 0, g: 0, b: 0 };
  if (index < 232) {
    const cube = index - 16;
    const channel = (value: number): number => (value === 0 ? 0 : 55 + 40 * value);
    return {
      r: channel(Math.floor(cube / 36)),
      g: channel(Math.floor((cube % 36) / 6)),
      b: channel(cube % 6),
    };
  }
  const gray = 8 + 10 * (Math.min(index, 255) - 232);
  return { r: gray, g: gray, b: gray };
};

const parseAnsiBgColor = (sequence: string): Rgb | undefined => {
  const truecolor = sequence.match(/\x1b\[4?8;2;(\d+);(\d+);(\d+)m/);
  if (truecolor) {
    return { r: Number(truecolor[1]), g: Number(truecolor[2]), b: Number(truecolor[3]) };
  }
  const indexed = sequence.match(/\x1b\[4?8;5;(\d+)m/);
  if (indexed) return ansi256ToRgb(Number(indexed[1]));
  return undefined;
};

const relativeLuminance = ({ r, g, b }: Rgb): number =>
  (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** Minimal structural view of Pi's active theme, as handed to renderers. */
export interface PiThemeLike {
  name?: string;
  getBgAnsi?(color: "userMessageBg"): string;
}

/**
 * Classify Pi's active theme as a light or dark variant. Named built-ins are
 * matched directly, custom themes fall back to the luminance of Pi's message
 * background color, and as a last resort COLORFGBG provides a terminal hint.
 */
export const classifyPiTheme = (
  theme: PiThemeLike | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ShikiThemeVariant | undefined => {
  const name = theme?.name?.trim().toLowerCase();
  if (name === "light") return "light";
  if (name === "dark") return "dark";
  const background = theme?.getBgAnsi
    ? parseAnsiBgColor(theme.getBgAnsi("userMessageBg"))
    : undefined;
  if (background) return relativeLuminance(background) >= 0.5 ? "light" : "dark";
  const colorFgBg = env.COLORFGBG;
  if (colorFgBg) {
    const index = colorFgBg
      .split(";")
      .map((part) => Number.parseInt(part, 10))
      .filter((part) => Number.isInteger(part) && part >= 0 && part <= 255)
      .at(-1);
    if (index !== undefined) {
      return relativeLuminance(ansi256ToRgb(index)) >= 0.5 ? "light" : "dark";
    }
  }
  return undefined;
};

const syncEffectiveTheme = (preference: string, variant: ShikiThemeVariant): boolean => {
  themePreference = preference;
  observedVariant = variant;
  const effective = resolveShikiTheme(preference, variant);
  if (effective === currentTheme) return false;
  currentTheme = effective;
  renderCache.clear();
  renderCacheChars = 0;
  resetFileHighlighting();
  if (enabled && (highlighter || initializingTheme)) {
    void initHighlighting(effective, true);
  }
  return true;
};

/**
 * Adopt the variant of the pi theme instance handed to a renderer. When the
 * configured preference follows the variant ("auto" or a "light/dark" pair),
 * the effective shiki theme swaps as Pi auto-switches.
 */
export function observePiTheme(theme: PiThemeLike | undefined): void {
  const variant = classifyPiTheme(theme);
  if (variant) syncEffectiveTheme(themePreference, variant);
}

/** The shiki theme currently used for rendering (after variant resolution). */
export const effectiveShikiTheme = (): string => currentTheme;

/** Whether the effective shiki theme is a light theme. */
export const effectiveShikiThemeIsLight = (): boolean =>
  shikiThemeType(currentTheme) === "light";

/** Pi's most recently observed theme variant. */
export const observedThemeVariant = (): ShikiThemeVariant => observedVariant;

/** Resolve a shiki language id from a file path, or undefined if unsupported. */
export function languageFromPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const name = basename(filePath).toLowerCase();
  if (name.startsWith(".env")) {
    const candidate = "dotenv";
    return candidate in shikiLanguages() ? candidate : undefined;
  }
  if (name === "dockerfile" || name.startsWith("dockerfile.")) {
    return "dockerfile" in shikiLanguages() ? "dockerfile" : undefined;
  }
  const exact = EXACT_BASENAMES.get(name);
  if (exact && exact in shikiLanguages()) return exact;
  const byExt = EXTENSION_ALIASES.get(extname(name));
  return byExt && byExt in shikiLanguages() ? byExt : undefined;
}

/** Configure highlighting without loading Shiki until the first code preview needs it. */
export function configureHighlighting(themePreferenceValue: string, syntaxEnabled = true): void {
  const preference = themePreferenceValue.trim() || "auto";
  const wasEnabled = enabled;
  enabled = syntaxEnabled;
  if (!enabled) {
    themePreference = preference;
    currentTheme = resolveShikiTheme(preference, observedVariant);
    initVersion++;
    initializingTheme = undefined;
    highlighter?.dispose();
    highlighter = undefined;
    readyTheme = undefined;
    highlighterGeneration++;
    loadedLanguages.clear();
    pendingLanguages.clear();
    languageLoadCallbacks.clear();
    highlighterReadyCallbacks.clear();
    renderCache.clear();
    renderCacheChars = 0;
    resetFileHighlighting();
    return;
  }
  const themeChanged = syncEffectiveTheme(preference, observedVariant);
  // syncEffectiveTheme already rebuilds eagerly on a real theme swap and
  // highlightCode's requestInit lazily covers a never-initialized highlighter;
  // the only remaining case that needs an explicit init is re-enabling after
  // a disable disposed the highlighter. Rebuilding unconditionally here cost
  // a full 10-grammar shiki init (~80-260ms of main-thread work) on every
  // /fabric settings save even when nothing display-related had changed.
  if (!themeChanged && !wasEnabled && !highlighter && !initializingTheme) {
    void initHighlighting(currentTheme, syntaxEnabled);
  }
}

/** Initialize (or reinitialize) the shared shiki highlighter. Fire-and-forget safe. */
export async function initHighlighting(theme: string, syntaxEnabled = true): Promise<void> {
  currentTheme = theme;
  enabled = syntaxEnabled;
  if (!enabled) return;
  const version = ++initVersion;
  initializingTheme = theme;
  try {
    // Shiki's default engine is Oniguruma compiled to WebAssembly. Its linear
    // memory only grows: compiling the grammars' scanners took it from 16 MB
    // to 172 MB on ordinary files, held for the life of Pi. The JavaScript
    // engine produced the same tokens on that corpus, in about 53 MB of
    // collectable heap.
    const [{ createHighlighter }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki"),
      import("shiki/engine/javascript"),
    ]);
    // Resolve the theme object from pi-fabric's own module graph and hand
    // createHighlighter the *object*, not a bare id string. Shiki's internal
    // lazy `import("@shikijs/themes/<id>)` for string ids cannot be resolved
    // inside Pi's extension host (issue #46); passing the object sidesteps it.
    const themeObject = await resolveShikiThemeObject(theme);
    if (!themeObject) {
      throw new Error(`Unknown shiki theme: ${theme}`);
    }
    const next = await createHighlighter({
      themes: [themeObject],
      langs: await resolveShikiLanguageObjects(PRELOADED_LANGUAGES),
      // Forgiving: a pattern the engine cannot translate stops matching
      // instead of failing the grammar.
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
    if (version !== initVersion) {
      next.dispose();
      return;
    }
    highlighter?.dispose();
    highlighter = next;
    resetFileHighlighting();
    readyTheme = theme;
    initializingTheme = undefined;
    highlighterGeneration++;
    loadedLanguages.clear();
    for (const lang of PRELOADED_LANGUAGES) loadedLanguages.add(lang);
    notifyReady();
  } catch (error) {
    if (version !== initVersion) return;
    initializingTheme = undefined;
    console.warn("[pi-fabric] Shiki failed to initialize; previews will be plain text.", error);
    highlighter?.dispose();
    highlighter = undefined;
    readyTheme = undefined;
    highlighterGeneration++;
    loadedLanguages.clear();
    highlighterReadyCallbacks.clear();
  }
}

const shouldSkipHighlight = (text: string): boolean => text.length > MAX_HIGHLIGHT_CHARS;

const ansiFg = (hex: string): string => {
  const clean = hex.replace(/^#/, "").slice(0, 6);
  const n = Number.parseInt(clean, 16);
  return Number.isFinite(n)
    ? `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`
    : "";
};

const ansiFromToken = (token: { content: string; color?: string; fontStyle?: number }): string => {
  let open = token.color ? ansiFg(token.color) : "";
  let close = token.color ? "\x1b[39m" : "";
  const fontStyle = token.fontStyle ?? 0;
  if (fontStyle & 2) {
    open += "\x1b[1m";
    close = "\x1b[22m" + close;
  }
  if (fontStyle & 1) {
    open += "\x1b[3m";
    close = "\x1b[23m" + close;
  }
  if (fontStyle & 4) {
    open += "\x1b[4m";
    close = "\x1b[24m" + close;
  }
  return open + escapeControlChars(token.content) + close;
};

const isLowContrastFg = (params: string): boolean => {
  if (params === "30" || params === "90" || params === "38;5;0" || params === "38;5;8") return true;
  if (!params.startsWith("38;2;")) return false;
  const parts = params.split(";").map(Number);
  const r = parts[2];
  const g = parts[3];
  const b = parts[4];
  if (r === undefined || g === undefined || b === undefined) return false;
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return false;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance < 72;
};

const normalizeContrast = (ansi: string): string => {
  if (shikiThemeType(currentTheme) === "light") return ansi;
  return ansi.replace(/\x1b\[([0-9;]*)m/g, (seq, params: string) =>
    isLowContrastFg(params) ? LOW_CONTRAST_FALLBACK : seq,
  );
};

const cacheRendered = (key: string, value: string[]): void => {
  const size = value.reduce((total, line) => total + line.length, 0);
  renderCache.set(key, { value, size });
  renderCacheChars += size;
  while (renderCache.size > CACHE_LIMIT || renderCacheChars > CACHE_CHAR_LIMIT) {
    const first = renderCache.keys().next().value;
    if (first === undefined) break;
    const cached = renderCache.get(first);
    if (cached) renderCacheChars -= cached.size;
    renderCache.delete(first);
  }
};

const requestInit = (invalidate?: () => void): void => {
  if (invalidate) highlighterReadyCallbacks.add(invalidate);
  if (initializingTheme === currentTheme) return;
  void initHighlighting(currentTheme, enabled);
};

const notifyReady = (): void => {
  const callbacks = [...highlighterReadyCallbacks];
  highlighterReadyCallbacks.clear();
  for (const callback of callbacks) {
    try {
      callback();
    } catch {
      // A stale invalidate callback is harmless.
    }
  }
};

const requestLanguageLoad = (lang: string, invalidate?: () => void): void => {
  if (invalidate) {
    const callbacks = languageLoadCallbacks.get(lang) ?? new Set();
    callbacks.add(invalidate);
    languageLoadCallbacks.set(lang, callbacks);
  }
  if (pendingLanguages.has(lang)) return;
  const instance = highlighter;
  if (!instance) return;
  pendingLanguages.add(lang);
  const generation = highlighterGeneration;
  void instance
    // Pass the catalog loader, not an id: locally supplied grammars are not
    // part of Shiki's built-in language registry.
    .loadLanguage(shikiLanguages()[lang]!)
    .then(() => {
      if (generation !== highlighterGeneration) return;
      loadedLanguages.add(lang);
      const callbacks = languageLoadCallbacks.get(lang);
      languageLoadCallbacks.delete(lang);
      for (const callback of callbacks ?? []) {
        try {
          callback();
        } catch {
          // Stale invalidate; ignore.
        }
      }
    })
    .catch(() => {
      if (generation === highlighterGeneration) languageLoadCallbacks.delete(lang);
    })
    .finally(() => {
      if (generation === highlighterGeneration) pendingLanguages.delete(lang);
    });
};

/**
 * Highlight `text` as `lang`, returning per-line truecolor ANSI strings that match
 * pi-code-previews' rendering (same shiki theme + token conversion). Returns null
 * when highlighting is disabled, the language is unsupported, the highlighter is
 * not yet ready, or the content is too large. Pass `invalidate` to request a
 * re-render once the highlighter/language becomes ready.
 */
export function highlightCode(
  text: string,
  lang: string,
  invalidate?: () => void,
): string[] | null {
  if (!enabled || !lang || shouldSkipHighlight(text)) return null;
  // A variant flip restarts initialization with the new theme; while it is in
  // flight the old highlighter cannot serve the current theme. Register the
  // invalidate so the preview repaints once the swap completes.
  if (!highlighter || readyTheme !== currentTheme) {
    requestInit(invalidate);
    return null;
  }
  const shikiLang = normalizeLanguage(lang);
  if (!(shikiLang in shikiLanguages())) return null;
  const cacheKey = `${currentTheme}\0${shikiLang}\0${text.length}\0${hashString(text)}`;
  const cached = renderCache.get(cacheKey);
  if (cached) {
    renderCache.delete(cacheKey);
    renderCache.set(cacheKey, cached);
    return cached.value;
  }
  if (!loadedLanguages.has(shikiLang)) {
    requestLanguageLoad(shikiLang, invalidate);
    return null;
  }
  try {
    const tokens = highlighter.codeToTokensBase(text, {
      lang: shikiLang as never,
      theme: currentTheme as never,
      ...TOKENIZE_OPTIONS,
    });
    const rendered = tokens.map((line) =>
      normalizeContrast(line.map(ansiFromToken).join("")),
    );
    cacheRendered(cacheKey, rendered);
    return rendered;
  } catch {
    return null;
  }
}

interface FileHighlightWaiter {
  to: number;
  invalidate: () => void;
}

interface FileHighlightEntry {
  highlighter: Highlighter;
  lang: string;
  // Present only for disk-backed entries; virtual documents omit both.
  mtimeMs?: number;
  size?: number;
  sourceLines: string[];
  lines: string[];
  state: GrammarState | undefined;
  target: number;
  waiters: FileHighlightWaiter[];
  stale: boolean;
  chars: number;
}

export interface FileHighlightLine {
  raw: string;
  ansi: string;
}

const fileHighlightCache = new Map<string, FileHighlightEntry>();
let fileHighlightChars = 0;
const fileHighlightQueue: FileHighlightEntry[] = [];
let fileHighlightQueueScheduled = false;

const expandFileLineTabs = (text: string): string => text.replace(/\t/g, "    ");

const dropFileHighlightEntry = (key: string, entry: FileHighlightEntry): void => {
  if (fileHighlightCache.get(key) !== entry) return;
  entry.stale = true;
  entry.waiters = [];
  fileHighlightCache.delete(key);
  fileHighlightChars -= entry.chars;
};

const evictFileHighlightCache = (): void => {
  while (
    fileHighlightCache.size > FILE_HIGHLIGHT_ENTRY_LIMIT ||
    fileHighlightChars > FILE_HIGHLIGHT_CHAR_LIMIT
  ) {
    const oldestKey = fileHighlightCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = fileHighlightCache.get(oldestKey);
    if (oldest) dropFileHighlightEntry(oldestKey, oldest);
    else fileHighlightCache.delete(oldestKey);
  }
};

const resetFileHighlighting = (): void => {
  for (const [, entry] of fileHighlightCache) {
    entry.stale = true;
    entry.waiters = [];
  }
  fileHighlightCache.clear();
  fileHighlightQueue.length = 0;
  fileHighlightChars = 0;
};

const fireSatisfiedWaiters = (entry: FileHighlightEntry): void => {
  const covered = entry.lines.length;
  const ready = new Set<() => void>();
  const remaining: FileHighlightWaiter[] = [];
  for (const waiter of entry.waiters) {
    if (waiter.to <= covered) ready.add(waiter.invalidate);
    else remaining.push(waiter);
  }
  entry.waiters = remaining;
  if (ready.size === 0) return;
  queueMicrotask(() => {
    for (const invalidate of ready) {
      try {
        invalidate();
      } catch {
        // A stale invalidate callback is harmless.
      }
    }
  });
};

const advanceFileHighlight = (entry: FileHighlightEntry): void => {
  const instance = highlighter;
  if (!instance || readyTheme !== currentTheme || instance !== entry.highlighter) {
    entry.stale = true;
    return;
  }
  const start = entry.lines.length;
  const hardEnd = Math.min(entry.target, entry.sourceLines.length);
  let end = start;
  let chars = 0;
  const maxEnd = Math.min(start + FILE_HIGHLIGHT_TICK_LINE_BUDGET, hardEnd);
  while (end < maxEnd && chars <= FILE_HIGHLIGHT_TICK_CHAR_BUDGET) {
    chars += (entry.sourceLines[end]?.length ?? 0) + 1;
    end++;
  }
  if (end <= start) return;
  try {
    const tokens = instance.codeToTokensBase(entry.sourceLines.slice(start, end).join("\n"), {
      lang: entry.lang as never,
      theme: currentTheme as never,
      ...TOKENIZE_OPTIONS,
      ...(entry.state ? { grammarState: entry.state } : {}),
    });
    const rendered = tokens.map((line) =>
      normalizeContrast(line.map(ansiFromToken).join("")),
    );
    entry.state = instance.getLastGrammarState(tokens as never);
    entry.lines.push(...rendered);
    const delta = rendered.reduce((total, line) => total + line.length, 0);
    entry.chars += delta;
    fileHighlightChars += delta;
  } catch {
    entry.stale = true;
  }
};

const pumpFileHighlightQueue = (): void => {
  fileHighlightQueueScheduled = false;
  let entry = fileHighlightQueue.shift();
  while (
    entry !== undefined &&
    (entry.stale ||
      entry.highlighter !== highlighter ||
      entry.lines.length >= Math.min(entry.target, entry.sourceLines.length))
  ) {
    if (entry.waiters.length > 0) fireSatisfiedWaiters(entry);
    entry = fileHighlightQueue.shift();
  }
  if (!entry) return;
  advanceFileHighlight(entry);
  if (!entry.stale) {
    fireSatisfiedWaiters(entry);
    // Coverage only progresses while something on screen waits for it; an
    // entry with no waiters parks so idle state never burns CPU.
    if (entry.waiters.length > 0) fileHighlightQueue.push(entry);
  }
  if (fileHighlightQueue.length > 0) {
    fileHighlightQueueScheduled = true;
    setImmediate(pumpFileHighlightQueue);
  }
};

const scheduleFileHighlight = (entry: FileHighlightEntry): void => {
  if (!fileHighlightQueue.includes(entry)) fileHighlightQueue.push(entry);
  if (fileHighlightQueueScheduled) return;
  fileHighlightQueueScheduled = true;
  setImmediate(pumpFileHighlightQueue);
};

/**
 * Highlight a line range of an on-disk file with full grammar state, returning
 * per-line { raw, ansi } entries for 0-based [from, to). `raw` is the
 * tab-expanded source line so callers can verify the rendered content still
 * matches the file. Returns null while coverage has not reached `to` (or when
 * the file is unusable); passing `invalidate` repaints as soon as the range is
 * covered and pumps bounded background tokenization — parked shiki
 * GrammarState, one ~5-10ms slice per event-loop tick, work only while
 * waiters exist.
 */
export function highlightFileLines(
  filePath: string,
  lang: string,
  from: number,
  to: number,
  invalidate?: () => void,
): FileHighlightLine[] | null {
  if (!enabled || !lang || !filePath || to <= from || from < 0) return null;
  if (!highlighter || readyTheme !== currentTheme) {
    requestInit(invalidate);
    return null;
  }
  const shikiLang = normalizeLanguage(lang);
  if (!(shikiLang in shikiLanguages())) return null;
  if (!loadedLanguages.has(shikiLang)) {
    requestLanguageLoad(shikiLang, invalidate);
    return null;
  }
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > FILE_HIGHLIGHT_MAX_SOURCE_CHARS) return null;
  const key = `${currentTheme}\0${shikiLang}\0${filePath}`;
  let entry = fileHighlightCache.get(key);
  if (entry && (entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size)) {
    dropFileHighlightEntry(key, entry);
    entry = undefined;
  }
  if (!entry) {
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
    if (text.includes("\0")) return null;
    const sourceLines = text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map(expandFileLineTabs);
    entry = {
      highlighter,
      lang: shikiLang,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sourceLines,
      lines: [],
      state: undefined,
      target: 0,
      waiters: [],
      stale: false,
      chars: sourceLines.reduce((total, line) => total + line.length, 0),
    };
    fileHighlightCache.set(key, entry);
    fileHighlightChars += entry.chars;
    evictFileHighlightCache();
    if (entry.stale) {
      // Evicted immediately by the char budget; treat as unusable.
      entry.waiters = [];
      return null;
    }
  } else {
    fileHighlightCache.delete(key);
    fileHighlightCache.set(key, entry);
  }
  return fileHighlightRange(entry, from, to, invalidate);
}

/**
 * Highlight a line range of an in-memory document with full grammar state.
 * Shares the disk-backed pump, cache, and budgets; the caller supplies the
 * cache identity via `cacheKey` (already namespaced by theme + language) and
 * the tab-expanded source lines. Returns null while coverage has not reached
 * `to`; passing `invalidate` repaints as soon as the range is covered.
 */
export function highlightSourceLines(
  cacheKey: string,
  sourceLines: string[],
  lang: string,
  from: number,
  to: number,
  invalidate?: () => void,
): FileHighlightLine[] | null {
  if (!enabled || !lang || !cacheKey || to <= from || from < 0) return null;
  if (!highlighter || readyTheme !== currentTheme) {
    requestInit(invalidate);
    return null;
  }
  const shikiLang = normalizeLanguage(lang);
  if (!(shikiLang in shikiLanguages())) return null;
  if (!loadedLanguages.has(shikiLang)) {
    requestLanguageLoad(shikiLang, invalidate);
    return null;
  }
  let entry = fileHighlightCache.get(cacheKey);
  if (!entry) {
    entry = {
      highlighter,
      lang: shikiLang,
      sourceLines,
      lines: [],
      state: undefined,
      target: 0,
      waiters: [],
      stale: false,
      chars: sourceLines.reduce((total, line) => total + line.length, 0),
    };
    fileHighlightCache.set(cacheKey, entry);
    fileHighlightChars += entry.chars;
    evictFileHighlightCache();
    if (entry.stale) {
      entry.waiters = [];
      return null;
    }
  } else {
    fileHighlightCache.delete(cacheKey);
    fileHighlightCache.set(cacheKey, entry);
  }
  return fileHighlightRange(entry, from, to, invalidate);
}

const fileHighlightRange = (
  entry: FileHighlightEntry,
  from: number,
  to: number,
  invalidate?: () => void,
): FileHighlightLine[] | null => {
  const total = entry.sourceLines.length;
  if (from >= total) return null;
  const clampedTo = Math.max(Math.min(to, total), Math.min(from, total));
  entry.target = Math.max(entry.target, clampedTo);
  if (invalidate && entry.lines.length < clampedTo) {
    entry.waiters = entry.waiters.filter((waiter) => waiter.invalidate !== invalidate);
    entry.waiters.push({ to: clampedTo, invalidate });
    scheduleFileHighlight(entry);
  }
  // Coverage past EOF: serve the existing lines rather than wait forever on a
  // target that can never be reached.
  if (entry.lines.length < clampedTo) return null;
  const out: FileHighlightLine[] = [];
  for (let index = from; index < Math.min(to, total); index++) {
    out.push({ raw: entry.sourceLines[index] ?? "", ansi: entry.lines[index] ?? "" });
  }
  return out;
};
