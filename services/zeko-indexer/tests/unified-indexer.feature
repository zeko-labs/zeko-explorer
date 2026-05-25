Feature: Unified Zeko indexer
  The TypeScript indexer consumes the PRD NATS event contracts and materializes
  rollback-aware SurrealDB rows with ULID primary keys.

  Scenario: Payment ingestion writes transaction, account, activity, and sync state rows
    When the indexer consumes a payment transaction for ledger "ledger-1"
    Then one applied transaction row exists for hash "tx-payment-1"
    And the transaction row uses a ULID record id
    And payment account rows are updated
    And account activity snapshots exist for ledger "ledger-1"
    And sync status for "l2-transactions" has last_hash "ledger-1"

  Scenario: Duplicate L2 transaction messages are idempotent
    When the indexer consumes a payment transaction for ledger "ledger-duplicate"
    And the indexer consumes the same payment transaction for ledger "ledger-duplicate" again
    Then exactly 1 transaction row exists
    And exactly 2 account activity rows exist

  Scenario: Account activity preserves the sequencer changed account index
    When the indexer consumes an account update for "B62qIndexed" with changed account index 42
    Then account activity for "B62qIndexed" has activity_index 42

  Scenario: zkApp ingestion is schema-blind and stores raw event and action fields
    When the indexer consumes a zkApp transaction for ledger "ledger-zk-1"
    Then one zkapp_event row exists for account "B62qContract"
    And the zkapp_event row stores raw fields ["100", "200"]
    And one zkapp_action row exists for account "B62qContract"
    And the zkapp_action row stores raw fields ["42"]
    And the zkapp_action row has before_action_state "action-before" and action_state "action-after"
    And the zkApp child rows are tagged with target_ledger_hash "ledger-zk-1"

  Scenario: Fee transfer and genesis diffs are classified without commands
    When the indexer consumes a fee transfer diff for ledger "ledger-fee-1"
    Then the latest commandless transaction row has type "fee_transfer"
    When the indexer consumes a genesis diff for ledger "ledger-genesis-1"
    And the latest commandless transaction row has type "genesis"

  Scenario: Proved finality updates an existing batch without settlement
    Given a pending batch row exists for ledger "ledger-finality-1"
    When the indexer consumes a proved finality message for ledger "ledger-finality-1"
    Then batch for ledger "ledger-finality-1" has proof_status "proved"
    And batch for ledger "ledger-finality-1" has da_status "attested" and da_source "proved"

  Scenario: Committed finality does not derive DA attestation
    Given a pending batch row exists for ledger "ledger-committed-1"
    When the indexer consumes a committed finality message for ledger "ledger-committed-1"
    Then batch for ledger "ledger-committed-1" has no da_status

  Scenario: Settlement creates a batch and links the covered L2 transactions
    Given the indexer consumed a payment transaction for ledger "ledger-batch-1"
    And the indexer consumed a payment transaction for ledger "ledger-batch-2"
    When the indexer consumes a settlement message for ledger "ledger-batch-2"
    Then batch for ledger "ledger-batch-2" covers transaction heights 1 through 2
    And batch for ledger "ledger-batch-2" has transaction_count 2
    And transactions "tx-ledger-batch-1" and "tx-ledger-batch-2" are linked to batch for ledger "ledger-batch-2"

  Scenario: Settlement links covered L2 transactions that arrive later
    Given the indexer consumed a settlement message before L2 transactions for ledger "ledger-late-batch-2"
    When the indexer consumes a payment transaction for ledger "ledger-late-batch-1"
    And the indexer consumes a payment transaction for ledger "ledger-late-batch-2"
    Then batch for ledger "ledger-late-batch-2" covers transaction heights 1 through 2
    And batch for ledger "ledger-late-batch-2" has transaction_count 2
    And transactions "tx-ledger-late-batch-1" and "tx-ledger-late-batch-2" are linked to batch for ledger "ledger-late-batch-2"

  Scenario: Replayed settling settlement does not downgrade finalized batch
    Given the indexer consumed a finalized settlement message for ledger "ledger-finalized-replay"
    When the indexer consumes a settlement message for ledger "ledger-finalized-replay"
    Then batch for ledger "ledger-finalized-replay" has settlement_status "finalized"
    And batch for ledger "ledger-finalized-replay" keeps settled_at "2026-05-13T00:00:00.000Z"

  Scenario: Settlement stores the source L1 provider
    When the indexer consumes an "ethereum" settlement message for ledger "ledger-ethereum-settlement"
    Then batch for ledger "ledger-ethereum-settlement" has l1_chain "ethereum"

  Scenario: L2 rollback deletes derived zkApp rows and restores account snapshots
    Given the indexer consumed a zkApp transaction for ledger "ledger-keep"
    And the indexer consumed a follow-up zkApp transaction for ledger "ledger-reverted"
    When the indexer consumes a replacement transaction from source ledger "ledger-keep" to target ledger "ledger-replacement"
    Then transaction "tx-zk-reverted" is marked reverted
    And no zkapp_event rows remain for target ledger "ledger-reverted"
    And no zkapp_action rows remain for target ledger "ledger-reverted"
    And account "B62qContract" has zkapp_state ["1", "1", "1", "1", "1", "1", "1", "1"]
    And account "B62qContract" has last_activity_height 1

  Scenario: L2 rollback removes accounts first created by the reverted range
    Given the indexer consumed a payment transaction for ledger "ledger-account-keep"
    And the indexer consumed a payment transaction creating account "B62qNewAccount" for ledger "ledger-account-reverted"
    When the indexer consumes a replacement transaction from source ledger "ledger-account-keep" to target ledger "ledger-account-replacement"
    Then account "B62qNewAccount" no longer exists

  Scenario: Later rollbacks do not restore account state from reverted ledgers
    Given the indexer consumed an account update for "B62qsender" with balance "100" on ledger "ledger-canonical-a"
    And the indexer consumed an account update for "B62qsender" with balance "200" on ledger "ledger-reverted-b"
    And the indexer consumes a replacement transaction from source ledger "ledger-canonical-a" to target ledger "ledger-canonical-c"
    When the indexer consumes a replacement transaction from source ledger "ledger-canonical-a" to target ledger "ledger-canonical-d"
    Then account "B62qsender" has balance "100"

  Scenario: Replayed reverted L2 messages do not replace the canonical ledger
    Given the indexer consumed a payment transaction for ledger "ledger-replay-a"
    And the indexer consumed a payment transaction for ledger "ledger-replay-b"
    And the indexer consumes a replacement transaction from source ledger "ledger-replay-a" to target ledger "ledger-replay-c"
    When the indexer consumes a replayed reverted transaction from source ledger "ledger-replay-a" to target ledger "ledger-replay-b"
    Then transaction "tx-ledger-replay-b" is marked reverted
    And transaction "tx-ledger-replay-c" is still applied
    And sync status for "l2-transactions" has last_hash "ledger-replay-c"

  Scenario: The first observed L2 diff can roll back to its source ledger
    Given the indexer consumed a payment transaction for ledger "ledger-first-reverted"
    When the indexer consumes a replacement transaction from source ledger "ledger-0" to target ledger "ledger-first-replacement"
    Then transaction "tx-ledger-first-reverted" is marked reverted
    And transaction "tx-ledger-first-replacement" is still applied
    And sync status for "l2-transactions" has last_hash "ledger-first-replacement"

  Scenario: Unknown L2 source hash pauses indexing for backfill
    Given the indexer consumed a payment transaction for ledger "ledger-gap-before"
    When the indexer consumes a payment transaction from source ledger "ledger-missing" to target ledger "ledger-gap-after"
    Then the indexer rejects the message with an L2 gap error
    And sync status for "l2-transactions" is paused

  Scenario: Proved finality before settlement is buffered and transferred
    When the indexer consumes a proved finality message for ledger "ledger-da-1"
    Then pending DA attestation for "ledger-da-1" has source "proved"
    When the indexer consumes a settlement message for ledger "ledger-da-1"
    Then batch for ledger "ledger-da-1" has da_status "attested" and da_source "settlement"
    And no pending DA attestation remains for "ledger-da-1"

  Scenario: Direct DA signatures respect source precedence
    Given batch for ledger "ledger-da-2" is attested from source "proved"
    When the indexer consumes valid DA signatures for ledger "ledger-da-2" from "PK_A" and "PK_B"
    Then batch for ledger "ledger-da-2" has da_status "attested" and da_source "da-direct"
    When the indexer consumes a settlement message for ledger "ledger-da-2"
    Then after settlement batch for ledger "ledger-da-2" has da_status "attested" and da_source "settlement"
    And batch for ledger "ledger-da-2" records DA signers "PK_A" and "PK_B"

  Scenario: L1 rollback preserves DA facts for later rebinding
    Given batch for ledger "ledger-da-3" is attested from source "settlement"
    When the indexer consumes an L1 rollback affecting settlement "settlement-ledger-da-3"
    Then batch for ledger "ledger-da-3" has settlement_status "pending"
    And pending DA attestation for "ledger-da-3" has source "settlement"

  Scenario: Pending DA attestations are pruned after the max age
    Given pending DA attestation for "ledger-da-stale" was received 31 days ago
    When the pending DA pruner runs with a 30 day max age
    Then no pending DA attestation remains for "ledger-da-stale"

  Scenario: Restart resumes from durable sync state
    Given the indexer consumes a payment transaction for ledger "ledger-before-restart"
    When a new indexer instance uses the same store
    And the indexer consumes a payment transaction from source ledger "ledger-before-restart" to target ledger "ledger-after-restart"
    Then sync status for "l2-transactions" has last_hash "ledger-after-restart"

  Scenario: Indexer remains schema-blind at the package boundary
    Then the zeko-indexer source does not import "@zeko/contract-schema"
