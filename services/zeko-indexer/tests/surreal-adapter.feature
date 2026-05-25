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
