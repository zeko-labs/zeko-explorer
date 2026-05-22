-- First account activity page.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> IndexScan; indexes idx_activity_account_order.
-- Full plan: harness/reports/explain-current.md#account-activity-first-page.
-- EXPLAIN END
SELECT * FROM account_activity
WHERE account = $account
ORDER BY sort_block_height ASC, sort_tx_index ASC, sort_activity_index ASC, id ASC
LIMIT $limit;
