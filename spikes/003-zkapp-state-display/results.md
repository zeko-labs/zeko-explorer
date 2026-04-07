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
      "events": {},
      "actions": {
        "commit": [
          { "index": 0, "label": "inner_action_state", "type": "field" },
          { "index": 1, "label": "inner_ledger_hash", "type": "field" },
          { "index": 2, "label": "slot_lower", "type": "uint32" },
          { "index": 3, "label": "slot_upper", "type": "uint32" }
        ],
        "witness": [
          { "index": 0, "label": "aux", "type": "field" }
        ]
      }
    }
  ]
}
```

Field labels are derived from `Zeko_circuits.Rollup_state.Outer_state.typ` and `Inner_state.typ` in the Zeko source. The labels above are indicative — exact layouts must be confirmed from the circuit definitions during implementation. The `verificationKeyHash` must be populated from a deployed instance.

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

DEFINE INDEX idx_event_account ON zkapp_event FIELDS emitting_account;
DEFINE INDEX idx_event_tx ON zkapp_event FIELDS transaction;
DEFINE INDEX idx_event_seq ON zkapp_event FIELDS sequence_number;
```

### `zkapp_action` Table

```surql
DEFINE TABLE zkapp_action SCHEMAFULL;
DEFINE FIELD id ON zkapp_action TYPE string;  -- deterministic: {tx_hash}:{account}:{action_index}
DEFINE FIELD transaction ON zkapp_action TYPE record<transaction>;
DEFINE FIELD emitting_account ON zkapp_action TYPE record<account>;
DEFINE FIELD action_index ON zkapp_action TYPE int;
DEFINE FIELD fields ON zkapp_action TYPE array<string>;  -- raw field elements
DEFINE FIELD action_state ON zkapp_action TYPE string;  -- rolling hash after this action
DEFINE FIELD timestamp ON zkapp_action TYPE datetime;
DEFINE FIELD sequence_number ON zkapp_action TYPE int;

DEFINE INDEX idx_action_account ON zkapp_action FIELDS emitting_account;
DEFINE INDEX idx_action_tx ON zkapp_action FIELDS transaction;
DEFINE INDEX idx_action_state ON zkapp_action FIELDS action_state;
DEFINE INDEX idx_action_seq ON zkapp_action FIELDS sequence_number;
```

---

## 6. Indexer Processing

When the indexer receives a `zeko.l2.transactions` message with `command.type === "zkapp_command"`:

```
NATS message received
    │
    ├─► Extract changed_accounts[].account.zkapp_state
    │   → Upsert account records with zkapp_state array + verification_key_hash
    │
    ├─► Extract command.account_updates[]
    │   → For each account_update:
    │       ├─► If update has events → create zkapp_event records
    │       └─► If update has actions → create zkapp_action records
    │
    └─► Link events/actions to transaction and emitting account
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
2. **Actions**: For each field array in `account_update.body.actions` → create a `zkapp_action` record with computed `action_state`, linked to the transaction and emitting account.
3. **State**: Use the post-state from `changed_accounts[].account.zkapp_state`.
4. **Verification key**: Extract `.hash` from `account_update.body.update.verification_key` when present, store on account.

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

## 8. Open Questions — Resolved

| Original Question | Resolution |
|---|---|
| How does Zekoscan display zkApp state? | Minimal — shows zkApp transactions but no decoded state/events/actions. |
| How does Minascan display zkApp state? | Developer-opt-in via contract verification + custom metadata. Raw fields without verification. |
| Community conventions for annotating state fields? | None standardized. No ABI equivalent in the Mina ecosystem. |
| How are events and actions structured? | Events: named, typed field arrays via `emitEvent()`. Actions: similar but with `actionState` rolling hash and reducer processing. Both stored as raw field arrays. |
| Can field labels be associated with a deployed contract? | Via verification key hash → known contract registry. No on-chain mechanism. |
| For Zeko's own contracts, can we hardcode labels? | Yes. Bridge contract layout defined in `Zeko_circuits.Rollup_state.Outer_state.typ`. |
| What queries do developers run against events/actions? | By emitting account, by sequence number, by action state hash. Reflected in SurrealDB indexes. |

---

## 9. Implementation Checklist

- [ ] Confirm exact bridge contract state field layout from `Zeko_circuits.Rollup_state.Outer_state.typ` and `Inner_state.typ`
- [ ] Create `known-contracts.json` with bridge contract entries (populate `verificationKeyHash` from deployed instance)
- [ ] Implement SurrealDB migrations for `zkapp_event`, `zkapp_action` tables and `account` table additions
- [ ] Implement indexer extraction of events/actions from `account_updates` in NATS messages
- [ ] Implement API-layer label resolution (registry lookup by `verification_key_hash`)
- [ ] Add `events` and `actions` resolvers to GraphQL `Account` type
- [ ] Add `labeledState` / `labeledFields` resolvers that apply registry labels
