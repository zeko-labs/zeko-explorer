# Spike 003: zkApp State, Events, and Actions Display — Results

**Status:** Complete
**Date:** 2026-04-03

---

## 1. Explorer Survey

### Minascan (Mina L1 Explorer)

Minascan is the most mature Mina explorer for zkApp data display:

- **Contract verification** is supported — developers can verify contracts, enabling richer display.
- **Custom metadata** — Minascan converts actions and events to human-readable forms as defined by developers who submit metadata alongside verified contracts.
- **zkApp state** is available via GraphQL (`zkappState`, `leafHash`, merkle path information).
- **Without verification**, state fields are displayed as raw field elements with no labels.

**Key takeaway:** Minascan's approach is developer-opt-in. Verified contracts get rich display; unverified contracts get raw fields. There is no automatic decoding.

### Zekoscan (Zeko L2 Explorer)

- Users can view zkApp transactions by selecting "zkApp Transactions" on an address page.
- Displays deployed zkApps and wallet balances.
- **Limited zkApp-specific display** — primarily shows transaction metadata rather than decoded state/events/actions.
- No contract verification flow observed.

**Key takeaway:** Zekoscan does not set a high bar for zkApp data display. There is room to differentiate.

### Summary

| Feature | Minascan | Zekoscan |
|---|---|---|
| Raw state fields | Yes (via GraphQL) | Limited |
| Labeled state fields | Yes (verified contracts only) | No |
| Event display | Yes (human-readable with metadata) | No |
| Action display | Yes (human-readable with metadata) | No |
| Contract verification | Yes | No |
| User-submitted schemas | Via verification flow | No |

---

## 2. o1js Data Model

Understanding the underlying data structures is essential for display and schema design.

### 2.1 zkApp State (8 Fields)

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

### 2.2 Events

Events are public arbitrary data emitted with transactions. Declared at the top level of a smart contract:

```typescript
events = {
  'add-merkle-leaf': Field,
  'update': MyCustomStruct,
};
// Emitted via:
this.emitEvent('add-merkle-leaf', newLeaf);
```

**Structure:**
- Each event has a **name** (string) and **data** (array of Field elements).
- Event types are defined in the contract source but **not stored on-chain** — only the raw field arrays are persisted.
- Events cannot be accessed provably inside smart contracts (read-only from outside via `fetchEvents()`).
- Archive nodes store events indexed by emitting account and block/transaction.

### 2.3 Actions

Actions are structurally similar to events but have additional power:

```typescript
// Declared like events:
events = { 'deposit': DepositStruct };

// But dispatched as actions:
this.reducer.dispatch(action);

// And processable inside the contract:
this.reducer.reduce(actions, State, callback);
```

**Key differences from events:**
- Actions maintain an **action state** — a rolling hash commitment (`actionState`) that proves which actions were dispatched.
- Actions can be **processed inside smart contracts** via the reducer pattern, enabling concurrent state updates.
- Actions have a **sequence number** and **state hash** that tracks the action accumulator progression.

### 2.4 Relevant NATS Payload Fields

From Spike 001 results, the `zeko.l2.transactions` message for zkApp commands includes:

```json
{
  "command": {
    "type": "zkapp_command",
    "account_updates": ["<account_update objects>"]
  },
  "changed_accounts": [
    {
      "account": {
        "public_key": "<base58>",
        "zkapp_state": ["<field_0>", "<field_1>", "...", "<field_7>"]
      }
    }
  ]
}
```

The `account_updates` array contains the zkApp command's account updates, which include event emissions and action dispatches. The `changed_accounts` contains the post-state of each affected account, including the updated `zkapp_state` array.

---

## 3. Display Strategy Recommendation

### Decision: Option 2 — Known Contract Registry + Raw Fields

A phased approach that starts practical and grows:

| Phase | Scope | Effort |
|---|---|---|
| **Milestone 1 (API)** | Raw fields for all accounts. Known contract registry provides labels for Zeko's own contracts. Events/actions returned as raw field arrays with emitting account and transaction links. | Low |
| **Milestone 2 (UI)** | Raw fields with copy-to-clipboard. Labeled fields for known contracts (inline labels next to field values). Expandable event/action lists grouped by transaction. | Medium |
| **Future (post-launch)** | User-submitted schemas via a PR-based or admin-submitted flow. Verification-key-based lookup for automatic schema matching. | Deferred |

### Why Option 2 Over Others

| Option | Verdict | Reason |
|---|---|---|
| 1. Raw fields only | Too minimal | Developers want labeled fields for Zeko's own bridge/rollup contracts at minimum. Raw-only provides no differentiation over Zekoscan. |
| 2. **Known contract registry** | **Selected** | Covers the most important contracts (Zeko's own) with minimal effort. Raw fallback for everything else. No external dependencies. |
| 3. User-submitted schemas | Deferred | Requires a submission/review workflow. Not enough contract diversity on Zeko L2 at launch to justify the investment. |
| 4. Verification key mapping | Registry key, not a standalone strategy | Verification key hash is the right **lookup key** for the registry, but the registry itself still needs to exist. Adopted as the key mechanism within Option 2. |

### Registry Key: Verification Key Hash

The verification key hash is the correct registry key because:

1. **Uniquely identifies contract code** — different contract versions produce different verification keys.
2. **Available on-chain** — stored in every zkApp account, no external lookup needed.
3. **Immutable per version** — if the contract upgrades, the new version gets a new verification key, and the registry can have a separate entry.
4. **Already present in account data** — the indexer can extract it from `changed_accounts` without additional RPC calls.

### Display Behavior

**For accounts with a matching registry entry:**
```
State Fields:
  [0] ledger_hash        0x1a2b3c...   [copy]
  [1] action_state       0x4d5e6f...   [copy]
  [2] committed_slot     1234567       [copy]
  ...
```

**For accounts without a registry entry (raw fallback):**
```
State Fields:
  [0]  0x1a2b3c4d5e6f7890abcdef1234567890abcdef1234567890abcdef12345678  [copy]
  [1]  0x4d5e6f7890abcdef1234567890abcdef1234567890abcdef1234567890abcdef  [copy]
  ...
```

**For events and actions:**
```
Events (3):
  ▸ deposit  tx:5Jv8...  2024-03-15 14:23:01
      [0] 0x1a2b3c...
      [1] 0x4d5e6f...
  ▸ deposit  tx:5Jw9...  2024-03-15 14:25:12
      [0] 0x7a8b9c...
      [1] 0x0d1e2f...
```

For known contracts, event field arrays are labeled using the registry's event schema. For unknown contracts, fields are shown as raw indexed arrays.

---

## 4. Known Contract Registry

### Format

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

### Populating the Registry

**Zeko's own contracts** are the initial entries. The field labels above are derived from the Zeko source code at `github.com/zeko-labs/zeko`:

- `Zeko_circuits.Rollup_state.Outer_state.typ` — defines the outer (L1) bridge contract state layout.
- `Zeko_circuits.Rollup_state.Inner_state.typ` — defines the inner (L2) rollup state layout.

**Action:** During implementation, the exact field layouts must be confirmed by reading the circuit definitions in the Zeko repo. The labels above are indicative based on the spike 001 findings (which reference `Utils.value_of_zkapp_state Zeko_circuits.Rollup_state.Outer_state.typ`).

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

## 5. SurrealDB Schema Impact

### 5.1 `account` Table

The `account` table already includes `zkapp_state` in the PRD. Additions:

```surql
DEFINE TABLE account SCHEMAFULL;
-- ...existing fields...
DEFINE FIELD zkapp_state ON account TYPE option<array<string, 8>>;
DEFINE FIELD verification_key_hash ON account TYPE option<string>;
DEFINE FIELD zkapp_uri ON account TYPE option<string>;

-- Index for registry lookups
DEFINE INDEX idx_account_vkey ON account FIELDS verification_key_hash;
```

**Notes:**
- `zkapp_state` is an array of exactly 8 field element strings (or null for non-zkApp accounts).
- `verification_key_hash` enables the registry lookup at query time.
- `zkapp_uri` is an optional field from the account data that some contracts set (points to contract metadata).

### 5.2 `zkapp_event` Table

```surql
DEFINE TABLE zkapp_event SCHEMAFULL;
DEFINE FIELD id ON zkapp_event TYPE string;  -- deterministic: {tx_hash}:{account}:{event_index}
DEFINE FIELD transaction ON zkapp_event TYPE record<transaction>;
DEFINE FIELD emitting_account ON zkapp_event TYPE record<account>;
DEFINE FIELD event_index ON zkapp_event TYPE int;  -- position within the transaction's events
DEFINE FIELD fields ON zkapp_event TYPE array<string>;  -- raw field elements
DEFINE FIELD timestamp ON zkapp_event TYPE datetime;
DEFINE FIELD sequence_number ON zkapp_event TYPE int;  -- global ordering

DEFINE INDEX idx_event_account ON zkapp_event FIELDS emitting_account;
DEFINE INDEX idx_event_tx ON zkapp_event FIELDS transaction;
DEFINE INDEX idx_event_seq ON zkapp_event FIELDS sequence_number;
```

### 5.3 `zkapp_action` Table

```surql
DEFINE TABLE zkapp_action SCHEMAFULL;
DEFINE FIELD id ON zkapp_action TYPE string;  -- deterministic: {tx_hash}:{account}:{action_index}
DEFINE FIELD transaction ON zkapp_action TYPE record<transaction>;
DEFINE FIELD emitting_account ON zkapp_action TYPE record<account>;
DEFINE FIELD action_index ON zkapp_action TYPE int;  -- position within the transaction's actions
DEFINE FIELD fields ON zkapp_action TYPE array<string>;  -- raw field elements
DEFINE FIELD action_state ON zkapp_action TYPE string;  -- rolling hash after this action
DEFINE FIELD timestamp ON zkapp_action TYPE datetime;
DEFINE FIELD sequence_number ON zkapp_action TYPE int;  -- global ordering

DEFINE INDEX idx_action_account ON zkapp_action FIELDS emitting_account;
DEFINE INDEX idx_action_tx ON zkapp_action FIELDS transaction;
DEFINE INDEX idx_action_state ON zkapp_action FIELDS action_state;
DEFINE INDEX idx_action_seq ON zkapp_action FIELDS sequence_number;
```

### 5.4 Design Decisions

**Raw fields stored, labels applied at query time.** The database stores raw field element strings. The API layer applies labels from the known contract registry when resolving queries. This avoids:
- Re-indexing when registry entries are added or corrected.
- Schema coupling between the registry and the database.
- Data loss if a registry entry is wrong.

**No `decoded_fields` column.** The PRD mentions "decoded fields" in the `zkapp_event` / `zkapp_action` tables. After investigation, decoding should happen at the API layer, not the storage layer, because:
1. The registry can change without re-indexing.
2. Different API consumers may want different representations (hex, decimal, labeled, raw).
3. The raw data is the source of truth — derived labels are a view concern.

---

## 6. Indexer Processing

### Extracting zkApp Data from NATS Messages

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

### account_update Structure

Each `account_update` in a zkApp command contains:

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
1. **For each event array** in `account_update.body.events`: create a `zkapp_event` record with the raw field array, linked to the transaction and emitting account.
2. **For each action array** in `account_update.body.actions`: create a `zkapp_action` record with the raw field array and computed `action_state`, linked to the transaction and emitting account.
3. **For `app_state` updates**: when `account_update.body.update.app_state` contains "Set" entries, the corresponding `changed_accounts` entry will have the updated `zkapp_state`. Use the post-state from `changed_accounts`.
4. **For `verification_key` updates**: extract the hash and store on the account record.

---

## 7. GraphQL API Shape

### Account Query

```graphql
type Account {
  publicKey: String!
  balance: String!
  nonce: Int!
  # ...existing fields...
  zkappState: [String!]        # 8 field elements, null for non-zkApp accounts
  verificationKeyHash: String  # null for non-zkApp accounts
  zkappUri: String             # optional metadata URI

  # Labeled state (from known contract registry, null if not in registry)
  labeledState: [LabeledField!]

  events(first: Int, after: String): ZkappEventConnection!
  actions(first: Int, after: String): ZkappActionConnection!
}

type LabeledField {
  index: Int!
  label: String!
  type: String!           # "field", "uint64", "uint32", "bool", "public_key"
  description: String
  rawValue: String!       # the raw field element
}
```

### Event and Action Queries

```graphql
type ZkappEvent {
  id: String!
  transaction: Transaction!
  emittingAccount: Account!
  eventIndex: Int!
  fields: [String!]!          # raw field elements
  labeledFields: [LabeledField!]  # from registry, null if unknown
  timestamp: DateTime!
  sequenceNumber: Int!
}

type ZkappAction {
  id: String!
  transaction: Transaction!
  emittingAccount: Account!
  actionIndex: Int!
  fields: [String!]!          # raw field elements
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
| Community conventions for annotating state fields? | None standardized. No ABI equivalent exists in the Mina ecosystem. Minascan's verification flow is the closest convention. |
| How are events and actions structured? | Events: named, typed field arrays emitted via `emitEvent()`. Actions: similar but with `actionState` rolling hash and reducer processing. Both stored as raw field arrays by archive nodes. |
| Can field labels be associated with a deployed contract? | Via verification key hash as a lookup key into a known contract registry. No on-chain mechanism exists. |
| For Zeko's own contracts, can we hardcode labels? | Yes. The bridge contract's state layout is defined in `Zeko_circuits.Rollup_state.Outer_state.typ`. We control the source and can extract exact field labels. |
| What queries do developers run against events/actions? | "All events from contract X" (by emitting account), "events after sequence N" (by sequence number), "actions by state hash" (by action_state). These are reflected in the SurrealDB indexes. |

### Additional Finding

**`zkapp_uri`** — zkApp accounts can optionally set a `zkapp_uri` field pointing to a metadata JSON file. This is a Mina protocol feature but adoption is near-zero. The explorer should store and display it when present, but should not depend on it for labeling. The known contract registry is the reliable path.

---

## 9. Implementation Checklist

For reference during Milestone 1 implementation:

- [ ] Confirm exact bridge contract state field layout from `Zeko_circuits.Rollup_state.Outer_state.typ` and `Inner_state.typ`
- [ ] Create `known-contracts.json` with bridge contract entries (populate `verificationKeyHash` from a deployed instance)
- [ ] Implement SurrealDB migrations for `zkapp_event`, `zkapp_action` tables and `account` table additions
- [ ] Implement indexer extraction of events/actions from `account_updates` in NATS messages
- [ ] Implement API-layer label resolution (registry lookup by `verification_key_hash`)
- [ ] Add `events` and `actions` resolvers to GraphQL `Account` type
- [ ] Add `labeledState` / `labeledFields` resolvers that apply registry labels
