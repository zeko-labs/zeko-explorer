Feature: Local explorer foundation stack
  The local developer stack follows the PRD and spike decisions.

  Scenario: Base local profile starts only the lean Milestone 1 workloads
    Given Docker Desktop Kubernetes is enabled
    When a developer runs "moon run infra:k8s-local-up"
    Then NATS JetStream is running in namespace "zeko-m-local"
    And SurrealDB is running in namespace "zeko-m-local"
    And the Zeko Indexer is running in namespace "zeko-m-local"
    And the Explorer API is running in namespace "zeko-m-local"
    And the Bridge API is running in namespace "zeko-m-local"
    And the L1 Watcher is disabled unless explicitly enabled
    And no DA Monitor workload is created

  Scenario: Port forwards expose explicit local bindings
    Given the local stack is running
    When a developer runs "moon run infra:k8s-local-forward"
    Then "localhost:4101" reaches the Explorer API
    And "localhost:4102" reaches the Bridge API
    And "localhost:4222" reaches NATS
    And "localhost:8000" reaches SurrealDB
