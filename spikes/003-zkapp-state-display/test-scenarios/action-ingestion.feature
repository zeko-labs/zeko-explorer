Feature: zkApp Action Ingestion

  Actions are structurally similar to events but carry an action_state — a
  rolling Poseidon hash commitment that tracks accumulated actions per
  account. The indexer stores each action with before_action_state and
  after_action_state (= action_state) forming a verifiable chain, and
  cross-checks the computed post-state against the account's on-chain
  action_state[0] vector head.

  Background:
    Given the indexer is consuming from "zeko.l2.transactions"

  Scenario: Single action is stored from a zkApp account_update
    Given account "B62qContract" has prior action_state head "prev-hash"
    When a NATS message arrives with a zkApp command
    And the account_update for "B62qContract" contains one action:
      | field_index | value |
      | 0           | 42    |
    Then one zkapp_action record exists for "B62qContract" in this transaction
    And the action has fields ["42"]
    And the action has before_action_state "prev-hash"
    And the action has action_state equal to Poseidon.hash(["prev-hash", actions_commitment_of(["42"])])
    And the action is linked to the correct transaction

  Scenario: Multiple actions from the same account_update chain through action_state
    Given account "B62qContract" has prior action_state head "s0"
    When a NATS message arrives with a zkApp command
    And the account_update for "B62qContract" contains three actions with fields ["A"], ["B"], ["C"]
    Then three zkapp_action records exist for "B62qContract" in this transaction
    And action 0 has before_action_state "s0" and action_state "s1"
    And action 1 has before_action_state "s1" and action_state "s2"
    And action 2 has before_action_state "s2" and action_state "s3"
    And each action has a distinct action_index (0, 1, 2)

  Scenario: Post-state cross-check against changed_accounts.zkapp.action_state[0]
    Given account "B62qContract" has prior action_state head "s0"
    When a NATS message arrives with two new actions for "B62qContract"
    And changed_accounts[B62qContract].zkapp.action_state[0] equals "s2"
    Then the indexer's computed action_state for the last action equals "s2"
    And the write succeeds
    But if the indexer's computed action_state did not equal "s2"
    Then the indexer logs a consistency error and halts

  Scenario: Action state chain continues across transactions
    Given "B62qContract" has a prior action with action_state "hash-N"
    When a NATS message arrives with one new action for "B62qContract"
    Then the new action's before_action_state is "hash-N"
    And the new action's action_state is derived from "hash-N" and the new action fields
    And the new action_state differs from "hash-N"

  Scenario: Actions are queryable by action_state as a unique chain key
    Given a zkapp_action exists for "B62qContract" with action_state "specific-hash-xyz"
    When querying actions with action_state "specific-hash-xyz"
    Then the query returns exactly one action
    And the result includes the emitting account and transaction links

  Scenario: Actions are queryable by before_action_state for chain walks
    Given zkapp_actions exist with before_action_state "anchor-hash"
    When querying actions with before_action_state "anchor-hash"
    Then the next action in the chain is returned

  Scenario: Action ID is deterministic and re-processing is idempotent
    Given a zkapp_action was stored for tx "txABC" from "B62qContract" at action_index 0
    When the same NATS message is re-processed (deduplication replay)
    Then no duplicate action record is created
    And the action ID remains "txABC:B62qContract:0"

  Scenario: Actions are queryable by emitting account in sequence order
    Given five zkapp_action records exist for account "B62qContract"
    When querying actions for "B62qContract" ordered by sequence_number
    Then the actions are returned in ascending sequence order

  Scenario: Each action is tagged with target_ledger_hash for rollback
    When a NATS message with target_ledger_hash "hash-X" arrives
    And it contains an action for "B62qContract"
    Then the zkapp_action record has target_ledger_hash "hash-X"

  Scenario: Account_update with empty actions list creates no action records
    When a NATS message arrives with a zkApp command
    And the account_update for "B62qContract" has an empty actions array
    Then no zkapp_action records exist for "B62qContract" in this transaction
    And the account's action_state vector is unchanged
