# TODO

## SurrealDB Spike 008 Reset

- [x] Stop optimizing by inventing manual feed/projection tables before proving the native SurrealDB model.
- [x] Re-center the data model around SurrealDB-native structures:
  - records and typed record links
  - relation tables and graph traversal
  - complex record IDs and record-ID range scans for time-ordered data
  - nested projections such as `metadata.{ ... }`
  - graph fetches such as `->edge->table`
  - native full-text search
  - native indexes, `EXPLAIN FULL`, and query planner evidence
- [x] For every hot query, run `EXPLAIN FULL` before changing schema or query shape.
- [x] Benchmark idiomatic SurrealQL shapes before introducing denormalized tables.
- [x] Only introduce materialized/projection tables after measured evidence shows the native model cannot meet the target.
- [x] Treat manually maintained feed tables as a last resort, not the default pattern.
- [x] Keep SurrealDB v3 as the benchmark and validation target.
- [x] Record every current optimization with:
  - original SurrealQL
  - `EXPLAIN FULL` output
  - revised SurrealQL
  - benchmark result
  - justification for any schema/model change

## Immediate Work

- [x] Add an `EXPLAIN` harness that runs against the same SurrealDB v3 Docker target as tests and benchmarks.
- [x] Build native query candidates for the current hot paths before changing the schema.
- [x] Compare current query plans against idiomatic graph/link/index alternatives.
- [x] Revisit existing manual feed tables and remove or demote them unless evidence proves they are required.

## Current Evidence

- [x] Removed `account_transaction_feed` and `bridge_operation_sender_feed`.
- [x] Removed `transaction_text`, `bridge_quality_open_queue`, and `bridge_quality_reason_queue`.
- [x] Replaced account transaction feeds with native `account_transaction` relation-table queries and indexes.
- [x] Replaced bridge sender feed with canonical `bridge_operation` indexes.
- [x] Replaced transaction search projection with native full-text search on canonical `transaction.search_text`.
- [x] Removed `bridge_quality_issue` and replaced bridge quality issue lists with derived queries over canonical `bridge_operation.data_quality` and indexed primary `data_quality_reasons[0]`.
- [x] Removed mutable `network_stats`; current status is derived from canonical tables with SurrealDB `COUNT` indexes and bounded timestamp scans.
- [x] Moved the SurrealKit-managed `database/` layout under `spikes/008-surrealdb-schema/surrealkit/` so the root no longer looks like a bespoke migration framework.
- [x] Added generated EXPLAIN comments to every query file; compound `RETURN` files point to component plans in `harness/reports/explain-current.md`, and `LIVE SELECT` files document why finite EXPLAIN does not apply.
- [x] Added `idx_tx_ledger` so rollback transaction lookup by `target_ledger_hash` uses an indexed path instead of scanning `transaction`.
- [x] Increased generated import chunking defaults to 20,000-row chunk files / 1,000-row insert batches for official `surreal import` paths. The accepted 100k chunked run uses 33 chunk files instead of 125 and avoids monolithic `data.surql`.
- [x] Tested the global transaction feed as a complex-record-ID range scan over `transaction:[sort_block_height, sort_tx_index, hash]`; rejected it after 100k persisted benchmark evidence and restored a canonical `idx_tx_connection_order` secondary index.
- [x] Added `EXPLAIN FULL` report generation at `spikes/008-surrealdb-schema/harness/reports/explain-current.md`.
- [x] Verified schema and behavior on `surrealdb/surrealdb:v3`: `pnpm run typecheck`, `pnpm run validate:schema`, `pnpm test`, `pnpm run explain:queries`.
- [x] 20k benchmark passed all budgets with 30 iterations.
- [x] Re-run the 100k benchmark after removing the leftover projection/read-model tables. Prior 100k failures are stale because they measured `transaction_text` and bridge quality queue shapes that no longer exist.
- [x] Reverted the `bridge_operation_text` projection. The bad bridge full-text benchmark remains evidence to investigate native SurrealDB search/query options on canonical `bridge_operation`.
- [x] Reviewed `account_activity` against the PRD and retained it as canonical per-account state-delta/audit history for rollback restoration, not as a manually maintained public feed shortcut.
- [x] Removed stale README/results claims that still described rejected feed/projection tables as accepted schema.
- [x] Added a Surreal Sync boundary: use it for supported PostgreSQL/JSONL/Kafka import or CDC proofs, not as a NATS JetStream indexer replacement without a supported bridge.
- [x] Rejected the global transaction feed complex-record-ID range after benchmark evidence: 100k persisted runs showed p95 2020.217ms and 4947.249ms. Replaced it with canonical `idx_tx_connection_order(sort_block_height, sort_tx_index, hash)`.
- [x] 100k persisted SurrealDB v3 benchmark passed after removing `bridge_quality_issue` and `network_stats`: 20k accounts, 100k transactions, 100k account activity rows, 100k bridge operations, initially 19 query paths, worst p95 119.026ms before later exact/search/zkApp/aggregation coverage was added.
- [x] Re-ran the 100k SurrealKit seed path with 5,000-row chunks: 125 seed files, 500s total load time, 497s spent in `surrealkit seed`, all 19 query paths still passed. This is accepted query evidence but not an acceptable long-term bulk-load story.
- [x] Attempted million-transaction persisted SurrealKit gate with 50k accounts, 1M transactions, 100k bridge operations, and activity stride 10. Generated seed files quickly, but SurrealKit seed throughput was too slow to reach the query phase in-turn (roughly hours at observed rate). Treat this as an official-tooling bulk-load blocker, not query performance proof.
- [x] Replaced the scale-load default with official SurrealDB v3 `surreal import` directly into a mounted SurrealKV store. SurrealKit remains the schema/migration authority; the generated load project emits `OPTION IMPORT` schema and data bundles from `surrealkit/database/schema/000_schema.surql`.
- [x] Re-ran the earlier 100k persisted default load with embedded `surreal import`: 20k accounts, 100k transactions, 100k account activity rows, 100k bridge operations, 19 query paths, 390s total load time, worst p95 119.026ms.
- [x] Tested deferred-index embedded import at 100k: schema import 2s and raw data import 19s, but combined index import failed with `Transaction retry required: memtable history insufficient for conflict detection`. Keep deferred indexing experimental until split index builds are proven.
- [x] Tested split deferred-index embedded import at 10k: it passed, but took 85s total because 100 separate index imports repeatedly reopened the SurrealKV store. This is worse than the 10k full-index embedded path and is not accepted as the default.
- [x] Removed redundant `idx_account_search_pk`; exact account lookup and exact search probes use the unique `idx_account_public_key` index, confirmed by `EXPLAIN FULL`.
- [x] Added explicit 100k benchmark coverage for exact `account-by-public-key`, exact `bridge-operation-by-natural-key`, `zkapp_event`/`zkapp_action` account timelines, and `network-throughput-by-minute`.
- [x] Raw canonical 24-hour time-bucket aggregation over `transaction` failed budget at 100k (`network-throughput-by-minute` p95 688.633ms against 500ms). Replaced only that analytical path with the official SurrealDB table-view pattern `transaction_minute_stats`; latest accepted 100k chunked p95 is 31.444ms.
- [x] Re-ran the 100k persisted default load with embedded `surreal import` after adding exact/search/zkApp/aggregation coverage and the table view: 20k accounts, 100k transactions, 100k account activity rows, 100k bridge operations, 26 query paths, 370s total load time, worst p95 114.415ms.
- [x] Attempted an indexed million-transaction embedded `surreal import` with the current full-index/table-view schema, 20k accounts, 1M transactions, 1M account activity rows, and 100k bridge operations. The run was killed with exit code 137 after about 41 minutes, before query timing.
- [x] Attempted the explicit million gate with activity stride 10: 50k accounts, 1M transactions, 100k account activity rows, and 100k bridge operations. It also exited 137 before query timing, after SurrealKV write stalls and about 44.5M internal sequence entries. Treat this as failed import evidence for full-index embedded import at million scale in local Docker, not as query-performance evidence.

## Next Optimization Targets

- [x] Investigate `accounts-search-text` with `EXPLAIN FULL`; canonical full-text uses `idx_account_search_text` and exact public-key lookup uses `idx_account_public_key`. Latest accepted 100k chunked p95: full-text 34.127ms, exact lookup 24.852ms.
- [x] Investigate `bridge-operations-search-text` with `EXPLAIN FULL`; canonical full-text uses `idx_bo_search_text` and exact natural-key lookup uses `idx_bo_aux_unique`. Latest accepted 100k chunked p95: full-text 36.583ms, exact lookup 30.400ms.
- [x] Evaluate remaining time-ordered per-account/event feeds against complex-record-ID range scans before keeping secondary feed indexes. Current `account_activity`, `zkapp_event`, and `zkapp_action` IDs are stable ULIDs for Relay identity and rollback references; account-local ordering is maintained by canonical secondary indexes. Latest accepted 100k chunked p95: account activity 30.888ms/31.642ms, zkApp events 32.264ms/33.049ms, zkApp actions 32.649ms/34.290ms.
- [x] Re-run `bridge-quality-issues-first-page` at 100k+ rows on canonical `bridge_operation WHERE data_quality = $data_quality` with a full filter+order `idx_bo_data_quality(data_quality, sort_submit_block_height, aux, aux_sequence, id)` index. Latest 100k chunked p95: 32.924ms.
- [x] Re-run `transaction-by-hash` in isolation and decide whether the 100ms budget is below the Docker HTTP runner floor or whether the query path needs a direct record-key lookup strategy. Latest accepted 100k chunked p95 is 25.478ms via unique `idx_tx_hash`, so no direct record-key lookup change is needed.
- [ ] Resolve million-row official bulk-load path with the full realistic schema/index set. Current evidence:
  - Docker embedded monolithic `surreal import` into SurrealKV is retained only as historical 100k evidence: 370s load, 26/26 query paths passed, worst p95 114.415ms.
  - Docker embedded monolithic million imports failed with exit 137 before query timing under the local Docker Desktop 4GB memory limit; this path is rejected for the million-row gate.
  - Docker live chunk import with host v3 CLI and 20,000-row chunks passed the 100k full-index gate: 486s load, 26/26 query paths passed, worst p95 37.744ms. This is the current accepted 100k evidence because it avoids monolithic import files.
  - Added a host streaming importer that writes one bounded `.surql` chunk, imports it with official `surreal import`, deletes it, and proceeds. Small persisted and memory checks pass. This is the correct low-disk loader shape because it avoids holding the full generated import set beside the database.
  - Docker live million import no longer fails because of a single file, but OrbStack stopped mid-run on this machine.
  - Host persisted SurrealKV million import is currently environment-blocked: with ~3.6GB free, non-streaming hit `No space left on device` around 540k transactions during compaction; streaming avoided generated-file amplification but still extrapolated beyond available disk by 200k transactions. Memory mode was also stopped before million because the 8GB host began swapping.
  - `surreal start --import-file` is not viable for this schema: schema-only startup import hits v3 startup retry/namespace failure around 60s.
  - RocksDB embedded import is not viable in this harness: schema import reported success but the process did not exit.
  - Live-server monolithic `surreal import` works but is slower at 10k than embedded import.
  - SurrealKit `seed` works but is slower than direct `surreal import`.
  - Direct parallel HTTP SQL loading is rejected: it hits HTTP body limits and transaction write-conflict retries under indexed writes.
  - Embedded chunk import is rejected: it avoids single-file memory pressure but repeated embedded opens produced an enforced relation failure at 100k.
  - Live-server chunked `surreal import` is memory-bounded and reached query timing at 100k, but loaded in 1115s and missed immediate p95 budgets for bridge quality and one zkApp path.
  - Host macOS v3.0.5 monolithic import removed Docker's memory cap but was slower than Docker at 100k and was stopped after roughly 12 minutes.
  Next accepted avenue: run `benchmark:host:million:stream` or `benchmark:docker:million` on a machine/volume with enough disk and memory headroom for the real persisted full-index database and compaction. Do not remove/defer indexes, add manual feed/projection tables, create a monolithic million-row import file, or route through Kafka/PostgreSQL solely for benchmark loading.
- [x] For time-bucketed analytics beyond current status counters, benchmark native aggregation queries and table views/drop-table patterns before adding any manual aggregate table. Raw native aggregation failed; official SurrealDB table view passed. No hand-maintained aggregate/projection table was added.
