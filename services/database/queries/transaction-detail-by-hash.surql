-- Transaction investigation query: one hash plus bounded graph/detail fanout.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> Compute -> RecordIdScan -> GraphEdgeScan -> CurrentValueSource -> IndexScan; indexes idx_ia_txn_hash_order, idx_action_hash_order, idx_event_hash_order.
-- Full plan: harness/reports/explain-current.md#transaction-detail-by-hash.
-- EXPLAIN END
LET $tx_id = (
  SELECT id, sort_block_height, sort_tx_index FROM transaction
  WHERE hash = $hash
  ORDER BY sort_block_height ASC, sort_tx_index ASC, id ASC
  LIMIT 1
)[0].id;

SELECT *,
  ->account_transaction->account AS related_accounts,
  <-batch_transaction<-batch AS batches,
  <-bridge_transaction_link<-bridge_operation AS bridge_operations,
  (SELECT * FROM zkapp_event WHERE transaction_hash = $hash ORDER BY event_index ASC, id ASC LIMIT $event_limit) AS zkapp_events,
  (SELECT * FROM zkapp_action WHERE transaction_hash = $hash ORDER BY action_index ASC, id ASC LIMIT $action_limit) AS zkapp_actions,
  (SELECT * FROM inner_action WHERE txn_hash = $hash ORDER BY action_index ASC, id ASC LIMIT $inner_action_limit) AS inner_actions
FROM $tx_id;
