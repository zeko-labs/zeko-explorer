-- Natural-key transaction lookup.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> IndexScan; indexes idx_tx_hash.
-- Full plan: harness/reports/explain-current.md#transaction-by-hash.
-- EXPLAIN END
SELECT * FROM transaction
WHERE hash = $hash
LIMIT 1;
