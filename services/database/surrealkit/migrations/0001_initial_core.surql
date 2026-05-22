-- Migration 0001: representative initial core schema.
--
-- Purpose:
-- - Provide the smallest schema that could have existed before spike 006 added
--   L1 watcher recovery state and bridge data-quality metadata.
-- - Give the executable Cucumber migration scenario real existing data to
--   migrate, instead of only proving that DDL parses on an empty database.
--
-- This is intentionally narrower than the SurrealKit desired-state schema. The
-- consolidated schema is the target; this file exists to prove forward
-- migration behavior.

-- Current account rows. This first migration knows only the fields needed by
-- early transaction and bridge fixtures.
DEFINE TABLE OVERWRITE account SCHEMAFULL;
DEFINE FIELD OVERWRITE id ON TABLE account TYPE string;
DEFINE FIELD OVERWRITE public_key ON TABLE account TYPE string;
DEFINE FIELD OVERWRITE token_id ON TABLE account TYPE string DEFAULT "1";
DEFINE FIELD OVERWRITE balance ON TABLE account TYPE string;
DEFINE FIELD OVERWRITE nonce ON TABLE account TYPE int;
DEFINE FIELD OVERWRITE created_at ON TABLE account TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE updated_at ON TABLE account TYPE datetime VALUE time::now();
DEFINE INDEX OVERWRITE idx_account_public_key ON TABLE account FIELDS public_key UNIQUE;

-- Early transaction feed. Later schema versions add role-specific indexes,
-- batch links, rollback reason, and raw command metadata.
DEFINE TABLE OVERWRITE transaction SCHEMAFULL;
DEFINE FIELD OVERWRITE id ON TABLE transaction TYPE string;
DEFINE FIELD OVERWRITE hash ON TABLE transaction TYPE string;
DEFINE FIELD OVERWRITE sequence_number ON TABLE transaction TYPE int;
DEFINE FIELD OVERWRITE type ON TABLE transaction TYPE "payment" | "zkapp_command" | "fee_transfer" | "genesis" | "sync";
DEFINE FIELD OVERWRITE status ON TABLE transaction TYPE "applied" | "reverted";
DEFINE FIELD OVERWRITE sender ON TABLE transaction TYPE option<record<account>>;
DEFINE FIELD OVERWRITE receiver ON TABLE transaction TYPE option<record<account>>;
DEFINE FIELD OVERWRITE block_height ON TABLE transaction TYPE int;
DEFINE FIELD OVERWRITE tx_index ON TABLE transaction TYPE int;
DEFINE FIELD OVERWRITE timestamp ON TABLE transaction TYPE datetime;
DEFINE FIELD OVERWRITE source_ledger_hash ON TABLE transaction TYPE string;
DEFINE FIELD OVERWRITE target_ledger_hash ON TABLE transaction TYPE string;
DEFINE INDEX OVERWRITE idx_tx_hash ON TABLE transaction FIELDS hash UNIQUE;

-- Early bridge operation table. Migration 0002 proves that adding data-quality
-- metadata can preserve and backfill rows already written by this shape.
DEFINE TABLE OVERWRITE bridge_operation SCHEMAFULL;
DEFINE FIELD OVERWRITE id ON TABLE bridge_operation TYPE string;
DEFINE FIELD OVERWRITE type ON TABLE bridge_operation TYPE "deposit" | "withdrawal";
DEFINE FIELD OVERWRITE status ON TABLE bridge_operation TYPE "submitted" | "l1_witnessed" | "l2_witnessed" | "committed" | "delay_passed" | "completed" | "timed_out" | "cancelled" | "rolled_back";
DEFINE FIELD OVERWRITE aux ON TABLE bridge_operation TYPE string;
DEFINE FIELD OVERWRITE aux_sequence ON TABLE bridge_operation TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE sender ON TABLE bridge_operation TYPE string;
DEFINE FIELD OVERWRITE recipient ON TABLE bridge_operation TYPE string;
DEFINE FIELD OVERWRITE amount ON TABLE bridge_operation TYPE string;
DEFINE FIELD OVERWRITE submit_tx_hash ON TABLE bridge_operation TYPE option<string>;
DEFINE FIELD OVERWRITE submit_block_height ON TABLE bridge_operation TYPE int;
DEFINE FIELD OVERWRITE submit_timestamp ON TABLE bridge_operation TYPE datetime;
DEFINE FIELD OVERWRITE created_at ON TABLE bridge_operation TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE updated_at ON TABLE bridge_operation TYPE datetime VALUE time::now();
DEFINE INDEX OVERWRITE idx_bo_aux_unique ON TABLE bridge_operation FIELDS aux, aux_sequence UNIQUE;
DEFINE INDEX OVERWRITE idx_bo_sender_order ON TABLE bridge_operation FIELDS sender, submit_block_height, submit_timestamp, aux, aux_sequence, id;

-- Migration ledger insert. Production tooling should calculate real checksums;
-- the spike uses stable labels so the scenario can assert ordering.
