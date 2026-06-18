import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import schema from "./generated/schema.json";
import { checkSemanticInvariants } from "./conformance.js";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const fn = ajv.compile(schema as object);

export type ValidateResult = {
  ok: boolean;
  errors: string[];
  schemaErrors: string[];
  conformanceErrors: string[];
};

export function validateDoc(obj: unknown): ValidateResult {
  const schemaOk = fn(obj) as boolean;
  const schemaErrors = (fn.errors ?? []).map((e) =>
    `${e.instancePath || "(root)"} — ${e.message ?? "invalid"}`.trim(),
  );
  const conformanceErrors = schemaOk ? checkSemanticInvariants(obj) : [];
  const errors = [...schemaErrors, ...conformanceErrors];
  return { ok: schemaOk && conformanceErrors.length === 0, errors, schemaErrors, conformanceErrors };
}
