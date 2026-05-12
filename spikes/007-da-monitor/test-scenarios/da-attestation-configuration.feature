Feature: Direct DA signatures — Configuration of the DA-attestation pipeline

  The configuration surface is three values: (a) the DA node's optional
  --nats-url flag, (b) the indexer's per-network "da.quorum" setting, and
  (c) the indexer's authorised DA signer public-key set. They are validated
  at startup and the configured values are surfaced on
  each heartbeat.

  Scenario: DA node started without --nats-url behaves identically to today
    Given a DA node is started without --nats-url
    When the sequencer sends a diff that the DA node signs and persists for "L1"
    Then the DA node persists the signature to RocksDB
    And no "zeko.da.signatures" message is published anywhere
    And no "zeko.health" heartbeat with service "da-node" is published

  Scenario: DA node started with --nats-url emits an instanceId on every message
    Given a DA node is started with --nats-url
    When the DA node publishes any "zeko.da.signatures" message
    Then the message instanceId field matches the UUID generated at DA-node process start
    When the same DA node publishes a "zeko.health" heartbeat
    Then the heartbeat instanceId field matches the same UUID

  Scenario: DA node restart rotates the instanceId
    Given a DA node started with --nats-url is publishing messages with instanceId "U1"
    When the DA node process exits and restarts
    Then subsequent published messages carry an instanceId different from "U1"

  Scenario: Indexer logs the configured quorum and signer set at startup and on every heartbeat
    Given the indexer is started with "da.quorum" set to 2
    And the indexer is configured with DA signer publicKeys "PK_A", "PK_B", and "PK_C"
    Then the startup log records "da.quorum 2"
    And the startup log records the configured DA signer publicKeys
    When the next "zeko.health" heartbeat is published by the indexer
    Then the heartbeat carries quorum.threshold 2
    And the heartbeat carries the configured DA signer publicKeys

  Scenario: Indexer warns when configured quorum disagrees with the L1 contract threshold
    Given the L1 contract's helper-account signature-check threshold is 3
    And the indexer is started with "da.quorum" set to 2
    Then the startup log records a warning that the configured quorum does not match the L1 contract threshold
    And Path C da_status flips are disabled
    And the indexer continues to run and process messages

  Scenario: Indexer warns when configured DA signer set disagrees with the L1 contract
    Given the L1 contract's helper-account public-key list is "PK_A", "PK_B", and "PK_C"
    And the indexer is configured with DA signer publicKeys "PK_A", "PK_B", and "PK_X"
    Then the startup log records a warning that the configured signer set does not match the L1 contract signer set
    And Path C da_status flips are disabled
    And the indexer continues to run and process messages

  Scenario: Indexer rejects an unknown schemaVersion on the wire
    Given the indexer is configured to accept schemaVersion 1
    When a publisher publishes a "zeko.da.signatures" message with schemaVersion 99
    Then the indexer drops the message with a warn log
    And the indexer acknowledges the message so JetStream does not redeliver it
    And no SurrealDB write occurs in response to that message

  Scenario: Indexer dispatches by implementation identifier
    Given the indexer registers handlers for "zeko-multisig-v1" and "celestia-v1"
    When a publisher publishes a "zeko.da.signatures" message with implementation "zeko-multisig-v1"
    Then the multisig handler verifies the message using Schnorr verification
    When a publisher publishes a "zeko.da.signatures" message with implementation "celestia-v1"
    Then the celestia handler verifies the message using inclusion-proof verification
    When a publisher publishes a "zeko.da.signatures" message with implementation "unknown-v1"
    Then the indexer drops the message with a warn log

  Scenario: DA node publishes its periodic heartbeat at the configured interval
    Given a DA node is started with --nats-url
    When 30 seconds elapse from process start
    Then a "zeko.health" message with service "da-node" is published
    And the heartbeat carries publicKey, instanceId, implementation, lastSignedHash, lastSignedAt, natsConnected
