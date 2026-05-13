Feature: Durable Publication Failure Handling

  L1 facts are safe only when publication and durable cursor state agree.
  The watcher must never advance a cursor before the relevant NATS message
  is acknowledged and the durable state transition is stored.

  Background:
    Given the L1 watcher is running
    And the hosted Mina daemon is available
    And Archive-Node-API is available
    And the bridge event cursor is at L1 height 2000

  Scenario: NATS outage pauses cursor advancement
    Given NATS JetStream becomes unavailable
    And Archive-Node-API has bridge events at L1 heights 2001 through 2005
    When the bridge event poller scans the next archive chunk
    Then the watcher process stays alive
    And no bridge event cursor advances past L1 height 2000
    And no bridge event is marked published in SurrealDB
    And health includes limitation "nats_unavailable"

  Scenario: NATS recovers and bridge events publish without gaps
    Given NATS JetStream was unavailable
    And no bridge event cursor advanced past L1 height 2000
    When NATS JetStream becomes available again
    Then the bridge event poller retries from L1 height 2001
    And publishes bridge events for heights 2001 through 2005 in order
    And advances the bridge event cursor after JetStream acknowledgements
    And health clears limitation "nats_unavailable"

  Scenario: SurrealDB outage pauses publication
    Given SurrealDB becomes unavailable
    And Archive-Node-API has outer actions at L1 heights 2001 through 2005
    When the outer action poller scans the next archive chunk
    Then the watcher process stays alive
    And no outer action is published to NATS
    And no outer action cursor advances past L1 height 2000
    And health includes limitation "surrealdb_unavailable"

  Scenario: SurrealDB recovers and archive polling resumes from durable state
    Given SurrealDB was unavailable
    And the durable outer action cursor is still L1 height 2000
    When SurrealDB becomes available again
    Then the outer action poller resumes from L1 height 2001
    And publishes outer actions in deterministic archive order
    And advances the outer action cursor after each acknowledged publication batch
    And health clears limitation "surrealdb_unavailable"

  Scenario: JetStream acknowledgement failure leaves the cursor unchanged
    Given NATS JetStream accepts a bridge event publish request
    But JetStream does not acknowledge the publish request
    When the watcher handles the publish timeout
    Then the watcher retries the bridge event with the same deduplication id
    And the bridge event cursor remains at L1 height 2000
    And no duplicate bridge operation is created downstream
