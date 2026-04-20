import { PrivateKey } from "o1js";
import { resolve } from "node:path";
import type { Submission } from "./schema.ts";
import { signSubmission } from "./signature.ts";
import { loadAndValidate } from "./validate.ts";

const [contractDir, b58] = process.argv.slice(2);
if (!contractDir || !b58) {
  console.error("usage: sign <contract-dir> <privateKeyBase58>");
  process.exit(2);
}

const path = resolve(contractDir, "contract.json");
// Validate before signing — refuse to sign a malformed submission.
const submission = await loadAndValidate(path);
const priv = PrivateKey.fromBase58(b58);
const owner = priv.toPublicKey().toBase58();

if (submission.meta.address !== owner) {
  console.error(`meta.address (${submission.meta.address}) does not match public key (${owner})`);
  process.exit(1);
}

const { owner: _drop, ...stripped } = submission;
const signature = signSubmission(priv, stripped as Submission);
const signed: Submission = { ...stripped, owner: { address: owner, signature } };

await Bun.write(path, JSON.stringify(signed, null, 2) + "\n");
console.log(`signed ${path} as ${owner}`);
