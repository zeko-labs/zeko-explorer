Feature: Partial Bridge Data UI Behavior

  Missing bridge-related L1 facts must not block unrelated explorer views.
  The API exposes data quality metadata, and the UI renders known data with
  inline warnings instead of crashing or replacing the page with a global
  loading state.

  Background:
    Given the explorer API is running
    And the frontend is running

  Scenario: Bridge operation renders when L1 bridge event details are missing
    Given a bridge operation exists with an L2 transaction and no matching L1 bridge event
    And the operation has dataQuality.l1BridgeEvents "degraded"
    When a user opens the bridge operation detail page
    Then the page renders the known L2 transaction details
    And the L1 bridge details are shown as unavailable
    And the page does not show a global loading blocker
    And the page does not crash

  Scenario: Account page renders despite unavailable bridge source
    Given account "B62qUser" has indexed L2 transactions
    And L1 bridge event source status is "unavailable"
    When a user opens the account page for "B62qUser"
    Then the page renders the indexed L2 transactions
    And bridge-related sections show a source availability warning
    And missing bridge facts do not hide unrelated account activity

  Scenario: Historical bridge gap is visible but non-blocking
    Given a bridge operation exists in an unrecoverable historical gap
    And the operation has dataQuality.l1BridgeEvents "unrecoverable_gap"
    When a user opens the bridge operation detail page
    Then the page renders the known operation fields
    And the page explains that historical L1 bridge details are unavailable
    And actions unrelated to missing L1 bridge details remain usable

  Scenario: Batch page renders with stale finality during daemon outage
    Given a batch settlement exists with status "settling"
    And the hosted Mina daemon is unavailable
    When a user opens the batch detail page
    Then the page renders the known settlement and batch details
    And finality is shown as stale or unknown
    And the page does not block waiting for live daemon data

  Scenario: Search results include partial bridge records
    Given search matches a bridge operation with missing L1 bridge fields
    And the operation has missing field "userPk"
    When a user searches for the bridge operation
    Then the search results include the bridge operation
    And the result marks "userPk" as unknown
    And the result includes data quality warnings from the API
