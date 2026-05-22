-- First recipient-side bridge history page.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> IndexScan; indexes idx_bo_recipient_order.
-- Full plan: harness/reports/explain-current.md#bridge-operations-by-recipient-first-page.
-- EXPLAIN END
SELECT * FROM bridge_operation
WHERE recipient = $public_key
ORDER BY sort_submit_block_height ASC, aux ASC, aux_sequence ASC, id ASC
LIMIT $limit;
