import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { safeText } from "./format.js";

/** Window and tab chrome clips titles far earlier than the transcript does. */
export const MAX_TERMINAL_TITLE_CHARS = 120;

/**
 * A terminal title is written as one raw OSC string, so it cannot carry the
 * transcript's styling: theme escapes would render as literal glyphs in the
 * tab. `safeText` also keeps a declared display name from smuggling control
 * characters into the terminal.
 */
export const terminalTitleText = (value: string | undefined): string => {
  const text = safeText(value);
  if (text.length <= MAX_TERMINAL_TITLE_CHARS) return text;
  return `${Array.from(text).slice(0, MAX_TERMINAL_TITLE_CHARS - 1).join("").trimEnd()}…`;
};

/** Session entry that carries the latest declared display title across resumes. */
export const TERMINAL_TITLE_ENTRY_TYPE = "pi-fabric-terminal-title";

type TitleEntryHost = Pick<ExtensionAPI, "appendEntry">;

/**
 * The title this session recorded last. Entries are branch-aware, so a session
 * fork carries the title its branch last declared.
 */
const recordedTitle = (context: ExtensionContext): string | undefined => {
  // A host that emits a boundary without a readable session still owns the
  // window; a missing entry list simply means nothing was recorded yet.
  const entries = context.sessionManager?.getEntries?.() ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== TERMINAL_TITLE_ENTRY_TYPE) continue;
    const recorded = (entry.data as { title?: unknown } | undefined)?.title;
    const text = typeof recorded === "string" ? terminalTitleText(recorded) : "";
    if (text) return text;
  }
  return undefined;
};

/**
 * Keeps the declared `fabric_exec` display title in the terminal chrome. The
 * title is sticky by design: it holds until the next declared title, outlives
 * the run that set it, and is adopted again when the session is resumed. Nested
 * call detail never reaches the window, because the declared milestone is the
 * one line a tab has room for.
 *
 * The title lives in memory while the session runs. Only a resume needs it
 * from disk, so one entry is written when the session shuts down, and only
 * when the title differs from the one last recorded.
 */
export class FabricTerminalTitle {
  readonly #host: TitleEntryHost;
  readonly #enabled: () => boolean;
  #title: string | undefined;
  #recorded: string | undefined;

  constructor(host: TitleEntryHost, enabled: () => boolean) {
    this.#host = host;
    this.#enabled = enabled;
  }

  /** Adopt the title this session recorded, after Pi applies its own. */
  resume(context: ExtensionContext): void {
    if (!this.#enabled()) return;
    // A title declared in this process is newer than anything on disk: it is
    // recorded only at shutdown, so an entry here can only be older.
    if (this.#title) {
      this.#write(context, this.#title);
      return;
    }
    const recorded = recordedTitle(context);
    if (!recorded) return;
    this.#title = recorded;
    this.#recorded = recorded;
    this.#write(context, recorded);
  }

  /** Show the declared display title for a run; `flush` records it for resumes. */
  show(context: ExtensionContext, title: string | undefined): void {
    if (!this.#enabled()) return;
    const text = terminalTitleText(title);
    if (!text || text === this.#title) return;
    this.#title = text;
    this.#write(context, text);
  }

  /** Record the held title once, for the next resume, if it changed. */
  flush(): void {
    if (!this.#enabled() || !this.#title || this.#title === this.#recorded) return;
    try {
      this.#host.appendEntry(TERMINAL_TITLE_ENTRY_TYPE, { version: 1, title: this.#title });
      this.#recorded = this.#title;
    } catch {
      // A session that refuses the entry still showed the live title.
    }
  }

  /** Put the sticky title back after Pi rewrites its own. */
  reassert(context: ExtensionContext): void {
    if (!this.#enabled() || !this.#title) return;
    this.#write(context, this.#title);
  }

  /** The title currently held, for callers that need to compare. */
  current(): string | undefined {
    return this.#title;
  }

  #write(context: ExtensionContext, text: string): void {
    // Only an interactive host owns an OS window title.
    if (context.mode !== "tui" || !context.hasUI) return;
    try {
      context.ui.setTitle(text);
    } catch {
      // A closed or redirected terminal must not fail the run.
    }
  }
}

/**
 * Re-adopt the recorded title whenever Pi re-applies its own: on session start
 * and branch switches, and again after a rename or a settled turn. Both are
 * deferred one macrotask because Pi titles the window after the extension
 * handlers for the same event have run.
 */
export const installTerminalTitle = (pi: ExtensionAPI, title: FabricTerminalTitle): void => {
  const later = (action: (context: ExtensionContext) => void) =>
    (_event: unknown, context: ExtensionContext | undefined): void => {
      if (!context) return;
      // Deferred work must never surface as an unhandled rejection: the title
      // is decoration, and the run it belongs to has already finished.
      setImmediate(() => {
        try {
          action(context);
        } catch {
          // Ignore.
        }
      });
    };
  pi.on("session_start", later((context) => title.resume(context)));
  pi.on("session_tree", later((context) => title.resume(context)));
  pi.on("session_info_changed", later((context) => title.reassert(context)));
  pi.on("agent_settled", later((context) => title.reassert(context)));
  // Synchronous: Pi disposes the session right after its shutdown handlers.
  pi.on("session_shutdown", () => {
    try {
      title.flush();
    } catch {
      // Ignore: the title is decoration.
    }
  });
};
