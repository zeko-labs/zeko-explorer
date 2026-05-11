@migration
Feature: Forward-only migrations with existing data

  Scenario: Bridge data-quality migration preserves existing rows and backfills defaults
    Given migration 1 is applied
    And core migration data exists
    When migration 2 is applied
    Then bridge operation "aux-migration" should have data quality "complete"
    And the database should contain tables:
      | l1_watcher_cursor    |
      | l1_watcher_published |

