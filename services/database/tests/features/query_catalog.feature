Feature: Query catalog

  Background:
    Given the consolidated schema is applied
    And the explorer fixture is indexed

  Scenario: Global transaction feed is keyset ordered
    When I run query "transaction-feed-first-page" with:
      | key | value |
      | from_sort_block_height | -106 |
      | limit                  | 4    |
    Then the result should contain 4 rows
    And the rows should be ordered by descending field "block_height"
    And all row IDs should be record IDs for table "transaction"

  Scenario: Natural transaction lookup is idempotent and direct
    When I run query "transaction-by-hash" with:
      | key | value |
      | hash | "tx-005" |
    Then the result should contain one row
    And field "hash" of the first row should equal "tx-005"

  Scenario: Natural transaction lookup returns the newest re-included hash
    Given I insert another transaction with hash "tx-005" on target ledger "ledger-reincluded"
    When I run query "transaction-by-hash" with:
      | key | value    |
      | hash | "tx-005" |
    Then the result should contain one row
    And field "target_ledger_hash" of the first row should equal "ledger-reincluded"

  Scenario: Transaction investigation by hash includes bounded related data
    When I run query "transaction-detail-by-hash" with:
      | key | value |
      | hash               | "tx-006" |
      | event_limit        | 10       |
      | action_limit       | 10       |
      | inner_action_limit | 10       |
    Then the result should contain one row
    And field "hash" of the first row should equal "tx-006"
    And the graph field "bridge_operations" of the first row should contain 1 rows
    And the graph field "inner_actions" of the first row should contain 1 rows

  Scenario: Transaction investigation by hash returns the newest re-included hash
    Given I insert another transaction with hash "tx-005" on target ledger "ledger-reincluded"
    When I run query "transaction-detail-by-hash" with:
      | key                | value    |
      | hash               | "tx-005" |
      | event_limit        | 10       |
      | action_limit       | 10       |
      | inner_action_limit | 10       |
    Then the result should contain one row
    And field "target_ledger_hash" of the first row should equal "ledger-reincluded"

  Scenario: Account profile query loads current state and first-page feeds
    When I run query "account-profile-overview" with:
      | key | value |
      | public_key     | "B62qAlice" |
      | activity_limit | 3           |
      | sent_limit     | 3           |
      | received_limit | 3           |
      | bridge_limit   | 3           |
    Then the result should contain one row
    And field "public_key" of the first row should equal "B62qAlice"
    And the graph field "recent_activity" of the first row should contain 3 rows
    And the graph field "recent_bridge_operations" of the first row should contain 2 rows

  Scenario: Public key account lookup returns the native token account
    Given an earlier token account exists for public key "B62qAlice"
    When I run query "account-by-public-key" with:
      | key        | value       |
      | public_key | "B62qAlice" |
    Then the result should contain one row
    And field "token_id" of the first row should equal "1"

  Scenario: Account profile lookup returns the native token account
    Given an earlier token account exists for public key "B62qAlice"
    When I run query "account-profile-overview" with:
      | key | value |
      | public_key     | "B62qAlice" |
      | activity_limit | 3           |
      | sent_limit     | 3           |
      | received_limit | 3           |
      | bridge_limit   | 3           |
    Then the result should contain one row
    And field "token_id" of the first row should equal "1"

  Scenario: Account profile lookup excludes token-account transaction feeds
    Given a token sender transaction exists for public key "B62qAlice" on target ledger "ledger-token-sent"
    When I run query "account-profile-overview" with:
      | key | value |
      | public_key     | "B62qAlice" |
      | activity_limit | 5           |
      | sent_limit     | 10          |
      | received_limit | 10          |
      | bridge_limit   | 3           |
    Then the result should contain one row
    And field "token_id" of the first row should equal "1"
    And graph field "recent_sent_transactions" should not include target ledger "ledger-token-sent"

  Scenario: Exact identifier search returns the native token account
    Given an earlier token account exists for public key "B62qAlice"
    When I run query "search-exact-identifiers" with:
      | key   | value       |
      | term  | "B62qAlice" |
      | limit | 3           |
    Then the exact search account result should have token id "1"

  Scenario: Exact identifier search returns every re-included transaction hash
    Given I insert another transaction with hash "tx-005" on target ledger "ledger-reincluded"
    When I run query "search-exact-identifiers" with:
      | key   | value    |
      | term  | "tx-005" |
      | limit | 3        |
    Then the exact search transaction result should contain target ledgers "ledger-reincluded,ledger-105"

  Scenario: Smart contract transaction feed is receiver-indexed
    When I run query "transactions-by-receiver-first-page" with:
      | key | value |
      | public_key | "B62qContract" |
      | limit      | 3              |
    Then the result should contain 3 rows
    And the rows should be ordered by descending field "block_height"

  Scenario: Account activity feed uses account-specific ordering
    When I run query "account-activity-first-page" with:
      | key | value |
      | account | account:01J0000000000000000000ALIC |
      | limit   | 3                                      |
    Then the result should contain 3 rows
    And the rows should be ordered by descending field "block_height"

  Scenario: zkApp events are paginated by emitting account
    When I run query "zkapp-events-first-page" with:
      | key | value |
      | account | account:01J0000000000000000000ZKAP |
      | limit   | 2                                      |
    Then the result should contain 2 rows
    And the rows should be ordered by descending field "block_height"

  Scenario: Bridge sender history keeps aux collisions stable
    When I run query "bridge-operations-by-sender-first-page" with:
      | key | value |
      | public_key | "B62qAlice" |
      | limit      | 10          |
    Then the result should contain 2 rows
    And the rows should be ordered by descending field "submit_block_height"

  Scenario: Bridge evidence issues are derived from canonical bridge operations
    When I run query "bridge-quality-issues-first-page" with:
      | key | value |
      | data_quality | "partial" |
      | limit        | 5         |
    Then the result should contain one row
    And field "data_quality" of the first row should equal "partial"
    And field "reason" of the first row should equal "historical_bridge_events_unavailable"

  Scenario: Bridge evidence issues can be filtered by canonical missing source reason
    When I run query "bridge-quality-issues-by-reason" with:
      | key | value |
      | reason | "historical_bridge_events_unavailable" |
      | limit  | 5                                      |
    Then the result should contain one row
    And field "data_quality" of the first row should equal "partial"

  Scenario: Native transaction full-text search uses SurrealDB search functions
    When I run query "transactions-search-text" with:
      | key | value |
      | term  | "again" |
      | limit | 5           |
    Then the result should contain one row
    And field "hash" of the first row should equal "tx-005"

  Scenario: Native account full-text search uses the canonical account table
    When I run query "accounts-search-text" with:
      | key | value |
      | term  | "B62qAlice" |
      | limit | 5           |
    Then the result should contain one row
    And field "public_key" of the first row should equal "B62qAlice"

  Scenario: L1 watcher cursor lookup exposes source limitations
    When I run query "l1-watcher-cursor" with:
      | key | value |
      | source      | "l1-watcher"    |
      | network     | "zeko-m-devnet" |
      | provider    | "mina-daemon"   |
      | cursor_kind | "tip"           |
    Then the result should contain one row
    And field "last_block_height" of the first row should equal "5001"

  Scenario: Network stats are derived from canonical tables
    When I run query "network-stats-current" with:
      | key | value |
      | scope | "current" |
    Then the result should contain one row
    And field "latest_block_height" of the first row should equal "106"
    And field "transaction_count" of the first row should equal "6"
    And field "account_count" of the first row should equal "3"
    And field "bridge_operation_count" of the first row should equal "2"

  Scenario: Native throughput aggregation uses time buckets on canonical transactions
    When I run query "network-throughput-by-minute" with:
      | key | value |
      | from | d"2026-05-01T00:00:00Z" |
      | to   | d"2026-05-01T01:00:00Z" |
    Then the result should contain 6 rows
