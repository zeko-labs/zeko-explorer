Feature: zkApp Event Ingestion

  The indexer extracts events from account_updates in each zkApp command and
  stores them as zkapp_event records. Events are raw field arrays — no type
  information is available from the chain. Each event is linked to its
  emitting account and the parent transaction.

  Background:
    Given the indexer is consuming from "zeko.l2.transactions"

  Scenario: Single event is stored from a zkApp account_update
    When a NATS message arrives with a zkApp command
    And the account_update for "B62qContract" contains one event:
      | field_index | value   |
      | 0           | 100     |
      | 1           | 200     |
    Then one zkapp_event record exists for "B62qContract" in this transaction
    And the event has fields ["100", "200"]
    And the event is linked to the correct transaction

  Scenario: Multiple events from the same account_update are all stored
    When a NATS message arrives with a zkApp command
    And the account_update for "B62qContract" contains three events
    Then three zkapp_event records exist for "B62qContract" in this transaction
    And each event has a distinct event_index (0, 1, 2)

  Scenario: Events from multiple account_updates in one transaction are stored separately
    When a NATS message arrives with a zkApp command
    And the account_update for "B62qContractA" contains one event
    And the account_update for "B62qContractB" contains two events
    Then one zkapp_event record exists for "B62qContractA"
    And two zkapp_event records exist for "B62qContractB"
    And all three events are linked to the same transaction

  Scenario: Event ID is deterministic based on tx hash, account, and event index
    Given a zkapp_event was stored for tx "txABC" from account "B62qContract" at event_index 0
    When the same NATS message is re-processed (deduplication replay)
    Then no duplicate event record is created
    And the event ID remains "txABC:B62qContract:0"

  Scenario: Account_update with empty events list creates no event records
    When a NATS message arrives with a zkApp command
    And the account_update for "B62qContract" has an empty events array
    Then no zkapp_event records exist for "B62qContract" in this transaction

  Scenario: Events are queryable by emitting account in sequence order
    Given three zkapp_event records exist for account "B62qContract" with sequence_numbers 1, 2, 3
    When querying events for account "B62qContract" ordered by sequence_number
    Then the events are returned in ascending sequence order
    And each event includes its emitting_account and transaction links
