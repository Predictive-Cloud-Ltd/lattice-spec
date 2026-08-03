import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadCases, runCase, EXPECTED_PATH } from "./control-runner.mjs";

const expected = JSON.parse(readFileSync(EXPECTED_PATH, "utf8"));

for (const testCase of loadCases()) {
  test(`control corpus: ${testCase.name}`, () => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(expected, testCase.name),
      `no golden for "${testCase.name}"`,
    );
    assert.deepEqual(runCase(testCase), expected[testCase.name]);
  });
}
