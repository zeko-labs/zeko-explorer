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

  Scenario: Raw transaction object keys are quoted in SurrealDB literals
    Given the in-memory projection has a bridge-linked transaction with producer-owned raw keys
    When the bridge projection is flushed once
    Then the SurrealDB SQL quotes raw object keys

  Scenario: Incremental flush does not delete existing bridge rows
    Given the in-memory projection has L1 and L2 action links
    When the bridge projection is flushed once
    Then the SurrealDB SQL does not delete bridge projection tables

  Scenario: Tracked removals delete only stale bridge records
    Given the in-memory projection has a removed L2 action link
    When the bridge projection is flushed once
    Then the SurrealDB SQL deletes only the removed L2 relation

  Scenario: Record IDs preserve source identifier uniqueness
    Given the in-memory projection has outer actions with punctuation-variant IDs
    When the bridge projection is flushed once
    Then the SurrealDB SQL uses distinct record IDs for each outer action
