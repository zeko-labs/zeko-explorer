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
- zkApp actions persist observed `before_action_state` and `action_state` from
  the event payload. This slice does not port Poseidon action-state derivation.
- Commandless diffs are classified as `genesis` when `genesis = true`, otherwise
  `fee_transfer`.
- Direct `zeko.da.signatures` ingestion is included because the WEB-426 schema
  already contains the additive Spike 007 columns, even though Milestone 1
  correctness only depends on proved and settlement-derived DA status.
