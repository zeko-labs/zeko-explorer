Feature: NATS and SurrealDB runtime integration
  The indexer adapter reads typed NATS messages and persists projected rows
  into the SurrealDB schema.

  Scenario: Bridge event replays from JetStream into SurrealDB
    Given local NATS and SurrealDB are running
    When a deposit submission is published on NATS for aux "aux-runtime"
    And an L1 witness is published on NATS for aux "aux-runtime"
    And the indexer consumes two NATS messages from durable replay
    And the bridge projection is flushed to SurrealDB twice
    Then SurrealDB stores a bridge operation for aux "aux-runtime" with status "l1_witnessed"
    And SurrealDB stores one L1 witness link

  Scenario: L2 transaction replays from JetStream into SurrealDB
    Given local NATS and SurrealDB are running for core projection
    When an ordinary L2 transaction "tx-runtime-core-integration" is published on NATS
    And the indexer consumes one L2 message from durable replay
    And the full indexer projection is flushed to SurrealDB
    Then SurrealDB stores transaction "tx-runtime-core-integration"
    And SurrealDB stores an account activity for "B62qRuntimeSender"
