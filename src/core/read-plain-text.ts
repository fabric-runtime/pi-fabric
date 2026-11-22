/**
 * Plain file text for `pi.read` when the effective read tool supplies it.
 *
 * An anchor-aware read override (pi-hashline-edit-pro) shows the model
 * `anchor│content` rows in `content`, and gives scripts the raw text in
 * `structuredContent`: a string, or an object with a string `text`. Programs
 * need the file, not the display rows. A read that was cut keeps a numeric
 * `Use offset=N` continuation notice so truncation never becomes silent.
 *
 * Returns undefined when the result carries no plain text (built-in images,
 * redacted results whose structuredContent was cleared): the caller keeps the
 * display text. Redaction stays authoritative because a content-only
 * tool_result patch clears structuredContent before this runs.
 */
// Each notice is a whole line of its own: a file row that merely contains the
// text (an anchored row starts with `anchor│`) never matches.
const SHOWING_HINT = /^\[Showing lines (\d+)-(\d+) of (\d+)( \([^)\]]*\))?\. Use offset=[^\s\]]+ to continue\.\]$/gm;
const MORE_LINES_HINT = /^\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/gm;
const BEYOND_EOF = /^Offset \d+ is beyond end of file/;

const lastMatch = (pattern: RegExp, text: string): RegExpExecArray | undefined => {
  let last: RegExpExecArray | undefined;
  for (const match of text.matchAll(pattern)) last = match as RegExpExecArray;
  return last;
};

/**
 * The blocks the tool appended after the file rows. File rows never contain a
 * blank line (a blank file line is shown as `anchor│`), so the rows are the
 * first block and every later block, split at a blank line, is tool-generated.
 * A display that starts with no row (nothing was read) is all notice.
 */
const trailingNotices = (display: string): string => {
  const [first = "", ...rest] = display.split("\n\n");
  return first.split("\n", 1)[0]!.includes("│") ? rest.join("\n\n") : display;
};

/** The continuation notice in the display text, rewritten to a numeric offset. */
export const readContinuationNotice = (display: string): string | undefined => {
  const notices = trailingNotices(display);
  const showing = lastMatch(SHOWING_HINT, notices);
  if (showing) {
    const [, start, end, total, size = ""] = showing;
    return `[Showing lines ${start}-${end} of ${total}${size}. Use offset=${Number(end) + 1} to continue.]`;
  }
  return lastMatch(MORE_LINES_HINT, notices)?.[0];
};

const withNotice = (text: string, notice: string | undefined): string =>
  notice === undefined || text.endsWith(notice) ? text : `${text}${text ? "\n\n" : ""}${notice}`;

export const readPlainText = (display: string, structured: unknown): string | undefined => {
  let text: string;
  let cut: boolean | undefined;
  let nextOffset: number | undefined;
  if (typeof structured === "string") {
    text = structured;
  } else if (structured && typeof structured === "object" && !Array.isArray(structured)
    && typeof (structured as { text?: unknown }).text === "string") {
    const record = structured as { text: string; truncated?: unknown; nextOffset?: unknown };
    text = record.text;
    cut = record.truncated === true || typeof record.nextOffset === "number";
    if (typeof record.nextOffset === "number") nextOffset = record.nextOffset;
  } else {
    return undefined;
  }
  // An out-of-range offset has no file text; keep the tool's explanation.
  if (text === "" && BEYOND_EOF.test(display)) return display;
  const notice = readContinuationNotice(display);
  if (notice) return withNotice(text, notice);
  if (cut) {
    return withNotice(text, nextOffset !== undefined
      ? `[Read truncated. Use offset=${nextOffset} to continue.]`
      : "[Read truncated; the text above is incomplete.]");
  }
  return text;
};
