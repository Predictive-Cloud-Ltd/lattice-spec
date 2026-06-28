// Regenerate the golden expectations from the reference merge engine. Run after intentionally
// changing merge behaviour: `npm run merge:record`, then review the diff to conformance/merge/expected.json.
import { writeFileSync } from "node:fs";
import { loadCases, runCase, EXPECTED_PATH } from "./merge-runner.mjs";

const out = {};
for (const c of loadCases()) out[c.name] = runCase(c);
writeFileSync(EXPECTED_PATH, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${Object.keys(out).length} golden merges to ${EXPECTED_PATH}`);
