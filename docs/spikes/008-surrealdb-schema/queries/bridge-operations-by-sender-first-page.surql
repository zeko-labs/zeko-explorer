-- First sender-side bridge history page.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> IndexScan; indexes idx_bo_sender_order.
-- Full plan: harness/reports/explain-current.md#bridge-operations-by-sender-first-page.
-- EXPLAIN END
SELECT * FROM bridge_operation
WHERE sender = $public_key
ORDER BY sort_submit_block_height ASC, aux ASC, aux_sequence ASC, id ASC
LIMIT $limit;
