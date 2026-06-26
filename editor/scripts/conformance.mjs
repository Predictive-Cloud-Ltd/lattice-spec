import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSemanticInvariants, collectExtensionTransformKinds, SPEC_VERSION } from "../src/conformance.js";

const here = dirname(fileURLToPath(import.meta.url));
const editor = resolve(here, "..");
const repo = resolve(editor, "..");
const schemaPath = resolve(repo, SPEC_VERSION, "topology-capability-doc.schema.json");
const examplesDir = resolve(repo, SPEC_VERSION, "examples");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function rel(path) {
  return relative(repo, path);
}

const schema = readJson(schemaPath);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const examples = readdirSync(examplesDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => resolve(examplesDir, name))
  .sort();

let failed = false;
for (const examplePath of examples) {
  const label = rel(examplePath);
  const doc = readJson(examplePath);
  const ok = validate(doc);
  const schemaErrors = (validate.errors ?? []).map((error) => {
    const path = error.instancePath || "(root)";
    return `${label}: ${path} ${error.message ?? "is invalid"}`;
  });
  const semanticErrors = checkSemanticInvariants(doc, { label });
  const errors = [...schemaErrors, ...semanticErrors];

  if (ok && semanticErrors.length === 0) {
    console.log(`ok ${label}`);
  } else {
    failed = true;
    console.error(`not ok ${label}`);
    for (const error of errors) console.error(`  - ${error}`);
  }
  for (const note of collectExtensionTransformKinds(doc)) {
    console.log(`# note ${label}: ${note}`);
  }
}

if (failed) {
  process.exitCode = 1;
}
