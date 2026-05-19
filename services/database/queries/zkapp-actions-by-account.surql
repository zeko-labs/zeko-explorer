-- zkApp action feed for a contract/account.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> Limit -> Filter -> IndexScan; indexes idx_action_account_order.
-- Full plan: harness/reports/explain-current.md#zkapp-actions-by-account.
-- EXPLAIN END
SELECT * FROM zkapp_action
WHERE emitting_account = $account
  AND [sort_block_height, sort_tx_index, sort_action_index, id] > [
    $after_sort_block_height,
    $after_sort_tx_index,
    $after_sort_action_index,
    $after_id
  ]
ORDER BY sort_block_height ASC, sort_tx_index ASC, sort_action_index ASC, id ASC
LIMIT $limit;
