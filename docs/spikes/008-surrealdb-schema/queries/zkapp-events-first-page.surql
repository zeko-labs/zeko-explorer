-- First zkApp event page for a contract/account.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> IndexScan; indexes idx_event_account_order.
-- Full plan: harness/reports/explain-current.md#zkapp-events-first-page.
-- EXPLAIN END
SELECT * FROM zkapp_event
WHERE emitting_account = $account
ORDER BY sort_block_height ASC, sort_tx_index ASC, sort_event_index ASC, id ASC
LIMIT $limit;
