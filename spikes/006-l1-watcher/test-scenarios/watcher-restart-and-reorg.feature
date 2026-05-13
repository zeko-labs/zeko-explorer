Feature: L1 Watcher Restart and Reorganization Recovery

  The watcher should recover from process restarts using persisted cursors
  and the persisted canonical block window. Restarts must not create gaps
  or duplicate durable L1 facts.

  Background:
    Given NATS JetStream is available
    And SurrealDB is available
    And the hosted Mina daemon is available
    And Archive-Node-API is available

  Scenario: Watcher restart resumes from durable cursors
    Given the L1 watcher stopped after publishing through L1 height 3000
    And the durable bridge event cursor is L1 height 3000
    And bridge events exist at L1 heights 3001 through 3010
    When the L1 watcher starts again
    Then the watcher scans bridge events from L1 height 3001
    And publishes bridge events for heights 3001 through 3010 in order
    And does not republish already acknowledged events before L1 height 3001

  Scenario: Watcher restart reconciles a shallow L1 reorganization
    Given the persisted canonical window contains block state hashes "A" through "F"
    And the daemon best chain now contains block state hashes "A" through "D" and "X" and "Y"
    And L1 facts were published from orphaned block state hashes "E" and "F"
    When the L1 watcher starts again
    Then the watcher publishes one rollback event for facts from "E" and "F"
    And processes replacement blocks "X" and "Y"
    And keeps the watcher process alive

  Scenario: Watcher restart with no common daemon ancestor reports degraded recovery
    Given the persisted canonical window contains block state hashes "A" through "F"
    And the daemon best chain contains no common state hash with the persisted window
    When the L1 watcher starts again
    Then the watcher keeps running
    And health reports rollback reconciliation as degraded
    And archive-backed outer actions are reconciled from durable cursors
    And bridge event recovery depends on historical zkApp command availability

  Scenario: Helper cancel counter mismatch triggers bounded rescan
    Given helperAccountL1 cancellation counter is 10 in SurrealDB
    And the hosted Mina daemon reports helperAccountL1 cancellation counter 12
    And only one matching cancel bridge event was published
    When the helper counter verifier runs
    Then health includes limitation "helper_cancel_counter_unreconciled"
    And the watcher rescans recent L1 blocks for missing cancel transactions
    And unrelated settlement and outer action loops continue
