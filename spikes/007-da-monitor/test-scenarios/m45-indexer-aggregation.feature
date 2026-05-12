Feature: Milestone 4/5 — Indexer aggregates DA signatures into Path C attestations

  The indexer consumes `zeko.da.signatures`, verifies each Schnorr signature,
  accumulates distinct signing public keys per ledgerHash in an in-memory
  LRU, and flips `batch.da_status = 'attested'` once the count reaches the
  configured quorum. Paths A (settlement) and B (proved) remain
  authoritative fallbacks.

  Background:
    Given the indexer is running with M4/M5 schema additions
    And the indexer is connected to NATS JetStream and SurrealDB
    And the configured quorum is 2

  Scenario: Two distinct operators sign — Path C flips da_status to attested
    Given a batch row in SurrealDB exists with target_ledger_hash "L1" and da_status null
    When the indexer consumes a valid "zeko.da.signatures" message for "L1" from publicKey "PK_A"
    Then the SurrealDB batch row for "L1" still has da_status null
    And the SurrealDB batch row for "L1" has da_signers containing one entry for "PK_A"
    When the indexer consumes a valid "zeko.da.signatures" message for "L1" from publicKey "PK_B"
    Then the SurrealDB batch row for "L1" has da_status "attested"
    And the SurrealDB batch row for "L1" has da_source "da-direct"
    And the SurrealDB batch row for "L1" has da_signers containing one entry each for "PK_A" and "PK_B"
    And the SurrealDB batch row for "L1" has da_quorum_threshold 2

  Scenario: Duplicate signature from the same operator does not double-count
    Given the indexer has already consumed a valid signature for "L2" from publicKey "PK_A"
    When the indexer consumes another valid signature for "L2" from publicKey "PK_A"
    Then the SurrealDB batch row for "L2" has da_signers containing exactly one entry for "PK_A"
    And the SurrealDB batch row for "L2" still has da_status null

  Scenario: Signatures arriving before the batch row exists are buffered
    Given no batch row exists in SurrealDB for ledger_hash "L3"
    When the indexer consumes a valid signature for "L3" from publicKey "PK_A"
    Then a row in "pending_da_attestation" exists with ledger_hash "L3" and source "da-direct"
    And that pending row's signers array contains one entry for "PK_A"
    When the indexer consumes a valid signature for "L3" from publicKey "PK_B"
    Then the pending row for "L3" has signers containing entries for "PK_A" and "PK_B"
    And the pending row for "L3" has attested_at populated
    When the indexer later consumes a "zeko.l1.settlements" message for "L3"
    Then the SurrealDB batch row for "L3" has da_status "attested"
    And the SurrealDB batch row for "L3" has da_source "settlement"
    And the SurrealDB batch row for "L3" has da_signers carrying both signer entries
    And no row in "pending_da_attestation" remains for ledger_hash "L3"

  Scenario: Bootstrap uses DeliverPolicy New
    Given the chain has historical signatures present in the "zeko-da" JetStream stream
    When the indexer starts its "zeko.da.signatures" consumer for the first time
    Then the durable consumer is created with DeliverPolicy "New"
    And the indexer never aggregates historical signatures for already-attested batches

  Scenario: Indexer restart reseeds the in-memory LRU from pending_da_attestation
    Given the indexer's in-memory LRU has one signer "PK_A" recorded for "L4"
    And SurrealDB "pending_da_attestation" for "L4" reflects that signer
    When the indexer process exits and restarts
    Then on the next signature message for "L4" from publicKey "PK_B" the LRU is reseeded from "pending_da_attestation"
    And the resulting signer set for "L4" contains both "PK_A" and "PK_B"
    And the SurrealDB batch row for "L4" has da_status "attested"

  Scenario: NATS publish loss does not break correctness
    Given a DA node's NATS publisher is unreachable for the entire signing of "L5"
    When the indexer never observes any "zeko.da.signatures" message for "L5"
    And the indexer later consumes a "zeko.l2.finality" message at level "proved" for "L5"
    Then the SurrealDB batch row for "L5" has da_status "attested"
    And the SurrealDB batch row for "L5" has da_source "proved"

  Scenario: Two indexer instances share the durable consumer during a rolling deploy
    Given two indexer instances run simultaneously with the same durable consumer name
    When DA nodes publish three "zeko.da.signatures" messages for "L6"
    Then JetStream delivers each message to exactly one indexer instance
    And the SurrealDB batch row for "L6" ends with da_signers containing all three signer entries exactly once
    And no duplicate persisted state remains in SurrealDB

  Scenario: Signer set never reaches quorum leaves da_status null
    Given a batch row exists in SurrealDB for "L7" with da_status null
    When the indexer consumes only one valid signature for "L7" from publicKey "PK_A"
    And no further signatures arrive for one commit period
    Then the SurrealDB batch row for "L7" still has da_status null
    And the indexer writes no terminal value to da_status for "L7"
    And the pending DA attestation for "L7" is surfaced on the operator /status page

  Scenario: LRU eviction is recoverable from pending_da_attestation
    Given the in-memory LRU has reached its cap of 4096 entries
    And the entry for "L8" has been evicted from the LRU
    And "pending_da_attestation" for "L8" still records signer "PK_A"
    When a new signature for "L8" from "PK_B" arrives
    Then the LRU is reseeded from "pending_da_attestation" for "L8"
    And the resulting signer set for "L8" contains both "PK_A" and "PK_B"
