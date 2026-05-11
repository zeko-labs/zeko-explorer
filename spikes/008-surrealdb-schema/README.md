# Spike 008: Full SurrealDB Schema — Tables, Record IDs, Indexes, Edges

**Status:** Ready for review
**Blocking:** Milestone 1 (indexer + GraphQL API)
**Owner:** TBD

---

## Working Artifacts

- [`results.html`](results.html) — consolidated decisions, cross-spike reconciliation, validation, and benchmark evidence.
- [`schema.surql`](schema.surql) — current schemafull SurrealDB schema.
- [`queries/`](queries/) — one SurrealQL file per planned query/access path.
- [`harness/`](harness/) — runnable TypeScript test and benchmark harness managed by pnpm.
- [`harness/features/`](harness/features/) — Cucumber acceptance suite that runs against in-memory SurrealDB.
- [`migrations/`](migrations/) — representative forward-only migration with existing data.
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

`benchmark:docker:persisted` generates ordered SurrealQL import chunks, starts `surrealdb/surrealdb:v2.4.0` with a mounted SurrealKV Docker volume, imports each chunk with `surreal import` inside the container, points the TypeScript query-timing harness at the loaded database, and removes both the container and volume when the run exits.

`pnpm run benchmark` is only a small local query-shape smoke test. It refuses large self-seeded datasets; scale evidence must use `benchmark:docker:persisted` so row loading goes through `surreal import`.

The current evidence run used:

```sh
BENCH_TX_COUNT=2200000 \
BENCH_ACCOUNT_COUNT=50000 \
BENCH_CONTRACT_ACCOUNT_COUNT=500 \
BENCH_BRIDGE_COUNT=220000 \
BENCH_ITERATIONS=5 \
BENCH_IMPORT_CHUNK_ROWS=50000 \
BENCH_ACTIVITY_STRIDE=10 \
pnpm run benchmark:docker:persisted
```

That run loaded 2,200,000 transaction rows into persisted SurrealKV in 947s and completed the 12-query benchmark catalog. The generated import directory under `harness/reports/` is disposable and ignored by git; `harness/benchmarks/latest-results.html` keeps the measured output.

---

## Context

Earlier spikes have settled individual pieces of the data layer in isolation:

- Spike 002 (bridge correlation) defines the `bridge_operation` table — composite `(aux, aux_sequence)` correlation, FIFO disambiguation, status lifecycle, indexes for the `(sender|recipient)` pubkey filter.
- Spike 005 (Relay pagination) commits us to **ULID** primary keys on every indexed row, exposed as `Node.id` for Relay Connections, and to keyset pagination over indexed sort columns.
- Spikes 001 / 006 / 007 produce the upstream events (sequencer connector, L1 watcher, DA monitor) that the indexer projects into rows.

What is **not** yet designed is the union of those decisions: a single coherent SurrealDB schema covering every entity the indexer writes and the GraphQL API reads. The indexer cannot be built — and the GraphQL resolvers cannot be authored — without it.

This spike produces that schema.

---

## Scope

All persistent state in the explorer's own database. **In scope**:

- `transaction` — sequencer-confirmed L2 transactions (payments, zkApp commands, etc.).
- `account` — current state for every account that has ever appeared (nonce, balance, zkApp state if applicable).
- `account_activity` — append-only log of state transitions per account, used for "account history" queries.
- `batch` — L2 batches with their L1 settlement and DA attestation status.
- `outer_action` / `inner_action` — zkApp action stream, normalized for query.
- `zkapp_event` — zkApp event stream.
- `bridge_operation` — settled in spike 002; included here for completeness and cross-check.
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
2. **`schema.surql`** — `DEFINE TABLE`, `DEFINE FIELD`, `DEFINE INDEX`, `DEFINE EVENT` for every table, ready to apply.
3. **Index plan** — for each paginated GraphQL query, the index it uses and its cost class (primary range walk vs. secondary index + indirection).
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
- [ULID — Sortable Unique Identifiers (arXiv:2509.08969)](https://arxiv.org/pdf/2509.08969).
