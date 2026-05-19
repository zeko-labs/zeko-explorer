Feature: L1 Settlement and Outer Action Publication

  The L1 watcher publishes settlement facts and raw outer actions from both
  live daemon blocks and Archive-Node-API catch-up. The indexer owns lifecycle
  joins; the watcher owns durable, deduplicated L1 fact publication.

  Background:
    Given the L1 watcher is running
    And NATS JetStream is available
    And SurrealDB is available
    And the hosted Mina daemon is available
    And Archive-Node-API is available

  Scenario: Settlement commit action is published from a daemon block
    Given a daemon block contains a successful account update for OUTER_PK
    And the account update emits a commit action
    When the tip reconciler processes the block
    Then the watcher publishes a settlement to "zeko.l1.settlements"
    And the settlement includes the inner action state and slot range
    And the settlement status is "settling"

  Scenario: Archive settlement deduplicates against live detection
    Given the watcher already published a settlement from daemon block "B1"
    And Archive-Node-API returns the same OUTER_PK commit action for block "B1"
    When the outer action poller processes the archive range containing "B1"
    Then JetStream deduplicates the repeated settlement publication
    And exactly one settlement fact exists for block "B1"
    And the outer action cursor advances after the acknowledgement

  Scenario: Settlement reaches finality depth once
    Given a settlement was published at L1 height 4000 with status "settling"
    And the daemon best chain tip is L1 height 4289
    When the tip reconciler updates settlement confirmation depth
    Then the settlement remains "settling"
    When the daemon best chain tip is L1 height 4290
    Then the watcher publishes one finalized settlement update
    And no additional finalized update is published on later blocks

  Scenario: Outer action poller publishes raw unknown actions as degraded
    Given Archive-Node-API returns an OUTER_PK action with unknown discriminant "9"
    When the outer action poller processes the archive range
    Then the watcher publishes the raw outer action to "zeko.l1.outer-actions"
    And the parsed action type is "unknown"
    And health reports degraded outer action decoding

  Scenario: Outer actions publish in deterministic archive order
    Given Archive-Node-API returns OUTER_PK actions from multiple blocks in one chunk
    When the outer action poller processes the chunk
    Then the watcher publishes the actions ordered by block height, transaction order, account update order, and action order
    And the outer action cursor advances only after all acknowledged messages in the chunk
