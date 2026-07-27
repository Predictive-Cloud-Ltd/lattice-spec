import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  EXPECTED_PATH,
  loadCorpus,
  runCase,
} from "./schedule-v0_4-runner.mjs";

const corpus = loadCorpus();
const expected = JSON.parse(readFileSync(EXPECTED_PATH, "utf8"));

for (const testCase of corpus.cases) {
  test(`schedule v0.4 corpus: ${testCase.name}`, () => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(expected, testCase.name),
      `no golden for "${testCase.name}"`,
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(runCase(testCase, corpus.doc))),
      expected[testCase.name],
    );
  });
}
