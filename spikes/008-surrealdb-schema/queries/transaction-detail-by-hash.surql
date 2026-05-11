-- Transaction investigation query: one hash plus bounded graph/detail fanout.
LET $tx_id = (SELECT VALUE id FROM transaction WHERE hash = $hash LIMIT 1)[0];

SELECT *,
  ->account_transaction->account AS related_accounts,
  <-batch_transaction<-batch AS batches,
  <-bridge_transaction_link<-bridge_operation AS bridge_operations,
  (SELECT * FROM zkapp_event WHERE transaction = $tx_id ORDER BY event_index ASC LIMIT $event_limit) AS zkapp_events,
  (SELECT * FROM zkapp_action WHERE transaction = $tx_id ORDER BY action_index ASC LIMIT $action_limit) AS zkapp_actions,
  (SELECT * FROM inner_action WHERE transaction = $tx_id ORDER BY action_index ASC LIMIT $inner_action_limit) AS inner_actions
FROM $tx_id;
