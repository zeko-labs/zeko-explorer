-- Exact identifier probes over canonical tables and their native indexes.
-- The API keeps result ordering deterministic: transaction hash, account public
-- key, bridge aux key, batch height, then action state hashes.
-- EXPLAIN START
-- EXPLAIN(v3 fixture): compound RETURN query; exact lookup components are documented in harness/reports/explain-current.md.
-- Identifier probes use natural-key indexes: idx_tx_hash, idx_account_public_key, idx_bo_aux_unique, idx_oa_after_state, idx_ia_after_state.
-- EXPLAIN END
RETURN {
  transactions: (SELECT * FROM transaction WHERE hash = $term LIMIT 1),
  accounts: (SELECT * FROM account WHERE public_key = $term LIMIT 1),
  bridge_operations: (SELECT * FROM bridge_operation WHERE aux = $term LIMIT $limit),
  outer_actions: (SELECT * FROM outer_action WHERE after_state = $term LIMIT 1),
  inner_actions: (SELECT * FROM inner_action WHERE after_state = $term LIMIT 1)
};
