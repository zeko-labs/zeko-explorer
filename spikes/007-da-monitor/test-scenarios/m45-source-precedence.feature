Feature: Milestone 4/5 — Indexer source precedence on the batch row

  The indexer accepts three sources for batch.da_status: Path A (settlement),
  Path B (proved), and Path C (DA-direct, aggregated from zeko.da.signatures).
  Source precedence on da_source is settlement > da-direct > proved: Path C
  upgrades a proved entry (it carries richer signer detail), but settlement
  is never overwritten (it is the authoritative on-chain record).

  Background:
    Given the indexer is running with M4/M5 schema additions
    And the indexer is connected to NATS JetStream and SurrealDB
    And the configured quorum is 2
    And the authorised DA signer set contains the publicKeys used in these scenarios

  Scenario: Path C upgrades a proved-source attestation with signer detail
    Given a batch row in SurrealDB has da_status "attested" and da_source "proved" for "L1"
    When the indexer consumes valid "zeko.da.signatures" messages for "L1" from two distinct publicKeys
    Then the SurrealDB batch row for "L1" has da_source "da-direct"
    And the SurrealDB batch row for "L1" has da_signers populated with one entry per signing publicKey
    And the SurrealDB batch row for "L1" has da_implementation "zeko-multisig-v1"
    And the SurrealDB batch row for "L1" has da_quorum_threshold 2

  Scenario: Settlement-source attestation is never overwritten by Path C
    Given a batch row in SurrealDB has da_status "attested" and da_source "settlement" for "L2"
    When the indexer consumes valid "zeko.da.signatures" messages for "L2" from two distinct publicKeys
    Then the SurrealDB batch row for "L2" still has da_source "settlement"
    And the SurrealDB batch row for "L2" still has its settlement-derived da_attested_at
    And the SurrealDB batch row for "L2" records the signer entries on da_signers as supplementary detail

  Scenario: Path C is the first source to reach the row
    Given a batch row exists in SurrealDB with target_ledger_hash "L3" and da_status null
    When the indexer consumes valid "zeko.da.signatures" messages for "L3" from two distinct publicKeys
    Then the SurrealDB batch row for "L3" has da_status "attested"
    And the SurrealDB batch row for "L3" has da_source "da-direct"
    And the SurrealDB batch row for "L3" has da_signers populated

  Scenario: Signatures arrive before the batch row exists
    Given no batch row exists in SurrealDB for ledger_hash "L4"
    When the indexer consumes two valid "zeko.da.signatures" messages for "L4" from distinct publicKeys
    Then a row in "pending_da_attestation" exists with ledger_hash "L4" and source "da-direct"
    And that pending row carries implementation, quorum_threshold, and signers
    When the indexer later consumes a "zeko.l1.settlements" message for "L4"
    Then the SurrealDB batch row for "L4" has da_status "attested"
    And the SurrealDB batch row for "L4" has da_source "settlement"
    And the SurrealDB batch row for "L4" has da_signers populated from the buffered pending row
    And no row in "pending_da_attestation" remains for ledger_hash "L4"

  Scenario: Signer set never reaches quorum leaves da_status null
    Given a batch row in SurrealDB has da_status null for "L5"
    When the indexer consumes only one valid signature for "L5"
    And no further signatures arrive
    Then the SurrealDB batch row for "L5" still has da_status null
    And the indexer writes no terminal value to da_status for "L5"
    And Path A or Path B may later flip the row to "attested" when the chain progresses
