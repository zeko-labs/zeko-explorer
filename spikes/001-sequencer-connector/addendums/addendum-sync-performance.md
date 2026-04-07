# Addendum: Archive Sync Performance and the New Architecture

## The Problem Today

From the [archive node docs](https://docs.zeko.io/operators/guides/archive-node.html):

> Synchronizing will take a long time. At the time of writing Zeko L2 testnet has 1 million transactions and would take at least a week to get it synced.

The current archive relay syncs via this pipeline:

```
archive-relay ──poll(30s)──> sequencer GraphQL (unprovedLedgerHash)
     │
     └──iter_diffs──> DA layer (binary RPC, chunked)
     │
     └──apply to local ledger──> build Mina breadcrumb
     │
     └──dispatch──> archive node ──> PostgreSQL
```

Each of the ~1M transactions must be:
1. Fetched from the DA layer via binary RPC (chunked, with `interval_size` batching)
2. Applied to a full local ledger copy (to compute merkle roots and build breadcrumbs)
3. Serialized into a Mina `Transition_frontier` breadcrumb
4. Dispatched to a Mina archive node via RPC
5. Inserted into PostgreSQL by the archive node

Steps 2-4 are the bottleneck — maintaining a full ledger copy and building Mina-compatible breadcrumbs is expensive and exists only because the Mina archive node expects data in that format. The Zeko explorer does not need Mina-compatible breadcrumbs.

## How the New Architecture Eliminates This Bottleneck

### Real-Time Path (Sequencer → NATS)

New transactions are published to NATS at the moment they are applied — zero latency, no polling. This path does not involve the DA layer at all for new transactions. The week-long sync problem does not apply to real-time operation.

### Bootstrap Path (DA Layer → Backfill → NATS)

For initial bootstrap of the ~1M historical transactions, the backfill service calls `Da_layer.Client.iter_diffs` and publishes each diff directly to NATS as JSON. Compared to the archive relay:

| Step | Archive Relay | Backfill Service |
|---|---|---|
| Fetch diff from DA | Binary RPC (same) | Binary RPC (same) |
| Apply to local ledger | Full ledger copy, merkle root computation | **Skipped** — diff already contains all needed data |
| Build breadcrumb | Mina `Transition_frontier` serialization | **Skipped** — not needed |
| Dispatch to archive | Mina archive node RPC | **Skipped** — not needed |
| Store | PostgreSQL insert via archive node | NATS publish (append to stream) |
| Per-diff overhead | ~5 operations, each blocking | **1 operation** — serialize JSON + NATS publish |

The backfill service skips the three most expensive steps (ledger maintenance, breadcrumb construction, archive dispatch) because NATS just needs the raw diff as JSON. The `Da_layer.Diff.V3` already has `[@@deriving yojson]`, so serialization is a single function call.

### Estimated Improvement

The DA layer fetch (binary RPC, chunked) is the I/O-bound floor — both approaches must do this. The archive relay adds CPU-bound ledger operations and synchronous archive dispatch on top. Rough breakdown of where time goes in the archive relay:

| Phase | Est. Share | New Architecture |
|---|---|---|
| DA layer fetch (I/O) | ~20% | Same |
| Ledger apply + merkle root | ~30% | Eliminated |
| Breadcrumb construction | ~20% | Eliminated |
| Archive dispatch + PG insert | ~30% | Replaced with NATS publish (~0%) |

A conservative estimate: the backfill service should process the same 1M transactions in **~1/4 the time** (limited by DA layer fetch speed), bringing a week-long sync down to ~1-2 days. The actual improvement depends on DA layer throughput and network conditions.

### Further Optimization: Parallelized DA Fetching

The `iter_diffs` call processes chunks sequentially. If the DA layer supports multiple concurrent connections, the backfill service could parallelize by:

1. Querying the DA layer for known intermediate ledger hashes (e.g., from the L1 commit history)
2. Splitting the range into N parallel sub-ranges
3. Running N concurrent `iter_diffs` calls, each publishing to NATS independently
4. JetStream deduplication handles any overlaps at range boundaries

This would further reduce bootstrap time proportionally to the number of parallel workers, limited by DA layer capacity.

### Pre-Seeded NATS Streams

The archive node docs suggest contacting Zeko Labs for pre-synced database checkpoints. The NATS equivalent is simpler: a pre-seeded JetStream data directory.

1. Run the backfill service once on a staging machine to populate a NATS stream with all 1M transactions
2. Snapshot the JetStream data directory (`/data/jetstream/`)
3. Distribute the snapshot (tar/zip) to new operators
4. Operators start NATS with the pre-seeded data directory
5. The indexer starts from sequence 1 and processes locally — no DA layer fetch needed
6. The sequencer connects and publishes new transactions from current state

This eliminates the DA layer fetch entirely for new deployments. The NATS data directory is a self-contained, portable representation of the full transaction history.

### Indexer Processing Speed

Once diffs are in NATS (whether from bootstrap or pre-seeded), the indexer processes them locally:

1. Read JSON from NATS (local, fast)
2. Parse and transform to SurrealDB records
3. Insert into SurrealDB

This is CPU-bound JSON processing + DB writes — no network fetches, no ledger maintenance. The indexer should process 1M transactions in hours, not days, depending on SurrealDB write throughput.
