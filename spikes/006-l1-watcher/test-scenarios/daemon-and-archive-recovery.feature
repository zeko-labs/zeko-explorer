Feature: Mina Daemon and Archive Recovery

  The hosted Mina daemon and Archive-Node-API are expected to be unreliable.
  The watcher must isolate failures by source, keep independent loops running,
  and recover without skipping durable ranges.

  Background:
    Given the L1 watcher is running
    And the watcher has durable cursors for outer actions and bridge events
    And NATS JetStream is available
    And SurrealDB is available

  Scenario: Daemon outage does not stop archive catch-up
    Given the hosted Mina daemon becomes unavailable
    And Archive-Node-API remains available
    When new outer actions are available from Archive-Node-API
    Then the outer action poller publishes the new outer actions
    And the outer action cursor advances after JetStream acknowledgements
    And settlement finality is marked stale
    And health includes limitation "l1_live_unavailable"

  Scenario: Daemon recovers before missed blocks leave the daemon frontier
    Given the hosted Mina daemon was unavailable for fewer than 290 blocks
    And bridge events were missed during the outage
    When the hosted Mina daemon becomes available again
    Then the watcher reconciles the retained best chain window
    And the missed bridge events are published in block order
    And health clears limitation "l1_live_unavailable"
    And no unrecoverable bridge gap is reported

  Scenario: Daemon outage exceeds the daemon frontier without historical zkApp commands
    Given the hosted Mina daemon was unavailable for more than 290 blocks
    And Archive-Node-API does not expose historical zkApp commands
    And bridge events may have occurred during the outage
    When the hosted Mina daemon becomes available again
    Then the watcher keeps running
    And health includes limitation "bridge_event_gap_unrecoverable"
    And health includes limitation "historical_bridge_events_unavailable"
    And the bridge event cursor records the unrecoverable gap range
    And already-known settlements and outer actions remain queryable

  Scenario: Archive outage does not stop live daemon processing
    Given Archive-Node-API becomes unavailable
    And the hosted Mina daemon remains available
    When a new daemon block contains an L1 settlement
    Then the watcher publishes the live settlement fact
    And the archive cursors remain unchanged
    And health includes limitation "l1_archive_unavailable"
    And the watcher retries archive catch-up with backoff

  Scenario: Archive recovers and resumes from the old cursor
    Given Archive-Node-API was unavailable
    And the bridge event cursor is at L1 height 1000
    And bridge events exist at L1 heights 1001 through 1010
    When Archive-Node-API becomes available again
    Then the bridge event poller scans from L1 height 1001
    And publishes bridge events for heights 1001 through 1010 in order
    And advances the bridge event cursor only after JetStream acknowledgements
    And health clears limitation "l1_archive_unavailable"

  Scenario: Daemon subscription drop falls back to polling
    Given the daemon GraphQL subscription connection drops
    And daemon HTTP GraphQL remains available
    When new L1 blocks are produced
    Then the watcher discovers the blocks through polling
    And the watcher reconnects the subscription with backoff
    And health reports the subscription as degraded without stopping data progress
