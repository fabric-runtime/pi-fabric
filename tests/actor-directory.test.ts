import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorDirectory } from "../src/actors/directory.js";
import { ActorManager } from "../src/actors/manager.js";
import { AgentManager } from "../src/agents/manager.js";
import { DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import { MeshStore, type MeshIdentity } from "../src/mesh/store.js";

const roots: string[] = [];
const directories: ActorDirectory[] = [];
const agents: AgentManager[] = [];

const open = (
  root: string,
  sessionId: string,
  options: { persistent?: boolean; meshCursorPath?: string } = {},
) => {
  const identity: MeshIdentity = {
    id: `session:${sessionId}`,
    name: "main",
    kind: "main",
    sessionId,
  };
  const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
    workerPath: path.resolve("tests/fixtures/fake-worker.mjs"),
    runRoot: path.join(root, `runs-${sessionId}-${agents.length}`),
  });
  agents.push(manager);
  const mesh = new MeshStore(path.join(root, "mesh"), 64 * 1024, 100);
  const actorRoots = {
    project: path.join(root, "mesh", "actors"),
    session: path.join(root, "mesh", "actors", sessionId),
  };
  const directory = new ActorDirectory([
    sessionId,
    identity,
    mesh,
    { ...DEFAULT_FABRIC_CONFIG.mesh, actorPollMs: 20 },
    manager,
    () => {},
    {
      persistent: options.persistent ?? true,
      rootId: identity.id,
      ...(options.meshCursorPath ? { meshCursorPath: options.meshCursorPath } : {}),
    },
  ], actorRoots, "project");
  directories.push(directory);
  return { directory, actorRoots, mesh, manager };
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => directory.close()));
  await Promise.all(agents.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ActorDirectory", () => {
  it("finishes closing both scopes before it reports a failed close", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-actor-directory-"));
    roots.push(root);
    const { directory } = open(root, "alpha");
    let releaseSecondary!: () => void;
    const secondaryGate = new Promise<void>((resolve) => {
      releaseSecondary = resolve;
    });
    let secondaryClosed = false;
    // The directory is the primary scope; the session scope is a plain ActorManager.
    const close = vi
      .spyOn(ActorManager.prototype, "close")
      .mockImplementation(async function (this: ActorManager) {
        if (this instanceof ActorDirectory) throw new Error("primary close failed");
        await secondaryGate;
        secondaryClosed = true;
      });
    try {
      let settled = false;
      const outcome = directory.close().then(
        () => undefined,
        (error: unknown) => error,
      ).finally(() => {
        settled = true;
      });
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
      expect(settled).toBe(false);

      releaseSecondary();
      expect(await outcome).toMatchObject({ message: "primary close failed" });
      expect(secondaryClosed).toBe(true);
    } finally {
      close.mockRestore();
    }
  });

  it("runs project and session actor registries concurrently", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-actor-directory-"));
    roots.push(root);
    const alpha = open(root, "alpha");

    const shared = await alpha.directory.create({
      scope: "project",
      name: "release guardian",
      instructions: "Guard the project release.",
    });
    const privateActor = await alpha.directory.create({
      scope: "session",
      name: "spec supervisor",
      instructions: "Supervise this task only.",
    });
    const idNamedActor = await alpha.directory.create({
      scope: "session",
      name: shared.id,
      instructions: "Exercise exact actor ID routing.",
    });

    expect(alpha.directory.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: shared.id, scope: "project" }),
      expect.objectContaining({ id: privateActor.id, scope: "session" }),
      expect.objectContaining({ id: idNamedActor.id, scope: "session" }),
    ]));
    expect(alpha.directory.status(shared.id)).toMatchObject({ id: shared.id, scope: "project" });
    expect(fs.existsSync(path.join(alpha.actorRoots.project, "actors.json"))).toBe(true);
    expect(fs.existsSync(path.join(alpha.actorRoots.session, "actors.json"))).toBe(true);

    const beta = open(root, "beta");
    expect(beta.directory.list()).toEqual([
      expect.objectContaining({ id: shared.id, scope: "project" }),
    ]);
  });

  it("does not write to or delete durable roots from a transient participant runtime", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-actor-directory-"));
    roots.push(root);
    const projectRoot = path.join(root, "mesh", "actors");
    const sentinel = path.join(projectRoot, "keep.txt");
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(sentinel, "durable");

    const transient = open(root, "child", { persistent: false });
    await transient.directory.create({
      scope: "project",
      name: "temporary project actor",
      instructions: "Stay process-local.",
    });
    await transient.directory.create({
      scope: "session",
      name: "temporary session actor",
      instructions: "Stay process-local too.",
    });
    await transient.directory.close();

    expect(fs.readFileSync(sentinel, "utf8")).toBe("durable");
    expect(fs.existsSync(path.join(projectRoot, "actors.json"))).toBe(false);
  });

  it("persists independent mesh cursors for concurrent actor scopes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-actor-directory-"));
    roots.push(root);
    const cursor = path.join(root, "actor-mesh-cursor.json");
    const opened = open(root, "alpha", { meshCursorPath: cursor });

    const handle = await opened.manager.spawn({ task: "HANG", transport: "process" });
    await opened.directory.steerRemote(handle.id, "deliver exactly once", "steer");
    const steerFile = path.join(opened.manager.runDirectory(handle.id)!, "steer.jsonl");

    await vi.waitFor(() => {
      expect(fs.existsSync(`${cursor}.project`)).toBe(true);
      expect(fs.existsSync(`${cursor}.session`)).toBe(true);
      expect(fs.existsSync(steerFile)).toBe(true);
    }, { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const deliveries = fs.readFileSync(steerFile, "utf8")
      .split("\n")
      .filter((line) => line.trim());
    expect(deliveries).toHaveLength(1);
    await opened.manager.stop(handle.id);
  });
});
