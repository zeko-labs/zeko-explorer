-- Account profile shell smoke query. Production resolvers execute the current
-- account lookup and each feed query independently so p95 latency is bounded by
-- the slowest subfeed, not one compound statement.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> Compute -> RecordIdScan -> IndexScan -> ProjectValue; indexes idx_activity_account_order, idx_bo_sender_order, idx_account_tx_out_order.
-- Full plan: harness/reports/explain-current.md#account-profile-overview.
-- EXPLAIN END
LET $account_id = (SELECT VALUE id FROM account WHERE public_key = $public_key AND token_id = "1" LIMIT 1)[0];

SELECT *,
  (SELECT * FROM account_activity WHERE account = $account_id ORDER BY sort_block_height ASC, sort_tx_index ASC, sort_activity_index ASC, id ASC LIMIT $activity_limit) AS recent_activity,
  (SELECT VALUE tx FROM (SELECT in.* AS tx, sort_block_height, sort_tx_index FROM account_transaction WHERE out = $account_id AND role = "sender" ORDER BY sort_block_height ASC, sort_tx_index ASC LIMIT $sent_limit)) AS recent_sent_transactions,
  (SELECT VALUE tx FROM (SELECT in.* AS tx, sort_block_height, sort_tx_index FROM account_transaction WHERE out = $account_id AND role = "receiver" ORDER BY sort_block_height ASC, sort_tx_index ASC LIMIT $received_limit)) AS recent_received_transactions,
  (SELECT * FROM bridge_operation WHERE sender = $public_key ORDER BY sort_submit_block_height ASC, aux ASC, aux_sequence ASC, id ASC LIMIT $bridge_limit) AS recent_bridge_operations
FROM $account_id;
