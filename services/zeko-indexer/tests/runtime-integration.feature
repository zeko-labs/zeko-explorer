Feature: NATS and SurrealDB runtime integration
  The indexer adapter reads typed NATS messages and persists projected rows
  into the WEB-426 SurrealDB schema.

  Scenario: Bridge event flows from NATS into SurrealDB
    Given local NATS and SurrealDB are running
    When a deposit submission is published on NATS for aux "aux-runtime"
    And the indexer consumes one NATS message
    And the bridge projection is flushed to SurrealDB
    Then SurrealDB stores a bridge operation for aux "aux-runtime" with status "submitted"
