# Spike 008 Import Load Experiments

This note records the benchmark load paths that were tried while proving the
SurrealDB schema. The harness now keeps only the accepted forward paths in
`package.json`; rejected paths are documented here so future implementers do not
repeat them without new evidence.

## Accepted Forward Paths

### Docker persisted chunk import

Command:

```sh
pnpm run benchmark:docker:persisted
```

Shape:

- Start Dockerized `surrealdb/surrealdb:v3` on persisted SurrealKV.
- Apply the committed SurrealKit schema with `surrealkit sync`.
- Generate deterministic data as bounded `.surql` chunk files.
- Load chunks sequentially with official `surreal import`.
- Keep the full index, full-text search, relation, and table-view schema present.

Evidence:

- 100k persisted gate passed with 20,000 accounts, 100,000 transactions,
  100,000 account activity rows, and 100,000 bridge operations.
- Total load: 486s.
- All 26 measured query paths passed.
- Worst p95: `transaction-feed-first-page` at 37.744ms against a 250ms budget.

This is the default reproducible benchmark path.

### Host persisted streaming import

Command:

```sh
pnpm run benchmark:host:million:stream
```

Shape:

- Start a host SurrealDB v3 binary on persisted SurrealKV.
- Generate one bounded import chunk at a time.
- Import that chunk with official `surreal import`.
- Delete the chunk and continue.
- Keep the full realistic schema and indexes present.

Evidence:

- Small persisted and memory checks passed.
- This path fixes generated-file disk amplification because it does not keep the
  full generated import set next to the database.
- The local machine still lacked disk/RAM headroom to complete the full
  million-row persisted gate.

This is the next path to run on a machine or volume with enough space for the
full indexed SurrealKV database and compaction.

## Rejected Paths

### SurrealKit seed for scale data

SurrealKit remains the schema and rollout authority, but `surrealkit seed` was
too slow for million-row benchmark loading. A 100k run with 5,000-row chunks
took about 500s, with 497s spent in `surrealkit seed`. Query timings still
passed, but this is not the load path for large benchmark datasets.

### Monolithic embedded import

A single generated `data.surql` file imported directly into embedded Docker
SurrealKV worked at smaller scale but failed the million gate with exit code
137 under the local 4GB Docker memory limit. The harness no longer creates a
monolithic million-row import file.

### `surreal start --import-file`

Startup import was tested with a full generated file. It is not viable for this
schema in the harness: schema-only startup import hit v3 startup
retry/namespace failures around 60s.

### Embedded chunk import

Repeated embedded `surreal import` opens avoided a single large file, but the
100k run hit an enforced relation failure. Live-server chunk import is the
retained chunked approach.

### Deferred index import

Raw data import without indexes was fast at 100k, but importing the combined
index set afterwards failed with `Transaction retry required: memtable history
insufficient for conflict detection`. Split deferred index import worked at
10k but was slower than full-index import because every index file reopened the
store. The benchmark must prove the realistic indexed database, so deferred
indexes are not an accepted shortcut.

### Direct parallel HTTP SQL loading

Parallel HTTP SQL loading hit request body limits and transaction write-conflict
retries under indexed writes. It is not an official bulk-load path and is not
kept in the harness.

### RocksDB and memory variants

RocksDB embedded import did not produce a usable benchmark path in this harness.
Memory mode avoids disk pressure but is not a persisted proof and began swapping
on the local 8GB host before the million gate.

## Rule For New Load Paths

New loader variants should only be added back to the executable harness if they:

- Use official SurrealDB or SurrealKit tooling.
- Preserve the full realistic schema and index set.
- Avoid monolithic million-row import files.
- Reach the query timing phase.
- Produce benchmark evidence that beats the retained chunked import paths.
