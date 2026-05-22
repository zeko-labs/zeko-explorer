-- First page for the global transaction feed.
-- EXPLAIN/benchmark evidence rejected the complex-record-ID range scan for this
-- public path on SurrealDB v3 + SurrealKV. This stays on the canonical
-- transaction table and uses a normal secondary index, not a feed table.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> IndexScan; indexes idx_tx_connection_order.
-- Full plan: harness/reports/explain-current.md#transaction-feed-first-page.
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
WHERE sort_block_height >= $from_sort_block_height
ORDER BY sort_block_height ASC, sort_tx_index ASC, hash ASC
LIMIT $limit;
