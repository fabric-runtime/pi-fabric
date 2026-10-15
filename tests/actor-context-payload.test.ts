import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareFabricActorContextPayload } from "../src/actors/host-event-payload.js";
import { ActorDirectory } from "../src/actors/directory.js";
import { CapturedToolCatalog } from "../src/capture/catalog.js";
import { normalizeFabricConfig } from "../src/config.js";
import { FabricRuntimeState } from "../src/fabric-runtime-state.js";

const digest = {
  filesTouched: ["src/actors/context.ts", "src/fabric-runtime-state.ts"],
  openErrors: 2,
  lastError: "TypeError: cannot read properties of undefined",
  lastUserRequest: "keep the actor digest when the session grows long",
};

const entry = (index: number): string =>
  `user: transcript entry ${String(index).padStart(2, "0")} ${"x".repeat(80)}`;
const transcript = Array.from({ length: 30 }, (_, index) => entry(index));

describe("prepareFabricActorContextPayload", () => {
  it("drops the oldest transcript entries and keeps the digest intact when over budget", () => {
    const newestFive = transcript.slice(-5);
    // Room for the digest plus exactly five entries: one more entry costs ~100 chars.
    const maxChars = JSON.stringify({ digest, transcript: newestFive }).length + 50;
    expect(JSON.stringify({ digest, transcript }).length).toBeGreaterThan(maxChars);

    const prepared = prepareFabricActorContextPayload({ digest, transcript }, maxChars);

    const encoded = JSON.stringify(prepared);
    expect(encoded.length).toBeLessThanOrEqual(maxChars);
    expect(JSON.parse(encoded)).toEqual({ digest, transcript: newestFive });
  });

  it("returns an under-budget context unchanged", () => {
    const small = { digest, transcript: transcript.slice(0, 3) };
    const prepared = prepareFabricActorContextPayload(small, 40_000);
    expect(prepared).toEqual(small);
    expect(prepared.digest).not.toHaveProperty("truncated");
  });

  it("still redacts secrets in the digest and transcript", () => {
    const prepared = prepareFabricActorContextPayload(
      {
        digest: { ...digest, lastUserRequest: "use Bearer abcdefghijklmnop.qrstuv please" },
        transcript: ["bash: curl -H 'Authorization: token-should-not-persist'"],
      },
      40_000,
    );
    const encoded = JSON.stringify(prepared);
    expect(encoded).not.toContain("abcdefghijklmnop");
    expect(encoded).not.toContain("token-should-not-persist");
    expect(prepared.digest.lastUserRequest).toBe("use Bearer [redacted] please");
  });

  it("empties the transcript, then drops trailing files, and marks a digest larger than the budget", () => {
    const files = Array.from(
      { length: 30 },
      (_, index) => `packages/very/deeply/nested/module-${String(index).padStart(2, "0")}/index.ts`,
    );
    const big = { ...digest, filesTouched: files };
    expect(JSON.stringify({ digest: big, transcript: [] }).length).toBeGreaterThan(1_000);

    const prepared = prepareFabricActorContextPayload({ digest: big, transcript }, 1_000);

    const encoded = JSON.stringify(prepared);
    expect(encoded.length).toBeLessThanOrEqual(1_000);
    const parsed = JSON.parse(encoded) as { digest: typeof big & { truncated?: boolean }; transcript: string[] };
    expect(parsed.transcript).toEqual([]);
    expect(parsed.digest.truncated).toBe(true);
    expect(parsed.digest.filesTouched.length).toBeGreaterThan(0);
    expect(parsed.digest.filesTouched.length).toBeLessThan(files.length);
    expect(parsed.digest.filesTouched).toEqual(files.slice(0, parsed.digest.filesTouched.length));
    expect(parsed.digest.openErrors).toBe(digest.openErrors);
    expect(parsed.digest.lastError).toBe(digest.lastError);
    expect(parsed.digest.lastUserRequest).toBe(digest.lastUserRequest);
  });

  it("shortens digest strings with an ellipsis once no file entries remain", () => {
    const longRequest = `request ${"r".repeat(290)}`;
    const big = { ...digest, lastUserRequest: longRequest };

    const prepared = prepareFabricActorContextPayload({ digest: big, transcript }, 200);

    const encoded = JSON.stringify(prepared);
    expect(encoded.length).toBeLessThanOrEqual(200);
    const parsed = JSON.parse(encoded) as { digest: Record<string, unknown>; transcript: string[] };
    expect(parsed.transcript).toEqual([]);
    expect(Object.keys(parsed.digest).sort()).toEqual(
      ["filesTouched", "lastError", "lastUserRequest", "openErrors", "truncated"],
    );
    expect(parsed.digest.truncated).toBe(true);
    expect(parsed.digest.filesTouched).toEqual([]);
    expect(parsed.digest.openErrors).toBe(digest.openErrors);
    const request = parsed.digest.lastUserRequest as string;
    expect(request.endsWith("\u2026")).toBe(true);
    expect(longRequest.startsWith(request.slice(0, -1))).toBe(true);
    expect(request.length).toBeLessThan(longRequest.length);
  });
});

describe("runtime actor host dispatch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("sends the real digest and the newest transcript lines when the actor context is over budget", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-actor-context-"));
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
    vi.stubEnv("PI_FABRIC_PROJECT_ROOT", cwd);
    const lastRequest = `final request ${"z".repeat(250)}`;
    const branch = [
      ...Array.from({ length: 39 }, (_, index) => ({
        type: "message",
        message: { role: "user", content: `request ${String(index).padStart(2, "0")} ${"y".repeat(170)}` },
      })),
      { type: "message", message: { role: "user", content: lastRequest } },
    ];
    const pi = {
      events: { emit: vi.fn() }, getThinkingLevel: () => "off", sendMessage: vi.fn(),
      on: () => () => {},
    } as unknown as ExtensionAPI;
    const context = {
      cwd, hasUI: false, isProjectTrusted: () => true, isIdle: () => false, hasPendingMessages: () => false,
      modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
      sessionManager: {
        getSessionId: () => "actor-context", getSessionFile: () => undefined,
        getBranch: () => branch, getLeafId: () => undefined,
      },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    } as unknown as ExtensionContext;
    const config = normalizeFabricConfig({
      fullCodeMode: true, mcp: { enabled: false, cache: { enabled: false } },
      mesh: { enabled: true, eventContextChars: 1_000 },
      agents: { enabled: false }, memory: { enabled: false }, residency: { enabled: false },
      prewalk: { enabled: false, alwaysRearm: false },
      approvals: { agent: "allow", execute: "allow", read: "allow", network: "deny" },
    });
    const fixture = path.join(cwd, "unused.mjs");
    fs.writeFileSync(fixture, "export default {};");
    const runtime = new FabricRuntimeState(pi, new CapturedToolCatalog(), {
      paths: { extension: fixture, worker: fixture, residentHost: fixture, skills: cwd },
    });
    vi.spyOn(ActorDirectory.prototype, "observeHostEvent").mockReturnValue(true);
    const dispatched = vi.spyOn(ActorDirectory.prototype, "dispatchObservedHostEvent").mockReturnValue(1);
    try {
      await runtime.initialize(context, config);
      runtime.dispatchHostEvent("input", { type: "input", text: "go" }, context);

      const calls = dispatched.mock.calls.filter(([event]) => event === "input");
      expect(calls).toHaveLength(1);
      const payload = calls[0]![1] as { digest: unknown; transcript: string[] };
      expect(payload.digest).toEqual({
        filesTouched: [],
        openErrors: 0,
        lastError: "",
        lastUserRequest: lastRequest,
      });
      expect(payload.transcript.length).toBeGreaterThan(0);
      expect(payload.transcript.at(-1)).toBe(`user: ${lastRequest.slice(0, 199)}\u2026`);
      expect(payload.transcript.at(-2)).toMatch(/^user: request 38 /);
      expect(JSON.stringify({ digest: payload.digest, transcript: payload.transcript }).length)
        .toBeLessThanOrEqual(1_000);
    } finally {
      await runtime.shutdown();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 20_000);
});
