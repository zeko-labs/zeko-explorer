Feature: Surreal bridge adapter
  The indexer persists the bridge read model using WEB-426 relation tables.

  Scenario: Relation rows are idempotent across repeated flushes
    Given the in-memory projection has L1 and L2 action links
    When the bridge projection is flushed twice
    Then every graph relation write uses insert relation with duplicate handling
    And repeated flushes emit the same relation record IDs

  Scenario: Bridge transaction links are persisted
    Given the in-memory projection has a bridge transaction link
    When the bridge projection is flushed once
    Then the SurrealDB SQL contains a bridge transaction relation

  Scenario: Bridge transaction links write transaction rows before enforced relations
    Given the in-memory projection has a bridge transaction link to a transaction row
    When the bridge projection is flushed once
    Then the SurrealDB SQL writes the transaction before the bridge transaction relation

  Scenario: Inner actions retain their source transaction record
    Given the in-memory projection has an inner action from transaction "tx-1"
    When the bridge projection is flushed once
    Then the SurrealDB SQL stores the inner action transaction link

  Scenario: Snapshot flush deletes stale bridge rows and relations
    Given the in-memory projection has L1 and L2 action links
    When the bridge projection is flushed, L2 evidence is removed, and the projection is flushed again
    Then the second SurrealDB SQL deletes stale bridge projection rows
    And the second SurrealDB SQL does not reinsert the removed L2 relation
