Feature: zkApp State Rollback on L2 Reorganization

  When the L2 chain reorgs, transactions at the rolled-back height are
  invalidated. The indexer must revert zkapp_state on affected accounts
  to the value from the last valid transaction, and remove zkapp_event
  and zkapp_action records associated with invalidated transactions.

  Note: This area was not addressed in the original spike — these scenarios
  define expected behavior to resolve the gap before implementation.

  Background:
    Given the indexer is consuming from "zeko.l2.transactions"
    And the indexer receives L2 rollback signals when chain hash continuity breaks

  Scenario: zkApp state is reverted on L2 rollback
    Given account "B62qContract" had zkapp_state ["aaa", ...] before tx "tx-1"
    And tx "tx-1" updated zkapp_state to ["bbb", ...]
    When an L2 rollback invalidates tx "tx-1"
    Then the account "B62qContract" zkapp_state reverts to ["aaa", ...]

  Scenario: Events emitted by an invalidated transaction are removed
    Given tx "tx-1" produced 3 zkapp_event records for "B62qContract"
    When an L2 rollback invalidates tx "tx-1"
    Then all 3 zkapp_event records for tx "tx-1" are removed
    And no orphaned event records remain for "B62qContract"

  Scenario: Actions dispatched by an invalidated transaction are removed
    Given tx "tx-1" produced 2 zkapp_action records for "B62qContract"
    When an L2 rollback invalidates tx "tx-1"
    Then both zkapp_action records for tx "tx-1" are removed

  Scenario: Action state is recalculated after rollback removes an action
    Given "B62qContract" has actions with action_states: ["hash-1", "hash-2", "hash-3"]
    And the third action (action_state "hash-3") is from an invalidated transaction
    When an L2 rollback invalidates the transaction containing "hash-3"
    Then the most recent action_state for "B62qContract" is "hash-2"

  Scenario: Rollback affecting multiple accounts reverts all of them
    Given tx "tx-multi" updated zkapp_state for "B62qContractA" and "B62qContractB"
    And tx "tx-multi" emitted events from both accounts
    When an L2 rollback invalidates tx "tx-multi"
    Then "B62qContractA" state reverts to its pre-tx value
    And "B62qContractB" state reverts to its pre-tx value
    And all events from "B62qContractA" and "B62qContractB" for tx "tx-multi" are removed

  Scenario: zkApp state re-progresses after rollback and new transaction
    Given "B62qContract" had state ["aaa", ...] rolled back from ["bbb", ...]
    When a new transaction arrives updating state to ["ccc", ...]
    Then account "B62qContract" has zkapp_state ["ccc", ...]
    And the new event and action records for the replacement transaction are stored

  Scenario: Accounts with no state change in rolled-back tx are unaffected
    Given tx "tx-partial" only updated "B62qContractA" state
    And "B62qContractB" was not changed by tx "tx-partial"
    When an L2 rollback invalidates tx "tx-partial"
    Then "B62qContractA" state reverts
    And "B62qContractB" state is unchanged
