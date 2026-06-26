import test from "node:test";
import assert from "node:assert/strict";
import { checkSemanticInvariants } from "../src/conformance.js";

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
    fragment({ nodes: [{ id: "N1", kind: "inverter", capabilities: [{ capability: "soc", read: {} }] }] }),
  );
  assert.deepEqual(errors, []);
});

test("site doc demands docVersion + per-capability ref/accessPath", () => {
  const errors = checkSemanticInvariants(
    site({
      docVersion: undefined,
      nodes: [{ id: "N1", kind: "inverter", capabilities: [{ capability: "soc", read: {} }] }],
    }),
  );
  assert.ok(has(errors, "docVersion must be an integer"));
  assert.ok(has(errors, 'capability "soc" is missing accessPath'));
  assert.ok(has(errors, 'capability "soc" must define integer ref'));
});

test("requireDataPlane override forces strictness on a fragment", () => {
  const errors = checkSemanticInvariants(
    fragment({ nodes: [{ id: "N1", kind: "inverter", capabilities: [{ capability: "soc", read: {} }] }] }),
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
            { capability: "soc", accessPath: "a", read: {} },
            { capability: "soc", accessPath: "a", read: {} },
          ],
        },
      ],
    }),
  );
  assert.ok(has(errors, 'deviceType "tmpl" repeats capability/accessPath "soc|a"'));
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
