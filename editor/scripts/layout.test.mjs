import test from "node:test";
import assert from "node:assert/strict";
import { layoutGraph } from "./.gen/graph/layout.js";

// Diamond: root -> a, root -> b, a -> leaf, b -> leaf
const nodes = ["root", "a", "b", "leaf"].map((id) => ({
  id, type: "device", position: { x: 0, y: 0 }, data: {},
}));
const edges = [
  { id: "e1", source: "root", target: "a" },
  { id: "e2", source: "root", target: "b" },
  { id: "e3", source: "a", target: "leaf" },
  { id: "e4", source: "b", target: "leaf" },
];

const byId = (arr) => Object.fromEntries(arr.map((n) => [n.id, n]));

test("TB: every node gets a finite position and ranks flow downward", () => {
  const out = byId(layoutGraph(nodes, edges, "TB"));
  for (const n of Object.values(out)) {
    assert.ok(Number.isFinite(n.position.x) && Number.isFinite(n.position.y));
  }
  assert.ok(out.root.position.y < out.a.position.y);
  assert.ok(out.a.position.y < out.leaf.position.y);
});

test("LR: ranks flow rightward", () => {
  const out = byId(layoutGraph(nodes, edges, "LR"));
  assert.ok(out.root.position.x < out.a.position.x);
  assert.ok(out.a.position.x < out.leaf.position.x);
});

test("no two nodes share a position", () => {
  const out = layoutGraph(nodes, edges, "TB");
  const keys = out.map((n) => `${n.position.x},${n.position.y}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("edges to unknown nodes are ignored, not fatal", () => {
  const out = layoutGraph(nodes, [...edges, { id: "ghost", source: "root", target: "nope" }], "TB");
  assert.equal(out.length, 4);
});

test("input nodes are not mutated", () => {
  layoutGraph(nodes, edges, "TB");
  assert.deepEqual(nodes[0].position, { x: 0, y: 0 });
});
