// Regenerate the golden expectations from the reference resolver. Run after intentionally changing
// resolve behaviour: `npm run resolve:record`, then review the diff to conformance/resolve/expected.json.
import { writeFileSync } from "node:fs";
import { loadCases, runCase, EXPECTED_PATH } from "./resolve-runner.mjs";

const out = {};
for (const c of loadCases()) out[c.name] = runCase(c);
writeFileSync(EXPECTED_PATH, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${Object.keys(out).length} golden resolutions to ${EXPECTED_PATH}`);
