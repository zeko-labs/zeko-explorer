Feature: zkApp State Indexing

  The indexer extracts zkApp state from NATS messages and stores it as an
  8-element field array on the account record. State is sourced from the
  post-transaction changed_accounts snapshot, not from account_updates.
  Fields with "Keep" in app_state are not overwritten.

  Background:
    Given the indexer is consuming from "zeko.l2.transactions"

  Scenario: zkApp state is stored when a zkApp command is processed
    When a NATS message arrives with command.type "zkapp_command"
    And changed_accounts contains account "B62qContract" with zkapp_state:
      | index | value                                                              |
      | 0     | 1234567890123456789012345678901234567890123456789012345678901234 |
      | 1     | 9876543210987654321098765432109876543210987654321098765432109876 |
    Then the account record for "B62qContract" has zkapp_state with 8 fields
    And field index 0 equals "1234567890123456789012345678901234567890123456789012345678901234"
    And field index 1 equals "9876543210987654321098765432109876543210987654321098765432109876"

  Scenario: zkApp state is updated when a subsequent transaction changes a field
    Given account "B62qContract" has stored zkapp_state with field 2 equal to "aaa"
    When a NATS message arrives with changed_accounts for "B62qContract"
    And the new zkapp_state has field 2 equal to "bbb"
    Then the account record for "B62qContract" has field 2 equal to "bbb"
    And all other fields remain unchanged

  Scenario: verification_key_hash is stored when a verification key is set
    When a NATS message arrives with a zkApp command for account "B62qContract"
    And the account_update for "B62qContract" contains:
      | verification_key.hash | abc123def456 |
    Then the account record for "B62qContract" has verification_key_hash "abc123def456"

  Scenario: verification_key_hash is not overwritten when update has no key change
    Given account "B62qContract" has verification_key_hash "original-hash"
    When a NATS message arrives with a zkApp command for "B62qContract"
    And the account_update has verification_key null
    Then the account record for "B62qContract" still has verification_key_hash "original-hash"

  Scenario: Non-zkApp accounts do not get a zkapp_state field
    When a NATS message arrives with command.type "signed_command"
    And changed_accounts contains a regular payment account "B62qUser"
    Then the account record for "B62qUser" has zkapp_state null

  Scenario: zkapp_uri is stored when present in account_update
    When a NATS message arrives with a zkApp command for "B62qContract"
    And the account_update contains zkapp_uri "https://example.com/metadata.json"
    Then the account record for "B62qContract" has zkapp_uri "https://example.com/metadata.json"
