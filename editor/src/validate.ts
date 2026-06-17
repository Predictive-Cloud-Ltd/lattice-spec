import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import schema from "./generated/schema.json";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const fn = ajv.compile(schema as object);

export type ValidateResult = { ok: boolean; errors: string[] };

export function validateDoc(obj: unknown): ValidateResult {
  const ok = fn(obj) as boolean;
  const errors = (fn.errors ?? []).map((e) =>
    `${e.instancePath || "(root)"} — ${e.message ?? "invalid"}`.trim(),
  );
  return { ok, errors };
}
