Feature: Milestone 1 — DA status under rollback and replay

  The DA-attestation fact survives L1 rollbacks (the data was made available
  regardless of what happened on L1) and is idempotent under NATS message
  replay.

  Background:
    Given the indexer is running and connected to NATS JetStream
    And the indexer is connected to SurrealDB

  Scenario: L1 rollback preserves the attestation fact for re-binding
    Given a batch row in SurrealDB has da_status "attested" and da_source "settlement" for "L1"
    When the indexer consumes a "zeko.l1.rollbacks" message that affects the batch for "L1"
    Then the SurrealDB batch row for "L1" is reverted
    And a row in "pending_da_attestation" exists with ledger_hash "L1" and source "settlement"
    When the indexer later consumes a new "zeko.l1.settlements" message for "L1"
    Then the SurrealDB batch row for "L1" has da_status "attested"
    And no row in "pending_da_attestation" remains for ledger_hash "L1"

  Scenario: Duplicate proved finality message is idempotent
    Given a batch row in SurrealDB has da_status "attested" and da_source "proved" for "L2"
    When the indexer consumes a duplicate "zeko.l2.finality" proved message for "L2"
    Then the SurrealDB batch row for "L2" is unchanged

  Scenario: Duplicate settlement message is idempotent
    Given a batch row in SurrealDB has da_status "attested" and da_source "settlement" for "L3"
    When the indexer consumes a duplicate "zeko.l1.settlements" message for "L3"
    Then the SurrealDB batch row for "L3" is unchanged

  Scenario: Pending attestation rows are pruned by max age
    Given a row in "pending_da_attestation" has been waiting 30 days for ledger_hash "L4"
    When the indexer's pending-attestation pruner runs
    Then no row in "pending_da_attestation" remains for ledger_hash "L4"
