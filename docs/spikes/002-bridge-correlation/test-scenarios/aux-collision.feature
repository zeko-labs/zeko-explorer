Feature: Correlation Key Collisions

  The aux correlation key is a deterministic Poseidon hash of bridge
  parameters. Identical deposits or withdrawals produce the same aux.
  The indexer disambiguates via FIFO ordering using aux_sequence.

  Background:
    Given the bridge indexer is running

  Scenario: Two identical deposits are tracked separately
    When two deposits are submitted with identical parameters from user "B62qUser"
    Then two separate deposit operations are created
    And the first deposit has sequence 0
    And the second deposit has sequence 1

  Scenario: Witness proof matches the earliest unmatched deposit (FIFO)
    Given two deposits exist with the same correlation key, sequences 0 and 1
    And both have status "submitted"
    When an L1 witness proof arrives for that correlation key
    Then the deposit with sequence 0 advances to "l1_witnessed"
    And the deposit with sequence 1 remains "submitted"

  Scenario: Second witness proof matches the next unmatched deposit
    Given two deposits exist with the same correlation key, sequences 0 and 1
    And sequence 0 has status "l1_witnessed"
    And sequence 1 has status "submitted"
    When a second L1 witness proof arrives for that correlation key
    Then the deposit with sequence 1 advances to "l1_witnessed"

  Scenario: Two identical withdrawals are tracked separately
    When two withdrawals are submitted with identical parameters from user "B62qUser"
    Then two separate withdrawal operations are created
    And the first withdrawal has sequence 0
    And the second withdrawal has sequence 1
