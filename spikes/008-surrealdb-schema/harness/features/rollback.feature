Feature: Rollback support

  Background:
    Given the consolidated schema is applied
    And the explorer fixture is indexed

  Scenario: L2 rollback can find and remove rollback-sensitive child rows
    When I mark target ledger "ledger-106" as rolled back
    Then the rollback query for target ledger "ledger-106" should find no rollback-sensitive child rows

