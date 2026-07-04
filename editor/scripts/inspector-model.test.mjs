import test from "node:test";
import assert from "node:assert/strict";
import { buildTopologyModel, buildNodeDetail } from "./.gen/graph/inspector-model.js";

const gw = {
  id: "GW-1", kind: "gateway",
  aggregate: { serves: true, over: "contains" },
  attributes: { ratedW: 10000 },
  capabilities: [
    { capability: "pv.power", read: { op: "read_input", address: 101 } },
    { capability: "meter.grid_power", read: { op: "read_input", address: 100, transform: { kind: "identity" } } },
    { capability: "meter.load_power", derived: { op: "sum", inputs: [
      { ref: "pv.power", weight: 1 }, { ref: "meter.grid_power", weight: -1 },
    ] } },
    { capability: "battery.charge_power_limit", control: { op: "write_single", address: 90 } },
  ],
};
const inv = { id: "INV-1", kind: "inverter", capabilities: [{ capability: "battery.soc", read: {} }] };
const doc = { nodes: [gw, inv], relationships: [{ from: "GW-1", to: "INV-1", type: "contains" }] };
const samples = { "GW-1": { "pv.power": 3200, "meter.grid_power": -1200 } };

test("topology: nodes and relationship edges", () => {
  const m = buildTopologyModel(doc, samples);
  assert.equal(m.nodes.length, 2);
  assert.deepEqual(m.edges, [{ id: "rel-0", source: "GW-1", target: "INV-1", label: "contains" }]);
});

test("topology: aggregate flag, cap count, evaluated key values", () => {
  const m = buildTopologyModel(doc, samples);
  const g = m.nodes.find((n) => n.id === "GW-1");
  assert.equal(g.aggregate, true);
  assert.equal(g.aggregateOver, "contains");
  assert.equal(g.capCount, 4);
  // first 3 caps WITH a value: pv 3200, grid -1200, derived load 4400
  assert.deepEqual(g.keyValues, [
    { label: "pv.power", value: "3200" },
    { label: "meter.grid_power", value: "-1200" },
    { label: "meter.load_power", value: "4400" },
  ]);
});

test("topology: no samples -> no key values, graph still builds", () => {
  const m = buildTopologyModel(doc, null);
  assert.deepEqual(m.nodes.find((n) => n.id === "GW-1").keyValues, []);
});

test("topology: malformed doc -> empty model", () => {
  assert.deepEqual(buildTopologyModel(null, null), { nodes: [], edges: [] });
  assert.deepEqual(buildTopologyModel({ nodes: "nope" }, null), { nodes: [], edges: [] });
});

test("detail: derived formula, depths, derivation edges", () => {
  const d = buildNodeDetail(gw, samples["GW-1"]);
  const load = d.caps.find((c) => c.id === "meter.load_power");
  assert.equal(load.kind, "derived");
  assert.equal(load.detail, "sum(pv.power, meter.grid_power×-1)");
  assert.equal(load.depth, 1);
  assert.equal(load.value, "4400");
  assert.equal(d.edges.length, 2);
  assert.deepEqual(d.edges[1], {
    id: "meter.load_power<-meter.grid_power-1",
    source: "meter.grid_power", target: "meter.load_power", label: "×-1",
  });
});

test("detail: read binding detail includes transform kind", () => {
  const d = buildNodeDetail(gw, {});
  assert.equal(d.caps.find((c) => c.id === "meter.grid_power").detail, "read_input @100 · identity");
});

test("detail: description-only read (read: {}) does not crash", () => {
  const d = buildNodeDetail(inv, {});
  assert.equal(d.caps.find((c) => c.id === "battery.soc").detail, "read");
});

test("detail: controls list and attribute context chips", () => {
  const d = buildNodeDetail(gw, {});
  assert.deepEqual(d.controls, [{ capability: "battery.charge_power_limit", detail: "write_single @90" }]);
  assert.deepEqual(d.context, [{ label: "ratedW", value: "10000" }]);
});

test("detail: undeclared derived input becomes an external-input placeholder", () => {
  const n = { capabilities: [{ capability: "d", derived: { inputs: [{ ref: "ghost.cap" }] } }] };
  const d = buildNodeDetail(n, { "ghost.cap": 5 });
  const ghost = d.caps.find((c) => c.id === "ghost.cap");
  assert.equal(ghost.detail, "external input");
  assert.equal(ghost.value, "5");
});
