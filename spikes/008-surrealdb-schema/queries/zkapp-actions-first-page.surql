-- First zkApp action page for a contract/account.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> IndexScan; indexes idx_action_account_order.
-- Full plan: harness/reports/explain-current.md#zkapp-actions-first-page.
-- EXPLAIN END
SELECT * FROM zkapp_action
WHERE emitting_account = $account
ORDER BY sort_block_height ASC, sort_tx_index ASC, sort_action_index ASC, id ASC
LIMIT $limit;
