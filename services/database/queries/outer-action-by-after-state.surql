-- Outer action natural-key lookup.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> IndexScan; indexes idx_oa_after_state.
-- Full plan: harness/reports/explain-current.md#outer-action-by-after-state.
-- EXPLAIN END
SELECT * FROM outer_action
WHERE after_state = $after_state
LIMIT 1;
