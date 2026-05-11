-- Account profile shell: current state plus the first-page feeds opened most often on account pages.
LET $account_id = (SELECT VALUE id FROM account WHERE public_key = $public_key LIMIT 1)[0];
LET $received_edges = (
  SELECT in AS tx, sort_block_height, sort_tx_index FROM account_transaction
  WHERE out = $account_id
    AND role = "receiver"
  ORDER BY sort_block_height ASC, sort_tx_index ASC
  LIMIT $received_limit
);

SELECT *,
  (SELECT * FROM account_activity WHERE account = $account_id ORDER BY block_height DESC, tx_index DESC, activity_index DESC, id ASC LIMIT $activity_limit) AS recent_activity,
  (SELECT * FROM transaction WHERE sender_public_key = $public_key ORDER BY sort_block_height ASC, sort_tx_index ASC, id ASC LIMIT $sent_limit) AS recent_sent_transactions,
  (SELECT * FROM $received_edges.tx) AS recent_received_transactions,
  (SELECT * FROM bridge_operation WHERE sender = $public_key ORDER BY sort_submit_block_height ASC, aux ASC, aux_sequence ASC, id ASC LIMIT $bridge_limit) AS recent_bridge_operations
FROM $account_id;
