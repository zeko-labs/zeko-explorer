-- Migration 0003: PRD 5.2.5 / Spike 007 DA attestation status.
--
-- Extends the Spike 008 SurrealDB read model with baseline DA status
-- derivation storage and the future direct-signature detail columns described
-- by the PRD. Shared/live stacks should run this through SurrealKit rollout
-- tooling; disposable local databases can continue to use `surrealkit sync`.

DEFINE FIELD OVERWRITE target_ledger_hash ON TABLE batch TYPE option<string>;
UPDATE batch
SET target_ledger_hash = last_tx.target_ledger_hash
WHERE target_ledger_hash = NONE AND last_tx != NONE;
UPDATE batch
SET target_ledger_hash = (
  SELECT target_ledger_hash, sort_block_height
  FROM transaction
  WHERE batch = $parent.id
  ORDER BY sort_block_height ASC
  LIMIT 1
)[0].target_ledger_hash
WHERE target_ledger_hash = NONE;
UPDATE batch
SET target_ledger_hash = (
  SELECT target_ledger_hash, sort_block_height
  FROM ->batch_transaction->transaction
  ORDER BY sort_block_height ASC
  LIMIT 1
)[0].target_ledger_hash
WHERE target_ledger_hash = NONE;
DEFINE FIELD OVERWRITE target_ledger_hash ON TABLE batch TYPE string;

DEFINE FIELD OVERWRITE da_status ON TABLE batch TYPE option<"unknown" | "pending" | "attested" | "failed">;
UPDATE batch
SET da_status = NONE
WHERE da_status != "attested";
DEFINE FIELD OVERWRITE da_status ON TABLE batch TYPE option<"attested">;

DEFINE FIELD OVERWRITE da_source ON TABLE batch TYPE option<"settlement" | "proved" | "da-direct">;
DEFINE FIELD OVERWRITE da_attested_at ON TABLE batch TYPE option<datetime>;
DEFINE FIELD OVERWRITE da_implementation ON TABLE batch TYPE option<string>;
DEFINE FIELD OVERWRITE da_quorum_threshold ON TABLE batch TYPE option<int>;
DEFINE FIELD OVERWRITE da_signers ON TABLE batch TYPE option<array<object>>;
DEFINE FIELD OVERWRITE da_signers.*.publicKey ON TABLE batch TYPE string;
DEFINE FIELD OVERWRITE da_signers.*.instanceId ON TABLE batch TYPE string;
DEFINE FIELD OVERWRITE da_signers.*.signedAt ON TABLE batch TYPE datetime;
DEFINE INDEX OVERWRITE idx_batch_target_ledger_hash ON TABLE batch FIELDS target_ledger_hash UNIQUE;
DEFINE INDEX OVERWRITE idx_batch_da ON TABLE batch FIELDS da_status, sort_batch_height, id;

DEFINE TABLE OVERWRITE pending_da_attestation SCHEMAFULL;
DEFINE FIELD OVERWRITE ledger_hash ON TABLE pending_da_attestation TYPE string;
DEFINE FIELD OVERWRITE source ON TABLE pending_da_attestation TYPE "settlement" | "proved" | "da-direct";
DEFINE FIELD OVERWRITE attested_at ON TABLE pending_da_attestation TYPE option<datetime>;
DEFINE FIELD OVERWRITE received_at ON TABLE pending_da_attestation TYPE datetime;
DEFINE FIELD OVERWRITE implementation ON TABLE pending_da_attestation TYPE option<string>;
DEFINE FIELD OVERWRITE quorum_threshold ON TABLE pending_da_attestation TYPE option<int>;
DEFINE FIELD OVERWRITE signers ON TABLE pending_da_attestation TYPE option<array<object>>;
DEFINE FIELD OVERWRITE signers.*.publicKey ON TABLE pending_da_attestation TYPE string;
DEFINE FIELD OVERWRITE signers.*.instanceId ON TABLE pending_da_attestation TYPE string;
DEFINE FIELD OVERWRITE signers.*.signedAt ON TABLE pending_da_attestation TYPE datetime;
DEFINE FIELD OVERWRITE created_at ON TABLE pending_da_attestation TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD OVERWRITE updated_at ON TABLE pending_da_attestation TYPE datetime VALUE time::now();
DEFINE INDEX OVERWRITE idx_pending_da_hash ON TABLE pending_da_attestation FIELDS ledger_hash UNIQUE;
DEFINE INDEX OVERWRITE idx_pending_da_received_at ON TABLE pending_da_attestation FIELDS received_at, ledger_hash;
