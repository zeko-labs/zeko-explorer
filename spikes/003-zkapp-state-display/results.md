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

## 2. Display Strategy

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

See [addendum: known contract registry](./addendums/addendum-known-contract-registry.md) for the full JSON schema, initial contract entries, and population strategy.

---

## 3. SurrealDB Schema Impact

### Key Design Decision

**Raw fields stored, labels applied at query time.** The database stores raw field element strings. The API layer applies labels from the registry at resolution time. This avoids re-indexing when registry entries change, and preserves the raw source of truth.

**No `decoded_fields` column.** The PRD mentions "decoded fields" — after investigation, decoding is a view concern (API layer), not a storage concern, because:
1. Registry can change without re-indexing.
2. Different consumers want different representations (hex, decimal, labeled).
3. Raw data is the source of truth.

### New/Modified Tables

**`account` additions:**
- `zkapp_state` — `option<array<string, 8>>` (8 field elements, null for non-zkApp accounts)
- `verification_key_hash` — `option<string>` (indexed, enables registry lookup)
- `zkapp_uri` — `option<string>` (optional metadata URI, near-zero adoption but stored when present)

**`zkapp_event`** — emitting account + transaction links, raw field array, event index, sequence number, timestamp

**`zkapp_action`** — same as event, plus `action_state` (rolling hash) with dedicated index

See [addendum: SurrealDB schema](./addendums/addendum-surrealdb-schema.md) for complete table definitions and indexes.

---

## 4. Indexer Processing

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

The indexer extracts events/actions from `account_update.body.events` and `account_update.body.actions` (arrays of field arrays). State comes from `changed_accounts[].account.zkapp_state` (post-state). Verification key hash comes from `account_update.body.update.verification_key.hash` when present.

See [addendum: o1js data model](./addendums/addendum-o1js-data-model.md) for the full technical breakdown of state, events, and actions structures.

---

## 5. GraphQL API Shape

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

## 6. Open Questions — Resolved

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

## 7. Implementation Checklist

- [ ] Confirm exact bridge contract state field layout from `Zeko_circuits.Rollup_state.Outer_state.typ` and `Inner_state.typ`
- [ ] Create `known-contracts.json` with bridge contract entries (populate `verificationKeyHash` from deployed instance)
- [ ] Implement SurrealDB migrations for `zkapp_event`, `zkapp_action` tables and `account` table additions
- [ ] Implement indexer extraction of events/actions from `account_updates` in NATS messages
- [ ] Implement API-layer label resolution (registry lookup by `verification_key_hash`)
- [ ] Add `events` and `actions` resolvers to GraphQL `Account` type
- [ ] Add `labeledState` / `labeledFields` resolvers that apply registry labels
