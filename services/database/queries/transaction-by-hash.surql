-- Natural-key transaction lookup.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> IndexScan; indexes idx_tx_hash.
-- Full plan: harness/reports/explain-current.md#transaction-by-hash.
-- EXPLAIN END
SELECT * FROM transaction
WHERE hash = $hash
ORDER BY sort_block_height ASC, sort_tx_index ASC, id ASC
LIMIT 1;
