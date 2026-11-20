import { getPngDimensions } from "@earendil-works/pi-tui";

export const isKittyImageLine = (line: string): boolean => line.includes("\x1b_G");
const EMPTY_IMAGE_ROWS: ReadonlySet<number> = new Set<number>();
const MAX_CROP_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_CACHED_CROPS = 2; // Only the top and bottom image can need cropping.

function header(line: string) {
  const start = line.indexOf("\x1b_G");
  if (start < 0) return undefined;
  const end = line.indexOf(";", start);
  if (end < 0) return undefined;
  const controls = line.slice(start + 3, end).split(",");
  const rows = Number(controls.find((control) => control.startsWith("r="))?.slice(2));
  if (!Number.isSafeInteger(rows) || rows <= 0) return undefined;
  return { start, end, controls, rows };
}

type ImageBlock = NonNullable<ReturnType<typeof header>> & { row: number; line: string; heightPx?: number | null };
type CachedCrop = { hidden: number; visible: number; line: string; bytes: number };
export interface KittyViewportFrame {
  lines: string[];
  /** Reserved rows must stay empty so Pi pre-clears them before placing pixels. */
  imageRows: ReadonlySet<number>;
}

/** Index immutable retained frames once. Scrolling then touches only the viewport
 * and its intersecting images, never a long run of offscreen blank reservations.
 * The two-entry, byte-bounded crop cache avoids rebuilding megabyte transmissions
 * on unchanged frames. No image data is decoded, uploaded or deleted here. */
export class KittyViewport {
  private source: readonly string[] | undefined;
  private images: ImageBlock[] = [];
  private readonly crops = new Map<ImageBlock, CachedCrop>();
  private cropBytes = 0;

  clear(): void {
    this.source = undefined;
    this.images = [];
    this.crops.clear();
    this.cropBytes = 0;
  }

  slice(source: readonly string[], start: number, end: number): KittyViewportFrame {
    if (source !== this.source) {
      this.clear();
      this.source = source;
      for (let row = 0; row < source.length; row++) {
        const image = header(source[row]!);
        if (!image) continue;
        this.images.push({ ...image, row, line: source[row]! });
        row += image.rows - 1;
      }
    }
    const lines = source.slice(start, end);
    if (!lines.length || !this.images.length) return { lines, imageRows: EMPTY_IMAGE_ROWS };
    let low = 0;
    let high = this.images.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const image = this.images[middle]!;
      if (image.row + image.rows <= start) low = middle + 1;
      else high = middle;
    }
    let imageRows: Set<number> | undefined;
    for (let index = low; index < this.images.length; index++) {
      const image = this.images[index]!;
      if (image.row >= start + lines.length) break;
      const row = Math.max(0, image.row - start);
      const hidden = Math.max(0, start - image.row);
      const visible = Math.min(image.rows - hidden, lines.length - row);
      const line = this.crop(image, hidden, visible);
      lines[row] = line;
      if (!line) continue;
      imageRows ??= new Set<number>();
      for (let i = row; i < row + visible; i++) imageRows.add(i);
    }
    return { lines, imageRows: imageRows ?? EMPTY_IMAGE_ROWS };
  }

  private crop(image: ImageBlock, hidden: number, visible: number): string {
    if (hidden === 0 && visible === image.rows) return image.line;
    const cached = this.crops.get(image);
    if (cached?.hidden === hidden && cached.visible === visible) return cached.line;
    // Pi's f=100 transmission starts with a PNG header. Read only its first 32
    // base64 characters, not a second Pi installation's image metadata registry.
    if (image.heightPx === undefined) image.heightPx = getPngDimensions(image.line.slice(image.end + 1, image.end + 33))?.heightPx ?? null;
    if (!image.heightPx || !image.controls.includes("f=100") || !image.controls.includes("a=T")) return "";
    const sourceY = Math.floor(image.heightPx * hidden / image.rows);
    const sourceEnd = Math.ceil(image.heightPx * (hidden + visible) / image.rows);
    const controls = image.controls.filter((control) => !/^[yhr]=/.test(control));
    controls.push(`y=${sourceY}`, `h=${Math.max(1, sourceEnd - sourceY)}`, `r=${visible}`);
    const line = `${image.line.slice(0, image.start)}\x1b_G${controls.join(",")};${image.line.slice(image.end + 1)}`;
    if (cached) {
      this.cropBytes -= cached.bytes;
      this.crops.delete(image);
    }
    const bytes = line.length * 2; // conservative UTF-16 storage budget
    if (bytes <= MAX_CROP_CACHE_BYTES) {
      while (this.crops.size >= MAX_CACHED_CROPS || this.cropBytes + bytes > MAX_CROP_CACHE_BYTES) {
        const oldest = this.crops.keys().next().value!;
        this.cropBytes -= this.crops.get(oldest)!.bytes;
        this.crops.delete(oldest);
      }
      this.crops.set(image, { hidden, visible, line, bytes });
      this.cropBytes += bytes;
    }
    return line;
  }
}

/** Hide only background placements that can reach the visible terminal. Leave
 * offscreen scrollback intact; removing it would force unnecessary reuploads on
 * close. Return text-only frames unchanged instead of copying retained history. */
export function hideKittyImages(lines: readonly string[], viewportHeight = lines.length): readonly string[] {
  const start = Math.max(0, lines.length - viewportHeight);
  let result: string[] | undefined;
  const hide = (row: number): void => { result ??= lines.slice(); result[row] = ""; };
  for (let row = start; row < lines.length; row++) if (isKittyImageLine(lines[row]!)) hide(row);
  // An image anchored above the viewport may extend into it through empty rows.
  for (let row = start - 1; row >= 0; row--) {
    const line = lines[row]!;
    if (line === "") continue;
    const image = header(line);
    if (image && row + image.rows > start) hide(row);
    break;
  }
  return result ?? lines;
}
