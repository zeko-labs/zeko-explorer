# Spike 008: Full SurrealDB Schema — Tables, Record IDs, Indexes, Edges

**Status:** Ready for review
**Blocking:** Milestone 1 (indexer + GraphQL API)
**Owner:** TBD

---

## Working Artifacts

- [`results.html`](results.html) — consolidated decisions, cross-spike reconciliation, validation, and benchmark evidence.
- [`surrealkit/`](surrealkit/) — explicit SurrealKit project layout; `surrealkit/database/schema/000_schema.surql` is the SurrealKit-managed desired state.
- [`queries/`](queries/) — one SurrealQL file per planned query/access path.
- [`harness/`](harness/) — runnable TypeScript test and benchmark harness managed by pnpm.
- [`harness/features/`](harness/features/) — Cucumber acceptance suite that runs against in-memory SurrealDB.
- [`surrealkit/migrations/`](surrealkit/migrations/) — representative SurrealKit-applied rollout SQL with existing data.
- [`harness/benchmarks/`](harness/benchmarks/) — benchmark runner and latest measured HTML output.

## Running the Evidence

```sh
cd spikes/008-surrealdb-schema/harness
pnpm install
pnpm run typecheck
pnpm test
pnpm run validate:schema
pnpm run benchmark:docker:persisted
```

`surrealkit/` is the explicit SurrealKit project root. Its nested `database/` directory is the official SurrealKit layout, not a separate home-grown database layer.

`benchmark:docker:persisted` generates a temporary SurrealKit-compatible load project from the committed `surrealkit/` schema, applies schema with official SurrealKit sync, imports deterministic data through sequential official SurrealDB v3 `surreal import` chunk files into a persisted SurrealKV Docker volume, points the TypeScript query-timing harness at the loaded database, and removes both the container and volume when the run exits. At the time of the accepted run, `surrealdb/surrealdb:v3` resolved to `3.0.5 for linux on aarch64`. Full schema/index coverage remains the job of `pnpm run validate:schema` and the Cucumber inventory tests.

`pnpm run benchmark` is only a small local query-shape smoke test. It refuses large self-seeded datasets; scale evidence must use `benchmark:docker:persisted` so row loading goes through official SurrealDB import tooling rather than the harness HTTP SQL client.

The old persisted evidence run was produced before the benchmark target was moved to SurrealDB v3 and before rejected projection/feed tables were removed. It used:

```sh
BENCH_TX_COUNT=2200000 \
BENCH_ACCOUNT_COUNT=50000 \
BENCH_CONTRACT_ACCOUNT_COUNT=500 \
BENCH_BRIDGE_COUNT=220000 \
BENCH_ITERATIONS=5 \
BENCH_SEED_CHUNK_ROWS=50000 \
BENCH_ACTIVITY_STRIDE=10 \
pnpm run benchmark:docker:persisted
```

That result is now retained only as historical rejected evidence, not as acceptance proof for the current model. The accepted scale gates are 100k, million-row, 20M, 200M, and 2B transactions via `benchmark:docker:persisted` against SurrealDB v3 and the canonical schema; the harness fails on p95 budget violations.

The current accepted persisted evidence is:

```sh
BENCH_ACCOUNT_COUNT=20000 \
BENCH_TX_COUNT=100000 \
BENCH_BRIDGE_COUNT=100000 \
BENCH_ITERATIONS=30 \
pnpm run benchmark:docker:persisted
```

That run loaded via official `surreal import` directly into Dockerized `surrealdb/surrealdb:v3` with persisted SurrealKV and passed all 26 measured query paths after removing manual feed/projection tables and adding explicit exact lookup, native full-text, zkApp timeline, and time-series aggregate coverage. The latest accepted 100k full-index run uses sequential official import chunks with 20,000-row chunk files and no monolithic `data.surql`: 486s total load, 482s data import, and all 26 query paths passed. Worst p95 was `transaction-feed-first-page` at 37.744ms against a 250ms budget.

A million-transaction gate was attempted with 50k accounts, 1M transactions, 2M `account_transaction` relation edges, 100k account activity rows, 10k zkApp events, 10k zkApp actions, 100k bridge operations, and the full index/search/table-view schema. The monolithic embedded Docker import is rejected: it exited 137 under the local 4GB Docker limit. Docker live chunk import avoided the monolithic file, but OrbStack stopped mid-run. Host SurrealKV chunk import avoided Docker memory limits, but the machine had only ~3.6GB free and SurrealKV hit `No space left on device` during compaction. A streaming host importer now generates one bounded `.surql` chunk, imports it with official `surreal import`, deletes it, and continues; this fixes the harness disk amplification from generated files, but persisted million-row proof is still blocked by local disk capacity. Memory-backed streaming mode was also tested and stopped because the 8GB host began swapping before the million gate. The next scale gate needs a machine/volume with enough disk headroom for the real persisted DB and compaction, not schema shortcuts, index deferral, manual projections, or Kafka/PostgreSQL detours.

---

## Context

Earlier spikes have settled individual pieces of the data layer in isolation:

- Spike 002 (bridge correlation) defines the `bridge_operation` table — composite `(aux, aux_sequence)` correlation, FIFO disambiguation, status lifecycle, indexes for the `(sender|recipient)` pubkey filter.
- Spike 005 (Relay pagination) commits us to stable Relay-visible record IDs and keyset pagination. This spike keeps ULIDs where they do not harm scale, uses complete cursor tuples, and accepts canonical secondary indexes when `EXPLAIN FULL` plus benchmarks prove them faster than record-ID range scans.
- Spikes 001 / 006 / 007 produce the upstream events (sequencer connector, L1 watcher, DA monitor) that the indexer projects into rows.

What is **not** yet designed is the union of those decisions: a single coherent SurrealDB schema covering every entity the indexer writes and the GraphQL API reads. The indexer cannot be built — and the GraphQL resolvers cannot be authored — without it.

This spike produces that schema.

---

## Scope

All persistent state in the explorer's own database. **In scope**:

- `transaction` — sequencer-confirmed L2 transactions (payments, zkApp commands, etc.).
- `account` — current state for every account that has ever appeared (nonce, balance, zkApp state if applicable).
- `account_activity` — append-only log of state transitions per account, used for "account history" queries.
- `account_transaction` — typed transaction/account relation edges with role metadata for sender, receiver, fee-payer, touched-account, and contract feeds.
- `batch` — L2 batches with their L1 settlement and DA attestation status.
- `outer_action` / `inner_action` — zkApp action stream, normalized for query.
- `zkapp_event` — zkApp event stream.
- `bridge_operation` — settled in spike 002; included here for completeness and cross-check.
- Bridge evidence issue lists — derived from canonical `bridge_operation.data_quality` and `data_quality_reasons`.
- Network aggregate status — derived from canonical tables with SurrealDB aggregation/count indexes.
- Native full-text indexes on canonical `transaction`, `account`, and `bridge_operation` search fields using SurrealDB analyzers and search functions.
- Live-query files for transaction, account-transaction, bridge-operation, and sync-status SSE subscriptions.
- Any additional tables required by the GraphQL types defined in the PRD.

**Out of scope**: Mina archive node schema, OCaml side, NATS subject formats. This spike only covers the **explorer's own SurrealDB** instance.

---

## Questions to Answer

### 1. Table inventory

- What is the complete set of tables? Map every GraphQL type in the PRD to either a SurrealDB table, a derived view, or an in-memory join.
- Which tables are **append-only** (transaction, action, event, account_activity, bridge_operation history rows) versus **mutable current-state** (account, the latest bridge_operation row)?
- Where does derived/denormalized state live (e.g., `account.last_activity_at`)? How is it kept consistent with the source-of-truth tables?

### 2. Record ID format

- All indexed rows use **ULID** primary keys (per spike 005). Which tables, exactly, get a ULID? Are there tables whose natural key (e.g., `account` keyed by public key, `batch` keyed by L1 tx hash) is a better record ID?
- For tables where ULID is the primary key: does the natural identifier (tx hash, batch id, action address+sequence) become a unique secondary index?
- How are ULIDs assigned at insert time — by the indexer in TypeScript, or by SurrealDB? What happens during backfill where rows must be inserted with historical timestamps?

### 3. Indexes for keyset pagination

- Every paginated GraphQL query (per spike 005) needs an index on its sort tuple. Enumerate them: `(submit_block_height DESC, submit_timestamp DESC, ulid ASC)`, `(account, height DESC)`, etc.
- Which queries can walk the **primary B-tree** (range queries on the ULID) versus needing a **secondary index** + main-table lookup? §6.1 of spike 005's results captures the cost difference.
- What composite indexes are required for filter + sort combinations (e.g., `bridge_operation` filtered by sender + sorted by submit_block_height)?

### 4. Graph edges

- SurrealDB has native graph edges (`RELATE`). Where do edges add value over foreign-key columns? Candidates: `transaction → account` (sender/recipient), `batch → transaction` (containment), `bridge_operation → transaction` (correlation).
- For each edge: directed or undirected? What edge metadata (e.g., role: sender/recipient/fee_payer) lives on the edge versus on the row?
- How do edges interact with keyset pagination? Can the GraphQL resolver walk an edge with `LIMIT` cleanly, or does it need to fall back to a join query?

### 5. Schema definition strategy

- SurrealDB supports `DEFINE TABLE`, `DEFINE FIELD`, `DEFINE INDEX`. Are tables defined as `SCHEMAFULL` (strict) or `SCHEMALESS`?
- Where do schema definitions live in the repo — `.surql` files committed alongside the indexer, or generated from a TypeScript source of truth?
- How do migrations work? Is there a forward-only migration tool (numbered files), or does the indexer apply DDL on startup?

### 6. Live queries

- Which tables back GraphQL **subscriptions** via SurrealDB live queries? (The plan from earlier spikes is: indexer writes to SurrealDB, GraphQL server fans out live-query notifications via SSE.)
- What is the per-row payload of a live-query notification? Just the diff, or the full row? Both?
- For paginated subscriptions (e.g., "newest-first stream"), how does the resolver compose an initial page with a tail subscription without missing rows or sending duplicates?

### 7. Cardinality and storage

- What is the expected row count and growth rate per table? (Sequencer at ~X tx/s × 1 yr × replication factor.)
- Which tables need **TTL / archival**? Is everything kept forever, or do `zkapp_action` / `zkapp_event` get cold-tiered?
- Does any table need **partitioning**? SurrealDB has no native partitioning but supports per-namespace/database isolation.

### 8. Cross-spike consistency

- Reconcile any conflicts between this schema and the entity models from spikes 001, 002, 003, 006, 007.
- Where this spike disagrees with an earlier spike, the conflict is called out and a decision is recorded (this spike or that one — but not both).

---

## Deliverables

1. **Table inventory matrix** — every table, its purpose, append-only vs. mutable, primary key, expected row count.
2. **`surrealkit/database/schema/000_schema.surql`** — `DEFINE TABLE`, `DEFINE FIELD`, `DEFINE INDEX`, `DEFINE EVENT` for every table, ready to apply with `surrealkit sync`.
3. **Index plan** — for each paginated GraphQL query, the index it uses and its cost class (primary range walk vs. secondary index + indirection). Each query file includes generated EXPLAIN comments, with the full JSON plans in `harness/reports/explain-current.md`.
4. **Edge plan** — every `RELATE` edge with direction, metadata fields, and a worked example resolver.
5. **Migration strategy** — how schema changes are versioned, applied in dev, applied in production.
6. **Live-query plan** — which tables back which GraphQL subscriptions, with the diff payload format.
7. **Recommendation** — final schema, with all of the above consolidated.

---

## References

- Spike 002 results — `bridge_operation` table, indexes, correlation key.
- Spike 005 results — Relay Connection schema, ULID primary keys, keyset pagination strategy.
- Spike 001 results — sequencer connector boundary, what events the indexer must consume.
- PRD Section 5.2 (Indexer) and Section 6 (GraphQL API).
- [SurrealDB DEFINE TABLE](https://surrealdb.com/docs/surrealql/statements/define/table).
- [SurrealDB DEFINE INDEX](https://surrealdb.com/docs/surrealql/statements/define/indexes).
- [SurrealDB graph relations (`RELATE`)](https://surrealdb.com/docs/surrealql/statements/relate).
- [SurrealDB live queries](https://surrealdb.com/docs/surrealql/statements/live).
- [SurrealDB full-text search indexes](https://surrealdb.com/docs/learn/data-models/full-text-search/search-indexes).
- [SurrealDB as a time-series database](https://surrealdb.com/docs/learn/data-models/time-series/using-as-time-series-database).
- [SurrealDB time-series aggregation queries](https://surrealdb.com/docs/learn/data-models/time-series/aggregation-queries).
- [SurrealDB record links vs graph relations](https://surrealdb.com/docs/learn/data-models/graph/record-links-vs-graph-relations).
- [SurrealDB migrating from PostgreSQL](https://surrealdb.com/docs/build/migrating/from-other-databases/from-postgresql).
- [SurrealDB schema management](https://surrealdb.com/docs/learn/schema-management).
- [SurrealDB performance best practices](https://surrealdb.com/docs/learn/querying/performance/performance-best-practices).
- [SurrealKit](https://github.com/surrealdb/surrealkit).
- [Surreal Sync](https://github.com/surrealdb/surreal-sync).
- [ULID — Sortable Unique Identifiers (arXiv:2509.08969)](https://arxiv.org/pdf/2509.08969).
