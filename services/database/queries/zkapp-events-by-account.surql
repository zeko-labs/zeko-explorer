-- zkApp event feed for a contract/account.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> Limit -> Filter -> IndexScan; indexes idx_event_account_order.
-- Full plan: harness/reports/explain-current.md#zkapp-events-by-account.
-- EXPLAIN END
SELECT * FROM zkapp_event
WHERE emitting_account = $account
  AND [sort_block_height, sort_tx_index, sort_event_index, id] > [
    $after_sort_block_height,
    $after_sort_tx_index,
    $after_sort_event_index,
    $after_id
  ]
ORDER BY sort_block_height ASC, sort_tx_index ASC, sort_event_index ASC, id ASC
LIMIT $limit;
