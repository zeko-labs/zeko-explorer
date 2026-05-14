-- One indexed step backward in the inner action state chain.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): SelectProject -> IndexScan; indexes idx_ia_after_state.
-- Full plan: harness/reports/explain-current.md#inner-action-chain-prev.
-- EXPLAIN END
SELECT * FROM inner_action
WHERE after_state = $after_state
LIMIT 1;
