Feature: Idempotent writes through natural unique keys

  Background:
    Given the consolidated schema is applied
    And the explorer fixture is indexed

  Scenario: Transaction hash prevents duplicate at-least-once NATS writes
    When I try to insert another transaction with hash "tx-005"
    Then the write should fail because of a unique index

  Scenario: Bridge aux sequence prevents duplicate correlation records
    When I try to insert another bridge operation with aux "aux-shared" and sequence 0
    Then the write should fail because of a unique index
