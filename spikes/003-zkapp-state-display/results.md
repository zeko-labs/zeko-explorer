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

## 3. Display Strategy

### Decision: Verification-Key-Grounded Registry + Raw Fields

Labels for state, events, and actions come from a **contract verification registry** keyed by verification-key hash. Submissions are reproduced in a sandbox from a public git commit; labels are extracted by runtime reflection from the exact class that produced the on-chain verification key. The registry lives in Cloudflare KV — O(1) edge lookups, open submission, no in-memory load by the indexer. Full design in [`addendums/addendum-contract-verification.md`](addendums/addendum-contract-verification.md).

| Milestone | Scope | Effort |
|---|---|---|
| **M1 (backend)** | KV namespace + verification service (sandbox container + pipeline). API: `submitContractForVerification`, `verificationProgress`, `contract(...)`, `submitOwnerClaim`. Indexer writes `contract:addr:*` reverse-lookup entries. Label-resolution resolvers on `labeledState` / `labeledFields`. | Medium |
| **M2 (frontend)** | Submission wizard with live SSE progress. Verified contract page (state / events / actions / deployments tabs). Owner claim flow via wallet signature. Owner dashboard for display metadata. Raw fallback page for unverified contracts. | Medium |

### Why This Option

| Option | Verdict | Reason |
|---|---|---|
| 1. Raw fields only | Too minimal | No differentiation over Zekoscan. Developers want labels for bridge/rollup contracts. |
| 2. `known-contracts.json` in repo | Rejected | Doesn't scale to user submissions. Requires a PR per contract. No cryptographic binding — submitter-supplied labels could drift from the on-chain code. |
| 3. **Verification-key-grounded KV registry** | **Selected** | Cryptographically bound (labels are reflected from the class that produced the verification key). Open submission without PR review. O(1) edge lookup. Fits in M1/M2 — nothing deferred. See addendum. |
| 4. On-chain registry contract | Rejected | Adds gas/fee cost, governance complexity, and rollback concerns for no improvement over the off-chain cryptographic guarantee. |

### Registry Lookup Flow

```
Account loaded → extract verification_key_hash
                       │
                 KV.get("contract:vkey:<hash>")
                       │
              ┌────────┴────────┐
          Found?              Not found
              │                   │
     Apply labels to          Display raw
     state/events/actions     field arrays
                              + "Verify this contract" CTA
```

---

## 4. Contract Registry

The registry is a **Cloudflare KV** store populated by a sandboxed **verification service**. Submitters supply a public git commit; the service reproduces the compile, extracts labels by runtime reflection, and writes the entry only if the computed verification key matches the one on-chain. The labels that end up in KV are therefore cryptographically bound to the code the protocol executes.

See [`addendums/addendum-contract-verification.md`](addendums/addendum-contract-verification.md) for the full design: verification pipeline, sandbox constraints, signed-result protocol, owner-claim flow (wallet signature over a nonce'd payload), full GraphQL schema, and security model.

**Summary of what lives where:**

| Keyspace | Value | Written by |
|---|---|---|
| `contract:vkey:<hash>` | Metadata blob: `stateFields`, `events`, `actions`, `o1jsVersion`, `sourceRef`, `verifiedAt` | Verification service (on `VERIFIED`) |
| `contract:addr:<network>:<address>` | `vkey_hash` string | Indexer (on each zkApp command for an account it hasn't seen before) |
| `contract:claim:<vkey_hash>:<address>` | Signed owner claim payload | API (on `submitOwnerClaim`) |
| `contract:owner:<vkey_hash>` | Owner-editable display metadata (display name, homepage, logo URL, etc.) | API (on `updateOwnerMetadata`) |

**Zeko's own contracts** (bridge outer/inner, etc.) are submitted through the same flow against the `zeko-labs/zeko` repository. No hard-coded entries. The manifest (`zeko.manifest.json`) declares the bridge's action discriminator convention (`action[0] ∈ {"0", "1"}` for `commit` / `witness`), which the verifier checks against the reflected single-field action layout (spike 002 §1). Field labels for `Outer_state` / `Inner_state` come from manifest entries validated against the reflected `@state` layout.

### 4.1 Event/Action Type Discrimination

Mina does not persist event or action **names** on-chain. An o1js declaration like `events = { 'add-merkle-leaf': Field, 'update': MyStruct }` defines compile-time labels, but the on-chain representation is raw `field[]`. The explorer therefore cannot recover the type name from chain data alone.

Three discriminator modes are recorded in the KV metadata:

| `discriminator` value | Meaning | Source |
|---|---|---|
| `null` | Contract emits a single event/action type. `schemas` is one field list, applied to every record. | Reflection (when the contract declares one type) |
| `{ fieldIndex: N, type: "field_hash", values: { ... } }` | o1js multi-type events — o1js prepends a Poseidon hash of the event name as field 0. | Reflection (when the `events = {...}` has multiple keys) |
| `{ fieldIndex: N, type: "string_tag", values: { ... } }` | User-chosen tag (like the Zeko bridge's `"0"`/`"1"`) carried inside the action fields. | Manifest (the verifier checks `fieldIndex` is within the reflected field count) |

**At query time**, the API resolver:
1. Reads `contract:addr:<network>:<account>` → `vkey_hash`. Cache miss → account is unverified, return raw fields.
2. Reads `contract:vkey:<vkey_hash>` → metadata.
3. If `discriminator` is `null` → apply the single schema.
4. Otherwise → read `fields[discriminator.fieldIndex]`, look up the matching schema key, apply that schema.
5. If no matching key → return raw fields (as for unknown contracts).

This preserves raw-first semantics: even when a contract is known, unexpected records still render as field arrays rather than crashing or showing misleading labels.

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

## 7. GraphQL API Shape

```graphql
type Account {
  # ...existing fields...
  zkappState: [String!]           # 8 field elements, null for non-zkApp
  verificationKeyHash: String
  zkappUri: String
  labeledState: [LabeledField!]   # from registry, null if not in registry
  events(first: Int, after: String): ZkappEventConnection!
  actions(first: Int, after: String): ZkappActionConnection!
}

type LabeledField {
  index: Int!
  label: String!
  type: String!                   # "field", "uint64", "uint32", "bool", "public_key"
  description: String
  rawValue: String!
}

type ZkappEvent {
  id: String!
  transaction: Transaction!
  emittingAccount: Account!
  eventIndex: Int!
  fields: [String!]!
  labeledFields: [LabeledField!]  # from registry, null if unknown
  timestamp: DateTime!
  sequenceNumber: Int!
}

type ZkappAction {
  id: String!
  transaction: Transaction!
  emittingAccount: Account!
  actionIndex: Int!
  fields: [String!]!
  labeledFields: [LabeledField!]  # from registry, null if unknown
  actionState: String!
  timestamp: DateTime!
  sequenceNumber: Int!
}
```

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
| Can field labels be associated with a deployed contract? | Yes — a sandboxed verification service reproduces the compile from a public git commit and extracts labels by runtime reflection from the class that produced the on-chain verification key. Entries live in Cloudflare KV keyed by vkey hash. Fully specified in `addendums/addendum-contract-verification.md`. |
| For Zeko's own contracts, can we hardcode labels? | No — they go through the same verification flow as any other contract, submitted against the `zeko-labs/zeko` repository, so the labels are cryptographically bound to the code. A `zeko.manifest.json` in that repo declares the bridge's action discriminator (validated against reflected field count). |
| What queries do developers run against events/actions? | By emitting account, by sequence number, by `action_state` / `before_action_state` chain walks. Reflected in SurrealDB indexes. |
| How is `action_state` computed? | Poseidon hash of (`before_action_state`, `actions_commitment`). Derivable from NATS payload — see §6.2. Post-state is cross-checked against `changed_accounts[].account.zkapp.action_state[0]`. |
| How are `Set` / `Keep` app_state markers handled? | Indexer ignores them — the sequencer has already applied them. The indexer persists the post-state array from `changed_accounts[].account.zkapp.app_state` verbatim (§6.1). |
| How is L2 rollback handled for zkApp records? | Delegated to the generic transaction-consumer rollback machinery. Every zkApp record is tagged with `target_ledger_hash`; on rollback, matching events/actions are deleted and account state is restored from `account_activity` snapshots (§8). |

---

## 10. Implementation Checklist

**Indexer + data model (M1):**
- [ ] Implement SurrealDB migrations for `zkapp_event`, `zkapp_action` tables and `account` table additions (including `action_state` vector and `target_ledger_hash`)
- [ ] Implement indexer extraction of events/actions from `account_updates` in NATS messages
- [ ] Implement `action_state` computation (Poseidon hash) with cross-check against post-state `action_state[0]`
- [ ] Write `account_activity` snapshot rows for every zkApp state change (enables rollback revert)
- [ ] Wire zkApp revert into the transaction consumer's rollback path: delete events/actions by `target_ledger_hash`, restore account state from `account_activity`
- [ ] Indexer writes `contract:addr:<network>:<address>` → `vkey_hash` to KV on each zkApp command

**Contract registry (M1 backend, see addendum):**
- [ ] Provision Cloudflare KV namespace (`zeko-explorer-contracts`) with keyspaces per §4
- [ ] Stand up Verification Service (Cloudflare Container or equivalent sandboxed worker) with pipeline stages `CLONING → INSTALLING → COMPILING → REFLECTING → MATCHING → VERIFIED`
- [ ] Implement Ed25519-signed verification result protocol (worker signs, API verifies and writes to KV)
- [ ] Implement runtime reflection of `@state`, `events`, `reducer.actionType` from compiled o1js class
- [ ] Implement `zeko.manifest.json` parser with manifest-vs-reflection validation (reject on mismatch)
- [ ] Submit the `zeko-labs/zeko` repository through the flow to bootstrap the bridge contract entries (outer + inner)

**API (M1):**
- [ ] Implement `submitContractForVerification`, `verificationProgress` (SSE), `contract(...)`, `verifiedContracts`, `submitOwnerClaim`, `updateOwnerMetadata` GraphQL operations
- [ ] Implement wallet-signature verification for owner claims (nonce + 10-minute validity + replay-protection KV set)
- [ ] Implement API-layer label resolution (KV lookup by `verification_key_hash`, discriminator dispatch for events/actions)
- [ ] Add `events` and `actions` resolvers to GraphQL `Account` type
- [ ] Add `labeledState` / `labeledFields` resolvers that apply registry labels
- [ ] Rate-limiting on `submitContractForVerification` (10 submissions/IP/hour, 3 concurrent jobs global)

**Frontend (M2, see addendum §8):**
- [ ] Submission wizard (4-step) with live SSE progress stream
- [ ] Verified contract page (State / Events / Actions / Deployments / Source tabs)
- [ ] Owner claim flow via Auro/Pallad wallet signature
- [ ] Owner dashboard for editing display metadata
- [ ] Unverified contract page (raw fields + "Verify this contract" CTA)
