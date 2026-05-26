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

  Scenario: Runtime config honors deployment environment variables
    When the runtime config is resolved from the deployment environment
    Then the runtime uses NATS server "nats://nats:4222"
    And the runtime uses Surreal endpoint "http://surrealdb:8000"
    And the runtime uses Surreal database "explorer"

  Scenario: Runtime stop cancels an idle source
    Given an idle runtime envelope source
    When the runtime is started and stopped
    Then the runtime exits
