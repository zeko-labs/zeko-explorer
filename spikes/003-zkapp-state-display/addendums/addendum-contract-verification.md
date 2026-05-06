# Contract Submission Pipeline — Specification

This document specifies how a zkApp on Mina/Zeko is described, submitted, verified, published, and rendered. It defines a single artefact (a JSON submission with a pinned schema version), one validation pipeline (the verify CLI), one runtime store (Cloudflare KV), one decoder (the shared interpreter), and one GraphQL surface. Every claim made here is exercised by the runnable example under [`examples/`](./examples/), which uses Bun.

## 1. Architecture

```
┌──────────────────────────┐  PR   ┌───────────────────────────────┐
│ zeko-contract-registry   │──────▶│ .github/workflows/verify.yml  │
│ contracts/<name>/        │       │   bun run verify <dir>        │
│   contract.json          │       │   (self-check → JSON Schema   │
│   fixtures.json          │       │   → semantic → fixtures       │
│ contract.v1.schema.json  │       │   → owner sig)                │
└──────────┬───────────────┘       └───────────────────────────────┘
           │ merge by maintainer     no KV access in this job
           ▼
┌──────────────────────────┐       ┌───────────────────────────────┐
│ main                     │◀──────│ .github/workflows/publish.yml │
│                          │       │   workflow_dispatch only      │
│                          │       │   re-verify → bun run upload  │
└──────────────────────────┘       └──────────────┬────────────────┘
                                                  │ Cloudflare KV REST
                                                  ▼
                                    ┌───────────────────────────┐
                                    │ Cloudflare KV             │
                                    │ key = "<network>:<addr>"  │
                                    │ val = contract.json bytes │
                                    └──────────────┬────────────┘
                                                   │ GraphQL resolver
                                                   ▼
   ┌──────────────┐               ┌───────────────────────────┐
   │ zkApp data   │               │ contract-registry-api     │
   │ (raw fields  │               │   contractSchema(...)     │
   │  from indexer)│               └───────────────┬───────────┘
   └──────┬───────┘                               │
          │                                       │
          ▼                                       ▼
   ┌────────────────────────────────────────────────────────────┐
   │ Unified Hive gateway (see spike 4)                         │
   │   Explorer API + Bridge API + Contract Registry API        │
   └──────────────────────────┬─────────────────────────────────┘
                              │ single GraphQL endpoint
                              ▼
   ┌────────────────────────────────────────────────────────────┐
   │ zeko-explorer UI — raw + labeled side by side              │
   └────────────────────────────────────────────────────────────┘
```

The indexer never reads schemas. Upload is a maintainer action, never automatic. Decoding is a pure function of `(raw_fields, schema)` and runs wherever the trade-off is cleaner — see §7.

## 2. The submission, by example

A submission is a contract directory with two files. The schema-validated file (`contract.json`) is what lands in KV; the fixtures file (`fixtures.json`) is a test artefact consumed only by the verify CLI. The example below is the real **LuminaPool** contract (`B62qrSyBR5jLgekkwjDdpt6UX8FfYntYB1uXydFyViWMFLkrGSceFEV`) on `zeko-m-devnet`.

### 2.1 `contract.json`

```json
{
  "$schema": "https://zeko.io/schema/v1/contract.json",
  "version": 1,
  "meta": {
    "address": "B62qrSyBR5jLgekkwjDdpt6UX8FfYntYB1uXydFyViWMFLkrGSceFEV",
    "networks": ["zeko-m-devnet"],
    "name": "LuminaPool",
    "description": "Lumina constant-product pool. Holds reserves for two assets and tracks liquidity supply."
  },
  "state": {
    "slots": [
      { "at": 0, "name": "reserve0",       "type": "UInt64" },
      { "at": 1, "name": "reserve1",       "type": "UInt64" },
      { "at": 2, "name": "totalLiquidity", "type": "UInt64" }
    ]
  },
  "events": {
    "discriminator": { "at": 0 },
    "variants": [
      { "when": "0", "kind": "AddLiquidity",
        "fields": [
          { "at": 1, "name": "sender",   "type": "PublicKey" },
          { "at": 3, "name": "a0In",     "type": "UInt64" },
          { "at": 4, "name": "a1In",     "type": "UInt64" },
          { "at": 5, "name": "lpOut",    "type": "UInt64" }
        ]
      },
      { "when": "3", "kind": "ReceiveMina",
        "fields": [
          { "at": 1, "name": "sender",   "type": "PublicKey" },
          { "at": 3, "name": "amountIn", "type": "UInt64" }
        ]
      },
      { "when": "4", "kind": "Swap",
        "fields": [
          { "at": 1, "name": "sender",    "type": "PublicKey" },
          { "at": 3, "name": "amountIn",  "type": "UInt64" },
          { "at": 4, "name": "amountOut", "type": "UInt64" }
        ]
      }
    ]
  }
}
```

### 2.2 `fixtures.json`

```json
{
  "fixtures": [
    { "target": "state",
      "raw": ["1000000000", "4056640838", "9023684", "0", "0", "0", "0", "0"],
      "expected": { "reserve0": "1000000000", "reserve1": "4056640838", "totalLiquidity": "9023684" } },

    { "target": "event",
      "raw": ["0", "7994353054957568193498626604873088658666758397914343032172656113958151515402", "0",
              "1000000000", "4056640838", "9023684"],
      "expected": { "kind": "AddLiquidity", "sender": "B62qipa4xp6pQKqAm5qoviGoHyKaurHvLZiWf3djDNgrzdERm6AowSQ",
                    "a0In": "1000000000", "a1In": "4056640838", "lpOut": "9023684" } },

    { "target": "event",
      "raw": ["3", "7994353054957568193498626604873088658666758397914343032172656113958151515402", "0", "1000000000"],
      "expected": { "kind": "ReceiveMina", "sender": "B62qipa4xp6pQKqAm5qoviGoHyKaurHvLZiWf3djDNgrzdERm6AowSQ",
                    "amountIn": "1000000000" } },

    { "target": "event",
      "raw": ["4", "7994353054957568193498626604873088658666758397914343032172656113958151515402", "0",
              "1000000000", "240787553"],
      "expected": { "kind": "Swap", "sender": "B62qipa4xp6pQKqAm5qoviGoHyKaurHvLZiWf3djDNgrzdERm6AowSQ",
                    "amountIn": "1000000000", "amountOut": "240787553" } }
  ]
}
```

Both files live at [`examples/contracts/lumina-pool/`](./examples/contracts/lumina-pool/). Running `bun run verify contracts/lumina-pool` produces:

```
schema:    OK
semantic:  OK
fixtures:  OK
PASS — grade: community-submitted
```

### 2.3 The DSL

| Concept | Form | Notes |
| --- | --- | --- |
| **Version** | `version: 1` | Pinned literal. The JSON Schema file is `contract.v1.schema.json`. New versions ship as new schema files; the verifier dispatches on `version`. |
| **Slot** | `{ at, name, type }` | `at` is the index into the raw field array |
| **Type** | `Field` `UInt32` `UInt64` `Bool` (1 slot) · `PublicKey` (2 slots) · user-declared `Struct` (recursive sum of widths) | Decoded values are JSON: integers as decimal strings, `Bool` as boolean, `PublicKey` as Base58 |
| **State** | `{ slots: Slot[] }` | Always 8 raw fields. A slot whose declared type spans past index 8 is rejected |
| **Events / Actions** | `null` *or* `{ fields: Slot[] }` *or* `{ discriminator: { at }, variants: [{ when, kind, fields }] }` | Three shapes only |
| **Struct** | `{ fields: { name, type }[] }` declared under `types` | Slots laid out contiguously in declaration order |
| **Networks** | `meta.networks: Network[]` | Non-empty set of networks on which this exact address is the same contract. The upload script writes one KV key per network. |
| **Fixture** | `{ target: "state"\|"event"\|"action", raw: string[], expected: ... }` | Lives in a separate `fixtures.json`. Typed by `FixtureFile` in `schema.ts` and executed by the interpreter. Not part of the JSON Schema and never uploaded to KV. |
| **Owner** | optional `{ address, signature: { r, s } }` | Signature over the canonical submission with the `owner` block stripped |

The full JSON Schema is at [`examples/contract.v1.schema.json`](./examples/contract.v1.schema.json).

## 3. The verify pipeline

The CLI in [`examples/src/verify.ts`](./examples/src/verify.ts) executes five stages in order; the first failure short-circuits.

| # | Stage | What it checks |
| --- | --- | --- |
| 0 | **Schema self-check** | At CLI startup, `ajv.validateSchema(contract.v1.schema.json)` confirms the schema file is itself a valid JSON Schema draft 2020-12 document. Fails fast before any submission is touched. |
| 1 | **JSON Schema** | The submission is validated with an Ajv-compiled validator (never `JSON.parse` + cast): `version === 1`, required fields, `B62q…` address pattern, network enum, integer slot indices, allowed types. The optional `$schema` property lets editors like VSCode autocomplete and validate the file in place. |
| 2 | **Semantic** | Every type resolves; state slots stay within 8 fields; `owner.address == meta.address` if present |
| 3 | **Fixtures** | Parse `fixtures.json`; run the interpreter on each `fixture.raw`; deep-equal against `fixture.expected`. Reject on mismatch and print both values |
| 4 | **Owner signature** | If `owner` is present, recompute the canonical digest (which strips `owner` and `$schema`) and call `Signature.verify` against `meta.address` |
| 5 | **Source linkage** *(future)* | If `meta.source` and `meta.vkeyHash` are present, clone, build, and compare the produced verification-key hash |

The Ajv-compiled validator lives in [`examples/src/validate.ts`](./examples/src/validate.ts) and is reused by `sign.ts` and `upload.ts` — nothing that reads `contract.json` ever just parses and casts.

## 4. Verification grades

| Grade | Earned when | UI badge |
| --- | --- | --- |
| `owner-signed` | Stage 4 passes | green, "Owner-signed by `B62q…`" |
| `source-linked` | Stage 5 passes (no owner block) | blue, "Source-linked to `<repo>@<commit>`" |
| `community-submitted` | Stages 1–3 pass with neither owner nor source | grey, "Community-submitted, fixtures verified" |

Grades are mutually exclusive and ordered. Multiple submissions for the same `(network, address)` are not allowed; resubmission requires a PR that updates the existing file. The grade is recomputed on the fly by the contract-registry-api resolver so it always matches the current submission.

## 5. Owner signature scheme

The signature proves that whoever holds the private key for `meta.address` authored *this exact submission*. Mutating any field invalidates it.

1. Strip the `owner` block from the submission.
2. Serialize with sorted keys (`signature.ts:canonical`).
3. SHA-256, take the first 31 bytes, interpret big-endian as a `Field`.
4. Sign with `Signature.create(privateKey, [digestField])`.
5. Store `{ r, s }` as decimal strings under `owner.signature`.

The 31-byte truncation keeps the digest below the Pallas field modulus.

## 6. CI and publish

Two separate workflow files — one per responsibility, so the publish path has no overlap with the review path:

**[`.github/workflows/verify.yml`](./examples/.github/workflows/verify.yml)** — runs on every PR whose diff touches `contracts/**`, `src/**`, the schema file, or `package.json`. For each changed contract directory it runs `bun run verify <dir>`. Never writes to KV and never reads Cloudflare secrets. Branch protection on `main` requires this job to pass.

**[`.github/workflows/publish.yml`](./examples/.github/workflows/publish.yml)** — triggers only via `workflow_dispatch`. A maintainer provides `mode` (`put` or `delete`) and `dir` (the contract directory). The job re-runs `bun run verify <dir>` (in `put` mode), then runs `bun run upload <mode> <dir>`. Scoped to a protected `contract-registry-publish` environment so Cloudflare secrets never leak into PR-triggered runs. It does **not** run on push to main. Merging a PR does not touch KV.

The upload script ([`examples/src/upload.ts`](./examples/src/upload.ts)) re-validates the submission with Ajv before any network call, uses the Cloudflare REST API directly via `fetch`, and writes one key per network listed in `meta.networks`. It reads `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `KV_NAMESPACE_ID` from the environment. Maintainers can run it locally too — it's the same code the workflow runs.

## 7. Runtime read path (GraphQL)

A standalone **Contract Registry API** (sibling of the Explorer and Bridge APIs in this monorepo) exposes one query and one type. Everything else — accounts, events, actions — stays on the Explorer API and returns raw fields only. The unified Hive gateway (spike 4) joins the two so a UI page can fetch raw fields and labels in a single round trip.

```graphql
scalar JSON

enum VerificationGrade { OWNER_SIGNED SOURCE_LINKED COMMUNITY_SUBMITTED }

type ContractSource {
  repo: String!
  commit: String!
}

type ContractMeta {
  address: String!
  networks: [String!]!
  name: String!
  description: String
  source: ContractSource
  vkeyHash: String
}

type ContractSchema {
  version: Int!
  meta: ContractMeta!
  state: JSON!           # { slots: [...] }
  events: JSON           # null | { fields: [...] } | { discriminator, variants }
  actions: JSON
  types: JSON            # user-declared Structs, keyed by name
  grade: VerificationGrade!
}

extend type Query {
  contractSchema(network: String!, address: String!): ContractSchema
}
```

The resolver reads `${network}:${address}` from KV and returns `null` on miss. The response is cached at the edge for 5 minutes with `stale-while-revalidate=86400`.

### 7.1 Where decoding runs

Decoding is a pure function of `(raw_fields, schema)`. It runs in the UI: the unified Hive gateway (spike 4) joins a single page query into Explorer-API raw fields and Contract-Registry-API schema, and the shared `@zeko/contract-schema` module decodes in the browser. Server-side decoding (e.g. as a gateway custom resolver, useful for hot multi-contract feeds) is a future option scoped to spike 4 — not in scope here. The indexer stays dumb either way.

## 8. Failure modes (verbatim)

```
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

## 9. Schema versioning

`version` is a required integer pinned to a literal in the current JSON Schema (`contract.v1.schema.json` accepts only `version: 1`). Evolving the DSL means:

1. Ship `contract.v2.schema.json` with new or changed fields.
2. The verify CLI dispatches on `submission.version`, loads the matching schema, and runs the matching interpreter path.
3. Existing v1 submissions keep validating against v1; no migration is forced.
4. The contract-registry-api and UI understand both versions as long as the interpreter supports them.

This is cheap to add later but expensive to retrofit if omitted, so the field is required from day one.

## 10. Non-goals

- **No on-chain registry.** The registry is a git repo plus a KV namespace.
- **No runtime contract code.** Submissions are pure data. The interpreter stays small and shared.
- **No automatic KV writes.** Maintainers dispatch the `publish` job after review.
- **No automatic source-build verification today.** The schema reserves `meta.source` and `meta.vkeyHash` so stage 5 can be enabled without changing the JSON Schema or the runtime.
