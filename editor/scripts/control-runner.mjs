import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { validateControl } from "./.gen/control-engine.js";

const here = dirname(fileURLToPath(import.meta.url));
export const CASES_PATH = resolve(here, "..", "..", "conformance", "control", "cases.json");
export const EXPECTED_PATH = resolve(here, "..", "..", "conformance", "control", "expected.json");

export function loadCases() {
  return JSON.parse(readFileSync(CASES_PATH, "utf8"));
}

export function runCase(testCase) {
  return JSON.parse(JSON.stringify(validateControl(testCase.doc, testCase.control)));
}
