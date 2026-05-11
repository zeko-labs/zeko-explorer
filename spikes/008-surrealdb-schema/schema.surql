-- Spike 008: SurrealDB schema for the Zeko explorer read model.
--
-- Conventions:
-- - The indexer assigns ULID record IDs for append-only indexed rows.
-- - Natural identifiers are unique secondary indexes.
-- - Tables are SCHEMAFULL so indexer payload drift fails at write time.
-- - Relation tables are ENFORCED so graph edges cannot point at missing rows.

--------------------------------------------------------------------------------
-- Migration ledger
--
-- Production should apply forward-only migration files and record each version
-- here. The consolidated schema uses OVERWRITE so the spike harness can reapply
-- it to fresh in-memory databases during tests.
--------------------------------------------------------------------------------

DEFINE TABLE OVERWRITE schema_migration SCHEMAFULL;
DEFINE FIELD OVERWRITE version ON TABLE schema_migration TYPE int;
DEFINE FIELD OVERWRITE name ON TABLE schema_migration TYPE string;
DEFINE FIELD OVERWRITE checksum ON TABLE schema_migration TYPE string;
DEFINE FIELD OVERWRITE applied_at ON TABLE schema_migration TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX OVERWRITE idx_schema_migration_version ON TABLE schema_migration FIELDS version UNIQUE;

--------------------------------------------------------------------------------
-- Runtime health and aggregate status
--
-- These rows are not GraphQL Relay nodes. They are singleton/status records used
-- by API _meta fields, the status page, and operator diagnostics.
--------------------------------------------------------------------------------

DEFINE TABLE OVERWRITE sync_status SCHEMAFULL;
DEFINE FIELD OVERWRITE source ON TABLE sync_status TYPE string;
DEFINE FIELD OVERWRITE status ON TABLE sync_status TYPE "healthy" | "degraded" | "paused" | "failed";
DEFINE FIELD OVERWRITE last_sequence ON TABLE sync_status TYPE option<int>;
DEFINE FIELD OVERWRITE last_hash ON TABLE sync_status TYPE option<string>;
DEFINE FIELD OVERWRITE last_height ON TABLE sync_status TYPE option<int>;
DEFINE FIELD OVERWRITE last_processed_at ON TABLE sync_status TYPE option<datetime>;
DEFINE FIELD OVERWRITE lag_seconds ON TABLE sync_status TYPE option<int>;
DEFINE FIELD OVERWRITE error ON TABLE sync_status TYPE option<string>;
DEFINE FIELD OVERWRITE updated_at ON TABLE sync_status TYPE datetime VALUE time::now();
DEFINE INDEX OVERWRITE idx_sync_status_source ON TABLE sync_status FIELDS source UNIQUE;
DEFINE INDEX OVERWRITE idx_sync_status_status ON TABLE sync_status FIELDS status;

DEFINE TABLE OVERWRITE network_stats SCHEMAFULL;
DEFINE FIELD OVERWRITE scope ON TABLE network_stats TYPE string;
DEFINE FIELD OVERWRITE latest_block_height ON TABLE network_stats TYPE option<int>;
DEFINE FIELD OVERWRITE latest_block_timestamp ON TABLE network_stats TYPE option<datetime>;
DEFINE FIELD OVERWRITE latest_batch_height ON TABLE network_stats TYPE option<int>;
DEFINE FIELD OVERWRITE transaction_count ON TABLE network_stats TYPE option<int>;
DEFINE FIELD OVERWRITE account_count ON TABLE network_stats TYPE option<int>;
DEFINE FIELD OVERWRITE bridge_operation_count ON TABLE network_stats TYPE option<int>;
DEFINE FIELD OVERWRITE tps_1m ON TABLE network_stats TYPE option<number>;
DEFINE FIELD OVERWRITE tps_5m ON TABLE network_stats TYPE option<number>;
DEFINE FIELD OVERWRITE updated_at ON TABLE network_stats TYPE datetime VALUE time::now();
DEFINE INDEX OVERWRITE idx_network_stats_scope ON TABLE network_stats FIELDS scope UNIQUE;

--------------------------------------------------------------------------------
-- L1 watcher durable state
--
-- Spike 006 requires the L1 watcher to recover after restarts without
-- republishing duplicate NATS messages or hiding partial source-data gaps.
-- These tables preserve watcher cursors, recent L1 block observations, and
-- deterministic Nats-Msg-Id publications.
--------------------------------------------------------------------------------

DEFINE TABLE OVERWRITE l1_watcher_cursor SCHEMAFULL;
DEFINE FIELD OVERWRITE source ON TABLE l1_watcher_cursor TYPE string;
DEFINE FIELD OVERWRITE network ON TABLE l1_watcher_cursor TYPE string;
DEFINE FIELD OVERWRITE provider ON TABLE l1_watcher_cursor TYPE string;
DEFINE FIELD OVERWRITE adapter ON TABLE l1_watcher_cursor TYPE "mina" | "ethereum";
DEFINE FIELD OVERWRITE cursor_kind ON TABLE l1_watcher_cursor TYPE "tip" | "outer_action" | "bridge_event" | "rollback";
DEFINE FIELD OVERWRITE last_block_height ON TABLE l1_watcher_cursor TYPE option<int>;
DEFINE FIELD OVERWRITE last_block_hash ON TABLE l1_watcher_cursor TYPE option<string>;
DEFINE FIELD OVERWRITE last_action_state ON TABLE l1_watcher_cursor TYPE option<string>;
DEFINE FIELD OVERWRITE last_published_msg_id ON TABLE l1_watcher_cursor TYPE option<string>;
DEFINE FIELD OVERWRITE limitations ON TABLE l1_watcher_cursor TYPE option<array<string>>;
DEFINE FIELD OVERWRITE updated_at ON TABLE l1_watcher_cursor TYPE datetime VALUE time::now();
DEFINE INDEX OVERWRITE idx_l1_cursor_unique ON TABLE l1_watcher_cursor FIELDS source, network, provider, cursor_kind UNIQUE;
DEFINE INDEX OVERWRITE idx_l1_cursor_health ON TABLE l1_watcher_cursor FIELDS network, provider, updated_at;

DEFINE TABLE OVERWRITE l1_watcher_block SCHEMAFULL;
DEFINE FIELD OVERWRITE network ON TABLE l1_watcher_block TYPE string;
DEFINE FIELD OVERWRITE provider ON TABLE l1_watcher_block TYPE string;
DEFINE FIELD OVERWRITE adapter ON TABLE l1_watcher_block TYPE "mina" | "ethereum";
DEFINE FIELD OVERWRITE height ON TABLE l1_watcher_block TYPE int;
DEFINE FIELD OVERWRITE hash ON TABLE l1_watcher_block TYPE string;
DEFINE FIELD OVERWRITE parent_hash ON TABLE l1_watcher_block TYPE string;
DEFINE FIELD OVERWRITE timestamp ON TABLE l1_watcher_block TYPE datetime;
DEFINE FIELD OVERWRITE canonical_status ON TABLE l1_watcher_block TYPE "canonical" | "orphaned" | "pending";
DEFINE FIELD OVERWRITE observed_at ON TABLE l1_watcher_block TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX OVERWRITE idx_l1_block_hash ON TABLE l1_watcher_block FIELDS network, provider, hash UNIQUE;
DEFINE INDEX OVERWRITE idx_l1_block_height ON TABLE l1_watcher_block FIELDS network, provider, height, hash;
DEFINE INDEX OVERWRITE idx_l1_block_status ON TABLE l1_watcher_block FIELDS network, provider, canonical_status, height;

DEFINE TABLE OVERWRITE l1_watcher_published SCHEMAFULL;
DEFINE FIELD OVERWRITE msg_id ON TABLE l1_watcher_published TYPE string;
DEFINE FIELD OVERWRITE subject ON TABLE l1_watcher_published TYPE string;
DEFINE FIELD OVERWRITE network ON TABLE l1_watcher_published TYPE string;
DEFINE FIELD OVERWRITE provider ON TABLE l1_watcher_published TYPE string;
DEFINE FIELD OVERWRITE source_hash ON TABLE l1_watcher_published TYPE option<string>;
DEFINE FIELD OVERWRITE source_height ON TABLE l1_watcher_published TYPE option<int>;
DEFINE FIELD OVERWRITE payload_hash ON TABLE l1_watcher_published TYPE string;
DEFINE FIELD OVERWRITE published_at ON TABLE l1_watcher_published TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX OVERWRITE idx_l1_published_msg ON TABLE l1_watcher_published FIELDS msg_id UNIQUE;
DEFINE INDEX OVERWRITE idx_l1_published_subject ON TABLE l1_watcher_published FIELDS subject, published_at;

--------------------------------------------------------------------------------
-- Current account state
--
-- `account` is mutable current state. Historical state transitions live in
-- `account_activity`, which is the source for account history and rollback
-- restoration. The account table intentionally stores raw zkApp state only;
-- labels/decoding stay in the contract registry layer from spike 003.
--------------------------------------------------------------------------------

DEFINE TABLE OVERWRITE account SCHEMAFULL;
DEFINE FIELD OVERWRITE id ON TABLE account TYPE string;
DEFINE FIELD OVERWRITE public_key ON TABLE account TYPE string;
DEFINE FIELD OVERWRITE token_id ON TABLE account TYPE string DEFAULT "1";
DEFINE FIELD OVERWRITE balance ON TABLE account TYPE string;
DEFINE FIELD OVERWRITE nonce ON TABLE account TYPE int;
DEFINE FIELD OVERWRITE delegate ON TABLE account TYPE option<record<account>>;
DEFINE FIELD OVERWRITE zkapp_state ON TABLE account TYPE option<array<string, 8>>;
DEFINE FIELD OVERWRITE action_state ON TABLE account TYPE option<array<string, 5>>;
DEFINE FIELD OVERWRITE verification_key_hash ON TABLE account TYPE option<string>;
DEFINE FIELD OVERWRITE zkapp_uri ON TABLE account TYPE option<string>;
DEFINE FIELD OVERWRITE first_seen_height ON TABLE account TYPE option<int>;
DEFINE FIELD OVERWRITE last_activity_height ON TABLE account TYPE option<int>;
DEFINE FIELD OVERWRITE last_activity_at ON TABLE account TYPE option<datetime>;
DEFINE FIELD OVERWRITE created_at ON TABLE account TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE updated_at ON TABLE account TYPE datetime VALUE time::now();
DEFINE INDEX OVERWRITE idx_account_public_key ON TABLE account FIELDS public_key UNIQUE;
DEFINE INDEX OVERWRITE idx_account_token ON TABLE account FIELDS token_id;
DEFINE INDEX OVERWRITE idx_account_delegate ON TABLE account FIELDS delegate;
DEFINE INDEX OVERWRITE idx_account_vkey ON TABLE account FIELDS verification_key_hash;
DEFINE INDEX OVERWRITE idx_account_last_activity ON TABLE account FIELDS last_activity_height, last_activity_at, id;
DEFINE INDEX OVERWRITE idx_account_search_pk ON TABLE account FIELDS public_key;

--------------------------------------------------------------------------------
-- L2 transaction feed
--
-- One Zeko "block" is one L2 transaction. Rows are append-mostly, but rollback
-- handling mutates `status` and `rollback_reason`. Natural keys are unique so
-- at-least-once NATS delivery can be retried safely without changing the ULID.
-- SurrealDB's b-tree indexes are most predictable in ascending order, so the
-- schema stores indexer-maintained negative sort keys for newest-first feeds.
-- Resolvers still expose `block_height DESC, tx_index DESC`; the database seeks
-- through `sort_block_height ASC, sort_tx_index ASC`.
--------------------------------------------------------------------------------

DEFINE TABLE OVERWRITE transaction SCHEMAFULL;
DEFINE FIELD OVERWRITE id ON TABLE transaction TYPE string;
DEFINE FIELD OVERWRITE hash ON TABLE transaction TYPE string;
DEFINE FIELD OVERWRITE sequence_number ON TABLE transaction TYPE int;
DEFINE FIELD OVERWRITE type ON TABLE transaction TYPE "payment" | "zkapp_command" | "fee_transfer" | "genesis" | "sync";
DEFINE FIELD OVERWRITE status ON TABLE transaction TYPE "applied" | "reverted";
DEFINE FIELD OVERWRITE sender ON TABLE transaction TYPE option<record<account>>;
DEFINE FIELD OVERWRITE receiver ON TABLE transaction TYPE option<record<account>>;
DEFINE FIELD OVERWRITE fee_payer ON TABLE transaction TYPE option<record<account>>;
-- Scalar public-key copies are deliberate feed keys. Keep record fields and graph
-- edges for bounded detail traversal; use these strings for high-volume account
-- and smart-contract transaction feeds so the index key is compact and stable.
DEFINE FIELD OVERWRITE sender_public_key ON TABLE transaction TYPE option<string>;
DEFINE FIELD OVERWRITE receiver_public_key ON TABLE transaction TYPE option<string>;
DEFINE FIELD OVERWRITE fee_payer_public_key ON TABLE transaction TYPE option<string>;
DEFINE FIELD OVERWRITE amount ON TABLE transaction TYPE option<string>;
DEFINE FIELD OVERWRITE fee ON TABLE transaction TYPE option<string>;
DEFINE FIELD OVERWRITE nonce ON TABLE transaction TYPE option<int>;
DEFINE FIELD OVERWRITE memo ON TABLE transaction TYPE option<string>;
DEFINE FIELD OVERWRITE block_height ON TABLE transaction TYPE int;
DEFINE FIELD OVERWRITE tx_index ON TABLE transaction TYPE int;
DEFINE FIELD OVERWRITE sort_block_height ON TABLE transaction TYPE int;
DEFINE FIELD OVERWRITE sort_tx_index ON TABLE transaction TYPE int;
DEFINE FIELD OVERWRITE timestamp ON TABLE transaction TYPE datetime;
DEFINE FIELD OVERWRITE source_ledger_hash ON TABLE transaction TYPE string;
DEFINE FIELD OVERWRITE target_ledger_hash ON TABLE transaction TYPE string;
DEFINE FIELD OVERWRITE batch ON TABLE transaction TYPE option<record<batch>>;
DEFINE FIELD OVERWRITE rollback_reason ON TABLE transaction TYPE option<string>;
DEFINE FIELD OVERWRITE raw_command ON TABLE transaction FLEXIBLE TYPE option<object>;
DEFINE FIELD OVERWRITE created_at ON TABLE transaction TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE updated_at ON TABLE transaction TYPE datetime VALUE time::now();
DEFINE INDEX OVERWRITE idx_tx_hash ON TABLE transaction FIELDS hash UNIQUE;
DEFINE INDEX OVERWRITE idx_tx_sequence ON TABLE transaction FIELDS sequence_number UNIQUE;
DEFINE INDEX OVERWRITE idx_tx_block_order ON TABLE transaction FIELDS block_height, tx_index UNIQUE;
DEFINE INDEX OVERWRITE idx_tx_feed ON TABLE transaction FIELDS sort_block_height, sort_tx_index, id;
DEFINE INDEX OVERWRITE idx_tx_sender_feed ON TABLE transaction FIELDS sender, sort_block_height, sort_tx_index, id;
DEFINE INDEX OVERWRITE idx_tx_receiver_feed ON TABLE transaction FIELDS receiver, sort_block_height, sort_tx_index, id;
DEFINE INDEX OVERWRITE idx_tx_fee_payer_feed ON TABLE transaction FIELDS fee_payer, sort_block_height, sort_tx_index, id;
DEFINE INDEX OVERWRITE idx_tx_sender_key_feed ON TABLE transaction FIELDS sender_public_key, sort_block_height, sort_tx_index, id;
DEFINE INDEX OVERWRITE idx_tx_receiver_key_feed ON TABLE transaction FIELDS receiver_public_key, sort_block_height, sort_tx_index, id;
DEFINE INDEX OVERWRITE idx_tx_fee_payer_key_feed ON TABLE transaction FIELDS fee_payer_public_key, sort_block_height, sort_tx_index, id;
DEFINE INDEX OVERWRITE idx_tx_status_feed ON TABLE transaction FIELDS status, sort_block_height, sort_tx_index, id;
DEFINE INDEX OVERWRITE idx_tx_type_feed ON TABLE transaction FIELDS type, sort_block_height, sort_tx_index, id;
DEFINE INDEX OVERWRITE idx_tx_target_ledger ON TABLE transaction FIELDS target_ledger_hash UNIQUE;
DEFINE INDEX OVERWRITE idx_tx_source_ledger ON TABLE transaction FIELDS source_ledger_hash;
DEFINE INDEX OVERWRITE idx_tx_batch_order ON TABLE transaction FIELDS batch, tx_index, id;

--------------------------------------------------------------------------------
-- Account activity log
--
-- Append-only per-account deltas. This table is deliberately denormalized so
-- account history pages do not need graph traversal and rollback code can
-- restore prior balances/nonces/zkApp state without replaying NATS.
--------------------------------------------------------------------------------

DEFINE TABLE OVERWRITE account_activity SCHEMAFULL;
DEFINE FIELD OVERWRITE id ON TABLE account_activity TYPE string;
DEFINE FIELD OVERWRITE account ON TABLE account_activity TYPE record<account>;
DEFINE FIELD OVERWRITE transaction ON TABLE account_activity TYPE record<transaction>;
DEFINE FIELD OVERWRITE role ON TABLE account_activity TYPE "sender" | "receiver" | "fee_payer" | "touched" | "delegate" | "rollback";
DEFINE FIELD OVERWRITE block_height ON TABLE account_activity TYPE int;
DEFINE FIELD OVERWRITE tx_index ON TABLE account_activity TYPE int;
DEFINE FIELD OVERWRITE activity_index ON TABLE account_activity TYPE int;
DEFINE FIELD OVERWRITE timestamp ON TABLE account_activity TYPE datetime;
DEFINE FIELD OVERWRITE balance_before ON TABLE account_activity TYPE option<string>;
DEFINE FIELD OVERWRITE balance_after ON TABLE account_activity TYPE option<string>;
DEFINE FIELD OVERWRITE nonce_before ON TABLE account_activity TYPE option<int>;
DEFINE FIELD OVERWRITE nonce_after ON TABLE account_activity TYPE option<int>;
DEFINE FIELD OVERWRITE zkapp_state_before ON TABLE account_activity TYPE option<array<string, 8>>;
DEFINE FIELD OVERWRITE zkapp_state_after ON TABLE account_activity TYPE option<array<string, 8>>;
DEFINE FIELD OVERWRITE action_state_before ON TABLE account_activity TYPE option<array<string, 5>>;
DEFINE FIELD OVERWRITE action_state_after ON TABLE account_activity TYPE option<array<string, 5>>;
DEFINE FIELD OVERWRITE target_ledger_hash ON TABLE account_activity TYPE string;
DEFINE FIELD OVERWRITE created_at ON TABLE account_activity TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX OVERWRITE idx_activity_unique ON TABLE account_activity FIELDS transaction, account, activity_index UNIQUE;
DEFINE INDEX OVERWRITE idx_activity_account_feed ON TABLE account_activity FIELDS account, block_height, tx_index, activity_index, id;
DEFINE INDEX OVERWRITE idx_activity_tx ON TABLE account_activity FIELDS transaction;
DEFINE INDEX OVERWRITE idx_activity_ledger ON TABLE account_activity FIELDS target_ledger_hash;

--------------------------------------------------------------------------------
-- Batch and data-availability state
--
-- `batch` is the lifecycle row shown by the explorer. `da_attestation` keeps raw
-- provider observations separate so spike 007 can change DA providers without
-- forcing a batch table rewrite.
--------------------------------------------------------------------------------

DEFINE TABLE OVERWRITE batch SCHEMAFULL;
DEFINE FIELD OVERWRITE id ON TABLE batch TYPE string;
DEFINE FIELD OVERWRITE batch_height ON TABLE batch TYPE int;
DEFINE FIELD OVERWRITE first_tx_height ON TABLE batch TYPE int;
DEFINE FIELD OVERWRITE last_tx_height ON TABLE batch TYPE int;
DEFINE FIELD OVERWRITE first_tx ON TABLE batch TYPE option<record<transaction>>;
DEFINE FIELD OVERWRITE last_tx ON TABLE batch TYPE option<record<transaction>>;
DEFINE FIELD OVERWRITE transaction_count ON TABLE batch TYPE int;
DEFINE FIELD OVERWRITE proof_status ON TABLE batch TYPE "pending" | "proved" | "failed";
DEFINE FIELD OVERWRITE settlement_status ON TABLE batch TYPE "pending" | "settling" | "finalized" | "rolled_back";
DEFINE FIELD OVERWRITE proved_at ON TABLE batch TYPE option<datetime>;
DEFINE FIELD OVERWRITE l1_chain ON TABLE batch TYPE option<string>;
DEFINE FIELD OVERWRITE l1_block_height ON TABLE batch TYPE option<int>;
DEFINE FIELD OVERWRITE l1_block_hash ON TABLE batch TYPE option<string>;
DEFINE FIELD OVERWRITE l1_tx_hash ON TABLE batch TYPE option<string>;
DEFINE FIELD OVERWRITE l1_confirmations ON TABLE batch TYPE option<int>;
DEFINE FIELD OVERWRITE l1_finality_level ON TABLE batch TYPE option<"detected" | "confirming" | "settling" | "finalized" | "canonical">;
DEFINE FIELD OVERWRITE da_status ON TABLE batch TYPE "unknown" | "pending" | "attested" | "failed";
DEFINE FIELD OVERWRITE da_attestation_hash ON TABLE batch TYPE option<string>;
DEFINE FIELD OVERWRITE submitted_at ON TABLE batch TYPE option<datetime>;
DEFINE FIELD OVERWRITE settled_at ON TABLE batch TYPE option<datetime>;
DEFINE FIELD OVERWRITE created_at ON TABLE batch TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE updated_at ON TABLE batch TYPE datetime VALUE time::now();
DEFINE INDEX OVERWRITE idx_batch_height ON TABLE batch FIELDS batch_height UNIQUE;
DEFINE INDEX OVERWRITE idx_batch_feed ON TABLE batch FIELDS batch_height, id;
DEFINE INDEX OVERWRITE idx_batch_settlement ON TABLE batch FIELDS settlement_status, batch_height, id;
DEFINE INDEX OVERWRITE idx_batch_l1_tx ON TABLE batch FIELDS l1_chain, l1_tx_hash UNIQUE;
DEFINE INDEX OVERWRITE idx_batch_da ON TABLE batch FIELDS da_status, batch_height, id;

DEFINE TABLE OVERWRITE da_attestation SCHEMAFULL;
DEFINE FIELD OVERWRITE id ON TABLE da_attestation TYPE string;
DEFINE FIELD OVERWRITE batch ON TABLE da_attestation TYPE record<batch>;
DEFINE FIELD OVERWRITE network ON TABLE da_attestation TYPE string;
DEFINE FIELD OVERWRITE attestation_hash ON TABLE da_attestation TYPE string;
DEFINE FIELD OVERWRITE status ON TABLE da_attestation TYPE "attested" | "failed";
DEFINE FIELD OVERWRITE provider ON TABLE da_attestation TYPE string;
DEFINE FIELD OVERWRITE da_block_height ON TABLE da_attestation TYPE option<int>;
DEFINE FIELD OVERWRITE confirmation_count ON TABLE da_attestation TYPE option<int>;
DEFINE FIELD OVERWRITE observed_at ON TABLE da_attestation TYPE datetime;
DEFINE FIELD OVERWRITE raw_payload ON TABLE da_attestation FLEXIBLE TYPE object;
DEFINE FIELD OVERWRITE created_at ON TABLE da_attestation TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX OVERWRITE idx_da_attestation_hash ON TABLE da_attestation FIELDS attestation_hash UNIQUE;
DEFINE INDEX OVERWRITE idx_da_attestation_batch ON TABLE da_attestation FIELDS batch, observed_at, id;

--------------------------------------------------------------------------------
-- Bridge action streams
--
-- These are raw normalized actions from the L1 watcher and L2 transaction
-- parser. They keep natural state-chain keys for efficient commit association,
-- but their primary record IDs remain ULIDs for Relay consistency.
--------------------------------------------------------------------------------

DEFINE TABLE OVERWRITE outer_action SCHEMAFULL;
DEFINE FIELD OVERWRITE id ON TABLE outer_action TYPE string;
DEFINE FIELD OVERWRITE after_state ON TABLE outer_action TYPE string;
DEFINE FIELD OVERWRITE before_state ON TABLE outer_action TYPE option<string>;
DEFINE FIELD OVERWRITE kind ON TABLE outer_action TYPE "commit" | "witness";
DEFINE FIELD OVERWRITE action_index ON TABLE outer_action TYPE int;
DEFINE FIELD OVERWRITE block_height ON TABLE outer_action TYPE int;
DEFINE FIELD OVERWRITE block_state_hash ON TABLE outer_action TYPE string;
DEFINE FIELD OVERWRITE timestamp ON TABLE outer_action TYPE datetime;
DEFINE FIELD OVERWRITE network ON TABLE outer_action TYPE string;
DEFINE FIELD OVERWRITE provider ON TABLE outer_action TYPE string;
DEFINE FIELD OVERWRITE global_slot ON TABLE outer_action TYPE option<int>;
DEFINE FIELD OVERWRITE distance_from_max_block_height ON TABLE outer_action TYPE option<int>;
DEFINE FIELD OVERWRITE txn_hash ON TABLE outer_action TYPE string;
DEFINE FIELD OVERWRITE fields ON TABLE outer_action TYPE array<string>;
DEFINE FIELD OVERWRITE slot_range_lower ON TABLE outer_action TYPE int;
DEFINE FIELD OVERWRITE slot_range_upper ON TABLE outer_action TYPE int;
DEFINE FIELD OVERWRITE marked_as_canonical_at ON TABLE outer_action TYPE option<datetime>;
DEFINE FIELD OVERWRITE ledger ON TABLE outer_action TYPE option<string>;
DEFINE FIELD OVERWRITE inner_action_state ON TABLE outer_action TYPE option<string>;
DEFINE FIELD OVERWRITE inner_action_state_length ON TABLE outer_action TYPE option<int>;
DEFINE FIELD OVERWRITE synchronized_outer_action_state ON TABLE outer_action TYPE option<string>;
DEFINE FIELD OVERWRITE synchronized_outer_action_state_length ON TABLE outer_action TYPE option<int>;
DEFINE FIELD OVERWRITE aux ON TABLE outer_action TYPE option<string>;
DEFINE FIELD OVERWRITE created_at ON TABLE outer_action TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE updated_at ON TABLE outer_action TYPE datetime VALUE time::now();
DEFINE INDEX OVERWRITE idx_oa_after_state ON TABLE outer_action FIELDS after_state UNIQUE;
DEFINE INDEX OVERWRITE idx_oa_before_state ON TABLE outer_action FIELDS before_state;
DEFINE INDEX OVERWRITE idx_oa_index ON TABLE outer_action FIELDS action_index UNIQUE;
DEFINE INDEX OVERWRITE idx_oa_aux ON TABLE outer_action FIELDS aux;
DEFINE INDEX OVERWRITE idx_oa_kind_feed ON TABLE outer_action FIELDS kind, block_height, action_index, id;
DEFINE INDEX OVERWRITE idx_oa_block_feed ON TABLE outer_action FIELDS block_height, action_index, id;
DEFINE INDEX OVERWRITE idx_oa_txn_hash ON TABLE outer_action FIELDS txn_hash;

DEFINE TABLE OVERWRITE inner_action SCHEMAFULL;
DEFINE FIELD OVERWRITE id ON TABLE inner_action TYPE string;
DEFINE FIELD OVERWRITE after_state ON TABLE inner_action TYPE string;
DEFINE FIELD OVERWRITE before_state ON TABLE inner_action TYPE option<string>;
DEFINE FIELD OVERWRITE action_index ON TABLE inner_action TYPE int;
DEFINE FIELD OVERWRITE block_height ON TABLE inner_action TYPE int;
DEFINE FIELD OVERWRITE timestamp ON TABLE inner_action TYPE datetime;
DEFINE FIELD OVERWRITE txn_hash ON TABLE inner_action TYPE string;
DEFINE FIELD OVERWRITE transaction ON TABLE inner_action TYPE option<record<transaction>>;
DEFINE FIELD OVERWRITE fields ON TABLE inner_action TYPE array<string>;
DEFINE FIELD OVERWRITE aux ON TABLE inner_action TYPE string;
DEFINE FIELD OVERWRITE marked_as_canonical_at ON TABLE inner_action TYPE option<datetime>;
DEFINE FIELD OVERWRITE target_ledger_hash ON TABLE inner_action TYPE string;
DEFINE FIELD OVERWRITE created_at ON TABLE inner_action TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE updated_at ON TABLE inner_action TYPE datetime VALUE time::now();
DEFINE INDEX OVERWRITE idx_ia_after_state ON TABLE inner_action FIELDS after_state UNIQUE;
DEFINE INDEX OVERWRITE idx_ia_before_state ON TABLE inner_action FIELDS before_state;
DEFINE INDEX OVERWRITE idx_ia_index ON TABLE inner_action FIELDS action_index UNIQUE;
DEFINE INDEX OVERWRITE idx_ia_aux ON TABLE inner_action FIELDS aux;
DEFINE INDEX OVERWRITE idx_ia_block_feed ON TABLE inner_action FIELDS block_height, action_index, id;
DEFINE INDEX OVERWRITE idx_ia_txn_hash ON TABLE inner_action FIELDS txn_hash;
DEFINE INDEX OVERWRITE idx_ia_transaction ON TABLE inner_action FIELDS transaction;
DEFINE INDEX OVERWRITE idx_ia_ledger ON TABLE inner_action FIELDS target_ledger_hash;

--------------------------------------------------------------------------------
-- zkApp event/action streams
--
-- Raw field arrays only. No decoded fields are stored because registry changes
-- must not require reindexing. Action rows also store before/after action-state
-- hashes so reducer action chains can be walked by indexed lookup.
--------------------------------------------------------------------------------

DEFINE TABLE OVERWRITE zkapp_event SCHEMAFULL;
DEFINE FIELD OVERWRITE id ON TABLE zkapp_event TYPE string;
DEFINE FIELD OVERWRITE transaction ON TABLE zkapp_event TYPE record<transaction>;
DEFINE FIELD OVERWRITE emitting_account ON TABLE zkapp_event TYPE record<account>;
DEFINE FIELD OVERWRITE event_index ON TABLE zkapp_event TYPE int;
DEFINE FIELD OVERWRITE block_height ON TABLE zkapp_event TYPE int;
DEFINE FIELD OVERWRITE tx_index ON TABLE zkapp_event TYPE int;
DEFINE FIELD OVERWRITE timestamp ON TABLE zkapp_event TYPE datetime;
DEFINE FIELD OVERWRITE fields ON TABLE zkapp_event TYPE array<string>;
DEFINE FIELD OVERWRITE sequence_number ON TABLE zkapp_event TYPE int;
DEFINE FIELD OVERWRITE target_ledger_hash ON TABLE zkapp_event TYPE string;
DEFINE FIELD OVERWRITE created_at ON TABLE zkapp_event TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX OVERWRITE idx_event_unique ON TABLE zkapp_event FIELDS transaction, emitting_account, event_index UNIQUE;
DEFINE INDEX OVERWRITE idx_event_account_feed ON TABLE zkapp_event FIELDS emitting_account, block_height, tx_index, event_index, id;
DEFINE INDEX OVERWRITE idx_event_tx ON TABLE zkapp_event FIELDS transaction;
DEFINE INDEX OVERWRITE idx_event_seq ON TABLE zkapp_event FIELDS sequence_number;
DEFINE INDEX OVERWRITE idx_event_ledger ON TABLE zkapp_event FIELDS target_ledger_hash;

DEFINE TABLE OVERWRITE zkapp_action SCHEMAFULL;
DEFINE FIELD OVERWRITE id ON TABLE zkapp_action TYPE string;
DEFINE FIELD OVERWRITE transaction ON TABLE zkapp_action TYPE record<transaction>;
DEFINE FIELD OVERWRITE emitting_account ON TABLE zkapp_action TYPE record<account>;
DEFINE FIELD OVERWRITE action_index ON TABLE zkapp_action TYPE int;
DEFINE FIELD OVERWRITE block_height ON TABLE zkapp_action TYPE int;
DEFINE FIELD OVERWRITE tx_index ON TABLE zkapp_action TYPE int;
DEFINE FIELD OVERWRITE timestamp ON TABLE zkapp_action TYPE datetime;
DEFINE FIELD OVERWRITE fields ON TABLE zkapp_action TYPE array<string>;
DEFINE FIELD OVERWRITE before_action_state ON TABLE zkapp_action TYPE string;
DEFINE FIELD OVERWRITE action_state ON TABLE zkapp_action TYPE string;
DEFINE FIELD OVERWRITE sequence_number ON TABLE zkapp_action TYPE int;
DEFINE FIELD OVERWRITE target_ledger_hash ON TABLE zkapp_action TYPE string;
DEFINE FIELD OVERWRITE created_at ON TABLE zkapp_action TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX OVERWRITE idx_action_unique ON TABLE zkapp_action FIELDS transaction, emitting_account, action_index UNIQUE;
DEFINE INDEX OVERWRITE idx_action_account_feed ON TABLE zkapp_action FIELDS emitting_account, block_height, tx_index, action_index, id;
DEFINE INDEX OVERWRITE idx_action_tx ON TABLE zkapp_action FIELDS transaction;
DEFINE INDEX OVERWRITE idx_action_state ON TABLE zkapp_action FIELDS action_state UNIQUE;
DEFINE INDEX OVERWRITE idx_action_before ON TABLE zkapp_action FIELDS before_action_state;
DEFINE INDEX OVERWRITE idx_action_seq ON TABLE zkapp_action FIELDS sequence_number;
DEFINE INDEX OVERWRITE idx_action_ledger ON TABLE zkapp_action FIELDS target_ledger_hash;

--------------------------------------------------------------------------------
-- Unified bridge operation lifecycle
--
-- This is the user-facing bridge read model. `(aux, aux_sequence)` remains the
-- FIFO collision key from spike 002, while ULID remains the primary record ID.
--
-- `data_quality` is a deterministic bridge evidence classification. It says
-- exactly whether the concrete source messages below were observed for the
-- concrete bridge_operation fields below. It is not a trust score, finality
-- flag, proof-validity flag, or economic correctness flag.
--
-- Source-to-field mapping:
-- - `zeko.l1.bridge-events` deposit event:
--   fills `type = "deposit"`, `sender`, `recipient`, `amount`, `aux`,
--   `timeout_slot`, `holder_account_l1`, `submit_tx_hash`,
--   `submit_block_height`, `submit_timestamp`, `source_network`,
--   `source_provider`.
-- - `zeko.l1.bridge-events` withdrawal-finalization event:
--   supplies user public key and withdrawal params for L1 finalization;
--   it cross-checks `sender`/`recipient`/`amount` for withdrawal rows.
-- - `zeko.l1.bridge-events` cancel-deposit event:
--   fills `cancel_tx_hash` and moves the matching deposit to `cancelled`.
-- - `zeko.l1.outer-actions` witness action from OUTER_PK:
--   fills `l1_witness_action_state`, `l1_witness_tx_hash`,
--   `l1_witness_block_height`, `l1_witness_timestamp`,
--   `l1_slot_range_lower`, `l1_slot_range_upper`, and creates an
--   `l1_action_link` edge with `role = "witness"`.
-- - `zeko.l1.outer-actions` commit action from OUTER_PK:
--   fills `commit_action_state` and creates an `l1_action_link` edge with
--   `role = "commit"` after walking the `inner_action` state chain covered by
--   the commit's `inner_action_state`.
-- - `zeko.l2.transactions` transaction containing an INNER_PK action:
--   creates an `inner_action` row, fills `l2_action_state`, `l2_tx_hash`,
--   `l2_block_height`, `l2_timestamp`, and creates an `l2_action_link` edge.
--   For withdrawals this same source also supplies `sender`, `recipient`, and
--   `amount` from the inner action fields `[recipient1, recipient2, amount]`.
-- - `zeko.l1.settlements` or new `zeko.l1.outer-actions` slot data:
--   provides the current L1 slot used to compute `timed_out` deposits and
--   `delay_passed` withdrawals. No separate bridge_operation field stores this
--   source payload.
-- - `zeko.l1.rollbacks` and L2 hash-chain breaks detected while consuming
--   `zeko.l2.transactions`:
--   fill `rollback_reason`, move affected rows to `rolled_back`, and remove or
--   relink invalidated `outer_action` / `inner_action` edges.
--
-- Status evidence requirements:
-- - deposit/submitted requires the `zeko.l1.bridge-events` deposit fields.
-- - deposit/l1_witnessed requires deposit/submitted plus OUTER_PK witness fields.
-- - deposit/committed requires deposit/l1_witnessed plus OUTER_PK commit fields.
-- - deposit/completed requires deposit/committed plus INNER_PK action fields.
-- - deposit/timed_out requires deposit not completed plus L1 slot data showing
--   `timeout_slot < current_l1_slot`.
-- - deposit/cancelled requires a `zeko.l1.bridge-events` cancel-deposit event.
-- - withdrawal/submitted and withdrawal/l2_witnessed require INNER_PK action
--   fields from `zeko.l2.transactions`.
-- - withdrawal/committed requires withdrawal/l2_witnessed plus OUTER_PK commit
--   fields.
-- - withdrawal/delay_passed requires withdrawal/committed plus L1 slot data
--   showing `current_l1_slot > commit.slot_range_upper + withdrawal_delay`.
-- - withdrawal/completed requires OUTER_PK witness fields from
--   `zeko.l1.outer-actions` and the L1 withdrawal-finalization event check when
--   available.
--
-- Classification:
-- - complete: all source messages required by the current `type/status` row were
--   observed directly and the corresponding fields above are populated.
-- - partial: at least one required source message is unavailable, but at least
--   one primary anchor exists (`submit_tx_hash`, `l2_tx_hash`, or
--   `l1_witness_action_state`). Missing fields stay NONE.
-- - inferred: a field above was populated from a named deterministic fallback
--   instead of its primary source; for example, deriving `aux` from an
--   `inner_action` row when `zeko.l1.bridge-events` is missing.
-- - unrecoverable: none of the source messages needed to anchor the operation
--   can be tied to `(aux, aux_sequence)` without guessing.
--
-- Maintenance algorithm:
-- 1. The TypeScript indexer owns `data_quality`; it is not manually edited by
--    operators and is not calculated by SurrealDB events.
-- 2. On each bridge-affecting message, the indexer upserts the concrete
--    `bridge_operation` fields that the message can prove.
-- 3. The indexer evaluates the required-evidence matrix above for the row's
--    current `type/status`.
-- 4. For every missing or inferred evidence item, the indexer upserts one
--    `bridge_quality_issue` row keyed by `(bridge_operation, reason)`.
-- 5. For every previously open issue that is now satisfied, the indexer sets
--    `bridge_quality_issue.resolved_at` and flips `is_open` to false.
-- 6. The denormalized summary on `bridge_operation` is then recomputed from open
--    issue rows: no open issues => `complete`; any open `unrecoverable` issue
--    => `unrecoverable`; else any open `inferred` issue => `inferred`; else
--    any open `partial` issue => `partial`.
-- 7. `data_quality_reasons` is the ordered list of open issue `reason` values.
--
-- V1 reason strings used by the spike:
-- - historical_bridge_events_unavailable
-- - historical_outer_actions_unavailable
-- - historical_inner_actions_unavailable
-- - inferred_from_l1_action_state
-- - inferred_from_l2_transaction
-- The indexer implementation should keep the required-evidence matrix in code
-- and update this comment/schema if new reason strings are introduced.
--------------------------------------------------------------------------------

DEFINE TABLE OVERWRITE bridge_operation SCHEMAFULL;
DEFINE FIELD OVERWRITE id ON TABLE bridge_operation TYPE string;
DEFINE FIELD OVERWRITE type ON TABLE bridge_operation TYPE "deposit" | "withdrawal";
DEFINE FIELD OVERWRITE status ON TABLE bridge_operation TYPE "submitted" | "l1_witnessed" | "l2_witnessed" | "committed" | "delay_passed" | "completed" | "timed_out" | "cancelled" | "rolled_back";
DEFINE FIELD OVERWRITE aux ON TABLE bridge_operation TYPE string;
DEFINE FIELD OVERWRITE aux_sequence ON TABLE bridge_operation TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE sender ON TABLE bridge_operation TYPE string;
DEFINE FIELD OVERWRITE recipient ON TABLE bridge_operation TYPE string;
DEFINE FIELD OVERWRITE amount ON TABLE bridge_operation TYPE string;
DEFINE FIELD OVERWRITE data_quality ON TABLE bridge_operation TYPE "complete" | "partial" | "inferred" | "unrecoverable" DEFAULT "complete";
DEFINE FIELD OVERWRITE data_quality_reasons ON TABLE bridge_operation TYPE option<array<string>>;
DEFINE FIELD OVERWRITE source_network ON TABLE bridge_operation TYPE option<string>;
DEFINE FIELD OVERWRITE source_provider ON TABLE bridge_operation TYPE option<string>;
DEFINE FIELD OVERWRITE submit_tx_hash ON TABLE bridge_operation TYPE option<string>;
DEFINE FIELD OVERWRITE submit_block_height ON TABLE bridge_operation TYPE int;
DEFINE FIELD OVERWRITE sort_submit_block_height ON TABLE bridge_operation TYPE int;
DEFINE FIELD OVERWRITE submit_timestamp ON TABLE bridge_operation TYPE datetime;
DEFINE FIELD OVERWRITE timeout_slot ON TABLE bridge_operation TYPE option<int>;
DEFINE FIELD OVERWRITE holder_account_l1 ON TABLE bridge_operation TYPE option<string>;
DEFINE FIELD OVERWRITE l1_witness_action_state ON TABLE bridge_operation TYPE option<string>;
DEFINE FIELD OVERWRITE l1_witness_tx_hash ON TABLE bridge_operation TYPE option<string>;
DEFINE FIELD OVERWRITE l1_witness_block_height ON TABLE bridge_operation TYPE option<int>;
DEFINE FIELD OVERWRITE l1_witness_timestamp ON TABLE bridge_operation TYPE option<datetime>;
DEFINE FIELD OVERWRITE l1_slot_range_lower ON TABLE bridge_operation TYPE option<int>;
DEFINE FIELD OVERWRITE l1_slot_range_upper ON TABLE bridge_operation TYPE option<int>;
DEFINE FIELD OVERWRITE l2_action_state ON TABLE bridge_operation TYPE option<string>;
DEFINE FIELD OVERWRITE l2_tx_hash ON TABLE bridge_operation TYPE option<string>;
DEFINE FIELD OVERWRITE l2_block_height ON TABLE bridge_operation TYPE option<int>;
DEFINE FIELD OVERWRITE l2_timestamp ON TABLE bridge_operation TYPE option<datetime>;
DEFINE FIELD OVERWRITE commit_action_state ON TABLE bridge_operation TYPE option<string>;
DEFINE FIELD OVERWRITE cancel_tx_hash ON TABLE bridge_operation TYPE option<string>;
DEFINE FIELD OVERWRITE rollback_reason ON TABLE bridge_operation TYPE option<string>;
DEFINE FIELD OVERWRITE created_at ON TABLE bridge_operation TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE updated_at ON TABLE bridge_operation TYPE datetime VALUE time::now();
DEFINE INDEX OVERWRITE idx_bo_aux_unique ON TABLE bridge_operation FIELDS aux, aux_sequence UNIQUE;
DEFINE INDEX OVERWRITE idx_bo_sender_feed ON TABLE bridge_operation FIELDS sender, sort_submit_block_height, aux, aux_sequence, id;
DEFINE INDEX OVERWRITE idx_bo_recipient_feed ON TABLE bridge_operation FIELDS recipient, sort_submit_block_height, aux, aux_sequence, id;
DEFINE INDEX OVERWRITE idx_bo_sender_type_feed ON TABLE bridge_operation FIELDS sender, type, sort_submit_block_height, aux, aux_sequence, id;
DEFINE INDEX OVERWRITE idx_bo_recipient_type_feed ON TABLE bridge_operation FIELDS recipient, type, sort_submit_block_height, aux, aux_sequence, id;
DEFINE INDEX OVERWRITE idx_bo_status_feed ON TABLE bridge_operation FIELDS status, sort_submit_block_height, aux, aux_sequence, id;
DEFINE INDEX OVERWRITE idx_bo_type_status_feed ON TABLE bridge_operation FIELDS type, status, sort_submit_block_height, aux, aux_sequence, id;
DEFINE INDEX OVERWRITE idx_bo_data_quality ON TABLE bridge_operation FIELDS data_quality, sort_submit_block_height, id;
DEFINE INDEX OVERWRITE idx_bo_submit_tx ON TABLE bridge_operation FIELDS submit_tx_hash;
DEFINE INDEX OVERWRITE idx_bo_l1_witness ON TABLE bridge_operation FIELDS l1_witness_action_state;
DEFINE INDEX OVERWRITE idx_bo_l2_action ON TABLE bridge_operation FIELDS l2_action_state;
DEFINE INDEX OVERWRITE idx_bo_commit ON TABLE bridge_operation FIELDS commit_action_state;
DEFINE INDEX OVERWRITE idx_bo_timeout ON TABLE bridge_operation FIELDS type, status, timeout_slot;

--------------------------------------------------------------------------------
-- Bridge evidence issues
--
-- Decision: do not expose incomplete bridge evidence by scanning
-- `bridge_operation.data_quality`. Low-cardinality quality filters degrade at
-- scale and are operator/product ambiguous. The indexer writes one
-- `bridge_quality_issue` row per non-complete reason. Operator issue lists read
-- this compact table; public bridge history still reads `bridge_operation`.
-- The 2.2M-row benchmark keeps this table out of public request paths until a
-- smaller public-facing queue/materialized severity bucket is measured.
--------------------------------------------------------------------------------

DEFINE TABLE OVERWRITE bridge_quality_issue SCHEMAFULL;
DEFINE FIELD OVERWRITE id ON TABLE bridge_quality_issue TYPE string;
DEFINE FIELD OVERWRITE bridge_operation ON TABLE bridge_quality_issue TYPE record<bridge_operation>;
DEFINE FIELD OVERWRITE aux ON TABLE bridge_quality_issue TYPE string;
DEFINE FIELD OVERWRITE aux_sequence ON TABLE bridge_quality_issue TYPE int;
DEFINE FIELD OVERWRITE type ON TABLE bridge_quality_issue TYPE "deposit" | "withdrawal";
DEFINE FIELD OVERWRITE status ON TABLE bridge_quality_issue TYPE "submitted" | "l1_witnessed" | "l2_witnessed" | "committed" | "delay_passed" | "completed" | "timed_out" | "cancelled" | "rolled_back";
DEFINE FIELD OVERWRITE data_quality ON TABLE bridge_quality_issue TYPE "partial" | "inferred" | "unrecoverable";
DEFINE FIELD OVERWRITE reason ON TABLE bridge_quality_issue TYPE string;
DEFINE FIELD OVERWRITE source_subject ON TABLE bridge_quality_issue TYPE option<string>;
DEFINE FIELD OVERWRITE missing_fields ON TABLE bridge_quality_issue TYPE option<array<string>>;
DEFINE FIELD OVERWRITE sender ON TABLE bridge_quality_issue TYPE option<string>;
DEFINE FIELD OVERWRITE recipient ON TABLE bridge_quality_issue TYPE option<string>;
DEFINE FIELD OVERWRITE submit_block_height ON TABLE bridge_quality_issue TYPE int;
DEFINE FIELD OVERWRITE sort_submit_block_height ON TABLE bridge_quality_issue TYPE int;
DEFINE FIELD OVERWRITE submit_timestamp ON TABLE bridge_quality_issue TYPE datetime;
DEFINE FIELD OVERWRITE detected_at ON TABLE bridge_quality_issue TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE resolved_at ON TABLE bridge_quality_issue TYPE option<datetime>;
DEFINE FIELD OVERWRITE is_open ON TABLE bridge_quality_issue TYPE bool DEFAULT true;
DEFINE INDEX OVERWRITE idx_bqi_unique ON TABLE bridge_quality_issue FIELDS bridge_operation, reason UNIQUE;
DEFINE INDEX OVERWRITE idx_bqi_open_feed ON TABLE bridge_quality_issue FIELDS is_open, data_quality, sort_submit_block_height, id;
DEFINE INDEX OVERWRITE idx_bqi_reason_feed ON TABLE bridge_quality_issue FIELDS reason, sort_submit_block_height, id;
DEFINE INDEX OVERWRITE idx_bqi_bridge ON TABLE bridge_quality_issue FIELDS bridge_operation;

--------------------------------------------------------------------------------
-- Graph relations
--
-- Open-ended feeds use indexed table scans. Graph edges are reserved for
-- bounded detail traversals where the relationship has role metadata or is
-- naturally many-to-many: transaction-account roles, batch containment, and
-- bridge correlations across L1/L2 actions and user-facing transactions.
--------------------------------------------------------------------------------

DEFINE TABLE OVERWRITE account_transaction TYPE RELATION IN transaction OUT account ENFORCED SCHEMAFULL;
DEFINE FIELD OVERWRITE role ON TABLE account_transaction TYPE "sender" | "receiver" | "fee_payer" | "touched";
DEFINE FIELD OVERWRITE amount_delta ON TABLE account_transaction TYPE option<string>;
DEFINE FIELD OVERWRITE account_public_key ON TABLE account_transaction TYPE option<string>;
DEFINE FIELD OVERWRITE sort_block_height ON TABLE account_transaction TYPE option<int>;
DEFINE FIELD OVERWRITE sort_tx_index ON TABLE account_transaction TYPE option<int>;
DEFINE FIELD OVERWRITE created_at ON TABLE account_transaction TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX OVERWRITE idx_account_tx_in ON TABLE account_transaction FIELDS in, role;
DEFINE INDEX OVERWRITE idx_account_tx_out ON TABLE account_transaction FIELDS out, role;
DEFINE INDEX OVERWRITE idx_account_tx_out_feed ON TABLE account_transaction FIELDS out, role, sort_block_height, sort_tx_index;
DEFINE INDEX OVERWRITE idx_account_tx_public_key_feed ON TABLE account_transaction FIELDS account_public_key, role, sort_block_height, sort_tx_index;
DEFINE INDEX OVERWRITE idx_account_tx_unique ON TABLE account_transaction FIELDS in, out, role UNIQUE;

DEFINE TABLE OVERWRITE batch_transaction TYPE RELATION IN batch OUT transaction ENFORCED SCHEMAFULL;
DEFINE FIELD OVERWRITE position ON TABLE batch_transaction TYPE int;
DEFINE FIELD OVERWRITE created_at ON TABLE batch_transaction TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX OVERWRITE idx_batch_tx_batch ON TABLE batch_transaction FIELDS in, position UNIQUE;
DEFINE INDEX OVERWRITE idx_batch_tx_transaction ON TABLE batch_transaction FIELDS out UNIQUE;

DEFINE TABLE OVERWRITE l1_action_link TYPE RELATION IN outer_action OUT bridge_operation ENFORCED SCHEMAFULL;
DEFINE FIELD OVERWRITE role ON TABLE l1_action_link TYPE "witness" | "commit";
DEFINE FIELD OVERWRITE created_at ON TABLE l1_action_link TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX OVERWRITE idx_l1_link_in ON TABLE l1_action_link FIELDS in, role;
DEFINE INDEX OVERWRITE idx_l1_link_out ON TABLE l1_action_link FIELDS out, role;
DEFINE INDEX OVERWRITE idx_l1_link_unique ON TABLE l1_action_link FIELDS in, out, role UNIQUE;

DEFINE TABLE OVERWRITE l2_action_link TYPE RELATION IN bridge_operation OUT inner_action ENFORCED SCHEMAFULL;
DEFINE FIELD OVERWRITE role ON TABLE l2_action_link TYPE "mint" | "burn";
DEFINE FIELD OVERWRITE created_at ON TABLE l2_action_link TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX OVERWRITE idx_l2_link_in ON TABLE l2_action_link FIELDS in, role;
DEFINE INDEX OVERWRITE idx_l2_link_out ON TABLE l2_action_link FIELDS out, role;
DEFINE INDEX OVERWRITE idx_l2_link_unique ON TABLE l2_action_link FIELDS in, out, role UNIQUE;

DEFINE TABLE OVERWRITE bridge_transaction_link TYPE RELATION IN bridge_operation OUT transaction ENFORCED SCHEMAFULL;
DEFINE FIELD OVERWRITE role ON TABLE bridge_transaction_link TYPE "submit" | "l1_witness" | "l2_finalize" | "cancel" | "rollback";
DEFINE FIELD OVERWRITE created_at ON TABLE bridge_transaction_link TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX OVERWRITE idx_bridge_tx_in ON TABLE bridge_transaction_link FIELDS in, role;
DEFINE INDEX OVERWRITE idx_bridge_tx_out ON TABLE bridge_transaction_link FIELDS out, role;
DEFINE INDEX OVERWRITE idx_bridge_tx_unique ON TABLE bridge_transaction_link FIELDS in, out, role UNIQUE;

--------------------------------------------------------------------------------
-- Edge cleanup events
--
-- Relation tables are ENFORCED, but explicit cleanup keeps rollback/delete paths
-- deterministic and makes the expected cascade behavior visible to implementers.
--------------------------------------------------------------------------------

DEFINE EVENT OVERWRITE cleanup_transaction_account_edges ON TABLE transaction
  WHEN $event = "DELETE"
  THEN (DELETE account_transaction WHERE in = $before.id);

DEFINE EVENT OVERWRITE cleanup_transaction_batch_edges ON TABLE transaction
  WHEN $event = "DELETE"
  THEN (DELETE batch_transaction WHERE out = $before.id);

DEFINE EVENT OVERWRITE cleanup_transaction_bridge_edges ON TABLE transaction
  WHEN $event = "DELETE"
  THEN (DELETE bridge_transaction_link WHERE out = $before.id);

DEFINE EVENT OVERWRITE cleanup_account_transaction_edges ON TABLE account
  WHEN $event = "DELETE"
  THEN (DELETE account_transaction WHERE out = $before.id);

DEFINE EVENT OVERWRITE cleanup_batch_transaction_edges ON TABLE batch
  WHEN $event = "DELETE"
  THEN (DELETE batch_transaction WHERE in = $before.id);

DEFINE EVENT OVERWRITE cleanup_outer_action_edges ON TABLE outer_action
  WHEN $event = "DELETE"
  THEN (DELETE l1_action_link WHERE in = $before.id);

DEFINE EVENT OVERWRITE cleanup_inner_action_edges ON TABLE inner_action
  WHEN $event = "DELETE"
  THEN (DELETE l2_action_link WHERE out = $before.id);

DEFINE EVENT OVERWRITE cleanup_bridge_operation_l1_edges ON TABLE bridge_operation
  WHEN $event = "DELETE"
  THEN (DELETE l1_action_link WHERE out = $before.id);

DEFINE EVENT OVERWRITE cleanup_bridge_operation_l2_edges ON TABLE bridge_operation
  WHEN $event = "DELETE"
  THEN (DELETE l2_action_link WHERE in = $before.id);

DEFINE EVENT OVERWRITE cleanup_bridge_operation_tx_edges ON TABLE bridge_operation
  WHEN $event = "DELETE"
  THEN (DELETE bridge_transaction_link WHERE in = $before.id);
