import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schemaV1 from "../contract.v1.schema.json" with { type: "json" };
import { SCHEMA_VERSION, type Submission } from "./schema.ts";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

// Fail-fast self-check: the schema file itself must be a valid JSON Schema
// draft 2020-12 document. If this throws, the shipped schema is broken — no
// downstream tool should ever observe it.
if (!ajv.validateSchema(schemaV1)) {
  const errs = (ajv.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ""}`.trim()).join("; ");
  throw new Error(`contract.v1.schema.json is not a valid JSON Schema: ${errs}`);
}

const compiled = ajv.compile<Submission>(schemaV1);

export type ValidationResult =
  | { ok: true; submission: Submission }
  | { ok: false; errors: string[] };

/** Validate a parsed JSON value against `contract.v1.schema.json`. */
export function validateSubmission(input: unknown): ValidationResult {
  if (!compiled(input)) {
    const errors = (compiled.errors ?? []).map(
      (e) => `schema: ${e.instancePath || "/"} ${e.message ?? ""}`.trim(),
    );
    return { ok: false, errors };
  }
  if (input.version !== SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [`unsupported schema version ${String(input.version)} (verifier supports ${SCHEMA_VERSION})`],
    };
  }
  return { ok: true, submission: input };
}

/** Load `contract.json` from disk and validate. Throws on I/O or validation failure. */
export async function loadAndValidate(path: string): Promise<Submission> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`${path}: not found`);
  const parsed: unknown = await file.json();
  const result = validateSubmission(parsed);
  if (!result.ok) {
    throw new Error(`${path}: ${result.errors.join("; ")}`);
  }
  return result.submission;
}
