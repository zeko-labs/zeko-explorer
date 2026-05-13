Feature: L1 Bridge Event Detection

  The L1 watcher publishes bridge facts observed on Mina L1. It does not
  assign bridge operation lifecycle state or aux_sequence; those are indexer
  responsibilities.

  Background:
    Given the L1 watcher is running
    And NATS JetStream is available
    And SurrealDB is available
    And the hosted Mina daemon is available
    And Archive-Node-API exposes historical zkApp commands

  Scenario: Deposit submission publishes user bridge event
    Given a successful L1 zkApp command contains a signed user account update
    And the account update emits a deposit action that references OUTER_PK
    When the bridge event decoder processes the command
    Then the watcher publishes a deposit event to "zeko.l1.bridge-events"
    And the event includes userPk from the signed account update
    And the event includes amount, recipient, timeout, holderAccountL1, and aux

  Scenario: Duplicate deposit aux values remain separate events
    Given two successful deposit submissions have the same computed aux
    And the submissions occur in different L1 transaction positions
    When the bridge event decoder processes both submissions
    Then the watcher publishes two deposit events
    And neither event includes aux_sequence
    And each event has a distinct deterministic event id

  Scenario: Withdrawal finalization publishes only when event params match witness aux
    Given a successful L1 transaction emits an OUTER_PK witness action
    And the same transaction emits finalize-withdrawal event params
    When withdrawalAux for the event params equals the witness aux
    Then the watcher publishes a withdrawal event to "zeko.l1.bridge-events"
    And the event includes recipient, amount, aux, and userPkSource

  Scenario: Withdrawal finalization mismatch is degraded and not published
    Given a successful L1 transaction emits an OUTER_PK witness action
    And the same transaction emits finalize-withdrawal event params
    When withdrawalAux for the event params does not equal the witness aux
    Then no withdrawal bridge event is published
    And health reports degraded bridge event decoding

  Scenario: Cancel deposit publishes without an outer witness action
    Given a successful L1 transaction advances helperAccountL1 cancellation counter
    And the transaction includes the expected outer-account precondition witness
    And the transaction emits no OUTER_PK witness action
    When the cancel decoder processes the transaction
    Then the watcher publishes a cancel event to "zeko.l1.bridge-events"
    And the event includes cancelledDepositIndex
    And the event is not rejected for missing an OUTER_PK action

  Scenario: Helper counter advancement without cancel transaction is degraded
    Given helperAccountL1 cancellation counter advances from 20 to 21
    And no matching cancel transaction is found in the recent daemon window
    When the helper counter verifier runs
    Then no synthetic cancel event is published
    And health includes limitation "helper_cancel_counter_unreconciled"
