// Shared loader for the transform-conformance corpus. Pins the EDITOR transform evaluator (the
// reference TS implementation, compiled to scripts/.gen by `npm run build:ref`) against
// language-neutral golden fixtures in conformance/transform/. The gateway (transform.cpp) runs the
// same corpus — that is what makes "similar implementation" mean "identical math".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as ppath } from "node:path";
import { toEng, fromEng } from "./.gen/transform-engine.js";

const here = dirname(fileURLToPath(import.meta.url));
export const CASES_PATH = ppath(here, "..", "..", "conformance", "transform", "cases.json");
export const EXPECTED_PATH = ppath(here, "..", "..", "conformance", "transform", "expected.json");

export function loadCases() {
  return JSON.parse(readFileSync(CASES_PATH, "utf8"));
}

// The observable result: the evaluated value (number) or null (no value / fail-closed).
export function runCase(c) {
  const fn = c.direction === "from_eng" ? fromEng : toEng;
  const out = fn(c.transform, c.input, c.ctx ?? {});
  return JSON.parse(JSON.stringify({ value: out === undefined ? null : out }));
}
