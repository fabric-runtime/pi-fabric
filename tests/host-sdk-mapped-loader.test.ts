import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadHostSdk } from "../src/core/host-sdk.js";

const KEY = Symbol.for("pi-fabric.hostSdkLoader");
const registry = globalThis as Record<symbol, unknown>;
const roots: string[] = [];
afterEach(() => {
  delete registry[KEY];
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("loadHostSdk mapped loader", () => {
  it("uses the loader registered by the extension entry when no CLI layout is recognised", async () => {
    const sdk = { from: "mapped" };
    registry[KEY] = async () => sdk;
    // A compiled `pi` binary is not a cli.js, so hostSdkEntry finds nothing.
    await expect(loadHostSdk("/nonexistent/pi")).resolves.toBe(sdk);
  });

  it("still prefers the running CLI's own SDK entry over the mapped loader", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fabric-host-sdk-")));
    roots.push(root);
    const bundle = path.join(root, "pkg", "dist", "bundle");
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(root, "pkg", "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
    fs.writeFileSync(path.join(bundle, "cli.js"), "");
    fs.writeFileSync(path.join(bundle, "index.js"), 'export const from = "running-cli";\n');
    registry[KEY] = async () => ({ from: "mapped" });
    await expect(loadHostSdk(path.join(bundle, "cli.js"))).resolves.toMatchObject({ from: "running-cli" });
  });

  it("falls back to the package import when the loader fails", async () => {
    registry[KEY] = async () => { throw new Error("not mapped"); };
    const outcome = await loadHostSdk("/nonexistent/pi").then(() => "loaded", (error: Error) => error.message);
    expect(outcome).not.toBe("not mapped");
  });
});
