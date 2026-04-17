Feature: Known Contract Registry Label Resolution

  The indexer loads a known-contracts.json registry at startup. The API
  resolves labels by looking up the account's verification_key_hash in the
  registry. Unknown contracts return raw field arrays only. Known contracts
  return labeled fields, dispatching through a discriminator when the
  contract emits multiple event/action types (since Mina does not persist
  event/action names on-chain).

  Background:
    Given the known-contracts registry is loaded with:
      | verificationKeyHash | name                 |
      | vkey-hash-bridge    | Zeko Bridge (Outer)  |

  # State field labeling — single schema per contract

  Scenario: Known contract returns labeled state fields
    Given account "B62qBridge" has:
      | verification_key_hash | vkey-hash-bridge |
      | zkapp_state[0]        | 999              |
    When querying labeledState for "B62qBridge"
    Then the response contains a labeled field at index 0:
      | label       | inner_ledger_hash                             |
      | type        | field                                         |
      | rawValue    | 999                                           |
      | description | Current committed inner (L2) ledger hash      |

  Scenario: Unknown contract returns null labeledState
    Given account "B62qUnknown" has:
      | verification_key_hash | vkey-hash-unknown |
      | zkapp_state[0]        | 42                |
    When querying labeledState for "B62qUnknown"
    Then the labeledState is null

  Scenario: Account with no verification key returns null labeledState
    Given account "B62qNoKey" has no verification_key_hash
    When querying labeledState for "B62qNoKey"
    Then the labeledState is null

  # Action discrimination — multi-type actions via field index 0 tag

  Scenario: Discriminated action picks the "commit" schema
    Given the bridge registry entry has an action discriminator at fieldIndex 0 with values {"0": "commit", "1": "witness"}
    And a zkapp_action from "B62qBridge" has fields ["0", "action-state-hash", "ledger-hash", "100", "200"]
    When querying the action's labeledFields
    Then field index 0 has label "kind" with rawValue "0"
    And field index 1 has label "inner_action_state"
    And field index 2 has label "inner_ledger_hash"
    And field index 3 has label "slot_lower" and type "uint32"
    And field index 4 has label "slot_upper" and type "uint32"

  Scenario: Discriminated action picks the "witness" schema
    Given the bridge registry entry has an action discriminator at fieldIndex 0 with values {"0": "commit", "1": "witness"}
    And a zkapp_action from "B62qBridge" has fields ["1", "aux-hash-xyz"]
    When querying the action's labeledFields
    Then field index 0 has label "kind" with rawValue "1"
    And field index 1 has label "aux"

  Scenario: Action with unknown discriminator falls back to raw fields
    Given the bridge registry entry has an action discriminator at fieldIndex 0 with values {"0": "commit", "1": "witness"}
    And a zkapp_action from "B62qBridge" has fields ["9", "unexpected"]
    When querying the action's labeledFields
    Then labeledFields is null
    And the raw fields ["9", "unexpected"] remain accessible

  Scenario: Contract with no discriminator applies its single schema to every record
    Given the registry contains a contract "vkey-hash-simple" with action discriminator null and a single schema [{index:0,label:"x",type:"field"}]
    And a zkapp_action from "B62qSimple" (vkey "vkey-hash-simple") has fields ["7"]
    When querying the action's labeledFields
    Then field index 0 has label "x" with rawValue "7"

  # Event discrimination — same machinery as actions

  Scenario: Unknown contract event returns null labeledFields
    Given a zkapp_event from account "B62qUnknown" (vkey "vkey-hash-unknown") with fields ["7", "8"]
    When querying the event's labeledFields
    Then labeledFields is null

  # Registry hot-reload and no-migration invariant

  Scenario: Registry reload at startup picks up updated entries
    Given the known-contracts.json file is updated with a new entry for vkey "vkey-hash-new"
    When the indexer restarts and reloads the registry
    Then accounts with verification_key_hash "vkey-hash-new" return labeled fields
    And no re-indexing of stored data is needed

  Scenario: Registry update does not require data migration
    Given 1000 zkapp_event records are stored with raw field arrays
    When the known-contracts registry adds a new entry matching those events' accounts
    Then the existing event records are not modified
    And labeledFields for those events start resolving from the API without re-indexing
