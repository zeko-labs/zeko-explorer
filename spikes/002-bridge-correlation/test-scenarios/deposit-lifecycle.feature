Feature: Deposit Lifecycle

  The bridge indexer tracks deposits through their full lifecycle by
  correlating events from L1 and L2 chains. Each deposit progresses
  through: SUBMITTED -> L1_WITNESSED -> COMMITTED -> COMPLETED.

  Background:
    Given the bridge indexer is running

  Scenario: Deposit submission is recorded when detected on L1
    When a deposit submission is detected on L1 from user "B62qUser" with:
      | amount      | 1000000000    |
      | recipient   | B62qRecipient |
      | timeout     | 500           |
    Then a deposit operation exists for user "B62qUser"
    And the deposit has status "submitted"
    And the deposit has amount "1000000000" and recipient "B62qRecipient"

  Scenario: L1 witness proof advances deposit to L1_WITNESSED
    Given a deposit exists with status "submitted" and correlation key "abc123"
    When an L1 witness proof is recorded for correlation key "abc123"
    Then the deposit status is "l1_witnessed"

  Scenario: Batch commit advances deposit to COMMITTED
    Given a deposit exists with status "l1_witnessed" and correlation key "abc123"
    And an L2 action exists for correlation key "abc123"
    When a batch commit is recorded that covers the L2 action for "abc123"
    Then the deposit status is "committed"

  Scenario: L2 finalization completes the deposit
    Given a deposit exists with status "committed" and correlation key "abc123"
    When an L2 finalization is recorded for correlation key "abc123"
    Then the deposit status is "completed"

  Scenario: Full deposit lifecycle end-to-end
    When the following events arrive in order:
      | event                                              |
      | deposit submission from "B62qUser" with aux abc123 |
      | L1 witness proof for aux abc123                    |
      | batch commit covering aux abc123                   |
      | L2 finalization for aux abc123                     |
    Then the deposit transitions through: submitted -> l1_witnessed -> committed -> completed
    And the deposit is queryable by user "B62qUser"

  Scenario: Events arriving out of order still produce correct state
    Given an L1 witness proof is recorded for correlation key "abc123" with no prior deposit
    When a deposit submission arrives for correlation key "abc123" from user "B62qUser"
    Then the deposit status is "l1_witnessed"
    And the deposit has sender "B62qUser"
