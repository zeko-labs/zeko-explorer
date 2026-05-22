Feature: zkApp State Rollback on L2 Reorganization

  L2 rollbacks are detected consumer-side by hash chain continuity checking
  on zeko.l2.transactions (see spike 001 §5 and PRD §7.5). There is no
  dedicated rollback NATS subject. When the transaction consumer identifies
  a set of invalidated transactions, it invokes the zkApp revert path:
  delete zkapp_event and zkapp_action records tagged with the rolled-back
  target_ledger_hashes, and restore account zkapp_state / action_state /
  verification_key_hash from the most recent surviving account_activity
  snapshot.

  Background:
    Given the indexer is consuming from "zeko.l2.transactions"
    And the indexer detects L2 rollbacks by hash chain continuity checking

  Scenario: Events emitted by an invalidated transaction are deleted
    Given tx "tx-1" (target_ledger_hash "hash-1") produced 3 zkapp_event records for "B62qContract"
    When an L2 hash chain break invalidates target_ledger_hash "hash-1"
    Then all 3 zkapp_event records with target_ledger_hash "hash-1" are deleted
    And no orphaned event records remain for "B62qContract"

  Scenario: Actions dispatched by an invalidated transaction are deleted
    Given tx "tx-1" (target_ledger_hash "hash-1") produced 2 zkapp_action records for "B62qContract"
    When an L2 hash chain break invalidates target_ledger_hash "hash-1"
    Then both zkapp_action records with target_ledger_hash "hash-1" are deleted

  Scenario: Surviving actions still form an intact chain after deletion
    Given "B62qContract" has actions with (before_action_state, action_state):
      | ("s0", "s1") with target_ledger_hash "hash-A" |
      | ("s1", "s2") with target_ledger_hash "hash-A" |
      | ("s2", "s3") with target_ledger_hash "hash-B" |
    When an L2 hash chain break invalidates target_ledger_hash "hash-B"
    Then the surviving actions have action_states "s1" and "s2"
    And the account's post-state action_state head is "s2"

  Scenario: zkApp state is reverted from account_activity snapshot
    Given account "B62qContract" has stored zkapp_state ["bbb", ...] from tx with target_ledger_hash "hash-1"
    And account_activity contains a prior row with zkapp_state ["aaa", ...] and target_ledger_hash "hash-0"
    When an L2 hash chain break invalidates target_ledger_hash "hash-1"
    Then the account "B62qContract" zkapp_state reverts to ["aaa", ...]
    And the account's action_state is restored from the same account_activity snapshot

  Scenario: Verification key hash reverts when its setting transaction is rolled back
    Given account "B62qContract" had verification_key_hash "vk-old" before target_ledger_hash "hash-1"
    And tx with target_ledger_hash "hash-1" set verification_key_hash to "vk-new"
    When an L2 hash chain break invalidates target_ledger_hash "hash-1"
    Then the account "B62qContract" verification_key_hash reverts to "vk-old"

  Scenario: Rollback affecting multiple accounts reverts all of them
    Given tx "tx-multi" (target_ledger_hash "hash-M") changed "B62qContractA" and "B62qContractB"
    And tx "tx-multi" emitted events from both accounts
    When an L2 hash chain break invalidates target_ledger_hash "hash-M"
    Then "B62qContractA" state reverts from its account_activity snapshot
    And "B62qContractB" state reverts from its account_activity snapshot
    And all events and actions from "B62qContractA" and "B62qContractB" with target_ledger_hash "hash-M" are deleted

  Scenario: zkApp state re-progresses after rollback and new transaction
    Given "B62qContract" had state ["aaa", ...] rolled back from ["bbb", ...]
    When a new transaction arrives updating state to ["ccc", ...]
    Then account "B62qContract" has zkapp_state ["ccc", ...]
    And a new account_activity row is written for the new target_ledger_hash
    And the new event and action records for the replacement transaction are stored

  Scenario: Accounts not touched by the rolled-back transaction are unaffected
    Given tx "tx-partial" (target_ledger_hash "hash-P") only changed "B62qContractA"
    And "B62qContractB" was not in tx "tx-partial" changed_accounts
    When an L2 hash chain break invalidates target_ledger_hash "hash-P"
    Then "B62qContractA" state reverts
    And "B62qContractB" state is unchanged

  Scenario: Events and actions are not preserved as "rolled_back" records
    Given tx "tx-1" produced events and actions for "B62qContract"
    When an L2 hash chain break invalidates tx "tx-1"
    Then the zkapp_event and zkapp_action records are deleted outright
    And no record with a "rolled_back" status remains
    And the audit trail of the revert lives on account_activity
