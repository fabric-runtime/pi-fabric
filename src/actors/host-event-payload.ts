import { createHash } from "node:crypto";
// Base64 and image-block heuristics are shared with the fabric_exec media
// sanitizer so both channels agree on what counts as a payload.
import { isImageContent, looksLikeBase64 } from "../core/media-sanitize.js";
import type { ImageContent } from "@earendil-works/pi-ai";

interface FabricActorHostMediaDescriptor {
  type: "image";
  mediaIndex: number;
  mimeType: string;
}

export interface PreparedFabricActorHostPayload {
  payload: unknown;
  images: ImageContent[];
  media: FabricActorHostMediaDescriptor[];
}

const normalizedKey = (key: string): string =>
  key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");

const isSensitiveKey = (key: string): boolean => {
  const normalized = normalizedKey(key);
  return [
    "password",
    "passwd",
    "secret",
    "token",
    "accesstoken",
    "refreshtoken",
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "apikey",
    "privatekey",
    "clientsecret",
  ].some((sensitive) => normalized === sensitive || normalized.endsWith(sensitive));
};

const redactInlineSecrets = (value: string): string =>
  value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, "Basic [redacted]")
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(
      /\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Api-Key)\s*:\s*[^\r\n;]+/gi,
      "$1: [redacted]",
    )
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[redacted]@");


interface SanitizedFabricActorHostValue {
  json: string;
  images: ImageContent[];
  media: FabricActorHostMediaDescriptor[];
}

// Redacts secrets, replaces media with descriptors and breaks cycles. The
// returned JSON text is always parseable.
const sanitizeFabricActorHostValue = (value: unknown): SanitizedFabricActorHostValue => {
  const images: ImageContent[] = [];
  const media: FabricActorHostMediaDescriptor[] = [];
  const imageIndexes = new Map<string, number>();
  const seen = new WeakSet<object>();
  let json: string;

  try {
    const serialized = JSON.stringify(value, (key, nested) => {
      if (key && isSensitiveKey(key)) return "[redacted]";
      if (isImageContent(nested)) {
        const sha256 = createHash("sha256")
          .update(nested.mimeType)
          .update("\0")
          .update(nested.data)
          .digest("hex");
        let mediaIndex = imageIndexes.get(sha256);
        if (mediaIndex === undefined) {
          mediaIndex = images.length;
          imageIndexes.set(sha256, mediaIndex);
          images.push({ type: "image", data: nested.data, mimeType: nested.mimeType });
          media.push({ type: "image", mediaIndex, mimeType: nested.mimeType });
        }
        return {
          type: "image",
          mediaIndex,
          mimeType: nested.mimeType,
          redacted: true,
        };
      }
      if (
        typeof nested === "object" &&
        nested !== null &&
        !Array.isArray(nested) &&
        (nested as { type?: unknown }).type === "image"
      ) {
        return {
          type: "image",
          ...(typeof (nested as { mimeType?: unknown }).mimeType === "string"
            ? { mimeType: (nested as { mimeType: string }).mimeType }
            : {}),
          redacted: true,
        };
      }
      if (typeof nested === "string") {
        if (looksLikeBase64(nested)) return "[omitted base64]";
        return redactInlineSecrets(nested);
      }
      if (typeof nested === "bigint") return String(nested);
      if (typeof nested === "function" || typeof nested === "symbol") return undefined;
      if (typeof nested === "object" && nested !== null) {
        if (seen.has(nested)) return "[circular or repeated reference]";
        seen.add(nested);
      }
      return nested;
    });
    json = serialized ?? "null";
  } catch {
    json = JSON.stringify(String(value));
  }
  return { json, images, media };
};

// Generic event payloads keep the tail of their JSON text when over budget;
// an unparseable tail is delivered as a plain string.
export const prepareFabricActorHostPayload = (
  value: unknown,
  maxChars: number,
): PreparedFabricActorHostPayload => {
  const sanitized = sanitizeFabricActorHostValue(value);
  const { images, media } = sanitized;
  let { json } = sanitized;
  if (json.length > maxChars) json = json.slice(json.length - maxChars);
  let payload: unknown;
  try {
    payload = JSON.parse(json) as unknown;
  } catch {
    payload = json;
  }
  return { payload, images, media };
};

export interface PreparedFabricActorContextPayload {
  digest: Record<string, unknown>;
  transcript: unknown[];
}

const ELLIPSIS = "\u2026";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Called only when the digest alone exceeds the budget. Drops trailing array
// entries first, then cuts the longest strings with an ellipsis, and marks the
// digest `truncated: true`. Numbers and booleans are kept. When even the empty
// skeleton exceeds maxChars, the skeleton is returned over budget.
const shrinkActorDigest = (
  digest: Record<string, unknown>,
  maxChars: number,
  size: (digest: Record<string, unknown>) => number,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...digest, truncated: true };
  for (const key of Object.keys(out)) {
    const value = out[key];
    if (!Array.isArray(value)) continue;
    const items = [...value];
    out[key] = items;
    while (items.length > 0 && size(out) > maxChars) items.pop();
    if (size(out) <= maxChars) return out;
  }
  const originals = new Map<string, { text: string; kept: number }>();
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === "string") originals.set(key, { text: value, kept: value.length });
  }
  for (;;) {
    const over = size(out) - maxChars;
    if (over <= 0) return out;
    let longest: string | undefined;
    for (const [key, state] of originals) {
      if (state.kept > 0 && (!longest || state.kept > originals.get(longest)!.kept)) longest = key;
    }
    if (!longest) return out;
    const state = originals.get(longest)!;
    const cut = state.kept === state.text.length ? state.kept - over - 1 : state.kept - over;
    let kept = Math.max(0, Math.min(state.kept - 1, cut));
    // Never split a surrogate pair: a lone surrogate serializes as a 6-char escape.
    if (kept > 0 && /[\uD800-\uDBFF]/.test(state.text.charAt(kept - 1))) kept--;
    state.kept = kept;
    out[longest] = kept > 0 ? state.text.slice(0, kept) + ELLIPSIS : "";
  }
};

/**
 * Bounds an actor context by structure, never by cutting JSON text, so the
 * digest always survives as an object. Over budget, the oldest transcript
 * entries are dropped first. If the digest alone exceeds the budget, the
 * transcript is empty and the digest is shortened by `shrinkActorDigest`.
 */
export const prepareFabricActorContextPayload = (
  context: { digest: object; transcript: readonly unknown[] },
  maxChars: number,
): PreparedFabricActorContextPayload => {
  const sanitized = JSON.parse(
    sanitizeFabricActorHostValue({ digest: context.digest, transcript: context.transcript }).json,
  ) as unknown;
  const record = isRecord(sanitized) ? sanitized : {};
  const digest = isRecord(record.digest) ? record.digest : {};
  const entries: unknown[] = Array.isArray(record.transcript) ? record.transcript : [];
  const size = (d: Record<string, unknown>, transcript: readonly unknown[]): number =>
    JSON.stringify({ digest: d, transcript }).length;
  if (size(digest, entries) <= maxChars) return { digest, transcript: entries };

  // Keep the newest entries that fit; each costs its JSON text plus a comma.
  let used = size(digest, []);
  let start = entries.length;
  while (start > 0) {
    const cost = JSON.stringify(entries[start - 1]).length + (start < entries.length ? 1 : 0);
    if (used + cost > maxChars) break;
    used += cost;
    start--;
  }
  if (used <= maxChars) return { digest, transcript: entries.slice(start) };
  return { digest: shrinkActorDigest(digest, maxChars, (d) => size(d, [])), transcript: [] };
};
