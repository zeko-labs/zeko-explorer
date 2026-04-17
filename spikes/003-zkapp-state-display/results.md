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

### Decision: Known Contract Registry + Raw Fields

| Phase | Scope | Effort |
|---|---|---|
| **Milestone 1 (API)** | Raw fields for all accounts. Known contract registry provides labels for Zeko's own contracts. Events/actions as raw field arrays with emitting account and transaction links. | Low |
| **Milestone 2 (UI)** | Raw fields with copy-to-clipboard. Labeled fields for known contracts. Expandable event/action lists grouped by transaction. | Medium |
| **Future (post-launch)** | User-submitted schemas via PR-based flow. Verification-key-based lookup for automatic schema matching. | Deferred |

### Why This Option

| Option | Verdict | Reason |
|---|---|---|
| 1. Raw fields only | Too minimal | No differentiation over Zekoscan. Developers want labels for bridge/rollup contracts. |
| 2. **Known contract registry** | **Selected** | Covers Zeko's own contracts with minimal effort. Raw fallback for the rest. No external dependencies. |
| 3. User-submitted schemas | Deferred | Requires submission/review workflow. Not enough contract diversity at launch. |
| 4. Verification key mapping | Registry key, not standalone | Adopted as the **lookup key** within Option 2 — uniquely identifies contract code, available on-chain, immutable per version. |

### Registry Lookup Flow

```
Account loaded → extract verification_key_hash
                       │
                 Registry lookup by vkey hash
                       │
              ┌────────┴────────┐
          Found?              Not found
              │                   │
     Apply labels to          Display raw
     state/events/actions     field arrays
```

---

## 4. Known Contract Registry

A JSON file in the explorer repository, loaded by the indexer at startup and served by the API.

**Location:** `packages/indexer/src/registry/known-contracts.json`

```json
{
  "$schema": "./known-contracts.schema.json",
  "contracts": [
    {
      "name": "Zeko Bridge (Outer/L1)",
      "description": "L1 bridge contract managing commit/witness actions for the Zeko rollup",
      "verificationKeyHash": "<vkey_hash_hex>",
      "address": "<public_key_base58>",
      "network": "mainnet",
      "stateFields": [
        { "index": 0, "label": "inner_ledger_hash", "type": "field", "description": "Current committed inner (L2) ledger hash" },
        { "index": 1, "label": "inner_action_state", "type": "field", "description": "Rolling hash of inner actions processed" },
        { "index": 2, "label": "outer_action_state", "type": "field", "description": "Rolling hash of outer actions (commits/witnesses)" },
        { "index": 3, "label": "committed_slot_lower", "type": "uint32", "description": "Lower bound of committed slot range" },
        { "index": 4, "label": "committed_slot_upper", "type": "uint32", "description": "Upper bound of committed slot range" },
        { "index": 5, "label": "sequencer_public_key_x", "type": "field", "description": "Sequencer public key (x coordinate)" },
        { "index": 6, "label": "sequencer_public_key_is_odd", "type": "bool", "description": "Sequencer public key (parity bit)" },
        { "index": 7, "label": "reserved", "type": "field", "description": "Reserved / unused" }
      ],
      "events": {
        "discriminator": null,
        "schemas": []
      },
      "actions": {
        "discriminator": { "fieldIndex": 0, "type": "string_tag",
          "values": { "0": "commit", "1": "witness" } },
        "schemas": {
          "commit": [
            { "index": 0, "label": "kind", "type": "field", "description": "Discriminator: 0 = commit" },
            { "index": 1, "label": "inner_action_state", "type": "field" },
            { "index": 2, "label": "inner_ledger_hash", "type": "field" },
            { "index": 3, "label": "slot_lower", "type": "uint32" },
            { "index": 4, "label": "slot_upper", "type": "uint32" }
          ],
          "witness": [
            { "index": 0, "label": "kind", "type": "field", "description": "Discriminator: 1 = witness" },
            { "index": 1, "label": "aux", "type": "field" }
          ]
        }
      }
    }
  ]
}
```

Field labels are derived from `Zeko_circuits.Rollup_state.Outer_state.typ` and `Inner_state.typ` in the Zeko source. The labels above are indicative — exact layouts must be confirmed from the circuit definitions during implementation. The `verificationKeyHash` must be populated from a deployed instance.

### 4.1 Event/Action Type Discrimination

Mina does not persist event or action **names** on-chain. An o1js declaration like `events = { 'add-merkle-leaf': Field, 'update': MyStruct }` defines compile-time labels, but the on-chain representation is raw `field[]`. The explorer therefore cannot recover the type name from chain data alone.

**Contracts that emit multiple event/action types are expected to include a discriminator field** as part of their wire format. The Zeko bridge contract does this: `action[0]` is `"0"` for `commit` and `"1"` for `witness` (confirmed in spike 002 §1 — `zeko-ui/services/actions/indexer/src/modules/outer.ts`). Without this convention, labels cannot be applied because the registry has no way to pick the right schema.

The registry supports three cases:

| `discriminator` value | Meaning |
|---|---|
| `null` | Contract emits a single event/action type. `schemas` is an array of field labels — applied to every record. |
| `{ fieldIndex: N, type: "string_tag", values: { ... } }` | Contract tags records with a stringified integer (like the bridge's "0"/"1"). `schemas` is an object keyed by tag name. |
| `{ fieldIndex: N, type: "field_hash", values: { ... } }` | Contract tags records with a `Poseidon` hash of the type name. Used by contracts following the o1js convention for multi-type events (rare — most contracts use string tags). |

**At query time**, the API resolver:
1. Looks up the contract by `verification_key_hash`.
2. If `discriminator` is `null` → apply the single schema.
3. Otherwise → read `fields[discriminator.fieldIndex]`, look up the matching schema key, apply that schema.
4. If no matching key → return raw fields (as for unknown contracts).

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
| Can field labels be associated with a deployed contract? | Via verification key hash → known contract registry. No on-chain mechanism. |
| For Zeko's own contracts, can we hardcode labels? | Yes. Bridge contract layout defined in `Zeko_circuits.Rollup_state.Outer_state.typ`. |
| What queries do developers run against events/actions? | By emitting account, by sequence number, by `action_state` / `before_action_state` chain walks. Reflected in SurrealDB indexes. |
| How is `action_state` computed? | Poseidon hash of (`before_action_state`, `actions_commitment`). Derivable from NATS payload — see §6.2. Post-state is cross-checked against `changed_accounts[].account.zkapp.action_state[0]`. |
| How are `Set` / `Keep` app_state markers handled? | Indexer ignores them — the sequencer has already applied them. The indexer persists the post-state array from `changed_accounts[].account.zkapp.app_state` verbatim (§6.1). |
| How is L2 rollback handled for zkApp records? | Delegated to the generic transaction-consumer rollback machinery. Every zkApp record is tagged with `target_ledger_hash`; on rollback, matching events/actions are deleted and account state is restored from `account_activity` snapshots (§8). |

---

## 10. Implementation Checklist

- [ ] Confirm exact bridge contract state field layout from `Zeko_circuits.Rollup_state.Outer_state.typ` and `Inner_state.typ`
- [ ] Create `known-contracts.json` with bridge contract entries (populate `verificationKeyHash` from deployed instance)
- [ ] Implement SurrealDB migrations for `zkapp_event`, `zkapp_action` tables and `account` table additions (including `action_state` vector and `target_ledger_hash`)
- [ ] Implement indexer extraction of events/actions from `account_updates` in NATS messages
- [ ] Implement `action_state` computation (Poseidon hash) with cross-check against post-state `action_state[0]`
- [ ] Write `account_activity` snapshot rows for every zkApp state change (enables rollback revert)
- [ ] Wire zkApp revert into the transaction consumer's rollback path: delete events/actions by `target_ledger_hash`, restore account state from `account_activity`
- [ ] Implement API-layer label resolution (registry lookup by `verification_key_hash`, discriminator dispatch for events/actions)
- [ ] Add `events` and `actions` resolvers to GraphQL `Account` type
- [ ] Add `labeledState` / `labeledFields` resolvers that apply registry labels
