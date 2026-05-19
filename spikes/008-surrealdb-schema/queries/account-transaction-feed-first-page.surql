-- First page for one account across all transaction roles.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): ProjectValue -> SelectProject -> Compute -> IndexScan; indexes idx_account_tx_public_key_all_order.
-- Full plan: harness/reports/explain-current.md#account-transaction-feed-first-page.
-- EXPLAIN END
SELECT VALUE tx FROM (
  SELECT in.* AS tx, sort_block_height, sort_tx_index, role, in
  FROM account_transaction
  WHERE account_public_key = $public_key
  ORDER BY sort_block_height ASC, sort_tx_index ASC, role ASC, in ASC
  LIMIT $limit
);
