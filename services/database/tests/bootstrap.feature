Feature: SurrealDB bootstrap

  Scenario: The initial SurrealKit schema can be applied to an empty database
    Given the consolidated schema is applied
    Then the database should contain tables:
      | name |
      | account                |
      | batch                  |
      | bridge_operation       |
      | pending_da_attestation |
      | transaction            |

  Scenario: The bootstrap schema stores PRD DA attestation fields
    Given the consolidated schema is applied
    And a batch row exists with target ledger hash "ledger-bootstrap"
    When direct DA signer detail reaches quorum for "ledger-bootstrap"
    Then the SurrealDB batch row for "ledger-bootstrap" has da_status "attested"
    And the SurrealDB batch row for "ledger-bootstrap" has da_source "da-direct"
    And the SurrealDB batch row for "ledger-bootstrap" records 2 DA signers
