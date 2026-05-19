-- Batch detail with bounded containment traversal.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> Compute -> RecordIdScan -> GraphEdgeScan -> CurrentValueSource; no explicit secondary index in plan.
-- Full plan: harness/reports/explain-current.md#batch-with-transactions-graph.
-- EXPLAIN END
SELECT *, ->batch_transaction->transaction AS transactions
FROM $batch;
