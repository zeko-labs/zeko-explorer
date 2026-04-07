# Addendum: Known Contract Registry

## Format

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

## Why Verification Key Hash as the Registry Key

1. **Uniquely identifies contract code** — different contract versions produce different verification keys.
2. **Available on-chain** — stored in every zkApp account, no external lookup needed.
3. **Immutable per version** — if the contract upgrades, the new version gets a new verification key, and the registry can have a separate entry.
4. **Already present in account data** — the indexer can extract it from `changed_accounts` without additional RPC calls.

## Populating the Registry

**Zeko's own contracts** are the initial entries. The field labels above are derived from the Zeko source code at `github.com/zeko-labs/zeko`:

- `Zeko_circuits.Rollup_state.Outer_state.typ` — defines the outer (L1) bridge contract state layout.
- `Zeko_circuits.Rollup_state.Inner_state.typ` — defines the inner (L2) rollup state layout.

**Action required:** During implementation, the exact field layouts must be confirmed by reading the circuit definitions in the Zeko repo. The labels above are indicative based on the spike 001 findings (which reference `Utils.value_of_zkapp_state Zeko_circuits.Rollup_state.Outer_state.typ`). The `verificationKeyHash` values must be populated from a deployed instance.

## Display Behavior

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
```

For known contracts, event/action field arrays are labeled using the registry's schema. For unknown contracts, fields are shown as raw indexed arrays.

## Future: User-Submitted Schemas

Post-launch, the registry can grow via:
1. **PR-based submission** — contract deployers submit a PR adding their contract to `known-contracts.json`.
2. **Admin panel** — if warranted by volume, a simple admin UI for reviewing and merging schema submissions.
3. **zkapp_uri fallback** — the Mina protocol supports an optional `zkapp_uri` field pointing to metadata JSON. Adoption is near-zero today, but the explorer stores it when present for future use.
