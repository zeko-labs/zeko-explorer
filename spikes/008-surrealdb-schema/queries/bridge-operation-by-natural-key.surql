-- Bridge operation natural-key lookup.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> IndexScan; indexes idx_bo_aux_unique.
-- Full plan: harness/reports/explain-current.md#bridge-operation-by-natural-key.
-- EXPLAIN END
SELECT * FROM bridge_operation
WHERE aux = $aux AND aux_sequence = $aux_sequence
LIMIT 1;
