import test from "node:test";
import assert from "node:assert/strict";
import { checkSemanticInvariants, collectExtensionTransformKinds } from "../src/conformance.js";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "..", "..", "0.1.0", "topology-capability-doc.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const ajvT = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajvT);
ajvT.addSchema(schema);
const validateTransform = ajvT.compile({ $ref: schema.$id + "#/$defs/transform" });
const validateOffer = ajvT.compile({ $ref: schema.$id + "#/$defs/capabilityOffer" });
const validateBinding = ajvT.compile({ $ref: schema.$id + "#/$defs/binding" });

// Minimal schema-valid building blocks the checker can reason about.
const baseNode = { id: "N1", kind: "inverter" };
const fragment = (overrides = {}) => ({
  topologyVersion: "0.1.0",
  scope: "fragment",
  producer: { name: "p", provider: "x" },
  nodes: [baseNode],
  ...overrides,
});
const site = (overrides = {}) => ({ ...fragment(), scope: "site", docVersion: 1, ...overrides });

const has = (errors, substr) => errors.some((e) => e.includes(substr));

test("fragment without data-plane fields is conformant (description-only)", () => {
  const errors = checkSemanticInvariants(
    fragment({ nodes: [{ id: "N1", kind: "inverter", capabilities: [{ capability: "battery.soc", read: {} }] }] }),
  );
  assert.deepEqual(errors, []);
});

test("site doc demands docVersion + per-capability ref/accessPath", () => {
  const errors = checkSemanticInvariants(
    site({
      docVersion: undefined,
      nodes: [{ id: "N1", kind: "inverter", capabilities: [{ capability: "battery.soc", read: {} }] }],
    }),
  );
  assert.ok(has(errors, "docVersion must be an integer"));
  assert.ok(has(errors, 'capability "battery.soc" is missing accessPath'));
  assert.ok(has(errors, 'capability "battery.soc" must define integer ref'));
});

test("requireDataPlane override forces strictness on a fragment", () => {
  const errors = checkSemanticInvariants(
    fragment({ nodes: [{ id: "N1", kind: "inverter", capabilities: [{ capability: "battery.soc", read: {} }] }] }),
    { requireDataPlane: true },
  );
  assert.ok(has(errors, "docVersion must be an integer"));
});

test("#5 numeric ids resolve in relationships (endpoints normalised like node ids)", () => {
  const errors = checkSemanticInvariants(
    fragment({
      nodes: [{ id: 1, kind: "gateway" }, { id: 2, kind: "inverter" }],
      relationships: [{ from: 1, to: 2, type: "contains" }],
    }),
  );
  assert.ok(!has(errors, "unknown"), `unexpected unknown-node error: ${errors.join("; ")}`);
});

test("#5 genuinely dangling relationship endpoint is still reported", () => {
  const errors = checkSemanticInvariants(
    fragment({ relationships: [{ from: "N1", to: "MISSING", type: "contains" }] }),
  );
  assert.ok(has(errors, 'unknown to node "MISSING"'));
});

test("#6 node missing an id is reported, not silently skipped", () => {
  const errors = checkSemanticInvariants(fragment({ nodes: [{ kind: "inverter" }] }));
  assert.ok(has(errors, "node #0 is missing an id"));
});

test("#3 site doc with an undeclared deviceType reference is rejected", () => {
  const errors = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "inverter", deviceType: "ghost" }] }),
  );
  assert.ok(has(errors, 'references unknown deviceType "ghost"'));
});

test("#3 fragment tolerates a deviceType defined in another fragment", () => {
  const errors = checkSemanticInvariants(
    fragment({ nodes: [{ id: "N1", kind: "inverter", deviceType: "ghost" }] }),
  );
  assert.ok(!has(errors, "unknown deviceType"));
});

test("#3 a declared deviceType table is always enforced, even in a fragment", () => {
  const errors = checkSemanticInvariants(
    fragment({
      deviceTypes: [{ key: "known" }],
      nodes: [{ id: "N1", kind: "inverter", deviceType: "ghost" }],
    }),
  );
  assert.ok(has(errors, 'references unknown deviceType "ghost"'));
});

test("#4 duplicate capability/accessPath offer inside a descriptor template is caught", () => {
  const errors = checkSemanticInvariants(
    fragment({
      deviceTypes: [
        {
          key: "tmpl",
          capabilities: [
            { capability: "battery.soc", accessPath: "a", read: {} },
            { capability: "battery.soc", accessPath: "a", read: {} },
          ],
        },
      ],
    }),
  );
  assert.ok(has(errors, 'deviceType "tmpl" repeats capability/accessPath "battery.soc|a"'));
});

test("#8 serving aggregator without an `over` relation is reported in a site doc", () => {
  const errors = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "ems", aggregate: { serves: true } }] }),
  );
  assert.ok(has(errors, 'aggregate serves but defines no "over" relation'));
});

test("#8 two qualifying aggregators with equal priority are flagged as nondeterministic", () => {
  const errors = checkSemanticInvariants(
    site({
      nodes: [
        { id: "A", kind: "ems", aggregate: { serves: true, over: "contains", priority: 0 } },
        { id: "B", kind: "gateway", aggregate: { serves: true, over: "contains", priority: 0 } },
        { id: "C", kind: "inverter" },
      ],
      relationships: [
        { from: "A", to: "C", type: "contains" },
        { from: "B", to: "C", type: "contains" },
      ],
    }),
  );
  assert.ok(has(errors, "nondeterministic primary"));
});

test("#8 distinct priorities resolve the tie (no error)", () => {
  const errors = checkSemanticInvariants(
    site({
      nodes: [
        { id: "A", kind: "ems", aggregate: { serves: true, over: "contains", priority: 10 } },
        { id: "B", kind: "gateway", aggregate: { serves: true, over: "contains", priority: 1 } },
        { id: "C", kind: "inverter" },
      ],
      relationships: [
        { from: "A", to: "C", type: "contains" },
        { from: "B", to: "C", type: "contains" },
      ],
    }),
  );
  assert.ok(!has(errors, "nondeterministic"));
});

test("#8 an aggregator below its minChildren threshold does not qualify (no false tie)", () => {
  // Mirrors the worked example: gateway serves over contains, minChildren 2, but
  // fronts only one child — it simply doesn't qualify, which is not an error.
  const errors = checkSemanticInvariants(
    site({
      nodes: [
        { id: "GW", kind: "gateway", aggregate: { serves: true, over: "contains", minChildren: 2, priority: 10 } },
        { id: "INV", kind: "inverter" },
      ],
      relationships: [{ from: "GW", to: "INV", type: "contains" }],
    }),
  );
  assert.ok(!has(errors, "aggregate"), `unexpected aggregate error: ${errors.join("; ")}`);
});

test("transform: a vendor kind like GE_RATE_HALF is rejected", () => {
  assert.equal(validateTransform({ kind: "GE_RATE_HALF" }), false);
});

test("transform: a namespaced x-* kind is allowed", () => {
  assert.equal(validateTransform({ kind: "x-acme:weird" }), true);
});

test("transform: ratio accepts a ref param with a factor", () => {
  assert.equal(validateTransform({ kind: "ratio", num: { ref: "capacity", factor: 0.5 }, den: 50 }), true);
});

test("transform: pipeline accepts nested steps", () => {
  assert.equal(
    validateTransform({ kind: "pipeline", steps: [{ kind: "ratio", num: 1, den: 10 }, { kind: "clamp", max: { ref: "rated_power" } }] }),
    true,
  );
});

test("transform ref must resolve to a declared node parameter", () => {
  const errors = checkSemanticInvariants(
    site({
      nodes: [{
        id: "N1", kind: "inverter",
        accessPaths: [{ id: "ap", provider: "p" }],
        capabilities: [{
          capability: "battery.charge_power_limit", ref: 1, accessPath: "ap", unit: "W",
          read: { protocol: "modbus", address: 1, transform: { kind: "ratio", num: { ref: "rated_power" }, den: 100 } },
        }],
      }],
    }),
  );
  assert.ok(has(errors, 'transform ref "rated_power" has no matching node parameter'));
});

test("a declared node parameter satisfies the ref", () => {
  const errors = checkSemanticInvariants(
    site({
      nodes: [{
        id: "N1", kind: "inverter", parameters: { rated_power: 5000 },
        accessPaths: [{ id: "ap", provider: "p" }],
        capabilities: [{
          capability: "battery.charge_power_limit", ref: 1, accessPath: "ap", unit: "W",
          read: { protocol: "modbus", address: 1, transform: { kind: "ratio", num: { ref: "rated_power" }, den: 100 } },
        }],
      }],
    }),
  );
  assert.equal(has(errors, "has no matching node parameter"), false);
});

test("extension transform kinds are reported", () => {
  const notes = collectExtensionTransformKinds(
    site({
      nodes: [{
        id: "N1", kind: "inverter", accessPaths: [{ id: "ap", provider: "p" }],
        capabilities: [{
          capability: "battery.soc", ref: 1, accessPath: "ap", unit: "%",
          read: { protocol: "modbus", address: 1, transform: { kind: "x-acme:weird" } },
        }],
      }],
    }),
  );
  assert.ok(notes.some((n) => n.includes('x-acme:weird')));
});

test("core transform kinds are not reported", () => {
  const notes = collectExtensionTransformKinds(
    site({ nodes: [{ id: "N1", kind: "inverter", accessPaths: [{ id: "ap", provider: "p" }],
      capabilities: [{ capability: "battery.soc", ref: 1, accessPath: "ap", unit: "%", read: { protocol: "modbus", address: 1, transform: { kind: "identity" } } }] }] }),
  );
  assert.deepEqual(notes, []);
});

test("capabilityOffer: shape accepts the closed set", () => {
  for (const s of ["setpoint", "switch", "schedule"]) {
    assert.equal(validateOffer({ capability: "battery.mode", control: { protocol: "modbus", address: 1 }, shape: s, tier: 1 }), true, s);
  }
});

test("capabilityOffer: an unknown shape is rejected", () => {
  assert.equal(validateOffer({ capability: "battery.mode", control: { protocol: "modbus", address: 1 }, shape: "wobble", tier: 1 }), false);
});

test("capabilityOffer: tier is constrained to 1|2 and controlGroup is a string", () => {
  assert.equal(validateOffer({ capability: "battery.mode", control: { protocol: "modbus", address: 1 }, shape: "switch", tier: 3 }), false);
  assert.equal(validateOffer({ capability: "battery.mode", control: { protocol: "modbus", address: 1 }, shape: "switch", tier: 2, controlGroup: "soc_target" }), true);
});

test("capabilityOffer: the old schedule boolean is no longer a known property", () => {
  assert.equal(validateOffer({ capability: "battery.mode", control: { protocol: "modbus", address: 1 }, shape: "schedule", tier: 1, schedule: true }), false);
});

test("binding: readModifyWrite is a boolean", () => {
  assert.equal(validateBinding({ protocol: "cloud-api", address: "/x", readModifyWrite: true }), true);
  assert.equal(validateBinding({ protocol: "cloud-api", address: "/x", readModifyWrite: "yes" }), false);
});

test("a control offer must declare shape and tier", () => {
  const errors = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "inverter", accessPaths: [{ id: "ap", provider: "p" }],
      capabilities: [{ capability: "battery.mode", ref: 1, accessPath: "ap", control: { protocol: "modbus", address: 1 } }] }] }),
  );
  assert.ok(has(errors, 'has a control binding but no shape'));
  assert.ok(has(errors, 'has a control binding but no tier'));
});

test("a fully-declared control offer is clean", () => {
  const errors = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "inverter", accessPaths: [{ id: "ap", provider: "p" }],
      capabilities: [{ capability: "battery.mode", ref: 1, accessPath: "ap", shape: "switch", tier: 1, control: { protocol: "modbus", address: 1 } }] }] }),
  );
  assert.equal(has(errors, "control binding but no"), false);
});

test("controlGroup requires a control binding", () => {
  const errors = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "inverter", accessPaths: [{ id: "ap", provider: "p" }],
      capabilities: [{ capability: "battery.soc", ref: 1, accessPath: "ap", controlGroup: "g", read: { protocol: "modbus", address: 1 } }] }] }),
  );
  assert.ok(has(errors, 'controlGroup "g" but no control binding'));
});

test("the same capability may offer completely divergent control formats per access path", () => {
  // battery.target_soc: local = scalar setpoint (L1 modbus); cloud = whole-schedule RMW, coupled (L2 cloud-api).
  // Same capability + shared ref across access paths; divergent shape/tier/group/RMW is conformant (resolver picks by preference).
  const errors = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "inverter",
      accessPaths: [{ id: "ap-local", provider: "p", preference: 10 }, { id: "ap-cloud", provider: "c", preference: 1 }],
      capabilities: [
        { capability: "battery.target_soc", ref: 1, accessPath: "ap-local", shape: "setpoint", tier: 1,
          control: { protocol: "modbus", address: 82 } },
        { capability: "battery.target_soc", ref: 1, accessPath: "ap-cloud", shape: "schedule", tier: 2, controlGroup: "cloud_plan",
          control: { protocol: "cloud-api", address: "/x", readModifyWrite: true } },
      ] }] }),
  );
  assert.deepEqual(errors, []);
});

test("transform: round accepts trunc/half_up/half_even", () => {
  for (const r of ["trunc", "half_up", "half_even"]) {
    assert.equal(validateTransform({ kind: "ratio", num: 100, den: 5000, round: r }), true, r);
  }
});

test("transform: an unknown round mode is rejected", () => {
  assert.equal(validateTransform({ kind: "ratio", num: 1, den: 2, round: "ceil" }), false);
});

test("transform: round is optional (absent is valid, defaults to trunc)", () => {
  assert.equal(validateTransform({ kind: "ratio", num: 1, den: 10 }), true);
});

test("transform: onRefUnavailable accepts zero/max (max requires a max value), rejects others", () => {
  assert.equal(validateTransform({ kind: "ratio", num: 100, den: { ref: "capacity" }, max: 50, onRefUnavailable: "max" }), true);
  assert.equal(validateTransform({ kind: "ratio", num: 100, den: { ref: "capacity" }, onRefUnavailable: "zero" }), true);
  // onRefUnavailable: "max" without a `max` value is rejected — an executor can't know what to emit.
  assert.equal(validateTransform({ kind: "ratio", num: 100, den: { ref: "capacity" }, onRefUnavailable: "max" }), false);
  assert.equal(validateTransform({ kind: "ratio", num: 1, den: 2, onRefUnavailable: "open" }), false);
});

test("a node parameter may be a static literal or a runtime { source: capability }", () => {
  const ok = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "inverter", parameters: { rated_power: 5000, capacity: { source: "battery.capacity" } },
      accessPaths: [{ id: "ap", provider: "p" }],
      capabilities: [{ capability: "battery.charge_power_limit", ref: 1, accessPath: "ap", unit: "W", shape: "setpoint", tier: 1,
        control: { protocol: "modbus", address: 1, transform: { kind: "ratio", num: 100, den: { ref: "capacity" }, round: "half_up", max: 50, onRefUnavailable: "max" } } }] }] }),
  );
  assert.equal(has(ok, "has no matching node parameter"), false);
});

test("a bare (unqualified) capability name is rejected; class.function and x-* pass", () => {
  const bare = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "heat_pump", accessPaths: [{ id: "ap", provider: "p" }],
      capabilities: [{ capability: "temperature", ref: 1, accessPath: "ap", read: { protocol: "modbus", address: 1 } }] }] }),
  );
  assert.ok(has(bare, 'capability "temperature" is not class.function'));
  const ok = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "heat_pump", accessPaths: [{ id: "ap", provider: "p" }],
      capabilities: [
        { capability: "thermal.temperature", ref: 1, accessPath: "ap", read: { protocol: "modbus", address: 1 } },
        { capability: "x-acme:widget", ref: 2, accessPath: "ap", read: { protocol: "modbus", address: 2 } },
      ] }] }),
  );
  assert.equal(has(ok, "not class.function"), false);
});

test("control-group members must share one binding (one atomic operation)", () => {
  const oneOp = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "inverter", accessPaths: [{ id: "c", provider: "x" }],
      capabilities: [
        { capability: "battery.target_soc", ref: 1, accessPath: "c", shape: "setpoint", tier: 2, controlGroup: "g",
          control: { protocol: "cloud-api", op: "post", address: "/coupled" } },
        { capability: "battery.charge_power_limit", ref: 2, accessPath: "c", shape: "setpoint", tier: 2, controlGroup: "g",
          control: { protocol: "cloud-api", op: "post", address: "/coupled" } },
      ] }] }),
  );
  assert.equal(has(oneOp, "must share one control binding"), false);
  const twoOps = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "inverter", accessPaths: [{ id: "c", provider: "x" }],
      capabilities: [
        { capability: "battery.target_soc", ref: 1, accessPath: "c", shape: "setpoint", tier: 2, controlGroup: "g",
          control: { protocol: "cloud-api", op: "post", address: "/a" } },
        { capability: "battery.charge_power_limit", ref: 2, accessPath: "c", shape: "setpoint", tier: 2, controlGroup: "g",
          control: { protocol: "cloud-api", op: "post", address: "/b" } },
      ] }] }),
  );
  assert.ok(has(twoOps, 'controlGroup "g" members must share one control binding'));
});

test("ref-resolution and x-* reporting recurse through a control binding's pipeline.steps", () => {
  const doc = site({ nodes: [{ id: "N1", kind: "inverter", accessPaths: [{ id: "ap", provider: "p" }],
    capabilities: [{ capability: "battery.charge_power_limit", ref: 1, accessPath: "ap", shape: "setpoint", tier: 1,
      control: { protocol: "modbus", address: 1, transform: { kind: "pipeline", steps: [ { kind: "ratio", num: { ref: "missing_param" }, den: 1 }, { kind: "x-acme:weird" } ] } } }] }] });
  const errors = checkSemanticInvariants(doc);
  assert.ok(has(errors, 'transform ref "missing_param" has no matching node parameter'));
  const notes = collectExtensionTransformKinds(doc);
  assert.ok(notes.some((n) => n.includes("x-acme:weird")));
});
