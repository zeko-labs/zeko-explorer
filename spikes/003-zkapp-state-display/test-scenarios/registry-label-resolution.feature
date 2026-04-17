Feature: Contract Registry Label Resolution

  The explorer resolves labels by reading the contract verification registry
  from Cloudflare KV. Labels live under `contract:vkey:<hash>` and are
  written by the verification service after a sandboxed compile matches the
  computed verification key against the one on-chain (addendum-contract-
  verification §4). Address → vkey hash reverse lookup is written by the
  indexer when a zkApp command is ingested.

  Unknown contracts return raw field arrays. Known contracts return labeled
  fields, dispatching through a discriminator when the contract emits
  multiple event/action types (Mina does not persist event/action names
  on-chain).

  Background:
    Given Cloudflare KV contains the registry entry at "contract:vkey:vkey-hash-bridge":
      | field      | value                                    |
      | name       | Zeko Bridge (Outer)                      |
      | o1jsVersion| 2.4.0                                    |
    And KV contains the address reverse lookup at "contract:addr:zeko-m-devnet:B62qBridge" → "vkey-hash-bridge"

  # State field labeling — single schema per contract

  Scenario: Known contract returns labeled state fields
    Given "contract:vkey:vkey-hash-bridge" stateFields include index 0 with label "inner_ledger_hash" and type "Field"
    And account "B62qBridge" has zkapp_state[0] equal to "999"
    When querying labeledState for "B62qBridge" on network "zeko-m-devnet"
    Then the response contains a labeled field at index 0:
      | label       | inner_ledger_hash                             |
      | type        | Field                                         |
      | rawValue    | 999                                           |

  Scenario: Unknown contract returns null labeledState
    Given KV has no entry at "contract:addr:zeko-m-devnet:B62qUnknown"
    And account "B62qUnknown" has zkapp_state[0] equal to "42"
    When querying labeledState for "B62qUnknown" on network "zeko-m-devnet"
    Then the labeledState is null
    And the response includes a "verify this contract" CTA marker

  Scenario: Account with no verification key returns null labeledState
    Given account "B62qNoKey" has no verification_key_hash
    When querying labeledState for "B62qNoKey"
    Then the labeledState is null

  # Action discrimination — multi-type actions via field index 0 tag

  Scenario: Discriminated action picks the "commit" schema (string_tag from manifest)
    Given the bridge KV entry has actions.discriminator.type "string_tag" at fieldIndex 0 with values {"0": "commit", "1": "witness"}
    And a zkapp_action from "B62qBridge" has fields ["0", "action-state-hash", "ledger-hash", "100", "200"]
    When querying the action's labeledFields
    Then field index 0 has label "kind" with rawValue "0"
    And field index 1 has label "inner_action_state"
    And field index 2 has label "inner_ledger_hash"
    And field index 3 has label "slot_lower" and type "UInt32"
    And field index 4 has label "slot_upper" and type "UInt32"

  Scenario: Discriminated action picks the "witness" schema
    Given the bridge KV entry has actions.discriminator.type "string_tag" at fieldIndex 0 with values {"0": "commit", "1": "witness"}
    And a zkapp_action from "B62qBridge" has fields ["1", "aux-hash-xyz"]
    When querying the action's labeledFields
    Then field index 0 has label "kind" with rawValue "1"
    And field index 1 has label "aux"

  Scenario: Action with unknown discriminator falls back to raw fields
    Given the bridge KV entry has actions.discriminator.type "string_tag" at fieldIndex 0 with values {"0": "commit", "1": "witness"}
    And a zkapp_action from "B62qBridge" has fields ["9", "unexpected"]
    When querying the action's labeledFields
    Then labeledFields is null
    And the raw fields ["9", "unexpected"] remain accessible

  Scenario: Contract with null discriminator applies its single schema to every record
    Given KV contains a vkey entry "vkey-hash-simple" with actions.discriminator null and a single schema [{index:0,label:"x",type:"Field"}]
    And KV contains "contract:addr:zeko-m-devnet:B62qSimple" → "vkey-hash-simple"
    And a zkapp_action from "B62qSimple" has fields ["7"]
    When querying the action's labeledFields
    Then field index 0 has label "x" with rawValue "7"

  # Event discrimination — o1js multi-type events use field_hash

  Scenario: Multi-type events use field_hash discriminator populated by reflection
    Given the vkey entry for "vkey-hash-vault" has events.discriminator.type "field_hash" at fieldIndex 0 with values {"<h(deposit)>": "deposit", "<h(withdrawal)>": "withdrawal"}
    And KV contains "contract:addr:zeko-m-devnet:B62qVault" → "vkey-hash-vault"
    And a zkapp_event from "B62qVault" has fields ["<h(deposit)>", "B62qUser-x", "B62qUser-y", "1000"]
    When querying the event's labeledFields
    Then field index 0 has label "_type" and type "Field"
    And field index 1 has label "user" and type "PublicKey"
    And field index 3 has label "amount" and type "UInt64"

  Scenario: Unknown contract event returns null labeledFields
    Given KV has no "contract:addr:zeko-m-devnet:B62qUnknown" entry
    And a zkapp_event from "B62qUnknown" has fields ["7", "8"]
    When querying the event's labeledFields
    Then labeledFields is null

  # Indexer-driven reverse-lookup population

  Scenario: Indexer writes contract:addr reverse lookup on first zkApp command for an account
    Given the indexer has not previously seen account "B62qNew" on network "zeko-m-devnet"
    And a NATS message arrives with a zkApp command from "B62qNew" with verification_key_hash "vkey-hash-new"
    When the indexer processes the message
    Then KV key "contract:addr:zeko-m-devnet:B62qNew" is set to "vkey-hash-new"
    And subsequent queries for "B62qNew" can resolve to the vkey entry

  Scenario: Indexer updates reverse lookup when a contract's verification key changes
    Given KV has "contract:addr:zeko-m-devnet:B62qUpgraded" → "vkey-hash-v1"
    When a NATS message arrives setting verification_key_hash to "vkey-hash-v2" for "B62qUpgraded"
    Then KV key "contract:addr:zeko-m-devnet:B62qUpgraded" is overwritten to "vkey-hash-v2"
    And the prior vkey KV entry remains (it may be referenced by other addresses)

  # No re-indexing invariant

  Scenario: Adding a vkey entry does not require re-indexing stored events or actions
    Given 1000 zkapp_event records are stored with raw field arrays for accounts whose vkey is currently unverified
    When a new verification completes and "contract:vkey:<hash>" is written to KV
    Then the existing event records are not modified in SurrealDB
    And labeledFields for those events start resolving from the API immediately on the next query

  Scenario: Revoking or updating a vkey entry takes effect at the next read
    Given the KV entry at "contract:vkey:vkey-hash-x" is replaced with a corrected schema
    When the next query for an account with vkey "vkey-hash-x" arrives
    Then the new schema is applied without restarting the API
    And no data migration or re-indexing is required
