// Regenerate the golden expectations from the reference transform evaluator. Run after intentionally
// changing transform behaviour: `npm run transform:record`, then review the diff to conformance/transform/expected.json.
import { writeFileSync } from "node:fs";
import { loadCases, runCase, EXPECTED_PATH } from "./transform-runner.mjs";

const out = {};
for (const c of loadCases()) out[c.name] = runCase(c);
writeFileSync(EXPECTED_PATH, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${Object.keys(out).length} golden transform results to ${EXPECTED_PATH}`);
