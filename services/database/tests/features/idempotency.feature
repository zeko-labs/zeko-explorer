Feature: Idempotent writes through natural unique keys

  Background:
    Given the consolidated schema is applied
    And the explorer fixture is indexed

  Scenario: Transaction hash and target ledger prevent duplicate at-least-once NATS writes
    When I try to insert another transaction with hash "tx-005" on target ledger "ledger-105"
    Then the write should fail because of a unique index

  Scenario: Re-included transaction hashes can use a different target ledger
    When I insert another transaction with hash "tx-005" on target ledger "ledger-reincluded"
    Then transaction hash "tx-005" should have 2 rows

  Scenario: Bridge aux sequence prevents duplicate correlation records
    When I try to insert another bridge operation with aux "aux-shared" and sequence 0
    Then the write should fail because of a unique index

  Scenario: Token accounts share a public key without colliding
    When I insert token accounts for public key "B62qTokenHolder"
    Then both token account rows should exist for public key "B62qTokenHolder"
