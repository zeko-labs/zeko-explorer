Feature: Bridge GraphQL API

  The Bridge GraphQL API replaces archive-scanning with indexed queries.
  Users can query their bridge operations by public key, filter by type
  and status, paginate results, and subscribe to live updates.

  Background:
    Given the Bridge GraphQL API is running

  Scenario: Query deposits for a user
    Given the following bridge operations exist:
      | sender    | type    | status    |
      | B62qUser  | deposit | completed |
      | B62qUser  | deposit | submitted |
      | B62qOther | deposit | completed |
    When querying bridge operations for "B62qUser" filtered by type "deposit"
    Then the response contains 2 operations
    And both belong to user "B62qUser"

  Scenario: Query matches user as sender or recipient
    Given the following bridge operations exist:
      | sender    | recipient | type    | status    |
      | B62qUser  | B62qOther | deposit | completed |
      | B62qOther | B62qUser  | deposit | submitted |
    When querying bridge operations for "B62qUser"
    Then the response contains 2 operations

  Scenario: Filter by status
    Given 3 deposit operations exist for user "B62qUser" with statuses "submitted", "l1_witnessed", "completed"
    When querying bridge operations for "B62qUser" filtered by status "completed"
    Then the response contains 1 operation with status "completed"

  Scenario: Paginated results
    Given 25 bridge operations exist for user "B62qUser"
    When querying the first 10 bridge operations for "B62qUser"
    Then the response contains 10 operations
    And the response indicates more pages are available
    When querying the next 10 operations using the cursor
    Then the response contains 10 operations

  Scenario: Single operation detail includes linked actions
    Given a completed deposit exists with correlation key "abc123"
    And the deposit has linked L1 witness, L1 commit, and L2 finalization actions
    When querying the bridge operation for correlation key "abc123"
    Then the response includes the operation details
    And the response includes the linked L1 and L2 actions

  Scenario: Live subscription receives status updates for a user
    Given a client subscribes to updates for user "B62qUser"
    When a bridge operation for "B62qUser" transitions from "submitted" to "l1_witnessed"
    Then the client receives an update with status "l1_witnessed"

  Scenario: Live subscription does not leak other users' operations
    Given a client subscribes to updates for user "B62qUser"
    When a bridge operation for "B62qOther" transitions to "completed"
    Then the client receives no update
