# Addendum: Contract Verification and Registry

This addendum supersedes the `known-contracts.json` design sketched in results.md §4. That sketch has three structural problems: (a) a static JSON file cannot scale to user-submitted contracts, (b) labels are not cryptographically bound to the on-chain contract code, so they can drift or lie, and (c) it pushed user-facing contract pages to "future / post-launch," which is out of scope per the PRD. This addendum replaces it with a verification-key-grounded registry backed by Cloudflare KV, a sandboxed verification service, and a signature-based owner-claim flow, all fitted inside Milestone 1 (backend) and Milestone 2 (UI) of the PRD.

---

## 1. Design Goals

1. **Cryptographic binding.** A contract's displayed state/event/action labels must be derivable from the exact source code that produced the on-chain verification key. No free-form label entry. No trust in submitters for fields the chain can attest.
2. **Open submission.** Anyone can submit a contract for verification. No central gatekeeper. No maintenance PR to this repository.
3. **Efficient on-demand lookup.** API label resolution is O(1) at the edge, with no in-memory registry loaded by the indexer, no cold-start warm-up, no rebuild on registry change.
4. **Owner-friendly metadata.** Contract owners can attach a GitHub repository, homepage, description, and logo. Ownership is cryptographically proven by signing with the contract account's private key.
5. **Fits inside established milestones.** Backend (verification service + KV + API mutations + label resolution) in Milestone 1. Frontend (submission wizard, verified contract pages, owner dashboard) in Milestone 2. No "future" bucket.
6. **Graceful for unverified contracts.** Unverified contracts still render usefully — raw fields, transaction history — with a clear "Verify this contract" call to action.

---

## 2. Architecture Overview

```
                         ┌──────────────────────────────┐
                         │  Contract owner / anyone     │
                         └──────────────┬───────────────┘
                                        │ submitContractForVerification
                                        ▼
┌───────────────────────────────────────────────────────────────────┐
│                 Explorer GraphQL API (Pothos)                      │
│  submitContractForVerification() → enqueues job, returns id       │
│  verificationProgress(id) → SSE subscription                      │
│  contract(vkeyHash | address) → KV read, O(1)                     │
└───────────────┬──────────────────────────────┬────────────────────┘
                │                              │
                │ enqueue job                  │ KV.get()
                ▼                              ▼
┌───────────────────────────────┐   ┌───────────────────────────────┐
│  Verification Service          │   │  Cloudflare KV                 │
│  (Cloudflare Container, or     │   │                                │
│   isolated Docker worker)      │   │  contract:vkey:<hash> → meta   │
│                                │   │  contract:addr:<net>:<addr>    │
│  1. git clone <repo>@<sha>     │   │    → vkey_hash                 │
│  2. npm ci                     │   │  contract:claim:<vkey_hash>    │
│  3. Import contract class      │   │    → signed claim              │
│  4. await Class.compile()      │   │  contract:owner:<vkey_hash>    │
│  5. Extract vkey hash          │   │    → owner metadata            │
│  6. Reflect state/events       │   └───────────────────────────────┘
│  7. Match vkey to on-chain     │                ▲
│  8. Write to KV                │                │
└────────────────────┬───────────┘                │
                     │                            │
                     └─ KV.put() ─────────────────┘
                     │
                     ▼
┌───────────────────────────────────────────────────────────────────┐
│                    zeko-indexer (TypeScript)                       │
│                                                                    │
│  On zkApp command ingestion, after writing account record:         │
│    KV.put("contract:addr:<network>:<address>", vkey_hash)          │
│  (enables address → vkey reverse lookup for the API)               │
└───────────────────────────────────────────────────────────────────┘
```

Three subsystems:

- **Verification Service** — sandboxed runtime that clones, compiles, reflects, matches. Cloudflare's Container runtime (GA as of 2026) is a natural fit: short-lived containers per job, no persistent state, isolated from the rest of the stack. Alternative (also acceptable for M1): a Fly.io or Hetzner Docker worker polling a job queue.
- **Cloudflare KV** — the registry itself. Three keyspaces: vkey → metadata, address → vkey, vkey → owner-claim. Edge-cached (reads typically <1 ms after warm-up, ~10 ms cold).
- **Explorer GraphQL API** — thin wrapper: submit mutation writes a job, query resolvers read KV. No database table for verified contracts.

---

## 3. Verification Pipeline

### 3.1 Submission input

```graphql
input ContractSubmissionInput {
  repository:     String!   # e.g., "https://github.com/acme/my-zkapp"
  commitSha:      String!   # 40-char git commit
  entryFile:      String!   # path to contract source, e.g. "src/MyContract.ts"
  className:      String!   # exported class, e.g. "MyContract"
  packageManager: PkgMgr    # NPM | PNPM | YARN (defaults to auto-detect)
  address:        String    # optional: on-chain address to match vkey against
  network:        NetworkId # required if address is provided
  manifest:       Manifest  # optional additional metadata (§4.2)
}
```

The submitter does **not** provide labels. The verification service derives them. The submitter provides only the material needed to reproduce the compilation.

### 3.2 Sandbox execution

Per-job container, throwaway:

- **Filesystem**: empty working directory, writable tmpfs, read-only root.
- **Network**: allow-list — only `github.com`, `registry.npmjs.org`, the network's Mina GraphQL endpoint (for vkey comparison). No arbitrary egress.
- **Resources**: 2 GB RAM, 2 vCPU, 5-minute wall-clock budget. o1js compilation of a typical contract is CPU-bound and fits.
- **Secrets**: none. Worker has no access to KV write keys directly — it emits a signed verification result that the API writes to KV on its behalf. This prevents a compromised worker from forging verifications for arbitrary contracts.

### 3.3 Pipeline stages

```
PENDING ──► CLONING ──► INSTALLING ──► COMPILING ──► REFLECTING ──► MATCHING ──► VERIFIED
                                                                         │
                                                                         └──► FAILED (at any stage)
```

| Stage | What it does | Failure reasons |
|---|---|---|
| `CLONING` | `git clone --depth 1 --branch <branch>`, then `git fetch origin <sha>` + `git checkout <sha>`. Rejects if the SHA isn't on the default branch or on a tag. | unreachable repo, unknown SHA, non-public repo |
| `INSTALLING` | Detects lockfile (`pnpm-lock.yaml` / `package-lock.json` / `yarn.lock`). Runs `<pkgmgr> install --frozen-lockfile`. | lockfile mismatch, missing lockfile, network-blocked dependency |
| `COMPILING` | Dynamically imports `${entryFile}`, reads the exported `className`, calls `await Class.compile()`. Records `verificationKey.hash`. | file missing, class not exported, class doesn't extend SmartContract, compile throws |
| `REFLECTING` | Walks decorated `@state` properties, the `events` object, and the `reducer.actionType` on the class — see §4. | unknown state/event type (not a provable type), non-serializable manifest |
| `MATCHING` | If `address` + `network` provided: fetches the deployed `verificationKey.hash` from the network's Mina GraphQL endpoint. Compares. | on-chain vkey differs from computed vkey, address not a zkApp account, address doesn't exist |
| `VERIFIED` | Emits a signed `VerificationResult` to the API. API writes KV. | — |

Progress is streamed over SSE so the submission UI shows live status.

### 3.4 Signed verification result

The worker signs its output with a long-lived key held by the API. Only results signed by this key are accepted into KV:

```json
{
  "vkeyHash": "12345...",
  "o1jsVersion": "2.4.0",
  "sourceRef": { "repository": "...", "commitSha": "...", "entryFile": "...", "className": "..." },
  "stateFields": [ /* §4.1 */ ],
  "events":      { /* §4.1 */ },
  "actions":     { /* §4.1 */ },
  "manifest":    { /* §4.2 */ },
  "verifiedAt":  "2026-04-17T12:34:56Z",
  "signature":   "<Ed25519 over the above, canonical JSON>"
}
```

---

## 4. What Gets Extracted (and Why It's Trustworthy)

### 4.1 Runtime reflection — the part that's cryptographically bound

`Class.compile()` produces the verification key from the same class the reflection step introspects. If the class were modified between compile and reflect, `Class.compile()` would return a different vkey and the `MATCHING` step would reject. This is the cryptographic binding: **the labels are extracted from the bytecode that produced the on-chain verification key**.

Reflection reads three things from the loaded class:

1. **`@state` layout** — o1js's `@state(Type)` decorator records `(propertyKey, ProvableType)` into `Class._fields` (the internal registry walked by the zkApp runtime). Each `ProvableType` exposes `sizeInFields()`. The verifier walks the list in declaration order and assigns consecutive slot indices. Over-budget declarations (>8 slots) would have failed `Class.compile()` already.

2. **`events` object** — an instance property defined as `events = { name: Type }`. Iterate keys, record `(name, Type.sizeInFields(), field layout)`. Multi-event contracts: o1js emits events as `[eventTypeHash, ...fieldsOfType]`. The verifier records both the discriminator (hash of each key) and the inner field layout per key.

3. **`reducer.actionType`** — an instance property `reducer = Reducer({ actionType })`. Single-type actions need no discriminator. The common multi-type pattern is `actionType: Field` with a user-chosen convention (as in the Zeko bridge) — this case requires a manifest entry (§4.2).

Output shape:

```json
{
  "stateFields": [
    { "index": 0, "label": "x",     "type": "Field",     "slots": 1 },
    { "index": 1, "label": "owner", "type": "PublicKey", "slots": 2 }
  ],
  "events": {
    "discriminator": { "fieldIndex": 0, "type": "field_hash",
                       "values": { "<hash-of-updated>": "updated",
                                   "<hash-of-transferred>": "transferred" } },
    "schemas": {
      "updated":     [ { "index": 0, "label": "_type", "type": "Field" },
                       { "index": 1, "label": "value", "type": "Field" } ],
      "transferred": [ { "index": 0, "label": "_type", "type": "Field" },
                       { "index": 1, "label": "to",    "type": "PublicKey", "slots": 2 } ]
    }
  },
  "actions": { "discriminator": null, "schemas": [
                 { "index": 0, "label": "value", "type": "Field" } ] }
}
```

### 4.2 `zeko.manifest.json` — the part that isn't

A small amount of metadata cannot be derived from source alone:

- Action discriminator convention (e.g., "field index 0 is a string tag") for contracts whose `actionType` is a generic `Field`.
- Display name, short description, homepage, repository, logo URL.

These live in a `zeko.manifest.json` at the repo root:

```json
{
  "name": "Zeko Bridge — Outer (L1)",
  "description": "L1 bridge contract managing commit and witness actions for the Zeko rollup.",
  "homepage": "https://zeko.io",
  "repository": "https://github.com/zeko-labs/zeko",
  "logo": "./assets/logo.svg",
  "actions": {
    "discriminator": { "fieldIndex": 0, "type": "string_tag",
                       "values": { "0": "commit", "1": "witness" } },
    "schemas": {
      "commit":  [
        { "index": 1, "label": "inner_action_state",  "type": "Field" },
        { "index": 2, "label": "inner_ledger_hash",   "type": "Field" },
        { "index": 3, "label": "slot_lower",          "type": "UInt32" },
        { "index": 4, "label": "slot_upper",          "type": "UInt32" }
      ],
      "witness": [
        { "index": 1, "label": "aux", "type": "Field" }
      ]
    }
  }
}
```

**Enforced correctness where possible.** The verifier validates the manifest against the reflected reality:

- Manifest `stateFields` (if present): must exactly match reflected layout → reject on mismatch.
- Manifest `events.schemas` (if present): same.
- Manifest `actions.schemas`: field count must equal the reflected action arity (o1js knows how many fields an action occupies even when it uses `Field` as actionType). Labels beyond that — free.
- `discriminator.fieldIndex` must be within the action's field count.
- `logo` URL must resolve to an image within the repo or to HTTPS.

Where the manifest is descriptive rather than structural (`name`, `description`, `homepage`), the verifier does not police content — the UI handles trust signals (verified-deployer badge, etc.).

---

## 5. Worked Example — a Real o1js Contract

### 5.1 `HelloWorld` — source

```typescript
// src/HelloWorld.ts
import { SmartContract, state, State, Field, method } from 'o1js';

export class HelloWorld extends SmartContract {
  @state(Field) x = State<Field>();

  events = {
    'x-updated': Field,
  };

  init() {
    super.init();
    this.x.set(Field(0));
  }

  @method async update(newValue: Field) {
    const current = this.x.getAndRequireEquals();
    current.assertNotEquals(newValue);
    this.x.set(newValue);
    this.emitEvent('x-updated', newValue);
  }
}
```

### 5.2 Step through the verifier

1. **CLONING.** `git clone https://github.com/acme/hello-world` @ `commit abc123d`.
2. **INSTALLING.** `pnpm install --frozen-lockfile` locks `o1js@2.4.0`.
3. **COMPILING.** The worker runs:
   ```typescript
   import { HelloWorld } from './src/HelloWorld.js';
   const { verificationKey } = await HelloWorld.compile();
   const vkeyHash = verificationKey.hash.toString();
   // → "12345678901234567890123456789012345678901234567890123456789012345"
   ```
4. **REFLECTING.** Walks `HelloWorld._fields` (the internal registry populated by `@state`):
   - `x`: type `Field`, `Field.sizeInFields() === 1` → slot 0.
   - `HelloWorld.prototype.events`: single entry `'x-updated': Field` → single-type, no discriminator.
   - `HelloWorld.prototype.reducer` is undefined → no actions.
5. **MATCHING.** Submitter provided `address: B62qHello...`, `network: zeko-m-devnet`. Worker queries the L2 GraphQL:
   ```graphql
   query { account(publicKey: "B62qHello...") { zkapp { verificationKey { hash } } } }
   ```
   Returns `12345678901234567890123456789012345678901234567890123456789012345`. Match.
6. **VERIFIED.** Worker emits:

```json
{
  "vkeyHash": "12345678901234567890123456789012345678901234567890123456789012345",
  "o1jsVersion": "2.4.0",
  "sourceRef": {
    "repository": "https://github.com/acme/hello-world",
    "commitSha":  "abc123d...",
    "entryFile":  "src/HelloWorld.ts",
    "className":  "HelloWorld"
  },
  "stateFields": [
    { "index": 0, "label": "x", "type": "Field", "slots": 1 }
  ],
  "events": {
    "discriminator": null,
    "schemas": [
      { "name": "x-updated", "fields": [ { "label": "value", "type": "Field" } ] }
    ]
  },
  "actions": { "discriminator": null, "schemas": [] },
  "manifest": null,
  "verifiedAt": "2026-04-17T12:34:56Z",
  "signature": "..."
}
```

API writes:
- `contract:vkey:1234...` → the JSON above.
- `contract:addr:zeko-m-devnet:B62qHello...` → `"1234..."`.

### 5.3 Second worked example — a multi-state Vault with a Struct

```typescript
// src/Vault.ts
import {
  SmartContract, state, State, method, Reducer,
  Field, UInt64, PublicKey, Bool, Struct,
} from 'o1js';

export class Deposit extends Struct({ user: PublicKey, amount: UInt64 }) {}
// Deposit.sizeInFields() === 3  (PublicKey: 2, UInt64: 1)

export class Vault extends SmartContract {
  @state(Field)     root         = State<Field>();      // slot 0
  @state(UInt64)    totalSupply  = State<UInt64>();     // slot 1
  @state(PublicKey) admin        = State<PublicKey>();  // slots 2, 3
  @state(Bool)      paused       = State<Bool>();       // slot 4

  events = {
    deposit:    Deposit,    // multi-field event
    withdrawal: UInt64,
  };

  reducer = Reducer({ actionType: Deposit });

  // ... methods omitted
}
```

Reflected output:

```json
{
  "stateFields": [
    { "index": 0, "label": "root",        "type": "Field",     "slots": 1 },
    { "index": 1, "label": "totalSupply", "type": "UInt64",    "slots": 1 },
    { "index": 2, "label": "admin",       "type": "PublicKey", "slots": 2 },
    { "index": 4, "label": "paused",      "type": "Bool",      "slots": 1 }
  ],
  "events": {
    "discriminator": { "fieldIndex": 0, "type": "field_hash",
                       "values": { "<h(deposit)>": "deposit",
                                   "<h(withdrawal)>": "withdrawal" } },
    "schemas": {
      "deposit":    [ { "index": 0, "label": "_type",  "type": "Field" },
                      { "index": 1, "label": "user",   "type": "PublicKey", "slots": 2 },
                      { "index": 3, "label": "amount", "type": "UInt64" } ],
      "withdrawal": [ { "index": 0, "label": "_type",  "type": "Field" },
                      { "index": 1, "label": "value",  "type": "UInt64" } ]
    }
  },
  "actions": { "discriminator": null,
               "schemas": [
                 { "index": 0, "label": "user",   "type": "PublicKey", "slots": 2 },
                 { "index": 2, "label": "amount", "type": "UInt64" } ] }
}
```

Every label above is traceable to a line in the source. Nothing is submitter-supplied.

### 5.4 The Zeko bridge contract — needs a manifest

The bridge's `actionType` is `Field` with a convention `action[0] ∈ {"0", "1"}`. Reflection sees only "actions are single-field" and cannot discover the convention. The bridge repo includes `zeko.manifest.json` declaring the discriminator and action schemas (§4.2 example). The verifier accepts because (a) the declared field count matches the reflected single-field action, and (b) the declared discriminator index is within bounds. The output KV entry merges reflected + manifest.

---

## 6. Owner Claims

### 6.1 Who is the owner?

The owner is whoever controls the contract's **account private key** on L2. No separate "deployer" concept: on Mina the account IS the identity, and the account signs proofs. Proving control of the private key is sufficient.

### 6.2 Claim flow

1. Owner visits the contract page in the explorer → clicks "Claim this contract".
2. UI displays a deterministic payload to sign:
   ```
   zeko-explorer:contract-claim:v1
   vkey_hash:   <hash>
   address:     <B62q...>
   network:     <network id>
   issued_at:   <ISO8601 timestamp>
   nonce:       <random 32-byte field>
   ```
3. Owner signs with their wallet (Auro, Pallad, etc.) using the contract account's private key.
4. UI posts `{ payload, signature }` to `submitOwnerClaim`.
5. API:
   - Verifies the signature against the contract account's public key (known from the address).
   - Rejects if `issued_at` is > 10 minutes old or if the same nonce was already used (replay protection).
   - Writes `contract:claim:<vkey_hash>` (the signed payload) + `contract:owner:<vkey_hash>` (owner-supplied display metadata: display name, homepage override, twitter, logo).
6. Owner can subsequently update display metadata without re-signing, provided they hold a short-lived session token issued at claim time. Material changes (transferring ownership, delisting) require a fresh signature.

### 6.3 What the owner can set

Split cleanly from verification data:

| Field | Source | Editable by owner |
|---|---|---|
| `stateFields`, `events`, `actions` (shape + labels) | Reflection / manifest | No (bound to vkey) |
| `name`, `description` | Manifest (default) or owner override | Yes (override) |
| `homepage`, `repository`, `twitter` | Manifest (default) or owner override | Yes |
| `logo` | Manifest default or owner upload | Yes (uploaded to R2, referenced by URL) |
| `verifiedAt`, `o1jsVersion`, `sourceRef` | Reflection | No |

### 6.4 Multiple addresses, one contract

A single verification key can be deployed to many accounts (factory pattern, per-user proxies). The KV schema reflects this:

- `contract:vkey:<hash>` → one metadata blob (shared).
- `contract:addr:<net>:<addr>` → vkey hash (many addresses point at the same vkey).

An owner claim is per-address (because the private key proof is per-account). One address's owner doesn't automatically claim every deployment of the same vkey. The explorer's contract page groups deployments: "This vkey is verified. It is deployed at N addresses. M of those are owner-claimed."

---

## 7. API Surface

```graphql
enum VerificationStatus {
  PENDING  CLONING  INSTALLING  COMPILING  REFLECTING  MATCHING
  VERIFIED FAILED
}

enum NetworkId { ZEKO_M_DEVNET  ZEKO_M_ALPHANET  ZEKO_M_MAINNET }

type Contract {
  vkeyHash:    String!
  o1jsVersion: String!
  sourceRef:   SourceRef!
  stateFields: [StateField!]!
  events:      EventsSchema!
  actions:     ActionsSchema!
  addresses:   [ContractAddress!]!   # all known deployments of this vkey
  owner:       OwnerInfo             # null = unclaimed
  verifiedAt:  DateTime!
}

type ContractAddress {
  address: String!
  network: NetworkId!
  firstSeenAt: DateTime!
  ownerClaim:  OwnerClaim       # null if address-specific claim not made
}

type OwnerInfo {
  displayName: String
  description: String
  homepage:    String
  repository:  String
  twitter:     String
  logoUrl:     String
}

type VerificationJob {
  id:        String!
  status:    VerificationStatus!
  currentStage: String           # human-readable substage
  logs:      [String!]!          # streamed stdout/stderr from the sandbox
  error:     String
  result:    Contract            # populated on VERIFIED
}

type Query {
  contract(vkeyHash: String, address: String, network: NetworkId): Contract
  verifiedContracts(first: Int, after: String, network: NetworkId): ContractConnection!
  verificationJob(id: String!): VerificationJob
}

type Mutation {
  submitContractForVerification(input: ContractSubmissionInput!): VerificationJob!
  submitOwnerClaim(payload: String!, signature: String!): OwnerClaim!
  updateOwnerMetadata(vkeyHash: String!, sessionToken: String!, patch: OwnerMetadataPatch!): OwnerInfo!
}

type Subscription {
  verificationProgress(jobId: String!): VerificationJob!
}
```

Label resolution on `Account.labeledState` / `ZkappEvent.labeledFields` / `ZkappAction.labeledFields` is a single KV read by `vkey_hash` — no DB join, no registry pre-load.

---

## 8. Frontend UX (Milestone 2)

### 8.1 Contract page

**Verified:**
- Header: logo, display name, verified badge (green check), network, one-line description, homepage link, GitHub link, Twitter link.
- "Verified from `github.com/acme/my-zkapp@abc123d` using `o1js@2.4.0`, matched on-chain `vkeyHash:0x...`" (clickable).
- Tabs: **State** (labeled) / **Events** (labeled, grouped by type) / **Actions** (labeled, chain view) / **Deployments** (all addresses sharing this vkey) / **Source** (links back to GitHub at the verified commit).
- On the **State** tab: an 8-row table of slots, labeled with name and type. Unfilled slots shown as `(unused)`. Values: decimal + hex toggle + copy button.
- Unclaimed verified contracts get "This contract is verified but has no owner profile. [Claim it →]".

**Unverified:**
- "This contract is not verified. [Verify this contract →]" banner.
- Tabs: **State** (raw 8-field array), **Events** (raw), **Actions** (raw, with chain). Transaction history unchanged.

### 8.2 Submission wizard

A single page, four steps with a live progress indicator on the right:

1. **Paste an address** (or verification key hash for pre-deployment). Explorer infers network from the URL it's on.
2. **Source info**: repo URL, commit SHA (prefilled with the repo's HEAD commit via GitHub API), entry file (autocompleted from repo tree), class name (autocompleted from file's exports).
3. **Review**: the explorer renders what *would* be displayed if verification succeeds, using a dry-run of static analysis. Submitter can spot-check labels before spending the compile budget.
4. **Submit** → live SSE progress on the right. Typical timings: clone ~2 s, install ~20 s, compile ~30 s–2 min, match ~1 s. Logs stream as they happen. On success, the contract page is revealed with a "claim this contract" CTA.

Explicit non-goals: no paid verification, no priority queue. Rate-limiting is by IP (§10).

### 8.3 Owner dashboard

- After claim, the owner sees a small gear icon on their contract page → opens a modal with display name, description, homepage, repository, twitter, logo upload. "Save" updates `contract:owner:<vkey_hash>` in KV. No re-verification needed.
- Transferring ownership = re-signing the claim payload with a new private key (not common; included for completeness).

---

## 9. Milestone Fit

| Milestone | Contract-verification deliverables |
|---|---|
| **M1** (foundation) | KV namespace + schema. Verification Service (sandbox container + pipeline stages). API: `submitContractForVerification`, `verificationProgress`, `contract(...)`, `verifiedContracts`, `submitOwnerClaim`. Indexer wires `contract:addr:*` reverse lookup at zkApp command ingestion. Label-resolution resolvers on `labeledState` / `labeledFields`. Rate-limiting and abuse protection on submission. |
| **M2** (frontend) | Submission wizard with live SSE progress. Verified contract page (tabs, deployments list, source link). Owner dashboard. Claim flow with wallet signature. Contract-address page upgrades for unverified → verified transitions. |
| **M3** (settlement/finality) | No additional work required — verification is orthogonal to settlement. |
| **M4** (public API, Ethereum) | Verification service extended to Zeko-E when the Ethereum L1 adapter lands (same o1js code path; just more networks for the `MATCHING` stage). |

Nothing in this design is deferred beyond M2. The "future / post-launch" phrasing in the earlier sketch is removed.

---

## 10. Security and Abuse

| Concern | Mitigation |
|---|---|
| **Malicious `npm install`** running arbitrary code in the sandbox | Network allow-list (only `registry.npmjs.org`, `github.com`, Mina GraphQL). Read-only root FS. No mounted secrets. Container destroyed after each job. |
| **Supply-chain attack via a malicious o1js dependency** | Lockfile frozen (`--frozen-lockfile`). The installed o1js version is recorded in the KV entry and displayed prominently. Operator can invalidate KV entries for a specific o1js version if a CVE lands. |
| **DoS by submitting many bad contracts** | Rate limit: 10 submissions per IP per hour, 3 concurrent jobs globally. Submissions with bad shape (unreachable repo, unknown SHA) fail before entering the sandbox — cheap to reject. |
| **Griefing by claiming someone else's contract** | Labels come from reflection, not the submitter. Ownership requires a signature from the contract's private key; no other path exists to `contract:owner:*`. |
| **Replay of owner claims** | Nonce + 10-minute validity on the signed payload. Nonces are recorded in a KV set with a 30-minute TTL. |
| **Compromised verification worker forging results** | Results are Ed25519-signed with a key the worker process holds in memory only (mounted at container start, wiped on exit). The API rejects un-signed or badly-signed results. Worker compromise is contained to the job it's running; it cannot retroactively forge prior verifications. |
| **KV key collisions on submitter-controlled input** | Keys are derived from cryptographic hashes and network-prefixed. Submitter cannot forge a `vkey_hash` without producing matching bytecode (trivially infeasible). |

---

## 11. Alternatives Considered

| Option | Why rejected |
|---|---|
| **`known-contracts.json` in this repo** | Doesn't scale to user submissions. Requires PR review per contract. No cryptographic binding to on-chain state. Pushes user-facing flows to "future." |
| **SurrealDB table for the registry** | SurrealDB is the read model (PRD §5.2.6, rebuildable from NATS). The registry is not derived from NATS; putting it in SurrealDB couples two lifecycles that should be independent. KV is the right tool — globally cached, independent of the read model. |
| **On-chain contract registry** | Gas/fee cost for submitters. Requires a smart contract and a separate governance story. Ordering and rollbacks complicate lookup. Off-chain KV is strictly simpler and the cryptographic guarantee (vkey match) is what matters, not where the registry lives. |
| **Static analysis only (parse TypeScript AST)** | Can miss details that the o1js runtime resolves (Struct composition, generics). Not reproducible: AST lies if a type alias is renamed. Runtime reflection after `compile()` is the only source that ties directly to the vkey. |
| **Submitter provides all labels; no reflection** | No correctness enforcement. Identical to today's `known-contracts.json` with the compile step removed. |
| **Pre-build binary artifact upload** | Harder to audit. Repro from source + commit SHA is the clearest trust model and is familiar to developers (mirrors Etherscan and sourcify patterns from Ethereum). |
