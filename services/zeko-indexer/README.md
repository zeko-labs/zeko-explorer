# @zeko/zeko-indexer

Unified Zeko indexer runtime projection logic.

This package consumes the shared NATS event contracts and materializes the
runtime rows defined by the PRD and the WEB-426 database schema branch. The core
indexer is intentionally tested through Gherkin/Vitest scenarios over a store
boundary so rollback, DA status derivation, ULID assignment, and zkApp
schema-blind ingestion can be verified without coupling tests to private helper
functions.

## WEB-427 Review Notes

Implementation choices not explicitly described in the PRD:

- The first slice uses an in-memory store adapter for executable BDD coverage.
  A SurrealDB-backed adapter and JetStream drain loop are still needed to run the
  service against deployed infrastructure.
- Bridge-specific `l1.outer-actions`, `l1.bridge-events`, `inner_action`, and
  `bridge_operation` projection is not included in this WEB-427 slice.
- L2 `block_height` and `sequence_number` currently come from local consumption
  order because the current `zeko.l2.transactions` contract does not carry an
  explicit L2 height.
- The in-memory account projection keys rows by `(public_key, token_id)` and
  defaults public-key lookups to token `"1"` so custom-token accounts do not
  overwrite the default token account.
- zkApp actions with raw action arrays bind `before_action_state` / `action_state`
  from the pre/post account `action_state` snapshot vector. This slice does not
  port Poseidon action-state derivation.
- Commandless diffs are classified as `genesis` when `genesis = true`, otherwise
  `fee_transfer`.
- Direct `zeko.da.signatures` ingestion is included because the WEB-426 schema
  already contains the additive Spike 007 columns, even though Milestone 1
  correctness only depends on proved and settlement-derived DA status.
- L1 rollback settlement tombstones are tracked in the store boundary so
  at-least-once replay of an orphaned settlement ID cannot rebind cleared L1
  fields, including when the rollback fact arrives before the matching batch
  exists.
- Late proved-finality or settlement facts for L2-reverted ledger hashes are
  ignored once the store contains reverted transactions for that target ledger,
  so stale messages cannot create pending DA rows or zero-transaction batches.
