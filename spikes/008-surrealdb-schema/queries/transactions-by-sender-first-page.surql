-- First page for one sender's transaction feed.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): ProjectValue -> SelectProject -> Compute -> IndexScan; indexes idx_account_tx_public_key_role_order.
-- Full plan: harness/reports/explain-current.md#transactions-by-sender-first-page.
-- EXPLAIN END
SELECT VALUE tx FROM (
  SELECT in.* AS tx, sort_block_height, sort_tx_index, in
  FROM account_transaction
  WHERE account_public_key = $public_key
    AND role = "sender"
  ORDER BY sort_block_height ASC, sort_tx_index ASC, in ASC
  LIMIT $limit
);
