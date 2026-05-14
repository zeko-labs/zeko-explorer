-- First batch page.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> IndexScan; indexes idx_batch_order.
-- Full plan: harness/reports/explain-current.md#batch-feed-first-page.
-- EXPLAIN END
SELECT * FROM batch
ORDER BY sort_batch_height ASC, id ASC
LIMIT $limit;
