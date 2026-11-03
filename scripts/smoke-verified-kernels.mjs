#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ActionRegistry } from "../dist/core/action-registry.js";
import { compileFabricSummary } from "../dist/compaction/hook.js";
import * as policy from "../dist/verified/generated/policy.js";
import { capabilityAuthority } from "../dist/verified/generated/authority.js";
import { bindingStep } from "../dist/verified/generated/lifecycle.js";
import { storageTransition } from "../dist/verified/generated/storage.js";
import { resourceScope, resourceConflict } from "../dist/verified/generated/resources.js";
import { meshGrantTake } from "../dist/verified/generated/grants.js";
import { budgetAdmission } from "../dist/verified/generated/budget.js";
import { promptGuidance } from "../dist/verified/generated/prompt-guidance.js";
import { speculationAdmission, speculationCheck, speculationAccounting } from "../dist/verified/generated/speculation.js";

// The retired PoC must not remain reachable through package exports.
await assert.rejects(import("pi-fabric/verified/cell-provider"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
await assert.rejects(import("pi-fabric/verified/goal-provider"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
const root = new URL("../", import.meta.url);
const stems = ["policy", "compaction", "resources", "lifecycle", "storage", "provider", "authority", "grants", "speculation", "budget", "prompt-guidance"];
for (const file of [...stems.flatMap((stem) => [`${stem}.js`, `${stem}.d.ts`]), "manifest.json"]) {
  assert.equal(readFileSync(new URL(`src/verified/generated/${file}`, root), "utf8"), readFileSync(new URL(`dist/verified/generated/${file}`, root), "utf8"));
}
const call = (machine, input) => machine.step({}, machine.init({}), input).scalars;
assert.equal(call(policy.pointerCurrent, { source: 1, lineage: 0 })["out.current"], 0);
assert.equal(call(policy.headReadable, { sequence: 1, version: 1, committed: 0, pending: 1, marker: 0 })["out.readable"], 0);
assert.equal(call(policy.useNormalized, { canonical: 1, plan: 1, changed: 1, accepted: 1 })["out.use"], 0);
assert.deepEqual(call(policy.consume, { active: 1 }), { "out.released": 1, "out.active": 0 });
assert.equal(call(policy.headReadable, { sequence: 1, version: 1, committed: 0, pending: 1, marker: 1 })["out.readable"], 1);
assert.deepEqual(call(promptGuidance, { active: 1, sections: 1, forced: 0 }), { "out.section": 1, "out.append": 0, "out.native": 0 });
assert.deepEqual(call(promptGuidance, { active: 1, sections: 1, forced: 1 }), { "out.section": 0, "out.append": 1, "out.native": 0 });
const budget = { valid: 1, spentHigh: 10, spentLow: 3, limitHigh: 10, limitLow: 4 };
assert.equal(call(budgetAdmission, budget)["out.admitted"], 1);
assert.equal(call(budgetAdmission, { ...budget, spentLow: 4 })["out.admitted"], 0);
const grant = { authenticated: 1, now: 11, expiresAt: 13, uses: 2, topic: 3, requestedTopic: 3, hasTopic: 1, kind: 5, hasKind: 1, requestedKind: 5, hasRequestedKind: 0, externalKind: 6 };
assert.deepEqual(call(meshGrantTake, grant), { "out.plan": 5, "out.uses": 1, "out.topic": 3, "out.kind": 5 });
assert.equal(call(meshGrantTake, { ...grant, requestedTopic: 4 })["out.plan"], 3);
assert.equal(call(speculationAdmission, { ended: 0, duplicate: 0, entries: 2, inFlight: 1, maxEntries: 3, maxConcurrent: 2 })["out.plan"], 0);
assert.equal(call(speculationCheck, { settled: 1, aborted: 1, now: 110, createdAt: 100, ttl: 1, birthEpoch: 2, epoch: 2, fresh: 1, failed: 0 })["out.outcome"], 2);
assert.equal(call(speculationAccounting, { event: 7 }).epoch, 1);

const set = (ids) => new Map(ids.map((id) => [id, 1]));
const empty = new Map();
const parent = capabilityAuthority.step({}, capabilityAuthority.init({}), { op: 0, name: 0, parentLive: 0, Candidate: set([1]), Parent: empty });
const child = capabilityAuthority.step({}, capabilityAuthority.init({}), { op: 1, name: 0, parentLive: 1, Candidate: set([2]), Parent: parent.maps.Grants });
assert.equal(child.scalars.live, 0);
assert.equal(capabilityAuthority.step({}, parent, { op: 3, name: 0, parentLive: 0, Candidate: empty, Parent: empty }).scalars.live, 0);
// Phases: 2 Retiring, 3 Closing. Events: 9 Shut, 7 Begin. Commands: 0 Denied, 2 StartClose.
const closing = bindingStep.step({}, { scalars: { phase: 2, owner: 0, holds: 0, calls: 0, revoked: 1, command: 0 }, maps: {} }, { event: 9, cleanup: 0 });
assert.equal(closing.scalars.command, 2);
assert.equal(bindingStep.step({}, closing, { event: 7, cleanup: 1 }).scalars.command, 0);
const storage = (present, version, highWater) => call(storageTransition, { key: 1, any: 0, expected: 0, put: 1, value: 2, identity: 3, present, version, highWater });
assert.deepEqual(storage(0, 0, 2 ** 48 - 1), { "out.plan": 3, "out.key": 1, "out.value": 2, "out.identity": 3, "out.version": 2 ** 48, "out.highWater": 2 ** 48 });
assert.equal(storage(0, 1, 1)["out.plan"], 0);
assert.equal(storage(0, 0, 9007199254740991)["out.plan"], 1);
// Proposal ids first (2..65), then the 65th declared name: the omission is refused.
const declared = Array.from({ length: 65 }, (_, i) => i + 2);
const lengths = new Map(declared.map((id) => [id, 3]));
const source = resourceScope.step({}, resourceScope.init({}), { op: 0, first: 2, Given: set(declared), Len: lengths });
const normalized = resourceScope.step({}, source, { op: 1, first: 2, Given: set(declared.slice(0, 64)), Len: lengths });
assert.equal(normalized.scalars.exact, 0);
assert.equal(call(resourceConflict, { leftEffect: 1, rightEffect: 1, leftExact: 0, rightExact: 1, leftOrdered: 1, rightOrdered: 0, witness: 0, Left: empty, Right: set([66]) }).conflict, 1);

const registry = new ActionRegistry();
let entered;
let release;
const active = new Promise((resolve) => { entered = resolve; });
const gate = new Promise((resolve) => { release = resolve; });
let secondRan = false;
registry.register({
  name: "proofsmoke", description: "Bundled conflict gate smoke",
  async list() { return []; },
  async describe(name) {
    return { name, description: name, inputSchema: { type: "object", additionalProperties: false }, risk: "write",
      effect: { kind: "transactional", ordering: "ordered", resources: name === "hold"
        ? [...Array.from({ length: 64 }, (_, i) => `r${i}`), "shared"] : ["shared"] } };
  },
  async invoke(name) {
    if (name === "hold") { entered(); await gate; } else secondRan = true;
    return name;
  },
});
const invoke = (name) => registry.invoke(`proofsmoke.${name}`, {}, {
  cwd: fileURLToPath(root), signal: undefined, parentToolCallId: "proof-smoke", nestedToolCallId: name,
  extensionContext: {}, update() {}, approve: async () => {}, audits: [], maxResultChars: 1000, effectPolicy: "strict",
});
const held = invoke("hold");
try {
  await active;
  await assert.rejects(invoke("second"), /unknown resource footprint/);
  assert.equal(secondRan, false);
} finally {
  release();
  await held;
  await registry.close();
}

const entries = ["first request", "next request"].map((text, i) => ({
  type: "message", id: `e${i}`, parentId: i === 0 ? null : "e0", timestamp: "2026-01-01T00:00:00Z",
  message: { role: "user", content: text, timestamp: i },
}));
const summary = compileFabricSummary(entries, 100);
assert.ok("compaction" in summary);
assert.ok(Buffer.byteLength(summary.compaction.summary) <= 32_768);
const invocationContext = { cwd: fileURLToPath(root), signal: undefined, parentToolCallId: "provider-smoke", nestedToolCallId: "provider",
  extensionContext: {}, update() {}, approve: async () => {}, audits: [], maxResultChars: 1000, effectPolicy: "strict" };

let disposed = 0;
let closed = 0;
const authorityRegistry = new ActionRegistry();
authorityRegistry.register({
  name: "authoritysmoke", description: "Bundled capability-view check",
  async list() { return []; },
  async describe(name) {
    return ["read", "lease"].includes(name) ? { name, description: name, inputSchema: { type: "object", additionalProperties: false }, risk: "read",
      effect: { kind: name === "lease" ? "scoped" : "none", resources: ["authoritysmoke"], ordering: "ordered" } } : undefined;
  },
  async invoke() { return 42; },
  async acquire() { return { value: 42, dispose() { disposed++; } }; },
  async close() { closed++; },
});
try {
  const lease = await authorityRegistry.acquireCapabilityView(["authoritysmoke.read"], invocationContext);
  const scoped = { ...invocationContext, capabilityView: lease.view };
  assert.equal(await authorityRegistry.invoke("authoritysmoke.read", {}, scoped), 42);
  await lease.release();
  await assert.rejects(authorityRegistry.invoke("authoritysmoke.read", {}, scoped), /released/);
  const owned = await authorityRegistry.acquireScoped("authoritysmoke.lease", {}, invocationContext);
  await authorityRegistry.close();
  assert.equal(disposed, 1);
  assert.equal(closed, 1);
  assert.deepEqual(authorityRegistry.providerStatus(), []);
  await owned.dispose();
  assert.equal(disposed, 1);
} finally { await authorityRegistry.close(); }
console.log("Bundled artifact identity, registry refusal, authority, scoped lifecycle, storage ABI, compaction, and kernel behavior verified.");
