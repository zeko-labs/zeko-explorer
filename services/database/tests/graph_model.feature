Feature: SurrealDB graph model

  Background:
    Given the consolidated schema is applied
    And the explorer fixture is indexed

  Scenario: Account detail can traverse bounded transaction-role edges
    When I run query "account-transaction-graph" with:
      | key | value |
      | account | account:01J0000000000000000000ALIC |
    Then the graph field "transactions" of the first row should contain 3 rows

  Scenario: Batch detail can traverse transaction containment edges
    When I run query "batch-with-transactions-graph" with:
      | key | value |
      | batch | batch:01J0000000000000000000BAT1 |
    Then the graph field "transactions" of the first row should contain 6 rows

  Scenario: Bridge detail can traverse correlated L1 and L2 actions
    When I run query "bridge-operation-detail-graph" with:
      | key | value |
      | aux          | "aux-shared" |
      | aux_sequence | 0            |
    Then the graph field "l1_actions" of the first row should contain 2 rows
    And the graph field "l2_actions" of the first row should contain 1 rows
    And the graph field "transactions" of the first row should contain 1 rows
