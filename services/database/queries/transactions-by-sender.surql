-- Account transaction feed for sender role.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): ProjectValue -> SelectProject -> Compute -> Limit -> Filter -> IndexScan; indexes idx_account_tx_public_key_role_order.
-- Full plan: harness/reports/explain-current.md#transactions-by-sender.
-- EXPLAIN END
SELECT VALUE tx FROM (
  SELECT in.* AS tx, sort_block_height, sort_tx_index, in
  FROM account_transaction
  WHERE account_public_key = $public_key
    AND role = "sender"
    AND [sort_block_height, sort_tx_index, in] > [
      $after_sort_block_height,
      $after_sort_tx_index,
      transaction:[$after_sort_block_height, $after_sort_tx_index, $after_hash]
    ]
  ORDER BY sort_block_height ASC, sort_tx_index ASC, in ASC
  LIMIT $limit
);
