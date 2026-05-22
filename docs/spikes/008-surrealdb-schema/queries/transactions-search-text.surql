-- Native SurrealDB full-text search over canonical transaction rows.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> Limit -> FullTextScan; indexes idx_tx_search_text.
-- Full plan: harness/reports/explain-current.md#transactions-search-text.
-- EXPLAIN END
SELECT
  id,
  hash,
  sequence_number,
  type,
  status,
  sender,
  receiver,
  sender_public_key,
  receiver_public_key,
  amount,
  fee,
  nonce,
  memo,
  block_height,
  tx_index,
  sort_block_height,
  sort_tx_index,
  timestamp,
  source_ledger_hash,
  target_ledger_hash,
  batch,
  rollback_reason
FROM transaction
WHERE search_text @1@ $term
LIMIT $limit;
