-- Bridge detail with bounded graph traversals.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> Compute -> IndexScan -> GraphEdgeScan -> CurrentValueSource; indexes idx_bo_aux_unique.
-- Full plan: harness/reports/explain-current.md#bridge-operation-detail-graph.
-- EXPLAIN END
SELECT *,
  <-l1_action_link<-outer_action AS l1_actions,
  ->l2_action_link->inner_action AS l2_actions,
  ->bridge_transaction_link->transaction AS transactions
FROM bridge_operation
WHERE aux = $aux AND aux_sequence = $aux_sequence
LIMIT 1;
