@migration
Feature: Forward-only migrations with existing data

  Scenario: Bridge data-quality migration preserves existing rows and backfills defaults
    Given migration 1 is applied
    And core migration data exists
    When migration 2 is applied
    Then bridge operation "aux-migration" should have data quality "complete"
    And the database should contain tables:
      | l1_watcher_cursor    |
      | l1_watcher_published |

  Scenario: DA status migration preserves attested facts and adds the pending buffer
    Given the Spike 008 schema is applied
    And an existing batch range has legacy DA status "pending"
    When migration 3 is applied
    Then the existing batch should be addressable by target ledger hash "ledger-migration"
    And the batch addressed by target ledger hash "ledger-migration" should have no terminal DA status
    And the database should contain tables:
      | pending_da_attestation |
    And table "pending_da_attestation" should define indexes:
      | idx_pending_da_hash |

  Scenario: DA status migration backfills legacy batches without last_tx pointers
    Given the Spike 008 schema is applied
    And an existing batch range without last_tx is linked through transaction rows
    When migration 3 is applied
    Then the existing batch should be addressable by target ledger hash "ledger-linked"
    And the batch addressed by target ledger hash "ledger-linked" should have no terminal DA status
