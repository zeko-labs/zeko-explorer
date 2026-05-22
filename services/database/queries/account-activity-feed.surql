-- Account activity feed.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> Limit -> Filter -> IndexScan; indexes idx_activity_account_order.
-- Full plan: harness/reports/explain-current.md#account-activity-feed.
-- EXPLAIN END
SELECT * FROM account_activity
WHERE account = $account
  AND [sort_block_height, sort_tx_index, sort_activity_index, id] > [
    $after_sort_block_height,
    $after_sort_tx_index,
    $after_sort_activity_index,
    $after_id
  ]
ORDER BY sort_block_height ASC, sort_tx_index ASC, sort_activity_index ASC, id ASC
LIMIT $limit;
