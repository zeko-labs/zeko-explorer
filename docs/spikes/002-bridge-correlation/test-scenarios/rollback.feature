Feature: Chain Rollback Handling

  The bridge indexer must handle reorganizations on both L1 (fork events)
  and L2 (hash chain breaks). When actions are invalidated by a rollback,
  affected bridge operations revert to their previous status based on
  remaining data.

  Background:
    Given the bridge indexer is running

  # L1 fork rollbacks

  Scenario: L1 fork invalidating witness reverts deposit to SUBMITTED
    Given a deposit exists with status "l1_witnessed"
    When an L1 fork invalidates the witness action
    Then the deposit reverts to status "submitted"

  Scenario: L1 fork invalidating commit reverts deposit to L1_WITNESSED
    Given a deposit exists with status "committed"
    And the deposit has a valid witness action
    When an L1 fork invalidates the commit action but not the witness
    Then the deposit reverts to status "l1_witnessed"

  Scenario: L1 fork invalidating both witness and commit reverts deposit to SUBMITTED
    Given a deposit exists with status "committed"
    When an L1 fork invalidates both the witness and commit actions
    Then the deposit reverts to status "submitted"

  Scenario: L1 fork invalidating withdrawal finalization witness reverts to DELAY_PASSED
    Given a withdrawal exists with status "completed"
    When an L1 fork invalidates the finalization witness action
    Then the withdrawal reverts to status "delay_passed"

  Scenario: L1 fork invalidating withdrawal commit reverts to SUBMITTED
    Given a withdrawal exists with status "committed"
    When an L1 fork invalidates the commit action
    Then the withdrawal reverts to status "submitted"

  # L2 hash chain break rollbacks

  Scenario: L2 rollback reverts completed deposit
    Given a deposit exists with status "completed"
    When an L2 hash chain break invalidates the finalization action
    Then the deposit reverts to its previous status based on remaining L1 data

  Scenario: L2 rollback removes withdrawal with no remaining data
    Given a withdrawal exists with status "submitted"
    And the withdrawal has no L1 actions yet
    When an L2 hash chain break invalidates the submission action
    Then the withdrawal operation is removed

  Scenario: Rollback affecting multiple operations recalculates all
    Given three bridge operations are linked to L2 actions in a contiguous range
    When an L2 hash chain break invalidates that range
    Then all three operations have their status recalculated

  # Re-progression after rollback

  Scenario: Bridge operation re-progresses after rollback and new settlement
    Given a deposit was rolled back from "committed" to "l1_witnessed"
    When a new batch commit arrives covering the same deposit
    Then the deposit advances back to "committed"
