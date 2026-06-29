// Shared loader for the merge-conformance corpus. Pins the EDITOR merge engine (the reference TS
// implementation, compiled to scripts/.gen by `npm run build:ref`) against language-neutral golden
// fixtures in conformance/merge/. Other languages (gateway C++, batpred Python) run the same corpus
// with their own runners — that is what makes "similar implementation" mean "identical behaviour".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as ppath } from "node:path";
import { merge } from "./.gen/merge-engine.js";

const here = dirname(fileURLToPath(import.meta.url));
export const CASES_PATH = ppath(here, "..", "..", "conformance", "merge", "cases.json");
export const EXPECTED_PATH = ppath(here, "..", "..", "conformance", "merge", "expected.json");

export function loadCases() {
  return JSON.parse(readFileSync(CASES_PATH, "utf8"));
}

// The observable result of a merge: the merged site doc plus any warnings. JSON-normalised so the
// output is exactly what lands in expected.json (and what other-language runners compare against).
export function runCase(c) {
  const { site, warnings } = merge(c.inputs);
  delete site.docVersion; // normalized out: each impl mints its own; not a cross-language pin
  return JSON.parse(JSON.stringify({ site, warnings }));
}
