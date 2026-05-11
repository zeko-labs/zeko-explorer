-- Account profile shell: current state plus the first-page feeds opened most often on account pages.
LET $account_id = (SELECT VALUE id FROM account WHERE public_key = $public_key LIMIT 1)[0];

SELECT *,
  (SELECT * FROM account_activity WHERE account = $account_id ORDER BY block_height DESC, tx_index DESC, activity_index DESC, id ASC LIMIT $activity_limit) AS recent_activity,
  (SELECT * FROM transaction WHERE sender = $account_id ORDER BY sort_block_height ASC, sort_tx_index ASC, id ASC LIMIT $sent_limit) AS recent_sent_transactions,
  (SELECT * FROM transaction WHERE receiver = $account_id ORDER BY sort_block_height ASC, sort_tx_index ASC, id ASC LIMIT $received_limit) AS recent_received_transactions,
  (SELECT * FROM bridge_operation WHERE sender = $public_key ORDER BY sort_submit_block_height ASC, aux ASC, aux_sequence ASC, id ASC LIMIT $bridge_limit) AS recent_bridge_operations
FROM $account_id;
