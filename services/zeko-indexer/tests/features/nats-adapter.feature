Feature: NATS envelope source configuration
  The indexer consumes durable NATS streams using concrete stream and subject
  pairs that match the PRD event domains.

  Scenario: Minimal source config resolves to the default L1 stream
    When the NATS envelope source config is resolved with only servers "nats://127.0.0.1:4222"
    Then the source consumes stream "zeko-l1"
    And the source filters subject "zeko.l1.*"

  Scenario: Stream-only source config uses the matching subject wildcard
    When the NATS envelope source config is resolved with stream "zeko-l2"
    Then the source consumes stream "zeko-l2"
    And the source filters subject "zeko.l2.*"

  Scenario: Invalid subscribed payloads are acknowledged and dropped
    When a schema-invalid NATS message is consumed on subject "zeko.da.signatures"
    Then the NATS message is acknowledged
    And no envelope is delivered
