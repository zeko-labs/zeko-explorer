-- Migration 0002: spike-006 L1 watcher consistency additions.
--
-- Adds:
-- - bridge_operation.data_quality and data_quality_reasons so APIs can expose
--   partial/inferred/unrecoverable bridge records instead of pretending all
--   empty histories are authoritative.
-- - l1_watcher_cursor for durable restart cursors and source limitations.
-- - l1_watcher_published for deterministic Nats-Msg-Id idempotency.
--
-- The UPDATE below is the important data-bearing proof: existing bridge rows
-- created before this migration are backfilled to `complete` and receive the
-- explicit ascending sort key used by newest-first bridge feeds.

DEFINE FIELD OVERWRITE data_quality ON TABLE bridge_operation TYPE "complete" | "partial" | "inferred" | "unrecoverable" DEFAULT "complete";
DEFINE FIELD OVERWRITE data_quality_reasons ON TABLE bridge_operation TYPE option<array<string>>;
DEFINE FIELD OVERWRITE source_network ON TABLE bridge_operation TYPE option<string>;
DEFINE FIELD OVERWRITE source_provider ON TABLE bridge_operation TYPE option<string>;
DEFINE FIELD OVERWRITE sort_submit_block_height ON TABLE bridge_operation TYPE int;

UPDATE bridge_operation
SET
  data_quality = "complete",
  sort_submit_block_height = 0 - submit_block_height
WHERE data_quality = NONE OR sort_submit_block_height = NONE;

DEFINE INDEX OVERWRITE idx_bo_data_quality ON TABLE bridge_operation FIELDS data_quality, sort_submit_block_height, id;

-- Materialized issue table. This is the scale decision for browsing incomplete
-- bridge evidence: do not scan all bridge_operation rows by low-cardinality
-- `data_quality`; write one compact issue row per reason instead.
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
DEFINE INDEX OVERWRITE idx_bqi_unique ON TABLE bridge_quality_issue FIELDS bridge_operation, reason UNIQUE;
DEFINE INDEX OVERWRITE idx_bqi_open_feed ON TABLE bridge_quality_issue FIELDS resolved_at, data_quality, sort_submit_block_height, id;
DEFINE INDEX OVERWRITE idx_bqi_reason_feed ON TABLE bridge_quality_issue FIELDS reason, sort_submit_block_height, id;
DEFINE INDEX OVERWRITE idx_bqi_bridge ON TABLE bridge_quality_issue FIELDS bridge_operation;

-- Durable cursor per source/network/provider/cursor kind. This gives the L1
-- watcher independent progress tracking for tip, outer-action, bridge-event,
-- and rollback loops.
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

-- Publication ledger. The watcher records each deterministic Nats-Msg-Id it
-- successfully emits, which prevents duplicate replay after process restarts.
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

CREATE schema_migration:0002 SET version = 2, name = "l1_watcher_and_bridge_quality", checksum = "spike008-0002";
