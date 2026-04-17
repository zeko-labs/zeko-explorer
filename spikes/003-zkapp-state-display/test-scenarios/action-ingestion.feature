Feature: zkApp Action Ingestion

  Actions are structurally similar to events but carry an action_state — a
  rolling hash commitment that tracks the accumulation of all dispatched
  actions for a given account. The indexer stores both the raw field array
  and the action_state hash after each action is applied.

  Background:
    Given the indexer is consuming from "zeko.l2.transactions"

  Scenario: Single action is stored from a zkApp account_update
    When a NATS message arrives with a zkApp command
    And the account_update for "B62qContract" contains one action:
      | field_index | value   |
      | 0           | 42      |
    Then one zkapp_action record exists for "B62qContract" in this transaction
    And the action has fields ["42"]
    And the action has a non-null action_state hash
    And the action is linked to the correct transaction

  Scenario: Multiple actions from the same account_update are all stored
    When a NATS message arrives with a zkApp command
    And the account_update for "B62qContract" contains three actions
    Then three zkapp_action records exist for "B62qContract" in this transaction
    And each action has a distinct action_index (0, 1, 2)
    And each action has an action_state reflecting the accumulated hash up to that action

  Scenario: Action states form a rolling chain per account
    Given "B62qContract" has a prior action with action_state "hash-N"
    When a NATS message arrives with one new action for "B62qContract"
    Then the new action's action_state is derived from "hash-N" and the new action fields
    And the new action_state differs from "hash-N"

  Scenario: Action ID is deterministic based on tx hash, account, and action index
    Given a zkapp_action was stored for tx "txABC" from account "B62qContract" at action_index 0
    When the same NATS message is re-processed (deduplication replay)
    Then no duplicate action record is created
    And the action ID remains "txABC:B62qContract:0"

  Scenario: Actions are queryable by action_state hash
    Given a zkapp_action exists for "B62qContract" with action_state "specific-hash-xyz"
    When querying actions with action_state "specific-hash-xyz"
    Then the query returns that action
    And the result includes the emitting account and transaction links

  Scenario: Actions are queryable by emitting account in sequence order
    Given five zkapp_action records exist for account "B62qContract"
    When querying actions for "B62qContract" ordered by sequence_number
    Then the actions are returned in ascending sequence order

  Scenario: Account_update with empty actions list creates no action records
    When a NATS message arrives with a zkApp command
    And the account_update for "B62qContract" has an empty actions array
    Then no zkapp_action records exist for "B62qContract" in this transaction
