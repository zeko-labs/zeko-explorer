Feature: DA attestation status storage

  Background:
    Given the consolidated schema is applied

  Scenario: Baseline proved finality can be buffered before the batch exists
    When a proved DA attestation is buffered for ledger hash "ledger-pending"
    Then a row in "pending_da_attestation" exists with ledger_hash "ledger-pending" and source "proved"

  Scenario: Direct DA signer detail can be stored on an attested batch
    Given a batch row exists with target ledger hash "ledger-direct"
    When direct DA signer detail reaches quorum for "ledger-direct"
    Then the SurrealDB batch row for "ledger-direct" has da_status "attested"
    And the SurrealDB batch row for "ledger-direct" has da_source "da-direct"
    And the SurrealDB batch row for "ledger-direct" records 2 DA signers
