-- Bridge detail with bounded graph traversals.
SELECT *,
  <-l1_action_link<-outer_action AS l1_actions,
  ->l2_action_link->inner_action AS l2_actions,
  ->bridge_transaction_link->transaction AS transactions
FROM bridge_operation
WHERE aux = $aux AND aux_sequence = $aux_sequence
LIMIT 1;
