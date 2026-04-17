Feature: zkApp State Indexing

  The indexer extracts zkApp state from NATS messages and stores it as an
  8-element field array on the account record. State is sourced from the
  post-transaction changed_accounts snapshot — the sequencer has already
  applied all Set/Keep markers from account_updates, so the indexer persists
  the resolved post-state verbatim without interpreting the markers itself.
  Every state-changing write also appends an account_activity snapshot
  tagged with the transaction's target_ledger_hash for rollback revert.

  Background:
    Given the indexer is consuming from "zeko.l2.transactions"

  Scenario: zkApp state is stored when a zkApp command is processed
    When a NATS message arrives with command.type "zkapp_command"
    And changed_accounts contains account "B62qContract" with zkapp.app_state:
      | index | value                                                              |
      | 0     | 1234567890123456789012345678901234567890123456789012345678901234 |
      | 1     | 9876543210987654321098765432109876543210987654321098765432109876 |
    Then the account record for "B62qContract" has zkapp_state with 8 fields
    And field index 0 equals "1234567890123456789012345678901234567890123456789012345678901234"
    And field index 1 equals "9876543210987654321098765432109876543210987654321098765432109876"

  Scenario: Indexer persists the post-state verbatim without interpreting Set/Keep
    Given account "B62qContract" has stored zkapp_state ["111", "222", "333", "444", "555", "666", "777", "888"]
    When a NATS message arrives with an account_update for "B62qContract" where:
      | slot 0 | Set "999" |
      | slot 1 | Keep      |
      | slot 2 | Set "abc" |
      | slot 3 | Keep      |
    And the message's changed_accounts[B62qContract].zkapp.app_state is:
      | ["999", "222", "abc", "444", "555", "666", "777", "888"] |
    Then the account record for "B62qContract" has zkapp_state ["999", "222", "abc", "444", "555", "666", "777", "888"]
    And the indexer did not read account_update.body.update.app_state

  Scenario: action_state vector is stored on the account from post-state
    When a NATS message arrives with a zkApp command for "B62qContract"
    And changed_accounts[B62qContract].zkapp.action_state is ["s1", "s2", "s3", "s4", "s5"]
    Then the account record for "B62qContract" has action_state ["s1", "s2", "s3", "s4", "s5"]
    And the head element of action_state is "s1"

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
    And the account record for "B62qUser" has action_state null

  Scenario: zkapp_uri is stored when present in account_update
    When a NATS message arrives with a zkApp command for "B62qContract"
    And the account_update contains zkapp_uri "https://example.com/metadata.json"
    Then the account record for "B62qContract" has zkapp_uri "https://example.com/metadata.json"

  Scenario: State change writes an account_activity snapshot for rollback revert
    Given account "B62qContract" has stored zkapp_state ["aaa", ...]
    When a NATS message with target_ledger_hash "hash-N" arrives
    And the message updates "B62qContract" zkapp_state to ["bbb", ...]
    Then an account_activity row exists for "B62qContract" with target_ledger_hash "hash-N"
    And the account_activity row captures zkapp_state ["bbb", ...] and action_state
