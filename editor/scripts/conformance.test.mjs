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
const validateNode = ajvT.compile({ $ref: schema.$id + "#/$defs/node" });
const validateAccessPath = ajvT.compile({ $ref: schema.$id + "#/$defs/accessPath" });
const validateRelationship = ajvT.compile({ $ref: schema.$id + "#/$defs/relationship" });
const validateProducer = ajvT.compile({ $ref: schema.$id + "#/$defs/producer" });

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

test("schema requires kind-specific transform params", () => {
  assert.ok(!validateTransform({ kind: "ratio" }), "ratio needs num+den");
  assert.ok(validateTransform({ kind: "ratio", num: 1, den: 2 }), "ratio with num+den ok");
  assert.ok(!validateTransform({ kind: "pipeline", steps: [] }), "pipeline needs non-empty steps");
  assert.ok(validateTransform({ kind: "pipeline", steps: [{ kind: "identity" }] }), "pipeline with a step ok");
  assert.ok(!validateTransform({ kind: "clamp" }), "clamp needs min or max");
  assert.ok(validateTransform({ kind: "clamp", max: 5 }), "clamp with max ok");
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
        { capability: "battery.target_soc", ref: 1, accessPath: "ap-cloud", shape: "schedule", tier: 2,
          scheduleSpec: { maxSlots: 8, slotFields: ["target_soc"], endBound: "inclusive", requiresDefaultMode: true },
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
        { capability: "battery.target_soc", ref: 1, accessPath: "c", shape: "setpoint", tier: 2, controlGroup: "g", groupSlot: { field: "targetSoc" },
          control: { protocol: "cloud-api", op: "post", address: "/coupled" } },
        { capability: "battery.charge_power_limit", ref: 2, accessPath: "c", shape: "setpoint", tier: 2, controlGroup: "g", groupSlot: { field: "power" },
          control: { protocol: "cloud-api", op: "post", address: "/coupled" } },
      ] }] }),
  );
  assert.equal(has(oneOp, "must share one control binding"), false);
  assert.equal(has(oneOp, "needs a groupSlot"), false);
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

test("groupSlot: exactly one of field/bits (schema)", () => {
  assert.equal(validateOffer({ capability: "battery.target_soc", control: { protocol: "x", address: "/a" }, shape: "setpoint", tier: 2, controlGroup: "g", groupSlot: { field: "targetSoc" } }), true);
  assert.equal(validateOffer({ capability: "battery.mode", control: { protocol: "x", address: 636 }, shape: "switch", tier: 1, controlGroup: "g", groupSlot: { bits: { lsb: 0, width: 2 } } }), true);
  assert.equal(validateOffer({ capability: "battery.mode", control: { protocol: "x", address: 636 }, shape: "switch", tier: 1, controlGroup: "g", groupSlot: { field: "f", bits: { lsb: 0, width: 1 } } }), false); // both
  assert.equal(validateOffer({ capability: "battery.mode", control: { protocol: "x", address: 636 }, shape: "switch", tier: 1, controlGroup: "g", groupSlot: {} }), false); // neither
});

test("a ≥2-member control group needs a groupSlot on every member", () => {
  const errors = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "inverter", accessPaths: [{ id: "c", provider: "x" }],
      capabilities: [
        { capability: "battery.target_soc", ref: 1, accessPath: "c", shape: "setpoint", tier: 2, controlGroup: "g", groupSlot: { field: "targetSoc" },
          control: { protocol: "cloud-api", op: "post", address: "/coupled" } },
        { capability: "battery.charge_power_limit", ref: 2, accessPath: "c", shape: "setpoint", tier: 2, controlGroup: "g",
          control: { protocol: "cloud-api", op: "post", address: "/coupled" } }, // missing groupSlot
      ] }] }),
  );
  assert.ok(has(errors, 'member "battery.charge_power_limit" needs a groupSlot'));
});

test("control-group members must not collide on field or overlapping bits", () => {
  const dupField = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "inverter", accessPaths: [{ id: "c", provider: "x" }],
      capabilities: [
        { capability: "battery.target_soc", ref: 1, accessPath: "c", shape: "setpoint", tier: 2, controlGroup: "g", groupSlot: { field: "f" },
          control: { protocol: "cloud-api", op: "post", address: "/coupled" } },
        { capability: "battery.charge_power_limit", ref: 2, accessPath: "c", shape: "setpoint", tier: 2, controlGroup: "g", groupSlot: { field: "f" },
          control: { protocol: "cloud-api", op: "post", address: "/coupled" } },
      ] }] }),
  );
  assert.ok(has(dupField, 'two members on field "f"'));
  // Solis CID 636-style bit-field: members own distinct bit ranges (ok), overlapping (error).
  const okBits = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "inverter", accessPaths: [{ id: "c", provider: "x" }],
      capabilities: [
        { capability: "battery.mode", ref: 1, accessPath: "c", shape: "switch", tier: 1, controlGroup: "g636", groupSlot: { bits: { lsb: 0, width: 2 } },
          control: { protocol: "modbus", op: "write_single", address: 636 } },
        { capability: "x-solis:allow_grid_charge", ref: 2, accessPath: "c", shape: "switch", tier: 1, controlGroup: "g636", groupSlot: { bits: { lsb: 5, width: 1 } },
          control: { protocol: "modbus", op: "write_single", address: 636 } },
      ] }] }),
  );
  assert.equal(has(okBits, "overlaps"), false);
  const overlapBits = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "inverter", accessPaths: [{ id: "c", provider: "x" }],
      capabilities: [
        { capability: "battery.mode", ref: 1, accessPath: "c", shape: "switch", tier: 1, controlGroup: "g636", groupSlot: { bits: { lsb: 0, width: 3 } },
          control: { protocol: "modbus", op: "write_single", address: 636 } },
        { capability: "x-solis:allow_grid_charge", ref: 2, accessPath: "c", shape: "switch", tier: 1, controlGroup: "g636", groupSlot: { bits: { lsb: 2, width: 1 } },
          control: { protocol: "modbus", op: "write_single", address: 636 } },
      ] }] }),
  );
  assert.ok(has(overlapBits, "overlaps"));
});

const validateOfferC = ajvT.compile({ $ref: schema.$id + "#/$defs/capabilityOffer" });

test("constraints: a bound may be number, string sentinel, or { source: capability }", () => {
  assert.equal(validateOfferC({ capability: "battery.charge_power_limit", control: { protocol: "x", address: 1 }, shape: "setpoint", tier: 1,
    constraints: { min: 0, max: { source: "battery.power_limit_max" } } }), true);
  assert.equal(validateOfferC({ capability: "battery.charge_power_limit", control: { protocol: "x", address: 1 }, shape: "setpoint", tier: 1,
    constraints: { max: "rated" } }), true);
  assert.equal(validateOfferC({ capability: "battery.charge_power_limit", control: { protocol: "x", address: 1 }, shape: "setpoint", tier: 1,
    constraints: { max: { src: "x" } } }), false); // wrong key
});

test("a runtime-sourced constraint bound must resolve to a sibling capability/parameter", () => {
  const bad = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "inverter", accessPaths: [{ id: "ap", provider: "p" }],
      capabilities: [{ capability: "battery.charge_power_limit", ref: 1, accessPath: "ap", shape: "setpoint", tier: 1,
        constraints: { max: { source: "battery.power_limit_max" } }, control: { protocol: "modbus", address: 1 } }] }] }),
  );
  assert.ok(has(bad, 'constraint max source "battery.power_limit_max" is not a capability or parameter'));
  const ok = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "inverter", accessPaths: [{ id: "ap", provider: "p" }],
      capabilities: [
        { capability: "battery.power_limit_max", ref: 2, accessPath: "ap", read: { protocol: "modbus", address: 2 } },
        { capability: "battery.charge_power_limit", ref: 1, accessPath: "ap", shape: "setpoint", tier: 1,
          constraints: { max: { source: "battery.power_limit_max" } }, control: { protocol: "modbus", address: 1 } },
      ] }] }),
  );
  assert.equal(has(ok, "constraint max source"), false);
});

const validateDerived = ajvT.compile({ $ref: schema.$id + "#/$defs/derived" });

test("derived: sum and ratio shapes accepted; malformed rejected", () => {
  assert.equal(validateDerived({ op: "sum", inputs: [{ ref: "pv.power", weight: 1 }, { ref: "battery.power", weight: -1 }] }), true);
  assert.equal(validateDerived({ op: "ratio", num: { ref: "battery.remaining", factor: 100 }, den: { ref: "battery.soc" } }), true);
  assert.equal(validateDerived({ op: "sum" }), false); // no inputs
  assert.equal(validateDerived({ op: "ratio", num: { ref: "a" } }), false); // no den
  assert.equal(validateDerived({ op: "product", inputs: [{ ref: "a" }] }), false); // unknown op
});

test("derived: read computed from siblings, not transport-bound", () => {
  const ok = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "gateway", accessPaths: [{ id: "ap", provider: "p" }],
      capabilities: [
        { capability: "pv.power", ref: 1, accessPath: "ap", read: { protocol: "modbus", address: 1 } },
        { capability: "meter.grid_power", ref: 2, accessPath: "ap", read: { protocol: "modbus", address: 2 } },
        { capability: "battery.power", ref: 3, accessPath: "ap", read: { protocol: "modbus", address: 3 } },
        // derived: no accessPath required (computed); site mode would normally demand one
        { capability: "meter.load_power", ref: 4, derived: { op: "sum", inputs: [
          { ref: "pv.power", weight: 1 }, { ref: "meter.grid_power", weight: -1 }, { ref: "battery.power", weight: -1 } ] } },
      ] }] }),
  );
  assert.deepEqual(ok, []);
});

test("derived input must resolve to a sibling capability/parameter", () => {
  const errors = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "gateway", accessPaths: [{ id: "ap", provider: "p" }],
      capabilities: [
        { capability: "pv.power", ref: 1, accessPath: "ap", read: { protocol: "modbus", address: 1 } },
        { capability: "meter.load_power", ref: 2, derived: { op: "sum", inputs: [{ ref: "pv.power" }, { ref: "battery.power" }] } }, // battery.power absent
      ] }] }),
  );
  assert.ok(has(errors, 'input "battery.power" is not a capability or parameter'));
});

test("derived value is not writable (no control)", () => {
  const errors = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "gateway", accessPaths: [{ id: "ap", provider: "p" }],
      capabilities: [
        { capability: "pv.power", ref: 1, accessPath: "ap", read: { protocol: "modbus", address: 1 } },
        { capability: "meter.load_power", ref: 2, shape: "setpoint", tier: 1,
          derived: { op: "sum", inputs: [{ ref: "pv.power" }] }, control: { protocol: "modbus", address: 9 } },
      ] }] }),
  );
  assert.ok(has(errors, "is derived (computed) and cannot also have a control binding"));
});

test("derived reference cycle is detected", () => {
  const errors = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "gateway", accessPaths: [{ id: "ap", provider: "p" }],
      capabilities: [
        { capability: "meter.a_power", ref: 1, derived: { op: "sum", inputs: [{ ref: "meter.b_power" }] } },
        { capability: "meter.b_power", ref: 2, derived: { op: "sum", inputs: [{ ref: "meter.a_power" }] } },
      ] }] }),
  );
  assert.ok(has(errors, "has a reference cycle"));
});

const validateSlot = ajvT.compile({ $ref: schema.$id + "#/$defs/scheduleSlot" });

test("scheduleSlot: requires start/end/mode; rejects unknown fields", () => {
  assert.equal(validateSlot({ start: "00:30", end: "04:30", mode: "force_charge", target_soc: 90 }), true);
  assert.equal(validateSlot({ start: "00:30", end: "04:30" }), false); // missing mode
  assert.equal(validateSlot({ start: "00:30", end: "04:30", mode: "x", wibble: 1 }), false); // unknown field
});

test("scheduleSpec: only valid slotFields + endBound (schema)", () => {
  assert.equal(validateOffer({ capability: "battery.mode", control: { protocol: "x", address: "/s" }, shape: "schedule", tier: 2,
    scheduleSpec: { maxSlots: 8, slotFields: ["target_soc", "enable"], endBound: "inclusive", requiresDefaultMode: true } }), true);
  assert.equal(validateOffer({ capability: "battery.mode", control: { protocol: "x", address: "/s" }, shape: "schedule", tier: 2,
    scheduleSpec: { slotFields: ["wibble"] } }), false); // unknown slot field
  assert.equal(validateOffer({ capability: "battery.mode", control: { protocol: "x", address: "/s" }, shape: "schedule", tier: 2,
    scheduleSpec: { endBound: "rounded" } }), false); // bad endBound
});

test("a schedule-shape offer must declare a scheduleSpec; scheduleSpec only on schedule offers", () => {
  const missing = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "inverter", accessPaths: [{ id: "ap", provider: "p" }],
      capabilities: [{ capability: "battery.mode", ref: 1, accessPath: "ap", shape: "schedule", tier: 2,
        control: { protocol: "cloud-api", op: "post", address: "/s" } }] }] }),
  );
  assert.ok(has(missing, 'shape "schedule" but no scheduleSpec'));
  const misplaced = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "inverter", accessPaths: [{ id: "ap", provider: "p" }],
      capabilities: [{ capability: "battery.target_soc", ref: 1, accessPath: "ap", shape: "setpoint", tier: 1,
        scheduleSpec: { maxSlots: 4 }, control: { protocol: "modbus", address: 1 } }] }] }),
  );
  assert.ok(has(misplaced, 'scheduleSpec but shape is not "schedule"'));
  const ok = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "inverter", accessPaths: [{ id: "ap", provider: "p" }],
      capabilities: [{ capability: "battery.mode", ref: 1, accessPath: "ap", shape: "schedule", tier: 2,
        scheduleSpec: { maxSlots: 8, slotFields: ["target_soc"], endBound: "inclusive", requiresDefaultMode: true },
        control: { protocol: "cloud-api", op: "post", address: "/s", readModifyWrite: true } }] }] }),
  );
  assert.equal(has(ok, "scheduleSpec"), false);
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

test("producer.authority is an optional integer", () => {
  assert.ok(validateProducer({ name: "p", provider: "x", authority: 50 }));
  assert.ok(validateProducer({ name: "p", provider: "x" }));
  assert.ok(!validateProducer({ name: "p", provider: "x", authority: "hi" }));
});

test("a deviceType template capability must be class.function or x-*", () => {
  const errors = checkSemanticInvariants(
    fragment({ deviceTypes: [{ key: "dt", capabilities: [{ capability: "soc", read: {} }] }], nodes: [{ id: "N1", kind: "inverter", deviceType: "dt" }] }),
  );
  assert.ok(has(errors, "is not class.function"), `expected a capability-name error, got: ${errors.join("; ")}`);
});

test("a class.function deviceType template capability is accepted", () => {
  const errors = checkSemanticInvariants(
    fragment({ deviceTypes: [{ key: "dt", capabilities: [{ capability: "battery.soc", read: {} }] }], nodes: [{ id: "N1", kind: "inverter", deviceType: "dt" }] }),
  );
  assert.ok(!has(errors, "is not class.function"), `unexpected capability-name error: ${errors.join("; ")}`);
});

test("node tombstone needs only id; a normal node still needs kind", () => {
  assert.ok(validateNode({ id: "N1", removed: true }));
  assert.ok(validateNode({ id: "N1", kind: "inverter" }));
  assert.ok(!validateNode({ id: "N1" }), "non-removed node without kind must fail");
  assert.ok(!validateNode({ id: "N1", removed: false }), "removed:false is not a tombstone — kind still required");
});

test("accessPath tombstone needs only id; a normal access path still needs provider", () => {
  assert.ok(validateAccessPath({ id: "ap", removed: true }));
  assert.ok(validateAccessPath({ id: "ap", provider: "gw" }));
  assert.ok(!validateAccessPath({ id: "ap" }), "non-removed access path without provider must fail");
  assert.ok(!validateAccessPath({ id: "ap", removed: false }), "removed:false is not a tombstone — provider still required");
});

test("offer tombstone needs only capability; a normal offer still needs read/control/derived", () => {
  assert.ok(validateOffer({ capability: "battery.soc", removed: true }));
  assert.ok(validateOffer({ capability: "battery.soc", read: { protocol: "modbus", address: 1 } }));
  assert.ok(!validateOffer({ capability: "battery.soc" }), "non-removed offer without a binding must fail");
  assert.ok(!validateOffer({ capability: "battery.soc", removed: false }), "removed:false is not a tombstone — a binding still required");
});

test("relationship may carry removed and still needs from/to/type", () => {
  assert.ok(validateRelationship({ from: "A", to: "B", type: "contains", removed: true }));
  assert.ok(!validateRelationship({ from: "A", to: "B", removed: true }), "tombstone still needs type");
});

test("a merged site doc must not carry tombstones", () => {
  const errors = checkSemanticInvariants(
    site({ nodes: [{ id: "N1", kind: "inverter", removed: true }] }),
  );
  assert.ok(has(errors, "tombstone"), `expected a tombstone error, got: ${errors.join("; ")}`);
});

test("a fragment may carry tombstones (no error)", () => {
  const errors = checkSemanticInvariants(
    fragment({ nodes: [{ id: "N1", removed: true }] }),
  );
  assert.ok(!has(errors, "tombstone"), `unexpected tombstone error: ${errors.join("; ")}`);
});

test("a merged site doc must not carry tombstones in accessPaths, capabilities, or relationships", () => {
  assert.ok(
    has(checkSemanticInvariants(site({ nodes: [{ id: "N1", kind: "inverter", accessPaths: [{ id: "ap1", removed: true }] }] })), "tombstone"),
    "accessPath tombstone should error",
  );
  assert.ok(
    has(checkSemanticInvariants(site({ nodes: [{ id: "N1", kind: "inverter", capabilities: [{ capability: "battery.soc", removed: true }] }] })), "tombstone"),
    "capability tombstone should error",
  );
  assert.ok(
    has(checkSemanticInvariants(site({ relationships: [{ from: "A", to: "B", type: "contains", removed: true }] })), "tombstone"),
    "relationship tombstone should error",
  );
});

test("schema pattern rejects a bare capability name and accepts class.function / x-*", () => {
  assert.ok(!validateOffer({ capability: "soc", read: { protocol: "modbus", address: 1 } }), "bare 'soc' must fail schema");
  assert.ok(validateOffer({ capability: "battery.soc", read: { protocol: "modbus", address: 1 } }), "class.function passes");
  assert.ok(validateOffer({ capability: "x-acme:foo", read: { protocol: "modbus", address: 1 } }), "x-* passes");
  assert.ok(!validateOffer({ capability: "x-:foo", read: { protocol: "modbus", address: 1 } }), "x-* with empty namespace must fail");
});
