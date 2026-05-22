-- Native time-bucketed transaction throughput from SurrealDB's declarative
-- transaction_minute_stats table view.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> IndexScan; indexes idx_tx_minute_stats_minute.
-- Full plan: harness/reports/explain-current.md#network-throughput-by-minute.
-- EXPLAIN END
SELECT minute, transaction_count
FROM transaction_minute_stats
WHERE minute >= $from AND minute < $to
ORDER BY minute ASC;
