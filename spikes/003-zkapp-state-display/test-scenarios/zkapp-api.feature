Feature: zkApp GraphQL API

  The GraphQL API exposes zkApp state, events, and actions on the Account
  type. State is always available as raw field arrays. LabeledState is
  available for known contracts. Events and actions support cursor-based
  pagination ordered by sequence number.

  Background:
    Given the zkApp GraphQL API is running

  Scenario: Query raw zkApp state for an account
    Given account "B62qContract" has zkapp_state with 8 non-null field elements
    When querying zkappState for "B62qContract"
    Then the response contains an array of 8 strings
    And each string is a non-empty decimal field element

  Scenario: Query returns null zkappState for non-zkApp accounts
    Given account "B62qUser" is a regular payment account with no zkapp_state
    When querying zkappState for "B62qUser"
    Then the response contains zkappState null

  Scenario: Query labeled state for a known contract
    Given account "B62qBridge" has verification_key_hash matching the registry
    When querying labeledState for "B62qBridge"
    Then the response contains an array of LabeledField objects
    And each LabeledField has index, label, type, rawValue
    And LabeledField at index 6 has label "sequencer_public_key_is_odd" and type "bool"

  Scenario: Paginate events for an account — first page
    Given account "B62qContract" has 30 events stored
    When querying events(first: 10) for "B62qContract"
    Then the response contains 10 events
    And hasNextPage is true
    And each event has id, fields, timestamp, sequenceNumber, transaction

  Scenario: Paginate events for an account — subsequent pages
    Given account "B62qContract" has 30 events stored
    When querying events(first: 10) for "B62qContract"
    And using the endCursor to query events(first: 10, after: cursor)
    Then the second page contains 10 different events
    And the sequenceNumbers on the second page are all greater than the first page

  Scenario: Query all events exhausted returns hasNextPage false
    Given account "B62qContract" has exactly 5 events
    When querying events(first: 10) for "B62qContract"
    Then the response contains 5 events
    And hasNextPage is false

  Scenario: Paginate actions for an account
    Given account "B62qContract" has 25 actions stored
    When querying actions(first: 10) for "B62qContract"
    Then the response contains 10 actions
    And hasNextPage is true
    And each action has id, fields, actionState, timestamp, sequenceNumber

  Scenario: Query event includes labeledFields for known contract
    Given account "B62qBridge" emitted an event with fields ["123", "456"]
    And "B62qBridge" has a known contract registry entry
    When querying the event via the events connection for "B62qBridge"
    Then each event includes a labeledFields array with labels from the registry

  Scenario: Query action includes labeledFields for known contract
    Given account "B62qBridge" dispatched an action with fields ["789"]
    And the registry maps "witness" action field 0 to label "aux" type "field"
    When querying the action via the actions connection for "B62qBridge"
    Then the action includes labeledFields with label "aux" at index 0

  Scenario: Events filtered by transaction
    Given transaction "tx-xyz" emitted 3 events from "B62qContract"
    When querying events for transaction "tx-xyz"
    Then the response contains 3 events all with transaction "tx-xyz"
