Feature: NATS protocol contracts
  The shared NATS package exposes the event contracts resolved by the PRD and spike outputs.

  Scenario: Fixture payloads match their schemas
    Given the NATS protocol event fixtures
    Then every valid fixture is accepted by its event schema
    And every invalid fixture is rejected by its event schema

  Scenario: DA signatures use the resolved subject
    Then the NATS subjects include "zeko.da.signatures"
    And the NATS subjects do not include "zeko.da.attestations"

  Scenario: Producer-owned fields survive validation
    Given an L2 transaction with producer-owned raw fields
    When the L2 transaction event is parsed
    Then the producer-owned raw fields are retained

  Scenario: Bridge events reject deprecated ordering fields
    Then an L1 bridge event with "aux_sequence" is rejected

  Scenario: Sequencer health requires freshness fields
    Then a sequencer health heartbeat without freshness fields is rejected

  Scenario: L1 watcher health accepts provider-specific limitations
    Then an L1 watcher health heartbeat with a provider-specific limitation is accepted

  Scenario: Network identifiers follow the PRD
    Then the PRD Zeko-E testnet network id is accepted
    And the spike-only Zeko-E testnet variant is rejected

  Scenario: Message identifiers are deterministic
    Then the NATS message id helpers produce the documented keys
