import { acceptMemoryChunk, type TextRange } from "./policy.js";

/** Check the actual outgoing page against the selected normalized source, after
 * all envelope trimming. Source observation/hashing and lineage selection remain
 * host responsibilities; ranges are checked by the compiled gdp-wired kernel. */
export const acceptsExpansionPage = (
  records: readonly Record<string, unknown>[],
  source: readonly { index: number; text: string }[],
  entryOffset: number,
  textOffset: number,
  cursor: { position: number; textOffset: number },
): boolean => {
  if (![entryOffset, textOffset, cursor.position, cursor.textOffset].every((n) => Number.isSafeInteger(n) && n >= 0)) return false;
  let position = entryOffset;
  let offset = textOffset;
  for (const record of records) {
    const entry = source[position];
    const range = record.textRange as TextRange | undefined;
    if (!entry || record.index !== entry.index || typeof record.text !== "string" || !range ||
        !acceptMemoryChunk(range, record.text.length, offset, entry.text.length) ||
        record.text !== entry.text.slice(range.start, range.end)) return false;
    if (range.complete) {
      position++;
      offset = 0;
    } else {
      offset = range.end;
    }
  }
  return position === cursor.position && offset === cursor.textOffset &&
    (records.length > 0 || position === source.length);
};
