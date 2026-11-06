import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";

// Only Pi's generated clipboard files, directly in the OS temp directory.
// Arbitrary paths (even other temp images) remain explicit read operations.
const CLIPBOARD_NAME = /^pi-clipboard-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp)$/i;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGES = 8;
const fingerprint = (image: ImageContent) => {
  const mime = image.mimeType.split(";")[0]!.trim().toLowerCase().replace(/^image\/jpg$/, "image/jpeg");
  return createHash("sha256").update(mime).update("\0").update(Buffer.from(image.data, "base64")).digest("hex");
};

export interface PastedImageResult {
  text: string;
  images: ImageContent[];
  warnings: string[];
  changed: boolean;
}

function sniffImage(bytes: Buffer): string | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR") return "image/png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[3] !== 247) return "image/jpeg";
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

async function readClipboardImage(file: string, root: string, remainingBytes: number): Promise<ImageContent> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("not a regular clipboard file (symlinks and hard links are refused)");
  if (path.dirname(await realpath(file)) !== root) throw new Error("clipboard file is outside the temporary directory");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1 || opened.mtimeMs !== stat.mtimeMs || opened.size !== stat.size || path.dirname(await realpath(file)) !== root) throw new Error("clipboard file changed while being opened");
    if (opened.size <= 0 || opened.size > MAX_FILE_BYTES) throw new Error("clipboard image is empty or exceeds 20 MiB");
    if (opened.size > remainingBytes) throw new Error("auto-attached images exceed 32 MiB");
    // Bounded even if a file grows while being read. A sentinel byte detects it.
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error("clipboard file changed while being read");
    const body = bytes.subarray(0, length);
    const mimeType = sniffImage(body);
    if (!mimeType) throw new Error("unsupported clipboard image format");
    return { type: "image", mimeType, data: body.toString("base64") };
  } finally {
    await handle.close();
  }
}

// Conservative Markdown masking: fenced code (backticks or tildes), inline
// backtick spans of any delimiter length, indented code, and provenance labels.
function excludedImageRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let fence: { char: string; count: number; start: number } | undefined;
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!line[0]) continue;
    const start = line.index!, end = start + line[0].length;
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line[0]);
    if (fence) {
      if (delimiter?.[1]?.[0] === fence.char && delimiter[1].length >= fence.count && line[0].slice(delimiter[0].length).trim() === "") {
        ranges.push([fence.start, end]); fence = undefined;
      }
    } else if (delimiter?.[1]) {
      fence = { char: delimiter[1][0]!, count: delimiter[1].length, start };
    } else if (/^(?: {4}|\t)/.test(line[0])) ranges.push([start, end]);
  }
  if (fence) ranges.push([fence.start, text.length]);
  const inRange = (start: number, end: number) => ranges.some(([a, b]) => start < b && end > a);
  const ticks = [...text.matchAll(/`+/g)];
  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i]!;
    if (inRange(tick.index!, tick.index! + tick[0].length)) continue;
    const close = ticks.findIndex((candidate, j) => j > i && candidate[0].length === tick[0].length && !inRange(candidate.index!, candidate.index! + candidate[0].length));
    if (close >= 0) { ranges.push([tick.index!, ticks[close]!.index! + ticks[close]![0].length]); i = close; }
  }
  for (const marker of text.matchAll(/\[Attached image: [^\]\r\n]*\]/g)) ranges.push([marker.index!, marker.index! + marker[0].length]);
  return ranges;
}

/** Submit-time ingestion only. The host normalizes image dimensions and payload
 * sizes after input transforms; handoff consumes those same normalized blocks.
 * No persistent cache, speculative reads, SDK load, or model calls live here. */
export async function attachPastedImages(
  text: string,
  existing: readonly ImageContent[] = [],
  temporaryDirectory = tmpdir(),
): Promise<PastedImageResult> {
  const result: PastedImageResult = { text, images: [...existing], warnings: [], changed: false };
  const excluded = excludedImageRanges(text);
  const candidates: Array<{ start: number; end: number; file: string }> = [];
  // Match the known temp prefix, not whitespace-delimited tokens: Pi inserts
  // unquoted paths, including spaces in Windows profile/temp directories.
  const prefix = path.join(temporaryDirectory, "pi-clipboard-").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const paths = new RegExp(prefix + "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.(?:png|jpe?g|gif|webp)", "gi");
  for (const match of text.matchAll(paths)) {
    let start = match.index!, end = start + match[0].length;
    if (excluded.some(([from, to]) => start < to && end > from)) continue;
    const before = text[start - 1], after = text[end];
    if ((before && /[\w:/\\.-]/.test(before)) || (after && /[\w/\\-]/.test(after))) continue;
    const file = match[0];
    if (!path.isAbsolute(file) || !CLIPBOARD_NAME.test(path.basename(file))) continue;
    if (before && (before === '"' || before === "'") && after === before) { start--; end++; }
    candidates.push({ start, end, file });
  }
  if (!candidates.length) return result;
  let root: string;
  try { root = await realpath(temporaryDirectory); } catch { return result; }
  const hashes = new Set(existing.map(fingerprint));
  const attached = new Set<string>();
  const failed = new Set<string>();
  let totalBytes = existing.reduce((sum, image) => sum + Buffer.byteLength(image.data, "base64"), 0);
  for (const { file } of candidates) {
    if (attached.has(file) || failed.has(file)) continue;
    try {
      if (result.images.length >= MAX_IMAGES) throw new Error("at most 8 images can be auto-attached to one message");
      const image = await readClipboardImage(file, root, MAX_MESSAGE_BYTES - totalBytes);
      const hash = fingerprint(image);
      if (!hashes.has(hash)) {
        const size = Buffer.byteLength(image.data, "base64");
        if (totalBytes + size > MAX_MESSAGE_BYTES) throw new Error("auto-attached images exceed 32 MiB");
        result.images.push(image);
        hashes.add(hash);
        totalBytes += size;
      }
      attached.add(file);
    } catch (error) {
      failed.add(file);
      result.warnings.push(`Could not attach ${file}: ${error instanceof Error ? error.message : String(error)}. The path is unchanged; use read to inspect it.`);
    }
  }
  // Replace backwards so offsets still refer to the submitted text.
  for (const candidate of candidates.reverse()) {
    if (!attached.has(candidate.file)) continue;
    result.text = result.text.slice(0, candidate.start) + `[Attached image: ${candidate.file}]` + result.text.slice(candidate.end);
    result.changed = true;
  }
  return result;
}
