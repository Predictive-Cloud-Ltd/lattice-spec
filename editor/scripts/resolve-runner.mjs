// Shared loader for the resolve-conformance corpus. Pins the EDITOR resolver (the reference TS
// implementation, compiled to scripts/.gen by `npm run build:ref`) against language-neutral golden
// fixtures in conformance/resolve/. Other languages (gateway C++, batpred Python) run the same
// corpus with their own runners — that is what makes "similar implementation" mean "identical behaviour".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as ppath } from "node:path";
import { resolve as resolveCap } from "./.gen/resolve-engine.js";

const here = dirname(fileURLToPath(import.meta.url));
export const CASES_PATH = ppath(here, "..", "..", "conformance", "resolve", "cases.json");
export const EXPECTED_PATH = ppath(here, "..", "..", "conformance", "resolve", "expected.json");

export function loadCases() {
  return JSON.parse(readFileSync(CASES_PATH, "utf8"));
}

// The observable result of a resolution — the behaviour every language's resolver must agree on.
const FIELDS = [
  "ok", "side", "node", "nodeKind", "chosenAccessPath", "fellBack", "reducer", "routeNodeCount",
  "strategy", "planNodes", "distribution", "ownedNodes", "ownershipNote", "unit", "shape", "tier",
  "controlGroup", "groupMembers", "derived", "clamped", "clampMin", "clampMaxLabel", "binding", "intent", "message",
];
function project(r) {
  const o = {};
  for (const k of FIELDS) if (r[k] !== undefined) o[k] = r[k];
  // Normalise to the JSON-serialisable form: drop nested undefined-valued keys so the
  // observable result is exactly what lands in expected.json (and what other-language
  // runners compare against). Without this, deepEqual sees {op: undefined} ≠ absent op.
  return JSON.parse(JSON.stringify(o));
}

export function runCase(c) {
  const q = c.query;
  const r = resolveCap(c.doc, q.capability, q.side, q.intent, new Set(q.offline ?? []), q.altitude ?? "auto");
  return project(r);
}
