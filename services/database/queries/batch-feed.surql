-- Batch feed.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> Limit -> Filter -> IndexScan; indexes idx_batch_order.
-- Full plan: harness/reports/explain-current.md#batch-feed.
-- EXPLAIN END
SELECT * FROM batch
WHERE [sort_batch_height, id] > [$after_sort_batch_height, $after_id]
ORDER BY sort_batch_height ASC, id ASC
LIMIT $limit;
