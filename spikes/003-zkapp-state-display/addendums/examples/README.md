# zeko-contract-schema — runnable example (Bun)

End-to-end reference of the contract submission pipeline:

1. **Author** opens a PR adding `contracts/<name>/contract.json` + `contracts/<name>/fixtures.json`.
2. **CI** runs `bun run verify <dir>` on every changed contract directory: JSON Schema → semantic checks → fixtures → optional owner signature.
3. **Maintainer** reviews and merges.
4. **Maintainer** manually triggers the `publish` workflow (`workflow_dispatch`) which re-verifies and runs `bun run upload put <dir>`. The upload script writes one KV entry per network declared in `meta.networks`.
5. **Contract Registry API** (a standalone GraphQL service in `zeko-explorer`, sibling of the Explorer and Bridge APIs) exposes a `contractSchema(network, address)` query that reads the entry from Cloudflare KV. The federated Hive gateway (spike 4) composes it with the Explorer and Bridge APIs. Decoding runs in the UI via the shared interpreter.

The indexer is never involved. It stores raw fields only.

## Run

```bash
bun install
bun run verify contracts/lumina-pool
bun run sign contracts/owned-counter <privateKeyBase58>
bun run upload put contracts/lumina-pool    # needs CLOUDFLARE_* env vars
```

## Layout

| Path | Purpose |
| --- | --- |
| `contract.v1.schema.json` | Versioned JSON Schema (draft 2020-12). Declares `$schema` pointing at the meta-schema; the verify CLI calls `ajv.validateSchema` at startup as a self-check. Submissions declare `version: 1` and may declare `$schema` for editor autocomplete. |
| `src/schema.ts` | TS types (`Submission`, `Fixture`, `FixtureFile`, `Network`, `Variants`), primitive widths, narrowing helpers |
| `src/validate.ts` | Single shared Ajv-compiled validator (`validateSubmission`, `loadAndValidate`). Used by `verify`, `sign`, and `upload` — nothing that reads `contract.json` ever just does `JSON.parse`. |
| `src/interpreter.ts` | `decodeState`, `decodeEventOrAction` — pure functions used by verify and the explorer UI |
| `src/signature.ts` | Canonical SHA-256 → 31-byte Field digest + `Signature.create` / `Signature.verify`. `$schema` and `owner` are stripped from the canonical payload. |
| `src/verify.ts` | The CLI invoked by the `verify` workflow |
| `src/sign.ts` | Attaches an owner signature in place (validates first) |
| `src/upload.ts` | Re-validates with Ajv, then PUTs/DELETEs KV entries via the Cloudflare REST API. One call per network in `meta.networks`. |
| `src/genkey.ts` | Helper that prints a random Mina keypair |
| `contracts/<name>/contract.json` | The submission — what lands in KV byte-for-byte. Declares `$schema` for editor tooling. |
| `contracts/<name>/fixtures.json` | Golden tests; validated by the TS `FixtureFile` type and run through the interpreter. Not part of the submission payload. |
| `.github/workflows/verify.yml` | Runs on every PR touching registry paths. Discovers changed contract directories and runs `bun run verify` on each. Never writes to KV. |
| `.github/workflows/publish.yml` | Runs only on `workflow_dispatch`. Maintainer chooses mode (`put` / `delete`) and dir; re-verifies then calls `bun run upload`. |

## Verbatim outputs

```
$ bun run verify contracts/lumina-pool
schema:    OK
semantic:  OK
fixtures:  OK
PASS — grade: community-submitted

$ bun run sign contracts/owned-counter EKE…
signed …/contracts/owned-counter/contract.json as B62qpEH1…
$ bun run verify contracts/owned-counter
schema:    OK
semantic:  OK
fixtures:  OK
PASS — grade: owner-signed

$ bun run verify <dir-with-wrong-fixture>
FAIL: fixture[0] (event): expected {…amountOut:"999999999"} actual {…amountOut:"240787553"}
FAIL — 1 error(s)

$ bun run verify <dir-without-meta>
FAIL: schema: / must have required property 'meta'
FAIL — 1 error(s)

$ bun run verify <signed-then-tampered>
FAIL: owner: signature does not verify against meta.address
FAIL — 1 error(s)
```
