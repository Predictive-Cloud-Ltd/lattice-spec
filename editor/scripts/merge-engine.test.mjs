import test from "node:test";
import assert from "node:assert/strict";
import { merge } from "./.gen/merge-engine.js";
import { checkSemanticInvariants } from "../src/conformance.js";

const frag = (over = {}) => ({ topologyVersion: "0.1.0", scope: "fragment", producer: { name: "p", provider: "x", authority: 0 }, nodes: [], ...over });

test("union: same node via two peer providers → one node, ranked access paths, unioned caps", () => {
  const d = frag({ producer: { name: "gw", provider: "gw", authority: 0 }, nodes: [
    { id: "INV", kind: "inverter", accessPaths: [{ id: "gw-local", provider: "gw", preference: 10 }],
      capabilities: [{ capability: "battery.soc", accessPath: "gw-local", read: {} }] }] });
  const c = frag({ producer: { name: "cloud", provider: "cloud", authority: 0 }, nodes: [
    { id: "INV", kind: "inverter", accessPaths: [{ id: "vendor-cloud", provider: "cloud", preference: 1 }],
      capabilities: [
        { capability: "battery.soc", accessPath: "vendor-cloud", read: {} },
        { capability: "battery.power", accessPath: "vendor-cloud", read: {} }] }] });
  const { site } = merge([d, c]);
  assert.equal(site.scope, "site");
  assert.equal(site.nodes.length, 1);
  const n = site.nodes[0];
  assert.deepEqual(n.accessPaths.map((a) => a.id), ["gw-local", "vendor-cloud"]); // preference desc
  assert.deepEqual(n.capabilities.map((o) => o.capability), ["battery.soc", "battery.soc", "battery.power"]);
  // refs: per (node, capability) — the two soc offers share one ref; power gets the next
  assert.equal(n.capabilities[0].ref, n.capabilities[1].ref);
  assert.notEqual(n.capabilities[0].ref, n.capabilities[2].ref);
});

test("override: higher authority wins a conflicting scalar field, others intact", () => {
  const disc = frag({ nodes: [{ id: "N", kind: "inverter", attributes: { ratedW: 5000 } }] });
  const over = frag({ producer: { name: "i", provider: "installer", authority: 50 }, docVersion: 1, nodes: [{ id: "N", kind: "gateway" }] });
  const { site } = merge([disc, over]);
  assert.equal(site.nodes[0].kind, "gateway");
  assert.equal(site.nodes[0].attributes.ratedW, 5000); // per-field: discovery's attribute survives
});

test("bag: attributes merge per-key by authority", () => {
  const disc = frag({ nodes: [{ id: "N", kind: "inverter", attributes: { ratedW: 5000, phase: 1 } }] });
  const over = frag({ producer: { name: "i", provider: "installer", authority: 50 }, nodes: [{ id: "N", kind: "inverter", attributes: { phase: 3 } }] });
  const { site } = merge([disc, over]);
  assert.deepEqual(site.nodes[0].attributes, { ratedW: 5000, phase: 3 });
});

test("aggregate: cohesive object overridden wholesale by highest authority", () => {
  const disc = frag({ nodes: [{ id: "G", kind: "gateway", aggregate: { serves: true, minChildren: 2 } }] });
  const over = frag({ producer: { name: "i", provider: "installer", authority: 50 }, nodes: [{ id: "G", kind: "gateway", aggregate: { serves: false } }] });
  const { site } = merge([disc, over]);
  assert.deepEqual(site.nodes[0].aggregate, { serves: false });
});

test("tombstone node: removes the node and its relationships", () => {
  const disc = frag({ nodes: [{ id: "A", kind: "gateway" }, { id: "B", kind: "inverter" }], relationships: [{ from: "A", to: "B", type: "contains" }] });
  const over = frag({ producer: { name: "i", provider: "installer", authority: 50 }, nodes: [{ id: "B", removed: true }] });
  const { site, warnings } = merge([disc, over]);
  assert.deepEqual(site.nodes.map((n) => n.id), ["A"]);
  assert.equal(site.relationships, undefined); // the only relationship referenced B
  assert.ok(warnings.some((w) => w.includes("dropped")));
});

test("tombstone offer: removes one offer on a surviving node", () => {
  const disc = frag({ nodes: [{ id: "N", kind: "inverter", accessPaths: [{ id: "ap", provider: "x" }], capabilities: [
    { capability: "battery.soc", accessPath: "ap", read: {} }, { capability: "battery.power", accessPath: "ap", read: {} }] }] });
  const over = frag({ producer: { name: "i", provider: "installer", authority: 50 }, nodes: [{ id: "N", kind: "inverter", capabilities: [
    { capability: "battery.power", accessPath: "ap", removed: true }] }] });
  const { site } = merge([disc, over]);
  assert.deepEqual(site.nodes[0].capabilities.map((o) => o.capability), ["battery.soc"]);
});

test("recency: equal authority, higher docVersion wins", () => {
  const a = frag({ docVersion: 1, nodes: [{ id: "N", kind: "inverter" }] });
  const b = frag({ docVersion: 5, nodes: [{ id: "N", kind: "gateway" }] });
  assert.equal(merge([a, b]).site.nodes[0].kind, "gateway");
  assert.equal(merge([b, a]).site.nodes[0].kind, "gateway"); // order-independent
});

test("merged doc has synthetic producer + inputs provenance + a content-digest docVersion", () => {
  const a = frag({ producer: { name: "gw", provider: "gw", authority: 0 }, docVersion: 3, nodes: [{ id: "N", kind: "inverter" }] });
  const b = frag({ producer: { name: "cloud", provider: "cloud", authority: 0 }, docVersion: 7, nodes: [{ id: "M", kind: "meter" }] });
  const { site } = merge([a, b]);
  assert.equal(site.producer.provider, "lattice-merge");
  assert.deepEqual(site.producer.inputs.map((i) => i.provider), ["gw", "cloud"]); // input order
  assert.ok(Number.isInteger(site.docVersion) && site.docVersion > 0);
  // digest is content-derived: changing merged content changes docVersion
  const c = frag({ producer: { name: "cloud", provider: "cloud", authority: 0 }, docVersion: 7, nodes: [{ id: "M", kind: "gateway" }] });
  assert.notEqual(site.docVersion, merge([a, c]).site.docVersion);
});

test("bare-capability tombstone removes only the access-path-less (derived) offer", () => {
  const disc = frag({ nodes: [{ id: "N", kind: "inverter", accessPaths: [{ id: "ap", provider: "x" }], capabilities: [
    { capability: "meter.load_power", accessPath: "ap", read: {} },
    { capability: "meter.load_power", derived: { op: "sum", inputs: [] } }] }] });
  const over = frag({ producer: { name: "i", provider: "installer", authority: 50 }, nodes: [{ id: "N", kind: "inverter", capabilities: [
    { capability: "meter.load_power", removed: true }] }] });
  const offers = merge([disc, over]).site.nodes[0].capabilities;
  assert.equal(offers.length, 1);
  assert.equal(offers[0].accessPath, "ap"); // the access-path offer survives; the derived one is removed
});

test("survival: a fresh rediscovery does not clobber an upstream override", () => {
  const over = frag({ producer: { name: "i", provider: "installer", authority: 50 }, nodes: [{ id: "N", kind: "gateway" }] });
  const disc1 = frag({ nodes: [{ id: "N", kind: "inverter" }] });
  const disc2 = frag({ docVersion: 9, nodes: [{ id: "N", kind: "inverter", attributes: { ratedW: 6000 } }] });
  assert.equal(merge([disc1, over]).site.nodes[0].kind, "gateway");
  assert.equal(merge([disc2, over]).site.nodes[0].kind, "gateway"); // overlay still wins after rediscovery
});

test("full-tie scalar conflict warns and keeps first", () => {
  const a = frag({ nodes: [{ id: "N", kind: "inverter" }] });
  const b = frag({ nodes: [{ id: "N", kind: "gateway" }] }); // same authority(0) + docVersion(0)
  const { site, warnings } = merge([a, b]);
  assert.equal(site.nodes[0].kind, "inverter");
  assert.ok(warnings.some((w) => w.includes("conflicting values")));
});

test("tombstone of an absent element is a no-op", () => {
  const disc = frag({ nodes: [{ id: "N", kind: "inverter" }] });
  const over = frag({ producer: { name: "i", provider: "installer", authority: 50 }, nodes: [{ id: "GHOST", removed: true }] });
  assert.deepEqual(merge([disc, over]).site.nodes.map((n) => n.id), ["N"]);
});

test("incompatible topologyVersion majors throw", () => {
  const a = frag({ topologyVersion: "0.1.0", nodes: [{ id: "N", kind: "inverter" }] });
  const b = frag({ topologyVersion: "1.0.0", nodes: [{ id: "N", kind: "inverter" }] });
  assert.throws(() => merge([a, b]), /incompatible topologyVersion majors/);
});

test("empty input raises (no valid zero-node site)", () => {
  assert.throws(() => merge([]), /empty document list/);
});

test("deviceTypes are carried into the merged site so node deviceType resolves", () => {
  const frag = { topologyVersion: "0.1.0", scope: "fragment", producer: { name: "gw", provider: "gw", authority: 0 }, docVersion: 1,
    deviceTypes: [{ key: "ge-aio", capabilities: [{ capability: "battery.soc", read: { protocol: "modbus", address: 60 } }] }],
    nodes: [{ id: "INV", kind: "inverter", deviceType: "ge-aio" }] };
  const { site } = merge([frag]);
  assert.deepEqual(site.deviceTypes.map((d) => d.key), ["ge-aio"]);
  const errors = checkSemanticInvariants(site);
  assert.ok(!errors.some((e) => e.includes("references unknown deviceType")), `unexpected: ${errors.join("; ")}`);
});

test("site.id survives from a low-authority input when the top input omits id", () => {
  const disc = { topologyVersion: "0.1.0", scope: "fragment", id: "site:home", producer: { name: "gw", provider: "gw", authority: 0 }, docVersion: 1, nodes: [{ id: "INV", kind: "inverter" }] };
  const over = { topologyVersion: "0.1.0", scope: "fragment", producer: { name: "installer", provider: "installer", authority: 50 }, docVersion: 1, nodes: [{ id: "INV", kind: "gateway" }] };
  const { site } = merge([disc, over]);
  assert.equal(site.id, "site:home");
  assert.equal(site.nodes[0].kind, "gateway");
});
