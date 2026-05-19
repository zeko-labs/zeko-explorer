Feature: Downstream Service Downtime

  Watcher correctness should not depend on the indexer, explorer API, or
  frontend being continuously available. Downstream services recover from
  durable NATS and stored sync status.

  Background:
    Given the L1 watcher is running
    And NATS JetStream is available
    And SurrealDB is available
    And the hosted Mina daemon is available
    And Archive-Node-API is available

  Scenario: Indexer outage does not stop watcher publication
    Given the indexer is unavailable
    When the watcher observes new settlements and bridge events
    Then the watcher publishes the L1 facts to their NATS subjects
    And the watcher advances cursors after JetStream acknowledgements
    And the watcher health remains based on L1 dependencies

  Scenario: Indexer recovers by replaying retained NATS messages
    Given the indexer was unavailable while the watcher published L1 facts
    And NATS retained the published L1 facts
    When the indexer becomes available again
    Then the indexer resumes consumption from its durable stream position
    And creates bridge operation updates for the retained bridge events
    And does not require the watcher to republish old messages

  Scenario: Explorer API downtime does not change watcher behavior
    Given the explorer API is unavailable
    When the watcher observes a new finalized settlement
    Then the watcher publishes the settlement update
    And updates sync status in SurrealDB
    And does not wait for the explorer API to recover

  Scenario: Explorer API recovers with stale L1 sync status visible
    Given the explorer API was unavailable
    And the watcher reported degraded L1 health during the outage
    When the explorer API becomes available again
    Then API responses include the latest L1 sync status
    And API responses do not report "no bridge operations" solely because a dependency was down

  Scenario: Frontend downtime has no data-loss effect
    Given no frontend clients are connected
    When the watcher and indexer process L1 bridge events
    Then bridge operation records are stored
    And the frontend can render those records when clients reconnect
