import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Keep entry identities, parent links and the authoritative JSONL untouched.
// Only immutable, inactive historical message payloads become read-through.
const MIN_PAGE_BYTES = 16 * 1024;
const openArchives = new Set<PayloadArchive>();
let exitCleanupInstalled = false;

class PayloadArchive {
  readonly directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-history-"));
  readonly file = path.join(this.directory, "payloads.jsonl");
  fd: number | undefined;
  offset = 0;
  owners = 1;
  closed = false;

  constructor() {
    try { this.fd = fs.openSync(this.file, "wx+", 0o600); }
    catch (error) { fs.rmSync(this.directory, { recursive: true, force: true }); throw error; }
    openArchives.add(this);
    if (!exitCleanupInstalled) {
      exitCleanupInstalled = true;
      process.once("exit", () => { for (const archive of openArchives) archive.close(); });
    }
  }

  write(json: string): { offset: number; bytes: number } {
    if (this.closed || this.fd === undefined) throw new Error("Historical payload archive is closed for writing");
    const data = Buffer.from(json, "utf8");
    const offset = this.offset;
    let written = 0;
    while (written < data.length) {
      const count = fs.writeSync(this.fd, data, written, data.length - written, offset + written);
      if (count === 0) throw new Error("Could not write historical payload archive");
      written += count;
    }
    this.offset += written;
    return { offset, bytes: written };
  }

  read(slot: { offset: number; bytes: number }): unknown {
    if (this.closed) throw new Error("Historical payload archive is closed");
    const held = this.fd;
    const fd = held ?? fs.openSync(this.file, "r");
    try {
      const data = Buffer.allocUnsafe(slot.bytes);
      let read = 0;
      while (read < data.length) {
        const count = fs.readSync(fd, data, read, data.length - read, slot.offset + read);
        if (count === 0) throw new Error("Historical payload archive is incomplete");
        read += count;
      }
      return JSON.parse(data.toString("utf8")) as unknown;
    } finally { if (held === undefined) fs.closeSync(fd); }
  }

  finishWrites(): void {
    const fd = this.fd;
    this.fd = undefined;
    try { if (fd !== undefined) fs.closeSync(fd); } finally { this.release(); }
  }

  release(): void { if (--this.owners === 0) this.close(); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    openArchives.delete(this);
    try { if (this.fd !== undefined) fs.closeSync(this.fd); } catch { /* finalizer/exit cleanup is best effort */ }
    this.fd = undefined;
    try { fs.rmSync(this.directory, { recursive: true, force: true }); } catch { /* never throw from a finalizer */ }
  }
}

// No entry/message references in holdings: a cached entry remains readable
// after session replacement; its archive is released once the entries are GC'd.
const releaseArchive = new FinalizationRegistry<PayloadArchive>(archive => archive.release());
function installPayload(owner: object, key: string, value: string | object, enumerable: boolean, writable: boolean, archive: PayloadArchive, slot: { offset: number; bytes: number }): void {
  const objectValue = typeof value === "object";
  // Objects retain identity while a reader holds them. Primitive strings need
  // a weak box; metadata readers never touch this accessor in the first place.
  let live = new WeakRef(objectValue ? value : { value });
  Object.defineProperty(owner, key, {
    configurable: true,
    enumerable,
    get() {
      let cached = live.deref();
      if (cached === undefined) {
        const decoded = archive.read(slot);
        cached = objectValue ? decoded as object : { value: decoded };
        live = new WeakRef(cached);
      }
      return objectValue ? cached : (cached as { value: unknown }).value;
    },
    ...(writable ? { set(replacement: unknown) {
      Object.defineProperty(owner, key, { value: replacement, configurable: true, enumerable, writable });
    } } : {}),
  });
  archive.owners++;
  releaseArchive.register(owner, archive);
}

export interface HistoryPagingResult { entries: number; bytes: number }

/** Invoked at actual turn/compaction boundaries, never registration or idle boot.
 * Cooperative work keeps abort from waiting for a full historical scan/write. */
export async function pageSessionHistory(
  manager: ExtensionContext["sessionManager"],
  signal?: AbortSignal,
): Promise<HistoryPagingResult> {
  const result = { entries: 0, bytes: 0 };
  if (signal?.aborted || typeof manager.buildContextEntries !== "function" || typeof manager.getEntries !== "function") return result;
  const active = new Set(manager.buildContextEntries().map(entry => entry.id));
  const entries = manager.getEntries();
  let archive: PayloadArchive | undefined;
  let yieldedAt = performance.now();
  try {
    for (let index = 0; index < entries.length; index++) {
      if (signal?.aborted) break;
      const entry = entries[index]!;
      if (entry.type === "message" && !active.has(entry.id)) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, "message");
        // Keep the message itself resident: role/usage/timestamp scans (TPS,
        // accounting, tree metadata) must never hydrate the body as a side effect.
        if (descriptor && "value" in descriptor && descriptor.value && typeof descriptor.value === "object") {
          const message = descriptor.value as object;
          let paged = false;
          for (const [key, field] of Object.entries(Object.getOwnPropertyDescriptors(message))) {
            if (!field.configurable || !field.enumerable || !("value" in field)) continue;
            const value: unknown = field.value;
            if (typeof value === "string") {
              if (value.length < MIN_PAGE_BYTES / 4) continue;
            } else if (typeof value === "object" && value !== null) {
              const prototype = Object.getPrototypeOf(value);
              if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) continue;
            } else continue;
            let json: string | undefined;
            try { json = JSON.stringify(value); } catch { /* keep non-JSON state in memory */ }
            if (json === undefined || Buffer.byteLength(json, "utf8") < MIN_PAGE_BYTES) continue;
            if (typeof value === "object" && json[0] !== "{" && json[0] !== "[") continue;
            archive ??= new PayloadArchive();
            const slot = archive.write(json);
            installPayload(message, key, value, field.enumerable === true, field.writable === true, archive, slot);
            paged = true;
            result.bytes += slot.bytes;
          }
          if (paged) result.entries++;
        }
      }
      if (index % 32 === 31 || performance.now() - yieldedAt >= 8) {
        await new Promise<void>(resolve => setImmediate(resolve));
        yieldedAt = performance.now();
      }
    }
  } finally { archive?.finishWrites(); }
  return result;
}
