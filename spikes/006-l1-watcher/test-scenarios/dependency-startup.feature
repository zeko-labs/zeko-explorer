Feature: L1 Watcher Dependency Startup Resilience

  The L1 watcher should start whenever its static configuration is valid.
  Runtime dependencies may be unavailable during deployment, maintenance,
  or network incidents. Those outages must be reported through health state
  and retries, not by crashing the watcher process.

  Background:
    Given the L1 watcher has valid static configuration
    And SurrealDB contains the last durable L1 watcher cursors

  Scenario: Watcher starts while the hosted Mina daemon is unavailable
    Given the hosted Mina daemon is unavailable
    And Archive-Node-API is available
    When the L1 watcher starts
    Then the watcher process stays alive
    And "/healthz" reports status "degraded"
    And health includes limitation "l1_daemon_unavailable"
    And archive-backed catch-up continues from the durable cursors
    And no finalized settlement depth is advanced from stale daemon data

  Scenario: Watcher starts while Archive-Node-API is unavailable
    Given Archive-Node-API is unavailable
    And the hosted Mina daemon is available
    When the L1 watcher starts
    Then the watcher process stays alive
    And "/healthz" reports status "degraded"
    And health includes limitation "l1_archive_unavailable"
    And live daemon block processing continues
    And archive cursors remain unchanged

  Scenario: Watcher starts while NATS is unavailable
    Given NATS JetStream is unavailable
    And the hosted Mina daemon is available
    And Archive-Node-API is available
    When the L1 watcher starts
    Then the watcher process stays alive
    And "/healthz" reports status "degraded"
    And health includes limitation "nats_unavailable"
    And no L1 data cursor advances
    And no L1 fact is considered published

  Scenario: Watcher starts while SurrealDB is unavailable
    Given SurrealDB is unavailable
    And the hosted Mina daemon is available
    And Archive-Node-API is available
    When the L1 watcher starts
    Then the watcher process stays alive
    And "/healthz" reports status "degraded"
    And health includes limitation "surrealdb_unavailable"
    And no new L1 facts are published
    And no cursor is advanced from memory only

  Scenario: Invalid static configuration fails fast
    Given the L1 watcher is missing required static configuration "OUTER_PK"
    When the L1 watcher starts
    Then startup fails with a configuration error
    And no dependency connection is attempted
