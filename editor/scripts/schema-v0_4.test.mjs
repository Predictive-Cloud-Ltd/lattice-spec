import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const schema = JSON.parse(
  readFileSync(resolve(repo, "0.4.0/topology-capability-doc.schema.json"), "utf8"),
);
const example = JSON.parse(
  readFileSync(resolve(repo, "0.4.0/examples/example-site.topology.json"), "utf8"),
);

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

test("the v0.4 calendar-correct worked example validates", () => {
  assert.equal(validate(example), true, JSON.stringify(validate.errors, null, 2));
});

test("every v0.4 schedule offer declares its temporal, mode, execution, and lease surface", () => {
  for (const missing of [
    "timeBasis",
    "supportedModes",
    "gapPolicy",
    "executionModes",
    "leaseRequired",
  ]) {
    const candidate = structuredClone(example);
    delete candidate.nodes[0].capabilities[0].scheduleSpec[missing];
    assert.equal(validate(candidate), false, `schema accepted scheduleSpec without ${missing}`);
  }
});

test("v0.4 rejects local-HHMM and inclusive-end schedule surfaces", () => {
  const local = structuredClone(example);
  local.nodes[0].capabilities[0].scheduleSpec.timeBasis = "local_hhmm";
  local.nodes[0].capabilities[0].scheduleSpec.endBound = "inclusive";
  assert.equal(validate(local), false);
  const errors = JSON.stringify(validate.errors);
  assert.match(errors, /timeBasis/);
  assert.match(errors, /endBound/);
});

test("absoluteScheduleSlot schema uses safe-integer UTC instants", () => {
  const validateSlot = ajv.compile(schema.$defs.absoluteScheduleSlot);
  assert.equal(
    validateSlot({
      start_ts_ms: 1785189600000,
      end_ts_ms: 1785196800000,
      mode: "force_charge",
      enable: false,
    }),
    true,
  );
  assert.equal(
    validateSlot({ start: "23:00", end: "03:00", mode: "force_charge" }),
    false,
  );
});
