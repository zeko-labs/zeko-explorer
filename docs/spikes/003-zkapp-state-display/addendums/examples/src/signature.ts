import { createHash } from "node:crypto";
import { Field, PublicKey, Signature, type PrivateKey } from "o1js";
import type { Submission } from "./schema.ts";

export function canonicalize(submission: Submission): string {
  // Strip `owner` (cannot sign itself) and `$schema` (tooling hint, not payload).
  const { owner: _owner, $schema: _schema, ...rest } = submission;
  return canonical(rest);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const entries = value as Record<string, unknown>;
  const keys = Object.keys(entries).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(entries[k])).join(",") + "}";
}

export function digestField(submission: Submission): Field {
  const hash = createHash("sha256").update(canonicalize(submission)).digest();
  const truncated = hash.subarray(0, 31);
  let n = 0n;
  for (const b of truncated) n = (n << 8n) | BigInt(b);
  return Field.from(n.toString());
}

export function signSubmission(privateKey: PrivateKey, submission: Submission): { r: string; s: string } {
  const sig = Signature.create(privateKey, [digestField(submission)]);
  return { r: sig.r.toString(), s: sig.s.toJSON() };
}

export function verifySubmission(submission: Submission): boolean {
  if (!submission.owner) return false;
  const pk = PublicKey.fromBase58(submission.owner.address);
  const sig = Signature.fromJSON({ r: submission.owner.signature.r, s: submission.owner.signature.s }) as Signature;
  return sig.verify(pk, [digestField(submission)]).toBoolean();
}
