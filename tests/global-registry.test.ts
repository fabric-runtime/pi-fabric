import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GlobalActorRegistry } from "../src/actors/global-registry.js";
import { ActorStoreReadError } from "../src/actors/store-read.js";
import type { FabricActorRequest } from "../src/actors/types.js";

// Mode 000 does not stop the read on Windows or for root.
const unreadableFileSkip =
  process.platform === "win32"
    ? "Windows does not deny reads by POSIX mode bits"
    : process.getuid?.() === 0
      ? "root reads a mode-000 file"
      : undefined;

const dirs: string[] = [];

const setup = () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-global-actors-"));
  dirs.push(agentDir);
  const registry = new GlobalActorRegistry(agentDir, 64 * 1024);
  return { agentDir, registry };
};

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const baseRequest: FabricActorRequest = {
  name: "reviewer",
  instructions: "Review code for security defects and reply concisely.",
  events: ["turn_end"],
  topics: ["team.review"],
  delivery: "steer" as const,
  responseMode: "directive" as const,
  triggerTurn: false,
  coalesce: true,
};

describe("GlobalActorRegistry", () => {
  it("creates, lists, and resolves templates by id, prefix, and name", () => {
    const { registry } = setup();
    expect(registry.list()).toEqual([]);

    const created = registry.create(baseRequest);
    expect(created.id).toMatch(/^[a-f0-9]{32}$/);
    expect(created.name).toBe("reviewer");
    expect(created.events).toEqual(["turn_end"]);
    expect(created.delivery).toBe("steer");
    expect(created.runner).toBe("pi-durable");
    expect(created.model).toBeUndefined();

    expect(registry.list()).toHaveLength(1);
    expect(registry.resolve(created.id)?.name).toBe("reviewer");
    expect(registry.resolve(created.id.slice(0, 8))?.name).toBe("reviewer");
    expect(registry.resolve("reviewer")?.id).toBe(created.id);
    expect(registry.resolve("missing")).toBeUndefined();
  });

  it("persists across instances in the same agent dir", () => {
    const { agentDir, registry } = setup();
    registry.create({ ...baseRequest, extensions: false });
    const reloaded = new GlobalActorRegistry(agentDir, 64 * 1024);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.resolve("reviewer")?.instructions).toBe(baseRequest.instructions);
    expect(reloaded.resolve("reviewer")?.extensions).toBe(false);
  });

  it("rejects duplicate names without overwrite and replaces with it", () => {
    const { registry } = setup();
    registry.create(baseRequest);
    expect(() => registry.create(baseRequest)).toThrow(/already exists/);

    const replaced = registry.create(
      { ...baseRequest, instructions: "Updated instructions." },
      true,
    );
    expect(replaced.instructions).toBe("Updated instructions.");
    expect(replaced.id).toBe(registry.resolve("reviewer")?.id);
    expect(registry.list()).toHaveLength(1);
  });

  it("applies partial patches via update and revalidates", () => {
    const { registry } = setup();
    const created = registry.create(baseRequest);
    const patched = registry.update(created.id, { instructions: "Be brief." });
    expect(patched.instructions).toBe("Be brief.");
    expect(patched.name).toBe("reviewer");
    expect(patched.events).toEqual(["turn_end"]);

    const fabricDisabled = registry.update(created.id, { extensions: false });
    expect(fabricDisabled.extensions).toBe(false);
    expect(registry.update(created.id, { instructions: "Stay brief." }).extensions).toBe(false);

    expect(() => registry.update(created.id, { instructions: "   " })).toThrow(/empty/);
    expect(() => registry.update(created.id, { name: "bad name!" })).toThrow(/Invalid/);
  });

  it("requires explicit active delivery intent and rejects impossible policies", () => {
    const { registry } = setup();
    const { triggerTurn: _triggerTurn, ...ambiguous } = baseRequest;
    expect(() => registry.create(ambiguous)).toThrow(/requires explicit triggerTurn/);
    expect(() =>
      registry.create({ ...baseRequest, delivery: "mailbox", triggerTurn: true }),
    ).toThrow(/never starts Main/);
  });

  it("updates template delivery policies", () => {
    const { registry } = setup();
    const created = registry.create(baseRequest);
    const active = registry.update(created.id, { delivery: "followUp", triggerTurn: true });
    expect(active).toMatchObject({ delivery: "followUp", triggerTurn: true });
    expect(() =>
      registry.update(created.id, { delivery: "nextTurn", triggerTurn: true }),
    ).toThrow(/never starts Main/);
    expect(registry.resolve(created.id)).toMatchObject({ delivery: "followUp", triggerTurn: true });
  });

  it("removes templates", () => {
    const { registry } = setup();
    const created = registry.create(baseRequest);
    expect(registry.remove(created.id)).toEqual({ removed: true });
    expect(registry.list()).toEqual([]);
    expect(registry.remove(created.id)).toEqual({ removed: false });
  });

  it("validates names, instructions, events, topics, and sizes", () => {
    const { registry } = setup();
    expect(() => registry.create({ ...baseRequest, name: "" })).toThrow(/Invalid/);
    expect(() => registry.create({ ...baseRequest, name: "9bad name!" })).toThrow(/Invalid/);
    expect(() => registry.create({ ...baseRequest, instructions: "  " })).toThrow(/empty/);
    expect(() =>
      registry.create({ ...baseRequest, events: ["bogus" as never] }),
    ).toThrow(/Unsupported/);
    expect(() =>
      registry.create({ ...baseRequest, topics: ["bad topic!"] }),
    ).toThrow(/Invalid/);
    const big = "x".repeat(64 * 1024 + 1);
    expect(() => registry.create({ ...baseRequest, instructions: big })).toThrow(/exceed/);
  });

  it("strips identity and timestamps in toRequest and supports renaming", () => {
    const { registry } = setup();
    const created = registry.create({
      ...baseRequest,
      runner: "claude",
      model: "claude/haiku",
      extensions: false,
    });
    const request = registry.toRequest(created);
    expect(request).not.toHaveProperty("id");
    expect(request).not.toHaveProperty("createdAt");
    expect(request).not.toHaveProperty("updatedAt");
    expect(request.name).toBe("reviewer");
    expect(request.runner).toBe("claude");
    expect(request.model).toBe("claude/haiku");
    expect(request.extensions).toBe(false);

    const renamed = registry.toRequest(created, "reviewer-2");
    expect(renamed.name).toBe("reviewer-2");
  });


  it("normalizes impossible legacy trigger settings while keeping active modes passive by default", () => {
    const { agentDir } = setup();
    const registryPath = path.join(agentDir, "fabric", "actors", "global-actors.json");
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        format: 1,
        actors: [
          {
            id: "a".repeat(32),
            name: "legacy-mailbox",
            instructions: "Legacy.",
            delivery: "mailbox",
            triggerTurn: true,
            createdAt: 1,
          },
          {
            id: "b".repeat(32),
            name: "legacy-steer",
            instructions: "Legacy.",
            delivery: "steer",
            createdAt: 1,
          },
        ],
      }),
    );

    const reloaded = new GlobalActorRegistry(agentDir, 64 * 1024);
    expect(reloaded.resolve("legacy-mailbox")).toMatchObject({
      delivery: "mailbox",
      triggerTurn: false,
    });
    expect(reloaded.resolve("legacy-steer")).toMatchObject({
      delivery: "steer",
      triggerTurn: false,
    });
  });

  it("throws when a query matches multiple templates", () => {
    const { registry } = setup();
    registry.create(baseRequest);
    registry.create({ ...baseRequest, name: "reviewer-2" });
    // An empty query matches every template's id prefix, so two templates
    // are ambiguous. (Random 32-hex ids rarely share a longer prefix, so the
    // empty query deterministically exercises the ambiguity branch.)
    expect(() => registry.resolve("")).toThrow(/Ambiguous/);
  });
});

describe("GlobalActorRegistry read failures", () => {
  const registryFile = (agentDir: string): string =>
    path.join(agentDir, "fabric", "actors", "global-actors.json");
  const savedTemplate = {
    id: "c".repeat(32),
    name: "saved",
    instructions: "Saved before the failed read.",
    createdAt: 1,
  };
  const writeRaw = (agentDir: string, raw: string): string => {
    const file = registryFile(agentDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, raw);
    return file;
  };
  const expectEveryMutationRefused = (registry: GlobalActorRegistry): void => {
    expect(() => registry.list()).toThrow(ActorStoreReadError);
    expect(() => registry.resolve("saved")).toThrow(ActorStoreReadError);
    expect(() => registry.create(baseRequest)).toThrow(ActorStoreReadError);
    expect(() => registry.update("saved", { instructions: "Overwrite." })).toThrow(ActorStoreReadError);
    expect(() => registry.remove("saved")).toThrow(ActorStoreReadError);
  };

  it.each([
    ["truncated JSON", `{"format":1,"actors":[${JSON.stringify(savedTemplate)}`],
    ["a non-object document", "[]"],
    ["a non-array actors field", '{"format":1,"actors":{}}'],
  ])("refuses to read or save over %s", (_label, raw) => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-global-actors-"));
    dirs.push(agentDir);
    const file = writeRaw(agentDir, raw);
    const registry = new GlobalActorRegistry(agentDir, 64 * 1024);
    expect(registry.loadError).toBeInstanceOf(ActorStoreReadError);
    expect(registry.loadError?.message).toContain(file);
    expectEveryMutationRefused(registry);
    expect(fs.readFileSync(file, "utf8")).toBe(raw);
  });

  it(
    "refuses to save over a registry it has no permission to read",
    ({ skip }) => {
      skip(unreadableFileSkip !== undefined, unreadableFileSkip);
      const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-global-actors-"));
      dirs.push(agentDir);
      const raw = JSON.stringify({ format: 1, actors: [savedTemplate] });
      const file = writeRaw(agentDir, raw);
      fs.chmodSync(file, 0o000);
      try {
        const registry = new GlobalActorRegistry(agentDir, 64 * 1024);
        expect((registry.loadError?.cause as NodeJS.ErrnoException | undefined)?.code).toBe("EACCES");
        expectEveryMutationRefused(registry);
      } finally {
        fs.chmodSync(file, 0o600);
      }
      expect(fs.readFileSync(file, "utf8")).toBe(raw);
    },
  );

  it("refuses to save when the registry path is a directory", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-global-actors-"));
    dirs.push(agentDir);
    const file = registryFile(agentDir);
    fs.mkdirSync(path.join(file, "keep"), { recursive: true });
    const registry = new GlobalActorRegistry(agentDir, 64 * 1024);
    expect((registry.loadError?.cause as NodeJS.ErrnoException | undefined)?.code).toBe("EISDIR");
    expectEveryMutationRefused(registry);
    expect(fs.readdirSync(file)).toEqual(["keep"]);
  });

  it("loads a missing registry as empty and saves the first template", () => {
    const { agentDir, registry } = setup();
    expect(registry.loadError).toBeUndefined();
    expect(registry.list()).toEqual([]);
    registry.create(baseRequest);
    const saved = JSON.parse(fs.readFileSync(registryFile(agentDir), "utf8")) as { actors: Array<{ name: string }> };
    expect(saved.actors.map((actor) => actor.name)).toEqual(["reviewer"]);
  });

  it("reads the registry again once the failure is repaired", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-global-actors-"));
    dirs.push(agentDir);
    writeRaw(agentDir, "{");
    const registry = new GlobalActorRegistry(agentDir, 64 * 1024);
    expect(() => registry.list()).toThrow(ActorStoreReadError);
    writeRaw(agentDir, JSON.stringify({ format: 1, actors: [savedTemplate] }));
    expect(registry.list().map((actor) => actor.name)).toEqual(["saved"]);
    expect(registry.loadError).toBeUndefined();
  });

  it("keeps records that fail validation when it rewrites the registry", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-global-actors-"));
    dirs.push(agentDir);
    const badId = { ...savedTemplate, id: "not-a-hex-id", name: "bad-id" };
    const oversized = { ...savedTemplate, id: "d".repeat(32), name: "oversized", instructions: "x".repeat(200) };
    const notAnObject = "legacy-entry";
    const file = writeRaw(agentDir, JSON.stringify({ format: 1, actors: [savedTemplate, badId, oversized, notAnObject] }));
    const registry = new GlobalActorRegistry(agentDir, 100);
    expect(registry.list().map((actor) => actor.name)).toEqual(["saved"]);

    registry.create({ ...baseRequest, instructions: "Short." });

    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { actors: unknown[] };
    expect(saved.actors).toEqual(expect.arrayContaining([badId, oversized, notAnObject]));
    expect(saved.actors).toHaveLength(5);
    expect(new GlobalActorRegistry(agentDir, 64 * 1024).list().map((actor) => actor.name).sort())
      .toEqual(["oversized", "reviewer", "saved"]);
  });
});
