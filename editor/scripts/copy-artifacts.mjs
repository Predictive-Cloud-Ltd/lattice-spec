// Copy the canonical schema + example from 0.1.0/ into src/generated/ so the
// editor bundles a single source of truth (no drift). Run by predev/prebuild.
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // editor/scripts
const editor = resolve(here, "..");                    // editor/
const repo = resolve(editor, "..");                    // lattice-spec/
const out = resolve(editor, "src/generated");
mkdirSync(out, { recursive: true });

copyFileSync(
  resolve(repo, "0.1.0/topology-capability-doc.schema.json"),
  resolve(out, "schema.json"),
);
copyFileSync(
  resolve(repo, "0.1.0/examples/givenergy-site.topology.json"),
  resolve(out, "example.json"),
);
console.log("copy-artifacts: wrote src/generated/{schema.json,example.json}");
