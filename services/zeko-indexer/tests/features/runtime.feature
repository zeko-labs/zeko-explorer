Feature: Indexer runtime process
  The executable indexer entrypoint creates a long-running NATS to SurrealDB
  projection loop while remaining importable as a library in tests.

  Scenario: Runtime consumes envelopes and flushes projection after each message
    Given a finite runtime envelope source with deposit aux "aux-runtime-loop"
    When the runtime processes the source
    Then the runtime flushes projection 2 times
    And runtime bridge operation for aux "aux-runtime-loop" has status "l1_witnessed"

  Scenario: Runtime config creates one durable reader per source stream
    When the runtime config is resolved from the environment
    Then the runtime consumes streams "zeko-l1,zeko-l2,zeko-da"
    And the runtime uses durable name "zeko-indexer"

  Scenario: Runtime config propagates NATS throughput limits
    When the runtime config is resolved with NATS batch size 32 and max in-flight 64
    Then every runtime source reader pulls batches of 32 messages
    And every runtime source reader allows 64 in-flight messages

  Scenario: Runtime config wires direct DA signature verification
    When the runtime config is resolved with a signed direct DA event
    Then the runtime direct DA quorum is 2
    And the runtime direct DA authorized signer is configured
    And the runtime direct DA verification accepts the signed event
    And the runtime direct DA verification rejects malformed signatures

  Scenario: Runtime rebuilds in-memory state from the start of durable streams
    When the runtime source readers are created
    Then every runtime source reader replays its stream from the beginning

  Scenario: Runtime config rejects durable resume without startup hydration
    When the runtime config is resolved with durable resume enabled
    Then the runtime config fails because startup hydration is not implemented

  Scenario: Runtime config honors deployment environment variables
    When the runtime config is resolved from the deployment environment
    Then the runtime uses NATS server "nats://nats:4222"
    And the runtime uses durable name "deployment-indexer"
    And the runtime uses Surreal endpoint "http://surrealdb:8000"
    And the runtime uses Surreal database "explorer"
    And the runtime configures bridge inner action public key "B62qBridgeInner"

  Scenario: Runtime stop cancels an idle source
    Given an idle runtime envelope source
    When the runtime is started and stopped
    Then the runtime exits

  Scenario: Runtime default projection writes ordinary L2 rows
    Given a finite runtime envelope source with ordinary L2 transaction "tx-runtime-core"
    When the runtime processes the source with the default SurrealDB projection
    Then the SurrealDB SurrealQL writes the core account row
    And the SurrealDB SurrealQL writes the core transaction row
    And the SurrealDB SurrealQL writes the core account activity row

  Scenario: Runtime aborts sibling sources after a projection failure
    Given a runtime source that fails during projection and an idle sibling source
    When the runtime projection fails
    Then the idle sibling source is cancelled

  Scenario: Runtime serializes projection flushes across sources
    Given two finite runtime envelope sources with bridge deposits
    When the runtime processes them through a delayed projection writer
    Then projection flushes do not overlap

  Scenario: Runtime closes its projection client after sources finish
    Given a finite runtime envelope source with ordinary L2 transaction "tx-runtime-close"
    When the runtime processes the source with a closeable SurrealDB projection client
    Then the runtime closes the SurrealDB projection client
