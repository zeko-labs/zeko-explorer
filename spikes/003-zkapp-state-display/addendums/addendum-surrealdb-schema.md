# Addendum: SurrealDB Schema for zkApp Data

## `account` Table Additions

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
- `verification_key_hash` enables the known contract registry lookup at query time.
- `zkapp_uri` is an optional field from the account data that some contracts set (points to contract metadata). Near-zero adoption but stored when present.

## `zkapp_event` Table

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

## `zkapp_action` Table

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

## Design Decisions

### Raw fields stored, labels applied at query time

The database stores raw field element strings. The API layer applies labels from the known contract registry when resolving queries. This avoids:
- Re-indexing when registry entries are added or corrected.
- Schema coupling between the registry and the database.
- Data loss if a registry entry is wrong.

### No `decoded_fields` column

The PRD mentions "decoded fields" in the `zkapp_event` / `zkapp_action` tables. After investigation, decoding should happen at the API layer, not the storage layer, because:
1. The registry can change without re-indexing.
2. Different API consumers may want different representations (hex, decimal, labeled, raw).
3. The raw data is the source of truth — derived labels are a view concern.

### Index Strategy

| Index | Purpose | Common query |
|---|---|---|
| `idx_event_account` / `idx_action_account` | Events/actions by emitting contract | "All events from contract X" |
| `idx_event_tx` / `idx_action_tx` | Events/actions within a transaction | Transaction detail page |
| `idx_event_seq` / `idx_action_seq` | Global ordering | "Events after sequence N" |
| `idx_action_state` | Action state hash lookup | "Actions at state hash X" |
| `idx_account_vkey` | Registry lookup by verification key | Label resolution at query time |
