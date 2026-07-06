import test from "node:test";
import assert from "node:assert/strict";
import { evalNodeCapability } from "./.gen/graph/eval.js";

const node = {
  id: "GW-1",
  capabilities: [
    { capability: "pv.power", read: { op: "read_input", address: 101 } },
    { capability: "meter.grid_power", read: { op: "read_input", address: 100 } },
    { capability: "battery.power", read: { op: "read_input", address: 102 } },
    {
      capability: "meter.load_power",
      derived: { op: "sum", inputs: [
        { ref: "pv.power", weight: 1 },
        { ref: "meter.grid_power", weight: -1 },
        { ref: "battery.power", weight: -1 },
      ] },
    },
    { capability: "cycle.a", derived: { op: "sum", inputs: [{ ref: "cycle.b" }] } },
    { capability: "cycle.b", derived: { op: "sum", inputs: [{ ref: "cycle.a" }] } },
    { capability: "weird.op", derived: { op: "max", inputs: [{ ref: "pv.power" }] } },
  ],
};
const samples = { "pv.power": 3200, "meter.grid_power": -1200, "battery.power": 800 };

test("read capability returns the raw sample", () => {
  assert.equal(evalNodeCapability(node, "pv.power", samples), 3200);
});

test("derived sum applies weights", () => {
  // 3200*1 + (-1200)*-1 + 800*-1 = 3600
  assert.equal(evalNodeCapability(node, "meter.load_power", samples), 3600);
});

test("default weight is 1 and absent op means sum", () => {
  const n = { capabilities: [{ capability: "d", derived: { inputs: [{ ref: "x" }, { ref: "y" }] } }] };
  assert.equal(evalNodeCapability(n, "d", { x: 2, y: 3 }), 5);
});

test("cycle guard returns undefined", () => {
  assert.equal(evalNodeCapability(node, "cycle.a", samples), undefined);
});

test("unknown derived op returns undefined", () => {
  assert.equal(evalNodeCapability(node, "weird.op", samples), undefined);
});

test("missing input sample returns undefined", () => {
  assert.equal(evalNodeCapability(node, "meter.load_power", { "pv.power": 1 }), undefined);
});

test("undeclared capability falls back to the raw sample", () => {
  assert.equal(evalNodeCapability(node, "not.declared", { "not.declared": 7 }), 7);
});

test("non-numeric sample on a read declines to evaluate (no leaked string)", () => {
  assert.equal(evalNodeCapability(node, "pv.power", { "pv.power": "oops" }), undefined);
});

test("non-numeric sample in a derived input yields undefined, not NaN", () => {
  const v = evalNodeCapability(node, "meter.load_power", {
    "pv.power": "oops",
    "meter.grid_power": -1200,
    "battery.power": 800,
  });
  assert.equal(v, undefined);
});
