Feature: Milestone 4/5 — DA node publishes Schnorr signatures to NATS

  Each operator's DA node, when started with --nats-url, publishes one
  self-authenticating `zeko.da.signatures` message per persisted Schnorr
  signature. The publish is fire-and-forget. The DA node is the sole
  publisher of its own signatures.

  Background:
    Given three DA nodes are running, each with a distinct signing publicKey

  Scenario: DA node started without --nats-url publishes nothing
    Given a DA node is started without --nats-url
    When the sequencer sends a diff that the DA node signs and persists for "L1"
    Then no "zeko.da.signatures" message is published for that signing publicKey and "L1"
    And no "zeko.health" heartbeat with service "da-node" is published from that publicKey

  Scenario: DA node started with --nats-url publishes one signature message per persist
    Given a DA node is started with --nats-url and is connected to NATS JetStream
    When the sequencer sends a diff that the DA node signs and persists for "L1"
    Then exactly one "zeko.da.signatures" message is published for that signing publicKey and "L1"
    And the message carries fields publicKey, ledgerHash, signature, instanceId, signedAt, implementation
    And the message implementation field is "zeko-multisig-v1"

  Scenario: Published signature is self-authenticating
    Given a DA node has just published a "zeko.da.signatures" message for "L2"
    When a consumer runs Mina Schnorr verification of the message's signature over its ledgerHash and publicKey
    Then the verification succeeds without consulting the publisher's NATS identity

  Scenario: Invalid Schnorr signature on the wire is dropped on the consumer side
    Given a malicious publisher publishes a "zeko.da.signatures" message with a forged signature for "L3"
    When the indexer consumes the message
    Then the indexer drops the message with a warn log
    And the indexer acknowledges the message so JetStream does not redeliver it
    And the forged publicKey is not added to the in-memory signer set for "L3"

  Scenario: JetStream dedup collapses replay of the same operator signature
    Given a DA node has just published a "zeko.da.signatures" message for "L4"
    When the same DA node republishes the same signature for "L4" within the dedup window
    Then JetStream persists only one copy under the Nats-Msg-Id "da-sig-{publicKey}-L4"

  Scenario: Distinct operators signing the same ledgerHash produce distinct persisted messages
    Given three DA nodes each persist a Schnorr signature for "L5"
    When each DA node publishes its own "zeko.da.signatures" message for "L5"
    Then JetStream persists three messages with three distinct Nats-Msg-Id values
    And all three messages carry the same ledgerHash "L5" and three distinct publicKey values

  Scenario: DA node publishes a periodic heartbeat carrying its publicKey
    Given a DA node is started with --nats-url
    When 30 seconds elapse
    Then a "zeko.health" message is published with service "da-node"
    And the heartbeat carries publicKey, instanceId, implementation, lastSignedHash, lastSignedAt, natsConnected

  Scenario: Publish failure does not affect the DA node's RPC ack to the sequencer
    Given a DA node is started with --nats-url but NATS is unreachable
    When the sequencer sends a diff that the DA node signs and persists for "L6"
    Then the Schnorr signature for "L6" is durably persisted to RocksDB
    And the DA node returns success on the sequencer RPC for "L6"
    And the NATS publish failure is logged at warn

  Scenario: Implementation identifier is carried on every published message
    Given a DA node is started with --nats-url
    When the DA node publishes any "zeko.da.signatures" message
    Then the message implementation field is "zeko-multisig-v1"
    When the DA node publishes any "zeko.health" heartbeat
    Then the heartbeat implementation field is "zeko-multisig-v1"
