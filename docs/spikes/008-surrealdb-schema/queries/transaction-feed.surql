-- Open-ended global transaction feed.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> Limit -> Filter -> IndexScan; indexes idx_tx_connection_order.
-- Full plan: harness/reports/explain-current.md#transaction-feed.
-- EXPLAIN END
SELECT * FROM transaction
WHERE [sort_block_height, sort_tx_index, hash] > [$after_sort_block_height, $after_sort_tx_index, $after_hash]
ORDER BY sort_block_height ASC, sort_tx_index ASC, hash ASC
LIMIT $limit;
