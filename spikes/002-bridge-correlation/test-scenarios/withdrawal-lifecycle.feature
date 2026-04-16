Feature: Withdrawal Lifecycle

  The bridge indexer tracks withdrawals through their full lifecycle by
  correlating L2 burn actions with L1 settlement and finalization.
  Each withdrawal progresses through:
  SUBMITTED -> COMMITTED -> DELAY_PASSED -> COMPLETED.

  Background:
    Given the bridge indexer is running

  Scenario: Withdrawal submission is recorded from L2 burn action
    When a withdrawal is submitted on L2 by user "B62qUser" with:
      | amount    | 500000000     |
      | recipient | B62qRecipient |
    Then a withdrawal operation exists for user "B62qUser"
    And the withdrawal has status "submitted"
    And the withdrawal has amount "500000000" and recipient "B62qRecipient"

  Scenario: Batch commit advances withdrawal to COMMITTED
    Given a withdrawal exists with status "submitted" and correlation key "wAux456"
    When a batch commit is recorded that covers the L2 action for "wAux456"
    Then the withdrawal status is "committed"

  Scenario: Delay period elapsed advances withdrawal to DELAY_PASSED
    Given a withdrawal exists with status "committed"
    And the covering commit has slot range upper bound 200
    And the withdrawal delay is 100 slots
    When the current L1 slot reaches 301
    Then the withdrawal status is "delay_passed"

  Scenario: L1 finalization witness completes the withdrawal
    Given a withdrawal exists with status "delay_passed" and correlation key "wAux456"
    When an L1 witness proof is recorded for correlation key "wAux456"
    Then the withdrawal status is "completed"

  Scenario: Full withdrawal lifecycle end-to-end
    When the following events arrive in order:
      | event                                                       |
      | withdrawal submission from "B62qUser" with aux wAux456      |
      | batch commit covering aux wAux456 with slot range upper 200 |
      | L1 slot advances past 300 (delay elapsed)                   |
      | L1 witness proof for aux wAux456                            |
    Then the withdrawal transitions through: submitted -> committed -> delay_passed -> completed
    And the withdrawal is queryable by user "B62qUser"
