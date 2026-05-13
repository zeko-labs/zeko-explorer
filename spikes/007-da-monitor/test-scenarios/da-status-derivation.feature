Feature: Baseline DA status derivation from existing NATS subjects

  The indexer derives batch.da_status from two NATS subjects it already consumes:
  zeko.l1.settlements (Path A, settlement-derived) and zeko.l2.finality with
  level "proved" (Path B, proved-derived). Existing batch rows keep the first
  attestation source observed; proved events that arrive before the batch row
  exists are buffered until settlement creates it.

  Background:
    Given the indexer is running and connected to NATS JetStream
    And the indexer is connected to SurrealDB

  Scenario: Settlement message marks the batch attested via Path A
    Given a batch row exists in SurrealDB with target_ledger_hash "L1"
    And that batch has da_status null
    When the indexer consumes a "zeko.l1.settlements" message for "L1"
    Then the SurrealDB batch row for "L1" has da_status "attested"
    And the SurrealDB batch row for "L1" has da_source "settlement"
    And the SurrealDB batch row for "L1" has da_attested_at equal to the settlement timestamp

  Scenario: Proved finality message marks the batch attested via Path B
    Given a batch row exists in SurrealDB with target_ledger_hash "L2"
    And that batch has da_status null
    When the indexer consumes a "zeko.l2.finality" message with level "proved" and ledger_hash "L2"
    Then the SurrealDB batch row for "L2" has da_status "attested"
    And the SurrealDB batch row for "L2" has da_source "proved"
    And the SurrealDB batch row for "L2" has da_attested_at equal to the finality timestamp

  Scenario: Proved finality before the batch row is buffered, then transferred on settlement
    Given no batch row exists in SurrealDB for ledger_hash "L3"
    When the indexer consumes a "zeko.l2.finality" message with level "proved" and ledger_hash "L3"
    Then a row in "pending_da_attestation" exists with ledger_hash "L3" and source "proved"
    When the indexer later consumes a "zeko.l1.settlements" message for "L3"
    Then the SurrealDB batch row for "L3" has da_status "attested"
    And the SurrealDB batch row for "L3" has da_source "settlement"
    And no row in "pending_da_attestation" remains for ledger_hash "L3"

  Scenario: Settlement wins the race when both messages target the same batch
    Given a batch row exists in SurrealDB with target_ledger_hash "L4"
    And that batch has da_status null
    When the indexer consumes a "zeko.l1.settlements" message for "L4"
    And the indexer subsequently consumes a "zeko.l2.finality" proved message for "L4"
    Then the SurrealDB batch row for "L4" has da_source "settlement"
    And the SurrealDB batch row for "L4" has da_status "attested"

  Scenario: Proved-derived attestation is not overwritten by a later settlement
    Given a batch row in SurrealDB has da_status "attested" and da_source "proved" for "L5"
    When the indexer consumes a "zeko.l1.settlements" message for "L5"
    Then the SurrealDB batch row for "L5" still has da_status "attested"
    And the settlement-related fields on the batch row are populated
    And da_source remains "proved"

  Scenario: Committed-level finality does not change da_status
    Given a batch row exists in SurrealDB with target_ledger_hash "L6"
    And that batch has da_status null
    When the indexer consumes a "zeko.l2.finality" message with level "committed" and ledger_hash "L6"
    Then the SurrealDB batch row for "L6" still has da_status null
