import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const fixture = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-build-artifacts-"));
  temporary.push(dir);
  fs.cpSync(path.join(root, "dist"), path.join(dir, "dist"), { recursive: true });
  for (const file of ["package.json", "scripts/assert-build-artifacts.mjs", "src/verified/generated/manifest.json"]) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  return dir;
};
const rejected = (dir: string, reason: string): void => {
  const result = spawnSync(process.execPath, [path.join(dir, "scripts/assert-build-artifacts.mjs")], { encoding: "utf8", timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(reason);
};

describe("published build artifact guards", () => {
  it("checks a staged build named by --dist, with no dist/ beside it", () => {
    // scripts/build-dist.mjs verifies the staged copy before it replaces dist/.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-build-artifacts-"));
    temporary.push(dir);
    fs.cpSync(path.join(root, "dist"), path.join(dir, ".dist-build-1"), { recursive: true });
    for (const file of ["package.json", "scripts/assert-build-artifacts.mjs", "src/verified/generated/manifest.json"]) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(dir, file));
    }
    fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "junction");
    const check = () => spawnSync(process.execPath, [path.join(dir, "scripts/assert-build-artifacts.mjs"), "--dist", ".dist-build-1"], { encoding: "utf8", timeout: 60_000 });
    const passed = check();
    expect(passed.stderr).toBe("");
    expect(passed.status).toBe(0);
    fs.rmSync(path.join(dir, ".dist-build-1", "extension-bootstrap.js"));
    const missing = check();
    expect(missing.status).toBe(1);
    // Node prints an uncaught error through the C runtime, which writes CRLF on Windows.
    expect(missing.stderr.replace(/\r\n/g, "\n")).toContain("Missing build artifacts:\nextension-bootstrap.js");
  }, 90_000);

  it("uses host-only wildcard peers and exact Pi development dependencies", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(manifest.dependencies["pi-fabric-worker-sdk"]).toBe(`npm:@earendil-works/pi-coding-agent@${manifest.devDependencies["@earendil-works/pi-coding-agent"]}`);
    for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
      expect(manifest.dependencies[name]).toBeUndefined();
      expect(manifest.peerDependencies[name]).toBe("*");
      expect(manifest.devDependencies[name]).toBe(name === "typebox" ? "1.3.27" : "1.5.0");
      expect(manifest.overrides?.[name]).toBeUndefined();
      expect(manifest.resolutions?.[name]).toBeUndefined();
    }
  });
  it.each(["index.d.ts", "extension-bootstrap.d.ts", "core/host-sdk-runtime.d.ts"])("rejects a private worker SDK leak in %s", (file) => {
    const dir = fixture();
    fs.appendFileSync(path.join(dir, "dist", file), '\nexport declare const leaked: import("pi-fabric-worker-sdk").ExtensionAPI;\n');
    rejected(dir, `Host-facing declaration imports the private worker SDK: ${file}`);
  });
  it("rejects a public export omitted from the compiled tree", () => {
    const dir = fixture();
    const file = path.join(dir, "package.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.exports["./missing"] = { import: "./dist/missing.js" };
    fs.writeFileSync(file, JSON.stringify(manifest));
    rejected(dir, "Missing or unpackaged public entrypoint: ./dist/missing.js");
  });
  it.each(["yaml", "pi-fabric-worker-sdk"])("rejects eager %s in the actual extension entry", (dependency) => {
    const dir = fixture();
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    expect(manifest.pi.extensions[0]).toBe("./dist/extension-bootstrap.js");
    fs.appendFileSync(path.join(dir, manifest.pi.extensions[0]), `\nimport "${dependency}";\n`);
    rejected(dir, `Startup eagerly imports optional dependency ${dependency}`);
  });
  // Synthetic package: preserve the generic bundled-entry guards without
  // depending on any real provider being installed with Fabric.
  const bundledFixture = (): string => {
    const dir = fixture();
    const file = path.join(dir, "package.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.dependencies["fixture-provider"] = "1.0.0";
    manifest.bundledDependencies = ["fixture-provider"];
    manifest.pi.extensions.push("./node_modules/fixture-provider/index.ts");
    fs.writeFileSync(file, JSON.stringify(manifest));
    const providerDir = path.join(dir, "node_modules", "fixture-provider");
    fs.mkdirSync(providerDir, { recursive: true });
    fs.writeFileSync(path.join(providerDir, "package.json"), JSON.stringify({
      name: "fixture-provider", version: "1.0.0", pi: { extensions: ["./index.ts"] },
    }));
    fs.writeFileSync(path.join(providerDir, "index.ts"), "export default () => {};\n");
    return dir;
  };
  it.each([
    ["an entry outside bundledDependencies", (manifest: any) => { manifest.bundledDependencies = []; }, "is not a bundled dependency"],
    ["a ranged bundled dependency", (manifest: any) => { manifest.dependencies["fixture-provider"] = "^1.0.0"; }, "must be an exact runtime dependency"],
    ["an entry the bundled package does not declare", (manifest: any) => { manifest.pi.extensions[1] = "./node_modules/fixture-provider/settings.ts"; }, "is not declared by fixture-provider"],
  ])("rejects %s", (_label, mutate, reason) => {
    const dir = bundledFixture();
    const file = path.join(dir, "package.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    mutate(manifest);
    fs.writeFileSync(file, JSON.stringify(manifest));
    rejected(dir, reason);
  });
  it("rejects a bundled Pi package that depends on a host package", () => {
    const dir = bundledFixture();
    const file = path.join(dir, "node_modules/fixture-provider/package.json");
    const bundled = JSON.parse(fs.readFileSync(file, "utf8"));
    bundled.dependencies = { "@earendil-works/pi-ai": "1.4.0" };
    fs.writeFileSync(file, JSON.stringify(bundled));
    rejected(dir, "must declare host package @earendil-works/pi-ai as a peer");
  });
  it("rejects a missing standalone worker validator", () => {
    const dir = fixture();
    fs.rmSync(path.join(dir, "dist/worker/result.js"));
    rejected(dir, "worker/result.js");
  });
  it.each(["worker.js", "durable/worker.js"])("rejects external dependencies in %s bootstrap", (entry) => {
    const dir = fixture();
    fs.appendFileSync(path.join(dir, "dist", entry), '\nimport "typebox/value";\n');
    rejected(dir, "Worker bootstrap imports an external package: typebox/value");
  });
  it("rejects a validator that relies on host modules", () => {
    const dir = fixture();
    fs.appendFileSync(path.join(dir, "dist/worker/result.js"), '\nimport "typebox/value";\n');
    rejected(dir, "Worker validator must be self-contained");
  });
  it("rejects a missing lazy Bend grammar entry", () => {
    const dir = fixture();
    fs.rmSync(path.join(dir, "dist/ui/languages/bend.js"));
    rejected(dir, "ui/languages/bend.js");
  });
  it("rejects a missing stable image-overlay entry", () => {
    const dir = fixture();
    fs.rmSync(path.join(dir, "dist/ui/image-overlays.js"));
    rejected(dir, "ui/image-overlays.js");
  });
  it.each(["native-discovery.js", "memory/extractive-history.js", "agents/agent-files.js", "durable/worker.js", "durable/worker-host.js", "durable-host.js"])("requires stable optional entry %s", (entry) => {
    const dir = fixture();
    fs.rmSync(path.join(dir, "dist", entry));
    rejected(dir, entry);
  });
  it("rejects the durable-host embedding entry in the eager startup graph", () => {
    const dir = fixture();
    fs.appendFileSync(path.join(dir, "dist/extension-bootstrap.js"), "\n// src/durable-host.ts\n");
    rejected(dir, "Startup static graph contains lazy module marker: src/durable-host.ts");
  });
  it("exposes ./durable-host with types in the exports map", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(manifest.exports["./durable-host"]).toEqual({ types: "./dist/durable-host.d.ts", import: "./dist/durable-host.js" });
  });
  it("rejects the named agent file loader in the startup graph", () => {
    const dir = fixture();
    fs.appendFileSync(path.join(dir, "dist/extension-bootstrap.js"), "\n// src/agents/agent-files.ts\n");
    rejected(dir, "Startup static graph contains lazy module marker: src/agents/agent-files.ts");
  });
  it("rejects an eager extractive engine implementation", () => {
    const dir = fixture();
    fs.appendFileSync(path.join(dir, "dist/extension-bootstrap.js"), "\n// src/memory/extractive-index.ts\n");
    rejected(dir, "Startup static graph contains lazy module marker: src/memory/extractive-index.ts");
  });
  it("rejects a missing generated ABI declaration", () => {
    const dir = fixture();
    fs.rmSync(path.join(dir, "dist/verified/generated/storage.d.ts"));
    rejected(dir, "storage.d.ts");
  });
  it("rejects a modified generated library in the bundle", () => {
    const dir = fixture();
    fs.appendFileSync(path.join(dir, "dist/verified/generated/storage.js"), "\n// changed\n");
    rejected(dir, "Bundled verified artifact differs");
  });
  it("rejects a bundle that loads the prover", () => {
    const dir = fixture();
    fs.appendFileSync(path.join(dir, "dist/extension-bootstrap.js"), '\nimport("gdp-wired/machine");\n');
    rejected(dir, "Published bundle loads the gdp-wired prover");
  });
  it("rejects a stale bundled receipt", () => {
    const dir = fixture();
    fs.appendFileSync(path.join(dir, "dist/verified/generated/manifest.json"), "\n");
    rejected(dir, "Bundled verified artifact receipt differs from source");
  });
});
