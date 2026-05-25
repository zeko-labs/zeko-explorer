Feature: Bridge operation projection
  The indexer consumes the PRD bridge subjects and materializes WEB-426
  bridge_operation, outer_action, inner_action, and graph-link rows.

  Scenario: Deposit submission is recorded from L1 bridge events
    When the indexer consumes a deposit submission for aux "aux-deposit-1"
    Then bridge operation for aux "aux-deposit-1" sequence 0 has type "deposit"
    And bridge operation for aux "aux-deposit-1" sequence 0 has status "submitted"
    And bridge operation for aux "aux-deposit-1" sequence 0 has sender "B62qUser"
    And bridge operation for aux "aux-deposit-1" sequence 0 has amount "1000000000"

  Scenario: Deposit lifecycle correlates L1 and L2 actions
    Given the indexer consumed a deposit submission for aux "aux-deposit-2"
    When the indexer consumes an L1 witness for aux "aux-deposit-2"
    And the indexer consumes an L2 inner action for aux "aux-deposit-2" with action state "inner-state-2"
    And the indexer consumes an L1 commit covering inner action state "inner-state-2"
    Then bridge operation for aux "aux-deposit-2" sequence 0 has status "completed"
    And one L1 witness link exists for aux "aux-deposit-2"
    And one L1 commit link exists for aux "aux-deposit-2"
    And one L2 "mint" link exists for aux "aux-deposit-2"

  Scenario: Repeated deposits with the same aux keep FIFO identity
    When the indexer consumes a deposit submission for aux "aux-shared"
    And the indexer consumes another deposit submission for aux "aux-shared"
    And the indexer consumes an L1 witness for aux "aux-shared"
    Then bridge operation for aux "aux-shared" sequence 0 has status "l1_witnessed"
    And bridge operation for aux "aux-shared" sequence 1 has status "submitted"

  Scenario: Out-of-order deposit submission enriches existing witness evidence
    Given the indexer consumed an L1 witness for aux "aux-out-of-order"
    When the indexer consumes a deposit submission for aux "aux-out-of-order"
    Then bridge operation for aux "aux-out-of-order" sequence 0 has status "l1_witnessed"
    And bridge operation for aux "aux-out-of-order" sequence 0 has sender "B62qUser"

  Scenario: Deposit cancellation updates the matching operation
    Given the indexer consumed a deposit submission for aux "aux-cancel"
    When the indexer consumes a deposit cancellation for aux "aux-cancel"
    Then bridge operation for aux "aux-cancel" sequence 0 has status "cancelled"
    And bridge operation for aux "aux-cancel" sequence 0 has cancel tx hash "l1-cancel-aux-cancel"

  Scenario: Deposit cancellation uses the cancelled deposit index
    Given the indexer consumed a deposit submission for aux "aux-cancel-index"
    And the indexer consumed another deposit submission for aux "aux-cancel-index"
    When the indexer consumes a deposit cancellation for aux "aux-cancel-index" sequence 1
    Then bridge operation for aux "aux-cancel-index" sequence 0 has status "submitted"
    And bridge operation for aux "aux-cancel-index" sequence 1 has status "cancelled"

  Scenario: Withdrawal lifecycle uses L2 inner actions, commits, delay, and L1 witnesses
    Given the indexer consumed an L2 inner action for aux "aux-withdrawal" with action state "inner-withdrawal"
    When the indexer consumes an L1 commit covering inner action state "inner-withdrawal"
    And the indexer observes L1 slot 231
    And the indexer consumes an L1 witness for aux "aux-withdrawal"
    Then bridge operation for aux "aux-withdrawal" sequence 0 has type "withdrawal"
    And bridge operation for aux "aux-withdrawal" sequence 0 has status "completed"

  Scenario: Out-of-order withdrawal finalization is enriched by the L2 burn
    Given the indexer consumed an L1 withdrawal finalization for aux "aux-withdrawal-out-of-order"
    When the indexer consumes an L2 inner action for aux "aux-withdrawal-out-of-order" with action state "inner-withdrawal-out-of-order"
    Then bridge operation for aux "aux-withdrawal-out-of-order" sequence 0 has status "completed"
    And bridge operation for aux "aux-withdrawal-out-of-order" sequence 0 has submit tx hash "tx-inner-withdrawal-out-of-order"
    And bridge operation for aux "aux-withdrawal-out-of-order" sequence 0 has sender "B62qUser"
    And bridge operation for aux "aux-withdrawal-out-of-order" sequence 0 has amount "1000000000"

  Scenario: L1 rollback invalidating a witness recalculates bridge status
    Given the indexer consumed a deposit submission for aux "aux-rollback"
    And the indexer consumed an L1 witness for aux "aux-rollback"
    When the indexer consumes an L1 rollback affecting outer action "outer-witness-aux-rollback"
    Then bridge operation for aux "aux-rollback" sequence 0 has status "submitted"
