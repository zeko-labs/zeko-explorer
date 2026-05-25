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

  Scenario: L2 millisecond timestamp strings are normalized
    When the indexer consumes a payment transaction for ledger "ledger-ms-time" with timestamp "1710000000000"
    Then transaction "tx-ledger-ms-time" has timestamp "2024-03-09T16:00:00.000Z"

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

  Scenario: zkApp ingestion accepts Spike 003 body-shaped account updates
    Given account "B62qBodyContract" has prior action_state head "action-before-body"
    When the indexer consumes a body-shaped zkApp transaction for "B62qBodyContract" on ledger "ledger-zk-body"
    Then one zkapp_event row exists for account "B62qBodyContract"
    And the zkapp_event row stores raw fields ["300", "400"]
    And one zkapp_action row exists for account "B62qBodyContract"
    And the zkapp_action row stores raw fields ["77"]
    And the zkapp_action row has before_action_state "action-before-body" and action_state "action-after-body"

  Scenario: First raw zkApp action uses the genesis action state
    When the indexer consumes a first body-shaped zkApp transaction for "B62qFirstBodyContract" on ledger "ledger-zk-body-first"
    Then one zkapp_action row exists for account "B62qFirstBodyContract"
    And the zkapp_action row stores raw fields ["77"]
    And the zkapp_action row has before_action_state "0" and action_state "action-after-first-body"

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

  Scenario: Proved finality creates a batch for already indexed L2 transactions
    Given the indexer consumed a payment transaction for ledger "ledger-proved-batch-1"
    And the indexer consumed a payment transaction for ledger "ledger-proved-batch-2"
    When the indexer consumes a proved finality message for ledger "ledger-proved-batch-2"
    Then batch for ledger "ledger-proved-batch-2" has proof_status "proved"
    And batch for ledger "ledger-proved-batch-2" covers transaction heights 1 through 2
    And transactions "tx-ledger-proved-batch-1" and "tx-ledger-proved-batch-2" are linked to batch for ledger "ledger-proved-batch-2"

  Scenario: Delayed proved finality does not re-attest an L2 rolled-back batch
    Given the indexer consumed a payment transaction for ledger "ledger-finality-rollback-1"
    And a pending batch row exists for ledger "ledger-finality-rollback-2"
    And the indexer consumed a payment transaction for ledger "ledger-finality-rollback-2"
    When the indexer consumes a replacement transaction from source ledger "ledger-finality-rollback-1" to target ledger "ledger-finality-rollback-3"
    And the indexer consumes a proved finality message for ledger "ledger-finality-rollback-2"
    Then batch for ledger "ledger-finality-rollback-2" has settlement_status "rolled_back"
    And batch for ledger "ledger-finality-rollback-2" has proof_status "pending"
    And batch for ledger "ledger-finality-rollback-2" has no da_status

  Scenario: Delayed proved finality does not create pending DA for an already rolled-back L2 ledger
    Given the indexer consumed a payment transaction for ledger "ledger-finality-no-batch-1"
    And the indexer consumed a payment transaction for ledger "ledger-finality-no-batch-2"
    When the indexer consumes a replacement transaction from source ledger "ledger-finality-no-batch-1" to target ledger "ledger-finality-no-batch-3"
    And the indexer consumes a proved finality message for ledger "ledger-finality-no-batch-2"
    Then no batch row exists for ledger "ledger-finality-no-batch-2"
    And no pending DA attestation remains for "ledger-finality-no-batch-2"

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

  Scenario: Out-of-order settlements recompute earlier batch links
    Given the indexer consumed a payment transaction for ledger "ledger-out-of-order-batch-1"
    And the indexer consumed a payment transaction for ledger "ledger-out-of-order-batch-2"
    And the indexer consumed a settlement message for ledger "ledger-out-of-order-batch-2"
    When the indexer consumes a settlement message for ledger "ledger-out-of-order-batch-1"
    Then batch for ledger "ledger-out-of-order-batch-1" has transaction_count 1
    And batch for ledger "ledger-out-of-order-batch-2" has transaction_count 1
    And transaction "tx-ledger-out-of-order-batch-1" is linked to batch for ledger "ledger-out-of-order-batch-1"
    And later transaction "tx-ledger-out-of-order-batch-2" is linked to batch for ledger "ledger-out-of-order-batch-2"

  Scenario: L2 rollback clears stale batch links before replacement settlement
    Given the indexer consumed a payment transaction for ledger "ledger-rollback-batch-1"
    And the indexer consumed a payment transaction for ledger "ledger-rollback-batch-2"
    And the indexer consumed a settlement message for ledger "ledger-rollback-batch-2"
    When the indexer consumes a replacement transaction from source ledger "ledger-rollback-batch-1" to target ledger "ledger-rollback-batch-3"
    And the indexer consumes a settlement message for ledger "ledger-rollback-batch-3"
    Then transaction "tx-ledger-rollback-batch-2" is marked reverted
    And transaction "tx-ledger-rollback-batch-2" is not linked to a batch
    And batch for ledger "ledger-rollback-batch-3" has transaction_count 2
    And transactions "tx-ledger-rollback-batch-1" and "tx-ledger-rollback-batch-3" are linked to batch for ledger "ledger-rollback-batch-3"

  Scenario: Stale settlements do not resurrect L2 rolled-back batches
    Given the indexer consumed a payment transaction for ledger "ledger-stale-settlement-1"
    And the indexer consumed a payment transaction for ledger "ledger-stale-settlement-2"
    And the indexer consumed a settlement message for ledger "ledger-stale-settlement-2"
    When the indexer consumes a replacement transaction from source ledger "ledger-stale-settlement-1" to target ledger "ledger-stale-settlement-3"
    And the indexer consumes a settlement message for ledger "ledger-stale-settlement-2"
    Then batch for ledger "ledger-stale-settlement-2" has settlement_status "rolled_back"
    And batch for ledger "ledger-stale-settlement-2" has proof_status "pending"
    And batch for ledger "ledger-stale-settlement-2" has no da_status
    And batch for ledger "ledger-stale-settlement-2" has no l1_tx_hash
    And transaction "tx-ledger-stale-settlement-2" is not linked to a batch

  Scenario: Stale settlement does not create a batch for an already rolled-back L2 ledger
    Given the indexer consumed a payment transaction for ledger "ledger-stale-no-batch-1"
    And the indexer consumed a payment transaction for ledger "ledger-stale-no-batch-2"
    When the indexer consumes a replacement transaction from source ledger "ledger-stale-no-batch-1" to target ledger "ledger-stale-no-batch-3"
    And the indexer consumes a settlement message for ledger "ledger-stale-no-batch-2"
    Then no batch row exists for ledger "ledger-stale-no-batch-2"
    And transaction "tx-ledger-stale-no-batch-2" is not linked to a batch

  Scenario: Replayed settling settlement does not downgrade finalized batch
    Given the indexer consumed a finalized settlement message for ledger "ledger-finalized-replay"
    When the indexer consumes a settlement message for ledger "ledger-finalized-replay"
    Then batch for ledger "ledger-finalized-replay" has settlement_status "finalized"
    And batch for ledger "ledger-finalized-replay" keeps settled_at "2026-05-13T00:00:00.000Z"
    And batch for ledger "ledger-finalized-replay" keeps l1_confirmations 290

  Scenario: Replayed settling settlement keeps finalized rollback identity
    Given the indexer consumed a finalized settlement message for ledger "ledger-finalized-rollback-id"
    When the indexer consumes a settlement message for ledger "ledger-finalized-rollback-id" with settlement id "settlement-late-ledger-finalized-rollback-id"
    And the indexer consumes an L1 rollback affecting settlement "settlement-ledger-finalized-rollback-id"
    Then batch for ledger "ledger-finalized-rollback-id" has settlement_status "pending"
    And batch for ledger "ledger-finalized-rollback-id" has no l1_tx_hash

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

  Scenario: Duplicate zkApp action states are rejected
    Given the indexer consumed a zkApp transaction for ledger "ledger-action-state-original"
    When the indexer rejects a zkApp transaction for ledger "ledger-action-state-duplicate" with duplicate action_state "action-keep"
    Then exactly 1 zkapp_action row has action_state "action-keep"
    And transaction "tx-zk-duplicate-action" does not exist

  Scenario: L2 rollback removes accounts first created by the reverted range
    Given the indexer consumed a payment transaction for ledger "ledger-account-keep"
    And the indexer consumed a payment transaction creating account "B62qNewAccount" for ledger "ledger-account-reverted"
    When the indexer consumes a replacement transaction from source ledger "ledger-account-keep" to target ledger "ledger-account-replacement"
    Then account "B62qNewAccount" no longer exists

  Scenario: L2 rollback restores delegated account state
    Given the indexer consumed an account update for "B62qDelegator" with delegate "B62qDelegateA" on ledger "ledger-delegate-keep"
    And the indexer consumed an account update for "B62qDelegator" with delegate "B62qDelegateB" on ledger "ledger-delegate-reverted"
    When the indexer consumes a replacement transaction from source ledger "ledger-delegate-keep" to target ledger "ledger-delegate-replacement"
    Then account "B62qDelegator" has delegate "B62qDelegateA"
    And rollback account activity for "B62qDelegator" records delegate_before "B62qDelegateB" and delegate_after "B62qDelegateA"

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

  Scenario: Additional direct DA signers preserve the quorum attestation time
    Given batch for ledger "ledger-da-time" is attested from source "da-direct" at "2026-05-13T00:00:00.000Z" with signers "PK_A" and "PK_B"
    When the indexer consumes a valid DA signature for ledger "ledger-da-time" from "PK_C" at "2026-05-14T00:00:00.000Z"
    Then batch for ledger "ledger-da-time" keeps da_attested_at "2026-05-13T00:00:00.000Z"
    And batch for ledger "ledger-da-time" records DA signers "PK_A", "PK_B", and "PK_C"

  Scenario: Pending direct DA signatures keep precedence when proved finality creates the batch
    Given the indexer consumed valid DA signatures for ledger "ledger-da-direct-first" from "PK_A" and "PK_B"
    And the indexer consumed a payment transaction for ledger "ledger-da-direct-first"
    When the indexer consumes a proved finality message for ledger "ledger-da-direct-first"
    Then batch for ledger "ledger-da-direct-first" has da_status "attested" and da_source "da-direct"
    And no pending DA attestation remains for "ledger-da-direct-first"

  Scenario: Pending direct DA signatures use quorum time when the batch is later created
    Given the indexer consumed a valid DA signature for ledger "ledger-da-quorum-time" from "PK_A" at "2026-05-13T00:00:00.000Z"
    And the indexer consumes a valid DA signature for ledger "ledger-da-quorum-time" from "PK_B" at "2026-05-14T00:00:00.000Z"
    And the indexer consumed a payment transaction for ledger "ledger-da-quorum-time"
    When the indexer consumes a proved finality message for ledger "ledger-da-quorum-time"
    Then batch for ledger "ledger-da-quorum-time" has da_status "attested" and da_source "da-direct"
    And batch for ledger "ledger-da-quorum-time" keeps da_attested_at "2026-05-14T00:00:00.000Z"

  Scenario: Below-quorum direct DA signatures are persisted before batch creation
    Given the indexer consumed a valid DA signature for ledger "ledger-da-subquorum-pending" from "PK_A"
    Then pending DA attestation for "ledger-da-subquorum-pending" has source "da-direct"
    And pending DA attestation for "ledger-da-subquorum-pending" records DA signer "PK_A"

  Scenario: Sub-quorum direct DA signatures do not override proved finality
    Given the indexer consumed a valid DA signature for ledger "ledger-da-subquorum" from "PK_A"
    And the indexer consumed a payment transaction for ledger "ledger-da-subquorum"
    When the indexer consumes a proved finality message for ledger "ledger-da-subquorum"
    Then batch for ledger "ledger-da-subquorum" has da_status "attested" and da_source "proved"
    And batch for ledger "ledger-da-subquorum" records DA signer "PK_A"

  Scenario: L1 rollback preserves DA facts for later rebinding
    Given batch for ledger "ledger-da-3" is attested from source "settlement"
    When the indexer consumes an L1 rollback affecting settlement "settlement-ledger-da-3"
    Then batch for ledger "ledger-da-3" has settlement_status "pending"
    And batch for ledger "ledger-da-3" has no da_status
    And pending DA attestation for "ledger-da-3" has source "settlement"

  Scenario: Replayed rolled-back settlements do not restore orphaned L1 fields
    Given the indexer consumed a settlement message for ledger "ledger-l1-rollback-replay"
    When the indexer consumes an L1 rollback affecting settlement "settlement-ledger-l1-rollback-replay"
    And the indexer consumes a settlement message for ledger "ledger-l1-rollback-replay"
    Then batch for ledger "ledger-l1-rollback-replay" has settlement_status "pending"
    And batch for ledger "ledger-l1-rollback-replay" has no da_status
    And batch for ledger "ledger-l1-rollback-replay" has no l1_tx_hash

  Scenario: L1 rollback before settlement tombstones the delayed settlement
    Given the indexer consumed an L1 rollback affecting settlement "settlement-ledger-l1-rollback-before-batch"
    When the indexer consumes a settlement message for ledger "ledger-l1-rollback-before-batch"
    Then no batch row exists for ledger "ledger-l1-rollback-before-batch"

  Scenario: L1 rollback preserves direct DA signer details for later rebinding
    Given batch for ledger "ledger-da-rollback-signers" is directly attested with signers "PK_A" and "PK_B"
    When the indexer consumes an L1 rollback affecting settlement "settlement-ledger-da-rollback-signers"
    Then batch for ledger "ledger-da-rollback-signers" has no da_status
    And pending DA attestation for "ledger-da-rollback-signers" records DA signers "PK_A" and "PK_B"

  Scenario: Pending DA attestations are pruned after the max age
    Given pending DA attestation for "ledger-da-stale" was received 31 days ago
    When the pending DA pruner runs with a 30 day max age
    Then no pending DA attestation remains for "ledger-da-stale"

  Scenario: Pruning stale pending direct DA signatures clears signer buffers
    Given the indexer consumed a valid DA signature for ledger "ledger-da-pruned-signers" from "PK_A" at "2026-04-12T00:00:00.000Z"
    When the pending DA pruner runs with a 30 day max age
    And the indexer consumes a valid DA signature for ledger "ledger-da-pruned-signers" from "PK_B" at "2026-05-13T00:00:00.000Z"
    Then pending DA attestation for "ledger-da-pruned-signers" records only DA signer "PK_B"
    And pending DA attestation for "ledger-da-pruned-signers" has no attested_at

  Scenario: Restart resumes from durable sync state
    Given the indexer consumes a payment transaction for ledger "ledger-before-restart"
    When a new indexer instance uses the same store
    And the indexer consumes a payment transaction from source ledger "ledger-before-restart" to target ledger "ledger-after-restart"
    Then sync status for "l2-transactions" has last_hash "ledger-after-restart"

  Scenario: Indexer remains schema-blind at the package boundary
    Then the zeko-indexer source does not import "@zeko/contract-schema"
