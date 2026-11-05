import { mkdtemp, rm, writeFile, mkdir, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachPastedImages } from "../src/core/pasted-images.js";
import { fabricExecutionKernelGuidance } from "../src/core/system-guidance.js";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC", "base64");
let root: string;
const file = () => path.join(root, `pi-clipboard-${randomUUID()}.png`);
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "fabric-clipboard-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

it("attaches clipboard bytes to the same input and preserves provenance", async () => {
  const imagePath = file();
  await writeFile(imagePath, PNG);
  const result = await attachPastedImages(`Explain ${imagePath}`, [], root);
  expect(result).toEqual({
    text: `Explain [Attached image: ${imagePath}]`,
    images: [{ type: "image", mimeType: "image/png", data: PNG.toString("base64") }],
    warnings: [], changed: true,
  });
  // Replayed/queued transformed input is not loaded or duplicated again.
  expect(await attachPastedImages(result.text, result.images, root)).toEqual({ ...result, changed: false });
});

it("deduplicates repeated paths, distinct identical files, and existing attachments", async () => {
  const a = file(), b = file();
  await Promise.all([writeFile(a, PNG), writeFile(b, PNG)]);
  const existing = [{ type: "image" as const, mimeType: "image/png", data: PNG.toString("base64") }];
  const snapshot = structuredClone(existing);
  const result = await attachPastedImages(`${a}\n${b}\n${a}`, existing, root);
  expect(result.images).toEqual(existing);
  expect(existing).toEqual(snapshot);
  expect(result.text.match(/\[Attached image:/g)).toHaveLength(3);
  expect(result.warnings).toEqual([]);
});

it.each([false, true])("accepts host-inserted paths with spaces (quoted=%s)", async quoted => {
  const spaced = path.join(root, "user files");
  await mkdir(spaced);
  const a = path.join(spaced, `pi-clipboard-${randomUUID()}.png`);
  await writeFile(a, PNG);
  const result = await attachPastedImages(`Compare ${quoted ? `"${a}"` : a}`, [], spaced);
  expect(result.images).toHaveLength(1);
  expect(result.text).toBe(`Compare [Attached image: ${a}]`);
});

it("sniffs content rather than trusting the filename extension", async () => {
  const a = file().replace(/png$/, "jpeg");
  await writeFile(a, PNG);
  const result = await attachPastedImages(a, [], root);
  expect(result.images[0]?.mimeType).toBe("image/png");
});

it("leaves missing and invalid files as paths with actionable warnings", async () => {
  const missing = file(), invalid = file(), good = file();
  await Promise.all([writeFile(invalid, "not an image"), writeFile(good, PNG)]);
  const result = await attachPastedImages(`${missing} ${invalid} ${good}`, [], root);
  expect(result.images).toHaveLength(1);
  expect(result.text).toContain(`${missing} ${invalid} [Attached image: ${good}]`);
  expect(result.warnings).toHaveLength(2);
  expect(result.warnings.every(warning => warning.includes("path is unchanged"))).toBe(true);
});

it("does not auto-open arbitrary, nested, URL, quoted-code, or already-marked paths", async () => {
  const a = file();
  const nested = path.join(root, "nested", path.basename(a));
  await mkdir(path.dirname(nested));
  await Promise.all([writeFile(a, PNG), writeFile(nested, PNG), writeFile(path.join(root, "screenshot.png"), PNG)]);
  for (const text of [
    path.join(root, "screenshot.png"), nested, `file://${a}`, `https://example.com${a}`,
    `\`${a}\``, `\`\`${a}\`\``, `\`\`\`text\n${a}\n\`\`\``, `\`\`\`\n${a}`,
    `~~~text\n${a}\n~~~`, `    ${a}`, `\t${a}`, `[Attached image: ${a}]`,
  ]) {
    const result = await attachPastedImages(text, [], root);
    expect(result).toEqual({ text, images: [], warnings: [], changed: false });
  }
});

it.skipIf(process.platform === "win32")("refuses symlinks even when their targets are images", async () => {
  const actual = file(), link = file();
  await writeFile(actual, PNG);
  await symlink(actual, link);
  const result = await attachPastedImages(link, [], root);
  expect(result.images).toEqual([]);
  expect(result.text).toBe(link);
  expect(result.warnings[0]).toContain("not a regular clipboard file");
});

it("accepts prose punctuation without swallowing it", async () => {
  const a = file();
  await writeFile(a, PNG);
  const result = await attachPastedImages(`See (${a}), please.`, [], root);
  expect(result.text).toBe(`See ([Attached image: ${a}]), please.`);
});

it("deduplicates equivalent base64 encodings and MIME spelling", async () => {
  const a = file();
  await writeFile(a, PNG);
  const existing = [{ type: "image" as const, mimeType: "IMAGE/PNG; profile=test", data: `\n${PNG.toString("base64")}\n` }];
  const result = await attachPastedImages(a, existing, root);
  expect(result.images).toEqual(existing);
  expect(result.changed).toBe(true);
});

it("refuses hard links to other local files", async () => {
  const a = file(), b = file();
  await writeFile(a, PNG);
  await link(a, b);
  const result = await attachPastedImages(b, [], root);
  expect(result.images).toEqual([]);
  expect(result.warnings[0]).toContain("hard links are refused");
});

it("refuses a file replaced between validation and opening", async () => {
  const a = file(), replacement = file();
  await Promise.all([writeFile(a, PNG), writeFile(replacement, PNG)]);
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.open).mockImplementationOnce(async (name, flags, mode) => {
    await fs.rename(replacement, a);
    return actual.open(name, flags, mode);
  });
  const result = await attachPastedImages(a, [], root);
  expect(result.images).toEqual([]);
  expect(result.warnings[0]).toContain("changed while being opened");
});

it("checks remaining aggregate bytes before reading a second large file", async () => {
  const a = file(), b = file();
  await Promise.all([writeFile(a, PNG), writeFile(b, PNG)]);
  await Promise.all([fs.truncate(a, 17 * 1024 * 1024), fs.truncate(b, 17 * 1024 * 1024)]);
  const result = await attachPastedImages(`${a}\n${b}`, [], root);
  expect(result.images).toHaveLength(1);
  expect(result.warnings[0]).toContain("exceed 32 MiB");
  expect(result.text).toContain(b);
});

it("rejects oversized images before reading their contents", async () => {
  const a = file();
  await writeFile(a, Buffer.alloc(20 * 1024 * 1024 + 1));
  const result = await attachPastedImages(a, [], root);
  expect(result.images).toEqual([]);
  expect(result.warnings[0]).toContain("exceeds 20 MiB");
});

it("bounds image count and leaves excess paths available for explicit read", async () => {
  const paths = Array.from({ length: 9 }, file);
  await Promise.all(paths.map((p, i) => writeFile(p, Buffer.concat([PNG, Buffer.from([i])]))));
  const result = await attachPastedImages(paths.join("\n"), [], root);
  expect(result.images).toHaveLength(8);
  expect(result.warnings).toHaveLength(1);
  expect(result.text).toContain(paths[8]);
  expect(result.text.match(/\[Attached image:/g)).toHaveLength(8);
});

describe("attachment-aware guidance", () => {
  it.each([true, false])("keeps explicit reads but exempts already attached content (fullCodeMode=%s)", full => {
    const guidance = fabricExecutionKernelGuidance(full);
    expect(guidance).toContain(full ? "`pi.read`" : "`read`");
    expect(guidance).toContain("without reading the path again");
    expect(guidance).toContain("If image content is unavailable, say so");
    expect(guidance).not.toContain("Read every file");
  });
});
