# Spike 003: zkApp State, Events, and Actions Display — Results

**Status:** Complete
**Date:** 2026-04-07

---

## 1. Explorer Survey

### Minascan (Mina L1 Explorer)

- **Contract verification** supported — developers submit metadata alongside verified contracts for human-readable display of events/actions.
- **Without verification**, state fields are raw field elements with no labels.
- **zkApp state** available via GraphQL (`zkappState`, `leafHash`, merkle path).

**Key takeaway:** Developer-opt-in. No automatic decoding.

### Zekoscan (Zeko L2 Explorer)

- Shows zkApp transactions on address pages, but **no decoded state/events/actions display**.
- No contract verification flow.

**Key takeaway:** Low bar. Room to differentiate.

| Feature | Minascan | Zekoscan |
|---|---|---|
| Raw state fields | Yes (via GraphQL) | Limited |
| Labeled state fields | Yes (verified contracts only) | No |
| Event display | Yes (human-readable with metadata) | No |
| Action display | Yes (human-readable with metadata) | No |
| Contract verification | Yes | No |

---

## 2. o1js Data Model

### zkApp State (8 Fields)

Each zkApp account stores exactly **8 Field elements** (each ~32 bytes / 256 bits) as on-chain state. Declared in o1js:

```typescript
class MyContract extends SmartContract {
  @state(Field) num = State<Field>();
  @state(UInt64) balance = State<UInt64>();
  @state(PublicKey) owner = State<PublicKey>();  // consumes 2 Fields (x, isOdd)
  // ...up to 8 Fields total
}
```

**Display implications:**
- A single `@state` may consume 1 or 2 Fields depending on the type (`PublicKey` uses 2, `Field`/`UInt64`/`Bool` use 1).
- Without metadata, there is no way to know which fields belong to which `@state` variable or what type they represent.
- The raw representation is always an array of 8 field element strings.

### Events

Events are public arbitrary data emitted with transactions:

```typescript
events = {
  'add-merkle-leaf': Field,
  'update': MyCustomStruct,
};
this.emitEvent('add-merkle-leaf', newLeaf);
```

- Each event has a **name** (string) and **data** (array of Field elements).
- Event types are defined in the contract source but **not stored on-chain** — only the raw field arrays are persisted.
- Events cannot be accessed provably inside smart contracts (read-only from outside via `fetchEvents()`).

### Actions

Actions are structurally similar to events but have additional power:

```typescript
this.reducer.dispatch(action);
this.reducer.reduce(actions, State, callback);
```

- Actions maintain an **action state** — a rolling hash commitment (`actionState`) that proves which actions were dispatched.
- Actions can be **processed inside smart contracts** via the reducer pattern, enabling concurrent state updates.
- Actions have a **sequence number** and **state hash** that tracks the action accumulator progression.

---

## 3. Display Strategy — Specification

The explorer renders raw fields by default and overlays labels when a contract has a registered schema. The system has four cooperating pieces and the boundary between them is fixed:

| Piece | Responsibility | Stores |
| --- | --- | --- |
| **Indexer** | Persist the raw 8-field state, raw event field arrays, and raw action field arrays exactly as the sequencer publishes them. Never reads schemas. | SurrealDB |
| **Registry repo** (`zeko-contract-registry`, separate public repo) | Hold one versioned submission per contract — `contracts/<name>/contract.json` + `contracts/<name>/fixtures.json`. PR + CI is the only write path. | Git |
| **Cloudflare KV** | Runtime schema store. One entry per `(network, address)` pair — a single submission with `meta.networks: ["zeko-m-devnet", ...]` produces one KV entry per listed network. Written by a maintainer-triggered `workflow_dispatch` publish job, read by the Contract Registry API. | Cloudflare KV |
| **Contract Registry API** | Standalone GraphQL service in this monorepo (sibling of the Explorer and Bridge APIs). Exposes `contractSchema(network, address)` as an edge-cached pass-through over Cloudflare KV. Composed through the unified Hive gateway (spike 4) so the UI fetches raw fields and labels in one round trip. | — (KV is the store) |
| **UI** | Calls the unified gateway, runs `@zeko/contract-schema` in the browser to label raw fields against the schema, and renders both side by side. | — |

### Data flow

```
Author opens PR → CI runs `bun run verify <dir>` → maintainer merges to main
                                                               │
                                                      maintainer triggers
                                                     `workflow_dispatch`
                                                               │
                                      `bun run upload put <dir>` (one PUT per network)
                                                               │
                                                       Cloudflare KV
                                                               │
                                            contract-registry-api: contractSchema(net, addr)
                                                               │
                                            unified Hive gateway (spike 4)
                                                               │
                             raw fields (Explorer API) + labels (UI runs interpreter)
```

Publish is never automatic. The merge is the review signal; `workflow_dispatch` is the deploy signal. Decoding is a pure function of `(raw_fields, schema)` and runs in the UI — the unified gateway gives the UI both inputs in a single round trip.

### Milestone scope

| Milestone | Scope |
| --- | --- |
| **M1 (backend)** | Stand up `zeko-contract-registry` with the Bun verify CLI, the `verify` GitHub Actions job (runs on PRs), and the `publish` job (runs on `workflow_dispatch` only). Publish `@zeko/contract-schema` (JSON Schema v1 + TS types + interpreter + signature helper + TypeScript upload script). Stand up a standalone **Contract Registry API** in this monorepo (sibling of `explorer-api` and `bridge-api`) exposing the `ContractSchema` type and `contractSchema(network, address)` query as an edge-cached KV pass-through; the unified Hive gateway (spike 4) composes it with the Explorer and Bridge APIs. Seed PRs for Zeko bridge outer + inner. |
| **M2 (frontend)** | Contract page with State / Events / Actions / Deployments tabs. UI queries `contractSchema`, calls the interpreter, renders labeled values next to raw fields. Grade badge per contract. Raw-only fallback for unknown contracts with a "Submit this contract" CTA pointing at the registry's PR template. |

The full pipeline specification — versioned JSON Schema, DSL, verify stages, signature scheme, CI workflow, TypeScript upload script, and KV layout — is in [`addendums/addendum-contract-verification.md`](addendums/addendum-contract-verification.md). A runnable example with verbatim CI output for every flow is in [`addendums/examples/`](addendums/examples/).

---

## 4. Contract Registry — Specification

The registry is a separate public repository (`zeko-contract-registry`). Each submission is a directory with two files: `contracts/<name>/contract.json` (the schema-validated payload that lands in KV) and `contracts/<name>/fixtures.json` (golden tests, verified in CI, never uploaded). Submissions conform to [`addendums/examples/contract.v1.schema.json`](addendums/examples/contract.v1.schema.json). The full DSL, verify pipeline, signature scheme, CI workflow, and TypeScript upload script are documented in [`addendums/addendum-contract-verification.md`](addendums/addendum-contract-verification.md).

### 4.1 Schema versioning

Every `contract.json` declares `"version": 1`. The schema file is named `contract.v1.schema.json` and its JSON Schema `$id` is `https://zeko.io/schema/v1/contract.json`. Future breaking shape changes ship as `contract.v2.schema.json` with `"version": 2`; old entries continue to validate against v1 until migrated. The explorer dispatches to the matching interpreter by reading `version` at decode time. Not versioning the payload would bake an implicit "always v1" assumption into every reader.

### 4.2 KV layout

One KV entry per `(network, address)` pair. A single submission with `meta.networks: ["zeko-m-devnet", "zeko-m-mainnet"]` produces two entries with the same value.

| Key | Value | Writer | Reader |
| --- | --- | --- | --- |
| `${network}:${address}` (e.g. `zeko-m-devnet:B62qrSyBR…`) | The `contract.json` bytes, exactly as merged | `bun run upload put <dir>` (TypeScript script calling the Cloudflare KV REST API), invoked by the registry's `publish` job on maintainer-triggered `workflow_dispatch` | `contractSchema(network, address)` resolver in the standalone Contract Registry API |

Flat layout. Multi-network deployments are a property of the submission, not of the file path — there is no `contracts/<network>/` subtree to keep in sync. There is no compaction, no indexing layer, no derived values.

### 4.3 Submission shape

The canonical example is the LuminaPool contract — see §2 of the addendum for the full `contract.json` with three event variants (AddLiquidity, ReceiveMina, Swap) plus `fixtures.json` with four golden fixtures, all matching real on-chain values from `B62qrSyBR5jLgekkwjDdpt6UX8FfYntYB1uXydFyViWMFLkrGSceFEV` on `zeko-m-devnet`.

Every `contract.json` has at minimum: `version: 1`, `meta` (`address`, `networks: [...]`, `name`), `state` (`{ slots }`), and optionally `events`, `actions`, `types`, `owner`. Events and actions take exactly one of three shapes: `null`, `{ fields }` (single shape), or `{ discriminator: { at }, variants }` (multi-shape, tag at slot `at` selects the variant).

`fixtures.json` is a test artefact validated by the `FixtureFile` TypeScript type; it is never uploaded to KV and not part of the JSON Schema. Authors submit it alongside `contract.json` so CI has deterministic inputs to exercise the interpreter against.

### 4.4 Decoder runtime

The decoder is a pure TypeScript module exported from `@zeko/contract-schema`:

```ts
decodeState(submission, raw: readonly string[]) → Record<string, unknown>
decodeEventOrAction(variants, raw: readonly string[], types) → Record<string, unknown> | null
```

Both functions run in the UI. An unknown discriminator value, a slot that reads past the raw array, or any other decoder error returns `null` so the caller can fall back to raw fields without a hard failure.

### 4.5 Verification grade

The verify CLI assigns one of three grades, surfaced in the response the UI receives:

| Grade | Earned when | UI badge |
| --- | --- | --- |
| `owner-signed` | The submission's `owner.signature` verifies against `meta.address` | "Owner-signed by `B62q…`" |
| `source-linked` | `meta.source` + `meta.vkeyHash` are present and the build matches | "Source-linked to `<repo>@<commit>`" |
| `community-submitted` | Schema, semantic checks, and fixtures pass without owner or source | "Community-submitted, fixtures verified" |

---

## 5. SurrealDB Schema Impact

### Key Design Decision

**Raw fields stored, labels applied at query time.** The database stores raw field element strings. The API layer applies labels from the registry at resolution time. This avoids re-indexing when registry entries change, and preserves the raw source of truth.

**No `decoded_fields` column.** The PRD mentions "decoded fields" — after investigation, decoding is a view concern (API layer), not a storage concern, because:
1. Registry can change without re-indexing.
2. Different consumers want different representations (hex, decimal, labeled).
3. Raw data is the source of truth.

### `account` Table Additions

```surql
DEFINE FIELD zkapp_state ON account TYPE option<array<string, 8>>;
DEFINE FIELD verification_key_hash ON account TYPE option<string>;
DEFINE FIELD zkapp_uri ON account TYPE option<string>;

DEFINE INDEX idx_account_vkey ON account FIELDS verification_key_hash;
```

### `account` Table — action_state vector

The account record also stores the current 5-element action_state vector:

```surql
DEFINE FIELD action_state ON account TYPE option<array<string, 5>>;
```

This is the post-state from `changed_accounts[].account.zkapp.action_state` — the head (`[0]`) is the most recent rolling hash, used as the prior state when the next action arrives.

### `zkapp_event` Table

```surql
DEFINE TABLE zkapp_event SCHEMAFULL;
DEFINE FIELD id ON zkapp_event TYPE string;  -- deterministic: {tx_hash}:{account}:{event_index}
DEFINE FIELD transaction ON zkapp_event TYPE record<transaction>;
DEFINE FIELD emitting_account ON zkapp_event TYPE record<account>;
DEFINE FIELD event_index ON zkapp_event TYPE int;
DEFINE FIELD fields ON zkapp_event TYPE array<string>;  -- raw field elements
DEFINE FIELD timestamp ON zkapp_event TYPE datetime;
DEFINE FIELD sequence_number ON zkapp_event TYPE int;
DEFINE FIELD target_ledger_hash ON zkapp_event TYPE string;  -- for consumer-side rollback revert

DEFINE INDEX idx_event_account ON zkapp_event FIELDS emitting_account;
DEFINE INDEX idx_event_tx ON zkapp_event FIELDS transaction;
DEFINE INDEX idx_event_seq ON zkapp_event FIELDS sequence_number;
DEFINE INDEX idx_event_ledger ON zkapp_event FIELDS target_ledger_hash;
```

### `zkapp_action` Table

```surql
DEFINE TABLE zkapp_action SCHEMAFULL;
DEFINE FIELD id ON zkapp_action TYPE string;  -- deterministic: {tx_hash}:{account}:{action_index}
DEFINE FIELD transaction ON zkapp_action TYPE record<transaction>;
DEFINE FIELD emitting_account ON zkapp_action TYPE record<account>;
DEFINE FIELD action_index ON zkapp_action TYPE int;
DEFINE FIELD fields ON zkapp_action TYPE array<string>;  -- raw field elements
DEFINE FIELD before_action_state ON zkapp_action TYPE string;  -- rolling hash before this action
DEFINE FIELD action_state ON zkapp_action TYPE string;         -- rolling hash after this action (chain key)
DEFINE FIELD timestamp ON zkapp_action TYPE datetime;
DEFINE FIELD sequence_number ON zkapp_action TYPE int;
DEFINE FIELD target_ledger_hash ON zkapp_action TYPE string;  -- for consumer-side rollback revert

DEFINE INDEX idx_action_account ON zkapp_action FIELDS emitting_account;
DEFINE INDEX idx_action_tx ON zkapp_action FIELDS transaction;
DEFINE INDEX idx_action_state ON zkapp_action FIELDS action_state UNIQUE;
DEFINE INDEX idx_action_before ON zkapp_action FIELDS before_action_state;
DEFINE INDEX idx_action_seq ON zkapp_action FIELDS sequence_number;
DEFINE INDEX idx_action_ledger ON zkapp_action FIELDS target_ledger_hash;
```

The `before_action_state` / `action_state` pair gives the actions a chain structure matching the bridge `outer_action.before_state` / `after_state` convention from spike 002. This enables "list actions after action_state X" queries (common for reducer consumers).

---

## 6. Indexer Processing

When the indexer receives a `zeko.l2.transactions` message with `command.type === "zkapp_command"`:

```
NATS message received
    │
    ├─► Extract changed_accounts[].account.zkapp.{app_state, action_state, ...}
    │   → Upsert account records with zkapp_state array + verification_key_hash + action_state vector
    │
    ├─► Extract command.account_updates[]
    │   → For each account_update:
    │       ├─► If update has events → create zkapp_event records
    │       └─► If update has actions → create zkapp_action records (with before/after action state)
    │
    └─► Link events/actions to transaction and emitting account, tag with target_ledger_hash
```

Each `account_update` contains:

```json
{
  "body": {
    "public_key": "<emitting account>",
    "update": {
      "app_state": ["Set <field>" | "Keep", ...8 entries],
      "verification_key": { "data": "...", "hash": "..." } | null
    },
    "actions": [["<field>", "<field>", ...], ...],
    "events": [["<field>", "<field>", ...], ...],
    "preconditions": { ... }
  }
}
```

The indexer should:
1. **Events**: For each field array in `account_update.body.events` → create a `zkapp_event` record linked to the transaction and emitting account.
2. **Actions**: For each field array in `account_update.body.actions` → create a `zkapp_action` record with `before_action_state` and `after_action_state`, linked to the transaction and emitting account.
3. **State**: Use the post-state from `changed_accounts[].account.zkapp`. The indexer does **not** interpret `account_update.body.update.app_state` `Set`/`Keep` operations itself — see §6.1.
4. **Verification key**: Extract `.hash` from `account_update.body.update.verification_key` when present, store on account.
5. **Tag with target_ledger_hash**: Every zkApp record (state row, event, action) is tagged with `target_ledger_hash` so the consumer-side rollback revert (§10) can drop records by hash.

### 6.1 `Set` / `Keep` Semantics — Why the Indexer Ignores Them

In Mina, each zkApp state slot in an `account_update` is one of two markers:

- `Set <field>` — replace the stored slot with the given field element
- `Keep` — leave the stored slot unchanged

**The sequencer has already applied these operations before publishing** to NATS. The `changed_accounts[].account.zkapp.app_state` array in the NATS payload is the fully-resolved **post-state** of the account — an 8-element field array with all `Set`/`Keep` operations from every account_update in the transaction collapsed into concrete values. The indexer persists this array verbatim.

**Consequence:** The indexer never needs to read `account_update.body.update.app_state`. That field is useful only to consumers that want to display "this transaction changed slot 3 from A to B" (a transaction-level diff view). For state storage, the post-state in `changed_accounts` is authoritative and already correct.

This is also why `Keep` does not appear in the stored schema — by the time data reaches SurrealDB it is always a concrete field element.

### 6.2 Action State Computation

Each account has an on-chain `action_state`: a 5-element field vector that commits to the history of dispatched actions (Mina `Zkapp_account.action_state`). The head (`action_state[0]`) is the most recent rolling hash; elements `[1..4]` are previous hashes retained for reducer processing.

The per-action `action_state` stored in the `zkapp_action` table is the **rolling hash after that action was applied**. It is derived deterministically using the Mina formula:

```
after_action_state = Poseidon.hash([before_action_state, actions_commitment])
actions_commitment = Poseidon.hash_with_prefix("MinaZkappActions*******",
                       [field_1, field_2, ..., field_k])
```

where `field_1..field_k` are the raw fields of the action as emitted in `account_update.body.actions[i]`.

**Data sources available to the indexer:**

| Source | What it gives |
|---|---|
| `changed_accounts[].account.zkapp.action_state` (post-state) | The 5-element action state vector after the whole transaction. `[0]` is the post-state head. |
| Previous account record in SurrealDB | The prior `[0]` (i.e., the `before_action_state` of the first action in the current transaction for this account) |
| `account_update.body.actions[i]` | Raw field arrays for actions emitted in this update |

**Indexer algorithm (per emitting account, per transaction):**

1. Load prior `action_state[0]` from the account record → `s_0` (or genesis empty hash if first action).
2. For each action `A_i` (in declaration order across this transaction's account_updates for this account):
   - `actions_commitment = Poseidon.hash_with_prefix("MinaZkappActions*******", A_i.fields)`
   - `s_i = Poseidon.hash([s_{i-1}, actions_commitment])`
   - Store `zkapp_action{ before_action_state = s_{i-1}, action_state = s_i, fields = A_i.fields, ... }`
3. Verify `s_N` matches `changed_accounts[account].zkapp.action_state[0]`. If not → log a consistency error and halt (protects against computation drift from protocol updates).

The Mina prefix string and algorithm are documented in `mina/src/lib/mina_base/zkapp_account.ml` and `o1js/src/lib/mina/actions.ts`. An OCaml/TypeScript port is implementation work for Milestone 1, not spike work; the spike's responsibility is confirming the data is derivable from the NATS payload, which it is.

---

## 7. API Shape — Specification

The explorer reads zkApp display data through the unified Hive gateway (designed in spike 4):

- **Explorer API** — indexed on-chain data (accounts, events, actions) returned as raw fields only.
- **Contract Registry API** — a single `contractSchema(network, address)` query reading from Cloudflare KV.

The gateway joins them so a UI page can fetch raw fields and labels in one round trip. Decoding — running `@zeko/contract-schema`'s interpreter against `(raw_fields, schema)` — runs in the UI.

### 7.1 GraphQL types and queries

```graphql
scalar JSON

type Account {
  # ...existing fields...
  zkappState: [String!]            # 8 raw field elements, null for non-zkApp
  verificationKeyHash: String
  zkappUri: String
  events(first: Int, after: String): ZkappEventConnection!
  actions(first: Int, after: String): ZkappActionConnection!
}

type ZkappEvent {
  id: String!
  transaction: Transaction!
  emittingAccount: Account!
  eventIndex: Int!
  fields: [String!]!               # raw field elements
  timestamp: DateTime!
  sequenceNumber: Int!
}

type ZkappAction {
  id: String!
  transaction: Transaction!
  emittingAccount: Account!
  actionIndex: Int!
  fields: [String!]!               # raw field elements
  actionState: String!
  timestamp: DateTime!
  sequenceNumber: Int!
}

type ContractSchema {
  network: String!                 # "zeko-m-devnet" | "zeko-m-mainnet"
  address: String!
  version: Int!                    # currently always 1
  grade: String!                   # "owner-signed" | "source-linked" | "community-submitted"
  submission: JSON!                # the contract.json bytes as merged in the registry
}

type Query {
  # ...existing queries...
  contractSchema(network: String!, address: String!): ContractSchema
}
```

The Explorer API's `Account`/`ZkappEvent`/`ZkappAction` types return raw fields only — no `labeledState`, no `labeledFields`, no `decoded` on those types. Decoding belongs on a separate axis from indexed data: the indexer is unaware of contract schemas, and mixing them in would force reindexing whenever a registry entry changes.

The Contract Registry API's `contractSchema(network, address)` resolver is a thin reader over KV: one `GET` on key `${network}:${address}`, return `null` on miss, 5-minute edge cache on hit.

### 7.2 UI join (default contract page)

```ts
// One round trip to the Hive gateway — Explorer API + Contract Registry API
// are joined server-side.
const { account, contractSchema: schema } = await graphql.query(CONTRACT_PAGE_QUERY, {
  address,
  network,
});

const submission = schema?.submission ?? null;

const labeledState = submission
  ? decodeState(submission, account.zkappState)
  : null;

const labeledEvents = account.events.nodes.map(e => ({
  ...e,
  labeled: submission ? decodeEventOrAction(submission.events, e.fields, submission.types) : null,
}));
```

Both views (raw + labeled) are rendered side-by-side. When `schema` is null the page shows raw fields only and a "Submit this contract" CTA pointing at the registry's PR template.

---

## 8. Rollback Handling — Consumer-Side Revert by `target_ledger_hash`

zkApp state, events, and actions live entirely inside L2 transactions, so they are subject to the same L2 rollback mechanism as other transaction data (spike 001 §5, PRD §7.5). There is no `zeko.l2.rollbacks` subject — the indexer detects rollbacks itself from hash chain breaks on `zeko.l2.transactions`.

**Detection (delegated to the generic transaction consumer):**
- `M[n].source_ledger_hash != M[n-1].target_ledger_hash`
- If `M[n].source_ledger_hash` matches an earlier `M[k].target_ledger_hash` → rollback of `M[k+1]..M[n-1]`
- Otherwise → gap, triggers backfill

**zkApp-specific revert actions when the transaction consumer identifies rolled-back transactions:**

1. **Events**: `DELETE zkapp_event WHERE target_ledger_hash IN <rolled-back hashes>`. These are purely derived records — no cascading state.
2. **Actions**: `DELETE zkapp_action WHERE target_ledger_hash IN <rolled-back hashes>`. Because `action_state` is a uniqueness constraint and actions form a chain, the next action after the rollback will have its `before_action_state` matching the last surviving `action_state` for that account — no recomputation needed.
3. **zkApp state**: The account's `zkapp_state` and `action_state` must be rolled back to the values from the last surviving transaction that changed this account. Two implementation options:
   - **A. Snapshot per change (chosen)**: Write an `account_activity` row (already proposed in PRD §5.2.6) for every zkApp state change. The revert walks `account_activity` for the account back to the last row where `target_ledger_hash` is not in the rollback set, and restores `zkapp_state` / `action_state` from that snapshot.
   - **B. Recompute from NATS**: Rebuild the account from the genesis point by replaying `zeko.l2.transactions`. Correct but expensive; only used as a last-resort repair.

Option A is the normal path. Option B is the fallback if `account_activity` is missing or inconsistent (e.g., after a manual DB edit).

4. **Verification key / zkApp URI**: Treated as account fields, reverted the same way (from `account_activity`).

**No special "rolled_back" state for events/actions.** Unlike `bridge_operation` (spike 002 §5), which retains `ROLLED_BACK` as an observable status, events and actions are pure derivations of on-chain transactions — if the transaction is reverted, the records are deleted outright. The audit trail lives on `account_activity`.

This approach piggybacks on the transaction-level rollback machinery — no zkApp-specific rollback stream is introduced, and the `target_ledger_hash` tag on every record is the only addition needed.

---

## 9. Open Questions — Resolved

| Original Question | Resolution |
|---|---|
| How does Zekoscan display zkApp state? | Minimal — shows zkApp transactions but no decoded state/events/actions. |
| How does Minascan display zkApp state? | Developer-opt-in via contract verification + custom metadata. Raw fields without verification. |
| Community conventions for annotating state fields? | None standardized. No ABI equivalent in the Mina ecosystem. |
| How are events and actions structured? | Events: named, typed field arrays via `emitEvent()`. Actions: similar but with `actionState` rolling hash and reducer processing. Both stored as raw field arrays. Event/action names are **not** persisted on-chain — multi-type contracts need a discriminator field (§4.1). |
| Can field labels be associated with a deployed contract? | Yes — by PR into `zeko-contract-registry` (separate repo). Each contract is a directory with `contract.json` (versioned: `version: 1`) describing state/events/actions via a small declarative DSL, plus `fixtures.json` with golden test cases. CI runs the Bun verify CLI against the fixtures (deep-equal; mismatch exits 1), optionally verifies an o1js owner signature, and optionally builds the source repo for a vkey hash compare. Publish is gated behind a maintainer-triggered `workflow_dispatch` that calls a TypeScript upload script — one Cloudflare KV `PUT` per network listed in `meta.networks`. A standalone Contract Registry API (sibling of the Explorer and Bridge APIs in this monorepo) serves the schema via a `contractSchema(network, address)` query, edge-cached. The unified Hive gateway (spike 4) composes it with the Explorer API so the UI fetches raw fields and labels in one round trip; decoding runs in the UI. Full design in `addendums/addendum-contract-verification.md`; runnable end-to-end proof at `addendums/examples/`. |
| For Zeko's own contracts, can we hardcode labels? | No — they submit through the same PR flow. Seed PRs add the bridge outer / inner on M1 launch. The bridge's `action[0] ∈ {"0","1"}` convention (spike 002 §1) is expressed as `discriminator: { at: 0 }` with two variants; the interpreter dispatches each action record to the matching variant at decode time. |
| Why a static DSL instead of per-contract code? | A static schema is reviewable by diff, runnable through the same interpreter in CI and the UI, and never executes user-supplied JavaScript. Golden fixtures prove the author's mental model matches the interpreter's output. |
| How do we verify that a submitter owns the contract? | Three acceptance grades. (a) **Owner-signed:** optional `owner` block carrying an o1js signature over the canonical payload; verified by `Signature.verify` against `meta.address` — only the deploying key can forge this. (b) **Source-linked:** optional `meta.source` points at a public repo and commit; CI builds it and compares the resulting vkey hash to `meta.vkeyHash`. (c) **Community-submitted:** neither present; accepted on PR reviewer judgment, UI displays a "Community-submitted" badge. Grade is surfaced in the API so the frontend can render appropriately. |
| What queries do developers run against events/actions? | By emitting account, by sequence number, by `action_state` / `before_action_state` chain walks. Reflected in SurrealDB indexes. |
| How is `action_state` computed? | Poseidon hash of (`before_action_state`, `actions_commitment`). Derivable from NATS payload — see §6.2. Post-state is cross-checked against `changed_accounts[].account.zkapp.action_state[0]`. |
| How are `Set` / `Keep` app_state markers handled? | Indexer ignores them — the sequencer has already applied them. The indexer persists the post-state array from `changed_accounts[].account.zkapp.app_state` verbatim (§6.1). |
| How is L2 rollback handled for zkApp records? | Delegated to the generic transaction-consumer rollback machinery. Every zkApp record is tagged with `target_ledger_hash`; on rollback, matching events/actions are deleted and account state is restored from `account_activity` snapshots (§8). |
