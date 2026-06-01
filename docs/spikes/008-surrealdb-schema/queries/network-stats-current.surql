-- Current aggregate stats derived from canonical tables.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): compound RETURN query; component plans are documented in harness/reports/explain-current.md.
-- Counts use COUNT indexes, the TPS window uses idx_tx_timestamp, and latest rows use order indexes.
-- EXPLAIN END
LET $latest_tx = (SELECT block_height, timestamp, sort_block_height, sort_tx_index FROM transaction ORDER BY sort_block_height ASC, sort_tx_index ASC LIMIT 1)[0];
LET $latest_batch = (SELECT batch_height, sort_batch_height FROM batch ORDER BY sort_batch_height ASC LIMIT 1)[0];
LET $transaction_count = (SELECT count() FROM transaction GROUP ALL)[0].count;
LET $account_count = (SELECT count() FROM account GROUP ALL)[0].count;
LET $bridge_operation_count = (SELECT count() FROM bridge_operation GROUP ALL)[0].count;
LET $tx_1m = array::len(SELECT VALUE id FROM transaction WHERE timestamp >= time::now() - 1m);
LET $tx_5m = array::len(SELECT VALUE id FROM transaction WHERE timestamp >= time::now() - 5m);

RETURN [{
  scope: $scope,
  latest_block_height: $latest_tx.block_height,
  latest_block_timestamp: $latest_tx.timestamp,
  latest_batch_height: $latest_batch.batch_height,
  transaction_count: $transaction_count,
  account_count: $account_count,
  bridge_operation_count: $bridge_operation_count,
  tps_1m: <number>$tx_1m / 60,
  tps_5m: <number>$tx_5m / 300,
  updated_at: time::now()
}];
