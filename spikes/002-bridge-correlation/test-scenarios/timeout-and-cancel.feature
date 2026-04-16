Feature: Deposit Timeout and Cancellation

  Deposits have a timeout slot. If the deposit is not finalized on L2
  before the timeout, the user can cancel and reclaim their funds on L1.
  Cancel deposit does not produce an on-chain witness action — it is
  detected via L1 transaction observation only.

  Background:
    Given the bridge indexer is running

  Scenario Outline: Deposit times out when slot passes timeout
    Given a deposit exists with status "<status>" and timeout slot 500
    When the current L1 slot reaches 501
    Then the deposit status is "timed_out"

    Examples:
      | status       |
      | submitted    |
      | l1_witnessed |
      | committed    |

  Scenario: Completed deposit does not time out
    Given a deposit exists with status "completed" and timeout slot 500
    When the current L1 slot reaches 600
    Then the deposit status remains "completed"

  Scenario: Cancel deposit transitions timed-out deposit to CANCELLED
    Given a deposit exists with status "timed_out" and correlation key "cancelAux"
    When a deposit cancellation is detected on L1 for correlation key "cancelAux"
    Then the deposit status is "cancelled"

  Scenario: Cancel with collision uses FIFO position
    Given two deposits exist with the same correlation key, both timed out
    When a cancellation is detected for that correlation key
    Then the deposit with sequence 0 is cancelled
    And the deposit with sequence 1 remains timed out

  Scenario: Withdrawals have no timeout
    Given a withdrawal exists with status "submitted"
    Then no timeout check applies to the withdrawal
