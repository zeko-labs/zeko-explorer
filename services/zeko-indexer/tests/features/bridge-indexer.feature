Feature: Bridge operation projection
  The indexer consumes the PRD bridge subjects and materializes
  bridge_operation, outer_action, inner_action, and graph-link rows.

  Scenario: Deposit submission is recorded from L1 bridge events
    When the indexer consumes a deposit submission for aux "aux-deposit-1"
    Then bridge operation for aux "aux-deposit-1" sequence 0 has type "deposit"
    And bridge operation for aux "aux-deposit-1" sequence 0 has status "submitted"
    And bridge operation for aux "aux-deposit-1" sequence 0 has sender "B62qUser"
    And bridge operation for aux "aux-deposit-1" sequence 0 has amount "1000000000"

  Scenario: Replayed deposit submissions derive stable bridge operation IDs
    When two fresh indexers consume the same deposit submission for aux "aux-replayed-id"
    Then the replayed bridge operation IDs match

  Scenario: Deposit lifecycle correlates L1 and L2 actions
    Given the indexer consumed a deposit submission for aux "aux-deposit-2"
    When the indexer consumes an L1 witness for aux "aux-deposit-2"
    And the indexer consumes an L2 inner action for aux "aux-deposit-2" with action state "inner-state-2"
    And the indexer consumes an L1 commit covering inner action state "inner-state-2"
    Then bridge operation for aux "aux-deposit-2" sequence 0 has status "completed"
    And bridge operation for aux "aux-deposit-2" sequence 0 has search text containing "completed"
    And one L1 witness link exists for aux "aux-deposit-2"
    And one L1 commit link exists for aux "aux-deposit-2"
    And one L2 "mint" link exists for aux "aux-deposit-2"

  Scenario: Deposit L2 finalization waits for commit evidence
    Given the indexer consumed a deposit submission for aux "aux-deposit-waits-commit"
    And the indexer consumed an L1 witness for aux "aux-deposit-waits-commit"
    When the indexer consumes an L2 inner action for aux "aux-deposit-waits-commit" with action state "inner-waits-commit"
    Then bridge operation for aux "aux-deposit-waits-commit" sequence 0 has status "l1_witnessed"

  Scenario: Deposit commit waits for L1 witness evidence
    Given the indexer consumed a deposit submission for aux "aux-deposit-waits-witness"
    And the indexer consumes an L2 inner action for aux "aux-deposit-waits-witness" with action state "inner-waits-witness"
    When the indexer consumed an L1 commit covering inner action state "inner-waits-witness"
    Then bridge operation for aux "aux-deposit-waits-witness" sequence 0 has status "submitted"

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

  Scenario: L2 withdrawal after rollback creates a fresh bridge operation
    Given the indexer consumed an L2 inner action for aux "aux-withdrawal-reinclude" with action state "inner-withdrawal-rolled-back"
    And the indexer consumes an L2 replacement from source ledger "ledger-0" to target ledger "ledger-withdrawal-replacement"
    When the indexer consumes an L2 inner action for aux "aux-withdrawal-reinclude" with action state "inner-withdrawal-reincluded"
    Then bridge operation for aux "aux-withdrawal-reinclude" sequence 0 has status "rolled_back"
    And bridge operation for aux "aux-withdrawal-reinclude" sequence 1 has status "l2_witnessed"

  Scenario: L1 witness skips rolled-back withdrawal operations
    Given the indexer consumed an L2 inner action for aux "aux-withdrawal-witness-reinclude" with action state "inner-withdrawal-witness-rolled-back"
    And the indexer consumes an L2 replacement from source ledger "ledger-0" to target ledger "ledger-withdrawal-witness-replacement"
    And the indexer consumes an L2 inner action for aux "aux-withdrawal-witness-reinclude" with action state "inner-withdrawal-witness-reincluded"
    When the indexer consumes an L1 witness for aux "aux-withdrawal-witness-reinclude"
    Then bridge operation for aux "aux-withdrawal-witness-reinclude" sequence 0 has status "rolled_back"
    And bridge operation for aux "aux-withdrawal-witness-reinclude" sequence 1 has status "completed"

  Scenario: L2 rollback of a completed withdrawal rolls back finalization evidence
    Given the indexer consumed an L2 inner action for aux "aux-completed-withdrawal-l2-rollback" with action state "inner-completed-withdrawal-l2-rollback"
    And the indexer consumed an L1 commit covering inner action state "inner-completed-withdrawal-l2-rollback"
    And the indexer observes L1 slot 231 for aux "aux-completed-withdrawal-l2-rollback"
    And the indexer consumes an L1 witness for aux "aux-completed-withdrawal-l2-rollback"
    When the indexer consumes an L2 replacement from source ledger "ledger-0" to target ledger "ledger-completed-withdrawal-replacement"
    Then bridge operation for aux "aux-completed-withdrawal-l2-rollback" sequence 0 has status "rolled_back"
    And bridge operation for aux "aux-completed-withdrawal-l2-rollback" sequence 0 has no L1 witness tx hash

  Scenario: Repeated deposits with the same aux keep FIFO identity
    When the indexer consumes a deposit submission for aux "aux-shared"
    And the indexer consumes another deposit submission for aux "aux-shared"
    And the indexer consumes an L1 witness for aux "aux-shared"
    Then bridge operation for aux "aux-shared" sequence 0 has status "l1_witnessed"
    And bridge operation for aux "aux-shared" sequence 1 has status "submitted"

  Scenario: Repeated deposits derive FIFO identity when producer action index resets
    When the indexer consumes a deposit submission for aux "aux-reset-index"
    And the indexer consumes another deposit submission for aux "aux-reset-index" with producer action index 0
    And the indexer consumes an L1 witness for aux "aux-reset-index"
    Then bridge operation for aux "aux-reset-index" sequence 0 has status "l1_witnessed"
    And bridge operation for aux "aux-reset-index" sequence 1 has status "submitted"

  Scenario: Out-of-order deposit submission enriches existing witness evidence
    Given the indexer consumed an L1 witness for aux "aux-out-of-order"
    When the indexer consumes a deposit submission for aux "aux-out-of-order"
    Then bridge operation for aux "aux-out-of-order" sequence 0 has status "l1_witnessed"
    And bridge operation for aux "aux-out-of-order" sequence 0 has sender "B62qUser"

  Scenario: Replayed L1 witness actions are idempotent
    Given the indexer consumed a deposit submission for aux "aux-replayed-witness"
    When the indexer consumes an L1 witness for aux "aux-replayed-witness"
    And the indexer replays the L1 witness for aux "aux-replayed-witness"
    Then exactly 1 bridge operation exists for aux "aux-replayed-witness"
    And one L1 witness link exists for aux "aux-replayed-witness"

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

  Scenario: Cancelled deposits do not accept later L1 witness evidence
    Given the indexer consumed a deposit submission for aux "aux-cancel-witness"
    And the indexer consumed a deposit cancellation for aux "aux-cancel-witness"
    When the indexer consumes an L1 witness for aux "aux-cancel-witness"
    Then bridge operation for aux "aux-cancel-witness" sequence 0 has status "cancelled"
    And bridge operation for aux "aux-cancel-witness" sequence 1 has status "l1_witnessed"

  Scenario: Cancelled deposits do not accept later L2 inner evidence
    Given the indexer consumed a deposit submission for aux "aux-cancel-inner"
    And the indexer consumed a deposit cancellation for aux "aux-cancel-inner"
    When the indexer consumes an L2 inner action for aux "aux-cancel-inner" with action state "inner-cancel-inner"
    Then bridge operation for aux "aux-cancel-inner" sequence 0 has status "cancelled"
    And bridge operation for aux "aux-cancel-inner" sequence 1 has type "withdrawal"
    And bridge operation for aux "aux-cancel-inner" sequence 1 has status "l2_witnessed"

  Scenario: L1 rollback of a deposit cancellation restores the deposit
    Given the indexer consumed a deposit submission for aux "aux-cancel-rollback"
    And the indexer consumed a deposit cancellation for aux "aux-cancel-rollback"
    When the indexer consumes an L1 rollback affecting bridge event "l1-cancel-aux-cancel-rollback-0"
    Then bridge operation for aux "aux-cancel-rollback" sequence 0 has status "submitted"
    And bridge operation for aux "aux-cancel-rollback" sequence 0 has no cancel tx hash

  Scenario: Settlement slots advance deposit timeouts
    Given the indexer consumed a deposit submission for aux "aux-settlement-timeout"
    When the indexer consumes an L1 settlement at slot 600
    Then bridge operation for aux "aux-settlement-timeout" sequence 0 has status "timed_out"

  Scenario: Timed-out deposits are not completed by late L2 evidence
    Given the indexer consumed a deposit submission for aux "aux-timeout-late-evidence"
    And the indexer consumes an L1 settlement at slot 600
    When the indexer consumes an L2 inner action for aux "aux-timeout-late-evidence" with action state "inner-timeout-late-evidence"
    Then bridge operation for aux "aux-timeout-late-evidence" sequence 0 has status "timed_out"

  Scenario: Timed-out deposits can still be cancelled
    Given the indexer consumed a deposit submission for aux "aux-timeout-cancel"
    And the indexer consumes an L1 settlement at slot 600
    When the indexer consumes a deposit cancellation for aux "aux-timeout-cancel"
    Then bridge operation for aux "aux-timeout-cancel" sequence 0 has status "cancelled"
    And bridge operation for aux "aux-timeout-cancel" sequence 0 has cancel tx hash "l1-cancel-aux-timeout-cancel"

  Scenario: Settlement slots advance withdrawal delay
    Given the indexer consumed an L2 inner action for aux "aux-settlement-delay" with action state "inner-settlement-delay"
    And the indexer consumed an L1 commit covering inner action state "inner-settlement-delay"
    When the indexer consumes an L1 settlement at slot 231
    Then bridge operation for aux "aux-settlement-delay" sequence 0 has status "delay_passed"

  Scenario: Withdrawal lifecycle uses L2 inner actions, commits, delay, and L1 witnesses
    Given the indexer consumed an L2 inner action for aux "aux-withdrawal" with action state "inner-withdrawal"
    When the indexer consumes an L1 commit covering inner action state "inner-withdrawal"
    And the indexer observes L1 slot 231
    And the indexer consumes an L1 witness for aux "aux-withdrawal"
    Then bridge operation for aux "aux-withdrawal" sequence 0 has type "withdrawal"
    And bridge operation for aux "aux-withdrawal" sequence 0 has status "completed"

  Scenario: L1 rollback of a withdrawal witness preserves elapsed delay
    Given the indexer consumed an L2 inner action for aux "aux-withdrawal-delay-rollback" with action state "inner-withdrawal-delay-rollback"
    And the indexer consumed an L1 commit covering inner action state "inner-withdrawal-delay-rollback"
    And the indexer observes L1 slot 231 for aux "aux-withdrawal-delay-rollback"
    And the indexer consumes an L1 witness for aux "aux-withdrawal-delay-rollback"
    When the indexer consumes an L1 rollback affecting outer action "outer-witness-aux-withdrawal-delay-rollback"
    Then bridge operation for aux "aux-withdrawal-delay-rollback" sequence 0 has status "delay_passed"

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

  Scenario: Out-of-order withdrawal finalization does not invent an L2 submit
    When the indexer consumed an L1 withdrawal finalization for aux "aux-withdrawal-no-submit"
    Then bridge operation for aux "aux-withdrawal-no-submit" sequence 0 has status "completed"
    And bridge operation for aux "aux-withdrawal-no-submit" sequence 0 has no submit tx hash

  Scenario: Withdrawal finalization enriches an already witnessed withdrawal
    Given the indexer consumed an L2 inner action for aux "aux-withdrawal-witness-first" with action state "inner-withdrawal-witness-first"
    And the indexer consumes an L1 witness for aux "aux-withdrawal-witness-first"
    When the indexer consumed an L1 withdrawal finalization for aux "aux-withdrawal-witness-first"
    Then exactly 1 bridge operation exists for aux "aux-withdrawal-witness-first"
    And bridge operation for aux "aux-withdrawal-witness-first" sequence 0 has status "completed"
    And bridge operation for aux "aux-withdrawal-witness-first" sequence 0 has submit tx hash "tx-inner-withdrawal-witness-first"

  Scenario: L1 rollback of a withdrawal finalization keeps L2 withdrawal evidence
    Given the indexer consumed an L2 inner action for aux "aux-withdrawal-finalization-rollback" with action state "inner-withdrawal-finalization-rollback"
    And the indexer consumed an L1 withdrawal finalization for aux "aux-withdrawal-finalization-rollback"
    When the indexer consumes an L1 rollback affecting bridge event "l1-withdrawal-finalized-aux-withdrawal-finalization-rollback"
    Then bridge operation for aux "aux-withdrawal-finalization-rollback" sequence 0 has status "l2_witnessed"
    And bridge operation for aux "aux-withdrawal-finalization-rollback" sequence 0 has no L1 witness tx hash

  Scenario: L1 rollback invalidating a witness recalculates bridge status
    Given the indexer consumed a deposit submission for aux "aux-rollback"
    And the indexer consumed an L1 witness for aux "aux-rollback"
    When the indexer consumes an L1 rollback affecting outer action "outer-witness-aux-rollback"
    Then bridge operation for aux "aux-rollback" sequence 0 has status "submitted"
    And no L1 witness link exists for aux "aux-rollback"

  Scenario: L1 rollback invalidating a deposit commit keeps L2 evidence uncompleted
    Given the indexer consumed a deposit submission for aux "aux-commit-rollback"
    And the indexer consumed an L1 witness for aux "aux-commit-rollback"
    And the indexer consumes an L2 inner action for aux "aux-commit-rollback" with action state "inner-commit-rollback"
    And the indexer consumed an L1 commit covering inner action state "inner-commit-rollback"
    When the indexer consumes an L1 rollback affecting outer action "outer-commit-inner-commit-rollback"
    Then bridge operation for aux "aux-commit-rollback" sequence 0 has status "l1_witnessed"
    And no L1 commit link exists for aux "aux-commit-rollback"

  Scenario: L1 rollback does not downgrade unrelated clock-derived bridge status
    Given the indexer consumed a deposit submission for aux "aux-timed-out"
    And the indexer consumed a deposit submission for aux "aux-rollback-unrelated"
    And the indexer consumed an L1 witness for aux "aux-rollback-unrelated"
    And the indexer observes L1 slot 600
    When the indexer consumes an L1 rollback affecting outer action "outer-witness-aux-rollback-unrelated"
    Then bridge operation for aux "aux-timed-out" sequence 0 has status "timed_out"
    And bridge operation for aux "aux-rollback-unrelated" sequence 0 has status "timed_out"
