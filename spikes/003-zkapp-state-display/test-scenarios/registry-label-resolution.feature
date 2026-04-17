Feature: Known Contract Registry Label Resolution

  The indexer loads a known-contracts.json registry at startup. The API
  resolves labels by looking up the account's verification_key_hash in the
  registry. Unknown contracts receive raw field arrays only; known contracts
  receive labeled fields with types and descriptions.

  Background:
    Given the known-contracts registry is loaded with:
      | verificationKeyHash | name                 |
      | vkey-hash-bridge    | Zeko Bridge (Outer)  |

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

  Scenario: Known contract event returns labeled fields
    Given a zkapp_event from account "B62qBridge" (vkey "vkey-hash-bridge") with fields ["7", "8"]
    And the registry maps event index 0 to label "inner_action_state" type "field"
    When querying the event's labeledFields
    Then field index 0 has label "inner_action_state" and rawValue "7"

  Scenario: Unknown contract event returns null labeledFields
    Given a zkapp_event from account "B62qUnknown" (vkey "vkey-hash-unknown") with fields ["7", "8"]
    When querying the event's labeledFields
    Then labeledFields is null

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
