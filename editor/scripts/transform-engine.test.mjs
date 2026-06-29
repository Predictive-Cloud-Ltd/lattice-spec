import test from "node:test";
import assert from "node:assert/strict";
import { toEng, fromEng } from "./.gen/transform-engine.js";

test("identity / hhmm passthrough both directions", () => {
  for (const kind of ["identity", "hhmm"]) {
    assert.equal(toEng({ kind }, 7), 7);
    assert.equal(fromEng({ kind }, 7), 7);
  }
});

test("negate flips sign both directions", () => {
  assert.equal(toEng({ kind: "negate" }, 5), -5);
  assert.equal(fromEng({ kind: "negate" }, 5), -5);
});

test("affine: raw*scale+offset, inverse (eng-offset)/scale", () => {
  const t = { kind: "affine", scale: 2, offset: 3 };
  assert.equal(toEng(t, 10), 23);
  assert.equal(fromEng(t, 23), 10);
});

test("ratio trunc (default) both directions", () => {
  const t = { kind: "ratio", num: 1, den: 3 };
  assert.equal(toEng(t, 10), 3);          // 10/3 trunc
  assert.equal(fromEng(t, 10), 30);       // 10*3/1
});

test("ratio round modes on the dividing direction", () => {
  assert.equal(fromEng({ kind: "ratio", num: 3, den: 1 }, 10), 3);                  // 10*1/3 trunc -> 3
  assert.equal(fromEng({ kind: "ratio", num: 3, den: 1, round: "half_up" }, 10), 3); // 10/3=3.33 -> 3
  assert.equal(fromEng({ kind: "ratio", num: 2, den: 1, round: "half_up" }, 5), 3);  // 5/2=2.5 -> 3 (half away)
  assert.equal(fromEng({ kind: "ratio", num: 2, den: 1, round: "half_even" }, 5), 2); // 2.5 -> 2 (banker's)
  assert.equal(fromEng({ kind: "ratio", num: 2, den: 1, round: "half_even" }, 7), 4); // 3.5 -> 4 (banker's)
});

test("clamp is idempotent and bounds both directions", () => {
  const t = { kind: "clamp", min: 0, max: 50 };
  assert.equal(toEng(t, 60), 50);
  assert.equal(toEng(t, -5), 0);
  assert.equal(toEng(t, 30), 30);
  assert.equal(fromEng(t, 60), 50);
});

test("pipeline: left->right toEng, reverse+invert fromEng", () => {
  const t = { kind: "pipeline", steps: [{ kind: "affine", scale: 2, offset: 0 }, { kind: "clamp", min: 0, max: 100 }] };
  assert.equal(toEng(t, 10), 20);    // *2 -> 20, clamp -> 20
  assert.equal(toEng(t, 60), 100);   // *2 -> 120, clamp -> 100
  assert.equal(fromEng(t, 20), 10);  // reverse: clamp(20)=20, then (20-0)/2 = 10
});

test("ratio with a ref param resolves from ctx", () => {
  const t = { kind: "ratio", num: { ref: "capacity" }, den: 100 };
  assert.equal(toEng(t, 50, { capacity: 13314 }), 6657);   // 50*13314/100
});

test("ref with factor (exact product)", () => {
  const t = { kind: "ratio", num: { ref: "capacity", factor: 0.5 }, den: 50 };
  assert.equal(toEng(t, 50, { capacity: 13314 }), 6657);   // 50*(13314*0.5)/50 = 6657
});

test("unavailable ref: toEng -> null; fromEng -> null by default", () => {
  const t = { kind: "ratio", num: { ref: "capacity" }, den: 100 };
  assert.equal(toEng(t, 50, {}), null);
  assert.equal(fromEng(t, 3000, {}), null);
});

test("onRefUnavailable: max emits the transform max on fromEng (fail-open)", () => {
  const t = { kind: "ratio", num: { ref: "capacity" }, den: 100, max: 50, onRefUnavailable: "max" };
  assert.equal(fromEng(t, 3000, {}), 50);
  assert.equal(toEng(t, 50, {}), null);   // reads stay fail-closed
});

test("GE capacity read (GE-AIO ratio 317/1)", () => {
  assert.equal(toEng({ kind: "ratio", num: 317, den: 1 }, 42), 13314);
});

test("GE rate cap read/write/fail-open (one bidirectional transform)", () => {
  const t = { kind: "pipeline", steps: [
    { kind: "clamp", min: 0, max: 50 },
    { kind: "ratio", num: { ref: "capacity" }, den: 100, round: "half_up", max: 50, onRefUnavailable: "max" },
  ] };
  assert.equal(toEng(t, 50, { capacity: 13314 }), 6657);   // read
  assert.equal(toEng(t, 60, { capacity: 13314 }), 6657);   // input clamp 60->50 then read
  assert.equal(fromEng(t, 3000, { capacity: 13314 }), 23); // write: 3000*100/13314 half_up = 23
  assert.equal(fromEng(t, 3000, {}), 50);                  // capacity unavailable -> fail-open max
});

test("GE_RATE_FULL write (rated_power ref)", () => {
  const t = { kind: "ratio", num: { ref: "rated_power" }, den: 100, round: "half_up" };
  assert.equal(fromEng(t, 6000, { rated_power: 12000 }), 50);  // 6000*100/12000 = 50
});

test("no transform / unknown x-* kind", () => {
  assert.equal(toEng(undefined, 9), 9);          // no transform = identity
  assert.equal(toEng({ kind: "x-acme:foo" }, 9), null); // vendor extension: not generically evaluable
});
