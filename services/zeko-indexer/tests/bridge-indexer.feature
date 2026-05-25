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

  Scenario: Non-bridge zkApp actions are not projected as bridge operations
    When the indexer consumes a non-bridge zkApp action for aux "aux-not-bridge"
    Then no bridge operation exists for aux "aux-not-bridge"

  Scenario: Late L2 inner actions replay previously indexed commits
    Given the indexer consumed a deposit submission for aux "aux-late-inner"
    And the indexer consumed an L1 witness for aux "aux-late-inner"
    And the indexer consumed an L1 commit covering inner action state "inner-late"
    When the indexer consumes an L2 inner action for aux "aux-late-inner" with action state "inner-late"
    Then bridge operation for aux "aux-late-inner" sequence 0 has status "completed"
    And one L1 commit link exists for aux "aux-late-inner"

  Scenario: L2 rollback removes derived bridge inner evidence
    Given the indexer consumed a deposit submission for aux "aux-l2-rollback"
    And the indexer consumed an L1 witness for aux "aux-l2-rollback"
    And the indexer consumed an L2 inner action for aux "aux-l2-rollback" with action state "inner-l2-rollback"
    And the indexer consumed an L1 commit covering inner action state "inner-l2-rollback"
    When the indexer consumes an L2 replacement from source ledger "ledger-0" to target ledger "ledger-l2-replacement"
    Then bridge operation for aux "aux-l2-rollback" sequence 0 has status "l1_witnessed"
    And no L2 links exist for aux "aux-l2-rollback"
    And no L1 commit link exists for aux "aux-l2-rollback"

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

  Scenario: Withdrawal inner action is exposed as L2 witnessed before commit
    When the indexer consumes an L2 inner action for aux "aux-withdrawal-l2-witnessed" with action state "inner-withdrawal-l2-witnessed"
    Then bridge operation for aux "aux-withdrawal-l2-witnessed" sequence 0 has status "l2_witnessed"

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
    And no L1 witness link exists for aux "aux-rollback"

  Scenario: L1 rollback does not downgrade unrelated clock-derived bridge status
    Given the indexer consumed a deposit submission for aux "aux-timed-out"
    And the indexer consumed a deposit submission for aux "aux-rollback-unrelated"
    And the indexer consumed an L1 witness for aux "aux-rollback-unrelated"
    And the indexer observes L1 slot 600
    When the indexer consumes an L1 rollback affecting outer action "outer-witness-aux-rollback-unrelated"
    Then bridge operation for aux "aux-timed-out" sequence 0 has status "timed_out"
    And bridge operation for aux "aux-rollback-unrelated" sequence 0 has status "submitted"
