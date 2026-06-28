// Pins the reference merge engine to the golden corpus. Other-language reference impls (gateway C++,
// batpred Python) run conformance/merge/cases.json against conformance/merge/expected.json too.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadCases, runCase, EXPECTED_PATH } from "./merge-runner.mjs";

const expected = JSON.parse(readFileSync(EXPECTED_PATH, "utf8"));

for (const c of loadCases()) {
  test(`merge corpus: ${c.name}`, () => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(expected, c.name),
      `no golden for "${c.name}" — run \`npm run merge:record\` and review the diff`,
    );
    assert.deepEqual(runCase(c), expected[c.name]);
  });
}
